"""
Seed ``fraud_rule_configs.exclusions`` from canonical :class:`RuleExclusions` defaults.

Uses :data:`DEFAULT_RULE_EXCLUSIONS_BY_RULE_ID` and :func:`rule_exclusions_to_legacy_json`
so the DB matches API/engine JSON (``min_hands``, ``roi_range``, ``profit_range``, etc.).

Run from project root:
  python -m backend_v2.scripts.seed_game_integrity_rule_exclusions
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
from backend_v2.engine.fraud_rule_config_schema import (
    DEFAULT_RULE_EXCLUSIONS_BY_RULE_ID,
    rule_exclusions_to_legacy_json,
)
from backend_v2.models.case_models import FraudRuleConfig


def main() -> None:
    engine = get_case_engine()
    with Session(engine) as session:
        rows = session.query(FraudRuleConfig).order_by(FraudRuleConfig.rule_id).all()
        if not rows:
            print("No fraud_rule_configs rows; run seed_fraud_rules first.")
            return
        for row in rows:
            rid = int(row.rule_id)
            if rid not in DEFAULT_RULE_EXCLUSIONS_BY_RULE_ID:
                continue
            ex = DEFAULT_RULE_EXCLUSIONS_BY_RULE_ID[rid]
            row.exclusions = rule_exclusions_to_legacy_json(ex)
        session.commit()
        print(f"Updated exclusions for {len(rows)} rule row(s).")


if __name__ == "__main__":
    main()
