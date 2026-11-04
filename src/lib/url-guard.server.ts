// The server half of the outbound policy: on top of the shared shape rules this
// adds the address gate and a redirect walker that re-checks every hop.
// backend/net_guard.py is the same policy inside the audio service.
import dns from "node:dns/promises";

import { BLOCKED, MAX_REDIRECTS, hostnameOf, inspectMediaUrl } from "./url-guard";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const DNS_TTL_MS = 60_000;
const DNS_CACHE_MAX = 256;

export class UnsafeDestinationError extends Error {}

const IPV4_NOT_GLOBAL: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

const IPV6_NOT_GLOBAL: [string, number][] = [
  ["::", 8],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
];

function addressBytes(text: string): number[] | null {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) {
    const octets = v4.slice(1, 5).map(Number);
    return octets.every((n) => n < 256) ? octets : null;
  }
  return ipv6Bytes(text);
}

function toBytes(groups: number[]): number[] {
  return groups.flatMap((group) => [(group >> 8) & 0xff, group & 0xff]);
}

function parseGroups(block: string): number[] | null {
  if (!block) return [];
  const out = block
    .split(":")
    .map((part) => (/^[0-9a-f]{1,4}$/i.test(part) ? parseInt(part, 16) : NaN));
  return out.every((group) => !Number.isNaN(group)) ? out : null;
}

function ipv6Bytes(text: string): number[] | null {
  const embedded = /^(.*?:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(text);
  if (embedded) {
    const quad = embedded[2]!.split(".").map(Number);
    const tail = `${((quad[0]! << 8) | quad[1]!).toString(16)}:${((quad[2]! << 8) | quad[3]!).toString(16)}`;
    text = `${embedded[1]}${tail}`;
  }
  const parts = text.split("::");
  if (parts.length > 2) return null;
  const head = parseGroups(parts[0] ?? "");
  if (head === null) return null;
  if (parts.length === 1) return head.length === 8 ? toBytes(head) : null;
  const tail = parseGroups(parts[1] ?? "");
  if (tail === null) return null;
  const zeros = 8 - head.length - tail.length;
  if (zeros < 1) return null;
  return toBytes([...head, ...new Array<number>(zeros).fill(0), ...tail]);
}

function matchesCidr(bytes: number[], base: string, bits: number): boolean {
  const target = addressBytes(base);
  if (!target || target.length !== bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    const left = bits - i * 8;
    if (left <= 0) return true;
    const mask = left >= 8 ? 0xff : (0xff << (8 - left)) & 0xff;
    if ((bytes[i]! & mask) !== (target[i]! & mask)) return false;
  }
  return true;
}

/**
 * True for a globally routable address and false for everything a server should
 * never open: loopback, RFC1918, link-local (so the cloud metadata address),
 * carrier-grade NAT, multicast, reserved and documentation ranges.
 */
export function isGlobalAddress(text: string): boolean {
  const parsed = addressBytes(text);
  if (!parsed) return false;
  const bytes =
    parsed.length === 16 && matchesCidr(parsed, "::ffff:0:0", 96) ? parsed.slice(12) : parsed;
  const ranges = bytes.length === 4 ? IPV4_NOT_GLOBAL : IPV6_NOT_GLOBAL;
  return !ranges.some(([base, bits]) => matchesCidr(bytes, base, bits));
}

/** False unless every record this name answers with is globally routable. */
export async function resolvesToPublicAddress(host: string): Promise<boolean> {
  let answers: { address: string }[];
  try {
    answers = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    return false;
  }
  if (answers.length === 0) return false;
  return answers.every((answer) => isGlobalAddress(answer.address));
}

const dnsCache = new Map<string, { ok: boolean; at: number }>();

/**
 * Lookups are trusted for {@link DNS_TTL_MS} only.
 *
 * That is a limit on rebinding, not a cure: between the answer and the socket the
 * name can still be re-answered, and only the OS resolver picks the address the
 * connection uses. The host list is what keeps traffic on SoundCloud; this gate
 * catches a listed name that has been pointed somewhere it should not be.
 */
async function hostIsPublic(host: string): Promise<boolean> {
  const hit = dnsCache.get(host);
  const now = Date.now();
  if (hit && hit.at > now) return hit.ok;
  const ok = await resolvesToPublicAddress(host);
  if (dnsCache.size >= DNS_CACHE_MAX) dnsCache.clear();
  dnsCache.set(host, { ok, at: now + DNS_TTL_MS });
  return ok;
}

/** Full gate: the shared shape checks, then that the host resolves to public addresses. */
export async function assertSafeMediaUrl(url: unknown): Promise<string> {
  const reason = inspectMediaUrl(url);
  if (reason !== null) throw new UnsafeDestinationError(`${BLOCKED}: ${reason}`);
  const absolute = url as string;
  const host = hostnameOf(new URL(absolute));
  if (!(await hostIsPublic(host))) {
    throw new UnsafeDestinationError(`${BLOCKED}: ${host} is not publicly reachable`);
  }
  return absolute;
}

/**
 * Fetch with the policy applied to every hop.
 *
 * `redirect` is manual because undici would otherwise follow up to twenty
 * redirects — carrying its own headers onto each — before this code saw a single
 * destination. Each `Location` is resolved, gated and counted here instead.
 */
export async function guardedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  let target = await assertSafeMediaUrl(url);
  for (let hop = 0; ; hop++) {
    const response = await fetch(target, { ...init, redirect: "manual" });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    await response.body?.cancel().catch(() => {});
    if (hop >= MAX_REDIRECTS) {
      throw new UnsafeDestinationError(`${BLOCKED}: too many redirects`);
    }
    const location = response.headers.get("location");
    if (!location) return response;
    target = await assertSafeMediaUrl(new URL(location, target).toString());
  }
}
