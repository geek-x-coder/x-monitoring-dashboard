"""Authentication: JWT token management and credential verification."""
from __future__ import annotations

import hmac
from datetime import datetime, timedelta, timezone
from functools import wraps
from typing import Callable

import jwt
from flask import jsonify, request
from pydantic import BaseModel, validator

from .utils import get_client_ip, get_env


def get_admin_username() -> str:
    return (get_env("ADMIN_USERNAME", "admin") or "admin").strip() or "admin"


def is_admin_username(username: str) -> bool:
    return (username or "").strip().lower() == get_admin_username().lower()


def create_jwt_token(username: str, hours: int = 24) -> str:
    payload = {
        "username": username,
        "role": "admin" if is_admin_username(username) else "user",
        "exp": datetime.now(timezone.utc) + timedelta(hours=hours),
        "iat": datetime.now(timezone.utc),
    }
    secret = get_env("JWT_SECRET_KEY", "default-secret-key")
    algo = get_env("JWT_ALGORITHM", "HS256")
    return jwt.encode(payload, secret, algorithm=algo)


def verify_jwt_token(token: str) -> dict | None:
    try:
        secret = get_env("JWT_SECRET_KEY", "default-secret-key")
        algo = get_env("JWT_ALGORITHM", "HS256")
        return jwt.decode(token, secret, algorithms=[algo])
    except (jwt.InvalidTokenError, jwt.ExpiredSignatureError):
        return None


def verify_login_credentials(
    username: str,
    password: str,
    expected_username: str,
    expected_password: str,
) -> bool:
    return hmac.compare_digest(username, expected_username) and hmac.compare_digest(
        password, expected_password
    )


class LoginRequest(BaseModel):
    username: str
    password: str

    @validator("username", "password")
    def not_empty(cls, v):
        if not v or not str(v).strip():
            raise ValueError("Field cannot be empty")
        return v.strip()


def require_auth(f: Callable) -> Callable:
    """Decorator: rejects requests without a valid Bearer JWT token."""
    @wraps(f)
    def decorated(*args, **kwargs):
        import logging
        logger = logging.getLogger("monitoring_backend")
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            logger.warning(
                "Auth rejected reason=missing_token path=%s clientIp=%s",
                request.path, get_client_ip(),
            )
            return jsonify({"message": "Missing or invalid authorization"}), 401

        token = auth_header[7:]
        payload = verify_jwt_token(token)
        if not payload:
            logger.warning(
                "Auth rejected reason=invalid_or_expired_token path=%s clientIp=%s",
                request.path, get_client_ip(),
            )
            return jsonify({"message": "Invalid or expired token"}), 401

        return f(*args, **kwargs)
    return decorated


def require_admin(f: Callable) -> Callable:
    """Decorator: rejects requests from non-admin users."""
    @wraps(f)
    def decorated(*args, **kwargs):
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return jsonify({"message": "Missing or invalid authorization"}), 401

        token = auth_header[7:]
        payload = verify_jwt_token(token)
        if not payload:
            return jsonify({"message": "Invalid or expired token"}), 401

        username = str(payload.get("username", ""))
        role = str(payload.get("role", ""))
        if role != "admin" and not is_admin_username(username):
            return jsonify({"message": "Admin privileges are required"}), 403

        return f(*args, **kwargs)
    return decorated
