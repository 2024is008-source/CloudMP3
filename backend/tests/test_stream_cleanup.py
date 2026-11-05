from __future__ import annotations

import os
import time
from pathlib import Path

from stream import TEMP_PREFIX, stream_temp, sweep_temp_dirs

PAYLOAD = b"wav" * 40


def make_temp_dir(root: Path, index: int) -> Path:
    tmpdir = root / f"{TEMP_PREFIX}{index}"
    tmpdir.mkdir()
    (tmpdir / "converted.wav").write_bytes(PAYLOAD)
    return tmpdir


async def test_stream_temp_deletes_the_file_after_a_completed_download(
    tmp_path: Path,
) -> None:
    tmpdir = make_temp_dir(tmp_path, 1)
    chunks = [chunk async for chunk in stream_temp(str(tmpdir / "converted.wav"), str(tmpdir))]

    assert b"".join(chunks) == PAYLOAD
    assert not tmpdir.exists()


async def test_stream_temp_deletes_the_file_when_the_client_leaves_mid_download(
    tmp_path: Path,
) -> None:
    tmpdir = make_temp_dir(tmp_path, 2)
    stream = stream_temp(str(tmpdir / "converted.wav"), str(tmpdir))
    assert await stream.__anext__()

    # Starlette closes the generator instead of finishing it when the visitor
    # abandons the page; the directory must not survive that.
    await stream.aclose()
    assert not tmpdir.exists()


def test_sweep_deletes_only_stale_conversion_dirs(tmp_path: Path) -> None:
    stale = make_temp_dir(tmp_path, 3)
    fresh = make_temp_dir(tmp_path, 4)
    unrelated = tmp_path / "other-app"
    unrelated.mkdir()

    long_ago = time.time() - 600
    os.utime(stale, (long_ago, long_ago))
    os.utime(stale / "converted.wav", (long_ago, long_ago))

    assert sweep_temp_dirs(300, root=str(tmp_path)) == 1
    assert not stale.exists()
    assert fresh.exists()
    assert unrelated.exists()


def test_sweep_keeps_a_dir_whose_conversion_is_still_running(tmp_path: Path) -> None:
    active = make_temp_dir(tmp_path, 5)
    long_ago = time.time() - 600
    os.utime(active, (long_ago, long_ago))

    assert sweep_temp_dirs(300, root=str(tmp_path)) == 0
    assert active.exists()


async def test_sweep_spares_a_dir_that_is_being_delivered(tmp_path: Path) -> None:
    serving = make_temp_dir(tmp_path, 6)
    stale = make_temp_dir(tmp_path, 7)
    long_ago = time.time() - 600
    for directory in (serving, stale):
        os.utime(directory, (long_ago, long_ago))
        os.utime(directory / "converted.wav", (long_ago, long_ago))

    download = stream_temp(str(serving / "converted.wav"), str(serving))
    assert await download.__anext__()

    # Reading a file does not move its mtime, so the finished archive of a slow
    # download looks idle to the sweep long before its last byte is delivered.
    assert sweep_temp_dirs(300, root=str(tmp_path)) == 1
    assert serving.exists()
    assert not stale.exists()

    await download.aclose()
    assert not serving.exists()
