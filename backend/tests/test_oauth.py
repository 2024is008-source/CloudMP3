from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

import sc_oauth
from config import Settings
from errors import ServiceError
from sc_oauth import SoundCloudAuth


def make_settings(tmp_path: Path, refresh: str = "seed-token") -> Settings:
    return Settings(
        service_key="key",
        client_id="client-id",
        client_secret="client-secret",
        refresh_token=refresh,
        access_token="",
        token_store=tmp_path / "token.json",
        ytdlp_timeout=10,
        convert_timeout=10,
        max_convert_bytes=1024,
        temp_ttl_seconds=300,
        max_concurrent_conversions=2,
    )


class FakeResponse:
    def __init__(self, status: int, body: dict) -> None:
        self.status_code = status
        self._body = body
        self.text = json.dumps(body)

    def json(self) -> dict:
        return self._body


class FakeClient:
    responses: list[FakeResponse] = []
    calls: list[dict] = []

    def __init__(self, *_args, **_kwargs) -> None:
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc) -> bool:
        return False

    async def post(self, url, data=None, **_kwargs):
        FakeClient.calls.append({"url": url, "data": data})
        await asyncio.sleep(0.01)
        return FakeClient.responses.pop(0)


@pytest.fixture(autouse=True)
def reset_fake(monkeypatch):
    FakeClient.responses = []
    FakeClient.calls = []
    monkeypatch.setattr(sc_oauth.httpx, "AsyncClient", FakeClient)
    yield


async def test_refresh_rotates_and_persists(tmp_path: Path) -> None:
    path = tmp_path / "token.json"
    FakeClient.responses = [
        FakeResponse(200, {"access_token": "access-1", "refresh_token": "rotated-1", "expires_in": 3600}),
        FakeResponse(200, {"access_token": "access-2", "refresh_token": "rotated-2", "expires_in": 3600}),
    ]
    auth = SoundCloudAuth(make_settings(tmp_path))

    assert await auth.get_access_token() == "access-1"
    assert json.loads(path.read_text())["refresh_token"] == "rotated-1"
    assert FakeClient.calls[0]["data"]["grant_type"] == "refresh_token"
    assert FakeClient.calls[0]["data"]["refresh_token"] == "seed-token"

    auth._expires_at = 0
    assert await auth.get_access_token() == "access-2"
    assert FakeClient.calls[1]["data"]["refresh_token"] == "rotated-1"
    assert json.loads(path.read_text())["refresh_token"] == "rotated-2"


async def test_concurrent_callers_refresh_once(tmp_path: Path) -> None:
    FakeClient.responses = [
        FakeResponse(200, {"access_token": "access-1", "refresh_token": "rotated-1", "expires_in": 3600})
    ]
    auth = SoundCloudAuth(make_settings(tmp_path))
    tokens = await asyncio.gather(*(auth.get_access_token() for _ in range(5)))
    assert tokens == ["access-1"] * 5
    assert len(FakeClient.calls) == 1


async def test_rejected_refresh_is_reported_without_leaking_token(tmp_path: Path) -> None:
    FakeClient.responses = [
        FakeResponse(400, {"error": "invalid_grant", "error_description": "refresh token revoked"})
    ]
    auth = SoundCloudAuth(make_settings(tmp_path))
    with pytest.raises(ServiceError) as raised:
        await auth.get_access_token()
    assert raised.value.status == 502
    assert raised.value.code == "oauth_rejected"
    assert "seed-token" not in raised.value.message
    assert "revoked" in raised.value.message


async def test_stored_token_wins_over_env_seed(tmp_path: Path) -> None:
    path = tmp_path / "token.json"
    path.write_text(json.dumps({"refresh_token": "stored-token"}))
    auth = SoundCloudAuth(make_settings(tmp_path))
    assert auth._refresh_token == "stored-token"


async def test_unconfigured_returns_none(tmp_path: Path) -> None:
    settings = make_settings(tmp_path, refresh="")
    auth = SoundCloudAuth(settings)
    assert await auth.get_access_token() is None
    assert auth.configured is False
