"""
Load fraud rule configuration from the case-management PostgreSQL database.

The collusion / warehouse database must **not** be used for rule presets: UI saves land in
``fraud_rule_configs`` on the case DB only. The fraud engine resolves rules from this module
when callers do not pass a pre-merged ``settings["rules"]`` list.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

_log = logging.getLogger(__name__)

from sqlalchemy import text
from sqlalchemy.orm import Session

from backend_v2.database import get_case_engine
from backend_v2.engine.fraud_rule_config_schema import (
    get_default_configs,
    merge_saved_into_defaults,
)
from backend_v2.models.case_models import FraudRuleConfig

# Must match ``FRAUD_RULE_CONFIGS_KEY`` in :mod:`backend_v2.api.routes_fraud`.
_LEGACY_FRAUD_RULE_BLOB_KEY = "fraud_rule_configs"


def _coerce_fraud_rule_weight(raw_weight: Optional[Any], fallback: float = 50.0) -> float:
    """Normalize per-rule weight (legacy 0–1 scale → points scale)."""
    if raw_weight is None:
        return float(fallback)
    try:
        w = float(raw_weight)
    except (TypeError, ValueError):
        return float(fallback)
    if 0 < w < 1.0:
        return w * 100.0
    return w


def fetch_raw_fraud_rule_config_dicts_from_case_db() -> List[Dict[str, Any]]:
    """
    Return one dict per row in ``fraud_rule_configs`` (case DB), or [] if unavailable/empty.
    Values match the shape expected by :func:`merge_saved_into_defaults`.
    """
    defaults_by_id = {
        int(c["rule_id"]): float(c.get("weight") or 50.0) for c in get_default_configs()
    }
    try:
        engine = get_case_engine()
        with Session(engine) as session:
            rows = session.query(FraudRuleConfig).order_by(FraudRuleConfig.rule_id).all()
            if not rows:
                return []
            out: List[Dict[str, Any]] = []
            for r in rows:
                rid = int(r.rule_id)
                out.append(
                    {
                        "rule_id": rid,
                        "name": r.rule_name,
                        "rule_name": r.rule_name,
                        "category": r.category,
                        "risk_level": getattr(r, "risk_level", None) or "Medium",
                        "weight": _coerce_fraud_rule_weight(
                            getattr(r, "weight", None),
                            defaults_by_id.get(rid, 50.0),
                        ),
                        "parameters": dict(r.parameters or {}),
                        "exclusions": dict(getattr(r, "exclusions", None) or {}),
                        "active": bool(r.is_active),
                        "is_active": bool(r.is_active),
                        "description_template": r.dynamic_description or "",
                    }
                )
            return out
    except Exception as exc:
        _log.warning("fetch_raw_fraud_rule_config_dicts_from_case_db failed: %s", exc)
        return []


def load_merged_fraud_rule_configs_from_case_db() -> List[Dict[str, Any]]:
    """
    Full merged rule list for the engine / API: DB rows overlaid on schema defaults by ``rule_id``.
    """
    raw = fetch_raw_fraud_rule_config_dicts_from_case_db()
    if not raw:
        return []
    return merge_saved_into_defaults(raw, base_list=get_default_configs())


def load_merged_fraud_rule_configs_for_engine() -> List[Dict[str, Any]]:
    """
    Single entry for :func:`run_analysis` and HTTP getters:

    1. Live ``fraud_rule_configs`` rows (authoritative).
    2. Legacy ``collusion_rule_settings`` JSON blob (first‑gen installs).
    3. Python schema defaults from :func:`get_default_configs`.
    """
    merged = load_merged_fraud_rule_configs_from_case_db()
    if merged:
        return merged
    try:
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
            conn.commit()
            row = conn.execute(
                text("SELECT value FROM collusion_rule_settings WHERE key = :k"),
                {"k": _LEGACY_FRAUD_RULE_BLOB_KEY},
            ).fetchone()
        if row:
            saved = json.loads(row[0])
            if isinstance(saved, list):
                return merge_saved_into_defaults(saved, base_list=get_default_configs())
    except Exception:
        pass
    return get_default_configs()
