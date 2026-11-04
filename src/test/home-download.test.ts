import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Format } from "@/lib/convert";

const convert = vi.hoisted(() => vi.fn());
const fetchCover = vi.hoisted(() => vi.fn());

vi.mock("@/lib/convert", () => ({
  convert: (bytes: Uint8Array, _ext: string, fmt: Format) =>
    convert(bytes, fmt).then(() => ({
      data: bytes,
      ext: fmt === "wav" ? "wav" : "mp3",
      mime: fmt === "wav" ? "audio/wav" : "audio/mpeg",
    })),
}));
vi.mock("@/lib/id3", () => ({
  fetchCover: (url: string | null) => fetchCover(url),
  tagMp3: (bytes: Uint8Array) => bytes,
}));

const { downloadTrackFile, routeForTrack } = await import("@/lib/home-download");

const SHORT = 30_000; // 30 s: 480 KB at 128 kbps, well inside the tab
const LONG = 600_000; // 10 min: 9.6 MB at 128 kbps, past the threshold

const track = {
  id: 1,
  title: "Track",
  artist: "Artist",
  duration: SHORT,
  artwork_url: null,
};

function ok(body = new Uint8Array([1, 2, 3]), headers: Record<string, string> = {}) {
  return new Response(body, { status: 200, headers });
}

let urls: string[];

beforeEach(() => {
  urls = [];
  convert.mockReset().mockResolvedValue(undefined);
  fetchCover.mockReset().mockResolvedValue(null);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      urls.push(input);
      return ok(new Uint8Array([1, 2, 3]), { "X-File-Ext": "m4a" });
    }),
  );
});

async function run(quality: Format, overrides: Partial<typeof track> = {}) {
  const signal = new AbortController().signal;
  return downloadTrackFile({ ...track, ...overrides }, quality, {}, signal);
}

describe("one homepage download", () => {
  it("asks the backend for a wav of any length", async () => {
    const short = await run("wav");
    const long = await run("wav", { duration: LONG });
    expect(short.route).toBe("server");
    expect(long.route).toBe("server");
    expect(urls[0]).toContain("mode=wav");
    expect(convert).not.toHaveBeenCalled();
  });

  it("asks the backend for 256 and 320 kbps whatever the length", async () => {
    for (const quality of ["mp3-256", "mp3-320"] as Format[]) {
      urls = [];
      const result = await run(quality, { duration: SHORT });
      expect(result.route).toBe("server");
      expect(urls[0]).toContain(`mode=mp3&bitrate=${quality.slice(4)}`);
    }
    expect(convert).not.toHaveBeenCalled();
  });

  it("asks the backend for an mp3 too big for the tab", async () => {
    const result = await run("mp3-128", { duration: LONG });
    expect(result.route).toBe("server");
    expect(urls[0]).toContain("mode=mp3&bitrate=128");
    expect(convert).not.toHaveBeenCalled();
  });

  it("converts a small mp3 in the tab", async () => {
    const result = await run("mp3-128");
    expect(result.route).toBe("browser");
    expect(urls[0]).not.toContain("mode=");
    expect(convert).toHaveBeenCalled();
    expect(result.file.method).toBe("browser");
  });

  it("hands an original over as served", async () => {
    const result = await run("original-high", { duration: LONG });
    expect(result.route).toBe("direct");
    expect(urls[0]).not.toContain("mode=");
    expect(result.file.method).toBe("direct");
  });

  it("names the same route for the track and for the job", async () => {
    const long = { ...track, duration: LONG };
    expect(routeForTrack(long, "mp3-128")).toBe("server");
    expect((await run("mp3-128", { duration: LONG })).route).toBe(routeForTrack(long, "mp3-128"));
  });
});

describe("a homepage download with the conversion service down", () => {
  beforeEach(() => {
    // The proxy only refuses what it must hand to FFmpeg; a stream it can serve
    // itself still comes back, which is why an original is unaffected.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        urls.push(input);
        return input.includes("mode=")
          ? new Response("The conversion service isn't available on this deployment.", {
              status: 503,
            })
          : ok(new Uint8Array([1, 2, 3]), { "X-File-Ext": "m4a" });
      }),
    );
  });

  it("fails a server-only format instead of converting it in the tab", async () => {
    await expect(run("wav")).rejects.toThrow(
      "The conversion service isn't available on this deployment.",
    );
    expect(convert).not.toHaveBeenCalled();
  });

  it("fails a 320 kbps mp3 the same way", async () => {
    await expect(run("mp3-320")).rejects.toThrow(/conversion service/);
    expect(convert).not.toHaveBeenCalled();
  });

  it("still hands an original straight over", async () => {
    const result = await run("original-high");
    expect(result.route).toBe("direct");
    expect(result.file.method).toBe("direct");
  });
});
