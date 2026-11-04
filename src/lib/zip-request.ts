import { z } from "zod";

import type { Format } from "./convert";

/** One track inside a server-built ZIP, in the shape the audio service takes. */
export type ZipTrackRequest = {
  id: number;
  mode: "original" | "mp3" | "wav";
  quality: "high" | "low";
  bitrate?: number;
};

export type ZipRequest = {
  name: string;
  tracks: ZipTrackRequest[];
};

const MP3_BITRATES = [128, 192, 256, 320];

/** The ceiling on one ZIP request body, the same the audio service applies. */
export const ZIP_BODY_MAX_BYTES = 1024 * 1024;

/**
 * The most tracks this site will even look at.
 *
 * A ZIP request is only a list of ids, so a body at the size ceiling can carry
 * tens of thousands of them and validating a list that long costs far more than
 * the largest archive could ever be worth. The audio service applies its own,
 * much lower limit; this one exists to stop a request that big being parsed.
 */
export const ZIP_TRACKS_MAX = 500;

/** The format half of a ZIP track request: what the server should produce. */
export type ZipSelection = Pick<ZipTrackRequest, "mode" | "quality" | "bitrate">;

/**
 * The homepage's quality picker, translated for the server. The ZIP is packed by
 * the audio service, so every format has to become a mode it can produce.
 */
export function zipSelection(format: Format): ZipSelection {
  if (format === "original-high") return { mode: "original", quality: "high" };
  if (format === "original-low") return { mode: "original", quality: "low" };
  if (format === "wav") return { mode: "wav", quality: "high" };
  const bitrate = Number(format.split("-")[1]);
  return {
    mode: "mp3",
    quality: "high",
    bitrate: MP3_BITRATES.includes(bitrate) ? bitrate : 320,
  };
}

/** The POST body for one ZIP: every track in playlist order, in the chosen format. */
export function zipRequestBody(
  name: string,
  tracks: readonly { id: number }[],
  format: Format,
): ZipRequest {
  return {
    name: name.trim() || "CloudMP3-Playlist",
    tracks: tracks.map((track) => ({ id: track.id, ...zipSelection(format) })),
  };
}

/** What the public ZIP route accepts from a browser before it reaches the service. */
export const zipRequestSchema = z.object({
  name: z.string().trim().max(160).optional(),
  tracks: z
    .array(
      z.object({
        id: z.number().int().positive(),
        mode: z.enum(["original", "mp3", "wav"]).default("original"),
        quality: z.enum(["high", "low"]).default("high"),
        bitrate: z
          .number()
          .int()
          .refine((v) => MP3_BITRATES.includes(v), "bad bitrate")
          .optional(),
      }),
    )
    .min(1),
});

export type ParsedZipRequest = z.infer<typeof zipRequestSchema>;

/**
 * A rejected request named by position, not by the schema's path: a visitor can
 * act on "track 3", but `tracks.2.bitrate` is our own vocabulary.
 */
export function zipRequestReason(issues: { path: (string | number)[]; message: string }[]): string {
  const [first] = issues;
  if (!first) return "The ZIP request was not valid.";
  const [head, index] = first.path;
  if (head === "tracks" && typeof index === "number")
    return `Track ${index + 1}: ${first.message}.`;
  if (head === "name") return `The archive name: ${first.message}.`;
  return first.message;
}

/**
 * True for a list too long to be worth validating.
 *
 * Measured on this schema: 20,000 track objects cost about 95 ms and 30 MB of a
 * single-threaded Node process, and the size ceiling lets in even more. The count
 * is read off the parsed JSON before the schema touches it, so the cost of a
 * refusal stays the cost of counting.
 */
export function tooManyTracks(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const tracks = (payload as { tracks?: unknown }).tracks;
  return Array.isArray(tracks) && tracks.length > ZIP_TRACKS_MAX;
}
