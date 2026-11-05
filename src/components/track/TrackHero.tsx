import {
  BadgeCheck,
  CalendarDays,
  Clock,
  Disc3,
  Download,
  ExternalLink,
  Music,
  ShieldCheck,
  Tag,
} from "lucide-react";

import { trackCtaClicked, trackExternalLink } from "@/lib/analytics";
import { CATEGORY_LABELS, formatDuration } from "@/lib/search-rank";
import type { TrackDetails } from "@/lib/soundcloud.server";

function formatRelease(value: string): string | null {
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function TrackHero({ track }: { track: TrackDetails }) {
  const released = track.release_date ? formatRelease(track.release_date) : null;
  const duration = formatDuration(track.duration);
  const fullDuration = formatDuration(track.full_duration);
  const localDate = track.created_at
    ? new Date(track.created_at).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : null;

  return (
    <header className="track-glow relative isolate overflow-hidden rounded-3xl border border-border bg-card/40 p-5 shadow-2xl shadow-black/30 sm:p-8 lg:p-10">
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/60 to-transparent"
        aria-hidden
      />
      <div className="relative grid gap-8 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)] lg:items-end">
        <div className="mx-auto w-full max-w-[21rem] lg:mx-0">
          <div className="relative">
            <div className="absolute -inset-5 rounded-full bg-primary/20 blur-3xl" aria-hidden />
            <div className="relative aspect-square overflow-hidden rounded-2xl border border-border bg-secondary shadow-2xl shadow-primary/15">
              {track.artwork_url ? (
                <img
                  src={track.artwork_url}
                  alt={`${track.title} artwork`}
                  className="h-full w-full object-cover"
                  fetchPriority="high"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center">
                  <Music className="h-16 w-16 text-muted-foreground" aria-hidden />
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {track.category !== "original" && (
              <span className="rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-foreground">
                {CATEGORY_LABELS[track.category]}
              </span>
            )}
            {track.official && (
              <span
                title="Official release metadata provided by SoundCloud"
                className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary/60 px-2.5 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
              >
                <ShieldCheck className="h-3 w-3 text-primary" aria-hidden /> Official release
              </span>
            )}
            {track.snippet && (
              <span className="rounded-full border border-border bg-secondary/60 px-2.5 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                30s preview
              </span>
            )}
          </div>

          <h1 className="mt-4 text-3xl font-bold leading-[1.06] tracking-tight text-foreground sm:text-4xl lg:text-[3.25rem]">
            {track.title}
          </h1>

          <div className="mt-3 text-sm text-muted-foreground">
            <div className="flex flex-wrap items-center gap-2">
              {track.artist_avatar && (
                <img
                  src={track.artist_avatar}
                  alt=""
                  className="h-6 w-6 rounded-full border border-border object-cover"
                />
              )}
              <span>by</span>
              {track.artist_url ? (
                <a
                  href={track.artist_url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => {
                    if (track.artist_url) {
                      trackExternalLink({ href: track.artist_url, label: "artist_profile" });
                    }
                  }}
                  className="inline-flex items-center gap-1 font-semibold text-foreground underline-offset-4 transition hover:text-primary hover:underline"
                >
                  {track.artist}
                  {track.verified && (
                    <BadgeCheck
                      className="h-4 w-4 text-primary"
                      aria-label="Verified SoundCloud artist"
                    />
                  )}
                </a>
              ) : (
                <span className="inline-flex items-center gap-1 font-semibold text-foreground">
                  {track.artist}
                  {track.verified && (
                    <BadgeCheck
                      className="h-4 w-4 text-primary"
                      aria-label="Verified SoundCloud artist"
                    />
                  )}
                </span>
              )}
            </div>
            {track.uploader !== track.artist && (
              <p className="mt-1.5">Uploaded by {track.uploader}</p>
            )}
          </div>

          <div className="mt-4 flex flex-col gap-1.5 text-sm text-muted-foreground sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-5 sm:gap-y-2">
            <span className="inline-flex items-center gap-1.5">
              <Clock className="h-4 w-4 text-primary" aria-hidden />
              {duration}
              {track.snippet && track.full_duration > track.duration && (
                <span className="text-xs">preview · {fullDuration} full</span>
              )}
            </span>
            {released && (
              <span className="inline-flex items-center gap-1.5">
                <CalendarDays className="h-4 w-4 text-primary" aria-hidden /> {released}
              </span>
            )}
            {track.genre && (
              <span className="inline-flex items-center gap-1.5">
                <Tag className="h-4 w-4 text-primary" aria-hidden /> {track.genre}
              </span>
            )}
            {track.label_name && (
              <span className="inline-flex items-center gap-1.5">
                <Disc3 className="h-4 w-4 text-primary" aria-hidden /> {track.label_name}
              </span>
            )}
          </div>

          {localDate && !released && (
            <p className="mt-2 text-xs text-muted-foreground">Uploaded {localDate}</p>
          )}

          <div className="mt-6 grid auto-cols-[minmax(0,max-content)] grid-flow-col justify-start gap-2">
            <a
              href="#download"
              onClick={() => trackCtaClicked({ label: "download_panel", page: "track" })}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/20 transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:px-5"
            >
              <Download className="h-4 w-4" aria-hidden />
              Download
            </a>
            <a
              href={track.permalink_url}
              target="_blank"
              rel="noreferrer"
              onClick={() =>
                trackExternalLink({ href: track.permalink_url, label: "listen_on_soundcloud" })
              }
              className="inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-full border border-border bg-secondary/40 px-4 text-sm font-semibold text-foreground transition hover:border-primary/50 hover:text-primary sm:px-5"
            >
              <ExternalLink className="h-4 w-4" aria-hidden />
              {/* The full label does not share a row with Download on a phone. */}
              <span className="sm:hidden">SoundCloud</span>
              <span className="hidden sm:inline">Listen on SoundCloud</span>
            </a>
          </div>
        </div>
      </div>
    </header>
  );
}
