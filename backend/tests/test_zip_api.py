from __future__ import annotations

import asyncio
import io
import os
import tempfile
import time
import zipfile
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from typing import ClassVar

import pytest
from fastapi.testclient import TestClient

import main
from errors import ServiceError
from zip_service import TrackFile, ZipTrack

HEADERS = {"X-Api-Key": "test-key"}


@pytest.fixture
def service(monkeypatch, tmp_path: Path):
    """The real app with a test key, a private ZIP root and no outbound calls."""

    async def never(*_args, **_kwargs):
        raise AssertionError("this request should have been rejected before fetching")

    settings = replace(
        main.settings,
        service_key="test-key",
        zip_temp_dir=str(tmp_path / "zips"),
        max_zip_tracks=3,
    )
    monkeypatch.setattr(main, "settings", settings)
    monkeypatch.setattr(main, "build_archive", never)
    return TestClient(main.app)


class StubSource:
    """Replaces main._zip_source: writes a track onto disk without touching SoundCloud."""

    EXT: ClassVar[dict[str, str]] = {"mp3": "mp3", "wav": "wav", "original": "m4a"}

    def __init__(self, payload: bytes = b"track-bytes", missing: tuple[int, ...] = ()) -> None:
        self.payload = payload
        self.missing = set(missing)
        self.seen: list[ZipTrack] = []
        self.dirs: list[str] = []

    async def __call__(self, track: ZipTrack) -> TrackFile:
        self.seen.append(track)
        if track.track_id in self.missing:
            raise ServiceError(409, "no_stream", "SoundCloud has no stream for this track.")
        ext = self.EXT[track.mode]
        tmpdir = tempfile.mkdtemp(prefix="cloudmp3-")
        self.dirs.append(tmpdir)
        path = os.path.join(tmpdir, f"track.{ext}")
        Path(path).write_bytes(self.payload)
        return TrackFile(path, tmpdir, ext, f"Artist - Title {track.track_id}.{ext}")


def body(*tracks: dict, name: str = "My Playlist") -> dict:
    return {"name": name, "tracks": [dict(track) for track in tracks]}


def test_zip_requires_the_service_key(service: TestClient) -> None:
    response = service.post("/api/download/zip", json=body({"id": 1}))
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"


def test_zip_rejects_a_body_that_is_not_json(service: TestClient) -> None:
    response = service.post(
        "/api/download/zip",
        content=b"not json",
        headers={**HEADERS, "Content-Type": "application/json"},
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "bad_body"


def test_zip_rejects_a_missing_or_empty_track_list(service: TestClient) -> None:
    assert (
        service.post("/api/download/zip", json={}, headers=HEADERS).json()["error"]["code"]
        == "no_tracks"
    )
    empty = service.post("/api/download/zip", json={"tracks": []}, headers=HEADERS)
    assert empty.status_code == 400
    assert empty.json()["error"]["code"] == "no_tracks"


def test_zip_rejects_invalid_track_ids(service: TestClient) -> None:
    for bad in ({"id": "one"}, {"id": 0}, {"id": -5}, {"id": None}, {}):
        response = service.post("/api/download/zip", json=body(bad), headers=HEADERS)
        assert response.status_code == 400, bad
        assert response.json()["error"]["code"] == "bad_track_id"


def test_zip_rejects_invalid_formats(service: TestClient) -> None:
    cases = {
        "bad_mode": {"id": 1, "mode": "remux"},
        "bad_quality": {"id": 1, "mode": "mp3", "quality": "lossless"},
        "bad_bitrate": {"id": 1, "mode": "mp3", "bitrate": 999},
    }
    for code, track in cases.items():
        response = service.post("/api/download/zip", json=body(track), headers=HEADERS)
        assert response.status_code == 400, track
        assert response.json()["error"]["code"] == code


def test_zip_rejects_a_track_that_is_not_an_object(service: TestClient) -> None:
    response = service.post("/api/download/zip", json={"tracks": ["1"]}, headers=HEADERS)
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "bad_track"


def test_zip_rejects_more_tracks_than_configured(service: TestClient) -> None:
    response = service.post(
        "/api/download/zip",
        json=body({"id": 1}, {"id": 2}, {"id": 3}, {"id": 4}),
        headers=HEADERS,
    )
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "too_many_tracks"


def test_zip_rejects_a_non_text_name(service: TestClient) -> None:
    response = service.post(
        "/api/download/zip", json={"name": 7, "tracks": [{"id": 1}]}, headers=HEADERS
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "bad_name"


def test_zip_rejects_a_body_beyond_the_service_ceiling(service: TestClient) -> None:
    # The cap is on the declared length, so a visitor cannot make the service
    # read a body it will never be able to pack.
    response = service.post(
        "/api/download/zip",
        content=b'{"tracks": [{' + b'"id": 1,' * (main.ZIP_BODY_MAX_BYTES // 8) + b'"id": 1}]}',
        headers={**HEADERS, "Content-Type": "application/json"},
    )
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "body_too_large"


def test_streams_a_real_zip_and_deletes_it_afterwards(monkeypatch, tmp_path: Path) -> None:
    settings = replace(
        main.settings, service_key="test-key", zip_temp_dir=str(tmp_path / "zips"), max_zip_tracks=3
    )
    monkeypatch.setattr(main, "settings", settings)
    stub = StubSource()
    monkeypatch.setattr(main, "_zip_source", stub)

    response = TestClient(main.app).post(
        "/api/download/zip",
        json=body({"id": 1, "mode": "mp3", "bitrate": 320}, {"id": 2, "mode": "original"}),
        headers=HEADERS,
    )

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"
    assert response.headers["X-File-Ext"] == "zip"
    assert "My Playlist.zip" in response.headers["Content-Disposition"]
    assert response.headers["X-Zip-Tracks"] == "2"
    assert response.headers["X-Zip-Failed"] == "0"
    assert int(response.headers["Content-Length"]) == len(response.content)

    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert archive.namelist() == ["01 Artist - Title 1.mp3", "02 Artist - Title 2.m4a"]
        assert archive.read("01 Artist - Title 1.mp3") == b"track-bytes"

    # Every track's staging dir and the archive itself are cleaned once delivered.
    assert stub.dirs
    assert all(not os.path.isdir(directory) for directory in stub.dirs)
    assert os.listdir(str(tmp_path / "zips")) == []


def test_zip_reports_the_tracks_it_could_not_fetch(monkeypatch, tmp_path: Path) -> None:
    settings = replace(
        main.settings, service_key="test-key", zip_temp_dir=str(tmp_path / "zips"), max_zip_tracks=3
    )
    monkeypatch.setattr(main, "settings", settings)
    monkeypatch.setattr(main, "_zip_source", StubSource(missing=(2,)))

    response = TestClient(main.app).post(
        "/api/download/zip", json=body({"id": 1}, {"id": 2}), headers=HEADERS
    )

    assert response.status_code == 200
    assert response.headers["X-Zip-Tracks"] == "1"
    assert response.headers["X-Zip-Failed"] == "1"
    assert response.headers["X-Zip-Failed-Ids"] == "2"
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert archive.namelist() == ["01 Artist - Title 1.m4a"]


def test_zip_fails_when_no_track_can_be_fetched(monkeypatch, tmp_path: Path) -> None:
    settings = replace(
        main.settings, service_key="test-key", zip_temp_dir=str(tmp_path / "zips"), max_zip_tracks=3
    )
    monkeypatch.setattr(main, "settings", settings)
    monkeypatch.setattr(main, "_zip_source", StubSource(missing=(1, 2)))

    response = TestClient(main.app).post(
        "/api/download/zip", json=body({"id": 1}, {"id": 2}), headers=HEADERS
    )

    assert response.status_code == 502
    assert response.json()["error"]["code"] == "zip_empty"
    assert os.listdir(str(tmp_path / "zips")) == []


def test_default_name_is_a_playlist_zip(monkeypatch, tmp_path: Path) -> None:
    settings = replace(main.settings, service_key="test-key", zip_temp_dir=str(tmp_path / "zips"))
    monkeypatch.setattr(main, "settings", settings)
    monkeypatch.setattr(main, "_zip_source", StubSource())

    response = TestClient(main.app).post(
        "/api/download/zip", json={"tracks": [{"id": 1}]}, headers=HEADERS
    )

    assert response.status_code == 200
    assert "CloudMP3-Playlist.zip" in response.headers["Content-Disposition"]


async def test_visitor_leaving_cancels_the_build(monkeypatch, tmp_path: Path) -> None:
    hold = asyncio.Event()

    async def stalled(_track: ZipTrack) -> TrackFile:
        await hold.wait()
        raise AssertionError("unreachable")

    settings = replace(
        main.settings, service_key="test-key", zip_temp_dir=str(tmp_path / "zips"), zip_timeout=60
    )
    monkeypatch.setattr(main, "settings", settings)
    monkeypatch.setattr(main, "_zip_source", stalled)

    class LeavingRequest:
        def __init__(self) -> None:
            self.polls = 0

        async def is_disconnected(self) -> bool:
            self.polls += 1
            return self.polls >= 2

    request = LeavingRequest()
    with pytest.raises(ServiceError) as excinfo:
        await main._watched_build([ZipTrack(1, "original")], request)

    assert (excinfo.value.status, excinfo.value.code) == (499, "client_disconnected")
    # The half-built archive is gone, and nothing was left running.
    assert os.listdir(str(tmp_path / "zips")) == []


async def test_a_failed_original_leaves_no_directory_on_the_zip_volume(
    monkeypatch, tmp_path: Path
) -> None:
    root = tmp_path / "zips"
    monkeypatch.setattr(main, "settings", replace(main.settings, zip_temp_dir=str(root)))
    original = SimpleNamespace(ext="m4a", url="https://example.invalid/upload.m4a")
    result = SimpleNamespace(
        artist="Artist", title="Title", album=None, artwork_url=None, original=original
    )

    async def detail(_track_id: int) -> dict:
        return {"id": 1}

    async def token() -> tuple[None, None]:
        return None, None

    async def fake_extract(*_args):
        return result

    async def refuse(_url: str, dest: str, _user_agent: str, _limit: int) -> int:
        # What download_to_file does on the way out: the partial file goes with it,
        # the directory it sat in is whoever staged it.
        Path(dest).write_bytes(b"half a file")
        raise ServiceError(413, "download_too_large", "This track is larger than the limit.")

    monkeypatch.setattr(main.api, "track", detail)
    monkeypatch.setattr(main, "_token", token)
    monkeypatch.setattr(main.format_service, "extract", fake_extract)
    monkeypatch.setattr(main, "download_to_file", refuse)

    with pytest.raises(ServiceError) as excinfo:
        await main._zip_source(ZipTrack(1, "original"))

    assert excinfo.value.code == "download_too_large"
    assert os.listdir(str(root)) == []


async def test_a_cache_flush_keeps_a_lock_another_request_is_holding(monkeypatch) -> None:
    """Emptying the format cache must not strand a fetch that is still running.

    Dropping a held lock from the map lets the next request for that track build a
    second lock and ask SoundCloud for the same track twice at once.
    """
    monkeypatch.setattr(main, "CACHE_LIMIT", 1)
    monkeypatch.setattr(main, "_cache", {999: (time.time(), SimpleNamespace())})
    monkeypatch.setattr(main, "_locks", {})

    result = SimpleNamespace(artist="Artist", title="Title")
    fetched: list[int] = []
    holding = asyncio.Event()
    release = asyncio.Event()
    let_first_finish = asyncio.Event()

    async def detail(track_id: int) -> dict:
        fetched.append(track_id)
        if track_id == 2:
            holding.set()
            await release.wait()
        else:
            await holding.wait()
            await let_first_finish.wait()
        return {"id": track_id}

    async def token() -> tuple[None, None]:
        return None, None

    async def fake_extract(*_args):
        return result

    monkeypatch.setattr(main.api, "track", detail)
    monkeypatch.setattr(main, "_token", token)
    monkeypatch.setattr(main.format_service, "extract", fake_extract)

    first = asyncio.create_task(main._cached_formats(1))
    second = asyncio.create_task(main._cached_formats(2))
    await holding.wait()
    held = main._locks[2]
    third = asyncio.create_task(main._cached_formats(2))
    await asyncio.sleep(0)

    # The first request finishes and empties the cache while track 2 is still fetching.
    let_first_finish.set()
    await first
    assert main._locks[2] is held

    release.set()
    await asyncio.gather(second, third)
    assert fetched.count(2) == 1
