# Deploying CloudMP3 to cloudmp3.site

Target: **Contabo VPS** (Ubuntu) · **Nginx** reverse proxy · **PM2** process manager ·
**Cloudflare** DNS + proxy · **Namecheap** registrar.

The app is a TanStack Start server: one Node process renders HTML and serves `/api/*`,
and Nginx is the only thing that should hold port 80/443.

---

## 1. What changed in the project

| Item                 | Before                                                                                         | Now                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Build target         | `nitro({ defaultPreset: "cloudflare-module" })` → a Cloudflare Worker bundle (`wrangler.json`) | `nitro({ defaultPreset: "node-server" })` → `.output/server/index.mjs`, a plain Node HTTP server            |
| Environment examples | none at the repo root                                                                          | `.env.example` (dev) and `.env.production.example` (build-time)                                             |
| `.gitignore`         | ignored `.dev.vars` and `*.local` only                                                         | also ignores `.env` / `.env*`, keeping the two examples tracked                                             |
| Deploy config        | none                                                                                           | `deploy/nginx/cloudmp3.site.conf`, `deploy/nginx/snippet-cloudmp3-site.conf`, `deploy/ecosystem.config.cjs` |

Nothing in `src/` was restructured: routing, the SoundCloud client, the downloader UI and
the browser-side ZIP work are untouched. This deployment change adds no UI code and removes
none — it moves the packaging target, nothing else.

**Why the preset mattered:** a `cloudflare-module` build is a Worker bundle. It cannot be
started by PM2 on Ubuntu, so this was the one blocking change. Verified: the custom server
entry (`src/server.ts`, the SSR error wrapper) is still used — the generated
`.output/server/index.mjs` calls `mod.fetch(req)` on it, and the wrapper's marker string is
present in the built SSR chunk.

---

## 2. Variables

Two different mechanisms read configuration, and mixing them up is the usual cause of
"the env var is set but nothing changed".

| Variable               | When read                    | Where to set it                     | Value                            |
| ---------------------- | ---------------------------- | ----------------------------------- | -------------------------------- |
| `VITE_SITE_ORIGIN`     | build time (inlined by Vite) | `.env.production` on the VPS        | `https://cloudmp3.site`          |
| `HOST`                 | runtime                      | `deploy/ecosystem.config.cjs`       | `127.0.0.1`                      |
| `PORT`                 | runtime                      | `deploy/ecosystem.config.cjs`       | `3000` (must match `proxy_pass`) |
| `NODE_ENV`             | runtime                      | set by the ecosystem file           | `production`                     |
| `CLOUDMP3_SERVICE_URL` | runtime                      | shell before `pm2 start` (optional) | e.g. `http://127.0.0.1:8090`     |
| `CLOUDMP3_SERVICE_KEY` | runtime                      | shell before `pm2 start` (optional) | same secret as `backend/.env`    |

Rules that follow from this split:

- `VITE_*` is baked into the bundle at build time. Changing it needs a **rebuild**, not a restart.
- Non-`VITE_*` values are read from the real process environment. Vite's `loadEnv` does **not**
  export them, so putting `CLOUDMP3_SERVICE_KEY` in `.env.production` does nothing — it must be
  in the environment PM2 inherits. PM2 snapshots env at start; after changing it run
  `pm2 restart cloudmp3 --update-env`.
- Only `https://` origins are honoured by `src/lib/site.ts`; anything else silently falls back
  to `https://cloudmp3.site`. That is intentional (a dev host can never leak a foreign
  canonical into production), but it also means you cannot preview `http://` canonicals.
- `CLOUDMP3_SERVICE_URL` / `CLOUDMP3_SERVICE_KEY` are optional. Unset, the site offers
  SoundCloud's authorized stream plus browser conversions and reports originals as
  unavailable. Do not set them unless `backend/` is actually running.

No secrets belong in the repository. `.env*` is now gitignored; keep the real key in
`backend/.env` (already ignored) and in the shell that starts PM2.

---

## 3. Namecheap (one-time)

1. **Domain list** → `cloudmp3.site` → **Manage** → **Nameservers**.
2. Choose **Custom DNS** and enter the two nameservers Cloudflare shows you when the domain
   is added (they look like `*.ns.cloudflare.com`).
3. Save. Propagation usually takes minutes, up to 48 h. In Cloudflare the site status flips
   from _Pending_ to **Active**.
4. Leave **Domain Shield / WhoisGuard** as you prefer — it does not affect DNS.

Do not add A records at Namecheap. Once Cloudflare is authoritative, records made there are ignored.

---

## 4. Cloudflare (one-time)

1. **Add a site** → `cloudmp3.site` → Free plan is enough → Cloudflare scans and imports records.
2. DNS records to end up with (proxy status is the part that matters):

   | Type  | Name                                                 | Content                           | Proxy                      |
   | ----- | ---------------------------------------------------- | --------------------------------- | -------------------------- |
   | A     | `cloudmp3.site`                                      | your VPS IPv4                     | **Proxied** (orange cloud) |
   | AAAA  | `cloudmp3.site`                                      | your VPS IPv6, if the VPS has one | Proxied                    |
   | CNAME | `www`                                                | `cloudmp3.site`                   | Proxied                    |
   | A     | any subdomain you already run (e.g. `panel`, `mail`) | its own host                      | leave as it is             |

   `www` must be a **CNAME to the apex**, not a second A record, so it inherits the same proxy
   state. Delete any stray `A www` the import created.

3. **SSL/TLS → Edge certificates → mode = Full (strict).**
   _Flexible_ also works with this Nginx config (the redirect logic is loop-safe in both
   modes) but it talks plain HTTP to your VPS. _Full (strict)_ requires the origin certificate
   from step 4 and is the setting to leave in place.
4. **SSL/TLS → Origin Server → Create Certificate** → default 15-year option, CSR generated
   locally:

   ```sh
   openssl req -new -newkey rsa:2048 -nodes \
     -keyout cloudmp3.site.key -out cloudmp3.site.csr \
     -subj "/CN=cloudmp3.site/O=CloudMP3" -addext "subjectAltName=DNS:cloudmp3.site,DNS:www.cloudmp3.site"
   ```

   Paste the CSR, download the **Origin Certificate** and the **Private Key**, then copy both to
   the VPS:

   ```sh
   sudo mkdir -p /etc/ssl/cloudmp3.site
   sudo cp cloudmp3.site.pem /etc/ssl/cloudmp3.site/cloudmp3.site.crt
   sudo cp cloudmp3.site.key  /etc/ssl/cloudmp3.site/cloudmp3.site.key
   sudo chmod 600 /etc/ssl/cloudmp3.site/cloudmp3.site.key
   ```

   This certificate is only trusted by Cloudflare, not by browsers — that is correct, because
   Cloudflare terminates TLS for visitors. Do **not** use your own Let's Encrypt HTTP-01
   renewal against a proxied domain unless you also keep port 80 serving the ACME challenge.

5. **Speed → Optimization → Compression**: keep Brotli/Gzip on; **Polish / image resizes off**
   (this app's only images are an SVG favicon and one PNG social card).
6. **Do not create a "Cache Everything" page rule.** `/api/public/*` returns per-request audio
   streams and `/robots.txt`, `/sitemap.xml` must reflect the deployed origin. Default caching
   is what you want; `/assets/*` already ships `max-age=31536000, immutable`.
7. **Network → Turnstile / Bot Fight Mode**: leave default. Bot Fight Mode can challenge the
   parallel `/api/public/track` fetches a real downloader makes — if downloads start failing
   with 403/503 while Nginx logs nothing, check there first.

### Protect the origin

The Nginx config trusts `X-Forwarded-Proto` and `CF-Connecting-IP`. That trust is only sound
if nothing but Cloudflare can reach the VPS. On the VPS:

```sh
sudo ufw default deny incoming
sudo ufw allow 22/tcp
# one line per Cloudflare range, IPv4 (https://www.cloudflare.com/ips/):
for r in 173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 \
         108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 \
         162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22; do
  sudo ufw allow from "$r" to any port 80,443 proto tcp
done
sudo ufw enable && sudo ufw status numbered
```

Keep 3000 (and 8090 if you run `backend/`) unexposed: the app binds `127.0.0.1` and the
Python service should be published as `127.0.0.1:8090:8080` only.

---

## 5. VPS: first-time setup

Assumptions to confirm before running anything: where you will put the repo (`/srv/cloudmp3`
below) and what already listens on 80/443. **If the VPS already hosts other sites, do not
replace `/etc/nginx/nginx.conf` or delete existing files in `conf.d/`** — this project ships
one vhost file plus one snippet, both namespaced to `cloudmp3*`, and the `server_name` values
mean requests for other hosts keep going to their own vhosts.

```sh
# runtime + tooling (Ubuntu 22.04/24.04)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs nginx git
sudo npm install -g pm2

# service user + app directory
sudo mkdir -p /srv/cloudmp3 && sudo chown -R $USER:$USER /srv/cloudmp3
cd /srv/cloudmp3
git clone <your-repository-url> .        # or rsync from Windows, see §7

# build-time origin, then install and build
cp .env.production.example .env.production
npm ci
npm run build                            # emits .output/server/index.mjs + .output/public
mkdir -p logs
```

Node 22 (or 24) is required: the server uses global `fetch`, `AbortSignal` and
`ReadableStream`, and the build pins Vite 8.

---

## 6. Nginx + PM2

```sh
# 1. install the two config files (note the rename: the vhost includes
#    snippets/cloudmp3-site.conf, not the shipped snippet- prefixed filename)
sudo mkdir -p /etc/nginx/snippets
sudo cp deploy/nginx/cloudmp3.site.conf /etc/nginx/conf.d/
sudo cp deploy/nginx/snippet-cloudmp3-site.conf /etc/nginx/snippets/cloudmp3-site.conf

# 2. edit the three placeholders in both files:
#    /srv/cloudmp3      -> the path you actually used in §5
#    /etc/ssl/cloudmp3.site/* -> the origin certificate paths from §4
#    3000               -> PORT in deploy/ecosystem.config.cjs

sudo nginx -t                              # must say "syntax is ok" before continuing
sudo systemctl reload nginx

# 3. start the app
export CLOUDMP3_SERVICE_URL=   # leave empty unless backend/ runs here
export CLOUDMP3_SERVICE_KEY=
pm2 start deploy/ecosystem.config.cjs
pm2 logs cloudmp3 --lines 30       # expect "Listening on: http://127.0.0.1:3000/"

# 4. survive a reboot
pm2 save
pm2 startup systemd -u $USER --hp /home/$USER   # run the command it prints
```

Sanity check the proxy chain from the VPS itself, before involving Cloudflare:

```sh
curl -I  http://127.0.0.1/            -H "Host: cloudmp3.site"   # 301 -> https
curl -sI https://127.0.0.1/           -H "Host: www.cloudmp3.site" -k  # 301 -> apex
curl -sI https://127.0.0.1/robots.txt -H "Host: cloudmp3.site" -k      # 200
```

---

## 7. Deploying an update (repeatable)

```sh
cd /srv/cloudmp3
pm2 status                                   # confirm the app name
git pull --ff-only                           # or rsync from Windows, below
npm ci && npm run build
pm2 reload cloudmp3 || pm2 restart cloudmp3 --update-env
```

From Windows, if the repo is not on a git remote you can push the working tree instead —
this sends source only, the build still happens on the VPS:

```powershell
rsync -az --delete --exclude node_modules --exclude .output --exclude .git `
  --exclude logs --exclude .env --exclude .env.production `
  "./" ubuntu@YOUR_VPS_IP:/srv/cloudmp3/
```

`--exclude` for `.env*` is deliberate: the server's own values must never be overwritten by a
local copy. Rollback is `git checkout <previous-tag> && npm ci && npm run build && pm2 restart cloudmp3`;
the previous build stays in `.output` until the new one replaces it, so keep a copy of
`.output` (`cp -a .output .output.prev`) if you want a one-command rollback.

---

## 8. Verification checklist

Run these against the live site and compare with what was checked locally (§10).

| Check            | Command                                                            | Expected                                                        |
| ---------------- | ------------------------------------------------------------------ | --------------------------------------------------------------- |
| Canonical host   | `curl -sI https://www.cloudmp3.site/`                              | `301` → `https://cloudmp3.site/`                                |
| No redirect loop | `curl -sIL https://cloudmp3.site/`                                 | one hop, ends `200`, never bounces back to http                 |
| Canonical tag    | `curl -s https://cloudmp3.site/ \| grep -o 'rel="canonical"[^>]*'` | `href="https://cloudmp3.site"`                                  |
| Social card      | `curl -s https://cloudmp3.site/ \| grep -o 'og:url"[^>]*'`         | `content="https://cloudmp3.site"`                               |
| Sitemap          | `curl -s https://cloudmp3.site/sitemap.xml`                        | 7 `<loc>` entries, all `https://cloudmp3.site`                  |
| robots           | `curl -s https://cloudmp3.site/robots.txt`                         | `Sitemap: https://cloudmp3.site/sitemap.xml`, `Disallow: /api/` |
| Static cache     | `curl -sI https://cloudmp3.site/assets/<file>.js`                  | `max-age=31536000, immutable`                                   |
| Streaming        | start one track download in the browser                            | bytes arrive progressively; no full buffering stall             |
| No dev hosts     | `grep -r "localhost" .output \| head`                              | only library fallback strings, no config                        |
| Structured data  | paste a page into the Google Rich Results test                     | Organization / WebSite / FAQPage parse                          |

Then in Google: submit `https://cloudmp3.site/sitemap.xml` in Search Console and add
IndexNow or Bing Webmaster Tools if you want faster discovery.

---

## 9. Cloudflare limits that affect audio downloads

- **Response size:** Cloudflare does not cap proxied download size for a streaming response,
  but a single connection that stalls for too long is dropped. The app streams each track as
  HLS segments with an 8-segment window, so bytes keep flowing and this is rarely an issue.
- **Origin timeout:** Cloudflare waits ~100 s for the _first byte_ from the origin.
  `/api/public/track` starts sending as soon as the first segment arrives, well inside that.
  The Python service (original files, FFmpeg WAV) can take longer than 100 s to produce a
  first byte — if you enable it, keep `YTDLP_TIMEOUT`/`FFMPEG_TIMEOUT` modest or move those
  routes to a subdomain that is DNS-only (grey cloud).
- **Free-plan caching:** audio is not cached at the edge by default, so every download is a
  real request to your VPS. Bandwidth, not CPU, is usually what runs out on a Contabo box.
- **Uploads:** not used by this app (ZIPs are assembled in the browser), so the 25/100/500 MB
  plan upload limits are irrelevant here.
- **Web Analytics / Speed:** nothing to configure; the app has no third-party scripts.

---

## 10. What was verified locally, and what was not

Verified on Windows against a production build driven by a real `.env.production`
(`cp .env.production.example .env.production && npm run build`, then
`PORT=3100 HOST=127.0.0.1 NODE_ENV=production node .output/server/index.mjs` —
port 3000 was occupied by an unrelated local app, which does not affect the result):

- The `.env.production` file is picked up by `npm run build`: every URL below came
  from the file, not from a shell variable. The file was deleted again afterwards.
- The Node server boots and binds exactly the `HOST`/`PORT` PM2 will pass it.
- `GET /` → 200 HTML, `<title>` as written, `canonical`, `og:url`, `og:image` = `https://cloudmp3.site`.
- `GET /track/12345` → 200 with canonical `https://cloudmp3.site/` (track pages deliberately
  canonicalise to the homepage; they are parameter-driven).
- `GET /robots.txt` → `Sitemap: https://cloudmp3.site/sitemap.xml`; `Disallow: /api/` present.
- `GET /sitemap.xml` → 7 URLs, all on the production origin, with `lastmod`.
- `GET /og/default.png` → 200 `image/png`; `GET /assets/<hash>.js` → 200 with the app's own
  `cache-control: public, max-age=31536000, immutable` (Nginx re-asserts it, it does not add it).
- `GET /api/public/track?id=0` → 400, `GET /api/public/preview?id=0` → 400 (validation, no upstream call).
- `GET /api/public/formats?id=123` → 200 with `service-unconfigured`, proving the optional
  backend degrades honestly instead of pretending.
- `GET /unknown-route` → 404.
- Header spoofing: `Host: evil.example` and `X-Forwarded-Proto: http` do not change the
  emitted canonical or `og:url` — they stay on the production origin, because the app builds
  them only from `VITE_SITE_ORIGIN`.
- `npm run lint` (files touched by this change), `tsc --noEmit`, `npm run test` (53 passed),
  `npm run build` — all re-run after these files were added; the outcomes are above and below.

**Not verified here, and requiring the VPS:** `nginx -t` (no Nginx on this machine), the
actual `pm2 start`/`pm2 startup` behaviour, Cloudflare's edge behaviour, TLS handshake with
the origin certificate, and any real end-to-end download. The Nginx and PM2 files are written
to be checked by those tools on the server before reload; `deploy/ecosystem.config.cjs` was
loaded with `node -e "require(...)"` to confirm it parses and resolves the log paths.

Note on `npm run lint`: it exits non-zero on 78 pre-existing problems in 24 files that this
change does not touch (mostly Prettier line-wrapping in the copy pages and `src/lib/*`). Those
were already failing before the deployment work; the files added or edited for it are clean.

---

## 11. Known gaps worth closing after launch

- `__root.tsx` requests `/favicon.ico`, but `public/` ships only `favicon.svg`,
  `apple-touch-icon.png` and `og/default.png` — that request 404s. Add a real `.ico` or drop
  the link.
- `support@cloudmp3.site` and `dmca@cloudmp3.site` appear in the footer, contact page and
  `Organization` JSON-LD. They are only reachable once you create those mailboxes (Cloudflare
  Email Routing to a real inbox is enough). A DMCA address that bounces is a legal liability,
  not a cosmetic issue.
- No outbound fetch in `src/lib/soundcloud.server.ts` has a timeout. On a single PM2 process a
  hung SoundCloud request holds a socket open indefinitely; wrapping those `fetch` calls in
  `AbortSignal.timeout(...)` is the smallest hardening step.
- `backend/README.md` documents `GET /health` but `main.py` exposes `/api/health`.
- `backend/docker-compose.yml` publishes `8080:8080`, which collides with the app's Vite dev
  port and with the `127.0.0.1:8090` example in the root README. Publish it as
  `127.0.0.1:8090:8080` on the VPS.
- uvicorn runs with `--forwarded-allow-ips '*'`. Harmless while the service stays on loopback;
  tighten it if that ever changes.
