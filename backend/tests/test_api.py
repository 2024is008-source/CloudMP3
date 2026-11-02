from __future__ import annotations

from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

import main


@pytest.fixture
def client(monkeypatch) -> TestClient:
    monkeypatch.setattr(main, "settings", replace(main.settings, service_key="test-key"))
    return TestClient(main.app)


def test_health_is_public(client: TestClient) -> None:
    assert client.get("/health").json() == {"ok": True}


def test_api_requires_key(client: TestClient) -> None:
    response = client.get("/api/formats/1")
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"


def test_missing_service_key_fails_closed(monkeypatch) -> None:
    monkeypatch.setattr(main, "settings", replace(main.settings, service_key=""))
    response = TestClient(main.app).get("/api/formats/1", headers={"X-Api-Key": "anything"})
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "service_key_unset"


def test_invalid_id_rejected_before_network(client: TestClient) -> None:
    response = client.get("/api/formats/0", headers={"X-Api-Key": "test-key"})
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "bad_track_id"


def test_invalid_mode_rejected_before_network(client: TestClient) -> None:
    response = client.get(
        "/api/download/1?mode=remux", headers={"X-Api-Key": "test-key"}
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "bad_mode"


def test_invalid_quality_rejected(client: TestClient) -> None:
    response = client.get(
        "/api/download/1?mode=wav&quality=lossless", headers={"X-Api-Key": "test-key"}
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "bad_quality"


def test_content_disposition_marks_utf8() -> None:
    header = main._disposition("Björk - Jóga.wav")
    assert header.startswith("attachment; filename=")
    assert "filename*=UTF-8''" in header
    assert "Bj%C3%B6rk" in header
