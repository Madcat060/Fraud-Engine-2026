"""
backend_v2.config
------------------

Centralised configuration for the new modular backend.

All hard‑coded values from the legacy prototype (DB URLs, ports,
external API credentials, upload paths, etc.) are now expressed as
environment variables with sensible defaults so they can be overridden
per environment.  python-dotenv is used to load values from a local
`.env` file during development.
"""

import os
from pathlib import Path

from dotenv import load_dotenv


# Load environment variables from .env if present (development only).
_ROOT_DIR = Path(__file__).resolve().parents[1]
_ENV_PATH = _ROOT_DIR / ".env"
if _ENV_PATH.exists():
    load_dotenv(_ENV_PATH)
else:
    # Fallback to default behaviour (load from working directory) so
    # projects that already rely on this still work.
    load_dotenv()


# --- Database configuration -------------------------------------------------

# Shared game-integrity database connection used across the system.
DEFAULT_DB_CONNECTION: str = os.getenv(
    "DEFAULT_DB_CONNECTION",
    "postgresql+psycopg2://postgres:Cookies01!@localhost/game_integrity",
)

# Case management PostgreSQL database (investigation_cases, case_notes, etc.).
CASE_MANAGEMENT_URL: str = os.getenv(
    "CASE_MANAGEMENT_URL",
    DEFAULT_DB_CONNECTION,
)

# Collusion / fraud engine data warehouse connection (Major_income_sessionsV2, etc.).
COLLUSION_DB_URL: str = os.getenv(
    "COLLUSION_DB_URL",
    DEFAULT_DB_CONNECTION,
)


# --- Service ports and URLs -------------------------------------------------

# Fraud UI service (Socket.IO + React UI).
PORT_FRAUD: int = int(os.getenv("PORT_FRAUD", "5001"))

# Reports API / ingestion service.
PORT_REPORTS: int = int(os.getenv("PORT_REPORTS", "5000"))

# Base URL for the reports service as seen from the fraud UI.
REPORTS_SERVICE_URL: str = os.getenv(
    "REPORTS_SERVICE_URL",
    f"http://127.0.0.1:{PORT_REPORTS}",
)


# --- File system paths ------------------------------------------------------

# Where case attachments are stored on disk.
ATTACHMENTS_UPLOAD_ROOT: str = os.getenv(
    "ATTACHMENTS_UPLOAD_ROOT",
    str(_ROOT_DIR / "uploads" / "attachments"),
)


# --- External report APIs ---------------------------------------------------

# Playtech report credentials & base URL used by the "live report" endpoint.
PLAYTECH_ADMIN_USER: str = os.getenv("PLAYTECH_ADMIN_USER", "PRReports")
PLAYTECH_ADMIN_PASSWORD: str = os.getenv("PLAYTECH_ADMIN_PASSWORD", "Password1234!")

PLAYTECH_BASE_URL: str = os.getenv(
    "PLAYTECH_BASE_URL",
    "https://pokerprivateapi.playtech.com/reports/report/get",
)


__all__ = [
    "DEFAULT_DB_CONNECTION",
    "CASE_MANAGEMENT_URL",
    "COLLUSION_DB_URL",
    "PORT_FRAUD",
    "PORT_REPORTS",
    "REPORTS_SERVICE_URL",
    "ATTACHMENTS_UPLOAD_ROOT",
    "PLAYTECH_ADMIN_USER",
    "PLAYTECH_ADMIN_PASSWORD",
    "PLAYTECH_BASE_URL",
]

