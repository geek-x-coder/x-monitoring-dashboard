"""MonitoringBackend: orchestrates DB queries, caching, and endpoint management."""
from __future__ import annotations

import logging
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from time import perf_counter
from typing import Any
from urllib.parse import urlparse

from .cache import EndpointCacheEntry, QueryCache
from .config import ApiEndpointConfig, AppConfig, load_app_config
from .db import DBConnectionPool, ensure_jvm_started
from .exceptions import CachedEndpointError, QueryExecutionTimeoutError, SqlFileNotFoundError
from .logging_setup import _startup_log, configure_logging
from .sql_validator import load_sql_file, validate_select_only_sql
from .utils import decode_log_cursor, encode_log_cursor, get_env, to_jsonable


LOG_DATE_FORMAT = "%Y-%m-%d"


def _resolve_sql_dir() -> str:
    """Return the sql/ directory path.

    - Dev mode : <repo_root>/sql/  (two levels up from this file)
    - Frozen   : <exe_dir>/sql/    (beside the exe, editable without rebuild)
    """
    if getattr(sys, "frozen", False):
        return os.path.join(os.path.dirname(sys.executable), "sql")
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "sql")


# ── DB-type normalisation ──────────────────────────────────────────────────────

def _normalize_db_type(db_type: str) -> str:
    lower = (db_type or "").lower()
    if "oracle" in lower:
        return "oracle"
    if "mariadb" in lower or "mysql" in lower:
        return "mariadb"
    if "mssql" in lower or "sqlserver" in lower or "sql server" in lower:
        return "mssql"
    return lower


# ── Diagnostic SQL (indexed by (db_type_key, category)) ───────────────────────

_DIAGNOSTIC_SQL: dict[tuple[str, str], str] = {

    # ── Oracle ────────────────────────────────────────────────────────────────

    ("oracle", "slow_queries"): """
SELECT ROUND(elapsed_time / GREATEST(executions, 1) / 1000000, 3) AS avg_elapsed_sec,
       executions,
       ROUND(elapsed_time / 1000000, 2)                           AS total_elapsed_sec,
       sql_id,
       SUBSTR(sql_text, 1, 120)                                   AS sql_text
FROM   V$SQL
WHERE  executions > 0
  AND  elapsed_time / GREATEST(executions, 1) > 500000
ORDER BY elapsed_time / GREATEST(executions, 1) DESC
FETCH FIRST 20 ROWS ONLY
""".strip(),

    ("oracle", "tablespace"): """
SELECT m.tablespace_name,
       ROUND(m.used_space      * t.block_size / 1073741824, 2) AS used_gb,
       ROUND(m.tablespace_size * t.block_size / 1073741824, 2) AS total_gb,
       ROUND(m.used_percent, 1)                                AS used_pct,
       t.status
FROM   DBA_TABLESPACE_USAGE_METRICS m
JOIN   DBA_TABLESPACES t ON t.tablespace_name = m.tablespace_name
ORDER BY m.used_percent DESC
""".strip(),

    ("oracle", "locks"): """
SELECT s.sid,
       NVL(s.username, '(background)')                                       AS username,
       s.status,
       DECODE(l.lmode,
              0,'None', 1,'Null', 2,'Row-S (SS)', 3,'Row-X (SX)',
              4,'Share', 5,'S/Row-X (SSX)', 6,'Exclusive', l.lmode)          AS lock_mode,
       DECODE(l.request,
              0,'—', 1,'Null', 2,'Row-S', 3,'Row-X',
              4,'Share', 5,'S/Row-X', 6,'Exclusive', l.request)              AS lock_request,
       NVL(o.object_name, '—')                                               AS object_name,
       NVL(o.object_type, '—')                                               AS object_type,
       l.block                                                                AS is_blocker
FROM   V$LOCK l
JOIN   V$SESSION s ON s.sid = l.sid
LEFT JOIN DBA_OBJECTS o ON o.object_id = l.id1 AND l.type = 'TM'
WHERE  l.type IN ('TM', 'TX')
  AND  (l.block = 1 OR l.request > 0)
ORDER BY l.block DESC, s.sid
""".strip(),

    # ── MariaDB / MySQL ───────────────────────────────────────────────────────

    ("mariadb", "slow_queries"): """
SELECT LEFT(DIGEST_TEXT, 120)                                       AS sql_text,
       SCHEMA_NAME                                                   AS schema_name,
       COUNT_STAR                                                     AS exec_count,
       ROUND(AVG_TIMER_WAIT      / 1000000000000, 3)                 AS avg_elapsed_sec,
       ROUND(SUM_TIMER_WAIT      / 1000000000000, 3)                 AS total_elapsed_sec,
       ROUND(AVG_ROWS_EXAMINED,  0)                                  AS avg_rows_examined
FROM   performance_schema.events_statements_summary_by_digest
WHERE  AVG_TIMER_WAIT / 1000000000000 > 1.0
ORDER BY AVG_TIMER_WAIT DESC
LIMIT  20
""".strip(),

    ("mariadb", "tablespace"): """
SELECT TABLE_SCHEMA                                                   AS schema_name,
       TABLE_NAME                                                     AS table_name,
       ENGINE,
       TABLE_ROWS                                                     AS row_count,
       ROUND((DATA_LENGTH + INDEX_LENGTH) / 1073741824, 4)           AS total_gb,
       ROUND(DATA_LENGTH  / 1073741824, 4)                           AS data_gb,
       ROUND(INDEX_LENGTH / 1073741824, 4)                           AS index_gb
FROM   information_schema.TABLES
WHERE  TABLE_SCHEMA NOT IN
         ('information_schema', 'performance_schema', 'mysql', 'sys')
  AND  TABLE_TYPE = 'BASE TABLE'
ORDER BY DATA_LENGTH + INDEX_LENGTH DESC
LIMIT  30
""".strip(),

    ("mariadb", "locks"): """
SELECT r.trx_id                                           AS waiting_trx,
       r.trx_mysql_thread_id                             AS waiting_thread,
       LEFT(IFNULL(r.trx_query, '—'), 80)               AS waiting_sql,
       b.trx_id                                          AS blocking_trx,
       b.trx_mysql_thread_id                             AS blocking_thread,
       LEFT(IFNULL(b.trx_query, '—'), 80)               AS blocking_sql
FROM   information_schema.INNODB_TRX        b
JOIN   information_schema.INNODB_LOCK_WAITS w
         ON  b.trx_id = w.blocking_trx_id
JOIN   information_schema.INNODB_TRX        r
         ON  r.trx_id = w.requesting_trx_id
""".strip(),

    # ── MSSQL ─────────────────────────────────────────────────────────────────

    ("mssql", "slow_queries"): """
SELECT TOP 20
    qs.execution_count,
    ROUND(qs.total_elapsed_time / NULLIF(qs.execution_count, 0) / 1000000.0, 3) AS avg_elapsed_sec,
    ROUND(qs.total_elapsed_time / 1000000.0, 2)                                  AS total_elapsed_sec,
    LEFT(st.text, 120)                                                            AS sql_text
FROM sys.dm_exec_query_stats   qs
CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
WHERE qs.total_elapsed_time / NULLIF(qs.execution_count, 0) > 1000000
ORDER BY qs.total_elapsed_time / NULLIF(qs.execution_count, 0) DESC
""".strip(),

    ("mssql", "tablespace"): """
SELECT
    f.name                                                                     AS file_name,
    f.type_desc,
    ROUND(f.size                                     * 8.0 / 1048576, 2)      AS total_gb,
    ROUND(FILEPROPERTY(f.name, 'SpaceUsed')          * 8.0 / 1048576, 2)      AS used_gb,
    ROUND((f.size - FILEPROPERTY(f.name, 'SpaceUsed')) * 8.0 / 1048576, 2)   AS free_gb,
    f.physical_name
FROM sys.database_files f
ORDER BY f.size DESC
""".strip(),

    ("mssql", "locks"): """
SELECT
    r.session_id,
    r.wait_type,
    ROUND(r.wait_time / 1000.0, 1)   AS wait_sec,
    r.status,
    r.command,
    LEFT(st.text, 120)               AS sql_text
FROM sys.dm_exec_requests      r
CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) st
WHERE r.wait_type IS NOT NULL
  AND r.wait_type NOT LIKE 'SLEEP%'
  AND r.wait_type NOT LIKE 'XE_%'
  AND r.wait_type NOT LIKE 'BROKER_%'
ORDER BY r.wait_time DESC
""".strip(),
}


class MonitoringBackend:
    """
    Core service class: executes JDBC queries, manages endpoint caches,
    and orchestrates background refresh threads.

    Follows SRP – business logic only; routing is handled in routes.py.
    """

    def __init__(
        self,
        config_path: str,
        logger: logging.Logger,
        initial_config: AppConfig | None = None,
    ) -> None:
        self.config_path = config_path
        self.logger = logger
        self.config = initial_config or load_app_config(config_path)
        self.executor = ThreadPoolExecutor(
            max_workers=self.config.thread_pool_size,
            thread_name_prefix="jdbc-worker",
        )
        self.cache = QueryCache(ttl_sec=int(get_env("CACHE_TTL_SEC", "300")))
        self.sql_file_signatures: dict[str, str] = {}
        self.sql_file_lock = threading.Lock()
        self.endpoint_cache: dict[str, EndpointCacheEntry] = {}
        self.endpoint_cache_lock = threading.RLock()
        self.scheduler_stop_event = threading.Event()
        self.scheduler_threads: list[threading.Thread] = []
        self.db_pools: dict[str, DBConnectionPool] = {
            conn_id: DBConnectionPool(max_size=int(get_env("DB_POOL_SIZE", "5")))
            for conn_id in self.config.connections
        }
        # Pre-start JVM once before any JDBC work begins, with all JDBC jars on classpath
        if self.config.connections:
            all_jars = list(dict.fromkeys(
                jar
                for conn in self.config.connections.values()
                for jar in conn.jdbc_jars
            ))
            try:
                ensure_jvm_started(classpath=all_jars)
            except Exception as exc:
                self.logger.error("JVM pre-start failed (will retry on first query): %s", exc)
        self._start_background_refreshers()
        enabled_apis = [ep for ep in self.config.apis.values() if ep.enabled]
        _startup_log(
            self.logger,
            "Backend initialized host=%s port=%s threadPoolSize=%s loadedApiCount=%s",
            self.config.host,
            self.config.port,
            self.config.thread_pool_size,
            len(enabled_apis),
        )
        for ep in enabled_apis:
            _startup_log(self.logger, "Hosted API id=%s path=%s", ep.api_id, ep.rest_api_path)

    # ── Background refresh ────────────────────────────────────────────────

    def _start_background_refreshers(self) -> None:
        self.scheduler_stop_event.clear()
        self.scheduler_threads = []

        # ── Initial cache warm-up: run ALL endpoints once in parallel ─────
        enabled_endpoints = [ep for ep in self.config.apis.values() if ep.enabled]
        if enabled_endpoints:
            self.logger.info(
                "Starting initial cache warm-up for %d endpoints...",
                len(enabled_endpoints),
            )
            futures = {
                self.executor.submit(
                    self.refresh_endpoint_cache,
                    ep,
                    source="startup",
                    client_ip="scheduler",
                ): ep.api_id
                for ep in enabled_endpoints
            }
            for future in futures:
                try:
                    future.result(timeout=60)
                except Exception as exc:
                    api_id = futures[future]
                    self.logger.error(
                        "Initial cache warm-up failed apiId=%s: %s", api_id, exc,
                    )
            self.logger.info("Initial cache warm-up completed.")

        # ── Start periodic refresh threads ────────────────────────────────
        for endpoint in enabled_endpoints:
            thread = threading.Thread(
                target=self._refresh_endpoint_loop,
                args=(endpoint.api_id,),
                name=f"cache-refresh-{endpoint.api_id}",
                daemon=True,
            )
            thread.start()
            self.scheduler_threads.append(thread)

    def _stop_background_refreshers(self) -> None:
        self.scheduler_stop_event.set()
        for thread in self.scheduler_threads:
            thread.join(timeout=1.5)
        self.scheduler_threads = []

    def _refresh_endpoint_loop(self, api_id: str) -> None:
        """Periodic refresh only – initial warm-up is done in _start_background_refreshers."""
        endpoint = self.config.apis.get(api_id)
        if endpoint is None or not endpoint.enabled:
            return
        while not self.scheduler_stop_event.wait(endpoint.refresh_interval_sec):
            self.refresh_endpoint_cache(endpoint, source="scheduler", client_ip="scheduler")

    # ── Cache management ──────────────────────────────────────────────────

    def _store_endpoint_cache_success(
        self,
        endpoint: ApiEndpointConfig,
        data: Any,
        *,
        source: str,
        started_at: str,
        duration_sec: float,
    ) -> EndpointCacheEntry:
        entry = EndpointCacheEntry(
            api_id=endpoint.api_id,
            path=endpoint.rest_api_path,
            connection_id=endpoint.connection_id,
            data=data,
            updated_at=datetime.now(timezone.utc).isoformat(),
            last_refresh_started_at=started_at,
            last_duration_sec=duration_sec,
            error_message=None,
            error_detail=None,
            is_timeout=False,
            source=source,
        )
        with self.endpoint_cache_lock:
            self.endpoint_cache[endpoint.api_id] = entry
        return entry

    def _store_endpoint_cache_error(
        self,
        endpoint: ApiEndpointConfig,
        *,
        source: str,
        started_at: str,
        duration_sec: float,
        message: str,
        detail: str | None,
        is_timeout: bool,
    ) -> EndpointCacheEntry:
        entry = EndpointCacheEntry(
            api_id=endpoint.api_id,
            path=endpoint.rest_api_path,
            connection_id=endpoint.connection_id,
            data=None,
            updated_at=None,
            last_refresh_started_at=started_at,
            last_duration_sec=duration_sec,
            error_message=message,
            error_detail=detail,
            is_timeout=is_timeout,
            source=source,
        )
        with self.endpoint_cache_lock:
            self.endpoint_cache[endpoint.api_id] = entry
        return entry

    def get_cached_endpoint_entry(self, api_id: str) -> EndpointCacheEntry | None:
        with self.endpoint_cache_lock:
            return self.endpoint_cache.get(api_id)

    def refresh_endpoint_cache(
        self,
        endpoint: ApiEndpointConfig,
        *,
        source: str,
        client_ip: str,
        reset_connection: bool = False,
    ) -> EndpointCacheEntry:
        started_at = datetime.now(timezone.utc).isoformat()
        started_timer = perf_counter()

        if reset_connection:
            self.reset_connections(endpoint.connection_id)

        try:
            data = self.run_query(endpoint, client_ip)
            duration_sec = perf_counter() - started_timer
            entry = self._store_endpoint_cache_success(
                endpoint, data, source=source, started_at=started_at, duration_sec=duration_sec,
            )
            if isinstance(data, list):
                result_summary = f"rows={len(data)}"
            elif isinstance(data, dict) and "updated" in data:
                result_summary = f"updated={data['updated']}"
            else:
                result_summary = "ok"
            is_slow = duration_sec >= self.config.logging.slow_query_threshold_sec
            log_fn = self.logger.warning if is_slow else self.logger.info
            log_fn(
                "Cache refreshed apiId=%s path=%s source=%s %s durationSec=%.3f clientIp=%s",
                endpoint.api_id, endpoint.rest_api_path, source, result_summary, duration_sec, client_ip,
            )
            return entry
        except QueryExecutionTimeoutError as error:
            duration_sec = perf_counter() - started_timer
            entry = self._store_endpoint_cache_error(
                endpoint, source=source, started_at=started_at, duration_sec=duration_sec,
                message="Database Query timeout", detail=str(error), is_timeout=True,
            )
            self.logger.warning(
                "Endpoint cache refresh timeout apiId=%s path=%s source=%s durationSec=%.3f timeoutSec=%.3f",
                endpoint.api_id, endpoint.rest_api_path, source, duration_sec, endpoint.query_timeout_sec,
            )
            return entry
        except Exception as error:
            duration_sec = perf_counter() - started_timer
            entry = self._store_endpoint_cache_error(
                endpoint, source=source, started_at=started_at, duration_sec=duration_sec,
                message="Internal Server Error", detail=str(error), is_timeout=False,
            )
            self.logger.error(
                "Endpoint cache refresh failed apiId=%s path=%s source=%s durationSec=%.3f detail=%s",
                endpoint.api_id, endpoint.rest_api_path, source, duration_sec, error,
            )
            return entry

    def refresh_all_endpoint_caches(
        self, *, source: str, client_ip: str, reset_connection: bool = False,
    ) -> list[EndpointCacheEntry]:
        return [
            self.refresh_endpoint_cache(
                endpoint, source=source, client_ip=client_ip, reset_connection=reset_connection,
            )
            for endpoint in self.config.apis.values()
            if endpoint.enabled
        ]

    def get_cached_endpoint_response(self, endpoint: ApiEndpointConfig, client_ip: str) -> Any:
        entry = self.get_cached_endpoint_entry(endpoint.api_id)
        if entry and entry.data is not None:
            return entry.data

        if entry and entry.error_message:
            raise CachedEndpointError(
                endpoint.api_id, entry.error_message, detail=entry.error_detail, is_timeout=entry.is_timeout,
            )

        refreshed_entry = self.refresh_endpoint_cache(endpoint, source="on-demand", client_ip=client_ip)
        if refreshed_entry.data is not None:
            return refreshed_entry.data

        raise CachedEndpointError(
            endpoint.api_id,
            refreshed_entry.error_message or "Internal Server Error",
            detail=refreshed_entry.error_detail,
            is_timeout=refreshed_entry.is_timeout,
        )

    # ── Query execution ───────────────────────────────────────────────────

    def run_query(self, endpoint: ApiEndpointConfig, client_ip: str) -> Any:
        future = self.executor.submit(self._execute_jdbc, endpoint, client_ip)
        try:
            return future.result(timeout=endpoint.query_timeout_sec)
        except FutureTimeoutError as error:
            future.cancel()
            raise QueryExecutionTimeoutError(endpoint.api_id, endpoint.query_timeout_sec) from error

    def _execute_jdbc(self, endpoint: ApiEndpointConfig, client_ip: str) -> Any:
        sql_dir = _resolve_sql_dir()
        conn_cfg = self.config.connections[endpoint.connection_id]
        pool = self.db_pools[endpoint.connection_id]
        jdbc_conn = pool.get_connection(conn_cfg)
        cursor = None
        start_time = perf_counter()
        should_return_connection = True

        try:
            sql = load_sql_file(endpoint.sql_id, sql_dir, self.logger)
            self._track_sql_change(endpoint, sql)
            cursor = jdbc_conn.cursor()
            cursor.execute(sql)

            if cursor.description is None:
                jdbc_conn.commit()
                elapsed = perf_counter() - start_time
                return {"updated": cursor.rowcount}

            columns = [desc[0] for desc in cursor.description]
            rows = cursor.fetchall()
            result = [
                {col: to_jsonable(val) for col, val in zip(columns, row)}
                for row in rows
            ]
            elapsed = perf_counter() - start_time
            return result
        except Exception:
            elapsed = perf_counter() - start_time
            should_return_connection = False
            self.logger.exception(
                "Query execution failed apiId=%s path=%s connectionId=%s durationSec=%.3f clientIp=%s",
                endpoint.api_id, endpoint.rest_api_path, endpoint.connection_id, elapsed, client_ip,
            )
            raise
        finally:
            if cursor is not None:
                try:
                    cursor.close()
                except Exception:
                    should_return_connection = False
            if should_return_connection:
                pool.return_connection(jdbc_conn)
            else:
                pool.discard_connection(jdbc_conn)

    # ── SQL editor ────────────────────────────────────────────────────────

    def _track_sql_change(self, endpoint: ApiEndpointConfig, sql: str) -> None:
        sql_dir = _resolve_sql_dir()
        sql_path = os.path.join(sql_dir, f"{endpoint.sql_id}.sql")
        with self.sql_file_lock:
            previous_sql = self.sql_file_signatures.get(endpoint.sql_id)
            self.sql_file_signatures[endpoint.sql_id] = sql
        if previous_sql is None or previous_sql == sql:
            return
        self.logger.info(
            "SQL changed detected apiId=%s sqlId=%s path=%s previousSql=%r newSql=%r",
            endpoint.api_id, endpoint.sql_id, sql_path, previous_sql, sql,
        )

    def list_endpoints(self) -> list[dict[str, Any]]:
        return [
            {
                "id": ep.api_id,
                "title": ep.title,
                "endpoint": ep.rest_api_path,
                "enabled": ep.enabled,
                "dbType": self.config.connections[ep.connection_id].db_type,
                "connectionId": ep.connection_id,
            }
            for ep in self.config.apis.values()
            if ep.enabled
        ]

    def list_sql_editable_endpoints(self) -> list[dict[str, Any]]:
        return [
            {
                "id": ep.api_id,
                "title": ep.title,
                "restApiPath": ep.rest_api_path,
                "sqlId": ep.sql_id,
            }
            for ep in self.config.apis.values()
            if ep.enabled
        ]

    def get_editable_endpoint(self, api_id: str) -> ApiEndpointConfig:
        endpoint = self.config.apis.get(api_id)
        if endpoint is None or not endpoint.enabled:
            raise KeyError(api_id)
        return endpoint

    def get_sql_for_api(self, api_id: str) -> dict[str, Any]:
        sql_dir = _resolve_sql_dir()
        endpoint = self.get_editable_endpoint(api_id)
        sql = load_sql_file(endpoint.sql_id, sql_dir, self.logger)
        return {
            "id": endpoint.api_id,
            "title": endpoint.title,
            "restApiPath": endpoint.rest_api_path,
            "sqlId": endpoint.sql_id,
            "sql": sql,
        }

    def update_sql_for_api(self, api_id: str, sql: str, actor: str, client_ip: str) -> dict[str, Any]:
        sql_dir = _resolve_sql_dir()
        endpoint = self.get_editable_endpoint(api_id)
        sql_path = os.path.join(sql_dir, f"{endpoint.sql_id}.sql")
        if not os.path.isfile(sql_path):
            self.logger.warning("SQL file not found sqlId=%s expectedPath=%s", endpoint.sql_id, sql_path)
            raise SqlFileNotFoundError(endpoint.sql_id, sql_path)

        normalized_sql = str(sql or "").replace("\r\n", "\n").strip()
        validate_select_only_sql(normalized_sql, self.config.sql_validation_typo_patterns)

        file_contents = f"{normalized_sql}\n"
        with open(sql_path, "w", encoding="utf-8") as file:
            file.write(file_contents)

        self.logger.info(
            "SQL updated via admin apiId=%s sqlId=%s path=%s actor=%s clientIp=%s",
            endpoint.api_id, endpoint.sql_id, sql_path, actor, client_ip,
        )
        self.refresh_endpoint_cache(endpoint, source="sql-update", client_ip=client_ip, reset_connection=True)
        return {
            "id": endpoint.api_id,
            "title": endpoint.title,
            "restApiPath": endpoint.rest_api_path,
            "sqlId": endpoint.sql_id,
            "sql": file_contents,
        }

    def get_sql_validation_rules(self) -> dict[str, Any]:
        return {
            "typoPatterns": {
                key: list(values)
                for key, values in self.config.sql_validation_typo_patterns.items()
            }
        }

    # ── DB health diagnostics ─────────────────────────────────────────────

    def _execute_sql_direct(self, connection_id: str, sql: str) -> list[dict[str, Any]]:
        """Execute a raw SQL string on the given connection and return rows as list of dicts."""
        conn_cfg = self.config.connections[connection_id]
        pool = self.db_pools[connection_id]
        jdbc_conn = pool.get_connection(conn_cfg)
        cursor = None
        should_return = True
        try:
            cursor = jdbc_conn.cursor()
            cursor.execute(sql)
            if cursor.description is None:
                return []
            columns = [desc[0] for desc in cursor.description]
            rows = cursor.fetchall()
            return [
                {col: to_jsonable(val) for col, val in zip(columns, row)}
                for row in rows
            ]
        except Exception:
            should_return = False
            raise
        finally:
            if cursor is not None:
                try:
                    cursor.close()
                except Exception:
                    should_return = False
            if should_return:
                pool.return_connection(jdbc_conn)
            else:
                pool.discard_connection(jdbc_conn)

    def list_db_connections(self) -> list[dict[str, Any]]:
        """Return metadata for all configured DB connections."""
        return [
            {
                "connectionId": conn_id,
                "dbType": conn.db_type,
                "jdbcUrl": conn.jdbc_url,
            }
            for conn_id, conn in self.config.connections.items()
        ]

    def get_db_health_data(
        self, connection_id: str, category: str, timeout_sec: float = 10.0,
    ) -> dict[str, Any]:
        """Execute a diagnostic query for a given category on the specified connection.

        category: 'slow_queries' | 'tablespace' | 'locks'
        Returns columns, rows, durationSec, and error (if any).
        """
        conn_cfg = self.config.connections.get(connection_id)
        if conn_cfg is None:
            return {
                "connectionId": connection_id,
                "dbType": "unknown",
                "category": category,
                "columns": [],
                "rows": [],
                "rowCount": 0,
                "durationSec": 0.0,
                "queriedAt": datetime.now(timezone.utc).isoformat(),
                "error": f"connection '{connection_id}' not configured",
            }

        db_type_key = _normalize_db_type(conn_cfg.db_type)
        sql = _DIAGNOSTIC_SQL.get((db_type_key, category))
        if sql is None:
            return {
                "connectionId": connection_id,
                "dbType": conn_cfg.db_type,
                "category": category,
                "columns": [],
                "rows": [],
                "rowCount": 0,
                "durationSec": 0.0,
                "queriedAt": datetime.now(timezone.utc).isoformat(),
                "error": f"'{conn_cfg.db_type}' 에서 '{category}' 진단은 지원하지 않습니다",
            }

        started = perf_counter()
        queried_at = datetime.now(timezone.utc).isoformat()
        try:
            future = self.executor.submit(self._execute_sql_direct, connection_id, sql)
            rows = future.result(timeout=timeout_sec)
            duration = perf_counter() - started
            columns = list(rows[0].keys()) if rows else []
            self.logger.debug(
                "DB health query success connectionId=%s category=%s rows=%d durationSec=%.3f",
                connection_id, category, len(rows), duration,
            )
            return {
                "connectionId": connection_id,
                "dbType": conn_cfg.db_type,
                "category": category,
                "columns": columns,
                "rows": rows,
                "rowCount": len(rows),
                "durationSec": round(duration, 3),
                "queriedAt": queried_at,
                "error": None,
            }
        except FutureTimeoutError:
            duration = perf_counter() - started
            self.logger.warning(
                "DB health query timeout connectionId=%s category=%s timeoutSec=%.1f",
                connection_id, category, timeout_sec,
            )
            return {
                "connectionId": connection_id,
                "dbType": conn_cfg.db_type,
                "category": category,
                "columns": [],
                "rows": [],
                "rowCount": 0,
                "durationSec": round(duration, 3),
                "queriedAt": queried_at,
                "error": f"쿼리 타임아웃 ({timeout_sec:.0f}s)",
            }
        except Exception as err:
            duration = perf_counter() - started
            self.logger.warning(
                "DB health query failed connectionId=%s category=%s durationSec=%.3f detail=%s",
                connection_id, category, duration, err,
            )
            return {
                "connectionId": connection_id,
                "dbType": conn_cfg.db_type,
                "category": category,
                "columns": [],
                "rows": [],
                "rowCount": 0,
                "durationSec": round(duration, 3),
                "queriedAt": queried_at,
                "error": str(err),
            }

    # ── Routing helpers ───────────────────────────────────────────────────

    def get_endpoint_by_path(self, request_path: str) -> ApiEndpointConfig | None:
        from .config import normalize_path
        return self.config.endpoints_by_path.get(normalize_path(request_path))

    def resolve_endpoint_reference(
        self, *, api_id: str | None = None, endpoint_value: str | None = None,
    ) -> ApiEndpointConfig | None:
        if api_id:
            endpoint = self.config.apis.get(str(api_id))
            if endpoint and endpoint.enabled:
                return endpoint
        if endpoint_value:
            raw_value = str(endpoint_value).strip()
            parsed_path = urlparse(raw_value).path if raw_value.startswith(("http://", "https://")) else raw_value
            return self.get_endpoint_by_path(parsed_path)
        return None

    # ── Log access ────────────────────────────────────────────────────────

    def get_logs(
        self,
        start_date_str: str | None = None,
        end_date_str: str | None = None,
        max_lines: int = 1000,
        cursor: str | None = None,
        follow_latest: bool = False,
    ) -> tuple[list[str], str | None, str, str]:
        try:
            if follow_latest:
                end_date = date.today()
            else:
                end_date = (
                    datetime.strptime(end_date_str, LOG_DATE_FORMAT).date()
                    if end_date_str else date.today()
                )
            start_date = (
                datetime.strptime(start_date_str, LOG_DATE_FORMAT).date()
                if start_date_str else end_date
            )
        except ValueError:
            raise ValueError("Invalid date format. Use YYYY-MM-DD.")

        if start_date > end_date:
            raise ValueError("start_date cannot be after end_date")

        log_cursor = decode_log_cursor(cursor)
        collected_lines: list[str] = []
        next_cursor: dict[str, int] = {}
        current_date = start_date

        while current_date <= end_date:
            date_key = current_date.strftime(LOG_DATE_FORMAT)
            log_file = (
                Path(self.config.logging.directory)
                / f"{self.config.logging.file_prefix}-{date_key}.log"
            )
            if log_file.exists():
                try:
                    with open(log_file, "r", encoding="utf-8") as f:
                        lines = [line.rstrip("\n") for line in f.readlines()]
                        previous_count = max(0, int(log_cursor.get(date_key, 0)))
                        if previous_count > len(lines):
                            previous_count = 0
                        collected_lines.extend(lines[previous_count:])
                        next_cursor[date_key] = len(lines)
                except Exception as error:
                    self.logger.error("Failed to read log file '%s': %s", log_file, error)
            else:
                next_cursor[date_key] = 0
            current_date += timedelta(days=1)

        trimmed_lines = collected_lines[-max_lines:]
        return (
            trimmed_lines,
            encode_log_cursor(next_cursor) if next_cursor else None,
            start_date.strftime(LOG_DATE_FORMAT),
            end_date.strftime(LOG_DATE_FORMAT),
        )

    # ── Lifecycle ─────────────────────────────────────────────────────────

    def reset_connections(self, connection_id: str | None = None) -> None:
        target_ids = [connection_id] if connection_id else list(self.db_pools.keys())
        for conn_id in target_ids:
            pool = self.db_pools.get(conn_id)
            if pool is None:
                continue
            pool.close_all()
            self.db_pools[conn_id] = DBConnectionPool(max_size=int(get_env("DB_POOL_SIZE", "5")))

    def _close_all_pools(self) -> None:
        for pool in self.db_pools.values():
            pool.close_all()

    def reload(self) -> None:
        new_config = load_app_config(self.config_path)
        old_executor = self.executor

        self._stop_background_refreshers()
        self._close_all_pools()

        configure_logging(new_config.logging)
        self.logger = logging.getLogger("monitoring_backend")
        self.config = new_config
        self.executor = ThreadPoolExecutor(
            max_workers=new_config.thread_pool_size,
            thread_name_prefix="jdbc-worker",
        )
        self.cache.clear()
        with self.endpoint_cache_lock:
            self.endpoint_cache.clear()
        self.db_pools = {
            conn_id: DBConnectionPool(max_size=int(get_env("DB_POOL_SIZE", "5")))
            for conn_id in new_config.connections
        }
        old_executor.shutdown(wait=False)
        self._start_background_refreshers()

        enabled_apis = [ep for ep in new_config.apis.values() if ep.enabled]
        _startup_log(
            self.logger,
            "Config reloaded host=%s port=%s threadPoolSize=%s loadedApiCount=%s",
            new_config.host, new_config.port, new_config.thread_pool_size, len(enabled_apis),
        )
        for ep in enabled_apis:
            _startup_log(self.logger, "Hosted API id=%s path=%s", ep.api_id, ep.rest_api_path)
