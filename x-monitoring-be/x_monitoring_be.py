"""
Monitoring Backend — entry point.

Initializes the Flask application, registers routes, and starts the server.
The core logic lives in the app/ package (SRP-compliant modules).
"""
from __future__ import annotations

import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, jsonify, request
from flask_cors import CORS
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from pydantic import ValidationError
from werkzeug.exceptions import HTTPException

load_dotenv()

from app.auth import (
    LoginRequest,
    create_jwt_token,
    get_env,
    is_admin_username,
    require_admin,
    require_auth,
    verify_jwt_token,
)
from app.config import load_app_config
from app.exceptions import CachedEndpointError, SqlFileNotFoundError
from app.logging_setup import configure_logging, install_global_exception_hooks
from app.service import MonitoringBackend
from app.utils import get_client_ip, parse_enabled

# ── Resolve paths ─────────────────────────────────────────────────────────────

import sys

def _resolve_base_dir() -> str:
    """Return the directory that holds config.json, sql/, and drivers/.

    - Dev mode  : directory of this .py file
    - onefile   : sys._MEIPASS  (temp extraction dir, all data bundled inside)
    - onedir    : directory of the exe  (config/sql/drivers live next to the exe,
                  NOT inside _internal/, so operators can edit them freely)
    """
    if getattr(sys, "frozen", False):
        # onedir: _MEIPASS points to _internal/ but our editable files sit beside the exe
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


BASE_DIR = _resolve_base_dir()
DEFAULT_CONFIG_PATH = os.environ.get(
    "MONITORING_CONFIG_PATH",
    os.path.join(BASE_DIR, "config.json"),
)

# ── Bootstrap ─────────────────────────────────────────────────────────────────

initial_config = load_app_config(DEFAULT_CONFIG_PATH)
configure_logging(initial_config.logging)

backend = MonitoringBackend(
    config_path=DEFAULT_CONFIG_PATH,
    logger=logging.getLogger("monitoring_backend"),
    initial_config=initial_config,
)
install_global_exception_hooks(backend.logger)

# ── Flask app factory ─────────────────────────────────────────────────────────

app = Flask(__name__)

CORS(
    app,
    resources={r"/*": {"origins": "*"}},
    supports_credentials=False,
    methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)

limiter = Limiter(
    app=app,
    key_func=get_remote_address,
    default_limits=[get_env("API_RATE_LIMIT", "100/minute")],
)

# ── Middleware ────────────────────────────────────────────────────────────────

from time import perf_counter as _request_perf_counter
from flask import g as _flask_g


@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    return response


@app.before_request
def handle_preflight():
    if request.method == "OPTIONS":
        return "", 204
    if backend.logger.isEnabledFor(logging.DEBUG):
        _flask_g._req_started = _request_perf_counter()
        backend.logger.debug(
            "HTTP request method=%s path=%s query=%s clientIp=%s",
            request.method, request.path, request.query_string.decode("utf-8", "replace"),
            get_client_ip(),
        )
    return None


@app.after_request
def log_request_completion(response):
    if backend.logger.isEnabledFor(logging.DEBUG):
        started = getattr(_flask_g, "_req_started", None)
        duration_ms = (
            int((_request_perf_counter() - started) * 1000) if started is not None else -1
        )
        backend.logger.debug(
            "HTTP response method=%s path=%s status=%s durationMs=%s clientIp=%s",
            request.method, request.path, response.status_code, duration_ms, get_client_ip(),
        )
    return response

# ── Auth routes ───────────────────────────────────────────────────────────────

@app.route("/auth/login", methods=["POST"])
@limiter.limit("10/minute")
def auth_login():
    try:
        payload = LoginRequest(**request.get_json(silent=True) or {})
    except ValidationError as e:
        return jsonify({"message": "Invalid request", "errors": e.errors()}), 400

    username = payload.username
    client_ip = get_client_ip()
    from app.auth import verify_login_credentials
    expected_username = (get_env("AUTH_USERNAME", "") or "").strip() or backend.config.auth_username
    expected_password = (get_env("AUTH_PASSWORD", "") or "").strip() or backend.config.auth_password

    backend.logger.info("Login attempt username=%s clientIp=%s", username, client_ip)

    if not verify_login_credentials(payload.username, payload.password, expected_username, expected_password):
        backend.logger.warning(
            "Login failed username=%s reason=invalid_credentials clientIp=%s", username, client_ip,
        )
        return jsonify({"message": "Invalid username or password"}), 401

    backend.logger.info("Login success username=%s clientIp=%s", username, client_ip)
    return jsonify({
        "token": create_jwt_token(username),
        "user": {
            "id": 1,
            "username": username,
            "role": "admin" if is_admin_username(username) else "user",
        },
    }), 200


@app.route("/auth/logout", methods=["POST"])
@require_auth
def auth_logout():
    backend.logger.info("Logout success clientIp=%s", get_client_ip())
    return jsonify({"message": "로그아웃 되었습니다"}), 200

# ── Dashboard routes ──────────────────────────────────────────────────────────

@app.route("/dashboard/endpoints", methods=["GET"])
@require_auth
def dashboard_endpoints():
    return jsonify(backend.list_endpoints()), 200


@app.route("/dashboard/sql-editor/endpoints", methods=["GET"])
@require_auth
@require_admin
def dashboard_sql_editor_endpoints():
    return jsonify(backend.list_sql_editable_endpoints()), 200


@app.route("/dashboard/cache/status", methods=["GET"])
@require_auth
def dashboard_cache_status():
    """Return per-endpoint cache health: refresh time, duration, row count, errors."""
    with backend.endpoint_cache_lock:
        snapshot = dict(backend.endpoint_cache)

    entries = []
    for api_id, entry in snapshot.items():
        api_cfg = backend.config.apis.get(api_id)
        conn    = backend.config.connections.get(entry.connection_id)
        entries.append({
            "apiId":                entry.api_id,
            "path":                 entry.path,
            "connectionId":         entry.connection_id,
            "dbType":               conn.db_type if conn else "unknown",
            "hasData":              entry.data is not None,
            "rowCount":             len(entry.data) if isinstance(entry.data, list) else (1 if entry.data is not None else 0),
            "updatedAt":            entry.updated_at,
            "lastRefreshStartedAt": entry.last_refresh_started_at,
            "lastDurationSec":      entry.last_duration_sec,
            "errorMessage":         entry.error_message,
            "errorDetail":          entry.error_detail,
            "isTimeout":            entry.is_timeout,
            "source":               entry.source,
        })

    healthy = sum(1 for e in entries if e["hasData"])
    return jsonify({
        "endpoints":    entries,
        "totalCount":   len(entries),
        "healthyCount": healthy,
    }), 200


@app.route("/dashboard/sql-editor/validation-rules", methods=["GET"])
@require_auth
@require_admin
def dashboard_sql_editor_validation_rules():
    return jsonify(backend.get_sql_validation_rules()), 200


@app.route("/dashboard/sql-editor/<api_id>", methods=["GET"])
@require_auth
@require_admin
def dashboard_sql_editor_get(api_id: str):
    try:
        payload = backend.get_sql_for_api(api_id)
    except KeyError:
        return jsonify({"message": "enabled api not found"}), 404
    except SqlFileNotFoundError as error:
        return jsonify({"message": str(error), "detail": error.sql_path}), 404
    return jsonify(payload), 200


@app.route("/dashboard/sql-editor/<api_id>", methods=["PUT"])
@require_auth
@require_admin
def dashboard_sql_editor_update(api_id: str):
    request_json = request.get_json(silent=True) or {}
    sql = request_json.get("sql")
    client_ip = get_client_ip()
    auth_header = request.headers.get("Authorization", "")
    token = auth_header[7:] if auth_header.startswith("Bearer ") else ""
    token_payload = verify_jwt_token(token) or {}
    actor = str(token_payload.get("username", "unknown"))

    try:
        result = backend.update_sql_for_api(api_id, str(sql or ""), actor, client_ip)
    except KeyError:
        return jsonify({"message": "enabled api not found"}), 404
    except SqlFileNotFoundError as error:
        return jsonify({"message": str(error), "detail": error.sql_path}), 404
    except ValueError as error:
        return jsonify({"message": str(error)}), 400
    return jsonify(result), 200


@app.route("/dashboard/db-health/connections", methods=["GET"])
@require_auth
def db_health_connections():
    """Return the list of configured DB connections (id, dbType, jdbcUrl)."""
    return jsonify({"connections": backend.list_db_connections()}), 200


@app.route("/dashboard/db-health/status", methods=["GET"])
@require_auth
def db_health_status():
    """Execute a diagnostic query for the given connection and category.

    Query params:
      connection_id  — required
      category       — required: slow_queries | tablespace | locks
      timeout_sec    — optional (default 10, max 60)
    """
    connection_id = (request.args.get("connection_id") or "").strip()
    category = (request.args.get("category") or "").strip()
    if not connection_id:
        return jsonify({"message": "connection_id is required"}), 400
    if category not in ("slow_queries", "tablespace", "locks"):
        return jsonify({"message": "category must be one of: slow_queries, tablespace, locks"}), 400
    try:
        timeout_sec = float(request.args.get("timeout_sec", "10"))
        timeout_sec = max(1.0, min(60.0, timeout_sec))
    except (TypeError, ValueError):
        timeout_sec = 10.0

    result = backend.get_db_health_data(connection_id, category, timeout_sec)
    return jsonify(result), 200


@app.route("/dashboard/config", methods=["GET", "PUT"])
@require_auth
@require_admin
def handle_config():
    """GET: return config.json content. PUT: write config.json and reload."""
    import json

    if request.method == "GET":
        config_path = backend.config_path
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                config_data = json.load(f)
            return jsonify(config_data), 200
        except FileNotFoundError:
            return jsonify({"message": "config.json not found"}), 404
        except Exception as e:
            return jsonify({"message": "failed to read config", "detail": str(e)}), 500

    # PUT
    client_ip = get_client_ip()
    config_data = request.get_json(silent=True)
    if not config_data or not isinstance(config_data, dict):
        return jsonify({"message": "invalid config JSON"}), 400

    config_path = backend.config_path
    try:
        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(config_data, f, indent=4, ensure_ascii=False)
        backend.logger.info("Config file updated by admin clientIp=%s", client_ip)
    except Exception as e:
        backend.logger.exception("Config write failed clientIp=%s", client_ip)
        return jsonify({"message": "failed to write config", "detail": str(e)}), 500

    try:
        backend.reload()
    except Exception as e:
        backend.logger.exception("Config reload after update failed clientIp=%s", client_ip)
        return jsonify({
            "message": "config saved but reload failed",
            "detail": str(e),
            "saved": True,
            "reloaded": False,
        }), 500

    backend.logger.info("Config updated and reloaded successfully clientIp=%s", client_ip)
    enabled_apis = [ep for ep in backend.config.apis.values() if ep.enabled]
    return jsonify({
        "message": "config updated and reloaded",
        "saved": True,
        "reloaded": True,
        "endpointCount": len(enabled_apis),
        "connectionCount": len(backend.config.connections),
    }), 200


@app.route("/dashboard/reload-config", methods=["POST"])
@require_auth
def reload_config():
    client_ip = get_client_ip()
    try:
        backend.reload()
    except Exception:
        backend.logger.exception("Config reload failed clientIp=%s", client_ip)
        return jsonify({"message": "config reload failed", "detail": "internal error"}), 500
    backend.logger.info("Config reload success clientIp=%s", client_ip)
    return jsonify({"message": "config reloaded", "endpointCount": len(backend.config.apis)}), 200


@app.route("/dashboard/cache/refresh", methods=["POST"])
@require_auth
def refresh_cached_endpoint():
    request_json = request.get_json(silent=True) or {}
    api_id = request_json.get("api_id")
    endpoint_value = request_json.get("endpoint")
    reset_connection = bool(request_json.get("reset_connection", False))
    client_ip = get_client_ip()

    endpoint = backend.resolve_endpoint_reference(
        api_id=str(api_id).strip() if api_id else None,
        endpoint_value=str(endpoint_value).strip() if endpoint_value else None,
    )

    if endpoint is None and (api_id or endpoint_value):
        return jsonify({"message": "enabled api not found"}), 404

    if endpoint is None:
        entries = backend.refresh_all_endpoint_caches(
            source="manual-refresh-all", client_ip=client_ip, reset_connection=reset_connection,
        )
        return jsonify({
            "message": "cache refresh completed",
            "refreshedCount": len(entries),
            "results": [
                {"apiId": e.api_id, "path": e.path, "ok": e.data is not None,
                 "message": e.error_message, "detail": e.error_detail}
                for e in entries
            ],
        }), 200

    entry = backend.refresh_endpoint_cache(
        endpoint, source="manual-refresh", client_ip=client_ip, reset_connection=reset_connection,
    )
    return jsonify({
        "message": "cache refresh completed",
        "apiId": entry.api_id,
        "path": entry.path,
        "ok": entry.data is not None,
        "errorMessage": entry.error_message,
        "errorDetail": entry.error_detail,
        "updatedAt": entry.updated_at,
        "durationSec": entry.last_duration_sec,
    }), 200

# ── Server resource monitoring ────────────────────────────────────────────────

@app.route("/dashboard/server-resources", methods=["POST"])
@require_auth
@limiter.limit("30/minute")
def server_resources():
    """Collect CPU, Memory, and Disk usage from a remote (or local) server.

    JSON body:
      os_type  — "windows" | "windows-ssh" | "linux-rhel8" | "linux-rhel7" | "linux-generic"
      host     — hostname/IP (optional; omit or "localhost" for this machine)
      username — SSH username (required for remote Linux)
      password — SSH password (required for remote Linux)
      port     — SSH port (default 22, for Linux) or WMI port (default 5985, for Windows)
    """
    import platform
    import subprocess

    body = request.get_json(silent=True) or {}
    os_type = str(body.get("os_type", "")).strip().lower()
    host = str(body.get("host", "localhost")).strip()
    username = str(body.get("username", "")).strip()
    password = str(body.get("password", "")).strip()
    domain = str(body.get("domain", "")).strip()
    ssh_port = int(body.get("port", 22))
    is_local = host in ("localhost", "127.0.0.1", "", platform.node())

    if not os_type:
        return jsonify({"message": "os_type is required (windows, windows-ssh, linux-ubuntu24, linux-rhel8, linux-rhel7, linux-generic)"}), 400

    def _run_local_cmd(cmd, shell=True):
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=15, shell=shell)
            return r.stdout.strip()
        except Exception as e:
            return f"ERROR: {e}"

    def _run_ssh_cmd(cmd):
        """Run a command on a remote Linux host via SSH using paramiko."""
        try:
            import paramiko
        except ImportError:
            return "ERROR: paramiko not installed (pip install paramiko)"
        client = None
        try:
            client = paramiko.SSHClient()
            client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            client.connect(host, port=ssh_port, username=username, password=password, timeout=10)
            _, stdout, _stderr = client.exec_command(cmd, timeout=10)
            return stdout.read().decode("utf-8", errors="replace").strip()
        except Exception as e:
            return f"ERROR: {e}"
        finally:
            if client is not None:
                try:
                    client.close()
                except Exception:
                    pass

    def run_cmd(cmd, shell=True):
        if is_local:
            return _run_local_cmd(cmd, shell=shell)
        if os_type.startswith("linux") or os_type == "windows-ssh":
            return _run_ssh_cmd(cmd if isinstance(cmd, str) else " ".join(cmd))
        # Remote Windows: use local WMI commands with /node
        return _run_local_cmd(cmd, shell=shell)

    def _ps_encoded(script):
        """Build a powershell -EncodedCommand string (Base64 UTF-16LE).
        This avoids quoting issues when cmd.exe is the default SSH shell."""
        import base64
        encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
        return f"powershell -NoProfile -EncodedCommand {encoded}"

    try:
        if os_type == "windows-ssh":
            # ── Windows via SSH (PowerShell) ─────────────────────────
            ssh_error = None
            cpu_raw = run_cmd(_ps_encoded(
                "(Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average"
            ))
            cpu_pct = None
            if "ERROR" in cpu_raw:
                ssh_error = cpu_raw
            else:
                for line in cpu_raw.splitlines():
                    line = line.strip()
                    if line:
                        try:
                            cpu_pct = float(line)
                            break
                        except ValueError:
                            pass

            mem_raw = run_cmd(_ps_encoded(
                "$o=Get-CimInstance Win32_OperatingSystem;"
                " 'TotalVisibleMemorySize='+$o.TotalVisibleMemorySize;"
                " 'FreePhysicalMemory='+$o.FreePhysicalMemory"
            ))
            mem_total_kb = mem_free_kb = None
            if "ERROR" in mem_raw:
                ssh_error = ssh_error or mem_raw
            else:
                for line in mem_raw.splitlines():
                    if "TotalVisibleMemorySize=" in line:
                        try:
                            mem_total_kb = float(line.split("=")[1].strip())
                        except (ValueError, IndexError):
                            pass
                    if "FreePhysicalMemory=" in line:
                        try:
                            mem_free_kb = float(line.split("=")[1].strip())
                        except (ValueError, IndexError):
                            pass

            mem_total_gb = round(mem_total_kb / 1048576, 2) if mem_total_kb else None
            mem_used_gb = round((mem_total_kb - mem_free_kb) / 1048576, 2) if mem_total_kb and mem_free_kb else None
            mem_pct = round((mem_total_kb - mem_free_kb) / mem_total_kb * 100, 1) if mem_total_kb and mem_free_kb else None

            disk_raw = run_cmd(_ps_encoded(
                "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3'"
                " | ForEach-Object { $_.DeviceID+','+$_.Size+','+$_.FreeSpace }"
            ))
            disks = []
            if "ERROR" in disk_raw:
                ssh_error = ssh_error or disk_raw
            else:
                for line in disk_raw.splitlines():
                    parts = [p.strip() for p in line.split(",")]
                    if len(parts) >= 3 and parts[0]:
                        try:
                            device_id = parts[0]
                            total_size = float(parts[1]) if parts[1] else 0
                            free_space = float(parts[2]) if parts[2] else 0
                            used = total_size - free_space
                            disks.append({
                                "mount": device_id,
                                "totalGb": round(total_size / 1073741824, 2),
                                "usedGb": round(used / 1073741824, 2),
                                "usedPct": round(used / total_size * 100, 1) if total_size > 0 else 0,
                            })
                        except (ValueError, IndexError):
                            pass

            return jsonify({
                "osType": "windows-ssh",
                "host": host,
                "cpu": {"usedPct": cpu_pct},
                "memory": {
                    "totalGb": mem_total_gb,
                    "usedGb": mem_used_gb,
                    "usedPct": mem_pct,
                },
                "disks": disks,
                "error": ssh_error,
            }), 200

        if os_type == "windows":
            # Build WMI credential args for remote Windows
            wmi_auth = ""
            if not is_local:
                if username:
                    user_str = f"{domain}\\{username}" if domain else username
                    wmi_auth = f' /user:"{user_str}" /password:"{password}"'

            # CPU
            if is_local:
                cpu_raw = run_cmd(
                    'wmic cpu get LoadPercentage /format:value'
                )
            else:
                cpu_raw = run_cmd(
                    f'wmic /node:"{host}"{wmi_auth} cpu get LoadPercentage /format:value'
                )
            cpu_pct = None
            for line in cpu_raw.splitlines():
                if "LoadPercentage=" in line:
                    try:
                        cpu_pct = float(line.split("=")[1].strip())
                    except (ValueError, IndexError):
                        pass

            # Memory
            if is_local:
                mem_raw = run_cmd(
                    'wmic OS get FreePhysicalMemory,TotalVisibleMemorySize /format:value'
                )
            else:
                mem_raw = run_cmd(
                    f'wmic /node:"{host}"{wmi_auth} OS get FreePhysicalMemory,TotalVisibleMemorySize /format:value'
                )
            mem_total_kb = mem_free_kb = None
            for line in mem_raw.splitlines():
                if "TotalVisibleMemorySize=" in line:
                    try:
                        mem_total_kb = float(line.split("=")[1].strip())
                    except (ValueError, IndexError):
                        pass
                if "FreePhysicalMemory=" in line:
                    try:
                        mem_free_kb = float(line.split("=")[1].strip())
                    except (ValueError, IndexError):
                        pass

            mem_total_gb = round(mem_total_kb / 1048576, 2) if mem_total_kb else None
            mem_used_gb = round((mem_total_kb - mem_free_kb) / 1048576, 2) if mem_total_kb and mem_free_kb else None
            mem_pct = round((mem_total_kb - mem_free_kb) / mem_total_kb * 100, 1) if mem_total_kb and mem_free_kb else None

            # Disk
            if is_local:
                disk_raw = run_cmd(
                    'wmic logicaldisk where "DriveType=3" get DeviceID,Size,FreeSpace /format:csv'
                )
            else:
                disk_raw = run_cmd(
                    f'wmic /node:"{host}"{wmi_auth} logicaldisk where "DriveType=3" get DeviceID,Size,FreeSpace /format:csv'
                )
            disks = []
            for line in disk_raw.splitlines():
                parts = [p.strip() for p in line.split(",")]
                if len(parts) >= 4 and parts[1] not in ("", "DeviceID"):
                    try:
                        device_id = parts[1]
                        free_space = float(parts[2]) if parts[2] else 0
                        total_size = float(parts[3]) if parts[3] else 0
                        used = total_size - free_space
                        disks.append({
                            "mount": device_id,
                            "totalGb": round(total_size / 1073741824, 2),
                            "usedGb": round(used / 1073741824, 2),
                            "usedPct": round(used / total_size * 100, 1) if total_size > 0 else 0,
                        })
                    except (ValueError, IndexError):
                        pass

            return jsonify({
                "osType": "windows",
                "host": host,
                "cpu": {"usedPct": cpu_pct},
                "memory": {
                    "totalGb": mem_total_gb,
                    "usedGb": mem_used_gb,
                    "usedPct": mem_pct,
                },
                "disks": disks,
                "error": None,
            }), 200

        # ── Linux ────────────────────────────────────────────────────────
        # Works for RHEL 8.3, RHEL 7, and generic Linux

        # CPU: use /proc/stat or top
        cpu_raw = run_cmd("top -bn1 | grep 'Cpu(s)' | head -1")
        cpu_pct = None
        if "ERROR" not in cpu_raw:
            try:
                # e.g. "%Cpu(s):  3.1 us,  1.2 sy, ..."  or  "Cpu(s):  3.1%us, ..."
                import re
                idle_match = re.search(r'(\d+\.?\d*)\s*(?:%?\s*)?id', cpu_raw)
                if idle_match:
                    cpu_pct = round(100.0 - float(idle_match.group(1)), 1)
            except Exception:
                pass

        # Memory: use /proc/meminfo (available on all Linux versions)
        mem_raw = run_cmd("cat /proc/meminfo")
        mem_total_kb = mem_available_kb = None
        if "ERROR" not in mem_raw:
            for line in mem_raw.splitlines():
                if line.startswith("MemTotal:"):
                    try:
                        mem_total_kb = float(line.split()[1])
                    except (ValueError, IndexError):
                        pass
                if line.startswith("MemAvailable:"):
                    try:
                        mem_available_kb = float(line.split()[1])
                    except (ValueError, IndexError):
                        pass

        mem_total_gb = round(mem_total_kb / 1048576, 2) if mem_total_kb else None
        mem_used_gb = round((mem_total_kb - (mem_available_kb or 0)) / 1048576, 2) if mem_total_kb else None
        mem_pct = round((mem_total_kb - (mem_available_kb or 0)) / mem_total_kb * 100, 1) if mem_total_kb else None

        # Disk: df command (universal)
        disk_raw = run_cmd("df -BG --output=target,size,used,pcent -x tmpfs -x devtmpfs 2>/dev/null || df -h")
        disks = []
        if "ERROR" not in disk_raw:
            for line in disk_raw.splitlines()[1:]:
                parts = line.split()
                if len(parts) >= 4:
                    try:
                        mount = parts[0]
                        total_gb = float(parts[1].replace("G", "").replace(",", "."))
                        used_gb = float(parts[2].replace("G", "").replace(",", "."))
                        used_pct_str = parts[3].replace("%", "")
                        used_pct = float(used_pct_str)
                        disks.append({
                            "mount": mount,
                            "totalGb": total_gb,
                            "usedGb": used_gb,
                            "usedPct": used_pct,
                        })
                    except (ValueError, IndexError):
                        pass

        return jsonify({
            "osType": os_type,
            "host": host,
            "cpu": {"usedPct": cpu_pct},
            "memory": {
                "totalGb": mem_total_gb,
                "usedGb": mem_used_gb,
                "usedPct": mem_pct,
            },
            "disks": disks,
            "error": None,
        }), 200

    except Exception as e:
        backend.logger.exception("Server resource collection failed host=%s", host)
        return jsonify({
            "osType": os_type,
            "host": host,
            "cpu": {"usedPct": None},
            "memory": {"totalGb": None, "usedGb": None, "usedPct": None},
            "disks": [],
            "error": str(e),
        }), 200


# ── Server resource monitoring (batch) ───────────────────────────────────────

@app.route("/dashboard/server-resources-batch", methods=["POST"])
@require_auth
@limiter.limit("30/minute")
def server_resources_batch():
    """Collect CPU, Memory, and Disk usage from multiple servers in one request.

    JSON body:
      servers — list of { os_type, host, username, password, port, domain }
    Returns:
      results — list of per-server results in the same order
    """
    import platform
    import subprocess

    body = request.get_json(silent=True) or {}
    servers = body.get("servers") or []
    if not isinstance(servers, list) or len(servers) == 0:
        return jsonify({"message": "servers array is required"}), 400
    if len(servers) > 50:
        return jsonify({"message": "too many servers (max 50)"}), 400

    results = []
    for srv in servers:
        os_type = str(srv.get("os_type", "")).strip().lower()
        host = str(srv.get("host", "localhost")).strip()
        username = str(srv.get("username", "")).strip()
        password = str(srv.get("password", "")).strip()
        domain = str(srv.get("domain", "")).strip()
        ssh_port = int(srv.get("port", 22))
        is_local = host in ("localhost", "127.0.0.1", "", platform.node())

        if not os_type:
            results.append({
                "osType": os_type, "host": host,
                "cpu": {"usedPct": None}, "memory": {"totalGb": None, "usedGb": None, "usedPct": None},
                "disks": [], "error": "os_type is required",
            })
            continue

        def _run_local_cmd(cmd, shell=True):
            try:
                r = subprocess.run(cmd, capture_output=True, text=True, timeout=15, shell=shell)
                return r.stdout.strip()
            except Exception as e:
                return f"ERROR: {e}"

        def _run_ssh_cmd(cmd):
            try:
                import paramiko
            except ImportError:
                return "ERROR: paramiko not installed (pip install paramiko)"
            client = None
            try:
                client = paramiko.SSHClient()
                client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
                client.connect(host, port=ssh_port, username=username, password=password, timeout=10)
                _, stdout, _stderr = client.exec_command(cmd, timeout=10)
                return stdout.read().decode("utf-8", errors="replace").strip()
            except Exception as e:
                return f"ERROR: {e}"
            finally:
                if client is not None:
                    try:
                        client.close()
                    except Exception:
                        pass

        def run_cmd(cmd, shell=True):
            if is_local:
                return _run_local_cmd(cmd, shell=shell)
            if os_type.startswith("linux") or os_type == "windows-ssh":
                return _run_ssh_cmd(cmd if isinstance(cmd, str) else " ".join(cmd))
            return _run_local_cmd(cmd, shell=shell)

        def _ps_encoded(script):
            import base64
            encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
            return f"powershell -NoProfile -EncodedCommand {encoded}"

        try:
            if os_type == "windows-ssh":
                # ── Windows via SSH (PowerShell) ─────────────────────
                ssh_error = None
                cpu_raw = run_cmd(_ps_encoded(
                    "(Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average"
                ))
                cpu_pct = None
                if "ERROR" in cpu_raw:
                    ssh_error = cpu_raw
                else:
                    for line in cpu_raw.splitlines():
                        line = line.strip()
                        if line:
                            try:
                                cpu_pct = float(line)
                                break
                            except ValueError:
                                pass

                mem_raw = run_cmd(_ps_encoded(
                    "$o=Get-CimInstance Win32_OperatingSystem;"
                    " 'TotalVisibleMemorySize='+$o.TotalVisibleMemorySize;"
                    " 'FreePhysicalMemory='+$o.FreePhysicalMemory"
                ))
                mem_total_kb = mem_free_kb = None
                if "ERROR" in mem_raw:
                    ssh_error = ssh_error or mem_raw
                else:
                    for line in mem_raw.splitlines():
                        if "TotalVisibleMemorySize=" in line:
                            try:
                                mem_total_kb = float(line.split("=")[1].strip())
                            except (ValueError, IndexError):
                                pass
                        if "FreePhysicalMemory=" in line:
                            try:
                                mem_free_kb = float(line.split("=")[1].strip())
                            except (ValueError, IndexError):
                                pass

                mem_total_gb = round(mem_total_kb / 1048576, 2) if mem_total_kb else None
                mem_used_gb = round((mem_total_kb - mem_free_kb) / 1048576, 2) if mem_total_kb and mem_free_kb else None
                mem_pct = round((mem_total_kb - mem_free_kb) / mem_total_kb * 100, 1) if mem_total_kb and mem_free_kb else None

                disk_raw = run_cmd(_ps_encoded(
                    "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3'"
                    " | ForEach-Object { $_.DeviceID+','+$_.Size+','+$_.FreeSpace }"
                ))
                disks = []
                if "ERROR" in disk_raw:
                    ssh_error = ssh_error or disk_raw
                else:
                    for line in disk_raw.splitlines():
                        parts = [p.strip() for p in line.split(",")]
                        if len(parts) >= 3 and parts[0]:
                            try:
                                device_id = parts[0]
                                total_size = float(parts[1]) if parts[1] else 0
                                free_space = float(parts[2]) if parts[2] else 0
                                used = total_size - free_space
                                disks.append({
                                    "mount": device_id,
                                    "totalGb": round(total_size / 1073741824, 2),
                                    "usedGb": round(used / 1073741824, 2),
                                    "usedPct": round(used / total_size * 100, 1) if total_size > 0 else 0,
                                })
                            except (ValueError, IndexError):
                                pass

                results.append({
                    "osType": "windows-ssh", "host": host,
                    "cpu": {"usedPct": cpu_pct},
                    "memory": {"totalGb": mem_total_gb, "usedGb": mem_used_gb, "usedPct": mem_pct},
                    "disks": disks, "error": ssh_error,
                })
                continue

            if os_type == "windows":
                # Build WMI credential args for remote Windows
                wmi_auth = ""
                if not is_local:
                    if username:
                        user_str = f"{domain}\\{username}" if domain else username
                        wmi_auth = f' /user:"{user_str}" /password:"{password}"'

                # CPU
                if is_local:
                    cpu_raw = run_cmd('wmic cpu get LoadPercentage /format:value')
                else:
                    cpu_raw = run_cmd(f'wmic /node:"{host}"{wmi_auth} cpu get LoadPercentage /format:value')
                cpu_pct = None
                for line in cpu_raw.splitlines():
                    if "LoadPercentage=" in line:
                        try:
                            cpu_pct = float(line.split("=")[1].strip())
                        except (ValueError, IndexError):
                            pass

                # Memory
                if is_local:
                    mem_raw = run_cmd('wmic OS get FreePhysicalMemory,TotalVisibleMemorySize /format:value')
                else:
                    mem_raw = run_cmd(f'wmic /node:"{host}"{wmi_auth} OS get FreePhysicalMemory,TotalVisibleMemorySize /format:value')
                mem_total_kb = mem_free_kb = None
                for line in mem_raw.splitlines():
                    if "TotalVisibleMemorySize=" in line:
                        try:
                            mem_total_kb = float(line.split("=")[1].strip())
                        except (ValueError, IndexError):
                            pass
                    if "FreePhysicalMemory=" in line:
                        try:
                            mem_free_kb = float(line.split("=")[1].strip())
                        except (ValueError, IndexError):
                            pass

                mem_total_gb = round(mem_total_kb / 1048576, 2) if mem_total_kb else None
                mem_used_gb = round((mem_total_kb - mem_free_kb) / 1048576, 2) if mem_total_kb and mem_free_kb else None
                mem_pct = round((mem_total_kb - mem_free_kb) / mem_total_kb * 100, 1) if mem_total_kb and mem_free_kb else None

                # Disk
                if is_local:
                    disk_raw = run_cmd('wmic logicaldisk where "DriveType=3" get DeviceID,Size,FreeSpace /format:csv')
                else:
                    disk_raw = run_cmd(f'wmic /node:"{host}"{wmi_auth} logicaldisk where "DriveType=3" get DeviceID,Size,FreeSpace /format:csv')
                disks = []
                for line in disk_raw.splitlines():
                    parts = [p.strip() for p in line.split(",")]
                    if len(parts) >= 4 and parts[1] not in ("", "DeviceID"):
                        try:
                            device_id = parts[1]
                            free_space = float(parts[2]) if parts[2] else 0
                            total_size = float(parts[3]) if parts[3] else 0
                            used = total_size - free_space
                            disks.append({
                                "mount": device_id,
                                "totalGb": round(total_size / 1073741824, 2),
                                "usedGb": round(used / 1073741824, 2),
                                "usedPct": round(used / total_size * 100, 1) if total_size > 0 else 0,
                            })
                        except (ValueError, IndexError):
                            pass

                results.append({
                    "osType": "windows", "host": host,
                    "cpu": {"usedPct": cpu_pct},
                    "memory": {"totalGb": mem_total_gb, "usedGb": mem_used_gb, "usedPct": mem_pct},
                    "disks": disks, "error": None,
                })
                continue

            # ── Linux ─────────────────────────────────────────────
            cpu_raw = run_cmd("top -bn1 | grep 'Cpu(s)' | head -1")
            cpu_pct = None
            if "ERROR" not in cpu_raw:
                try:
                    idle_match = re.search(r'(\d+\.?\d*)\s*(?:%?\s*)?id', cpu_raw)
                    if idle_match:
                        cpu_pct = round(100.0 - float(idle_match.group(1)), 1)
                except Exception:
                    pass

            mem_raw = run_cmd("cat /proc/meminfo")
            mem_total_kb = mem_available_kb = None
            if "ERROR" not in mem_raw:
                for line in mem_raw.splitlines():
                    if line.startswith("MemTotal:"):
                        try:
                            mem_total_kb = float(line.split()[1])
                        except (ValueError, IndexError):
                            pass
                    if line.startswith("MemAvailable:"):
                        try:
                            mem_available_kb = float(line.split()[1])
                        except (ValueError, IndexError):
                            pass

            mem_total_gb = round(mem_total_kb / 1048576, 2) if mem_total_kb else None
            mem_used_gb = round((mem_total_kb - (mem_available_kb or 0)) / 1048576, 2) if mem_total_kb else None
            mem_pct = round((mem_total_kb - (mem_available_kb or 0)) / mem_total_kb * 100, 1) if mem_total_kb else None

            disk_raw = run_cmd("df -BG --output=target,size,used,pcent -x tmpfs -x devtmpfs 2>/dev/null || df -h")
            disks = []
            if "ERROR" not in disk_raw:
                for line in disk_raw.splitlines()[1:]:
                    parts = line.split()
                    if len(parts) >= 4:
                        try:
                            mount = parts[0]
                            total_gb = float(parts[1].replace("G", "").replace(",", "."))
                            used_gb = float(parts[2].replace("G", "").replace(",", "."))
                            used_pct_str = parts[3].replace("%", "")
                            used_pct = float(used_pct_str)
                            disks.append({
                                "mount": mount, "totalGb": total_gb, "usedGb": used_gb, "usedPct": used_pct,
                            })
                        except (ValueError, IndexError):
                            pass

            results.append({
                "osType": os_type, "host": host,
                "cpu": {"usedPct": cpu_pct},
                "memory": {"totalGb": mem_total_gb, "usedGb": mem_used_gb, "usedPct": mem_pct},
                "disks": disks, "error": None,
            })

        except Exception as e:
            backend.logger.exception("Server resource collection failed host=%s", host)
            results.append({
                "osType": os_type, "host": host,
                "cpu": {"usedPct": None}, "memory": {"totalGb": None, "usedGb": None, "usedPct": None},
                "disks": [], "error": str(e),
            })

    return jsonify({"results": results}), 200


# ── Network test (Ping / Telnet) ──────────────────────────────────────────────

@app.route("/dashboard/network-test", methods=["POST"])
@require_auth
@limiter.limit("30/minute")
def network_test():
    """Run a ping or TCP-connect (telnet) test against a target host.

    JSON body:
      type   — "ping" | "telnet"
      host   — target hostname or IP
      port   — required for telnet (integer)
      count  — ping count (default 4, max 10)
      timeout — seconds (default 5, max 30)
    """
    import platform
    import socket
    import subprocess
    import time as _time

    body = request.get_json(silent=True) or {}
    test_type = str(body.get("type", "ping")).strip().lower()
    host = str(body.get("host", "")).strip()
    port = body.get("port")
    count = min(max(int(body.get("count", 4)), 1), 10)
    timeout = min(max(float(body.get("timeout", 5)), 1), 30)

    if not host:
        return jsonify({"message": "host is required"}), 400

    if test_type == "telnet":
        if port is None:
            return jsonify({"message": "port is required for telnet test"}), 400
        port = int(port)
        started = _time.monotonic()
        sock = None
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(timeout)
            result_code = sock.connect_ex((host, port))
            elapsed_ms = int((_time.monotonic() - started) * 1000)
            success = result_code == 0
            return jsonify({
                "type": "telnet",
                "host": host,
                "port": port,
                "success": success,
                "responseTimeMs": elapsed_ms,
                "message": "Connection successful" if success else f"Connection failed (code={result_code})",
            }), 200
        except socket.timeout:
            elapsed_ms = int((_time.monotonic() - started) * 1000)
            return jsonify({
                "type": "telnet",
                "host": host,
                "port": port,
                "success": False,
                "responseTimeMs": elapsed_ms,
                "message": f"Connection timed out ({timeout}s)",
            }), 200
        except Exception as e:
            elapsed_ms = int((_time.monotonic() - started) * 1000)
            return jsonify({
                "type": "telnet",
                "host": host,
                "port": port,
                "success": False,
                "responseTimeMs": elapsed_ms,
                "message": str(e),
            }), 200
        finally:
            if sock is not None:
                try:
                    sock.close()
                except Exception:
                    pass

    # Ping test
    is_windows = platform.system().lower() == "windows"
    ping_cmd = (
        ["ping", "-n", str(count), "-w", str(int(timeout * 1000)), host]
        if is_windows
        else ["ping", "-c", str(count), "-W", str(int(timeout)), host]
    )

    started = _time.monotonic()
    try:
        result = subprocess.run(
            ping_cmd,
            capture_output=True,
            text=True,
            timeout=timeout * count + 5,
        )
        elapsed_ms = int((_time.monotonic() - started) * 1000)
        output = result.stdout + result.stderr
        success = result.returncode == 0
        return jsonify({
            "type": "ping",
            "host": host,
            "count": count,
            "success": success,
            "responseTimeMs": elapsed_ms,
            "output": output.strip(),
            "message": "Ping successful" if success else "Ping failed",
        }), 200
    except subprocess.TimeoutExpired:
        elapsed_ms = int((_time.monotonic() - started) * 1000)
        return jsonify({
            "type": "ping",
            "host": host,
            "count": count,
            "success": False,
            "responseTimeMs": elapsed_ms,
            "output": "",
            "message": f"Ping timed out ({timeout * count + 5}s)",
        }), 200
    except Exception as e:
        elapsed_ms = int((_time.monotonic() - started) * 1000)
        return jsonify({
            "type": "ping",
            "host": host,
            "count": count,
            "success": False,
            "responseTimeMs": elapsed_ms,
            "output": "",
            "message": str(e),
        }), 200


# ── Network test batch (Ping / Telnet) ─────────────────��────────────────────

@app.route("/dashboard/network-test-batch", methods=["POST"])
@require_auth
@limiter.limit("30/minute")
def network_test_batch():
    """Run ping or TCP-connect tests for multiple targets in one request.

    JSON body:
      targets — list of { type, host, port, count, timeout }
    Returns:
      results — list of per-target results in the same order
    """
    import platform
    import socket
    import subprocess
    import time as _time

    body = request.get_json(silent=True) or {}
    targets = body.get("targets") or []
    if not isinstance(targets, list) or len(targets) == 0:
        return jsonify({"message": "targets array is required"}), 400
    if len(targets) > 50:
        return jsonify({"message": "too many targets (max 50)"}), 400

    results = []
    for tgt in targets:
        test_type = str(tgt.get("type", "ping")).strip().lower()
        t_host = str(tgt.get("host", "")).strip()
        t_port = tgt.get("port")
        t_count = min(max(int(tgt.get("count", 4)), 1), 10)
        t_timeout = min(max(float(tgt.get("timeout", 5)), 1), 30)

        if not t_host:
            results.append({"type": test_type, "host": "", "success": False, "responseTimeMs": 0, "message": "host is required"})
            continue

        if test_type == "telnet":
            if t_port is None:
                results.append({"type": "telnet", "host": t_host, "success": False, "responseTimeMs": 0, "message": "port is required for telnet test"})
                continue
            t_port = int(t_port)
            started = _time.monotonic()
            sock = None
            try:
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sock.settimeout(t_timeout)
                result_code = sock.connect_ex((t_host, t_port))
                elapsed_ms = int((_time.monotonic() - started) * 1000)
                success = result_code == 0
                results.append({
                    "type": "telnet", "host": t_host, "port": t_port,
                    "success": success, "responseTimeMs": elapsed_ms,
                    "message": "Connection successful" if success else f"Connection failed (code={result_code})",
                })
            except socket.timeout:
                elapsed_ms = int((_time.monotonic() - started) * 1000)
                results.append({
                    "type": "telnet", "host": t_host, "port": t_port,
                    "success": False, "responseTimeMs": elapsed_ms,
                    "message": f"Connection timed out ({t_timeout}s)",
                })
            except Exception as e:
                elapsed_ms = int((_time.monotonic() - started) * 1000)
                results.append({
                    "type": "telnet", "host": t_host, "port": t_port,
                    "success": False, "responseTimeMs": elapsed_ms,
                    "message": str(e),
                })
            finally:
                if sock is not None:
                    try:
                        sock.close()
                    except Exception:
                        pass
            continue

        # Ping test
        is_windows = platform.system().lower() == "windows"
        ping_cmd = (
            ["ping", "-n", str(t_count), "-w", str(int(t_timeout * 1000)), t_host]
            if is_windows
            else ["ping", "-c", str(t_count), "-W", str(int(t_timeout)), t_host]
        )
        started = _time.monotonic()
        try:
            result = subprocess.run(ping_cmd, capture_output=True, text=True, timeout=t_timeout * t_count + 5)
            elapsed_ms = int((_time.monotonic() - started) * 1000)
            output = result.stdout + result.stderr
            success = result.returncode == 0
            results.append({
                "type": "ping", "host": t_host, "count": t_count,
                "success": success, "responseTimeMs": elapsed_ms,
                "output": output.strip(),
                "message": "Ping successful" if success else "Ping failed",
            })
        except subprocess.TimeoutExpired:
            elapsed_ms = int((_time.monotonic() - started) * 1000)
            results.append({
                "type": "ping", "host": t_host, "count": t_count,
                "success": False, "responseTimeMs": elapsed_ms,
                "output": "", "message": f"Ping timed out ({t_timeout * t_count + 5}s)",
            })
        except Exception as e:
            elapsed_ms = int((_time.monotonic() - started) * 1000)
            results.append({
                "type": "ping", "host": t_host, "count": t_count,
                "success": False, "responseTimeMs": elapsed_ms,
                "output": "", "message": str(e),
            })

    return jsonify({"results": results}), 200


# ── Health-check proxy (CORS bypass for web mode) ────────────────────────────

@app.route("/dashboard/health-check-proxy", methods=["POST"])
@require_auth
@limiter.limit("60/minute")
def health_check_proxy():
    """Proxy an HTTP GET to an external URL and return the result.

    Used by the frontend status-list / health-check widgets when running
    in a browser (where CORS blocks direct cross-origin requests).
    """
    import time as _time
    import warnings as _warnings
    try:
        import requests as _requests
        from urllib3.exceptions import InsecureRequestWarning as _InsecureRequestWarning
    except ImportError:
        _requests = None

    request_json = request.get_json(silent=True) or {}
    target_url = str(request_json.get("url", "")).strip()
    timeout_sec = min(max(float(request_json.get("timeout", 10)), 1), 30)

    if not target_url:
        return jsonify({"message": "url is required"}), 400

    # Use stdlib if requests is not available
    if _requests is None:
        from urllib.request import urlopen, Request
        from urllib.error import HTTPError
        started = _time.monotonic()
        try:
            req = Request(target_url, method="GET")
            with urlopen(req, timeout=timeout_sec) as resp:
                body_bytes = resp.read(4096)
                elapsed_ms = int((_time.monotonic() - started) * 1000)
                try:
                    body = body_bytes.decode("utf-8")
                except Exception:
                    body = None
                return jsonify({
                    "ok": 200 <= resp.status < 400,
                    "httpStatus": resp.status,
                    "responseTimeMs": elapsed_ms,
                    "body": body,
                    "error": None,
                }), 200
        except HTTPError as e:
            elapsed_ms = int((_time.monotonic() - started) * 1000)
            return jsonify({
                "ok": False,
                "httpStatus": e.code,
                "responseTimeMs": elapsed_ms,
                "body": None,
                "error": str(e),
            }), 200
        except Exception as e:
            elapsed_ms = int((_time.monotonic() - started) * 1000)
            return jsonify({
                "ok": False,
                "httpStatus": None,
                "responseTimeMs": elapsed_ms,
                "body": None,
                "error": str(e),
            }), 200

    started = _time.monotonic()
    try:
        # `with` 블록으로 Response를 명시적으로 닫아 소켓/커넥션 풀 엔트리가
        # GC 시점까지 살아남는 것을 방지한다. (대량 호출 시 파일 핸들 누수 예방)
        with _warnings.catch_warnings():
            _warnings.filterwarnings("ignore", category=_InsecureRequestWarning)
            with _requests.get(
                target_url, timeout=timeout_sec, verify=False, allow_redirects=True, stream=False,
            ) as resp:
                elapsed_ms = int((_time.monotonic() - started) * 1000)
                try:
                    body = resp.text[:4096]
                except Exception:
                    body = None
                status_code = resp.status_code
        return jsonify({
            "ok": 200 <= status_code < 400,
            "httpStatus": status_code,
            "responseTimeMs": elapsed_ms,
            "body": body,
            "error": None,
        }), 200
    except Exception as e:
        elapsed_ms = int((_time.monotonic() - started) * 1000)
        return jsonify({
            "ok": False,
            "httpStatus": None,
            "responseTimeMs": elapsed_ms,
            "body": None,
            "error": str(e),
        }), 200


# ── Health-check proxy batch (CORS bypass for web mode) ─────────────────────

@app.route("/dashboard/health-check-proxy-batch", methods=["POST"])
@require_auth
@limiter.limit("30/minute")
def health_check_proxy_batch():
    """Proxy HTTP GET to multiple external URLs and return all results at once.

    JSON body:
      urls — list of { id, url, timeout }
    Returns:
      results — list of per-URL results in the same order
    """
    import time as _time
    import warnings as _warnings
    try:
        import requests as _requests
        from urllib3.exceptions import InsecureRequestWarning as _InsecureRequestWarning
    except ImportError:
        _requests = None

    body = request.get_json(silent=True) or {}
    urls = body.get("urls") or []
    if not isinstance(urls, list) or len(urls) == 0:
        return jsonify({"message": "urls array is required"}), 400
    if len(urls) > 50:
        return jsonify({"message": "too many urls (max 50)"}), 400

    results = []
    for item in urls:
        target_url = str(item.get("url", "")).strip()
        item_id = item.get("id", target_url)
        timeout_sec = min(max(float(item.get("timeout", 10)), 1), 30)

        if not target_url:
            results.append({"id": item_id, "ok": False, "httpStatus": None, "responseTimeMs": 0, "body": None, "error": "url is required"})
            continue

        if _requests is None:
            from urllib.request import urlopen, Request
            from urllib.error import HTTPError
            started = _time.monotonic()
            try:
                req = Request(target_url, method="GET")
                with urlopen(req, timeout=timeout_sec) as resp:
                    body_bytes = resp.read(4096)
                    elapsed_ms = int((_time.monotonic() - started) * 1000)
                    try:
                        resp_body = body_bytes.decode("utf-8")
                    except Exception:
                        resp_body = None
                    results.append({
                        "id": item_id, "ok": 200 <= resp.status < 400,
                        "httpStatus": resp.status, "responseTimeMs": elapsed_ms,
                        "body": resp_body, "error": None,
                    })
            except HTTPError as e:
                elapsed_ms = int((_time.monotonic() - started) * 1000)
                results.append({"id": item_id, "ok": False, "httpStatus": e.code, "responseTimeMs": elapsed_ms, "body": None, "error": str(e)})
            except Exception as e:
                elapsed_ms = int((_time.monotonic() - started) * 1000)
                results.append({"id": item_id, "ok": False, "httpStatus": None, "responseTimeMs": elapsed_ms, "body": None, "error": str(e)})
            continue

        started = _time.monotonic()
        try:
            with _warnings.catch_warnings():
                _warnings.filterwarnings("ignore", category=_InsecureRequestWarning)
                # Response를 with 로 닫아 커넥션 풀 엔트리/소켓 누수 방지
                with _requests.get(
                    target_url, timeout=timeout_sec, verify=False, allow_redirects=True, stream=False,
                ) as resp:
                    elapsed_ms = int((_time.monotonic() - started) * 1000)
                    try:
                        resp_body = resp.text[:4096]
                    except Exception:
                        resp_body = None
                    status_code = resp.status_code
            results.append({
                "id": item_id, "ok": 200 <= status_code < 400,
                "httpStatus": status_code, "responseTimeMs": elapsed_ms,
                "body": resp_body, "error": None,
            })
        except Exception as e:
            elapsed_ms = int((_time.monotonic() - started) * 1000)
            results.append({"id": item_id, "ok": False, "httpStatus": None, "responseTimeMs": elapsed_ms, "body": None, "error": str(e)})

    return jsonify({"results": results}), 200


# ── System routes ─────────────────────────────────────────────────────────────

@app.route("/health", methods=["GET"])
def health_check():
    return jsonify({
        "status": "healthy",
        "version": backend.config.version,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "loadedEndpoints": len(backend.config.apis),
    }), 200


@app.route("/logs", methods=["GET"])
@require_auth
def get_logs():
    start_date_param = request.args.get("start_date")
    end_date_param = request.args.get("end_date")
    max_lines = int(request.args.get("max_lines", 1000))
    cursor = request.args.get("cursor")
    follow_latest = parse_enabled(request.args.get("follow_latest", False))

    try:
        logs, next_cursor, resolved_start_date, resolved_end_date = backend.get_logs(
            start_date_param, end_date_param, max_lines, cursor=cursor, follow_latest=follow_latest,
        )
    except ValueError as error:
        return jsonify({"message": str(error)}), 400

    return jsonify({
        "logs": logs,
        "count": len(logs),
        "startDate": resolved_start_date,
        "endDate": resolved_end_date,
        "nextCursor": next_cursor,
    }), 200


@app.route("/logs/available-dates", methods=["GET"])
@require_auth
def get_available_log_dates():
    log_dir = Path(backend.config.logging.directory)
    if not log_dir.exists():
        return jsonify({"dates": []}), 200

    pattern = re.compile(
        rf"^{re.escape(backend.config.logging.file_prefix)}-(\d{{4}}-\d{{2}}-\d{{2}})\.log$"
    )
    dates = []
    for file_path in sorted(log_dir.glob(f"{backend.config.logging.file_prefix}-*.log"), reverse=True):
        match = pattern.match(file_path.name)
        if match:
            dates.append(match.group(1))
    return jsonify({"dates": dates}), 200


# ── Dynamic endpoint routing ──────────────────────────────────────────────────

@app.route("/", defaults={"requested_path": ""}, methods=["GET"])
@app.route("/<path:requested_path>", methods=["GET"])
@require_auth
@limiter.limit("120/minute")
def execute_endpoint(requested_path: str):
    client_ip = get_client_ip()

    if not requested_path:
        backend.logger.error("API routing failed reason=empty_path clientIp=%s", client_ip)
        return jsonify({"message": "endpoint not found"}), 404

    # Skip paths handled by explicit route handlers (dashboard, auth, etc.)
    if requested_path.startswith(("dashboard/", "auth/", "health", "logs")):
        return jsonify({"message": "endpoint not found"}), 404

    endpoint = backend.get_endpoint_by_path(f"/{requested_path}")
    if endpoint is None:
        backend.logger.error(
            "API routing failed reason=unknown_path path=/%s clientIp=%s", requested_path, client_ip,
        )
        return jsonify({"message": "endpoint not found"}), 404

    # ?fresh=1 → 캐시를 우회하고 즉시 쿼리를 재실행한다.
    # 알람 판정처럼 실시간성이 필요한 호출에서 사용 (criteria 기반 알람 등).
    fresh_param = request.args.get("fresh", "").strip().lower()
    bypass_cache = fresh_param in ("1", "true", "yes")

    try:
        if bypass_cache:
            entry = backend.refresh_endpoint_cache(
                endpoint, source="on-demand-fresh", client_ip=client_ip,
            )
            if entry.data is None:
                raise CachedEndpointError(
                    endpoint.api_id,
                    entry.error_message or "Internal Server Error",
                    detail=entry.error_detail,
                    is_timeout=entry.is_timeout,
                )
            data = entry.data
        else:
            data = backend.get_cached_endpoint_response(endpoint, client_ip)
    except SqlFileNotFoundError as error:
        return jsonify({
            "message": str(error), "apiId": endpoint.api_id, "detail": f"expectedPath: {error.sql_path}",
        }), 404
    except CachedEndpointError as error:
        return jsonify({
            "message": error.message, "apiId": endpoint.api_id, "detail": error.detail,
        }), 500
    except Exception as error:
        return jsonify({
            "message": "query execution failed", "apiId": endpoint.api_id, "detail": str(error),
        }), 500

    return jsonify(data), 200


# ── Error handler ─────────────────────────────────────────────────────────────

@app.errorhandler(Exception)
def handle_unexpected_server_error(error):
    if isinstance(error, HTTPException):
        return error
    backend.logger.exception(
        "Unhandled Flask exception method=%s path=%s clientIp=%s",
        request.method, request.path, get_client_ip(),
    )
    return jsonify({"message": "internal server error"}), 500


# ── Entry point ───────────────────────────────────────────────────────────────

def _run_server() -> None:
    """Start the HTTP server.

    서버 선택 규칙:
      - 환경변수 USE_WAITRESS=1  또는 USE_WAITRESS 미설정 + 프로덕션 모드(기본)
        → waitress (운영용 WSGI, Windows 서비스 권장)
      - 환경변수 USE_WAITRESS=0 또는 FLASK_ENV=development
        → werkzeug (개발 서버; 자동 리로드는 사용 안 함)

    Windows 서비스로 등록해 사용하는 경우 NSSM 등에서 이 진입점을 그대로 호출하면 된다.
    """
    use_waitress_env = (get_env("USE_WAITRESS", "1") or "1").strip().lower()
    flask_env = (get_env("FLASK_ENV", "production") or "production").strip().lower()
    use_waitress = use_waitress_env in ("1", "true", "yes") and flask_env != "development"

    host = backend.config.host
    port = backend.config.port

    if use_waitress:
        try:
            from waitress import serve as _waitress_serve
        except ImportError:
            backend.logger.warning(
                "waitress not installed — falling back to werkzeug development server. "
                "Install with: pip install waitress",
            )
            use_waitress = False

    backend.logger.info(
        "Starting MonitoringBackend host=%s port=%s server=%s",
        host, port, "waitress" if use_waitress else "werkzeug",
    )

    if use_waitress:
        threads = int(get_env("WAITRESS_THREADS", "16"))
        _waitress_serve(app, host=host, port=port, threads=threads, ident="x-monitoring-be")
    else:
        app.run(
            debug=False,
            host=host,
            port=port,
            threaded=True,
            use_reloader=False,
        )


if __name__ == "__main__":
    try:
        _run_server()
    except Exception:
        backend.logger.exception("FATAL: MonitoringBackend terminated unexpectedly")
        raise
    finally:
        backend._stop_background_refreshers()
        backend._close_all_pools()
        backend.logger.info("MonitoringBackend process stopped")
