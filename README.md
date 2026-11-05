# CloudMP3

A SoundCloud track and playlist downloader: paste a link, pick a format, get a file or a ZIP.

## Development

You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```

Vite listens on port 8080.

| Script                            | Purpose                                               |
| --------------------------------- | ----------------------------------------------------- |
| `npm run dev`                     | Dev server with SSR.                                  |
| `npm run build`                   | Production build (nitro → Node server in `.output/`). |
| `npm run preview`                 | Preview the built output.                             |
| `npm run test`                    | Vitest suite.                                         |
| `npm run lint` / `npm run format` | ESLint / Prettier.                                    |

## Deploy

`npm run build` emits `.output/server/index.mjs` (a plain Node HTTP server) plus
`.output/public` (static assets). [DEPLOYMENT.md](./DEPLOYMENT.md) covers the
Nginx reverse proxy, PM2, Cloudflare and Namecheap steps for
`https://cloudmp3.site`.

## Site origin

Every canonical, `og:url`, sitemap `<loc>` and `robots.txt` `Sitemap:` line is built from one
value, so it has to match the host the app is actually served from.

| Variable           | Purpose                                                                                                                                                                                                                                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_SITE_ORIGIN` | Public origin of this deployment, e.g. `https://example.com`. Defaults to `https://cloudmp3.site` when unset — set it on any other host or every page will declare a foreign canonical. Vite inlines it, so it is a **build-time** value: put it in `.env.production` (copy `.env.production.example`), not in the PM2 environment. |

## Original-audio service (optional)

SoundCloud original artist uploads and FFmpeg WAV conversion run in a separate
Python service in [`backend/`](./backend/README.md) — the app is TypeScript and
those two tools are Python/FFmpeg processes. Without it, the site still works:
it offers SoundCloud's
authorized stream plus browser MP3/WAV conversions, and never claims an original
exists.

Read at server start from the process environment (PM2's `env`, or the shell you
launch the app from — Vite does not put non-`VITE_` variables into the bundle):

| Variable               | Purpose                                               |
| ---------------------- | ----------------------------------------------------- |
| `CLOUDMP3_SERVICE_URL` | Public URL of the Python service (no trailing slash). |
| `CLOUDMP3_SERVICE_KEY` | Shared secret the app sends as `X-Api-Key`.           |

The service itself needs `SOUNDCLOUD_CLIENT_ID`, `SOUNDCLOUD_CLIENT_SECRET` and a
one-time `SOUNDCLOUD_REFRESH_TOKEN` to read artist originals; see
[`backend/README.md`](./backend/README.md) for setup, token rotation and deployment.

Run both locally:

```sh
# terminal 1 — service
cd backend && .venv/Scripts/python -m uvicorn main:app --port 8090

# terminal 2 — app (vite listens on 8080)
CLOUDMP3_SERVICE_URL=http://127.0.0.1:8090 CLOUDMP3_SERVICE_KEY=... npm run dev
```
