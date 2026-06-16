"""Regression tests for fraud rule config merge helpers."""

from backend_v2.engine.fraud_rule_config_schema import (
    get_default_configs,
    merge_saved_into_defaults,
)


def test_merge_saved_overrides_weight():
    base = get_default_configs()
    saved = [{"rule_id": 1, "weight": 99.0}]
    out = merge_saved_into_defaults(saved, base_list=base)
    r1 = next(x for x in out if x["rule_id"] == 1)
    assert r1["weight"] == 99.0


def test_merge_saved_merges_parameters_keys():
    base = get_default_configs()
    saved = [{"rule_id": 1, "parameters": {"min_cash_total_bets": 200.0, "min_cash_margin_pct": 40.0}}]
    out = merge_saved_into_defaults(saved, base_list=base)
    r1 = next(x for x in out if x["rule_id"] == 1)
    assert r1["parameters"].get("min_cash_total_bets") == 200.0
    assert r1["parameters"].get("min_cash_margin_pct") == 40.0


def test_merge_saved_full_exclusions_replace():
    base = get_default_configs()
    ex = {"min_hands": 5000, "roi_range": {"from": -50.0, "to": 40.0}}
    saved = [{"rule_id": 1, "exclusions": ex}]
    out = merge_saved_into_defaults(saved, base_list=base)
    r1 = next(x for x in out if x["rule_id"] == 1)
    assert r1["exclusions"] == ex


def test_get_default_configs_rule_ids():
    rows = get_default_configs()
    ids = {int(r["rule_id"]) for r in rows}
    assert ids == {1, 2}


def test_merge_saved_schema_base_false_no_default_parameter_injection():
    base = [
        {
            "rule_id": 1,
            "parameters": {"min_cash_total_bets": 500.0},
            "exclusions": {},
            "weight": 35.0,
            "active": True,
            "is_active": True,
        }
    ]
    saved = [{"rule_id": 1, "parameters": {"min_cash_total_bets": 200.0}}]
    out = merge_saved_into_defaults(saved, base_list=base, schema_base=False)
    r1 = next(x for x in out if x["rule_id"] == 1)
    assert r1["parameters"] == {"min_cash_total_bets": 200.0}
    assert "max_age_days" not in r1["parameters"]
