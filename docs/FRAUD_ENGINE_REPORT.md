# Fraud Engine 2026 — Technical Report

**Audience:** Engineering, data, and audit/assurance reviewers
**Scope:** Architecture, detection logic, data sources, scoring, persistence, APIs, frontend, configuration, and known gaps.
**Basis:** This report is derived directly from the source code in this repository (primarily `backend_v2/`). Where the older markdown in `docs/` disagrees with the code, the **code is treated as authoritative** and the discrepancy is flagged in [Section 12](#12-known-gaps-and-observations).

---

## 1. Executive summary

Fraud Engine 2026 is a **collusion / fraud-detection platform for online poker**. It ingests operator data-warehouse tables (account, cash, tournament, and login activity), evaluates each player against a configurable set of fraud rules, scores the results, and opens **investigation cases** that analysts triage and work through a web UI.

The platform is split into **two independent Python services** plus a **single-page React frontend**:

| Component | Role | Default port |
|-----------|------|--------------|
| **Fraud service** (`backend_v2.service_fraud`) | Serves the React UI, exposes the case/rules REST API, runs collusion scans, streams progress over Socket.IO | 5001 |
| **Reports service** (`backend_v2.service_reports`) | Data ingestion (CSV → PostgreSQL), report scheduling, external (Playtech) report fetching | 5000 |
| **Frontend** (`src/`, Vite + React) | Triage dashboard, case investigation workspace, rule configuration | served by fraud service |

The detection engine currently implements **five active rules** (cash-margin, new-account win spike, and three tournament-overlap rules). It is structured so additional rules can be added without reworking the shared scoring/persistence plumbing.

---

## 2. Technology stack

**Backend (Python)** — see `requirements.txt`
- **Flask** + **Flask-SocketIO** + **Flask-CORS** — web layer and real-time scan updates
- **SQLAlchemy** (2.x style, `future=True`) — ORM and DB access
- **psycopg2-binary** — PostgreSQL driver
- **pandas** — CSV ingestion / type inference (reports service)
- **pydantic v2** — rule-exclusion schema validation
- **APScheduler** — report scheduling
- **tqdm** — scan progress bars in the console
- **PyInstaller** — packaging into a frozen executable

**Frontend (Node/React)** — see `package.json`
- **React 18** built with **Vite 7**
- **MUI 7** (`@mui/material`, `@emotion`) — component library
- **Recharts 3** + **Chart.js 4 / react-chartjs-2** — charts
- **socket.io-client** — live scan/case alerts

**Data stores**
- **PostgreSQL** — both the source data warehouse and the case-management database (same instance by default; see [Section 5](#5-databases-and-data-sources))
- **SQLite** (`data/gi_cases.db`) and JSON (`data/app_data.json`) — present in the repo for local/dev artefacts

---

## 3. Repository layout

```
Fraud Engine 2026/
├── backend_v2/                  ← canonical backend (use this)
│   ├── service_fraud.py         ← Fraud UI + API + scan service (port 5001)
│   ├── service_reports.py       ← Reports/ingestion service (port 5000)
│   ├── config.py                ← env-driven configuration
│   ├── database.py              ← SQLAlchemy engine cache + declarative Base
│   ├── engine/
│   │   ├── fraud_engine.py      ← MAIN ENGINE: run_analysis(), rules 1–5, scoring, upsert
│   │   ├── fraud_rule_config_schema.py  ← rule metadata, defaults, merge helpers
│   │   └── fraud_rule_db_loader.py      ← loads persisted rule configs for the engine
│   ├── api/
│   │   ├── routes_fraud.py      ← cases, player profiles, rule settings, scan trigger
│   │   ├── routes_reports.py    ← report runner, profiles, CSV import, ops metrics
│   │   └── ops_dashboard.py     ← operational metrics queries
│   ├── models/case_models.py    ← InvestigationCase, CaseNote, FraudRuleConfig
│   ├── services/
│   │   ├── report_manager.py    ← scheduler loop + CSV→DB ingestion
│   │   └── storage.py           ← persistence helpers
│   └── scripts/                 ← seeders + DB maintenance
├── src/                         ← React frontend (Vite)
│   ├── App.jsx, main.jsx
│   ├── Workspace/TriageDashboard.jsx
│   ├── Investigation/CaseWorkspace.jsx (+ charts, network, attachments)
│   └── Settings/RuleSettings.jsx, EngineConfigAccordion.jsx
├── templates/                   ← index.html / rules.html shells
├── static/dist/                 ← built frontend assets
├── docs/                        ← documentation (some predates the 5-rule engine)
└── requirements.txt, package.json, vite.config.js
```

> **Legacy note:** Root-level `app.py`, `api.py`, and `processor.py` are **legacy** and are *not* the V2 entry points. They survive only because `backend_v2/api/routes_reports.py` still imports `_run_reports_impl` from `app.py`. Do not start the V2 fraud app via `python app.py`. See `docs/PROJECT_LAYOUT.md`.

---

## 4. High-level architecture

```mermaid
flowchart TB
    subgraph Operator["Operator data (CSV / Playtech API)"]
        CSV[CSV exports]
        PT[Playtech reports API]
    end

    subgraph Reports["Reports service :5000 (service_reports)"]
        RM[report_manager\nscheduler + CSV ingest]
        RR[routes_reports]
    end

    subgraph DB["PostgreSQL"]
        WH[(Data warehouse\nPrimary_* tables)]
        CM[(Case mgmt\ninvestigation_cases,\ncase_notes,\nfraud_rule_configs)]
    end

    subgraph Fraud["Fraud service :5001 (service_fraud)"]
        FE[fraud_engine.run_analysis\nRules 1–5]
        RF[routes_fraud\ncases + rule settings API]
        SIO[Socket.IO\nscan_status / new_case_alert]
    end

    subgraph UI["React SPA (src/)"]
        TD[TriageDashboard]
        CW[CaseWorkspace]
        RS[RuleSettings]
    end

    CSV --> RM
    PT --> RR
    RM --> WH
    WH --> FE
    FE --> CM
    RF <--> CM
    CM --> RF
    RF --> UI
    SIO <--> UI
    RS --> RF
    RF --> FE
```

**Two scan trigger paths** both call the same engine:
1. **Socket.IO** `run_manual_scan` → background job `_collusion_scan_job` in `service_fraud.py`.
2. **REST** `POST /api/collusion/scan/trigger` and `POST /api/collusion/analyze` in `routes_fraud.py`.

A module-level `scan_lock` + `SCAN_IN_PROGRESS` flag prevents concurrent scans.

---

## 5. Databases and data sources

Configuration (`backend_v2/config.py`) defines three logical connections, all defaulting to the **same** PostgreSQL instance unless overridden by environment variables:

| Variable | Purpose | Default |
|----------|---------|---------|
| `DEFAULT_DB_CONNECTION` | Shared base connection | `postgresql+psycopg2://postgres:***@localhost/game_integrity` |
| `CASE_MANAGEMENT_URL` | Case DB (cases, notes, rule configs) | = `DEFAULT_DB_CONNECTION` |
| `COLLUSION_DB_URL` | Source warehouse for scans | = `DEFAULT_DB_CONNECTION` |

Engines are cached and created with `pool_pre_ping=True` (`database.py`), so stale connections are re-established automatically. Passwords are redacted in logs via `mask_connection_url()`.

### 5.1 Source warehouse tables (read by the engine)

The engine and profile queries read these `Primary_*` tables (note the inconsistent `"Player Code"` vs `"Player code"` casing across tables, which the SQL handles explicitly):

| Table | Used for |
|-------|----------|
| `Primary_Account_information` | Signup date/age, nickname ↔ player-code resolution |
| `Primary_Cash_table_session_summary` | Cash margin (Rule 1), turnover, P/L |
| `Primary_Major_income_sessions` | "% Win" spike (Rule 2), buy-in ROI |
| `Primary_SNG_Twister_and_MTT` | Tournament overlap (Rules 3–5) |
| `Primary_Cash_Games_Player_Stats` | Player stats / profile enrichment |
| `Primary_Login_activity_by_player` | Login activity / code resolution |

### 5.2 Case-management tables (written by the engine)

Defined in `backend_v2/models/case_models.py`:

- **`investigation_cases`** — one row per flagged player (`player_code` unique). Holds `risk_score`, `triggered_scenarios` (human-readable reason string), `status`, `category`, `tag`, financial KPIs (`net_profit`, `roi`, win rates, `lifetime_rake`), poker stats (`vpip`, `pfr`, `three_bet`), and JSON blobs `network_data` / `suspicious_sessions`. `to_dict()` flattens selected `network_data` keys to top-level fields for the UI.
- **`case_notes`** — analyst notes, FK to a case with `ON DELETE CASCADE`.
- **`fraud_rule_configs`** — one row per rule (`rule_id` PK): `rule_name`, `category`, `risk_level`, `weight`, `parameters` (JSON), `exclusions` (JSON), `is_active`. This table is the live source of truth for engine behaviour; Python defaults are only used on first install or for missing keys.

Tables are auto-created on startup (`CaseManagementBase.metadata.create_all`) and rules are seeded if the table is empty (`seed_fraud_rules.run_seed_if_table_empty`).

---

## 6. The detection engine

Entry point: `run_analysis(connection_string, settings)` in `backend_v2/engine/fraud_engine.py`.

### 6.1 Execution flow

1. **Connect + probe** the source DB (`SELECT 1`); fail fast on connection errors.
2. **Resolve rule configuration** into `settings`:
   - If the caller passed a prebuilt `rules` list, merge it (`merge_fraud_configs_into_settings_core`).
   - Otherwise load persisted rows from `fraud_rule_configs` (`fraud_rule_db_loader`).
   - Otherwise fall back to Python schema defaults (`get_default_configs`).
3. **Evaluate each active rule** in turn (1 → 5). Each evaluator runs a single set-based SQL query against the warehouse, applies per-rule **exclusions**, and attaches a human-readable **reason** string (prefixed `Rule N`) onto a `PlayerCase` keyed by player code. Results are **persisted incrementally after each rule** (`_persist`).
4. **Finalize** all cases (`_finalize_cases`): de-duplicate/group reason fragments, compute `risk_score`, assign `category` and `tag`.
5. **Enrich** with a unified player profile (`_bulk_update_unified_profile`) — financial and poker KPIs in bulk.
6. **Filter** out cases with no reason, archive players newly excluded by settings, print a summary "verdict box", and return the case dicts. The caller (`upsert_cases`) writes them to the case DB.

Progress is reported with an ASCII progress bar + ETA per phase (`_step`) and emitted to the UI over Socket.IO (`scan_status`, `new_case_alert`).

### 6.2 The five rules

Rule metadata and defaults live in `fraud_rule_config_schema.py` (`FRAUD_RULES_META`); the SQL lives in `fraud_engine.py`.

| # | Name | Category | Core logic (default thresholds) |
|---|------|----------|----------------------------------|
| **1** | Cash margin — new account | Chip Dumping | Per player: cash margin = `Σ(Total profit/loss) ÷ Σ(Total bets) × 100` from `Primary_Cash_table_session_summary`. Flags when margin ≥ **50%** and Σ bets ≥ **100**. |
| **2** | Major income — % Win spike (new account) | New Account High Win | On `Primary_Major_income_sessions`, flags accounts **≤ 2 days** old (signup from account table) where a session `"% Win"` > **500%** and `Win` ≥ **50**. |
| **3** | Common games — Twister overlap | Common Games | On `Primary_SNG_Twister_and_MTT` filtered to **Twister**, counts shared distinct tournament codes per player pair; flags when shared ≥ **5** and **both** players' overlap % ≥ **30%**. |
| **4** | Common games — MTT overlap | Common Games | As Rule 3 but **MTT**; flags when shared ≥ **5** and **either** player's overlap % ≥ **30%**. |
| **5** | Common games — SNG overlap | Common Games | As Rule 3 but **SNG**; flags when shared ≥ **5** and **either** player's overlap % ≥ **30%**. |

Rules 3–5 share one implementation (`_evaluate_rule_common_overlap`); the `require_both_overlap_pct` flag distinguishes Rule 3 (both) from Rules 4–5 (either). Overlap % is `shared ÷ that player's distinct tournaments in the format × 100`.

### 6.3 Exclusions (noise filters)

Each rule supports advanced exclusions (`_should_exclude_player`), validated by the `RuleExclusions` pydantic model and stored as JSON. A player is skipped for a rule if they fall **outside/inside** configured bands, including:

- Lifetime floors: `min_lifetime_hands`, `min_lifetime_net_profit`, `min_lifetime_roi_pct`
- Ranges (from/to): `roi_range`, `profit_range`, `total_hands_range`, `win_rate_range`, `rake_range`
- Floors: `rake_floor`, `fee_floor`, `min_hands`

Lifetime stats used for exclusion come from the in-run case data or a `player_totals` aggregate (`_get_player_lifetime_stats`).

### 6.4 Scoring

Scoring is performed in `_finalize_cases` → `_score_rule`:

- Each case's `reason` string is parsed for `Rule N` labels.
- For each distinct rule that fired, the rule's **`weight`** (from `fraud_rule_configs`, default **35.0** per rule) is **added once** to `risk_score`. (Multiple hits of the same rule do **not** stack; `_score_rule` returns the weight when count > 0.)
- A rule with **weight 0** is treated as **informational only** — it does not contribute score and tags the case `INFO_R{n}` instead of opening it on its own.
- `caseTriggerScore` (default **100**) is the threshold used for "at/above trigger" reporting and UI triage. With three default-weight (35) rules, a player needs roughly all three to clear 100.

> Note: `upsert_cases` persists every case that has a non-empty reason; the trigger score is primarily a triage/reporting lens rather than a hard persistence gate.

### 6.5 Categories and tags

Cases are bucketed into **master categories** (`MASTER_CATEGORIES`): `Chip Dumping`, `New Account High Win`, `Common Games`, `General`. Category is derived from the rule(s) in the reason string (`_category_from_reason_and_rules`) with a fixed tab priority. Tags (e.g. `CASH_MARGIN_NEW`, `MAJOR_PCT_WIN`, `INFO_R{n}`) are set per rule for filtering.

### 6.6 Persistence (`upsert_cases`)

- Writes to the case DB in batches (periodic commits).
- **De-duplicates by open case**: if an `Open` case already exists for the same nickname, the new reason fragments are merged into `triggered_scenarios` (dedup by `\n\n`-separated chunks) and KPIs refreshed, rather than creating a duplicate.
- Players newly excluded by settings changes are moved to status **`Closed - Filtered`** (`archive_cases_for_excluded`).

---

## 7. REST and Socket.IO APIs

### 7.1 Fraud service (`routes_fraud.py`, port 5001)

| Method & path | Purpose |
|---------------|---------|
| `POST /api/collusion/analyze` | Run analysis with supplied/merged settings |
| `POST /api/collusion/scan/trigger` | Trigger a scan |
| `GET /api/collusion/cases` | List cases (triage) |
| `POST /api/collusion/cases` | Create a case |
| `GET/PUT /api/collusion/cases/<id>` | Read/update a case |
| `GET/POST /api/collusion/cases/<id>/notes` | Case notes |
| `GET /api/player/<player_code>` | Full player investigation profile |
| `GET /api/cases/<player_code>/chart-data` | Chart series for a player |
| `POST /api/player/<player_code>/live-report` | Fetch a live Playtech report |
| `POST/GET /api/cases/<id>/attachments` (+ download) | Case attachments |
| `GET/PUT /api/collusion/fraud-rule-configs` | Read/update per-rule configs |
| `GET/PUT /api/collusion/rule-settings` | Read/update global rule settings |
| `GET/POST /api/rules`, `GET/PUT /api/settings` | Rule/settings helpers |

**Socket.IO events:** client emits `run_manual_scan`; server emits `scan_status` (`started`/`finished`/`error`), `new_case_alert`, `scan_error`.

### 7.2 Reports service (`routes_reports.py`, port 5000)

Report running and streaming (`/api/run`, `/api/run/stream`), scheduler status/stream, report-viewer run/schema, **profiles → report-lists → reports** CRUD, CSV import (`/api/report-lists/<id>/import-csv`, `/api/import-csv-to-db`), and **ops dashboard metrics** (`/api/ops-dashboard/metrics`, backed by `ops_dashboard.py`).

The scheduler loop (`report_manager.scheduler_loop`) runs in a daemon thread started at import time. CSV ingestion infers PostgreSQL column types from pandas and dedupes rows via `EXCEPT`-based inserts (dropping legacy `uniq_*` constraints first).

---

## 8. Frontend (`src/`)

Single-page React app (`App.jsx`) with two top-level tabs:

- **Case manager** → `Workspace/TriageDashboard.jsx` — case table with category tabs, risk scores, and live Socket.IO updates. Clicking a case opens the investigation modal.
- **Fraud rule configuration** → `Settings/FraudRuleConfigPage.jsx` → `RuleSettings.jsx` / `EngineConfigAccordion.jsx` — per-rule weights, parameters, exclusions, and the global **Minimum case score** (`caseTriggerScore`).

The **investigation workspace** (`Investigation/CaseWorkspace.jsx`, the largest component) shows player profile, KPIs, financial and performance charts (`FinancialChart`, `PerformanceTrendChart`, `CollusionInsightCharts`), network/sessions (`NetworkAndSessions`, `HardwareTwins`), notes, and attachments. An `ErrorBoundary` wraps the modal.

The build is produced by Vite into `static/dist/` and served via `templates/index.html` from the fraud service.

---

## 9. Configuration and deployment

**Environment variables** (via `.env`, loaded by `config.py`): the three DB URLs, `PORT_FRAUD`/`PORT_REPORTS`, `REPORTS_SERVICE_URL`, `ATTACHMENTS_UPLOAD_ROOT`, and Playtech credentials/base URL.

**Run (Windows quick start):** `backend_v2\Launch.bat` from the repo root seeds rules, builds the frontend if needed, and starts the dev servers + APIs.

**Run (manual):**
```bash
# Backend
python -m backend_v2.service_fraud      # http://localhost:5001
python -m backend_v2.service_reports    # http://localhost:5000

# Frontend
npm install && npm run build            # → static/dist/
npm run dev                             # Vite dev server
```

**Packaging:** PyInstaller is a dependency; when frozen (`sys.frozen`), services bind to `127.0.0.1` and disable debug.

**Operational note:** the Werkzeug stat-reloader is disabled by default in `service_fraud.py` because a mid-scan restart aborts multi-minute scans; opt in with `FRAUD_ENGINE_RELOADER=1` only while actively editing Python.

---

## 10. End-to-end data flow (scan)

```mermaid
sequenceDiagram
    participant A as Analyst (UI)
    participant F as Fraud service
    participant E as fraud_engine
    participant W as Warehouse (Primary_*)
    participant C as Case DB

    A->>F: run_manual_scan / POST scan trigger
    F->>F: acquire scan_lock, SCAN_IN_PROGRESS=true
    F->>E: run_analysis(conn, settings)
    E->>C: load fraud_rule_configs (merge defaults)
    loop Rules 1..5 (active only)
        E->>W: rule SQL query
        W-->>E: candidate rows
        E->>E: apply exclusions, build reasons
        E->>C: persist after rule
    end
    E->>E: _finalize_cases (score, category, tag)
    E->>W: bulk profile enrichment
    E->>C: upsert_cases (dedup open cases)
    E-->>F: case dicts + summary
    F-->>A: scan_status finished, new_case_alert
    A->>F: GET /api/collusion/cases
    F-->>A: cases for triage
```

---

## 11. Strengths

- **Clean separation** of concerns: config, DB engine cache, models, engine, API, and frontend are well-modularised under `backend_v2/`.
- **Set-based SQL** per rule (no per-player loops in the DB), with incremental persistence so partial results survive a crash mid-scan.
- **Config-driven rules**: weights, parameters, exclusions, and active flags live in the DB and are editable from the UI; defaults are only a first-install fallback.
- **Extensible by design**: adding a rule = extend `FRAUD_RULES_META` + add `_evaluate_ruleN_*` + a branch in `run_analysis`; shared scoring/category/tag plumbing is already multi-rule.
- **Safe-by-default operations**: password redaction in logs, reloader disabled during scans, scan locking.

---

## 12. Known gaps and observations

These are flagged for the technical/audit audience; none block operation but several are worth addressing.

1. **Documentation drift (high priority for an audit).** Several `docs/` files still describe a **single rule** ("Rule 1 — Burner / New Pro Accounts") — e.g. `FRAUD_RULES_EXECUTION_FLOW.md`, `FRAUD_PRESETS_AND_SCORING.md`, `KEY_FILES_REFERENCE.md`, `ROI_METRICS.md`. The **code implements five rules** with different definitions (Rule 1 is now "cash margin", not "burner"). Treat this report / the code as authoritative and refresh those docs.
2. **Hard-coded credentials in source.** `config.py` ships **default DB credentials** (`postgres:Cookies01!`) and **default Playtech credentials** (`PRReports` / a literal password). These should be removed from source and required via environment/secrets, especially before any external distribution or packaging.
3. **Single database instance by default.** Source warehouse and case DB default to the same PostgreSQL instance. For production, separate them (and apply least-privilege: the engine only needs read on `Primary_*` and write on case tables).
4. **Legacy stack still present.** `app.py` / `api.py` / `processor.py` remain only because `routes_reports.py` imports `_run_reports_impl` from `app.py`. Migrating that into `backend_v2` would let the legacy files be deleted (see `docs/PROJECT_LAYOUT.md` "optional next cleanup").
5. **Open CORS.** Both services use permissive CORS (`*`) and Socket.IO `cors_allowed_origins="*"`. Acceptable for localhost dev; lock down for any networked deployment.
6. **Nickname-based case de-duplication.** `upsert_cases` merges into an existing **Open** case matched by **nickname**; if two distinct players share a nickname this could merge cases. Player code is the unique key on the table, so this is worth reviewing.
7. **Mixed local stores.** `data/gi_cases.db` (SQLite) and `data/app_data.json` exist alongside PostgreSQL; confirm which are authoritative vs dev leftovers.
8. **Test coverage is thin.** Only `backend_v2/tests/test_fraud_rule_config_merge.py` is present; the rule SQL, scoring, and exclusion logic have no automated tests.

---

## 13. Suggested next steps

| Priority | Action |
|----------|--------|
| High | Refresh `docs/` to the 5-rule reality; make this report the canonical overview |
| High | Move credentials out of `config.py` into env/secret management |
| Medium | Split source vs case databases; apply least-privilege DB roles |
| Medium | Add unit/integration tests for rule SQL, scoring, and exclusions |
| Medium | Review nickname-based open-case merge in `upsert_cases` |
| Low | Complete the `_run_reports_impl` migration and remove legacy root files |
| Low | Restrict CORS / Socket.IO origins for non-local deployments |

---

### Key source references

- Engine: `backend_v2/engine/fraud_engine.py` — `run_analysis`, `_evaluate_rule1_burner`, `_evaluate_rule2_major_income`, `_evaluate_rule_common_overlap`, `_finalize_cases`, `upsert_cases`
- Rules/defaults: `backend_v2/engine/fraud_rule_config_schema.py` — `FRAUD_RULES_META`, `RuleExclusions`, `get_default_configs`
- Services: `backend_v2/service_fraud.py`, `backend_v2/service_reports.py`
- API: `backend_v2/api/routes_fraud.py`, `backend_v2/api/routes_reports.py`, `backend_v2/api/ops_dashboard.py`
- Models/DB/config: `backend_v2/models/case_models.py`, `backend_v2/database.py`, `backend_v2/config.py`
- Frontend: `src/App.jsx`, `src/Workspace/TriageDashboard.jsx`, `src/Investigation/CaseWorkspace.jsx`, `src/Settings/RuleSettings.jsx`
