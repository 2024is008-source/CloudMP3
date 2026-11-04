"""The outbound policy is the proof, not the comment.

Each test below drives the real ``net_guard.media_client``: real event hooks, real
redirect loop, real address gate. Only the transport (``httpx.MockTransport``) and
the resolver are stood in for, so ``routes.requested`` is exactly the list of
addresses a socket would have been opened for. Every "blocked" test therefore
asserts the blocked address is absent from it, not merely that an error was
raised.
"""

from __future__ import annotations

import ipaddress
import itertools
import re
import socket

import httpx
import pytest

import net_guard
import stream
from errors import ServiceError
from net_guard import (
    UnsafeDestination,
    inspect_media_url,
    inspect_page_url,
    is_allowed_media_url,
)
from sc_api import SoundCloudApi

PUBLIC_IP = "93.184.215.34"
CDN_PAGE = "https://cf-media.sndcdn.com/media-aac"
CDN_SECOND = "https://cf-media.sndcdn.com/second"
MASTER = "https://cf-media.sndcdn.com/master.m3u8"
TRACK_PAGE = "https://soundcloud.com/artist/title"


class _Resolver:
    """Stands in for ``socket`` so no test performs a real lookup."""

    gaierror = socket.gaierror
    timeout = socket.timeout

    def __init__(self) -> None:
        self.answers: dict[str, list[str]] = {}
        self.lookups: list[str] = []

    def add(self, host: str, *addresses: str) -> None:
        self.answers[host] = list(addresses)

    def getaddrinfo(self, host: str, port=None):
        self.lookups.append(host)
        addresses = self.answers.get(host)
        if addresses is None:
            # A literal address resolves to itself; a name that was not
            # registered does not resolve at all.
            try:
                ipaddress.ip_address(host)
            except ValueError:
                raise socket.gaierror(-2, "Name or service not known") from None
            addresses = [host]
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (a, 0)) for a in addresses]


class _Internet:
    """The mocked network: what it answers and what it was ever asked for."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.requested: list[str] = []
        self.bodies: dict[str, bytes] = {}
        self.redirects: dict[str, str] = {}
        self._transport = httpx.MockTransport(self._handler)
        self._monkeypatch = monkeypatch

    def add(self, url: str, body: bytes = b"audio") -> None:
        self.bodies[url] = body

    def redirect(self, url: str, target: str) -> None:
        self.redirects[url] = target

    def patch(self, module) -> None:
        """Make one module's clients use this transport; the guard stays real."""
        real = module.media_client
        self._monkeypatch.setattr(
            module,
            "media_client",
            lambda timeout, **kwargs: real(timeout, transport=self._transport, **kwargs),
        )

    def client(self, **kwargs) -> httpx.AsyncClient:
        return net_guard.media_client(5.0, transport=self._transport, **kwargs)

    def _handler(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        self.requested.append(url)
        if url in self.redirects:
            return httpx.Response(302, headers={"location": self.redirects[url]})
        if url in self.bodies:
            return httpx.Response(200, content=self.bodies[url])
        return httpx.Response(404)


@pytest.fixture(autouse=True)
def dns(monkeypatch: pytest.MonkeyPatch) -> _Resolver:
    resolver = _Resolver()
    for host in ("cf-media.sndcdn.com", "api.sndcdn.com", "i.sndcdn.com", "soundcloud.com"):
        resolver.add(host, PUBLIC_IP)
    monkeypatch.setattr(net_guard, "socket", resolver)
    net_guard._dns_cache.clear()
    yield resolver
    net_guard._dns_cache.clear()


@pytest.fixture
def internet(monkeypatch: pytest.MonkeyPatch) -> _Internet:
    return _Internet(monkeypatch)


# --- the shape gate ----------------------------------------------------------


def test_http_credentials_and_ports_are_all_refused() -> None:
    assert inspect_media_url("http://api.sndcdn.com/x") == "scheme is not https"
    assert inspect_media_url("https://api.sndcdn.com/x") is None
    assert inspect_media_url("https://api.sndcdn.com:8443/x") == "port is not 443"
    assert inspect_media_url("https://api.sndcdn.com:443/x") is None
    assert inspect_media_url("file:///etc/passwd") == "scheme is not https"
    assert inspect_media_url("https:///x") == "no hostname"
    assert inspect_media_url("not a url") == "scheme is not https"
    assert inspect_media_url("https://api.sndcdn.com:notaport/x") == "malformed URL"


def test_credentials_are_refused_whatever_host_they_look_like() -> None:
    # https://cdn.sndcdn.com@127.0.0.1/ is 127.0.0.1 to a careless client.
    assert (
        inspect_media_url("https://cf-media.sndcdn.com@127.0.0.1/") == "URL carries credentials"
    )
    assert inspect_media_url("https://@cf-media.sndcdn.com/x") == "URL carries credentials"


def test_lookalike_hosts_are_refused() -> None:
    assert (
        inspect_media_url("https://sndcdn.com.evil.example/x")
        == "host is not an approved SoundCloud address"
    )
    assert (
        inspect_media_url("https://notsndcdn.com/x")
        == "host is not an approved SoundCloud address"
    )
    assert (
        inspect_media_url("https://evil.example/sndcdn.com")
        == "host is not an approved SoundCloud address"
    )
    assert is_allowed_media_url("https://api-v2.soundcloud.com/tracks/1")


def test_the_env_override_adds_domains_and_drops_anything_looser(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(
        net_guard.ALLOWED_HOSTS_ENV, " media.example , .com, *, 127.0.0.1, audio.cdn.co.uk"
    )
    assert net_guard.allowed_hosts() == net_guard.DEFAULT_ALLOWED_HOSTS + (
        "media.example",
        "audio.cdn.co.uk",
    )
    # The override widens the host list only: https, the port and the address
    # gates still apply to a newly approved domain.
    assert is_allowed_media_url("https://media.example/a")
    assert not is_allowed_media_url("http://media.example/a")
    assert not is_allowed_media_url("https://x.com/a")


def test_a_track_page_only_lives_on_soundcloud_com() -> None:
    assert inspect_page_url(TRACK_PAGE) is None
    # sndcdn.com is a fine place to fetch audio and a nonsense place to find a
    # page — and a page is what gets handed to yt-dlp.
    assert inspect_page_url(CDN_PAGE) == "host is not an approved SoundCloud address"


# --- the address gate --------------------------------------------------------


@pytest.mark.parametrize(
    "address",
    [
        "127.0.0.1",
        "127.2.3.4",
        "10.0.0.5",
        "172.16.0.1",
        "192.168.1.50",
        "169.254.169.254",
        "100.64.0.1",
        "198.18.0.1",
        "0.0.0.0",
        "255.255.255.255",
        "224.0.0.1",
        "239.255.255.255",
        "240.0.0.1",
        "::1",
        "fc00::1",
        "fe80::1",
        "ff02::1",
    ],
)
def test_a_name_that_resolves_to_a_non_public_address_is_not_public(address: str) -> None:
    assert net_guard.is_public_address(address) is False


def test_a_publicly_routable_address_is_public() -> None:
    assert net_guard.is_public_address(PUBLIC_IP) is True
    assert net_guard.is_public_address("2001:4860:4860::8888") is True


def test_a_host_with_one_private_record_is_not_public(dns: _Resolver) -> None:
    # An attacker holding the zone chooses which answer the connection uses.
    dns.add("split.sndcdn.com", PUBLIC_IP, "127.0.0.1")
    assert net_guard.is_public_address("split.sndcdn.com") is False


def test_a_name_that_does_not_resolve_is_not_public(dns: _Resolver) -> None:
    assert net_guard.is_public_address("no-such-name.sndcdn.com") is False


# --- redirects ---------------------------------------------------------------


async def test_an_approved_cdn_redirect_is_followed(internet: _Internet) -> None:
    internet.add(CDN_PAGE)
    internet.redirect("https://api.sndcdn.com/hop", CDN_PAGE)
    async with internet.client() as client:
        response = await client.get("https://api.sndcdn.com/hop")

    assert response.status_code == 200
    assert internet.requested == ["https://api.sndcdn.com/hop", CDN_PAGE]


async def test_a_redirect_to_an_unapproved_host_is_never_requested(
    internet: _Internet, dns: _Resolver
) -> None:
    dns.add("redirect.sndcdn.com", PUBLIC_IP)
    internet.redirect("https://redirect.sndcdn.com/a", "https://10.0.0.9/latest/meta-data")
    async with internet.client() as client:
        with pytest.raises(UnsafeDestination):
            await client.get("https://redirect.sndcdn.com/a")

    assert internet.requested == ["https://redirect.sndcdn.com/a"]


async def test_a_redirect_onto_the_loopback_service_port_is_refused(
    internet: _Internet, dns: _Resolver
) -> None:
    dns.add("bounce.sndcdn.com", PUBLIC_IP)
    internet.redirect("https://bounce.sndcdn.com/a", "http://127.0.0.1:8090/api/formats/1")
    async with internet.client() as client:
        with pytest.raises(UnsafeDestination):
            await client.get("https://bounce.sndcdn.com/a")

    assert internet.requested == ["https://bounce.sndcdn.com/a"]


async def test_a_redirect_to_a_public_ip_outside_the_allowlist_is_refused(
    internet: _Internet, dns: _Resolver
) -> None:
    # 8.8.8.8 passes the address gate on its own; the host list is what stops it.
    dns.add("open.sndcdn.com", PUBLIC_IP)
    internet.redirect("https://open.sndcdn.com/a", "https://8.8.8.8/")
    async with internet.client() as client:
        with pytest.raises(UnsafeDestination):
            await client.get("https://open.sndcdn.com/a")

    assert internet.requested == ["https://open.sndcdn.com/a"]


async def test_a_name_that_resolves_only_at_the_second_hop_is_caught(
    internet: _Internet, dns: _Resolver
) -> None:
    dns.add("internal.sndcdn.com", "169.254.169.254")
    internet.redirect("https://cf-media.sndcdn.com/a", "https://internal.sndcdn.com/b")
    async with internet.client() as client:
        with pytest.raises(UnsafeDestination):
            await client.get("https://cf-media.sndcdn.com/a")

    assert internet.requested == ["https://cf-media.sndcdn.com/a"]


async def test_a_redirect_loop_stops_without_leaving_the_allowlist(
    internet: _Internet, dns: _Resolver
) -> None:
    dns.add("loop.sndcdn.com", PUBLIC_IP)
    loop = "https://loop.sndcdn.com/round"
    internet.redirect(loop, loop)
    async with internet.client() as client:
        with pytest.raises(httpx.TooManyRedirects):
            await client.get(loop)

    assert 0 < len(internet.requested) <= net_guard.MAX_REDIRECTS + 1


async def test_a_long_chain_of_approved_hops_is_bounded(
    internet: _Internet, dns: _Resolver
) -> None:
    dns.add("chain.sndcdn.com", PUBLIC_IP)
    first = "https://chain.sndcdn.com/0"
    for i in range(20):
        internet.redirect(f"https://chain.sndcdn.com/{i}", f"https://chain.sndcdn.com/{i + 1}")
    async with internet.client() as client:
        with pytest.raises(httpx.TooManyRedirects):
            await client.get(first)

    assert len(internet.requested) == net_guard.MAX_REDIRECTS + 1


async def test_a_blocked_address_is_refused_before_any_lookup_or_socket(
    internet: _Internet, dns: _Resolver
) -> None:
    dns.lookups.clear()
    internet.add(CDN_PAGE)
    async with internet.client() as client:
        with pytest.raises(UnsafeDestination):
            await client.get("https://evil.example/x")

    assert internet.requested == []
    assert dns.lookups == []


async def test_a_dns_failure_costs_the_request_without_a_socket(
    internet: _Internet, dns: _Resolver
) -> None:
    # Right shape, approved domain, and nothing to connect to.
    async with internet.client() as client:
        with pytest.raises(UnsafeDestination):
            await client.get("https://gone.sndcdn.com/x")

    assert internet.requested == []
    assert dns.lookups == ["gone.sndcdn.com"]


async def test_a_lookup_is_reused_for_its_whole_ttl(
    internet: _Internet, dns: _Resolver
) -> None:
    internet.add(CDN_PAGE)
    internet.add("https://cf-media.sndcdn.com/second", b"audio")
    async with internet.client() as client:
        await client.get(CDN_PAGE)
        await client.get("https://cf-media.sndcdn.com/second")

    assert dns.lookups.count("cf-media.sndcdn.com") == 1


async def test_a_blocked_redirect_never_puts_a_signed_url_in_the_log(
    internet: _Internet, caplog: pytest.LogCaptureFixture
) -> None:
    secret = "https://cf-media.sndcdn.com/media?policy=1&signature=abc123"
    internet.redirect(secret, "http://169.254.169.254/latest/meta-data/")

    with caplog.at_level("WARNING", logger="cloudmp3.net"):
        async with internet.client() as client:
            with pytest.raises(UnsafeDestination):
                await client.get(secret)

    assert "abc123" not in caplog.text
    assert "latest/meta-data" not in caplog.text
    assert "host policy" in caplog.text


# --- HLS ---------------------------------------------------------------------


async def test_an_unapproved_hls_segment_is_never_fetched(
    internet: _Internet, monkeypatch: pytest.MonkeyPatch
) -> None:
    internet.patch(stream)
    internet.add(MASTER, b'#EXTM3U\n#EXT-X-MAP:URI="init.m4s"\nseg1.m4s\nhttps://evil.example/s.m4s\n')

    with pytest.raises(ServiceError) as excinfo:
        await stream.collect_segments(MASTER, "ua")

    assert (excinfo.value.status, excinfo.value.code) == (502, "source_blocked")
    assert internet.requested == [MASTER]


async def test_an_hls_segment_on_http_is_never_fetched(
    internet: _Internet, monkeypatch: pytest.MonkeyPatch
) -> None:
    internet.patch(stream)
    internet.add(MASTER, b"#EXTM3U\nhttp://cf-media.sndcdn.com/seg1.m4s\n")

    with pytest.raises(ServiceError) as excinfo:
        await stream.collect_segments(MASTER, "ua")

    assert excinfo.value.code == "source_blocked"
    assert internet.requested == [MASTER]


async def test_a_playlist_relative_reference_to_a_new_origin_is_refused(
    internet: _Internet, monkeypatch: pytest.MonkeyPatch
) -> None:
    internet.patch(stream)
    # Resolved against the playlist this becomes //evil.example, a different host.
    internet.add(MASTER, b"#EXTM3U\n//evil.example/seg1.m4s\n")

    with pytest.raises(ServiceError) as excinfo:
        await stream.collect_segments(MASTER, "ua")

    assert excinfo.value.code == "source_blocked"
    assert internet.requested == [MASTER]


async def test_a_nested_playlist_is_expanded_and_every_leaf_is_approved(
    internet: _Internet, monkeypatch: pytest.MonkeyPatch
) -> None:
    internet.patch(stream)
    variant = "https://cf-media.sndcdn.com/variant.m3u8"
    internet.add(MASTER, b"#EXTM3U\nvariant.m3u8\n")
    internet.add(variant, b'#EXTM3U\n#EXT-X-MAP:URI="init.m4s"\na.m4s\nb.m4s\n')

    segments = await stream.collect_segments(MASTER, "ua")

    assert segments == [
        "https://cf-media.sndcdn.com/init.m4s",
        "https://cf-media.sndcdn.com/a.m4s",
        "https://cf-media.sndcdn.com/b.m4s",
    ]
    assert internet.requested == [MASTER, variant]


async def test_a_nested_playlist_pointing_off_the_allowlist_is_refused(
    internet: _Internet, monkeypatch: pytest.MonkeyPatch
) -> None:
    internet.patch(stream)
    variant = "https://cf-media.sndcdn.com/variant.m3u8"
    internet.add(MASTER, b"#EXTM3U\nvariant.m3u8\n")
    internet.add(variant, b"#EXTM3U\nhttp://127.0.0.1:8090/x\n")

    with pytest.raises(ServiceError) as excinfo:
        await stream.collect_segments(MASTER, "ua")

    assert excinfo.value.code == "source_blocked"
    assert internet.requested == [MASTER, variant]


async def test_a_playlist_that_nests_forever_is_stopped(
    internet: _Internet, monkeypatch: pytest.MonkeyPatch
) -> None:
    internet.patch(stream)
    urls = [f"https://cf-media.sndcdn.com/p{i}.m3u8" for i in range(stream.PLAYLIST_MAX_DEPTH + 2)]
    for url, nxt in itertools.pairwise(urls):
        internet.add(url, f"#EXTM3U\n{nxt}\n".encode())

    with pytest.raises(ServiceError) as excinfo:
        await stream.collect_segments(urls[0], "ua")

    assert excinfo.value.code == "download_failed"
    assert internet.requested == urls[: stream.PLAYLIST_MAX_DEPTH]


async def test_a_keyed_playlist_is_refused_as_drm(
    internet: _Internet, monkeypatch: pytest.MonkeyPatch
) -> None:
    internet.patch(stream)
    internet.add(MASTER, b'#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://cf-media.sndcdn.com/k"\na.m4s\n')

    with pytest.raises(ServiceError) as excinfo:
        await stream.collect_segments(MASTER, "ua")

    assert (excinfo.value.status, excinfo.value.code) == (403, "drm_protected")


async def test_stage_source_writes_the_validated_segments_to_disk(
    internet: _Internet, monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    internet.patch(stream)
    internet.add(MASTER, b"#EXTM3U\n#EXT-X-MAP:URI=\"init.m4s\"\na.m4s\n")
    internet.add("https://cf-media.sndcdn.com/init.m4s", b"init")
    internet.add("https://cf-media.sndcdn.com/a.m4s", b"body")
    settings = _settings(tmp_path)

    path = await stream.stage_source(MASTER, settings, str(tmp_path))

    assert _read_bytes(path) == b"initbody"
    assert internet.requested == [MASTER, "https://cf-media.sndcdn.com/init.m4s", "https://cf-media.sndcdn.com/a.m4s"]


def _read_bytes(path: str) -> bytes:
    with open(path, "rb") as staged:
        return staged.read()


def _settings(tmp_path):
    from config import Settings

    return Settings(
        service_key="k",
        client_id="id",
        client_secret="secret",
        refresh_token="",
        access_token="",
        token_store=tmp_path / "token.json",
        ytdlp_timeout=60,
        convert_timeout=300,
        max_convert_bytes=1024 * 1024,
        temp_ttl_seconds=300,
        max_concurrent_conversions=2,
    )


# --- the page handed to yt-dlp ------------------------------------------------


def test_a_track_page_off_soundcloud_is_refused_before_it_reaches_yt_dlp() -> None:
    data = {"id": 1, "title": "x", "permalink_url": "https://evil.example/payload"}

    with pytest.raises(ServiceError) as excinfo:
        SoundCloudApi._to_track(data)

    assert (excinfo.value.status, excinfo.value.code) == (404, "not_found")


def test_an_http_permalink_is_upgraded_and_still_a_soundcloud_page() -> None:
    track = SoundCloudApi._to_track(
        {"id": 1, "title": "x", "permalink_url": "http://soundcloud.com/a/b"}
    )

    assert track.permalink_url == "https://soundcloud.com/a/b"


# --- the two services must agree ---------------------------------------------


def test_node_and_python_approve_the_same_hosts() -> None:
    """The allowlists live in two languages, so one test holds them together.

    ``src/lib/url-guard.ts`` is the Node mirror of this module. A host approved by
    the FastAPI service and refused by the Node route (or the other way round)
    shows up as a track that downloads from one screen and not the other, which no
    unit test of either language on its own would ever see.
    """
    from pathlib import Path

    source = (
        Path(__file__).resolve().parents[2] / "src" / "lib" / "url-guard.ts"
    ).read_text(encoding="utf-8")

    block = re.search(r"DEFAULT_ALLOWED_HOSTS\s*=\s*\[(.*?)\]", source, re.DOTALL)
    assert block, "url-guard.ts no longer declares DEFAULT_ALLOWED_HOSTS"
    node_hosts = tuple(re.findall(r'"([^"]+)"', block.group(1)))
    assert node_hosts == net_guard.DEFAULT_ALLOWED_HOSTS

    env_name = re.search(r'ALLOWED_HOSTS_ENV\s*=\s*"([^"]+)"', source)
    assert env_name, "url-guard.ts no longer reads the operator override"
    assert env_name.group(1) == net_guard.ALLOWED_HOSTS_ENV

    redirects = re.search(r"MAX_REDIRECTS\s*=\s*(\d+)", source)
    assert redirects and int(redirects.group(1)) == net_guard.MAX_REDIRECTS
