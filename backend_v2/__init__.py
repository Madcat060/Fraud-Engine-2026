"""
backend_v2
-----------

Modular backend for the Fraud Engine (rules, cases, scans) and the V2 Reports API.

**Fraud UI + collusion APIs:** use ``python -m backend_v2.service_fraud``.

Legacy monolith files at the repo root (``app.py``, ``api.py``, ``processor.py``) are
**not** this package; they remain only because ``routes_reports`` still imports
report-runner code from ``app.py``. See ``docs/PROJECT_LAYOUT.md``.
"""
