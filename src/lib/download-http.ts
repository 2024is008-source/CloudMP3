/**
 * The browser side of a streamed download response, shared by the track panel
 * and the homepage ZIP. Nothing here knows about SoundCloud or conversion.
 */

export function safeName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "_");
}

export function totalFromHeaders(res: Response): number | null {
  const length = Number(res.headers.get("Content-Length"));
  if (Number.isFinite(length) && length > 0) return length;
  const estimate = Number(res.headers.get("X-Total-Bytes"));
  return Number.isFinite(estimate) && estimate > 0 ? estimate : null;
}

export type Progress = (received: number, total: number | null) => void;

/** Read a body chunk by chunk so the page can show real byte progress. */
async function readChunks(
  res: Response,
  onProgress: Progress,
  signal: AbortSignal,
): Promise<Uint8Array[]> {
  const total = totalFromHeaders(res);
  if (!res.body) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    onProgress(bytes.length, total ?? bytes.length);
    return [bytes];
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    if (signal.aborted) {
      await reader.cancel();
      throw new DOMException("Aborted", "AbortError");
    }
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.length;
      onProgress(received, total);
    }
  }
  // A stream that declares no length only reaches 100% once it is finished.
  if (total === null) onProgress(received, received);
  return chunks;
}

export async function readResponse(
  res: Response,
  onProgress: Progress,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const chunks = await readChunks(res, onProgress, signal);
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * The same stream, handed over as a Blob instead of one concatenated buffer.
 * A whole-playlist archive can run to a gigabyte and a tab must not hold two
 * copies of it, so the chunks go straight into the Blob while still reporting
 * byte progress as they arrive.
 */
export async function blobFromResponse(
  res: Response,
  onProgress: Progress,
  signal: AbortSignal,
): Promise<Blob> {
  const type = res.headers.get("Content-Type")?.split(";")[0] || "application/octet-stream";
  const chunks = await readChunks(res, onProgress, signal);
  return new Blob(chunks as BlobPart[], { type });
}

export function filenameFromHeaders(res: Response): string | null {
  const direct = res.headers.get("X-Filename");
  if (direct) {
    try {
      return decodeURIComponent(direct);
    } catch {
      /* ignore */
    }
  }
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (encoded?.[1]) {
    try {
      return decodeURIComponent(encoded[1]);
    } catch {
      /* ignore */
    }
  }
  const plain = /filename="([^"]+)"/i.exec(disposition);
  return plain?.[1] ?? null;
}

export function withExtension(name: string, ext: string): string {
  const cleaned = safeName(name);
  return /\.[a-z0-9]{1,6}$/i.test(cleaned) ? cleaned : `${cleaned}.${ext}`;
}

export async function errorText(res: Response): Promise<string> {
  const raw = (await res.text().catch(() => "")).trim();
  return friendlyText(raw, res.status);
}

/** A download failure that still carries the status it arrived with. */
export type DownloadFailure = Error & { status?: number };

/**
 * The one way a response becomes a failure.
 *
 * Throwing this instead of a bare `Error` keeps the status with the problem, so
 * analytics can count a rate limit apart from a gateway outage and a caller can
 * tell a refusal apart from a transport failure without reading prose.
 */
export async function downloadFailure(res: Response): Promise<DownloadFailure> {
  const error: DownloadFailure = new Error(await errorText(res));
  error.status = res.status;
  return error;
}

/** What the visitor sees when the request never reached a working service. */
const NETWORK_MESSAGE = "Couldn't reach the download service. Try again in a moment.";

const STATUS_MESSAGE: Record<number, string> = {
  400: "SoundCloud didn't accept this request.",
  401: "The download service isn't authorised on this deployment.",
  403: "This track isn't available for download.",
  404: "SoundCloud has no track with this id.",
  408: "The download took too long and was cancelled.",
  409: "SoundCloud isn't providing a downloadable file for this track.",
  413: "That is larger than this server allows. Try fewer tracks or a lower bitrate.",
  422: "That request wasn't in the form the download service expects.",
  429: "Too many downloads at once. Try again in a moment.",
  500: "The download service failed. Try again in a moment.",
  502: "The download service couldn't reach SoundCloud. Try again in a moment.",
  503: "The conversion service isn't available on this deployment.",
  504: "The download took too long and was cancelled.",
  507: "The download service ran out of space. Try fewer tracks.",
};

/**
 * A sentence the visitor can act on, never the response as it arrived.
 *
 * Our own proxy answers failures with one plain line, so that is passed through;
 * anything else is replaced by the meaning of the status code. A JSON body is
 * read only for the one field our service writes (`error.message`) or for a
 * plain-string `detail`: FastAPI's validation body is a list of internal field
 * paths, a gateway's is a stack trace, and neither belongs on a screen.
 */
export function friendlyText(raw: string, status: number): string {
  const fallback = STATUS_MESSAGE[status] ?? NETWORK_MESSAGE;
  if (!raw) return fallback;
  if (raw.startsWith("{") || raw.startsWith("[")) {
    const message = jsonMessage(raw);
    return message ? message.slice(0, 240) : fallback;
  }
  // An HTML error page or a multi-line dump belongs to somebody else's stack.
  if (raw.startsWith("<") || raw.length > 240 || raw.includes("\n")) return fallback;
  return raw;
}

function jsonMessage(raw: string): string {
  try {
    const body = JSON.parse(raw) as { error?: { message?: unknown }; detail?: unknown };
    const nested = body.error && typeof body.error === "object" ? body.error.message : undefined;
    if (typeof nested === "string" && nested.trim()) return nested.trim();
    // Only a string detail is prose meant for a reader; a list of validation
    // errors names our own field paths.
    return typeof body.detail === "string" ? body.detail.trim() : "";
  } catch {
    return "";
  }
}

/**
 * True for the error a cancelled fetch or stream throws.
 *
 * Checked by name rather than by class: a browser's DOMException is not an Error,
 * so `instanceof` would read a visitor's own cancellation as a service failure.
 */
export function isAbort(e: unknown): boolean {
  return nameOf(e) === "AbortError";
}

function nameOf(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const name = (e as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

function messageOf(e: unknown): string {
  if (typeof e !== "object" || e === null) return "";
  const message = (e as { message?: unknown }).message;
  return typeof message === "string" ? message.trim() : "";
}

/**
 * The message for a rejection that never reached a response. A browser network
 * failure reports "Failed to fetch", which tells a visitor nothing about what to
 * do, so it becomes the sentence they need.
 */
export function userError(e: unknown): string {
  if (isAbort(e)) return "Download cancelled.";
  const message = messageOf(e);
  if (message && !/^(failed to fetch|load failed|net::\w+|networkerror\b)/i.test(message)) {
    return message.slice(0, 240);
  }
  return NETWORK_MESSAGE;
}
