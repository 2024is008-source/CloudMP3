import { describe, expect, it } from "vitest";
import { buildId3, tagMp3 } from "@/lib/id3";

const has = (b: Uint8Array, s: string) => new TextDecoder("latin1").decode(b).includes(s);

describe("ID3 tagging", () => {
  it("writes an ID3v2.3 header with title, artist and cover frames", () => {
    const tag = buildId3({ title: "Song", artist: "Me", cover: { data: new Uint8Array([1, 2]), mime: "image/jpeg" } });
    expect([...tag.slice(0, 4)]).toEqual([0x49, 0x44, 0x33, 3]);
    expect(has(tag, "TIT2")).toBe(true);
    expect(has(tag, "TPE1")).toBe(true);
    expect(has(tag, "APIC")).toBe(true);
    const size = (tag[6]! << 21) | (tag[7]! << 14) | (tag[8]! << 7) | tag[9]!;
    expect(size).toBe(tag.length - 10);
  });
  it("puts the tag before the MP3 audio", () => {
    const out = tagMp3(new Uint8Array([0xff, 0xfb]), { title: "a", artist: "b" });
    expect([...out.slice(-2)]).toEqual([0xff, 0xfb]);
  });
});
