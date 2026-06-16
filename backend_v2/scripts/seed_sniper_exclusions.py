"""
Seed Fraud Rule Config exclusions (Sniper) for the single configured rule (rule_id 1).

Run from project root:
  python -m backend_v2.scripts.seed_sniper_exclusions

Uses CASE_MANAGEMENT_URL (case DB). Updates the exclusions JSON column on
fraud_rule_configs for rule 1 so the engine and UI Exclusions tab show values.
"""

from __future__ import annotations

import os
import sys

if __name__ == "__main__":
    _root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    if _root not in sys.path:
        sys.path.insert(0, _root)

from sqlalchemy.orm import Session

from backend_v2.database import get_case_engine
from backend_v2.models.case_models import FraudRuleConfig

# Burner / new-pro style (burst-oriented thresholds for exclusions UI)
EXCLUSIONS_RULE_1 = {
    "max_hands": 100,
    "min_roi": 200,
    "min_profit": 100,
    "roi_range": {"from": 200, "to": None},
    "profit_range": {"from": 100, "to": None},
}


def run_seed() -> None:
    engine = get_case_engine()
    updated = 0
    rule_id = 1
    with Session(engine) as session:
        row = session.query(FraudRuleConfig).filter(FraudRuleConfig.rule_id == rule_id).first()
        if not row:
            print(f"[seed_sniper_exclusions] Rule {rule_id} not found in fraud_rule_configs; run seed_fraud_rules first.")
        else:
            row.exclusions = dict(EXCLUSIONS_RULE_1)
            updated += 1
        session.commit()
    print(f"[seed_sniper_exclusions] Updated exclusions for rule 1 ({updated} row).")


if __name__ == "__main__":
    run_seed()
