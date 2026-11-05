// The shape half of the outbound policy, safe to run in the browser as well as
// on the server. backend/net_guard.py holds the same rules for the audio service,
// and tests/test_net_guard.py holds the two of them to one host list.

/**
 * Where audio, artwork and API answers may come from.
 *
 * Every one of these addresses arrives from a SoundCloud response or from scraped
 * HTML. Following them without a policy points a server at its own network — the
 * conversion service listens on loopback, and a cloud metadata address is usually
 * one redirect away — and points a visitor's browser at whoever answered the API.
 */
export const DEFAULT_ALLOWED_HOSTS = ["sndcdn.com", "soundcloud.com", "soundcloud.cloud"];

/** Operator override, comma-separated; it can only ever add an approved domain. */
export const ALLOWED_HOSTS_ENV = "CLOUDMP3_ALLOWED_MEDIA_HOSTS";

/** Signed media URLs carry their token in the query, so a URL is never logged. */
export const BLOCKED = "blocked by the outbound host policy";

/** SoundCloud's own chains are one hop, at most two. Deeper is a loop or an attacker. */
export const MAX_REDIRECTS = 4;

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function environment(): Record<string, string | undefined> {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env ?? {};
}

/** The shipped list plus whatever the operator approved, malformed entries dropped. */
export function allowedHosts(): string[] {
  const extra = (environment()[ALLOWED_HOSTS_ENV] ?? "").trim();
  if (!extra) return [...DEFAULT_ALLOWED_HOSTS];
  const added: string[] = [];
  for (const raw of extra.split(",")) {
    const host = raw.trim().replace(/^\.+/, "").replace(/\.+$/, "").toLowerCase();
    const labels = host.split(".");
    // Two labels at least, so a stray ".com" cannot widen the suffix match, and
    // never an IP literal, which the host list is not meant to authorise.
    if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) continue;
    if (labels.every((label) => /^\d+$/.test(label))) continue;
    added.push(host);
  }
  return [...DEFAULT_ALLOWED_HOSTS, ...added];
}

export function hostnameOf(parsed: URL): string {
  return parsed.hostname.toLowerCase().replace(/\.+$/, "");
}

/** The reason this address may not be contacted against `hosts`, or null. */
export function inspectUrl(url: unknown, hosts: string[]): string | null {
  if (typeof url !== "string" || !url) return "not a URL";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "malformed URL";
  }
  if (parsed.protocol !== "https:") return "scheme is not https";
  // https://cdn.example.com@127.0.0.1/ reads as cdn.example.com here and as
  // 127.0.0.1 elsewhere, so any userinfo in the authority is refused outright —
  // taken from the text, because the parser would drop an empty one.
  const authority = url.slice(url.indexOf("//") + 2).split(/[/?#]/)[0] ?? "";
  if (authority.includes("@")) return "URL carries credentials";
  // WHATWG drops a port that equals the scheme default, so anything left is not 443.
  if (parsed.port !== "") return "port is not 443";
  const host = hostnameOf(parsed);
  if (!host) return "no hostname";
  if (!hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
    return "host is not an approved SoundCloud address";
  }
  return null;
}

export function inspectMediaUrl(url: unknown): string | null {
  return inspectUrl(url, allowedHosts());
}

/**
 * A track or profile *page*, which only ever lives on soundcloud.com.
 *
 * Stricter than the media rule because a page address is what the download route
 * hands to a resolver that opens its own sockets beyond any guard here.
 */
export function inspectPageUrl(url: unknown): string | null {
  return inspectUrl(url, ["soundcloud.com"]);
}

/** Shape only — no lookup and no redirect. Fetching on this alone is the bug. */
export function isAllowedMediaUrl(url: unknown): boolean {
  return inspectMediaUrl(url) === null;
}
