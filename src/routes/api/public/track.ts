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
        if (!Number.isInteger(id) || id <= 0) return new Response("Bad id", { status: 400 });

        if (mode === "original" || mode === "wav") {
          const { proxyServiceDownload } = await import("@/lib/original.server");
          return proxyServiceDownload(id, mode, quality);
        }

        const { getStreamUrl, hlsStream } = await import("@/lib/soundcloud.server");
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
          const audio = await fetch(s.url);
          if (!audio.ok || !audio.body) return new Response("Stream failed", { status: 502 });
          return new Response(audio.body, { headers });
        } catch (e) {
          return new Response(e instanceof Error ? e.message : "Error", { status: 400 });
        }
      },
    },
  },
});
