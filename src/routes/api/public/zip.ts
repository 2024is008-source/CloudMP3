import { createFileRoute } from "@tanstack/react-router";

import {
  ZIP_BODY_MAX_BYTES,
  tooManyTracks,
  zipRequestReason,
  zipRequestSchema,
} from "@/lib/zip-request";

/**
 * Read a request body that nobody has vouched for.
 *
 * The declared length is checked first, but a chunked request has none, so the
 * stream itself is counted and closed the moment it passes the ceiling. Returns
 * null rather than a message: the caller knows which sentence to answer with.
 */
/** A request read for its body alone, which a test can hand over without a server. */
type ZipBodySource = {
  headers: { get(name: string): string | null };
  body: ReadableStream | null;
};

export async function readZipBody(request: ZipBodySource): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > ZIP_BODY_MAX_BYTES) return null;

  const body = request.body;
  if (!body) return "";

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value?.byteLength ?? 0;
    if (bytes > ZIP_BODY_MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

// Public proxy: forwards a ZIP job to the audio service, which packs the
// archive. Nothing is assembled here, and only validated track ids go through.
export const Route = createFileRoute("/api/public/zip")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const raw = await readZipBody(request);
        if (raw === null) {
          return new Response("This ZIP request is too large. Try fewer tracks.", { status: 413 });
        }

        let payload: unknown;
        try {
          payload = JSON.parse(raw);
        } catch {
          return new Response("Send a JSON object with the tracks to pack.", { status: 400 });
        }

        if (tooManyTracks(payload)) {
          return new Response("Too many tracks for one ZIP. Ask for fewer at a time.", {
            status: 413,
          });
        }

        const parsed = zipRequestSchema.safeParse(payload);
        if (!parsed.success) {
          return new Response(zipRequestReason(parsed.error.issues).slice(0, 200), { status: 400 });
        }

        const { proxyServiceZip } = await import("@/lib/original.server");
        return proxyServiceZip(parsed.data, request.signal);
      },
    },
  },
});
