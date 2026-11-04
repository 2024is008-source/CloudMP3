import { afterEach, describe, expect, it, vi } from "vitest";

const lookup = vi.hoisted(() => vi.fn());

vi.mock("node:dns/promises", () => ({ default: { lookup } }));

import {
  MAX_REDIRECTS,
  allowedHosts,
  inspectMediaUrl,
  inspectPageUrl,
  isAllowedMediaUrl,
} from "@/lib/url-guard";
import { hlsStream } from "@/lib/soundcloud.server";
import { proxyServiceDownload } from "@/lib/original.server";
import { UnsafeDestinationError, guardedFetch, isGlobalAddress } from "@/lib/url-guard.server";

const PUBLIC = "93.184.215.34";

/**
 * Each test names its own hosts.
 *
 * A lookup answer is trusted for a minute, the way the shipped code trusts it, so
 * a name reused between tests would carry the previous test's answer over.
 */
function resolves(hosts: Record<string, string | string[]>) {
  lookup.mockReset().mockImplementation(async (host: string) => {
    const answer = hosts[host];
    if (!answer) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    const list = Array.isArray(answer) ? answer : [answer];
    return list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  });
}

type Route = { status?: number; body?: string; location?: string };

/** The mocked internet: what it answers, and every address it was asked for. */
function network(routes: Record<string, Route>): string[] {
  const requested: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      requested.push(url);
      const route = routes[url];
      if (!route) return new Response("", { status: 404 });
      if (route.location) {
        return new Response(null, { status: 302, headers: { location: route.location } });
      }
      return new Response(route.body ?? "", { status: route.status ?? 200 });
    }),
  );
  return requested;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env["CLOUDMP3_ALLOWED_MEDIA_HOSTS"];
  delete process.env["CLOUDMP3_SERVICE_URL"];
  delete process.env["CLOUDMP3_SERVICE_KEY"];
});

describe("the outbound host policy", () => {
  it("accepts only https on the approved domains", () => {
    expect(inspectMediaUrl("https://cf-media.sndcdn.com/media-aac")).toBeNull();
    expect(inspectMediaUrl("https://api-v2.soundcloud.com/tracks/1")).toBeNull();
    expect(inspectMediaUrl("https://w1.soundcloud.cloud/a")).toBeNull();
    expect(inspectMediaUrl("http://cf-media.sndcdn.com/a")).toBe("scheme is not https");
    expect(inspectMediaUrl("https://8.8.8.8/a")).toBe("host is not an approved SoundCloud address");
    expect(inspectMediaUrl("https://sndcdn.com.evil.example/a")).toBe(
      "host is not an approved SoundCloud address",
    );
  });

  it("refuses credentials, ports and addresses that are not URLs", () => {
    expect(inspectMediaUrl("https://cf-media.sndcdn.com@127.0.0.1/")).toBe(
      "URL carries credentials",
    );
    expect(inspectMediaUrl("https://@cf-media.sndcdn.com/a")).toBe("URL carries credentials");
    expect(inspectMediaUrl("https://cf-media.sndcdn.com:8443/a")).toBe("port is not 443");
    expect(inspectMediaUrl("https://cf-media.sndcdn.com:443/a")).toBeNull();
    expect(inspectMediaUrl("/relative/path")).toBe("malformed URL");
    expect(inspectMediaUrl(null)).toBe("not a URL");
  });

  it("keeps a track page on soundcloud.com", () => {
    expect(inspectPageUrl("https://soundcloud.com/artist/title")).toBeNull();
    expect(inspectPageUrl("https://cf-media.sndcdn.com/artist/title")).toBe(
      "host is not an approved SoundCloud address",
    );
  });

  it("lets the operator add domains and drops anything looser", () => {
    process.env["CLOUDMP3_ALLOWED_MEDIA_HOSTS"] = " media.example , .com, *, 127.0.0.1";
    expect(allowedHosts()).toEqual([
      "sndcdn.com",
      "soundcloud.com",
      "soundcloud.cloud",
      "media.example",
    ]);
    expect(isAllowedMediaUrl("https://a.media.example/x")).toBe(true);
    expect(isAllowedMediaUrl("http://a.media.example/x")).toBe(false);
    expect(isAllowedMediaUrl("https://anything.com/x")).toBe(false);
  });

  it("tells loopback, private and reserved addresses from routed ones", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.0.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "255.255.255.255",
      "224.0.0.1",
      "::1",
      "fc00::1",
      "fe80::1",
      "ff02::1",
      "2001:db8::1",
      "::ffff:127.0.0.1",
      "not-an-address",
    ]) {
      expect(isGlobalAddress(address), address).toBe(false);
    }
    for (const address of [PUBLIC, "2001:4860:4860::8888", "::ffff:8.8.8.8"]) {
      expect(isGlobalAddress(address), address).toBe(true);
    }
  });
});

describe("guardedFetch", () => {
  it("follows a redirect that stays on the approved hosts", async () => {
    resolves({ "bounce-a.sndcdn.com": PUBLIC, "cf-media.sndcdn.com": PUBLIC });
    const requested = network({
      "https://bounce-a.sndcdn.com/hop": { location: "https://cf-media.sndcdn.com/media-aac" },
      "https://cf-media.sndcdn.com/media-aac": { body: "audio" },
    });

    const response = await guardedFetch("https://bounce-a.sndcdn.com/hop");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("audio");
    expect(requested).toEqual([
      "https://bounce-a.sndcdn.com/hop",
      "https://cf-media.sndcdn.com/media-aac",
    ]);
  });

  it("never asks for a redirect that leaves the approved hosts", async () => {
    resolves({ "bounce-b.sndcdn.com": PUBLIC });
    const requested = network({
      "https://bounce-b.sndcdn.com/hop": { location: "http://169.254.169.254/latest/meta-data/" },
    });

    await expect(guardedFetch("https://bounce-b.sndcdn.com/hop")).rejects.toThrow(
      UnsafeDestinationError,
    );
    expect(requested).toEqual(["https://bounce-b.sndcdn.com/hop"]);
  });

  it("never asks for an approved name that resolves to the local network", async () => {
    resolves({ "bounce-c.sndcdn.com": PUBLIC, "rebound.sndcdn.com": "127.0.0.1" });
    const requested = network({
      "https://bounce-c.sndcdn.com/hop": { location: "https://rebound.sndcdn.com/admin" },
    });

    await expect(guardedFetch("https://bounce-c.sndcdn.com/hop")).rejects.toThrow(
      UnsafeDestinationError,
    );
    expect(requested).toEqual(["https://bounce-c.sndcdn.com/hop"]);
  });

  it("refuses a start address that is not approved without looking it up", async () => {
    resolves({});
    const requested = network({});

    await expect(guardedFetch("https://internal.example/x")).rejects.toThrow(
      UnsafeDestinationError,
    );
    expect(requested).toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("bounds a redirect loop instead of following it forever", async () => {
    resolves({ "loop-d.sndcdn.com": PUBLIC });
    const loop = "https://loop-d.sndcdn.com/round";
    const requested = network({ [loop]: { location: loop } });

    await expect(guardedFetch(loop)).rejects.toThrow(/too many redirects/);
    expect(requested.length).toBeLessThanOrEqual(MAX_REDIRECTS + 1);
  });

  it("stops when a name stops resolving", async () => {
    resolves({});
    const requested = network({ "https://gone.sndcdn.com/x": { body: "audio" } });

    await expect(guardedFetch("https://gone.sndcdn.com/x")).rejects.toThrow(UnsafeDestinationError);
    expect(requested).toEqual([]);
  });
});

describe("HLS playback addresses", () => {
  const master = "https://cf-media.sndcdn.com/master.m3u8";

  async function bytes(stream: ReadableStream<Uint8Array>): Promise<string> {
    return new Response(stream).text();
  }

  it("fetches only segments that passed the policy", async () => {
    resolves({ "cf-media.sndcdn.com": PUBLIC });
    const requested = network({
      [master]: {
        body: '#EXTM3U\n#EXT-X-MAP:URI="init.m4s"\nseg1.m4s\nhttps://evil.example/s.m4s\n',
      },
      "https://cf-media.sndcdn.com/init.m4s": { body: "init" },
      "https://cf-media.sndcdn.com/seg1.m4s": { body: "body" },
    });

    await expect(hlsStream(master)).rejects.toThrow(UnsafeDestinationError);
    expect(requested).toEqual([master]);
  });

  it("expands a nested playlist and keeps the segment order", async () => {
    resolves({ "cf-media.sndcdn.com": PUBLIC });
    const variant = "https://cf-media.sndcdn.com/variant.m3u8";
    const requested = network({
      [master]: { body: "#EXTM3U\nvariant.m3u8\n" },
      [variant]: { body: '#EXTM3U\n#EXT-X-MAP:URI="init.m4s"\nb.m4s\nc.m4s\n' },
      "https://cf-media.sndcdn.com/init.m4s": { body: "init" },
      "https://cf-media.sndcdn.com/b.m4s": { body: "b" },
      "https://cf-media.sndcdn.com/c.m4s": { body: "c" },
    });

    const stream = await hlsStream(master);

    expect(await bytes(stream)).toBe("initbc");
    expect(requested).toEqual([
      master,
      variant,
      "https://cf-media.sndcdn.com/init.m4s",
      "https://cf-media.sndcdn.com/b.m4s",
      "https://cf-media.sndcdn.com/c.m4s",
    ]);
  });

  it("refuses a playlist that is DRM-protected", async () => {
    resolves({ "cf-media.sndcdn.com": PUBLIC });
    const requested = network({
      [master]: {
        body: '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://cf-media.sndcdn.com/k"\na.m4s\n',
      },
    });

    await expect(hlsStream(master)).rejects.toThrow(/DRM/);
    expect(requested).toEqual([master]);
  });

  it("refuses a playlist served over http", async () => {
    resolves({});
    const requested = network({});

    await expect(hlsStream("http://cf-media.sndcdn.com/master.m3u8")).rejects.toThrow(
      UnsafeDestinationError,
    );
    expect(requested).toEqual([]);
  });
});

describe("the audio service is called without leaking its key", () => {
  it("refuses a redirect instead of re-sending the request to it", async () => {
    const target = "http://127.0.0.1:8090/api/download/123?mode=original&quality=high";
    const requested = network({
      [target]: { location: "http://169.254.169.254/latest/meta-data/" },
      "http://169.254.169.254/latest/meta-data/": { body: "credentials" },
    });
    process.env["CLOUDMP3_SERVICE_URL"] = "http://127.0.0.1:8090";
    process.env["CLOUDMP3_SERVICE_KEY"] = "service-key";

    const response = await proxyServiceDownload(
      123,
      "original",
      "high",
      new AbortController().signal,
    );

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("The original-file service is unreachable.");
    expect(requested).toEqual([target]);
  });
});
