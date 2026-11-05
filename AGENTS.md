## Architecture

- SoundCloud access is reimplemented in TypeScript (src/lib/soundcloud.server.ts) following scdl's client_id + api-v2 approach, because the Node server does not carry Python/FFmpeg; originals, WAV, high-bitrate MP3 and ZIPs are produced by the FastAPI service in backend/ and streamed through the public API routes.
