from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import unquote, urlparse

import httpx

from config import Settings
from errors import ServiceError
from sc_api import ApiTrack

# SoundCloud serves streams and original uploads from these hosts.
SOURCE_HOSTS = ("sndcdn.com", "soundcloud.com", "soundcloud.cloud")

EXT_CODEC = {
    "wav": "PCM (WAV)",
    "wave": "PCM (WAV)",
    "flac": "FLAC",
    "aif": "AIFF (PCM)",
    "aiff": "AIFF (PCM)",
    "aac": "AAC",
    "m4a": "AAC",
    "mp3": "MP3",
    "ogg": "Ogg",
    "oga": "Ogg",
    "opus": "Opus",
    "wma": "WMA",
}

MIME_EXT = {
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
    "audio/flac": "flac",
    "audio/x-flac": "flac",
    "audio/aiff": "aiff",
    "audio/x-aiff": "aiff",
    "audio/aac": "aac",
    "audio/mp4": "m4a",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "audio/opus": "opus",
}

ORIGINAL_WARNING = "registered users"
INVALID_NAME = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
# SoundCloud preset names carry the real bitrate even when yt-dlp's abr is missing.
PRESET_BITRATES = {
    "mp3_1_0": 128,
    "mp3_0_0": 128,
    "aac_96k": 96,
    "aac_160k": 160,
    "aac_256k": 256,
    "opus_0_0": 64,
}


def normalize_ext(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    ext = value.strip().lower().lstrip(".")
    return ext if re.fullmatch(r"[a-z0-9]{1,6}", ext) else None


def ext_from_filename(name: str | None) -> str | None:
    if not name:
        return None
    base = name.rsplit("/", 1)[-1]
    if "." not in base:
        return None
    return normalize_ext(base.rsplit(".", 1)[-1])


def ext_from_url(url: str | None) -> str | None:
    if not url:
        return None
    try:
        path = urlparse(url).path
    except ValueError:
        return None
    return ext_from_filename(path.rsplit("/", 1)[-1] if "/" in path else path)


def is_allowed_source(url: Any) -> bool:
    if not isinstance(url, str):
        return False
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    if parsed.scheme != "https":
        return False
    host = (parsed.hostname or "").lower()
    return any(host == allowed or host.endswith("." + allowed) for allowed in SOURCE_HOSTS)


def filename_from_disposition(value: str | None) -> str | None:
    if not value:
        return None
    match = re.search(r"filename\*\s*=\s*([^;]+)", value, re.IGNORECASE)
    if match:
        raw = match.group(1).strip().strip('"')
        parts = raw.split("'", 2)
        if len(parts) == 3 and parts[2]:
            try:
                return unquote(parts[2], encoding=parts[0] or "utf-8", errors="replace")
            except LookupError:
                return unquote(parts[2])
    for pattern in (r'filename\s*=\s*"([^"]*)"', r"filename\s*=\s*([^;]+)"):
        match = re.search(pattern, value, re.IGNORECASE)
        if match:
            return match.group(1).strip()
    return None


def safe_filename(name: str, fallback: str) -> str:
    cleaned = INVALID_NAME.sub("_", name).strip().strip(".")
    cleaned = re.sub(r"\s+", " ", cleaned)
    if not cleaned:
        cleaned = fallback
    if len(cleaned) > 180:
        ext = ext_from_filename(cleaned)
        suffix = f".{ext}" if ext else ""
        cleaned = cleaned[: 180 - len(suffix)].rstrip() + suffix
    return cleaned


def codec_for(ext: str | None, acodec: str | None = None) -> str:
    if ext and ext in EXT_CODEC:
        return EXT_CODEC[ext]
    text = (acodec or "").lower()
    if text.startswith(("mp4a", "aac")):
        return "AAC"
    if text.startswith("mp3"):
        return "MP3"
    if text.startswith("opus"):
        return "Opus"
    if text.startswith("vorbis"):
        return "Vorbis"
    if text.startswith("flac"):
        return "FLAC"
    if text.startswith("pcm"):
        return "PCM"
    return (ext or "unknown").upper()


def pick_ext(*candidates: str | None) -> str | None:
    for candidate in candidates:
        ext = normalize_ext(candidate)
        if ext:
            return ext
    return None


@dataclass
class StreamFormat:
    preset: str
    codec: str
    ext: str
    bitrate: int | None
    protocol: str
    url: str

    def to_public(self) -> dict[str, Any]:
        return {
            "preset": self.preset,
            "codec": self.codec,
            "ext": self.ext,
            "bitrate": self.bitrate,
            "protocol": self.protocol,
        }


@dataclass
class OriginalFile:
    url: str
    ext: str
    codec: str
    mime: str | None
    bytes: int | None
    filename: str | None
    bitrate: int | None = None

    def display_name(self, artist: str, title: str) -> str:
        return safe_filename(self.filename or f"{artist} - {title}.{self.ext}", f"audio.{self.ext}")

    def to_public(self) -> dict[str, Any]:
        return {
            "available": True,
            "ext": self.ext,
            "codec": self.codec,
            "mime": self.mime,
            "bytes": self.bytes,
            "filename": self.filename,
            "bitrate": self.bitrate,
        }


@dataclass
class TrackFormats:
    track_id: int
    title: str
    artist: str
    duration: int
    permalink_url: str
    original: OriginalFile | None
    original_reason: str | None
    original_message: str | None
    streams: list[StreamFormat] = field(default_factory=list)
    flags: dict[str, Any] = field(default_factory=dict)
    account_configured: bool = False
    ffmpeg_available: bool = False

    def select_stream(self, quality: str) -> StreamFormat | None:
        if not self.streams:
            return None
        target = max if quality == "high" else min
        bitrate = target((s.bitrate or 0) for s in self.streams)
        tied = [s for s in self.streams if (s.bitrate or 0) == bitrate]
        return next((s for s in tied if s.protocol == "progressive"), tied[0])

    def to_public(self) -> dict[str, Any]:
        return {
            "ok": True,
            "trackId": self.track_id,
            "source": "yt-dlp",
            "track": {
                "title": self.title,
                "artist": self.artist,
                "duration": self.duration,
                "permalink_url": self.permalink_url,
            },
            "original": (
                self.original.to_public()
                if self.original
                else {
                    "available": False,
                    "reason": self.original_reason or "unavailable",
                    "message": self.original_message
                    or "SoundCloud isn't exposing an original file for this track.",
                }
            ),
            "streams": [s.to_public() for s in self.streams],
            "wavConversion": {
                "available": bool(self.streams) and self.ffmpeg_available,
                "source": (
                    self.select_stream("high").to_public() if self.streams else None
                ),
            },
            "flags": self.flags,
            "account": {"configured": self.account_configured},
        }


class _YtDlpLogger:
    def __init__(self) -> None:
        self.warnings: list[str] = []

    def debug(self, message: str) -> None:
        pass

    def info(self, message: str) -> None:
        pass

    def warning(self, message: str) -> None:
        self.warnings.append(str(message))

    def error(self, message: str) -> None:
        self.warnings.append(str(message))


def _is_original_format(fmt: dict[str, Any]) -> bool:
    format_id = str(fmt.get("format_id") or "").lower()
    note = str(fmt.get("format_note") or "").lower()
    return format_id == "download" or note.startswith("original")


def _extract_sync(permalink: str, token: str | None, user_agent: str) -> tuple[dict, list[str]]:
    import yt_dlp

    logger = _YtDlpLogger()
    options: dict[str, Any] = {
        "quiet": True,
        "no_color": True,
        "skip_download": True,
        "noplaylist": True,
        "cachedir": False,
        "socket_timeout": 20,
        "retries": 2,
        "extractor_retries": 2,
        "logger": logger,
        "http_headers": {"User-Agent": user_agent},
    }
    if token:
        # yt-dlp's SoundCloud extractor uses this to send "Authorization: OAuth ..."
        options["username"] = "oauth"
        options["password"] = token
    with yt_dlp.YoutubeDL(options) as ydl:
        info = ydl.extract_info(permalink, download=False)
    if not isinstance(info, dict):
        raise ServiceError(502, "extract_failed", "yt-dlp returned no track information.")
    return info, logger.warnings


class FormatService:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    async def extract(
        self,
        track: ApiTrack,
        token: str | None,
        account_configured: bool,
        ffmpeg_available: bool,
        auth_failed: bool = False,
    ) -> TrackFormats:
        info, warnings = await self._run_extract(track.permalink_url, token)

        formats = info.get("formats")
        if not isinstance(formats, list):
            formats = []

        original_format = next((f for f in formats if isinstance(f, dict) and _is_original_format(f)), None)
        original = await self._describe_original(original_format) if original_format else None
        streams = self._normalize_streams(formats)
        if not streams and isinstance(info.get("url"), str):
            fallback = self._stream_from_info(info)
            if fallback:
                streams.append(fallback)

        auth_failed = auth_failed or "__auth_failed__" in warnings
        reason, message = self._original_reason(
            track, original is not None, account_configured, auth_failed, warnings
        )

        return TrackFormats(
            track_id=track.id,
            title=track.title,
            artist=track.artist,
            duration=track.duration,
            permalink_url=track.permalink_url,
            original=original,
            original_reason=reason,
            original_message=message,
            streams=streams,
            flags={
                "downloadable": track.downloadable,
                "hasDownloadsLeft": track.has_downloads_left,
                "policy": track.policy,
                "streamable": track.streamable,
            },
            account_configured=account_configured,
            ffmpeg_available=ffmpeg_available,
        )

    async def _run_extract(self, permalink: str, token: str | None) -> tuple[dict, list[str]]:
        try:
            return await asyncio.wait_for(
                asyncio.to_thread(_extract_sync, permalink, token, self._settings.user_agent),
                timeout=self._settings.ytdlp_timeout,
            )
        except asyncio.TimeoutError as exc:
            raise ServiceError(
                504, "extract_timeout", "SoundCloud took too long to report this track's formats."
            ) from exc
        except ServiceError:
            raise
        except Exception as exc:
            if token:
                # A rejected account token must not take the authorized streams down with it.
                try:
                    info, warnings = await asyncio.wait_for(
                        asyncio.to_thread(_extract_sync, permalink, None, self._settings.user_agent),
                        timeout=self._settings.ytdlp_timeout,
                    )
                    warnings.append("__auth_failed__")
                    return info, warnings
                except Exception:
                    pass
            raise ServiceError(
                502, "extract_failed", f"yt-dlp could not read this track: {_safe_error(exc)}"
            ) from exc

    @staticmethod
    def _normalize_streams(formats: list[Any]) -> list[StreamFormat]:
        out: list[StreamFormat] = []
        seen: set[tuple[str, int | None, str]] = set()
        for fmt in formats:
            if not isinstance(fmt, dict) or _is_original_format(fmt):
                continue
            # SoundCloud snippet transcodings are authorized previews, not the track.
            if "preview" in str(fmt.get("format_id") or "").lower():
                continue
            if fmt.get("vcodec") not in (None, "none"):
                continue
            raw_ext = normalize_ext(fmt.get("ext"))
            acodec = fmt.get("acodec")
            if (not acodec or acodec == "none") and raw_ext not in (
                "mp3",
                "m4a",
                "opus",
                "ogg",
                "oga",
            ):
                continue
            protocol = str(fmt.get("protocol") or "")
            if protocol not in ("http", "https", "m3u8", "m3u8_native"):
                continue
            url = fmt.get("url")
            if not isinstance(url, str) or not is_allowed_source(url):
                continue

            codec = codec_for(raw_ext, str(acodec))
            ext = raw_ext or ("m4a" if codec == "AAC" else "mp3")
            bitrate = _bitrate(fmt)
            kind = "hls" if protocol.startswith("m3u8") else "progressive"
            key = (codec, bitrate, kind)
            if key in seen:
                continue
            seen.add(key)
            out.append(
                StreamFormat(
                    preset=str(fmt.get("format_id") or ""),
                    codec=codec,
                    ext=ext,
                    bitrate=bitrate,
                    protocol=kind,
                    url=url,
                )
            )
        out.sort(key=lambda s: (-(s.bitrate or 0), 0 if s.protocol == "progressive" else 1))
        return out

    @staticmethod
    def _stream_from_info(info: dict[str, Any]) -> StreamFormat | None:
        if "preview" in str(info.get("format_id") or "").lower():
            return None
        url = info.get("url")
        if not isinstance(url, str) or not is_allowed_source(url):
            return None
        raw_ext = normalize_ext(info.get("ext"))
        acodec = str(info.get("acodec") or "")
        codec = codec_for(raw_ext, acodec)
        protocol = str(info.get("protocol") or "")
        return StreamFormat(
            preset=str(info.get("format_id") or "best"),
            codec=codec,
            ext=raw_ext or ("m4a" if codec == "AAC" else "mp3"),
            bitrate=_bitrate(info),
            protocol="hls" if protocol.startswith("m3u8") else "progressive",
            url=url,
        )

    async def _describe_original(self, fmt: dict[str, Any]) -> OriginalFile | None:
        url = fmt.get("url")
        if not is_allowed_source(url):
            return None

        headers = await self._head(url)
        filename = filename_from_disposition(headers.get("content-disposition"))
        mime = _clean_mime(headers.get("content-type"))
        size = _content_length(headers)

        ext = pick_ext(
            ext_from_filename(filename),
            ext_from_url(url),
            fmt.get("ext"),
            MIME_EXT.get(mime or ""),
        )
        if not ext:
            return None

        recorded = fmt.get("filesize") or fmt.get("filesize_approx")
        if size is None and isinstance(recorded, (int, float)) and recorded > 0:
            size = int(recorded)

        return OriginalFile(
            url=url,
            ext=ext,
            codec=codec_for(ext),
            mime=mime or _mime_for(ext),
            bytes=size,
            filename=filename,
            bitrate=None,
        )

    async def _head(self, url: str) -> dict[str, str]:
        headers = {"User-Agent": self._settings.user_agent}
        try:
            async with httpx.AsyncClient(
                timeout=20.0, follow_redirects=True, headers=headers
            ) as client:
                response = await client.head(url)
                if response.status_code < 400 and response.status_code not in (405, 501):
                    if _clean_mime(response.headers.get("content-type")) == "text/html":
                        return {}
                    return {k.lower(): v for k, v in response.headers.items()}
                async with client.stream("GET", url, headers={"Range": "bytes=0-0"}) as ranged:
                    if ranged.status_code >= 400:
                        return {}
                    result = {k.lower(): v for k, v in ranged.headers.items()}
                    if "content-length" not in result and "content-range" in result:
                        match = re.search(r"/(\d+)\s*$", result["content-range"])
                        if match:
                            result["content-length"] = match.group(1)
                    return result
        except httpx.HTTPError:
            return {}

    @staticmethod
    def _original_reason(
        track: ApiTrack,
        has_original: bool,
        account_configured: bool,
        auth_failed: bool,
        warnings: list[str],
    ) -> tuple[str | None, str | None]:
        if has_original:
            return None, None
        if not track.downloadable:
            return (
                "not-enabled",
                "The artist hasn't enabled downloads for this track on SoundCloud.",
            )
        if not track.has_downloads_left:
            return (
                "quota",
                "SoundCloud reports that the download limit for this track has been reached.",
            )
        if not account_configured:
            return (
                "auth-required",
                "Original files need a SoundCloud account configured on this server.",
            )
        if auth_failed or any(ORIGINAL_WARNING in warning.lower() for warning in warnings):
            return (
                "auth-required",
                "The configured SoundCloud account isn't authorized to fetch this original file.",
            )
        return (
            "unavailable",
            "SoundCloud isn't exposing an original file for this track right now.",
        )


def _bitrate(fmt: dict[str, Any]) -> int | None:
    format_id = str(fmt.get("format_id") or "")
    for preset, known in PRESET_BITRATES.items():
        if preset in format_id:
            return known
    value = fmt.get("abr") or fmt.get("tbr")
    if isinstance(value, (int, float)) and value > 0:
        return int(round(value))
    match = re.search(
        r"(\d{2,4})\s*k",
        f"{fmt.get('format_id') or ''} {fmt.get('format_note') or ''}",
        re.IGNORECASE,
    )
    return int(match.group(1)) if match else None


def _clean_mime(value: str | None) -> str | None:
    if not value:
        return None
    return value.split(";", 1)[0].strip().lower() or None


def _content_length(headers: dict[str, str]) -> int | None:
    raw = headers.get("content-length")
    try:
        value = int(raw) if raw is not None else 0
    except ValueError:
        return None
    return value if value > 0 else None


def _mime_for(ext: str) -> str | None:
    for mime, known in MIME_EXT.items():
        if known == ext:
            return mime
    return None


def _safe_error(exc: Exception) -> str:
    message = re.sub(r"https?://\S+", "[url]", str(exc))
    return message[:200] or "unknown error"
