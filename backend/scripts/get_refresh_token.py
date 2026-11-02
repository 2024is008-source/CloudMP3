"""One-time helper that obtains a SoundCloud refresh token for the service.

Usage (locally, never in production):

    export SOUNDCLOUD_CLIENT_ID=...
    export SOUNDCLOUD_CLIENT_SECRET=...
    python scripts/get_refresh_token.py --out data/soundcloud-token.json

The redirect URI below must be registered on the SoundCloud app. Override it
with SOUNDCLOUD_REDIRECT_URI or --redirect-uri.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import secrets
import threading
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import httpx

AUTHORIZE_URL = "https://secure.soundcloud.com/authorize"
TOKEN_URL = "https://secure.soundcloud.com/oauth/token"
DEFAULT_REDIRECT = "http://127.0.0.1:8765/callback"

RESULT: dict[str, str] = {}


class CallbackHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/callback":
            self._reply(404, "<h1>Not found</h1>")
            return
        params = urllib.parse.parse_qs(parsed.query)
        for key in ("code", "state", "error", "error_description"):
            value = params.get(key, [""])[0]
            if value:
                RESULT[key] = value

        if "error" in RESULT:
            self._reply(400, f"<h1>Authorization failed</h1><p>{RESULT['error']}</p>")
            return
        self._reply(200, "<h1>Authorized</h1><p>You can close this tab.</p>")

    def _reply(self, status: int, body: str) -> None:
        payload = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_args) -> None:
        pass


def pkce_pair() -> tuple[str, str]:
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(64)).decode().rstrip("=")
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).decode().rstrip("=")
    return verifier, challenge


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", help="Write the service token store JSON to this path")
    parser.add_argument("--redirect-uri", default=os.getenv("SOUNDCLOUD_REDIRECT_URI", DEFAULT_REDIRECT))
    args = parser.parse_args()

    client_id = os.getenv("SOUNDCLOUD_CLIENT_ID", "").strip()
    client_secret = os.getenv("SOUNDCLOUD_CLIENT_SECRET", "").strip()
    if not client_id or not client_secret:
        print("Set SOUNDCLOUD_CLIENT_ID and SOUNDCLOUD_CLIENT_SECRET first.")
        return 2

    redirect = urllib.parse.urlparse(args.redirect_uri)
    if redirect.hostname not in ("127.0.0.1", "localhost") or not redirect.port:
        print("Use a loopback redirect URI such as http://127.0.0.1:8765/callback.")
        return 2

    verifier, challenge = pkce_pair()
    state = secrets.token_urlsafe(24)
    authorize = (
        f"{AUTHORIZE_URL}?client_id={urllib.parse.quote(client_id)}"
        f"&redirect_uri={urllib.parse.quote(args.redirect_uri, safe='')}"
        f"&response_type=code&code_challenge={challenge}"
        f"&code_challenge_method=S256&state={state}"
    )

    server = HTTPServer((redirect.hostname, redirect.port), CallbackHandler)
    thread = threading.Thread(target=server.handle_request, daemon=True)
    thread.start()

    print("Open this URL and sign in with the SoundCloud account that will fetch originals:\n")
    print(authorize)
    try:
        webbrowser.open(authorize)
    except Exception:
        pass
    print("\nWaiting for the callback...")
    thread.join(timeout=300)
    server.server_close()

    if not RESULT:
        print("No callback received. Check the redirect URI registered on the app.")
        return 1
    if RESULT.get("error"):
        print(f"Authorization failed: {RESULT['error']} {RESULT.get('error_description', '')}")
        return 1
    if not hmac.compare_digest(RESULT.get("state", ""), state):
        print("State mismatch; aborting.")
        return 1
    code = RESULT.get("code")
    if not code:
        print("No authorization code returned.")
        return 1

    try:
        response = httpx.post(
            TOKEN_URL,
            data={
                "grant_type": "authorization_code",
                "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uri": args.redirect_uri,
                "code": code,
                "code_verifier": verifier,
            },
            headers={"Accept": "application/json"},
            timeout=30,
        )
    except httpx.HTTPError as exc:
        print(f"Token request failed: {exc}")
        return 1

    if response.status_code != 200:
        print(f"Token endpoint returned {response.status_code}: {response.text[:300]}")
        return 1

    body = response.json()
    refresh_token = body.get("refresh_token")
    if not refresh_token:
        print("SoundCloud returned no refresh_token. Check the app's OAuth settings.")
        return 1

    if args.out:
        path = Path(args.out)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps({"refresh_token": refresh_token}, indent=2) + "\n", "utf-8"
        )
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
        print(f"Wrote {path}. Mount it at TOKEN_STORE_PATH and do not commit it.")
    else:
        print("\nSOUNDCLOUD_REFRESH_TOKEN=" + refresh_token)
        print("\nStore it as a service secret; it is shown once.")

    if body.get("access_token"):
        print(f"Access token expires in {body.get('expires_in', 'unknown')} seconds.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
