import type { ReactNode } from "react";
import { ExternalLink, ShieldAlert, ShieldCheck } from "lucide-react";

import { estimateBytes, formatBytes } from "@/lib/audio-size";
import { extLabel } from "@/lib/download-options";
import { formatDuration } from "@/lib/search-rank";
import type { TrackDetails } from "@/lib/soundcloud.server";
import type { TrackFormats } from "@/lib/track-formats";
import { cn } from "@/lib/utils";

type Row = { label: string; value: ReactNode; mono?: boolean; title?: string | undefined };

function formatDate(value: string): string | null {
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function TrackInfoCard({
  track,
  formats,
}: {
  track: TrackDetails;
  formats: TrackFormats | null;
}) {
  const released = track.release_date ? formatDate(track.release_date) : null;
  const serviceStream = formats?.streams[0] ?? null;
  const streamCodec = serviceStream?.codec ?? track.source.codec;
  const streamBitrate = serviceStream?.bitrate ?? track.source.bitrate;
  const sourceSize = estimateBytes(track.duration, streamBitrate);
  const duration = `${formatDuration(track.duration)}${
    track.snippet && track.full_duration > track.duration
      ? ` (${formatDuration(track.full_duration)} full track)`
      : ""
  }`;

  const original = formats?.original;
  const availableOriginal = original?.available === true ? original : null;
  const unavailableOriginal = original?.available === false ? original : null;
  const originalAvailable = availableOriginal !== null;
  const showOriginal =
    originalAvailable ||
    Boolean(unavailableOriginal && !unavailableOriginal.reason.startsWith("service-"));

  const originalValue: ReactNode = availableOriginal ? (
    <span title={availableOriginal.filename ?? undefined}>
      {extLabel(availableOriginal.ext, availableOriginal.codec)}
      {` · ${availableOriginal.codec}`}
      {availableOriginal.bytes ? ` · ${formatBytes(availableOriginal.bytes)}` : ""}
    </span>
  ) : (
    <span className="text-muted-foreground">Not available</span>
  );

  const canDownload = track.downloadAllowed || originalAvailable;

  const rows: Array<Row | null> = [
    { label: "Title", value: track.title },
    { label: "Artist", value: track.artist },
    { label: "Uploader", value: track.uploader },
    { label: "Duration", value: duration },
    track.genre ? { label: "Genre", value: track.genre } : null,
    released ? { label: "Release date", value: released } : null,
    track.label_name ? { label: "Label", value: track.label_name } : null,
    {
      label: track.snippet ? "Preview codec" : "Stream codec",
      value: streamCodec,
      mono: true,
    },
    {
      label: track.snippet ? "Preview bitrate" : "Stream bitrate",
      value: `${streamBitrate} kbps`,
      mono: true,
    },
    {
      label: track.snippet ? "Preview size" : "Stream size (est.)",
      value: `≈ ${formatBytes(sourceSize)}`,
      mono: true,
    },
    showOriginal
      ? {
          label: "Original upload",
          value: originalValue,
          mono: originalAvailable,
          title: unavailableOriginal?.message,
        }
      : null,
    {
      label: "Source URL",
      value: (
        <a
          href={track.permalink_url}
          target="_blank"
          rel="noreferrer"
          title={track.permalink_url}
          className="inline-flex max-w-full items-center gap-1.5 text-primary underline-offset-4 hover:underline"
        >
          <span className="truncate">{track.permalink_url.replace(/^https?:\/\//, "")}</span>
          <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
        </a>
      ),
    },
    {
      label: "Download permissions",
      value: canDownload ? (
        <span className="inline-flex items-center gap-1.5 text-foreground">
          <ShieldCheck className="h-3.5 w-3.5 text-primary" aria-hidden />
          {originalAvailable ? "Authorized original download" : "Authorized for download"}
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <ShieldAlert className="h-3.5 w-3.5 text-primary" aria-hidden />
          {track.previewAllowed ? "Preview only — download not authorized" : "Playback restricted"}
        </span>
      ),
    },
    track.publisher?.isrc ? { label: "ISRC", value: track.publisher.isrc, mono: true } : null,
  ];
  const visibleRows = rows.filter((row): row is Row => row !== null);

  return (
    <section className="rounded-3xl border border-border bg-card/60 p-5 backdrop-blur sm:p-6">
      <h2 className="text-xl font-bold tracking-tight text-foreground">Track information</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Metadata reported by SoundCloud for this upload.
      </p>

      <dl className="mt-5 divide-y divide-border/60">
        {visibleRows.map((row) => (
          <div
            key={row.label}
            className="grid grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)] gap-3 py-2.5 text-sm"
            title={row.title}
          >
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd
              className={cn(
                "min-w-0 break-words text-right text-foreground",
                row.mono && "font-mono text-[13px] tabular-nums",
              )}
            >
              {row.value}
            </dd>
          </div>
        ))}
      </dl>

      {track.tags.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5 border-t border-border/60 pt-4">
          {track.tags.slice(0, 8).map((tag) => (
            <span
              key={tag}
              className="rounded-full border border-border bg-secondary/50 px-2.5 py-1 text-xs text-muted-foreground"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
        Permissions reflect SoundCloud's public track policy. Downloads are only offered when the
        stream is authorized. The original upload is listed only when SoundCloud exposes an
        authorized artist file; encoded streams are not labelled as originals.
      </p>
    </section>
  );
}
