"""Synthetic measurements for the server-side ZIP pipeline.

SoundCloud is replaced by generated audio, so this runs offline, on any machine,
and still answers the five questions an operator asks before trusting the
endpoint: how long an archive takes to build, how much of a job lands in memory
instead of on disk, how much scratch space the temp directories need, whether
MAX_CONCURRENT_ZIP_JOBS actually queues work rather than letting it pile up, and
how fast a finished archive streams out.

Usage:

    cd backend && python scripts/measure_zip.py
    cd backend && python scripts/measure_zip.py --tracks 20 --mb 6 --jobs 6 --limit 3
    cd backend && python scripts/measure_zip.py --out zip-bench.txt

The numbers describe this machine and these payloads. They are not a claim about
production traffic, where the same archive also waits on SoundCloud's servers.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import random
import shutil
import sys
import tempfile
import time
import tracemalloc
from dataclasses import dataclass

# The script lives one level below the service it measures, so the backend
# modules only become importable once its own directory is on the path.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from config import Settings
from stream import stream_temp
from zip_service import TrackFile, ZipArchive, ZipTrack, build_archive

CHUNK = 1024 * 1024
# Every source byte maps onto one of eight characters, so the text-like payload
# compresses without being the absurd case that a file of zeroes would be.
TEXT_TABLE = bytes(0x61 + (value % 8) for value in range(256))


@dataclass(frozen=True)
class Payload:
    """What one synthetic track is made of."""

    mb: float
    ext: str
    kind: str

    def chunk(self, rng: random.Random) -> bytes:
        raw = rng.randbytes(CHUNK)
        return raw if self.kind == "audio-like" else raw.translate(TEXT_TABLE)

    def write(self, path: str, seed: int) -> int:
        """Fill one track file and return its size; runs off the event loop."""
        block = self.chunk(random.Random(seed))
        remaining = int(self.mb * 1024 * 1024)
        with open(path, "wb") as handle:
            while remaining > 0:
                # The final piece is short, so the file lands on the requested size.
                piece = block[: min(len(block), remaining)]
                handle.write(piece)
                remaining -= len(piece)
        return os.path.getsize(path)


@dataclass
class Build:
    """One measured archive job."""

    label: str
    tracks: int
    source_bytes: int
    archive_bytes: int
    seconds: float
    cpu_seconds: float
    heap_peak: int
    temp_peak: int
    entries: int
    failed: int


class Ledger:
    """Peak scratch space in use, sampled while the jobs run.

    The benchmark's temp root holds nothing but the job's own track directories
    and its archive, so scanning the root reads what a live job costs the disk.
    `start_window` restarts the peak so each scenario gets its own number while
    the run as a whole keeps the widest. A reading is only as fresh as the
    sampling interval, so a spike between two ticks is missed.
    """

    def __init__(self, root: str, sample_seconds: float) -> None:
        self.root = root
        self.sample_seconds = sample_seconds
        self.window_peak = 0
        self.peak = 0
        self._task: asyncio.Task[None] | None = None

    def start_window(self) -> None:
        self.window_peak = 0

    async def _sample(self) -> None:
        while True:
            size = _dir_size(self.root)
            self.window_peak = max(self.window_peak, size)
            self.peak = max(self.peak, size)
            await asyncio.sleep(self.sample_seconds)

    def start(self) -> None:
        self._task = asyncio.create_task(self._sample())

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
            self._task = None

    def leftovers(self) -> int:
        try:
            entries = list(os.scandir(self.root))
        except OSError:
            return 0
        return sum(1 for entry in entries if entry.is_dir(follow_symlinks=False))


def _dir_size(root: str) -> int:
    total = 0
    try:
        entries = list(os.scandir(root))
    except OSError:
        return 0
    for entry in entries:
        if entry.is_dir(follow_symlinks=False):
            total += _dir_size(entry.path)
        else:
            # Not entry.stat(): on Windows the directory record keeps the size a
            # file had when it was created, so an archive still being written
            # reads as zero bytes. Stat on the path reports the live length.
            try:
                total += os.stat(entry.path).st_size
            except OSError:
                continue
    return total


def bench_settings(root: str, limit: int, tracks: int) -> Settings:
    """A configuration with the benchmark's own ZIP limits and nothing else set."""
    return Settings(
        service_key="bench",
        client_id="",
        client_secret="",
        refresh_token="",
        access_token="",
        token_store=tempfile.gettempdir(),
        ytdlp_timeout=60,
        convert_timeout=300,
        max_convert_bytes=600 * 1024 * 1024,
        temp_ttl_seconds=300,
        max_concurrent_conversions=2,
        max_concurrent_zip_jobs=limit,
        max_zip_tracks=tracks,
        max_zip_bytes=8 * 1024 * 1024 * 1024,
        zip_timeout=3600,
        zip_temp_dir=root,
    )


def make_producer(root: str, payload: Payload, delay: float, seed: int):
    """Stand in for the real track fetcher: land the bytes on disk, hand back a TrackFile.

    Production writes each track into the system temp; these directories are
    pinned under one root so the ledger measures this job and nothing else.
    """

    async def produce(track: ZipTrack) -> TrackFile:
        if delay:
            await asyncio.sleep(delay)
        tmpdir = tempfile.mkdtemp(prefix="cloudmp3-bench-track-", dir=root)
        path = os.path.join(tmpdir, f"track.{payload.ext}")
        await asyncio.to_thread(payload.write, path, seed + track.track_id * 7919)
        return TrackFile(
            path=path,
            tmpdir=tmpdir,
            ext=payload.ext,
            name=f"Artist {track.track_id % 4 + 1} - Track {track.track_id}.{payload.ext}",
        )

    return produce


async def measure_build(
    label: str,
    count: int,
    payload: Payload,
    settings: Settings,
    ledger: Ledger,
    delay: float,
    seed: int,
    root: str,
) -> tuple[Build, ZipArchive]:
    tracks = [ZipTrack(track_id=index + 1) for index in range(count)]
    source = {"bytes": 0}
    inner = make_producer(root, payload, delay, seed)

    async def counted(track: ZipTrack) -> TrackFile:
        file = await inner(track)
        source["bytes"] += os.path.getsize(file.path)
        return file

    ledger.start_window()
    tracemalloc.start()
    tracemalloc.reset_peak()
    wall = time.perf_counter()
    cpu = time.process_time()
    try:
        archive = await build_archive(tracks, settings, counted)
    finally:
        _, heap_peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        seconds = time.perf_counter() - wall
        cpu_seconds = time.process_time() - cpu
        temp_peak = ledger.window_peak

    return (
        Build(
            label=label,
            tracks=count,
            source_bytes=source["bytes"],
            archive_bytes=archive.size,
            seconds=seconds,
            cpu_seconds=cpu_seconds,
            heap_peak=heap_peak,
            temp_peak=temp_peak,
            entries=len(archive.entries),
            failed=len(archive.failed),
        ),
        archive,
    )


async def measure_stream(archive: ZipArchive) -> float:
    """Read a finished archive exactly the way the response does, and time it."""
    received = 0
    started = time.perf_counter()
    async for chunk in stream_temp(archive.path, archive.tmpdir):
        received += len(chunk)
    seconds = time.perf_counter() - started
    if received != archive.size:
        raise AssertionError(f"streamed {received} of {archive.size} bytes")
    shutil.rmtree(archive.tmpdir, ignore_errors=True)
    return seconds


async def measure_concurrency(
    jobs: int,
    count: int,
    payload: Payload,
    settings: Settings,
    ledger: Ledger,
    delay: float,
    seed: int,
    root: str,
) -> tuple[float, int, list[float], int]:
    """Start more jobs than the cap allows and watch where they wait.

    A job's first track can only be fetched from inside the semaphore, so the
    gap between launching and that first fetch is the time it spent queued.
    """
    started = time.perf_counter()
    windows: list[tuple[float, float]] = []
    ledger.start_window()

    async def run(index: int) -> None:
        opened = {"at": 0.0}
        inner = make_producer(root, payload, delay, seed + index * 1000)

        async def timed(track: ZipTrack) -> TrackFile:
            if not opened["at"]:
                opened["at"] = time.perf_counter() - started
            return await inner(track)

        tracks = [ZipTrack(track_id=index * 100 + n + 1) for n in range(count)]
        archive = await build_archive(tracks, settings, timed)
        windows.append((opened["at"], time.perf_counter() - started))
        shutil.rmtree(archive.tmpdir, ignore_errors=True)

    async with asyncio.TaskGroup() as group:
        for index in range(jobs):
            group.create_task(run(index))

    seconds = time.perf_counter() - started
    # Ending jobs are counted before starting ones, so a hand-over never reads
    # as two extra jobs running at once.
    events = sorted(
        [(open_at, 1) for open_at, _ in windows]
        + [(close_at, -1) for _, close_at in windows],
        key=lambda item: (item[0], item[1]),
    )
    active = most = 0
    for _, delta in events:
        active += delta
        most = max(most, active)
    return seconds, most, sorted(open_at for open_at, _ in windows), ledger.window_peak


def bytes_text(value: float) -> str:
    for unit, size in (("GiB", 1024**3), ("MiB", 1024**2), ("KiB", 1024)):
        if value >= size:
            return f"{value / size:.1f} {unit}"
    return f"{value:.0f} B"


def rate_text(total: float, seconds: float) -> str:
    return f"{bytes_text(total / seconds)}/s" if seconds > 0 else "n/a"


def report(rows: list[Build], extra: dict[str, str]) -> str:
    header = (
        f"{'scenario':<22} {'tracks':>6} {'source':>9} {'archive':>9} "
        f"{'wall':>8} {'cpu':>8} {'heap peak':>10} {'temp peak':>10}"
    )
    lines = [
        "CloudMP3 server-side ZIP benchmark",
        "=" * len(header),
        header,
        "-" * len(header),
    ]
    for build in rows:
        lines.append(
            f"{build.label:<22} {build.tracks:>6} {bytes_text(build.source_bytes):>9} "
            f"{bytes_text(build.archive_bytes):>9} {build.seconds:>7.2f}s "
            f"{build.cpu_seconds:>7.2f}s {bytes_text(build.heap_peak):>10} "
            f"{bytes_text(build.temp_peak):>10}"
        )
    lines.append("")
    lines.extend(f"{key}: {value}" for key, value in extra.items())
    return "\n".join(lines)


def write_report(path: str, text: str) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text + "\n")


async def main(args: argparse.Namespace) -> int:
    root = os.path.abspath(args.temp_dir)
    shutil.rmtree(root, ignore_errors=True)
    os.makedirs(root, exist_ok=True)

    ledger = Ledger(root, args.sample)
    rows: list[Build] = []
    extra: dict[str, str] = {}

    audio = Payload(mb=args.mb, ext=args.ext, kind="audio-like")
    text = Payload(mb=max(1.0, args.mb / 2), ext="bin", kind="text-like")
    settings = bench_settings(root, args.limit, max(args.tracks, args.min_tracks))
    scenarios = (
        (f"stored .{args.ext}", args.tracks, audio, args.delay, args.seed),
        (f"stored .{args.ext} packed", args.tracks, audio, 0.0, args.seed + 3000),
        ("deflated .bin", max(2, args.tracks // 2), text, args.delay, args.seed + 5000),
        ("deflated .bin packed", max(2, args.tracks // 2), text, 0.0, args.seed + 7000),
    )

    ledger.start()
    try:
        for label, count, payload, delay, seed in scenarios:
            build, archive = await measure_build(
                label, count, payload, settings, ledger, delay, seed, root
            )
            rows.append(build)
            shutil.rmtree(archive.tmpdir, ignore_errors=True)

        if args.stream:
            build, archive = await measure_build(
                f"stored .{args.ext} streamed", args.tracks, audio, settings,
                ledger, 0.0, args.seed + 20000, root,
            )
            rows.append(build)
            stream_seconds = await measure_stream(archive)

        seconds, most, waits, temp_peak = await measure_concurrency(
            args.jobs,
            args.min_tracks,
            audio,
            bench_settings(root, args.limit, args.min_tracks),
            ledger,
            args.delay,
            args.seed + 9000,
            root,
        )
    finally:
        await ledger.stop()

    stored = rows[0]
    deflated = rows[2]
    biggest = max(rows, key=lambda row: row.heap_peak)
    extra["machine"] = f"Python {sys.version.split()[0]} on {sys.platform}, bench root {root}"
    extra["payload"] = (
        f"audio-like = {args.mb:g} MiB of random bytes per track as .{args.ext}, which the "
        f"packer stores; text-like = {max(1.0, args.mb / 2):g} MiB drawn from eight "
        "characters as .bin, which the packer deflates"
    )
    short = [row for row in rows if row.failed or row.entries != row.tracks]
    extra["packed"] = (
        "every scenario packed all of its tracks and skipped none"
        if not short
        else "; ".join(f"{row.label}: {row.entries}/{row.tracks} packed" for row in short)
    )
    extra["generation time"] = (
        f"{stored.label} of {stored.tracks} tracks: {stored.seconds:.2f}s wall, of which "
        f"{stored.cpu_seconds:.2f}s was CPU; with the artificial {args.delay:g}s-per-track "
        f"wait removed the same archive packed in {rows[1].seconds:.2f}s"
    )
    extra["deflate cost"] = (
        f"the {deflated.tracks} compressible tracks took {deflated.seconds:.2f}s wall / "
        f"{deflated.cpu_seconds:.2f}s CPU to write {bytes_text(deflated.source_bytes)} down "
        f"to {bytes_text(deflated.archive_bytes)}; the {stored.tracks} stored tracks took "
        f"{rows[1].cpu_seconds:.2f}s CPU to write {bytes_text(stored.source_bytes)} and keep "
        "all of it"
    )
    extra["throughput"] = (
        f"{rate_text(stored.archive_bytes, rows[1].seconds)} of archive written when no "
        "download wait is in the way"
    )
    extra["peak memory"] = (
        f"{bytes_text(biggest.heap_peak)} of Python heap at its highest, measured on the run "
        f"that wrote {bytes_text(biggest.archive_bytes)} of archive; the copy buffer is "
        "counted, the playlist is not"
    )
    extra["peak temp"] = (
        f"{bytes_text(ledger.peak)} of scratch space at its widest ({bytes_text(temp_peak)} "
        f"during the {args.jobs}-job concurrency run)"
    )
    extra["concurrency"] = (
        f"{args.jobs} jobs of {args.min_tracks} tracks at MAX_CONCURRENT_ZIP_JOBS={args.limit}: "
        f"{seconds:.2f}s for all of them, {most} building at once (the cap held), "
        f"job start times {', '.join(f'{w:.2f}s' for w in waits)}"
    )
    if args.stream:
        extra["streaming"] = (
            f"{bytes_text(stored.archive_bytes)} archive read back through stream_temp in "
            f"{stream_seconds:.2f}s ({rate_text(stored.archive_bytes, stream_seconds)}), "
            "with the file already in the OS cache, so a real connection is the slower side"
        )
    leftovers = ledger.leftovers()
    extra["cleanup"] = (
        f"{leftovers} temporary directories left under the bench root once every scenario "
        "had finished"
    )

    text_out = report(rows, extra)
    print(text_out)
    if args.out:
        await asyncio.to_thread(write_report, args.out, text_out)
    return 1 if leftovers else 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Measure the server-side ZIP pipeline")
    parser.add_argument("--tracks", type=int, default=12, help="tracks in a single archive")
    parser.add_argument("--mb", type=float, default=4.0, help="size of one synthetic track")
    parser.add_argument(
        "--ext", default="mp3", help="track extension; mp3 and wav store, others deflate"
    )
    parser.add_argument("--jobs", type=int, default=4, help="jobs in the concurrency scenario")
    parser.add_argument(
        "--min-tracks", type=int, default=3, help="tracks per job in the concurrency scenario"
    )
    parser.add_argument(
        "--limit", type=int, default=2, help="MAX_CONCURRENT_ZIP_JOBS to measure against"
    )
    parser.add_argument(
        "--delay", type=float, default=0.05, help="seconds a track waits before it lands"
    )
    parser.add_argument(
        "--sample", type=float, default=0.01, help="disk sampling interval in seconds"
    )
    parser.add_argument("--seed", type=int, default=20261103)
    parser.add_argument(
        "--temp-dir", default=os.path.join(tempfile.gettempdir(), "cloudmp3-zipbench")
    )
    parser.add_argument(
        "--no-stream", dest="stream", action="store_false", help="skip the streaming run"
    )
    parser.add_argument("--out", help="also write the report to this file")
    parser.set_defaults(stream=True)
    return parser.parse_args()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main(parse_args())))
