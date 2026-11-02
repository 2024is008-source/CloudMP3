import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRight, ListMusic, Loader2, Music, RotateCcw } from "lucide-react";

import { CategoryBadge } from "@/components/SearchResultRow";
import { Skeleton } from "@/components/ui/skeleton";
import { getRelatedTracks } from "@/lib/sc.functions";
import { formatDuration, type SearchResult } from "@/lib/search-rank";
import { setSelection } from "@/lib/selection";
import type { RelatedTracks as RelatedData, TrackDetails } from "@/lib/soundcloud.server";

type Result = ({ ok: true } & RelatedData) | { ok: false; error: string };

function TrackCard({ item }: { item: SearchResult }) {
  return (
    <Link
      to="/track/$id"
      params={{ id: String(item.id) }}
      className="group flex w-full min-w-0 items-center gap-3 rounded-xl border border-border bg-card/40 p-2.5 transition hover:border-primary/40 hover:bg-card"
    >
      {item.artwork_url ? (
        <img
          src={item.artwork_url}
          alt=""
          loading="lazy"
          className="h-11 w-11 shrink-0 rounded-lg bg-secondary object-cover"
        />
      ) : (
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-secondary">
          <Music className="h-4 w-4 text-muted-foreground" aria-hidden />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-foreground transition group-hover:text-primary">
          {item.title}
        </p>
        <p className="truncate text-xs text-muted-foreground">{item.artist}</p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <CategoryBadge item={item} />
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {formatDuration(item.duration)}
        </span>
      </div>
      <ChevronRight
        className="h-4 w-4 shrink-0 text-muted-foreground transition group-hover:text-primary"
        aria-hidden
      />
    </Link>
  );
}

function PlaylistCard({
  item,
  onOpen,
}: {
  item: SearchResult;
  onOpen: (item: SearchResult) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      className="group flex w-full min-w-0 items-center gap-3 rounded-xl border border-border bg-card/40 p-2.5 text-left transition hover:border-primary/40 hover:bg-card"
    >
      {item.artwork_url ? (
        <img
          src={item.artwork_url}
          alt=""
          loading="lazy"
          className="h-11 w-11 shrink-0 rounded-lg bg-secondary object-cover"
        />
      ) : (
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-secondary">
          <ListMusic className="h-4 w-4 text-muted-foreground" aria-hidden />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-foreground transition group-hover:text-primary">
          {item.title}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {item.artist} · {item.track_count} track{item.track_count === 1 ? "" : "s"}
        </p>
      </div>
      <ChevronRight
        className="h-4 w-4 shrink-0 text-muted-foreground transition group-hover:text-primary"
        aria-hidden
      />
    </button>
  );
}

function Group({
  title,
  items,
  children,
}: {
  title: string;
  items: SearchResult[];
  children: (item: SearchResult) => React.ReactNode;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mt-6 first:mt-0">
      <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {title}
      </h3>
      <div className="mt-3 grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => (
          <div key={`${item.kind}:${item.id}`} className="min-w-0">
            {children(item)}
          </div>
        ))}
      </div>
    </div>
  );
}

export function RelatedTracks({ track }: { track: TrackDetails }) {
  const [data, setData] = useState<RelatedData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reqRef = useRef(0);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    const reqId = ++reqRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = (await getRelatedTracks({
        data: {
          id: track.id,
          artist: track.artist.slice(0, 160),
          title: track.title.slice(0, 240),
        },
      })) as Result;
      if (reqId !== reqRef.current) return;
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setData({
        more: result.more,
        versions: result.versions,
        similar: result.similar,
        playlists: result.playlists,
      });
    } catch {
      if (reqId === reqRef.current) {
        setError("Related tracks are unavailable right now. Check your connection and retry.");
      }
    } finally {
      if (reqId === reqRef.current) setLoading(false);
    }
  }, [track.id, track.artist, track.title]);

  useEffect(() => {
    setData(null);
    void load();
    return () => {
      reqRef.current++;
    };
  }, [load]);

  function openPlaylist(item: SearchResult) {
    setSelection(item.permalink_url, false);
    void navigate({ to: "/", search: { focus: false } });
  }

  const total = data
    ? data.more.length + data.versions.length + data.similar.length + data.playlists.length
    : 0;

  return (
    <section className="mt-10">
      <div className="flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary">
          <ListMusic className="h-4 w-4" aria-hidden />
        </span>
        <div>
          <h2 className="text-xl font-bold tracking-tight text-foreground">Related tracks</h2>
          <p className="text-xs text-muted-foreground">Live results from SoundCloud search.</p>
        </div>
        {loading && <Loader2 className="ml-1 h-4 w-4 animate-spin text-primary" aria-hidden />}
      </div>

      {error ? (
        <div
          role="alert"
          className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-card/40 p-4"
        >
          <p className="text-sm text-muted-foreground">{error}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-border px-3.5 py-2 text-xs font-semibold transition hover:bg-accent"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Retry
          </button>
        </div>
      ) : loading && !data ? (
        <div className="mt-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-xl" />
          ))}
        </div>
      ) : data && total > 0 ? (
        <div>
          <Group title={`More from ${track.artist}`} items={data.more}>
            {(item) => <TrackCard item={item} />}
          </Group>
          <Group title="Alternative versions" items={data.versions}>
            {(item) => <TrackCard item={item} />}
          </Group>
          <Group title="Similar tracks" items={data.similar}>
            {(item) => <TrackCard item={item} />}
          </Group>
          <Group title="Related playlists" items={data.playlists}>
            {(item) => <PlaylistCard item={item} onOpen={openPlaylist} />}
          </Group>
        </div>
      ) : (
        <p className="mt-4 rounded-2xl border border-dashed border-border bg-card/30 px-4 py-6 text-center text-sm text-muted-foreground">
          No related tracks turned up in SoundCloud search.
        </p>
      )}
    </section>
  );
}
