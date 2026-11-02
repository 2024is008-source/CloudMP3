import { createFileRoute } from "@tanstack/react-router";
import { useState, useRef, useEffect, useMemo, useSyncExternalStore } from "react";
import { zip } from "fflate";
import { convert, FORMATS, type Format } from "@/lib/convert";
import { fetchCover, tagMp3 } from "@/lib/id3";
import {
  Download,
  FolderArchive,
  Search,
  Music,
  Loader2,
  Check,
  AlertCircle,
  ClipboardPaste,
  Zap,
  MousePointerClick,
  ListMusic,
  Tags,
  Smartphone,
  PackageX,
  Copy,
  Link2,
  FileAudio,
  Pause,
  Play,
  XCircle,
  RotateCcw,
  User,
  Clock,
  HardDrive,
  ArrowUpDown,
} from "lucide-react";
import { z } from "zod";
import { toast } from "sonner";

import { getInfo } from "@/lib/sc.functions";
import { clearSelection, getSelection, subscribeSelection } from "@/lib/selection";
import { Link, useNavigate } from "@tanstack/react-router";
import { SITE } from "@/lib/site";
import { seoHead } from "@/lib/seo";
import { Equalizer } from "@/components/Equalizer";
import { BrandMark } from "@/components/Navbar";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Skeleton } from "@/components/ui/skeleton";

const HOME_FAQ = [
  {
    q: "How do I convert a SoundCloud track to MP3?",
    a: "Copy the track link from SoundCloud, paste it into the box above, press Fetch, choose an MP3 bitrate (128 to 320kbps) and click the download arrow. The conversion runs in your browser.",
  },
  {
    q: "Can I download a whole SoundCloud playlist at once?",
    a: "Yes. Paste a playlist or album link, then use Download ZIP to get every track in one archive with numbered filenames, or Download All to save each file separately.",
  },
  {
    q: "Can I paste an artist profile link?",
    a: "Yes. A profile link loads that artist's uploads and lists their playlists underneath, so you can open any one of them. Individual tracks that are Go+ only, region-locked or taken down still fail, so check the failed count before you assume the set is complete.",
  },
  {
    q: "Is 320kbps MP3 better than the original?",
    a: "No. SoundCloud streams most audio as AAC at up to 160kbps. A 320kbps MP3 or a WAV file plays on more devices, but it cannot add detail that was not in the source.",
  },
  {
    q: "Is this SoundCloud to MP3 converter free?",
    a: "Yes. There is no sign-up, no app and no download limit. Pick MP3 at 128, 192, 256 or 320kbps, WAV, or the original AAC file.",
  },
  {
    q: "Will the MP3 play on my MP3 player or car stereo?",
    a: "Yes. The files are standard MP3s with ID3 tags, so the title, artist and cover art show up in music apps, MP3 players and car stereos.",
  },
  {
    q: "Does it work on iPhone and Android?",
    a: "Yes. It runs in Safari, Chrome and other mobile browsers with nothing to install. On iPhone, files save to the Files app; on Android, to Downloads.",
  },
];

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => v === true || v === "true" || v === "1")
  .optional();

const searchSchema = z.object({ focus: boolish });

export const Route = createFileRoute("/")({
  validateSearch: searchSchema,
  head: () => ({
    ...seoHead({
      title: "SoundCloud to MP3 Converter — Free, No Signup | CloudMP3",
      description:
        "Convert SoundCloud tracks, albums and playlists to MP3 (up to 320kbps), WAV or original AAC — free, no sign-up, whole playlists as one ZIP.",
      path: "",
    }),
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "WebApplication",
          name: SITE.name,
          url: `${SITE.origin}/`,
          applicationCategory: "MultimediaApplication",
          operatingSystem: "All",
          browserRequirements: "Requires a modern web browser",
          offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
          featureList: [
            "SoundCloud to MP3 (128, 192, 256, 320kbps)",
            "SoundCloud to WAV",
            "Original AAC download",
            "Full playlist and album ZIP download",
            "Automatic ID3 tagging & cover art",
          ],
        }),
      },
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: HOME_FAQ.map((f) => ({
            "@type": "Question",
            name: f.q,
            acceptedAnswer: { "@type": "Answer", text: f.a },
          })),
        }),
      },
    ],
  }),
  component: Index,
});

type Track = {
  id: number;
  title: string;
  artist: string;
  duration: number;
  permalink_url: string;
  artwork_url: string | null;
};
type ProfileSet = {
  id: number;
  title: string;
  permalink_url: string;
  track_count: number;
  artwork_url: string | null;
};
type Info = {
  type: "track" | "playlist" | "profile";
  title: string;
  creator: string;
  artwork_url: string | null;
  track_count: number;
  total_duration: number;
  tracks: Track[];
  sets?: ProfileSet[];
  more_uploads?: boolean;
  more_sets?: boolean;
};

type Job = {
  kind: "files" | "zip";
  total: number;
  done: number;
  failed: number;
  current: string | null;
  paused: boolean;
};

// Rough bytes-per-second for the size estimate, keyed by format.
const RATES: Record<Format, number> = {
  "original-high": 20_000,
  "original-low": 12_000,
  "mp3-320": 40_000,
  "mp3-256": 32_000,
  "mp3-192": 24_000,
  "mp3-128": 16_000,
  wav: 176_000,
};

const fmtSize = (bytes: number) =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;

const PAGE = 50;

function fmt(ms: number) {
  const s = Math.round(ms / 1000),
    h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    r = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(r)}` : `${m}:${p(r)}`;
}
const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, "_");

async function fetchTrack(t: Track, fmt: Format, album?: string, track?: number) {
  const q = fmt === "original-low" ? "low" : "high";
  const r = await fetch(`/api/public/track?id=${t.id}&q=${q}`);
  if (!r.ok) throw new Error(await r.text());
  const raw = new Uint8Array(await r.arrayBuffer());
  const out = await convert(raw, r.headers.get("X-File-Ext") ?? "m4a", fmt);
  if (out.ext === "mp3") {
    const cover = await fetchCover(t.artwork_url);
    out.data = tagMp3(out.data, { title: t.title, artist: t.artist, album, track, cover });
  }
  return out;
}
function save(data: BlobPart, name: string, type: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function Index() {
  const { focus } = Route.useSearch();
  const navigate = useNavigate();
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [state, setState] = useState<Record<number, "busy" | "done" | "err">>({});
  const [job, setJob] = useState<Job | null>(null);
  const [quality, setQuality] = useState<Format>("mp3-320");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [trackQuery, setTrackQuery] = useState("");
  const [sortBy, setSortBy] = useState<"default" | "title" | "artist" | "duration">("default");
  const [shown, setShown] = useState(PAGE);
  const cancelRef = useRef(false);
  const pauseRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focus) inputRef.current?.focus();
  }, [focus]);

  async function load(u: string, autoDownload = false) {
    setError(null);
    setLoading(true);
    try {
      const r = await getInfo({ data: { url: u } });
      if (r.ok) {
        const first = r.info.type === "track" ? r.info.tracks[0] : undefined;
        if (first) {
          void navigate({
            to: "/track/$id",
            params: { id: String(first.id) },
            search: autoDownload ? { download: true } : {},
          });
          return;
        }
        setInfo(r.info as Info);
        setState({});
        setSelected(new Set());
        setTrackQuery("");
        setSortBy("default");
        setShown(PAGE);
      } else {
        setError(r.error);
        toast.error(r.error);
      }
    } catch {
      setError("That doesn't look like a valid SoundCloud link.");
      toast.error("That doesn't look like a valid SoundCloud link.");
    } finally {
      setLoading(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    await load(url.trim());
  }

  // A pick from the header search bar fills the box and loads it.
  const picked = useSyncExternalStore(subscribeSelection, getSelection, () => null);
  useEffect(() => {
    if (!picked) return;
    clearSelection();
    setUrl(picked.url);
    void load(picked.url, picked.autoDownload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked]);

  /** Download a single track. Returns true on success; toasts are left to the caller. */
  async function one(t: Track): Promise<boolean> {
    setState((s) => ({ ...s, [t.id]: "busy" }));
    try {
      const multi = info && info.tracks.length > 1;
      const f = await fetchTrack(
        t,
        quality,
        multi ? info.title : undefined,
        multi ? info.tracks.indexOf(t) + 1 : undefined,
      );
      save(f.data as BlobPart, `${safe(`${t.artist} - ${t.title}`)}.${f.ext}`, f.mime);
      setState((s) => ({ ...s, [t.id]: "done" }));
      return true;
    } catch {
      setState((s) => ({ ...s, [t.id]: "err" }));
      return false;
    }
  }

  async function clickOne(t: Track) {
    if (job) return;
    if (await one(t)) toast.success(`Saved ${t.title}`);
    else toast.error(`Couldn't download ${t.title}`);
  }

  /** Wait out a pause / bail on cancel. Returns false when cancelled. */
  async function gate() {
    while (pauseRef.current && !cancelRef.current) await new Promise((r) => setTimeout(r, 250));
    return !cancelRef.current;
  }

  async function runFiles(tracks: Track[]) {
    if (job || tracks.length === 0) return;
    cancelRef.current = false;
    pauseRef.current = false;
    let failed = 0;
    const queue = [...tracks];
    setJob({
      kind: "files",
      total: tracks.length,
      done: 0,
      failed: 0,
      current: null,
      paused: false,
    });
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (queue.length) {
          if (!(await gate())) return;
          const t = queue.shift()!;
          setJob((j) => (j ? { ...j, current: t.title } : j));
          if (!(await one(t))) failed++;
          setJob((j) => (j ? { ...j, done: j.done + 1, failed, current: null } : j));
        }
      }),
    );
    const cancelled = cancelRef.current;
    setJob(null);
    if (cancelled) toast.info("Download cancelled.");
    else if (failed)
      toast.error(`${failed} of ${tracks.length} downloads failed — use Retry failed.`);
    else toast.success(`Saved ${tracks.length} track${tracks.length > 1 ? "s" : ""}`);
  }

  async function runZip(tracks: Track[], name: string) {
    if (job || tracks.length === 0) return;
    cancelRef.current = false;
    pauseRef.current = false;
    const files: Record<string, Uint8Array> = {};
    let failed = 0;
    const queue = [...tracks.entries()];
    setJob({ kind: "zip", total: tracks.length, done: 0, failed: 0, current: null, paused: false });
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        while (queue.length) {
          if (!(await gate())) return;
          const [i, t] = queue.shift()!;
          setJob((j) => (j ? { ...j, current: t.title } : j));
          setState((s) => ({ ...s, [t.id]: "busy" }));
          try {
            const f = await fetchTrack(t, quality, name, i + 1);
            files[
              `${String(i + 1).padStart(2, "0")} ${safe(`${t.artist} - ${t.title}`)}.${f.ext}`
            ] = f.data;
            setState((s) => ({ ...s, [t.id]: "done" }));
          } catch {
            failed++;
            setState((s) => ({ ...s, [t.id]: "err" }));
          }
          setJob((j) => (j ? { ...j, done: j.done + 1, failed, current: null } : j));
        }
      }),
    );
    if (cancelRef.current) {
      setJob(null);
      toast.info("ZIP cancelled.");
      return;
    }
    if (Object.keys(files).length === 0) {
      setJob(null);
      toast.error("Every track failed — nothing to ZIP.");
      return;
    }
    setJob((j) => (j ? { ...j, current: "Building ZIP…" } : j));
    zip(files, { level: 0 }, (err, data) => {
      if (!err) {
        save(data as BlobPart, `${safe(name)}.zip`, "application/zip");
        toast.success(
          `ZIP ready — ${Object.keys(files).length} tracks${failed ? ` (${failed} skipped)` : ""}`,
        );
      } else {
        toast.error("Couldn't build the ZIP archive.");
      }
      setJob(null);
    });
  }

  function togglePause() {
    pauseRef.current = !pauseRef.current;
    setJob((j) => (j ? { ...j, paused: pauseRef.current } : j));
  }

  function cancelJob() {
    cancelRef.current = true;
    pauseRef.current = false;
  }

  const failedTracks = info ? info.tracks.filter((t) => state[t.id] === "err") : [];
  const selectedTracks = info ? info.tracks.filter((t) => selected.has(t.id)) : [];

  function toggleSelect(id: number) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function toggleSelectAll() {
    if (!info) return;
    setSelected((s) =>
      s.size === info.tracks.length ? new Set() : new Set(info.tracks.map((t) => t.id)),
    );
  }

  const visibleTracks = useMemo(() => {
    if (!info) return [];
    let list = info.tracks.map((t, i) => ({ t, i }));
    const q = trackQuery.trim().toLowerCase();
    if (q)
      list = list.filter(
        ({ t }) => t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q),
      );
    if (sortBy === "title") list = [...list].sort((a, b) => a.t.title.localeCompare(b.t.title));
    else if (sortBy === "artist")
      list = [...list].sort((a, b) => a.t.artist.localeCompare(b.t.artist));
    else if (sortBy === "duration") list = [...list].sort((a, b) => a.t.duration - b.t.duration);
    return list;
  }, [info, trackQuery, sortBy]);
  const pageTracks = visibleTracks.slice(0, shown);
  const profileSets = info?.type === "profile" ? (info.sets ?? []) : [];

  return (
    <main className="relative isolate mx-auto w-full max-w-4xl px-4 pb-12 pt-4 md:pt-6">
      {!info && <Equalizer />}
      {!info ? (
        <section className="mx-auto mt-0 max-w-2xl text-center md:mt-4">
          <div
            className="rise-in relative mx-auto mb-3 flex h-20 w-20 md:h-24 md:w-24 items-center justify-center"
            aria-hidden
          >
            <span className="absolute h-20 w-20 md:h-24 md:w-24 animate-ping rounded-full bg-primary/20 [animation-duration:2.4s]" />
            <span className="absolute h-20 w-20 rounded-full bg-primary/25 blur-xl" />
            <BrandMark className="relative scale-[1.8] md:scale-[2.2] shadow-2xl shadow-primary/40" />
          </div>
          <span className="rise-in inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/10 px-3 py-1 text-xs font-medium tracking-wide text-primary">
            No sign-up · no app · no queue
          </span>
          <h1
            className="rise-in mt-4 text-[2.5rem] font-bold leading-[1.05] tracking-tight sm:text-5xl md:text-6xl"
            style={{ ["--rise-delay" as string]: "0.1s" }}
          >
            SoundCloud <span className="text-shimmer">to MP3</span>
          </h1>
          <p
            className="rise-in mt-3 text-muted-foreground"
            style={{ ["--rise-delay" as string]: "0.2s" }}
          >
            A free SoundCloud to MP3 converter for tracks, albums and playlists — up to 320kbps, or
            one ZIP.
          </p>
          <form
            onSubmit={submit}
            style={{ ["--rise-delay" as string]: "0.3s" }}
            className="rise-in mt-8 flex shadow-2xl shadow-primary/10 backdrop-blur gap-2 rounded-full border border-border bg-card p-2"
          >
            <input
              ref={inputRef}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
              placeholder="Paste a SoundCloud track, playlist or profile link…"
              className="min-w-0 flex-1 bg-transparent px-4 text-sm outline-none placeholder:text-muted-foreground"
            />
            <button
              type="button"
              onClick={async () => {
                try {
                  const text = await navigator.clipboard.readText();
                  if (text) setUrl(text.trim());
                } catch {
                  toast.error("Clipboard access denied — paste the link manually.");
                }
              }}
              aria-label="Paste link from clipboard"
              className="hidden items-center gap-1.5 rounded-full border border-border px-3.5 py-2.5 text-xs font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground sm:inline-flex"
            >
              <ClipboardPaste className="h-4 w-4" /> Paste
            </button>
            <button
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Search className="h-4 w-4" />
              )}{" "}
              Fetch
            </button>
          </form>
          {error && (
            <p className="mt-4 inline-flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              {error}
            </p>
          )}
          <p className="mt-8 text-xs text-muted-foreground">
            {SITE.name} works best on content you own or have permission to save.
          </p>
        </section>
      ) : null}
      {loading && !info && (
        <section
          aria-busy="true"
          aria-label="Loading track information"
          className="mx-auto mt-12 max-w-3xl"
        >
          <div className="flex flex-col gap-6 rounded-3xl border border-border bg-card p-6 sm:flex-row sm:items-end">
            <Skeleton className="h-44 w-44 rounded-2xl" />
            <div className="w-full space-y-3">
              <Skeleton className="h-5 w-20 rounded-full" />
              <Skeleton className="h-9 w-2/3" />
              <Skeleton className="h-4 w-40" />
            </div>
          </div>
          <div className="mt-6 space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-xl" />
            ))}
          </div>
        </section>
      )}
      {!info ? (
        <div className="mx-auto mt-24 max-w-3xl space-y-16 text-left">
          <section>
            <h2 className="text-2xl font-bold tracking-tight">
              Convert a SoundCloud Link to MP3 in Four Steps
            </h2>
            <ol className="mt-5 grid gap-3 sm:grid-cols-2">
              {[
                {
                  icon: Copy,
                  t: "Copy the link",
                  b: "On SoundCloud, open a track, album or playlist and choose Share → Copy link.",
                },
                {
                  icon: Link2,
                  t: "Paste and fetch",
                  b: "Paste it into the box above and press Fetch to load the cover and track list.",
                },
                {
                  icon: FileAudio,
                  t: "Choose a format",
                  b: "Pick MP3 at 128, 192, 256 or 320kbps, WAV, or the original AAC file.",
                },
                {
                  icon: Download,
                  t: "Download",
                  b: "Save one track, every track, or the whole playlist as a single ZIP.",
                },
              ].map(({ icon: Icon, t, b }, i) => (
                <li
                  key={t}
                  className="group rounded-2xl border border-border bg-card p-5 transition-all duration-300 hover:-translate-y-1 hover:border-primary/40 hover:shadow-lg hover:shadow-primary/10"
                >
                  <div className="flex items-center gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                      <Icon className="h-5 w-5" />
                    </span>
                    <h3 className="font-semibold">
                      <span className="text-primary">{i + 1}.</span> {t}
                    </h3>
                  </div>
                  <p className="mt-2.5 text-sm text-muted-foreground">{b}</p>
                </li>
              ))}
            </ol>
            <p className="mt-4 text-sm text-muted-foreground">
              Need iPhone or Android steps? Read the full{" "}
              <Link
                to="/how-to-download"
                className="text-primary underline-offset-4 hover:underline"
              >
                guide to downloading from SoundCloud
              </Link>
              .
            </p>
          </section>
          <section>
            <h2 className="text-2xl font-bold tracking-tight">
              Why Use {SITE.name}? High-Bitrate Audio &amp; ID3 Tag Preservation
            </h2>
            <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {[
                {
                  icon: Zap,
                  t: "Fast processing",
                  b: `SoundCloud delivers audio as HLS segments. ${SITE.name} fetches them in parallel and joins them into one clean file.`,
                },
                {
                  icon: MousePointerClick,
                  t: "Simple interface",
                  b: "Paste a link, press Fetch, download. No sign-up, no queue, no clutter.",
                },
                {
                  icon: ListMusic,
                  t: "Playlist support",
                  b: "Albums and playlists download several tracks at once and pack into one ZIP with numbered filenames.",
                },
                {
                  icon: Tags,
                  t: "Metadata preserved",
                  b: "MP3s include ID3 tags: title, artist, album, track number and cover art.",
                },
                {
                  icon: Smartphone,
                  t: "Mobile-friendly",
                  b: "Works in Safari, Chrome and other mobile browsers — files save straight to your phone.",
                },
                {
                  icon: PackageX,
                  t: "Nothing to install",
                  b: "MP3 and WAV are encoded in your browser from the original stream, so nothing is stored on our servers.",
                },
              ].map(({ icon: Icon, t, b }) => (
                <div
                  key={t}
                  className="group rounded-2xl border border-border bg-card p-5 transition-all duration-300 hover:-translate-y-1 hover:border-primary/40 hover:shadow-lg hover:shadow-primary/10"
                >
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                    <Icon className="h-5 w-5" />
                  </span>
                  <h3 className="mt-3 font-semibold">{t}</h3>
                  <p className="mt-1.5 text-sm text-muted-foreground">{b}</p>
                </div>
              ))}
            </div>
          </section>
          <section>
            <h2 className="text-2xl font-bold tracking-tight">
              Frequently Asked Questions About SoundCloud Audio Extraction
            </h2>
            <Accordion type="single" collapsible className="mt-5 space-y-3">
              {HOME_FAQ.map((f, i) => (
                <AccordionItem
                  key={f.q}
                  value={`faq-${i}`}
                  className="rounded-2xl border border-border bg-card px-5 transition-colors data-[state=open]:border-primary/40"
                >
                  <AccordionTrigger className="py-4 text-left text-sm font-semibold hover:no-underline">
                    {f.q}
                  </AccordionTrigger>
                  <AccordionContent className="text-sm leading-relaxed text-muted-foreground">
                    {f.a}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
            <p className="mt-5 text-sm text-muted-foreground">
              More answers on the{" "}
              <Link to="/faq" className="text-primary underline-offset-4 hover:underline">
                features &amp; FAQ page
              </Link>
              .
            </p>
          </section>
        </div>
      ) : (
        <section className="pb-24">
          {/* Playlist header card */}
          <div className="relative overflow-hidden rounded-3xl border border-border bg-card/60 p-6 shadow-2xl shadow-primary/5 backdrop-blur-xl sm:p-8">
            <div
              className="pointer-events-none absolute -top-24 right-0 h-64 w-64 rounded-full bg-primary/15 blur-3xl"
              aria-hidden
            />
            <div className="relative flex flex-col gap-6 sm:flex-row sm:items-end">
              {info.artwork_url ? (
                <img
                  src={info.artwork_url}
                  alt={info.title}
                  className="h-44 w-44 rounded-2xl object-cover shadow-2xl shadow-primary/20 ring-1 ring-border sm:h-52 sm:w-52"
                />
              ) : (
                <div className="flex h-44 w-44 items-center justify-center rounded-2xl bg-muted ring-1 ring-border sm:h-52 sm:w-52">
                  <Music className="h-12 w-12 text-muted-foreground" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-primary">
                  {info.type}
                </span>
                <h2 className="mt-3 text-3xl font-bold leading-tight tracking-tight md:text-4xl">
                  {info.title}
                </h2>
                <p className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground">
                  <User className="h-3.5 w-3.5" /> {info.creator}
                </p>
                <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <ListMusic className="h-4 w-4 text-primary" />
                    {info.type === "profile" && info.track_count === 0
                      ? "No direct uploads"
                      : `${info.track_count} track${info.track_count === 1 ? "" : "s"}`}
                  </span>
                  {info.total_duration > 0 && (
                    <>
                      <span className="inline-flex items-center gap-1.5">
                        <Clock className="h-4 w-4 text-primary" /> {fmt(info.total_duration)}
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <HardDrive className="h-4 w-4 text-primary" /> ≈{" "}
                        {fmtSize((info.total_duration / 1000) * RATES[quality])}
                      </span>
                    </>
                  )}
                </div>
                {info.type === "profile" && info.more_uploads && (
                  <p className="mt-3 text-xs text-muted-foreground">
                    Only {info.track_count} of this profile's uploads are listed here. Paste a
                    specific track or playlist link to reach the rest.
                  </p>
                )}
              </div>
            </div>
            {job && (
              <div className="relative mt-6">
                <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
                  <div
                    className="h-full rounded-full bg-primary transition-all duration-300"
                    style={{ width: `${Math.round((job.done / job.total) * 100)}%` }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Download progress manager */}
          {job && (
            <div className="mt-4 rounded-2xl border border-border bg-card/60 p-4 backdrop-blur-xl">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                <span className="inline-flex items-center gap-2 font-semibold">
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  {job.kind === "zip" ? "Preparing ZIP" : "Downloading"} {job.done}/{job.total}
                </span>
                {job.current && (
                  <span className="min-w-0 max-w-48 truncate text-muted-foreground">
                    Now: {job.current}
                  </span>
                )}
                <span className="text-muted-foreground">
                  Remaining: {Math.max(0, job.total - job.done)}
                </span>
                {job.failed > 0 && <span className="text-destructive">Failed: {job.failed}</span>}
                <span className="ml-auto flex items-center gap-2">
                  <button
                    onClick={togglePause}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-medium transition hover:bg-accent"
                  >
                    {job.paused ? (
                      <Play className="h-3.5 w-3.5" />
                    ) : (
                      <Pause className="h-3.5 w-3.5" />
                    )}
                    {job.paused ? "Resume" : "Pause"}
                  </button>
                  <button
                    onClick={cancelJob}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-destructive transition hover:bg-accent"
                  >
                    <XCircle className="h-3.5 w-3.5" /> Cancel
                  </button>
                </span>
              </div>
            </div>
          )}

          {/* Toolbar */}
          <div className="mt-5 flex flex-wrap items-center gap-2">
            {info.tracks.length > 0 && (
              <>
                <button
                  onClick={() => runFiles(info.tracks)}
                  disabled={!!job}
                  className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
                >
                  <Download className="h-4 w-4" /> Download All
                </button>
                <button
                  onClick={() => runZip(info.tracks, info.title)}
                  disabled={!!job}
                  className="inline-flex items-center gap-2 rounded-full border border-border bg-secondary px-5 py-2.5 text-sm font-semibold transition hover:bg-accent disabled:opacity-60"
                >
                  <FolderArchive className="h-4 w-4" /> Download ZIP
                </button>
                <label className="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2.5 text-sm text-muted-foreground">
                  <Music className="h-4 w-4" />
                  <select
                    value={quality}
                    onChange={(e) => setQuality(e.target.value as Format)}
                    className="bg-transparent text-foreground outline-none [&>option]:bg-popover"
                  >
                    {FORMATS.map((f) => (
                      <option key={f.value} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </label>
                {failedTracks.length > 0 && !job && (
                  <button
                    onClick={() => runFiles(failedTracks)}
                    className="inline-flex items-center gap-2 rounded-full border border-destructive/40 px-4 py-2.5 text-sm font-medium text-destructive transition hover:bg-destructive/10"
                  >
                    <RotateCcw className="h-4 w-4" /> Retry failed ({failedTracks.length})
                  </button>
                )}
                {selected.size > 0 && (
                  <span className="text-xs font-medium text-muted-foreground">
                    {selected.size} selected
                  </span>
                )}
              </>
            )}
            <button
              onClick={() => {
                setInfo(null);
                setUrl("");
              }}
              className="ml-auto inline-flex items-center gap-2 rounded-full px-4 py-2.5 text-sm text-muted-foreground transition hover:bg-accent hover:text-foreground"
            >
              <Search className="h-4 w-4" /> Search another
            </button>
          </div>

          {info.tracks.length > 0 && (
            <>
              {/* Track filter + sort */}
              <div className="mt-5 flex flex-col gap-2 sm:flex-row">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    value={trackQuery}
                    onChange={(e) => {
                      setTrackQuery(e.target.value);
                      setShown(PAGE);
                    }}
                    placeholder="Filter by track or artist…"
                    aria-label="Filter tracks"
                    className="w-full rounded-full border border-border bg-card py-2 pl-9 pr-4 text-sm outline-none transition placeholder:text-muted-foreground focus:border-primary/70"
                  />
                </div>
                <label className="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-sm text-muted-foreground">
                  <ArrowUpDown className="h-4 w-4" />
                  <select
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                    aria-label="Sort tracks"
                    className="bg-transparent text-foreground outline-none [&>option]:bg-popover"
                  >
                    <option value="default">Original order</option>
                    <option value="title">Sort by title</option>
                    <option value="artist">Sort by artist</option>
                    <option value="duration">Sort by duration</option>
                  </select>
                </label>
              </div>

              {/* Track list */}
              <div className="mt-4 overflow-hidden rounded-2xl border border-border bg-card/40">
                <div className="flex items-center gap-3 border-b border-border bg-muted/60 px-4 py-2 text-xs uppercase tracking-wider text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={info.tracks.length > 0 && selected.size === info.tracks.length}
                    onChange={toggleSelectAll}
                    aria-label="Select all tracks"
                    className="h-4 w-4 shrink-0 accent-primary"
                  />
                  <span className="hidden w-6 sm:block">#</span>
                  <span className="flex-1">Title</span>
                  <span className="hidden w-12 text-right sm:block">Time</span>
                  <span className="w-9" />
                </div>
                {pageTracks.map(({ t, i }) => (
                  <div
                    key={t.id}
                    className="flex items-center gap-3 border-b border-border/60 px-4 py-2.5 transition last:border-0 hover:bg-card"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(t.id)}
                      onChange={() => toggleSelect(t.id)}
                      aria-label={`Select ${t.title}`}
                      className="h-4 w-4 shrink-0 accent-primary"
                    />
                    <span className="hidden w-6 text-sm text-muted-foreground sm:block">
                      {i + 1}
                    </span>
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      {t.artwork_url ? (
                        <img
                          src={t.artwork_url}
                          alt=""
                          loading="lazy"
                          className="h-10 w-10 shrink-0 rounded-md object-cover"
                        />
                      ) : (
                        <div className="h-10 w-10 shrink-0 rounded-md bg-muted" />
                      )}
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold">{t.title}</p>
                        <p className="truncate text-xs text-muted-foreground">{t.artist}</p>
                      </div>
                    </div>
                    <span className="hidden w-12 text-right text-sm text-muted-foreground sm:block">
                      {fmt(t.duration)}
                    </span>
                    <button
                      onClick={() => clickOne(t)}
                      disabled={state[t.id] === "busy" || !!job}
                      aria-label={
                        state[t.id] === "err" ? `Retry ${t.title}` : `Download ${t.title}`
                      }
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition hover:bg-accent disabled:opacity-60"
                    >
                      {state[t.id] === "busy" ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : state[t.id] === "done" ? (
                        <Check className="h-4 w-4 text-primary" />
                      ) : state[t.id] === "err" ? (
                        <RotateCcw className="h-4 w-4 text-destructive" />
                      ) : (
                        <Download className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                ))}
                {visibleTracks.length === 0 && (
                  <p className="p-6 text-center text-sm text-muted-foreground">
                    No tracks match that filter.
                  </p>
                )}
              </div>
              {visibleTracks.length > shown && (
                <button
                  onClick={() => setShown((s) => s + PAGE)}
                  className="mt-3 w-full rounded-full border border-border py-2.5 text-sm font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground"
                >
                  Show more ({visibleTracks.length - shown} remaining)
                </button>
              )}
            </>
          )}

          {info.type === "profile" && info.tracks.length === 0 && (
            <p className="mt-5 text-sm text-muted-foreground">
              {profileSets.length > 0
                ? "This profile has no direct uploads to grab — open one of its playlists instead."
                : "This profile has no downloads available: no direct uploads and no public playlists."}
            </p>
          )}

          {profileSets.length > 0 && (
            <div className="mt-4 overflow-hidden rounded-2xl border border-border bg-card/40">
              <div className="flex items-center gap-2 border-b border-border bg-muted/60 px-4 py-2 text-xs uppercase tracking-wider text-muted-foreground">
                <ListMusic className="h-4 w-4 text-primary" /> Playlists by {info.title}
              </div>
              {profileSets.map((s) => (
                <button
                  key={s.id}
                  onClick={() => load(s.permalink_url)}
                  disabled={loading}
                  className="flex w-full items-center gap-3 border-b border-border/60 px-4 py-2.5 text-left transition last:border-0 hover:bg-card disabled:opacity-60"
                >
                  {s.artwork_url ? (
                    <img
                      src={s.artwork_url}
                      alt=""
                      loading="lazy"
                      className="h-10 w-10 shrink-0 rounded-md object-cover"
                    />
                  ) : (
                    <div className="h-10 w-10 shrink-0 rounded-md bg-muted" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{s.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {s.track_count} track{s.track_count === 1 ? "" : "s"}
                    </span>
                  </span>
                  <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
                </button>
              ))}
              {info.more_sets && (
                <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
                  Only the first {profileSets.length} playlists are listed — see the profile on
                  SoundCloud for the rest.
                </p>
              )}
            </div>
          )}

          {/* Sticky selection bar */}
          {selected.size > 0 && (
            <div className="fixed inset-x-4 bottom-4 z-40 mx-auto flex max-w-2xl flex-wrap items-center gap-2 rounded-2xl border border-border bg-card/90 p-3 shadow-2xl shadow-primary/10 backdrop-blur-xl">
              <span className="px-2 text-sm font-semibold">{selected.size} selected</span>
              <button
                onClick={() => runFiles(selectedTracks)}
                disabled={!!job}
                className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
              >
                <Download className="h-4 w-4" /> Download
              </button>
              <button
                onClick={() => runZip(selectedTracks, `${info.title} (selection)`)}
                disabled={!!job}
                className="inline-flex items-center gap-2 rounded-full border border-border bg-secondary px-4 py-2 text-sm font-semibold transition hover:bg-accent disabled:opacity-60"
              >
                <FolderArchive className="h-4 w-4" /> ZIP
              </button>
              <button
                onClick={() => setSelected(new Set())}
                className="ml-auto inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-sm text-muted-foreground transition hover:bg-accent hover:text-foreground"
              >
                <XCircle className="h-4 w-4" /> Clear
              </button>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
