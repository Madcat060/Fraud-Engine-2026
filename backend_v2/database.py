"""
backend_v2.database
--------------------

Shared SQLAlchemy engine/cache and declarative base for the new modular
backend.  This module is intentionally small to avoid circular imports:

* Configuration lives in :mod:`backend_v2.config`.
* ORM models live in :mod:`backend_v2.models.*`.
* Application code (services, blueprints) should import engines and
  sessions from here rather than constructing ad‑hoc engines.
"""

from __future__ import annotations

import re
from typing import Dict, Optional

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker, Session

from .config import DEFAULT_DB_CONNECTION, CASE_MANAGEMENT_URL


class Base(DeclarativeBase):
    """Root declarative base for all SQLAlchemy models in backend_v2."""


_ENGINE_CACHE: Dict[str, Engine] = {}


def mask_connection_url(url: Optional[str]) -> str:
    """Redact password in SQLAlchemy-style URLs for console logs."""
    if not url:
        return "(not configured)"
    return re.sub(r"(://[^:]+:)[^@]+(@)", r"\1***\2", str(url), count=1)


def get_db_engine(connection_string: Optional[str] = None) -> Engine:
    """
    Return a cached SQLAlchemy :class:`Engine` for the given connection URL.

    Engines are created with ``future=True`` and ``pool_pre_ping=True`` so
    that stale connections are detected and re‑established automatically.
    """
    if connection_string is None:
        connection_string = DEFAULT_DB_CONNECTION

    if connection_string not in _ENGINE_CACHE:
        _ENGINE_CACHE[connection_string] = create_engine(
            connection_string,
            future=True,
            pool_pre_ping=True,
        )
    return _ENGINE_CACHE[connection_string]


def get_case_engine() -> Engine:
    """Engine bound to the case‑management database."""
    return get_db_engine(CASE_MANAGEMENT_URL)


SessionLocal = sessionmaker(
    bind=get_db_engine(),
    class_=Session,
    autoflush=False,
    autocommit=False,
)


__all__ = [
    "Base",
    "get_db_engine",
    "get_case_engine",
    "SessionLocal",
    "mask_connection_url",
]

