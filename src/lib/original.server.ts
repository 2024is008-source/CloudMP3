import { z } from "zod";

import type { StreamInfo, TrackFormats } from "./track-formats";
import type { ParsedZipRequest } from "./zip-request";

// A cold yt-dlp extraction can take ~20s, so allow more than one probe.
const FORMAT_TIMEOUT = 25_000;
const CACHE_TTL = 5 * 60_000;
const cache = new Map<number, { at: number; value: TrackFormats }>();

const streamSchema = z.object({
  preset: z.string(),
  codec: z.string(),
  ext: z.string(),
  bitrate: z.number().nullable(),
  protocol: z.enum(["hls", "progressive"]),
});

const originalSchema = z.union([
  z.object({
    available: z.literal(true),
    ext: z.string(),
    codec: z.string(),
    mime: z.string().nullable(),
    bytes: z.number().nullable(),
    filename: z.string().nullable(),
    bitrate: z.number().nullable(),
  }),
  z.object({
    available: z.literal(false),
    reason: z.enum([
      "not-enabled",
      "quota",
      "auth-required",
      "unavailable",
      "service-unconfigured",
      "service-error",
    ]),
    message: z.string(),
  }),
]);

const formatsSchema = z.object({
  ok: z.literal(true),
  trackId: z.number(),
  original: originalSchema,
  streams: z.array(streamSchema),
  wavConversion: z.object({
    available: z.boolean(),
    source: streamSchema.nullable(),
  }),
  mp3Conversion: z.object({
    available: z.boolean(),
    bitrates: z.array(z.number()),
    source: streamSchema.nullable(),
  }),
  account: z.object({ configured: z.boolean() }),
});

function env(name: string): string | undefined {
  const process = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  return process?.env?.[name]?.trim() || undefined;
}

function serviceConfig(): { url?: string | undefined; key?: string | undefined } {
  return {
    url: env("CLOUDMP3_SERVICE_URL")?.replace(/\/+$/, ""),
    key: env("CLOUDMP3_SERVICE_KEY"),
  };
}

export function serviceConfigured(): boolean {
  const { url, key } = serviceConfig();
  return Boolean(url && key);
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Call the audio service without letting a redirect carry the API key.
 *
 * The service is our own process on loopback and it does not redirect, so a 3xx
 * here is either a misconfigured proxy in front of it or something answering for
 * it. undici re-sends the request headers, `X-Api-Key` included, to whatever
 * address the `Location` names, so the answer is refused rather than followed.
 */
async function serviceFetch(url: string | URL, init: RequestInit): Promise<Response> {
  const response = await fetch(url, { ...init, redirect: "manual" });
  if (REDIRECT_STATUSES.has(response.status)) {
    await response.body?.cancel().catch(() => {});
    throw new Error("The audio service answered with a redirect.");
  }
  return response;
}

function unavailable(
  trackId: number,
  configured: boolean,
  reason: "service-unconfigured" | "service-error",
  message: string,
): TrackFormats {
  return {
    configured,
    trackId,
    original: { available: false, reason, message },
    streams: [],
    wavConversion: { available: false, source: null },
    mp3Conversion: { available: false, bitrates: [], source: null },
    account: { configured: false },
  };
}

/** Real formats reported by the Python service, or an honest unavailable state. */
export async function getTrackFormats(trackId: number): Promise<TrackFormats> {
  const cached = cache.get(trackId);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.value;

  const { url, key } = serviceConfig();
  if (!url || !key) {
    return unavailable(
      trackId,
      false,
      "service-unconfigured",
      "Original-file access isn't configured on this deployment.",
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FORMAT_TIMEOUT);
  try {
    const response = await serviceFetch(`${url}/api/formats/${trackId}`, {
      headers: { "X-Api-Key": key },
      signal: controller.signal,
    });
    if (!response.ok) {
      return unavailable(
        trackId,
        true,
        "service-error",
        "The original-file service is unavailable.",
      );
    }
    const parsed = formatsSchema.safeParse(await response.json());
    if (!parsed.success) {
      return unavailable(
        trackId,
        true,
        "service-error",
        "The original-file service returned an unreadable response.",
      );
    }
    const value: TrackFormats = {
      configured: true,
      trackId,
      original: parsed.data.original,
      streams: parsed.data.streams as StreamInfo[],
      wavConversion: parsed.data.wavConversion,
      mp3Conversion: parsed.data.mp3Conversion,
      account: parsed.data.account,
    };
    if (cache.size >= 200) cache.clear();
    cache.set(trackId, { at: Date.now(), value });
    return value;
  } catch {
    return unavailable(trackId, true, "service-error", "The original-file service is unreachable.");
  } finally {
    clearTimeout(timer);
  }
}

const FORWARD_HEADERS = [
  "content-type",
  "content-length",
  "content-disposition",
  "x-filename",
  "x-file-ext",
  "x-audio-codec",
  "x-audio-bitrate",
  "x-total-bytes",
  "x-converted",
  "x-source-kind",
  "x-source-codec",
  "x-source-bitrate",
  "x-zip-tracks",
  "x-zip-failed",
  "x-zip-failed-ids",
  "accept-ranges",
  "content-range",
];

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    if (body?.error?.message) return body.error.message;
  } catch {
    /* fall through */
  }
  return "The original-file service rejected this request.";
}

/**
 * Stream the service's response through unchanged. Original audio is proxied
 * byte-for-byte; conversion only happens inside the service, never here.
 *
 * `signal` is the browser request's own: when the visitor leaves mid-download,
 * tearing down the upstream connection is what makes the service delete the
 * converted file immediately instead of finishing a transfer nobody wants.
 */
export async function proxyServiceDownload(
  trackId: number,
  mode: "original" | "wav" | "mp3",
  quality: "high" | "low",
  signal: AbortSignal,
  bitrate?: number,
): Promise<Response> {
  const { url, key } = serviceConfig();
  if (!url || !key) {
    return new Response("Original files aren't configured on this deployment.", { status: 503 });
  }

  const target = new URL(`${url}/api/download/${trackId}`);
  target.searchParams.set("mode", mode);
  target.searchParams.set("quality", quality);
  if (bitrate) target.searchParams.set("bitrate", String(bitrate));

  let upstream: Response;
  try {
    upstream = await serviceFetch(target, {
      headers: { "X-Api-Key": key },
      signal,
    });
  } catch {
    return new Response("The original-file service is unreachable.", { status: 502 });
  }

  if (!upstream.ok) {
    const message = await errorMessage(upstream);
    const status = upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502;
    return new Response(message, { status });
  }

  const headers = new Headers();
  for (const name of FORWARD_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("Cache-Control", "no-store");
  return new Response(upstream.body, { status: 200, headers });
}

/**
 * Hand a ZIP request to the audio service and stream the archive back.
 *
 * The archive is packed entirely on the server: this route never assembles
 * entries, so the tab only ever sees finished bytes. Aborting `signal` — the
 * visitor closing or navigating away — is what makes the service stop building
 * or stop sending, and delete the file it was holding.
 *
 * A failure keeps the service's own status, so a 504 timeout and a 413 over the
 * size limit stay distinguishable to the page and to monitoring.
 */
export async function proxyServiceZip(
  body: ParsedZipRequest,
  signal: AbortSignal,
): Promise<Response> {
  const { url, key } = serviceConfig();
  if (!url || !key) {
    return new Response("ZIP downloads aren't configured on this deployment.", { status: 503 });
  }

  let upstream: Response;
  try {
    upstream = await serviceFetch(`${url}/api/download/zip`, {
      method: "POST",
      headers: { "X-Api-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    return new Response("The original-file service is unreachable.", { status: 502 });
  }

  if (!upstream.ok) {
    return new Response(await errorMessage(upstream), {
      status: upstream.status >= 400 ? upstream.status : 502,
    });
  }

  const headers = new Headers();
  for (const name of FORWARD_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("Content-Type", "application/zip");
  headers.set("Cache-Control", "no-store");
  return new Response(upstream.body, { status: 200, headers });
}
