import { estimateBytes } from "./audio-size";
import type { Format } from "./convert";

/**
 * Where a download is actually produced.
 *
 * - `server`: the Python service runs FFmpeg (ZIP, WAV, and MP3 at 256kbps and up
 *   or too long to encode in a tab).
 * - `direct`: SoundCloud's own bytes are handed over, unconverted.
 * - `browser`: the tab decodes and re-encodes with lamejs.
 */
export type DownloadRoute = "server" | "direct" | "browser";

export type DownloadFormat = "original" | "stream" | "aac" | "mp3" | "wav";

export type RouteInput = {
  /** The format the visitor asked for, not the format SoundCloud serves. */
  format: DownloadFormat;
  /** Estimated output size in bytes, or 0 when nothing reports one. */
  estimatedBytes: number;
  /** Target bitrate for a re-encoded MP3; ignored for every other format. */
  bitrate?: number | null;
  /** A whole-archive request, which has no browser path at all. */
  isZip?: boolean;
  /** How long the track is, which is what a tab runs out of memory on. */
  durationMs?: number;
  /** False when this deployment has no audio service, so the tab is all there is. */
  serviceAvailable?: boolean;
};

/** MP3 output at or above this size is too big to buffer and encode in a tab. */
export const MP3_SERVER_THRESHOLD_BYTES = 7 * 1000 * 1000;

/** libmp3lame at these bitrates costs real CPU; a phone tab should not pay for it. */
export const MP3_SERVER_MIN_KBPS = 256;

/**
 * The longest track a tab is asked to convert when there is no audio service.
 * Conversion holds the whole decoded file at once — stereo 44.1kHz PCM is
 * 352,800 bytes a second, so five minutes is ~79 MB before the output is added.
 * That is already the most this deployment should put on somebody's phone.
 */
export const BROWSER_CONVERT_MAX_MS = 5 * 60_000;

/**
 * The one routing policy, shared by the track panel, a single homepage file and
 * a homepage batch.
 *
 * With the service running, a format that is FFmpeg's job stays FFmpeg's job:
 * nothing is quietly rebuilt in the tab as a different-sized file than the
 * visitor chose. With no service on this deployment there is nothing to hand the
 * job to, so the tab takes it for what it can hold, and the same answer is what
 * keeps a tile from being offered at all when the track is longer than that.
 */
export function selectDownloadRoute(input: RouteInput): DownloadRoute {
  const { format, estimatedBytes, bitrate, isZip, durationMs, serviceAvailable } = input;

  if (isZip) return "server";

  // Nothing to convert: hand over the artist's upload or the authorized stream as served.
  if (format === "original" || format === "stream" || format === "aac") return "direct";

  if (serviceAvailable === false) {
    return (durationMs ?? 0) <= BROWSER_CONVERT_MAX_MS ? "browser" : "server";
  }

  // 16-bit PCM is roughly eleven times the source size.
  if (format === "wav") return "server";

  // An MP3 that is high-bitrate or simply large stays on FFmpeg; a small one is
  // quick in the tab and saves the server a process.
  if ((bitrate ?? 0) >= MP3_SERVER_MIN_KBPS) return "server";
  if (estimatedBytes >= MP3_SERVER_THRESHOLD_BYTES) return "server";
  return "browser";
}

/**
 * The same policy for the quality picker's value, which knows a track's length
 * but nothing else: an original is handed over as served, a WAV or a
 * high-bitrate/large MP3 is FFmpeg's, and only a small MP3 is the tab's. Without
 * FFmpeg on the deployment the length alone decides.
 */
export function routeForChoice(
  format: Format,
  durationMs: number,
  serviceAvailable = true,
): DownloadRoute {
  if (format.startsWith("original")) return "direct";
  if (format === "wav") {
    return selectDownloadRoute({ format: "wav", estimatedBytes: 0, durationMs, serviceAvailable });
  }
  const kbps = Number(format.split("-")[1]);
  return selectDownloadRoute({
    format: "mp3",
    estimatedBytes: estimateBytes(durationMs, kbps),
    bitrate: kbps,
    durationMs,
    serviceAvailable,
  });
}

/**
 * Where a whole selection is produced, for the job-level events: the server's if
 * any one file is, and the tab's only when every file can be made there.
 */
export function routeForJob(
  format: Format,
  durations: number[],
  serviceAvailable = true,
): DownloadRoute {
  const routes = durations.map((duration) => routeForChoice(format, duration, serviceAvailable));
  if (routes.includes("server")) return "server";
  return routes.includes("direct") ? "direct" : "browser";
}
