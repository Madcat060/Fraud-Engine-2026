"""
backend_v2.services.report_manager
----------------------------------

Lightweight orchestration layer for report scheduling, external API
fetching and CSV ingestion.

The full legacy implementation in ``app.py`` is substantial.  For the
purposes of backend_v2 we provide a focused, modular API that can be
extended incrementally.  The scheduler loop and CSV ingestion entrypoint
are implemented here so :mod:`backend_v2.service_reports` can run
independently of the legacy monolith.
"""

from __future__ import annotations

import json
import logging
import queue
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, Optional

log = logging.getLogger(__name__)

_DATA_DIR = Path(__file__).resolve().parent / "data"
_SCHEDULER_STATE_PATH = _DATA_DIR / "scheduler_state.json"

import pandas as pd

from sqlalchemy import text
from sqlalchemy import inspect as sa_inspect

from backend_v2.config import DEFAULT_DB_CONNECTION
from backend_v2.database import get_db_engine


def _pg_quote_ident(name: str) -> str:
    """Quote identifier for PostgreSQL (handles spaces and case)."""
    return '"' + str(name).replace('"', '""') + '"'


def _drop_legacy_uniq_constraints(conn, full_target: str, schema: Optional[str], base_table: str) -> None:
    """
    Drop unique constraints on the target table that were created by the old
    ON CONFLICT ingestion (naming pattern uniq_*). This allows the EXCEPT-based
    insert to run without UniqueViolation; dedup is then full-row only via EXCEPT.
    """
    if schema:
        schema_cond = "n.nspname = :schema"
        params = {"schema": schema, "tname": base_table}
    else:
        schema_cond = "n.nspname = 'public'"
        params = {"tname": base_table}
    q = text(
        f"""
        SELECT c.conname
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE c.contype = 'u'
          AND t.relname = :tname
          AND {schema_cond}
          AND c.conname LIKE 'uniq_%'
        """
    )
    try:
        rows = conn.execute(q, params).fetchall()
        for (conname,) in rows:
            quoted = _pg_quote_ident(conname)
            conn.execute(text(f"ALTER TABLE {full_target} DROP CONSTRAINT IF EXISTS {quoted}"))
    except Exception:
        pass


def _infer_pg_type(series: pd.Series) -> str:
    """Infer PostgreSQL type from a pandas Series for ALTER TABLE ADD COLUMN."""
    s = series.dropna()
    if s.empty:
        return "TEXT"
    try:
        s_numeric = pd.to_numeric(s, errors="raise")
        if (s_numeric % 1 == 0).all():
            return "BIGINT"
        return "DOUBLE PRECISION"
    except Exception:
        pass
    try:
        _ = pd.to_datetime(s, format='%Y-%m-%d %H:%M:%S', errors="raise")
        return "TIMESTAMP"
    except Exception:
        pass
    return "TEXT"


# Simple in‑memory queue used by /api/run and /api/run/stream.
RUN_QUEUE: "queue.Queue[Any]" = queue.Queue()


@dataclass
class ReportJob:
    sql: str
    db_connection: str = DEFAULT_DB_CONNECTION
    max_rows: int = 10_000


def _normalize_cash_games_player_stats(df: pd.DataFrame) -> pd.DataFrame:
    """Rename and cast columns for Report 16770 Cash Games Player Stats to match Fraud Engine expectations."""
    out = df.copy()
    # Column renames (Playtech report headers -> Fraud Engine)
    renames = {
        "VIPI %": "VPIP",
        "3-bet %": "3-bet",
        "4-bet %": "4-bet",
    }
    for old_name, new_name in renames.items():
        if old_name in out.columns:
            out = out.rename(columns={old_name: new_name})
    # Cast Hands to integer
    if "Hands" in out.columns:
        out["Hands"] = pd.to_numeric(out["Hands"], errors="coerce").fillna(0).astype("int64")
    # Percentage columns: cast to float (Fraud Engine / HUD expect numeric)
    pct_columns = [
        "VPIP", "PFR", "3-bet", "4-bet", "Limp", "WTSD", "WSD",
        "Flop Cbet", "Turn Cbet", "River Cbet", "Post flop AGG",
        "Attempt to Steal", "Fold vs Flop Cbet", "Call vs Flop Cbet", "Raise vs Flop Cbet",
        "Delayed CBet", "Donk Bet Turn", "Overbet River",
    ]
    for col in pct_columns:
        if col in out.columns:
            out[col] = pd.to_numeric(out[col], errors="coerce").astype("float64")
    return out


# Snapshot table: each export replaces the row for that player (same "Player Code").
_PRIMARY_ACCOUNT_INFORMATION = "primary_account_information"
_PLAYER_CODE_COLUMN = "Player Code"


def _is_primary_account_information_table(base_table: str) -> bool:
    return (base_table or "").strip().replace("-", "_").lower() == _PRIMARY_ACCOUNT_INFORMATION


def import_dataframe_to_db(
    conn_str: str,
    table_name: str,
    df: pd.DataFrame,
    unique_key_columns: Optional[list] = None,
) -> int:
    """
    Robust CSV/DataFrame ingestion helper for backend_v2.

    Behaviour:
    - Ensures the target table has all columns from the DataFrame (ALTER TABLE ADD COLUMN).
    - Loads rows into a per‑call staging table with the same schema as the target
      (CREATE TEMP TABLE ... LIKE target INCLUDING DEFAULTS).
    - Default: inserts only rows that are not full-row exact duplicates of existing rows using
      a set-based EXCEPT (no unique constraints required).
    - Special case — table name ``Primary_Account_information`` (case-insensitive, any ``_``/``-``
      variant on the base name): **upsert by** ``"Player Code"`` only. Rows in the import with the
      same code replace existing rows (after deduplicating the batch so the last row per code wins).
      Applies to CSV upload and automated report DB imports whenever the target table is named that way.
    - Drops the staging table at the end.
    """
    if df.empty:
        return 0

    table_norm = (table_name or "").strip().replace("-", "_")
    if table_norm.lower() == "cash_games_player_stats":
        df = _normalize_cash_games_player_stats(df)
        if df.empty:
            return 0

    # Resolve schema and base table name (before engine; dedupe needs base_table)
    if "." in table_norm:
        parts = table_norm.split(".")
        schema, base_table = parts[0], parts[-1]
    else:
        schema, base_table = None, table_norm

    account_upsert = _is_primary_account_information_table(base_table) and _PLAYER_CODE_COLUMN in df.columns
    if account_upsert:
        df = df.copy()
        df = df.drop_duplicates(subset=[_PLAYER_CODE_COLUMN], keep="last")
        if df.empty:
            return 0

    engine = get_db_engine(conn_str)
    inspector = sa_inspect(engine)

    table_exists = inspector.has_table(base_table, schema=schema)
    existing_cols: set[str] = set()
    if table_exists:
        existing_cols = {c["name"] for c in inspector.get_columns(base_table, schema=schema)}
        columns = list(df.columns)
        to_add = [c for c in columns if c not in existing_cols]
        if to_add:
            table_sql = _pg_quote_ident(schema) + "." + _pg_quote_ident(base_table) if schema else _pg_quote_ident(base_table)
            with engine.begin() as conn:
                for col in to_add:
                    sql_type = _infer_pg_type(df[col])
                    quoted_col = _pg_quote_ident(col)
                    alter_sql = text(f"ALTER TABLE {table_sql} ADD COLUMN {quoted_col} {sql_type}")
                    conn.execute(alter_sql)
        existing_cols = {c["name"] for c in inspector.get_columns(base_table, schema=schema)}

    # If target table does not exist, simple append (let to_sql create or caller ensure table exists)
    if not table_exists:
        with engine.begin() as conn:
            df.to_sql(
                table_norm,
                conn,
                if_exists="append",
                index=False,
                chunksize=1000,
            )
        return len(df)

    from uuid import uuid4

    # Use lowercase to avoid PostgreSQL/SQLAlchemy case-sensitivity warning after to_sql
    staging_table = f"__staging_{base_table.lower()}_{uuid4().hex[:8]}"
    if schema:
        full_target = _pg_quote_ident(schema) + "." + _pg_quote_ident(base_table)
    else:
        full_target = _pg_quote_ident(base_table)
    staging_ident = _pg_quote_ident(staging_table)

    rows_inserted = 0
    pc_q = _pg_quote_ident(_PLAYER_CODE_COLUMN)
    with engine.begin() as conn:
        # 0. Drop legacy unique constraints so EXCEPT insert avoids UniqueViolation (not used for account upsert).
        if not account_upsert:
            _drop_legacy_uniq_constraints(conn, full_target, schema, base_table)

        # 1. Create temp staging table that mirrors the target table's schema (columns aligned for EXCEPT)
        create_temp_sql = text(
            f"CREATE TEMP TABLE {staging_ident} (LIKE {full_target} INCLUDING DEFAULTS)"
        )
        conn.execute(create_temp_sql)

        # 2. Load DataFrame into the temp staging table; PostgreSQL enforces types
        df.to_sql(
            staging_table,
            conn,
            if_exists="append",
            index=False,
            chunksize=1000,
        )

        if account_upsert:
            # Replace any existing row whose Player Code appears in this batch (non-null keys only).
            delete_sql = text(
                f"DELETE FROM {full_target} AS t "
                f"WHERE t.{pc_q} IN ("
                f"  SELECT s.{pc_q} FROM {staging_ident} AS s WHERE s.{pc_q} IS NOT NULL"
                f")"
            )
            conn.execute(delete_sql)
            insert_sql = text(f"INSERT INTO {full_target} SELECT * FROM {staging_ident}")
            result = conn.execute(insert_sql)
            rows_inserted = result.rowcount or 0
        else:
            # 3. Insert only rows from staging that do not have a full-row exact match in the target
            insert_sql = text(
                f"INSERT INTO {full_target} "
                f"SELECT * FROM {staging_ident} EXCEPT SELECT * FROM {full_target}"
            )
            result = conn.execute(insert_sql)
            rows_inserted = result.rowcount or 0

        # 4. Drop staging table
        try:
            drop_sql = text(f"DROP TABLE IF EXISTS {staging_ident}")
            conn.execute(drop_sql)
        except Exception:
            pass

    return int(rows_inserted)


def _execute_report_job(job: ReportJob) -> None:
    """
    Execute a single SQL report job and push status messages + a small
    preview of the result set into RUN_QUEUE for SSE consumers.
    """
    try:
        RUN_QUEUE.put({"type": "msg", "text": f"Starting report query (max_rows={job.max_rows})..."})
        engine = get_db_engine(job.db_connection)
        with engine.connect() as conn:
            df = pd.read_sql(text(job.sql), conn)

        if df.empty:
            RUN_QUEUE.put({"type": "msg", "text": "Query completed – no rows returned."})
            RUN_QUEUE.put({"type": "db_result", "rows": [], "columns": [], "total_rows": 0})
        else:
            truncated = len(df) > job.max_rows
            if truncated:
                df = df.head(job.max_rows)
            rows = [dict(r) for _, r in df.iterrows()]
            RUN_QUEUE.put(
                {
                    "type": "db_result",
                    "rows": rows,
                    "columns": list(df.columns),
                    "total_rows": len(rows),
                    "truncated": truncated,
                }
            )
            RUN_QUEUE.put({"type": "msg", "text": f"Query completed ({len(rows)} rows)."})
    except Exception as exc:  # pragma: no cover - defensive logging
        RUN_QUEUE.put({"type": "msg", "text": f"Report job failed: {exc}"})
    finally:
        RUN_QUEUE.put("__DONE__")


def _load_scheduler_state() -> dict:
    """Persisted last-run times per report id (epoch seconds)."""
    _DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not _SCHEDULER_STATE_PATH.exists():
        return {"last_run": {}}
    try:
        with open(_SCHEDULER_STATE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return {"last_run": {}}
        if not isinstance(data.get("last_run"), dict):
            data["last_run"] = {}
        return data
    except Exception as exc:  # pragma: no cover
        log.warning("scheduler state load failed: %s", exc)
        return {"last_run": {}}


def _save_scheduler_state(data: dict) -> None:
    try:
        _DATA_DIR.mkdir(parents=True, exist_ok=True)
        with open(_SCHEDULER_STATE_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
    except Exception as exc:  # pragma: no cover
        log.warning("scheduler state save failed: %s", exc)


def _interval_to_timedelta(report: dict) -> timedelta:
    try:
        v = int(report.get("schedule_interval_value") or 5)
    except (TypeError, ValueError):
        v = 5
    v = max(1, v)
    unit = str(report.get("schedule_interval_unit") or "minutes").lower()
    if unit == "hours":
        return timedelta(hours=v)
    if unit == "days":
        return timedelta(days=v)
    return timedelta(minutes=v)


def _build_playtech_date_window(report: dict) -> tuple[datetime, datetime] | None:
    """
    Start/end datetimes for Playtech (naive UTC/GMT wall time).

    - **minutes**: end = UTC now minus 1 minute, or minus 5 minutes when N < 3 (tight polling);
      start = end minus N minutes.
    - **hours**: end = UTC now minus 1 minute; start = end minus N hours.
    - **days**: full calendar day in UTC — 00:00:00 through 23:59:59 (GMT), regardless of tick time.
    """
    try:
        iv = int(report.get("schedule_interval_value") or 5)
    except (TypeError, ValueError):
        iv = 5
    iv = max(1, iv)
    unit = str(report.get("schedule_interval_unit") or "minutes").lower()

    # Short minute-based intervals need a larger safety margin so the end is not “too fresh”.
    if unit == "minutes" and iv < 3:
        end_lag = timedelta(minutes=5)
    else:
        end_lag = timedelta(minutes=1)
    now_utc = datetime.now(timezone.utc).replace(microsecond=0)

    if unit == "days":
        d = now_utc.date()
        ge = datetime(d.year, d.month, d.day, 23, 59, 59, tzinfo=timezone.utc)
        gs = datetime(d.year, d.month, d.day, 0, 0, 0, tzinfo=timezone.utc)
    else:
        ge = now_utc - end_lag
        if unit == "hours":
            gs = ge - timedelta(hours=iv)
        elif unit == "minutes":
            gs = ge - timedelta(minutes=iv)
        else:
            gs = ge - timedelta(minutes=iv)

    def naive_utc(dt: datetime) -> datetime:
        if dt.tzinfo is None:
            return dt
        return dt.replace(tzinfo=None)

    global_start = naive_utc(gs)
    global_end = naive_utc(ge)
    if global_start >= global_end:
        return None
    return global_start, global_end


def _scheduler_tick() -> None:
    """
    Load enabled scheduled reports from Storage; for each report whose schedule window
    contains local "now" and whose interval has elapsed since last run, execute the same
    API→CSV→DB path as manual Run Reports.

    Playtech date range follows schedule_interval_unit: see :func:`_build_playtech_date_window`.
    """
    from backend_v2.api.routes_reports import _parse_schedule_datetime, _run_reports_impl_v2
    from backend_v2.services.storage import Storage

    storage = Storage()
    settings = storage.get_settings() or {}
    default_db = (settings.get("default_db_connection_string") or "").strip() or DEFAULT_DB_CONNECTION

    scheduled = storage.get_all_reports_with_schedules()
    if not scheduled:
        return

    now = datetime.now().replace(microsecond=0)
    now_ts = time.time()
    state = _load_scheduler_state()
    last_run: Dict[str, Any] = state.setdefault("last_run", {})

    for report in scheduled:
        rid = str(report.get("id") or "")
        if not rid:
            continue

        win_start = _parse_schedule_datetime(str(report.get("schedule_start") or ""))
        win_end = _parse_schedule_datetime(str(report.get("schedule_end") or ""))
        if not win_start or not win_end:
            log.debug("scheduler: report %s missing schedule_start/end", rid)
            continue
        if win_end < win_start:
            win_start, win_end = win_end, win_start

        if now < win_start:
            continue
        if now > win_end:
            if rid in last_run:
                del last_run[rid]
                _save_scheduler_state(state)
            continue

        interval_td = _interval_to_timedelta(report)
        interval_sec = max(60.0, float(interval_td.total_seconds()))

        prev = last_run.get(rid)
        if prev is not None:
            try:
                prev_f = float(prev)
            except (TypeError, ValueError):
                prev_f = 0.0
            if now_ts - prev_f < interval_sec:
                continue

        list_id = report.get("list_id")
        rl = storage.get_report_list(list_id) if list_id else None
        if not rl:
            log.warning("scheduler: report %s invalid list_id", rid)
            continue
        profile_id = rl.get("profile_id")
        profile = None
        for p in storage.get_profiles():
            if p.get("id") == profile_id:
                profile = p
                break
        if not profile:
            log.warning("scheduler: report %s profile missing", rid)
            continue

        built = _build_playtech_date_window(report)
        if built is None:
            log.warning("scheduler: report %s could not build Playtech date window", rid)
            continue
        global_start, global_end = built

        out_q: queue.Queue[Any] = queue.Queue()
        label = report.get("filename") or report.get("db_table_name") or rid
        log.info(
            "scheduler: running report id=%s name=%s window UTC %s -> %s",
            rid,
            label,
            global_start.isoformat(sep=" "),
            global_end.isoformat(sep=" "),
        )
        try:
            _run_reports_impl_v2(
                [report],
                profile,
                global_start,
                global_end,
                default_db,
                1,
                out_q,
                preserve_input_times=True,
            )
            while True:
                item = out_q.get()
                if item == "__DONE__":
                    break
                if isinstance(item, str):
                    log.info("%s", item)
        except Exception as exc:
            log.exception("scheduler: report %s failed: %s", rid, exc)
            continue

        last_run[rid] = now_ts
        _save_scheduler_state(state)


def enqueue_report_run(sql: str, db_connection: Optional[str] = None, max_rows: int = 10_000) -> None:
    """
    Enqueue a report execution job and return immediately.  Results and
    progress messages are streamed via :data:`RUN_QUEUE` and consumed by
    the SSE endpoint in :mod:`backend_v2.api.routes_reports`.
    """
    job = ReportJob(sql=sql, db_connection=db_connection or DEFAULT_DB_CONNECTION, max_rows=max_rows)
    threading.Thread(target=_execute_report_job, args=(job,), daemon=True).start()


def scheduler_loop(poll_interval_seconds: int = 30) -> None:
    """
    Background loop: poll Storage for ``schedule_enabled`` reports, and when
    current time lies between ``schedule_start`` and ``schedule_end`` and the
    interval since the last run has elapsed, call :func:`_run_reports_impl_v2`
    (same path as manual Run Reports). Last-run times persist in
    ``data/scheduler_state.json`` next to ``app_data.json``.
    """
    log.info("Report scheduler started (poll every %ss); state file %s", poll_interval_seconds, _SCHEDULER_STATE_PATH)
    while True:
        try:
            _scheduler_tick()
        except Exception:  # pragma: no cover
            log.exception("scheduler tick failed")
        time.sleep(poll_interval_seconds)


__all__ = [
    "RUN_QUEUE",
    "enqueue_report_run",
    "import_dataframe_to_db",
    "scheduler_loop",
]

