# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1 — Build the Vite/React frontend into static/dist
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim AS frontend
WORKDIR /app

# Install JS deps using the lockfile for reproducible builds.
COPY package.json package-lock.json ./
RUN npm ci

# Everything Vite needs to produce static/dist/assets/main.js
COPY vite.config.js ./
COPY src ./src
RUN npm run build


# ---------------------------------------------------------------------------
# Stage 2 — Python runtime serving both Flask services
# ---------------------------------------------------------------------------
FROM python:3.12-slim-bookworm AS runtime

# System packages:
#   - build-essential + unixodbc-dev: needed to compile pyodbc
#   - libpq5: PostgreSQL client lib used by psycopg2
#   - curl: used by the compose healthchecks
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        unixodbc-dev \
        libpq5 \
        curl \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Install Python deps first so they stay cached across code changes.
COPY requirements.txt ./
RUN pip install --upgrade pip && pip install -r requirements.txt

# Application source.
COPY backend_v2 ./backend_v2
COPY templates ./templates
COPY static ./static
COPY scripts ./scripts

# Pull in the compiled frontend from the build stage.
COPY --from=frontend /app/static/dist ./static/dist

# Writable runtime dirs (case attachments, local state). These are also
# mounted as volumes in docker-compose so data survives container restarts.
RUN mkdir -p uploads/attachments data

# Fraud UI / Socket.IO service and Reports API.
EXPOSE 5001 5000

# Default to the Fraud Engine UI service; docker-compose overrides the
# command for the reports container.
CMD ["python", "-m", "backend_v2.service_fraud"]
