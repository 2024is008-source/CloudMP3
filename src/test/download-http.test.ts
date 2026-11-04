import { describe, expect, it } from "vitest";

import {
  blobFromResponse,
  downloadFailure,
  errorText,
  filenameFromHeaders,
  isAbort,
  readResponse,
  safeName,
  totalFromHeaders,
  userError,
  withExtension,
} from "@/lib/download-http";

function streamed(chunks: string[], headers: Record<string, string> = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { headers });
}

const idle = new AbortController().signal;

/** jsdom's Blob has neither `.text()` nor `.arrayBuffer()`, so the bytes come back through a reader. */
function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

describe("download-http", () => {
  it("reads a streamed body and reports every byte", async () => {
    const seen: [number, number | null][] = [];
    const bytes = await readResponse(
      streamed(["abc", "de"], { "X-Total-Bytes": "5" }),
      (received, total) => seen.push([received, total]),
      idle,
    );

    expect(new TextDecoder().decode(bytes)).toBe("abcde");
    expect(seen).toEqual([
      [3, 5],
      [5, 5],
    ]);
  });

  it("keeps the same bytes in a Blob without a second copy", async () => {
    const seen: number[] = [];
    const blob = await blobFromResponse(
      streamed(["abc", "de"], { "Content-Type": "application/zip", "X-Total-Bytes": "5" }),
      (received) => seen.push(received),
      idle,
    );

    expect(blob.type).toBe("application/zip");
    expect(blob.size).toBe(5);
    expect(await blobText(blob)).toBe("abcde");
    expect(seen.at(-1)).toBe(5);
  });

  it("stops when the visitor cancels", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(readResponse(streamed(["abc"]), () => {}, controller.signal)).rejects.toThrow();
  });

  it("takes the total from Content-Length, then from the estimate header", () => {
    const withLength = new Response(null, { headers: { "Content-Length": "1024" } });
    expect(totalFromHeaders(withLength)).toBe(1024);
    const withEstimate = new Response(null, { headers: { "X-Total-Bytes": "2048" } });
    expect(totalFromHeaders(withEstimate)).toBe(2048);
    expect(totalFromHeaders(new Response(null))).toBeNull();
  });

  it("prefers X-Filename and falls back to Content-Disposition", () => {
    const direct = new Response(null, {
      headers: { "X-Filename": encodeURIComponent("Jóga.zip") },
    });
    expect(filenameFromHeaders(direct)).toBe("Jóga.zip");

    const encoded = new Response(null, {
      headers: {
        "Content-Disposition": "attachment; filename=\"zip.zip\"; filename*=UTF-8''J%C3%B3ga.zip",
      },
    });
    expect(filenameFromHeaders(encoded)).toBe("Jóga.zip");

    const plain = new Response(null, {
      headers: { "Content-Disposition": 'attachment; filename="Playlist.zip"' },
    });
    expect(filenameFromHeaders(plain)).toBe("Playlist.zip");
    expect(filenameFromHeaders(new Response(null))).toBeNull();
  });

  it("makes a name safe and adds the extension only when missing", () => {
    expect(safeName('A / B: C*D?"E')).toBe("A _ B_ C_D__E");
    expect(withExtension("My Playlist", "zip")).toBe("My Playlist.zip");
    expect(withExtension("My Playlist.ZIP", "zip")).toBe("My Playlist.ZIP");
  });

  it("passes the proxy's own sentence through", async () => {
    const res = new Response("SoundCloud has no track with this id.", { status: 404 });
    expect(await errorText(res)).toBe("SoundCloud has no track with this id.");
  });

  it("keeps only the message out of a JSON error body", async () => {
    const res = new Response(
      JSON.stringify({ error: { message: "Track is private.", trace: "x" } }),
      {
        status: 403,
      },
    );
    expect(await errorText(res)).toBe("Track is private.");
  });

  it("replaces an upstream error page with the meaning of the status", async () => {
    const gateway = new Response(
      "<html><head><title>502 Bad Gateway</title></head><body>nginx/1.27.3</body></html>",
      { status: 502 },
    );
    expect(await errorText(gateway)).toBe(
      "The download service couldn't reach SoundCloud. Try again in a moment.",
    );

    const long = new Response("  " + "x".repeat(500) + "  ", { status: 500 });
    expect(await errorText(long)).toBe("The download service failed. Try again in a moment.");

    const empty = new Response("   ", { status: 429 });
    expect(await errorText(empty)).toBe("Too many downloads at once. Try again in a moment.");
  });

  it("turns a network failure into something actionable", () => {
    expect(userError(new TypeError("Failed to fetch"))).toBe(
      "Couldn't reach the download service. Try again in a moment.",
    );
    expect(userError(new DOMException("Aborted", "AbortError"))).toBe("Download cancelled.");
    expect(isAbort(new DOMException("Aborted", "AbortError"))).toBe(true);
    expect(isAbort(new Error("boom"))).toBe(false);
    expect(userError(new Error("The archive is empty."))).toBe("The archive is empty.");
  });
});

/**
 * One error surface for every download: a status becomes a sentence a visitor can
 * act on, and nothing that belongs to a stack trace, a validation body or a
 * gateway's HTML reaches the screen.
 */
describe("download error mapping", () => {
  it.each([
    [400, "SoundCloud didn't accept this request."],
    [403, "This track isn't available for download."],
    [404, "SoundCloud has no track with this id."],
    [413, "That is larger than this server allows. Try fewer tracks or a lower bitrate."],
    [422, "That request wasn't in the form the download service expects."],
    [429, "Too many downloads at once. Try again in a moment."],
    [500, "The download service failed. Try again in a moment."],
    [502, "The download service couldn't reach SoundCloud. Try again in a moment."],
    [503, "The conversion service isn't available on this deployment."],
    [504, "The download took too long and was cancelled."],
  ])("names HTTP %i", async (status, message) => {
    expect(await errorText(new Response("", { status }))).toBe(message);
  });

  it("keeps a validation body's field paths out of the message", async () => {
    // FastAPI answers a rejected request with internal names like `tracks.2.bitrate`.
    const res = new Response(
      JSON.stringify({
        detail: [{ loc: ["body", "tracks", 2, "bitrate"], msg: "Input should be 128" }],
      }),
      { status: 422 },
    );
    expect(await errorText(res)).toBe(
      "That request wasn't in the form the download service expects.",
    );
  });

  it("drops an unrecognised JSON body instead of printing it", async () => {
    const res = new Response(JSON.stringify({ errors: [{ field: "api_key" }] }), { status: 401 });
    expect(await errorText(res)).toBe("The download service isn't authorised on this deployment.");
  });

  it("replaces a Python traceback with the meaning of the status", async () => {
    const res = new Response(
      'Traceback (most recent call last):\n  File "/srv/app/main.py", line 41\nValueError: bad stream',
      { status: 500 },
    );
    expect(await errorText(res)).toBe("The download service failed. Try again in a moment.");
  });

  it("carries the status with the failure it throws", async () => {
    const failure = await downloadFailure(new Response("", { status: 429 }));
    expect(failure).toBeInstanceOf(Error);
    expect(failure.status).toBe(429);
    expect(failure.message).toBe("Too many downloads at once. Try again in a moment.");
  });

  it("tells a dead service apart from a refused track", async () => {
    const unavailable = await downloadFailure(new Response("", { status: 503 }));
    const refused = await downloadFailure(new Response("", { status: 403 }));
    expect(unavailable.message).not.toBe(refused.message);
    // A request that never got a response at all is the third, separate case.
    expect(userError(new Error("load failed"))).toBe(
      "Couldn't reach the download service. Try again in a moment.",
    );
  });
});
