"""
Dump PostgreSQL column configuration for every public table named Primary*.

Uses COLLUSION_DB_URL from backend_v2.config (and .env when present).
Run from repo root:

  python -m backend_v2.scripts.dump_primary_table_configuration
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

# Repo root (parent of backend_v2/)
_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

import psycopg2
from psycopg2.extras import RealDictCursor

from backend_v2.config import COLLUSION_DB_URL


def _parse_pg_url(url: str) -> dict:
    raw = re.sub(r"^postgresql\+[^+]+://", "postgresql://", url.strip())
    from urllib.parse import urlparse

    u = urlparse(raw)
    if u.hostname is None:
        raise ValueError("Invalid database URL (no host)")
    return {
        "host": u.hostname,
        "port": u.port or 5432,
        "dbname": (u.path or "").lstrip("/") or "postgres",
        "user": u.username or "",
        "password": u.password or "",
    }


def _type_configuration(row: dict) -> str:
    """Single string describing how the column is defined in PostgreSQL."""
    dt = row["data_type"] or ""
    if dt == "USER-DEFINED":
        return row.get("udt_name") or dt
    if row.get("character_maximum_length") is not None:
        return f"{dt}({row['character_maximum_length']})"
    if row.get("numeric_precision") is not None:
        sc = row.get("numeric_scale")
        if sc is not None:
            return f"{dt}({row['numeric_precision']},{sc})"
        return f"{dt}({row['numeric_precision']})"
    if row.get("datetime_precision") is not None:
        return f"{dt}({row['datetime_precision']})"
    return dt


def main() -> None:
    kw = _parse_pg_url(COLLUSION_DB_URL)
    out_path = Path(__file__).resolve().parents[1] / "docs" / "primary_tables_db_configuration.md"

    conn = psycopg2.connect(**kw)
    cur = conn.cursor(cursor_factory=RealDictCursor)

    cur.execute(
        """
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name LIKE 'Primary%'
        ORDER BY table_name
        """
    )
    tables = [r["table_name"] for r in cur.fetchall()]

    lines: list[str] = []
    lines.append("# Primary* tables — database column configuration\n\n")
    lines.append(
        "Auto-generated from `information_schema.columns` (PostgreSQL). "
        "Each section is one **database table**; each **markdown table** is the full column configuration for that report.\n\n"
    )
    lines.append(f"**Database:** `{kw['dbname']}` · **Schema:** `public` · **Tables:** {len(tables)}\n\n")
    lines.append("---\n\n")

    for t in tables:
        cur.execute(
            """
            SELECT
                ordinal_position,
                column_name,
                data_type,
                udt_name,
                character_maximum_length,
                numeric_precision,
                numeric_scale,
                datetime_precision,
                is_nullable,
                column_default
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = %s
            ORDER BY ordinal_position
            """,
            (t,),
        )
        cols = cur.fetchall()
        lines.append(f"## `{t}`\n\n")
        lines.append("| Ord | Column name (exact) | PostgreSQL type | Nullable | Default |\n")
        lines.append("|-----|---------------------|-----------------|----------|--------|\n")
        for c in cols:
            typ = _type_configuration(dict(c))
            null = c["is_nullable"] or ""
            dflt = c["column_default"]
            if dflt is None or str(dflt).strip() == "":
                dflt_md = "—"
            else:
                dflt_md = str(dflt).replace("|", "\\|")
            name = str(c["column_name"]).replace("|", "\\|")
            lines.append(f"| {c['ordinal_position']} | `{name}` | {typ} | {null} | {dflt_md} |\n")
        lines.append("\n")

    lines.append("---\n\n")
    lines.append(
        "Regenerate: `python -m backend_v2.scripts.dump_primary_table_configuration`\n"
    )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("".join(lines), encoding="utf-8")
    print(f"Wrote {out_path} ({len(tables)} tables)")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
