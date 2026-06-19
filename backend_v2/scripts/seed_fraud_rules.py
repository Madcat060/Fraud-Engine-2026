"""
Seed fraud_rule_configs from fraud_rule_config_schema.get_default_configs().

Run from project root:
  python -m backend_v2.scripts.seed_fraud_rules
"""

from __future__ import annotations

import os
import sys

# Allow running as script: ensure project root on path
if __name__ == "__main__":
    _root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    if _root not in sys.path:
        sys.path.insert(0, _root)

from sqlalchemy import text
from sqlalchemy.orm import Session

from backend_v2.database import get_case_engine
from backend_v2.engine.fraud_rule_config_schema import get_default_configs
from backend_v2.models.case_models import Base, FraudRuleConfig


def _fraud_rules_seed_from_meta() -> list:
    """Single source: FRAUD_RULES_META + exclusions via get_default_configs()."""
    rows = []
    for c in get_default_configs():
        rid = int(c["rule_id"])
        rows.append(
            {
                "rule_id": rid,
                "rule_name": c.get("name") or f"Rule {rid}",
                "category": c.get("category", "General"),
                "risk_level": c.get("risk_level") or "Medium",
                "weight": float(c.get("weight", 50.0)),
                "parameters": dict(c.get("parameters") or {}),
                "exclusions": dict(c.get("exclusions") or {}),
                "dynamic_description": c.get("description_template") or "",
                "is_active": bool(c.get("is_active", c.get("active", True))),
            }
        )
    return rows


# Categories come from get_default_configs() (Chip Dumping, New Account High Win, General).
FRAUD_RULES_SEED = _fraud_rules_seed_from_meta()


def _ensure_columns(engine) -> None:
    """Add missing columns to fraud_rule_configs if the table existed with an older schema."""
    with engine.connect() as conn:
        conn.execute(text("""
            ALTER TABLE fraud_rule_configs
            ADD COLUMN IF NOT EXISTS dynamic_description TEXT
        """))
        conn.execute(text("""
            ALTER TABLE fraud_rule_configs
            ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE
        """))
        conn.execute(text("""
            ALTER TABLE fraud_rule_configs
            ADD COLUMN IF NOT EXISTS risk_level VARCHAR(32)
        """))
        conn.execute(text("""
            ALTER TABLE fraud_rule_configs
            ADD COLUMN IF NOT EXISTS weight FLOAT DEFAULT 0.5
        """))
        conn.execute(text("""
            ALTER TABLE fraud_rule_configs
            ADD COLUMN IF NOT EXISTS exclusions JSONB DEFAULT '{}'
        """))
        conn.commit()


def _delete_fraud_rule_rows_not_in_schema(session: Session) -> int:
    """Remove DB rows for rule_ids dropped from the schema (e.g. legacy 29–34)."""
    valid_ids = [int(c["rule_id"]) for c in get_default_configs()]
    q = session.query(FraudRuleConfig).filter(~FraudRuleConfig.rule_id.in_(valid_ids))
    n = q.count()
    if n:
        q.delete(synchronize_session=False)
    return n


def run_seed(force_overwrite: bool = False) -> None:
    """
    Seed ``fraud_rule_configs`` from :func:`get_default_configs`.

    * Default: insert **only missing** rule_ids (never overwrite existing UI-edited rows).
    * ``force_overwrite=True``: update every row from Python defaults (admin / migration only).
    * :func:`run_seed_if_table_empty`: inserts the full template **only when the table has zero rows**
      (first install / empty DB) — never clobber a populated table on server startup.
    * Rows whose ``rule_id`` is no longer in the schema are **deleted** on each seed run.
    """
    engine = get_case_engine()
    Base.metadata.create_all(engine)
    _ensure_columns(engine)

    created = 0
    updated = 0
    purged = 0
    with Session(engine) as session:
        purged = _delete_fraud_rule_rows_not_in_schema(session)
        for rule in FRAUD_RULES_SEED:
            existing = session.query(FraudRuleConfig).filter(FraudRuleConfig.rule_id == rule["rule_id"]).first()
            risk_level = rule.get("risk_level")
            weight = rule.get("weight", 0.5)
            exclusions = rule.get("exclusions") or {}
            if existing:
                # Preserve UI-edited values by default; only overwrite when explicitly forced.
                if force_overwrite:
                    existing.rule_name = rule["rule_name"]
                    existing.category = rule["category"]
                    existing.parameters = rule["parameters"]
                    existing.dynamic_description = rule["dynamic_description"]
                    if risk_level is not None:
                        existing.risk_level = risk_level
                    existing.weight = weight if weight is not None else 0.5
                    existing.exclusions = exclusions
                    updated += 1
                # else: safe preserve — do not modify existing rows (avoids resetting
                # parameters/exclusions when they are {} or "", and matches user expectation).
            else:
                session.add(
                    FraudRuleConfig(
                        rule_id=rule["rule_id"],
                        rule_name=rule["rule_name"],
                        category=rule["category"],
                        risk_level=risk_level,
                        weight=weight,
                        parameters=rule["parameters"],
                        exclusions=exclusions,
                        dynamic_description=rule["dynamic_description"],
                        is_active=bool(rule.get("is_active", True)),
                    )
                )
                created += 1
        session.commit()
    mode = "FORCE overwrite" if force_overwrite else "safe preserve"
    print(
        f"[seed_fraud_rules] Seed complete ({mode}). "
        f"Created: {created}, Updated: {updated}, Purged (removed rule_ids): {purged}, "
        f"Total template rules: {len(FRAUD_RULES_SEED)}."
    )


def run_seed_if_table_empty() -> None:
    """
    First-install helper: if ``fraud_rule_configs`` has no rows, insert all defaults once.
    If **any** row exists, do nothing (PostgreSQL remains the source of truth; no Python overwrite).
    """
    engine = get_case_engine()
    Base.metadata.create_all(engine)
    _ensure_columns(engine)
    with Session(engine) as session:
        n = session.query(FraudRuleConfig).count()
        if n > 0:
            return
    # Table empty — full seed in one shot (same as run_seed with all rows missing).
    run_seed(force_overwrite=False)


if __name__ == "__main__":
    # Set FRAUD_RULES_FORCE_SEED=1 to intentionally overwrite saved rule settings.
    force = str(os.environ.get("FRAUD_RULES_FORCE_SEED", "0")).strip().lower() in {"1", "true", "yes"}
    run_seed(force_overwrite=force)
