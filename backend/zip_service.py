from __future__ import annotations

import asyncio
import os
import re
import shutil
import tempfile
import zipfile
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from config import Settings
from errors import ServiceError
from formats import safe_filename
from stream import TEMP_PREFIX, cleanup_dir

# Archive directories keep the "cloudmp3-" prefix, so the idle sweep in
# stream.sweep_temp_dirs reaps anything orphaned by a crash or a restart.
ZIP_PREFIX = f"{TEMP_PREFIX}zip-"

# SoundCloud's uploads and streams are already lossy-compressed containers;
# deflating them again costs CPU and saves almost nothing.
STORED_EXTS = frozenset(
    {"mp3", "m4a", "aac", "mp4", "ogg", "oga", "opus", "flac", "wma", "aiff", "wav"}
)

SEPARATORS = re.compile(r"[/\\]")
ENTRY_MAX = 180

# Free space kept back so an archive never fills the volume the operating
# system, the database or the next job needs. Checked against both roots a job
# writes to — the archive and the track being staged — before any copy starts.
MIN_FREE_BYTES = 256 * 1024 * 1024


@dataclass(frozen=True)
class ZipTrack:
    """One entry the visitor asked for, in the form the download API takes."""

    track_id: int
    mode: str = "original"
    quality: str = "high"
    bitrate: int | None = None


@dataclass
class TrackFile:
    """A single track materialised on disk, ready to enter the archive."""

    path: str
    tmpdir: str
    ext: str
    name: str


@dataclass
class ZipArchive:
    path: str
    tmpdir: str
    size: int
    entries: list[str] = field(default_factory=list)
    failed: list[dict[str, Any]] = field(default_factory=list)


# The caller turns a ZipTrack into bytes on disk. Keeping it injected means this
# module never touches the network, so the archive logic is testable on its own.
Producer = Callable[[ZipTrack], Awaitable[TrackFile]]

_slot: asyncio.Semaphore | None = None
_slot_owner: tuple[int, int] | None = None


def zip_slot(limit: int) -> asyncio.Semaphore:
    """The cap on concurrent ZIP jobs, separate from the FFmpeg slot.

    A job spends most of its life waiting on downloads and conversions rather
    than running FFmpeg, so the two limits are configured and measured apart.
    """
    global _slot, _slot_owner
    owner = (id(asyncio.get_running_loop()), max(1, limit))
    if _slot is None or _slot_owner != owner:
        _slot = asyncio.Semaphore(owner[1])
        _slot_owner = owner
    return _slot


def zip_temp_root(settings: Settings) -> str | None:
    """Where archives get built, or None for the system temp directory."""
    if not settings.zip_temp_dir:
        return None
    os.makedirs(settings.zip_temp_dir, exist_ok=True)
    return settings.zip_temp_dir


def new_archive_dir(settings: Settings) -> tuple[str, str]:
    tmpdir = tempfile.mkdtemp(prefix=ZIP_PREFIX, dir=zip_temp_root(settings))
    return os.path.join(tmpdir, "archive.zip"), tmpdir


def entry_extension(ext: str | None) -> str:
    cleaned = (ext or "").strip().lower().lstrip(".")
    return cleaned if re.fullmatch(r"[a-z0-9]{1,6}", cleaned) else "bin"


def compress_type(ext: str) -> int:
    return zipfile.ZIP_STORED if ext in STORED_EXTS else zipfile.ZIP_DEFLATED


def numbered(index: int, total: int, name: str) -> str:
    """Prefix each entry with its playlist position, so duplicates never collide.

    The pad width follows the job size rather than a fixed two digits, so the
    files still sort in order in a shell after MAX_ZIP_TRACKS is raised.
    """
    width = max(2, len(str(total)))
    prefix = f"{index + 1:0{width}d} "
    return safe_filename(f"{prefix}{name}", f"track-{index + 1}")


def assert_entry(name: str) -> str:
    """Reject anything that could write outside the archive or confuse a client.

    Names built here come from SoundCloud through safe_filename, which already
    turns separators and control characters into underscores, so a match means a
    caller skipped it. "Ghost .. Town" is a legal title and stays legal.
    """
    cleaned = name.strip().strip("\\/")
    if not cleaned:
        raise ServiceError(500, "zip_naming", "A track produced no usable filename.")
    if SEPARATORS.search(cleaned) or cleaned.startswith(".") or re.search(r"[\x00-\x1f]", cleaned):
        raise ServiceError(500, "zip_naming", "A track produced an unusable filename.")
    if len(cleaned) > ENTRY_MAX:
        cleaned = safe_filename(cleaned, "track")[:ENTRY_MAX]
    return cleaned


def _add_entry(zf: zipfile.ZipFile, file: TrackFile, arcname: str) -> int:
    """Copy one track into the open archive from disk and return its size."""
    size = os.path.getsize(file.path)
    try:
        zf.write(file.path, arcname=arcname, compress_type=compress_type(entry_extension(file.ext)))
    except OSError as exc:
        # Disk full is the failure an operator can act on, and it looks nothing
        # like the ones the visitor caused.
        raise ServiceError(
            507, "zip_disk_full", "This server ran out of scratch space building the ZIP."
        ) from exc
    return size


def require_room(file: TrackFile, archive_dir: str) -> None:
    """Refuse to start a copy the volumes cannot finish.

    Runs off the event loop: one ``statvfs`` per track is nothing next to the
    copy, but it is still a blocking call.
    """
    size = os.path.getsize(file.path)
    for root in (file.tmpdir, archive_dir):
        try:
            free = shutil.disk_usage(root).free
        except OSError:
            continue
        if free - size < MIN_FREE_BYTES:
            raise ServiceError(
                507,
                "zip_disk_full",
                "This server does not have enough free space left to pack another track.",
            )


async def build_archive(
    tracks: list[ZipTrack], settings: Settings, producer: Producer
) -> ZipArchive:
    """Pack every requested track into one archive on disk.

    Nothing here is held in memory beyond the chunk the zip module copies, and
    the directory is deleted on every exit path, cancellation included.
    """
    if not tracks:
        raise ServiceError(400, "no_tracks", "Choose at least one track for the ZIP.")
    if len(tracks) > settings.max_zip_tracks:
        raise ServiceError(
            413,
            "too_many_tracks",
            f"This server packs at most {settings.max_zip_tracks} tracks per ZIP.",
        )

    try:
        async with asyncio.timeout(settings.zip_timeout):
            async with zip_slot(settings.max_concurrent_zip_jobs):
                # The archive directory is made inside the slot. A job that waits
                # behind the cap would otherwise leave an empty directory on disk,
                # and the TEMP_TTL_SECONDS sweep can delete it before its turn
                # arrives — after which the build fails for no reason the visitor
                # can act on. The timeout still covers that wait, so a queued job
                # gets its 504 rather than packing after a long stall.
                return await _write_archive(tracks, settings, producer)
    except TimeoutError as exc:
        raise ServiceError(
            504, "zip_timeout", "Building this ZIP took longer than the server allows."
        ) from exc


async def _write_archive(
    tracks: list[ZipTrack],
    settings: Settings,
    producer: Producer,
) -> ZipArchive:
    path, tmpdir = new_archive_dir(settings)
    archive = ZipArchive(path=path, tmpdir=tmpdir, size=0)
    total = 0

    try:
        with zipfile.ZipFile(path, "w", allowZip64=True) as zf:
            for index, track in enumerate(tracks):
                try:
                    file = await producer(track)
                except ServiceError as exc:
                    archive.failed.append(
                        {"trackId": track.track_id, "code": exc.code, "message": exc.message}
                    )
                    continue
                except Exception as exc:
                    archive.failed.append(
                        {
                            "trackId": track.track_id,
                            "message": "This track could not be downloaded.",
                            "code": getattr(exc, "code", "track_failed"),
                        }
                    )
                    continue

                try:
                    arcname = assert_entry(numbered(index, len(tracks), file.name))
                    size = os.path.getsize(file.path)
                    # The limit is applied to the copy about to happen, not to the
                    # archive afterwards: a stored audio entry adds about the size of
                    # its file, so checking first keeps the peak on disk at
                    # max_zip_bytes plus one track rather than plus two.
                    if total + size > settings.max_zip_bytes:
                        raise ServiceError(
                            413,
                            "zip_too_large",
                            "These tracks together exceed this server's ZIP size limit.",
                        )
                    await asyncio.to_thread(require_room, file, tmpdir)
                    total += await asyncio.to_thread(_add_entry, zf, file, arcname)
                    archive.entries.append(arcname)
                finally:
                    # The track's own copy has served its purpose; the archive holds it.
                    cleanup_dir(file.tmpdir)

        if not archive.entries:
            reason = archive.failed[0]["message"] if archive.failed else "No track could be fetched."
            raise ServiceError(502, "zip_empty", reason)

        archive.size = os.path.getsize(path)
        return archive
    except BaseException:
        # Every exit — an oversized archive, a timeout, a visitor who left — takes
        # the half-built file and its directory with it.
        cleanup_dir(tmpdir)
        raise


def zip_filename(name: str | None) -> str:
    """The download name the visitor sees, always ending in .zip."""
    base = safe_filename((name or "").strip() or "CloudMP3-Playlist", "CloudMP3-Playlist")
    base = re.sub(r"\.zip$", "", base, flags=re.IGNORECASE)
    return f"{base or 'CloudMP3-Playlist'}.zip"
