"""
backend_v2.api.routes_fraud
---------------------------

Flask blueprint exposing the fraud / collusion endpoints under
``/api/collusion/*`` and related APIs (player profile, chart data, live report, attachments, rule settings).

This is a refactor of the legacy ``api.py`` collusion blueprint wired
to the new :mod:`backend_v2.engine.fraud_engine` implementation and
centralised configuration.
"""

from __future__ import annotations

import copy
import io
import logging
import os
import re
import traceback
from datetime import datetime, timedelta, timezone
import json

import numpy as np
import pandas as pd
import requests
from flask import Blueprint, current_app, jsonify, request, send_from_directory
from sqlalchemy import text
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from backend_v2.config import (
    ATTACHMENTS_UPLOAD_ROOT,
    CASE_MANAGEMENT_URL,
    COLLUSION_DB_URL,
    DEFAULT_DB_CONNECTION,
    PLAYTECH_ADMIN_PASSWORD,
    PLAYTECH_ADMIN_USER,
    PLAYTECH_BASE_URL,
)
from backend_v2.database import get_case_engine, get_db_engine, mask_connection_url
from backend_v2.models.case_models import Base, CaseNote, FraudRuleConfig, InvestigationCase
from backend_v2.engine.fraud_engine import (
    resolve_display_nickname_from_primary,
    resolve_player_code_from_nickname,
    run_analysis,
    upsert_cases,
)
from backend_v2.services.storage import Storage
from backend_v2.engine.fraud_rule_config_schema import (
    get_default_configs,
    merge_fraud_configs_into_settings_core,
    merge_saved_into_defaults,
)
from backend_v2.engine.fraud_rule_db_loader import (
    fetch_raw_fraud_rule_config_dicts_from_case_db,
    load_merged_fraud_rule_configs_for_engine,
)


fraud_bp = Blueprint("fraud_v2", __name__)
storage = Storage()
logger = logging.getLogger(__name__)


def _is_blank(v) -> bool:
    """True if value is None, empty string, or "—"."""
    if v is None:
        return True
    s = str(v).strip()
    return s == "" or s == "—"


def _norm_signup(v) -> str:
    """Normalize sign-up date to YYYY-MM-DD or "—"."""
    if v is None or _is_blank(str(v) if v is not None else ""):
        return "—"
    return str(v)[:10]


def _core_info_fallback(player_code: str, nickname: str) -> dict:
    """Default core_info when no session or MTT row is found. Keys: username, nickname, country, cardroom, sign_up_date, frozen, poker_player_code."""
    return {
        "username": "—",
        "nickname": nickname or player_code,
        "country": "—",
        "cardroom": "—",
        "sign_up_date": "—",
        "frozen": "—",
        "poker_player_code": player_code,
    }


import threading as _threading

scan_lock = _threading.Lock()

COLLUSION_RULE_SETTINGS_KEY = "v3_standards"
FRAUD_RULE_CONFIGS_KEY = "fraud_rule_configs"

# Rules 3–5: EXISTS overlap (defaults match fraud_rule_config_schema; investigation panel verdicts).
# Rule 3 (Twister): require_both=1 — both players’ overlap % must meet min_pct. Rules 4–5: require_both=0 (either).
_PLAYER_OVERLAP_RULE_VERDICT_SQL = """
WITH unique_tourneys AS (
    SELECT DISTINCT
        s."Player code" AS pcode,
        TRIM(s."Tournament code"::TEXT) AS tc
    FROM "Primary_SNG_Twister_and_MTT" s
    WHERE TRIM(COALESCE(s."Tournament type", '')) = :ttype
      AND s."Player code" IS NOT NULL
      AND TRIM(COALESCE(s."Tournament code"::TEXT, '')) <> ''
),
player_totals AS (
    SELECT pcode, COUNT(DISTINCT tc)::BIGINT AS total_tournaments
    FROM unique_tourneys
    GROUP BY pcode
),
player_pairs AS (
    SELECT
        LEAST(t1.pcode, t2.pcode) AS player_a_code,
        GREATEST(t1.pcode, t2.pcode) AS player_b_code,
        COUNT(*)::BIGINT AS common_tournaments_played
    FROM unique_tourneys t1
    INNER JOIN unique_tourneys t2 ON t1.tc = t2.tc AND t1.pcode <> t2.pcode
    GROUP BY LEAST(t1.pcode, t2.pcode), GREATEST(t1.pcode, t2.pcode)
),
qualified AS (
    SELECT
        pp.player_a_code,
        pp.player_b_code,
        pp.common_tournaments_played,
        pa.total_tournaments AS total_a,
        pb.total_tournaments AS total_b
    FROM player_pairs pp
    INNER JOIN player_totals pa ON pp.player_a_code = pa.pcode
    INNER JOIN player_totals pb ON pp.player_b_code = pb.pcode
    WHERE pp.common_tournaments_played >= :min_common
      AND (
          (:require_both <> 1 AND (
              (pp.common_tournaments_played::NUMERIC / NULLIF(pa.total_tournaments, 0)) * 100 >= :min_pct
              OR (pp.common_tournaments_played::NUMERIC / NULLIF(pb.total_tournaments, 0)) * 100 >= :min_pct
          ))
          OR (:require_both = 1 AND (
              (pp.common_tournaments_played::NUMERIC / NULLIF(pa.total_tournaments, 0)) * 100 >= :min_pct
              AND (pp.common_tournaments_played::NUMERIC / NULLIF(pb.total_tournaments, 0)) * 100 >= :min_pct
          ))
      )
)
SELECT 1
FROM qualified q
WHERE q.player_a_code = :pcode OR q.player_b_code = :pcode
LIMIT 1
"""


_V3_FLAT_ALLOW_KEYS = frozenset(
    {
        "caseTriggerScore",
        "globalRequirePaidActivity",
        "globalPaidActivityEpsilon",
        "weights",
        "ruleWeights",
        "burnerMaxAgeDays",
        "burnerMinRoiPct",
        "burner_roi_threshold",
        "max_age_days",
        "min_burner_profit",
        "min_cash_margin_pct",
        "min_cash_total_bets",
        "min_major_pct_win",
        "min_major_session_win",
        "major_max_age_days",
    }
)
_V3_FLAT_ALLOW_PATTERNS = (
    re.compile(r"^rule\d+_active$"),
    re.compile(r"^rule\d+_score$"),
    re.compile(r"^rule\d+_weight$"),
    re.compile(r"^r\d+_excl_"),
    re.compile(r"^rule\d+_min_hands$"),
)


def _allowed_rule_weight_keys() -> frozenset[str]:
    """Keys like ``rule1`` allowed in ``ruleWeights`` (only schema rule_ids)."""
    return frozenset({f"rule{int(c['rule_id'])}" for c in get_default_configs()})


def _sanitize_v3_flat_settings(d: dict) -> dict:
    """
    Drop legacy multi-rule flat keys from ``v3_standards`` blobs.

    Keeps globals, Rule 1 / current-schema flat mirrors, and per-rule weight keys for active rule_ids only.
    """
    if not isinstance(d, dict):
        return {}
    out: dict = {}
    for k, v in d.items():
        if k in _V3_FLAT_ALLOW_KEYS:
            out[k] = v
        elif any(p.match(k) for p in _V3_FLAT_ALLOW_PATTERNS):
            out[k] = v
    out["weights"] = {}
    rw = out.get("ruleWeights")
    if isinstance(rw, dict):
        allow = _allowed_rule_weight_keys()
        out["ruleWeights"] = {kk: vv for kk, vv in rw.items() if kk in allow}
    else:
        out["ruleWeights"] = {}
    return out


def _coerce_fraud_rule_weight(raw_weight: object, fallback: float = 50.0) -> float:
    """
    Normalize per-rule weight for engine + UI. Legacy rows sometimes store 0–1 (e.g. 0.5);
    the engine expects a point scale (50, 100, 400, …) summed into risk_score.
    """
    if raw_weight is None:
        return float(fallback)
    try:
        w = float(raw_weight)
    except (TypeError, ValueError):
        return float(fallback)
    if 0 < w < 1.0:
        return w * 100.0
    return w


# ``v3_standards`` JSON blob: only these (plus ``rule1_*`` / ``r1_*`` mirrors) are meaningful for the slim engine.
DEFAULT_SETTINGS = {
    "caseTriggerScore": 100.0,
    "globalRequirePaidActivity": True,
    "globalPaidActivityEpsilon": 1e-6,
    "weights": {},
    "ruleWeights": {},
}


os.makedirs(ATTACHMENTS_UPLOAD_ROOT, exist_ok=True)


@fraud_bp.route("/api/collusion/analyze", methods=["POST"])
def analyze() -> tuple:
    """
    Run collusion analysis with V2 thresholds from the frontend.

    Body: JSON payload with threshold/settings overrides.
    Returns: ``{ "cases": [...] }``.
    """
    conn_str = current_app.config.get("COLLUSION_CONNECTION_STRING") or COLLUSION_DB_URL
    if not conn_str:
        return jsonify({"error": "Collusion DB not configured", "cases": []}), 500

    payload = request.get_json(silent=True) or {}
    try:
        settings = _collusion_get_rule_settings() or dict(DEFAULT_SETTINGS)
        configs = _collusion_get_fraud_rule_configs()
        _merge_fraud_rule_configs_into_settings(configs, settings)
        settings.update(payload)
        cases = run_analysis(conn_str, settings)
        return jsonify({"cases": cases})
    except Exception as exc:
        return jsonify({"error": str(exc), "cases": []}), 200


def _norm_profile_pc(val: object) -> str:
    return str(val or "").replace(".0", "").strip()


def _target_side_common_sng_row(row: dict, pcode: str, nick_lower: str) -> str | None:
    """Return 'a' if case target is Player A, 'b' if Player B; None if indeterminate."""
    ca = _norm_profile_pc(row.get("Player A code"))
    cb = _norm_profile_pc(row.get("Player B code"))
    pc = (pcode or "").strip()
    na = str(row.get("Player A") or "").strip().lower()
    nb = str(row.get("Player B") or "").strip().lower()
    nl = (nick_lower or "").strip().lower()
    if pc:
        if ca == pc:
            return "a"
        if cb == pc:
            return "b"
    if nl:
        if na == nl and nb != nl:
            return "a"
        if nb == nl and na != nl:
            return "b"
    return None


def _normalize_common_sng_report_row(row: dict, side: str) -> dict:
    """Map a report row to target-vs-partner fields for Investigation UI."""
    na = str(row.get("Player A") or "").strip()
    nb = str(row.get("Player B") or "").strip()
    ca = _norm_profile_pc(row.get("Player A code"))
    cb = _norm_profile_pc(row.get("Player B code"))
    pct_a = row.get("Common tournaments % from player A tournaments")
    pct_b = row.get("Common tournaments % from player B tournaments")
    ta = row.get("Player A tournaments played")
    tb = row.get("Player B tournaments played")
    ct = row.get("Common tournaments played")

    def _float_or_none(v: object) -> float | None:
        if v is None:
            return None
        try:
            if isinstance(v, (int, float)):
                return float(v)
            return float(str(v).replace(",", ""))
        except (TypeError, ValueError):
            return None

    try:
        common_n = int(float(ct)) if ct is not None else 0
    except (TypeError, ValueError):
        common_n = 0

    if side == "a":
        return {
            "partner_nickname": nb or "—",
            "partner_code": cb,
            "common_tournaments": common_n,
            "target_tournaments_total": _float_or_none(ta),
            "partner_tournaments_total": _float_or_none(tb),
            "pct_target": _float_or_none(pct_a),
            "pct_partner": _float_or_none(pct_b),
        }
    return {
        "partner_nickname": na or "—",
        "partner_code": ca,
        "common_tournaments": common_n,
        "target_tournaments_total": _float_or_none(tb),
        "partner_tournaments_total": _float_or_none(ta),
        "pct_target": _float_or_none(pct_b),
        "pct_partner": _float_or_none(pct_a),
    }


@fraud_bp.route("/api/player/<path:player_code>", methods=["GET"])
def get_player_profile(player_code: str):
    """
    360-degree player profile for CaseWorkspace.

    Returns global_view with profile, core_info, statistical_info, network, graph_data,
    v2_summary, and session_history for the given player_code.
    """
    player_code = str(player_code or request.args.get("player_code") or request.args.get("q") or "").strip()
    if not player_code:
        return jsonify({"error": "player_code required", "global_view": {}}), 400

    # Activity heatmap: 7-day window ending at case creation (reduces load vs full-history aggregate).
    heatmap_end = datetime.now(timezone.utc)
    heatmap_start = heatmap_end - timedelta(days=7)
    case_created_raw = request.args.get("case_created_at")
    if case_created_raw:
        try:
            raw = str(case_created_raw).strip().replace("Z", "+00:00")
            case_created = datetime.fromisoformat(raw)
            if case_created.tzinfo is None:
                case_created = case_created.replace(tzinfo=timezone.utc)
            heatmap_end = case_created
            heatmap_start = case_created - timedelta(days=7)
        except Exception:
            pass

    conn_str = current_app.config.get("COLLUSION_CONNECTION_STRING") or COLLUSION_DB_URL
    case_conn_str = current_app.config.get("CASE_MANAGEMENT_URL") or CASE_MANAGEMENT_URL
    
    if not conn_str:
        return jsonify({"global_view": {"profile": {"player_code": player_code}, "core_info": {}, "statistical_info": {}}})

    engine = get_db_engine(conn_str)
    case_engine = get_case_engine() if case_conn_str else None

    # When Primary_* queries fail partially, align investigation KPIs with triage by filling from case scan snapshot.
    case_snapshot_total_profit: float | None = None

    # Initialize response structure
    profile = {
        "nickname": None,
        "player_code": player_code,
        "username": None,
        "poker_player_code": player_code,
        "vpip": None,
        "hands": None,
        "bb100": None,
        "earnings_from_others": None,
        "mtt_played": None,
        "twister_played": None,
        "win_ratio": None,
        "payout_pct": None,
        "login_count": None,
        "avg_buyin": None,
        "collusion_entries": 0,
        "lifetime_rake": None,
        "average_big_blind": None,
        "total_duration_seconds": None,
    }
    
    core_info = {
        "nickname": None,
        "poker_player_code": player_code,
        "username": None,
        "country": None,
        "cardroom": None,
        "advertiser": None,
        "sign_up_date": None,
        "signup_ip": None,
        "signup_serial": None,
        "total_rake_fees": None,
        "frozen": "Check IMS",
        "ipoker_collusion": None,
        "vip": None,
    }
    
    statistical_info = {
        "mtt_played": None,
        "twister_sng_played": None,
        "hands_played": None,
        "win_ratio": None,
        "profit_loss": None,
        "cash_profit": None,
        "mtt_profit": None,
        "twister_profit": None,
        "lifetime_fee": None,
        "cash_payout_pct": None,
        "login_count": None,
        "average_buy_in": None,
        "average_big_blind": None,
        "total_duration_seconds": None,
        "collusion_entries": 0,
        "total_rake_fees": None,
        "cash_rake_generated": None,
        "avg_cashout_pct": None,
    }
    
    v2_summary = {
        "country": None,
        "real_sign_up_date": None,
        "frozen": None,
        "ipoker_collusion": None,
        "big_blind": None,
        "total_duration": None,
        "total_hands": None,
        "total_won_hands": None,
        "total_buy": None,
        "total_win": None,
        "total_bets": None,
        "total_rake": None,
        "lifetime_rake": None,
        "lifetime_fee": None,
        "cash_profit": None,
        "mtt_profit": None,
        "twister_profit": None,
        "cash_rake_generated": None,
        "overall_win_pct": None,
        "overall_won_hands_pct": None,
        "total_profit": None,
        "roi": None,
        "mtt_roi": None,
        "total_tournaments": None,
        "twisters_played": None,
        "win_rate_mtt": None,
        "twister_win_pct": None,
        "total_twister_buyin": None,
        "total_mtt_buyin": None,
        "mtt_total_win": None,
        "twister_total_win": None,
        "twister_tournaments_won": None,
        "mtt_tournaments_won": None,
        "mtt_tournaments_played": None,
        "lifetime_total_fees": None,
        "sng_profit": None,
    }
    
    session_history = []
    mtt_sessions = []
    spike_log = []
    radar_chart_data = None
    network = []
    related_players = []
    graph_data = {"nodes": [], "links": []}
    timeline_data = []
    profile["syndicate_network"] = []
    profile["common_sng_report_overlap"] = []
    profile["activity_heatmap"] = []
    profile["hardware_twins"] = []
    profile["session_stats"] = []
    cumulative_performance = []
    rule_verdicts = {
        "Rule 1": "PASS",
        "Rule 2": "PASS",
        "Rule 3": "PASS",
        "Rule 4": "PASS",
        "Rule 5": "PASS",
    }
    total_logins = 0
    unique_ips = 0
    unique_serials = 0
    ip_volatility = 0.0

    try:
        with engine.connect() as conn:
            # Set a per-request statement timeout to avoid hanging the UI on heavy players
            try:
                conn.execute(text("SET LOCAL statement_timeout = '15000'"))  # 15 seconds
            except Exception:
                pass
            # Identity bridge: nickname/username -> player_code via Primary_* (same logic as fraud engine).
            input_name = player_code
            is_numeric_code = str(player_code or "").strip().isdigit()
            if not is_numeric_code:
                norm_input = str(input_name or "").strip()
                if norm_input:
                    try:
                        extracted = resolve_player_code_from_nickname(conn, norm_input)
                        if extracted:
                            player_code = str(extracted).strip()
                    except Exception:
                        pass
            else:
                player_code = str(player_code or "").strip()

            player_code = str(player_code or "").strip()

            norm_nick = player_code

            # 1. Header Stats from investigation_cases table
            if case_engine:
                try:
                    with Session(case_engine) as session:
                        case = session.query(InvestigationCase).filter(InvestigationCase.player_code == player_code).first()
                        if case:
                            profile["collusion_entries"] = 1
                            statistical_info["collusion_entries"] = 1
                            nd_case = case.network_data or {}
                            if nd_case.get("total_profit_loss") is not None:
                                case_snapshot_total_profit = float(nd_case["total_profit_loss"])
                            elif getattr(case, "net_profit", None) is not None:
                                case_snapshot_total_profit = float(case.net_profit or 0.0)
                            # KPI financials are computed from Primary_* below; case_snapshot_total_profit is used only if those leave total_profit unset.
                except Exception:
                    pass

            # 2. Display nickname from Primary_* (account / major / cash sessions)
            try:
                norm_nick = resolve_display_nickname_from_primary(conn, player_code)
            except Exception:
                norm_nick = player_code
                conn.rollback()

            profile["nickname"] = norm_nick

            # --- 2. Build Core Info (strict table boundaries; see docs/primary_tables_report.md) ---
            core_info = {
                "nickname": norm_nick,
                "poker_player_code": player_code,
                "username": None,
                "country": None,
                "cardroom": None,
                "advertiser": None,
                "sign_up_date": None,
                "signup_ip": None,
                "signup_serial": None,
                "total_rake_fees": None,
                "frozen": "Check IMS",
                "ipoker_collusion": None,
                "vip": None,
            }

            def _clean_date(d_val):
                if not d_val or str(d_val).strip() == "" or str(d_val).strip().lower() in ("nan", "nat", "none"):
                    return None
                try:
                    return str(d_val).split(" ")[0]
                except Exception:
                    return str(d_val)

            nk_lo = (norm_nick or "").strip().lower()

            # Primary_Account_information — ONLY source for identity signup fields + Lifetime Rake / Lifetime Fee
            try:
                sql_acc = text("""
                    SELECT
                        MAX(NULLIF(TRIM("Nickname"::TEXT), '')) AS nickname,
                        MAX(NULLIF(TRIM("Username"::TEXT), '')) AS username,
                        MAX(NULLIF(TRIM("Country"::TEXT), '')) AS country,
                        MAX(NULLIF(TRIM("Cardroom"::TEXT), '')) AS cardroom,
                        MAX(NULLIF(TRIM("Signup date + time"::TEXT), '')) AS sign_up_date,
                        MAX(NULLIF(TRIM("Signup IP"::TEXT), '')) AS signup_ip,
                        MAX(NULLIF(TRIM("Signup serial"::TEXT), '')) AS signup_serial,
                        MAX(NULLIF(TRIM("Frozen"::TEXT), '')) AS frozen,
                        COALESCE(MAX("Lifetime Rake"), 0)::DOUBLE PRECISION AS lifetime_rake,
                        COALESCE(MAX("Lifetime Fee"), 0)::DOUBLE PRECISION AS lifetime_fee
                    FROM "Primary_Account_information"
                    WHERE LOWER(TRIM(COALESCE("Nickname"::TEXT, ''))) = :nick
                       OR LOWER(TRIM(COALESCE("Username"::TEXT, ''))) = :nick
                       OR TRIM("Player Code"::TEXT) = TRIM(CAST(:pcode AS TEXT))
                       OR (
                            TRIM(CAST(:pcode AS TEXT)) ~ '^[0-9]+$'
                            AND "Player Code" = TRIM(CAST(:pcode AS TEXT))::BIGINT
                       )
                """)
                acc = conn.execute(sql_acc, {"nick": nk_lo, "pcode": player_code or ""}).mappings().first()
                if acc:
                    if acc.get("nickname"):
                        core_info["nickname"] = str(acc["nickname"]).strip()
                    if acc.get("username"):
                        core_info["username"] = str(acc["username"]).strip()
                    if acc.get("country"):
                        core_info["country"] = str(acc["country"]).strip()
                        v2_summary["country"] = core_info["country"]
                    if acc.get("cardroom"):
                        core_info["cardroom"] = str(acc["cardroom"]).strip()
                    su_raw = acc.get("sign_up_date")
                    if su_raw and str(su_raw).strip():
                        core_info["sign_up_date"] = str(su_raw).strip()
                        v2_summary["real_sign_up_date"] = _clean_date(su_raw) or str(su_raw).strip()
                    if acc.get("signup_ip"):
                        core_info["signup_ip"] = str(acc["signup_ip"]).strip()
                    if acc.get("signup_serial"):
                        core_info["signup_serial"] = str(acc["signup_serial"]).strip()
                    fz = acc.get("frozen")
                    if fz and str(fz).strip():
                        core_info["frozen"] = str(fz).strip()
                    acc_lr = float(acc.get("lifetime_rake") or 0.0)
                    acc_fee = float(acc.get("lifetime_fee") or 0.0)
                    v2_summary["lifetime_rake"] = acc_lr
                    v2_summary["lifetime_fee"] = acc_fee
                    v2_summary["lifetime_total_fees"] = acc_fee
                    statistical_info["lifetime_rake"] = acc_lr
                    statistical_info["lifetime_fee"] = acc_fee
                    statistical_info["total_rake_fees"] = acc_lr
                    statistical_info["total_rake"] = acc_lr
                    core_info["total_rake_fees"] = acc_lr
                    core_info["total_rake"] = acc_lr
                    profile["lifetime_rake"] = acc_lr
            except Exception:
                conn.rollback()

            # Primary_Cash_table_session_summary — cash P/L, hands, turnover, cash rake generated (no lifetime rake)
            try:
                sql_cash = text("""
                    SELECT
                        MAX("Nickname") AS nickname,
                        MAX("Username") AS username,
                        MAX(TRIM("Player Code"::TEXT)) AS player_code_sql,
                        COALESCE(SUM("Hands played"::NUMERIC), 0) AS total_hands,
                        COALESCE(SUM(COALESCE("Hands Won", 0)::NUMERIC), 0) AS hands_won_sum,
                        COALESCE(SUM("Total profit/loss"::NUMERIC), 0) AS cash_profit,
                        COALESCE(SUM("Total bets"::NUMERIC), 0) AS cash_invested,
                        COALESCE(SUM("Total bets"::NUMERIC + "Total profit/loss"::NUMERIC), 0) AS cash_return,
                        COALESCE(SUM("Rake generated"::NUMERIC), 0) AS cash_rake_generated,
                        COUNT(*)::BIGINT AS total_sessions,
                        COALESCE(SUM(COALESCE("Session duration (in mins)", 0)::NUMERIC), 0) / 60.0 AS cash_play_hours,
                        COUNT(DISTINCT DATE("Session start date & time"::TIMESTAMP)) AS cash_days_active
                    FROM "Primary_Cash_table_session_summary"
                    WHERE LOWER(TRIM("Nickname")) = :nick
                       OR TRIM("Player Code"::TEXT) = TRIM(CAST(:pcode AS TEXT))
                       OR (
                            TRIM(CAST(:pcode AS TEXT)) ~ '^[0-9]+$'
                            AND "Player Code" = TRIM(CAST(:pcode AS TEXT))::BIGINT
                       )
                """)
                t1_row = conn.execute(sql_cash, {"nick": nk_lo, "pcode": player_code or ""}).mappings().first()
                if t1_row:
                    t1 = dict(t1_row)
                    if not core_info.get("nickname") or core_info.get("nickname") in ("—", ""):
                        core_info["nickname"] = t1.get("nickname") or core_info["nickname"]
                    if not core_info.get("username") or core_info.get("username") in ("—", ""):
                        core_info["username"] = t1.get("username") or core_info["username"]
                    if t1.get("player_code_sql") is not None:
                        core_info["poker_player_code"] = str(t1.get("player_code_sql")).strip() or core_info["poker_player_code"]
                    total_hands_t1 = int(t1.get("total_hands") or 0)
                    hands_won_sum = float(t1.get("hands_won_sum") or 0)
                    cash_profit_t1 = float(t1.get("cash_profit") or 0)
                    cash_invested_t1 = float(t1.get("cash_invested") or 0)
                    cash_return_t1 = float(t1.get("cash_return") or 0)
                    cash_rake_gen = float(t1.get("cash_rake_generated") or 0)
                    total_sessions_t1 = int(t1.get("total_sessions") or 0)
                    cash_play_h = float(t1.get("cash_play_hours") or 0)
                    cash_days = int(t1.get("cash_days_active") or 0)
                    core_info["total_hands"] = total_hands_t1
                    statistical_info["total_hands"] = total_hands_t1
                    statistical_info["hands_played"] = total_hands_t1
                    v2_summary["total_hands"] = total_hands_t1
                    v2_summary["total_won_hands"] = int(hands_won_sum)
                    v2_summary["total_bets"] = cash_invested_t1
                    v2_summary["total_buy"] = cash_invested_t1
                    v2_summary["cash_profit"] = cash_profit_t1
                    v2_summary["cash_rake_generated"] = cash_rake_gen
                    statistical_info["cash_profit"] = cash_profit_t1
                    statistical_info["cash_rake_generated"] = cash_rake_gen
                    profile["hands"] = total_hands_t1
                    if cash_invested_t1 > 0:
                        v2_summary["cash_roi"] = round((cash_profit_t1 / cash_invested_t1) * 100.0, 2)
                        statistical_info["cash_payout_pct"] = round((cash_return_t1 / cash_invested_t1) * 100.0, 2)
                    cash_win_pct = (
                        round((hands_won_sum / float(total_hands_t1)) * 100.0, 2) if total_hands_t1 > 0 else 0.0
                    )
                    statistical_info["cash_win_pct"] = cash_win_pct
                    statistical_info["win_ratio"] = cash_win_pct
                    v2_summary["overall_win_pct"] = cash_win_pct
                    profile["win_ratio"] = cash_win_pct
                    statistical_info["total_sessions"] = total_sessions_t1
                    statistical_info["total_hours"] = round(cash_play_h, 2)
                    core_info["total_hours"] = round(cash_play_h, 2)
                    statistical_info["stat_total_duration_hours"] = round(cash_play_h, 2)
                    v2_summary["total_duration"] = round(cash_play_h, 2)
                    statistical_info["total_duration_seconds"] = int(round(cash_play_h * 3600.0))
                    statistical_info["stat_days_active"] = cash_days
                    statistical_info["ls_days_active"] = cash_days
            except Exception:
                conn.rollback()

            norm_nick = str(core_info.get("nickname") or norm_nick or player_code or "").strip()
            if norm_nick:
                profile["nickname"] = norm_nick
                core_info["nickname"] = norm_nick
            nk_lo = (norm_nick or "").strip().lower()

            # Primary_SNG_Twister_and_MTT — tournament P/L and counts; strict `Tournament type` = MTT | SNG | Twister
            try:
                sql_tourney = text("""
                    WITH r AS (
                        SELECT *
                        FROM "Primary_SNG_Twister_and_MTT"
                        WHERE LOWER(TRIM(COALESCE("Nickname"::TEXT, ''))) = :nick
                           OR LOWER(TRIM(COALESCE("Username"::TEXT, ''))) = :nick
                           OR TRIM(COALESCE("Player code"::TEXT, '')) = TRIM(CAST(:pcode AS TEXT))
                           OR (
                                TRIM(CAST(:pcode AS TEXT)) ~ '^[0-9]+$'
                                AND "Player code" = TRIM(CAST(:pcode AS TEXT))::BIGINT
                           )
                    ),
                    agg AS (
                        SELECT
                            COALESCE(SUM(
                                COALESCE("Total win", 0) - COALESCE("Buy-ins", 0) - COALESCE("Fees", 0)
                                - COALESCE("Jackpot fees", 0)
                            ), 0) AS tourney_net_all,
                            COALESCE(SUM(CASE WHEN TRIM(COALESCE("Tournament type", '')) = 'MTT'
                                THEN COALESCE("Total win", 0) - COALESCE("Buy-ins", 0) - COALESCE("Fees", 0)
                                - COALESCE("Jackpot fees", 0)
                                ELSE 0 END), 0) AS mtt_net,
                            COALESCE(SUM(CASE WHEN TRIM(COALESCE("Tournament type", '')) = 'Twister'
                                THEN COALESCE("Total win", 0) - COALESCE("Buy-ins", 0) - COALESCE("Fees", 0)
                                - COALESCE("Jackpot fees", 0)
                                ELSE 0 END), 0) AS twister_net,
                            COALESCE(SUM(CASE WHEN TRIM(COALESCE("Tournament type", '')) = 'MTT'
                                THEN COALESCE("Buy-ins", 0) + COALESCE("Fees", 0) + COALESCE("Jackpot fees", 0)
                                ELSE 0 END), 0) AS mtt_buy_fees,
                            COALESCE(SUM(CASE WHEN TRIM(COALESCE("Tournament type", '')) = 'Twister'
                                THEN COALESCE("Buy-ins", 0) + COALESCE("Fees", 0) + COALESCE("Jackpot fees", 0)
                                ELSE 0 END), 0) AS twister_buy_fees,
                            COALESCE(SUM(CASE WHEN TRIM(COALESCE("Tournament type", '')) = 'MTT'
                                THEN COALESCE("Total win", 0) ELSE 0 END), 0) AS mtt_total_win,
                            COALESCE(SUM(CASE WHEN TRIM(COALESCE("Tournament type", '')) = 'Twister'
                                THEN COALESCE("Total win", 0) ELSE 0 END), 0) AS twister_total_win,
                            COALESCE(SUM(
                                COALESCE("Buy-ins", 0) + COALESCE("Fees", 0) + COALESCE("Jackpot fees", 0)
                            ), 0) AS all_buy_fees
                        FROM r
                    ),
                    dist AS (
                        SELECT
                            COUNT(DISTINCT CASE
                                WHEN TRIM(COALESCE("Tournament type", '')) IN ('MTT', 'SNG')
                                     AND TRIM(COALESCE("Tournament code"::TEXT, '')) <> ''
                                THEN TRIM("Tournament code"::TEXT) END) AS cnt_mtt_sng,
                            COUNT(*) FILTER (
                                WHERE TRIM(COALESCE("Tournament type", '')) = 'Twister'
                            )::BIGINT AS cnt_twister
                        FROM r
                    ),
                    mtt_win AS (
                        SELECT
                            COUNT(*) FILTER (WHERE s.net > 0)::BIGINT AS mtt_profitable,
                            COUNT(*)::BIGINT AS mtt_total
                        FROM (
                            SELECT
                                SUM(
                                    COALESCE("Total win", 0) - COALESCE("Buy-ins", 0) - COALESCE("Fees", 0)
                                    - COALESCE("Jackpot fees", 0)
                                ) AS net
                            FROM r
                            WHERE TRIM(COALESCE("Tournament type", '')) = 'MTT'
                              AND TRIM(COALESCE("Tournament code"::TEXT, '')) <> ''
                            GROUP BY TRIM("Tournament code"::TEXT)
                        ) s
                    ),
                    twister_win AS (
                        SELECT
                            COUNT(*) FILTER (WHERE x.row_profit > 0)::BIGINT AS twister_profitable,
                            COUNT(*)::BIGINT AS twister_total
                        FROM (
                            SELECT
                                (
                                    COALESCE("Total win", 0)::DOUBLE PRECISION
                                    - COALESCE("Buy-ins", 0)::DOUBLE PRECISION
                                    - COALESCE("Fees", 0)::DOUBLE PRECISION
                                    - COALESCE("Jackpot fees", 0)::DOUBLE PRECISION
                                ) AS row_profit
                            FROM r
                            WHERE TRIM(COALESCE("Tournament type", '')) = 'Twister'
                        ) x
                    )
                    SELECT
                        a.tourney_net_all,
                        a.mtt_net,
                        a.twister_net,
                        a.mtt_buy_fees,
                        a.twister_buy_fees,
                        a.mtt_total_win,
                        a.twister_total_win,
                        a.all_buy_fees,
                        d.cnt_mtt_sng,
                        d.cnt_twister,
                        mw.mtt_profitable,
                        mw.mtt_total,
                        tw.twister_profitable,
                        tw.twister_total
                    FROM agg a
                    CROSS JOIN dist d
                    CROSS JOIN mtt_win mw
                    CROSS JOIN twister_win tw
                """)
                tr = conn.execute(sql_tourney, {"nick": nk_lo, "pcode": player_code or ""}).mappings().first()
                if tr:
                    tourney_net_all = float(tr.get("tourney_net_all") or 0)
                    mtt_net = float(tr.get("mtt_net") or 0)
                    twister_net = float(tr.get("twister_net") or 0)
                    sng_net = tourney_net_all - mtt_net - twister_net
                    mtt_total_win = float(tr.get("mtt_total_win") or 0)
                    twister_total_win = float(tr.get("twister_total_win") or 0)
                    # Σ(buy+fee+jackpot) = Σ(win) − Σ(net) over the same rows; max() fixes NULL/odd buy columns under-reporting vs explicit SUM.
                    mtt_buy_fees = max(
                        float(tr.get("mtt_buy_fees") or 0),
                        max(0.0, mtt_total_win - mtt_net),
                    )
                    twister_buy_fees = max(
                        float(tr.get("twister_buy_fees") or 0),
                        max(0.0, twister_total_win - twister_net),
                    )
                    all_buy_fees = float(tr.get("all_buy_fees") or 0)
                    cnt_mtt_sng = int(tr.get("cnt_mtt_sng") or 0)
                    cnt_twister = int(tr.get("cnt_twister") or 0)
                    mtt_profitable = int(tr.get("mtt_profitable") or 0)
                    mtt_total = int(tr.get("mtt_total") or 0)
                    twister_profitable = int(tr.get("twister_profitable") or 0)
                    twister_total = int(tr.get("twister_total") or 0)
                    cash_pl = float(v2_summary.get("cash_profit") or statistical_info.get("cash_profit") or 0)
                    cash_bets = float(v2_summary.get("total_bets") or 0)
                    total_profit = cash_pl + tourney_net_all
                    v2_summary["mtt_profit"] = mtt_net
                    v2_summary["twister_profit"] = twister_net
                    v2_summary["sng_profit"] = sng_net
                    statistical_info["sng_profit"] = sng_net
                    v2_summary["total_profit"] = total_profit
                    statistical_info["mtt_profit"] = mtt_net
                    statistical_info["twister_profit"] = twister_net
                    statistical_info["profit_loss"] = cash_pl
                    statistical_info["total_profit"] = total_profit
                    statistical_info["mtt_net_profit"] = mtt_net
                    statistical_info["mtt_buyin"] = mtt_buy_fees
                    statistical_info["total_mtt_buyin"] = mtt_buy_fees
                    statistical_info["total_twister_buyin"] = twister_buy_fees
                    statistical_info["mtt_total_win"] = mtt_total_win
                    statistical_info["twister_total_win"] = twister_total_win
                    v2_summary["total_mtt_buyin"] = mtt_buy_fees
                    v2_summary["total_twister_buyin"] = twister_buy_fees
                    v2_summary["mtt_total_win"] = mtt_total_win
                    v2_summary["twister_total_win"] = twister_total_win
                    v2_summary["mtt_tournaments_won"] = mtt_profitable
                    v2_summary["mtt_tournaments_played"] = mtt_total
                    v2_summary["twister_tournaments_won"] = twister_profitable
                    statistical_info["mtt_tournaments_won"] = mtt_profitable
                    statistical_info["mtt_tournaments_played"] = mtt_total
                    statistical_info["twister_tournaments_won"] = twister_profitable
                    core_info["total_profit"] = total_profit
                    mtt_roi_val = round((mtt_net / mtt_buy_fees * 100.0), 2) if mtt_buy_fees > 0 else 0.0
                    v2_summary["mtt_roi"] = mtt_roi_val
                    statistical_info["mtt_roi"] = mtt_roi_val
                    statistical_info["total_tournaments"] = cnt_mtt_sng
                    statistical_info["mtt_played"] = cnt_mtt_sng
                    v2_summary["total_tournaments"] = cnt_mtt_sng
                    v2_summary["twisters_played"] = cnt_twister
                    statistical_info["twister_sng_played"] = cnt_twister
                    if mtt_total > 0:
                        wrm = round((mtt_profitable / float(mtt_total)) * 100.0, 2)
                        statistical_info["win_rate_mtt"] = wrm
                        v2_summary["win_rate_mtt"] = wrm
                    if twister_total > 0:
                        twr = round((twister_profitable / float(twister_total)) * 100.0, 2)
                        statistical_info["twister_win_pct"] = twr
                        v2_summary["twister_win_pct"] = twr
                    combined_stake = cash_bets + all_buy_fees
                    if combined_stake > 0:
                        g_roi = round((total_profit / combined_stake) * 100.0, 2)
                        core_info["roi"] = g_roi
                        v2_summary["roi"] = g_roi
                        statistical_info["roi"] = g_roi
                    else:
                        core_info["roi"] = 0.0
                        v2_summary["roi"] = 0.0
                        statistical_info["roi"] = 0.0
                else:
                    cash_pl = float(v2_summary.get("cash_profit") or statistical_info.get("cash_profit") or 0)
                    v2_summary["total_profit"] = cash_pl
                    statistical_info["total_profit"] = cash_pl
                    core_info["total_profit"] = cash_pl
                    cash_bets = float(v2_summary.get("total_bets") or 0)
                    if cash_bets > 0:
                        g_roi = round((cash_pl / cash_bets) * 100.0, 2)
                        core_info["roi"] = g_roi
                        v2_summary["roi"] = g_roi
                        statistical_info["roi"] = g_roi
            except Exception:
                conn.rollback()

            # Primary_Major_income_sessions — iPoker collusion flag ONLY (no financial KPIs from this path)
            try:
                sql_ipoker = text("""
                    SELECT EXISTS (
                        SELECT 1
                        FROM "Primary_Major_income_sessions" mi
                        WHERE (LOWER(TRIM(mi."Nickname")) = :nick
                           OR TRIM(mi."Player code"::TEXT) = TRIM(CAST(:pcode AS TEXT))
                           OR (
                                TRIM(CAST(:pcode AS TEXT)) ~ '^[0-9]+$'
                                AND mi."Player code" = TRIM(CAST(:pcode AS TEXT))::BIGINT
                           ))
                          AND UPPER(TRIM(COALESCE(mi."iPoker collusion", ''))) = 'YES'
                    ) AS ipoker_collusion_yes
                """)
                ik = conn.execute(sql_ipoker, {"nick": nk_lo, "pcode": player_code or ""}).mappings().first()
                if ik:
                    ipoker_yes = bool(ik.get("ipoker_collusion_yes"))
                    ipoker_disp = "Yes" if ipoker_yes else "No"
                    core_info["ipoker_collusion"] = ipoker_disp
                    v2_summary["ipoker_collusion"] = ipoker_disp
            except Exception:
                conn.rollback()

            try:
                sql_tourney_meta = text("""
                    SELECT
                        MAX(NULLIF(TRIM("VIP level"::TEXT), '')) AS vip,
                        MAX(NULLIF(TRIM("Casino"::TEXT), '')) AS casino,
                        MAX(NULLIF(TRIM("Country"::TEXT), '')) AS country
                    FROM "Primary_SNG_Twister_and_MTT"
                    WHERE LOWER(TRIM(COALESCE("Nickname"::TEXT, ''))) = :nick
                       OR LOWER(TRIM(COALESCE("Username"::TEXT, ''))) = :nick
                       OR TRIM(COALESCE("Player code"::TEXT, '')) = TRIM(CAST(:pcode AS TEXT))
                       OR (
                            TRIM(CAST(:pcode AS TEXT)) ~ '^[0-9]+$'
                            AND "Player code" = TRIM(CAST(:pcode AS TEXT))::BIGINT
                       )
                """)
                vr = conn.execute(sql_tourney_meta, {"nick": nk_lo, "pcode": player_code or ""}).mappings().first()
                if vr:
                    if vr.get("vip") and not core_info.get("vip"):
                        core_info["vip"] = str(vr["vip"]).strip()
                    if vr.get("casino") and not (core_info.get("cardroom") or "").strip():
                        core_info["cardroom"] = str(vr["casino"]).strip()
                    if vr.get("country") and not (core_info.get("country") or "").strip():
                        core_info["country"] = str(vr["country"]).strip()
                        v2_summary["country"] = core_info["country"]
            except Exception:
                conn.rollback()

            # Core fallbacks when Primary_Account_information is missing or sparse
            try:
                sql_major_fb = text("""
                    SELECT
                        MAX(NULLIF(TRIM(mi."Country"), '')) AS country,
                        MAX(NULLIF(TRIM(mi."Real sign up date"), '')) AS real_signup,
                        MAX(NULLIF(TRIM(mi."Frozen"), '')) AS frozen,
                        MAX(mi."Player lifetime rake")::DOUBLE PRECISION AS major_lifetime_rake
                    FROM "Primary_Major_income_sessions" mi
                    WHERE LOWER(TRIM(COALESCE(mi."Nickname"::TEXT, ''))) = :nick
                       OR LOWER(TRIM(COALESCE(mi."Username"::TEXT, ''))) = :nick
                       OR TRIM(mi."Player code"::TEXT) = TRIM(CAST(:pcode AS TEXT))
                       OR (
                            TRIM(CAST(:pcode AS TEXT)) ~ '^[0-9]+$'
                            AND mi."Player code" = TRIM(CAST(:pcode AS TEXT))::BIGINT
                       )
                """)
                mf = conn.execute(sql_major_fb, {"nick": nk_lo, "pcode": player_code or ""}).mappings().first()
                if mf:
                    if mf.get("country") and not (core_info.get("country") or "").strip():
                        core_info["country"] = str(mf["country"]).strip()
                        v2_summary["country"] = core_info["country"]
                    if mf.get("real_signup") and not (core_info.get("sign_up_date") or "").strip():
                        rsu = str(mf["real_signup"]).strip()
                        core_info["sign_up_date"] = rsu
                        v2_summary["real_sign_up_date"] = _clean_date(rsu) or rsu
                    fz_m = mf.get("frozen")
                    if fz_m and str(fz_m).strip() and core_info.get("frozen") in (None, "", "Check IMS", "—"):
                        core_info["frozen"] = str(fz_m).strip()
                    mlr = float(mf.get("major_lifetime_rake") or 0.0)
                    # Only when account did not supply a value (no row / NULL), not when rake is legitimately 0
                    if mlr > 0 and v2_summary.get("lifetime_rake") is None:
                        v2_summary["lifetime_rake"] = mlr
                        statistical_info["lifetime_rake"] = mlr
                        statistical_info["total_rake_fees"] = mlr
                        statistical_info["total_rake"] = mlr
                        core_info["total_rake_fees"] = mlr
                        core_info["total_rake"] = mlr
                        profile["lifetime_rake"] = mlr
            except Exception:
                conn.rollback()

            try:
                sql_login_first = text("""
                    SELECT "IP" AS ip, "Serial" AS serial, "Casino" AS casino
                    FROM "Primary_Login_activity_by_player"
                    WHERE LOWER(TRIM(COALESCE("Nickname"::TEXT, ''))) = :nick
                       OR LOWER(TRIM(COALESCE("Username"::TEXT, ''))) = :nick
                       OR TRIM("Player Code"::TEXT) = TRIM(CAST(:pcode AS TEXT))
                       OR (
                            TRIM(CAST(:pcode AS TEXT)) ~ '^[0-9]+$'
                            AND "Player Code" = TRIM(CAST(:pcode AS TEXT))::BIGINT
                       )
                    ORDER BY "Login Date Time" ASC NULLS LAST
                    LIMIT 1
                """)
                lf = conn.execute(sql_login_first, {"nick": nk_lo, "pcode": player_code or ""}).mappings().first()
                if lf:
                    if lf.get("ip") and not (core_info.get("signup_ip") or "").strip():
                        core_info["signup_ip"] = str(lf["ip"]).strip()
                    if lf.get("serial") and not (core_info.get("signup_serial") or "").strip():
                        core_info["signup_serial"] = str(lf["serial"]).strip()
                    if lf.get("casino") and not (core_info.get("cardroom") or "").strip():
                        core_info["cardroom"] = str(lf["casino"]).strip()
            except Exception:
                conn.rollback()

            try:
                sql_cash_first_ip = text("""
                    SELECT NULLIF(TRIM("Session ip"), '') AS session_ip
                    FROM "Primary_Cash_table_session_summary"
                    WHERE LOWER(TRIM("Nickname")) = :nick
                       OR TRIM("Player Code"::TEXT) = TRIM(CAST(:pcode AS TEXT))
                       OR (
                            TRIM(CAST(:pcode AS TEXT)) ~ '^[0-9]+$'
                            AND "Player Code" = TRIM(CAST(:pcode AS TEXT))::BIGINT
                       )
                    ORDER BY "Session start date & time"::TIMESTAMP NULLS LAST
                    LIMIT 1
                """)
                ci = conn.execute(sql_cash_first_ip, {"nick": nk_lo, "pcode": player_code or ""}).mappings().first()
                if ci and ci.get("session_ip") and not (core_info.get("signup_ip") or "").strip():
                    core_info["signup_ip"] = str(ci["session_ip"]).strip()
            except Exception:
                conn.rollback()

            try:
                sql_hud_casino = text("""
                    SELECT MAX(NULLIF(TRIM("Casino"::TEXT), '')) AS casino
                    FROM "Primary_Cash_Games_Player_Stats"
                    WHERE LOWER(TRIM("Nickname")) = LOWER(TRIM(:nick))
                       OR TRIM(COALESCE("Player code"::TEXT, '')) = TRIM(CAST(:pcode AS TEXT))
                       OR (
                            TRIM(CAST(:pcode AS TEXT)) ~ '^[0-9]+$'
                            AND "Player code" = TRIM(CAST(:pcode AS TEXT))::BIGINT
                       )
                """)
                hc = conn.execute(sql_hud_casino, {"nick": norm_nick, "pcode": player_code or ""}).mappings().first()
                if hc and hc.get("casino") and not (core_info.get("cardroom") or "").strip():
                    core_info["cardroom"] = str(hc["casino"]).strip()
            except Exception:
                conn.rollback()

            # Cash fallback: session count / hours / days if duration sum was empty but rows exist
            try:
                th = int(statistical_info.get("total_hands") or v2_summary.get("total_hands") or 0)
                hrs = float(statistical_info.get("total_hours") or 0)
                days = int(statistical_info.get("stat_days_active") or statistical_info.get("ls_days_active") or 0)
                if th > 0 and (hrs == 0 or days == 0):
                    sql_cash_act = text("""
                        SELECT
                            COUNT(DISTINCT ("Session start date & time"::DATE)) AS cash_days,
                            COUNT(*)::BIGINT AS cash_session_count,
                            SUM(
                                GREATEST(
                                    0,
                                    EXTRACT(EPOCH FROM (
                                        COALESCE("Session end date & time"::TIMESTAMP, "Session start date & time"::TIMESTAMP)
                                        - "Session start date & time"::TIMESTAMP
                                    ))::NUMERIC
                                )
                            ) / 3600.0 AS cash_hours
                        FROM "Primary_Cash_table_session_summary"
                        WHERE LOWER(TRIM("Nickname")) = :nick
                           OR TRIM("Player Code"::TEXT) = TRIM(CAST(:pcode AS TEXT))
                           OR (
                                TRIM(CAST(:pcode AS TEXT)) ~ '^[0-9]+$'
                                AND "Player Code" = TRIM(CAST(:pcode AS TEXT))::BIGINT
                           )
                    """)
                    ca = conn.execute(sql_cash_act, {"nick": nk_lo, "pcode": player_code or ""}).mappings().first()
                    if ca:
                        if hrs == 0:
                            ch = float(ca.get("cash_hours") or 0)
                            if ch > 0:
                                statistical_info["total_hours"] = round(ch, 2)
                                core_info["total_hours"] = round(ch, 2)
                                statistical_info["stat_total_duration_hours"] = round(ch, 2)
                                v2_summary["total_duration"] = round(ch, 2)
                                statistical_info["total_duration_seconds"] = int(round(ch * 3600.0))
                        if days == 0:
                            cd = int(ca.get("cash_days") or 0)
                            if cd > 0:
                                statistical_info["stat_days_active"] = cd
                                statistical_info["ls_days_active"] = cd
                        csc = int(ca.get("cash_session_count") or 0)
                        if csc > 0 and not statistical_info.get("total_sessions"):
                            statistical_info["total_sessions"] = csc
            except Exception:
                conn.rollback()

            # Final cleanup: empty strings → "—" (after account + fallbacks)
            for k, v in list(core_info.items()):
                if v is None or str(v).strip() == "" or str(v).strip().lower() in ("nan", "none"):
                    if k not in ("total_rake_fees", "country", "ipoker_collusion", "signup_ip", "signup_serial"):
                        core_info[k] = "—"

            _cc = core_info.get("country")
            if _cc is None or (isinstance(_cc, str) and _cc.strip() == ""):
                core_info["country"] = "—"
                v2_summary["country"] = "—"
            if not core_info.get("ipoker_collusion"):
                core_info["ipoker_collusion"] = "No"
                v2_summary["ipoker_collusion"] = "No"

            # 4. Gameplay Stats & Logins
            # 4. Advanced Playstyle Stats (Cash Game Fingerprint) — match by Nickname or Player code so we find stats when identity map lacks canonical nickname
            profile["playstyle_stats"] = None
            try:
                sql_hud = text('''
                    SELECT
                        SUM("Hands"::INTEGER) AS hands,
                        AVG("VPIP"::NUMERIC) AS vpip,
                        AVG("PFR"::NUMERIC) AS pfr,
                        AVG("3-bet"::NUMERIC) AS three_bet,
                        AVG("4-bet"::NUMERIC) AS four_bet,
                        AVG("Limp"::NUMERIC) AS limp,
                        AVG("WTSD"::NUMERIC) AS wtsd,
                        AVG("Flop Cbet"::NUMERIC) AS flop_cbet,
                        AVG("Turn Cbet"::NUMERIC) AS turn_cbet,
                        AVG("River Cbet"::NUMERIC) AS river_cbet,
                        AVG("Post flop AGG"::NUMERIC) AS post_flop_agg,
                        AVG("Attempt to Steal"::NUMERIC) AS attempt_to_steal,
                        AVG("Fold vs Flop Cbet"::NUMERIC) AS fold_vs_flop_cbet,
                        AVG("Call vs Flop Cbet"::NUMERIC) AS call_vs_flop_cbet,
                        AVG("Raise vs Flop Cbet"::NUMERIC) AS raise_vs_flop_cbet,
                        AVG("Delayed CBet"::NUMERIC) AS delayed_cbet,
                        AVG("Donk Bet Turn"::NUMERIC) AS donk_bet_turn,
                        AVG("WSD"::NUMERIC) AS wsd,
                        AVG("Overbet River"::NUMERIC) AS overbet_river
                    FROM "Primary_Cash_Games_Player_Stats"
                    WHERE LOWER(TRIM("Nickname")) = LOWER(TRIM(:nick))
                       OR TRIM(COALESCE("Player code"::TEXT, \'\')) = TRIM(CAST(:pcode AS TEXT))
                       OR (
                            TRIM(CAST(:pcode AS TEXT)) ~ '^[0-9]+$'
                            AND "Player code" = TRIM(CAST(:pcode AS TEXT))::BIGINT
                       )
                ''')
                hud_row = conn.execute(sql_hud, {"nick": norm_nick, "pcode": player_code or ""}).mappings().first()

                if hud_row and hud_row.get("hands") and int(hud_row["hands"]) > 0:
                    profile["playstyle_stats"] = {k: (float(v) if v is not None else 0.0) for k, v in hud_row.items()}
                    profile["playstyle_stats"]["hands"] = int(hud_row["hands"])
                    # VPIP / PFR / 3-bet live only in playstyle_stats (Behavioral stats UI), not Key Metrics.
                    profile["vpip"] = float(hud_row.get("vpip") or 0)
                    profile["pfr"] = float(hud_row.get("pfr") or 0)
                    profile["three_bet"] = float(hud_row.get("three_bet") or 0)
            except Exception as e:
                print(f"[HUD FETCH ERROR] {e}")
                conn.rollback()

            # Lifetime Statistics — Infrastructure: Primary_Login_activity_by_player only (row count = logins)
            try:
                sql_infra = text("""
                    SELECT
                        COUNT(*)::BIGINT AS total_logins,
                        COUNT(DISTINCT "IP"::TEXT) AS unique_ips,
                        COUNT(DISTINCT "Serial"::TEXT) AS unique_serials
                    FROM "Primary_Login_activity_by_player"
                    WHERE LOWER(TRIM("Nickname")) = :nick
                       OR TRIM("Player Code"::TEXT) = TRIM(:pcode)
                """)
                infra_res = conn.execute(
                    sql_infra,
                    {"nick": (norm_nick or "").strip().lower(), "pcode": player_code or ""},
                ).mappings().fetchone()
                if infra_res:
                    total_logins = int(infra_res.get("total_logins") or 0)
                    unique_ips = int(infra_res.get("unique_ips") or 0)
                    unique_serials = int(infra_res.get("unique_serials") or 0)
                    ip_volatility = round((unique_ips / total_logins * 100), 2) if total_logins > 0 else 0.0
                    statistical_info["total_logins"] = total_logins
                    statistical_info["unique_ips"] = unique_ips
                    statistical_info["unique_serials"] = unique_serials
                    statistical_info["ip_volatility"] = ip_volatility
                    statistical_info["login_count"] = total_logins
                    profile["login_count"] = total_logins
            except Exception:
                conn.rollback()

            # 5. Session History — last 50 cash sessions from Primary_Cash_table_session_summary (golden data)
            try:
                sql_sessions = text("""
                    SELECT
                        "Session start date & time" AS start_date,
                        "Session serial" AS session_serial,
                        NULLIF(TRIM(COALESCE("Poker Game Session Code"::TEXT, '')), '') AS poker_session_code,
                        "Table name" AS table_name,
                        COALESCE("Big blind"::NUMERIC, 0) AS big_blind,
                        COALESCE("Hands played"::NUMERIC, 0) AS hands,
                        EXTRACT(EPOCH FROM ("Session end date & time"::TIMESTAMP - "Session start date & time"::TIMESTAMP)) AS duration_seconds,
                        COALESCE("Total bets"::NUMERIC, 0) AS buy_in,
                        COALESCE("Total profit/loss"::NUMERIC, 0) AS profit,
                        COALESCE("Rake generated"::NUMERIC, 0) AS rake,
                        CASE
                            WHEN COALESCE("Total bets"::NUMERIC, 0) > 0
                            THEN (COALESCE("Total profit/loss"::NUMERIC, 0) / "Total bets"::NUMERIC) * 100::NUMERIC
                            ELSE 0::NUMERIC
                        END AS roi
                    FROM "Primary_Cash_table_session_summary"
                    WHERE LOWER(TRIM("Nickname")) = :nick OR TRIM("Player Code"::TEXT) = TRIM(:pcode)
                    ORDER BY "Session start date & time" DESC
                    LIMIT 50
                """)
                session_params = {"nick": (norm_nick or "").strip().lower(), "pcode": player_code or ""}

                for row in conn.execute(sql_sessions, session_params).mappings():
                    r = dict(row)
                    start_dt = r.get("start_date")
                    start_date_str = start_dt.isoformat() if isinstance(start_dt, datetime) else (str(start_dt) if start_dt else None)
                    buy_in = float(r.get("buy_in") or 0.0)
                    profit = float(r.get("profit") or 0.0)
                    roi_pct = float(r.get("roi") or 0.0)
                    dur_secs = r.get("duration_seconds")
                    num_hands = r.get("hands")
                    session_serial = r.get("session_serial")
                    poker_sc = (r.get("poker_session_code") or "").strip() if r.get("poker_session_code") else ""
                    display_code = poker_sc or (str(session_serial).strip() if session_serial is not None else "")
                    rake_val = float(r.get("rake") or 0.0)
                    table_name_val = r.get("table_name")
                    cash_out = buy_in + profit
                    # Build JSON-serializable row for Cash Sessions table (golden data keys)
                    dur_secs_int = int(dur_secs) if dur_secs is not None else 0
                    out_row = {
                        "start_date": start_date_str,
                        "session_code": display_code or None,
                        "session_serial": str(session_serial) if session_serial is not None else None,
                        "poker_session_code": poker_sc or None,
                        "Session code": display_code or None,
                        "table_name": str(table_name_val) if table_name_val is not None else None,
                        "big_blind": float(r.get("big_blind") or 0),
                        "hands": int(num_hands) if num_hands is not None else 0,
                        "duration_seconds": dur_secs_int,
                        "Duration (seconds)": dur_secs_int,
                        "buy_in": buy_in,
                        "buy": buy_in,
                        "cash_out": round(cash_out, 2),
                        "win": buy_in + profit,
                        "rake": round(rake_val, 2),
                        "profit": round(profit, 2),
                        "roi": round(roi_pct / 100.0, 4) if roi_pct else 0.0,
                        "roi_pct": round(roi_pct, 2),
                        "end_date": None,
                        "bets": 0,
                        "wins": 0,
                        "# of hands": int(num_hands) if num_hands is not None else 0,
                        "iPoker collusion": None,
                    }
                    session_history.append(out_row)

                # Stake & Profit timeline + Wallet Leak charts: filled only from daily cash aggregation below (not per-session walk)

                # MTT sessions: Primary_SNG_Twister_and_MTT only (tournament history table)
                try:
                    mtt_nick = (norm_nick or "").strip().lower()
                    mtt_detail_sql = text("""
                        SELECT
                            "Start date",
                            "End date",
                            NULLIF(TRIM(COALESCE("Session code"::TEXT, '')), '') AS session_code,
                            TRIM("Tournament code"::TEXT) AS tournament_id,
                            COALESCE("Buy-ins"::NUMERIC, 0) AS buy_in,
                            COALESCE("Fees"::NUMERIC, 0) + COALESCE("Jackpot fees"::NUMERIC, 0) AS fee_total,
                            COALESCE("Total win"::NUMERIC, 0) AS prize_money,
                            "Position",
                            COALESCE("# Hands"::NUMERIC, 0) AS hands,
                            TRIM(COALESCE("Currency"::TEXT, '')) AS currency,
                            TRIM(COALESCE("Tournament status"::TEXT, '')) AS tournament_status,
                            CASE
                                WHEN "End date" IS NOT NULL
                                     AND TRIM(COALESCE("End date"::TEXT, '')) <> ''
                                     AND "Start date" IS NOT NULL
                                THEN EXTRACT(
                                    EPOCH FROM (
                                        "End date"::TIMESTAMP - "Start date"::TIMESTAMP
                                    )
                                )::BIGINT
                                ELSE NULL
                            END AS duration_seconds_sql
                        FROM "Primary_SNG_Twister_and_MTT"
                        WHERE LOWER(TRIM(COALESCE("Nickname"::TEXT, ''))) = :nick
                           OR LOWER(TRIM(COALESCE("Username"::TEXT, ''))) = :nick
                           OR TRIM(COALESCE("Player code"::TEXT, '')) = TRIM(CAST(:pcode AS TEXT))
                        ORDER BY "Start date" DESC NULLS LAST
                        LIMIT 100
                    """)
                    mtt_rows = list(
                        conn.execute(
                            mtt_detail_sql,
                            {"nick": mtt_nick, "pcode": (player_code or "").strip()},
                        ).mappings()
                    )
                    for mrow in mtt_rows:
                        mr = dict(mrow)
                        start_dt = mr.get("Start date")
                        end_dt = mr.get("End date")
                        start_str = start_dt.isoformat() if isinstance(start_dt, datetime) else (str(start_dt) if start_dt else None)
                        prize = float(mr.get("prize_money") or 0)
                        buy_in_val = float(mr.get("buy_in") or 0)
                        fee_total = float(mr.get("fee_total") or 0)
                        sat_down = buy_in_val + fee_total
                        profit_net = prize - sat_down
                        roi_mtt = (profit_net / sat_down * 100.0) if sat_down > 0 else 0.0
                        dur_secs = None
                        sql_dur = mr.get("duration_seconds_sql")
                        if sql_dur is not None:
                            try:
                                dur_secs = max(0, int(sql_dur))
                            except (TypeError, ValueError):
                                dur_secs = None
                        if dur_secs is None and start_dt and end_dt and isinstance(start_dt, datetime) and isinstance(end_dt, datetime):
                            try:
                                dur_secs = max(0, int((end_dt - start_dt).total_seconds()))
                            except Exception:
                                dur_secs = None
                        mtt_hands = int(mr.get("hands") or 0)
                        mtt_sessions.append({
                            "start_date": start_str,
                            "session_code": None if mr.get("session_code") is None else str(mr.get("session_code")),
                            "tournament_id": None if mr.get("tournament_id") is None else str(mr.get("tournament_id")),
                            "buy_in": round(buy_in_val, 2),
                            "fee_total": round(fee_total, 2),
                            "sat_down": round(sat_down, 2),
                            "prize_money": round(prize, 2),
                            "cash_out": round(prize, 2),
                            "win_amount": round(prize, 2),
                            "profit": round(profit_net, 2),
                            "roi_pct": round(roi_mtt, 2),
                            "position": mr.get("Position"),
                            "hands": mtt_hands,
                            "field_size": mtt_hands,
                            "duration_seconds": dur_secs,
                            "Currency": mr.get("currency") or mr.get("Currency"),
                            "tournament_status": mr.get("tournament_status") or "",
                        })
                    # Legacy fallback removed: MTT sessions are now sourced only from Primary_SNG_Twister_and_MTT.
                except Exception as mtt_err:
                    conn.rollback()
            except Exception as e:
                conn.rollback()

            # 5a0. Hit & Run (Rule 12) — was loading every cash session into Python (very slow for high-volume players).
            # Verdict is evaluated in the Rule Engine block via a single bounded SQL EXISTS; session_stats left empty (unused in UI).

            # 5a. Stake & Profit Timeline — daily cash (Primary_Cash_table_session_summary) merged with
            #     daily MTT + Twister net (Primary_SNG_Twister_and_MTT). Cumulative profit uses combined
            #     daily P/L; cumulative rake is cash-table rake only (no per-day SNG rake in this merge).
            try:
                sql_timeline = text("""
                    WITH Daily AS (
                        SELECT
                            DATE("Session start date & time"::TIMESTAMP) AS date,
                            SUM(COALESCE("Total bets"::NUMERIC, 0)) AS Bets,
                            SUM(COALESCE("Total profit/loss"::NUMERIC, 0)) AS Wins,
                            SUM(COALESCE("Rake generated"::NUMERIC, 0)) AS RakeDay
                        FROM "Primary_Cash_table_session_summary"
                        WHERE LOWER(TRIM(COALESCE("Nickname"::TEXT, ''))) = LOWER(TRIM(CAST(:nick AS TEXT)))
                           OR TRIM("Player Code"::TEXT) = TRIM(CAST(:pcode AS TEXT))
                        GROUP BY DATE("Session start date & time"::TIMESTAMP)
                    )
                    SELECT
                        date,
                        COALESCE(Wins, 0::NUMERIC) AS profit,
                        COALESCE(Bets, 0::NUMERIC) AS stake,
                        COALESCE(RakeDay, 0::NUMERIC) AS daily_rake
                    FROM Daily
                    ORDER BY date ASC
                """)
                sql_mtt_daily = text("""
                    SELECT
                        DATE("Start date"::TIMESTAMP) AS date,
                        SUM(
                            COALESCE("Total win"::NUMERIC, 0)
                            - COALESCE("Buy-ins"::NUMERIC, 0)
                            - COALESCE("Fees"::NUMERIC, 0)
                            - COALESCE("Jackpot fees"::NUMERIC, 0)
                        ) AS daily_net
                    FROM "Primary_SNG_Twister_and_MTT"
                    WHERE LOWER(TRIM(COALESCE("Nickname"::TEXT, ''))) = LOWER(TRIM(CAST(:nick AS TEXT)))
                       OR LOWER(TRIM(COALESCE("Username"::TEXT, ''))) = LOWER(TRIM(CAST(:nick AS TEXT)))
                       OR TRIM(COALESCE("Player code"::TEXT, '')) = TRIM(CAST(:pcode AS TEXT))
                    GROUP BY DATE("Start date"::TIMESTAMP)
                    ORDER BY date ASC
                """)
                pcode_bind = str(player_code or "").strip()
                daily_rows = list(conn.execute(sql_timeline, {"nick": norm_nick, "pcode": pcode_bind}).mappings().all())
                mtt_daily_rows: list = []
                try:
                    mtt_daily_rows = list(
                        conn.execute(
                            sql_mtt_daily,
                            {"nick": norm_nick, "pcode": pcode_bind},
                        ).mappings().all()
                    )
                except Exception as mtt_timeline_err:
                    print(f"[Financial Timeline MTT daily] {mtt_timeline_err}")
                    try:
                        conn.rollback()
                    except Exception:
                        pass
                    mtt_daily_rows = []

                def _row_date_str(date_val) -> str:
                    if not date_val:
                        return ""
                    if hasattr(date_val, "isoformat"):
                        return date_val.isoformat()[:10]
                    return str(date_val)[:10]

                cash_by_date: dict[str, dict] = {}
                for r in daily_rows:
                    ds = _row_date_str(r.get("date"))
                    if not ds:
                        continue
                    cash_by_date[ds] = {
                        "profit": float(r.get("profit") or 0),
                        "stake": round(float(r.get("stake") or 0), 2),
                        "daily_rake": float(r.get("daily_rake") or 0),
                    }

                mtt_by_date: dict[str, float] = {}
                for r in mtt_daily_rows:
                    ds = _row_date_str(r.get("date"))
                    if not ds:
                        continue
                    mtt_by_date[ds] = float(r.get("daily_net") or 0)

                all_dates = sorted(set(cash_by_date.keys()) | set(mtt_by_date.keys()))
                if all_dates:
                    timeline_data.clear()
                    cum = 0.0
                    cum_rake = 0.0
                    for date_str in all_dates:
                        c = cash_by_date.get(date_str, {"profit": 0.0, "stake": 0.0, "daily_rake": 0.0})
                        mtt_net = mtt_by_date.get(date_str, 0.0)
                        cash_p = float(c.get("profit", 0))
                        rake_d = float(c.get("daily_rake", 0))
                        stake = float(c.get("stake", 0))
                        daily_combined = cash_p + mtt_net
                        cum += daily_combined
                        cum_rake += rake_d
                        timeline_data.append({
                            "date": date_str,
                            "play_date": date_str,
                            "Date": date_str,
                            "daily_profit": round(daily_combined, 2),
                            "daily_cash_profit": round(cash_p, 2),
                            "daily_mtt_twister_net": round(mtt_net, 2),
                            "daily_rake": round(rake_d, 2),
                            "Profit": round(cum, 2),
                            "cumulative_profit": round(cum, 2),
                            "cumulative_rake": round(cum_rake, 2),
                            "avg_stake": stake,
                            "stake": stake,
                            "rake": round(rake_d, 2),
                        })
            except Exception as e:
                print(f"[Financial Timeline] {e}")
                conn.rollback()

            # 5a1. Lifetime Cumulative Performance (Rule 14 & 15) — hourly running totals (last 24 months only to cap work on grinders)
            try:
                sql_cumulative = text("""
                    WITH hourly AS (
                        SELECT
                            DATE_TRUNC('hour', "Session start date & time"::TIMESTAMP) AS hour_ts,
                            SUM(COALESCE("Total profit/loss"::NUMERIC, 0)) AS period_profit,
                            SUM(COALESCE("Rake generated"::NUMERIC, 0)) AS period_rake
                        FROM "Primary_Cash_table_session_summary"
                        WHERE (LOWER(TRIM(COALESCE("Nickname"::TEXT, ''))) = LOWER(TRIM(CAST(:nick AS TEXT)))
                           OR TRIM("Player Code"::TEXT) = TRIM(CAST(:pcode AS TEXT)))
                          AND "Session start date & time"::TIMESTAMP >= (CURRENT_TIMESTAMP - INTERVAL '730 days')
                        GROUP BY DATE_TRUNC('hour', "Session start date & time"::TIMESTAMP)
                    )
                    SELECT hour_ts AS date,
                           SUM(period_profit) OVER (ORDER BY hour_ts ASC) AS cumulative_profit,
                           SUM(period_rake) OVER (ORDER BY hour_ts ASC) AS cumulative_rake
                    FROM hourly
                    ORDER BY hour_ts ASC
                """)
                for row in conn.execute(
                    sql_cumulative, {"nick": norm_nick, "pcode": str(player_code or "").strip()}
                ).mappings():
                    r = dict(row)
                    date_val = r.get("date")
                    date_str = (date_val.isoformat()[:19] if hasattr(date_val, "isoformat") else str(date_val)[:19]) if date_val else ""
                    cumulative_performance.append({
                        "date": date_str,
                        "Date": date_str,
                        "cumulative_profit": round(float(r.get("cumulative_profit") or 0), 2),
                        "cumulative_rake": round(float(r.get("cumulative_rake") or 0), 2),
                    })
            except Exception as e:
                print(f"[Cumulative Performance] {e}")
                conn.rollback()
                cumulative_performance = []

            # 5b. Major income & spike log — Primary_Major_income_sessions ONLY (full column set for grid)
            try:
                sql_spike = text("""
                    SELECT
                        NULLIF(TRIM(COALESCE(m."Session code"::TEXT, '')), '') AS "Session code",
                        m."Start date" AS "Start date",
                        m."End date" AS "End date",
                        COALESCE(m."Duration (seconds)"::BIGINT, 0) AS "Duration (seconds)",
                        COALESCE(m."Big blind"::DOUBLE PRECISION, 0) AS "Big blind",
                        COALESCE(m."Buy"::DOUBLE PRECISION, 0) AS "Buy",
                        COALESCE(m."Win"::DOUBLE PRECISION, 0) AS "Win",
                        COALESCE(m."% Win"::DOUBLE PRECISION, 0) AS "% Win",
                        COALESCE(m."Rake"::DOUBLE PRECISION, 0) AS "Rake",
                        COALESCE(m."Bets"::DOUBLE PRECISION, 0) AS "Bets",
                        COALESCE(m."Wins"::DOUBLE PRECISION, 0) AS "Wins",
                        COALESCE(m."# of hands"::BIGINT, 0) AS "# of hands",
                        COALESCE(m."# of won hands"::BIGINT, 0) AS "# of won hands",
                        COALESCE(m."% of won hands"::DOUBLE PRECISION, 0) AS "% of won hands",
                        NULLIF(TRIM(COALESCE(m."Currency"::TEXT, '')), '') AS "Currency"
                    FROM "Primary_Major_income_sessions" m
                    WHERE (LOWER(TRIM(m."Nickname")) = :nick
                       OR TRIM(m."Player code"::TEXT) = TRIM(:pcode))
                      AND COALESCE(m."Buy"::DOUBLE PRECISION, 0) > 0
                      AND (
                          (COALESCE(m."Win"::DOUBLE PRECISION, 0) - COALESCE(m."Buy"::DOUBLE PRECISION, 0))
                          / NULLIF(m."Buy"::DOUBLE PRECISION, 0) * 100.0
                      ) > 100
                    ORDER BY m."Start date" DESC NULLS LAST
                    LIMIT 200
                """)
                spike_rows = conn.execute(
                    sql_spike,
                    {"nick": (norm_nick or "").strip().lower(), "pcode": player_code or ""},
                ).mappings().all()
                for r in spike_rows:
                    row = {k: v for k, v in dict(r).items()}
                    for dk in ("Start date", "End date"):
                        dv = row.get(dk)
                        if dv is not None and hasattr(dv, "isoformat"):
                            try:
                                row[dk] = dv.isoformat()[:19]
                            except Exception:
                                row[dk] = str(dv)[:32]
                        elif dv is not None:
                            row[dk] = str(dv)[:32]
                    spike_log.append(row)
            except Exception as e:
                print(f"[Spike Log] {e}")
                conn.rollback()
                spike_log[:] = []

            # Radar chart removed from investigation UI (deprecated).
            radar_chart_data = None

            # 6. Potential accomplices — Primary_SNG_Twister_and_MTT (Tournament code::TEXT) + Primary_Major_income_sessions (Session code::TEXT)
            try:
                uname = (core_info.get("username") if core_info.get("username") and core_info.get("username") != "—" else None) or norm_nick
                nk = (norm_nick or "").strip().lower()
                synd_params = {
                    "uname": str(uname or "").strip(),
                    "nick": nk,
                    "pcode": str(player_code or "").strip(),
                }
                sql_mtt_overlap = text("""
                    SELECT
                        COALESCE(
                            NULLIF(TRIM(COALESCE("Username"::TEXT, '')), ''),
                            NULLIF(TRIM(COALESCE("Nickname"::TEXT, '')), ''),
                            '?'
                        ) AS accomplice,
                        MAX(NULLIF(TRIM(COALESCE("Player code"::TEXT, '')), '')) AS accomplice_player_code,
                        COUNT(DISTINCT TRIM("Tournament code"::TEXT)) AS shared_games,
                        SUM(COALESCE("Total win"::NUMERIC, 0)) AS total_accomplice_win
                    FROM "Primary_SNG_Twister_and_MTT"
                    WHERE TRIM(COALESCE("Tournament code"::TEXT, '')) != ''
                      AND TRIM("Tournament code"::TEXT) IN (
                          SELECT DISTINCT TRIM("Tournament code"::TEXT)
                          FROM "Primary_SNG_Twister_and_MTT"
                          WHERE TRIM(COALESCE("Tournament code"::TEXT, '')) != ''
                            AND (
                                LOWER(TRIM(COALESCE("Username"::TEXT, ''))) = LOWER(TRIM(CAST(:uname AS TEXT)))
                                OR LOWER(TRIM(COALESCE("Nickname"::TEXT, ''))) = :nick
                                OR TRIM(COALESCE("Player code"::TEXT, '')) = TRIM(CAST(:pcode AS TEXT))
                            )
                      )
                      AND NOT (
                          LOWER(TRIM(COALESCE("Username"::TEXT, ''))) = LOWER(TRIM(CAST(:uname AS TEXT)))
                          OR LOWER(TRIM(COALESCE("Nickname"::TEXT, ''))) = :nick
                          OR TRIM(COALESCE("Player code"::TEXT, '')) = TRIM(CAST(:pcode AS TEXT))
                      )
                    GROUP BY COALESCE(
                        NULLIF(TRIM(COALESCE("Username"::TEXT, '')), ''),
                        NULLIF(TRIM(COALESCE("Nickname"::TEXT, '')), ''),
                        '?'
                    )
                    HAVING COUNT(DISTINCT TRIM("Tournament code"::TEXT)) >= 5
                """)
                sql_cash_overlap = text("""
                    SELECT
                        COALESCE(
                            NULLIF(TRIM(COALESCE("Username"::TEXT, '')), ''),
                            NULLIF(TRIM(COALESCE("Nickname"::TEXT, '')), ''),
                            '?'
                        ) AS accomplice,
                        COUNT(DISTINCT TRIM("Session code"::TEXT)) AS shared_games,
                        SUM(COALESCE("Win"::NUMERIC, 0)) AS total_accomplice_win
                    FROM "Primary_Major_income_sessions"
                    WHERE TRIM(COALESCE("Session code"::TEXT, '')) != ''
                      AND TRIM("Session code"::TEXT) IN (
                          SELECT DISTINCT TRIM("Session code"::TEXT)
                          FROM "Primary_Major_income_sessions"
                          WHERE TRIM(COALESCE("Session code"::TEXT, '')) != ''
                            AND (
                                LOWER(TRIM(COALESCE("Nickname"::TEXT, ''))) = :nick
                                OR TRIM("Player code"::TEXT) = TRIM(CAST(:pcode AS TEXT))
                            )
                      )
                      AND NOT (
                          LOWER(TRIM(COALESCE("Nickname"::TEXT, ''))) = :nick
                          OR TRIM("Player code"::TEXT) = TRIM(CAST(:pcode AS TEXT))
                      )
                    GROUP BY COALESCE(
                        NULLIF(TRIM(COALESCE("Username"::TEXT, '')), ''),
                        NULLIF(TRIM(COALESCE("Nickname"::TEXT, '')), ''),
                        '?'
                    )
                    HAVING COUNT(DISTINCT TRIM("Session code"::TEXT)) >= 1
                """)
                mtt_rows = conn.execute(sql_mtt_overlap, synd_params).mappings().all()
                cash_ol_rows = conn.execute(sql_cash_overlap, {"nick": nk, "pcode": synd_params["pcode"]}).mappings().all()
                merged: dict = {}
                for r in mtt_rows:
                    d = dict(r)
                    a = (str(d.get("accomplice") if d.get("accomplice") is not None else "?") or "?").strip() or "?"
                    apc = str(d.get("accomplice_player_code") or "").strip() or None
                    merged[a] = {
                        "accomplice": a,
                        "accomplice_player_code": apc,
                        "shared_games": int(d.get("shared_games") or 0),
                        "total_accomplice_win": float(d.get("total_accomplice_win") or 0),
                    }
                for r in cash_ol_rows:
                    d = dict(r)
                    a = (str(d.get("accomplice") if d.get("accomplice") is not None else "?") or "?").strip() or "?"
                    sg = int(d.get("shared_games") or 0)
                    tw = float(d.get("total_accomplice_win") or 0)
                    if a in merged:
                        merged[a]["shared_games"] += sg
                        merged[a]["total_accomplice_win"] += tw
                syndicate_sorted = sorted(
                    merged.values(),
                    key=lambda x: (-x["shared_games"], -x["total_accomplice_win"]),
                )[:10]
                profile["syndicate_network"] = syndicate_sorted
            except Exception as e:
                print(f"[Syndicate Overlap] {e}")
                conn.rollback()
                profile["syndicate_network"] = []

            # 6b. Common SNG report — pairwise overlap % (investigation context; not tied to a fraud rule slot)
            try:
                nk_report = (norm_nick or "").strip().lower()
                pcode_report = (player_code or "").strip()
                sql_common_sng = text(
                    """
                    SELECT *
                    FROM "Primary_Common_SNG_player_report"
                    WHERE TRIM(COALESCE("Player A code"::TEXT, '')) = TRIM(:pcode)
                       OR TRIM(COALESCE("Player B code"::TEXT, '')) = TRIM(:pcode)
                       OR LOWER(TRIM(COALESCE("Player A", ''))) = :nick
                       OR LOWER(TRIM(COALESCE("Player B", ''))) = :nick
                    """
                )
                common_rows = conn.execute(
                    sql_common_sng,
                    {"pcode": pcode_report, "nick": nk_report},
                ).mappings().all()
                overlap_out: list = []
                seen_pairs: set[tuple[str, str]] = set()
                for cr in common_rows:
                    d = dict(cr)
                    side = _target_side_common_sng_row(d, pcode_report, nk_report)
                    if side is None:
                        continue
                    norm = _normalize_common_sng_report_row(d, side)
                    pk = norm.get("partner_code") or ""
                    pn = (norm.get("partner_nickname") or "").strip().lower()
                    dedupe_key = (pk, pn)
                    if dedupe_key in seen_pairs:
                        continue
                    seen_pairs.add(dedupe_key)
                    overlap_out.append(norm)
                overlap_out.sort(
                    key=lambda x: (
                        -int(x.get("common_tournaments") or 0),
                        str(x.get("partner_nickname") or ""),
                    )
                )
                profile["common_sng_report_overlap"] = overlap_out
            except Exception as e:
                print(f"[Common SNG report overlap] {e}")
                conn.rollback()
                profile["common_sng_report_overlap"] = []

            # 7. Activity Heatmap — 7×24 matrix, bounded to 7 days before case creation (or last 7 days)
            try:
                sql_activity_heatmap = text("""
                    SELECT
                           EXTRACT(DOW FROM "Session start date & time"::TIMESTAMP) AS dow,
                           EXTRACT(HOUR FROM "Session start date & time"::TIMESTAMP) AS hod,
                           COUNT(*)::INTEGER AS intensity
                    FROM "Primary_Cash_table_session_summary"
                    WHERE (LOWER(TRIM("Nickname")) = LOWER(TRIM(:nick))
                       OR TRIM("Player Code"::TEXT) = TRIM(:pcode))
                      AND "Session start date & time"::TIMESTAMP >= :heatmap_start
                      AND "Session start date & time"::TIMESTAMP <= :heatmap_end
                    GROUP BY EXTRACT(DOW FROM "Session start date & time"::TIMESTAMP),
                             EXTRACT(HOUR FROM "Session start date & time"::TIMESTAMP)
                    ORDER BY dow, hod
                """)
                activity_res = conn.execute(
                    sql_activity_heatmap,
                    {
                        "nick": norm_nick,
                        "pcode": player_code,
                        "heatmap_start": heatmap_start,
                        "heatmap_end": heatmap_end,
                    },
                ).mappings().all()
                profile["activity_heatmap"] = [{"dow": int(r.get("dow") or 0), "hod": int(r.get("hod") or 0), "intensity": int(r.get("intensity") or 0)} for r in activity_res]
            except Exception as e:
                print(f"[Activity Heatmap] {e}")
                conn.rollback()
                profile["activity_heatmap"] = []

            # 8. Hardware Twins — Primary_Login_activity_by_player only (Serial::TEXT / IP::TEXT)
            try:
                lp_nick = (norm_nick or "").strip().lower()
                sql_twins = text("""
                    WITH target_ids AS (
                        SELECT DISTINCT TRIM("Serial"::TEXT) AS s, TRIM("IP"::TEXT) AS ip
                        FROM "Primary_Login_activity_by_player"
                        WHERE LOWER(TRIM("Nickname")) = :nick
                           OR TRIM("Player Code"::TEXT) = TRIM(:pcode)
                    )
                    SELECT DISTINCT
                        TRIM("Nickname") AS twin_nick,
                        TRIM("Serial"::TEXT) AS "Serial",
                        TRIM("IP"::TEXT) AS "Ip",
                        "Device Name",
                        MAX("Login Date Time") AS last_seen
                    FROM "Primary_Login_activity_by_player"
                    WHERE (
                        TRIM("Serial"::TEXT) IN (SELECT s FROM target_ids WHERE s IS NOT NULL AND s != '')
                        OR TRIM("IP"::TEXT) IN (SELECT ip FROM target_ids WHERE ip IS NOT NULL AND ip != '')
                    )
                      AND NOT (
                          LOWER(TRIM("Nickname")) = :nick
                          OR TRIM("Player Code"::TEXT) = TRIM(:pcode)
                      )
                      AND TRIM(COALESCE("Device Name"::TEXT, '')) <> ''
                      AND LOWER(TRIM(COALESCE("Device Name"::TEXT, ''))) NOT IN (
                          'unknown', 'unknown device', 'n/a', 'null', 'none'
                      )
                    GROUP BY TRIM("Nickname"), TRIM("Serial"::TEXT), TRIM("IP"::TEXT), "Device Name"
                    ORDER BY last_seen DESC
                """)
                twins_res = conn.execute(sql_twins, {"nick": lp_nick, "pcode": player_code or ""}).mappings().all()
                profile["hardware_twins"] = [dict(r) for r in twins_res]
            except Exception as e:
                print(f"[Hardware Twins] {e}")
                conn.rollback()
                profile["hardware_twins"] = []

            # 9. Related players (dashboard) — Primary_Login_activity_by_player: same Serial::TEXT or IP::TEXT as target
            try:
                lp_nick = (norm_nick or "").strip().lower()
                target_ids = conn.execute(
                    text("""
                        SELECT DISTINCT TRIM("Serial"::TEXT) AS "Serial", TRIM("IP"::TEXT) AS "Ip"
                        FROM "Primary_Login_activity_by_player"
                        WHERE LOWER(TRIM("Nickname")) = :nick
                           OR TRIM("Player Code"::TEXT) = TRIM(:pcode)
                    """),
                    {"nick": lp_nick, "pcode": player_code or ""},
                ).mappings().all()
                target_serials = {r["Serial"] for r in target_ids if r.get("Serial")}
                target_ips = {r["Ip"] for r in target_ids if r.get("Ip")}

                sql_related = text("""
                    SELECT DISTINCT
                        TRIM("Nickname") AS "Nickname",
                        TRIM(CAST("Player Code" AS TEXT)) AS "PlayerCode",
                        "Casino" AS cardroom,
                        TRIM("IP"::TEXT) AS "Ip",
                        TRIM("Serial"::TEXT) AS "Serial"
                    FROM "Primary_Login_activity_by_player"
                    WHERE (
                        TRIM("Serial"::TEXT) IN (
                            SELECT TRIM("Serial"::TEXT)
                            FROM "Primary_Login_activity_by_player"
                            WHERE LOWER(TRIM("Nickname")) = :nick
                               OR TRIM("Player Code"::TEXT) = TRIM(:pcode)
                        )
                        OR TRIM("IP"::TEXT) IN (
                            SELECT TRIM("IP"::TEXT)
                            FROM "Primary_Login_activity_by_player"
                            WHERE LOWER(TRIM("Nickname")) = :nick
                               OR TRIM("Player Code"::TEXT) = TRIM(:pcode)
                        )
                    )
                      AND NOT (
                          LOWER(TRIM("Nickname")) = :nick
                          OR TRIM("Player Code"::TEXT) = TRIM(:pcode)
                      )
                """)
                related_rows = conn.execute(sql_related, {"nick": lp_nick, "pcode": player_code or ""}).mappings().all()
                seen_nick = {}
                for r in related_rows:
                    row = dict(r)
                    serial_match = row.get("Serial") and row["Serial"] in target_serials
                    ip_match = row.get("Ip") and row["Ip"] in target_ips
                    if serial_match and ip_match:
                        row["match_via"] = "Both"
                    elif serial_match:
                        row["match_via"] = "Serial"
                    else:
                        row["match_via"] = "IP"
                    nick = (row.get("Nickname") or "").strip()
                    if not nick:
                        continue
                    rpc = str(row.get("PlayerCode") or row.get("player_code") or "").strip()
                    if nick not in seen_nick:
                        seen_nick[nick] = {
                            "nickname": nick,
                            "player_code": rpc or None,
                            "cardroom": row.get("cardroom") or row.get("Casino") or "—",
                            "match_via": row["match_via"],
                            "ip": row.get("Ip"),
                            "serial": row.get("Serial"),
                        }
                    else:
                        existing = seen_nick[nick]
                        if rpc and not (existing.get("player_code") or "").strip():
                            existing["player_code"] = rpc
                        if row["match_via"] == "Both":
                            existing["match_via"] = "Both"
                        elif existing["match_via"] != "Both" and row["match_via"] != existing["match_via"]:
                            existing["match_via"] = "Both"
                related_players[:] = list(seen_nick.values())

                # Spider Web: network_nodes and network_edges for graph (target + related; Serial=red, IP=blue)
                target_id = (norm_nick or player_code or "target").strip()
                graph_data["nodes"] = [{"id": target_id, "label": target_id, "group": "target"}]
                graph_data["links"] = []
                for rp in related_players:
                    nick = (rp.get("nickname") or "").strip()
                    if not nick or nick == target_id:
                        continue
                    graph_data["nodes"].append({"id": nick, "label": nick, "group": "related"})
                    match_via = rp.get("match_via") or ""
                    if match_via == "Both":
                        graph_data["links"].append({"source": target_id, "target": nick, "linkType": "serial"})
                        graph_data["links"].append({"source": target_id, "target": nick, "linkType": "ip"})
                    elif match_via == "Serial":
                        graph_data["links"].append({"source": target_id, "target": nick, "linkType": "serial"})
                    else:
                        graph_data["links"].append({"source": target_id, "target": nick, "linkType": "ip"})
            except Exception as e:
                print(f"[Related Players] {e}")
                conn.rollback()
                related_players[:] = []
                graph_data["nodes"] = []
                graph_data["links"] = []

            # 10. Rule 1 — cash margin from Primary_Cash_table_session_summary only (see fraud_engine._evaluate_rule1_burner)
            try:
                r1_sql = text(
                    """
                    WITH cash_one AS (
                        SELECT
                            COALESCE(SUM(COALESCE("Total profit/loss", 0)::NUMERIC), 0) AS sum_pl,
                            COALESCE(SUM(COALESCE("Total bets", 0)::NUMERIC), 0) AS sum_bets
                        FROM "Primary_Cash_table_session_summary"
                        WHERE TRIM("Player Code"::TEXT) = TRIM(:pcode)
                    ),
                    margin AS (
                        SELECT
                            CASE
                                WHEN sum_bets > 0 AND sum_bets >= :min_bets
                                THEN (sum_pl / sum_bets) * 100.0
                                ELSE NULL
                            END AS cash_margin_pct
                        FROM cash_one
                    )
                    SELECT 1
                    FROM margin m
                    WHERE m.cash_margin_pct IS NOT NULL
                      AND m.cash_margin_pct >= :min_margin
                    LIMIT 1
                    """
                )
                pcode_bind = str(player_code or "").strip()
                if conn.execute(
                    r1_sql,
                    {
                        "pcode": pcode_bind,
                        "min_margin": 50.0,
                        "min_bets": 100.0,
                    },
                ).first():
                    rule_verdicts["Rule 1"] = "FAIL"
            except Exception as e:
                print(f"[Rule Engine] {e}")
                conn.rollback()

            # 10b. Rule 2 — Primary_Major_income_sessions "% Win" + Win floor; signup age (defaults match schema)
            try:
                r2_sql = text(
                    """
                    WITH account_one AS (
                        SELECT
                            TRIM("Player Code"::TEXT) AS player_code,
                            MAX("Signup date + time") AS signup_raw
                        FROM "Primary_Account_information"
                        WHERE TRIM("Player Code"::TEXT) = TRIM(:pcode)
                        GROUP BY TRIM("Player Code"::TEXT)
                    )
                    SELECT 1
                    FROM "Primary_Major_income_sessions" m
                    INNER JOIN account_one a ON a.player_code = TRIM(m."Player code"::TEXT)
                    WHERE COALESCE(m."% Win"::DOUBLE PRECISION, 0) > :min_pct_win
                      AND COALESCE(m."Win"::DOUBLE PRECISION, 0) >= :min_win
                      AND a.signup_raw IS NOT NULL
                      AND TRIM(a.signup_raw::TEXT) <> ''
                      AND (CURRENT_TIMESTAMP - CAST(a.signup_raw AS TIMESTAMP))
                          <= make_interval(0, 0, 0, :rule_days, 0, 0, 0.0)
                    LIMIT 1
                    """
                )
                if conn.execute(
                    r2_sql,
                    {
                        "pcode": pcode_bind,
                        "rule_days": 2,
                        "min_pct_win": 500.0,
                        "min_win": 50.0,
                    },
                ).first():
                    rule_verdicts["Rule 2"] = "FAIL"
            except Exception as e:
                print(f"[Rule Engine] Rule 2: {e}")
                conn.rollback()

            # 10c. Rules 3–5 — common tournament overlap (Twister / MTT / SNG); defaults align with schema seed
            try:
                pcode_ov = None
                try:
                    pcode_ov = int(float(str(player_code or "").strip().replace(",", "")))
                except (TypeError, ValueError):
                    pcode_ov = None
                if pcode_ov is not None:
                    overlap_stmt = text(_PLAYER_OVERLAP_RULE_VERDICT_SQL)
                    overlap_params = {"min_common": 5, "min_pct": 30.0, "pcode": pcode_ov}
                    for rule_label, ttype, require_both in (
                        ("Rule 3", "Twister", 1),
                        ("Rule 4", "MTT", 0),
                        ("Rule 5", "SNG", 0),
                    ):
                        if conn.execute(
                            overlap_stmt,
                            {**overlap_params, "ttype": ttype, "require_both": require_both},
                        ).first():
                            rule_verdicts[rule_label] = "FAIL"
            except Exception as e:
                print(f"[Rule Engine] Rules 3–5 overlap verdict: {e}")
                conn.rollback()

    except Exception as e:
        print(f"[ERROR] /api/player/<{player_code}> - Critical error in get_player_profile: {e}")
        traceback.print_exc()
        # Return graceful fallback instead of crashing
        return jsonify({
            "error": "Player not found or database error",
            "message": str(e),
            "global_view": {
                "profile": {"player_code": player_code, "nickname": None},
                "core_info": {},
                "statistical_info": {},
                "network": [],
                "related_players": [],
                "graph_data": {"nodes": [], "links": []},
                "v2_summary": {},
                "session_history": [],
                "mtt_sessions": [],
                "spike_log": [],
                "radar_chart_data": None,
                "timelineData": [],
                "cumulative_performance": [],
                "rule_verdicts": rule_verdicts,
            }
        }), 200  # Return 200 with error message instead of 500

    # Check if we found any data - if not, return graceful fallback
    if not session_history and not core_info.get("nickname"):
        return jsonify({
            "error": "Player not found",
            "message": f"No data found for player_code: {player_code}",
            "global_view": {
                "profile": {"player_code": player_code, "nickname": None},
                "core_info": core_info,
                "statistical_info": statistical_info,
                "network": network,
                "related_players": related_players,
                "graph_data": graph_data,
                "v2_summary": v2_summary,
                "session_history": session_history,
                "mtt_sessions": mtt_sessions,
                "spike_log": spike_log,
                "radar_chart_data": radar_chart_data,
                "timelineData": timeline_data,
                "cumulative_performance": cumulative_performance,
                "rule_verdicts": rule_verdicts,
            }
        }), 200

    # Align with triage when tournament/cash SQL left total_profit unset (timeouts, partial failures).
    if v2_summary.get("total_profit") is None and case_snapshot_total_profit is not None:
        tp = float(case_snapshot_total_profit)
        v2_summary["total_profit"] = tp
        statistical_info["total_profit"] = tp
        core_info["total_profit"] = tp

    # Build global_view response
    global_view = {
        "profile": profile,
        "core_info": core_info,
        "statistical_info": statistical_info,
        "network": network,
        "related_players": related_players,
        "network_triggers": None,
        "graph_data": graph_data,
        "v2_summary": v2_summary,
        "session_history": session_history,
        "mtt_sessions": mtt_sessions,
        "spike_log": spike_log,
        "radar_chart_data": radar_chart_data,
        "timelineData": timeline_data,
        "cumulative_performance": cumulative_performance,
        "rule_verdicts": rule_verdicts,
    }
    global_view["statistical_info"].update({
        "total_logins": total_logins,
        "unique_ips": unique_ips,
        "unique_serials": unique_serials,
        "ip_volatility": ip_volatility,
    })

    return jsonify({"global_view": global_view})


@fraud_bp.route("/api/cases/<path:player_code>/chart-data", methods=["GET"])
def get_player_chart_data(player_code: str):
    """
    Time-series chart data for React charts (FinancialChart / PerformanceTrendChart).
    Daily aggregates from Primary_Cash_table_session_summary only; numeric fields
    are aggregated as ::NUMERIC in SQL. Nickname may be resolved from investigation_cases.
    """
    import logging
    log = logging.getLogger(__name__)

    player_code = (player_code or request.args.get("player_code") or "").strip()
    if not player_code:
        return jsonify({"error": "player_code required", "timeline": []}), 400

    conn_str = current_app.config.get("COLLUSION_CONNECTION_STRING") or COLLUSION_DB_URL
    if not conn_str:
        return jsonify({"timeline": []})

    sql = text("""
        SELECT
            DATE("Session start date & time"::TIMESTAMP)::TEXT AS stat_date,
            SUM(COALESCE("Total profit/loss"::NUMERIC, 0)) AS daily_profit,
            SUM(COALESCE("Rake generated"::NUMERIC, 0)) AS daily_rake,
            SUM(COALESCE("Total bets"::NUMERIC, 0)) AS daily_stake
        FROM "Primary_Cash_table_session_summary"
        WHERE LOWER(TRIM("Nickname")) = LOWER(TRIM(:nick))
           OR TRIM("Player Code"::TEXT) = TRIM(:pcode)
        GROUP BY DATE("Session start date & time"::TIMESTAMP)
        ORDER BY DATE("Session start date & time"::TIMESTAMP) ASC
    """)

    try:
        engine = get_db_engine(conn_str)
        with engine.connect() as conn:
            pcode = player_code
            if not str(pcode).strip().isdigit():
                try:
                    extracted = resolve_player_code_from_nickname(conn, pcode)
                    if extracted:
                        pcode = extracted
                except Exception:
                    conn.rollback()
            # Optional hint from site DB (case row); Primary_* remains source of truth for series.
            case_nickname_hint = None
            try:
                case_engine = get_case_engine()
                if case_engine:
                    with case_engine.connect() as cconn:
                        for key in (pcode, player_code):
                            if not key:
                                continue
                            row = cconn.execute(
                                text(
                                    "SELECT player_nickname FROM investigation_cases WHERE player_code = :player_code LIMIT 1"
                                ),
                                {"player_code": str(key).strip()},
                            ).fetchone()
                            if row and row[0]:
                                case_nickname_hint = str(row[0]).strip()
                                break
            except Exception:
                pass
            nick_for_sql = case_nickname_hint or pcode
            try:
                nick_for_sql = resolve_display_nickname_from_primary(conn, pcode) or nick_for_sql
            except Exception:
                conn.rollback()
            result = conn.execute(sql, {"nick": nick_for_sql, "pcode": pcode}).mappings().fetchall()
            timeline = []
            cumulative_profit = 0.0
            cumulative_rake = 0.0
            for row in result:
                daily_profit = float(row.get("daily_profit") or 0.0)
                daily_rake = float(row.get("daily_rake") or 0.0)
                daily_stake = float(row.get("daily_stake") or 0.0)
                cumulative_profit += daily_profit
                cumulative_rake += daily_rake
                timeline.append({
                    "date": (row.get("stat_date") or row.get("date") or "") if row is not None else "",
                    "profit": round(daily_profit, 2),
                    "net_win": round(daily_profit, 2),
                    "daily_profit": round(daily_profit, 2),
                    "cumulative_profit": round(cumulative_profit, 2),
                    "rake": round(daily_rake, 2),
                    "daily_rake": round(daily_rake, 2),
                    "cumulative_rake": round(cumulative_rake, 2),
                    "stake": round(daily_stake, 2),
                    "avg_stake": round(daily_stake, 2),
                })
            return jsonify({"timeline": timeline})
    except Exception as e:
        log.error("Error fetching chart data for %s: %s", player_code, str(e))
        return jsonify({"error": str(e), "timeline": []}), 500


@fraud_bp.route("/api/player/<path:player_code>/live-report", methods=["POST"])
def fetch_live_report(player_code: str):
    """
    Fetch a 14‑day EFOP report for a single player from Playtech and
    return the CSV payload as JSON.
    """
    try:
        data = request.json or {}
        report_id = data.get("report_id", "13750")
        report_version = data.get("report_version", "3.0")

        end_date = datetime.now(timezone.utc)
        start_date = end_date - timedelta(days=14)
        start_date_str = start_date.strftime("%Y-%m-%d")
        end_date_str = end_date.strftime("%Y-%m-%d")

        admin_user = PLAYTECH_ADMIN_USER
        admin_pass = PLAYTECH_ADMIN_PASSWORD

        # If it's all digits, it's a Player Code (2). Otherwise, it's a Nickname (1).
        id_type = "2" if str(player_code).isdigit() else "1"

        payload = {
            "admin": admin_user,
            "password": admin_pass,
            "startdate": start_date_str,
            "enddate": end_date_str,
            "nicknameorcode": id_type,
            "plr_1": str(player_code),
            "plr_2": "",
            "plr_3": "",
            "plr_4": "",
            "outputs": data.get(
                "outputs",
                (
                    "Player2Username,Player2Nickname,PlayerCode2,Player2Cardroom,"
                    "SessionCode,StartDate,EndDate,Player2Frozen,NoOfCommonHands,"
                    "EarningsFromOpponent,CurrencyCode"
                ),
            ),
        }

        url = f"{PLAYTECH_BASE_URL}/report/{report_id}/report_version/{report_version}/"

        # Bypass VPN strict SSL checks (legacy behaviour).
        import urllib3

        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

        headers = {"Content-Type": "application/x-www-form-urlencoded"}
        resp = requests.post(url, data=payload, headers=headers, timeout=30, verify=False)
        resp.raise_for_status()

        df = pd.read_csv(io.StringIO(resp.text))
        df = df.replace({np.nan: None})

        return jsonify({"status": "success", "data": df.to_dict(orient="records")})
    except Exception as exc:  # pragma: no cover - defensive logging
        return jsonify({"status": "error", "message": str(exc)}), 500


@fraud_bp.route("/api/cases/<int:case_id>/attachments", methods=["POST"])
def upload_case_attachment(case_id: int):
    """Upload a file attachment for a given case and persist metadata."""
    if "file" not in request.files:
        return jsonify({"error": "No file part in request"}), 400

    file = request.files["file"]
    if file.filename == "":
        return jsonify({"error": "No file selected"}), 400

    from werkzeug.utils import secure_filename

    filename = secure_filename(file.filename)
    if not filename:
        return jsonify({"error": "Invalid filename"}), 400

    os.makedirs(ATTACHMENTS_UPLOAD_ROOT, exist_ok=True)
    file_path = os.path.join(ATTACHMENTS_UPLOAD_ROOT, filename)
    file.save(file_path)

    conn_str = current_app.config.get("COLLUSION_CONNECTION_STRING") or COLLUSION_DB_URL
    if not conn_str:
        return jsonify({"error": "Collusion DB not configured"}), 500

    engine = get_db_engine(conn_str)
    conn = None
    try:
        conn = engine.connect()
        conn.execute(
            text(
                "INSERT INTO case_attachments (case_id, file_name, file_path) "
                "VALUES (:case_id, :file_name, :file_path)"
            ),
            {
                "case_id": case_id,
                "file_name": filename,
                "file_path": file_path,
            },
        )
        conn.commit()
        return (
            jsonify(
                {
                    "status": "success",
                    "attachment": {
                        "case_id": case_id,
                        "file_name": filename,
                        "file_path": file_path,
                    },
                }
            ),
            201,
        )
    except Exception as exc:
        if conn is not None:
            conn.rollback()
        return jsonify({"error": str(exc)}), 500
    finally:
        if conn is not None:
            conn.close()


@fraud_bp.route("/api/cases/<int:case_id>/attachments", methods=["GET"])
def get_case_attachments(case_id: int):
    """Return all attachments associated with a given case."""
    conn_str = current_app.config.get("COLLUSION_CONNECTION_STRING") or COLLUSION_DB_URL
    if not conn_str:
        return jsonify({"error": "Collusion DB not configured", "attachments": []}), 500

    engine = get_db_engine(conn_str)
    conn = None
    try:
        conn = engine.connect()
        rows = (
            conn.execute(
                text(
                    "SELECT id, case_id, file_name, file_path "
                    "FROM case_attachments "
                    "WHERE case_id = :case_id "
                    "ORDER BY id DESC"
                ),
                {"case_id": case_id},
            )
            .mappings()
            .all()
        )
        attachments = [dict(r) for r in rows]
        return jsonify({"attachments": attachments})
    except Exception as exc:
        return jsonify({"error": str(exc), "attachments": []}), 500
    finally:
        if conn is not None:
            conn.close()


@fraud_bp.route(
    "/api/cases/<int:case_id>/attachments/<int:attachment_id>/download",
    methods=["GET"],
)
def download_case_attachment(case_id: int, attachment_id: int):
    """Serve the file securely after verifying that it belongs to the case."""
    conn_str = current_app.config.get("COLLUSION_CONNECTION_STRING") or COLLUSION_DB_URL
    if not conn_str:
        return jsonify({"error": "Collusion DB not configured"}), 500

    engine = get_db_engine(conn_str)
    conn = None
    try:
        conn = engine.connect()
        row = (
            conn.execute(
                text(
                    "SELECT id, case_id, file_name, file_path "
                    "FROM case_attachments "
                    "WHERE id = :attachment_id AND case_id = :case_id"
                ),
                {"attachment_id": attachment_id, "case_id": case_id},
            )
            .mappings()
            .first()
        )
        if not row:
            return jsonify({"error": "Attachment not found"}), 404

        data = dict(row)
        file_path = data.get("file_path") or ""
        file_name = data.get("file_name") or "download"

        directory = os.path.abspath(ATTACHMENTS_UPLOAD_ROOT)
        filename = os.path.basename(file_path)
        if not filename or filename != os.path.normpath(filename):
            return jsonify({"error": "Invalid file path"}), 400

        return send_from_directory(directory, filename, as_attachment=True, download_name=file_name)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500
    finally:
        if conn is not None:
            conn.close()


def _case_row_to_dict(row: InvestigationCase) -> dict:
    """Serialize case for API; uses model to_dict when available so category/tag and flattened metrics are always included."""
    if hasattr(row, "to_dict") and callable(row.to_dict):
        return row.to_dict()

    # Fallback for legacy or detached rows – mirror InvestigationCase.to_dict logic,
    # including flattened ``network_data`` fields so the triage React table keeps working.
    nd = getattr(row, "network_data", None) or {}

    mtt_win_pct = float(nd.get("mtt_win_pct") or 0.0)
    cash_win_pct = float(nd.get("cash_win_pct") or 0.0)
    total_mtts = int(nd.get("total_mtts") or 0)
    total_sessions = int(nd.get("total_sessions") or 0)
    total_hands_played = int(nd.get("total_hands_played") or 0)
    total_profit_loss = float(nd.get("total_profit_loss") or 0.0)
    total_rake_fees = float(nd.get("total_rake_fees") or 0.0)
    cash_ratio = float(nd.get("cash_ratio") or 0.0)
    mtt_ratio = float(nd.get("mtt_ratio") or 0.0)
    account_lifetime_fee = float(nd.get("account_lifetime_fee") or 0.0)
    twister_win_pct = float(nd.get("twister_win_pct") or 0.0)
    total_twister_buyin = float(nd.get("total_twister_buyin") or 0.0)
    total_mtt_buyin = float(nd.get("total_mtt_buyin") or 0.0)

    out = {
        "id": row.id,
        "case_ref": f"#{row.id}" if getattr(row, "id", None) is not None else None,
        "player_code": getattr(row, "player_code", None) or row.player_nickname,
        "player_nickname": row.player_nickname,
        "risk_score": float(row.risk_score),
        "triggered_scenarios": row.triggered_scenarios or "",
        "status": row.status or "Open",
        "assigned_agent": row.assigned_agent,
        "decision_summary": row.decision_summary,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        "net_profit": float(getattr(row, "net_profit", 0.0) or 0.0),
        "roi": float(getattr(row, "roi", 0.0) or 0.0),
        "win_rate": float(getattr(row, "win_rate", 0.0) or 0.0),
        "total_hands": int(getattr(row, "total_hands", 0) or 0),
        "lifetime_rake": float(getattr(row, "lifetime_rake", 0.0) or 0.0),
        "network_data": nd,
        "category": getattr(row, "category", None) or "General",
        "tag": getattr(row, "tag", None),
    }

    out.update(
        {
            "mtt_win_pct": mtt_win_pct,
            "cash_win_pct": cash_win_pct,
            "total_mtts": total_mtts,
            "total_sessions": total_sessions,
            "total_hands_played": total_hands_played,
            "total_profit_loss": total_profit_loss,
            "total_rake_fees": total_rake_fees,
            "cash_ratio": cash_ratio,
            "mtt_ratio": mtt_ratio,
            "account_lifetime_fee": account_lifetime_fee,
            "twister_win_pct": twister_win_pct,
            "total_twister_buyin": total_twister_buyin,
            "total_mtt_buyin": total_mtt_buyin,
            "twisters_played": int(nd.get("twisters_played") or 0),
        }
    )

    return out


def _note_row_to_dict(row: CaseNote) -> dict:
    return {
        "id": row.id,
        "case_id": row.case_id,
        "agent": row.agent_name,
        "agent_name": row.agent_name,
        "content": row.content or "",
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


@fraud_bp.route("/api/collusion/cases", methods=["GET"])
def get_collusion_cases():
    """Fetch all cases from investigation_cases ordered by risk_score descending."""
    try:
        engine = get_case_engine()
        with Session(engine) as session:
            rows = session.query(InvestigationCase).order_by(InvestigationCase.risk_score.desc()).all()
            return jsonify([_case_row_to_dict(r) for r in rows])
    except Exception as e:
        import traceback
        print(f"[ERROR] Failed to fetch cases: {str(e)}")
        traceback.print_exc()
        return jsonify({"error": str(e), "cases": []}), 500


@fraud_bp.route("/api/collusion/cases", methods=["POST"])
def post_collusion_case():
    """Create a new case in investigation_cases."""
    data = request.get_json(silent=True) or {}
    player_code = (data.get("player_code") or "").strip()
    nickname = (
        data.get("player_nickname")
        or data.get("nickname")
        or player_code
        or ""
    ).strip()
    risk_score = float(data.get("risk_score", 0))
    triggered = (data.get("triggered_scenarios") or data.get("reason") or "").strip()
    if not nickname and not player_code:
        return jsonify({"error": "player_code or player_nickname required"}), 400
    if not player_code:
        player_code = nickname

    engine = get_case_engine()
    with Session(engine) as session:
        existing = (
            session.query(InvestigationCase)
            .filter(InvestigationCase.player_code == player_code)
            .first()
        )
        if existing:
            return (
                jsonify(
                    {
                        "error": "A case already exists for this player_code. "
                        "Update the existing case (e.g. set status to Open) instead of creating a duplicate.",
                        "case_ref": f"#{existing.id}",
                        "id": existing.id,
                    }
                ),
                409,
            )

        case = InvestigationCase(
            player_code=player_code,
            player_nickname=nickname,
            risk_score=risk_score,
            triggered_scenarios=triggered,
            status="Open",
            assigned_agent=None,
            decision_summary=None,
        )
        session.add(case)
        session.commit()
        session.refresh(case)
        return jsonify(_case_row_to_dict(case)), 201


@fraud_bp.route("/api/collusion/cases/<int:case_id>", methods=["GET"])
def get_collusion_case(case_id: int):
    """Fetch one case and its notes."""
    engine = get_case_engine()
    with Session(engine) as session:
        case = (
            session.query(InvestigationCase)
            .filter(InvestigationCase.id == case_id)
            .first()
        )
        if not case:
            return jsonify({"error": "Case not found"}), 404
        out = _case_row_to_dict(case)
        notes = (
            session.query(CaseNote)
            .filter(CaseNote.case_id == case_id)
            .order_by(CaseNote.created_at.asc())
            .all()
        )
        out["notes"] = [_note_row_to_dict(n) for n in notes]
        return jsonify(out)


@fraud_bp.route("/api/collusion/cases/<int:case_id>", methods=["PUT"])
def put_collusion_case(case_id: int):
    """Update status, assigned_agent, decision_summary for an existing case."""
    data = request.get_json(silent=True) or {}
    status = (data.get("status") or "").strip() or None
    assigned_agent = (data.get("assigned_agent") or "").strip() or None
    decision_summary = (data.get("decision_summary") or "").strip() or None

    engine = get_case_engine()
    try:
        with Session(engine) as session:
            case = session.query(InvestigationCase).get(case_id)
            if not case:
                return jsonify({"error": "Case not found"}), 404
            if status is not None:
                case.status = status
            if assigned_agent is not None:
                case.assigned_agent = assigned_agent
            if decision_summary is not None:
                case.decision_summary = decision_summary
            session.commit()
            session.refresh(case)
            return jsonify(_case_row_to_dict(case))
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@fraud_bp.route("/api/collusion/cases/<int:case_id>/notes", methods=["GET"])
def get_collusion_case_notes(case_id: int):
    """Fetch all notes for a case ordered by created_at ascending."""
    engine = get_case_engine()
    with Session(engine) as session:
        case = (
            session.query(InvestigationCase)
            .filter(InvestigationCase.id == case_id)
            .first()
        )
        if not case:
            return jsonify({"error": "Case not found"}), 404
        notes = (
            session.query(CaseNote)
            .filter(CaseNote.case_id == case_id)
            .order_by(CaseNote.created_at.asc())
            .all()
        )
        return jsonify([_note_row_to_dict(n) for n in notes])


@fraud_bp.route("/api/collusion/cases/<int:case_id>/notes", methods=["POST"])
def post_collusion_case_note(case_id: int):
    """Insert a new note into case_notes."""
    data = request.get_json(silent=True) or {}
    content = (data.get("content") or "").strip()
    agent_name = (data.get("agent") or data.get("agent_name") or "").strip() or None
    if not content:
        return jsonify({"error": "content required"}), 400

    engine = get_case_engine()
    try:
        with Session(engine) as session:
            case = (
                session.query(InvestigationCase)
                .filter(InvestigationCase.id == case_id)
                .first()
            )
            if not case:
                return jsonify({"error": "Case not found"}), 404
            note = CaseNote(case_id=case_id, agent_name=agent_name, content=content)
            session.add(note)
            session.commit()
            session.refresh(note)
            return jsonify(_note_row_to_dict(note)), 201
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


def _collusion_get_rule_settings():
    """
    Read collusion rule settings from PostgreSQL, falling back to DB
    defaults and finally to in-code DEFAULT_SETTINGS.
    """
    engine = get_case_engine()
    # Ensure table exists (idempotent)
    with engine.connect() as conn:
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS collusion_rule_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
                """
            )
        )
        conn.commit()
        row = conn.execute(
            text("SELECT value FROM collusion_rule_settings WHERE key = :k"),
            {"k": COLLUSION_RULE_SETTINGS_KEY},
        ).fetchone()
    merged = dict(DEFAULT_SETTINGS)
    if row:
        try:
            blob = json.loads(row[0])
            if isinstance(blob, dict):
                merged.update(blob)
        except Exception:
            pass
    return _sanitize_v3_flat_settings(merged)


def _collusion_save_rule_settings(settings: dict) -> None:
    """Persist collusion rule settings to PostgreSQL (v3 blob). Omits ``rules`` — canonical copy lives in ``fraud_rule_configs``."""
    engine = get_case_engine()
    blob = {k: v for k, v in (settings or {}).items() if k != "rules"}
    with engine.connect() as conn:
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS collusion_rule_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
                """
            )
        )
        conn.execute(
            text(
                """
                INSERT INTO collusion_rule_settings (key, value)
                VALUES (:k, :v)
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
                """
            ),
            {"k": COLLUSION_RULE_SETTINGS_KEY, "v": json.dumps(blob)},
        )
        conn.commit()


def _load_fraud_rule_configs_from_table():
    """
    Load raw rows from ``fraud_rule_configs`` on the case-management DB (single source of truth).
    """
    return fetch_raw_fraud_rule_config_dicts_from_case_db()


def _load_fraud_rule_configs_blob_mirror() -> list:
    """
    Fallback when the ORM table read returns no rows: mirror JSON written by
    :func:`_persist_merged_fraud_configs_to_db` under ``collusion_rule_settings`` key
    ``fraud_rule_configs``. Keeps the UI consistent after refresh if the table is empty or unreadable.
    """
    try:
        engine = get_case_engine()
        with engine.connect() as conn:
            row = conn.execute(
                text("SELECT value FROM collusion_rule_settings WHERE key = :k"),
                {"k": FRAUD_RULE_CONFIGS_KEY},
            ).fetchone()
        if not row:
            return []
        data = json.loads(row[0])
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _collusion_get_fraud_rule_configs():
    """
    Read fraud rule configs: prefer live ``fraud_rule_configs`` PostgreSQL rows;
    fall back to collusion_rule_settings JSON blob, then schema defaults.
    """
    return load_merged_fraud_rule_configs_for_engine()


def _collusion_save_fraud_rule_configs(configs: list) -> None:
    """Persist fraud rule configs to collusion_rule_settings under FRAUD_RULE_CONFIGS_KEY."""
    engine = get_case_engine()
    with engine.connect() as conn:
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS collusion_rule_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
                """
            )
        )
        conn.execute(
            text(
                """
                INSERT INTO collusion_rule_settings (key, value)
                VALUES (:k, :v)
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
                """
            ),
            {"k": FRAUD_RULE_CONFIGS_KEY, "v": json.dumps(configs)},
        )
        conn.commit()


def _persist_merged_fraud_configs_to_db(merged: list) -> None:
    """Write merged config dicts to ``fraud_rule_configs`` and mirror JSON blob (legacy fallback)."""
    defaults_by_id = {int(c["rule_id"]): c for c in get_default_configs()}
    engine = get_case_engine()
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        for c in merged:
            rid = c.get("rule_id")
            if rid is None:
                continue
            rid = int(rid)
            row = session.query(FraudRuleConfig).filter(FraudRuleConfig.rule_id == rid).first()
            if row:
                nm = c.get("name") if "name" in c else c.get("rule_name")
                if nm is not None and str(nm).strip() != "":
                    row.rule_name = str(nm)
                if "category" in c and c["category"] is not None:
                    row.category = str(c["category"])
                if "description_template" in c and c["description_template"] is not None:
                    row.dynamic_description = str(c["description_template"])
                    flag_modified(row, "dynamic_description")
                if "is_active" in c:
                    row.is_active = bool(c["is_active"])
                elif "active" in c:
                    row.is_active = bool(c["active"])
                # JSON columns: merge parameters so partial payloads never wipe DB; flag_modified so
                # SQLAlchemy always persists JSONB/JSON changes.
                if "parameters" in c and isinstance(c["parameters"], dict):
                    prev = dict(row.parameters or {})
                    prev.update(c["parameters"])
                    row.parameters = prev
                    flag_modified(row, "parameters")
                if "risk_level" in c:
                    row.risk_level = c["risk_level"]
                if "weight" in c and c["weight"] is not None:
                    row.weight = _coerce_fraud_rule_weight(
                        c.get("weight"),
                        float((defaults_by_id.get(rid) or {}).get("weight", 50.0)),
                    )
                if "exclusions" in c and isinstance(c["exclusions"], dict):
                    row.exclusions = dict(c["exclusions"])
                    flag_modified(row, "exclusions")
            else:
                session.add(
                    FraudRuleConfig(
                        rule_id=rid,
                        rule_name=str(c.get("name") or f"Rule {rid}"),
                        category=str(c.get("category") or "General"),
                        risk_level=c.get("risk_level"),
                        weight=_coerce_fraud_rule_weight(
                            c.get("weight"),
                            float((defaults_by_id.get(rid) or {}).get("weight", 50.0)),
                        ),
                        parameters=dict(c.get("parameters") or {}),
                        exclusions=dict(c.get("exclusions") or {}),
                        dynamic_description=str(c.get("description_template") or ""),
                        is_active=bool(c.get("is_active", c.get("active", True))),
                    )
                )
        session.commit()
    _collusion_save_fraud_rule_configs(merged)


def _rules_list_for_ui(raw_rows: list) -> list:
    """
    ``rules`` for Enterprise UI: use persisted rows as-is (no schema parameter overlay).
    Stub in full default rows only for rule_ids missing from storage so every slot exists.
    Rows whose ``rule_id`` is not in the current schema (``get_default_configs()``) are dropped.
    """
    schema_ids = {int(c["rule_id"]) for c in get_default_configs()}
    if not raw_rows:
        return get_default_configs()
    by_id = {}
    for c in raw_rows:
        rid = c.get("rule_id")
        if rid is None:
            continue
        try:
            rid_i = int(rid)
        except (TypeError, ValueError):
            continue
        if rid_i not in schema_ids:
            continue
        by_id[rid_i] = copy.deepcopy(c)
    for d in get_default_configs():
        rid = int(d["rule_id"])
        if rid not in by_id:
            by_id[rid] = copy.deepcopy(d)
    return [by_id[k] for k in sorted(by_id)]


def _build_unified_rule_settings_response() -> dict:
    """
    Single payload for clients: legacy flat keys (``v3_standards``) plus canonical
    ``rules`` from ``fraud_rule_configs`` when the table has rows.

    When the table exists, ``rule{N}_active`` is **always** derived from each row’s
    ``is_active`` so the accordion cannot show “Active” just because the v3 blob
    omitted a false toggle (JSON merge would otherwise leave the key undefined → UI default on).
    """
    db_settings = _collusion_get_rule_settings() or {}
    merged = dict(DEFAULT_SETTINGS)
    merged.update(db_settings)
    table_cfg = _load_fraud_rule_configs_from_table()
    if not table_cfg:
        table_cfg = _load_fraud_rule_configs_blob_mirror()
    blob_rules = merged.get("rules")
    saved_list = table_cfg if table_cfg else (blob_rules if isinstance(blob_rules, list) else [])
    merged["rules"] = _rules_list_for_ui(saved_list)
    for r in merged["rules"]:
        rid = r.get("rule_id")
        if rid is None:
            continue
        try:
            rid_i = int(rid)
        except (TypeError, ValueError):
            continue
        _act = r.get("is_active")
        if _act is None:
            _act = r.get("active", True)
        merged[f"rule{rid_i}_active"] = bool(_act)
        ex = r.get("exclusions") or {}
        if not isinstance(ex, dict):
            continue

        def _pop_excl_flat(*keys: str) -> None:
            for k in keys:
                merged.pop(k, None)

        # Canonical ``rules[].exclusions`` is the source of truth; mirror into legacy flat keys so
        # the accordion cannot show stale values from an old v3 blob after Save.
        mh = ex.get("min_hands")
        if mh is not None and str(mh).strip() != "":
            merged[f"r{rid_i}_excl_min_Hands"] = mh
            merged[f"rule{rid_i}_min_hands"] = mh
        else:
            _pop_excl_flat(f"r{rid_i}_excl_min_Hands", f"rule{rid_i}_min_hands")

        rr_roi = ex.get("roi_range") if isinstance(ex.get("roi_range"), dict) else {}
        grf = ex.get("global_roi_from")
        grt = ex.get("global_roi_to")
        if grf is None:
            grf = rr_roi.get("from")
        if grt is None:
            grt = rr_roi.get("to")
        if grf is not None and str(grf).strip() != "":
            merged[f"r{rid_i}_excl_min_Roi"] = grf
        else:
            merged.pop(f"r{rid_i}_excl_min_Roi", None)
        if grt is not None and str(grt).strip() != "":
            merged[f"r{rid_i}_excl_max_Roi"] = grt
        else:
            merged.pop(f"r{rid_i}_excl_max_Roi", None)

        wr = ex.get("win_rate_range") if isinstance(ex.get("win_rate_range"), dict) else {}
        wfrom, wto = wr.get("from"), wr.get("to")
        if wfrom is not None and str(wfrom).strip() != "":
            merged[f"r{rid_i}_excl_win_rate_from"] = wfrom
        else:
            merged.pop(f"r{rid_i}_excl_win_rate_from", None)
        if wto is not None and str(wto).strip() != "":
            merged[f"r{rid_i}_excl_win_rate_to"] = wto
        else:
            merged.pop(f"r{rid_i}_excl_win_rate_to", None)

        thr = ex.get("total_hands_range") if isinstance(ex.get("total_hands_range"), dict) else {}
        thf, tht = thr.get("from"), thr.get("to")
        if thf is not None and str(thf).strip() != "":
            merged[f"r{rid_i}_excl_total_hands_from"] = thf
        else:
            merged.pop(f"r{rid_i}_excl_total_hands_from", None)
        if tht is not None and str(tht).strip() != "":
            merged[f"r{rid_i}_excl_total_hands_to"] = tht
        else:
            merged.pop(f"r{rid_i}_excl_total_hands_to", None)

        pr = ex.get("profit_range") if isinstance(ex.get("profit_range"), dict) else {}
        pf, pt = pr.get("from"), pr.get("to")
        if pf is not None and str(pf).strip() != "":
            merged[f"r{rid_i}_excl_min_Profit"] = pf
        else:
            merged.pop(f"r{rid_i}_excl_min_Profit", None)
        if pt is not None and str(pt).strip() != "":
            merged[f"r{rid_i}_excl_max_Profit"] = pt
        else:
            merged.pop(f"r{rid_i}_excl_max_Profit", None)

        rkr = ex.get("rake_range") if isinstance(ex.get("rake_range"), dict) else {}
        rk_f, rk_t = rkr.get("from"), rkr.get("to")
        rf = ex.get("rake_floor")
        if rk_f is not None and str(rk_f).strip() != "":
            merged[f"r{rid_i}_excl_min_Rake"] = rk_f
        elif rf is not None and str(rf).strip() != "":
            merged[f"r{rid_i}_excl_min_Rake"] = rf
        else:
            merged.pop(f"r{rid_i}_excl_min_Rake", None)
        if rk_t is not None and str(rk_t).strip() != "":
            merged[f"r{rid_i}_excl_max_Rake"] = rk_t
        else:
            merged.pop(f"r{rid_i}_excl_max_Rake", None)
    return merged


_RULE_ACTIVE_FLAT_RE = re.compile(r"^rule(\d+)_active$")


def _bool_coerce(v: object) -> bool:
    return str(v).lower() == "true" or v is True


def _sync_flat_rule_actives_to_fraud_table(payload: dict) -> None:
    """Keep ``fraud_rule_configs.is_active`` aligned when the UI saves legacy ``ruleN_active`` keys."""
    updates: list[tuple[int, bool]] = []
    for k, v in payload.items():
        if not isinstance(k, str):
            continue
        m = _RULE_ACTIVE_FLAT_RE.match(k)
        if not m:
            continue
        updates.append((int(m.group(1)), _bool_coerce(v)))
    if not updates:
        return
    defaults_by_id = {int(c["rule_id"]): c for c in get_default_configs()}
    engine = get_case_engine()
    with Session(engine) as session:
        for rid, active in updates:
            if rid not in defaults_by_id:
                continue
            row = session.query(FraudRuleConfig).filter(FraudRuleConfig.rule_id == rid).first()
            if row:
                row.is_active = active
            else:
                tmpl = defaults_by_id[rid]
                session.add(
                    FraudRuleConfig(
                        rule_id=rid,
                        rule_name=str(tmpl.get("name") or f"Rule {rid}"),
                        category=str(tmpl.get("category") or "General"),
                        risk_level=str(tmpl.get("risk_level") or "Medium"),
                        weight=_coerce_fraud_rule_weight(
                            tmpl.get("weight"),
                            float(tmpl.get("weight") or 50.0),
                        ),
                        parameters=dict(tmpl.get("parameters") or {}),
                        exclusions=dict(tmpl.get("exclusions") or {}),
                        dynamic_description=str(tmpl.get("description_template") or ""),
                        is_active=active,
                    )
                )
        session.commit()


def _merge_fraud_rule_configs_into_settings(configs: list, settings: dict) -> None:
    """
    Flatten fraud rule configs into settings so run_analysis has full JSON per rule.

    PostgreSQL ``fraud_rule_configs`` (via merged ``configs``) is authoritative for
    ``is_active``, weights, parameters, and exclusions. Legacy flat ``ruleN_active`` keys
    on ``settings`` are overwritten to match the merged rules so the engine sees one truth.
    """
    merge_fraud_configs_into_settings_core(configs or [], settings)
    for r in settings.get("rules") or []:
        try:
            rid_int = int(r.get("rule_id"))
        except Exception:
            continue
        fk = f"rule{rid_int}_active"
        _act = r.get("is_active")
        if _act is None:
            _act = r.get("active", True)
        settings[fk] = bool(_act)


def _persist_fraud_configs_from_request():
    """
    Merge request JSON ``configs`` with DB rows and persist.
    Shared by POST /api/rules and PUT /api/collusion/fraud-rule-configs.

    Uses ``schema_base=False`` so schema template parameters are **not** injected before applying
    the request — only existing DB values + explicit payload keys are merged.
    """
    data = request.get_json(silent=True) or {}
    configs = data.get("configs")
    if not isinstance(configs, list):
        return jsonify({"error": "configs array required"}), 400
    table_rows = _load_fraud_rule_configs_from_table() or []
    merged = merge_saved_into_defaults(configs, base_list=table_rows, schema_base=False)
    try:
        _persist_merged_fraud_configs_to_db(merged)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    return jsonify(_collusion_get_fraud_rule_configs())


@fraud_bp.route("/api/collusion/fraud-rule-configs", methods=["GET"])
def get_fraud_rule_configs():
    """Return merged fraud rule configs for the Fraud Rule Configuration UI."""
    configs = _collusion_get_fraud_rule_configs()
    return jsonify(configs)


@fraud_bp.route("/api/rules", methods=["GET"])
def get_rules():
    """Same payload as GET /api/collusion/fraud-rule-configs (``templates/rules.html``)."""
    return get_fraud_rule_configs()


@fraud_bp.route("/api/rules", methods=["POST"])
def post_rules():
    """
    Update fraud_rule_configs. Body: { "configs": [ { rule_id, parameters?, active? / is_active? }, ... ] }.
    Same behaviour as PUT /api/collusion/fraud-rule-configs.
    """
    return _persist_fraud_configs_from_request()


@fraud_bp.route("/api/collusion/fraud-rule-configs", methods=["PUT"])
def put_fraud_rule_configs():
    """
    Persist updated fraud rule configs. Body: { "configs": [ { rule_id, parameters?, active? / is_active? }, ... ] }.
    Updates fraud_rule_configs table when present, and the blob for backward compatibility.
    """
    return _persist_fraud_configs_from_request()


@fraud_bp.route("/api/collusion/rule-settings", methods=["GET"])
def get_collusion_rule_settings():
    """
    Return one unified JSON object: legacy flat keys (``v3_standards``) plus
    ``rules`` from ``fraud_rule_configs`` when present, so the engine and UI
    share the same presets without a second fetch.
    """
    return jsonify(_build_unified_rule_settings_response())


@fraud_bp.route("/api/collusion/rule-settings", methods=["PUT"])
def put_collusion_rule_settings():
    """
    Persist collusion rule settings (``v3_standards`` blob).

    If the body includes a non-empty ``rules`` array (same shape as
    ``fraud_rule_configs``), it is merged onto the current table rows and
    written in one step with the flat settings — no separate "second save"
    required for those fields.
    """
    data = request.get_json(silent=True) or {}
    rules = data.get("rules")
    flat_in = {k: v for k, v in data.items() if k != "rules"}
    data = dict(_sanitize_v3_flat_settings(flat_in))
    if isinstance(rules, list):
        data["rules"] = rules
    rules = data.get("rules")
    if isinstance(rules, list) and len(rules) > 0:
        table_rows = _load_fraud_rule_configs_from_table() or []
        merged_fc = merge_saved_into_defaults(rules, base_list=table_rows, schema_base=False)
        try:
            _persist_merged_fraud_configs_to_db(merged_fc)
        except Exception as e:
            return jsonify({"error": str(e)}), 500
    try:
        _sync_flat_rule_actives_to_fraud_table(data)
    except Exception as exc:
        logger.warning("Could not sync ruleN_active to fraud_rule_configs: %s", exc)
    _collusion_save_rule_settings(data)
    return jsonify(_build_unified_rule_settings_response())


@fraud_bp.route("/api/settings", methods=["GET"])
def get_settings():
    """
    Return UI/settings flags for the Fraud UI.

    The default DB connection string is always overridden with the
    absolute DEFAULT_DB_CONNECTION so the UI shows the real value in use.
    """
    s = storage.get_settings()
    s = dict(s)
    s["default_db_connection_string"] = DEFAULT_DB_CONNECTION
    return jsonify(s)


@fraud_bp.route("/api/settings", methods=["PUT"])
def update_settings():
    """
    Update persisted UI settings.

    Note: default_db_connection_string is fixed (DEFAULT_DB_CONNECTION)
    and is not persisted; only feature flags (e.g. ews_clickup_theme) are
    stored.
    """
    data = request.json or {}
    updates = {}
    if "ews_clickup_theme" in data:
        updates["ews_clickup_theme"] = data.get("ews_clickup_theme")
    if updates:
        storage.update_settings(updates)
    return jsonify(storage.get_settings())


def _run_collusion_scan_job(scan_days: int = 90) -> int:
    """
    Background job: load rule settings, merge fraud rule configs, run fraud analysis, and upsert cases.
    """
    settings = _collusion_get_rule_settings() or dict(DEFAULT_SETTINGS)
    configs = _collusion_get_fraud_rule_configs()
    _merge_fraud_rule_configs_into_settings(configs, settings)
    # Apply manual scan days override to limit historical lookback.
    try:
        sd = int(scan_days)
    except Exception:
        sd = 90
    settings["lookbackDays"] = sd
    settings["major_sessions_lookback_days"] = sd

    conn_str = current_app.config.get("COLLUSION_CONNECTION_STRING") or COLLUSION_DB_URL
    if not conn_str:
        return 0

    # Single end-of-scan persist: no per-rule upserts (avoids duplicate/stale rows and 0 metrics).
    cases = run_analysis(conn_str, settings, persist_after_each_rule=False)
    try:
        written = upsert_cases(cases)
    except Exception:
        logger.exception(
            "upsert_cases failed after collusion scan (%s case dict(s) from engine)",
            len(cases),
        )
        raise
    print(
        f"[Fraud Engine] Case DB upsert finished: {written} row(s) processed "
        f"({len(cases)} engine case dict(s)) → {mask_connection_url(CASE_MANAGEMENT_URL)}"
    )
    return written


@fraud_bp.route("/api/collusion/scan/trigger", methods=["POST"])
def trigger_collusion_scan():
    """
    Start a collusion scan in the background. Returns immediately; scan runs in a separate thread.
    Accepts JSON payload: { "days": <int> } to limit historical lookback.
    """
    global scan_lock

    data = request.json or {}
    try:
        scan_days = int(data.get("days", 90))
    except Exception:
        scan_days = 90

    if scan_lock.locked():
        return jsonify({"status": "running", "message": "A scan is already in progress."})

    # Capture the real Flask app object so the background thread has context
    app_obj = current_app._get_current_object()

    def run_job():
        acquired = scan_lock.acquire(blocking=False)
        if not acquired:
            return
        try:
            with app_obj.app_context():
                _run_collusion_scan_job(scan_days)
        except Exception:
            traceback.print_exc()
        finally:
            try:
                scan_lock.release()
            except Exception:
                pass

    _threading.Thread(target=run_job, daemon=True).start()
    return jsonify({"status": "started", "message": f"Scan initiated for the last {scan_days} days."})


__all__ = ["fraud_bp"]

