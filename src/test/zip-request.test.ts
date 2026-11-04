import { describe, expect, it } from "vitest";

import { FORMATS, type Format } from "@/lib/convert";
import {
  ZIP_TRACKS_MAX,
  tooManyTracks,
  zipRequestBody,
  zipRequestReason,
  zipRequestSchema,
  zipSelection,
} from "@/lib/zip-request";

const tracks = [{ id: 11 }, { id: 22 }, { id: 33 }];

describe("ZIP request selection", () => {
  it("asks the service for the quality tier the visitor chose", () => {
    expect(zipSelection("original-high")).toEqual({ mode: "original", quality: "high" });
    expect(zipSelection("original-low")).toEqual({ mode: "original", quality: "low" });
    expect(zipSelection("wav")).toEqual({ mode: "wav", quality: "high" });
  });

  it("carries the mp3 bitrate through", () => {
    for (const bitrate of [128, 192, 256, 320]) {
      expect(zipSelection(`mp3-${bitrate}` as Format)).toEqual({
        mode: "mp3",
        quality: "high",
        bitrate,
      });
    }
  });

  it("falls back to 320 for a bitrate the encoder does not offer", () => {
    expect(zipSelection("mp3-999" as Format)).toEqual({
      mode: "mp3",
      quality: "high",
      bitrate: 320,
    });
  });
});

describe("ZIP request body", () => {
  it("sends every track in playlist order in one format", () => {
    const body = zipRequestBody("My Playlist", tracks, "mp3-192");
    expect(body.name).toBe("My Playlist");
    expect(body.tracks).toEqual([
      { id: 11, mode: "mp3", quality: "high", bitrate: 192 },
      { id: 22, mode: "mp3", quality: "high", bitrate: 192 },
      { id: 33, mode: "mp3", quality: "high", bitrate: 192 },
    ]);
  });

  it("names an untitled job after the site, not after a blank file", () => {
    expect(zipRequestBody("   ", tracks, "wav").name).toBe("CloudMP3-Playlist");
  });

  it("builds a body the public ZIP route always accepts", () => {
    // The route validates what the page sends; a format that failed its own
    // schema would turn every ZIP of that quality into a 400.
    for (const format of FORMATS) {
      const parsed = zipRequestSchema.safeParse(zipRequestBody("Tour", tracks, format.value));
      expect(parsed.success).toBe(true);
    }
  });
});

describe("ZIP request schema", () => {
  it("defaults the format for a bare track id", () => {
    const parsed = zipRequestSchema.parse({ tracks: [{ id: 7 }] });
    expect(parsed.tracks[0]).toEqual({ id: 7, mode: "original", quality: "high" });
  });

  it("keeps the name optional and trims it", () => {
    expect(zipRequestSchema.parse({ name: "  Set  ", tracks: [{ id: 7 }] }).name).toBe("Set");
    expect(zipRequestSchema.parse({ tracks: [{ id: 7 }] }).name).toBeUndefined();
  });

  const rejected: unknown[] = [
    { tracks: [] },
    { tracks: [{ id: 0 }] },
    { tracks: [{ id: -5 }] },
    { tracks: [{ id: 1.5 }] },
    { tracks: [{ id: "12" }] },
    { tracks: [{ id: 12, mode: "flac" }] },
    { tracks: [{ id: 12, quality: "medium" }] },
    { tracks: [{ id: 12, mode: "mp3", bitrate: 200 }] },
    { tracks: [{ id: 12 }], name: "n".repeat(161) },
    { name: "Playlist" },
  ];

  it.each(rejected)("refuses %s before it reaches the service", (body) => {
    expect(zipRequestSchema.safeParse(body).success).toBe(false);
  });

  it("accepts a mixed-format job, since each row has its own selection", () => {
    const parsed = zipRequestSchema.safeParse({
      name: "Mixed",
      tracks: [
        { id: 1, mode: "original", quality: "high" },
        { id: 2, mode: "mp3", quality: "high", bitrate: 320 },
        { id: 3, mode: "wav", quality: "high" },
      ],
    });
    expect(parsed.success).toBe(true);
  });
});

describe("ZIP request rejections", () => {
  const reasonOf = (body: unknown) => {
    const parsed = zipRequestSchema.safeParse(body);
    return parsed.success ? "" : zipRequestReason(parsed.error.issues);
  };

  it("names the track by the position the visitor sees", () => {
    // A playlist is counted from one and the array is counted from zero, so a
    // message that repeats the schema's index sends them to the wrong row.
    expect(
      reasonOf({ tracks: [{ id: 1 }, { id: 2 }, { id: 12, mode: "mp3", bitrate: 200 }] }),
    ).toMatch(/^Track 3: /);
    expect(reasonOf({ tracks: [{ id: 1 }, { id: 0 }] })).toContain("Track 2:");
  });

  it("speaks of the archive name rather than the field", () => {
    expect(reasonOf({ name: "n".repeat(161), tracks: [{ id: 1 }] })).toContain("The archive name:");
  });

  it("answers an empty rejection instead of quoting nothing", () => {
    expect(zipRequestReason([])).toBe("The ZIP request was not valid.");
  });
});

describe("tooManyTracks", () => {
  const list = (n: number) => ({ tracks: Array.from({ length: n }, (_, i) => ({ id: i + 1 })) });

  it("refuses a list longer than the route will validate", () => {
    expect(tooManyTracks(list(ZIP_TRACKS_MAX + 1))).toBe(true);
    expect(tooManyTracks(list(ZIP_TRACKS_MAX))).toBe(false);
  });

  it("leaves every other shape for the schema to explain", () => {
    // A request with no usable list is a bad request, not an oversized one, so the
    // visitor still gets "Track 2: …" rather than a size complaint.
    expect(tooManyTracks({ tracks: [{ id: 1 }, { id: 0 }] })).toBe(false);
    expect(tooManyTracks({})).toBe(false);
    expect(tooManyTracks({ tracks: "abc" })).toBe(false);
    expect(tooManyTracks(null)).toBe(false);
    expect(tooManyTracks("a list on its own")).toBe(false);
  });
});
