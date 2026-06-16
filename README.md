# Fraud Engine 2026

Collusion / fraud detection stack: **Vite + React** UI, **Flask + Socket.IO** backend, PostgreSQL.

## Canonical backend (use this)

- **Package**: `backend_v2/`
- **Fraud service**: `python -m backend_v2.service_fraud` → http://localhost:5001  
- **Reports service**: `python -m backend_v2.service_reports` → http://localhost:5000  
- **Engine & rules**: `backend_v2/services/fraud_engine.py`  
- **REST + rule APIs**: `backend_v2/api/routes_fraud.py`  

**Windows quick start:** from repo root, run `backend_v2\Launch.bat` (seeds rules safely, builds frontend if needed, starts dev + APIs).

## Frontend

- **Source**: `src/` (React)
- **Build**: `npm install && npm run build` → `static/dist/`
- **Dev**: `npm run dev`
- **Templates**: `templates/index.html`, `templates/rules.html`

## Configuration

- Copy / edit `.env` (see `backend_v2/config.py` for variables): `DEFAULT_DB_CONNECTION`, `CASE_MANAGEMENT_URL`, `COLLUSION_DB_URL`, ports, etc.

## Project layout reference

See **`docs/PROJECT_LAYOUT.md`** for what is current vs legacy (`app.py`, `processor.py`, etc.) and why some root files still exist.

## Legacy note

Root-level **`app.py`**, **`api.py`**, **`processor.py`** are **not** the V2 fraud entrypoint. Reports in V2 run via `backend_v2/api/routes_reports.py` and include an internal fallback runner when `app.py` is absent. Do not start the V2 fraud app with `python app.py` unless you intentionally want the legacy stack.
