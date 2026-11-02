from __future__ import annotations

import asyncio
import hmac
import logging
import re
import subprocess
import time
from typing import Any
from urllib.parse import quote

import yt_dlp
from fastapi import Depends, FastAPI, Header
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from starlette.background import BackgroundTask

from config import Settings, load_settings
from errors import ServiceError
from formats import FormatService, TrackFormats, safe_filename
from sc_api import SoundCloudApi
from sc_oauth import SoundCloudAuth
from stream import cleanup_dir, convert_to_wav, ffmpeg_path, stream_file

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("cloudmp3")

settings: Settings = load_settings()
auth = SoundCloudAuth(settings)
api = SoundCloudApi(settings)
format_service = FormatService(settings)

CACHE_TTL = 600
CACHE_LIMIT = 300
_cache: dict[int, tuple[float, TrackFormats]] = {}
_locks: dict[int, asyncio.Lock] = {}
_locks_guard = asyncio.Lock()
_ffmpeg_version: str | None = None

app = FastAPI(
    title="CloudMP3 original audio service",
    version="1.0.0",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


@app.exception_handler(ServiceError)
async def handle_service_error(_request, exc: ServiceError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status,
        content={"error": {"code": exc.code, "message": exc.message}},
        headers={"Cache-Control": "no-store"},
    )


async def require_key(x_api_key: str | None = Header(default=None)) -> None:
    if not settings.service_key:
        raise ServiceError(
            503,
            "service_key_unset",
            "CLOUDMP3_SERVICE_KEY is not configured on this service.",
        )
    if not x_api_key or not hmac.compare_digest(x_api_key, settings.service_key):
        raise ServiceError(401, "unauthorized", "Invalid service key.")


def _valid_track_id(track_id: int) -> int:
    if not 1 <= track_id <= 9007199254740991:
        raise ServiceError(400, "bad_track_id", "A numeric SoundCloud track id is required.")
    return track_id


def _ffmpeg_available() -> bool:
    return ffmpeg_path() is not None


def _ffmpeg_report() -> str | None:
    global _ffmpeg_version
    binary = ffmpeg_path()
    if not binary:
        return None
    if _ffmpeg_version is not None:
        return _ffmpeg_version
    try:
        out = subprocess.run(
            [binary, "-version"], capture_output=True, text=True, timeout=5
        )
        first = (out.stdout or "").splitlines()[0]
        match = re.search(r"ffmpeg version (\S+)", first)
        _ffmpeg_version = match.group(1) if match else "unknown"
    except Exception:
        _ffmpeg_version = "unknown"
    return _ffmpeg_version


async def _token() -> tuple[str | None, ServiceError | None]:
    try:
        return await auth.get_access_token(), None
    except ServiceError as exc:
        return None, exc


async def _cached_formats(track_id: int) -> TrackFormats:
    entry = _cache.get(track_id)
    if entry and time.time() - entry[0] < CACHE_TTL:
        return entry[1]

    async with _locks_guard:
        lock = _locks.setdefault(track_id, asyncio.Lock())

    async with lock:
        entry = _cache.get(track_id)
        if entry and time.time() - entry[0] < CACHE_TTL:
            return entry[1]

        track = await api.track(track_id)
        token, auth_error = await _token()
        result = await format_service.extract(
            track,
            token,
            auth.configured,
            _ffmpeg_available(),
            auth_error is not None,
        )
        if len(_cache) >= CACHE_LIMIT:
            _cache.clear()
            _locks.clear()
        _cache[track_id] = (time.time(), result)
        return result


def _disposition(filename: str) -> str:
    ascii_name = filename.encode("ascii", "ignore").decode("ascii") or "download"
    ascii_name = re.sub(r'[\\"\r\n]', "_", ascii_name)
    return (
        f'attachment; filename="{ascii_name}"; '
        f"filename*=UTF-8''{quote(filename, safe='')}"
    )


def _base_headers(filename: str, ext: str, codec: str) -> dict[str, str]:
    return {
        "Content-Disposition": _disposition(filename),
        "X-Filename": quote(filename, safe=""),
        "X-File-Ext": ext,
        "X-Audio-Codec": codec,
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex",
    }


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"ok": True}


@app.get("/api/health", dependencies=[Depends(require_key)])
async def health_detail() -> dict[str, Any]:
    return {
        "ok": True,
        "ytdlp": yt_dlp.version.__version__,
        "ffmpeg": _ffmpeg_report(),
        "auth": {"configured": auth.configured},
        "cache": {"entries": len(_cache)},
    }


@app.get("/api/account", dependencies=[Depends(require_key)])
async def account() -> dict[str, Any]:
    return {"ok": True, "auth": await auth.describe()}


@app.get("/api/formats/{track_id}", dependencies=[Depends(require_key)])
async def track_formats(track_id: int) -> JSONResponse:
    result = await _cached_formats(_valid_track_id(track_id))
    return JSONResponse(
        content=result.to_public(),
        headers={"Cache-Control": "no-store", "X-Robots-Tag": "noindex"},
    )


@app.get("/api/download/{track_id}", dependencies=[Depends(require_key)])
async def download(
    track_id: int,
    mode: str = "original",
    quality: str = "high",
) -> Any:
    _valid_track_id(track_id)
    if mode not in ("original", "wav"):
        raise ServiceError(400, "bad_mode", "mode must be 'original' or 'wav'.")
    if quality not in ("high", "low"):
        raise ServiceError(400, "bad_quality", "quality must be 'high' or 'low'.")

    track = await api.track(track_id)
    token, auth_error = await _token()
    if mode == "original" and auth_error is not None:
        # The account itself is unusable, so original access can never succeed.
        raise auth_error

    result = await format_service.extract(
        track,
        token,
        auth.configured,
        _ffmpeg_available(),
        auth_error is not None,
    )

    if mode == "original":
        original = result.original
        if not original:
            raise ServiceError(
                409,
                result.original_reason or "unavailable",
                result.original_message
                or "SoundCloud isn't exposing an original file for this track.",
            )
        filename = original.display_name(result.artist, result.title)
        headers = _base_headers(filename, original.ext, original.codec)
        headers["Content-Type"] = original.mime or "application/octet-stream"
        headers["X-Source-Kind"] = "soundcloud-original"
        headers["X-Converted"] = "0"
        if original.bitrate:
            headers["X-Audio-Bitrate"] = str(original.bitrate)
        if original.bytes:
            headers["X-Total-Bytes"] = str(original.bytes)
            headers["Content-Length"] = str(original.bytes)
        return StreamingResponse(
            stream_file(original.url, settings.user_agent), headers=headers
        )

    source = result.select_stream(quality)
    if not source:
        raise ServiceError(
            409,
            "no_stream",
            "SoundCloud isn't providing an authorized stream for this track.",
        )

    output, tmpdir, size = await convert_to_wav(source.url, settings)
    filename = safe_filename(
        f"{result.artist} - {result.title}.wav", "converted.wav"
    )
    headers = _base_headers(filename, "wav", "PCM (WAV)")
    headers["X-Source-Kind"] = "soundcloud-stream"
    headers["X-Source-Codec"] = source.codec
    headers["X-Converted"] = "1"
    headers["X-Total-Bytes"] = str(size)
    if source.bitrate:
        headers["X-Source-Bitrate"] = str(source.bitrate)
    return FileResponse(
        output,
        media_type="audio/wav",
        filename=filename,
        headers=headers,
        background=BackgroundTask(cleanup_dir, tmpdir),
    )


if not settings.service_key:
    log.warning("CLOUDMP3_SERVICE_KEY is not set; every API request will be rejected.")
if not auth.configured:
    log.warning(
        "No SoundCloud account token configured; original files will be reported unavailable."
    )
