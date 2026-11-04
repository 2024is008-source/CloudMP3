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
    mp3Conversion: { available: wav, bitrates: [128, 192, 256, 320], source: null },
    account: { configured: true },
  };
}

/** The state a deployment without the audio service reports. */
function offlineFormats(): TrackFormats {
  return {
    configured: false,
    trackId: 123,
    original: {
      available: false,
      reason: "service-unconfigured",
      message: "Original-file access isn't configured on this deployment.",
    },
    streams: [],
    wavConversion: { available: false, source: null },
    mp3Conversion: { available: false, bitrates: [], source: null },
    account: { configured: false },
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

  it("offers one plain WAV entry, whichever pipeline is configured", () => {
    const ffmpeg = buildDownloadOptions(makeTrack(), makeFormats(unavailable, true));
    const browser = buildDownloadOptions(makeTrack(), makeFormats(unavailable, false));

    // WAV is FFmpeg's job and there is no second implementation for when it is
    // missing, so the option says the same thing either way.
    for (const options of [ffmpeg, browser]) {
      const wav = options.filter((option) => option.kind === "wav");
      expect(wav).toHaveLength(1);
      expect(wav[0]!.label).toBe("WAV");
      expect(options.filter((option) => option.ext === "wav")).toHaveLength(1);
    }
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

  it("does not offer the AAC stream as a format", () => {
    const options = buildDownloadOptions(makeTrack(), makeFormats(unavailable));
    expect(options.some((option) => option.kind === "stream")).toBe(false);
    expect(options.some((option) => option.ext === "m4a")).toBe(false);
    expect(options.map((option) => option.label)).toEqual([
      "MP3 320 kbps",
      "MP3 256 kbps",
      "MP3 192 kbps",
      "WAV",
    ]);
  });

  it("offers a stream as it is when it already is an MP3", () => {
    const options = buildDownloadOptions(
      makeTrack({
        variants: [
          {
            preset: "mp3_0_0",
            codec: "MP3",
            bitrate: 128,
            protocol: "progressive",
            mime: "audio/mpeg",
          },
        ],
      }),
      offlineFormats(),
    );
    expect(options.find((option) => option.kind === "stream")).toMatchObject({
      value: "stream-high",
      label: "MP3 128 kbps",
      ext: "mp3",
    });
  });

  it("drops the formats only the audio service could produce", () => {
    const options = buildDownloadOptions(makeTrack(), offlineFormats());

    // 200 s at 192 kbps is 4.8 MB, so the tab can encode that one; 256, 320 and
    // WAV are FFmpeg's, and a tile for them would only fail.
    expect(options.map((option) => option.label)).toEqual(["MP3 192 kbps"]);
  });

  it("falls back to the stream when nothing else can be made without the service", () => {
    const options = buildDownloadOptions(makeTrack({ duration: 400_000 }), offlineFormats());

    // 400 s passes the tab's size ceiling at every bitrate, so the only file
    // this deployment can hand over is what SoundCloud already serves.
    expect(options.map((option) => option.label)).toEqual(["AAC 160 kbps"]);
  });

  it("keeps every format once the service is configured", () => {
    const offline = buildDownloadOptions(makeTrack(), offlineFormats()).map((o) => o.value);
    const online = buildDownloadOptions(makeTrack(), makeFormats(unavailable)).map((o) => o.value);

    expect(online.length).toBeGreaterThan(offline.length);
    expect(online).toContain("mp3-256");
    expect(online).toContain("wav");
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
