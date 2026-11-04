import { describe, expect, it } from "vitest";

import {
  MP3_SERVER_MIN_KBPS,
  MP3_SERVER_THRESHOLD_BYTES,
  routeForChoice,
  routeForJob,
  selectDownloadRoute,
  type RouteInput,
} from "@/lib/download-router";

function route(input: Partial<RouteInput> & { format: RouteInput["format"] }) {
  return selectDownloadRoute({ estimatedBytes: 0, ...input });
}

// 30 s at 128 kbps is 480 KB and at 192 kbps 720 KB: both fit the tab.
const SHORT = 30_000;
// 10 min at 128 kbps is 9.6 MB, past the threshold the same track leaves the tab.
const LONG = 600_000;

/**
 * The routing table the site is required to follow, one row per format a
 * visitor can ask for. Both entry points — the track panel and the homepage —
 * reach it through the same `selectDownloadRoute`, so this is the table and not
 * a paraphrase of it.
 */
describe("download routing table", () => {
  it("hands every original or as-served stream straight over", () => {
    expect(route({ format: "aac" })).toBe("direct");
    expect(route({ format: "aac", estimatedBytes: 900_000_000 })).toBe("direct");
    expect(route({ format: "stream" })).toBe("direct");
    expect(route({ format: "original", estimatedBytes: 400_000_000 })).toBe("direct");
  });

  it("converts every wav on the backend at any size", () => {
    expect(route({ format: "wav", estimatedBytes: 5_000_000 })).toBe("server");
    expect(route({ format: "wav", estimatedBytes: 0 })).toBe("server");
  });

  it("builds every zip on the backend", () => {
    expect(route({ format: "mp3", bitrate: 128, isZip: true })).toBe("server");
    expect(route({ format: "original", isZip: true })).toBe("server");
  });

  it("sends a 256 or 320 kbps mp3 to the backend whatever its size", () => {
    for (const bitrate of [MP3_SERVER_MIN_KBPS, 320]) {
      expect(route({ format: "mp3", bitrate, estimatedBytes: 1_000_000 })).toBe("server");
      expect(route({ format: "mp3", bitrate, estimatedBytes: 0 })).toBe("server");
    }
  });

  it("sends an mp3 of 7 MB or more to the backend", () => {
    expect(route({ format: "mp3", bitrate: 128, estimatedBytes: MP3_SERVER_THRESHOLD_BYTES })).toBe(
      "server",
    );
    expect(
      route({ format: "mp3", bitrate: 192, estimatedBytes: MP3_SERVER_THRESHOLD_BYTES + 1 }),
    ).toBe("server");
  });

  it("leaves an eligible small mp3 in the browser", () => {
    expect(
      route({ format: "mp3", bitrate: 192, estimatedBytes: MP3_SERVER_THRESHOLD_BYTES - 1 }),
    ).toBe("browser");
    expect(route({ format: "mp3", bitrate: 128, estimatedBytes: 2_000_000 })).toBe("browser");
    expect(route({ format: "mp3", bitrate: 192, estimatedBytes: 0 })).toBe("browser");
  });
});

describe("routing when the deployment has no audio service", () => {
  // With no FFmpeg here the tab is the only producer, so it takes the conversion
  // for a track it can hold whole and refuses one it cannot. The format never
  // changes: a 320 asked for is a 320 made, just in the tab.
  const NO_SERVICE = { serviceAvailable: false };

  it("converts every format in the tab within the length it can hold", () => {
    expect(route({ format: "wav", durationMs: SHORT, ...NO_SERVICE })).toBe("browser");
    expect(route({ format: "mp3", bitrate: 320, durationMs: SHORT, ...NO_SERVICE })).toBe(
      "browser",
    );
    expect(route({ format: "mp3", bitrate: 256, durationMs: SHORT, ...NO_SERVICE })).toBe(
      "browser",
    );
    expect(route({ format: "mp3", bitrate: 128, durationMs: SHORT, ...NO_SERVICE })).toBe(
      "browser",
    );
  });

  it("leaves a track longer than the tab can hold with nobody", () => {
    expect(route({ format: "wav", durationMs: LONG, ...NO_SERVICE })).toBe("server");
    expect(route({ format: "mp3", bitrate: 128, durationMs: LONG, ...NO_SERVICE })).toBe("server");
    expect(
      route({
        format: "mp3",
        bitrate: 128,
        estimatedBytes: 100_000,
        durationMs: LONG,
        ...NO_SERVICE,
      }),
    ).toBe("server");
  });

  it("still hands over what needs no conversion", () => {
    expect(route({ format: "aac", ...NO_SERVICE })).toBe("direct");
    expect(route({ format: "original", ...NO_SERVICE })).toBe("direct");
    expect(route({ format: "stream", ...NO_SERVICE })).toBe("direct");
  });

  it("keeps a zip on the backend, where the archive is packed", () => {
    expect(
      route({ format: "mp3", bitrate: 128, isZip: true, durationMs: SHORT, ...NO_SERVICE }),
    ).toBe("server");
  });

  it("changes nothing while the service is configured", () => {
    expect(route({ format: "wav", durationMs: SHORT })).toBe("server");
    expect(route({ format: "mp3", bitrate: 320, durationMs: SHORT })).toBe("server");
    expect(
      route({ format: "mp3", bitrate: 192, estimatedBytes: 1_000_000, durationMs: SHORT }),
    ).toBe("browser");
  });
});

describe("the quality picker's value", () => {
  it("hands an original over as served", () => {
    expect(routeForChoice("original-high", LONG)).toBe("direct");
    expect(routeForChoice("original-low", LONG)).toBe("direct");
  });

  it("sends wav and the high bitrates to the server at any length", () => {
    expect(routeForChoice("wav", SHORT)).toBe("server");
    expect(routeForChoice("mp3-256", SHORT)).toBe("server");
    expect(routeForChoice("mp3-320", SHORT)).toBe("server");
    expect(routeForChoice("mp3-320", LONG)).toBe("server");
  });

  it("keeps a short low-bitrate mp3 in the tab and sends a long one to the server", () => {
    expect(routeForChoice("mp3-128", SHORT)).toBe("browser");
    expect(routeForChoice("mp3-192", SHORT)).toBe("browser");
    expect(routeForChoice("mp3-128", LONG)).toBe("server");
    expect(routeForChoice("mp3-192", 500_000)).toBe("server");
  });

  it("moves every conversion to the tab when there is no service to run it", () => {
    expect(routeForChoice("wav", SHORT, false)).toBe("browser");
    expect(routeForChoice("mp3-320", SHORT, false)).toBe("browser");
    expect(routeForChoice("mp3-320", LONG, false)).toBe("server");
    expect(routeForChoice("original-high", LONG, false)).toBe("direct");
  });
});

describe("a homepage batch's job-level route", () => {
  it("reports the server when any file needs FFmpeg", () => {
    expect(routeForJob("mp3-128", [SHORT, LONG])).toBe("server");
    expect(routeForJob("wav", [SHORT])).toBe("server");
    expect(routeForJob("mp3-320", [SHORT, SHORT])).toBe("server");
  });

  it("reports the tab only when every file can be made there", () => {
    expect(routeForJob("mp3-128", [SHORT, SHORT])).toBe("browser");
    expect(routeForJob("original-high", [SHORT, LONG])).toBe("direct");
  });

  it("reports the tab for a whole batch the tab can finish", () => {
    expect(routeForJob("mp3-320", [SHORT, SHORT], false)).toBe("browser");
    expect(routeForJob("wav", [SHORT, LONG], false)).toBe("server");
  });

  it("reports a single track exactly as that track's own route", () => {
    for (const duration of [SHORT, LONG]) {
      expect(routeForJob("mp3-192", [duration])).toBe(routeForChoice("mp3-192", duration));
      expect(routeForJob("mp3-192", [duration], false)).toBe(
        routeForChoice("mp3-192", duration, false),
      );
    }
  });
});
