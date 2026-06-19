# Fraud Engine 2026

Collusion / fraud detection stack: **Vite + React** UI, **Flask + Socket.IO** backend, PostgreSQL.

## Canonical backend (use this)

- **Package**: `backend_v2/`
- **Fraud service**: `python -m backend_v2.service_fraud` → http://localhost:5001  
- **Reports service**: `python -m backend_v2.service_reports` → http://localhost:5000  
- **Engine & rules**: `backend_v2/services/fraud_engine.py`  
- **REST + rule APIs**: `backend_v2/api/routes_fraud.py`  

**Windows quick start:** from repo root, run `backend_v2\Launch.bat` (seeds rules safely, builds frontend if needed, starts dev + APIs).

## Docker quick start (any OS / dev VM)

Runs the whole stack — Postgres, fraud service, reports service — in containers. No local Python/Node needed, just Docker.

```bash
cp .env.dist .env                # then edit .env and set POSTGRES_PASSWORD + DEFAULT_DB_CONNECTION
docker compose up --build
```

Then open:

- **Fraud Engine UI**: http://localhost:5001
- **Reports API**: http://localhost:5000
- **Postgres**: `localhost:5432` (user `postgres`, db `game_integrity`)

Useful commands:

- `docker compose up --build -d` — run detached
- `docker compose logs -f fraud` — tail a service's logs
- `docker compose down` — stop; add `-v` to also wipe the Postgres volume

How it fits together: a multi-stage `Dockerfile` builds the Vite/React frontend, then bakes it into a Python image. Both the `fraud` and `reports` services share that image (different start commands). DB connection URLs, ports, and Playtech credentials are all set via `.env` (copy `.env.dist` and fill it in — no secrets are committed to the repo).

> **Note on remote VMs:** the Reports tab calls `http://localhost:5000` from the browser (hardcoded in `static/app.js`). It works when you browse from the same machine running Docker (or via an SSH port-forward of 5000 and 5001). If you serve the UI from a remote VM and hit it by its IP/hostname, the Reports tab won't reach the reports API until that URL is made configurable.

## Publish & deploy (upload once, press a button)

The compose quick start above *builds* the image locally. For real deployments the image is **built once by CI and published**, then VMs just **pull and run** it.

**1. Publish (automatic):** `.github/workflows/docker-publish.yml` builds and pushes the image to GitHub Container Registry on every push to `main` (and on `v*` tags). You can also trigger it manually from the repo's **Actions → Build and publish Docker image → Run workflow** button. Published image:

```
ghcr.io/madcat060/fraud-engine-2026:latest
```

> First publish only: make sure GitHub Actions can write packages (repo **Settings → Actions → General → Workflow permissions → Read and write**). To let the VM pull without logging in, set the package visibility to **Public** (org/repo **Packages** settings), otherwise run `docker login ghcr.io` on the VM with a PAT that has `read:packages`.

**2. Deploy (press a button on the VM):**

```bash
cp .env.dist .env                # first time only — then set credentials
./deploy.sh                      # pull latest + restart
```

`deploy.sh` just runs `docker compose -f docker-compose.prod.yml pull && up -d`. `docker-compose.prod.yml` is identical to the dev compose except it pulls the published image instead of building. Override the image (e.g. pin a tag) with `FRAUD_IMAGE=ghcr.io/madcat060/fraud-engine-2026:<tag>` in `.env`.

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
