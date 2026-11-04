from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124 Safari/537.36"
)


def _int_env(name: str, default: int) -> int:
    try:
        value = int(os.getenv(name, "").strip())
    except ValueError:
        return default
    return value if value > 0 else default


@dataclass(frozen=True)
class Settings:
    service_key: str
    client_id: str
    client_secret: str
    refresh_token: str
    access_token: str
    token_store: Path
    ytdlp_timeout: int
    convert_timeout: int
    max_convert_bytes: int
    temp_ttl_seconds: int
    max_concurrent_conversions: int
    user_agent: str = DEFAULT_UA
    # ZIP jobs are capped apart from FFmpeg: one archive holds its tracks open
    # on disk for as long as it takes to build, which is a different cost.
    max_concurrent_zip_jobs: int = 2
    max_zip_tracks: int = 50
    max_zip_bytes: int = 2 * 1024 * 1024 * 1024
    zip_timeout: int = 1800
    zip_temp_dir: str = ""

    @property
    def oauth_configured(self) -> bool:
        return bool(self.refresh_token or self.access_token)


def load_settings() -> Settings:
    return Settings(
        service_key=os.getenv("CLOUDMP3_SERVICE_KEY", "").strip(),
        client_id=os.getenv("SOUNDCLOUD_CLIENT_ID", "").strip(),
        client_secret=os.getenv("SOUNDCLOUD_CLIENT_SECRET", "").strip(),
        refresh_token=os.getenv("SOUNDCLOUD_REFRESH_TOKEN", "").strip(),
        access_token=os.getenv("SOUNDCLOUD_ACCESS_TOKEN", "").strip(),
        token_store=Path(
            os.getenv("TOKEN_STORE_PATH", "./data/soundcloud-token.json").strip()
            or "./data/soundcloud-token.json"
        ),
        ytdlp_timeout=_int_env("YTDLP_TIMEOUT", 60),
        convert_timeout=_int_env("FFMPEG_TIMEOUT", 300),
        max_convert_bytes=_int_env("MAX_CONVERT_BYTES", 600 * 1024 * 1024),
        temp_ttl_seconds=_int_env("TEMP_TTL_SECONDS", 300),
        max_concurrent_conversions=_int_env("MAX_CONCURRENT_CONVERSIONS", 2),
        max_concurrent_zip_jobs=_int_env("MAX_CONCURRENT_ZIP_JOBS", 2),
        max_zip_tracks=_int_env("MAX_ZIP_TRACKS", 50),
        max_zip_bytes=_int_env("MAX_ZIP_TOTAL_BYTES", 2 * 1024 * 1024 * 1024),
        zip_timeout=_int_env("ZIP_JOB_TIMEOUT_SECONDS", 1800),
        zip_temp_dir=os.getenv("ZIP_TEMP_DIR", "").strip(),
    )
