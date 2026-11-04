// Mirrors scdl's approach: scrape a public client_id, then use api-v2.
import { assertSafeMediaUrl, guardedFetch } from "./url-guard.server";
import { inspectPageUrl } from "./url-guard";

let cachedId: { id: string; at: number } | null = null;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

/**
 * Deadline for the calls that read a small body at once. A hung metadata request
 * would hold a socket open on this single-process server indefinitely and leave
 * the visitor's spinner turning forever. Downloads are not covered: a stream in
 * progress is not a hung request, so `hlsStream` and the segment readers keep
 * their own no-timeout fetch.
 */
const CALL_TIMEOUT_MS = 20_000;

function call(input: string | URL, headers: Record<string, string> = {}): Promise<Response> {
  return guardedFetch(input.toString(), {
    headers: { "User-Agent": UA, ...headers },
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
}

export async function getClientId(force = false): Promise<string> {
  if (!force && cachedId && Date.now() - cachedId.at < 30 * 60_000) return cachedId.id;
  const html = await (await call("https://soundcloud.com/")).text();
  const scripts = [...html.matchAll(/<script crossorigin src="([^"]+)"/g)]
    .map((m) => m[1]!)
    .reverse();
  for (const src of scripts) {
    const js = await (await call(src)).text();
    const m = js.match(/client_id\s*[:=]\s*"([a-zA-Z0-9]{32})"/);
    if (m) {
      cachedId = { id: m[1]!, at: Date.now() };
      return m[1]!;
    }
  }
  throw new Error("Could not obtain SoundCloud client id");
}

/**
 * SoundCloud's own hosts only. `scApi` also takes absolute links handed back by
 * a previous response (`next_href`, `api_url`), and an unbounded follow of those
 * would let a crafted reply point the VPS at its own network. The page rule is the
 * strictest one in `url-guard.server.ts`: an API answer never has a reason to
 * name a CDN as the place to ask a question.
 */
function isSoundCloudEndpoint(url: string): boolean {
  return inspectPageUrl(url) === null;
}

export async function scApi(path: string, params: Record<string, string> = {}): Promise<any> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const id = await getClientId(attempt > 0);
    const u = new URL(path.startsWith("http") ? path : `https://api-v2.soundcloud.com${path}`);
    if (!isSoundCloudEndpoint(u.toString())) {
      throw new Error("Only SoundCloud endpoints can be queried");
    }
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    u.searchParams.set("client_id", id);
    const r = await call(u);
    if (r.status === 401 || r.status === 403) continue;
    if (!r.ok) throw new Error(`SoundCloud responded ${r.status}`);
    return r.json();
  }
  throw new Error("SoundCloud authorization failed");
}

export type Track = {
  id: number;
  title: string;
  artist: string;
  duration: number;
  permalink_url: string;
  artwork_url: string | null;
};

export type ProfileSet = {
  id: number;
  title: string;
  permalink_url: string;
  track_count: number;
  artwork_url: string | null;
};

const art = (u?: string | null) => (u ? u.replace("-large.", "-t500x500.") : null);

function mapTrack(t: any, fallbackArt?: string | null): Track {
  return {
    id: t.id,
    title: t.title,
    artist: t.user?.username ?? "Unknown Artist",
    duration: t.duration ?? 0,
    permalink_url: t.permalink_url,
    artwork_url: art(t.artwork_url || t.user?.avatar_url) ?? fallbackArt ?? null,
  };
}

const PROFILE_UPLOAD_CAP = 200;
const PROFILE_SET_CAP = 60;
const SCRAPE_PAGE = 50;

/** Follows SoundCloud's cursor pagination up to `cap` items. */
async function collectPages(path: string, cap: number): Promise<any[]> {
  const items: any[] = [];
  let next: string | undefined;
  while (items.length < cap) {
    const page = next
      ? await scApi(next)
      : await scApi(path, { limit: String(Math.min(SCRAPE_PAGE, cap)) });
    const collection: any[] = Array.isArray(page?.collection) ? page.collection : [];
    items.push(...collection);
    next = typeof page?.next_href === "string" ? page.next_href : undefined;
    if (!next || collection.length === 0) break;
  }
  return items.slice(0, cap);
}

export async function resolveUrl(url: string) {
  const data = await scApi("/resolve", { url });
  if (data.kind === "track") {
    const t = mapTrack(data);
    return {
      type: "track" as const,
      title: t.title,
      creator: t.artist,
      artwork_url: t.artwork_url,
      track_count: 1,
      total_duration: t.duration,
      tracks: [t],
    };
  }
  if (data.kind === "playlist") {
    const raw: any[] = data.tracks ?? [];
    const missing = raw.filter((t) => !t.title).map((t) => t.id);
    const full = new Map<number, any>(raw.filter((t) => t.title).map((t) => [t.id, t]));
    for (let i = 0; i < missing.length; i += 50) {
      const batch = await scApi("/tracks", { ids: missing.slice(i, i + 50).join(",") });
      for (const t of batch) full.set(t.id, t);
    }
    const pArt = art(data.artwork_url);
    const tracks = raw
      .map((t) => full.get(t.id))
      .filter(Boolean)
      .map((t) => mapTrack(t, pArt));
    return {
      type: "playlist" as const,
      title: data.title,
      creator: data.user?.username ?? tracks[0]?.artist ?? "Unknown Artist",
      artwork_url: pArt ?? tracks[0]?.artwork_url ?? null,
      track_count: tracks.length,
      total_duration: tracks.reduce((s, t) => s + t.duration, 0),
      tracks,
    };
  }
  if (data.kind === "user") {
    const [uploads, sets] = await Promise.all([
      collectPages(`/users/${data.id}/tracks`, PROFILE_UPLOAD_CAP),
      collectPages(`/users/${data.id}/playlists`, PROFILE_SET_CAP),
    ]);
    const avatar = art(data.avatar_url);
    const tracks = uploads.filter((t) => t?.kind === "track").map((t) => mapTrack(t, avatar));
    const playlists: ProfileSet[] = sets
      .filter((s) => s?.kind === "playlist" && typeof s.permalink_url === "string")
      .map((s) => ({
        id: s.id,
        title: s.title ?? "Untitled playlist",
        permalink_url: s.permalink_url,
        track_count: typeof s.track_count === "number" ? s.track_count : 0,
        artwork_url: art(s.artwork_url) ?? avatar,
      }));
    return {
      type: "profile" as const,
      title: (typeof data.full_name === "string" && data.full_name.trim()) || data.username,
      // SoundCloud's `username` is the display name, so the permalink handle is the distinct line.
      creator:
        typeof data.permalink === "string" && data.permalink
          ? `@${data.permalink}`
          : (data.username ?? "Unknown uploader"),
      artwork_url: avatar,
      track_count: tracks.length,
      total_duration: tracks.reduce((s, t) => s + t.duration, 0),
      tracks,
      sets: playlists,
      more_uploads: uploads.length >= PROFILE_UPLOAD_CAP,
      more_sets: sets.length >= PROFILE_SET_CAP,
    };
  }
  const found = typeof data.kind === "string" ? data.kind : "page";
  throw new Error(
    `That's a ${found} page, not a track or playlist. Paste a track link (soundcloud.com/artist/title) or a playlist link (soundcloud.com/artist/sets/name).`,
  );
}

export type { SearchResult, SearchTab } from "./search-rank";
import {
  baseTitle,
  classifyVersion,
  matchesTab,
  normalizeText,
  rankSearchItems,
  type SearchCategory,
  type SearchResult,
  type SearchTab,
} from "./search-rank";

type SearchFilter = "all" | "tracks" | "playlists";

const SEARCH_PATH: Record<SearchFilter, string> = {
  all: "/search",
  tracks: "/search/tracks",
  playlists: "/search/playlists",
};

function mapSearchItem(item: any): SearchResult | null {
  const kind = item?.kind;
  if (kind !== "track" && kind !== "playlist") return null;
  if (!item.permalink_url) return null;

  const isTrack = kind === "track";
  const title = item.title ?? "Untitled";
  const user = item.user;
  const publisher = item.publisher_metadata;
  const official = Boolean(publisher && (publisher.isrc || publisher.artist));
  const downloadable = isTrack
    ? item.streamable !== false && item.policy !== "SNIP" && item.policy !== "BLOCK"
    : true;

  return {
    id: item.id,
    kind,
    title,
    artist: user?.username ?? "Unknown Artist",
    duration: item.duration ?? 0,
    track_count: isTrack ? 1 : (item.track_count ?? 1),
    artwork_url: art(item.artwork_url || user?.avatar_url),
    permalink_url: item.permalink_url,
    verified: user?.verified === true,
    official,
    downloadable,
    playback_count: item.playback_count ?? 0,
    category: isTrack
      ? classifyVersion({
          title,
          tags: [item.tag_list, publisher?.album_title].filter(Boolean).join(" "),
          genre: item.genre,
        })
      : "playlist",
  };
}

async function fetchSearchChunk(q: string, filter: SearchFilter, limit: number, offset: number) {
  const data = await scApi(SEARCH_PATH[filter], {
    q,
    limit: String(limit),
    offset: String(offset),
  });
  const raw: any[] = Array.isArray(data?.collection) ? data.collection : [];
  return {
    rawCount: raw.length,
    items: raw.map(mapSearchItem).filter((x): x is SearchResult => x !== null),
  };
}

export async function searchSc(
  q: string,
  filter: SearchFilter = "all",
  limit = 10,
  offset = 0,
): Promise<SearchResult[]> {
  return (await fetchSearchChunk(q, filter, limit, offset)).items;
}

export type RankedSearchPage = {
  results: SearchResult[];
  nextOffset: number;
  hasMore: boolean;
};

/** SoundCloud caps one search at 50; scan a few chunks to fill filtered tabs. */
const SCAN_CHUNK = 50;
const MAX_SCAN = 150;

export async function searchRanked(
  q: string,
  tab: SearchTab,
  limit = 20,
  offset = 0,
  full = false,
): Promise<RankedSearchPage> {
  const filter: SearchFilter = tab === "playlists" ? "playlists" : tab === "all" ? "all" : "tracks";
  const pool: SearchResult[] = [];
  let cursor = offset;
  let scanned = 0;
  let hasMore = true;

  while (pool.length < limit && scanned < MAX_SCAN) {
    const chunk = await fetchSearchChunk(q, filter, SCAN_CHUNK, cursor);
    if (chunk.rawCount === 0) {
      hasMore = false;
      break;
    }
    scanned += chunk.rawCount;
    cursor += chunk.rawCount;
    pool.push(...chunk.items.filter((item) => matchesTab(item, tab)));
    if (chunk.rawCount < SCAN_CHUNK) {
      hasMore = false;
      break;
    }
  }

  const ranked = rankSearchItems(q, pool);
  // Filtered tabs can match more than `limit` inside one window. The results
  // page asks for the whole window so no ranked item is skipped between pages.
  return { results: full ? ranked : ranked.slice(0, limit), nextOffset: cursor, hasMore };
}

export type Quality = "high" | "low";

export type AudioVariant = {
  preset: string;
  codec: "AAC" | "MP3";
  bitrate: number;
  protocol: "hls" | "progressive";
  mime: string;
};

const PRESET_BITRATES: Record<string, number> = {
  mp3_1_0: 128,
  mp3_0_0: 128,
  aac_160k: 160,
  aac_96k: 96,
  aac_256k: 256,
  opus_0_0: 64,
};

function playableVariant(tc: any): AudioVariant | null {
  const protocol = tc?.format?.protocol;
  if (protocol !== "hls" && protocol !== "progressive") return null;
  const mime = String(tc?.format?.mime_type ?? "");
  if (!mime.startsWith("audio/mp4") && !mime.startsWith("audio/mpeg")) return null;
  const preset = String(tc?.preset ?? "");
  const codec: "AAC" | "MP3" = mime.startsWith("audio/mp4") ? "AAC" : "MP3";
  const digits = Number(preset.match(/(\d{2,3})k?/)?.[1] ?? 0);
  const bitrate = PRESET_BITRATES[preset] ?? (digits >= 32 ? digits : 128);
  return { preset, codec, bitrate, protocol, mime };
}

function audioVariants(track: any): AudioVariant[] {
  const seen = new Set<string>();
  const out: AudioVariant[] = [];
  for (const tc of track?.media?.transcodings ?? []) {
    const variant = playableVariant(tc);
    if (!variant) continue;
    const key = `${variant.codec}|${variant.bitrate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(variant);
  }
  return out.sort((a, b) => b.bitrate - a.bitrate);
}

function parseTags(raw: string): string[] {
  const out: string[] = [];
  for (const m of raw.matchAll(/"([^"]+)"|(\S+)/g)) {
    const tag = (m[1] ?? m[2] ?? "").trim();
    if (tag) out.push(tag);
  }
  return out;
}

export type TrackDetails = {
  id: number;
  title: string;
  artist: string;
  uploader: string;
  artist_url: string | null;
  artist_avatar: string | null;
  verified: boolean;
  permalink_url: string;
  artwork_url: string | null;
  duration: number;
  full_duration: number;
  genre: string | null;
  tags: string[];
  release_date: string | null;
  created_at: string | null;
  label_name: string | null;
  playback_count: number | null;
  likes_count: number | null;
  policy: string | null;
  streamable: boolean;
  /** Full audio stream is authorized for download (not a snippet or blocked). */
  downloadAllowed: boolean;
  /** SoundCloud provides an authorized preview stream. */
  previewAllowed: boolean;
  /** The preview is SoundCloud's official short snippet. */
  snippet: boolean;
  official: boolean;
  category: SearchCategory;
  source: AudioVariant;
  variants: AudioVariant[];
  publisher: {
    artist: string | null;
    album: string | null;
    isrc: string | null;
    explicit: boolean;
  } | null;
};

export async function getTrackDetails(trackId: number): Promise<TrackDetails> {
  const t = await scApi(`/tracks/${trackId}`);
  if (!t || t.kind !== "track") throw new Error("Track not found");

  const variants = audioVariants(t);
  const source = variants[0];
  if (!source) throw new Error("This track has no playable audio");

  const policy = typeof t.policy === "string" ? t.policy : null;
  const streamable = t.streamable !== false;
  const previewAllowed = streamable && policy !== "BLOCK";
  const snippet =
    policy === "SNIP" || (t.media?.transcodings ?? []).some((tc: any) => tc.snipped === true);
  const publisher = t.publisher_metadata;

  return {
    id: t.id,
    title: t.title ?? "Untitled",
    artist: publisher?.artist || t.user?.username || "Unknown Artist",
    uploader: t.user?.username ?? "Unknown Artist",
    artist_url: t.user?.permalink_url ?? null,
    artist_avatar: art(t.user?.avatar_url),
    verified: t.user?.verified === true,
    permalink_url: t.permalink_url,
    artwork_url: art(t.artwork_url || t.user?.avatar_url),
    duration: t.duration ?? 0,
    full_duration: t.full_duration ?? t.duration ?? 0,
    genre: t.genre?.trim() || null,
    tags: parseTags(String(t.tag_list ?? "")),
    release_date: t.release_date ?? null,
    created_at: t.created_at ?? null,
    label_name: t.label_name ?? null,
    playback_count: typeof t.playback_count === "number" ? t.playback_count : null,
    likes_count: typeof t.likes_count === "number" ? t.likes_count : null,
    policy,
    streamable,
    downloadAllowed: previewAllowed && !snippet,
    previewAllowed,
    snippet,
    official: Boolean(publisher && (publisher.isrc || publisher.artist)),
    category: classifyVersion({
      title: t.title ?? "",
      tags: [t.tag_list, publisher?.album_title].filter(Boolean).join(" "),
      genre: t.genre,
    }),
    source,
    variants,
    publisher: publisher
      ? {
          artist: publisher.artist ?? null,
          album: publisher.album_title ?? null,
          isrc: publisher.isrc ?? null,
          explicit: publisher.explicit === true,
        }
      : null,
  };
}

export async function getStreamUrl(trackId: number, quality: Quality = "high") {
  const [t] = await scApi("/tracks", { ids: String(trackId) });
  if (!t) throw new Error("Track not found");

  type Candidate = { tc: any; variant: AudioVariant };
  const tcs: any[] = t.media?.transcodings ?? [];
  const candidates: Candidate[] = tcs
    .map((tc): Candidate | null => {
      const variant = playableVariant(tc);
      return variant ? { tc, variant } : null;
    })
    .filter((x): x is Candidate => x !== null)
    .sort((a, b) => {
      const diff =
        quality === "high"
          ? b.variant.bitrate - a.variant.bitrate
          : a.variant.bitrate - b.variant.bitrate;
      if (diff !== 0) return diff;
      return (
        (a.variant.protocol === "progressive" ? 0 : 1) -
        (b.variant.protocol === "progressive" ? 0 : 1)
      );
    });

  const params: Record<string, string> = {};
  if (t.track_authorization) params["track_authorization"] = t.track_authorization;

  for (const { tc, variant } of candidates) {
    try {
      const { url } = await scApi(tc.url, params);
      const progressive = tc.format.protocol === "progressive";
      const duration = typeof t.duration === "number" ? t.duration : 0;
      return {
        url,
        hls: !progressive,
        ext: variant.codec === "AAC" ? "m4a" : "mp3",
        mime: variant.mime,
        title: t.title as string,
        artist: (t.user?.username ?? "Unknown") as string,
        codec: variant.codec,
        bitrate: variant.bitrate,
        duration,
        // duration is in milliseconds: kbps × ms ÷ 8 gives bytes.
        estimatedBytes: Math.round((variant.bitrate * duration) / 8),
      };
    } catch {
      /* try next */
    }
  }
  throw new Error("This track can't be downloaded (it may be Go+ only or region-locked)");
}

export type PreviewAudio = {
  data: Uint8Array;
  mime: string;
  snippet: boolean;
};

type CachedPreview = PreviewAudio & { at: number };
const PREVIEW_TTL = 10 * 60 * 1000;
const PREVIEW_CACHE_LIMIT = 24 * 1024 * 1024;
const previewCache = new Map<number, CachedPreview>();
let previewCacheBytes = 0;

function cachePreview(trackId: number, entry: PreviewAudio) {
  previewCache.delete(trackId);
  previewCache.set(trackId, { ...entry, at: Date.now() });
  previewCacheBytes += entry.data.byteLength;
  for (const [id, cached] of previewCache) {
    if (previewCacheBytes <= PREVIEW_CACHE_LIMIT && previewCache.size <= 6) break;
    previewCache.delete(id);
    previewCacheBytes -= cached.data.byteLength;
  }
}

/**
 * Resolve SoundCloud's own authorized preview stream (never a third-party
 * source). Buffered so the player can report a real duration and seek.
 */
export async function getPreviewAudio(trackId: number): Promise<PreviewAudio> {
  const cached = previewCache.get(trackId);
  if (cached && Date.now() - cached.at < PREVIEW_TTL) {
    return { data: cached.data, mime: cached.mime, snippet: cached.snippet };
  }
  if (cached) {
    previewCache.delete(trackId);
    previewCacheBytes -= cached.data.byteLength;
  }

  const t = await scApi(`/tracks/${trackId}`);
  if (!t || t.kind !== "track") throw new Error("Track not found");
  if (t.streamable === false || t.policy === "BLOCK") {
    throw new Error("This track is not authorized for preview");
  }

  type Candidate = { tc: any; variant: AudioVariant };
  const tcs: any[] = t.media?.transcodings ?? [];
  const candidates: Candidate[] = tcs
    .map((tc): Candidate | null => {
      const variant = playableVariant(tc);
      return variant ? { tc, variant } : null;
    })
    .filter((x): x is Candidate => x !== null)
    .sort((a, b) => {
      const rank = (c: Candidate) =>
        c.variant.protocol === "progressive" ? 0 : c.variant.bitrate <= 96 ? 1 : 2;
      return rank(a) - rank(b) || a.variant.bitrate - b.variant.bitrate;
    });

  const params: Record<string, string> = {};
  if (t.track_authorization) params["track_authorization"] = t.track_authorization;
  const snippet = t.policy === "SNIP" || tcs.some((tc: any) => tc.snipped === true);

  for (const { tc, variant } of candidates) {
    try {
      const { url } = await scApi(tc.url, params);
      const data =
        tc.format.protocol === "hls"
          ? await hlsBytes(url)
          : new Uint8Array(await (await guardedFetch(url)).arrayBuffer());
      if (data.byteLength === 0) continue;
      const entry: PreviewAudio = { data, mime: variant.mime.split(";")[0]!, snippet };
      cachePreview(trackId, entry);
      return entry;
    } catch {
      /* try next */
    }
  }
  throw new Error("Preview is not available for this track");
}

export type RelatedTracks = {
  more: SearchResult[];
  versions: SearchResult[];
  similar: SearchResult[];
  playlists: SearchResult[];
};

/** Related results from live SoundCloud search, not generated placeholders. */
export async function findRelatedTracks(current: {
  id: number;
  artist: string;
  title: string;
}): Promise<RelatedTracks> {
  const artist = current.artist.trim();
  const base = baseTitle(current.title).trim() || current.title.trim();
  const [artistRes, titleRes] = await Promise.allSettled([
    artist ? searchSc(artist, "tracks", 30, 0) : Promise.resolve<SearchResult[]>([]),
    searchSc(base, "all", 50, 0),
  ]);

  const byArtist = artistRes.status === "fulfilled" ? artistRes.value : [];
  const byTitle = titleRes.status === "fulfilled" ? titleRes.value : [];
  const artistKey = normalizeText(artist);
  const baseKey = normalizeText(base);
  const sameArtist = (r: SearchResult) =>
    artistKey.length > 0 && normalizeText(r.artist) === artistKey;
  const titleMatch = (r: SearchResult) => {
    if (baseKey.length < 2) return false;
    const full = normalizeText(r.title);
    const trimmed = normalizeText(baseTitle(r.title));
    return full.includes(baseKey) || trimmed.includes(baseKey);
  };

  const seen = new Set<number>([current.id]);
  const take = (
    list: SearchResult[],
    accept: (r: SearchResult) => boolean,
    limit: number,
  ): SearchResult[] => {
    const out: SearchResult[] = [];
    for (const r of list) {
      if (r.kind !== "track" || seen.has(r.id) || !accept(r)) continue;
      seen.add(r.id);
      out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  };

  const more = take(byArtist, sameArtist, 6);
  const versions = take(
    byTitle,
    (r) => titleMatch(r) && !sameArtist(r) && r.category !== "original",
    6,
  );
  const similar = take(byTitle, (r) => titleMatch(r) && !sameArtist(r), 6);
  const playlists = byTitle.filter((r) => r.kind === "playlist" && titleMatch(r)).slice(0, 4);

  return { more, versions, similar, playlists };
}

const PLAYLIST_MAX_DEPTH = 3;
const PLAYLIST_MAX_SEGMENTS = 10_000;

/** A playlist line is either another playlist or one media segment. */
function isPlaylistUrl(url: URL): boolean {
  return /\.m3u8?$/i.test(url.pathname);
}

function playlistReferences(text: string): string[] {
  const refs: string[] = [];
  const init = text.match(/#EXT-X-MAP:URI="([^"]+)"/);
  if (init) refs.push(init[1]!);
  for (const line of text.split("\n")) {
    const entry = line.trim();
    if (entry && !entry.startsWith("#")) refs.push(entry);
  }
  return refs;
}

/**
 * Every media address in a playlist tree, each gated before it is fetched.
 *
 * Nested playlists are expanded here rather than returned as one address to read
 * later, so nothing downstream can follow a reference that never passed the
 * outbound policy. References resolve against the playlist that named them, which
 * is exactly where a new origin could otherwise be smuggled in.
 */
async function collectSegments(url: string, depth = 0): Promise<string[]> {
  if (depth >= PLAYLIST_MAX_DEPTH) throw new Error("This stream's playlist nests too deeply");
  const text = await (await call(url)).text();
  if (text.includes("#EXT-X-KEY") && !text.includes("METHOD=NONE")) {
    throw new Error("This track is DRM-protected");
  }
  const segments: string[] = [];
  for (const reference of playlistReferences(text)) {
    const target = await assertSafeMediaUrl(new URL(reference, url).toString());
    if (isPlaylistUrl(new URL(target))) {
      segments.push(...(await collectSegments(target, depth + 1)));
    } else {
      segments.push(target);
    }
    if (segments.length > PLAYLIST_MAX_SEGMENTS)
      throw new Error("This stream has too many segments");
  }
  return segments;
}

/** Fully buffer an HLS playlist (init segment + media segments) into one file. */
async function hlsBytes(m3u8: string): Promise<Uint8Array> {
  const urls = await collectSegments(m3u8);
  const parts: Uint8Array[] = new Array(urls.length);
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const i = next++;
      const r = await guardedFetch(urls[i]!);
      if (!r.ok) throw new Error("segment failed");
      parts[i] = new Uint8Array(await r.arrayBuffer());
    }
  };
  const WINDOW = 8;
  await Promise.all(Array.from({ length: Math.min(WINDOW, urls.length) }, worker));
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

/** Join an HLS playlist (init segment + media segments) into one file stream. */
export async function hlsStream(m3u8: string): Promise<ReadableStream<Uint8Array>> {
  const urls = await collectSegments(m3u8);
  // Fetch segments in parallel (sliding window) while preserving order.
  const WINDOW = 8;
  const get = async (u: string, tries = 2): Promise<Uint8Array> => {
    const r = await guardedFetch(u);
    if (!r.ok) {
      if (tries > 0) return get(u, tries - 1);
      throw new Error("segment failed");
    }
    return new Uint8Array(await r.arrayBuffer());
  };
  const pending: Promise<Uint8Array>[] = [];
  let next = 0;
  const fill = () => {
    while (next < urls.length && pending.length < WINDOW) {
      const p = get(urls[next++]!);
      p.catch(() => {});
      pending.push(p);
    }
  };
  return new ReadableStream({
    async pull(ctrl) {
      fill();
      const p = pending.shift();
      if (!p) return ctrl.close();
      try {
        ctrl.enqueue(await p);
      } catch (e) {
        ctrl.error(e);
      }
    },
  });
}
