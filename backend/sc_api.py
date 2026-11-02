from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass

import httpx

from config import Settings
from errors import ServiceError

API = "https://api-v2.soundcloud.com"
SCRIPT_RE = re.compile(r'<script crossorigin src="([^"]+)"')
CLIENT_RE = re.compile(r'client_id\s*[:=]\s*"([a-zA-Z0-9]{32})"')


@dataclass(frozen=True)
class ApiTrack:
    id: int
    title: str
    artist: str
    duration: int
    permalink_url: str
    downloadable: bool
    has_downloads_left: bool
    policy: str | None
    streamable: bool


class SoundCloudApi:
    """Public api-v2 access used to resolve a track id to its page and flags."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._client_id: str | None = None
        self._client_id_at = 0.0
        self._lock = asyncio.Lock()

    async def _scrape_client_id(self) -> str:
        headers = {"User-Agent": self._settings.user_agent}
        async with httpx.AsyncClient(timeout=20.0, headers=headers, follow_redirects=True) as client:
            page = await client.get("https://soundcloud.com/")
            scripts = SCRIPT_RE.findall(page.text)
            for src in reversed(scripts):
                try:
                    js = await client.get(src)
                except httpx.HTTPError:
                    continue
                match = CLIENT_RE.search(js.text)
                if match:
                    return match.group(1)
        raise ServiceError(
            502, "client_id_failed", "Could not obtain a public SoundCloud client id."
        )

    async def client_id(self, force: bool = False) -> str:
        fresh = self._client_id and time.time() - self._client_id_at < 1800
        if fresh and not force:
            return self._client_id  # type: ignore[return-value]
        async with self._lock:
            fresh = self._client_id and time.time() - self._client_id_at < 1800
            if fresh and not force:
                return self._client_id  # type: ignore[return-value]
            self._client_id = await self._scrape_client_id()
            self._client_id_at = time.time()
            return self._client_id

    async def track(self, track_id: int) -> ApiTrack:
        last_status: int | None = None
        async with httpx.AsyncClient(
            timeout=20.0,
            headers={"User-Agent": self._settings.user_agent},
            follow_redirects=True,
        ) as client:
            for attempt in range(2):
                if attempt == 0 and self._settings.client_id:
                    client_id = self._settings.client_id
                else:
                    client_id = await self.client_id(force=attempt > 0)
                response = await client.get(
                    f"{API}/tracks/{track_id}", params={"client_id": client_id}
                )
                last_status = response.status_code
                if response.status_code in (401, 403):
                    continue
                if response.status_code == 404:
                    raise ServiceError(404, "not_found", "Track not found on SoundCloud.")
                if response.status_code == 429:
                    raise ServiceError(
                        503, "rate_limited", "SoundCloud is rate limiting requests. Try again shortly."
                    )
                if response.status_code != 200:
                    raise ServiceError(
                        502, "api_failed", f"SoundCloud responded {response.status_code}."
                    )
                try:
                    data = response.json()
                except ValueError as exc:
                    raise ServiceError(
                        502, "api_failed", "SoundCloud returned an unreadable response."
                    ) from exc
                if not isinstance(data, dict) or data.get("kind") != "track":
                    raise ServiceError(404, "not_found", "Track not found on SoundCloud.")
                return self._to_track(data)

        raise ServiceError(
            502, "api_failed", f"SoundCloud authorization failed ({last_status})."
        )

    @staticmethod
    def _to_track(data: dict) -> ApiTrack:
        permalink = data.get("permalink_url")
        if not isinstance(permalink, str) or not permalink:
            raise ServiceError(404, "not_found", "This track has no public SoundCloud page.")
        permalink = permalink.replace("http://", "https://", 1)
        user = data.get("user") if isinstance(data.get("user"), dict) else {}
        return ApiTrack(
            id=int(data.get("id")),
            title=str(data.get("title") or "Untitled"),
            artist=str(user.get("username") or "Unknown Artist"),
            duration=int(data.get("full_duration") or data.get("duration") or 0),
            permalink_url=permalink,
            downloadable=data.get("downloadable") is True,
            has_downloads_left=data.get("has_downloads_left") is not False,
            policy=data.get("policy") if isinstance(data.get("policy"), str) else None,
            streamable=data.get("streamable") is not False,
        )
