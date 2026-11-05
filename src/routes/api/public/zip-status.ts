import { createFileRoute } from "@tanstack/react-router";

const JOB_ID = /^[A-Za-z0-9_-]{16,64}$/;

// Public proxy: reports progress for one ZIP job by its unguessable random id.
export const Route = createFileRoute("/api/public/zip-status")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const id = new URL(request.url).searchParams.get("id") ?? "";
        if (!JOB_ID.test(id)) return new Response("Bad id", { status: 400 });
        const { proxyServiceZipStatus } = await import("@/lib/original.server");
        return proxyServiceZipStatus(id);
      },
    },
  },
});
