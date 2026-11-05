import { createFileRoute } from "@tanstack/react-router";
import { useState, useRef, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  classifyError,
  formatOfExt,
  trackAppError,
  trackCtaClicked,
  trackDownloadCancelled,
  trackDownloadComplete,
  trackDownloadError,
  trackDownloadStart,
  trackFaqOpened,
  trackFormatSelected,
  trackPlaylistDownload,
  trackPlaylistSelection,
  trackSearch,
  type DownloadInfo,
  type DownloadMethod,
  type FileFormat,
} from "@/lib/analytics";
import { FORMATS, type Format } from "@/lib/convert";
import {
  blobFromResponse,
  downloadFailure,
  filenameFromHeaders,
  isAbort,
  userError,
} from "@/lib/download-http";
import { routeForJob } from "@/lib/download-router";
import { createJobSlot, type JobSlot } from "@/lib/job-slot";
import { downloadTrackFile } from "@/lib/home-download";
import { WAV_KBPS } from "@/lib/download-options";
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
import { saveDownload } from "@/lib/save-download";
import { zipRequestBody } from "@/lib/zip-request";
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
    a: "Copy the track link from SoundCloud, paste it into the box above, press Fetch, choose an MP3 bitrate (128 to 320kbps) and click the download arrow. Small files convert in your browser; larger ones convert on our server and are deleted as they download.",
  },
  {
    q: "Can I download a whole SoundCloud playlist at once?",
    a: "Yes. Paste a playlist or album link, then use Download ZIP to pack its tracks into one archive with numbered filenames, or Download All to save each file separately. A very long playlist is limited by what this server allows in one archive.",
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
    a: "Yes. There is no sign-up and no app — you use it in the browser. Pick MP3 at 128, 192, 256 or 320kbps, WAV, or the original AAC file.",
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
      title: "Free SoundCloud to MP3 Downloader Online",
      description:
        "Convert and download SoundCloud tracks to MP3 online for free. Enjoy fast, easy audio downloads with high-quality sound and no registration required.",
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
  /** Only a server ZIP reports bytes; a per-track job counts finished files. */
  received?: number;
  size?: number | null;
  progress?: number | null;
};

type OneResult =
  | { ok: true; ext: string; bytes: number; method: DownloadMethod }
  | { ok: false; error: unknown; cancelled?: boolean };

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

/** What GA4 calls the chosen quality, and the bitrate it implies. */
function choiceFormat(fmt: Format): FileFormat {
  if (fmt.startsWith("mp3")) return "mp3";
  if (fmt === "wav") return "wav";
  return "aac";
}

function choiceKbps(fmt: Format): number | null {
  if (fmt.startsWith("mp3")) return Number(fmt.slice(4));
  return fmt === "wav" ? WAV_KBPS : null;
}

function fmt(ms: number) {
  const s = Math.round(ms / 1000),
    h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    r = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(r)}` : `${m}:${p(r)}`;
}
/** The reason the server gave for a ZIP that broke after it had started streaming. */
async function zipJobError(jobId: string): Promise<string | null> {
  try {
    const r = await fetch(`/api/public/zip-status?id=${jobId}`);
    if (!r.ok) return null;
    const status = (await r.json()) as { error?: string | null };
    return typeof status.error === "string" && status.error ? status.error : null;
  } catch {
    return null;
  }
}

function newZipJobId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return "zip_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, "_");

function Index() {
  const { focus } = Route.useSearch();
  const navigate = useNavigate();
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  // Whether this deployment runs FFmpeg. Without it the tab converts what it can
  // hold, which is the same rule the track panel builds its list from.
  const [service, setService] = useState(true);
  const [state, setState] = useState<Record<number, "busy" | "done" | "err">>({});
  const [job, setJob] = useState<Job | null>(null);
  const [quality, setQuality] = useState<Format>("mp3-320");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [trackQuery, setTrackQuery] = useState("");
  const [sortBy, setSortBy] = useState<"default" | "title" | "artist" | "duration">("default");
  const [shown, setShown] = useState(PAGE);
  const cancelRef = useRef(false);
  const pauseRef = useRef(false);
  // One controller and one busy flag for whichever job is running: a second
  // click used to read the stale `job` state, overwrite the controller and leave
  // the first request running with nobody left to cancel it.
  const jobSlotRef = useRef<JobSlot | null>(null);
  jobSlotRef.current ??= createJobSlot();
  const jobSlot = jobSlotRef.current;
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focus) inputRef.current?.focus();
  }, [focus]);

  // Leaving the route stops the download workers, so a job cannot keep fetching
  // and buffering audio for a page that is no longer on screen. An in-flight
  // request is aborted too, which is what tells the server to drop the
  // half-built archive or the converted file it was sending.
  useEffect(
    () => () => {
      cancelRef.current = true;
      jobSlot.cancel();
    },
    [jobSlot],
  );

  /**
   * `origin` separates a link somebody pasted from one they chose off the page;
   * only the pasted link is a search submission.
   */
  async function load(u: string, autoDownload = false, origin: "link" | "result" = "link") {
    setError(null);
    setLoading(true);
    try {
      const r = await getInfo({ data: { url: u } });
      if (r.ok) {
        // A pasted link is counted as a search, but only by what it resolved to:
        // the address itself is never sent.
        if (origin === "link") {
          trackSearch({
            source: "link_box",
            linkType: r.info.type,
            resultCount: r.info.track_count,
          });
        }
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
        setService(r.service);
        setState({});
        setSelected(new Set());
        setTrackQuery("");
        setSortBy("default");
        setShown(PAGE);
      } else {
        trackAppError({ stage: "metadata", error: r.error });
        if (origin === "link") trackSearch({ source: "link_box", linkType: "invalid" });
        setError(r.error);
        toast.error(r.error);
      }
    } catch {
      trackAppError({ stage: "metadata", error: "invalid link" });
      if (origin === "link") trackSearch({ source: "link_box", linkType: "invalid" });
      setError("That doesn't look like a valid SoundCloud link.");
      toast.error("That doesn't look like a valid SoundCloud link.");
    } finally {
      setLoading(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    trackCtaClicked({ label: "fetch_link", page: "home" });
    await load(url.trim());
  }

  // A pick from the header search bar fills the box and loads it.
  const picked = useSyncExternalStore(subscribeSelection, getSelection, () => null);
  useEffect(() => {
    if (!picked) return;
    clearSelection();
    setUrl(picked.url);
    void load(picked.url, picked.autoDownload, "result");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked]);

  /** One file handed to the browser, or the reason it was not. Toasts stay with the caller. */
  async function one(t: Track, signal: AbortSignal): Promise<OneResult> {
    setState((s) => ({ ...s, [t.id]: "busy" }));
    const multi = info && info.tracks.length > 1;
    const album = multi ? info.title : undefined;
    const number = multi ? info.tracks.indexOf(t) + 1 : undefined;
    try {
      // The route is the shared policy's, decided once, with no second guess
      // when the service is unreachable: a server-only format fails plainly
      // rather than becoming a different file in the tab.
      const { file } = await downloadTrackFile(t, quality, { album, number }, signal, service);
      const name = file.filename
        ? safe(file.filename)
        : `${safe(`${t.artist} - ${t.title}`)}.${file.ext}`;
      saveDownload(file.data, name, file.mime);
      setState((s) => ({ ...s, [t.id]: "done" }));
      return { ok: true, ext: file.ext, bytes: file.bytes, method: file.method };
    } catch (e) {
      if (isAbort(e) || signal.aborted) {
        setState((s) => {
          const next = { ...s };
          delete next[t.id];
          return next;
        });
        return { ok: false, error: e, cancelled: true };
      }
      setState((s) => ({ ...s, [t.id]: "err" }));
      return { ok: false, error: e };
    }
  }

  // The chosen quality before the file says what it really became.
  const chosen = (method: DownloadMethod) => ({
    fileFormat: choiceFormat(quality),
    bitrate: choiceKbps(quality),
    method,
  });

  /** Where this selection is produced, for the job-level events. */
  function jobMethod(tracks: Track[]): DownloadMethod {
    return routeForJob(
      quality,
      tracks.map((t) => t.duration),
      service,
    );
  }

  async function clickOne(t: Track) {
    const controller = jobSlot.take();
    if (!controller) return;
    const beganAt = performance.now();
    const request: DownloadInfo = { ...chosen(jobMethod([t])), kind: "single" };
    trackDownloadStart(request);
    const result = await one(t, controller.signal);
    jobSlot.release(controller);
    const elapsedMs = Math.round(performance.now() - beganAt);
    if (result.ok) {
      trackDownloadComplete({
        ...request,
        method: result.method,
        fileFormat: formatOfExt(result.ext),
        bytes: result.bytes,
        elapsedMs,
      });
      // The tab hands the finished file to the browser; only the browser knows
      // whether the device kept it, so nothing here claims that it did.
      toast.success(`Download started: ${t.title}`);
    } else if (result.cancelled) {
      trackDownloadCancelled(request);
      toast.info("Download cancelled.");
    } else {
      trackDownloadError({
        ...request,
        errorType: classifyError(result.error),
        elapsedMs,
      });
      toast.error(`${t.title}: ${userError(result.error)}`);
    }
  }

  /** Wait out a pause / bail on cancel. Returns false when cancelled. */
  async function gate() {
    while (pauseRef.current && !cancelRef.current) await new Promise((r) => setTimeout(r, 250));
    return !cancelRef.current;
  }

  async function runFiles(tracks: Track[]) {
    if (tracks.length === 0) return;
    const controller = jobSlot.take();
    if (!controller) return;
    const beganAt = performance.now();
    const request = {
      ...chosen(jobMethod(tracks)),
      kind: "batch" as const,
      trackCount: tracks.length,
    };
    trackPlaylistDownload({
      kind: "batch",
      trackCount: tracks.length,
      fileFormat: request.fileFormat,
      bitrate: request.bitrate,
      method: request.method,
    });
    cancelRef.current = false;
    pauseRef.current = false;
    let failed = 0;
    let bytes = 0;
    let firstError: unknown;
    let ext = "";
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
          const result = await one(t, controller.signal);
          if (result.ok) {
            bytes += result.bytes;
            ext = result.ext;
          } else if (!result.cancelled) {
            failed++;
            firstError ??= result.error;
          }
          setJob((j) => (j ? { ...j, done: j.done + 1, failed, current: null } : j));
        }
      }),
    );
    const cancelled = cancelRef.current;
    const elapsedMs = Math.round(performance.now() - beganAt);
    jobSlot.release(controller);
    setJob(null);
    if (cancelled) {
      trackDownloadCancelled(request);
      toast.info("Download cancelled.");
    } else if (failed) {
      trackAppError({ stage: "playlist", error: firstError });
      trackDownloadError({
        ...request,
        fileFormat: ext ? formatOfExt(ext) : request.fileFormat,
        errorType: classifyError(firstError),
        trackCount: tracks.length - failed,
        bytes,
        elapsedMs,
      });
      toast.error(`${failed} of ${tracks.length} downloads failed — use Retry failed.`);
    } else {
      trackDownloadComplete({
        ...request,
        fileFormat: ext ? formatOfExt(ext) : request.fileFormat,
        bytes,
        elapsedMs,
      });
      toast.success(`Download started for ${tracks.length} track${tracks.length > 1 ? "s" : ""}`);
    }
  }

  /**
   * A server-built ZIP reports only how many tracks it packed and which ids it
   * could not fetch, so the per-row marks are applied from those ids at the end.
   */
  function markRows(tracks: Track[], status: (id: number) => "busy" | "done" | "err" | null) {
    setState((s) => {
      const next = { ...s };
      for (const t of tracks) {
        const value = status(t.id);
        if (value) next[t.id] = value;
        else delete next[t.id];
      }
      return next;
    });
  }

  async function runZip(tracks: Track[], name: string) {
    if (tracks.length === 0) return;
    const controller = jobSlot.take();
    if (!controller) return;
    const beganAt = performance.now();
    const audio = chosen("server");
    const request: DownloadInfo = {
      fileFormat: "zip",
      contentFormat: audio.fileFormat,
      bitrate: audio.bitrate,
      method: "server",
      kind: "zip",
      trackCount: tracks.length,
    };
    trackPlaylistDownload({
      kind: "zip",
      trackCount: tracks.length,
      fileFormat: "zip",
      contentFormat: audio.fileFormat,
      bitrate: audio.bitrate,
      method: "server",
    });
    cancelRef.current = false;
    pauseRef.current = false;
    setJob({
      kind: "zip",
      total: tracks.length,
      done: 0,
      failed: 0,
      current: tracks[0]?.title ?? "Packing on the server",
      paused: false,
      received: 0,
      size: null,
      progress: 0,
    });
    // Mark first track busy, subsequent pending
    markRows(tracks, (id) => (id === tracks[0]?.id ? "busy" : null));

    let failedIds: number[] = [];
    let ticker: ReturnType<typeof setInterval> | null = null;
    const jobId = newZipJobId();
    // True once the server has answered 200: from then on a failure arrives as a
    // cut stream, and the reason lives in the job status instead of the response.
    let streaming = false;
    try {
      const sentAt = performance.now();
      type ZipStatus = { total: number; packed: number; failed: number[]; done: boolean };
      let last: ZipStatus | null = null;

      // Real progress from the server: which tracks are packed and which failed.
      const applyStatus = (status: ZipStatus) => {
        last = status;
        const settled = status.packed + status.failed.length;
        markRows(tracks, (id) => {
          if (status.failed.includes(id)) return "err";
          const idx = tracks.findIndex((t) => t.id === id);
          if (idx < settled) return "done";
          if (idx === settled && !status.done) return "busy";
          return null;
        });
        setJob((prev) => {
          if (!prev || prev.kind !== "zip") return prev;
          const fraction = status.total > 0 ? settled / status.total : 0;
          return {
            ...prev,
            done: status.packed,
            failed: status.failed.length,
            current: status.done ? "Finishing download" : (tracks[settled]?.title ?? prev.current),
            progress: Math.max(prev.progress ?? 0, Math.min(0.97, 0.97 * fraction)),
          };
        });
      };
      const poll = async () => {
        try {
          const r = await fetch(`/api/public/zip-status?id=${jobId}`, { signal: controller.signal });
          if (r.ok) applyStatus((await r.json()) as ZipStatus);
        } catch {
          /* the next poll will try again */
        }
      };
      ticker = setInterval(() => {
        if (!controller.signal.aborted) void poll();
      }, 700);

      const res = await fetch("/api/public/zip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(zipRequestBody(name, tracks, quality, jobId)),
        signal: controller.signal,
      });
      if (!res.ok) throw await downloadFailure(res);
      streaming = true;
      const serverWaitMs = Math.round(performance.now() - sentAt);

      const blob = await blobFromResponse(
        res,
        (received) => setJob((j) => (j ? { ...j, received } : j)),
        controller.signal,
      );
      clearInterval(ticker);
      ticker = null;
      await poll();
      const final = last as ZipStatus | null;

      failedIds = final?.failed ?? [];
      const packed = final?.packed ?? tracks.length - failedIds.length;
      markRows(tracks, (id) => (failedIds.includes(id) ? "err" : "done"));
      setJob((j) => (j ? { ...j, done: packed, failed: failedIds.length, progress: 1 } : j));
      saveDownload(blob, filenameFromHeaders(res) ?? `${safe(name)}.zip`, "application/zip");
      setTimeout(() => setJob(null), 800);
      trackDownloadComplete({
        ...request,
        trackCount: packed,
        failedTracks: failedIds.length,
        bytes: blob.size,
        elapsedMs: Math.round(performance.now() - beganAt),
        serverWaitMs,
      });
      if (failedIds.length) {
        trackAppError({ stage: "zip", error: "no_stream" });
        const titles = tracks
          .filter((t) => failedIds.includes(t.id))
          .map((t) => t.title)
          .slice(0, 3)
          .join(", ");
        toast.error(
          `ZIP saved with ${packed} track${packed === 1 ? "" : "s"} — ${failedIds.length} could not be added${titles ? `: ${titles}` : ""}.`,
        );
      } else {
        toast.success(`ZIP saved — ${packed} track${packed === 1 ? "" : "s"}`);
      }
    } catch (e) {
      const elapsedMs = Math.round(performance.now() - beganAt);
      if (controller.signal.aborted) {
        trackDownloadCancelled(request);
        markRows(tracks, () => null);
        toast.info("ZIP cancelled.");
      } else {
        trackAppError({ stage: "zip", error: e });
        trackDownloadError({
          ...request,
          errorType: classifyError(e),
          elapsedMs,
        });
        markRows(tracks, () => "err");
        const reason = streaming ? await zipJobError(jobId) : null;
        toast.error(reason ?? userError(e));
      }
      setJob(null);
    } finally {
      if (ticker) clearInterval(ticker);
      jobSlot.release(controller);
    }
  }

  function togglePause() {
    pauseRef.current = !pauseRef.current;
    setJob((j) => (j ? { ...j, paused: pauseRef.current } : j));
  }

  function cancelJob() {
    cancelRef.current = true;
    pauseRef.current = false;
    // Aborting is what reaches an in-flight request: the workers only check the
    // flag between tracks, so without this a cancel waits out the current file.
    jobSlot.cancel();
  }

  const failedTracks = info ? info.tracks.filter((t) => state[t.id] === "err") : [];
  const selectedTracks = info ? info.tracks.filter((t) => selected.has(t.id)) : [];

  // A per-track job counts finished files; a server ZIP counts the bytes it has
  // been sent, because the archive only exists once the server has finished it.
  const jobPct = job
    ? job.progress !== undefined && job.progress !== null
      ? Math.min(100, Math.round(job.progress * 100))
      : job.kind === "zip" && job.size
        ? Math.min(100, Math.round(((job.received ?? 0) / job.size) * 100))
        : Math.round((job.done / Math.max(1, job.total)) * 100)
    : 0;
  // A server ZIP has an honest percentage both when packing tracks and when receiving bytes
  const jobKnownPct =
    job !== null &&
    (job.progress !== undefined && job.progress !== null
      ? true
      : !(job.kind === "zip" && !job.size));
  const jobLabel =
    job?.kind === "zip"
      ? job.size && job.received
        ? `ZIP ${fmtSize(job.received)} of ${fmtSize(job.size)} (${jobPct}%)`
        : `Preparing ZIP · ${job.done}/${job.total} tracks (${jobPct}%)`
      : job
        ? `Downloading ${job.done}/${job.total}`
        : "";

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
    const next =
      selected.size === info.tracks.length
        ? new Set<number>()
        : new Set(info.tracks.map((t) => t.id));
    setSelected(next);
    trackPlaylistSelection({
      action: next.size === 0 ? "clear" : "select_all",
      trackCount: next.size,
    });
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
    <main className="relative isolate mx-auto w-full max-w-page px-5 pt-4 md:pt-8">
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
          <span className="rise-in inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium tracking-wide text-muted-foreground">
            No sign-up · no app · no queue
          </span>
          <h1 className="rise-in mt-4 text-[2.5rem] font-bold leading-[1.05] tracking-tight sm:text-5xl md:text-6xl">
            SoundCloud <span className="text-shimmer">to MP3</span>
          </h1>
          <p
            className="rise-in mt-3 text-muted-foreground"
            style={{ ["--rise-delay" as string]: "0.06s" }}
          >
            A free SoundCloud to MP3 converter for tracks, albums and playlists — up to 320kbps, or
            one ZIP.
          </p>
          <form
            onSubmit={submit}
            style={{ ["--rise-delay" as string]: "0.12s" }}
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
              className="hidden h-11 items-center gap-1.5 rounded-full border border-border px-4 text-sm font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground sm:inline-flex"
            >
              <ClipboardPaste className="h-4 w-4" /> Paste
            </button>
            <button
              disabled={loading}
              className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
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
          <p className="mt-8 text-sm text-muted-foreground">
            {SITE.name} works best on content you own or have permission to save.
          </p>
        </section>
      ) : null}
      {loading && !info && (
        <section aria-busy="true" aria-label="Loading track information" className="mt-12">
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
        <div className="mt-section space-y-section text-left">
          <section>
            <h2 className="text-2xl font-bold tracking-tight md:text-3xl">
              Convert a SoundCloud Link to MP3 in Four Steps
            </h2>
            <ol className="mt-8 grid gap-3 sm:grid-cols-2">
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
                  b: "Save one track, a selection, or the whole playlist as a single ZIP.",
                },
              ].map(({ icon: Icon, t, b }, i) => (
                <li
                  key={t}
                  className="group rounded-2xl border border-border bg-card p-5 transition-all duration-300 hover:-translate-y-1 hover:border-primary/40 hover:shadow-lg hover:shadow-primary/10"
                >
                  <div className="flex items-center gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/20 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
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
            <p className="mt-6 max-w-prose text-sm text-muted-foreground">
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
            <h2 className="text-2xl font-bold tracking-tight md:text-3xl">
              Why Use {SITE.name}? High-Bitrate Audio &amp; ID3 Tag Preservation
            </h2>
            <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
                  b: "MP3 and WAV are encoded from the authorized stream, and a converted file is deleted the moment your download ends.",
                },
              ].map(({ icon: Icon, t, b }) => (
                <div
                  key={t}
                  className="group rounded-2xl border border-border bg-card p-5 transition-all duration-300 hover:-translate-y-1 hover:border-primary/40 hover:shadow-lg hover:shadow-primary/10"
                >
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/20 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                    <Icon className="h-5 w-5" />
                  </span>
                  <h3 className="mt-3 font-semibold">{t}</h3>
                  <p className="mt-1.5 text-sm text-muted-foreground">{b}</p>
                </div>
              ))}
            </div>
          </section>
          <section>
            <h2 className="text-2xl font-bold tracking-tight md:text-3xl">
              Frequently Asked Questions About SoundCloud Audio Extraction
            </h2>
            <Accordion
              type="single"
              collapsible
              className="mt-8 space-y-3"
              onValueChange={(value) => {
                if (!value) return;
                const index = Number(value.slice("faq-".length));
                if (Number.isInteger(index)) trackFaqOpened({ page: "home", index });
              }}
            >
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
            <p className="mt-6 max-w-prose text-sm text-muted-foreground">
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
                  alt={`${info.title} artwork`}
                  className="h-44 w-44 rounded-2xl object-cover shadow-2xl shadow-primary/20 ring-1 ring-border sm:h-52 sm:w-52"
                />
              ) : (
                <div className="flex h-44 w-44 items-center justify-center rounded-2xl bg-muted ring-1 ring-border sm:h-52 sm:w-52">
                  <Music className="h-12 w-12 text-muted-foreground" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <span className="rounded-full border border-primary/25 bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-foreground">
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
                <div
                  role="progressbar"
                  aria-label={jobLabel}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={jobKnownPct ? jobPct : undefined}
                  aria-valuetext={jobKnownPct ? jobLabel : undefined}
                  aria-busy={jobKnownPct ? undefined : true}
                  className="h-1.5 overflow-hidden rounded-full bg-secondary"
                >
                  <div
                    className={`h-full rounded-full bg-primary transition-all duration-300 ${
                      jobKnownPct ? "" : "w-1/3 animate-pulse"
                    }`}
                    style={jobKnownPct ? { width: `${jobPct}%` } : undefined}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Download progress manager */}
          {job && (
            <div
              role="status"
              aria-live="polite"
              className="mt-4 rounded-2xl border border-border bg-card/60 p-4 backdrop-blur-xl"
            >
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                <span className="inline-flex items-center gap-2 font-semibold">
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  {jobLabel}
                </span>
                {job.current && (
                  <span className="min-w-0 max-w-xs sm:max-w-md truncate text-muted-foreground">
                    Now: {job.current}
                  </span>
                )}
                {job.kind === "files" && (
                  <span className="text-muted-foreground">
                    Remaining: {Math.max(0, job.total - job.done)}
                  </span>
                )}
                {job.failed > 0 && <span className="text-destructive">Failed: {job.failed}</span>}
                <span className="ml-auto flex items-center gap-2">
                  {job.kind === "files" && (
                    <button
                      onClick={togglePause}
                      className="inline-flex h-11 items-center gap-1.5 rounded-full border border-border px-4 text-sm font-medium transition hover:bg-accent"
                    >
                      {job.paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
                      {job.paused ? "Resume" : "Pause"}
                    </button>
                  )}
                  <button
                    onClick={cancelJob}
                    className="inline-flex h-11 items-center gap-1.5 rounded-full border border-border px-4 text-sm font-medium text-destructive transition hover:bg-accent"
                  >
                    <XCircle className="h-4 w-4" /> Cancel
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
                  onClick={() => runFiles(selected.size > 0 ? selectedTracks : info.tracks)}
                  disabled={!!job}
                  className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
                >
                  <Download className="h-4 w-4" /> {selected.size > 0 ? `Download (${selected.size})` : "Download All"}
                </button>
                <button
                  onClick={() =>
                    runZip(
                      selected.size > 0 ? selectedTracks : info.tracks,
                      selected.size > 0 ? `${info.title} (selection)` : info.title,
                    )
                  }
                  disabled={!!job}
                  className="inline-flex items-center gap-2 rounded-full border border-border bg-secondary px-5 py-2.5 text-sm font-semibold transition hover:bg-accent disabled:opacity-60"
                >
                  <FolderArchive className="h-4 w-4" /> {selected.size > 0 ? `Download ZIP (${selected.size})` : "Download ZIP"}
                </button>
                {selected.size > 0 && (
                  <button
                    onClick={() => runZip(info.tracks, info.title)}
                    disabled={!!job}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border/70 px-3 py-2 text-xs font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-60"
                    title="Download all tracks in the playlist as a ZIP"
                  >
                    ZIP All ({info.tracks.length})
                  </button>
                )}
                <label className="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2.5 text-sm text-muted-foreground">
                  <Music className="h-4 w-4" />
                  <select
                    value={quality}
                    onChange={(e) => {
                      const next = e.target.value as Format;
                      setQuality(next);
                      trackFormatSelected({
                        fileFormat: choiceFormat(next),
                        bitrate: choiceKbps(next),
                        page: "playlist",
                      });
                    }}
                    aria-label="Download quality"
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
                  <span className="inline-flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <span>{selected.size} selected</span>
                    <button
                      type="button"
                      onClick={() => setSelected(new Set())}
                      className="text-xs text-primary underline-offset-2 hover:underline"
                    >
                      Clear
                    </button>
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
                  <label className="-m-2.5 grid h-11 w-11 shrink-0 place-items-center">
                    <input
                      type="checkbox"
                      checked={info.tracks.length > 0 && selected.size === info.tracks.length}
                      onChange={toggleSelectAll}
                      aria-label="Select all tracks"
                      className="h-6 w-6 accent-primary"
                    />
                  </label>
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
                    <label className="-m-2.5 grid h-11 w-11 shrink-0 place-items-center">
                      <input
                        type="checkbox"
                        checked={selected.has(t.id)}
                        onChange={() => toggleSelect(t.id)}
                        aria-label={`Select ${t.title}`}
                        className="h-6 w-6 accent-primary"
                      />
                    </label>
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
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition hover:bg-accent disabled:opacity-60"
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
                  onClick={() => load(s.permalink_url, false, "result")}
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
                className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
              >
                <Download className="h-4 w-4" /> Download
              </button>
              <button
                onClick={() => runZip(selectedTracks, `${info.title} (selection)`)}
                disabled={!!job}
                className="inline-flex h-11 items-center gap-2 rounded-full border border-border bg-secondary px-4 text-sm font-semibold transition hover:bg-accent disabled:opacity-60"
              >
                <FolderArchive className="h-4 w-4" /> ZIP
              </button>
              <button
                onClick={() => {
                  setSelected(new Set());
                  trackPlaylistSelection({ action: "clear", trackCount: 0 });
                }}
                className="ml-auto inline-flex h-11 items-center gap-1.5 rounded-full px-3 text-sm text-muted-foreground transition hover:bg-accent hover:text-foreground"
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
