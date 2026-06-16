"""
backend_v2.engine.fraud_engine
-------------------------------

Fraud analysis engine: **Rules 1–2** (cash margin; major-income ``% Win`` spike) and **Rules 3–5**
(Twister / MTT / SNG common-tournament overlap from ``Primary_SNG_Twister_and_MTT``).

**Design:** Add new rules by extending ``FRAUD_RULES_META`` + a new ``_evaluate_ruleN_*`` and a branch in ``run_analysis``. Shared plumbing (merge configs, ``_finalize_cases`` scoring from "Rule N" labels in ``reason``, categories) stays multi-rule-ready.

    run_analysis(connection_string: str, settings: dict) -> list[dict]
"""

from __future__ import annotations

import logging
import re
import time
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple

from tqdm import tqdm

from sqlalchemy import bindparam, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from backend_v2.database import get_case_engine, get_db_engine, mask_connection_url
from backend_v2.engine.fraud_rule_config_schema import (
    FRAUD_RULES_META,
    get_default_configs,
    merge_fraud_configs_into_settings_core,
    meta_default_weight,
)
from backend_v2.models.case_models import CaseManagementBase, InvestigationCase

log = logging.getLogger(__name__)

# Investigation / triage — single source for exports and DB normalization (matches triage CASE_TABS minus "All").
MASTER_CATEGORIES: Tuple[str, ...] = (
    "Chip Dumping",
    "New Account High Win",
    "Common Games",
    "General",
)


def _is_rule_active(settings: Dict[str, object], rule_ids: List[int]) -> bool:
    """Checks if any rule in the provided list is toggled Active in merged settings."""
    flat_flags: List[bool] = []
    for rid in rule_ids:
        fk = f"rule{rid}_active"
        if fk in settings:
            v = settings[fk]
            flat_flags.append(str(v).lower() == "true" or v is True)
    if flat_flags:
        return any(flat_flags)

    rules = settings.get("rules", [])
    if not rules:
        return True

    active_flags: List[bool] = []
    for r in rules:
        try:
            rid = int(r.get("rule_id", -1))
        except Exception:
            continue
        if rid in rule_ids:
            raw_flag = r.get("is_active")
            if raw_flag is None:
                raw_flag = r.get("active", True)
            active = str(raw_flag).lower() == "true" or raw_flag is True
            active_flags.append(active)

    if not active_flags:
        return False if rules else True
    return any(active_flags)


def _count_scan_phases(settings: Dict[str, object]) -> int:
    """ETA bar denominator for ``run_analysis``: one phase per active rule (1–5)."""
    n = sum(1 for rid in (1, 2, 3, 4, 5) if _is_rule_active(settings, [rid]))
    return n if n > 0 else 1


def get_rule_config(settings: Dict[str, object], target_rule_id: int) -> Tuple[Dict[str, object], Dict[str, object]]:
    rules = settings.get("rules", [])
    for r in rules or []:
        try:
            rid = int(r.get("rule_id"))
        except Exception:
            continue
        if rid == target_rule_id:
            params = r.get("parameters", {})
            excls = r.get("exclusions", {})
            return params if isinstance(params, dict) else {}, excls if isinstance(excls, dict) else {}
    return {}, {}


def fraud_rule_parameters(settings: Dict[str, object], rule_id: int) -> Dict[str, object]:
    raw, _ = get_rule_config(settings, rule_id)
    return dict(raw or {})


def get_rule_weight(settings: Dict[str, object], rule_id: int) -> float:
    rid = int(rule_id)
    rc = settings.get("rule_configs") or {}
    rd = rc.get(rid) or rc.get(str(rid)) or {}
    w = rd.get("weight")
    if w is not None:
        return float(w)
    for r in settings.get("rules") or []:
        try:
            if int(r.get("rule_id", -1)) != rid:
                continue
        except Exception:
            continue
        rw = r.get("weight")
        if rw is not None:
            return float(rw)
    return float(meta_default_weight(rid))


def _scan_rule_fail(name: str, msg: str) -> None:
    tqdm.write(f"[ERROR] {name}: {msg}")


_SCAN_BAR_WIDTH = 24


def _ascii_scan_bar(fraction: float, width: int = _SCAN_BAR_WIDTH) -> str:
    frac = min(max(fraction, 0.0), 1.0)
    filled = int(round(frac * width))
    return "[" + ("#" * filled) + ("-" * (width - filled)) + "]"


def _format_eta_for_scan(seconds: float) -> str:
    if seconds < 60:
        return f"{seconds:.0f}s"
    m, s = divmod(int(seconds), 60)
    if m < 60:
        return f"{m}m {s:02d}s"
    h, m2 = divmod(m, 60)
    return f"{h}h {m2:02d}m"


def _print_verdict_box(total_sec: float, total_cases: int, most_active_category: str) -> None:
    tqdm.write("")
    tqdm.write("┌" + "─" * 58 + "┐")
    tqdm.write(f"│  Fraud scan complete in {total_sec:.1f}s — {total_cases} case(s) exported".ljust(58) + "│")
    tqdm.write(f"│  Top category: {most_active_category[:44]}".ljust(58) + "│")
    tqdm.write("└" + "─" * 58 + "┘")
    tqdm.write("")


def _print_sniper_summary(filtered: List[Dict[str, object]]) -> None:
    if not filtered:
        return
    by_cat = Counter((c.get("category") or "General") for c in filtered)
    tqdm.write("[SUMMARY] By category: " + ", ".join(f"{k}: {v}" for k, v in by_cat.most_common(8)))


def _count_cases_for_rule(cases_dict: Dict[str, "PlayerCase"], patterns: List[str]) -> int:
    n = 0
    for c in (cases_dict or {}).values():
        r = c.reason or ""
        if any(p in r for p in patterns):
            n += 1
    return n


@dataclass
class PlayerCase:
    player_code: str
    nickname: str
    risk_score: float
    reason: str
    category: str = ""
    tag: str = ""
    total_hands: int = 0
    net_profit: float = 0.0
    win_rate: float = 0.0
    win_rate_cash: float = 0.0
    win_rate_mtt: float = 0.0
    global_win_ratio: float = 0.0
    total_tournaments: int = 0
    lifetime_rake: float = 0.0
    lifetime_total_fees: float = 0.0
    vpip: float = 0.0
    pfr: float = 0.0
    three_bet: float = 0.0
    top_partners: str = ""
    roi: float = 0.0
    collusion_flags: int = 0
    network_data: Dict[str, object] = field(default_factory=dict)
    suspicious_sessions: list = field(default_factory=list)
    extra_score: float = 0.0
    triggered_scenarios: list = field(default_factory=list)

    def to_dict(self) -> Dict[str, object]:
        category = self.category if self.category in MASTER_CATEGORIES else "General"
        nd = dict(self.network_data or {})
        return {
            "player_code": self.player_code,
            "nickname": self.nickname,
            "risk_score": int(self.risk_score),
            "reason": self.reason,
            "category": category,
            "tag": self.tag,
            "total_hands": int(self.total_hands or 0),
            "net_profit": float(self.net_profit or 0.0),
            "win_rate": float(self.win_rate or 0.0),
            "win_rate_cash": float(self.win_rate_cash or 0.0),
            "win_rate_mtt": float(self.win_rate_mtt or 0.0),
            "global_win_ratio": float(self.global_win_ratio or 0.0),
            "total_tournaments": int(self.total_tournaments or 0),
            "lifetime_rake": float(self.lifetime_rake or 0.0),
            "lifetime_total_fees": float(self.lifetime_total_fees or 0.0),
            "vpip": float(self.vpip or 0.0),
            "pfr": float(self.pfr or 0.0),
            "three_bet": float(self.three_bet or 0.0),
            "top_partners": self.top_partners or "",
            "roi": float(self.roi or 0.0),
            "collusion_flags": int(self.collusion_flags or 0),
            "network_data": nd,
            "suspicious_sessions": list(self.suspicious_sessions or []),
            # Flatten for triage / socket payloads (mirrors InvestigationCase.to_dict).
            "twister_win_pct": float(nd.get("twister_win_pct") or 0.0),
            "twisters_played": int(nd.get("twisters_played") or 0),
        }


def _normalize_pc_str(raw: object) -> str:
    s = str(raw or "").strip()
    if s.endswith(".0") and len(s) > 2 and s[:-2].isdigit():
        s = s[:-2]
    return s


def _player_codes_from_cases(cases_dict: Dict[str, PlayerCase]) -> List[int]:
    seen: set = set()
    out: List[int] = []
    for pc in cases_dict.values():
        for src in (getattr(pc, "player_code", None), (getattr(pc, "network_data", None) or {}).get("core_player_code")):
            s = _normalize_pc_str(src)
            if s.isdigit() and s not in seen:
                seen.add(s)
                out.append(int(s))
    return out


def _resolve_player_codes_for_bulk(cases_dict: Dict[str, PlayerCase], engine: Engine) -> List[int]:
    codes = _player_codes_from_cases(cases_dict)
    if codes:
        return codes
    nicks = list({(pc.nickname or "").strip() for pc in cases_dict.values() if (pc.nickname or "").strip()})
    if not nicks:
        return []
    sql = text(
        """
        SELECT DISTINCT q.pc FROM (
            SELECT "Player Code" AS pc FROM "Primary_Account_information" WHERE "Nickname" = ANY(:nicks)
            UNION
            SELECT "Player code" AS pc FROM "Primary_Major_income_sessions" WHERE "Nickname" = ANY(:nicks)
            UNION
            SELECT "Player Code" AS pc FROM "Primary_Cash_table_session_summary" WHERE "Nickname" = ANY(:nicks)
            UNION
            SELECT "Player Code" AS pc FROM "Primary_Login_activity_by_player" WHERE "Nickname" = ANY(:nicks)
            UNION
            SELECT "Player code" AS pc FROM "Primary_SNG_Twister_and_MTT" WHERE "Nickname" = ANY(:nicks)
            UNION
            SELECT "Player code" AS pc FROM "Primary_Cash_Games_Player_Stats" WHERE "Nickname" = ANY(:nicks)
        ) q
        WHERE q.pc IS NOT NULL
        """
    )
    try:
        with engine.connect() as conn:
            rows = conn.execute(sql, {"nicks": nicks}).fetchall()
        return sorted({int(r[0]) for r in rows if r[0] is not None})
    except Exception:
        return []


def _cases_by_player_code_str(cases_dict: Dict[str, PlayerCase]) -> Dict[str, List[PlayerCase]]:
    m: Dict[str, List[PlayerCase]] = {}
    for pc in cases_dict.values():
        for src in (pc.player_code, (pc.network_data or {}).get("core_player_code")):
            s = _normalize_pc_str(src)
            if s.isdigit():
                m.setdefault(s, []).append(pc)
    return m


def _safe_float(value: object, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _exclusion_min_hands_floor(exclusions: Dict[str, object]) -> Optional[object]:
    v = exclusions.get("min_lifetime_hands")
    if v is not None:
        return v
    return exclusions.get("min_hands")


def _get_player_lifetime_stats(
    player_code: str,
    cases_dict: Dict[str, PlayerCase],
    player_totals: Dict[str, Dict[str, object]],
) -> Dict[str, float]:
    pc = cases_dict.get(player_code)
    if pc and (getattr(pc, "total_hands", 0) or 0) > 0:
        return {
            "total_hands": float(getattr(pc, "total_hands", 0) or 0),
            "net_profit": float(getattr(pc, "net_profit", 0) or 0),
            "roi": float(getattr(pc, "roi", 0) or 0),
            "win_rate": float(getattr(pc, "win_rate", 0) or 0),
            "lifetime_rake": float(getattr(pc, "lifetime_rake", 0) or 0),
            "lifetime_total_fees": float(getattr(pc, "lifetime_total_fees", 0) or 0),
            "total_tournaments": float(getattr(pc, "total_tournaments", 0) or 0),
        }
    pt = player_totals.get(player_code) or {}
    total_hands = _safe_float(pt.get("total_hands"), 0.0)
    total_buy = _safe_float(pt.get("total_buy"), 0.0)
    total_win = _safe_float(pt.get("total_win"), 0.0)
    total_won_hands = _safe_float(pt.get("total_won_hands"), 0.0)
    total_rake = _safe_float(pt.get("total_rake"), 0.0)
    net_profit = total_win - total_buy
    roi = (net_profit / total_buy * 100.0) if total_buy and total_buy > 0 else 0.0
    win_rate = (total_won_hands / total_hands * 100.0) if total_hands and total_hands > 0 else 0.0
    total_tournaments = _safe_float(pt.get("total_tournaments"), 0.0)
    return {
        "total_hands": total_hands,
        "net_profit": net_profit,
        "roi": roi,
        "win_rate": win_rate,
        "lifetime_rake": total_rake,
        "lifetime_total_fees": 0.0,
        "total_tournaments": total_tournaments,
    }


def _should_exclude_player(
    player_code: str,
    rule_id: int,
    cases_dict: Dict[str, PlayerCase],
    player_totals: Dict[str, Dict[str, object]],
    settings: Dict[str, object],
    excluded_set: Optional[set] = None,
) -> bool:
    rule_exclusions = settings.get("rule_exclusions") or {}
    exclusions = rule_exclusions.get(rule_id) or rule_exclusions.get(str(rule_id)) or {}
    if not exclusions:
        return False
    stats = _get_player_lifetime_stats(player_code, cases_dict, player_totals)
    total_hands = stats["total_hands"]
    roi = stats["roi"]
    net_profit = stats["net_profit"]
    lifetime_rake = stats["lifetime_rake"]

    def _in_range(val: float, from_val: object, to_val: object) -> bool:
        if from_val is None and to_val is None:
            return False
        try:
            f = float(from_val) if from_val is not None else None
            t = float(to_val) if to_val is not None else None
            if f is not None and val < f:
                return False
            if t is not None and val > t:
                return False
            return True
        except (TypeError, ValueError):
            return False

    mh_floor = _exclusion_min_hands_floor(exclusions)
    if mh_floor is not None:
        try:
            mh = float(mh_floor)
            if total_hands < mh:
                if excluded_set is not None:
                    excluded_set.add(player_code)
                return True
        except (TypeError, ValueError):
            pass

    mlnp = exclusions.get("min_lifetime_net_profit")
    if mlnp is not None:
        try:
            if net_profit < float(mlnp):
                if excluded_set is not None:
                    excluded_set.add(player_code)
                return True
        except (TypeError, ValueError):
            pass

    ml_roi = exclusions.get("min_lifetime_roi_pct")
    if ml_roi is not None:
        try:
            if roi < float(ml_roi):
                if excluded_set is not None:
                    excluded_set.add(player_code)
                return True
        except (TypeError, ValueError):
            pass

    roi_range = exclusions.get("roi_range") or {}
    if isinstance(roi_range, dict) and _in_range(roi, roi_range.get("from"), roi_range.get("to")):
        if excluded_set is not None:
            excluded_set.add(player_code)
        return True

    profit_range = exclusions.get("profit_range") or {}
    if isinstance(profit_range, dict) and _in_range(net_profit, profit_range.get("from"), profit_range.get("to")):
        if excluded_set is not None:
            excluded_set.add(player_code)
        return True

    total_hands_range = exclusions.get("total_hands_range") or {}
    if isinstance(total_hands_range, dict) and _in_range(
        float(total_hands), total_hands_range.get("from"), total_hands_range.get("to")
    ):
        if excluded_set is not None:
            excluded_set.add(player_code)
        return True

    win_rate_range = exclusions.get("win_rate_range") or {}
    if isinstance(win_rate_range, dict) and _in_range(
        float(stats.get("win_rate") or 0.0),
        win_rate_range.get("from"),
        win_rate_range.get("to"),
    ):
        if excluded_set is not None:
            excluded_set.add(player_code)
        return True

    rake_range = exclusions.get("rake_range") or {}
    if isinstance(rake_range, dict) and _in_range(
        lifetime_rake, rake_range.get("from"), rake_range.get("to")
    ):
        if excluded_set is not None:
            excluded_set.add(player_code)
        return True

    rake_floor = exclusions.get("rake_floor")
    if rake_floor is not None:
        try:
            rf = float(rake_floor)
            if lifetime_rake < rf:
                if excluded_set is not None:
                    excluded_set.add(player_code)
                return True
        except (TypeError, ValueError):
            pass

    fee_floor = exclusions.get("fee_floor")
    if fee_floor is not None:
        try:
            ff = float(fee_floor)
            lf = float(stats.get("lifetime_total_fees") or 0.0)
            if lf < ff:
                if excluded_set is not None:
                    excluded_set.add(player_code)
                return True
        except (TypeError, ValueError):
            pass

    return False


def normalize_category(category: str) -> str:
    if not category or not category.strip():
        return "General"
    c = category.strip()
    return c if c in MASTER_CATEGORIES else "General"


_CATEGORY_TAB_PRIORITY = (
    "Chip Dumping",
    "New Account High Win",
    "Common Games",
    "General",
)


def _rule_id_to_category_map(settings: Dict[str, object]) -> Dict[int, str]:
    m: Dict[int, str] = {}
    for meta in FRAUD_RULES_META:
        try:
            rid = int(meta["rule_id"])
        except (TypeError, ValueError, KeyError):
            continue
        m[rid] = normalize_category(str(meta.get("category") or "General"))
    for r in settings.get("rules") or []:
        if not isinstance(r, dict):
            continue
        try:
            rid = int(r.get("rule_id"))
        except (TypeError, ValueError):
            continue
        cat = r.get("category")
        if cat is not None and str(cat).strip():
            m[rid] = normalize_category(str(cat))
    return m


def _extract_rule_ids_from_reason(reason: str) -> List[int]:
    if not reason:
        return []
    seen: set[int] = set()
    out: List[int] = []
    for m in re.finditer(r"Rule\s+(\d+)", reason, re.IGNORECASE):
        try:
            rid = int(m.group(1))
        except ValueError:
            continue
        if rid not in seen:
            seen.add(rid)
            out.append(rid)
    return out


def _category_from_reason_and_rules(reason: str, settings: Dict[str, object]) -> str:
    ids = _extract_rule_ids_from_reason(reason or "")
    if ids:
        cmap = _rule_id_to_category_map(settings)
        cats = [cmap.get(rid, "General") for rid in ids]
        for tab in _CATEGORY_TAB_PRIORITY:
            if tab in cats:
                return tab
        return cats[-1]
    r_lower = (reason or "").lower()
    if "rule 2" in r_lower or "major" in r_lower:
        return "New Account High Win"
    if "rule 3" in r_lower or "rule 4" in r_lower or "rule 5" in r_lower:
        return "Common Games"
    if "twister common" in r_lower or "mtt common" in r_lower or "sng common" in r_lower:
        return "Common Games"
    if "burner" in r_lower or "new pro" in r_lower or "cash margin" in r_lower:
        return "Chip Dumping"
    return "General"


def _parse_rule_reasons(reason: str) -> Tuple[Dict[str, int], Dict[str, str]]:
    rule_counts: Dict[str, int] = {}
    rule_examples: Dict[str, str] = {}
    if not reason:
        return rule_counts, rule_examples
    for part in reason.split(" | "):
        part = part.strip()
        if not part:
            continue
        col_idx = part.find(":")
        label = part[:col_idx].strip() if col_idx != -1 else part.strip()
        rule_counts[label] = rule_counts.get(label, 0) + 1
        if label not in rule_examples:
            rule_examples[label] = part
    return rule_counts, rule_examples


def _score_rule(count: int, base_weight: float) -> float:
    if count <= 0:
        return 0.0
    return float(base_weight)


def _finalize_cases(cases_values: Iterable[PlayerCase], settings: Dict[str, object]) -> None:
    rule_configs = settings.get("rule_configs", {})
    for pc in cases_values:
        if pc.reason:
            parts = [p.strip() for p in pc.reason.split("|") if p.strip()]
            groups = {}
            order = []
            for p in parts:
                match = re.match(r"^(Rule\s+\d+)", p, re.IGNORECASE)
                if match:
                    rule_id = match.group(1).title()
                    if rule_id not in groups:
                        groups[rule_id] = []
                        order.append(rule_id)
                    groups[rule_id].append(p)
                else:
                    groups[p] = [p]
                    order.append(p)
            final_parts = []
            for key in order:
                items = groups[key]
                if len(items) == 1:
                    clean_str = re.sub(r"^(Rule\s+\d+)\s+\[", r"\1: [", items[0])
                    final_parts.append(clean_str)
                else:
                    first = items[0]
                    if "Triggered" in first and "Example:" in first:
                        final_parts.append(first)
                    else:
                        core_msg = re.sub(r"^(Rule\s+\d+:?\s*)", "", first)
                        final_parts.append(f"{key}: Triggered {len(items)} times. Example: {core_msg}")
            pc.reason = " | ".join(final_parts)

        counts, _ = _parse_rule_reasons(pc.reason)
        pc.risk_score = 0.0
        info_ids: List[int] = []
        for label, cnt in counts.items():
            match = re.search(r"Rule\s+(\d+)", label, re.IGNORECASE)
            if not match:
                continue
            rid_int = int(match.group(1))
            rule_data = rule_configs.get(str(rid_int)) or rule_configs.get(rid_int) or {}
            base_weight = float(rule_data.get("weight", meta_default_weight(rid_int)))
            if base_weight <= 0.0:
                if cnt > 0:
                    info_ids.append(rid_int)
                continue
            pc.risk_score += _score_rule(cnt, base_weight)
        pc.risk_score += float(getattr(pc, "extra_score", 0.0) or 0.0)
        if info_ids:
            nd = dict(pc.network_data or {})
            merged = list(nd.get("informational_rule_ids") or [])
            if not isinstance(merged, list):
                merged = []
            for x in sorted(set(info_ids)):
                if x not in merged:
                    merged.append(x)
            merged.sort()
            nd["informational_rule_ids"] = merged
            pc.network_data = nd
            tag_bits = [f"INFO_R{r}" for r in merged]
            pc.tag = (pc.tag + "," + ",".join(tag_bits)) if (pc.tag and pc.tag.strip()) else ",".join(tag_bits)

        pc.category = _category_from_reason_and_rules(pc.reason or "", settings)
        if not pc.tag or pc.tag == "UNKNOWN":
            pc.tag = pc.category.upper().replace(" ", "_").replace("-", "_")


def build_nickname_to_player_code_map(conn) -> Dict[str, str]:
    out: Dict[str, str] = {}
    stmts = [
        text(
            """
            SELECT "Nickname" AS nk, MAX("Player code"::TEXT) AS pc
            FROM "Primary_Major_income_sessions"
            WHERE "Nickname" <> '' AND "Player code" IS NOT NULL
            GROUP BY "Nickname"
            """
        ),
        text(
            """
            SELECT "Nickname" AS nk, MAX("Player Code"::TEXT) AS pc
            FROM "Primary_Account_information"
            WHERE "Nickname" <> '' AND "Player Code" IS NOT NULL
            GROUP BY "Nickname"
            """
        ),
        text(
            """
            SELECT "Nickname" AS nk, MAX("Player Code"::TEXT) AS pc
            FROM "Primary_Cash_table_session_summary"
            WHERE "Nickname" <> '' AND "Player Code" IS NOT NULL
            GROUP BY "Nickname"
            """
        ),
        text(
            """
            SELECT "Nickname" AS nk, MAX("Player code"::TEXT) AS pc
            FROM "Primary_Cash_Games_Player_Stats"
            WHERE "Nickname" <> '' AND "Player code" IS NOT NULL
            GROUP BY "Nickname"
            """
        ),
        text(
            """
            SELECT "Nickname" AS nk, MAX("Player code"::TEXT) AS pc
            FROM "Primary_SNG_Twister_and_MTT"
            WHERE "Nickname" <> '' AND "Player code" IS NOT NULL
            GROUP BY "Nickname"
            """
        ),
    ]
    for stmt in stmts:
        try:
            for row in conn.execute(stmt).mappings():
                nk = (row.get("nk") or "").strip()
                pc = (row.get("pc") or "").strip()
                if not nk or not pc:
                    continue
                if nk not in out:
                    out[nk] = pc
                lk = nk.lower()
                if lk not in out:
                    out[lk] = pc
        except Exception:
            continue
    return out


def resolve_player_code_from_nickname(conn, nickname: str) -> Optional[str]:
    nick = (nickname or "").strip()
    if not nick:
        return None
    stmts = [
        text(
            """
            SELECT MAX("Player code"::TEXT) AS player_code
            FROM "Primary_Major_income_sessions"
            WHERE "Nickname" = :nick
            LIMIT 1
            """
        ),
        text(
            """
            SELECT MAX("Player Code"::TEXT) AS player_code
            FROM "Primary_Account_information"
            WHERE "Nickname"::TEXT = :nick OR "Username"::TEXT = :nick
            LIMIT 1
            """
        ),
        text(
            """
            SELECT MAX("Player Code"::TEXT) AS player_code
            FROM "Primary_Cash_table_session_summary"
            WHERE "Nickname" = :nick
            LIMIT 1
            """
        ),
        text(
            """
            SELECT MAX("Player code"::TEXT) AS player_code
            FROM "Primary_Cash_Games_Player_Stats"
            WHERE "Nickname" = :nick
            LIMIT 1
            """
        ),
        text(
            """
            SELECT MAX("Player code"::TEXT) AS player_code
            FROM "Primary_SNG_Twister_and_MTT"
            WHERE "Nickname" = :nick
            LIMIT 1
            """
        ),
        text(
            """
            SELECT MAX("Player Code"::TEXT) AS player_code
            FROM "Primary_Login_activity_by_player"
            WHERE "Nickname"::TEXT = :nick OR "Username"::TEXT = :nick
            LIMIT 1
            """
        ),
    ]
    for stmt in stmts:
        try:
            row = conn.execute(stmt, {"nick": nick}).mappings().first()
            if row:
                code = (row.get("player_code") or "").strip()
                if code:
                    return code
        except Exception:
            continue
    return None


def resolve_display_nickname_from_primary(conn, player_code: str) -> str:
    pcode = (player_code or "").strip()
    if not pcode:
        return pcode
    try:
        pcode_bind: object = int(float(pcode))
    except (TypeError, ValueError):
        pcode_bind = pcode
    stmts = [
        text(
            """
            SELECT MAX("Nickname") AS nick
            FROM "Primary_Account_information"
            WHERE "Player Code" = :pcode
            """
        ),
        text(
            """
            SELECT MAX("Nickname") AS nick
            FROM "Primary_Major_income_sessions"
            WHERE "Player code" = :pcode
            """
        ),
        text(
            """
            SELECT MAX("Nickname") AS nick
            FROM "Primary_Cash_table_session_summary"
            WHERE "Player Code" = :pcode
            """
        ),
        text(
            """
            SELECT MAX("Nickname") AS nick
            FROM "Primary_Login_activity_by_player"
            WHERE "Player Code" = :pcode
            """
        ),
    ]
    for stmt in stmts:
        try:
            row = conn.execute(stmt, {"pcode": pcode_bind}).mappings().first()
            if row:
                n = (row.get("nick") or "").strip()
                if n:
                    return n
        except Exception:
            continue
    return pcode


def _evaluate_rule1_burner(
    engine: Engine,
    settings: Dict[str, object],
    cases_dict: Dict[str, PlayerCase],
    player_totals: Dict[str, Dict[str, object]],
) -> None:
    """Rule 1: cash margin % from cash sessions only (no signup-age gate)."""
    r1 = fraud_rule_parameters(settings, 1)
    min_margin = r1.get("min_cash_margin_pct")
    if min_margin is None or min_margin == "":
        min_margin = r1.get("burner_roi_threshold")
    min_margin_f = _safe_float(min_margin, 50.0)
    min_bets_f = _safe_float(r1.get("min_cash_total_bets"), 100.0)
    if min_bets_f < 1e-9:
        min_bets_f = 100.0

    rule_sql = text(
        """
        WITH cash_agg AS (
            SELECT
                TRIM("Player Code"::TEXT) AS pc,
                SUM(COALESCE("Total profit/loss", 0)::NUMERIC) AS sum_pl,
                SUM(COALESCE("Total bets", 0)::NUMERIC) AS sum_bets
            FROM "Primary_Cash_table_session_summary"
            GROUP BY TRIM("Player Code"::TEXT)
        ),
        margin AS (
            SELECT
                pc,
                sum_pl,
                sum_bets,
                CASE
                    WHEN sum_bets > 0 THEN (sum_pl / sum_bets) * 100.0
                    ELSE NULL
                END AS cash_margin_pct
            FROM cash_agg
            WHERE sum_bets >= :min_bets
        )
        SELECT
            m.pc AS player_code,
            MAX(NULLIF(TRIM(COALESCE(a."Nickname"::TEXT, '')), '')) AS nick,
            MAX(m.cash_margin_pct)::DOUBLE PRECISION AS cash_margin_pct,
            MAX(m.sum_bets)::DOUBLE PRECISION AS sum_bets
        FROM margin m
        LEFT JOIN "Primary_Account_information" a ON TRIM(a."Player Code"::TEXT) = m.pc
        WHERE m.cash_margin_pct IS NOT NULL
          AND m.cash_margin_pct >= :min_margin
        GROUP BY m.pc
        """
    )
    with engine.connect() as conn:
        rows = list(
            conn.execute(
                rule_sql,
                {
                    "min_margin": min_margin_f,
                    "min_bets": min_bets_f,
                },
            ).mappings()
        )
    for row in rows:
        r = dict(row)
        pcode_raw = r.get("player_code")
        if pcode_raw is None:
            continue
        player_code = str(pcode_raw).replace(".0", "").strip()
        if not player_code:
            continue
        if _should_exclude_player(player_code, 1, cases_dict, player_totals, settings):
            continue
        nickname = (r.get("nick") or "").strip() or player_code
        margin = float(r.get("cash_margin_pct") or 0.0)
        sum_bets = float(r.get("sum_bets") or 0.0)
        pc = cases_dict.get(player_code)
        if not pc:
            pc = PlayerCase(
                player_code=player_code,
                nickname=nickname,
                risk_score=0.0,
                reason="",
            )
            cases_dict[player_code] = pc
        pc.category = "Chip Dumping"
        if not pc.tag or pc.tag == "UNKNOWN":
            pc.tag = "CASH_MARGIN_NEW"
        elif "CASH_MARGIN_NEW" not in (pc.tag or ""):
            pc.tag = f"{pc.tag},CASH_MARGIN_NEW"
        reason = (
            f"Rule 1 [Cash]: Cash margin {margin:.2f}% (floor {min_margin_f:.1f}%) — "
            f"(Σ Total profit/loss ÷ Σ Total bets) × 100 from Primary_Cash_table_session_summary only; "
            f"Σ bets {sum_bets:.0f} (min {min_bets_f:.0f})."
        )
        if reason not in pc.reason:
            pc.risk_score = 0.0
            pc.reason = (pc.reason + " | " + reason).strip(" |")


def _evaluate_rule2_major_income(
    engine: Engine,
    settings: Dict[str, object],
    cases_dict: Dict[str, PlayerCase],
    player_totals: Dict[str, Dict[str, object]],
) -> None:
    """Rule 2: ``Primary_Major_income_sessions`` warehouse ``% Win`` vs Buy/Win floors; signup age from account table."""
    r2 = fraud_rule_parameters(settings, 2)
    _age_raw = r2.get("major_max_age_days", r2.get("max_age_days", 2))
    max_age_days = max(1, int(float(_age_raw)))
    min_pct_win = _safe_float(r2.get("min_major_pct_win"), 500.0)
    min_win = _safe_float(r2.get("min_major_session_win"), 50.0)
    if min_win < 0.0:
        min_win = 0.0

    rule_sql = text(
        """
        WITH account_one AS (
            SELECT
                TRIM("Player Code"::TEXT) AS player_code,
                MAX("Nickname") AS nickname,
                MAX("Signup date + time") AS signup_raw
            FROM "Primary_Account_information"
            GROUP BY TRIM("Player Code"::TEXT)
        ),
        qualified AS (
            SELECT
                TRIM(m."Player code"::TEXT) AS player_code,
                a.nickname AS nickname,
                COALESCE(m."% Win"::DOUBLE PRECISION, 0) AS pct_win,
                COALESCE(m."Win"::DOUBLE PRECISION, 0) AS win_amt,
                COALESCE(m."Buy"::DOUBLE PRECISION, 0) AS buy_amt,
                m."Session code" AS session_code
            FROM "Primary_Major_income_sessions" m
            INNER JOIN account_one a ON a.player_code = TRIM(m."Player code"::TEXT)
            WHERE COALESCE(m."% Win"::DOUBLE PRECISION, 0) > :min_pct_win
              AND COALESCE(m."Win"::DOUBLE PRECISION, 0) >= :min_win
              AND a.signup_raw IS NOT NULL
              AND TRIM(a.signup_raw::TEXT) <> ''
              AND (CURRENT_TIMESTAMP - CAST(a.signup_raw AS TIMESTAMP))
                  <= make_interval(0, 0, 0, :max_age_days, 0, 0, 0.0)
        )
        SELECT DISTINCT ON (player_code)
            player_code,
            nickname,
            pct_win,
            win_amt,
            buy_amt,
            session_code
        FROM qualified
        ORDER BY player_code, pct_win DESC NULLS LAST
        """
    )
    with engine.connect() as conn:
        rows = list(
            conn.execute(
                rule_sql,
                {
                    "max_age_days": max_age_days,
                    "min_pct_win": min_pct_win,
                    "min_win": min_win,
                },
            ).mappings()
        )
    for row in rows:
        r = dict(row)
        pcode_raw = r.get("player_code")
        if pcode_raw is None:
            continue
        player_code = str(pcode_raw).replace(".0", "").strip()
        if not player_code:
            continue
        if _should_exclude_player(player_code, 2, cases_dict, player_totals, settings):
            continue
        nickname = (r.get("nickname") or "").strip() or player_code
        pct_win = float(r.get("pct_win") or 0.0)
        win_amt = float(r.get("win_amt") or 0.0)
        buy_amt = float(r.get("buy_amt") or 0.0)
        session_code = r.get("session_code")
        sess = "" if session_code is None else str(session_code).replace(".0", "").strip()
        pc = cases_dict.get(player_code)
        if not pc:
            pc = PlayerCase(
                player_code=player_code,
                nickname=nickname,
                risk_score=0.0,
                reason="",
            )
            cases_dict[player_code] = pc
        pc.category = "New Account High Win"
        if not pc.tag or pc.tag == "UNKNOWN":
            pc.tag = "MAJOR_PCT_WIN"
        elif "MAJOR_PCT_WIN" not in (pc.tag or ""):
            pc.tag = f"{pc.tag},MAJOR_PCT_WIN"
        reason = (
            f'Rule 2 [Major]: Primary_Major_income_sessions "% Win" {pct_win:.2f}% (floor {min_pct_win:.1f}%), '
            f"Win {win_amt:.2f} (min {min_win:.1f}), Buy {buy_amt:.2f}, session {sess or '—'}; "
            f"signup ≤{max_age_days}d (Primary_Account_information)."
        )
        if reason not in pc.reason:
            pc.risk_score = 0.0
            pc.reason = (pc.reason + " | " + reason).strip(" |")


_COMMON_OVERLAP_RANKED_SQL = """
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
        pb.total_tournaments AS total_b,
        ROUND((pp.common_tournaments_played::NUMERIC / NULLIF(pa.total_tournaments, 0)) * 100, 2) AS pct_a,
        ROUND((pp.common_tournaments_played::NUMERIC / NULLIF(pb.total_tournaments, 0)) * 100, 2) AS pct_b
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
),
per_player AS (
    SELECT
        q.player_a_code AS player_code,
        q.player_b_code AS partner_code,
        q.common_tournaments_played,
        q.pct_a AS overlap_pct_self,
        q.pct_b AS overlap_pct_partner,
        q.total_a AS total_tournaments_self,
        q.total_b AS total_tournaments_partner
    FROM qualified q
    UNION ALL
    SELECT
        q.player_b_code,
        q.player_a_code,
        q.common_tournaments_played,
        q.pct_b,
        q.pct_a,
        q.total_b,
        q.total_a
    FROM qualified q
)
SELECT DISTINCT ON (player_code)
    player_code,
    partner_code,
    common_tournaments_played,
    overlap_pct_self,
    overlap_pct_partner,
    total_tournaments_self,
    total_tournaments_partner
FROM per_player
ORDER BY player_code, common_tournaments_played DESC, overlap_pct_self DESC NULLS LAST
"""


def _evaluate_rule_common_overlap(
    engine: Engine,
    settings: Dict[str, object],
    cases_dict: Dict[str, PlayerCase],
    player_totals: Dict[str, Dict[str, object]],
    *,
    rule_id: int,
    tournament_type: str,
    bracket_label: str,
    tag_token: str,
    require_both_overlap_pct: bool = False,
) -> None:
    """Rules 3–5: lifetime distinct tournament overlap in one format (Twister / MTT / SNG).

    Rule 3 callers set require_both_overlap_pct=True (both players must meet min_overlap_pct).
    Rules 4–5 use the default (either player suffices).
    """
    rp = fraud_rule_parameters(settings, rule_id)
    try:
        min_common = int(float(rp.get("min_common_tournaments", 5)))
    except (TypeError, ValueError):
        min_common = 5
    if min_common < 1:
        min_common = 1
    min_pct = _safe_float(rp.get("min_overlap_pct", rp.get("min_pct_either")), 30.0)

    rule_sql = text(_COMMON_OVERLAP_RANKED_SQL)
    require_both = 1 if require_both_overlap_pct else 0
    with engine.connect() as conn:
        rows = list(
            conn.execute(
                rule_sql,
                {
                    "ttype": tournament_type,
                    "min_common": min_common,
                    "min_pct": min_pct,
                    "require_both": require_both,
                },
            ).mappings()
        )
        need_nicks = set()
        for row in rows:
            for key in ("player_code", "partner_code"):
                raw = row.get(key)
                if raw is None:
                    continue
                pk = str(raw).replace(".0", "").strip()
                if pk:
                    need_nicks.add(pk)
        nick_map: Dict[str, str] = {}
        for pk in sorted(need_nicks):
            nick_map[pk] = resolve_display_nickname_from_primary(conn, pk) or pk

    for row in rows:
        r = dict(row)
        pcode_raw = r.get("player_code")
        if pcode_raw is None:
            continue
        player_code = str(pcode_raw).replace(".0", "").strip()
        if not player_code:
            continue
        if _should_exclude_player(player_code, rule_id, cases_dict, player_totals, settings):
            continue
        partner_raw = r.get("partner_code")
        partner_code = str(partner_raw).replace(".0", "").strip() if partner_raw is not None else ""
        partner_disp = (nick_map.get(partner_code) or partner_code or "—").strip()
        common = int(r.get("common_tournaments_played") or 0)
        ov_self = float(r.get("overlap_pct_self") or 0.0)
        ov_pt = float(r.get("overlap_pct_partner") or 0.0)
        tot_self = int(r.get("total_tournaments_self") or 0)
        tot_pt = int(r.get("total_tournaments_partner") or 0)

        pc0 = cases_dict.get(player_code)
        if pc0 and (pc0.nickname or "").strip():
            nickname = (pc0.nickname or "").strip()
        else:
            nickname = nick_map.get(player_code) or player_code

        pc = cases_dict.get(player_code)
        if not pc:
            pc = PlayerCase(
                player_code=player_code,
                nickname=nickname,
                risk_score=0.0,
                reason="",
            )
            cases_dict[player_code] = pc
        elif not (pc.nickname or "").strip() or pc.nickname == pc.player_code:
            pc.nickname = nickname

        pc.category = "Common Games"
        if not pc.tag or pc.tag == "UNKNOWN":
            pc.tag = tag_token
        elif tag_token not in (pc.tag or ""):
            pc.tag = f"{pc.tag},{tag_token}"

        overlap_floor_note = (
            f"floor {min_pct:.1f}% overlap for both players."
            if require_both_overlap_pct
            else f"floor {min_pct:.1f}% on either side."
        )
        reason = (
            f"Rule {rule_id} [{bracket_label}]: Partner {partner_disp} (player code {partner_code}) — "
            f"{common} shared distinct {tournament_type} tournaments (floor {min_common}); "
            f"overlap {ov_self:.2f}% of your {tot_self} in this format, "
            f"{ov_pt:.2f}% of partner’s {tot_pt} ({overlap_floor_note}) "
            f"Source Primary_SNG_Twister_and_MTT; lifetime scope (no calendar-day filter)."
        )
        if reason not in pc.reason:
            pc.risk_score = 0.0
            pc.reason = (pc.reason + " | " + reason).strip(" |")


def _evaluate_rule3_twister_common(
    engine: Engine,
    settings: Dict[str, object],
    cases_dict: Dict[str, PlayerCase],
    player_totals: Dict[str, Dict[str, object]],
) -> None:
    _evaluate_rule_common_overlap(
        engine,
        settings,
        cases_dict,
        player_totals,
        rule_id=3,
        tournament_type="Twister",
        bracket_label="Twister Common",
        tag_token="TWISTER_COMMON",
        require_both_overlap_pct=True,
    )


def _evaluate_rule4_mtt_common(
    engine: Engine,
    settings: Dict[str, object],
    cases_dict: Dict[str, PlayerCase],
    player_totals: Dict[str, Dict[str, object]],
) -> None:
    _evaluate_rule_common_overlap(
        engine,
        settings,
        cases_dict,
        player_totals,
        rule_id=4,
        tournament_type="MTT",
        bracket_label="MTT Common",
        tag_token="MTT_COMMON",
    )


def _evaluate_rule5_sng_common(
    engine: Engine,
    settings: Dict[str, object],
    cases_dict: Dict[str, PlayerCase],
    player_totals: Dict[str, Dict[str, object]],
) -> None:
    _evaluate_rule_common_overlap(
        engine,
        settings,
        cases_dict,
        player_totals,
        rule_id=5,
        tournament_type="SNG",
        bracket_label="SNG Common",
        tag_token="SNG_COMMON",
    )


def _bulk_update_unified_profile(cases_dict: Dict[str, PlayerCase], engine: Engine) -> None:
    """
    Single CTE query: strict table roles (account / cash / major / SNG+MTT+Twister / HUD stats / logins).
    Financial totals: cash Σ(Total profit/loss) + tourney Σ(Total win − Buy-ins − Fees − Jackpot fees),
    matching the daily timeline merge (``Primary_SNG_Twister_and_MTT``).
    Lifetime rake & fee: prefer account ``Lifetime Rake`` / ``Lifetime Fee``; if zero or missing, fall back to
    max(account, major ``Player lifetime rake``, cash ``Rake generated``) for rake, and sum of tournament
    ``Fees`` + ``Jackpot fees`` for fee when account fee is absent.
    ``total_hands`` uses cash hands plus distinct SNG/MTT/Twister entry counts so MTT-heavy profiles are not all zero.
    Core display fields: account first, then major / first login / tournament metadata. VPIP/PFR/3-bet: HUD only.
    """
    if not cases_dict:
        return

    codes = _resolve_player_codes_for_bulk(cases_dict, engine)
    if not codes:
        return

    by_pc = _cases_by_player_code_str(cases_dict)

    sql = text(
        """
        WITH SearchCodes AS (SELECT unnest(CAST(:codes AS BIGINT[])) AS pc),
        AccountAgg AS (
            SELECT
                "Player Code" AS join_pc,
                MAX("Nickname") AS acc_nickname,
                MAX("Username") AS acc_username,
                MAX("Country") AS acc_country,
                MAX("Signup date + time") AS acc_signup,
                MAX("Signup IP") AS acc_signup_ip,
                MAX("Signup serial") AS acc_signup_serial,
                MAX("Frozen") AS acc_frozen,
                MAX("Cardroom") AS acc_cardroom,
                MAX("Lifetime Rake")::DOUBLE PRECISION AS acc_lifetime_rake_raw,
                MAX("Lifetime Fee")::DOUBLE PRECISION AS acc_lifetime_fee_raw
            FROM "Primary_Account_information"
            WHERE "Player Code" IN (SELECT pc FROM SearchCodes)
            GROUP BY "Player Code"
        ),
        MajorIdentityAgg AS (
            SELECT
                "Player code" AS join_pc,
                MAX(NULLIF(TRIM("Country"), '')) AS m_country,
                MAX(NULLIF(TRIM("Real sign up date"), '')) AS m_signup,
                MAX(NULLIF(TRIM("Frozen"), '')) AS m_frozen,
                MAX("Player lifetime rake")::DOUBLE PRECISION AS m_lifetime_rake
            FROM "Primary_Major_income_sessions"
            WHERE "Player code" IN (SELECT pc FROM SearchCodes)
            GROUP BY "Player code"
        ),
        LoginFirstAgg AS (
            SELECT DISTINCT ON ("Player Code")
                "Player Code" AS join_pc,
                NULLIF(TRIM("IP"), '') AS login_first_ip,
                NULLIF(TRIM("Serial"), '') AS login_first_serial,
                NULLIF(TRIM("Casino"), '') AS login_first_casino
            FROM "Primary_Login_activity_by_player"
            WHERE "Player Code" IN (SELECT pc FROM SearchCodes)
            ORDER BY "Player Code", "Login Date Time" ASC NULLS LAST
        ),
        TourneyDisplayAgg AS (
            SELECT
                "Player code" AS join_pc,
                NULL AS t_vip,
                MAX(NULLIF(TRIM("Casino"::TEXT), '')) AS t_casino,
                MAX(NULLIF(TRIM("Country"::TEXT), '')) AS t_country
            FROM "Primary_SNG_Twister_and_MTT"
            WHERE "Player code" IN (SELECT pc FROM SearchCodes)
            GROUP BY "Player code"
        ),
        CashAgg AS (
            SELECT
                "Player Code" AS join_pc,
                SUM(COALESCE("Hands played", 0)) AS cash_hands,
                SUM(COALESCE("Hands Won", 0)) AS cash_hands_won,
                SUM(COALESCE("Total profit/loss", 0)) AS cash_profit,
                SUM(COALESCE("Total bets", 0)) AS cash_bets,
                SUM(COALESCE("Total bets", 0) + COALESCE("Total profit/loss", 0)) AS cash_return,
                SUM(COALESCE("Rake generated", 0)) AS cash_rake_generated
            FROM "Primary_Cash_table_session_summary"
            WHERE "Player Code" IN (SELECT pc FROM SearchCodes)
            GROUP BY "Player Code"
        ),
        MajorAgg AS (
            SELECT
                "Player code" AS join_pc,
                COUNT(*) FILTER (WHERE UPPER(TRIM(COALESCE("iPoker collusion", ''))) = 'YES') AS ipoker_ban_hits,
                COUNT(*) FILTER (WHERE ("Win" - "Buy") > 0) AS profitable_major_sessions,
                COUNT(*) AS total_major_sessions
            FROM "Primary_Major_income_sessions"
            WHERE "Player code" IN (SELECT pc FROM SearchCodes)
            GROUP BY "Player code"
        ),
        TourneyAgg AS (
            SELECT
                "Player code" AS join_pc,
                COALESCE(SUM(
                    COALESCE("Total win", 0) - COALESCE("Buy-ins", 0) - COALESCE("Fees", 0)
                    - COALESCE("Jackpot fees", 0)
                ), 0) AS tourney_net_all,
                COALESCE(SUM(CASE WHEN TRIM(COALESCE("Tournament type", '')) = 'MTT'
                    THEN COALESCE("Total win", 0) - COALESCE("Buy-ins", 0) - COALESCE("Fees", 0)
                    - COALESCE("Jackpot fees", 0) ELSE 0 END), 0
                ) AS mtt_net,
                COALESCE(SUM(CASE WHEN TRIM(COALESCE("Tournament type", '')) = 'Twister'
                    THEN COALESCE("Total win", 0) - COALESCE("Buy-ins", 0) - COALESCE("Fees", 0)
                    - COALESCE("Jackpot fees", 0) ELSE 0 END), 0
                ) AS twister_net,
                COALESCE(SUM(CASE WHEN TRIM(COALESCE("Tournament type", '')) = 'MTT'
                    THEN COALESCE("Buy-ins", 0) + COALESCE("Fees", 0) + COALESCE("Jackpot fees", 0) ELSE 0 END), 0
                ) AS mtt_buy_fees,
                COALESCE(SUM(CASE WHEN TRIM(COALESCE("Tournament type", '')) = 'Twister'
                    THEN COALESCE("Buy-ins", 0) + COALESCE("Fees", 0) + COALESCE("Jackpot fees", 0) ELSE 0 END), 0
                ) AS twister_buy_fees,
                COALESCE(SUM(CASE WHEN TRIM(COALESCE("Tournament type", '')) = 'MTT'
                    THEN COALESCE("Total win", 0) ELSE 0 END), 0
                ) AS mtt_total_win,
                COALESCE(SUM(CASE WHEN TRIM(COALESCE("Tournament type", '')) = 'Twister'
                    THEN COALESCE("Total win", 0) ELSE 0 END), 0
                ) AS twister_total_win,
                COALESCE(SUM(
                    COALESCE("Buy-ins", 0) + COALESCE("Fees", 0) + COALESCE("Jackpot fees", 0)
                ), 0) AS all_buy_fees,
                COALESCE(SUM(COALESCE("Fees", 0) + COALESCE("Jackpot fees", 0)), 0) AS sum_tourney_entry_fees
            FROM "Primary_SNG_Twister_and_MTT"
            WHERE "Player code" IN (SELECT pc FROM SearchCodes)
            GROUP BY "Player code"
        ),
        TourneyDist AS (
            SELECT
                d.join_pc,
                COUNT(DISTINCT CASE
                    WHEN d.tt IN ('MTT', 'SNG') AND d.tc <> '' THEN d.tc END) AS cnt_mtt_sng,
                COUNT(*) FILTER (WHERE d.tt = 'Twister')::BIGINT AS cnt_twister
            FROM (
                SELECT
                    "Player code" AS join_pc,
                    TRIM(COALESCE("Tournament type", '')) AS tt,
                    TRIM(COALESCE("Tournament code"::TEXT, '')) AS tc
                FROM "Primary_SNG_Twister_and_MTT"
                WHERE "Player code" IN (SELECT pc FROM SearchCodes)
            ) d
            GROUP BY d.join_pc
        ),
        MttWinAgg AS (
            SELECT
                s.join_pc,
                COUNT(*) FILTER (WHERE s.net > 0)::BIGINT AS mtt_profitable,
                COUNT(*)::BIGINT AS mtt_tournament_count
            FROM (
                SELECT
                    "Player code" AS join_pc,
                    SUM(
                        COALESCE("Total win", 0) - COALESCE("Buy-ins", 0) - COALESCE("Fees", 0)
                        - COALESCE("Jackpot fees", 0)
                    ) AS net
                FROM "Primary_SNG_Twister_and_MTT"
                WHERE "Player code" IN (SELECT pc FROM SearchCodes)
                  AND TRIM(COALESCE("Tournament type", '')) = 'MTT'
                  AND TRIM(COALESCE("Tournament code"::TEXT, '')) <> ''
                GROUP BY "Player code", TRIM("Tournament code"::TEXT)
            ) s
            GROUP BY s.join_pc
        ),
        TwisterWinAgg AS (
            SELECT
                w.join_pc,
                COUNT(*) FILTER (WHERE w.row_profit > 0)::BIGINT AS twister_profitable,
                COUNT(*)::BIGINT AS twister_tournament_count
            FROM (
                SELECT
                    "Player code" AS join_pc,
                    (
                        COALESCE("Total win", 0)::DOUBLE PRECISION
                        - COALESCE("Buy-ins", 0)::DOUBLE PRECISION
                        - COALESCE("Fees", 0)::DOUBLE PRECISION
                        - COALESCE("Jackpot fees", 0)::DOUBLE PRECISION
                    ) AS row_profit
                FROM "Primary_SNG_Twister_and_MTT"
                WHERE "Player code" IN (SELECT pc FROM SearchCodes)
                  AND TRIM(COALESCE("Tournament type", '')) = 'Twister'
            ) w
            GROUP BY w.join_pc
        ),
        CashHud AS (
            SELECT
                "Player code" AS join_pc,
                AVG("VPIP") AS hud_vpip,
                AVG("PFR") AS hud_pfr,
                AVG("3-bet") AS hud_three_bet
            FROM "Primary_Cash_Games_Player_Stats"
            WHERE "Player code" IN (SELECT pc FROM SearchCodes)
            GROUP BY "Player code"
        ),
        LoginAgg AS (
            SELECT
                "Player Code" AS join_pc,
                COUNT(*) AS login_rows,
                COUNT(DISTINCT "IP") AS login_distinct_ips,
                COUNT(DISTINCT "Serial") AS login_distinct_serials
            FROM "Primary_Login_activity_by_player"
            WHERE "Player Code" IN (SELECT pc FROM SearchCodes)
            GROUP BY "Player Code"
        )
        SELECT
            sc.pc AS player_key,
            a.acc_nickname,
            a.acc_username,
            a.acc_country,
            a.acc_signup,
            a.acc_signup_ip,
            a.acc_signup_serial,
            a.acc_frozen,
            a.acc_cardroom,
            a.join_pc AS acc_present_pc,
            a.acc_lifetime_rake_raw,
            a.acc_lifetime_fee_raw,
            COALESCE(a.acc_lifetime_rake_raw, 0)::DOUBLE PRECISION AS acc_lifetime_rake,
            COALESCE(a.acc_lifetime_fee_raw, 0)::DOUBLE PRECISION AS acc_lifetime_fee,
            mix.m_country,
            mix.m_signup,
            mix.m_frozen,
            mix.m_lifetime_rake,
            lfa.login_first_ip,
            lfa.login_first_serial,
            lfa.login_first_casino,
            tda.t_vip,
            tda.t_casino,
            tda.t_country,
            COALESCE(c.cash_hands, 0)::BIGINT AS cash_hands,
            COALESCE(c.cash_hands_won, 0)::BIGINT AS cash_hands_won,
            COALESCE(c.cash_profit, 0)::DOUBLE PRECISION AS cash_profit,
            COALESCE(c.cash_bets, 0)::DOUBLE PRECISION AS cash_bets,
            COALESCE(c.cash_return, 0)::DOUBLE PRECISION AS cash_return,
            COALESCE(c.cash_rake_generated, 0)::DOUBLE PRECISION AS cash_rake_generated,
            CASE
                WHEN COALESCE(c.cash_bets, 0) > 0 THEN (COALESCE(c.cash_profit, 0) / c.cash_bets) * 100.0
                ELSE 0.0
            END AS cash_margin_pct,
            CASE
                WHEN COALESCE(c.cash_bets, 0) > 0 THEN (COALESCE(c.cash_return, 0) / c.cash_bets) * 100.0
                ELSE 0.0
            END AS cash_payout_pct,
            CASE
                WHEN COALESCE(c.cash_hands, 0) > 0 THEN
                    (COALESCE(c.cash_hands_won, 0)::NUMERIC / c.cash_hands::NUMERIC) * 100.0
                ELSE 0.0
            END AS cash_win_pct,
            COALESCE(tg.tourney_net_all, 0)::DOUBLE PRECISION AS tourney_net_all,
            COALESCE(tg.mtt_net, 0)::DOUBLE PRECISION AS mtt_net,
            COALESCE(tg.twister_net, 0)::DOUBLE PRECISION AS twister_net,
            COALESCE(tg.mtt_buy_fees, 0)::DOUBLE PRECISION AS mtt_buy_fees,
            COALESCE(tg.twister_buy_fees, 0)::DOUBLE PRECISION AS twister_buy_fees,
            COALESCE(tg.mtt_total_win, 0)::DOUBLE PRECISION AS mtt_total_win,
            COALESCE(tg.twister_total_win, 0)::DOUBLE PRECISION AS twister_total_win,
            COALESCE(tg.all_buy_fees, 0)::DOUBLE PRECISION AS all_buy_fees,
            COALESCE(tg.sum_tourney_entry_fees, 0)::DOUBLE PRECISION AS sum_tourney_entry_fees,
            CASE
                WHEN COALESCE(tg.mtt_buy_fees, 0) > 0 THEN (COALESCE(tg.mtt_net, 0) / tg.mtt_buy_fees) * 100.0
                ELSE 0.0
            END AS mtt_roi_pct,
            COALESCE(td.cnt_mtt_sng, 0)::BIGINT AS cnt_mtt_sng,
            COALESCE(td.cnt_twister, 0)::BIGINT AS cnt_twister,
            COALESCE(mw.mtt_profitable, 0)::BIGINT AS mtt_profitable,
            COALESCE(mw.mtt_tournament_count, 0)::BIGINT AS mtt_tournament_count,
            CASE
                WHEN COALESCE(mw.mtt_tournament_count, 0) > 0 THEN
                    (COALESCE(mw.mtt_profitable, 0)::NUMERIC / mw.mtt_tournament_count::NUMERIC) * 100.0
                ELSE 0.0
            END AS mtt_win_pct,
            CASE
                WHEN COALESCE(tww.twister_tournament_count, 0) > 0 THEN
                    (COALESCE(tww.twister_profitable, 0)::NUMERIC / tww.twister_tournament_count::NUMERIC) * 100.0
                ELSE 0.0
            END AS twister_win_pct,
            COALESCE(m.ipoker_ban_hits, 0)::BIGINT AS ipoker_ban_hits,
            COALESCE(m.profitable_major_sessions, 0)::BIGINT AS profitable_major_sessions,
            COALESCE(m.total_major_sessions, 0)::BIGINT AS total_major_sessions,
            CASE
                WHEN (COALESCE(m.total_major_sessions, 0) + COALESCE(mw.mtt_tournament_count, 0)) > 0 THEN
                    (
                        (COALESCE(m.profitable_major_sessions, 0) + COALESCE(mw.mtt_profitable, 0))::NUMERIC
                        / (COALESCE(m.total_major_sessions, 0) + COALESCE(mw.mtt_tournament_count, 0))::NUMERIC
                    ) * 100.0
                ELSE 0.0
            END AS global_win_ratio_pct,
            CASE
                WHEN (COALESCE(c.cash_bets, 0) + COALESCE(tg.all_buy_fees, 0)) > 0 THEN
                    (
                        (COALESCE(c.cash_profit, 0) + COALESCE(tg.tourney_net_all, 0))
                        / (COALESCE(c.cash_bets, 0) + COALESCE(tg.all_buy_fees, 0))
                    ) * 100.0
                ELSE 0.0
            END AS global_roi_pct,
            COALESCE(h.hud_vpip, 0)::DOUBLE PRECISION AS hud_vpip,
            COALESCE(h.hud_pfr, 0)::DOUBLE PRECISION AS hud_pfr,
            COALESCE(h.hud_three_bet, 0)::DOUBLE PRECISION AS hud_three_bet,
            COALESCE(lg.login_rows, 0)::BIGINT AS login_rows,
            COALESCE(lg.login_distinct_ips, 0)::BIGINT AS login_distinct_ips,
            COALESCE(lg.login_distinct_serials, 0)::BIGINT AS login_distinct_serials
        FROM SearchCodes sc
        LEFT JOIN AccountAgg a ON sc.pc = a.join_pc
        LEFT JOIN CashAgg c ON sc.pc = c.join_pc
        LEFT JOIN MajorAgg m ON sc.pc = m.join_pc
        LEFT JOIN TourneyAgg tg ON sc.pc = tg.join_pc
        LEFT JOIN TourneyDist td ON sc.pc = td.join_pc
        LEFT JOIN MttWinAgg mw ON sc.pc = mw.join_pc
        LEFT JOIN TwisterWinAgg tww ON sc.pc = tww.join_pc
        LEFT JOIN CashHud h ON sc.pc = h.join_pc
        LEFT JOIN LoginAgg lg ON sc.pc = lg.join_pc
        LEFT JOIN MajorIdentityAgg mix ON sc.pc = mix.join_pc
        LEFT JOIN LoginFirstAgg lfa ON sc.pc = lfa.join_pc
        LEFT JOIN TourneyDisplayAgg tda ON sc.pc = tda.join_pc
        """
    )

    with engine.connect() as conn:
        rows = conn.execute(sql, {"codes": codes}).mappings().fetchall()

    def _coalesce_str(*parts: object) -> str:
        for p in parts:
            if p is None:
                continue
            s = str(p).strip()
            if s:
                return s
        return ""

    for row in rows:
        pk = row.get("player_key")
        if pk is None:
            continue
        key = str(int(pk))
        nick_acc = str(row.get("acc_nickname") or "").strip()
        targets = list(by_pc.get(key) or [])
        if not targets and nick_acc:
            targets = [c for c in cases_dict.values() if (c.nickname or "").strip() == nick_acc]
        if not targets:
            continue

        cash_hands = int(row.get("cash_hands") or 0)
        cash_profit = float(row.get("cash_profit") or 0.0)
        tourney_net = float(row.get("tourney_net_all") or 0.0)
        mtt_net = float(row.get("mtt_net") or 0.0)
        twister_net = float(row.get("twister_net") or 0.0)
        total_profit = cash_profit + tourney_net

        has_account = row.get("acc_present_pc") is not None
        major_lr = float(row.get("m_lifetime_rake") or 0.0)
        acc_rake_raw = float(row.get("acc_lifetime_rake_raw") or 0.0)
        cash_rake_gen = float(row.get("cash_rake_generated") or 0.0)
        # Triage display: when account rake is missing/zero, use max of warehouse proxies (cash rake + major + account).
        display_lr = max(acc_rake_raw, major_lr, cash_rake_gen)
        acc_fee_raw = float(row.get("acc_lifetime_fee_raw") or 0.0) if has_account else 0.0
        sum_tourney_fees = float(row.get("sum_tourney_entry_fees") or 0.0)
        # Fee: prefer account Lifetime Fee; else sum of tournament entry fees from SNG/MTT/Twister table.
        display_fee = acc_fee_raw if acc_fee_raw > 0 else sum_tourney_fees
        acc_lr = display_lr
        acc_fee = display_fee
        global_roi = float(row.get("global_roi_pct") or 0.0)
        cash_margin_pct = float(row.get("cash_margin_pct") or 0.0)
        cash_win_pct = float(row.get("cash_win_pct") or 0.0)
        mtt_win_pct = float(row.get("mtt_win_pct") or 0.0)
        twister_win_pct = float(row.get("twister_win_pct") or 0.0)
        mtt_total_win = float(row.get("mtt_total_win") or 0.0)
        twister_total_win = float(row.get("twister_total_win") or 0.0)
        mtt_buy_fees_row = max(
            float(row.get("mtt_buy_fees") or 0.0),
            max(0.0, mtt_total_win - mtt_net),
        )
        twister_buy_fees = max(
            float(row.get("twister_buy_fees") or 0.0),
            max(0.0, twister_total_win - twister_net),
        )
        gwr = float(row.get("global_win_ratio_pct") or 0.0)
        cnt_mtt_sng = int(row.get("cnt_mtt_sng") or 0)
        cnt_twister = int(row.get("cnt_twister") or 0)
        # Activity volume for triage: cash hands plus distinct SNG/MTT/Twister entries (MTT-only players were showing 0).
        combined_activity_hands = cash_hands + cnt_mtt_sng + cnt_twister

        for pc in targets:
            if not pc.network_data:
                pc.network_data = {}

            pc.network_data["core_username"] = str(row.get("acc_username") or "").strip() or "—"
            pc.network_data["core_player_code"] = key
            pc.network_data["core_country"] = (
                _coalesce_str(row.get("acc_country"), row.get("m_country"), row.get("t_country")) or "—"
            )
            pc.network_data["core_signup"] = _coalesce_str(row.get("acc_signup"), row.get("m_signup")) or "—"
            sip = _coalesce_str(row.get("acc_signup_ip"), row.get("login_first_ip"))
            pc.network_data["signup_ip"] = sip or "—"
            sser = _coalesce_str(row.get("acc_signup_serial"), row.get("login_first_serial"))
            pc.network_data["signup_serial"] = sser or "—"
            pc.network_data["core_frozen"] = _coalesce_str(row.get("acc_frozen"), row.get("m_frozen")) or "—"
            cr = _coalesce_str(row.get("acc_cardroom"), row.get("t_casino"), row.get("login_first_casino"))
            pc.network_data["core_cardroom"] = cr or "—"
            tv = str(row.get("t_vip") or "").strip()
            if tv:
                pc.network_data["core_vip"] = tv
            pc.network_data["account_lifetime_rake"] = acc_lr
            pc.network_data["account_lifetime_fee"] = acc_fee
            pc.network_data["cash_profit"] = cash_profit
            pc.network_data["mtt_profit"] = mtt_net
            pc.network_data["twister_profit"] = twister_net
            pc.network_data["cash_rake_generated"] = float(row.get("cash_rake_generated") or 0.0)
            pc.network_data["mtt_net_profit"] = mtt_net
            pc.network_data["ipoker_collusion_yes_count"] = int(row.get("ipoker_ban_hits") or 0)
            pc.network_data["ls_total_logins"] = int(row.get("login_rows") or 0)
            pc.network_data["ls_unique_ips"] = int(row.get("login_distinct_ips") or 0)
            pc.network_data["ls_unique_serials"] = int(row.get("login_distinct_serials") or 0)
            pc.network_data["total_hands_played"] = combined_activity_hands
            pc.network_data["cash_hands_only"] = cash_hands
            pc.network_data["tournaments_mtt_sng"] = cnt_mtt_sng
            pc.network_data["twisters_played"] = cnt_twister
            pc.network_data["twister_win_pct"] = twister_win_pct
            pc.network_data["total_twister_buyin"] = twister_buy_fees
            pc.network_data["total_mtt_buyin"] = mtt_buy_fees_row
            pc.network_data["total_profit_loss"] = total_profit
            pc.network_data["blended_roi_pct"] = global_roi

            pc.player_code = key
            if nick_acc:
                pc.nickname = nick_acc

            pc.net_profit = total_profit
            # Persist cash-only margin for triage/case list (Σ P/L ÷ Σ Total bets × 100 from cash sessions).
            pc.roi = cash_margin_pct
            pc.win_rate = cash_win_pct
            pc.win_rate_cash = cash_win_pct
            pc.win_rate_mtt = mtt_win_pct
            pc.global_win_ratio = gwr
            pc.total_hands = combined_activity_hands
            pc.total_tournaments = cnt_mtt_sng
            pc.lifetime_rake = acc_lr
            pc.lifetime_total_fees = acc_fee
            pc.vpip = float(row.get("hud_vpip") or 0.0)
            pc.pfr = float(row.get("hud_pfr") or 0.0)
            pc.three_bet = float(row.get("hud_three_bet") or 0.0)





def run_analysis(
    connection_string: str,
    settings: Optional[Dict[str, object]] = None,
    persist_after_each_rule: bool = True,
) -> List[Dict[str, object]]:
    if not connection_string:
        raise ValueError("connection_string is required")

    scan_start = time.time()
    tqdm.write(f"[Fraud Engine] Source DB: {mask_connection_url(connection_string)}")

    settings = dict(settings or {})
    ct_val = settings.get("caseTriggerScore")
    case_trigger = float(ct_val if ct_val is not None else 100.0)
    engine = get_db_engine(connection_string)
    try:
        with engine.connect() as probe_conn:
            probe_conn.execute(text("SELECT 1"))
    except Exception as exc:
        tqdm.write(f"[Fraud Engine] Source DB connection failed: {exc}")
        raise
    tqdm.write("[Fraud Engine] Source DB: connected (probe OK).")

    prebuilt = settings.get("rules")
    if isinstance(prebuilt, list) and len(prebuilt) > 0:
        merge_fraud_configs_into_settings_core(prebuilt, settings)
        log.info("Using %d merged rule preset(s) from caller settings.", len(prebuilt))
    else:
        try:
            from backend_v2.engine.fraud_rule_db_loader import load_merged_fraud_rule_configs_for_engine

            merged_rules = load_merged_fraud_rule_configs_for_engine()
            if merged_rules:
                merge_fraud_configs_into_settings_core(merged_rules, settings)
                log.info("Loaded fraud_rule_config row(s) from case-management DB.")
                tqdm.write(
                    f"[Fraud Engine] Loaded {len(merged_rules)} fraud_rule_config row(s) from case-management DB."
                )
            else:
                merge_fraud_configs_into_settings_core(get_default_configs(), settings)
                tqdm.write("[Fraud Engine] No fraud_rule_configs in case DB; using Python schema defaults.")
        except Exception as e:
            log.error("Could not load fraud_rule_configs from case-management DB: %s", e)
            tqdm.write(f"[Fraud Engine] Case DB fraud_rule_configs load failed: {e}; using schema defaults.")
            merge_fraud_configs_into_settings_core(get_default_configs(), settings)

    cases_dict: Dict[str, PlayerCase] = {}
    player_totals: Dict[str, Dict[str, object]] = {}
    excluded_this_run: set = set()

    def _persist(rule_id: str) -> None:
        if persist_after_each_rule and cases_dict:
            _finalize_cases(cases_dict.values(), settings)
            rejected_no_reason = 0
            to_save: List[Dict[str, object]] = []
            for c in cases_dict.values():
                if not (c.reason and str(c.reason).strip()):
                    rejected_no_reason += 1
                    continue
                to_save.append(c.to_dict())
            if to_save:
                upsert_cases(to_save, rule_id=rule_id)
            tqdm.write(
                f"[PERSIST] rule {rule_id}: upserted {len(to_save)} | skipped (no reason): {rejected_no_reason}"
            )

    tqdm.write("[SYSTEM] Fraud Engine initializing (Rules 1–5)…")
    scan_total = _count_scan_phases(settings)
    scan_phase_idx = 0

    def _step(_step_num: int, label: str) -> float:
        nonlocal scan_phase_idx
        scan_phase_idx += 1
        elapsed = time.time() - scan_start
        rate = elapsed / max(scan_phase_idx, 1)
        eta_sec = max(0.0, (scan_total - scan_phase_idx) * rate)
        bar = _ascii_scan_bar(scan_phase_idx / max(scan_total, 1))
        pct = int(round(100.0 * scan_phase_idx / max(scan_total, 1)))
        eta_str = _format_eta_for_scan(eta_sec)
        tqdm.write(
            f"[SCANNING] {scan_phase_idx}/{scan_total} |{bar}| {pct:3d}% | ETA {eta_str} | {label}"
        )
        return time.time()

    if _is_rule_active(settings, [1]):
        _step(1, "Rule 1: Burner / New Pro")
        try:
            _evaluate_rule1_burner(engine, settings, cases_dict, player_totals)
            _persist("1")
        except Exception as e:
            _scan_rule_fail("Rule 1", str(e))
            import traceback
            traceback.print_exc()
        else:
            ts = datetime.now().strftime("%H:%M:%S")
            n_cases = len(cases_dict)
            r1_hits = _count_cases_for_rule(cases_dict, ["Rule 1 [Cash]"])
            at_trigger = sum(1 for c in cases_dict.values() if c.risk_score >= case_trigger)
            tqdm.write(
                f"[{ts}] Rule 1 done — {r1_hits} burner hit(s), {n_cases} case(s), "
                f"{at_trigger} at/above score trigger ({case_trigger:g})."
            )

    if _is_rule_active(settings, [2]):
        _step(1, "Rule 2: Major income % Win spike")
        try:
            _evaluate_rule2_major_income(engine, settings, cases_dict, player_totals)
            _persist("2")
        except Exception as e:
            _scan_rule_fail("Rule 2", str(e))
            import traceback

            traceback.print_exc()
        else:
            ts = datetime.now().strftime("%H:%M:%S")
            n_cases = len(cases_dict)
            r2_hits = _count_cases_for_rule(cases_dict, ["Rule 2 [Major]"])
            at_trigger = sum(1 for c in cases_dict.values() if c.risk_score >= case_trigger)
            tqdm.write(
                f"[{ts}] Rule 2 done — {r2_hits} major-income hit(s), {n_cases} case(s), "
                f"{at_trigger} at/above score trigger ({case_trigger:g})."
            )

    if _is_rule_active(settings, [3]):
        _step(1, "Rule 3: Twister common games overlap")
        try:
            _evaluate_rule3_twister_common(engine, settings, cases_dict, player_totals)
            _persist("3")
        except Exception as e:
            _scan_rule_fail("Rule 3", str(e))
            import traceback

            traceback.print_exc()
        else:
            ts = datetime.now().strftime("%H:%M:%S")
            n_cases = len(cases_dict)
            r3_hits = _count_cases_for_rule(cases_dict, ["Rule 3 [Twister Common]"])
            at_trigger = sum(1 for c in cases_dict.values() if c.risk_score >= case_trigger)
            tqdm.write(
                f"[{ts}] Rule 3 done — {r3_hits} Twister overlap hit(s), {n_cases} case(s), "
                f"{at_trigger} at/above score trigger ({case_trigger:g})."
            )

    if _is_rule_active(settings, [4]):
        _step(1, "Rule 4: MTT common games overlap")
        try:
            _evaluate_rule4_mtt_common(engine, settings, cases_dict, player_totals)
            _persist("4")
        except Exception as e:
            _scan_rule_fail("Rule 4", str(e))
            import traceback

            traceback.print_exc()
        else:
            ts = datetime.now().strftime("%H:%M:%S")
            n_cases = len(cases_dict)
            r4_hits = _count_cases_for_rule(cases_dict, ["Rule 4 [MTT Common]"])
            at_trigger = sum(1 for c in cases_dict.values() if c.risk_score >= case_trigger)
            tqdm.write(
                f"[{ts}] Rule 4 done — {r4_hits} MTT overlap hit(s), {n_cases} case(s), "
                f"{at_trigger} at/above score trigger ({case_trigger:g})."
            )

    if _is_rule_active(settings, [5]):
        _step(1, "Rule 5: SNG common games overlap")
        try:
            _evaluate_rule5_sng_common(engine, settings, cases_dict, player_totals)
            _persist("5")
        except Exception as e:
            _scan_rule_fail("Rule 5", str(e))
            import traceback

            traceback.print_exc()
        else:
            ts = datetime.now().strftime("%H:%M:%S")
            n_cases = len(cases_dict)
            r5_hits = _count_cases_for_rule(cases_dict, ["Rule 5 [SNG Common]"])
            at_trigger = sum(1 for c in cases_dict.values() if c.risk_score >= case_trigger)
            tqdm.write(
                f"[{ts}] Rule 5 done — {r5_hits} SNG overlap hit(s), {n_cases} case(s), "
                f"{at_trigger} at/above score trigger ({case_trigger:g})."
            )

    _finalize_cases(list(cases_dict.values()), settings)

    try:
        _bulk_update_unified_profile(cases_dict, engine)
    except Exception as e:
        log.error("Bulk unified profile failed: %s", e)

    filtered_cases = [c for c in cases_dict.values() if c.reason and str(c.reason).strip()]
    filtered = [c.to_dict() for c in filtered_cases]

    rej_no_reason_final = sum(1 for c in cases_dict.values() if not (c.reason and str(c.reason).strip()))
    tqdm.write(
        f"[PERSIST] final export: {len(filtered_cases)} case(s) | skipped (no reason): {rej_no_reason_final}"
    )

    if excluded_this_run:
        archive_cases_for_excluded(excluded_this_run)

    total_sec = time.time() - scan_start
    most_active = (
        Counter(c.get("category", "General") for c in filtered).most_common(1)[0][0]
        if filtered
        else "—"
    )
    _print_verdict_box(total_sec, len(filtered), most_active)
    _print_sniper_summary(filtered)

    return filtered


def archive_cases_for_excluded(player_codes: set) -> int:
    if not player_codes:
        return 0
    engine = get_case_engine()
    codes = [str(p).strip().rstrip(".0") for p in player_codes if p]
    if not codes:
        return 0
    with Session(engine) as session:
        stmt = text(
            """
            UPDATE investigation_cases
            SET status = 'Closed - Filtered', updated_at = NOW()
            WHERE player_code IN :codes
            """
        ).bindparams(bindparam("codes", expanding=True))
        result = session.execute(stmt, {"codes": codes})
        session.commit()
        count = result.rowcount if hasattr(result, "rowcount") else 0
    if count:
        print(f"[Fraud Engine] Archived {count} case(s) as Closed - Filtered (excluded by new settings).")
    return count


def _coerce_for_json_column(obj: object) -> object:
    if obj is None:
        return None
    if isinstance(obj, bool):
        return obj
    if isinstance(obj, (int, float)) and not isinstance(obj, bool):
        return obj
    if isinstance(obj, str):
        return obj
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    if isinstance(obj, dict):
        return {str(k): _coerce_for_json_column(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_coerce_for_json_column(v) for v in obj]
    try:
        if hasattr(obj, "item") and callable(getattr(obj, "item", None)):
            return _coerce_for_json_column(obj.item())
    except Exception:
        pass
    return str(obj)


_UPSERT_COMMIT_EVERY = 150


def upsert_cases(
    cases: List[Dict[str, object]],
    rule_id: Optional[str] = None,
) -> int:
    if not cases:
        return 0

    engine = get_case_engine()
    try:
        CaseManagementBase.metadata.create_all(engine)
    except Exception:
        pass
    from sqlalchemy.dialects.postgresql import insert

    saved = 0
    pending_commit = 0

    def _bump_commit(sess: Session) -> None:
        nonlocal pending_commit
        pending_commit += 1
        if pending_commit >= _UPSERT_COMMIT_EVERY:
            sess.commit()
            pending_commit = 0

    with Session(engine) as session:
        for case in cases:
            pcode = str(case.get("player_code", "")).strip()
            if pcode.endswith(".0"):
                pcode = pcode[:-2]
            pcode = pcode.strip()
            if not pcode:
                continue
            saved += 1

            nick = str(case.get("nickname", "")).strip() or pcode
            risk = float(case.get("risk_score", 0))
            scenarios = (case.get("reason") or case.get("triggered_scenarios") or "").strip() or ""
            category = normalize_category(str(case.get("category", "") or "General"))
            tag = str(case.get("tag", "") or "").strip()

            nd_coerced = _coerce_for_json_column(case.get("network_data") or {})
            network_data: Dict[str, Any] = nd_coerced if isinstance(nd_coerced, dict) else {}
            ss_coerced = _coerce_for_json_column(case.get("suspicious_sessions") or [])
            suspicious_sessions: List[Any] = ss_coerced if isinstance(ss_coerced, list) else []

            existing_case = session.query(InvestigationCase).filter(
                InvestigationCase.player_nickname == nick,
                InvestigationCase.status == "Open",
            ).first()

            if existing_case:
                existing_text = (existing_case.triggered_scenarios or "").strip()
                new_text = scenarios.strip()
                chunks: List[str] = []
                for txt in (existing_text, new_text):
                    if not txt:
                        continue
                    for part in txt.split("\n\n"):
                        part = part.strip()
                        if part:
                            chunks.append(part)
                deduped = list(dict.fromkeys(chunks))
                combined = "\n\n".join(deduped).strip()
                existing_case.triggered_scenarios = combined or existing_case.triggered_scenarios or ""
                existing_case.updated_at = datetime.now(timezone.utc)
                existing_case.risk_score = risk
                existing_case.net_profit = float(case.get("net_profit", 0.0))
                existing_case.roi = float(case.get("roi", 0.0))
                existing_case.win_rate = float(case.get("win_rate", 0.0))
                existing_case.win_rate_cash = float(case.get("win_rate_cash", 0.0))
                existing_case.win_rate_mtt = float(case.get("win_rate_mtt", 0.0))
                existing_case.global_win_ratio = float(case.get("global_win_ratio", 0.0))
                existing_case.total_hands = int(case.get("total_hands", 0))
                existing_case.total_tournaments = int(case.get("total_tournaments", 0))
                existing_case.lifetime_rake = float(case.get("lifetime_rake", 0.0))
                existing_case.lifetime_total_fees = float(case.get("lifetime_total_fees", 0.0))
                existing_case.vpip = float(case.get("vpip", 0.0))
                existing_case.pfr = float(case.get("pfr", 0.0))
                existing_case.three_bet = float(case.get("three_bet", 0.0))
                existing_case.top_partners = str(case.get("top_partners", "") or "")
                existing_case.network_data = network_data or (existing_case.network_data or {})
                existing_case.suspicious_sessions = suspicious_sessions or (
                    existing_case.suspicious_sessions or []
                )
                existing_case.category = category
                existing_case.tag = tag if tag else existing_case.tag
                _bump_commit(session)
                continue

            stmt = insert(InvestigationCase).values(
                player_code=pcode,
                player_nickname=nick,
                risk_score=risk,
                triggered_scenarios=scenarios,
                status=case.get("status", "Open"),
                net_profit=float(case.get("net_profit", 0.0)),
                roi=float(case.get("roi", 0.0)),
                win_rate=float(case.get("win_rate", 0.0)),
                win_rate_cash=float(case.get("win_rate_cash", 0.0)),
                win_rate_mtt=float(case.get("win_rate_mtt", 0.0)),
                global_win_ratio=float(case.get("global_win_ratio", 0.0)),
                total_hands=int(case.get("total_hands", 0)),
                total_tournaments=int(case.get("total_tournaments", 0)),
                lifetime_rake=float(case.get("lifetime_rake", 0.0)),
                lifetime_total_fees=float(case.get("lifetime_total_fees", 0.0)),
                vpip=float(case.get("vpip", 0.0)),
                pfr=float(case.get("pfr", 0.0)),
                three_bet=float(case.get("three_bet", 0.0)),
                top_partners=str(case.get("top_partners", "") or ""),
                network_data=network_data,
                suspicious_sessions=suspicious_sessions,
                category=category,
                tag=tag if tag else None,
            )
            stmt = stmt.on_conflict_do_update(
                index_elements=["player_code"],
                set_={
                    "risk_score": stmt.excluded.risk_score,
                    "triggered_scenarios": stmt.excluded.triggered_scenarios,
                    "player_nickname": stmt.excluded.player_nickname,
                    "updated_at": text("NOW()"),
                    "net_profit": stmt.excluded.net_profit,
                    "roi": stmt.excluded.roi,
                    "win_rate": stmt.excluded.win_rate,
                    "win_rate_cash": stmt.excluded.win_rate_cash,
                    "win_rate_mtt": stmt.excluded.win_rate_mtt,
                    "global_win_ratio": stmt.excluded.global_win_ratio,
                    "total_hands": stmt.excluded.total_hands,
                    "total_tournaments": stmt.excluded.total_tournaments,
                    "lifetime_rake": stmt.excluded.lifetime_rake,
                    "lifetime_total_fees": stmt.excluded.lifetime_total_fees,
                    "vpip": stmt.excluded.vpip,
                    "pfr": stmt.excluded.pfr,
                    "three_bet": stmt.excluded.three_bet,
                    "top_partners": stmt.excluded.top_partners,
                    "network_data": stmt.excluded.network_data,
                    "suspicious_sessions": stmt.excluded.suspicious_sessions,
                    "category": stmt.excluded.category,
                    "tag": stmt.excluded.tag,
                },
            )
            session.execute(stmt)
            _bump_commit(session)
        if pending_commit:
            session.commit()
    return saved


__all__ = [
    "run_analysis",
    "PlayerCase",
    "upsert_cases",
    "resolve_player_code_from_nickname",
    "resolve_display_nickname_from_primary",
    "build_nickname_to_player_code_map",
]
