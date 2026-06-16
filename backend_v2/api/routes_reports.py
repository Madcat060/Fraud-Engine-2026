"""
backend_v2.api.routes_reports
-----------------------------

Flask blueprint exposing:

* `/api/report-viewer/run` – ad‑hoc read‑only SQL runner with row cap.
* `/api/report-viewer/schema` – table/column introspection.
* `/api/run` and `/api/run/stream` – simple report execution queue with
  Server‑Sent Events streaming of progress / results.
"""

from __future__ import annotations

import json
import queue
import warnings
from typing import Any, Dict
import re
from urllib.parse import parse_qsl

import csv
import io
from datetime import datetime, timedelta

import pandas as pd
import requests
from flask import Blueprint, Response, jsonify, request
from sqlalchemy import inspect, text

from backend_v2.config import DEFAULT_DB_CONNECTION, PLAYTECH_ADMIN_PASSWORD, PLAYTECH_ADMIN_USER
from backend_v2.database import get_db_engine
from backend_v2.api.ops_dashboard import get_ops_dashboard_metrics
from backend_v2.services.report_manager import import_dataframe_to_db
from backend_v2.services.storage import Storage


reports_bp = Blueprint("reports_v2", __name__)
storage = Storage()

# Queue used for manual Run Reports SSE stream (distinct from any other queues)
run_queue: "queue.Queue[Any]" | None = None


def _parse_legacy_curl(curl_cmd: str) -> tuple[str, dict[str, str], dict[str, str]]:
    """Extract URL, headers and form data from stored legacy curl command."""
    cmd = str(curl_cmd or "").strip()
    if not cmd:
        raise ValueError("Empty curl command")

    url_match = re.search(r'"(https?://[^"]+)"', cmd)
    if not url_match:
        url_match = re.search(r"'(https?://[^']+)'", cmd)
    if not url_match:
        raise ValueError("Could not parse URL from api_curl")
    url = url_match.group(1)

    headers: dict[str, str] = {}
    for hm in re.finditer(r'-H\s+"([^"]+)"', cmd):
        h = hm.group(1)
        if ":" in h:
            k, v = h.split(":", 1)
            headers[k.strip()] = v.strip()

    data_match = re.search(r'-d\s+"([^"]*)"', cmd)
    if not data_match:
        data_match = re.search(r"-d\s+'([^']*)'", cmd)
    raw_form = data_match.group(1) if data_match else ""
    form = {k: v for k, v in parse_qsl(raw_form, keep_blank_values=True)}
    return url, headers, form


def _finalize_playtech_report_form(form: dict[str, str], username: str, password: str) -> dict[str, str]:
    """
    Collapse credential fields to a single ``admin`` and ``password`` (lowercase keys).

    Templates sometimes use ``Admin`` / ``Password`` or duplicate keys after edits; sending
    multiple variants in one body can cause APIs (including iPoker private report hosts)
    to read the wrong value and return 401.
    """
    rest: dict[str, str] = {}
    for k, v in form.items():
        lk = k.lower()
        if lk in ("admin", "adminuser", "user", "user_name", "password"):
            continue
        rest[k] = v
    out: dict[str, str] = {"admin": username, "password": password}
    out.update(rest)
    return out


def _format_report_date(dt: datetime, with_time: bool) -> str:
    return dt.strftime("%Y-%m-%d %H:%M:%S" if with_time else "%Y-%m-%d")


def _build_time_windows(
    reports: list[Dict[str, Any]],
    global_start: datetime,
    global_end: datetime,
) -> list[tuple[datetime, datetime]]:
    """Build execution windows from report interval hints (hour/day/week)."""
    if global_start > global_end:
        global_start, global_end = global_end, global_start

    step = None
    has_hourly = any(str(r.get("run_interval") or "").strip().lower() == "hourly" for r in reports)
    has_daily = any(str(r.get("recurrence") or "").strip().lower() == "day" or str(r.get("days") or "").strip() == "1" for r in reports)
    has_weekly = any(str(r.get("recurrence") or "").strip().lower() == "week" or str(r.get("days") or "").strip() == "7" for r in reports)

    if has_hourly:
        step = timedelta(hours=1)
    elif has_daily:
        step = timedelta(days=1)
    elif has_weekly:
        step = timedelta(days=7)
    else:
        return [(global_start, global_end)]

    windows: list[tuple[datetime, datetime]] = []
    cur = global_start
    while cur < global_end:
        nxt = min(cur + step, global_end)
        windows.append((cur, nxt))
        if nxt <= cur:
            break
        cur = nxt

    if not windows:
        windows = [(global_start, global_end)]
    return windows


def _run_reports_impl_v2(
    reports: list[Dict[str, Any]],
    profile: Dict[str, Any],
    global_start: datetime,
    global_end: datetime,
    default_db_conn: str,
    max_threads: int,  # kept for signature compatibility
    out_queue: "queue.Queue[Any]",
    preserve_input_times: bool = True,
) -> None:
    """Local fallback runner when legacy app.py is unavailable."""
    del max_threads, preserve_input_times
    username = str(profile.get("username") or PLAYTECH_ADMIN_USER or "")
    password = str(profile.get("password") or PLAYTECH_ADMIN_PASSWORD or "")
    out_queue.put(
        "[monitor] Auth profile: "
        + str(profile.get("name") or profile.get("id") or "?")
        + f" (user={username}, password_length={len(password)})"
    )
    total_reports = 0
    ok_reports = 0
    failed_reports = 0
    total_rows_received = 0
    total_rows_inserted = 0

    windows = _build_time_windows(reports, global_start, global_end)
    out_queue.put(f"[monitor] Interval windows -> {len(windows)} chunk(s)")

    for w_start, w_end in windows:
        out_queue.put(
            f"[monitor] Window -> {_format_report_date(w_start, True)} to {_format_report_date(w_end, True)}"
        )
        for report in reports:
            total_reports += 1
            try:
                if not (report.get("active", True)):
                    ok_reports += 1
                    continue
                api_curl = str(report.get("api_curl") or "").strip()
                if not api_curl:
                    out_queue.put(f"[skip] Missing api_curl for report {report.get('id', '<unknown>')}")
                    continue

                out_queue.put(f"[run] {report.get('filename') or report.get('db_table_name') or 'report'}")
                url, headers, form = _parse_legacy_curl(api_curl)
                out_queue.put(f"[monitor] Connection Made -> {url}")
                out_queue.put("[monitor] Extract list now...")

                with_time = any(k.lower() in ("startdate", "enddate", "sstartdate", "senddate") and ":" in v for k, v in form.items())
                start_s = _format_report_date(w_start, with_time)
                end_s = _format_report_date(w_end, with_time)
                for key in list(form.keys()):
                    lk = key.lower()
                    if lk in ("admin", "adminuser", "user", "user_name"):
                        form[key] = username
                    elif lk == "password":
                        form[key] = password
                    elif lk in ("startdate", "sstartdate"):
                        form[key] = start_s
                    elif lk in ("enddate", "senddate"):
                        form[key] = end_s
                    else:
                        form[key] = (
                            str(form[key])
                            .replace("{username}", username)
                            .replace("{password}", password)
                        )

                form = _finalize_playtech_report_form(form, username, password)

                # Keep legacy stream behavior: show the exact API call context per report.
                redacted_form = dict(form)
                for sk in list(redacted_form.keys()):
                    if sk.lower() == "password":
                        redacted_form[sk] = "***"
                curl_parts = [f"{k}={v}" for k, v in redacted_form.items()]
                out_queue.put({"_curl": f'curl -X POST "{url}" -d "' + "&".join(curl_parts) + '"'})

                resp = requests.post(url, data=form, headers=headers, timeout=300)
                if not resp.ok:
                    snippet = (resp.text or "")[:1200].replace("\n", " ").strip()
                    if len(snippet) > 800:
                        snippet = snippet[:800] + "…"
                    out_queue.put(
                        f"[http] {report.get('filename') or report.get('id')} -> {resp.status_code} "
                        f"response: {snippet or '(empty body)'}"
                    )
                resp.raise_for_status()
                out_queue.put(f"[http] {report.get('filename') or report.get('id')} -> {resp.status_code}")
                text_body = resp.text or ""
                if not text_body.strip():
                    out_queue.put(f"[done] {report.get('filename') or report.get('id')} -> empty response (0 rows)")
                    out_queue.put({"_db_result": {"status": "ok", "rows_imported": 0, "note": "empty response"}})
                    ok_reports += 1
                    continue

                df = pd.read_csv(io.StringIO(text_body), low_memory=False)
                if df.empty:
                    out_queue.put(f"[done] {report.get('filename') or report.get('id')} -> csv parsed, 0 rows")
                    out_queue.put({"_db_result": {"status": "ok", "rows_imported": 0, "note": "empty csv"}})
                    ok_reports += 1
                    continue
                out_queue.put(
                    f"[rows] {report.get('filename') or report.get('id')} -> received {int(len(df))} row(s)"
                )
                total_rows_received += int(len(df))

                output_mode = str(report.get("output_mode") or "csv").lower()
                if output_mode == "db":
                    table_name = (
                        str(report.get("db_table_name") or "").strip()
                        or str(report.get("filename") or "").strip()
                        or "report_import"
                    )
                    conn_str = str(report.get("db_connection_string") or "").strip() or default_db_conn
                    imported = import_dataframe_to_db(conn_str, table_name, df, unique_key_columns=None)
                    total_rows_inserted += int(imported)
                    out_queue.put(
                        f"[done] {report.get('filename') or report.get('id')} -> table {table_name}, inserted {int(imported)} row(s)"
                    )
                    out_queue.put({"_db_result": {"status": "ok", "table_name": table_name, "rows_imported": int(imported)}})
                    ok_reports += 1
                else:
                    out_queue.put(
                        f"[done] {report.get('filename') or report.get('id')} -> output_mode=csv, rows {int(len(df))}"
                    )
                    out_queue.put({"_db_result": {"status": "ok", "rows_returned": int(len(df)), "note": "output_mode=csv"}})
                    ok_reports += 1
            except Exception as exc:
                failed_reports += 1
                out_queue.put(f"[error] {report.get('filename') or report.get('id')}: {exc}")

    out_queue.put(
        f"[summary] reports total={total_reports}, ok={ok_reports}, failed={failed_reports}, "
        f"rows_received={total_rows_received}, rows_inserted={total_rows_inserted}"
    )
    out_queue.put("__DONE__")


def _is_read_only_query(sql: str) -> bool:
    """Return True if the SQL appears to be a SELECT/CTE only."""
    s = sql or ""
    # Strip comments and collapse whitespace for a cheap but effective check.
    lines = []
    for line in s.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith("--"):
            continue
        idx = line.find("--")
        if idx != -1:
            line = line[:idx]
        lines.append(line)
    s = " ".join(lines).strip().upper()
    if not s:
        return False
    first = s.split()[0]
    return first in ("SELECT", "WITH")


def _report_viewer_serialize(value: Any) -> Any:
    """Simple JSON‑safe serializer for DataFrame values."""
    if isinstance(value, (pd.Timestamp,)):
        return value.isoformat()
    if isinstance(value, (pd.Timedelta,)):
        return value.total_seconds()
    if pd.isna(value):
        return None
    return value


@reports_bp.route("/api/report-viewer/run", methods=["POST"])
def report_viewer_run():
    """
    Run an ad‑hoc SQL query against the default DB connection.

    Only SELECT/CTE queries are allowed; max rows are capped to prevent
    oversize responses.
    """
    data = request.json or {}
    query = (data.get("query") or "").strip()
    conn_str = DEFAULT_DB_CONNECTION

    if not query:
        return jsonify({"error": "Query is required."}), 400
    if not _is_read_only_query(query):
        return (
            jsonify(
                {
                    "error": "Only SELECT (or WITH ... SELECT) queries are allowed. "
                    "Write/delete statements are disabled."
                }
            ),
            400,
        )

    max_rows = min(int(data.get("max_rows", 10000)), 50000)
    max_rows = max(1, max_rows)

    try:
        engine = get_db_engine(conn_str)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            df = pd.read_sql(text(query), engine, coerce_float=True)
        if df.empty:
            return jsonify({"columns": list(df.columns), "rows": [], "total_rows": 0})
        truncated = len(df) > max_rows
        if truncated:
            df = df.head(max_rows)
        rows = [{str(c): _report_viewer_serialize(r[c]) for c in df.columns} for _, r in df.iterrows()]
        return jsonify(
            {
                "columns": list(df.columns),
                "rows": rows,
                "total_rows": len(rows),
                "truncated": truncated,
            }
        )
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@reports_bp.route("/api/report-viewer/schema", methods=["GET", "POST"])
def report_viewer_schema():
    """
    Return a table index: all tables and their column headers in the
    default DB connection.
    """
    conn_str = DEFAULT_DB_CONNECTION
    try:
        engine = get_db_engine(conn_str)
        insp = inspect(engine)
        result = []

        schema_names = []
        try:
            for s in insp.get_schema_names():
                if s.lower() not in ("pg_catalog", "information_schema", "sys"):
                    schema_names.append(s)
        except Exception:
            schema_names = [None]
        if not schema_names:
            schema_names = [None]

        for schema_name in schema_names:
            try:
                table_names = insp.get_table_names(schema=schema_name) if schema_name else insp.get_table_names()
            except Exception:
                continue
            for t in table_names:
                try:
                    cols = insp.get_columns(t, schema=schema_name)
                except Exception:
                    continue
                result.append(
                    {
                        "schema": schema_name,
                        "table": t,
                        "columns": [c["name"] for c in cols],
                    }
                )
        return jsonify({"tables": result})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


def _parse_schedule_datetime(s: str):
    """Parse schedule datetime. Supports legacy date formats from app.py."""
    if not s or not str(s).strip():
        return None
    s = str(s).strip().replace("T", " ")
    if len(s) >= 15 and s[2] in "/-" and s[5] in "/-" and " " not in s[:10]:
        try:
            date_part = s[:10].replace("/", "-")
            time_part = s[10:16] if len(s) >= 16 else (s[10:] + ":00")[:5]
            if len(time_part) >= 5 and time_part[2] == ":":
                d, m, y = date_part.split("-")
                h, mi = time_part.split(":")
                return datetime(int(y), int(m), int(d), int(h), int(mi), 0)
        except (ValueError, TypeError, IndexError):
            pass

    formats_try = [
        ("%Y-%m-%d %H:%M:%S", 19),
        ("%Y-%m-%d %H:%M", 16),
        ("%Y-%m-%d", 10),
        ("%d-%m-%Y %H:%M:%S", 19),
        ("%d-%m-%Y %H:%M", 16),
        ("%d-%m-%Y", 10),
        ("%d/%m/%Y %H:%M:%S", 19),
        ("%d/%m/%Y %H:%M", 16),
        ("%d/%m/%Y", 10),
    ]
    for fmt, max_len in formats_try:
        try:
            to_parse = (s + " " * 20)[:max_len].rstrip()
            if not to_parse:
                continue
            return datetime.strptime(to_parse, fmt)
        except ValueError:
            continue
    parts = s.replace("/", "-").split()
    if parts:
        try:
            d, m, y = parts[0].split("-")
            h, mi = ("00", "00")
            if len(parts) > 1 and ":" in parts[1]:
                h, mi = parts[1].split(":", 1)
            return datetime(int(y), int(m), int(d), int(h), int(mi), 0)
        except (ValueError, IndexError):
            pass
    return None


@reports_bp.route("/api/run", methods=["POST"])
def run_reports():
    """
    Legacy-compatible Run Reports endpoint.

    Expects JSON (or form) with list_id, date_from/date_to, interval, etc.
    Schedules report execution and streams progress via /api/run/stream.
    """
    global run_queue

    data: Dict[str, Any] = request.get_json(silent=True) or request.form.to_dict() or {}
    list_id = data.get("list_id")
    date_from = (data.get("date_from") or "").strip()
    date_to = (data.get("date_to") or "").strip()
    if not list_id:
        return jsonify({"error": "list_id is required"}), 400

    report_list = storage.get_report_list(list_id)
    if not report_list:
        return jsonify({"error": "Report list not found"}), 404

    # Manual Run Reports sends profile_id from the Profile dropdown; honor it for credentials.
    # (Each list still stores a default profile_id for scheduler / backward compatibility.)
    requested_pid = (data.get("profile_id") or "").strip()
    list_profile_id = report_list.get("profile_id")
    profile_id = requested_pid or list_profile_id
    profile = None
    for p in storage.get_profiles():
        if p.get("id") == profile_id:
            profile = p
            break
    if not profile:
        return jsonify({"error": "Profile not found"}), 404

    all_reports = storage.get_reports(list_id)

    def is_active(r: Dict[str, Any]) -> bool:
        v = r.get("active", True)
        return v is True or (isinstance(v, str) and v.lower() == "true") or v == 1

    reports = [r for r in all_reports if not r.get("schedule_enabled") and is_active(r)]
    if not reports:
        if not all_reports:
            return jsonify({"error": "No reports in this list"}), 400
        return jsonify(
            {
                "error": "All reports in this list are scheduled; use each report's "
                "schedule instead of Run Reports."
            }
        ), 400

    global_start = _parse_schedule_datetime(date_from) or (datetime.now() - timedelta(days=1))
    global_end = _parse_schedule_datetime(date_to) or datetime.now()
    if global_start > global_end:
        global_start, global_end = global_end, global_start

    interval_val = (data.get("interval") or "").strip().lower()
    if interval_val == "daily":
        global_start = global_start.replace(hour=0, minute=0, second=0, microsecond=0)
        global_end = global_end.replace(hour=0, minute=0, second=0, microsecond=0)
        for r in reports:
            r["days"] = "1"
            r["recurrence"] = "day"
    elif interval_val == "weekly":
        global_start = global_start.replace(hour=0, minute=0, second=0, microsecond=0)
        global_end = global_end.replace(hour=0, minute=0, second=0, microsecond=0)
        for r in reports:
            r["days"] = "7"
            r["recurrence"] = "week"
    elif interval_val == "hourly":
        # Leave global_start/global_end as provided (may include times) and mark reports for hourly chunking.
        for r in reports:
            r["run_interval"] = "hourly"

    default_db_conn = DEFAULT_DB_CONNECTION
    max_threads = 1  # Sequential execution as in legacy app

    import threading as _threading
    import queue as _queue

    # Prefer legacy runner when available; otherwise use local V2 implementation.
    try:
        from app import _run_reports_impl  # type: ignore
    except Exception:
        _run_reports_impl = _run_reports_impl_v2

    run_queue = _queue.Queue()

    # For manual Run Reports, preserve the exact input times; do not apply any UTC/zone normalization.
    if data.get("sync"):
        _run_reports_impl(
            reports,
            profile,
            global_start,
            global_end,
            default_db_conn,
            max_threads,
            run_queue,
            preserve_input_times=True,
        )
        return jsonify({"status": "completed"})

    thread = _threading.Thread(
        target=_run_reports_impl,
        args=(
            reports,
            profile,
            global_start,
            global_end,
            default_db_conn,
            max_threads,
            run_queue,
            True,
        ),
        daemon=True,
    )
    thread.start()
    return jsonify({"status": "started"})


@reports_bp.route("/api/run/stream")
def run_stream():
    """SSE stream for Run Reports: log lines and db_result preview; always ends with type 'done'."""

    def generate():
        global run_queue
        try:
            q = run_queue
            if not q:
                yield f"data: {json.dumps({'type': 'done'})}\n\n"
                return
            while True:
                try:
                    msg = q.get(timeout=9000)
                    if msg == "__DONE__":
                        yield f"data: {json.dumps({'type': 'done'})}\n\n"
                        break
                    if isinstance(msg, dict) and "_curl" in msg:
                        yield f"data: {json.dumps({'type': 'msg', 'text': msg['_curl']})}\n\n"
                    elif isinstance(msg, dict) and "_db_result" in msg:
                        yield f"data: {json.dumps({'type': 'db_result', 'payload': msg['_db_result']})}\n\n"
                    else:
                        yield f"data: {json.dumps({'type': 'msg', 'text': str(msg)})}\n\n"
                except queue.Empty:
                    yield f"data: {json.dumps({'type': 'done'})}\n\n"
                    break
        except Exception as exc:
            yield f"data: {json.dumps({'type': 'msg', 'text': f'Stream error: {exc}'})}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@reports_bp.route("/api/scheduler/status", methods=["GET"])
def scheduler_status():
    """
    Lightweight scheduler status endpoint.

    The full scheduling logic is handled in backend_v2.services.report_manager;
    for now we simply report a basic "running" status so the frontend can
    poll without 404s.
    """
    return jsonify({"status": "running"})


@reports_bp.route("/api/scheduler/stream")
def scheduler_stream():
    """
    Basic SSE heartbeat stream for the scheduler.

    Until full scheduler event streaming is implemented, this endpoint
    emits a periodic no-op heartbeat so the React frontend does not see
    404 errors and can keep an open EventSource connection.
    """

    def generate():
        try:
            while True:
                payload = {"type": "heartbeat", "status": "running"}
                yield f"data: {json.dumps(payload)}\n\n"
                import time

                time.sleep(15)
        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)})}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@reports_bp.route("/api/profiles", methods=["GET"])
def get_profiles():
    """Return all configured profiles."""
    return jsonify(storage.get_profiles())


@reports_bp.route("/api/profiles", methods=["POST"])
def create_profile():
    """Create a new profile."""
    data = request.json or {}
    name = (data.get("name") or "").strip()
    username = (data.get("username") or "").strip()
    password = data.get("password", "")
    if not name or not username:
        return jsonify({"error": "Name and username are required"}), 400
    profile = storage.create_profile(name, username, password)
    if profile is None:
        return jsonify({"error": "A profile with this name already exists"}), 400
    return jsonify(profile), 201


@reports_bp.route("/api/profiles/<profile_id>", methods=["PUT"])
def update_profile(profile_id: str):
    """Update an existing profile."""
    data = request.json or {}
    result = storage.update_profile(profile_id, data)
    if result == "not_found":
        return jsonify({"error": "Profile not found"}), 404
    if result == "duplicate":
        return jsonify({"error": "A profile with this name already exists"}), 400
    if result == "invalid":
        return jsonify({"error": "Name and username cannot be empty"}), 400
    return jsonify(result)


@reports_bp.route("/api/profiles/<profile_id>", methods=["DELETE"])
def delete_profile(profile_id: str):
    """Delete a profile and its dependent lists/reports."""
    success = storage.delete_profile(profile_id)
    if not success:
        return jsonify({"error": "Profile not found"}), 404
    return jsonify({"success": True})


@reports_bp.route("/api/profiles/<profile_id>/report-lists", methods=["GET"])
def get_report_lists(profile_id: str):
    """Return all report lists for a given profile."""
    return jsonify(storage.get_report_lists(profile_id))


@reports_bp.route("/api/profiles/<profile_id>/report-lists", methods=["POST"])
def create_report_list(profile_id: str):
    """Create a new report list under the specified profile."""
    data = request.json or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "List name is required"}), 400
    report_list = storage.create_report_list(profile_id, name)
    if report_list is None:
        return jsonify({"error": "A list with this name already exists for this profile"}), 400
    return jsonify(report_list), 201


@reports_bp.route("/api/report-lists/<list_id>", methods=["PUT"])
def update_report_list(list_id: str):
    """Update a report list's metadata."""
    data = request.json or {}
    result = storage.update_report_list(list_id, data)
    if result == "not_found":
        return jsonify({"error": "Report list not found"}), 404
    if result == "duplicate":
        return jsonify({"error": "A list with this name already exists for this profile"}), 400
    if result == "invalid":
        return jsonify({"error": "List name cannot be empty"}), 400
    return jsonify(result)


@reports_bp.route("/api/report-lists/<list_id>", methods=["DELETE"])
def delete_report_list(list_id: str):
    """Delete a report list and its reports."""
    success = storage.delete_report_list(list_id)
    if not success:
        return jsonify({"error": "Report list not found"}), 404
    return jsonify({"success": True})


@reports_bp.route("/api/report-lists/<list_id>/reports", methods=["GET"])
def get_reports(list_id: str):
    """Return all reports for a given list."""
    return jsonify(storage.get_reports(list_id))


@reports_bp.route("/api/report-lists/<list_id>/reports", methods=["POST"])
def create_report_for_list(list_id: str):
    """Create a report inside the given list."""
    data = request.json or {}
    report = storage.create_report(list_id, data)
    if report is None:
        return jsonify({"error": "Report list not found"}), 404
    return jsonify(report), 201


@reports_bp.route("/api/report-lists/<list_id>/import-csv", methods=["POST"])
def import_reports_csv(list_id: str):
    """
    Import reports from a CSV file into the given report list.

    CSV format: Template Name, cURL command, Filename, Save To, Days,
    Recurrence, Output Mode, Date Format, Send times in, DB Table Name,
    DB Connection String.
    """
    if storage.get_report_list(list_id) is None:
        return jsonify({"error": "Report list not found"}), 404
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400
    f = request.files["file"]
    if not f.filename or not f.filename.lower().endswith(".csv"):
        return jsonify({"error": "Please upload a CSV file"}), 400
    try:
        stream = io.StringIO(f.stream.read().decode("utf-8-sig", errors="replace"))
        reader = csv.DictReader(stream)
        if not reader.fieldnames:
            return jsonify({"error": "CSV has no header row"}), 400

        def _normalize_csv_header(h: str) -> str:
            return (h or "").strip().lower().replace(" ", "_").replace("(", "").replace(")", "")

        headers = {_normalize_csv_header(h): h for h in reader.fieldnames}
        created = 0
        for row in reader:
            def get(key_aliases, default=""):
                for k in key_aliases:
                    orig = headers.get(k) or k
                    v = row.get(orig)
                    if v is not None and str(v).strip():
                        return str(v).strip()
                return default

            template_name = get(["template_name", "template name"], "")
            curl_cmd = get(["curl_command", "curl command", "curlcommand"], "")
            if not curl_cmd:
                continue
            filename = get(["filename"], "") or template_name or "report"
            save_to = get(["save_to_folder_path", "save_to", "save to"], "")
            days = get(["days"], "")
            recurrence = get(["recurrence"], "")
            output_mode_raw = get(["output_mode", "output mode"], "csv")
            output_mode = "db" if output_mode_raw.upper() == "DB" else "csv"
            date_format = get(["date_format", "date format"], "")
            api_timezone = get(["send_times_in", "send times in"], "GMT")
            db_table_name = get(["db_table_name", "db table name"], "") or template_name
            db_connection_string = get(["db_connection_string", "db connection string"], "")
            report_data = {
                "active": True,
                "api_curl": curl_cmd,
                "filename": filename,
                "save_to": save_to,
                "days": days,
                "recurrence": recurrence,
                "output_mode": output_mode,
                "db_table_name": db_table_name,
                "db_connection_string": db_connection_string,
                "date_format": date_format,
                "api_timezone": api_timezone or "GMT",
                "schedule_enabled": False,
            }
            report = storage.create_report(list_id, report_data)
            if report:
                created += 1
        return jsonify({"ok": True, "imported": created})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@reports_bp.route("/api/import-csv-to-db", methods=["POST"])
def import_csv_to_db_route():
    """
    Import one or more CSV files into database tables using the default
    connection (or an override per item).

    This is a simplified but compatible implementation of the legacy
    /api/import-csv-to-db endpoint, preserving its form-field contract.
    """
    default_conn = DEFAULT_DB_CONNECTION
    count = request.form.get("count")
    try:
        count = int(count) if count is not None else 0
    except ValueError:
        count = 0

    results = []
    total_rows = 0
    items = max(count, 1)

    for i in range(items):
        if count == 0 and i > 0:
            break

        file_key = f"file_{i}" if count > 0 else "file"
        f = request.files.get(file_key)
        table_name_key = f"table_name_{i}" if count > 0 else "table_name"
        table_name_alt_key = f"table_{i}" if count > 0 else "table"
        table_name = (
            (request.form.get(table_name_key) or request.form.get(table_name_alt_key) or "").strip()
        )
        conn_key = f"db_connection_string_{i}" if count > 0 else "db_connection_string"
        conn_alt_key = f"db_connection_{i}" if count > 0 else "db_connection"
        conn_str = (request.form.get(conn_key) or request.form.get(conn_alt_key) or "").strip()
        if not conn_str:
            conn_str = default_conn

        if count == 0 and i == 0:
            if not f or not (f.filename or "").lower().endswith(".csv"):
                return jsonify({"error": "No CSV file provided"}), 400
            if not table_name:
                return jsonify({"error": "table_name is required"}), 400

        if count > 0:
            if not f or not (f.filename or "").lower().endswith(".csv"):
                continue
            if not table_name:
                results.append(
                    {"index": i, "filename": getattr(f, "filename", ""), "error": "table_name is required"}
                )
                continue

        if any(ch in table_name for ch in ("/", "\\", ";")):
            if count > 0:
                results.append(
                    {"index": i, "filename": getattr(f, "filename", ""), "error": "Invalid table name"}
                )
                continue
            return jsonify({"error": "Invalid table name"}), 400

        try:
            raw = f.stream.read().decode("utf-8-sig", errors="replace")
            df = pd.read_csv(io.StringIO(raw), low_memory=False)
            if df.empty:
                results.append(
                    {
                        "index": i,
                        "filename": getattr(f, "filename", ""),
                        "table_name": table_name,
                        "rows_imported": 0,
                    }
                )
                continue
            n = import_dataframe_to_db(conn_str, table_name, df, unique_key_columns=None)
            total_rows += n
            results.append(
                {
                    "index": i,
                    "filename": getattr(f, "filename", ""),
                    "table_name": table_name,
                    "rows_imported": n,
                }
            )
        except Exception as exc:
            if count > 0:
                results.append(
                    {
                        "index": i,
                        "filename": getattr(f, "filename", ""),
                        "table_name": table_name,
                        "error": str(exc),
                    }
                )
            else:
                return jsonify({"error": str(exc)}), 500

    if count == 0 and not results:
        return jsonify({"error": "No CSV file provided"}), 400

    return jsonify(
        {
            "ok": True,
            "rows_imported": total_rows,
            "results": results,
            "items_processed": len(results),
        }
    )


@reports_bp.route("/api/reports/<report_id>", methods=["PUT"])
def update_report(report_id: str):
    """Update a report definition."""
    data = request.json or {}
    report = storage.update_report(report_id, data)
    if report is None:
        return jsonify({"error": "Report not found"}), 404
    return jsonify(report)


@reports_bp.route("/api/reports/<report_id>", methods=["DELETE"])
def delete_report(report_id: str):
    """Delete a report definition."""
    success = storage.delete_report(report_id)
    if not success:
        return jsonify({"error": "Report not found"}), 404
    return jsonify({"success": True})


@reports_bp.route("/api/ops-dashboard/metrics", methods=["GET"])
def ops_dashboard_metrics():
    """
    Read-only aggregates for the Operations dashboard (scheduled CSV → PostgreSQL).
    Optional: ?hours=24&db_connection_string=...
    """
    raw = (request.args.get("hours") or "24").strip()
    try:
        hours = int(raw)
    except ValueError:
        hours = 24
    conn = (request.args.get("db_connection_string") or "").strip() or None
    try:
        return jsonify(get_ops_dashboard_metrics(conn, hours))
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


__all__ = ["reports_bp"]

