from __future__ import annotations

import asyncio
import os
import re
import shutil
import subprocess
import sys
import tempfile

import httpx

from config import Settings
from errors import ServiceError

CHUNK = 64 * 1024
NETWORK_TIMEOUT = httpx.Timeout(connect=30.0, read=120.0, write=30.0, pool=30.0)


async def _chunks(url: str, user_agent: str):
    async with httpx.AsyncClient(
        timeout=NETWORK_TIMEOUT,
        follow_redirects=True,
        headers={"User-Agent": user_agent},
    ) as client:
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


async def convert_to_wav(url: str, settings: Settings) -> tuple[str, str, int]:
    """Decode SoundCloud's authorized stream to 16-bit PCM WAV on disk.

    Returns (path, temp_dir, size). The caller removes temp_dir afterwards.
    """
    binary = ffmpeg_path()
    if not binary:
        raise ServiceError(503, "ffmpeg_missing", "FFmpeg is not installed on this server.")

    tmpdir = tempfile.mkdtemp(prefix="cloudmp3-")
    output = os.path.join(tmpdir, "converted.wav")
    args = [
        binary,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-rw_timeout",
        "30000000",
        "-user_agent",
        settings.user_agent,
        "-i",
        url,
        "-map",
        "0:a:0",
        "-vn",
        "-c:a",
        "pcm_s16le",
        "-f",
        "wav",
        output,
    ]
    kwargs: dict = {
        "stdout": asyncio.subprocess.DEVNULL,
        "stderr": asyncio.subprocess.PIPE,
    }
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW

    process = await asyncio.create_subprocess_exec(*args, **kwargs)
    try:
        _, stderr = await asyncio.wait_for(process.communicate(), timeout=settings.convert_timeout)
    except asyncio.TimeoutError as exc:
        process.kill()
        await process.wait()
        shutil.rmtree(tmpdir, ignore_errors=True)
        raise ServiceError(504, "convert_timeout", "Audio conversion took too long.") from exc

    if process.returncode != 0:
        message = _safe_process_error(stderr)
        shutil.rmtree(tmpdir, ignore_errors=True)
        raise ServiceError(502, "convert_failed", message)

    try:
        size = os.path.getsize(output)
    except OSError:
        shutil.rmtree(tmpdir, ignore_errors=True)
        raise ServiceError(502, "convert_failed", "FFmpeg produced no audio file.")

    if size <= 44:
        shutil.rmtree(tmpdir, ignore_errors=True)
        raise ServiceError(502, "convert_failed", "FFmpeg produced an empty audio file.")
    if size > settings.max_convert_bytes:
        shutil.rmtree(tmpdir, ignore_errors=True)
        raise ServiceError(
            413,
            "convert_too_large",
            "The converted WAV would exceed this server's size limit.",
        )
    return output, tmpdir, size


def cleanup_dir(path: str) -> None:
    shutil.rmtree(path, ignore_errors=True)


def _safe_process_error(stderr: bytes | None) -> str:
    text = (stderr or b"").decode("utf-8", "replace").strip()
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    line = lines[-1] if lines else "FFmpeg could not convert this stream."
    line = re.sub(r"https?://\S+", "[url]", line)
    return line[:240]
