import { estimateBytes } from "./audio-size";
import { selectDownloadRoute } from "./download-router";
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

/** The best stream, optionally restricted to one codec. */
function bestStream(
  track: TrackDetails,
  formats: TrackFormats | null,
  codec?: "AAC" | "MP3",
): StreamInfo | null {
  const reported = (formats?.configured ? formats.streams : []).filter(
    (stream) => codec === undefined || stream.codec === codec,
  );
  if (reported.length > 0) {
    return [...reported].sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0] ?? null;
  }
  const variant = [...track.variants]
    .filter((entry) => codec === undefined || entry.codec === codec)
    .sort((a, b) => b.bitrate - a.bitrate)[0];
  if (!variant) return null;
  return {
    preset: variant.preset,
    codec: variant.codec,
    ext: variant.codec === "AAC" ? "m4a" : "mp3",
    bitrate: variant.bitrate,
    protocol: variant.protocol,
  };
}

function streamOption(stream: StreamInfo): DownloadOption {
  return {
    value: "stream-high",
    label: stream.bitrate ? `${stream.codec} ${stream.bitrate} kbps` : stream.codec,
    kbps: stream.bitrate,
    bytes: null,
    kind: "stream",
    quality: "high",
    ext: stream.ext,
  };
}

/**
 * Whether only the audio service can produce this file.
 *
 * The question is asked the way the download itself asks it, so a tile cannot
 * promise a format the deployment has no way to make.
 */
function needsService(option: DownloadOption, durationMs: number): boolean {
  return (
    selectDownloadRoute({
      format: option.kind,
      estimatedBytes: estimateBytes(durationMs, option.kbps ?? 0),
      bitrate: option.kbps,
    }) === "server"
  );
}

/**
 * Only formats that actually exist become options. The "Original" entry comes
 * from the service's confirmed download format, never from the title or a
 * WAV-extension transcoding, and a format that is the service's job appears only
 * while the service is configured — the alternative is a tile that fails.
 * AAC is not a format the panel offers: it is what SoundCloud streams, not what
 * a visitor came here to collect.
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

  const source = bestStream(track, formats);
  const mp3Stream = bestStream(track, formats, "MP3");

  if (source) {
    // A stream is offered as it is only when it already is an MP3. SoundCloud
    // serves most audio as AAC, and a tile for that hands over a .m4a.
    if (mp3Stream) options.push(streamOption(mp3Stream));

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

  if (formats?.configured === true) return options;

  const usable = options.filter((entry) => !needsService(entry, track.duration));
  // Too long for the tab to encode, with no audio service to take it instead,
  // leaves nothing but the source itself. An honest AAC tile beats a panel that
  // offers no file at all.
  if (usable.length === 0 && source) usable.push(streamOption(source));
  return usable;
}

export function canDownload(track: TrackDetails, formats: TrackFormats | null): boolean {
  return track.downloadAllowed || formats?.original.available === true;
}
