from __future__ import annotations

import asyncio
import contextlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.parse import urljoin, urlparse

import anyio
import httpx

from config import Settings
from errors import ServiceError
from formats import MP3_BITRATES, ext_from_url, is_allowed_source
from net_guard import UnsafeDestination, assert_safe_media_url, media_client

CHUNK = 64 * 1024
NETWORK_TIMEOUT = httpx.Timeout(connect=30.0, read=120.0, write=30.0, pool=30.0)
TEMP_PREFIX = "cloudmp3-"
ARTWORK_TIMEOUT = httpx.Timeout(connect=15.0, read=30.0, write=15.0, pool=15.0)
ARTWORK_MAX_BYTES = 8 * 1024 * 1024

# A 44-byte header is what FFmpeg leaves behind when it decodes nothing.
WAV_HEADER_BYTES = 44


async def _chunks(url: str, user_agent: str):
    async with media_client(NETWORK_TIMEOUT, headers={"User-Agent": user_agent}) as client:
        async with client.stream("GET", url) as response:
            if response.status_code >= 400:
                raise ServiceError(
                    502,
                    "download_failed",
                    f"SoundCloud's file host responded {response.status_code}.",
                )
            async for chunk in response.aiter_bytes(CHUNK):
                yield chunk


async def stream_file(url: str, user_agent: str):
    """Stream a resolved original file, retrying once before any byte is sent."""
    sent = False
    for attempt in range(2):
        try:
            async for chunk in _chunks(url, user_agent):
                sent = True
                yield chunk
            return
        except (httpx.HTTPError, ServiceError) as exc:
            if sent or attempt == 1:
                raise ServiceError(
                    502,
                    "download_failed",
                    "The original file could not be streamed from SoundCloud.",
                ) from exc


def ffmpeg_path() -> str | None:
    return shutil.which("ffmpeg")


async def download_to_file(url: str, dest: str, user_agent: str, limit: int) -> int:
    """Write one SoundCloud file to disk and return its size.

    The ZIP builder needs the bytes on disk instead of in a response, so this
    reuses the same retrying stream and drops them in a file. A partial file is
    removed on every exit, cancellation included.
    """
    written = 0
    try:
        async with await anyio.open_file(dest, mode="wb") as file:
            async for chunk in stream_file(url, user_agent):
                written += len(chunk)
                if written > limit:
                    raise ServiceError(
                        413,
                        "download_too_large",
                        "This track is larger than the limit set on this server.",
                    )
                await file.write(chunk)
    except BaseException:
        try:
            os.remove(dest)
        except OSError:
            pass
        raise
    if written == 0:
        raise ServiceError(502, "download_failed", "SoundCloud sent no audio for this track.")
    return written


# --- HLS ---------------------------------------------------------------------

# A master playlist names variant playlists, which name segments. Every level is
# read and checked here, because nothing downstream can be trusted to have done
# it: handed a playlist, FFmpeg follows each address inside it itself.
PLAYLIST_MAX_DEPTH = 3
# Generous for any real track and small enough that a playlist written to exhaust
# memory gets refused instead of obeyed.
PLAYLIST_MAX_SEGMENTS = 10_000


def is_playlist_url(url: str) -> bool:
    return urlparse(url).path.lower().endswith((".m3u8", ".m3u"))


def playlist_references(text: str) -> list[str]:
    """Every address one playlist points at, in the order they must be read.

    A fragmented-Media playlist keeps its init segment in ``#EXT-X-MAP`` rather
    than in a line of its own, and the decoder needs those bytes before the rest.
    """
    refs: list[str] = []
    mapped = re.search(r'#EXT-X-MAP:URI="([^"]+)"', text)
    if mapped:
        refs.append(mapped.group(1))
    for line in text.splitlines():
        entry = line.strip()
        if entry and not entry.startswith("#"):
            refs.append(entry)
    return refs


async def _playlist_body(url: str, user_agent: str) -> str:
    try:
        async with media_client(NETWORK_TIMEOUT, headers={"User-Agent": user_agent}) as client:
            response = await client.get(url)
    except httpx.HTTPError as exc:
        raise ServiceError(
            502, "download_failed", "SoundCloud's playlist could not be read."
        ) from exc
    if response.status_code >= 400:
        raise ServiceError(
            502,
            "download_failed",
            f"SoundCloud's playlist host responded {response.status_code}.",
        )
    return response.text


async def collect_segments(url: str, user_agent: str, depth: int = 0) -> list[str]:
    """Every media address in a playlist tree, each checked before it is fetched.

    A nested playlist is expanded here rather than returned as one address to
    fetch later, so the addresses the caller ends up streaming are all leaf
    segments and all of them have been through the outbound policy.
    """
    if depth >= PLAYLIST_MAX_DEPTH:
        raise ServiceError(502, "download_failed", "This stream's playlist nests too deeply.")
    text = await _playlist_body(url, user_agent)
    if "#EXT-X-KEY" in text and "METHOD=NONE" not in text:
        raise ServiceError(403, "drm_protected", "This track is DRM-protected.")
    segments: list[str] = []
    for reference in playlist_references(text):
        # Relative references resolve against the playlist that named them, which
        # is where a nested playlist could otherwise smuggle a new origin in.
        target = urljoin(url, reference)
        try:
            await assert_safe_media_url(target)
        except UnsafeDestination as exc:
            raise ServiceError(
                502,
                "source_blocked",
                "SoundCloud pointed this stream at an address this server will not contact.",
            ) from exc
        if is_playlist_url(target):
            segments.extend(await collect_segments(target, user_agent, depth + 1))
        else:
            segments.append(target)
        if len(segments) > PLAYLIST_MAX_SEGMENTS:
            raise ServiceError(502, "download_failed", "This stream has too many segments.")
    return segments


async def stage_source(url: str, settings: Settings, tmpdir: str) -> str:
    """Bring one SoundCloud resource onto disk and return the path to it.

    FFmpeg used to be handed the remote address and did its own fetching: the
    file, any playlist behind it, and every segment that playlist named — none of
    it visible to this service's outbound policy. Downloading through the guarded
    client first means FFmpeg only ever opens a local file.
    """
    extension = ext_from_url(url) or "bin"
    dest = os.path.join(tmpdir, f"source.{extension}")
    if not is_playlist_url(url):
        await download_to_file(url, dest, settings.user_agent, settings.max_convert_bytes)
        return dest

    segments = await collect_segments(url, settings.user_agent)
    if not segments:
        raise ServiceError(502, "download_failed", "SoundCloud sent no audio for this track.")

    # Concurrently fetch segments with a sliding window over pooled keep-alive connections
    WINDOW = 8
    sem = asyncio.Semaphore(WINDOW)
    async with media_client(NETWORK_TIMEOUT, headers={"User-Agent": settings.user_agent}) as client:
        async def fetch_one(seg_url: str) -> bytes:
            async with sem:
                for attempt in range(2):
                    try:
                        resp = await client.get(seg_url)
                        if resp.status_code == 200:
                            return resp.content
                    except httpx.HTTPError:
                        if attempt == 1:
                            raise ServiceError(
                                502,
                                "download_failed",
                                "The original file could not be streamed from SoundCloud.",
                            )
                raise ServiceError(
                    502,
                    "download_failed",
                    "The original file could not be streamed from SoundCloud.",
                )

        chunks = await asyncio.gather(*(fetch_one(s) for s in segments))

    written = 0
    try:
        async with await anyio.open_file(dest, mode="wb") as file:
            for chunk in chunks:
                written += len(chunk)
                if written > settings.max_convert_bytes:
                    raise ServiceError(
                        413,
                        "download_too_large",
                        "This track is larger than the limit set on this server.",
                    )
                await file.write(chunk)
    except BaseException:
        with contextlib.suppress(OSError):
            os.remove(dest)
        raise
    if written == 0:
        raise ServiceError(502, "download_failed", "SoundCloud sent no audio for this track.")
    return dest


def cleanup_dir(path: str) -> None:
    shutil.rmtree(path, ignore_errors=True)


_slot: asyncio.Semaphore | None = None
_slot_owner: tuple[int, int] | None = None


def conversion_slot(limit: int) -> asyncio.Semaphore:
    """The single cap on concurrent FFmpeg processes in this service.

    A semaphore belongs to the event loop it is first awaited on, so a new loop
    or a reconfigured limit rebuilds it rather than raising.
    """
    global _slot, _slot_owner
    owner = (id(asyncio.get_running_loop()), max(1, limit))
    if _slot is None or _slot_owner != owner:
        _slot = asyncio.Semaphore(owner[1])
        _slot_owner = owner
    return _slot


async def _spawn(args: list[str]):
    kwargs: dict = {
        "stdout": asyncio.subprocess.DEVNULL,
        "stderr": asyncio.subprocess.PIPE,
    }
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    return await asyncio.create_subprocess_exec(*args, **kwargs)


def _decode_input(binary: str, source: str) -> list[str]:
    """FFmpeg's opening arguments for a file that is already on this disk.

    ``-protocol_whitelist file`` is the point: a media file can name other
    addresses — a playlist carried as a stream, a remote key — and without this
    FFmpeg would go and fetch them itself, past every check in this module. With
    it, FFmpeg can only read what is in front of it.
    """
    return [
        binary,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-protocol_whitelist",
        "file",
        "-i",
        source,
    ]


async def _stop(process: asyncio.subprocess.Process) -> None:
    """Kill FFmpeg and reap it, bounded so a second cancellation cannot strand the cleanup."""
    with contextlib.suppress(ProcessLookupError):
        process.kill()
    try:
        await asyncio.wait_for(process.wait(), timeout=5)
    except (TimeoutError, asyncio.CancelledError):
        pass


async def _run_ffmpeg(
    args: list[str], output: str, tmpdir: str, settings: Settings, min_bytes: int
) -> int:
    """Convert under the shared slot and return the output size.

    Every failure deletes ``tmpdir`` here, so a rejected download never leaves a
    half-written file waiting for the sweep.
    """
    async with conversion_slot(settings.max_concurrent_conversions):
        process = await _spawn(args)
        try:
            _, stderr = await asyncio.wait_for(
                process.communicate(), timeout=settings.convert_timeout
            )
        except TimeoutError as exc:
            await _stop(process)
            cleanup_dir(tmpdir)
            raise ServiceError(504, "convert_timeout", "Audio conversion took too long.") from exc
        except BaseException:
            # wait_for cancels its own task but not the child process, so a
            # visitor who closes the tab mid-conversion — or a ZIP job cancelled
            # while one of its tracks was still converting — would otherwise
            # leave FFmpeg running with an open file in a directory nobody owns.
            await _stop(process)
            cleanup_dir(tmpdir)
            raise

    if process.returncode != 0:
        message = _safe_process_error(stderr)
        cleanup_dir(tmpdir)
        raise ServiceError(502, "convert_failed", message)

    try:
        size = os.path.getsize(output)
    except OSError:
        cleanup_dir(tmpdir)
        raise ServiceError(502, "convert_failed", "FFmpeg produced no audio file.")

    if size <= min_bytes:
        cleanup_dir(tmpdir)
        raise ServiceError(502, "convert_failed", "FFmpeg produced an empty audio file.")
    if size > settings.max_convert_bytes:
        cleanup_dir(tmpdir)
        raise ServiceError(
            413,
            "convert_too_large",
            "The converted audio would exceed this server's size limit.",
        )
    return size


async def convert_to_wav(url: str, settings: Settings) -> tuple[str, str, int]:
    """Decode SoundCloud's authorized stream to 16-bit PCM WAV on disk.

    Returns (path, temp_dir, size). The caller removes temp_dir afterwards.
    """
    binary = ffmpeg_path()
    if not binary:
        raise ServiceError(503, "ffmpeg_missing", "FFmpeg is not installed on this server.")

    tmpdir = tempfile.mkdtemp(prefix=TEMP_PREFIX)
    output = os.path.join(tmpdir, "converted.wav")
    args = _decode_input(binary, await _stage(url, settings, tmpdir)) + [
        "-map",
        "0:a:0",
        "-vn",
        "-c:a",
        "pcm_s16le",
        "-f",
        "wav",
        output,
    ]
    size = await _run_ffmpeg(args, output, tmpdir, settings, WAV_HEADER_BYTES)
    return output, tmpdir, size


async def _stage(url: str, settings: Settings, tmpdir: str) -> str:
    """Fetch a source into ``tmpdir``, leaving no half-built directory behind."""
    try:
        return await stage_source(url, settings, tmpdir)
    except BaseException:
        cleanup_dir(tmpdir)
        raise


def _mp3_args(
    binary: str,
    source: str,
    output: str,
    bitrate: int,
    metadata: dict[str, str],
    cover: str | None,
) -> list[str]:
    args = _decode_input(binary, source)
    if cover:
        # The picture is a second input, so it needs its own map and the
        # attached_pic disposition that turns it into an ID3 APIC frame.
        args += ["-i", cover, "-map", "0:a:0", "-map", "1:v:0"]
        args += ["-c:v:0", "mjpeg", "-disposition:v:0", "attached_pic"]
    else:
        args += ["-map", "0:a:0", "-vn"]
    args += ["-c:a", "libmp3lame", "-b:a", f"{bitrate}k", "-id3v2_version", "3"]
    # SoundCloud's stream carries container tags (major_brand and friends) that
    # mean nothing in an MP3, so start from an empty tag block and write our own.
    args += ["-map_metadata", "-1"]
    for key, value in metadata.items():
        args += ["-metadata", f"{key}={value}"]
    return args + ["-f", "mp3", output]


async def _fetch_artwork(url: str, tmpdir: str, settings: Settings) -> str | None:
    """Save SoundCloud's own cover image next to the output, or give up quietly.

    A missing picture must never cost the visitor their audio, so every failure
    here returns None instead of raising.
    """
    if not is_allowed_source(url):
        return None
    ext = ext_from_url(url)
    if ext not in ("jpg", "jpeg", "png"):
        return None
    try:
        async with media_client(
            ARTWORK_TIMEOUT, headers={"User-Agent": settings.user_agent}
        ) as client:
            response = await client.get(url)
    except httpx.HTTPError:
        return None
    if response.status_code != 200 or not response.content:
        return None
    if len(response.content) > ARTWORK_MAX_BYTES:
        # A cover this size is not a cover; skip it rather than hand FFmpeg a
        # multi-megabyte second input for a file the visitor never asked for.
        return None
    path = os.path.join(tmpdir, f"cover.{'png' if ext == 'png' else 'jpg'}")
    try:
        async with await anyio.open_file(path, mode="wb") as file:
            await file.write(response.content)
    except OSError:
        # A picture that will not save must not cost the visitor their audio.
        with contextlib.suppress(OSError):
            os.remove(path)
        return None
    return path


async def _convert_mp3(
    binary: str,
    url: str,
    settings: Settings,
    bitrate: int,
    metadata: dict[str, str],
    artwork_url: str | None,
) -> tuple[str, str, int]:
    tmpdir = tempfile.mkdtemp(prefix=TEMP_PREFIX)
    output = os.path.join(tmpdir, "converted.mp3")
    source = await _stage(url, settings, tmpdir)
    cover = await _fetch_artwork(artwork_url, tmpdir, settings) if artwork_url else None
    args = _mp3_args(binary, source, output, bitrate, metadata, cover)
    size = await _run_ffmpeg(args, output, tmpdir, settings, 0)
    return output, tmpdir, size


async def convert_to_mp3(
    url: str,
    settings: Settings,
    bitrate: int,
    metadata: dict[str, str],
    artwork_url: str | None = None,
) -> tuple[str, str, int]:
    """Transcode SoundCloud's stream to an ID3-tagged MP3 on disk.

    Returns (path, temp_dir, size). The caller removes temp_dir afterwards.
    """
    if bitrate not in MP3_BITRATES:
        raise ServiceError(
            400, "bad_bitrate", "MP3 bitrate must be 128, 192, 256 or 320 kbps."
        )
    binary = ffmpeg_path()
    if not binary:
        raise ServiceError(503, "ffmpeg_missing", "FFmpeg is not installed on this server.")

    if artwork_url:
        try:
            return await _convert_mp3(binary, url, settings, bitrate, metadata, artwork_url)
        except ServiceError as exc:
            if exc.code != "convert_failed":
                raise
            # A second pass without the picture tells a bad cover from a bad stream.
    return await _convert_mp3(binary, url, settings, bitrate, metadata, None)


_serving: set[str] = set()


def _serving_key(path: str) -> str:
    return os.path.normcase(os.path.abspath(path))


async def stream_temp(path: str, tmpdir: str):
    """Yield a converted file, then delete the directory holding it.

    The ``finally`` also runs when the consumer abandons the generator, i.e.
    when the visitor closes the tab mid-download. FileResponse's background
    task does not survive that cancellation, so the converted audio would be
    left behind.
    """
    key = _serving_key(tmpdir)
    _serving.add(key)
    try:
        async with await anyio.open_file(path, mode="rb") as file:
            while chunk := await file.read(CHUNK):
                yield chunk
    finally:
        _serving.discard(key)
        cleanup_dir(tmpdir)


def _last_active(path: str) -> float:
    """Newest mtime of a temp directory or anything inside it.

    A running FFmpeg job keeps its output file's mtime current, so this is what
    keeps the sweep from deleting a conversion that is still in progress.
    """
    newest = os.stat(path).st_mtime
    with os.scandir(path) as entries:
        for entry in entries:
            try:
                newest = max(newest, entry.stat(follow_symlinks=False).st_mtime)
            except OSError:
                continue
    return newest


def sweep_temp_dirs(ttl_seconds: float, root: str | None = None) -> int:
    """Delete conversion temp dirs that have been idle past the TTL.

    Catches what the per-response cleanup cannot: directories orphaned by a
    crash or a restart in the middle of a download.
    """
    base = root or tempfile.gettempdir()
    cutoff = time.time() - ttl_seconds
    removed = 0
    try:
        entries = list(os.scandir(base))
    except OSError:
        return 0
    for entry in entries:
        if not entry.name.startswith(TEMP_PREFIX) or not entry.is_dir():
            continue
        if _serving_key(entry.path) in _serving:
            # Reading a file does not move its mtime, so a finished archive being
            # delivered over a slow connection looks idle long before the last
            # byte arrives. Deleting it then would truncate the download.
            continue
        try:
            stale = _last_active(entry.path) < cutoff
        except OSError:
            stale = True
        if stale:
            cleanup_dir(entry.path)
            removed += 1
    return removed


def _safe_process_error(stderr: bytes | None) -> str:
    text = (stderr or b"").decode("utf-8", "replace").strip()
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    line = lines[-1] if lines else "FFmpeg could not convert this stream."
    line = re.sub(r"https?://\S+", "[url]", line)
    return line[:240]
