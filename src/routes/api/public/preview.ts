import { createFileRoute } from "@tanstack/react-router";

// Inline SoundCloud preview stream for the track page audio player. Served
// from a buffered copy so the player gets a real duration and can seek.
export const Route = createFileRoute("/api/public/preview")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const id = Number(new URL(request.url).searchParams.get("id"));
        if (!Number.isInteger(id) || id <= 0) return new Response("Bad id", { status: 400 });
        const { getPreviewAudio } = await import("@/lib/soundcloud.server");
        try {
          const preview = await getPreviewAudio(id);
          const total = preview.data.byteLength;
          const headers = new Headers({
            "Content-Type": preview.mime,
            "Content-Disposition": "inline",
            "Cache-Control": "private, max-age=300",
            "Accept-Ranges": "bytes",
            "X-Preview-Snippet": preview.snippet ? "1" : "0",
          });

          const range = request.headers.get("range");
          const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
          if (match) {
            const [, from, to] = match;
            let start = from ? Number(from) : 0;
            let end = to ? Number(to) : total - 1;
            if (!from && to) {
              start = Math.max(0, total - Number(to));
              end = total - 1;
            }
            if (start >= total || start > end) {
              return new Response(null, {
                status: 416,
                headers: { "Content-Range": `bytes */${total}`, "Accept-Ranges": "bytes" },
              });
            }
            end = Math.min(end, total - 1);
            const body = preview.data.subarray(start, end + 1);
            headers.set("Content-Range", `bytes ${start}-${end}/${total}`);
            headers.set("Content-Length", String(body.byteLength));
            return new Response(body as unknown as BodyInit, { status: 206, headers });
          }

          headers.set("Content-Length", String(total));
          return new Response(preview.data as unknown as BodyInit, { status: 200, headers });
        } catch (e) {
          // The reason goes to the server log, not to the browser: an upstream
          // message can name a URL or a SoundCloud response we should not echo.
          console.error(`[preview] track ${id} failed:`, e);
          const refused = /not authorized/i.test(e instanceof Error ? e.message : "");
          return new Response(
            refused
              ? "This track isn't available for preview."
              : "SoundCloud has no preview for this track.",
            { status: refused ? 403 : 404 },
          );
        }
      },
    },
  },
});
