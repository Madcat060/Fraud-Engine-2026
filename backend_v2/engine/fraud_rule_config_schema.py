"""
Fraud Rule Configuration schema: rules 1–5 (cash margin; major-income ``% Win`` spike;
Twister / MTT / SNG common-tournament overlap) with category, description templates, and defaults.

Canonical **exclusions** use :class:`RuleExclusions` in
:data:`DEFAULT_RULE_EXCLUSIONS_BY_RULE_ID`. When persisting from the API,
**parameters** and rule flags merge onto the current DB row; **exclusions** are
**replaced** when the client sends an ``exclusions`` object.
"""

from __future__ import annotations

import copy
from typing import Optional

from pydantic import BaseModel, ConfigDict

# ---------------------------------------------------------------------------
# Canonical exclusions (Pydantic) — single source for defaults + DB seeders.
# Serialized to API/engine JSON via :func:`rule_exclusions_to_legacy_json`.
# ---------------------------------------------------------------------------


class RuleExclusions(BaseModel):
    """Advanced exclusion / noise-filter fields for a single fraud rule."""

    model_config = ConfigDict(extra="forbid", validate_assignment=True)

    # Preferred lifetime / volume floors (serialized verbatim to API + engine JSON).
    min_lifetime_hands: float | int | None = None
    min_lifetime_tournaments: int | None = None
    min_lifetime_net_profit: float | None = None
    min_lifetime_roi_pct: float | None = None

    ignore_micro_sessions_min_hands: float | int | None = None
    net_profit_from: float | None = None
    net_profit_to: float | None = None
    global_roi_from: float | None = None
    global_roi_to: float | None = None
    bb_from: float | None = None
    bb_to: float | None = None
    hours_from: float | None = None
    hours_to: float | None = None
    lifetime_rake_from: float | None = None
    lifetime_rake_to: float | None = None
    multiplier_from: float | None = None
    multiplier_to: float | None = None
    total_hands_from: int | None = None
    total_hands_to: int | None = None


DEFAULT_RULE_EXCLUSIONS_BY_RULE_ID: dict[int, RuleExclusions] = {
    1: RuleExclusions(),
    2: RuleExclusions(),
    3: RuleExclusions(),
    4: RuleExclusions(),
    5: RuleExclusions(),
}

# Plain dict view (Pydantic field names only; omit keys that are None).
DEFAULT_RULE_EXCLUSIONS_AS_DICTS: dict[int, dict] = {
    rid: ex.model_dump(exclude_none=True) for rid, ex in DEFAULT_RULE_EXCLUSIONS_BY_RULE_ID.items()
}


def get_default_rule_exclusions(rule_id: int) -> RuleExclusions:
    """Return the canonical default :class:`RuleExclusions` for ``rule_id``."""
    rid = int(rule_id)
    ex = DEFAULT_RULE_EXCLUSIONS_BY_RULE_ID.get(rid)
    if ex is None:
        return RuleExclusions()
    return ex.model_copy(deep=True)


def rule_exclusions_to_legacy_json(ex: RuleExclusions) -> dict:
    """
    Map :class:`RuleExclusions` to the JSON shape stored in ``fraud_rule_configs.exclusions``
    and consumed by the engine / UI (``min_hands``, ``roi_range``, ``profit_range``, etc.).

    * ``min_lifetime_hands`` / ``min_lifetime_tournaments`` / ``min_lifetime_net_profit`` /
      ``min_lifetime_roi_pct`` — passed through verbatim (preferred noise filters).
    * ``ignore_micro_sessions_min_hands`` → ``min_hands``
    * ``global_roi_*`` → ``roi_range``
    * ``net_profit_*`` → ``profit_range``
    * ``lifetime_rake_*`` → ``max_rake_to_flag`` (whale cap) when *from* < *to*, else ``rake_floor``
    * ``bb_*``, ``hours_*``, ``multiplier_*``, ``total_hands_*`` → ``*_range`` dicts
    """
    out: dict = {}

    if ex.min_lifetime_hands is not None:
        out["min_lifetime_hands"] = ex.min_lifetime_hands
    if ex.min_lifetime_tournaments is not None:
        out["min_lifetime_tournaments"] = int(ex.min_lifetime_tournaments)
    if ex.min_lifetime_net_profit is not None:
        out["min_lifetime_net_profit"] = ex.min_lifetime_net_profit
    if ex.min_lifetime_roi_pct is not None:
        out["min_lifetime_roi_pct"] = ex.min_lifetime_roi_pct

    if ex.ignore_micro_sessions_min_hands is not None:
        out["min_hands"] = ex.ignore_micro_sessions_min_hands

    roi: dict = {}
    if ex.global_roi_from is not None:
        roi["from"] = ex.global_roi_from
    if ex.global_roi_to is not None:
        roi["to"] = ex.global_roi_to
    if roi:
        out["roi_range"] = roi

    pr: dict = {}
    if ex.net_profit_from is not None:
        pr["from"] = ex.net_profit_from
    if ex.net_profit_to is not None:
        pr["to"] = ex.net_profit_to
    if pr:
        out["profit_range"] = pr

    lf, lt = ex.lifetime_rake_from, ex.lifetime_rake_to
    if lf is not None:
        try:
            if lt is not None and float(lt) > float(lf):
                # Matches UI: band From–To with To > From → engine whale cap (lifetime rake ceiling).
                out["max_rake_to_flag"] = float(lf)
            else:
                out["rake_floor"] = float(lf)
        except (TypeError, ValueError):
            out["rake_floor"] = lf

    br: dict = {}
    if ex.bb_from is not None:
        br["from"] = ex.bb_from
    if ex.bb_to is not None:
        br["to"] = ex.bb_to
    if br:
        out["bb_range"] = br

    hr: dict = {}
    if ex.hours_from is not None:
        hr["from"] = ex.hours_from
    if ex.hours_to is not None:
        hr["to"] = ex.hours_to
    if hr:
        out["hours_range"] = hr

    mr: dict = {}
    if ex.multiplier_from is not None:
        mr["from"] = ex.multiplier_from
    if ex.multiplier_to is not None:
        mr["to"] = ex.multiplier_to
    if mr:
        out["multiplier_range"] = mr

    thr: dict = {}
    if ex.total_hands_from is not None:
        thr["from"] = ex.total_hands_from
    if ex.total_hands_to is not None:
        thr["to"] = ex.total_hands_to
    if thr:
        out["total_hands_range"] = thr

    return out


def default_exclusions_dict_for_rule(rule_id: int, *, exclude_none: bool = True) -> dict:
    """
    Default exclusions as a plain dict (optional: strip nulls).
    Suitable for JSON APIs and seeders.
    """
    data = get_default_rule_exclusions(rule_id).model_dump(exclude_none=exclude_none)
    return data


def _sync_fraud_rules_meta_exclusions() -> None:
    """Apply :data:`DEFAULT_RULE_EXCLUSIONS_BY_RULE_ID` to each row in :data:`FRAUD_RULES_META`."""
    for meta in FRAUD_RULES_META:
        rid = int(meta["rule_id"])
        ex = DEFAULT_RULE_EXCLUSIONS_BY_RULE_ID.get(rid)
        meta["exclusions"] = rule_exclusions_to_legacy_json(ex) if ex is not None else {}


# Master categories — see fraud_engine.MASTER_CATEGORIES.
FRAUD_RULES_META = [
    {
        "rule_id": 1,
        "name": "Cash margin — new account",
        "category": "Chip Dumping",
        "description_template": "Flags when cash margin (Σ P/L ÷ Σ bets × 100 from cash sessions) ≥ {min_cash_margin_pct}% and Σ bets ≥ {min_cash_total_bets}.",
        "parameters": {
            "min_cash_margin_pct": 50.0,
            "min_cash_total_bets": 100.0,
        },
        "exclusions": {},
        "active": True,
        "weight": 35.0,
    },
    {
        "rule_id": 2,
        "name": "Major income — % Win spike (new account)",
        "category": "New Account High Win",
        "description_template": "Flags accounts ≤{major_max_age_days}d old when a Primary_Major_income_sessions row has \"% Win\" > {min_major_pct_win} and Win ≥ {min_major_session_win}.",
        "parameters": {
            "major_max_age_days": 2,
            "min_major_pct_win": 500.0,
            "min_major_session_win": 50.0,
        },
        "exclusions": {},
        "active": True,
        "weight": 35.0,
    },
    {
        "rule_id": 3,
        "name": "Common games — Twister overlap",
        "category": "Common Games",
        "description_template": (
            "Data source: Primary_SNG_Twister_and_MTT. Filter: Tournament type = Twister only. "
            "Logic: lifetime distinct tournament codes per player; count shared tournaments per pair; "
            "flag when shared count ≥ {min_common_tournaments} and both players’ overlap % "
            "(shared ÷ that player’s distinct tournaments in this format × 100) ≥ {min_overlap_pct}. "
            "Units: min_common_tournaments = integer count; min_overlap_pct = percent (e.g. 30.0 = 30%). "
            "Opening a case means this player’s Twister volume is concentrated vs the same partner(s) vs configured floors."
        ),
        "parameters": {
            "min_common_tournaments": 5,
            "min_overlap_pct": 30.0,
        },
        "exclusions": {},
        "active": True,
        "weight": 35.0,
    },
    {
        "rule_id": 4,
        "name": "Common games — MTT overlap",
        "category": "Common Games",
        "description_template": (
            "Data source: Primary_SNG_Twister_and_MTT. Filter: Tournament type = MTT only. "
            "Logic: lifetime distinct tournament codes per player; count shared tournaments per pair; "
            "flag when shared count ≥ {min_common_tournaments} and either player’s overlap % "
            "(shared ÷ that player’s distinct tournaments in this format × 100) ≥ {min_overlap_pct}. "
            "Units: min_common_tournaments = integer count; min_overlap_pct = percent (e.g. 30.0 = 30%). "
            "Opening a case means this player’s MTT volume is concentrated vs the same partner(s) vs configured floors."
        ),
        "parameters": {
            "min_common_tournaments": 5,
            "min_overlap_pct": 30.0,
        },
        "exclusions": {},
        "active": True,
        "weight": 35.0,
    },
    {
        "rule_id": 5,
        "name": "Common games — SNG overlap",
        "category": "Common Games",
        "description_template": (
            "Data source: Primary_SNG_Twister_and_MTT. Filter: Tournament type = SNG only. "
            "Logic: lifetime distinct tournament codes per player; count shared tournaments per pair; "
            "flag when shared count ≥ {min_common_tournaments} and either player’s overlap % "
            "(shared ÷ that player’s distinct tournaments in this format × 100) ≥ {min_overlap_pct}. "
            "Units: min_common_tournaments = integer count; min_overlap_pct = percent (e.g. 30.0 = 30%). "
            "Opening a case means this player’s SNG volume is concentrated vs the same partner(s) vs configured floors."
        ),
        "parameters": {
            "min_common_tournaments": 5,
            "min_overlap_pct": 30.0,
        },
        "exclusions": {},
        "active": True,
        "weight": 35.0,
    },
]


def get_meta_parameters(rule_id: int) -> dict:
    """Default parameters for a rule_id from FRAUD_RULES_META (single source for engine fallbacks)."""
    for meta in FRAUD_RULES_META:
        try:
            if int(meta.get("rule_id", -1)) == int(rule_id):
                return dict(meta.get("parameters") or {})
        except (TypeError, ValueError):
            continue
    return {}


def get_default_configs():
    """Return defaults used by /api/collusion/fraud-rule-configs."""
    defaults = []
    for meta in FRAUD_RULES_META:
        rid = int(meta.get("rule_id"))
        exclusions = dict(meta.get("exclusions") or {})

        defaults.append(
            {
                "rule_id": rid,
                "name": meta.get("name"),
                "category": meta.get("category", "General"),
                "description_template": meta.get("description_template", ""),
                "risk_level": "Medium",
                "weight": float(meta.get("weight", 50.0)),
                "parameters": dict(meta.get("parameters") or {}),
                "exclusions": exclusions,
                "active": bool(meta.get("active", True)),
                "is_active": bool(meta.get("active", True)),
            }
        )
    return defaults


def merge_saved_into_defaults(saved_list, base_list=None, *, schema_base: bool = True):
    """
    Merge partial ``saved_list`` onto a full config list (by rule_id).

    * ``base_list`` — starting point. If ``schema_base`` is True (default) and ``base_list`` is
      omitted, uses :func:`get_default_configs()`. If ``schema_base`` is False, ``base_list`` must be
      the current DB rows only: **no** schema defaults are mixed in before applying ``saved_list``,
      so saving the UI does not inject template parameters the user never set.
    * ``saved_list`` — incoming updates; ``parameters`` (when present) **replace** the base row’s
      parameters dict entirely; ``exclusions`` replace entirely when present.
    * New rule_ids not in ``base_list`` are seeded from :func:`get_default_configs()` for that id.

    Returns a list of configs (one per known rule_id), sorted by ``rule_id``.
    """
    if schema_base:
        src = base_list if base_list is not None else get_default_configs()
    else:
        src = list(base_list) if base_list else []
    by_id = {int(c["rule_id"]): copy.deepcopy(c) for c in src}
    if not saved_list:
        return [by_id[k] for k in sorted(by_id)]
    for s in saved_list:
        rid = s.get("rule_id")
        if rid is None:
            continue
        rid = int(rid)
        if rid not in by_id:
            tmpl = next(
                (copy.deepcopy(x) for x in get_default_configs() if int(x["rule_id"]) == rid),
                None,
            )
            if tmpl is None:
                continue
            by_id[rid] = tmpl
        base = by_id[rid]
        if "active" in s:
            base["active"] = bool(s["active"])
            base["is_active"] = bool(s["active"])
        if "is_active" in s:
            base["active"] = bool(s["is_active"])
            base["is_active"] = bool(s["is_active"])
        if "parameters" in s and isinstance(s["parameters"], dict):
            # Strict overwrite: DB / payload is the single source of truth. No key-by-key merging.
            base["parameters"] = copy.deepcopy(s["parameters"])
        if "risk_level" in s:
            base["risk_level"] = s["risk_level"]
        if "weight" in s and s["weight"] is not None:
            base["weight"] = float(s["weight"])
        if "exclusions" in s and isinstance(s["exclusions"], dict):
            # Full replacement: Fraud Rules UI is the only source for include/exclude noise filters.
            # (Merging into schema defaults caused cleared fields to keep old bands in the DB.)
            base["exclusions"] = copy.deepcopy(s["exclusions"])

    return [by_id[k] for k in sorted(by_id)]


def normalize_merged_exclusions(ex: Optional[dict]) -> dict:
    """
    Strip exclusion keys that are effectively unset so engine noise filters match the Fraud Rules UI.

    Call after building ``roi_range`` from ``global_roi_*`` so empty bands do not behave like filters.
    """
    out = dict(ex or {})
    rr = out.get("roi_range")
    if isinstance(rr, dict):
        rf, rt = rr.get("from"), rr.get("to")
        if rf is None and rt is None:
            out.pop("roi_range", None)
    pr = out.get("profit_range")
    if isinstance(pr, dict):
        pf, pt = pr.get("from"), pr.get("to")
        if pf is None and pt is None:
            out.pop("profit_range", None)
    thr = out.get("total_hands_range")
    if isinstance(thr, dict):
        tf, tt = thr.get("from"), thr.get("to")
        if tf is None and tt is None:
            out.pop("total_hands_range", None)
    wrr = out.get("win_rate_range")
    if isinstance(wrr, dict):
        wf, wt = wrr.get("from"), wrr.get("to")
        if wf is None and wt is None:
            out.pop("win_rate_range", None)
    if out.get("min_hands") is None:
        out.pop("min_hands", None)
    if out.get("rake_floor") is None:
        out.pop("rake_floor", None)
    if out.get("fee_floor") is None:
        out.pop("fee_floor", None)
    if out.get("max_rake_to_flag") is None:
        out.pop("max_rake_to_flag", None)
    rkr = out.get("rake_range")
    if isinstance(rkr, dict):
        rk_f, rk_t = rkr.get("from"), rkr.get("to")
        if rk_f is None and rk_t is None:
            out.pop("rake_range", None)
    return out


def meta_default_weight(rule_id: int) -> float:
    """Default weight from FRAUD_RULES_META for a rule_id (used when DB/UI omit weight)."""
    rid = int(rule_id)
    for d in get_default_configs():
        if int(d["rule_id"]) == rid:
            return float(d.get("weight", 50.0))
    return 50.0


def merge_fraud_configs_into_settings_core(configs: list, settings: dict) -> None:
    """
    Flatten merged fraud rule config dicts into ``settings`` for the engine.

    Populates ``rules``, ``rule_configs`` (per-rule weight/category/parameters/exclusions),
    ``rule_exclusions``, and ``rule{N}_active``. Per-rule parameters live only under ``rule_configs``;
    they are not copied onto the root ``settings`` dict.
    Does **not** apply v3_standards ``ruleN_active`` overlay — callers handle that separately.
    """
    settings["rules"] = list(configs or [])
    settings["rule_exclusions"] = {}
    settings["rule_configs"] = {}
    rule_weights = settings.get("ruleWeights") or {}
    default_categories = {d["rule_id"]: d["category"] for d in get_default_configs()}
    for c in configs or []:
        rid = c.get("rule_id")
        if rid is None:
            continue
        try:
            rid_int = int(rid)
        except Exception:
            continue
        key_active = f"rule{rid_int}_active"
        _act = c.get("is_active")
        if _act is None:
            _act = c.get("active", True)
        settings[key_active] = bool(_act)
        params = c.get("parameters") or {}
        exclusions = dict(c.get("exclusions") or {})
        flat_rf = settings.get(f"r{rid_int}_excl_min_Rake")
        if flat_rf is not None and str(flat_rf).strip() != "" and "rake_floor" not in exclusions:
            try:
                exclusions["rake_floor"] = float(flat_rf)
            except (TypeError, ValueError):
                pass
        if "global_roi_from" in exclusions or "global_roi_to" in exclusions:

            def _roi_ex_bound(v):
                if v is None:
                    return None
                if isinstance(v, str) and not str(v).strip():
                    return None
                try:
                    return float(v)
                except (TypeError, ValueError):
                    return None

            exclusions["roi_range"] = {
                "from": _roi_ex_bound(exclusions.get("global_roi_from")),
                "to": _roi_ex_bound(exclusions.get("global_roi_to")),
            }
        exclusions = normalize_merged_exclusions(exclusions)
        if isinstance(c, dict):
            c["exclusions"] = exclusions
        settings["rule_exclusions"][rid_int] = exclusions
        weight = c.get("weight")
        if weight is None:
            weight = (
                settings.get(f"rule{rid_int}_weight")
                or rule_weights.get(f"rule{rid_int}")
                or rule_weights.get(rid_int)
                or rule_weights.get(str(rid_int))
            )
        if weight is None:
            weight = meta_default_weight(rid_int)
        category = (c.get("category") or default_categories.get(rid_int) or "General").strip()
        settings["rule_configs"][rid_int] = {
            "parameters": params,
            "exclusions": dict(exclusions),
            "weight": float(weight),
            "category": category,
        }


# Overwrite inline ``exclusions`` on each meta row with :data:`DEFAULT_RULE_EXCLUSIONS_BY_RULE_ID`.
_sync_fraud_rules_meta_exclusions()
