import type { TrackDetails } from "./soundcloud.server";
import type { StreamInfo, TrackFormats } from "./track-formats";

export const WAV_KBPS = 1411;

export type OptionKind = "original" | "stream" | "mp3" | "wav";

export type DownloadOption = {
  value: string;
  label: string;
  /** Real bitrate, or null when the source doesn't report one. */
  kbps: number | null;
  /** Exact size when SoundCloud reported it (originals). */
  bytes: number | null;
  kind: OptionKind;
  quality: "high" | "low";
  ext: string;
};

export function extLabel(ext: string, codec?: string | null): string {
  const upper = (codec ?? "").toUpperCase();
  if (upper.startsWith("AAC")) return "AAC";
  if (upper.startsWith("AIFF")) return "AIFF";
  return ext.toUpperCase();
}

function bestStream(track: TrackDetails, formats: TrackFormats | null): StreamInfo | null {
  const reported = formats?.configured ? formats.streams : [];
  if (reported.length > 0) {
    return [...reported].sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0] ?? null;
  }
  const variant = [...track.variants].sort((a, b) => b.bitrate - a.bitrate)[0];
  if (!variant) return null;
  return {
    preset: variant.preset,
    codec: variant.codec,
    ext: variant.codec === "AAC" ? "m4a" : "mp3",
    bitrate: variant.bitrate,
    protocol: variant.protocol,
  };
}

/**
 * Only formats that actually exist become options. The "Original" entry comes
 * from the service's confirmed download format, never from the title or a
 * WAV-extension transcoding.
 */
export function buildDownloadOptions(
  track: TrackDetails,
  formats: TrackFormats | null,
): DownloadOption[] {
  const options: DownloadOption[] = [];
  const original = formats?.original;

  if (original?.available) {
    options.push({
      value: "original",
      label: `Original ${extLabel(original.ext, original.codec)}`,
      kbps: original.bitrate,
      bytes: original.bytes,
      kind: "original",
      quality: "high",
      ext: original.ext,
    });
  }

  const stream = bestStream(track, formats);

  if (stream) {
    options.push({
      value: "stream-high",
      label: stream.bitrate ? `${stream.codec} ${stream.bitrate} kbps` : stream.codec,
      kbps: stream.bitrate,
      bytes: null,
      kind: "stream",
      quality: "high",
      ext: stream.ext,
    });

    for (const kbps of [320, 256, 192]) {
      options.push({
        value: `mp3-${kbps}`,
        label: `MP3 ${kbps} kbps`,
        kbps,
        bytes: null,
        kind: "mp3",
        quality: "high",
        ext: "mp3",
      });
    }

    options.push({
      value: "wav",
      label: "WAV",
      kbps: WAV_KBPS,
      bytes: null,
      kind: "wav",
      quality: "high",
      ext: "wav",
    });
  }

  return options;
}

export function canDownload(track: TrackDetails, formats: TrackFormats | null): boolean {
  return track.downloadAllowed || formats?.original.available === true;
}
