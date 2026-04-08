"""SQL editor service.

Extracted from `MonitoringBackend.{get,update}_sql_for_api` (SRP). Owns
the read/write/validate cycle for the per-endpoint SQL files. Cache
refresh after a write is delegated to a constructor-injected callback so
this service has no dependency on the cache layer (DIP).
"""
from __future__ import annotations

import logging
import os
from typing import Any, Callable

from .config import ApiEndpointConfig, AppConfig
from .exceptions import SqlFileNotFoundError
from .sql_validator import load_sql_file, validate_select_only_sql


# Callback signature: (endpoint, client_ip) → None
OnSqlUpdated = Callable[[ApiEndpointConfig, str], None]


class SqlEditorService:
    """Reads, validates, and persists per-endpoint SQL files."""

    def __init__(
        self,
        *,
        sql_dir: str,
        config_provider: Callable[[], AppConfig],
        on_sql_updated: OnSqlUpdated,
        logger: logging.Logger,
    ) -> None:
        self._sql_dir = sql_dir
        self._config_provider = config_provider
        self._on_sql_updated = on_sql_updated
        self._logger = logger

    # ── Endpoint listings ─────────────────────────────────────────────────

    def list_sql_editable_endpoints(self) -> list[dict[str, Any]]:
        return [
            {
                "id": ep.api_id,
                "title": ep.title,
                "restApiPath": ep.rest_api_path,
                "sqlId": ep.sql_id,
            }
            for ep in self._config_provider().apis.values()
            if ep.enabled
        ]

    def get_editable_endpoint(self, api_id: str) -> ApiEndpointConfig:
        endpoint = self._config_provider().apis.get(api_id)
        if endpoint is None or not endpoint.enabled:
            raise KeyError(api_id)
        return endpoint

    # ── Read / write SQL ──────────────────────────────────────────────────

    def get_sql_for_api(self, api_id: str) -> dict[str, Any]:
        endpoint = self.get_editable_endpoint(api_id)
        sql = load_sql_file(endpoint.sql_id, self._sql_dir, self._logger)
        return {
            "id": endpoint.api_id,
            "title": endpoint.title,
            "restApiPath": endpoint.rest_api_path,
            "sqlId": endpoint.sql_id,
            "sql": sql,
        }

    def update_sql_for_api(self, api_id: str, sql: str, actor: str, client_ip: str) -> dict[str, Any]:
        endpoint = self.get_editable_endpoint(api_id)
        sql_path = os.path.join(self._sql_dir, f"{endpoint.sql_id}.sql")
        if not os.path.isfile(sql_path):
            self._logger.warning("SQL file not found sqlId=%s expectedPath=%s", endpoint.sql_id, sql_path)
            raise SqlFileNotFoundError(endpoint.sql_id, sql_path)

        normalized_sql = str(sql or "").replace("\r\n", "\n").strip()
        validate_select_only_sql(normalized_sql, self._config_provider().sql_validation_typo_patterns)

        file_contents = f"{normalized_sql}\n"
        with open(sql_path, "w", encoding="utf-8") as file:
            file.write(file_contents)

        self._logger.info(
            "SQL updated via admin apiId=%s sqlId=%s path=%s actor=%s clientIp=%s",
            endpoint.api_id, endpoint.sql_id, sql_path, actor, client_ip,
        )
        # Delegate cache refresh to the injected callback (DIP — editor
        # does not know about EndpointCache or MonitoringBackend).
        self._on_sql_updated(endpoint, client_ip)
        return {
            "id": endpoint.api_id,
            "title": endpoint.title,
            "restApiPath": endpoint.rest_api_path,
            "sqlId": endpoint.sql_id,
            "sql": file_contents,
        }

    # ── Validation rules ──────────────────────────────────────────────────

    def get_sql_validation_rules(self) -> dict[str, Any]:
        return {
            "typoPatterns": {
                key: list(values)
                for key, values in self._config_provider().sql_validation_typo_patterns.items()
            }
        }
