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
    user_agent: str = DEFAULT_UA

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
    )
