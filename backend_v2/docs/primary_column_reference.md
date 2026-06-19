# Primary_* column reference

This document lists **exact** column identifiers as they appear in the platform extract (mirrored in sample CSVs under `backend_v2/`). The fraud engine and investigation API use **double-quoted** identifiers in SQL, so spelling and **capitalisation matter** in PostgreSQL.

## Player identifier casing (critical)

| Table | Column name in DB / CSV |
|-------|-------------------------|
| `Primary_Account_information` | `"Player Code"` |
| `Primary_Cash_table_session_summary` | `"Player Code"` |
| `Primary_Login_activity_by_player` | `"Player Code"` |
| `Primary_Major_income_sessions` | `"Player code"` (lowercase **c**) |
| `Primary_Cash_Games_Player_Stats` | `"Player code"` (lowercase **c**) |
| `Primary_SNG_Twister_and_MTT` | `"Player code"` (lowercase **c**) |

`"Player Code"` and `"Player code"` are **different** columns. New rules and investigation queries must use the name that matches the target table.

## Source samples in this repo

| CSV file (sample) | PostgreSQL table |
|-------------------|------------------|
| `Account Information.csv` | `Primary_Account_information` |
| `Cash table summary.csv` | `Primary_Cash_table_session_summary` |
| `Cash Game Player Stats.csv` | `Primary_Cash_Games_Player_Stats` |
| `Login Activity by player.csv` | `Primary_Login_activity_by_player` |
| `Major Income Sessions.csv` | `Primary_Major_income_sessions` |
| `SNG twister and MTT.csv` | `Primary_SNG_Twister_and_MTT` |

Refresh this document if the export schema changes.

---

## `Primary_Account_information`

`Cardroom`, `Username`, `Nickname`, `Country`, `Signup date + time`, `Frozen`, `Signup IP`, `Signup serial`, `Date first rake/fee`, `Player Code`, `Lifetime Rake`, `Lifetime Fee`

**Used for:** account-level identity, signup (incl. `Signup IP`, `Signup serial`), frozen state, **Lifetime Rake** and **Lifetime Fee** (only source for those KPIs); `routes_fraud.py` player profile; `resolve_display_nickname_from_primary` / `resolve_player_code_from_nickname`.

---

## `Primary_Cash_table_session_summary`

`Player Code`, `Nickname`, `Username`, `Language`, `Big blind`, `Number of seats at table`, `Game type`, `Bet type`, `Game code name`, `Session start date & time`, `Session end date & time`, `Session duration (in mins)`, `Table ID`, `Table name`, `Poker Game Session Code`, `Session serial`, `Session ip`, `Gamelist code/ID`, `Hands played`, `Hands Won`, `Total bets`, `Total wins`, `Total profit/loss`, `Rake generated`, `# of raked hands`, `Award iPoints`, `Status iPoints`, `Turn time`, `Chips min`, `Chips max`, `Original currency`, `Anonymous Table`, `Client platform`, `Currency`

**Used for:** cash-only KPIs (Σ `Hands played`, Σ `Total profit/loss`, Σ `Total bets`, Σ `Rake generated`, cash win % via Σ `Hands Won` / Σ `Hands played`), session history, stake timeline, cumulative charts; Rules 5, 7, 12, 14, 18, 20, 21; `_bulk_update_unified_profile` cash aggregates.

---

## `Primary_Cash_Games_Player_Stats`

`Username`, `Nickname`, `Player code`, `Casino`, `Hands`, `VPIP`, `PFR`, `3-bet`, `4-bet`, `Limp`, `WTSD`, `Flop Cbet`, `Turn Cbet`, `River Cbet`, `Post flop AGG`, `Attempt to Steal`, `Fold vs Flop Cbet`, `Call vs Flop Cbet`, `Raise vs Flop Cbet`, `Delayed CBet`, `Donk Bet Turn`, `WSD`, `Overbet River`

**Used for:** **Behavioral stats** (VPIP, PFR, 3-bet, etc.) in `routes_fraud.py` / investigation UI; Rule 22; `_bulk_update_unified_profile` averages for case payloads. No cash volume or financial totals from this table.

---

## `Primary_Login_activity_by_player`

`Player Code`, `Nickname`, `Username`, `Casino`, `Login Date Time`, `Logout Date Time`, `Device Name`, `Serial`, `IP`, `Operating system`

**Used for:** login counts, unique IPs/serials, hardware twins, related players; Rules 8, 11, 12, 13, 17 (login anchor subquery maps `Login Date Time` / `Logout Date Time` internally), 19, 23; MTT Rules 16/17 (join on nickname + same calendar day as `Login Date Time`). Identity resolution also consults this table when nick/username appear only here.

---

## `Primary_Major_income_sessions`

`Player code`, `Username`, `Nickname`, `Country`, `Real sign up date`, `Frozen`, `iPoker collusion`, `Player lifetime rake`, `Session code`, `Start date`, `End date`, `Duration (seconds)`, `Big blind`, `Buy`, `Win`, `% Win`, `Rake`, `Bets`, `Wins`, `# of hands`, `# of won hands`, `% of won hands`, `Currency`

**Used for:** major-income **session grid** (investigation spike log), iPoker collusion flag, and **Rule 4 only** (literal `% Win`, `% of won hands`, `# of hands`). Do **not** use this table for account lifetime rake/fee, cash P/L, or MTT aggregates — those come from `Primary_Account_information`, `Primary_Cash_table_session_summary`, and `Primary_SNG_Twister_and_MTT` (`Tournament type`).

---

## `Primary_SNG_Twister_and_MTT`

`Username`, `Nickname`, `Player code`, `Casino`, `VIP level`, `Country`, `Registration code`, `Session code`, `Tournament name`, `Tournament code`, `Start date`, `End date`, `Registration date`, `Dropout date`, `Tournament status`, `Registration method`, `Buy-ins`, `Fees`, `Jackpot fees`, `Number of rebuys`, `Amount of rebuys`, `Number of addons`, `Amount of addons`, `Prizepool win`, `Jackpot win`, `Total win`, `Physical prize`, `Balance`, `Status points`, `Award points`, `Currency`, `Promotion source`, `Client platform`, `Tournament type`, `Prize type`, `Game type`, `Game code name`, `Position`, `Twister planned prize`, `Launch platform`, `Device family`, `Deal Made`, `Flight`, `Main tournament`, `# Hands`, `Tickets used amount`, `TM spent`, `TM won`

**Used for:** tournament session list in investigation; VIP level; `GET /api/player/<player_code>` P/L and counts with **strict** `Tournament type` ∈ `MTT`, `SNG`, `Twister`. **Twister played** = count of rows with `Tournament type` = Twister (not only distinct `Tournament code`). **Twister win %** (triage / engine) = among those rows, row-level profit `Total win` − `Buy-ins` − `Fees` − `Jackpot fees`; count rows with profit &gt; 0 ÷ row count × 100 (positive = win, negative = loss). MTT+SNG distinct-tournament logic unchanged. Rules 15–17 where applicable.

---

## Where to change code

| Area | Typical files |
|------|----------------|
| Investigation player profile | `backend_v2/api/routes_fraud.py` |
| Fraud rules (scan) | `backend_v2/engine/fraud_engine.py` |
| Rule defaults / descriptions | `backend_v2/engine/fraud_rule_config_schema.py` |
| Investigation UI | `src/Investigation/*.jsx` |

After altering any `Primary_*` column name in SQL, grep the codebase for the old identifier and update tests or CSV fixtures if you use them.

---

## Schema performance (native types + indexes)

Optional migration: `backend_v2/scripts/db_optimizations.sql` — casts selected date/time columns to `TIMESTAMP`, IP columns to `inet`, and adds B-tree indexes on player keys and hot timestamp/IP columns. The fraud engine’s SQL assumes these types **after** you run that script on `game_integrity` (timestamps and `host(CAST("IP" AS inet))` work on `text` extracts too, but native types avoid casts and enable index use).

**Behavioural note:** bulk core/lifetime/global stats filter by **exact** `Nickname` (no `LOWER`/`TRIM` in SQL). Case or spacing mismatches between the case list and the warehouse will miss rows until nicknames align.
