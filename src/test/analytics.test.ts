import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DownloadInfo } from "@/lib/analytics";

type Call = [string, ...unknown[]];

/**
 * The module keeps `started` and the last reported address, so every case needs a
 * freshly imported copy of it.
 */
async function loadAnalytics(): Promise<{ mod: typeof import("@/lib/analytics"); calls: Call[] }> {
  document.head.querySelectorAll("script").forEach((node) => node.remove());
  delete window.dataLayer;
  delete window.gtag;
  const calls: Call[] = [];
  window.gtag = (...args: unknown[]) => {
    calls.push(args as Call);
  };
  vi.resetModules();
  return { mod: await import("@/lib/analytics"), calls };
}

function events(calls: Call[]) {
  return calls
    .filter((call) => call[0] === "event")
    .map((call) => ({ name: call[1] as string, params: call[2] as Record<string, unknown> }));
}

function lastEvent(calls: Call[]) {
  const list = events(calls);
  const tail = list[list.length - 1];
  if (!tail) throw new Error("no event was queued");
  return tail;
}

const single: DownloadInfo = { fileFormat: "mp3", bitrate: 320, method: "server", kind: "single" };

beforeEach(() => {
  window.history.pushState({}, "", "/");
  document.title = "CloudMP3";
});

describe("GA4 tag installation", () => {
  it("injects the Google tag once and turns off automatic page views", async () => {
    const { mod, calls } = await loadAnalytics();
    mod.initAnalytics();
    mod.initAnalytics();

    const scripts = document.querySelectorAll<HTMLScriptElement>(
      "script[src*='googletagmanager.com/gtag/js']",
    );
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.async).toBe(true);

    const config = calls.find((call) => call[0] === "config");
    expect(config?.[1]).toBe("G-RZVEMQ51PX");
    expect(config?.[2]).toMatchObject({ send_page_view: false });
  });

  it("keeps a tag that is already on the page instead of adding a second one", async () => {
    const { mod } = await loadAnalytics();
    const existing = document.createElement("script");
    existing.src = "https://www.googletagmanager.com/gtag/js?id=G-RZVEMQ51PX";
    document.head.appendChild(existing);
    mod.initAnalytics();

    expect(document.querySelectorAll("script[src*='googletagmanager.com']")).toHaveLength(1);
  });

  it("keeps an existing gtag function rather than replacing it", async () => {
    document.head.querySelectorAll("script").forEach((node) => node.remove());
    delete window.dataLayer;
    const seen: Call[] = [];
    window.gtag = (...args: unknown[]) => {
      seen.push(args as Call);
    };
    vi.resetModules();
    const { initAnalytics } = await import("@/lib/analytics");
    const original = window.gtag;
    initAnalytics();

    expect(window.gtag).toBe(original);
    expect(seen.some((call) => call[0] === "config")).toBe(true);
  });

  it("names the Measurement ID it exports and loads the tag with exactly that ID", async () => {
    // A typo in the ID alone would still inject a tag and still pass every other
    // case here, so the exported constant and the script address are compared.
    const { mod } = await loadAnalytics();
    expect(mod.GA_MEASUREMENT_ID).toBe("G-RZVEMQ51PX");

    mod.initAnalytics();
    const src = document.querySelector<HTMLScriptElement>(
      "script[src^='https://www.googletagmanager.com/gtag/js']",
    )?.src;
    expect(src).toBe(`https://www.googletagmanager.com/gtag/js?id=${mod.GA_MEASUREMENT_ID}`);
  });
});

describe("server-side rendering", () => {
  it("does nothing and throws nothing while there is no window", async () => {
    const { mod, calls } = await loadAnalytics();
    vi.stubGlobal("window", undefined);
    try {
      mod.initAnalytics();
      mod.trackPageView();
      mod.trackDownloadStart(single);
      mod.trackSearch({ source: "header", tab: "tracks", term: "phonk", resultCount: 2 });
      mod.trackAppError({ stage: "formats", error: new Error("upstream said no") });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(calls).toHaveLength(0);
    expect(document.querySelectorAll("script[src*='googletagmanager.com']")).toHaveLength(0);
  });
});

describe("event queueing", () => {
  it("survives a missing or hostile gtag", async () => {
    const { mod } = await loadAnalytics();
    delete window.gtag;
    expect(() => mod.trackDownloadStart(single)).not.toThrow();

    window.gtag = () => {
      throw new Error("google is blocked");
    };
    expect(() => mod.trackDownloadComplete({ ...single, bytes: 12 })).not.toThrow();
    expect(() => mod.trackPageView()).not.toThrow();
  });

  it("queues calls that arrive before gtag.js has loaded", async () => {
    document.head.querySelectorAll("script").forEach((node) => node.remove());
    delete window.dataLayer;
    delete window.gtag;
    vi.resetModules();
    const { initAnalytics, trackDownloadStart } = await import("@/lib/analytics");
    initAnalytics();
    trackDownloadStart(single);

    const queue = window.dataLayer ?? [];
    expect(queue.map((entry) => (entry as Call)[0])).toContain("event");
    expect(queue.some((entry) => (entry as Call)[0] === "config")).toBe(true);
  });

  it("drops empty values and caps free text", async () => {
    const { mod, calls } = await loadAnalytics();
    mod.trackDownloadComplete({ fileFormat: "wav", method: "browser", bitrate: null, bytes: null });
    expect(lastEvent(calls).params).toEqual({
      download_kind: "single",
      file_format: "wav",
      download_method: "browser",
    });

    mod.trackCtaClicked({ label: "a".repeat(200), page: "track" });
    expect((lastEvent(calls).params["cta_label"] as string).length).toBe(60);
  });
});

describe("page views", () => {
  it("reports one view per page and chains the referrer", async () => {
    const { mod, calls } = await loadAnalytics();

    window.history.pushState({}, "", "/faq");
    mod.trackPageView();
    mod.trackPageView();
    expect(events(calls)).toHaveLength(1);

    document.title = "FAQ — CloudMP3";
    window.history.pushState({}, "", "/search?q=demo&tab=original");
    mod.trackPageView();
    const view = lastEvent(calls);
    expect(view.name).toBe("page_view");
    expect(view.params).toEqual({
      page_title: "FAQ — CloudMP3",
      page_location: "http://localhost:3000/search",
      page_path: "/search",
      page_referrer: "http://localhost:3000/faq",
    });
  });

  it("counts a re-render of the same address as no view", async () => {
    const { mod, calls } = await loadAnalytics();
    window.history.pushState({}, "", "/track/12345");
    mod.trackPageView();
    for (let i = 0; i < 5; i++) mod.trackPageView();
    expect(events(calls)).toHaveLength(1);
  });

  it("leaves a refined search on the page it was already counted for", async () => {
    // The query is what changes here, and the searches themselves arrive as
    // `search_submitted`; counting every refinement as a fresh page would turn
    // one visitor's one page into a dozen.
    const { mod, calls } = await loadAnalytics();
    window.history.pushState({}, "", "/search?q=phonk");
    mod.trackPageView();
    for (const href of ["/search?q=phonk&tab=tracks", "/search?q=drift", "/search"]) {
      window.history.pushState({}, "", href);
      mod.trackPageView();
    }
    expect(events(calls)).toHaveLength(1);
  });

  it("counts the hand-off to a track page once, whatever the query it carried", async () => {
    const { mod, calls } = await loadAnalytics();
    window.history.pushState({}, "", "/track/1?download=true");
    mod.trackPageView();
    window.history.pushState({}, "", "/track/1");
    mod.trackPageView();
    expect(events(calls)).toHaveLength(1);
    expect(lastEvent(calls).params["page_location"]).toBe("http://localhost:3000/track/1");
  });

  it("strips a query from the referrer of the first view", async () => {
    const { mod, calls } = await loadAnalytics();
    Object.defineProperty(document, "referrer", {
      value: "https://example.com/?q=secret",
      configurable: true,
    });
    window.history.pushState({}, "", "/faq");
    mod.trackPageView();
    expect(lastEvent(calls).params["page_referrer"]).toBe("https://example.com/");
  });
});

describe("download events", () => {
  it("names the format, bitrate and route on every start", async () => {
    const { mod, calls } = await loadAnalytics();
    mod.trackDownloadStart(single);
    expect(lastEvent(calls)).toEqual({
      name: "download_start",
      params: {
        download_kind: "single",
        file_format: "mp3",
        bitrate: 320,
        download_method: "server",
      },
    });
  });

  it("reports the archive separately from the audio packed inside it", async () => {
    const { mod, calls } = await loadAnalytics();
    mod.trackPlaylistDownload({
      kind: "zip",
      trackCount: 24,
      fileFormat: "zip",
      contentFormat: "mp3",
      bitrate: 192,
      method: "server",
    });
    expect(lastEvent(calls).params).toEqual({
      download_kind: "zip",
      file_format: "zip",
      content_format: "mp3",
      bitrate: 192,
      download_method: "server",
      track_count: 24,
    });
  });

  it("carries sizes and durations on a complete", async () => {
    const { mod, calls } = await loadAnalytics();
    mod.trackDownloadComplete({
      ...single,
      bytes: 7_340_032,
      elapsedMs: 4200,
      conversionMs: 1900,
      serverWaitMs: 900,
    });
    expect(lastEvent(calls).params).toMatchObject({
      file_size_bytes: 7_340_032,
      elapsed_ms: 4200,
      conversion_ms: 1900,
      server_wait_ms: 900,
    });
  });

  it("keeps a cancellation out of both the success and the failure count", async () => {
    const { mod, calls } = await loadAnalytics();
    mod.trackDownloadCancelled({ ...single, elapsedMs: 800 });
    const event = lastEvent(calls);
    expect(event.name).toBe("download_cancelled");
    expect(event.params["error_type"]).toBeUndefined();

    mod.trackDownloadError({ ...single, errorType: "timeout", elapsedMs: 30_000 });
    expect(lastEvent(calls).params).toMatchObject({ error_type: "timeout", elapsed_ms: 30_000 });
  });

  it("names the container the bytes actually arrived in", async () => {
    const { mod } = await loadAnalytics();
    const { formatOfExt } = mod;
    expect(formatOfExt("m4a")).toBe("aac");
    expect(formatOfExt(".mp3")).toBe("mp3");
    expect(formatOfExt("WAV")).toBe("wav");
    expect(formatOfExt("zip")).toBe("zip");
    expect(formatOfExt("opus")).toBe("ogg");
    expect(formatOfExt("flac")).toBe("flac");
    expect(formatOfExt("bin")).toBe("other");
  });
});

describe("search and interaction events", () => {
  it("reports a pasted link as a type, never as a link", async () => {
    const { mod, calls } = await loadAnalytics();
    mod.trackSearch({
      source: "link_box",
      term: "https://soundcloud.com/artist/track?client_id=SECRET",
      linkType: "track",
      resultCount: 1,
    });
    const params = lastEvent(calls).params;
    expect(params).toEqual({
      search_source: "link_box",
      result_count: 1,
      link_type: "track",
    });
  });

  it("keeps a typed query short", async () => {
    const { mod, calls } = await loadAnalytics();
    mod.trackSearch({ source: "header", tab: "original", term: "x".repeat(90), resultCount: 8 });
    expect(lastEvent(calls).params["search_term"]).toBe("x".repeat(60));
    expect(lastEvent(calls).params["search_tab"]).toBe("original");
  });

  it("reports only the destination host of an outbound link", async () => {
    const { mod, calls } = await loadAnalytics();
    mod.trackExternalLink({
      href: "https://soundcloud.com/some-artist/secret-slug?client_id=SECRET",
      label: "open_on_soundcloud",
    });
    expect(lastEvent(calls).params).toEqual({
      link_host: "soundcloud.com",
      link_label: "open_on_soundcloud",
    });

    const before = events(calls).length;
    mod.trackExternalLink({ href: "/faq", label: "internal" });
    mod.trackExternalLink({ href: "not a url", label: "broken" });
    expect(events(calls)).toHaveLength(before);
  });

  it("counts the FAQ entry that opened, by position", async () => {
    const { mod, calls } = await loadAnalytics();
    mod.trackFaqOpened({ page: "home", index: 3 });
    expect(lastEvent(calls).params).toEqual({ faq_page: "home", question_index: 3 });
  });
});

describe("error classification", () => {
  const cases: [unknown, string][] = [
    ['{"error":{"code":"zip_too_large","message":"too big for one archive"}}', "over_limit"],
    ['{"error":{"code":"too_many_tracks"}}', "over_limit"],
    ["convert_failed", "conversion"],
    ["ffmpeg_missing", "conversion"],
    ["zip_timeout", "timeout"],
    ["client_disconnected", "aborted"],
    ["zip_empty", "empty_archive"],
    ["no_stream", "not_downloadable"],
    ["Download isn't available", "not_downloadable"],
    ["not_found", "not_found"],
    ["429 Too Many Requests", "rate_limited"],
    ["unauthorized", "unauthorized"],
    ["bad_mode", "bad_request"],
    ["That track link isn't valid.", "bad_request"],
    ["Failed to fetch", "network"],
    ["formats service 503", "server_unavailable"],
    [new Error("Service Unavailable"), "server_unavailable"],
    [{ code: "bad_track_id" }, "bad_request"],
    [null, "unknown"],
    ["", "unknown"],
  ];

  it.each(cases)("reduces %s to one stable code", async (input, expected) => {
    const { mod } = await loadAnalytics();
    expect(mod.classifyError(input)).toBe(expected);
  });

  it("reports a stage and a code, never the message behind it", async () => {
    const { mod, calls } = await loadAnalytics();
    mod.trackAppError({
      stage: "zip",
      error: '{"error":{"code":"no_stream","message":"Artist - Song https://soundcloud.com/x"}}',
    });
    const params = lastEvent(calls).params;
    expect(params).toEqual({ error_stage: "zip", error_type: "not_downloadable" });
    expect(JSON.stringify(params)).not.toMatch(/soundcloud|Artist|https/);
  });

  it("does not turn an aborted request into a failure", async () => {
    const { mod, calls } = await loadAnalytics();
    mod.trackAppError({ stage: "formats", error: new Error("The user aborted a request.") });
    expect(lastEvent(calls).params).toEqual({
      error_stage: "formats",
      error_type: "aborted",
    });
  });
});
