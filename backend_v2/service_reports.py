"""
backend_v2.service_reports
--------------------------

Entry point for the Reports / ingestion service.

* Creates a minimal Flask app with only report‑related APIs.
* Registers :mod:`backend_v2.api.routes_reports`.
* Starts the background scheduler loop from
  :mod:`backend_v2.services.report_manager`.
"""

from __future__ import annotations

import logging
import sys
import threading
from pathlib import Path

from flask import Flask
from flask_cors import CORS

from backend_v2.api.routes_reports import reports_bp
from backend_v2.config import PORT_REPORTS
from backend_v2.services.report_manager import scheduler_loop


def _get_resource_path() -> str:
    """
    Resolve the base path used for templates/static files.

    This mirrors the legacy layout where templates/ and static/ live at
    the project root, one level above backend_v2.
    """
    return str(Path(__file__).resolve().parents[1])


def create_app() -> Flask:
    resource_path = _get_resource_path()
    app = Flask(
        __name__,
        template_folder=str(Path(resource_path) / "templates"),
        static_folder=str(Path(resource_path) / "static"),
    )
    CORS(
        app,
        resources={
            r"/api/*": {
                "origins": "*",
                "methods": ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
                "allow_headers": ["Content-Type"],
            }
        },
    )
    app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
    app.register_blueprint(reports_bp)
    return app


app = create_app()


def _start_scheduler_thread() -> None:
    if not logging.root.handlers:
        logging.basicConfig(
            level=logging.INFO,
            format="%(levelname)s %(name)s: %(message)s",
        )
    t = threading.Thread(target=scheduler_loop, daemon=True)
    t.start()


_start_scheduler_thread()


if __name__ == "__main__":
    is_frozen = getattr(sys, "frozen", False)
    host = "127.0.0.1" if is_frozen else "0.0.0.0"
    port = PORT_REPORTS

    print(f"Reports service starting on {host}:{port} ...")
    # use_reloader=False: avoid restarts during report runs so /api/scheduler/stream
    # is not dropped ("connection to server lost" when watchdog restarts the process)
    app.run(host=host, port=port, debug=not is_frozen, use_reloader=False, threaded=True)

