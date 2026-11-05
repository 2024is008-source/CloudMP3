// Pure search classification & ranking. Used by the server (scoring before
// paginating) and by the UI (tabs, badges). No network or server imports here.

export type VersionKind =
  | "original"
  | "remix"
  | "slowed"
  | "sped_up"
  | "nightcore"
  | "reverb"
  | "bootleg"
  | "mashup"
  | "edit"
  | "flip"
  | "cover"
  | "instrumental";

export type SearchCategory = VersionKind | "playlist";

export type SearchTab = "original" | "remixes" | "covers" | "playlists" | "all";

export type SearchResult = {
  id: number;
  kind: "track" | "playlist";
  title: string;
  artist: string;
  duration: number;
  track_count: number;
  artwork_url: string | null;
  permalink_url: string;
  /** SoundCloud-verified uploader (user.verified). */
  verified: boolean;
  /** Upload matched SoundCloud publisher metadata (ISRC/artist) — an official release. */
  official: boolean;
  /** Full stream is authorized (not a snippet / blocked). */
  downloadable: boolean;
  playback_count: number;
  category: SearchCategory;
};

export const SEARCH_TABS: ReadonlyArray<{ id: SearchTab; label: string }> = [
  { id: "original", label: "Original" },
  { id: "remixes", label: "Remixes" },
  { id: "covers", label: "Covers" },
  { id: "playlists", label: "Playlists" },
  { id: "all", label: "All" },
];

export const CATEGORY_LABELS: Record<SearchCategory, string> = {
  original: "Original",
  remix: "Remix",
  slowed: "Slowed",
  sped_up: "Sped Up",
  nightcore: "Nightcore",
  reverb: "Reverb",
  bootleg: "Bootleg",
  mashup: "Mashup",
  edit: "Edit",
  flip: "Flip",
  cover: "Cover",
  instrumental: "Instrumental",
  playlist: "Playlist",
};

const REMIX_FAMILY: ReadonlySet<SearchCategory> = new Set([
  "remix",
  "mashup",
  "bootleg",
  "edit",
  "flip",
  "instrumental",
]);

const PITCH_FAMILY: ReadonlySet<SearchCategory> = new Set([
  "slowed",
  "sped_up",
  "nightcore",
  "reverb",
]);

/** Version markers common enough to trust anywhere in a title. */
const STRONG_MARKERS: ReadonlyArray<[VersionKind, RegExp]> = [
  ["nightcore", /\bnight\s?core\b/i],
  ["slowed", /\bslowed(?:\s*(?:\+|and|&)\s*reverb)?\b/i],
  ["sped_up", /\b(?:sped|speed)\s?up\b|\bspedup\b/i],
  ["reverb", /\breverb(?:ed)?\b/i],
  ["remix", /\bremix(?:es|ed)?\b|\brmx\b/i],
  ["mashup", /\bmash[\s-]?up\b/i],
  ["bootleg", /\bbootleg\b/i],
];

/**
 * Words that also appear in ordinary song titles ("Cover Me", "The Edit").
 * Only trusted inside brackets/after a dash, in the trailing words, or in tags.
 */
const CONTEXT_MARKERS: ReadonlyArray<[VersionKind, RegExp]> = [
  ["cover", /\bcover(?:ed|s)?\b/i],
  ["instrumental", /\binstrumental\b/i],
  ["edit", /\b(?:re-?)?edit(?:ed)?\b/i],
  ["flip", /\bflip\b/i],
];

const PRIMARY_ORDER: ReadonlyArray<VersionKind> = [
  "cover",
  "remix",
  "mashup",
  "bootleg",
  "flip",
  "edit",
  "nightcore",
  "slowed",
  "sped_up",
  "reverb",
  "instrumental",
];

const BRACKET_GROUP = /[([{][^)\]}]*[)\]}]/g;
const BRACKET_CONTENT = /[([{]([^)\]}]*)[)\]}]/g;

function bracketParts(title: string): string[] {
  return [...title.matchAll(BRACKET_CONTENT)].map((m) => m[1] ?? "");
}

function dashParts(title: string): string[] {
  const parts = title.split(/\s+[-–—]\s+/);
  return parts.length > 1 ? parts.slice(1) : [];
}

/** Title with brackets and version suffixes removed, for exact comparisons. */
export function baseTitle(title: string): string {
  const withoutBrackets = title.replace(BRACKET_GROUP, " ").trim();
  const parts = withoutBrackets.split(/\s+[-–—]\s+/);
  if (parts.length > 1 && detectVersions({ title: parts.slice(1).join(" ") }).length > 0) {
    return (parts[0] ?? withoutBrackets).trim();
  }
  return withoutBrackets;
}

export type VersionSignals = {
  title: string;
  tags?: string | null;
  genre?: string | null;
};

/** All version markers found across title, tags and genre. */
export function detectVersions(signals: VersionSignals): VersionKind[] {
  const { title } = signals;
  const meta = `${signals.tags ?? ""} ${signals.genre ?? ""}`.trim();
  const contexts = [...bracketParts(title), ...dashParts(title)];
  const tail = title.split(/\s+/).slice(-4).join(" ");
  const found = new Set<VersionKind>();

  for (const [kind, re] of STRONG_MARKERS) {
    if (re.test(title) || (meta && re.test(meta))) found.add(kind);
  }
  if (meta) {
    for (const [kind, re] of CONTEXT_MARKERS) if (re.test(meta)) found.add(kind);
  }
  for (const [kind, re] of CONTEXT_MARKERS) {
    if (contexts.some((c) => re.test(c)) || re.test(tail)) found.add(kind);
  }

  return PRIMARY_ORDER.filter((k) => found.has(k));
}

/** Primary category for a track; "original" when no version marker is found. */
export function classifyVersion(signals: VersionSignals): VersionKind {
  return detectVersions(signals)[0] ?? "original";
}

export function matchesTab(item: SearchResult, tab: SearchTab): boolean {
  switch (tab) {
    case "original":
      return item.kind === "track" && item.category === "original";
    case "remixes":
      return (
        item.kind === "track" &&
        (REMIX_FAMILY.has(item.category) || PITCH_FAMILY.has(item.category))
      );
    case "covers":
      return item.kind === "track" && item.category === "cover";
    case "playlists":
      return item.kind === "playlist";
    case "all":
      return true;
  }
}

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "of",
  "to",
  "in",
  "on",
  "for",
  "feat",
  "ft",
  "featuring",
  "official",
  "audio",
  "video",
  "music",
  "lyrics",
  "lyric",
  "song",
  "prod",
  "remaster",
  "remastered",
  "version",
]);

export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(value: string): string[] {
  return normalizeText(value)
    .split(" ")
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/** Fraction of `needles` that appear in `haystack`. */
function coverage(needles: readonly string[], haystack: readonly string[]): number {
  if (needles.length === 0) return 0;
  const set = new Set(haystack);
  let hit = 0;
  for (const n of needles) if (set.has(n)) hit++;
  return hit / needles.length;
}

function titleScore(queryTokens: readonly string[], itemTitle: string): number {
  const titleTokens = tokens(baseTitle(itemTitle));
  if (titleTokens.length === 0 || queryTokens.length === 0) return 0;
  return Math.max(coverage(queryTokens, titleTokens), coverage(titleTokens, queryTokens));
}

function artistScore(queryTokens: readonly string[], artist: string): number {
  const artistTokens = tokens(artist);
  if (artistTokens.length === 0 || queryTokens.length === 0) return 0;
  return Math.max(coverage(artistTokens, queryTokens), coverage(queryTokens, artistTokens) * 0.9);
}

function tierFor(item: SearchResult, tScore: number, aScore: number): number {
  if (item.kind === "playlist") return 380;

  if (item.category !== "original") {
    // An official alternative release can outrank unofficial remixes, but no
    // alternative version (even an exact-titled remix) outranks a real original.
    if (item.official) return 620;
    if (REMIX_FAMILY.has(item.category)) return 560;
    if (PITCH_FAMILY.has(item.category)) return 500;
    return 440; // covers
  }

  if (tScore >= 0.999 && aScore >= 0.75) return 1000;
  if (tScore >= 0.999) return 900;
  if (tScore >= 0.6) return 800;
  return 700;
}

export type RankedSearchResult = SearchResult & { score: number };

function dedupeKey(item: SearchResult): string {
  if (item.kind === "playlist") {
    return `p|${normalizeText(item.title)}|${normalizeText(item.artist)}`;
  }
  return `t|${normalizeText(baseTitle(item.title))}|${normalizeText(item.artist)}|${item.category}`;
}

/**
 * Relevance ranking with category tiers, duplicate removal and a popularity
 * tiebreak. Result order never depends on SoundCloud's raw ordering.
 */
export function rankSearchItems(
  query: string,
  items: readonly SearchResult[],
): RankedSearchResult[] {
  const queryTokens = tokens(query);

  const scored: RankedSearchResult[] = items.map((item) => {
    const tScore = titleScore(queryTokens, item.title);
    const aScore = artistScore(queryTokens, item.artist);
    const tier = tierFor(item, tScore, aScore);
    const relevance = Math.round(tScore * 50 + aScore * 30);
    const quality =
      (item.verified ? 8 : 0) +
      (item.official ? 10 : 0) +
      Math.min(6, Math.log10((item.playback_count ?? 0) + 1));
    return { ...item, score: tier * 10_000 + relevance * 100 + quality };
  });

  scored.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));

  const seen = new Set<string>();
  const out: RankedSearchResult[] = [];
  for (const item of scored) {
    const keys = [`${item.kind}:${item.id}`, dedupeKey(item)];
    if (keys.some((k) => seen.has(k))) continue;
    for (const k of keys) seen.add(k);
    out.push(item);
  }
  return out;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
