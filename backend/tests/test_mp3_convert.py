from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

import pytest

import stream
from config import Settings
from errors import ServiceError

STREAM_URL = "https://cf-media.sndcdn.com/authorized.m4a?policy=signed"
ARTWORK_URL = "https://i.sndcdn.com/artworks-000-large.jpg"
METADATA = {"title": "Jóga", "artist": "Björk"}
PAYLOAD = b"mp3" * 2048


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
    }
    values.update(overrides)
    return Settings(**values)


class FakeProcess:
    def __init__(self, returncode: int) -> None:
        self.returncode = returncode
        self.killed = False

    async def communicate(self):
        return None, b"ffmpeg exit status\nHTTP error 500 returned\n"

    def kill(self) -> None:
        self.killed = True

    async def wait(self) -> int:
        return self.returncode


class Ffmpeg:
    """Stands in for the FFmpeg process: records argv and overlap, writes output."""

    def __init__(self, payload: bytes = PAYLOAD, failures: int = 0) -> None:
        self.payload = payload
        self.failures = failures
        self.calls: list[list[str]] = []
        self.active = 0
        self.peak = 0

    async def spawn(self, args: list[str]) -> FakeProcess:
        self.calls.append(list(args))
        self.active += 1
        self.peak = max(self.peak, self.active)
        await asyncio.sleep(0.01)
        failed = len(self.calls) <= self.failures
        if not failed:
            Path(args[-1]).write_bytes(self.payload)
        self.active -= 1
        return FakeProcess(1 if failed else 0)


def use_temp_under(monkeypatch, root: Path) -> list[str]:
    """Point mkdtemp at the test directory and remember what was created."""
    created: list[str] = []
    real_mkdtemp = tempfile.mkdtemp

    def fake_mkdtemp(*args, **kwargs):
        kwargs.pop("dir", None)
        path = real_mkdtemp(prefix=stream.TEMP_PREFIX, dir=str(root))
        created.append(path)
        return path

    monkeypatch.setattr(stream.tempfile, "mkdtemp", fake_mkdtemp)
    return created


def patch_ffmpeg(monkeypatch, ffmpeg: Ffmpeg) -> None:
    monkeypatch.setattr(stream, "ffmpeg_path", lambda: "ffmpeg")
    monkeypatch.setattr(stream, "_spawn", ffmpeg.spawn)


class StuckProcess:
    """An FFmpeg that never exits: what a stalled download looks like from here."""

    def __init__(self) -> None:
        self.killed = False
        self.reaped = False

    async def communicate(self):
        await asyncio.get_running_loop().create_future()
        raise AssertionError("unreachable")

    def kill(self) -> None:
        self.killed = True

    async def wait(self) -> int:
        self.reaped = True
        return 0


def patch_stuck_ffmpeg(monkeypatch) -> list[StuckProcess]:
    processes: list[StuckProcess] = []

    async def spawn(args: list[str]) -> StuckProcess:
        process = StuckProcess()
        processes.append(process)
        return process

    monkeypatch.setattr(stream, "ffmpeg_path", lambda: "ffmpeg")
    monkeypatch.setattr(stream, "_spawn", spawn)
    return processes


class FakeResponse:
    def __init__(self, content: bytes, status_code: int = 200) -> None:
        self.content = content
        self.status_code = status_code


def patch_httpx(monkeypatch, response: FakeResponse) -> None:
    class Client:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc) -> bool:
            return False

        async def get(self, url: str) -> FakeResponse:
            return response

    monkeypatch.setattr(stream.httpx, "AsyncClient", Client)


def patch_source_download(monkeypatch, payload: bytes = PAYLOAD) -> list[str]:
    """Stand in for SoundCloud's file host and record every address asked for.

    A conversion now copies the source to disk before FFmpeg reads it, so these
    tests need a network as well as a fake process. The recorder is the point: a
    test can say which addresses were contacted, not only which were refused.
    """
    seen: list[str] = []

    class FakeStream:
        status_code = 200

        def __init__(self, url: str) -> None:
            self.url = url

        async def __aenter__(self):
            seen.append(self.url)
            return self

        async def __aexit__(self, *exc) -> bool:
            return False

        async def aiter_bytes(self, chunk_size: int = 0):
            step = max(1, chunk_size)
            for start in range(0, len(payload), step):
                yield payload[start : start + step]

    class Client:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc) -> bool:
            return False

        def stream(self, method: str, url: str) -> FakeStream:
            return FakeStream(url)

        async def get(self, url: str) -> FakeResponse:
            seen.append(url)
            return FakeResponse(payload)

    monkeypatch.setattr(stream.httpx, "AsyncClient", Client)
    return seen


async def test_mp3_args_ask_for_lame_id3_and_metadata(tmp_path: Path) -> None:
    source = str(tmp_path / "source.m4a")
    args = stream._mp3_args(
        "ffmpeg", source, str(tmp_path / "out.mp3"), 320, METADATA, None
    )
    text = " ".join(args)

    assert "-c:a libmp3lame" in text
    assert "-b:a 320k" in text
    assert "-id3v2_version 3" in text
    assert "-map 0:a:0" in text and "-vn" in text
    assert "-map_metadata -1" in text
    assert "-metadata title=Jóga" in text
    assert "-metadata artist=Björk" in text
    assert args[-1] == str(tmp_path / "out.mp3")
    # The source is one argv entry, never interpolated into a shell.
    assert source in args
    # FFmpeg reads a staged file only: nothing here can leave the machine.
    assert "-protocol_whitelist file" in text
    assert not any(arg.startswith("http") for arg in args)


async def test_mp3_args_attach_the_cover_without_disabling_video(tmp_path: Path) -> None:
    args = stream._mp3_args(
        "ffmpeg",
        str(tmp_path / "source.m4a"),
        str(tmp_path / "out.mp3"),
        256,
        METADATA,
        str(tmp_path / "cover.jpg"),
    )
    text = " ".join(args)

    assert str(tmp_path / "cover.jpg") in args
    assert "-map 1:v:0" in text
    assert "attached_pic" in text
    # "-vn" would drop the picture again, so it must not be present.
    assert "-vn" not in text


async def test_convert_to_mp3_rejects_an_unknown_bitrate(tmp_path: Path, monkeypatch) -> None:
    patch_ffmpeg(monkeypatch, Ffmpeg())
    created = use_temp_under(monkeypatch, tmp_path)

    with pytest.raises(ServiceError) as excinfo:
        await stream.convert_to_mp3(STREAM_URL, make_settings(tmp_path), 200, METADATA)

    assert (excinfo.value.status, excinfo.value.code) == (400, "bad_bitrate")
    assert created == []


async def test_convert_to_mp3_returns_the_tagged_file(tmp_path: Path, monkeypatch) -> None:
    ffmpeg = Ffmpeg()
    patch_ffmpeg(monkeypatch, ffmpeg)
    patch_source_download(monkeypatch)
    use_temp_under(monkeypatch, tmp_path)

    output, tmpdir, size = await stream.convert_to_mp3(
        STREAM_URL, make_settings(tmp_path), 192, METADATA
    )

    assert Path(output).name == "converted.mp3"
    assert size == len(PAYLOAD)
    assert "-b:a 192k" in " ".join(ffmpeg.calls[0])
    assert Path(tmpdir).name.startswith(stream.TEMP_PREFIX)
    stream.cleanup_dir(tmpdir)


async def test_conversions_share_one_slot_limit(tmp_path: Path, monkeypatch) -> None:
    ffmpeg = Ffmpeg()
    patch_ffmpeg(monkeypatch, ffmpeg)
    patch_source_download(monkeypatch)
    use_temp_under(monkeypatch, tmp_path)
    settings = make_settings(tmp_path, max_concurrent_conversions=1)

    results = await asyncio.gather(
        *(stream.convert_to_mp3(STREAM_URL, settings, 320, METADATA) for _ in range(3))
    )

    assert ffmpeg.peak == 1
    assert len(results) == 3
    for _, tmpdir, _ in results:
        stream.cleanup_dir(tmpdir)


async def test_conversions_run_in_parallel_up_to_the_limit(
    tmp_path: Path, monkeypatch
) -> None:
    ffmpeg = Ffmpeg()
    patch_ffmpeg(monkeypatch, ffmpeg)
    patch_source_download(monkeypatch)
    use_temp_under(monkeypatch, tmp_path)
    settings = make_settings(tmp_path, max_concurrent_conversions=2)

    results = await asyncio.gather(
        *(stream.convert_to_mp3(STREAM_URL, settings, 320, METADATA) for _ in range(4))
    )

    assert ffmpeg.peak == 2
    for _, tmpdir, _ in results:
        stream.cleanup_dir(tmpdir)


async def test_failed_conversion_leaves_no_temp_directory(
    tmp_path: Path, monkeypatch
) -> None:
    ffmpeg = Ffmpeg(failures=1)
    patch_ffmpeg(monkeypatch, ffmpeg)
    patch_source_download(monkeypatch)
    created = use_temp_under(monkeypatch, tmp_path)

    with pytest.raises(ServiceError) as excinfo:
        await stream.convert_to_mp3(STREAM_URL, make_settings(tmp_path), 320, METADATA)

    assert (excinfo.value.status, excinfo.value.code) == (502, "convert_failed")
    assert created and all(not Path(path).exists() for path in created)


async def test_oversized_conversion_is_refused_and_removed(
    tmp_path: Path, monkeypatch
) -> None:
    ffmpeg = Ffmpeg(payload=b"x" * 4096)
    patch_ffmpeg(monkeypatch, ffmpeg)
    patch_source_download(monkeypatch, payload=b"tiny")
    created = use_temp_under(monkeypatch, tmp_path)

    with pytest.raises(ServiceError) as excinfo:
        await stream.convert_to_mp3(
            STREAM_URL, make_settings(tmp_path, max_convert_bytes=1024), 320, METADATA
        )

    assert (excinfo.value.status, excinfo.value.code) == (413, "convert_too_large")
    assert created and all(not Path(path).exists() for path in created)


async def test_cover_failure_retries_once_without_the_picture(
    tmp_path: Path, monkeypatch
) -> None:
    ffmpeg = Ffmpeg(failures=1)
    patch_ffmpeg(monkeypatch, ffmpeg)
    patch_source_download(monkeypatch)
    use_temp_under(monkeypatch, tmp_path)

    async def fake_artwork(url: str, tmpdir: str, settings) -> str:
        cover = Path(tmpdir) / "cover.jpg"
        cover.write_bytes(b"jpeg")
        return str(cover)

    monkeypatch.setattr(stream, "_fetch_artwork", fake_artwork)

    output, tmpdir, size = await stream.convert_to_mp3(
        STREAM_URL, make_settings(tmp_path), 320, METADATA, ARTWORK_URL
    )

    assert size == len(PAYLOAD)
    assert len(ffmpeg.calls) == 2
    assert "attached_pic" in " ".join(ffmpeg.calls[0])
    assert "attached_pic" not in " ".join(ffmpeg.calls[1])
    assert Path(output).exists()
    stream.cleanup_dir(tmpdir)


async def test_artwork_is_only_taken_from_soundcloud_hosts(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)

    assert await stream._fetch_artwork("http://evil.example/a.jpg", str(tmp_path), settings) is None
    assert (
        await stream._fetch_artwork("https://cdn.example.com/a.jpg", str(tmp_path), settings) is None
    )
    assert (
        await stream._fetch_artwork("https://i.sndcdn.com/artworks.apec", str(tmp_path), settings)
        is None
    )


async def test_a_cover_larger_than_a_cover_is_skipped(tmp_path: Path, monkeypatch) -> None:
    patch_httpx(monkeypatch, FakeResponse(b"p" * (stream.ARTWORK_MAX_BYTES + 1)))

    assert await stream._fetch_artwork(ARTWORK_URL, str(tmp_path), make_settings(tmp_path)) is None
    assert not (tmp_path / "cover.jpg").exists()


async def test_a_cover_that_will_not_write_does_not_cost_the_audio(
    tmp_path: Path, monkeypatch
) -> None:
    ffmpeg = Ffmpeg()
    patch_ffmpeg(monkeypatch, ffmpeg)
    created = use_temp_under(monkeypatch, tmp_path)
    patch_source_download(monkeypatch)
    real_open = stream.anyio.open_file

    def refuse(path, *args, **kwargs):
        # Only the picture is optional. The staged source must still be writable,
        # or this would be testing the download rather than the cover.
        if str(path).endswith("cover.jpg"):
            raise OSError("the disk went away")
        return real_open(path, *args, **kwargs)

    monkeypatch.setattr(stream.anyio, "open_file", refuse)

    output, tmpdir, size = await stream.convert_to_mp3(
        STREAM_URL, make_settings(tmp_path), 320, METADATA, ARTWORK_URL
    )

    # A picture is optional; the audio is the download. Retrying the whole
    # conversion because the cover could not be saved would lose both.
    assert size == len(PAYLOAD)
    assert Path(output).exists()
    assert len(ffmpeg.calls) == 1
    assert "attached_pic" not in " ".join(ffmpeg.calls[0])
    stream.cleanup_dir(tmpdir)
    assert created and all(not Path(path).exists() for path in created)


async def test_ffmpeg_is_handed_a_staged_file_and_never_the_address(
    tmp_path: Path, monkeypatch
) -> None:
    """The whole point of staging: the address is fetched by us, not by FFmpeg.

    Before this, ffmpeg was given the URL and did its own fetching — of the file,
    of any playlist behind it and of every segment that playlist named — none of
    it passing through the outbound policy.
    """
    ffmpeg = Ffmpeg()
    patch_ffmpeg(monkeypatch, ffmpeg)
    seen = patch_source_download(monkeypatch)
    use_temp_under(monkeypatch, tmp_path)

    output, tmpdir, _ = await stream.convert_to_wav(STREAM_URL, make_settings(tmp_path))

    assert seen == [STREAM_URL]
    args = ffmpeg.calls[0]
    assert not any(argument.startswith("http") for argument in args)
    assert "-protocol_whitelist" in args and "file" in args
    assert Path(args[args.index("-i") + 1]).is_file()
    stream.cleanup_dir(tmpdir)


async def test_a_cancelled_conversion_kills_ffmpeg_and_clears_its_dir(
    tmp_path: Path, monkeypatch
) -> None:
    patch_source_download(monkeypatch)
    created = use_temp_under(monkeypatch, tmp_path)
    processes = patch_stuck_ffmpeg(monkeypatch)

    task = asyncio.create_task(stream.convert_to_wav(STREAM_URL, make_settings(tmp_path)))
    await asyncio.sleep(0.02)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert processes and all(process.killed and process.reaped for process in processes)
    assert created and all(not Path(path).exists() for path in created)


async def test_a_stuck_conversion_times_out_without_orphaning_ffmpeg(
    tmp_path: Path, monkeypatch
) -> None:
    patch_source_download(monkeypatch)
    created = use_temp_under(monkeypatch, tmp_path)
    processes = patch_stuck_ffmpeg(monkeypatch)

    with pytest.raises(ServiceError) as excinfo:
        await stream.convert_to_wav(STREAM_URL, make_settings(tmp_path, convert_timeout=0.01))

    assert (excinfo.value.status, excinfo.value.code) == (504, "convert_timeout")
    assert processes and all(process.killed and process.reaped for process in processes)
    assert created and all(not Path(path).exists() for path in created)
