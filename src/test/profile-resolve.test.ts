import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveUrl } from "@/lib/soundcloud.server";

type Stub = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
};

const json = (body: unknown): Stub => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const text = (body: string): Stub => ({
  ok: true,
  status: 200,
  json: async () => ({}),
  text: async () => body,
});

const user = {
  kind: "user",
  id: 7,
  username: "The Peak: EDM",
  permalink: "soundcloud-the-peak",
  avatar_url: "https://i1.sndcdn.com/avatars-000599540127-vevupo-large.jpg",
};

const track = (id: number, title: string, duration: number) => ({
  kind: "track",
  id,
  title,
  duration,
  permalink_url: `https://soundcloud.com/soundcloud-the-peak/${title}`,
  user: { username: "The Peak: EDM" },
  artwork_url: null,
});

const set = (id: number, title: string, track_count: number) => ({
  kind: "playlist",
  id,
  title,
  track_count,
  permalink_url: `https://soundcloud.com/soundcloud-the-peak/sets/${title}`,
  artwork_url: null,
});

function stubApi(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const fetchStub = vi.fn(async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    const u = new URL(url);
    if (u.hostname === "soundcloud.com")
      return text('<script crossorigin src="https://sc.example/app.js"></script>');
    if (u.hostname === "sc.example") return text(`client_id = "${"a".repeat(32)}";`);
    for (const [path, body] of Object.entries(routes)) {
      if (u.pathname.endsWith(path)) return json(typeof body === "function" ? body(u) : body);
    }
    throw new Error(`unstubbed request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchStub);
  return calls;
}

describe("resolveUrl", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("turns an artist profile link into uploads plus a playlist list", async () => {
    const calls = stubApi({
      "/resolve": user,
      "/users/7/tracks": {
        collection: [track(1, "one", 60_000), track(2, "two", 30_000)],
        next_href: null,
      },
      "/users/7/playlists": (u: URL) =>
        u.searchParams.get("offset") === "50"
          ? { collection: [set(11, "second", 5)], next_href: null }
          : {
              collection: [set(10, "first", 3)],
              next_href: "https://api-v2.soundcloud.com/users/7/playlists?offset=50&limit=50",
            },
    });

    const r = await resolveUrl(
      "https://soundcloud.com/soundcloud-the-peak?utm_source=clipboard&utm_medium=text",
    );
    if (r.type !== "profile") throw new Error(`expected profile, got ${r.type}`);

    expect(r.title).toBe("The Peak: EDM");
    expect(r.creator).toBe("@soundcloud-the-peak");
    expect(r.track_count).toBe(2);
    expect(r.total_duration).toBe(90_000);
    expect(r.artwork_url).toBe("https://i1.sndcdn.com/avatars-000599540127-vevupo-t500x500.jpg");
    expect(r.tracks.map((t) => t.title)).toEqual(["one", "two"]);
    expect(r.sets.map((s) => [s.title, s.track_count])).toEqual([
      ["first", 3],
      ["second", 5],
    ]);
    expect(r.more_uploads).toBe(false);
    expect(calls.some((c) => c.includes("/users/7/playlists?offset=50"))).toBe(true);
  });

  it("lists no uploads when the profile only publishes playlists", async () => {
    stubApi({
      "/resolve": user,
      "/users/7/tracks": { collection: [], next_href: null },
      "/users/7/playlists": { collection: [set(10, "first", 3)], next_href: null },
    });

    const r = await resolveUrl("https://soundcloud.com/soundcloud-the-peak");
    if (r.type !== "profile") throw new Error(`expected profile, got ${r.type}`);

    expect(r.tracks).toEqual([]);
    expect(r.track_count).toBe(0);
    expect(r.total_duration).toBe(0);
    expect(r.sets).toHaveLength(1);
  });

  it("names the page type when a link is neither track, playlist nor profile", async () => {
    stubApi({ "/resolve": { kind: "reposts", id: 99 } });

    await expect(resolveUrl("https://soundcloud.com/soundcloud-the-peak/reposts")).rejects.toThrow(
      /That's a reposts page, not a track or playlist/,
    );
  });

  it("still resolves a single track link", async () => {
    stubApi({ "/resolve": track(1, "one", 60_000) });

    const r = await resolveUrl("https://soundcloud.com/soundcloud-the-peak/one");
    expect(r.type).toBe("track");
    expect(r.track_count).toBe(1);
    expect(r.tracks[0]?.artist).toBe("The Peak: EDM");
  });
});
