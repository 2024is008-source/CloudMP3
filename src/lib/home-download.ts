/**
 * The homepage's two ways of finishing one file, and the shared policy that
 * picks between them. Kept apart from the route so the routing of a single
 * download and of a batch is testable without rendering the page.
 */

import { convert, type Format } from "./convert";
import { downloadFailure, filenameFromHeaders, readResponse } from "./download-http";
import { routeForChoice, type DownloadRoute } from "./download-router";
import type { DownloadMethod } from "./analytics";
import { fetchCover, tagMp3 } from "./id3";

export type HomeTrack = {
  id: number;
  title: string;
  artist: string;
  duration: number;
  artwork_url: string | null;
};

/** One finished file, wherever it was produced. */
export type Picked = {
  data: BlobPart;
  ext: string;
  mime: string;
  bytes: number;
  method: DownloadMethod;
  filename: string | null;
};

/** Where one homepage file is produced, from the same table as the track page. */
export function routeForTrack(track: HomeTrack, quality: Format): DownloadRoute {
  return routeForChoice(quality, track.duration);
}

/**
 * FFmpeg's route: the service converts on disk and answers only once the file is
 * ready, so the tab holds exactly one copy — the one it is saving.
 */
export async function fetchFromServer(
  track: HomeTrack,
  fmt: Format,
  signal: AbortSignal,
): Promise<Picked> {
  const target = fmt === "wav" ? "mode=wav" : `mode=mp3&bitrate=${fmt.slice(4)}`;
  const res = await fetch(`/api/public/track?id=${track.id}&q=high&${target}`, { signal });
  // Every failure, including a service that is not configured here, stays an
  // honest error: a server-only format is never rebuilt in the tab.
  if (!res.ok) throw await downloadFailure(res);
  const ext = res.headers.get("X-File-Ext") || (fmt === "wav" ? "wav" : "mp3");
  const data = await readResponse(res, () => {}, signal);
  return {
    data: data as BlobPart,
    ext,
    mime: res.headers.get("Content-Type") || (fmt === "wav" ? "audio/wav" : "audio/mpeg"),
    bytes: data.length,
    method: "server",
    filename: filenameFromHeaders(res),
  };
}

/** The tab's route, and the unconverted hand-over of a stream or original. */
export async function fetchInTab(
  track: HomeTrack,
  fmt: Format,
  album: string | undefined,
  trackNumber: number | undefined,
  signal: AbortSignal,
): Promise<Picked> {
  const q = fmt === "original-low" ? "low" : "high";
  const r = await fetch(`/api/public/track?id=${track.id}&q=${q}`, { signal });
  if (!r.ok) throw await downloadFailure(r);
  const raw = new Uint8Array(await r.arrayBuffer());
  const out = await convert(raw, r.headers.get("X-File-Ext") ?? "m4a", fmt, () => {
    // Decode and encode are chunked precisely so a cancel can interrupt them.
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  });
  let data = out.data;
  if (out.ext === "mp3") {
    const cover = await fetchCover(track.artwork_url);
    data = tagMp3(out.data, {
      title: track.title,
      artist: track.artist,
      album,
      track: trackNumber,
      cover,
    });
  }
  return {
    data: data as BlobPart,
    ext: out.ext,
    mime: out.mime,
    bytes: data.length,
    method: fmt.startsWith("original") ? "direct" : "browser",
    filename: null,
  };
}

/**
 * Finish one file the way the shared policy says. There is no second guess here:
 * the route is chosen once and either it works or the caller reports why not.
 */
export async function downloadTrackFile(
  track: HomeTrack,
  quality: Format,
  meta: { album?: string | undefined; number?: number | undefined },
  signal: AbortSignal,
): Promise<{ route: DownloadRoute; file: Picked }> {
  const route = routeForTrack(track, quality);
  const file =
    route === "server"
      ? await fetchFromServer(track, quality, signal)
      : await fetchInTab(track, quality, meta.album, meta.number, signal);
  return { route, file };
}
