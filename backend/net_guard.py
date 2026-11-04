"""Every outbound URL this service contacts is decided here.

The audio hosts come from SoundCloud's API responses and, on the client_id scrape,
from HTML we do not control. Following those links without a policy lets a
compromised or crafted reply point the VPS at its own network — port 8090 is the
conversion service itself, and a cloud metadata address is usually one hop away.

So a URL must clear four gates before a socket opens:

1. ``https`` with no credentials and no port other than the default,
2. a hostname on the approved CDN allowlist,
3. a host that resolves only to public addresses,
4. the same two checks again on **every redirect hop**, not just the first.

Gate 4 is what makes this a redirect guard rather than a start-URL check: an
approved ``*.sndcdn.com`` address is free to redirect wherever it likes, and
without re-validation the allowlist only proves where the request began.
"""

from __future__ import annotations

import ipaddress
import logging
import os
import re
import socket
import time
from urllib.parse import urlparse

import anyio
import httpx

logger = logging.getLogger("cloudmp3.net")

# The three domains SoundCloud serves audio, images and API from. A redirect that
# leaves them is refused even when it is a genuine 302.
DEFAULT_ALLOWED_HOSTS = ("sndcdn.com", "soundcloud.com", "soundcloud.cloud")

#: Operator override, comma-separated. It can only ever *add* an approved domain;
#: it cannot relax https, the port rule or the address checks below.
ALLOWED_HOSTS_ENV = "CLOUDMP3_ALLOWED_MEDIA_HOSTS"

#: Signed media URLs put a token in the query string, so a URL is never logged.
#: Only this fixed reason plus the bare host go into the log.
BLOCKED = "blocked by the outbound host policy"

# A redirect chain this deep is a loop or an attacker, not a CDN. SoundCloud's own
# hops are one, at most two.
MAX_REDIRECTS = 4

# How long an answered lookup is trusted. Short enough that a rebind has to be
# caught inside this window, long enough that a playlist of hundreds of segments
# does not do hundreds of lookups.
DNS_TTL_SECONDS = 60.0
_DNS_CACHE_MAX = 256
_dns_cache: dict[str, tuple[bool, float]] = {}

_LABEL = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")


class UnsafeDestination(httpx.ConnectError):
    """Refusal to connect, raised from inside the request pipeline.

    It is an ``httpx`` transport error on purpose: every caller already treats a
    network failure as "this source is not reachable" and retries or reports 502,
    so a blocked destination follows the path that already exists instead of
    becoming a new error the audio routes have to learn about.
    """

    def __init__(self, reason: str) -> None:
        super().__init__(reason)


def allowed_hosts() -> tuple[str, ...]:
    """The shipped allowlist plus whatever the operator approved.

    Entries that are not plain hostnames are dropped rather than trusted, so a
    mistyped or hostile value cannot widen the policy to ``*``, to a single
    suffix such as ``com``, or to an IP literal.
    """
    extra = os.getenv(ALLOWED_HOSTS_ENV, "").strip()
    if not extra:
        return DEFAULT_ALLOWED_HOSTS
    added: list[str] = []
    for raw in extra.split(","):
        host = raw.strip().lstrip(".").rstrip(".").lower()
        labels = host.split(".")
        if len(labels) < 2 or not all(_LABEL.match(part) for part in labels):
            continue
        if all(part.isdigit() for part in labels):
            continue
        added.append(host)
    return DEFAULT_ALLOWED_HOSTS + tuple(added)


def is_public_address(host: str) -> bool:
    """True when every address ``host`` resolves to is globally routable.

    Loopback, private, link-local (so ``169.254.169.254``, the cloud metadata
    endpoint), carrier-grade NAT, multicast, reserved and unspecified all fail.
    ``ipaddress`` counts the multicast block as globally reachable, which is true
    of the range and useless as a permission: a CDN is never reached that way.
    A name with one public and one private answer fails too: an attacker who
    controls a zone gets to choose which answer the connection uses.
    """
    try:
        answers = {info[4][0] for info in socket.getaddrinfo(host, None)}
    except (UnicodeError, OSError):
        return False
    if not answers:
        return False
    for text in answers:
        try:
            ip = ipaddress.ip_address(text)
        except ValueError:
            return False
        if not ip.is_global or ip.is_multicast or ip.is_reserved:
            return False
    return True


def _host_public_cached(host: str) -> bool:
    cached = _dns_cache.get(host)
    if cached and cached[1] > time.monotonic():
        return cached[0]
    ok = is_public_address(host)
    if len(_dns_cache) >= _DNS_CACHE_MAX:
        _dns_cache.clear()
    _dns_cache[host] = (ok, time.monotonic() + DNS_TTL_SECONDS)
    return ok


def inspect_url(url: object, hosts: tuple[str, ...]) -> str | None:
    """The reason this URL may not be contacted against ``hosts``, or None.

    Returns a short reason rather than a copy of the URL: the reason is logged, and
    a signed stream address must never reach a log file.
    """
    if not isinstance(url, str) or not url:
        return "not a URL"
    try:
        parsed = urlparse(url)
        port = parsed.port  # raises for a malformed port
    except ValueError:
        return "malformed URL"
    if parsed.scheme != "https":
        return "scheme is not https"
    # https://cdn.example.com@127.0.0.1/ parses as host cdn.example.com for us and
    # as 127.0.0.1 for a less careful client, so any userinfo in the netloc — even
    # the empty `https://@host/` — is refused rather than re-parsed per hop.
    if "@" in parsed.netloc:
        return "URL carries credentials"
    if port not in (None, 443):
        return "port is not 443"
    host = (parsed.hostname or "").lower().rstrip(".")
    if not host:
        return "no hostname"
    if not any(host == allowed or host.endswith("." + allowed) for allowed in hosts):
        return "host is not an approved SoundCloud address"
    return None


def inspect_media_url(url: object) -> str | None:
    """Audio, image and API addresses, judged against the approved CDN list."""
    return inspect_url(url, allowed_hosts())


def inspect_page_url(url: object) -> str | None:
    """A track or profile *page*, which only ever lives on soundcloud.com.

    Stricter than the media rule: ``sndcdn.com`` is a fine place to fetch audio
    from and a nonsense place to find a track page, and a page address is the one
    link handed to yt-dlp — a third-party resolver that opens its own sockets and
    cannot be guarded from here.
    """
    return inspect_url(url, ("soundcloud.com",))


def is_allowed_media_url(url: object) -> bool:
    """Cheap check: scheme, port, credentials and hostname. No DNS, no blocking."""
    return inspect_media_url(url) is None


# Kept as the name the audio code already calls.
is_allowed_source = is_allowed_media_url


async def assert_safe_media_url(url: object) -> str:
    """Full gate: the shape checks above, then that the host resolves publicly.

    The lookup runs off the event loop; a blocking ``getaddrinfo`` inside a request
    would stall every other download on this process.
    """
    reason = inspect_media_url(url)
    if reason is not None:
        logger.warning("%s: a request was refused, %s", BLOCKED, reason)
        raise UnsafeDestination(f"{BLOCKED}: {reason}")
    assert isinstance(url, str)
    host = (urlparse(url).hostname or "").lower().rstrip(".")
    public = await anyio.to_thread.run_sync(_host_public_cached, host)
    if not public:
        logger.warning("%s: %s does not resolve to a public address", BLOCKED, host)
        raise UnsafeDestination(f"{BLOCKED}: {host} is not publicly reachable")
    return url


async def _guard_request(request: httpx.Request) -> None:
    """Runs once per hop, redirects included, before the connection is opened."""
    await assert_safe_media_url(str(request.url))


def media_client(
    timeout: httpx.Timeout | float,
    *,
    headers: dict[str, str] | None = None,
    max_redirects: int = MAX_REDIRECTS,
    transport: httpx.AsyncBaseTransport | None = None,
) -> httpx.AsyncClient:
    """An HTTP client that cannot be pointed anywhere the policy forbids.

    ``follow_redirects`` stays on because SoundCloud's CDN genuinely redirects; what
    changes is that each new address is re-checked, and that the chain is bounded.

    ``transport`` exists for the tests: a mocked transport lets a suite drive the
    real client, the real hooks and the real redirect loop without a socket.
    """
    return httpx.AsyncClient(
        timeout=timeout,
        headers=headers,
        transport=transport,
        follow_redirects=True,
        max_redirects=max_redirects,
        event_hooks={"request": [_guard_request]},
    )
