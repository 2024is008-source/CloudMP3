import { createFileRoute } from "@tanstack/react-router";

// Real format availability for one track. Never guesses the original upload.
export const Route = createFileRoute("/api/public/formats")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const id = Number(new URL(request.url).searchParams.get("id"));
        if (!Number.isInteger(id) || id <= 0) return new Response("Bad id", { status: 400 });
        const { getTrackFormats } = await import("@/lib/original.server");
        const formats = await getTrackFormats(id);
        return Response.json(formats, {
          headers: { "Cache-Control": "private, max-age=120", "X-Robots-Tag": "noindex" },
        });
      },
    },
  },
});
