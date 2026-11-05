import { BadgeCheck, Download, Music } from "lucide-react";

import { CATEGORY_LABELS, formatDuration, type SearchResult } from "@/lib/search-rank";
import { cn } from "@/lib/utils";

const ORIGINAL_BADGE = "border-primary/35 bg-primary/10 text-foreground";
const ALT_BADGE = "border-border bg-secondary text-muted-foreground";
const PLAYLIST_BADGE = "border-primary/30 bg-transparent text-primary";

export function CategoryBadge({ item, className }: { item: SearchResult; className?: string }) {
  const label = CATEGORY_LABELS[item.category].toUpperCase();
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded border px-1.5 py-px text-xs font-semibold tracking-wide",
        item.kind === "playlist"
          ? PLAYLIST_BADGE
          : item.category === "original"
            ? ORIGINAL_BADGE
            : ALT_BADGE,
        className,
      )}
    >
      {label}
    </span>
  );
}

export function SearchResultRow({
  item,
  onOpen,
  onDownload,
  className,
}: {
  item: SearchResult;
  onOpen: (item: SearchResult) => void;
  onDownload: (item: SearchResult) => void;
  className?: string;
}) {
  const duration = formatDuration(item.duration);
  const downloadLabel = item.downloadable
    ? item.kind === "playlist"
      ? "Open playlist"
      : "Download"
    : "Not authorized for download";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(item)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(item);
        }
      }}
      aria-label={`Open ${item.title} by ${item.artist}`}
      className={cn(
        "group flex cursor-pointer items-center gap-3 px-3 py-2.5 text-left transition-colors " +
          "hover:bg-secondary/70 focus-visible:bg-secondary/70 focus-visible:outline-none",
        className,
      )}
    >
      {item.artwork_url ? (
        <img
          src={item.artwork_url}
          alt=""
          loading="lazy"
          className="h-11 w-11 shrink-0 rounded-md bg-secondary object-cover"
        />
      ) : (
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-secondary">
          <Music className="h-4 w-4 text-muted-foreground" />
        </div>
      )}

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <p className="truncate text-sm font-semibold text-foreground transition-colors group-hover:text-primary">
            {item.title}
          </p>
          {item.verified && (
            <span
              title="Verified SoundCloud artist"
              aria-label="Verified artist"
              className="shrink-0"
            >
              <BadgeCheck className="h-3.5 w-3.5 text-primary" aria-hidden />
            </span>
          )}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="truncate">{item.artist}</span>
          <span aria-hidden>·</span>
          <span className="shrink-0 tabular-nums">{duration}</span>
          {item.kind === "playlist" && (
            <>
              <span aria-hidden>·</span>
              <span className="shrink-0">
                {item.track_count} track{item.track_count === 1 ? "" : "s"}
              </span>
            </>
          )}
          <CategoryBadge item={item} className="ml-1" />
        </div>
      </div>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDownload(item);
        }}
        disabled={!item.downloadable}
        aria-label={
          item.downloadable ? `Download ${item.title}` : `${downloadLabel}: ${item.title}`
        }
        title={downloadLabel}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-35"
      >
        <Download className="h-4 w-4" />
      </button>
    </div>
  );
}

export function SearchResultSkeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn("flex items-center gap-3 px-3 py-2.5", className)}>
      <div className="h-11 w-11 shrink-0 animate-pulse rounded-md bg-secondary" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="h-3 w-2/3 animate-pulse rounded-full bg-secondary" />
        <div className="h-2.5 w-1/3 animate-pulse rounded-full bg-secondary/70" />
      </div>
      <div className="h-9 w-9 shrink-0 animate-pulse rounded-full bg-secondary/70" />
    </div>
  );
}
