from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import Any

import httpx

from config import Settings
from errors import ServiceError

TOKEN_URL = "https://secure.soundcloud.com/oauth/token"
ME_URL = "https://api-v2.soundcloud.com/me"

log = logging.getLogger(__name__)


class SoundCloudAuth:
    """Holds the one SoundCloud account used for original downloads.

    SoundCloud rotates refresh tokens (each one is single-use), so a successful
    refresh is persisted before the next request can use it. Only one refresh
    may run at a time; concurrent refreshes would invalidate each other.
    """

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._lock = asyncio.Lock()
        self._access_token: str | None = settings.access_token or None
        self._expires_at = time.time() + 3600 if settings.access_token else 0.0
        self._refresh_token: str | None = self._load_refresh_token()
        self._describe_cache: tuple[float, dict[str, Any]] | None = None

    @property
    def configured(self) -> bool:
        return bool(self._refresh_token or self._access_token)

    def _load_refresh_token(self) -> str | None:
        path = self._settings.token_store
        try:
            if path.is_file():
                data = json.loads(path.read_text("utf-8"))
                token = data.get("refresh_token") if isinstance(data, dict) else None
                if isinstance(token, str) and token.strip():
                    return token.strip()
        except (OSError, ValueError):
            log.warning("SoundCloud token store at %s is unreadable", path)
        return self._settings.refresh_token or None

    def _store_refresh_token(self, token: str) -> None:
        path = self._settings.token_store
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_name(f".{path.name}.tmp")
            tmp.write_text(
                json.dumps({"refresh_token": token, "updated_at": int(time.time())}),
                "utf-8",
            )
            try:
                os.chmod(tmp, 0o600)
            except OSError:
                pass
            os.replace(tmp, path)
        except OSError:
            log.error("Could not persist the rotated SoundCloud refresh token to %s", path)

    async def get_access_token(self) -> str | None:
        if not self.configured:
            return None
        if self._access_token and time.time() < self._expires_at - 60:
            return self._access_token
        async with self._lock:
            if self._access_token and time.time() < self._expires_at - 60:
                return self._access_token
            if not self._refresh_token:
                return self._access_token
            await self._refresh_locked()
            return self._access_token

    async def _refresh_locked(self) -> None:
        if not (self._settings.client_id and self._settings.client_secret):
            raise ServiceError(
                503,
                "oauth_unconfigured",
                "SOUNDCLOUD_CLIENT_ID and SOUNDCLOUD_CLIENT_SECRET are required to refresh the account token.",
            )

        payload = {
            "grant_type": "refresh_token",
            "client_id": self._settings.client_id,
            "client_secret": self._settings.client_secret,
            "refresh_token": self._refresh_token,
        }
        headers = {"Accept": "application/json", "User-Agent": self._settings.user_agent}
        try:
            async with httpx.AsyncClient(timeout=20.0, headers=headers) as client:
                response = await client.post(TOKEN_URL, data=payload)
        except httpx.HTTPError as exc:
            raise ServiceError(
                502, "oauth_unreachable", "Could not reach SoundCloud to refresh the account token."
            ) from exc

        if response.status_code != 200:
            detail = ""
            try:
                body = response.json()
                detail = str(
                    body.get("error_description") or body.get("error") or "rejected"
                )[:160]
            except ValueError:
                pass
            raise ServiceError(
                502,
                "oauth_rejected",
                "SoundCloud rejected the stored account token"
                + (f" ({detail})." if detail else ".")
                + " Re-run scripts/get_refresh_token.py and update SOUNDCLOUD_REFRESH_TOKEN.",
            )

        try:
            body = response.json()
        except ValueError as exc:
            raise ServiceError(
                502, "oauth_failed", "SoundCloud returned an unreadable token response."
            ) from exc
        if not isinstance(body, dict):
            raise ServiceError(502, "oauth_failed", "SoundCloud returned an unexpected token response.")

        access = body.get("access_token")
        if not isinstance(access, str) or not access:
            raise ServiceError(502, "oauth_failed", "SoundCloud returned no access token.")

        expires_in = body.get("expires_in")
        lifetime = expires_in if isinstance(expires_in, (int, float)) and expires_in > 0 else 3600
        self._access_token = access
        self._expires_at = time.time() + float(lifetime)

        rotated = body.get("refresh_token")
        if isinstance(rotated, str) and rotated and rotated != self._refresh_token:
            self._refresh_token = rotated
            self._store_refresh_token(rotated)

    async def describe(self) -> dict[str, Any]:
        """Report whether the configured account can actually call the API."""
        if not self.configured:
            return {"configured": False, "verified": False}
        cached = self._describe_cache
        if cached and time.time() - cached[0] < 120:
            return cached[1]

        result: dict[str, Any]
        try:
            token = await self.get_access_token()
            if not token:
                result = {"configured": False, "verified": False}
            else:
                params = {"client_id": self._settings.client_id} if self._settings.client_id else None
                async with httpx.AsyncClient(
                    timeout=15.0,
                    headers={
                        "Accept": "application/json",
                        "User-Agent": self._settings.user_agent,
                        "Authorization": f"OAuth {token}",
                    },
                ) as client:
                    response = await client.get(ME_URL, params=params)
                if response.status_code == 200:
                    body = response.json()
                    result = {
                        "configured": True,
                        "verified": True,
                        "username": body.get("username"),
                        "permalink_url": body.get("permalink_url"),
                    }
                elif response.status_code in (401, 403):
                    result = {"configured": True, "verified": False, "error": "rejected"}
                else:
                    result = {
                        "configured": True,
                        "verified": False,
                        "error": f"status {response.status_code}",
                    }
        except ServiceError as exc:
            result = {"configured": True, "verified": False, "error": exc.code}
        except (httpx.HTTPError, ValueError):
            result = {"configured": True, "verified": False, "error": "unreachable"}

        self._describe_cache = (time.time(), result)
        return result
