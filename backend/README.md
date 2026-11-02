# CloudMP3 original audio service

A small FastAPI service that lets the CloudMP3 Worker retrieve **artist-uploaded
original audio** from SoundCloud. It uses the yt-dlp Python API for format
extraction and FFmpeg for optional WAV conversion.

The public website runs on Cloudflare Workers, which cannot run Python or
FFmpeg, so this service is hosted separately (Docker/VPS) and called server to
server. Visitors never log in: one SoundCloud API app account is configured on
the service, and SoundCloud still enforces each track's download permission.

## What it will and will not do

- Reports an original file only when SoundCloud actually exposes one through
  yt-dlp's `download` / `Original` format. A WAV-extension transcoding is never
  treated as the original upload.
- Preserves the real extension, codec, MIME type and filename of the original.
- Refuses when the artist disabled downloads, the download quota is exhausted,
  or the account is not authorized. It never tries to bypass those rules.
- Labels FFmpeg WAV output as converted. Conversion cannot restore quality
  beyond the source stream.

## Endpoints

All `/api/*` calls require the `X-Api-Key` header.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness probe, no key. |
| GET | `/api/health` | yt-dlp/FFmpeg versions, account configured flag. |
| GET | `/api/account` | Verifies the account token against `/me`. |
| GET | `/api/formats/{track_id}` | Real formats, original availability, conversion support. |
| GET | `/api/download/{track_id}?mode=original` | Streams the original file with its real headers. |
| GET | `/api/download/{track_id}?mode=wav&quality=high\|low` | FFmpeg-converted WAV from an authorized stream. |

Source URLs never leave the service; only track ids are accepted, so the
service cannot be used to fetch arbitrary URLs.

## Setup

1. Create an app at <https://developers.soundcloud.com>. Register
   `http://127.0.0.1:8765/callback` as a redirect URI for the one-time helper.
2. Get a refresh token for the account that will fetch originals:

   ```sh
   export SOUNDCLOUD_CLIENT_ID=...
   export SOUNDCLOUD_CLIENT_SECRET=...
   python scripts/get_refresh_token.py --out data/soundcloud-token.json
   ```

   Sign in as an account that can access the tracks you expect. SoundCloud
   rotates refresh tokens, so the helper option writes a token store that the
   service updates in place.

3. Configure the service:

   ```sh
   cp .env.example .env
   # CLOUDMP3_SERVICE_KEY=...        shared secret with the Worker
   # SOUNDCLOUD_CLIENT_ID=...
   # SOUNDCLOUD_CLIENT_SECRET=...
   # SOUNDCLOUD_REFRESH_TOKEN=...    seed if you did not write a token store
   ```

4. Run it:

   ```sh
   docker compose up -d --build
   curl http://127.0.0.1:8080/health
   curl -H "X-Api-Key: $CLOUDMP3_SERVICE_KEY" http://127.0.0.1:8080/api/account
   ```

   Or locally: `python -m venv .venv && .venv/bin/pip install -r requirements-dev.txt`
   then `uvicorn main:app --port 8080`.

5. Point the Worker at it (Cloudflare dashboard → Workers → Settings → Variables,
   or `wrangler secret put`):

   ```text
   CLOUDMP3_SERVICE_URL=https://original-audio.example.com
   CLOUDMP3_SERVICE_KEY=<same shared secret>
   ```

   Without these variables the site keeps working and simply does not offer
   original files.

## Operations

- **Run one worker.** Refresh tokens are single-use; concurrent workers would
  rotate the same token and invalidate each other. The Dockerfile enforces
  `--workers 1`.
- **Persist `/data`.** The rotated refresh token lives in
  `TOKEN_STORE_PATH` (default `/data/soundcloud-token.json`). Losing it means
  running the helper again.
- **Rotating the account:** delete the token file, set a new
  `SOUNDCLOUD_REFRESH_TOKEN`, and restart the service.
- **HTTPS only.** Put the service behind TLS; the shared key is a bearer secret.
- Logs never include access or refresh tokens.

## Tests

```sh
python -m pytest
```

The suite covers extension/codec detection, Content-Disposition parsing, the
source-host allowlist, refresh-token rotation, and endpoint validation.
