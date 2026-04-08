"""MonitoringBackend: orchestrates DB queries, caching, and endpoint management.

This class is a façade — most non-cache work is delegated to focused
sub-services in sibling modules:
    - `LogReader`         → app/log_reader.py
    - `DbHealthService`   → app/db_health_service.py
    - `JdbcQueryExecutor` → app/jdbc_executor.py
    - `SqlEditorService`  → app/sql_editor_service.py
The façade preserves the public method names so route handlers do not
need to know which sub-service does the work.
"""
from __future__ import annotations

import logging
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from time import perf_counter
from typing import Any
from urllib.parse import urlparse

from .cache import EndpointCacheEntry
from .config import ApiEndpointConfig, AppConfig, load_app_config
from .db import DBConnectionPool, ensure_jvm_started
from .db_health_service import DbHealthService
from .exceptions import CachedEndpointError, QueryExecutionTimeoutError
from .jdbc_executor import JdbcQueryExecutor
from .log_reader import LogReader
from .logging_setup import _startup_log, configure_logging
from .sql_editor_service import SqlEditorService
from .utils import get_env


def _resolve_sql_dir() -> str:
    """Return the sql/ directory path.

    - Dev mode : <repo_root>/sql/  (two levels up from this file)
    - Frozen   : <exe_dir>/sql/    (beside the exe, editable without rebuild)
    """
    if getattr(sys, "frozen", False):
        return os.path.join(os.path.dirname(sys.executable), "sql")
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "sql")


# NOTE: _normalize_db_type and _DIAGNOSTIC_SQL were moved to db_health_service.py


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
        # 과거 QueryCache 인스턴스가 있었으나 어디서도 .set()이 호출되지 않는
        # 데드 코드였음 → 제거. 실제 캐싱은 endpoint_cache(EndpointCacheEntry)로만 이뤄진다.
        self.endpoint_cache: dict[str, EndpointCacheEntry] = {}
        self.endpoint_cache_lock = threading.RLock()
        self.scheduler_stop_event = threading.Event()
        self.scheduler_threads: list[threading.Thread] = []
        self.db_pools: dict[str, DBConnectionPool] = {
            conn_id: DBConnectionPool(max_size=int(get_env("DB_POOL_SIZE", "5")))
            for conn_id in self.config.connections
        }
        # ── Sub-services (façade pattern) ──────────────────────────────
        # Use lambdas so the sub-services always observe the *current*
        # executor / db_pools / config — both `executor` and `db_pools`
        # are reassigned during reload().
        sql_dir = _resolve_sql_dir()
        self._db_health = DbHealthService(
            config_provider=lambda: self.config,
            executor_provider=lambda: self.executor,
            pool_provider=lambda conn_id: self.db_pools[conn_id],
            logger=self.logger,
        )
        self._jdbc = JdbcQueryExecutor(
            sql_dir=sql_dir,
            config_provider=lambda: self.config,
            executor_provider=lambda: self.executor,
            pool_provider=lambda conn_id: self.db_pools[conn_id],
            logger=self.logger,
        )
        self._sql_editor = SqlEditorService(
            sql_dir=sql_dir,
            config_provider=lambda: self.config,
            on_sql_updated=lambda endpoint, client_ip: self.refresh_endpoint_cache(
                endpoint, source="sql-update", client_ip=client_ip, reset_connection=True,
            ),
            logger=self.logger,
        )
        self._log_reader = LogReader(self.config.logging, self.logger)

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
        if self.logger.isEnabledFor(logging.DEBUG):
            self.logger.debug(
                "Scheduler thread started apiId=%s intervalSec=%s",
                api_id, endpoint.refresh_interval_sec,
            )
        while not self.scheduler_stop_event.wait(endpoint.refresh_interval_sec):
            if self.logger.isEnabledFor(logging.DEBUG):
                self.logger.debug("Scheduler tick apiId=%s", api_id)
            self.refresh_endpoint_cache(endpoint, source="scheduler", client_ip="scheduler")
        if self.logger.isEnabledFor(logging.DEBUG):
            self.logger.debug("Scheduler thread exited apiId=%s", api_id)

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
            if self.logger.isEnabledFor(logging.DEBUG):
                row_count = len(entry.data) if isinstance(entry.data, list) else 1
                self.logger.debug(
                    "Cache HIT apiId=%s path=%s rowCount=%d updatedAt=%s source=%s clientIp=%s",
                    endpoint.api_id, endpoint.rest_api_path, row_count,
                    entry.updated_at, entry.source, client_ip,
                )
            return entry.data

        if entry and entry.error_message:
            if self.logger.isEnabledFor(logging.DEBUG):
                self.logger.debug(
                    "Cache HIT (error) apiId=%s message=%s isTimeout=%s clientIp=%s",
                    endpoint.api_id, entry.error_message, entry.is_timeout, client_ip,
                )
            raise CachedEndpointError(
                endpoint.api_id, entry.error_message, detail=entry.error_detail, is_timeout=entry.is_timeout,
            )

        if self.logger.isEnabledFor(logging.DEBUG):
            self.logger.debug(
                "Cache MISS apiId=%s path=%s — refreshing on-demand clientIp=%s",
                endpoint.api_id, endpoint.rest_api_path, client_ip,
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

    # ── Query execution (delegated to JdbcQueryExecutor) ──────────────────

    def run_query(self, endpoint: ApiEndpointConfig, client_ip: str) -> Any:
        return self._jdbc.run_query(endpoint, client_ip)

    # ── SQL editor (delegated to SqlEditorService) ────────────────────────

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
        return self._sql_editor.list_sql_editable_endpoints()

    def get_editable_endpoint(self, api_id: str) -> ApiEndpointConfig:
        return self._sql_editor.get_editable_endpoint(api_id)

    def get_sql_for_api(self, api_id: str) -> dict[str, Any]:
        return self._sql_editor.get_sql_for_api(api_id)

    def update_sql_for_api(self, api_id: str, sql: str, actor: str, client_ip: str) -> dict[str, Any]:
        return self._sql_editor.update_sql_for_api(api_id, sql, actor, client_ip)

    def get_sql_validation_rules(self) -> dict[str, Any]:
        return self._sql_editor.get_sql_validation_rules()

    # ── DB health diagnostics (delegated to DbHealthService) ──────────────

    def list_db_connections(self) -> list[dict[str, Any]]:
        return self._db_health.list_db_connections()

    def get_db_health_data(
        self, connection_id: str, category: str, timeout_sec: float = 10.0,
    ) -> dict[str, Any]:
        return self._db_health.get_db_health_data(connection_id, category, timeout_sec)

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

    # ── Log access (delegated to LogReader) ───────────────────────────────

    def get_logs(
        self,
        start_date_str: str | None = None,
        end_date_str: str | None = None,
        max_lines: int = 1000,
        cursor: str | None = None,
        follow_latest: bool = False,
    ) -> tuple[list[str], str | None, str, str]:
        return self._log_reader.get_logs(
            start_date_str, end_date_str, max_lines, cursor, follow_latest,
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

        # 1) 새 executor부터 준비 — in-flight 작업들이 구 executor에서 종료되길 기다리는
        #    동안에도 새 요청을 처리할 수 있도록 executor 교체를 먼저 한다.
        new_executor = ThreadPoolExecutor(
            max_workers=new_config.thread_pool_size,
            thread_name_prefix="jdbc-worker",
        )
        self.executor = new_executor

        # 2) 구 executor를 gracefully drain.
        #    wait=True로 기다려야 한다: wait=False면 구 executor에 제출된 in-flight
        #    _execute_jdbc 잡들이 이후 _close_all_pools() 로 닫힌 커넥션을 참조하게
        #    되어 예외가 튀고, 최악의 경우 JDBC 리소스가 정리되지 않은 채 남는다.
        try:
            old_executor.shutdown(wait=True, cancel_futures=True)
        except TypeError:
            # Python 3.8 호환 (cancel_futures는 3.9+)
            old_executor.shutdown(wait=True)

        # 3) 이제 구 풀을 안전하게 닫는다 (in-flight 잡이 없음이 보장됨).
        self._close_all_pools()

        configure_logging(new_config.logging)
        self.logger = logging.getLogger("monitoring_backend")
        self.config = new_config
        with self.endpoint_cache_lock:
            self.endpoint_cache.clear()
        self.db_pools = {
            conn_id: DBConnectionPool(max_size=int(get_env("DB_POOL_SIZE", "5")))
            for conn_id in new_config.connections
        }
        # LogReader holds a snapshot of logging-config (directory / file_prefix);
        # DbHealthService reads config/executor/pools via providers so needs no refresh.
        self._log_reader.update_logging_config(new_config.logging)
        self._start_background_refreshers()

        enabled_apis = [ep for ep in new_config.apis.values() if ep.enabled]
        _startup_log(
            self.logger,
            "Config reloaded host=%s port=%s threadPoolSize=%s loadedApiCount=%s",
            new_config.host, new_config.port, new_config.thread_pool_size, len(enabled_apis),
        )
        for ep in enabled_apis:
            _startup_log(self.logger, "Hosted API id=%s path=%s", ep.api_id, ep.rest_api_path)
