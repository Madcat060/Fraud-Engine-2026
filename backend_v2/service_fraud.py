"""
backend_v2.service_fraud
------------------------

Entry point for the Fraud UI / collusion detection service.

* Creates a Flask app bound to the React UI and fraud APIs.
* Registers the :mod:`backend_v2.api.routes_fraud` blueprint.
* Initialises Socket.IO.
"""

from __future__ import annotations

import os
import sys
import threading
from pathlib import Path
import logging

from flask import Flask, render_template
from flask_cors import CORS
from flask_socketio import SocketIO

from backend_v2.api.routes_fraud import fraud_bp
from backend_v2.config import CASE_MANAGEMENT_URL, COLLUSION_DB_URL, PORT_FRAUD, REPORTS_SERVICE_URL
from backend_v2.database import get_case_engine, mask_connection_url
from backend_v2.models.case_models import CaseManagementBase


# Silence Werkzeug HTTP request logging so only Fraud Engine progress is shown
logging.getLogger("werkzeug").setLevel(logging.ERROR)


# Global scan coordination for manual scans
scan_lock = threading.Lock()
SCAN_IN_PROGRESS = False


def _get_resource_path() -> str:
    """
    Resolve the base path used for templates/static files.

    This mirrors the behaviour of the legacy app: templates/ and
    static/ live at the project root.
    """
    return str(Path(__file__).resolve().parents[1])


def create_app() -> tuple[Flask, SocketIO]:
    """Create and configure the Fraud Flask app + Socket.IO instance."""
    resource_path = _get_resource_path()
    app = Flask(
        __name__,
        template_folder=os.path.join(resource_path, "templates"),
        static_folder=os.path.join(resource_path, "static"),
    )
    CORS(app)
    app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
    app.config["COLLUSION_CONNECTION_STRING"] = COLLUSION_DB_URL
    app.config["REPORTS_SERVICE_URL"] = REPORTS_SERVICE_URL

    # Ensure case‑management tables exist.
    try:
        engine = get_case_engine()
        CaseManagementBase.metadata.create_all(engine)
        try:
            from backend_v2.scripts.seed_fraud_rules import run_seed_if_table_empty

            run_seed_if_table_empty()
        except Exception as seed_exc:
            print(f"[Fraud Engine] fraud_rule_configs seed skipped: {seed_exc}")
        print(
            f"[Fraud Engine] Case DB ready: {mask_connection_url(CASE_MANAGEMENT_URL)}"
        )
    except Exception as exc:
        print(
            f"[Fraud Engine] Case DB init failed ({mask_connection_url(CASE_MANAGEMENT_URL)}): {exc}"
        )

    app.register_blueprint(fraud_bp)

    @app.route("/")
    def index():
        """Serve the React UI entrypoint."""
        return render_template("index.html")

    @app.route("/rules")
    def rules_page():
        """Fraud rule UI is the React app (RuleSettings); same shell as / so /rules can deep-link."""
        return render_template("index.html")

    try:
        socketio = SocketIO(
            app,
            cors_allowed_origins="*",
            async_mode="threading",
            logger=False,
            engineio_logger=False,
        )
    except ValueError:
        socketio = SocketIO(
            app,
            cors_allowed_origins="*",
            logger=False,
            engineio_logger=False,
        )

    @socketio.on("connect")
    def handle_connect(auth):
        """Handle Socket.IO client connection."""
        from flask import request
        # Only log if in debug mode or if there are connection issues
        # Normal connections/disconnections are expected behavior
        return True

    @socketio.on("disconnect")
    def handle_disconnect():
        """Handle Socket.IO client disconnection."""
        # Normal disconnections (page refresh, tab close) don't need logging
        pass

    def _collusion_scan_job(socketio_instance, flask_app, lock, scan_days=90):
        """
        Background collusion scan job, executed within a proper app context.
        """
        from backend_v2.engine.fraud_engine import run_analysis, upsert_cases
        from backend_v2.config import COLLUSION_DB_URL
        from backend_v2.api.routes_fraud import (
            DEFAULT_SETTINGS,
            _collusion_get_fraud_rule_configs,
            _collusion_get_rule_settings,
            _merge_fraud_rule_configs_into_settings,
        )

        global SCAN_IN_PROGRESS
        with flask_app.app_context():
            try:
                with lock:
                    SCAN_IN_PROGRESS = True
                    print(
                        f"[Fraud Engine] Manual scan started (lookback {scan_days}d) → "
                        f"source {mask_connection_url(COLLUSION_DB_URL)}"
                    )
                    socketio_instance.emit(
                        "scan_status",
                        {"status": "started", "message": "Engine warming up..."},
                    )
                    # 1. Same settings shape as POST /api/collusion/analyze (rules + merged configs).
                    settings = _collusion_get_rule_settings() or dict(DEFAULT_SETTINGS)
                    configs = _collusion_get_fraud_rule_configs()
                    _merge_fraud_rule_configs_into_settings(configs, settings)
                    settings["lookbackDays"] = scan_days
                    settings["major_sessions_lookback_days"] = scan_days

                    conn_str = flask_app.config.get("COLLUSION_CONNECTION_STRING") or COLLUSION_DB_URL
                    if not conn_str:
                        raise RuntimeError("Collusion DB URL not configured")

                    # 2. Run the analysis (progress: tqdm in fraud_engine.run_analysis)
                    cases = run_analysis(conn_str, settings=settings)

                    # 4. Save results (Upsert logic)
                    print(
                        f"[Fraud Engine] Upserting to case DB: {mask_connection_url(CASE_MANAGEMENT_URL)}"
                    )
                    count = upsert_cases(cases)
                    print(
                        f"[Fraud Engine] Analysis complete: {len(cases)} case dict(s) returned; "
                        f"{count} row(s) upserted."
                    )

                    socketio_instance.emit(
                        "scan_status",
                        {"status": "finished", "count": len(cases)},
                    )
                    socketio_instance.emit("new_case_alert", {"count": len(cases)})
            except Exception as e:
                print(f"[Fraud Engine] CRASH: {str(e)}")
                socketio_instance.emit(
                    "scan_status", {"status": "error", "message": str(e)}
                )
            finally:
                SCAN_IN_PROGRESS = False

    @socketio.on("run_manual_scan")
    def handle_run_manual_scan():
        """Socket.IO handler to trigger a manual collusion scan."""
        global SCAN_IN_PROGRESS
        if SCAN_IN_PROGRESS or scan_lock.locked():
            socketio.emit("scan_error", {"error": "Scan already running."})
            return

        socketio.start_background_task(_collusion_scan_job, socketio, app, scan_lock)

    return app, socketio


app, socketio = create_app()


if __name__ == "__main__":
    is_frozen = getattr(sys, "frozen", False)
    host = "127.0.0.1" if is_frozen else "0.0.0.0"
    port = PORT_FRAUD

    if os.name == "nt":
        os.system("title Fraud Engine")

    is_reloader_child = os.environ.get("WERKZEUG_RUN_MAIN") == "true"
    if is_frozen or is_reloader_child:
        print(f"Fraud Detection service starting on {host}:{port} ...")

    # Werkzeug's stat reloader restarts the process when any .py file changes — that kills
    # multi-minute collusion scans mid-rule (looks like a "reset"). Disable by default; opt in
    # with FRAUD_ENGINE_RELOADER=1 when actively editing Python and accepting scan interruption.
    use_reloader = (
        not is_frozen
        and os.environ.get("FRAUD_ENGINE_RELOADER", "").strip().lower() in ("1", "true", "yes")
    )
    socketio.run(
        app,
        host=host,
        port=port,
        debug=not is_frozen,
        use_reloader=use_reloader,
    )

