## Architecture
- SoundCloud access is reimplemented in TypeScript (src/lib/soundcloud.server.ts) following scdl's client_id + api-v2 approach, because Python/FFmpeg cannot run on the Worker runtime; ZIPs are built in the browser.
