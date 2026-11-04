import { useEffect, useRef } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { AlertCircle, ChevronRight, Home, RotateCcw } from "lucide-react";

import { DownloadPanel } from "@/components/track/DownloadPanel";
import { PreviewPlayer } from "@/components/track/PreviewPlayer";
import { RelatedTracks } from "@/components/track/RelatedTracks";
import { TrackHero } from "@/components/track/TrackHero";
import { TrackInfoCard } from "@/components/track/TrackInfoCard";
import { Skeleton } from "@/components/ui/skeleton";
import { trackAppError } from "@/lib/analytics";
import { getTrackPage } from "@/lib/sc.functions";
import { formatDuration } from "@/lib/search-rank";
import { SITE } from "@/lib/site";
import { OG_IMAGE, absoluteUrl, seoHead } from "@/lib/seo";
import { useTrackFormats } from "@/lib/use-track-formats";

function isoDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `PT${h ? `${h}H` : ""}${m ? `${m}M` : ""}${s || (!h && !m) ? `${s}S` : ""}`;
}

export const Route = createFileRoute("/track/$id")({
  validateSearch: (search: Record<string, unknown>): { download?: boolean } => {
    const raw = search["download"];
    const download = raw === true || raw === "true" || raw === "1";
    return download ? { download: true } : {};
  },
  loader: async ({ params }) => {
    const id = Number(params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return { ok: false as const, error: "That track link isn't valid." };
    }
    return getTrackPage({ data: { id } });
  },
  head: ({ loaderData }) => {
    const track = loaderData && loaderData.ok ? loaderData.track : null;
    if (!track) {
      return {
        meta: [
          { title: `Track unavailable — ${SITE.name}` },
          { name: "robots", content: "noindex, follow" },
        ],
        links: [{ rel: "canonical", href: `${SITE.origin}/` }],
      };
    }

    const url = absoluteUrl(`/track/${track.id}`);
    // Snippet tracks report the 30s preview as duration; full_duration is the real length.
    const length =
      track.full_duration && track.full_duration > track.duration
        ? track.full_duration
        : track.duration;
    const lengthText = formatDuration(length);
    const genreText = track.genre ? ` · ${track.genre}` : "";
    const title = track.downloadAllowed
      ? `${track.title} — ${track.artist} | Download MP3, AAC & WAV — ${SITE.name}`
      : track.previewAllowed
        ? `${track.title} — ${track.artist} | Preview — ${SITE.name}`
        : `${track.title} — ${track.artist} — ${SITE.name}`;
    const description = track.downloadAllowed
      ? `Preview ${track.title} by ${track.artist} and download it from SoundCloud as MP3, original ${track.source.codec} or WAV when the track is authorized. ${lengthText}${genreText}.`
      : track.previewAllowed
        ? `Preview ${track.title} by ${track.artist} on ${SITE.name}. SoundCloud authorizes a ${formatDuration(track.duration)} preview of this ${lengthText} track, so downloads aren't offered.${genreText}`
        : `${track.title} by ${track.artist} (${lengthText}${genreText}). SoundCloud isn't providing an authorized preview or download for this track.`;

    const structured = {
      "@context": "https://schema.org",
      "@type": "MusicRecording",
      name: track.title,
      byArtist: {
        "@type": "MusicGroup",
        name: track.artist,
        ...(track.artist_url ? { url: track.artist_url } : {}),
      },
      duration: isoDuration(length),
      ...(track.genre ? { genre: track.genre } : {}),
      ...(track.release_date ? { datePublished: track.release_date.slice(0, 10) } : {}),
      ...(track.artwork_url ? { image: track.artwork_url } : {}),
      ...(track.publisher?.isrc ? { isrcCode: track.publisher.isrc } : {}),
      url,
      sameAs: track.permalink_url,
    };

    return {
      ...seoHead({
        title,
        ogTitle: `${track.title} — ${track.artist}`,
        description,
        path: `/track/${track.id}`,
        ogType: "music.song",
        image: track.artwork_url ?? OG_IMAGE,
        imageAlt: `Cover art for ${track.title} by ${track.artist}`,
      }),
      scripts: [
        { type: "application/ld+json", children: JSON.stringify(structured) },
        {
          type: "application/ld+json",
          children: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            itemListElement: [
              { "@type": "ListItem", position: 1, name: SITE.name, item: SITE.origin },
              { "@type": "ListItem", position: 2, name: track.title, item: url },
            ],
          }),
        },
      ],
    };
  },
  pendingMs: 150,
  pendingMinMs: 300,
  pendingComponent: TrackSkeleton,
  component: TrackPage,
});

function TrackSkeleton() {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 pb-20 pt-6 md:pt-10">
      <div className="grid gap-8 rounded-3xl border border-border bg-card/40 p-5 shadow-2xl shadow-black/30 sm:p-8 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)] lg:items-end lg:p-10">
        <Skeleton className="mx-auto aspect-square w-full max-w-[21rem] rounded-2xl lg:mx-0" />
        <div className="space-y-4 self-end">
          <Skeleton className="h-5 w-24 rounded-full" />
          <Skeleton className="h-10 w-3/4" />
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-10 w-44 rounded-full" />
        </div>
      </div>
      <Skeleton className="mt-6 h-32 w-full rounded-2xl" />
      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,25rem)]">
        <Skeleton className="h-96 rounded-3xl" />
        <Skeleton className="h-96 rounded-3xl" />
      </div>
    </main>
  );
}

function TrackUnavailable({ error, onRetry }: { error: string; onRetry: () => void }) {
  // The notice is on screen for every re-render of a dead loader, so the failure
  // is reported once per visit rather than once per paint.
  const reported = useRef(false);
  useEffect(() => {
    if (reported.current) return;
    reported.current = true;
    trackAppError({ stage: "metadata", error });
  }, [error]);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col items-center px-4 py-20 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <AlertCircle className="h-6 w-6" aria-hidden />
      </span>
      <h1 className="mt-5 text-2xl font-bold tracking-tight text-foreground">
        This track couldn't be loaded
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">{error}</p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground transition hover:brightness-110"
        >
          <RotateCcw className="h-4 w-4" aria-hidden /> Try again
        </button>
        <Link
          to="/"
          search={{ focus: false }}
          className="inline-flex h-11 items-center gap-2 rounded-full border border-border px-5 text-sm font-semibold text-foreground transition hover:bg-accent"
        >
          <Home className="h-4 w-4" aria-hidden /> Go home
        </Link>
      </div>
    </main>
  );
}

function TrackPage() {
  const data = Route.useLoaderData();
  const { download } = Route.useSearch();
  const router = useRouter();
  const { formats, loading: formatsLoading } = useTrackFormats(data.ok ? data.track.id : 0);

  useEffect(() => {
    if (!download) return;
    const timer = setTimeout(() => {
      document.getElementById("download")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 300);
    return () => clearTimeout(timer);
  }, [download]);

  if (!data.ok) {
    return <TrackUnavailable error={data.error} onRetry={() => void router.invalidate()} />;
  }

  const track = data.track;

  return (
    <main className="mx-auto w-full max-w-6xl px-4 pb-20 pt-6 md:pt-10">
      <nav aria-label="Breadcrumb" className="mb-2">
        <ol className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
          <li>
            <Link
              to="/"
              search={{ focus: false }}
              className="inline-flex h-11 items-center gap-1.5 rounded-full px-2 font-semibold transition hover:bg-accent hover:text-foreground"
            >
              <Home className="h-4 w-4" aria-hidden /> Home
            </Link>
          </li>
          <li aria-hidden className="shrink-0">
            <ChevronRight className="h-4 w-4" />
          </li>
          <li aria-current="page" className="min-w-0 truncate text-foreground">
            {track.title}
          </li>
        </ol>
      </nav>

      <TrackHero track={track} />

      <div className="mt-6">
        <PreviewPlayer track={track} />
      </div>

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,25rem)]">
        <DownloadPanel
          track={track}
          formats={formats}
          formatsLoading={formatsLoading}
          autoStart={download === true}
        />
        <TrackInfoCard track={track} formats={formats} />
      </div>

      <RelatedTracks track={track} />
    </main>
  );
}
