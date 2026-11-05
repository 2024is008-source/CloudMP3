from __future__ import annotations

import errno

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


COPY_BUFFER = 1024 * 1024


def _add_entry(zf: zipfile.ZipFile, file: TrackFile, arcname: str) -> int:
    """Copy one track into the open archive from disk and return its size."""
    size = os.path.getsize(file.path)
    info = zipfile.ZipInfo.from_file(file.path, arcname=arcname)
    info.compress_type = compress_type(entry_extension(file.ext))
    try:
        if hasattr(zf, "open"):
            with open(file.path, "rb") as src, zf.open(
                info, "w", force_zip64=size >= zipfile.ZIP64_LIMIT
            ) as dest:
                shutil.copyfileobj(src, dest, COPY_BUFFER)
        else:
            # Compatibility path for archive-like writers used by tests.
            with open(file.path, "rb") as src:
                while True:
                    chunk = src.read(COPY_BUFFER)
                    if not chunk:
                        break
                    zf.write(chunk)
    except OSError as exc:
        # Disk full is the failure an operator can act on, and it looks nothing
        # like the ones the visitor caused.
        if getattr(exc, "errno", None) == errno.ENOSPC:
            raise ServiceError(
                507,
                "zip_disk_full",
                "This server ran out of scratch space building the ZIP.",
            ) from exc
        raise
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


class _AppendOnly:
    """A file the zip module cannot seek back into.

    zipfile then writes sizes in data descriptors after each entry instead of
    patching headers it already wrote, so every byte on disk is final the
    moment it lands and can be streamed to the visitor while packing goes on.
    """

    def __init__(self, path: str) -> None:
        self._file = open(path, "wb", buffering=0)
        self._pos = 0

    def write(self, data) -> int:
        # A raw file may accept fewer bytes than offered, and zipfile ignores the
        # return value, so keep going until every byte has landed.
        view = memoryview(data).cast("B")
        total = len(view)
        while len(view):
            accepted = self._file.write(view) or 0
            view = view[accepted:]
            self._pos += accepted
        return total

    def tell(self) -> int:
        return self._pos

    def seekable(self) -> bool:
        return False

    def seek(self, *_args) -> int:
        raise OSError("append-only")

    def flush(self) -> None:
        pass

    def close(self) -> None:
        self._file.close()

    def __enter__(self) -> "_AppendOnly":
        return self

    def __exit__(self, *_exc) -> None:
        self.close()


def _failure_note(failed: list[dict[str, Any]]) -> str:
    lines = ["These tracks could not be added to the ZIP:", ""]
    for item in failed:
        lines.append(f"- Track {item['trackId']}: {item['message']}")
    return "\n".join(lines) + "\n"


MISSING_NOTE = "missing-tracks.txt"


async def build_archive(
    tracks: list[ZipTrack],
    settings: Settings,
    producer: Producer,
    started: asyncio.Event | None = None,
    note_failures: bool = False,
    on_open: Callable[[dict[str, Any]], None] | None = None,
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
                return await _write_archive(tracks, settings, producer, started, note_failures, on_open)
    except TimeoutError as exc:
        raise ServiceError(
            504, "zip_timeout", "Building this ZIP took longer than the server allows."
        ) from exc


async def _write_archive(
    tracks: list[ZipTrack],
    settings: Settings,
    producer: Producer,
    started: asyncio.Event | None = None,
    note_failures: bool = False,
    on_open: Callable[[dict[str, Any]], None] | None = None,
) -> ZipArchive:
    path, tmpdir = new_archive_dir(settings)
    archive = ZipArchive(path=path, tmpdir=tmpdir, size=0)
    if on_open is not None:
        on_open({"path": path, "tmpdir": tmpdir, "archive": archive})
    total = 0

    # Tracks are fetched/converted up to ``lookahead`` at a time while entries are
    # written strictly in playlist order. The window slides only as tracks are
    # packed, so at most that many staged tracks wait on disk beside the archive
    # no matter how long the playlist is or how slow the writer gets.
    lookahead = max(1, min(getattr(settings, "zip_fetch_concurrency", 4), len(tracks)))
    tasks: list[asyncio.Task[TrackFile] | None] = [None] * len(tracks)
    begun = 0

    def start_more(consumed: int) -> None:
        nonlocal begun
        while begun < len(tracks) and begun < consumed + lookahead:
            tasks[begun] = asyncio.create_task(producer(tracks[begun]))
            begun += 1

    try:
        sink = _AppendOnly(path)
        with sink, zipfile.ZipFile(sink, "w", allowZip64=True) as zf:
            start_more(0)
            for index, track in enumerate(tracks):
                task = tasks[index]
                assert task is not None
                try:
                    file = await task
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    archive.failed.append(_failure(track, exc))
                    tasks[index] = None
                    start_more(index + 1)
                    continue
                tasks[index] = None
                # Free a slot before packing, so the next fetch overlaps this write.
                start_more(index + 1)

                try:
                    arcname = assert_entry(numbered(index, len(tracks), file.name))
                    size = os.path.getsize(file.path)
                    # The limit is applied to the copy about to happen, not to the
                    # archive afterwards: a stored audio entry adds about the size of
                    # its file, so checking first keeps the peak on disk at
                    # max_zip_bytes plus the staged window.
                    if total + size > settings.max_zip_bytes:
                        raise ServiceError(
                            413,
                            "zip_too_large",
                            "These tracks together exceed this server's ZIP size limit.",
                        )
                    await asyncio.to_thread(require_room, file, tmpdir)
                    total += await asyncio.to_thread(_add_entry, zf, file, arcname)
                    archive.entries.append(arcname)
                    if started is not None:
                        started.set()
                finally:
                    # The track's own copy has served its purpose; the archive holds it.
                    cleanup_dir(file.tmpdir)

            if note_failures and archive.entries and archive.failed:
                zf.writestr(MISSING_NOTE, _failure_note(archive.failed))

        if not archive.entries:
            reason = archive.failed[0]["message"] if archive.failed else "No track could be fetched."
            raise ServiceError(502, "zip_empty", reason)

        archive.size = os.path.getsize(path)
        return archive
    except BaseException:
        # Every exit — an oversized archive, a timeout, a visitor who left — takes
        # the half-built file, its directory and any tracks still in flight with it.
        # The directory goes first and synchronously, so a second cancellation
        # during the awaits below cannot strand it.
        cleanup_dir(tmpdir)
        await asyncio.shield(_discard_pending(tasks))
        raise


def _failure(track: ZipTrack, exc: BaseException) -> dict[str, Any]:
    if isinstance(exc, ServiceError):
        return {"trackId": track.track_id, "code": exc.code, "message": exc.message}
    return {
        "trackId": track.track_id,
        "message": "This track could not be downloaded.",
        "code": getattr(exc, "code", "track_failed"),
    }


async def _discard_pending(tasks: list["asyncio.Task[TrackFile] | None"]) -> None:
    """Cancel tracks still in flight and delete the staging dir of finished ones."""
    live = [t for t in tasks if t is not None]
    for task in live:
        if not task.done():
            task.cancel()
    results = await asyncio.gather(*live, return_exceptions=True)
    for result in results:
        if isinstance(result, TrackFile):
            cleanup_dir(result.tmpdir)


def zip_filename(name: str | None) -> str:
    """The download name the visitor sees, always ending in .zip."""
    base = safe_filename((name or "").strip() or "CloudMP3-Playlist", "CloudMP3-Playlist")
    base = re.sub(r"\.zip$", "", base, flags=re.IGNORECASE)
    return f"{base or 'CloudMP3-Playlist'}.zip"
