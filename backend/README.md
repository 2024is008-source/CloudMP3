# CloudMP3 original audio service

A small FastAPI service that lets the CloudMP3 site retrieve **artist-uploaded
original audio** from SoundCloud. It uses the yt-dlp Python API for format
extraction and FFmpeg for WAV and MP3 conversion.

The site runs as a Node server, which does not carry Python or FFmpeg, so this
service is hosted separately (Docker on the same VPS) and called server to
server. Visitors never log in: one SoundCloud API app account is configured on
the service, and SoundCloud still enforces each track's download permission.

## What it will and will not do

- Reports an original file only when SoundCloud actually exposes one through
  yt-dlp's `download` / `Original` format. A WAV-extension transcoding is never
  treated as the original upload.
- Preserves the real extension, codec, MIME type and filename of the original.
- Refuses when the artist disabled downloads, the download quota is exhausted,
  or the account is not authorized. It never tries to bypass those rules.
- Labels FFmpeg WAV and MP3 output as converted. Conversion cannot restore
  quality beyond the source stream.
- Writes ID3v2.3 tags (title, artist, album when known) and SoundCloud's own
  cover image into converted MP3, and keeps the `Artist - Title` filename.
- Runs at most `MAX_CONCURRENT_CONVERSIONS` FFmpeg processes at a time and
  deletes each converted file as soon as its download ends or is abandoned.
- Builds multi-track ZIP archives on disk, one track at a time, under
  `MAX_CONCURRENT_ZIP_JOBS`. Nothing is assembled in the browser and no archive
  is ever held in memory whole.

## Endpoints

All `/api/*` calls require the `X-Api-Key` header.

| Method | Path                                                                             | Purpose                                                                                                                                 |
| ------ | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/health`                                                                        | Liveness probe, no key.                                                                                                                 |
| GET    | `/api/health`                                                                    | yt-dlp/FFmpeg versions, account configured flag.                                                                                        |
| GET    | `/api/account`                                                                   | Verifies the account token against `/me`.                                                                                               |
| GET    | `/api/formats/{track_id}`                                                        | Real formats, original availability, conversion support.                                                                                |
| GET    | `/api/download/{track_id}?mode=original`                                         | Streams the original file with its real headers.                                                                                        |
| GET    | `/api/download/{track_id}?mode=wav&quality=high\|low`                            | FFmpeg-converted WAV from an authorized stream.                                                                                         |
| GET    | `/api/download/{track_id}?mode=mp3&bitrate=128\|192\|256\|320&quality=high\|low` | FFmpeg-converted, ID3-tagged MP3 from an authorized stream.                                                                             |
| POST   | `/api/download/zip`                                                              | Server-built ZIP. Body: `{"name": "...", "tracks": [{"id": 1, "mode": "original\|mp3\|wav", "quality": "high\|low", "bitrate": 320}]}`. |

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
   # CLOUDMP3_SERVICE_KEY=...        shared secret with the site's Node server
   # SOUNDCLOUD_CLIENT_ID=...
   # SOUNDCLOUD_CLIENT_SECRET=...
   # SOUNDCLOUD_REFRESH_TOKEN=...    seed if you did not write a token store
   ```

4. Run it:

   ```sh
   docker compose up -d --build
   # The compose file publishes the container's 8080 on 127.0.0.1:8090 only.
   curl http://127.0.0.1:8090/health
   curl -H "X-Api-Key: $CLOUDMP3_SERVICE_KEY" http://127.0.0.1:8090/api/account
   ```

   Or locally: `python -m venv .venv && .venv/bin/pip install -r requirements-dev.txt`
   then `uvicorn main:app --port 8080`.

5. Point the site at it (runtime environment of the Node server, before
   `pm2 start` / `pm2 restart cloudmp3 --update-env`):

   ```text
   CLOUDMP3_SERVICE_URL=http://127.0.0.1:8090
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
source-host allowlist, refresh-token rotation, endpoint validation, and the ZIP
builder's naming, limits, cleanup and cancellation. SoundCloud is never reached
from the tests.

## Measurement

```sh
python scripts/measure_zip.py --tracks 50 --mb 4 --jobs 2 --limit 2
```

Builds archives out of generated files — never SoundCloud — and prints packing
time, peak Python heap, peak scratch space, how the `MAX_CONCURRENT_ZIP_JOBS`
cap queues jobs, and how fast a finished archive streams. `--out report.txt`
keeps the numbers. It exits non-zero if any temporary directory survives the run.
