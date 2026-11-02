import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Download,
  Loader2,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { estimateBytes, formatBytes } from "@/lib/audio-size";
import { convert, type Format } from "@/lib/convert";
import {
  buildDownloadOptions,
  canDownload,
  extLabel,
  type DownloadOption,
} from "@/lib/download-options";
import { fetchCover, tagMp3 } from "@/lib/id3";
import type { TrackDetails } from "@/lib/soundcloud.server";
import type { TrackFormats } from "@/lib/track-formats";
import { cn } from "@/lib/utils";

type Phase =
  "downloading" | "converting" | "decoding" | "encoding" | "tagging" | "saving" | "done" | "error";

type Job = {
  phase: Phase;
  progress: number | null;
  received?: number;
  total?: number | null;
  error?: string;
};

const PHASE_LABEL: Record<Exclude<Phase, "error">, string> = {
  downloading: "Downloading audio",
  converting: "Converting on the server",
  decoding: "Decoding audio",
  encoding: "Re-encoding audio",
  tagging: "Writing ID3 tags",
  saving: "Saving file",
  done: "Download complete",
};

function safeName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "_");
}

function saveFile(data: Uint8Array, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function totalFromHeaders(res: Response): number | null {
  const length = Number(res.headers.get("Content-Length"));
  if (Number.isFinite(length) && length > 0) return length;
  const estimate = Number(res.headers.get("X-Total-Bytes"));
  return Number.isFinite(estimate) && estimate > 0 ? estimate : null;
}

async function readResponse(
  res: Response,
  onProgress: (received: number, total: number | null) => void,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const total = totalFromHeaders(res);
  if (!res.body) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    onProgress(bytes.length, total ?? bytes.length);
    return bytes;
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
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  onProgress(received, total ?? received);
  return out;
}

function filenameFromHeaders(res: Response): string | null {
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

function withExtension(name: string, ext: string): string {
  const cleaned = safeName(name);
  return /\.[a-z0-9]{1,6}$/i.test(cleaned) ? cleaned : `${cleaned}.${ext}`;
}

async function errorText(res: Response): Promise<string> {
  const text = (await res.text()).trim();
  return (text || "The download could not start.").slice(0, 300);
}

function optionSize(option: DownloadOption, duration: number): string {
  if (option.bytes) return formatBytes(option.bytes);
  if (option.kbps) return `≈ ${formatBytes(estimateBytes(duration, option.kbps))}`;
  return "—";
}

function shortLabel(option: DownloadOption, formats: TrackFormats | null): string {
  if (option.kind === "original") {
    const codec = formats?.original.available ? formats.original.codec : null;
    return `Original ${extLabel(option.ext, codec)}`;
  }
  if (option.kind === "stream") return option.label;
  if (option.kind === "mp3") return `MP3 ${option.kbps}k`;
  return "WAV";
}

export function DownloadPanel({
  track,
  formats,
  formatsLoading = false,
  autoStart = false,
}: {
  track: TrackDetails;
  formats: TrackFormats | null;
  formatsLoading?: boolean;
  autoStart?: boolean;
}) {
  const options = useMemo(() => buildDownloadOptions(track, formats), [track, formats]);
  const [selected, setSelected] = useState<string | null>(null);
  const option = options.find((entry) => entry.value === selected) ?? options[0] ?? null;
  const allowed = canDownload(track, formats);
  const checking = formatsLoading && !track.downloadAllowed;
  const [job, setJob] = useState<Job | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const autoRef = useRef<"idle" | "pending" | "started">("idle");
  const lastTick = useRef(0);

  const busy = job !== null && job.phase !== "done" && job.phase !== "error";
  const size = option ? optionSize(option, track.duration) : "—";
  const label = option ? shortLabel(option, formats) : "audio";

  const start = useCallback(async () => {
    if (!option || !allowed) return;
    const fmt = option;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    lastTick.current = 0;
    setJob({
      phase: fmt.kind === "wav-ffmpeg" ? "converting" : "downloading",
      progress: 0,
      received: 0,
      total: null,
    });

    const onProgress = (received: number, total: number | null) => {
      const now = performance.now();
      if (now - lastTick.current < 120) return;
      lastTick.current = now;
      setJob({
        phase: "downloading",
        progress: total ? Math.min(0.99, received / total) : null,
        received,
        total,
      });
    };

    try {
      let data: Uint8Array;
      let ext = fmt.ext;
      let mime = "audio/mp4";
      let filename: string | null = null;

      if (fmt.kind === "original") {
        const res = await fetch(`/api/public/track?id=${track.id}&mode=original`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(await errorText(res));
        ext = res.headers.get("X-File-Ext") || ext;
        mime =
          res.headers.get("Content-Type") ||
          (formats?.original.available ? formats.original.mime : null) ||
          "application/octet-stream";
        filename = filenameFromHeaders(res);
        data = await readResponse(res, onProgress, controller.signal);
      } else if (fmt.kind === "wav-ffmpeg") {
        const res = await fetch(`/api/public/track?id=${track.id}&mode=wav&q=${fmt.quality}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(await errorText(res));
        ext = "wav";
        mime = "audio/wav";
        filename = filenameFromHeaders(res);
        data = await readResponse(res, onProgress, controller.signal);
      } else {
        const res = await fetch(`/api/public/track?id=${track.id}&q=${fmt.quality}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(await errorText(res));
        const sourceExt = res.headers.get("X-File-Ext") || "m4a";
        const raw = await readResponse(res, onProgress, controller.signal);
        data = raw;
        ext = sourceExt;
        mime = res.headers.get("Content-Type") ?? "audio/mp4";

        if (fmt.kind === "mp3" || fmt.kind === "wav-browser") {
          setJob({ phase: "decoding", progress: null });
          const target: Format = fmt.kind === "mp3" ? (`mp3-${fmt.kbps}` as Format) : "wav";
          const out = await convert(raw, sourceExt, target, (phase, progress) => {
            if (controller.signal.aborted) return;
            setJob({
              phase: phase === "decode" ? "decoding" : "encoding",
              progress: phase === "encode" ? progress : null,
            });
          });
          data = out.data;
          ext = out.ext;
          mime = out.mime;
          if (ext === "mp3") {
            setJob({ phase: "tagging", progress: null });
            const cover = await fetchCover(track.artwork_url);
            data = tagMp3(data, { title: track.title, artist: track.artist, cover });
          }
        }
      }

      if (controller.signal.aborted) return;
      setJob({ phase: "saving", progress: null });
      const fallback = `${safeName(`${track.artist} - ${track.title}`)}.${ext}`;
      saveFile(data, withExtension(filename ?? fallback, ext), mime);
      setJob({ phase: "done", progress: 1, received: data.length, total: data.length });
      toast.success(`Saved ${track.title}`);
    } catch (e) {
      if (controller.signal.aborted) {
        setJob(null);
        return;
      }
      const message = e instanceof Error ? e.message : "The download failed.";
      setJob({
        phase: "error",
        progress: null,
        error: /decode|audiobuffer|encodingerror/i.test(message)
          ? "Your browser couldn't convert this audio. Try the original format or WAV instead."
          : message,
      });
      toast.error(`Couldn't download ${track.title}`);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [allowed, formats, option, track]);

  useEffect(() => {
    if (!autoStart || formatsLoading || !allowed || autoRef.current !== "idle") return;
    autoRef.current = "pending";
    const timer = setTimeout(() => {
      autoRef.current = "started";
      void start();
    }, 500);
    return () => {
      clearTimeout(timer);
      // React's dev double-invoke runs cleanup right after mount; allow a re-schedule.
      if (autoRef.current === "pending") autoRef.current = "idle";
    };
  }, [autoStart, formatsLoading, allowed, start]);

  useEffect(() => () => abortRef.current?.abort(), []);

  function cancel() {
    abortRef.current?.abort();
    setJob(null);
  }

  const pct =
    job?.progress === null || job?.progress === undefined ? null : Math.round(job.progress * 100);
  const downloading = job?.phase === "downloading";
  const finished = job?.phase === "done";
  const failed = job?.phase === "error";
  const originalAvailable = formats?.original.available === true;

  return (
    <section
      id="download"
      className="scroll-mt-24 rounded-3xl border border-border bg-card/60 p-5 shadow-xl shadow-black/20 backdrop-blur sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-foreground">
            {allowed ? "Download" : "Download availability"}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {allowed
              ? "Only formats available for this track are listed."
              : "SoundCloud controls whether this upload can be downloaded."}
          </p>
        </div>
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold uppercase tracking-wider",
            allowed
              ? "border-primary/30 bg-primary/10 text-foreground"
              : "border-border bg-secondary/50 text-muted-foreground",
          )}
        >
          {allowed ? (
            <ShieldCheck className="h-3 w-3" aria-hidden />
          ) : (
            <ShieldAlert className="h-3 w-3" aria-hidden />
          )}
          {originalAvailable
            ? "Original available"
            : allowed
              ? "Stream authorized"
              : "Preview only"}
        </span>
      </div>

      {checking ? (
        <div className="mt-5 flex items-center gap-2 rounded-2xl border border-border bg-secondary/30 p-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden />
          Checking whether the artist enabled downloads…
        </div>
      ) : !allowed ? (
        <div className="mt-5 rounded-2xl border border-border bg-secondary/30 p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <ShieldAlert className="h-4 w-4 text-primary" aria-hidden />
            {track.snippet ? "Only a preview is available" : "Download isn't available"}
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            {track.snippet
              ? "SoundCloud serves a 30-second snippet for this track. Downloading the full track isn't authorized."
              : "SoundCloud doesn't authorize a download for this track, and no original upload is exposed."}{" "}
            You can still listen to it on SoundCloud.
          </p>
          <a
            href={track.permalink_url}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-xs font-semibold text-foreground transition hover:border-primary/50 hover:text-primary"
          >
            Open on SoundCloud
          </a>
        </div>
      ) : (
        <>
          <fieldset className="mt-5">
            <legend className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Format
            </legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {options.map((entry) => {
                const active = option?.value === entry.value;
                return (
                  <label
                    key={entry.value}
                    className={cn(
                      "flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition",
                      active
                        ? "border-primary/60 bg-primary/[0.07]"
                        : "border-border bg-background/30 hover:border-primary/30 hover:bg-card",
                    )}
                  >
                    <input
                      type="radio"
                      name="download-format"
                      value={entry.value}
                      checked={active}
                      disabled={busy}
                      onChange={() => {
                        setSelected(entry.value);
                        setJob(null);
                      }}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-primary disabled:cursor-not-allowed"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="text-sm font-semibold text-foreground">{entry.label}</span>
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                          {optionSize(entry, track.duration)}
                        </span>
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <button
            type="button"
            onClick={() => void start()}
            disabled={busy || !option}
            className={cn(
              "mt-4 flex w-full items-center justify-center gap-2 rounded-full bg-primary px-5 py-3.5",
              "text-sm font-bold text-primary-foreground shadow-lg shadow-primary/25 transition",
              "hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            )}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Download className="h-4 w-4" aria-hidden />
            )}
            {busy ? "Preparing…" : finished ? "Download again" : `Download ${label}`}
            {!busy && !finished && size !== "—" && (
              <span className="font-normal opacity-80">· {size}</span>
            )}
          </button>

          {job && (
            <div
              aria-live="polite"
              className={cn(
                "mt-4 rounded-2xl border p-4",
                failed
                  ? "border-destructive/40 bg-destructive/5"
                  : finished
                    ? "border-primary/30 bg-primary/5"
                    : "border-border bg-background/40",
              )}
            >
              <div className="flex items-start gap-3">
                <span
                  className={cn(
                    "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                    failed
                      ? "bg-destructive/10 text-destructive"
                      : finished
                        ? "bg-primary/15 text-primary"
                        : "bg-secondary text-primary",
                  )}
                >
                  {failed ? (
                    <AlertCircle className="h-4 w-4" aria-hidden />
                  ) : finished ? (
                    <CheckCircle2 className="h-4 w-4" aria-hidden />
                  ) : (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  )}
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <p
                      className={cn(
                        "text-sm font-semibold",
                        failed ? "text-destructive" : "text-foreground",
                      )}
                    >
                      {failed
                        ? "Download failed"
                        : PHASE_LABEL[job.phase as Exclude<Phase, "error">]}
                    </p>
                    {pct !== null && !failed && (
                      <span className="text-xs tabular-nums text-muted-foreground">{pct}%</span>
                    )}
                  </div>

                  {!failed && (
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
                      <div
                        className={cn(
                          "h-full rounded-full bg-primary transition-[width] duration-200",
                          pct === null && "w-1/3 animate-pulse",
                        )}
                        style={pct !== null ? { width: `${pct}%` } : undefined}
                      />
                    </div>
                  )}

                  <p
                    className={cn(
                      "mt-2 text-xs",
                      failed ? "text-destructive" : "text-muted-foreground",
                    )}
                  >
                    {failed
                      ? job.error
                      : finished
                        ? `${label} · ${formatBytes(job.received ?? 0)} saved.`
                        : downloading
                          ? `${formatBytes(job.received ?? 0)}${job.total ? ` of ≈ ${formatBytes(job.total)}` : ""} downloaded`
                          : job.phase === "converting"
                            ? "FFmpeg is converting the authorized stream to WAV — this can take a moment."
                            : job.phase === "encoding" && pct !== null
                              ? `Encoding ${label} · ${pct}%`
                              : `${label} · working…`}
                  </p>

                  <div className="mt-3 flex flex-wrap gap-2">
                    {failed && (
                      <button
                        type="button"
                        onClick={() => void start()}
                        className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground transition hover:brightness-110"
                      >
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Retry download
                      </button>
                    )}
                    {busy && (
                      <button
                        type="button"
                        onClick={cancel}
                        className="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-xs font-semibold text-muted-foreground transition hover:bg-accent hover:text-foreground"
                      >
                        <X className="h-3.5 w-3.5" aria-hidden /> Cancel
                      </button>
                    )}
                    {(finished || failed) && (
                      <button
                        type="button"
                        onClick={() => setJob(null)}
                        className="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-xs font-semibold text-muted-foreground transition hover:bg-accent hover:text-foreground"
                      >
                        Dismiss
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
