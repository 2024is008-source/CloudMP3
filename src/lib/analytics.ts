/**
 * Google Analytics 4 (gtag.js) for this site.
 *
 * Nothing here can throw or block a caller: a blocked tag, a half-loaded tag or a
 * missing Measurement ID has to stay silent while the download carries on. The
 * official snippet is installed by hand rather than through the SSR head, so one
 * boot cannot inject the script twice, and `send_page_view` is off because the
 * SPA reports its own views from the router.
 *
 * Payloads are counts, formats, sizes and stable codes. Never a track title, a
 * SoundCloud link, an upstream message, a token or an email address.
 */

export const GA_MEASUREMENT_ID = "G-RZVEMQ51PX";

const TAG_SOURCE = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;

/** Longest free-text value ever sent for custom parameters; search terms are cut to this. */
const TEXT_LIMIT = 60;

/** Standard GA4 character limits for built-in page parameters so URLs and titles are not truncated at 60 chars. */
const URL_LIMIT = 1000;
const TITLE_LIMIT = 300;

/**
 * Campaign and click-attribution query parameters that GA4 uses for traffic source
 * classification. These are preserved on `page_location` while app-internal query
 * parameters (`q`, `tab`, `download`, `focus`, `topic`) are excluded.
 */
const ATTRIBUTION_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_id",
  "utm_term",
  "utm_content",
  "utm_source_platform",
  "utm_creative_format",
  "utm_marketing_tactic",
  "gclid",
  "gclsrc",
  "dclid",
  "wbraid",
  "gbraid",
  "srsltid",
  "msclkid",
  "fbclid",
]);

type Scalar = string | number | boolean;

/** GA-facing parameter bag. Empty entries are dropped before sending. */
export type EventParams = Record<string, Scalar | null | undefined>;

export type EventName =
  | "page_view"
  | "download_start"
  | "download_complete"
  | "download_error"
  | "download_cancelled"
  | "format_selected"
  | "search_submitted"
  | "search_result_opened"
  | "playlist_selection"
  | "faq_opened"
  | "cta_clicked"
  | "external_link_clicked"
  | "app_error";

/** Where the bytes were produced, mirroring `selectDownloadRoute`. */
export type DownloadMethod = "direct" | "browser" | "server";

export type FileFormat = "aac" | "mp3" | "wav" | "ogg" | "flac" | "zip" | "other";

export type DownloadKind = "single" | "batch" | "zip";

export type ErrorType =
  | "aborted"
  | "bad_request"
  | "conversion"
  | "decode"
  | "empty_archive"
  | "network"
  | "not_downloadable"
  | "not_found"
  | "over_limit"
  | "rate_limited"
  | "server_unavailable"
  | "timeout"
  | "unauthorized"
  | "unknown";

/**
 * One download attempt. Callers that do not know a value pass `undefined` rather
 * than a guess; empty entries never reach GA4.
 */
export type DownloadInfo = {
  fileFormat: FileFormat;
  /** kbps for an MP3, or null when the format has no target bitrate. */
  bitrate?: number | null | undefined;
  method: DownloadMethod;
  kind?: DownloadKind | undefined;
  /** Tracks in a batch or ZIP; omitted for a single file. */
  trackCount?: number | undefined;
  /** Output size, when the transfer or the encoder reported one. */
  bytes?: number | null | undefined;
  /** Wall time from the click to this event. */
  elapsedMs?: number | undefined;
  /** Time spent decoding and re-encoding, when the tab did that work. */
  conversionMs?: number | undefined;
  /** Server time before the first byte, used to separate building from sending. */
  serverWaitMs?: number | undefined;
  errorType?: ErrorType | undefined;
  /** For an archive: the audio format packed inside it. */
  contentFormat?: FileFormat | undefined;
  /** Tracks the service could not pack, when a batch or archive came away short. */
  failedTracks?: number | undefined;
};

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

let started = false;
let lastView = "";
let initialReferrerCaptured = false;
let initialReferrer = "";

function limitForKey(key: string): number {
  if (key === "page_location" || key === "page_referrer") return URL_LIMIT;
  if (key === "page_title" || key === "page_path") return TITLE_LIMIT;
  return TEXT_LIMIT;
}

function scalars(params: EventParams): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = typeof value === "string" ? value.slice(0, limitForKey(key)) : value;
  }
  return out;
}

function normalizePath(pathname: string): string {
  if (!pathname || pathname === "/") return "/";
  return pathname.replace(/\/+$/, "");
}

/**
 * The address as GA4 counts pages: this origin and path, with no app query or
 * fragment. A search refinement, a `?download=true` hand-off or a `#faq` jump is
 * the same page as the page, and each of those is already measured by its own
 * event — `search_submitted`, `download_start`, `faq_opened`.
 */
function withoutQuery(href: string): string {
  try {
    const url = new URL(href);
    return `${url.origin}${normalizePath(url.pathname)}`;
  } catch {
    return "";
  }
}

/**
 * Build the `page_location` sent to GA4: keeps standard campaign and ad-click
 * attribution parameters (`utm_*`, `gclid`, `srsltid`, etc.) so GA4 can attribute
 * sessions accurately, while stripping internal app parameters (`q`, `tab`,
 * `download`, `focus`, `topic`).
 */
function buildPageLocation(loc: Location): string {
  const base = `${loc.origin}${normalizePath(loc.pathname)}`;
  if (!loc.search) return base;
  try {
    const incoming = new URLSearchParams(loc.search);
    const kept = new URLSearchParams();
    for (const [key, value] of incoming.entries()) {
      if (ATTRIBUTION_PARAMS.has(key.toLowerCase()) && value !== "") {
        kept.append(key, value);
      }
    }
    const qs = kept.toString();
    return qs ? `${base}?${qs}` : base;
  } catch {
    return base;
  }
}

function captureInitialReferrer(): void {
  if (initialReferrerCaptured || typeof document === "undefined") return;
  initialReferrerCaptured = true;
  initialReferrer = withoutQuery(document.referrer);
}

function hasExistingConfig(queue: unknown[]): boolean {
  for (const entry of queue) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as ArrayLike<unknown>;
    if (item[0] === "config" && item[1] === GA_MEASUREMENT_ID) return true;
  }
  return false;
}

/** Whether the initial page_view for this browser session has already been sent. */
export function hasTrackedInitialPageView(): boolean {
  return lastView !== "";
}

/** Load the tag once. Safe to call from any effect, on any page. */
export function initAnalytics(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  try {
    captureInitialReferrer();
    const queue = (window.dataLayer ??= []);
    // The official bootstrap. gtag.js replaces this with the real function and
    // replays whatever the page queued in the meantime.
    // Note: gtag.js strictly checks for an [object Arguments] or `callee` property
    // via Object.prototype.toString.call(a) === '[object Arguments]' in its queue
    // processor; pushing a rest array `args` causes gtag to drop commands silently.
    window.gtag ??= function gtag() {
      // eslint-disable-next-line prefer-rest-params
      queue.push(arguments);
    };
    if (!hasExistingConfig(queue)) {
      window.gtag("js", new Date());
      window.gtag("config", GA_MEASUREMENT_ID, { send_page_view: false });
    }
    if (!document.querySelector("script[src^='https://www.googletagmanager.com/gtag/js']")) {
      const script = document.createElement("script");
      script.async = true;
      script.src = TAG_SOURCE;
      document.head.appendChild(script);
    }
  } catch {
    /* a page without analytics is still a working page */
  }
}

/** Queue one event. Calls that arrive before the tag loads are not lost. */
export function trackEvent(name: EventName, params: EventParams = {}): void {
  if (typeof window === "undefined") return;
  try {
    window.gtag?.("event", name, scalars(params));
  } catch {
    /* never let tracking break the action being tracked */
  }
}

/**
 * One view per page. React remounts, re-renders and a refined search are
 * invisible here because the page seen last time is compared before anything is
 * sent, and the app query is not part of that comparison.
 */
export function trackPageView(): void {
  if (typeof window === "undefined") return;
  try {
    const pathname = normalizePath(window.location.pathname);
    const page = `${window.location.origin}${pathname}`;
    if (page === lastView) return;
    const externalRef = initialReferrerCaptured
      ? initialReferrer
      : withoutQuery(document.referrer);
    initialReferrerCaptured = true;
    const referrer = lastView ? lastView : externalRef;
    lastView = page;
    trackEvent("page_view", {
      page_title: document.title,
      page_location: buildPageLocation(window.location),
      page_path: pathname,
      page_referrer: referrer,
    });
  } catch {
    /* ignore */
  }
}

function downloadParams(info: DownloadInfo): EventParams {
  return {
    download_kind: info.kind ?? "single",
    file_format: info.fileFormat,
    content_format: info.contentFormat,
    bitrate: info.bitrate,
    download_method: info.method,
    track_count: info.trackCount,
    failed_tracks: info.failedTracks,
  };
}

export function trackDownloadStart(info: DownloadInfo): void {
  trackEvent("download_start", downloadParams(info));
}

/**
 * Fires once the finished file is handed to the browser. The tab cannot know that
 * the device kept it, so nothing here claims a save.
 */
export function trackDownloadComplete(info: DownloadInfo): void {
  trackEvent("download_complete", {
    ...downloadParams(info),
    file_size_bytes: info.bytes,
    elapsed_ms: info.elapsedMs,
    conversion_ms: info.conversionMs,
    server_wait_ms: info.serverWaitMs,
  });
}

export function trackDownloadError(info: DownloadInfo): void {
  trackEvent("download_error", {
    ...downloadParams(info),
    error_type: info.errorType ?? "unknown",
    elapsed_ms: info.elapsedMs,
  });
}

/** A visitor pressing Cancel is an outcome, not a failure, so it gets its own event. */
export function trackDownloadCancelled(info: DownloadInfo): void {
  trackEvent("download_cancelled", downloadParams(info));
}

/**
 * Name the container GA4 should report for the bytes actually produced. The
 * extension is authoritative: it comes from the encoder or from `X-File-Ext`,
 * never from what the visitor hoped for.
 */
export function formatOfExt(ext: string): FileFormat {
  const cleaned = ext.replace(/^\./, "").toLowerCase();
  if (cleaned === "mp3") return "mp3";
  if (cleaned === "wav") return "wav";
  if (cleaned === "zip") return "zip";
  if (cleaned === "aac" || cleaned === "m4a" || cleaned === "mp4") return "aac";
  if (cleaned === "ogg" || cleaned === "oga" || cleaned === "opus") return "ogg";
  if (cleaned === "flac") return "flac";
  return "other";
}

export function trackFormatSelected(input: {
  fileFormat: FileFormat;
  bitrate?: number | null;
  page: "track" | "playlist";
}): void {
  trackEvent("format_selected", {
    file_format: input.fileFormat,
    bitrate: input.bitrate ?? undefined,
    page: input.page,
  });
}

/**
 * A search box submission. A pasted SoundCloud link reports only what it pointed
 * at — the link itself never leaves the page.
 */
export function trackSearch(input: {
  source: "header" | "search_page" | "link_box";
  tab?: string;
  term?: string;
  resultCount?: number;
  linkType?: "track" | "playlist" | "profile" | "invalid";
}): void {
  trackEvent("search_submitted", {
    search_source: input.source,
    search_tab: input.tab,
    // A pasted link is only ever a type. Whatever a visitor typed into a search
    // box is reported, cut to `TEXT_LIMIT`.
    search_term: input.source === "link_box" ? undefined : input.term,
    result_count: input.resultCount,
    link_type: input.linkType,
  });
}

export function trackPlaylistDownload(input: {
  kind: Exclude<DownloadKind, "single">;
  trackCount: number;
  fileFormat: FileFormat;
  contentFormat?: FileFormat;
  bitrate?: number | null;
  method: DownloadMethod;
}): void {
  trackDownloadStart({
    kind: input.kind,
    trackCount: input.trackCount,
    fileFormat: input.fileFormat,
    contentFormat: input.contentFormat,
    bitrate: input.bitrate,
    method: input.method,
  });
}

/** The result row a visitor chose, without naming the result. */
export function trackResultOpened(input: {
  kind: "track" | "playlist" | "profile";
  from: "header" | "search_page" | "related";
}): void {
  trackEvent("search_result_opened", { result_kind: input.kind, result_from: input.from });
}

/** Which tracks a visitor ticked, as a count only. */
export function trackPlaylistSelection(input: {
  action: "select_all" | "clear" | "filter";
  trackCount: number;
}): void {
  trackEvent("playlist_selection", {
    selection_action: input.action,
    track_count: input.trackCount,
  });
}

export function trackFaqOpened(input: { page: "home" | "faq"; index: number }): void {
  trackEvent("faq_opened", { faq_page: input.page, question_index: input.index });
}

export function trackCtaClicked(input: { label: string; page: string }): void {
  trackEvent("cta_clicked", { cta_label: input.label, page: input.page });
}

/** Only the destination host is reported, never the full link. */
export function trackExternalLink(input: { href: string; label: string }): void {
  if (typeof window === "undefined") return;
  let host = "";
  try {
    host = new URL(input.href).hostname;
  } catch {
    return;
  }
  if (!host || host === window.location.hostname) return;
  trackEvent("external_link_clicked", { link_host: host, link_label: input.label });
}

/** Specific service codes first, generic wording last: the first match wins. */
const ERROR_PATTERNS: [RegExp, ErrorType][] = [
  [/disconnect|cancel|abort/, "aborted"],
  [/timeout/, "timeout"],
  [/too_many|too_large|over_limit|too big/, "over_limit"],
  [/convert|encod|lame|ffmpeg/, "conversion"],
  [/decode|audio ?buffer/, "decode"],
  [/empty/, "empty_archive"],
  [
    /no_stream|not.?authorized|preview|download.?not|isn.?t available|not available/,
    "not_downloadable",
  ],
  [/not_found|not found|404|gone/, "not_found"],
  [/rate_limit|rate limit|429|too many requests/, "rate_limited"],
  [/unauthorized|api.?key|401|403|forbidden/, "unauthorized"],
  [
    /bad_|no_tracks|valid soundcloud|doesn.?t look|isn.?t valid|not valid|invalid|400/,
    "bad_request",
  ],
  [/fetch|network|load failed|err_cr_/, "network"],
  [/service|unreachable|server|failed|50[234]/, "server_unavailable"],
];

/** The service answers failures with `{"error":{"code":…}}`; the code beats its prose. */
function unwrapCode(text: string): string {
  if (!text.startsWith("{")) return text;
  try {
    const body = JSON.parse(text) as { error?: { code?: unknown } };
    const code = body?.error?.code;
    return typeof code === "string" && code ? code : text;
  } catch {
    return text;
  }
}

/** The most identifying text a failure carries, looked for before any message. */
function signatureOf(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "object") {
    const source = input as Record<string, unknown>;
    for (const key of ["code", "error", "message", "name"] as const) {
      const value = source[key];
      if (typeof value === "string" && value) return unwrapCode(value.toLowerCase());
      if (value !== null && typeof value === "object") {
        const nested = (value as Record<string, unknown>)["code"];
        if (typeof nested === "string" && nested) return nested.toLowerCase();
      }
    }
  }
  return unwrapCode(String(input).toLowerCase());
}

/**
 * Turn a failure into one stable code. The text itself is never sent: the
 * service's message can name an artist and a thrown link would carry a URL, so
 * only which pattern matched reaches GA4.
 */
export function classifyError(input: unknown): ErrorType {
  const text = signatureOf(input);
  if (!text) return "unknown";
  for (const [pattern, type] of ERROR_PATTERNS) {
    if (pattern.test(text)) return type;
  }
  return "unknown";
}

/** Application-level failures that are not a download: metadata, formats, availability. */
export function trackAppError(input: {
  stage: "metadata" | "formats" | "availability" | "search" | "zip" | "playlist";
  error: unknown;
}): void {
  trackEvent("app_error", { error_stage: input.stage, error_type: classifyError(input.error) });
}
