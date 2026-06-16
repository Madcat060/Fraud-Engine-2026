"""
Apply fraud rule plan defaults to existing fraud_rule_configs rows (weights + key parameters).

Per-rule weights are taken from ``get_default_configs()`` (``FRAUD_RULES_META``), not a hand-maintained map.

Does not overwrite unrelated columns. Safe to re-run: merges parameters JSON.

Usage (project root):
  python -m backend_v2.scripts.patch_fraud_rules_plan_defaults --dry-run
  python -m backend_v2.scripts.patch_fraud_rules_plan_defaults
"""

from __future__ import annotations

import argparse
import json
import os
import sys

if __name__ == "__main__":
    _root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    if _root not in sys.path:
        sys.path.insert(0, _root)

from sqlalchemy import text

from backend_v2.database import get_case_engine
from backend_v2.engine.fraud_rule_config_schema import get_default_configs


def _weights_from_schema() -> dict[int, float]:
    """rule_id -> weight; kept in sync with FRAUD_RULES_META via get_default_configs()."""
    return {int(c["rule_id"]): float(c.get("weight", 50.0)) for c in get_default_configs()}

# Optional rule_id -> parameters patch (only schema rule_ids; empty until you add overrides)
PARAM_MERGE: dict[int, dict] = {}


def main() -> None:
    parser = argparse.ArgumentParser(description="Patch fraud_rule_configs with plan defaults.")
    parser.add_argument("--dry-run", action="store_true", help="Print changes only, do not commit.")
    args = parser.parse_args()
    engine = get_case_engine()

    weight_patch = _weights_from_schema()
    with engine.connect() as conn:
        for rid, w in sorted(weight_patch.items()):
            cur = conn.execute(
                text("SELECT weight FROM fraud_rule_configs WHERE rule_id = :rid"),
                {"rid": rid},
            ).scalar()
            if args.dry_run:
                print(f"[weight] rule_id={rid} current={cur!r} -> {w}")
            else:
                conn.execute(
                    text("UPDATE fraud_rule_configs SET weight = :w WHERE rule_id = :rid"),
                    {"w": w, "rid": rid},
                )

        for rid, patch in sorted(PARAM_MERGE.items()):
            cur = conn.execute(
                text("SELECT parameters FROM fraud_rule_configs WHERE rule_id = :rid"),
                {"rid": rid},
            ).scalar()
            if isinstance(cur, str):
                try:
                    merged = dict(json.loads(cur))
                except json.JSONDecodeError:
                    merged = {}
            elif isinstance(cur, dict):
                merged = dict(cur)
            else:
                merged = {}
            merged.update(patch)
            if args.dry_run:
                print(f"[parameters] rule_id={rid} patch={patch!r} would become keys={sorted(merged.keys())}")
            else:
                conn.execute(
                    text(
                        """
                        UPDATE fraud_rule_configs
                        SET parameters = CAST(:js AS jsonb)
                        WHERE rule_id = :rid
                        """
                    ),
                    {"js": json.dumps(merged), "rid": rid},
                )

        if not args.dry_run:
            conn.commit()
    mode = "dry-run" if args.dry_run else "applied"
    print(f"[patch_fraud_rules_plan_defaults] Done ({mode}).")


if __name__ == "__main__":
    main()
