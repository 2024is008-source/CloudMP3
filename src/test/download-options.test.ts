import { describe, expect, it } from "vitest";

import { buildDownloadOptions, canDownload, extLabel } from "@/lib/download-options";
import type { TrackDetails } from "@/lib/soundcloud.server";
import type { OriginalInfo, TrackFormats } from "@/lib/track-formats";

function makeTrack(overrides: Partial<TrackDetails> = {}): TrackDetails {
  return {
    id: 123,
    title: "Example",
    artist: "Artist",
    uploader: "Artist",
    artist_url: null,
    artist_avatar: null,
    verified: false,
    permalink_url: "https://soundcloud.com/artist/example",
    artwork_url: null,
    duration: 200_000,
    full_duration: 200_000,
    genre: null,
    tags: [],
    release_date: null,
    created_at: null,
    label_name: null,
    playback_count: null,
    likes_count: null,
    policy: null,
    streamable: true,
    downloadAllowed: true,
    previewAllowed: true,
    snippet: false,
    official: false,
    category: "original",
    source: {
      preset: "aac_160k",
      codec: "AAC",
      bitrate: 160,
      protocol: "hls",
      mime: "audio/mp4",
    },
    variants: [
      { preset: "aac_160k", codec: "AAC", bitrate: 160, protocol: "hls", mime: "audio/mp4" },
      { preset: "aac_96k", codec: "AAC", bitrate: 96, protocol: "hls", mime: "audio/mp4" },
    ],
    publisher: null,
    ...overrides,
  };
}

function makeFormats(original: OriginalInfo, wav = true): TrackFormats {
  return {
    configured: true,
    trackId: 123,
    original,
    streams: [
      { preset: "aac_160k", codec: "AAC", ext: "m4a", bitrate: 160, protocol: "hls" },
      { preset: "aac_96k", codec: "AAC", ext: "m4a", bitrate: 96, protocol: "hls" },
    ],
    wavConversion: { available: wav, source: null },
    account: { configured: true },
  };
}

const unavailable: OriginalInfo = {
  available: false,
  reason: "not-enabled",
  message: "The artist did not enable downloads.",
};

describe("download options", () => {
  it("never offers an original when the service reports it unavailable", () => {
    const options = buildDownloadOptions(makeTrack(), makeFormats(unavailable));
    expect(options.some((option) => option.kind === "original")).toBe(false);
    expect(options.some((option) => option.label.startsWith("Original"))).toBe(false);
  });

  it("offers exactly one original with the real extension, codec and byte size", () => {
    const options = buildDownloadOptions(
      makeTrack(),
      makeFormats({
        available: true,
        ext: "wav",
        codec: "PCM (WAV)",
        mime: "audio/wav",
        bytes: 58_210_304,
        filename: "Example.wav",
        bitrate: null,
      }),
    );
    const originals = options.filter((option) => option.kind === "original");
    expect(originals).toHaveLength(1);
    expect(originals[0]).toMatchObject({
      value: "original",
      label: "Original WAV",
      ext: "wav",
      bytes: 58_210_304,
    });
  });

  it("only lists the extension SoundCloud actually serves", () => {
    const options = buildDownloadOptions(
      makeTrack(),
      makeFormats({
        available: true,
        ext: "wav",
        codec: "PCM (WAV)",
        mime: "audio/wav",
        bytes: 10,
        filename: null,
        bitrate: null,
      }),
    );
    const labels = options.map((option) => option.label);
    expect(labels.filter((label) => label.startsWith("Original"))).toEqual(["Original WAV"]);
    for (const other of ["Original FLAC", "Original AIFF", "Original AAC", "Original MP3"]) {
      expect(labels).not.toContain(other);
    }
  });

  it("labels browser and FFmpeg WAV conversions distinctly", () => {
    const ffmpeg = buildDownloadOptions(makeTrack(), makeFormats(unavailable, true));
    const browser = buildDownloadOptions(makeTrack(), makeFormats(unavailable, false));

    const ffmpegWav = ffmpeg.filter((option) => option.kind === "wav-ffmpeg");
    expect(ffmpegWav).toHaveLength(1);
    expect(ffmpegWav[0]!.label).toBe("Converted WAV");

    const browserWav = browser.filter((option) => option.kind === "wav-browser");
    expect(browserWav).toHaveLength(1);
    expect(browserWav[0]!.label).toBe("Converted WAV");

    expect(ffmpeg.filter((option) => option.ext === "wav")).toHaveLength(1);
    expect(browser.filter((option) => option.ext === "wav")).toHaveLength(1);
  });

  it("lists the MP3 conversion bitrates without extra labels", () => {
    const options = buildDownloadOptions(makeTrack(), makeFormats(unavailable));
    const mp3 = options.filter((option) => option.kind === "mp3");
    expect(mp3.map((option) => option.label)).toEqual([
      "MP3 320 kbps",
      "MP3 256 kbps",
      "MP3 192 kbps",
    ]);
  });

  it("offers only the best real stream", () => {
    const options = buildDownloadOptions(makeTrack(), makeFormats(unavailable));
    const streams = options.filter((option) => option.kind === "stream");
    expect(streams.map((option) => option.value)).toEqual(["stream-high"]);
    expect(streams[0]!.label).toBe("AAC 160 kbps");
  });
});

describe("extLabel", () => {
  it("maps container extensions to the codec users recognise", () => {
    expect(extLabel("m4a", "AAC")).toBe("AAC");
    expect(extLabel("aif", "AIFF (PCM)")).toBe("AIFF");
    expect(extLabel("aiff", "AIFF")).toBe("AIFF");
    expect(extLabel("wav", "PCM (WAV)")).toBe("WAV");
    expect(extLabel("flac", "FLAC")).toBe("FLAC");
    expect(extLabel("mp3", "MP3")).toBe("MP3");
  });
});

describe("canDownload", () => {
  it("requires either an authorized stream or a confirmed original", () => {
    expect(canDownload(makeTrack({ downloadAllowed: false }), null)).toBe(false);
    expect(canDownload(makeTrack({ downloadAllowed: false }), makeFormats(unavailable))).toBe(
      false,
    );
    expect(
      canDownload(
        makeTrack({ downloadAllowed: false }),
        makeFormats({
          available: true,
          ext: "flac",
          codec: "FLAC",
          mime: "audio/flac",
          bytes: 1,
          filename: null,
          bitrate: null,
        }),
      ),
    ).toBe(true);
  });
});
