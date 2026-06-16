"""
Read-only aggregates for the Operations dashboard (Report Manager).

Resolves PostgreSQL tables by the underscore import names only. Fraud Engine
``Primary_*`` tables are intentionally not used here.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Optional

from sqlalchemy import inspect as sa_inspect, text

from backend_v2.config import DEFAULT_DB_CONNECTION
from backend_v2.database import get_db_engine, mask_connection_url
from backend_v2.services.report_manager import _pg_quote_ident

log = logging.getLogger(__name__)

# DB table names for scheduled / CSV imports (underscore names only — not Fraud ``Primary_*``).
TABLE_KEYS = {
    "login": ["login_activity_by_player"],
    "sng": ["sng_twister_and_mtt"],
    "network_activity": ["network_activity"],
    "network_disconnection": ["network_disconnection_rate"],
    "poker_business": ["poker_business_activity_monitoring"],
    "tournament_disconnection": [
        "tournament_disconnection_report_by_player",
        "tournament_disconnection_report",
        "tournament_disconnection",
    ],
}

# Exact spellings the dashboard charts expect (Playtech CSV). Rows from PG often use lowercased keys.
_NETWORK_CANONICAL_COLUMNS: tuple[str, ...] = (
    "Statistics date",
    "Avg # of real tables",
    "Average # of fun tables",
    "Max # of real tables",
    "Max # of fun tables",
    "Min # of real tables",
    "Min # of fun tables",
    "Average # of real players",
    "Average # of fun players",
    "Max # of real players",
    "Max # of fun players",
    "Min # of real players",
    "Min # of fun players",
    "Average # of connected players",
    "Max # of connected players",
    "Min # of connected players",
    "Average # of tournaments",
    "Max # of tournaments",
    "Min # of tournaments",
    "Average # of players in tournaments",
    "Max # of players in tournaments",
    "Min # of players in tournaments",
)


def _qi(ident: str) -> str:
    return _pg_quote_ident(ident)


def _all_public_tables(inspector, schema: Optional[str]) -> list[str]:
    try:
        return list(inspector.get_table_names(schema=schema))
    except Exception:
        return []


def _match_table_name(want: str, existing: list[str]) -> Optional[str]:
    """Case- and hyphen-insensitive match (e.g. Network_activity → network_activity)."""
    w = want.replace("-", "_").lower()
    for t in existing:
        if t.replace("-", "_").lower() == w:
            return t
    return None


def _resolve_tables(inspector, schema: Optional[str]) -> dict[str, Optional[str]]:
    existing = _all_public_tables(inspector, schema)
    out: dict[str, Optional[str]] = {}
    for key, candidates in TABLE_KEYS.items():
        found = None
        for name in candidates:
            if inspector.has_table(name, schema=schema):
                found = name
                break
        if not found and existing:
            for name in candidates:
                m = _match_table_name(name, existing)
                if m:
                    found = m
                    break
        out[key] = found
    return out


def _full_table_ident(schema: Optional[str], table: str) -> str:
    if schema:
        return f"{_qi(schema)}.{_qi(table)}"
    return _qi(table)


def _safe_float(v: Any) -> Optional[float]:
    if v is None:
        return None
    try:
        x = float(v)
        if x != x:  # NaN
            return None
        return x
    except (TypeError, ValueError):
        return None


def _column_names(inspector, schema: Optional[str], table: str) -> list[str]:
    if not table or not inspector.has_table(table, schema=schema):
        return []
    return [c["name"] for c in inspector.get_columns(table, schema=schema)]


def _resolve_col(names: list[str], candidates: tuple[str, ...]) -> Optional[str]:
    """Match CSV / PG column name with case-insensitive fallback."""
    nset = set(names)
    lower_map = {n.lower(): n for n in names}
    for c in candidates:
        if c in nset:
            return c
        if c.lower() in lower_map:
            return lower_map[c.lower()]
    return None


def _resolve_col_by_substrings(
    names: list[str],
    keywords: tuple[str, ...],
    *,
    require_any: Optional[tuple[str, ...]] = None,
) -> Optional[str]:
    """First column whose normalized name contains a keyword (exports vary)."""
    for n in names:
        norm = n.lower().replace("_", " ").replace("-", " ")
        if require_any and not any(r in norm for r in require_any):
            continue
        for kw in keywords:
            if kw in norm:
                return n
    return None


def _row_to_dashboard_json(row: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in row.items():
        if v is None:
            out[k] = None
        elif hasattr(v, "isoformat"):
            try:
                out[k] = v.isoformat()
            except Exception:
                out[k] = str(v)
        elif isinstance(v, Decimal):
            out[k] = float(v)
        elif isinstance(v, (int, float)):
            out[k] = v
        else:
            s = str(v).strip()
            if s == "":
                out[k] = None
            else:
                try:
                    out[k] = float(s.replace(",", ""))
                except ValueError:
                    out[k] = s
    return out


def _network_row_canonicalize(row: dict[str, Any]) -> dict[str, Any]:
    """
    Copy values onto canonical Playtech header names so JSON keys match the UI.

    PostgreSQL / pandas often yield lowercase column names; charts look for mixed-case headers.
    """
    lower_to_val: dict[str, Any] = {}
    for k, v in row.items():
        lower_to_val[str(k).lower()] = v
    out = dict(row)
    for canon in _NETWORK_CANONICAL_COLUMNS:
        lk = canon.lower()
        if canon in out and out[canon] is not None and str(out[canon]).strip() != "":
            continue
        if lk in lower_to_val:
            out[canon] = lower_to_val[lk]
    return out


def get_ops_dashboard_metrics(
    db_connection_string: Optional[str],
    hours: int = 24,
) -> dict[str, Any]:
    hours = max(1, min(int(hours or 24), 168))
    interval_hours = f"{hours} hours"
    conn_str = (db_connection_string or "").strip() or DEFAULT_DB_CONNECTION
    engine = get_db_engine(conn_str)
    inspector = sa_inspect(engine)
    schema: Optional[str] = None

    tables = _resolve_tables(inspector, schema)
    refreshed_at = datetime.now(timezone.utc).isoformat()
    payload: dict[str, Any] = {
        "refreshed_at": refreshed_at,
        "hours": hours,
        "tables": tables,
        "kpis": {},
        "series": {},
        "bars": {},
        "meta": {"database": mask_connection_url(conn_str)},
        "errors": [],
    }

    def add_err(msg: str) -> None:
        payload["errors"].append(msg)

    # --- Login / logout activity ---
    t_login = tables.get("login")
    if t_login:
        ft = _full_table_ident(schema, t_login)
        login_names = _column_names(inspector, schema, t_login)
        login_ts = _resolve_col(
            login_names,
            (
                "Login Date Time",
                "LoginDate",
                "Login date",
                "logindate",
                "Login Date",
            ),
        )
        player_code_col = _resolve_col(login_names, ("Player Code", "Player code", "player_code"))
        if not login_ts:
            add_err(
                "login_activity: no login timestamp column (need one of: "
                "Login Date Time, LoginDate, Login date)"
            )
        else:
            payload["meta"]["login_time_column"] = login_ts
            ts_q = _qi(login_ts)
            try:
                with engine.connect() as conn:
                    pc_sql = _qi(player_code_col) if player_code_col else None
                    if pc_sql:
                        sum_sql = f"""
                            SELECT COUNT(*)::bigint AS n,
                                   COUNT(DISTINCT {pc_sql})::bigint AS players
                            FROM {ft}
                            WHERE NULLIF(TRIM({ts_q}::text), '') IS NOT NULL
                              AND ({ts_q})::timestamp >= NOW() - CAST(:iv AS interval)
                            """
                    else:
                        sum_sql = f"""
                            SELECT COUNT(*)::bigint AS n
                            FROM {ft}
                            WHERE NULLIF(TRIM({ts_q}::text), '') IS NOT NULL
                              AND ({ts_q})::timestamp >= NOW() - CAST(:iv AS interval)
                            """
                    r = conn.execute(text(sum_sql), {"iv": interval_hours}).mappings().first()
                    if r:
                        payload["kpis"]["logins_window"] = int(r["n"] or 0)
                        if pc_sql and r.get("players") is not None:
                            payload["kpis"]["unique_players_login_window"] = int(r["players"] or 0)
                    rows = conn.execute(
                        text(
                            f"""
                            SELECT date_trunc('hour', ({ts_q})::timestamp) AS hr,
                                   COUNT(*)::bigint AS n
                            FROM {ft}
                            WHERE ({ts_q})::timestamp >= NOW() - CAST(:iv AS interval)
                            GROUP BY 1
                            ORDER BY 1 ASC
                            """
                        ),
                        {"iv": interval_hours},
                    ).mappings().all()
                    payload["series"]["logins_by_hour"] = [
                        {"t": row["hr"].isoformat() if row["hr"] else None, "v": int(row["n"] or 0)}
                        for row in rows
                        if row["hr"] is not None
                    ]
            except Exception as e:
                log.warning("[ops-dashboard] login_activity: %s", e)
                add_err(f"login_activity: {e}")

    # --- Tournament / fees (SNG / MTT / Twister extract) ---
    t_sng = tables.get("sng")
    if t_sng:
        ft = _full_table_ident(schema, t_sng)
        sng_names = _column_names(inspector, schema, t_sng)
        sd = _resolve_col(
            sng_names,
            ("Stats date", "stats date", "Statistics date", "statistics date", "STATSDATE"),
        )
        fees_c = _resolve_col(sng_names, ("Fees", "fees", "Fee", "fee"))
        buy_c = _resolve_col(
            sng_names,
            ("Buy-ins", "Buy ins", "buy-ins", "buy_ins", "Buyins", "buyins"),
        )
        tt_c = _resolve_col(
            sng_names,
            ("Tournament type", "tournament type", "Tournament Type"),
        )
        if not sd:
            add_err("sng_twister_and_mtt: no Stats date column (try Stats date or stats date)")
        elif not fees_c or not buy_c:
            add_err("sng_twister_and_mtt: missing Fees and/or Buy-ins column")
        else:
            payload["meta"]["sng_stats_date_column"] = sd
            payload["meta"]["sng_fees_column"] = fees_c
            payload["meta"]["sng_buyins_column"] = buy_c
            sd_q = _qi(sd)
            fees_q = _qi(fees_c)
            buy_q = _qi(buy_c)
            tt_q = _qi(tt_c) if tt_c else None
            try:
                with engine.connect() as conn:
                    r = conn.execute(
                        text(
                            f"""
                            SELECT
                              COALESCE(SUM(
                                CASE WHEN NULLIF(TRIM({fees_q}::text), '') IS NOT NULL
                                  THEN TRIM({fees_q}::text)::double precision ELSE 0 END
                              ), 0)::double precision AS fees,
                              COALESCE(SUM(
                                CASE WHEN NULLIF(TRIM({buy_q}::text), '') IS NOT NULL
                                  THEN TRIM({buy_q}::text)::double precision ELSE 0 END
                              ), 0)::double precision AS buyins,
                              COUNT(*)::bigint AS rows_n
                            FROM {ft}
                            WHERE NULLIF(TRIM({sd_q}::text), '') IS NOT NULL
                              AND ({sd_q})::date >= (NOW() - CAST(:iv AS interval))::date
                            """
                        ),
                        {"iv": interval_hours},
                    ).mappings().first()
                    if r:
                        payload["kpis"]["tournament_fees_window"] = _safe_float(r["fees"])
                        payload["kpis"]["tournament_buyins_window"] = _safe_float(r["buyins"])
                        payload["kpis"]["tournament_row_count_window"] = int(r["rows_n"] or 0)
                    if tt_q:
                        donut = conn.execute(
                            text(
                                f"""
                                SELECT NULLIF(TRIM({tt_q}::text), '') AS lbl,
                                       COUNT(*)::bigint AS c
                                FROM {ft}
                                WHERE ({sd_q})::date >= CURRENT_DATE - INTERVAL '7 days'
                                GROUP BY 1
                                HAVING NULLIF(TRIM({tt_q}::text), '') IS NOT NULL
                                ORDER BY c DESC
                                LIMIT 8
                                """
                            )
                        ).mappings().all()
                        payload["series"]["tournament_mix"] = [
                            {"label": (d["lbl"] or "—")[:48], "value": int(d["c"] or 0)} for d in donut
                        ]
                    else:
                        payload["series"]["tournament_mix"] = []
                    by_day = conn.execute(
                        text(
                            f"""
                            SELECT ({sd_q})::date AS d,
                                   COALESCE(SUM(
                                     CASE WHEN NULLIF(TRIM({fees_q}::text), '') IS NOT NULL
                                       THEN TRIM({fees_q}::text)::double precision ELSE 0 END
                                   ), 0)::double precision AS fees
                            FROM {ft}
                            WHERE ({sd_q})::date >= CURRENT_DATE - INTERVAL '14 days'
                            GROUP BY 1
                            ORDER BY 1 ASC
                            """
                        )
                    ).mappings().all()
                    payload["series"]["fees_by_day"] = [
                        {"t": str(row["d"]), "v": _safe_float(row["fees"]) or 0.0} for row in by_day if row["d"]
                    ]
                    buy_day = conn.execute(
                        text(
                            f"""
                            SELECT ({sd_q})::date AS d,
                                   COALESCE(SUM(
                                     CASE WHEN NULLIF(TRIM({buy_q}::text), '') IS NOT NULL
                                       THEN TRIM({buy_q}::text)::double precision ELSE 0 END
                                   ), 0)::double precision AS buyins
                            FROM {ft}
                            WHERE ({sd_q})::date >= CURRENT_DATE - INTERVAL '14 days'
                            GROUP BY 1
                            ORDER BY 1 ASC
                            """
                        )
                    ).mappings().all()
                    payload["series"]["buyins_by_day"] = [
                        {"t": str(row["d"]), "v": _safe_float(row["buyins"]) or 0.0} for row in buy_day if row["d"]
                    ]
                    casino_col = _resolve_col(
                        sng_names,
                        (
                            "Casino",
                            "casino",
                            "CASINO",
                            "Cardroom",
                            "cardroom",
                            "CARDROOM",
                            "Card room",
                            "Gaming site",
                            "Gaming Site",
                            "Skin",
                            "skin",
                            "Operator",
                            "Network",
                        ),
                    )
                    if not casino_col:
                        casino_col = _resolve_col_by_substrings(
                            sng_names,
                            ("cardroom", "casino", "gaming site", "skin", "operator", "venue"),
                        )
                    if casino_col:
                        payload["meta"]["sng_casino_column"] = casino_col
                        cq = _qi(casino_col)
                        fee_rows = conn.execute(
                            text(
                                f"""
                                SELECT COALESCE(NULLIF(TRIM({cq}::text), ''), '(no venue)') AS lbl,
                                       COALESCE(SUM(
                                         CASE WHEN NULLIF(TRIM({fees_q}::text), '') IS NOT NULL
                                           THEN TRIM({fees_q}::text)::double precision ELSE 0 END
                                       ), 0)::double precision AS fees
                                FROM {ft}
                                WHERE ({sd_q})::date >= (NOW() - CAST(:iv AS interval))::date
                                GROUP BY COALESCE(NULLIF(TRIM({cq}::text), ''), '(no venue)')
                                ORDER BY fees DESC NULLS LAST
                                LIMIT 12
                                """
                            ),
                            {"iv": interval_hours},
                        ).mappings().all()
                        payload["bars"]["fees_by_casino"] = [
                            {"label": (x["lbl"] or "")[:40], "value": _safe_float(x["fees"]) or 0.0}
                            for x in fee_rows
                        ]
                    else:
                        payload["bars"]["fees_by_casino"] = []
                        add_err("sng_twister_and_mtt: no Casino/Cardroom column — fees-by-casino chart skipped")
            except Exception as e:
                log.warning("[ops-dashboard] sng_twister: %s", e)
                add_err(f"sng_twister: {e}")

    # --- Network activity (polling stats): full row snapshot for all chartable columns ---
    t_na = tables.get("network_activity")
    if t_na:
        ft = _full_table_ident(schema, t_na)
        na_cols = _column_names(inspector, schema, t_na)
        ts_na = _resolve_col(na_cols, ("Statistics date", "statistics date", "Stat date"))
        try:
            if not ts_na:
                add_err("network_activity: no Statistics date column found")
            else:
                payload["meta"]["network_statistics_date_column"] = ts_na
                ts_q = _qi(ts_na)
                with engine.connect() as conn:
                    try:
                        rows = conn.execute(
                            text(
                                f"""
                                SELECT * FROM {ft}
                                WHERE NULLIF(TRIM({ts_q}::text), '') IS NOT NULL
                                ORDER BY ({ts_q})::timestamp DESC NULLS LAST
                                LIMIT 500
                                """
                            )
                        ).mappings().all()
                    except Exception as ord_exc:
                        log.warning("[ops-dashboard] network_activity order: %s", ord_exc)
                        add_err(
                            "network_activity: timestamp sort failed (check date format); using unsorted sample"
                        )
                        rows = conn.execute(
                            text(f"SELECT * FROM {ft} WHERE NULLIF(TRIM({ts_q}::text), '') IS NOT NULL LIMIT 500")
                        ).mappings().all()
                rows = list(reversed(rows))
                full = [
                    _network_row_canonicalize(_row_to_dashboard_json(dict(x))) for x in rows
                ]
                payload["series"]["network_activity_full"] = full
                payload["meta"]["network_activity_row_count"] = len(full)
                col_conn = _resolve_col(
                    na_cols,
                    ("Average # of connected players", "Avg # of connected players"),
                )
                col_real = _resolve_col(na_cols, ("Average # of real players", "Avg # of real players"))
                col_tourney = _resolve_col(
                    na_cols,
                    ("Average # of tournaments", "Avg # of tournaments"),
                )
                payload["series"]["network_connected"] = []
                for rj in full:
                    tsv = rj.get("Statistics date") or (rj.get(ts_na) if ts_na else None)
                    payload["series"]["network_connected"].append(
                        {
                            "t": tsv,
                            "connected": _safe_float(
                                rj.get(col_conn) if col_conn else rj.get("Average # of connected players")
                            ),
                            "real_players": _safe_float(
                                rj.get(col_real) if col_real else rj.get("Average # of real players")
                            ),
                            "tournaments": _safe_float(
                                rj.get(col_tourney) if col_tourney else rj.get("Average # of tournaments")
                            ),
                        }
                    )
                if full:
                    last = full[-1]
                    payload["kpis"]["network_connected_latest"] = _safe_float(
                        last.get(col_conn) if col_conn else last.get("Average # of connected players")
                    )
                    payload["kpis"]["network_real_players_latest"] = _safe_float(
                        last.get(col_real) if col_real else last.get("Average # of real players")
                    )
                    payload["kpis"]["network_tournaments_latest"] = _safe_float(
                        last.get(col_tourney) if col_tourney else last.get("Average # of tournaments")
                    )
        except Exception as e:
            log.warning("[ops-dashboard] network_activity: %s", e)
            add_err(f"network_activity: {e}")

    # --- Network disconnection rate ---
    t_nd = tables.get("network_disconnection")
    if t_nd:
        ft = _full_table_ident(schema, t_nd)
        try:
            with engine.connect() as conn:
                rows = conn.execute(
                    text(
                        f"""
                        SELECT ({_qi("Disconnection time")})::timestamp AS ts,
                               NULLIF(TRIM({_qi("Disconnection rate")}::text), '')::double precision AS rate,
                               NULLIF(TRIM({_qi("Disconnection count (total)")}::text), '')::double precision AS disc,
                               NULLIF(TRIM({_qi("Total connections")}::text), '')::double precision AS conns
                        FROM {ft}
                        WHERE NULLIF(TRIM({_qi("Disconnection time")}::text), '') IS NOT NULL
                        ORDER BY ({_qi("Disconnection time")})::timestamp DESC
                        LIMIT 200
                        """
                    )
                ).mappings().all()
                rows = list(reversed(rows))
                payload["series"]["disconnection_rate"] = [
                    {
                        "t": row["ts"].isoformat() if row["ts"] else None,
                        "v": _safe_float(row["rate"]),
                    }
                    for row in rows
                    if row["ts"] is not None
                ]
                if rows:
                    rates = [_safe_float(r["rate"]) for r in rows if _safe_float(r["rate"]) is not None]
                    if rates:
                        payload["kpis"]["disconnection_rate_latest"] = rates[-1]
                        payload["kpis"]["disconnection_rate_avg_window"] = sum(rates) / len(rates)
        except Exception as e:
            log.warning("[ops-dashboard] network_disconnection: %s", e)
            add_err(f"network_disconnection: {e}")

    # --- Poker business activity monitoring (wide snapshot row) ---
    t_pb = tables.get("poker_business")
    if t_pb:
        ft = _full_table_ident(schema, t_pb)
        cols = [
            ("Online players", "online_players"),
            ("# of current logins", "current_logins"),
            ("Cash game hands", "cash_game_hands"),
            ("Tournament hands", "tournament_hands"),
            ("Real tables", "real_tables"),
            ("Tournaments", "tournaments"),
            ("Players in tournaments", "players_in_tournaments"),
        ]
        try:
            with engine.connect() as conn:
                row = conn.execute(
                    text(
                        f"""
                        SELECT *
                        FROM {ft}
                        WHERE NULLIF(TRIM({_qi("Stats date")}::text), '') IS NOT NULL
                        ORDER BY ({_qi("Stats date")})::timestamp DESC NULLS LAST
                        LIMIT 1
                        """
                    )
                ).mappings().first()
                if row:
                    d = dict(row)
                    for c_sql, k in cols:
                        raw = d.get(c_sql)
                        payload["kpis"][k] = None
                        if raw is None or str(raw).strip() == "":
                            continue
                        try:
                            payload["kpis"][k] = int(float(str(raw).replace(",", "")))
                        except (TypeError, ValueError):
                            payload["kpis"][k] = _safe_float(raw)
        except Exception as e:
            log.warning("[ops-dashboard] poker_business: %s", e)
            add_err(f"poker_business: {e}")

    # --- Tournament disconnection by player ---
    t_td = tables.get("tournament_disconnection")
    if t_td:
        ft = _full_table_ident(schema, t_td)
        td_names = _column_names(inspector, schema, t_td)
        td_time = _resolve_col(
            td_names,
            (
                "Time of disconnection",
                "Time of Disconnection",
                "TimeOfDisconnection",
                "time of disconnection",
                "Disconnection time",
                "Disconnection Time",
                "DC Time",
                "Timestamp",
                "Date time",
                "Date Time",
                "Event time",
            ),
        )
        if not td_time:
            td_time = _resolve_col_by_substrings(
                td_names,
                ("disconnection", "disconnect", "dc time", "event time"),
                require_any=("time", "date", "timestamp"),
            )
        td_room = _resolve_col(
            td_names,
            (
                "Cardroom",
                "Casino",
                "cardroom",
                "casino",
                "CARDROOM",
                "Card room",
                "Card Room",
                "Gaming site",
                "Skin",
                "Tournament cardroom",
            ),
        )
        if not td_room:
            td_room = _resolve_col_by_substrings(
                td_names,
                ("cardroom", "casino", "gaming site", "skin", "venue", "operator"),
                require_any=("room", "casino", "site", "skin", "venue", "operator", "network"),
            )
        if not td_time:
            add_err(
                "tournament_disconnection: no time column (expected Time of disconnection or similar)"
            )
        elif not td_room:
            add_err(
                "tournament_disconnection: no cardroom/casino column (expected Cardroom or Casino)"
            )
        else:
            payload["meta"]["tournament_dc_time_column"] = td_time
            payload["meta"]["tournament_dc_cardroom_column"] = td_room
            tq = _qi(td_time)
            rq = _qi(td_room)
            try:
                with engine.connect() as conn:
                    n = conn.execute(
                        text(
                            f"""
                            SELECT COUNT(*)::bigint AS n
                            FROM {ft}
                            WHERE NULLIF(TRIM({tq}::text), '') IS NOT NULL
                              AND ({tq})::timestamp >= NOW() - CAST(:iv AS interval)
                            """
                        ),
                        {"iv": interval_hours},
                    ).scalar()
                    payload["kpis"]["tournament_disconnection_events_window"] = int(n or 0)
                    bars = conn.execute(
                        text(
                            f"""
                            SELECT COALESCE(NULLIF(TRIM({rq}::text), ''), '(no venue)') AS cardroom,
                                   COUNT(*)::bigint AS c
                            FROM {ft}
                            WHERE NULLIF(TRIM({tq}::text), '') IS NOT NULL
                              AND ({tq})::timestamp >= NOW() - CAST(:iv AS interval)
                            GROUP BY COALESCE(NULLIF(TRIM({rq}::text), ''), '(no venue)')
                            ORDER BY c DESC
                            LIMIT 12
                            """
                        ),
                        {"iv": interval_hours},
                    ).mappings().all()
                    if not bars or sum(int(b["c"] or 0) for b in bars) == 0:
                        bars = conn.execute(
                            text(
                                f"""
                                SELECT COALESCE(NULLIF(TRIM({rq}::text), ''), '(no venue)') AS cardroom,
                                       COUNT(*)::bigint AS c
                                FROM {ft}
                                WHERE NULLIF(TRIM({tq}::text), '') IS NOT NULL
                                GROUP BY COALESCE(NULLIF(TRIM({rq}::text), ''), '(no venue)')
                                ORDER BY c DESC
                                LIMIT 12
                                """
                            )
                        ).mappings().all()
                        payload["meta"]["tournament_dc_cardroom_note"] = (
                            "No rows in selected window; showing all-time top cardrooms by volume"
                        )
                    payload["bars"]["tournament_dc_by_cardroom"] = [
                        {"label": (b["cardroom"] or "")[:40], "value": int(b["c"] or 0)} for b in bars
                    ]
            except Exception as e:
                log.warning("[ops-dashboard] tournament_disconnection: %s", e)
                add_err(f"tournament_disconnection: {e}")

    return payload
