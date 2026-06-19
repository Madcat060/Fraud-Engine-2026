# Primary* tables — database column configuration

Auto-generated from `information_schema.columns` (PostgreSQL). Each section is one **database table**; each **markdown table** is the full column configuration for that report.

**Database:** `game_integrity` · **Schema:** `public` · **Tables:** 6

---

## `Primary_Account_information`

| Ord | Column name (exact) | PostgreSQL type | Nullable | Default |
|-----|---------------------|-----------------|----------|--------|
| 1 | `Cardroom` | text | YES | — |
| 2 | `Username` | text | YES | — |
| 3 | `Nickname` | text | YES | — |
| 4 | `Country` | text | YES | — |
| 5 | `Signup date + time` | text | YES | — |
| 6 | `Frozen` | text | YES | — |
| 7 | `Signup IP` | text | YES | — |
| 8 | `Signup serial` | text | YES | — |
| 9 | `Date first rake/fee` | timestamp without time zone(6) | YES | — |
| 10 | `Player Code` | bigint(64,0) | YES | — |
| 11 | `Lifetime Rake` | double precision(53) | YES | — |
| 12 | `Lifetime Fee` | double precision(53) | YES | — |

## `Primary_Cash_Games_Player_Stats`

| Ord | Column name (exact) | PostgreSQL type | Nullable | Default |
|-----|---------------------|-----------------|----------|--------|
| 1 | `Username` | text | YES | — |
| 2 | `Nickname` | text | YES | — |
| 3 | `Player code` | bigint(64,0) | YES | — |
| 4 | `Casino` | text | YES | — |
| 5 | `Hands` | bigint(64,0) | YES | — |
| 6 | `VPIP` | double precision(53) | YES | — |
| 7 | `PFR` | double precision(53) | YES | — |
| 8 | `3-bet` | double precision(53) | YES | — |
| 9 | `4-bet` | double precision(53) | YES | — |
| 10 | `Limp` | double precision(53) | YES | — |
| 11 | `WTSD` | double precision(53) | YES | — |
| 12 | `Flop Cbet` | double precision(53) | YES | — |
| 13 | `Turn Cbet` | double precision(53) | YES | — |
| 14 | `River Cbet` | double precision(53) | YES | — |
| 15 | `Post flop AGG` | double precision(53) | YES | — |
| 16 | `Attempt to Steal` | double precision(53) | YES | — |
| 17 | `Fold vs Flop Cbet` | double precision(53) | YES | — |
| 18 | `Call vs Flop Cbet` | double precision(53) | YES | — |
| 19 | `Raise vs Flop Cbet` | double precision(53) | YES | — |
| 20 | `Delayed CBet` | double precision(53) | YES | — |
| 21 | `Donk Bet Turn` | double precision(53) | YES | — |
| 22 | `WSD` | double precision(53) | YES | — |
| 23 | `Overbet River` | double precision(53) | YES | — |

## `Primary_Cash_table_session_summary`

| Ord | Column name (exact) | PostgreSQL type | Nullable | Default |
|-----|---------------------|-----------------|----------|--------|
| 1 | `Player Code` | bigint(64,0) | YES | — |
| 2 | `Nickname` | text | YES | — |
| 3 | `Username` | text | YES | — |
| 4 | `Language` | text | YES | — |
| 5 | `Big blind` | double precision(53) | YES | — |
| 6 | `Number of seats at table` | bigint(64,0) | YES | — |
| 7 | `Game type` | text | YES | — |
| 8 | `Bet type` | text | YES | — |
| 9 | `Game code name` | text | YES | — |
| 10 | `Session start date & time` | text | YES | — |
| 11 | `Session end date & time` | text | YES | — |
| 12 | `Session duration (in mins)` | double precision(53) | YES | — |
| 13 | `Table ID` | bigint(64,0) | YES | — |
| 14 | `Table name` | text | YES | — |
| 15 | `Poker Game Session Code` | bigint(64,0) | YES | — |
| 16 | `Session serial` | text | YES | — |
| 17 | `Session ip` | text | YES | — |
| 18 | `Gamelist code/ID` | bigint(64,0) | YES | — |
| 19 | `Hands played` | bigint(64,0) | YES | — |
| 20 | `Hands Won` | bigint(64,0) | YES | — |
| 21 | `Total bets` | double precision(53) | YES | — |
| 22 | `Total wins` | double precision(53) | YES | — |
| 23 | `Total profit/loss` | double precision(53) | YES | — |
| 24 | `Rake generated` | double precision(53) | YES | — |
| 25 | `# of raked hands` | bigint(64,0) | YES | — |
| 26 | `Award iPoints` | double precision(53) | YES | — |
| 27 | `Status iPoints` | double precision(53) | YES | — |
| 28 | `Turn time` | bigint(64,0) | YES | — |
| 29 | `Chips min` | double precision(53) | YES | — |
| 30 | `Chips max` | bigint(64,0) | YES | — |
| 31 | `Original currency` | text | YES | — |
| 32 | `Anonymous Table` | text | YES | — |
| 33 | `Client platform` | text | YES | — |
| 34 | `Currency` | text | YES | — |

## `Primary_Login_activity_by_player`

| Ord | Column name (exact) | PostgreSQL type | Nullable | Default |
|-----|---------------------|-----------------|----------|--------|
| 1 | `Player Code` | bigint(64,0) | YES | — |
| 2 | `Nickname` | text | YES | — |
| 3 | `Username` | text | YES | — |
| 4 | `Casino` | text | YES | — |
| 5 | `Login Date Time` | text | YES | — |
| 6 | `Logout Date Time` | text | YES | — |
| 7 | `Device Name` | text | YES | — |
| 8 | `Serial` | text | YES | — |
| 9 | `IP` | text | YES | — |
| 10 | `Operating system` | text | YES | — |

## `Primary_Major_income_sessions`

| Ord | Column name (exact) | PostgreSQL type | Nullable | Default |
|-----|---------------------|-----------------|----------|--------|
| 1 | `Player code` | bigint(64,0) | YES | — |
| 2 | `Username` | text | YES | — |
| 3 | `Nickname` | text | YES | — |
| 4 | `Country` | text | YES | — |
| 5 | `Real sign up date` | text | YES | — |
| 6 | `Frozen` | text | YES | — |
| 7 | `iPoker collusion` | text | YES | — |
| 8 | `Player lifetime rake` | double precision(53) | YES | — |
| 9 | `Session code` | bigint(64,0) | YES | — |
| 10 | `Start date` | text | YES | — |
| 11 | `End date` | text | YES | — |
| 12 | `Duration (seconds)` | bigint(64,0) | YES | — |
| 13 | `Big blind` | double precision(53) | YES | — |
| 14 | `Buy` | double precision(53) | YES | — |
| 15 | `Win` | double precision(53) | YES | — |
| 16 | `% Win` | double precision(53) | YES | — |
| 17 | `Rake` | double precision(53) | YES | — |
| 18 | `Bets` | double precision(53) | YES | — |
| 19 | `Wins` | double precision(53) | YES | — |
| 20 | `# of hands` | bigint(64,0) | YES | — |
| 21 | `# of won hands` | bigint(64,0) | YES | — |
| 22 | `% of won hands` | double precision(53) | YES | — |
| 23 | `Currency` | text | YES | — |

## `Primary_SNG_Twister_and_MTT`

| Ord | Column name (exact) | PostgreSQL type | Nullable | Default |
|-----|---------------------|-----------------|----------|--------|
| 1 | `Username` | text | YES | — |
| 2 | `Nickname` | text | YES | — |
| 3 | `Player code` | bigint(64,0) | YES | — |
| 4 | `Casino` | text | YES | — |
| 5 | `VIP level` | bigint(64,0) | YES | — |
| 6 | `Country` | text | YES | — |
| 7 | `Registration code` | bigint(64,0) | YES | — |
| 8 | `Session code` | bigint(64,0) | YES | — |
| 9 | `Tournament name` | text | YES | — |
| 10 | `Tournament code` | bigint(64,0) | YES | — |
| 11 | `Start date` | text | YES | — |
| 12 | `End date` | text | YES | — |
| 13 | `Registration date` | text | YES | — |
| 14 | `Dropout date` | text | YES | — |
| 15 | `Tournament status` | text | YES | — |
| 16 | `Registration method` | text | YES | — |
| 17 | `Buy-ins` | double precision(53) | YES | — |
| 18 | `Fees` | double precision(53) | YES | — |
| 19 | `Jackpot fees` | double precision(53) | YES | — |
| 20 | `Number of rebuys` | bigint(64,0) | YES | — |
| 21 | `Amount of rebuys` | double precision(53) | YES | — |
| 22 | `Number of addons` | bigint(64,0) | YES | — |
| 23 | `Amount of addons` | double precision(53) | YES | — |
| 24 | `Prizepool win` | double precision(53) | YES | — |
| 25 | `Jackpot win` | double precision(53) | YES | — |
| 26 | `Total win` | double precision(53) | YES | — |
| 27 | `Physical prize` | text | YES | — |
| 28 | `Balance` | double precision(53) | YES | — |
| 29 | `Status points` | double precision(53) | YES | — |
| 30 | `Award points` | double precision(53) | YES | — |
| 31 | `Currency` | text | YES | — |
| 32 | `Promotion source` | text | YES | — |
| 33 | `Client platform` | text | YES | — |
| 34 | `Tournament type` | text | YES | — |
| 35 | `Prize type` | text | YES | — |
| 36 | `Game type` | text | YES | — |
| 37 | `Game code name` | text | YES | — |
| 38 | `Position` | bigint(64,0) | YES | — |
| 39 | `Twister planned prize` | double precision(53) | YES | — |
| 40 | `Launch platform` | text | YES | — |
| 41 | `Device family` | text | YES | — |
| 42 | `Deal Made` | text | YES | — |
| 43 | `Flight` | text | YES | — |
| 44 | `Main tournament` | double precision(53) | YES | — |
| 45 | `# Hands` | double precision(53) | YES | — |
| 46 | `Tickets used amount` | double precision(53) | YES | — |
| 47 | `TM spent` | double precision(53) | YES | — |
| 48 | `TM won` | double precision(53) | YES | — |

---

Regenerate: `python -m backend_v2.scripts.dump_primary_table_configuration`
