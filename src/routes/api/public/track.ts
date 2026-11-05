import { createFileRoute } from "@tanstack/react-router";

// Public proxy: only streams SoundCloud audio for a numeric track id.
export const Route = createFileRoute("/api/public/track")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const sp = new URL(request.url).searchParams;
        const id = Number(sp.get("id"));
        const quality = sp.get("q") === "low" ? "low" : "high";
        const mode = sp.get("mode");
        const bitrate = Number(sp.get("bitrate"));
        if (!Number.isInteger(id) || id <= 0) return new Response("Bad id", { status: 400 });

        if (mode === "original" || mode === "wav") {
          const { proxyServiceDownload } = await import("@/lib/original.server");
          return proxyServiceDownload(id, mode, quality, request.signal);
        }

        if (mode === "mp3") {
          const { proxyServiceDownload } = await import("@/lib/original.server");
          return proxyServiceDownload(id, "mp3", quality, request.signal, bitrate || undefined);
        }

        const { getStreamUrl, hlsStream } = await import("@/lib/soundcloud.server");
        const { guardedFetch } = await import("@/lib/url-guard.server");
        try {
          const s = await getStreamUrl(id, quality);
          const name = `${s.artist} - ${s.title}.${s.ext}`.replace(/[\\/:*?"<>|]/g, "_");
          const headers: Record<string, string> = {
            "Content-Type": s.mime,
            "Content-Disposition": `attachment; filename="track.${s.ext}"; filename*=UTF-8''${encodeURIComponent(name)}`,
            "X-File-Ext": s.ext,
            "X-Audio-Codec": s.codec,
            "X-Audio-Bitrate": String(s.bitrate),
          };
          // HLS responses have no Content-Length; the estimate lets the client
          // show byte progress that still reflects the real transfer.
          if (s.estimatedBytes > 0) headers["X-Total-Bytes"] = String(s.estimatedBytes);
          if (s.hls) return new Response(await hlsStream(s.url), { headers });
          const audio = await guardedFetch(s.url);
          if (!audio.ok || !audio.body) return new Response("Stream failed", { status: 502 });
          return new Response(audio.body, { headers });
        } catch (e) {
          // What SoundCloud or our own lookup threw is for the server log only:
          // a message like "Could not obtain SoundCloud client id" describes how
          // this site works, not what a visitor should read.
          console.error(`[track] stream for ${id} failed:`, e);
          const refused = /not authorized|download|preview/i.test(
            e instanceof Error ? e.message : "",
          );
          return new Response(
            refused
              ? "This track isn't available for download."
              : "SoundCloud didn't accept this request.",
            { status: refused ? 403 : 400 },
          );
        }
      },
    },
  },
});
