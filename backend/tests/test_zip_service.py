from __future__ import annotations

import asyncio
import os
import tempfile
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest

import zip_service
from config import Settings
from errors import ServiceError
from zip_service import TrackFile, ZipTrack


def make_settings(tmp_path: Path, **overrides) -> Settings:
    values = {
        "service_key": "key",
        "client_id": "client-id",
        "client_secret": "client-secret",
        "refresh_token": "",
        "access_token": "token",
        "token_store": tmp_path / "token.json",
        "ytdlp_timeout": 10,
        "convert_timeout": 10,
        "max_convert_bytes": 10 * 1024 * 1024,
        "temp_ttl_seconds": 300,
        "max_concurrent_conversions": 2,
        "zip_temp_dir": str(tmp_path / "zips"),
    }
    values.update(overrides)
    return Settings(**values)


class Producer:
    """Stands in for the network: writes each track to its own temp dir on disk."""

    def __init__(
        self,
        payload: bytes = b"audio-bytes",
        ext: str = "mp3",
        hold: asyncio.Event | None = None,
    ) -> None:
        self.payload = payload
        self.ext = ext
        self.hold = hold
        self.requested: list[int] = []
        self.dirs: list[str] = []
        self.fail: set[int] = set()
        self.errors: set[int] = set()
        self.active = 0
        self.peak = 0

    def name_for(self, track_id: int) -> str:
        return f"Artist - Title {track_id}.{self.ext}"

    async def __call__(self, track: ZipTrack) -> TrackFile:
        self.requested.append(track.track_id)
        self.active += 1
        self.peak = max(self.peak, self.active)
        try:
            if self.hold is not None:
                await self.hold.wait()
            if track.track_id in self.fail:
                raise ServiceError(409, "no_stream", "SoundCloud has no stream for this track.")
            if track.track_id in self.errors:
                raise RuntimeError("the disk went away")
            tmpdir = tempfile.mkdtemp(prefix="cloudmp3-")
            self.dirs.append(tmpdir)
            path = os.path.join(tmpdir, f"track.{self.ext}")
            Path(path).write_bytes(self.payload)
            return TrackFile(path, tmpdir, self.ext, self.name_for(track.track_id))
        finally:
            self.active -= 1


def tracks(*ids: int) -> list[ZipTrack]:
    return [ZipTrack(track_id) for track_id in ids]


class FakeDisk:
    """Stand-in for shutil: every volume reports the same number of free bytes."""

    def __init__(self, free: int) -> None:
        self.free = free

    def disk_usage(self, path: str):
        return SimpleNamespace(total=0, used=0, free=self.free)


def entries_of(path: str) -> dict[str, bytes]:
    with zipfile.ZipFile(path) as archive:
        return {info.filename: archive.read(info.filename) for info in archive.infolist()}


async def test_builds_a_valid_zip_holding_every_track(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    producer = Producer(payload=b"first-track")

    archive = await zip_service.build_archive(tracks(1, 2, 3), settings, producer)

    assert archive.entries == [
        "01 Artist - Title 1.mp3",
        "02 Artist - Title 2.mp3",
        "03 Artist - Title 3.mp3",
    ]
    assert not archive.failed
    assert archive.size == os.path.getsize(archive.path)
    assert zipfile.is_zipfile(archive.path)
    assert entries_of(archive.path)["02 Artist - Title 2.mp3"] == b"first-track"
    # The archive was built in the configured root, and every track's own copy is gone.
    assert archive.tmpdir.startswith(str(tmp_path / "zips"))
    assert producer.dirs and all(not os.path.isdir(directory) for directory in producer.dirs)


async def test_duplicate_titles_do_not_overwrite_each_other(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)

    class SameName(Producer):
        def name_for(self, track_id: int) -> str:
            return "Artist - Same Song.mp3"

    archive = await zip_service.build_archive(tracks(7, 7, 7), settings, SameName(b"body"))

    assert len(set(archive.entries)) == 3
    assert set(entries_of(archive.path)) == set(archive.entries)
    assert all(content == b"body" for content in entries_of(archive.path).values())


async def test_numbering_pads_for_a_large_job(tmp_path: Path) -> None:
    settings = make_settings(tmp_path, max_zip_tracks=120)
    archive = await zip_service.build_archive(tracks(*range(1, 101)), settings, Producer())

    assert archive.entries[0] == "001 Artist - Title 1.mp3"
    assert archive.entries[9] == "010 Artist - Title 10.mp3"


async def test_packs_lossy_audio_without_deflating_it(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    stored = await zip_service.build_archive(tracks(1), settings, Producer(ext="wav"))
    with zipfile.ZipFile(stored.path) as archive:
        assert archive.infolist()[0].compress_type == zipfile.ZIP_STORED

    # An extension SoundCloud does not normally hand out is worth deflating.
    loose = b"a" * 4096
    deflated = await zip_service.build_archive(tracks(1), settings, Producer(loose, ext="bin"))
    with zipfile.ZipFile(deflated.path) as archive:
        assert archive.infolist()[0].compress_type == zipfile.ZIP_DEFLATED
        assert archive.read(archive.namelist()[0]) == loose


async def test_limits_are_refused_before_anything_is_fetched(tmp_path: Path) -> None:
    settings = make_settings(tmp_path, max_zip_tracks=2)
    producer = Producer()

    with pytest.raises(ServiceError) as empty:
        await zip_service.build_archive([], settings, producer)
    assert (empty.value.status, empty.value.code) == (400, "no_tracks")

    with pytest.raises(ServiceError) as too_many:
        await zip_service.build_archive(tracks(1, 2, 3), settings, producer)
    assert (too_many.value.status, too_many.value.code) == (413, "too_many_tracks")

    assert producer.requested == []
    root = tmp_path / "zips"
    assert not root.exists() or os.listdir(root) == []


async def test_oversized_total_is_refused_and_cleaned_up(tmp_path: Path) -> None:
    settings = make_settings(tmp_path, max_zip_bytes=8)
    producer = Producer(payload=b"x" * 64)

    with pytest.raises(ServiceError) as excinfo:
        await zip_service.build_archive(tracks(1, 2), settings, producer)

    assert (excinfo.value.status, excinfo.value.code) == (413, "zip_too_large")
    assert not os.path.isdir(producer.dirs[0])
    assert os.listdir(str(tmp_path / "zips")) == []


async def test_the_size_limit_stops_the_copy_that_would_break_it(
    tmp_path: Path, monkeypatch
) -> None:
    settings = make_settings(tmp_path, max_zip_bytes=100)
    producer = Producer(payload=b"x" * 60)
    copies: list[str] = []
    write = zip_service._add_entry

    def counted(zf, file, arcname):
        copies.append(arcname)
        return write(zf, file, arcname)

    monkeypatch.setattr(zip_service, "_add_entry", counted)

    with pytest.raises(ServiceError) as excinfo:
        await zip_service.build_archive(tracks(1, 2, 3), settings, producer)

    assert (excinfo.value.status, excinfo.value.code) == (413, "zip_too_large")
    # Two 60-byte tracks already exceed a 100-byte cap, so the second one is never
    # copied. Checking the limit after each write would put the archive past its own
    # ceiling by a whole track before noticing, and peak scratch space is the number
    # an operator has to size the volume for — not the finished size.
    assert copies == ["01 Artist - Title 1.mp3"]
    assert os.listdir(str(tmp_path / "zips")) == []


async def test_a_broken_track_is_skipped_and_reported(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    producer = Producer()
    producer.fail = {2}
    producer.errors = {3}

    archive = await zip_service.build_archive(tracks(1, 2, 3, 4), settings, producer)

    assert archive.entries == [
        "01 Artist - Title 1.mp3",
        "04 Artist - Title 4.mp3",
    ]
    assert archive.failed == [
        {"trackId": 2, "code": "no_stream", "message": "SoundCloud has no stream for this track."},
        {"trackId": 3, "code": "track_failed", "message": "This track could not be downloaded."},
    ]
    with zipfile.ZipFile(archive.path) as opened:
        assert opened.namelist() == archive.entries


async def test_nothing_usable_is_a_502_not_an_empty_zip(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    producer = Producer()
    producer.fail = {1}
    producer.errors = {2}

    with pytest.raises(ServiceError) as excinfo:
        await zip_service.build_archive(tracks(1, 2), settings, producer)

    assert (excinfo.value.status, excinfo.value.code) == (502, "zip_empty")
    assert os.listdir(str(tmp_path / "zips")) == []


async def test_timeout_deletes_the_partial_archive(tmp_path: Path) -> None:
    settings = make_settings(tmp_path, zip_timeout=0.05)
    producer = Producer(hold=asyncio.Event())

    with pytest.raises(ServiceError) as excinfo:
        await zip_service.build_archive(tracks(1), settings, producer)

    assert (excinfo.value.status, excinfo.value.code) == (504, "zip_timeout")
    assert os.listdir(str(tmp_path / "zips")) == []


async def test_cancellation_deletes_the_partial_archive(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    producer = Producer(hold=asyncio.Event())

    task = asyncio.create_task(zip_service.build_archive(tracks(1, 2), settings, producer))
    await asyncio.sleep(0.02)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert os.listdir(str(tmp_path / "zips")) == []


async def test_zip_jobs_share_their_own_semaphore(tmp_path: Path) -> None:
    settings = make_settings(tmp_path, max_concurrent_zip_jobs=1)
    release = asyncio.Event()
    producers = [Producer(hold=release) for _ in range(3)]

    running = [
        asyncio.create_task(zip_service.build_archive(tracks(number), settings, producer))
        for number, producer in enumerate(producers, start=1)
    ]
    await asyncio.sleep(0.02)
    assert sum(producer.active for producer in producers) == 1

    release.set()
    archives = await asyncio.gather(*running)
    assert [archive.entries for archive in archives] == [
        ["01 Artist - Title 1.mp3"],
        ["01 Artist - Title 2.mp3"],
        ["01 Artist - Title 3.mp3"],
    ]
    assert [producer.peak for producer in producers] == [1, 1, 1]


async def test_a_queued_job_holds_no_archive_directory_yet(tmp_path: Path) -> None:
    """Waiting for a slot costs nothing on disk, so the idle sweep has nothing to eat.

    sweep_temp_dirs deletes temp directories that look idle. A directory made
    before the wait would age out while its job sat queued, and the build would
    then fail on its own missing path for a reason the visitor can act on.
    """
    settings = make_settings(tmp_path, max_concurrent_zip_jobs=1)
    release = asyncio.Event()
    first = Producer(hold=release)
    second = Producer()

    running = asyncio.create_task(zip_service.build_archive(tracks(1), settings, first))
    queued = asyncio.create_task(zip_service.build_archive(tracks(2), settings, second))
    await asyncio.sleep(0.05)

    assert not queued.done()
    assert len(os.listdir(str(tmp_path / "zips"))) == 1

    release.set()
    await asyncio.gather(running, queued)
    assert len(os.listdir(str(tmp_path / "zips"))) == 2


def test_entry_names_cannot_escape_the_archive() -> None:
    for unsafe in ("../evil.mp3", "/etc/passwd", "..\\escape.mp3", ".hidden.mp3", "a\x00b.mp3"):
        with pytest.raises(ServiceError) as excinfo:
            zip_service.assert_entry(unsafe)
        assert (excinfo.value.status, excinfo.value.code) == (500, "zip_naming")

    assert zip_service.assert_entry("01 Artist - Title.mp3") == "01 Artist - Title.mp3"


def test_hostile_titles_are_sanitised_before_entry() -> None:
    name = zip_service.numbered(0, 1, "../../Windows - System32.mp3")

    assert name == "01 .._.._Windows - System32.mp3"
    assert zip_service.assert_entry(name) == name


def test_download_name_always_ends_in_zip() -> None:
    assert zip_service.zip_filename(None) == "CloudMP3-Playlist.zip"
    assert zip_service.zip_filename("") == "CloudMP3-Playlist.zip"
    assert zip_service.zip_filename("An Album / 2026") == "An Album _ 2026.zip"
    assert zip_service.zip_filename("already.zip") == "already.zip"


def test_room_is_reserved_for_the_track_and_the_free_floor(tmp_path: Path, monkeypatch) -> None:
    track = tmp_path / "track.mp3"
    track.write_bytes(b"x" * 4096)
    file = TrackFile(str(track), str(tmp_path), "mp3", "Artist - Title.mp3")

    # Exactly enough: the copy fits and the reserve is still standing.
    monkeypatch.setattr(zip_service, "shutil", FakeDisk(zip_service.MIN_FREE_BYTES + 4096))
    zip_service.require_room(file, str(tmp_path))

    monkeypatch.setattr(zip_service, "shutil", FakeDisk(zip_service.MIN_FREE_BYTES + 4095))
    with pytest.raises(ServiceError) as excinfo:
        zip_service.require_room(file, str(tmp_path))
    assert (excinfo.value.status, excinfo.value.code) == (507, "zip_disk_full")


async def test_a_full_scratch_volume_stops_the_job_before_the_copy(
    tmp_path: Path, monkeypatch
) -> None:
    settings = make_settings(tmp_path)
    producer = Producer(payload=b"audio-bytes")
    monkeypatch.setattr(zip_service, "shutil", FakeDisk(zip_service.MIN_FREE_BYTES - 1))

    with pytest.raises(ServiceError) as excinfo:
        await zip_service.build_archive(tracks(1, 2), settings, producer)

    assert (excinfo.value.status, excinfo.value.code) == (507, "zip_disk_full")
    # A refused job leaves nothing behind on either volume.
    assert os.listdir(str(tmp_path / "zips")) == []
    assert producer.dirs and all(not os.path.isdir(directory) for directory in producer.dirs)


def test_a_copy_that_fails_on_disk_is_reported_as_a_full_disk(tmp_path: Path) -> None:
    path = tmp_path / "track.mp3"
    path.write_bytes(b"audio-bytes")
    file = TrackFile(str(path), str(tmp_path), "mp3", "Artist - Title.mp3")

    class NoRoomArchive:
        def write(self, *args, **kwargs):
            raise OSError(28, "No space left on device")

    with pytest.raises(ServiceError) as excinfo:
        zip_service._add_entry(NoRoomArchive(), file, "01 Artist - Title.mp3")

    assert (excinfo.value.status, excinfo.value.code) == (507, "zip_disk_full")
