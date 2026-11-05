import { describe, expect, it } from "vitest";

import { ZIP_BODY_MAX_BYTES } from "@/lib/zip-request";
import { readZipBody } from "@/routes/api/public/zip";

/** A body arriving in pieces, which is how a browser sends one it cannot size. */
function chunked(chunks: Uint8Array[]) {
  return {
    headers: new Headers(),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  };
}

const encoder = new TextEncoder();

describe("the ZIP route's body ceiling", () => {
  it("hands a small body over unchanged", async () => {
    const text = JSON.stringify({ tracks: [{ id: 7 }] });
    const request = new Request("http://localhost/api/public/zip", { method: "POST", body: text });
    expect(await readZipBody(request)).toBe(text);
  });

  it("refuses on the declared length", async () => {
    // Content-Length is a forbidden header name in jsdom, so the one header this
    // branch reads is handed over directly instead of through a Headers object.
    const declared = { get: (name: string) => (name === "content-length" ? "1048577" : null) };
    const small = chunked([new Uint8Array(1024)]);
    expect(await readZipBody({ ...small, headers: declared })).toBeNull();
  });

  it("refuses a chunked body that passes the ceiling with no length declared", async () => {
    const chunk = new Uint8Array(300_000);
    expect(await readZipBody(chunked(Array.from({ length: 5 }, () => chunk)))).toBeNull();
  });

  it("stays under the ceiling by bytes, not by characters", async () => {
    // A multi-byte title makes the text shorter than the buffer it arrives in,
    // and it is the buffer the service has to hold.
    const wide = chunked([encoder.encode("é".repeat(ZIP_BODY_MAX_BYTES))]);
    expect(await readZipBody(wide)).toBeNull();
  });

  it("reads a bodyless request as empty text", async () => {
    expect(await readZipBody({ headers: new Headers(), body: null })).toBe("");
  });
});
