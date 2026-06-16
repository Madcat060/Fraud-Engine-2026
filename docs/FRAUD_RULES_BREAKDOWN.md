# Fraud Engine 2026 — Rules Breakdown (with worked examples)

This document breaks down **each of the five active fraud rules** in plain English, with:

1. **The area** — what behaviour the rule is trying to catch and why it matters.
2. **How it works** — the data source and detection logic.
3. **Default settings** — the thresholds shipped in `FRAUD_RULES_META`.
4. **Worked example** — concrete numbers showing a *trigger* and a *non-trigger*.
5. **The code** — the actual SQL + Python that implements the rule.
6. **Example output** — the reason string and case fields the rule produces.

All logic lives in `backend_v2/engine/fraud_engine.py`; the defaults live in `backend_v2/engine/fraud_rule_config_schema.py`. Live thresholds come from the `fraud_rule_configs` table (editable in the UI), falling back to these defaults.

---

## How to read this document

Every rule attaches a **reason string** (prefixed `Rule N`) to a player's case and sets a **category** and **tag**. After all rules run, `_finalize_cases()` converts the reasons into a **risk score** by adding each triggered rule's **weight** (default **35** per rule) once. A case is surfaced at/above the **minimum case score** (`caseTriggerScore`, default **100**).

| Rule | Area (category) | Data source | Default weight |
|------|-----------------|-------------|----------------|
| 1 | Cash margin — new account (**Chip Dumping**) | `Primary_Cash_table_session_summary` | 35 |
| 2 | Major income % Win spike (**New Account High Win**) | `Primary_Major_income_sessions` + `Primary_Account_information` | 35 |
| 3 | Twister tournament overlap (**Common Games**) | `Primary_SNG_Twister_and_MTT` | 35 |
| 4 | MTT tournament overlap (**Common Games**) | `Primary_SNG_Twister_and_MTT` | 35 |
| 5 | SNG tournament overlap (**Common Games**) | `Primary_SNG_Twister_and_MTT` | 35 |

> **Note on scoring:** with the default weights, a single rule scores 35, which is below the default trigger of 100. A case clears the trigger when multiple rules fire on the same player (e.g. 3 × 35 = 105), or when weights/trigger are tuned in the UI. Cases are still **persisted** even below the trigger; the trigger governs triage visibility.

---

## Rule 1 — Cash margin (new account)

### The area
**Chip dumping / unnatural cash winnings.** In legitimate cash poker, a player's profit relative to the money they put across the table (turnover) sits in a narrow band — typically around **−2% to +3%**. A player whose profit is a very high percentage of their total bets is winning far more efficiently than skill alone explains, which is a classic signature of **chip dumping** (a colluder deliberately losing chips to a partner).

### How it works
For each player, sum the profit/loss and the bets across **all cash sessions**, then compute:

\[
\text{Cash margin (\%)} = \frac{\sum(\text{Total profit/loss})}{\sum(\text{Total bets})} \times 100
\]

A player is flagged when **margin ≥ `min_cash_margin_pct`** *and* **Σ bets ≥ `min_cash_total_bets`** (the bets floor stops tiny-sample noise from triggering).

### Default settings
| Parameter | Default | Meaning |
|-----------|---------|---------|
| `min_cash_margin_pct` | `50.0` | Flag at 50%+ margin on turnover |
| `min_cash_total_bets` | `100.0` | Ignore players with under 100 in total bets |

### Worked example
| Player | Σ P/L | Σ bets | Margin | Bets ≥ 100? | Result |
|--------|-------|--------|--------|-------------|--------|
| **A (triggers)** | 8,000 | 10,000 | 80.0% | yes | **Flagged** — 80% ≥ 50% |
| **B (no trigger)** | 90 | 60 | 150% | **no** (60 < 100) | Not flagged — below bets floor |
| **C (no trigger)** | 200 | 10,000 | 2.0% | yes | Not flagged — 2% < 50% |

Player A's 80% margin on 10,000 of turnover is economically implausible for fair play → case opened under **Chip Dumping**.

### The code
The SQL aggregates cash sessions, computes the margin, and filters by both thresholds:

```834:866:backend_v2/engine/fraud_engine.py
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
```

The parameters are read from the rule config (with safe fallbacks):

```825:832:backend_v2/engine/fraud_engine.py
    r1 = fraud_rule_parameters(settings, 1)
    min_margin = r1.get("min_cash_margin_pct")
    if min_margin is None or min_margin == "":
        min_margin = r1.get("burner_roi_threshold")
    min_margin_f = _safe_float(min_margin, 50.0)
    min_bets_f = _safe_float(r1.get("min_cash_total_bets"), 100.0)
    if min_bets_f < 1e-9:
        min_bets_f = 100.0
```

### Example output
- **Category:** `Chip Dumping` · **Tag:** `CASH_MARGIN_NEW`
- **Reason string:**
  > `Rule 1 [Cash]: Cash margin 80.00% (floor 50.0%) — (Σ Total profit/loss ÷ Σ Total bets) × 100 from Primary_Cash_table_session_summary only; Σ bets 10000 (min 100).`

---

## Rule 2 — Major income "% Win" spike (new account)

### The area
**Brand-new accounts winning huge multiples instantly.** A freshly created account that books an enormous percentage return within a day or two is a hallmark of a **receiver account** in a collusion ring (chips/value funnelled into a new identity) or a bonus/jackpot abuse setup. The "% Win" field on a major-income session expresses the win as a percentage of the buy-in, so 500%+ means winning 5×+ the stake.

### How it works
Join major-income sessions to the account table, and flag a player when **all** hold:

- A session's `"% Win"` **>** `min_major_pct_win`, **and**
- That session's `Win` amount **≥** `min_major_session_win` (filters trivial wins), **and**
- The account's **signup age ≤ `major_max_age_days`** (computed from `Signup date + time`).

### Default settings
| Parameter | Default | Meaning |
|-----------|---------|---------|
| `major_max_age_days` | `2` | Account must be ≤ 2 days old |
| `min_major_pct_win` | `500.0` | Session must show > 500% win |
| `min_major_session_win` | `50.0` | Session win must be ≥ 50 (absolute) |

### Worked example
| Player | Account age | Best session % Win | Session Win | Result |
|--------|-------------|--------------------|-------------|--------|
| **A (triggers)** | 1 day | 1,200% | 300 | **Flagged** — new + > 500% + ≥ 50 |
| **B (no trigger)** | 10 days | 1,200% | 300 | Not flagged — account too old |
| **C (no trigger)** | 1 day | 1,200% | 20 | Not flagged — win < 50 |

### The code
Account age is enforced in SQL with an interval comparison; the strongest session per player is kept (`DISTINCT ON … ORDER BY pct_win DESC`):

```930:966:backend_v2/engine/fraud_engine.py
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
```

### Example output
- **Category:** `New Account High Win` · **Tag:** `MAJOR_PCT_WIN`
- **Reason string:**
  > `Rule 2 [Major]: Primary_Major_income_sessions "% Win" 1200.00% (floor 500.0%), Win 300.00 (min 50.0), Buy 25.00, session 998877; signup ≤2d (Primary_Account_information).`

---

## Rules 3–5 — Common tournament overlap (Twister / MTT / SNG)

Rules 3, 4 and 5 are the **same algorithm** applied to three tournament formats. They detect **two players who keep showing up in the same tournaments** far more than chance would predict — the core signature of **collusion teams / soft-play rings** that register together to share a table.

All three share one implementation, `_evaluate_rule_common_overlap()`, parameterised per format:

```1214:1266:backend_v2/engine/fraud_engine.py
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
```

### How it works (shared logic)
1. Take each player's **distinct tournament codes** in the chosen format (`Tournament type = Twister | MTT | SNG`).
2. For every **pair** of players, count how many **distinct tournaments they shared**.
3. Compute each player's **overlap %** = `shared ÷ that player's total distinct tournaments in the format × 100`.
4. Flag the pair when shared count **≥ `min_common_tournaments`** *and* the overlap threshold is met.

### The one key difference between the three rules
| Rule | Format | Overlap threshold rule |
|------|--------|------------------------|
| **3 — Twister** | Twister | **Both** players must meet `min_overlap_pct` (`require_both_overlap_pct=True`) |
| **4 — MTT** | MTT | **Either** player meeting `min_overlap_pct` is enough |
| **5 — SNG** | SNG | **Either** player meeting `min_overlap_pct` is enough |

Twister fields are small (only a few players per game), so requiring **both** sides to be concentrated avoids flagging a casual player who happened to share games with a grinder. MTT/SNG use **either** because a high-volume player can dilute their own overlap % while still being the target of a colluder.

### Default settings (same for all three)
| Parameter | Default | Meaning |
|-----------|---------|---------|
| `min_common_tournaments` | `5` | At least 5 shared distinct tournaments |
| `min_overlap_pct` | `30.0` | 30% concentration threshold |

### Worked examples

**Rule 3 (Twister — needs BOTH sides ≥ 30%)**

| | Player A | Player B |
|--|----------|----------|
| Distinct Twisters | 12 | 8 |
| Shared | 6 | 6 |
| Overlap % | 6/12 = **50%** | 6/8 = **75%** |

Shared 6 ≥ 5 ✓, and **both** 50% and 75% ≥ 30% ✓ → **both players flagged**. (If B had played 100 Twisters → 6% overlap → *not* flagged under Rule 3's "both" requirement.)

**Rule 4 (MTT — needs EITHER side ≥ 30%)**

| | Player A | Player B |
|--|----------|----------|
| Distinct MTTs | 40 | 5 |
| Shared | 5 | 5 |
| Overlap % | 5/40 = **12.5%** | 5/5 = **100%** |

Shared 5 ≥ 5 ✓, and **either** side qualifies (B = 100% ≥ 30%) ✓ → **flagged**. The big-volume player A alone (12.5%) wouldn't qualify, but the pair does because B is almost exclusively playing A's games.

### The code (shared SQL + threshold switch)
The pairwise overlap is computed entirely in SQL; the `:require_both` bind flips between the "either" and "both" logic:

```1043:1065:backend_v2/engine/fraud_engine.py
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
```

Parameters and the `require_both` switch are set in the shared evaluator:

```1118:1128:backend_v2/engine/fraud_engine.py
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
```

### Example output
- **Category:** `Common Games` · **Tag:** `TWISTER_COMMON` / `MTT_COMMON` / `SNG_COMMON`
- **Reason string (Rule 4 example):**
  > `Rule 4 [MTT Common]: Partner ColluderBob (player code 554433) — 5 shared distinct MTT tournaments (floor 5); overlap 12.50% of your 40 in this format, 100.00% of partner's 5 (floor 30.0% on either side.) Source Primary_SNG_Twister_and_MTT; lifetime scope (no calendar-day filter).`

---

## Cross-rule mechanics (applies to all five)

### Exclusions (noise filters)
Before a player is flagged for any rule, `_should_exclude_player()` can skip them based on per-rule **exclusion** bands stored in `fraud_rule_configs.exclusions` — e.g. minimum lifetime hands, ROI/profit ranges, rake floors. This lets analysts suppress known false positives (e.g. high-volume verified regulars) without changing the rule itself.

### Scoring (turning reasons into a risk score)
```615:621:backend_v2/engine/fraud_engine.py
            rule_data = rule_configs.get(str(rid_int)) or rule_configs.get(rid_int) or {}
            base_weight = float(rule_data.get("weight", meta_default_weight(rid_int)))
            if base_weight <= 0.0:
                if cnt > 0:
                    info_ids.append(rid_int)
                continue
            pc.risk_score += _score_rule(cnt, base_weight)
```
- Each distinct triggered rule adds its **weight once** (repeated hits of the same rule don't stack).
- A rule with **weight 0** becomes **informational only**: it tags the case `INFO_R{n}` but adds no score and won't open a case on its own.

### Category & tag
Each rule sets a **category** (triage tab) and a **tag** (filter chip). After all rules run, the category is reconciled from the rule IDs present in the reason string via a fixed priority (`Chip Dumping` → `New Account High Win` → `Common Games` → `General`).

---

## Adding a sixth rule (extension pattern)
The engine is built so a new rule is three small additions:

1. Add a row to `FRAUD_RULES_META` in `fraud_rule_config_schema.py` (id, name, category, parameters, default weight).
2. Write `_evaluate_rule6_*()` in `fraud_engine.py` that runs its SQL and appends a `Rule 6 [...]` reason.
3. Add an `if _is_rule_active(settings, [6]):` branch in `run_analysis()`.

All shared plumbing — scoring, exclusions, categories, tags, persistence — already understands any `Rule N` label, so no other changes are required.

---

### Source references
- Rule 1: `_evaluate_rule1_burner` — `backend_v2/engine/fraud_engine.py`
- Rule 2: `_evaluate_rule2_major_income` — `backend_v2/engine/fraud_engine.py`
- Rules 3–5: `_evaluate_rule_common_overlap` + `_COMMON_OVERLAP_RANKED_SQL` + the three wrappers — `backend_v2/engine/fraud_engine.py`
- Defaults/parameters: `FRAUD_RULES_META` — `backend_v2/engine/fraud_rule_config_schema.py`
- Scoring/finalisation: `_finalize_cases`, `_score_rule` — `backend_v2/engine/fraud_engine.py`
