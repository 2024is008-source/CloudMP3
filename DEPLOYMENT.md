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

Nothing in `src/` was restructured by that change: routing, the SoundCloud client and the
downloader UI stayed as they were. This deployment change adds no UI code and removes
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

| Variable                       | When read                    | Where to set it                                            | Value                            |
| ------------------------------ | ---------------------------- | ---------------------------------------------------------- | -------------------------------- |
| `VITE_SITE_ORIGIN`             | build time (inlined by Vite) | `.env.production` on the VPS                               | `https://cloudmp3.site`          |
| `HOST`                         | runtime                      | `deploy/ecosystem.config.cjs`                              | `127.0.0.1`                      |
| `PORT`                         | runtime                      | `deploy/ecosystem.config.cjs`                              | `3000` (must match `proxy_pass`) |
| `NODE_ENV`                     | runtime                      | set by the ecosystem file                                  | `production`                     |
| `CLOUDMP3_SERVICE_URL`         | runtime                      | shell before `pm2 start` (optional)                        | e.g. `http://127.0.0.1:8090`     |
| `CLOUDMP3_SERVICE_KEY`         | runtime                      | shell before `pm2 start` (optional)                        | same secret as `backend/.env`    |
| `CLOUDMP3_ALLOWED_MEDIA_HOSTS` | runtime, read per request    | shell before `pm2 start` **and** `backend/.env` (optional) | e.g. `cdn.example.net`           |

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
- `CLOUDMP3_ALLOWED_MEDIA_HOSTS` is optional and only ever **widens** the audio host allowlist
  (`sndcdn.com`, `soundcloud.com`, `soundcloud.cloud` are always allowed). Both outbound guards
  read it per request — `src/lib/url-guard.ts` in the Node server, `backend/net_guard.py` in the
  audio service — so it must be set in each process you run; a browser has no `process.env` and
  keeps the shipped list. Set it if a SoundCloud redirect lands somewhere outside those three
  domains, which is the one way this policy can refuse a legitimate download.

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
   (this app's only images are favicons and one PNG social card, none of them worth resizing).
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
one vhost file and two `cloudmp3*`-prefixed snippets, and the `server_name` values
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
# 1. install the config files (note the rename: the vhost includes
#    snippets/cloudmp3-site.conf, not the shipped snippet- prefixed filename)
sudo mkdir -p /etc/nginx/snippets
sudo cp deploy/nginx/cloudmp3.site.conf /etc/nginx/conf.d/
sudo cp deploy/nginx/snippet-cloudmp3-site.conf /etc/nginx/snippets/cloudmp3-site.conf
sudo cp deploy/nginx/snippet-cloudmp3-headers.conf /etc/nginx/snippets/cloudmp3-headers.conf

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

The last two must also show the four security headers. Check them on an error page as
well, since those are produced by nginx rather than the app:

```sh
curl -sI https://127.0.0.1/.git/config -H "Host: cloudmp3.site" -k   # 403 + X-Content-Type-Options: nosniff
```

### Security headers, HSTS and CSP

Three kinds of reply exist, and each has to carry the headers on its own:

| Reply                                                                                                             | Where the headers come from                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Anything the Node app serves through `location /` or `/api/`                                                      | Both: `routeRules` in `vite.config.ts` and `snippet-cloudmp3-headers.conf`. The app's copy is the safety net if a response ever bypasses this vhost.                                                         |
| A static file from `location /assets/` or the icon paths                                                          | nginx only, and only because those two locations `include snippets/cloudmp3-headers.conf` — they declare their own `Cache-Control`, and `add_header` replaces the inherited set rather than merging into it. |
| A 403 from the dotfile rule, a 413 from `client_max_body_size`, a 429 from `limit_req`, a 502/504 from a dead app | nginx only. These never reach the app, which is why every directive in the snippet carries `always`; without it nginx attaches headers to 2xx/3xx only.                                                      |

`server_tokens off` and the snippet are included in **both** `server` blocks: the port-80
one is not purely a redirector, because a Cloudflare Flexible request arrives over plain
HTTP with a browser-facing scheme of HTTPS and falls through to the shared locations.

**HSTS stays commented out** until the site is actually serving traffic. A browser that
caches the policy cannot be talked out of it, so turning it on before TLS is proven locks
everyone out of a domain you still need to repair. The four conditions for enabling it, and
why the value lives only in nginx, are listed in `deploy/nginx/snippet-cloudmp3-headers.conf`.
Neither nginx nor the app sets it today, so there is exactly one place to change.

**No Content-Security-Policy is shipped, deliberately.** This app runs a Google Analytics
`gtag.js` script, TanStack Start's inlined SSR bootstrapping, and `@breezystack/lamejs` as a
worker; a `script-src` strict enough to be worth having needs `'unsafe-inline'` or nonces for
the inline bootstraps and `'unsafe-eval'`/`worker-src` entries for the encoder, and getting it
wrong turns a working converter into a blank page with console errors that look like a bug in
the app. A correct CSP here is a build-time task: enumerate the origins from the production
HTML, write the policy, serve it with `Content-Security-Policy-Report-Only` for a week, and
only then enforce. That has not been done, so it is not claimed. The `X-Frame-Options: DENY`,
`nosniff` and `Permissions-Policy` headers already block the clickjacking and capability
abuse a CSP would otherwise be there to catch.

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
  Two routes can legitimately exceed it, because neither answers until the work is finished:
  the Python service's conversions (`YTDLP_TIMEOUT`/`FFMPEG_TIMEOUT` keep those modest) and
  `POST /api/public/zip`, whose archive is complete before the first byte and whose build time
  is dominated by fetching each track rather than by packing (packing 200 MB of already-downloaded
  audio measured 1.9 s; the fetches are what add up). If playlist ZIPs matter to you, lower
  `MAX_ZIP_TRACKS` to a number that reliably builds inside ~100 s, or move the API to a
  subdomain that is DNS-only (grey cloud). Behind a grey-cloud record the shipped
  `proxy_read_timeout` of 2100 s is what applies: it sits above `ZIP_JOB_TIMEOUT_SECONDS`
  (1800 s) on purpose, so a job that overruns is answered by the service's own 504 with a
  code, not by nginx closing a silent connection.
- **Free-plan caching:** audio is not cached at the edge by default, so every download is a
  real request to your VPS. Bandwidth, not CPU, is usually what runs out on a Contabo box.
- **Uploads:** the only request body this app sends is JSON — a ZIP posts its track list, not
  its audio — so the 25/100/500 MB plan upload limits are irrelevant here.
- **Web Analytics / Speed:** the app loads one third-party script, the Google tag (`gtag.js`)
  for Analytics 4, injected on the client after the page is interactive. Nothing to configure
  at the edge; if you enable Cloudflare's own Bot Analytics or Security level changes, note that
  a managed challenge on `/api/public/*` would break downloads, because those requests come from
  `fetch()`, not from a browser navigation.

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
- `GET /track/12345` → 200. An available track self-canonicalises to
  `https://cloudmp3.site/track/12345` and stays indexable; an unavailable one answers
  `noindex, follow` with the canonical pointed at the homepage (see `head()` in
  `src/routes/track.$id.tsx`). Track pages are deliberately absent from `sitemap.xml`.
- `GET /robots.txt` → `Sitemap: https://cloudmp3.site/sitemap.xml`; `Disallow: /api/` present.
- `GET /sitemap.xml` → 7 URLs, all on the production origin, with `lastmod`.
- `GET /og/default.png` → 200 `image/png`; `GET /assets/<hash>.js` → 200 with the app's own
  `cache-control: public, max-age=31536000, immutable` (Nginx re-asserts it, it does not add it).
- `GET /favicon.ico` → 200 `image/vnd.microsoft.icon` — a real 16/32/48 multi-size icon, built
  once from `favicon.svg` with ImageMagick and now served from `public/` like the other icons.
- `GET /api/public/track?id=0` → 400, `GET /api/public/preview?id=0` → 400 (validation, no upstream call).
- `GET /api/public/formats?id=123` → 200 with `service-unconfigured`, proving the optional
  backend degrades honestly instead of pretending.
- `GET /unknown-route` → 404.
- Security headers: the built Node server itself answers `/` and `/assets/<hash>.js` with
  `x-content-type-options: nosniff`, `referrer-policy: strict-origin-when-cross-origin`,
  `x-frame-options: DENY` and the `permissions-policy` above, so a response that never reaches
  the Nginx vhost — a preview port, a tunnel, a half-configured proxy — still carries them.
  Declared once in `vite.config.ts` and re-asserted by `deploy/nginx/snippet-cloudmp3-headers.conf`.
- Header spoofing: `Host: evil.example` and `X-Forwarded-Proto: http` do not change the
  emitted canonical or `og:url` — they stay on the production origin, because the app builds
  them only from `VITE_SITE_ORIGIN`.
- `npm run lint` (files touched by this change), `tsc --noEmit`, `npm run test` (147 passed),
  `npm run build` and `python -m pytest -q` in `backend/` (79 passed) — re-run after every change
  above, including the SEO fixes; outcomes are below.

**Not verified here, and requiring the VPS:** `nginx -t` (no Nginx on this machine), the
actual `pm2 start`/`pm2 startup` behaviour, Cloudflare's edge behaviour, TLS handshake with
the origin certificate, and any real end-to-end download. The Nginx and PM2 files are written
to be checked by those tools on the server before reload; `deploy/ecosystem.config.cjs` was
loaded with `node -e "require(...)"` to confirm it parses and resolves the log paths.

Re-verified on 2026-11-04 after the outbound-host work (§11): `python -m pytest -q` in `backend/`
→ 129 passed, `npx vitest run` → 199 passed across 15 files, `npx tsc --noEmit` → no output,
`npm run build` → built, and `npx eslint` on the changed TypeScript files → only the 17
pre-existing `no-explicit-any` errors in `src/lib/soundcloud.server.ts` (the same 16 `any`
usages exist at `HEAD`). Every guard test runs against a stubbed transport and resolver: the
redirect behaviour of a real `sndcdn` stream was **not** exercised, because this project's
testing rules exclude live downloads of any size.

Note on `npm run lint`: measured again on 2026-11-03 it exits non-zero on 4850 problems
(4843 errors, 7 warnings) across the repo, none of them caused by this work. 4817 of those errors
are Prettier's CRLF complaints: the working tree has a mix of CRLF and LF sources and there is no
`.gitattributes`, so every line of a CRLF file is reported. Only 33 are Prettier line-wrapping, and
the remaining 24 are substantive-adjacent — 17 `@typescript-eslint/no-explicit-any`,
6 `react-refresh/only-export-components` and 1 `react-hooks/exhaustive-deps`. Adding a
`.gitattributes` with `* text=auto eol=lf` would clear the CRLF noise at once; that is deliberately
not done here because it rewrites every file in one commit.
Files added or edited for the deployment and SEO work are LF and lint clean.

---

## 11. Known gaps worth closing after launch

- `support@cloudmp3.site` and `dmca@cloudmp3.site` appear in the footer, contact page and
  `Organization` JSON-LD. They are only reachable once you create those mailboxes (Cloudflare
  Email Routing to a real inbox is enough). A DMCA address that bounces is a legal liability,
  not a cosmetic issue.
- uvicorn runs with `--forwarded-allow-ips '*'`. Harmless while the service stays on loopback
  (`backend/docker-compose.yml` publishes `127.0.0.1:8090`); tighten it if that ever changes.
- Media fetches are guarded on **every** hop, not only the URL handed to them.
  `backend/net_guard.py` and `src/lib/url-guard.server.ts` apply the same four checks — https
  with no credentials and no port other than 443, hostname on the approved SoundCloud list,
  every DNS answer globally routable (so no loopback, private, link-local, CGNAT, multicast or
  reserved address), and the first three re-checked at each redirect — with the redirect chain
  capped at 4 hops. HLS playlists are parsed here and each variant, init and media segment is
  checked before it is fetched, so FFmpeg never receives a remote address at all
  (`backend/stream.py:180` stages through the guarded client, `src/lib/soundcloud.server.ts`
  `collectSegments` does the same in Node). The service-to-service call in
  `src/lib/original.server.ts` refuses redirects outright, because undici re-sends
  `X-Api-Key` to whatever `Location` names. `backend/tests/test_net_guard.py` and
  `src/test/url-guard.test.ts` drive the real clients with only the transport and the resolver
  stubbed, so a blocked test proves the address was **never** asked for, not merely refused.
  **DNS rebinding is not solved by any of this.** The guards check the name before resolution
  and every address the name answers, then reuse that answer for 60 s, which shortens the
  window a flapping name can exploit; they cannot make the checked address and the connected
  address the same one, because httpx and undici resolve again inside their own transports.
  Closing that gap needs IP pinning (connect to the validated address with the original
  `Host`/SNI), which is not implemented. What bounds the damage instead is that the
  allowlist is the primary control: a name on it is one SoundCloud controls, and the address
  gate refuses a listed name that has been pointed at `127.0.0.1`, `169.254.169.254` or a
  private range. Visitor-supplied URLs never reach these fetchers — every address comes from a
  SoundCloud API response — and the one place a browser does the fetching (artwork in
  `src/lib/id3.ts`) is shape-checked only, since a cross-origin redirect is opaque there and a
  wrong answer is a missing cover image, not an internal port.
- The GA4 property needs the custom dimensions and metrics listed in §12 before the download
  events say anything; the tag sends the parameters, GA4 does not invent the definitions.

### Dependency advisories

`npm audit` on 2026-11-03 reports 16 vulnerabilities, 14 moderate and 2 high.

The 14 moderate ones are all in the dev toolchain (`eslint` and its `minimatch`, plus
`vite`'s dev-server advisories through `launch-editor` and `server.fs.allow`). None of that
code is in `.output/`, so a deployed visitor cannot reach it. They are not fixable without a
breaking major of a dev dependency, so they are left for the normal toolchain update.

The high one that matters is **GHSA-mrhx-c7xc-m3w5 — `zod < 4.6.6` exhausts memory validating
an oversized constrained collection**. Assessed against this app:

- **Path:** `cloudmp3 > zod@3.25.76`, and `@hookform/resolvers@5.9.2` resolves to the same copy
  (deduped). TanStack Start's own tooling already depends on `zod@4.6.7`, but that copy is used
  by `@tanstack/start-plugin-core` at build time, not by the app's runtime schemas — so having
  the fixed version in `node_modules` does not protect anything here.
- **Reachability: yes.** `zipRequestSchema` (`src/lib/zip-request.ts:65`) parses a body a visitor
  controls, on the public `POST /api/public/zip`, before any service call, and zod is in the
  deployed artifact (the build emits `.output/server/_libs/zod.mjs`, 100 kB). Its `tracks` field is
  `z.array(...).min(1)` with **no `.max()`**, which is exactly the shape the advisory describes:
  zod 3 builds a result object for every element first and only then applies a length constraint.
- **Is it mitigated? Yes, and the mitigation is the one the fix would give.** Three limits sit in
  front of the parse, in this order (`src/routes/api/public/zip.ts:53-71`):
  1. `readZipBody` counts bytes as the stream is read and cancels the reader past
     `ZIP_BODY_MAX_BYTES` (1 MiB), answering 413 — the body itself cannot be arbitrarily large.
     Nginx enforces the same ceiling independently with `client_max_body_size 1m`.
  2. `tooManyTracks` rejects a `tracks` array longer than `ZIP_TRACKS_MAX` (500) by reading
     `.length`, so the cost does not depend on what is inside the array.
  3. Only then does zod see the payload — at most 500 small objects.
     A non-array `tracks` is rejected by zod's own type check without iterating anything, so there
     is no path where zod walks an unbounded collection. Measured earlier with a synthetic 20k-track
     body (the size ceiling allows roughly that many minimal elements): ~95 ms in zod, ~10 ms in
     `JSON.parse`, ~30 MB retained — uncomfortable, not fatal, and unreachable at 500.
- **Other schemas surveyed.** Five files import zod. `src/lib/sc.functions.ts` and
  `src/routes/contact.tsx` validate only bounded scalars (`.max()` on every string, `.max(50)` on
  the search limit) and contain no `.array()`. The two `z.array(...)` in
  `src/lib/original.server.ts:47,54` parse the _audio service's_ response, not visitor input, and
  that response is bounded by our own backend. `zipRequestSchema` is the only place a
  visitor-controlled array reaches zod.
- **Verdict: not a launch blocker.** The request limits already bound the vulnerable operation to
  a workload two orders of magnitude below what the advisory describes.

The migration is deliberately **separate, not part of this fix pass** — v3 to v4 is a major with
breaking changes in `.refine()`, default/optional inference and error-issue shapes, all three of
which this schema uses. The plan, when it is scheduled:

1. Read zod's official v3→v4 migration guide and note the changes touching `zipRequestSchema`
   (`z.enum(...).default()`, `.refine()` on an optional number, `z.infer` of an optional string
   with `.trim().max()`).
2. Confirm `@hookform/resolvers@5.9.2` supports v4 (it does from 5.x, but verify against the
   installed copy) and that no TanStack Start runtime validation is expecting a v3 error shape.
3. Land it as one isolated commit that changes only `package.json` and the five files that
   import zod — `src/lib/zip-request.ts`, `src/lib/original.server.ts`, `src/lib/sc.functions.ts`,
   `src/routes/contact.tsx` and `src/routes/index.tsx` — so reverting is one step.
4. Extend `src/test/zip-request.test.ts` with an oversized-array case asserting the 500 guard
   fires before zod, and a deep-nesting case, then run `tsc --noEmit`, `npm run test`,
   `npm run build` and check `npm audit` reports the advisory gone.
5. Do not run `npm audit fix --force`: it moves `vite` outside the declared range as well, which
   would be a second major in the same commit.

---

## 12. GA4 configuration (manual, in the Analytics property)

The tag is already installed (`G-RZVEMQ51PX`, `send_page_view: false`, one `page_view` per
page from the router). What follows is what to register in **Admin → Custom definitions** so
the parameters in `src/lib/analytics.ts` become reportable dimensions and metrics. GA4
accepts 50 of each on a standard property; this list is 18 and 9.

Event-scoped **custom dimensions** (all are registered as text; scope: Event):

| Parameter          | Display name        | Values it will see                                                     |
| ------------------ | ------------------- | ---------------------------------------------------------------------- |
| `download_kind`    | Download kind       | `single`, `batch`, `zip`                                               |
| `file_format`      | File format         | `aac`, `mp3`, `wav`, `ogg`, `flac`, `zip`, `other`                     |
| `content_format`   | Archive content     | same enum: what is packed inside a ZIP                                 |
| `download_method`  | Bytes produced by   | `direct` (authorized stream), `browser`, `server`                      |
| `error_type`       | Failure code        | the stable codes in `ErrorType`, e.g. `not_downloadable`, `over_limit` |
| `search_source`    | Search origin       | `header`, `search_page`, `link_box`                                    |
| `search_tab`       | Search tab          | the tab names on `/search`                                             |
| `search_term`      | Search term         | visitor-typed text, truncated to 60 characters                         |
| `link_type`        | Pasted link kind    | `track`, `playlist`, `profile`, `invalid`                              |
| `result_kind`      | Result kind opened  | `track`, `playlist`, `profile`                                         |
| `result_from`      | Result opened from  | `header`, `search_page`, `related`                                     |
| `selection_action` | Selection action    | `select_all`, `clear`, `filter`                                        |
| `page`             | Page label          | `track`, `playlist`, and the CTA's own page name                       |
| `cta_label`        | Button label        | the label as written on the page                                       |
| `faq_page`         | FAQ page            | `home`, `faq`                                                          |
| `link_host`        | External link host  | hostname only — never the full URL                                     |
| `link_label`       | External link label | the link's own text                                                    |
| `error_stage`      | Failure stage       | `metadata`, `formats`, `availability`, `search`, `zip`, `playlist`     |

Event-scoped **custom metrics** (unit as noted):

| Parameter         | Display name       | Unit         |
| ----------------- | ------------------ | ------------ |
| `bitrate`         | Bitrate (kbps)     | `128`–`320`  |
| `track_count`     | Tracks in job      | integer      |
| `failed_tracks`   | Tracks not packed  | integer      |
| `file_size_bytes` | File size          | bytes        |
| `elapsed_ms`      | Elapsed            | milliseconds |
| `conversion_ms`   | Encode time        | milliseconds |
| `server_wait_ms`  | Server wait        | milliseconds |
| `result_count`    | Results returned   | integer      |
| `question_index`  | FAQ question index | integer      |

`page_view` uses GA4's own `page_location`, `page_path`, `page_title` and `page_referrer`,
which need no definitions; `page_location` and `page_path` are deliberately sent without a
query string, so `/search?q=anything` reports as `/search` and refined searches do not each
count as a new page.

Two settings to confirm while you are in Admin:

- **Data retention** (Admin → Data Settings → Data Retention): 14 months is enough for this
  site and limits how long `search_term` text is kept.
- **Enhanced measurement**: leave it off, or at least switch off its outbound-click and
  scroll events. The app already reports `external_link_clicked` (host only) and its own
  `page_view`, and Google's auto-collected version would double-count both.

No event carries a track title, an artist name, a SoundCloud URL, a token or an email
address. If that ever changes, the parameter needs a definition above before it ships.
