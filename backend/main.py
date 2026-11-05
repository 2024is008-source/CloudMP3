from __future__ import annotations

import asyncio
import hmac
import logging
import os
import re
import subprocess
import tempfile
import time
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import quote

import yt_dlp
from fastapi import Depends, FastAPI, Header, Request
from fastapi.responses import JSONResponse, StreamingResponse

from config import Settings, load_settings
from errors import ServiceError
from formats import FormatService, MP3_BITRATES, TrackFormats, safe_filename
from sc_api import SoundCloudApi
from sc_oauth import SoundCloudAuth
from stream import (
    TEMP_PREFIX,
    cleanup_dir,
    convert_to_mp3,
    convert_to_wav,
    download_to_file,
    ffmpeg_path,
    stream_file,
    stream_temp,
    sweep_temp_dirs,
)
from zip_service import (
    TrackFile,
    ZipArchive,
    ZipTrack,
    build_archive,
    entry_extension,
    zip_filename,
    zip_temp_root,
)

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

SWEEP_INTERVAL = 60
# The archive is built before the first byte is sent, so the visitor leaving is
# noticed by polling rather than by an abandoned stream.
DISCONNECT_POLL = 0.5
# A ZIP request carries a list of ids and nothing else; 50 of them fit in a few
# kilobytes. The proxy caps the body too, and this is the service's own ceiling.
ZIP_BODY_MAX_BYTES = 1024 * 1024


def _sweep_all(ttl: int) -> int:
    """Reap idle temp dirs in the system temp and, when configured, the ZIP root."""
    removed = sweep_temp_dirs(ttl)
    root = zip_temp_root(settings)
    if root:
        removed += sweep_temp_dirs(ttl, root)
    return removed


async def _sweep_loop() -> None:
    while True:
        await asyncio.sleep(SWEEP_INTERVAL)
        removed = _sweep_all(settings.temp_ttl_seconds)
        if removed:
            log.info("Deleted %d expired conversion temp dirs", removed)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # A crash or a restart mid-conversion leaves a temp dir no response will
    # ever clean up, so sweep the backlog on boot and keep sweeping while the
    # service runs. Abandoned downloads are already deleted when the client
    # disconnects; this is the backstop for those and for the TTL ceiling.
    removed = _sweep_all(settings.temp_ttl_seconds)
    if removed:
        log.info("Deleted %d expired conversion temp dirs at startup", removed)
    task = asyncio.create_task(_sweep_loop())
    yield
    task.cancel()


app = FastAPI(
    title="CloudMP3 original audio service",
    version="1.0.0",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    lifespan=lifespan,
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
            # Only the idle locks. A lock still held by a request that has not
            # finished must stay reachable, or the next request for that track
            # would take a fresh lock and fetch the same track a second time.
            for key, held in list(_locks.items()):
                if not held.locked():
                    del _locks[key]
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


def _checked_selection(mode: str, quality: str, bitrate: int) -> tuple[str, str, int]:
    """Validate one track's format choice, the same way for single files and ZIPs."""
    if mode not in ("original", "wav", "mp3"):
        raise ServiceError(400, "bad_mode", "mode must be 'original', 'wav' or 'mp3'.")
    if quality not in ("high", "low"):
        raise ServiceError(400, "bad_quality", "quality must be 'high' or 'low'.")
    if mode == "mp3" and bitrate not in MP3_BITRATES:
        raise ServiceError(400, "bad_bitrate", "MP3 bitrate must be 128, 192, 256 or 320.")
    return mode, quality, bitrate


@app.get("/api/download/{track_id}", dependencies=[Depends(require_key)])
async def download(
    track_id: int,
    mode: str = "original",
    quality: str = "high",
    bitrate: int = 320,
) -> Any:
    _valid_track_id(track_id)
    mode, quality, bitrate = _checked_selection(mode, quality, bitrate)

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

    if mode == "mp3":
        metadata = {"title": result.title, "artist": result.artist}
        if result.album:
            metadata["album"] = result.album
        output, tmpdir, size = await convert_to_mp3(
            source.url, settings, bitrate, metadata, result.artwork_url
        )
        filename = safe_filename(
            f"{result.artist} - {result.title}.mp3", "converted.mp3"
        )
        headers = _base_headers(filename, "mp3", "MP3")
        headers["Content-Type"] = "audio/mpeg"
        headers["X-Source-Kind"] = "soundcloud-stream"
        headers["X-Source-Codec"] = source.codec
        headers["X-Audio-Bitrate"] = str(bitrate)
        headers["X-Converted"] = "1"
        headers["X-Total-Bytes"] = str(size)
        if source.bitrate:
            headers["X-Source-Bitrate"] = str(source.bitrate)
        return StreamingResponse(
            stream_temp(output, tmpdir),
            media_type="audio/mpeg",
            headers={**headers, "Content-Length": str(size)},
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
    return StreamingResponse(
        stream_temp(output, tmpdir),
        media_type="audio/wav",
        headers={**headers, "Content-Length": str(size)},
    )


def _zip_tracks(payload: Any) -> tuple[str, list[ZipTrack]]:
    """Turn the POST body into validated tracks; anything else gets a clear 400."""
    if not isinstance(payload, dict):
        raise ServiceError(400, "bad_body", "The ZIP request must be a JSON object.")
    name = payload.get("name")
    if name is not None and not isinstance(name, str):
        raise ServiceError(400, "bad_name", "'name' must be text.")
    requested = payload.get("tracks")
    if not isinstance(requested, list) or not requested:
        raise ServiceError(400, "no_tracks", "Send at least one track in 'tracks'.")
    if len(requested) > settings.max_zip_tracks:
        raise ServiceError(
            413,
            "too_many_tracks",
            f"This server packs at most {settings.max_zip_tracks} tracks per ZIP.",
        )

    tracks: list[ZipTrack] = []
    for item in requested:
        if not isinstance(item, dict):
            raise ServiceError(400, "bad_track", "Each track needs an object with a numeric id.")
        track_id = item.get("id")
        if isinstance(track_id, bool) or not isinstance(track_id, int):
            raise ServiceError(400, "bad_track_id", "A numeric SoundCloud track id is required.")
        _valid_track_id(track_id)
        bitrate = item.get("bitrate", 320)
        mode, quality, bitrate = _checked_selection(
            str(item.get("mode", "original")),
            str(item.get("quality", "high")),
            bitrate if isinstance(bitrate, int) and not isinstance(bitrate, bool) else 320,
        )
        tracks.append(ZipTrack(track_id, mode, quality, bitrate))
    return name or "", tracks


async def _zip_source(track: ZipTrack) -> TrackFile:
    """Fetch one ZIP member onto disk through the same pipeline a single file uses.

    The formats are resolved per track instead of from the cache: an archive can
    take minutes to build and SoundCloud's file links do not stay valid that long.
    """
    detail = await api.track(track.track_id)
    token, auth_error = await _token()
    result = await format_service.extract(
        detail,
        token,
        auth.configured,
        _ffmpeg_available(),
        auth_error is not None,
    )
    base = f"{result.artist} - {result.title}"

    if track.mode == "original":
        original = result.original
        if not original:
            raise ServiceError(
                409,
                result.original_reason or "unavailable",
                result.original_message
                or "SoundCloud isn't exposing an original file for this track.",
            )
        ext = entry_extension(original.ext)
        # Staged on the volume the archive is built on, so a ZIP job does not
        # fill the system temp directory an operator never sized for it.
        tmpdir = tempfile.mkdtemp(prefix=TEMP_PREFIX, dir=zip_temp_root(settings))
        path = os.path.join(tmpdir, f"track.{ext}")
        try:
            await download_to_file(original.url, path, settings.user_agent, settings.max_zip_bytes)
        except BaseException:
            # The download takes its half-written file back with it, but the
            # directory it was staged in is ours. Handing it to the sweep instead
            # would keep a dead track directory on the ZIP volume for a whole TTL.
            cleanup_dir(tmpdir)
            raise
        return TrackFile(path, tmpdir, ext, f"{base}.{ext}")

    source = result.select_stream(track.quality)
    if not source:
        raise ServiceError(
            409,
            "no_stream",
            "SoundCloud isn't providing an authorized stream for this track.",
        )

    if track.mode == "mp3":
        metadata = {"title": result.title, "artist": result.artist}
        if result.album:
            metadata["album"] = result.album
        output, tmpdir, _ = await convert_to_mp3(
            source.url, settings, track.bitrate, metadata, result.artwork_url
        )
        return TrackFile(output, tmpdir, "mp3", f"{base}.mp3")

    output, tmpdir, _ = await convert_to_wav(source.url, settings)
    return TrackFile(output, tmpdir, "wav", f"{base}.wav")


async def _watched_build(tracks: list[ZipTrack], request: Request) -> ZipArchive:
    """Build on a task so a visitor who leaves takes the archive down with them.

    The response cannot be started until the archive is whole, so the disconnect
    is polled rather than noticed through an abandoned stream.
    """
    task = asyncio.create_task(build_archive(tracks, settings, _zip_source))
    try:
        while True:
            if task.done():
                return await task
            if await request.is_disconnected():
                # Nothing is listening any more; the code only marks the cleanup.
                raise ServiceError(499, "client_disconnected", "The browser left mid-ZIP.")
            # Waiting on the task with the poll as a timeout keeps a quick job
            # instant while still noticing a walk-away within half a second.
            await asyncio.wait({task}, timeout=DISCONNECT_POLL)
    except BaseException:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        raise


def _zip_stream_headers(filename: str) -> dict[str, str]:
    return {
        "Content-Disposition": _disposition(filename),
        "X-Filename": quote(filename, safe=""),
        "X-File-Ext": "zip",
        "X-Zip-Streaming": "1",
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex",
    }


async def _first_entry(task: asyncio.Task[ZipArchive], started: asyncio.Event, request: Request) -> None:
    """Wait until the first track is in the archive, so errors can still be a status code."""
    waiter = asyncio.create_task(started.wait())
    try:
        while True:
            if task.done():
                await task  # raises the build's ServiceError, if any
                return
            if started.is_set():
                return
            if await request.is_disconnected():
                raise ServiceError(499, "client_disconnected", "The browser left mid-ZIP.")
            await asyncio.wait({task, waiter}, timeout=DISCONNECT_POLL, return_when=asyncio.FIRST_COMPLETED)
    except BaseException:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        raise
    finally:
        waiter.cancel()


async def _stream_growing(task: asyncio.Task[ZipArchive], path: str, tmpdir: str):
    """Send archive bytes as they are written, while later tracks are still packing."""
    try:
        with open(path, "rb") as file:
            while True:
                chunk = await asyncio.to_thread(file.read, ZIP_STREAM_CHUNK)
                if chunk:
                    yield chunk
                    continue
                if task.done():
                    await task  # surface a mid-build failure as a broken download
                    rest = await asyncio.to_thread(file.read)
                    if rest:
                        yield rest
                    return
                await asyncio.sleep(0.05)
    finally:
        # Synchronous steps first: a cancelled generator can have its next await
        # cancelled too, and the directory must not depend on that await.
        if not task.done():
            task.cancel()
        cleanup_dir(tmpdir)
        await asyncio.gather(task, return_exceptions=True)


ZIP_STREAM_CHUNK = 256 * 1024
ZIP_JOBS: dict[str, dict[str, Any]] = {}
ZIP_JOB_TTL = 900
_JOB_ID = re.compile(r"[A-Za-z0-9_-]{16,64}")


def _job_id(payload: Any) -> str | None:
    value = payload.get("jobId") if isinstance(payload, dict) else None
    return value if isinstance(value, str) and _JOB_ID.fullmatch(value) else None


def _prune_jobs() -> None:
    """Forget finished jobs a while after they end.

    The age runs from the moment a job finishes, not from when it began: a build
    may take up to ZIP_JOB_TIMEOUT_SECONDS and must stay reportable throughout.
    A job that never reports finishing is dropped once it is older than the
    build timeout plus the TTL.
    """
    now = time.monotonic()
    stale = []
    for key, job in ZIP_JOBS.items():
        if job["done"]:
            expired = now - job.get("finished_at", job["at"]) > ZIP_JOB_TTL
        else:
            expired = now - job["at"] > settings.zip_timeout + ZIP_JOB_TTL
        if expired:
            stale.append(key)
    for key in stale:
        ZIP_JOBS.pop(key, None)


@app.get("/api/download/zip/status/{job_id}", dependencies=[Depends(require_key)])
async def zip_status(job_id: str) -> dict[str, Any]:
    job = ZIP_JOBS.get(job_id) if _JOB_ID.fullmatch(job_id) else None
    if not job:
        raise ServiceError(404, "unknown_job", "No ZIP job with that id.")
    archive: ZipArchive = job["archive"]
    return {
        "total": job["total"],
        "packed": len(archive.entries),
        "failed": [item["trackId"] for item in archive.failed],
        "done": job["done"],
        "error": job.get("error"),
    }


@app.post("/api/download/zip", dependencies=[Depends(require_key)])
async def download_zip(request: Request) -> StreamingResponse:
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > ZIP_BODY_MAX_BYTES:
        raise ServiceError(413, "body_too_large", "The ZIP request body is too large.")
    try:
        payload = await request.json()
    except ValueError:
        raise ServiceError(400, "bad_body", "The ZIP request must be a JSON object.") from None
    name, tracks = _zip_tracks(payload)

    started = asyncio.Event()
    paths: dict[str, Any] = {}
    job_id = _job_id(payload)
    if job_id:
        _prune_jobs()
        existing = ZIP_JOBS.get(job_id)
        if existing is not None and not existing["done"]:
            raise ServiceError(409, "duplicate_job", "A ZIP with this job id is already running.")

    async def run() -> ZipArchive:
        return await build_archive(
            tracks, settings, _zip_source, started=started, note_failures=True, on_open=opened
        )

    def opened(info: dict[str, Any]) -> None:
        paths.update(info)
        if job_id:
            ZIP_JOBS[job_id] = {"total": len(tracks), "archive": info["archive"], "done": False, "at": time.monotonic()}

    task = asyncio.create_task(run())
    if job_id:
        def finished(t: asyncio.Task[ZipArchive]) -> None:
            job = ZIP_JOBS.get(job_id)
            if job:
                job["done"] = True
                job["finished_at"] = time.monotonic()
                job["error"] = None if t.cancelled() or t.exception() is None else getattr(t.exception(), "message", "failed")
        task.add_done_callback(finished)
    await _first_entry(task, started, request)
    filename = zip_filename(name)
    return StreamingResponse(
        _stream_growing(task, paths["path"], paths["tmpdir"]),
        media_type="application/zip",
        headers=_zip_stream_headers(filename),
    )


if not settings.service_key:
    log.warning("CLOUDMP3_SERVICE_KEY is not set; every API request will be rejected.")
if not auth.configured:
    log.warning(
        "No SoundCloud account token configured; original files will be reported unavailable."
    )
