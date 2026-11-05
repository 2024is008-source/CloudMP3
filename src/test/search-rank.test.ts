import { describe, expect, it } from "vitest";

import {
  baseTitle,
  classifyVersion,
  detectVersions,
  formatDuration,
  matchesTab,
  rankSearchItems,
  type SearchResult,
} from "@/lib/search-rank";

let nextId = 1;

function item(over: Partial<SearchResult> = {}): SearchResult {
  return {
    id: nextId++,
    kind: "track",
    title: "Shape of You",
    artist: "Ed Sheeran",
    duration: 233_000,
    track_count: 1,
    artwork_url: null,
    permalink_url: "https://soundcloud.com/example",
    verified: false,
    official: false,
    downloadable: true,
    playback_count: 1_000,
    category: "original",
    ...over,
  };
}

describe("version detection", () => {
  it.each([
    ["Shape of You (James Carter x Levi Remix)", "remix"],
    ["Shape of You (Slowed + Reverb)", "slowed"],
    ["shape of you (sped up)", "sped_up"],
    ["Shape of You (Nightcore)", "nightcore"],
    ["Shape of You (Reverb)", "reverb"],
    ["Shape of You - Bootleg", "bootleg"],
    ["Shape of You (Mashup)", "mashup"],
    ["Shape of You (Edit)", "edit"],
    ["Shape of You (Flip)", "flip"],
    ["Shape of You (Cover)", "cover"],
    ["Shape of You (Instrumental)", "instrumental"],
  ])("classifies %s as %s", (title, expected) => {
    expect(classifyVersion({ title })).toBe(expected);
  });

  it("uses tags and genre as signals, not only the title", () => {
    expect(classifyVersion({ title: "Shape of You", tags: "slowed" })).toBe("slowed");
    expect(classifyVersion({ title: "Shape of You", genre: "Nightcore" })).toBe("nightcore");
    expect(classifyVersion({ title: "Shape of You", tags: "deep house" })).toBe("original");
  });

  it("does not flag a plain title", () => {
    expect(detectVersions({ title: "Shape of You" })).toEqual([]);
  });

  it("strips version suffixes for exact comparisons", () => {
    expect(baseTitle("Shape of You (James Carter Remix)")).toBe("Shape of You");
    expect(baseTitle("Ed Sheeran - Shape of You")).toBe("Ed Sheeran - Shape of You");
  });
});

describe("search ranking", () => {
  it("puts the original above a first-listed remix", () => {
    const remix = item({
      title: "Shape of You (James Carter x Levi Remix)",
      artist: "James Carter Presents:",
      category: "remix",
      verified: true,
      playback_count: 45_000_000,
    });
    const original = item({ title: "Shape of You", artist: "Ed Sheeran", verified: true });
    const ranked = rankSearchItems("shape of you", [remix, original]);
    expect(ranked.map((r) => r.category)).toEqual(["original", "remix"]);
  });

  it("prefers an exact title and artist match over the same title by another artist", () => {
    const exact = item({ title: "Shape of You", artist: "Ed Sheeran" });
    const otherArtist = item({
      title: "Shape of You",
      artist: "Some Cover Band",
      playback_count: 9_000_000,
    });
    const ranked = rankSearchItems("shape of you ed sheeran", [otherArtist, exact]);
    expect(ranked[0]?.artist).toBe("Ed Sheeran");
  });

  it("ranks official alternatives above unofficial remixes, both below originals", () => {
    const weakOriginal = item({ title: "Ed Sheeran - Shape of You (Audio)", artist: "Ed Sheeran" });
    const officialRemix = item({
      title: "Shape of You (Remix)",
      category: "remix",
      official: true,
      verified: true,
    });
    const blogRemix = item({
      title: "Shape of You (Remix)",
      artist: "DJ Example",
      category: "remix",
    });
    const ranked = rankSearchItems("shape of you", [blogRemix, officialRemix, weakOriginal]);
    expect(ranked.map((r) => r.category)).toEqual(["original", "remix", "remix"]);
    expect(ranked[1]?.official).toBe(true);
    expect(ranked[2]?.official).toBe(false);
  });

  it("orders tiers: remix, slowed/sped, cover, playlist", () => {
    const remix = item({ title: "Song (Remix)", category: "remix" });
    const slowed = item({ title: "Song (Slowed)", category: "slowed" });
    const cover = item({ title: "Song (Cover)", category: "cover" });
    const playlist = item({
      kind: "playlist",
      title: "Song",
      category: "playlist",
      track_count: 12,
    });
    const ranked = rankSearchItems("song", [playlist, cover, slowed, remix]);
    expect(ranked.map((r) => (r.kind === "playlist" ? "playlist" : r.category))).toEqual([
      "remix",
      "slowed",
      "cover",
      "playlist",
    ]);
  });

  it("removes duplicate ids and duplicate uploads", () => {
    const a = item({ id: 42, playback_count: 10 });
    const b = item({ id: 42, playback_count: 10 });
    const sameUpload = item({
      id: 43,
      title: "Shape of You",
      artist: "Ed Sheeran",
      playback_count: 5,
    });
    const ranked = rankSearchItems("shape of you", [a, b, sameUpload]);
    expect(ranked).toHaveLength(1);
  });

  it("prefers verified, official and popular tracks within a tier", () => {
    const plain = item({ title: "Shape of You", artist: "Ed Sheeran" });
    const verified = item({
      title: "Shape of You",
      artist: "Ed Sheeran",
      verified: true,
      official: true,
    });
    const ranked = rankSearchItems("shape of you", [plain, verified]);
    expect(ranked[0]?.verified).toBe(true);
  });
});

describe("tab filtering", () => {
  const original = item({ category: "original" });
  const remix = item({ category: "remix" });
  const slowed = item({ category: "slowed" });
  const cover = item({ category: "cover" });
  const playlist = item({ kind: "playlist", category: "playlist" });

  it("original excludes all alternative versions", () => {
    expect(matchesTab(original, "original")).toBe(true);
    for (const alt of [remix, slowed, cover, playlist]) {
      expect(matchesTab(alt, "original")).toBe(false);
    }
  });

  it("remixes includes remixes and pitched versions but not covers", () => {
    expect(matchesTab(remix, "remixes")).toBe(true);
    expect(matchesTab(slowed, "remixes")).toBe(true);
    expect(matchesTab(cover, "remixes")).toBe(false);
    expect(matchesTab(original, "remixes")).toBe(false);
  });

  it("covers, playlists and all behave", () => {
    expect(matchesTab(cover, "covers")).toBe(true);
    expect(matchesTab(remix, "covers")).toBe(false);
    expect(matchesTab(playlist, "playlists")).toBe(true);
    expect(matchesTab(original, "playlists")).toBe(false);
    expect(matchesTab(original, "all")).toBe(true);
    expect(matchesTab(playlist, "all")).toBe(true);
  });
});

describe("formatDuration", () => {
  it("formats minutes and hours", () => {
    expect(formatDuration(233_000)).toBe("3:53");
    expect(formatDuration(3_723_000)).toBe("1:02:03");
    expect(formatDuration(0)).toBe("0:00");
  });
});
