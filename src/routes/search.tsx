import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AlertCircle, Loader2, RotateCcw, Search, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { SearchResultRow, SearchResultSkeleton } from "@/components/SearchResultRow";
import { SearchTabs } from "@/components/SearchTabs";
import { trackAppError, trackResultOpened, trackSearch } from "@/lib/analytics";
import { searchSoundcloud } from "@/lib/sc.functions";
import { setSelection } from "@/lib/selection";
import { SEARCH_TABS, type SearchResult, type SearchTab } from "@/lib/search-rank";
import { SITE } from "@/lib/site";
import { seoHead } from "@/lib/seo";

const TAB_IDS = SEARCH_TABS.map((t) => t.id);

export const Route = createFileRoute("/search")({
  validateSearch: (search: Record<string, unknown>) => {
    const rawTab = typeof search["tab"] === "string" ? (search["tab"] as string) : "";
    const tab: SearchTab = (TAB_IDS as string[]).includes(rawTab)
      ? (rawTab as SearchTab)
      : "original";
    const q = typeof search["q"] === "string" ? (search["q"] as string).slice(0, 120) : "";
    return { q, tab };
  },
  head: () => {
    // noindex without a self-canonical: a canonical tag here would contradict the robots
    // directive and invite Google to index the page anyway.
    const { meta } = seoHead({
      title: `Search SoundCloud tracks, remixes & covers — ${SITE.name}`,
      description:
        "Search SoundCloud with original-first ranking. Filter original tracks, remixes, covers and playlists, then download what is authorized.",
      path: "/search",
    });
    return { meta: [...meta, { name: "robots", content: "noindex, follow" }] };
  },
  component: SearchPage,
});

const PAGE = 30;

function mergeUnique(prev: SearchResult[], incoming: SearchResult[]): SearchResult[] {
  const seen = new Set(prev.map((r) => `${r.kind}:${r.id}`));
  const out = [...prev];
  for (const r of incoming) {
    const key = `${r.kind}:${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function tabLabel(tab: SearchTab) {
  return SEARCH_TABS.find((t) => t.id === tab)?.label ?? "All";
}

function SearchPage() {
  const { q, tab } = Route.useSearch();
  const navigate = useNavigate();
  const [input, setInput] = useState(q);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqRef = useRef(0);
  const keyRef = useRef(`${q}|${tab}`);
  // A failing service repeats on every typing pause, so a run of failures is
  // reported once and cleared by the first page that comes back.
  const failureReported = useRef(false);

  const term = q.trim();
  const canSearch = term.length >= 2;

  useEffect(() => {
    setInput(q);
  }, [q]);

  // Debounced URL sync while typing.
  useEffect(() => {
    if (input.trim() === q) return;
    const timer = setTimeout(() => {
      void navigate({
        to: "/search",
        search: { q: input.trim(), tab },
        replace: true,
      });
    }, 350);
    return () => clearTimeout(timer);
  }, [input, q, tab, navigate]);

  const runSearch = useCallback(async (query: string, searchTab: SearchTab) => {
    const reportFailure = (cause: unknown) => {
      if (failureReported.current) return;
      failureReported.current = true;
      trackAppError({ stage: "search", error: cause });
    };
    const reqId = ++reqRef.current;
    const key = `${query}|${searchTab}`;
    keyRef.current = key;
    setLoading(true);
    setError(null);
    setInitialLoading(true);
    try {
      const page = await searchSoundcloud({
        data: { q: query, tab: searchTab, limit: PAGE, offset: 0, full: true },
      });
      if (reqId !== reqRef.current) return;
      if (!page.ok) {
        reportFailure(page.error);
        setError(page.error);
        return;
      }
      failureReported.current = false;
      setResults(page.results);
      setNextOffset(page.nextOffset);
      setHasMore(page.hasMore);
    } catch (e) {
      if (reqId !== reqRef.current) return;
      reportFailure(e);
      setError("Search is unavailable right now. Check your connection and try again.");
    } finally {
      if (reqId === reqRef.current) {
        setLoading(false);
        setInitialLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!canSearch) {
      reqRef.current++;
      keyRef.current = `${q}|${tab}`;
      setResults([]);
      setError(null);
      setHasMore(false);
      setNextOffset(0);
      setLoading(false);
      setInitialLoading(false);
      return;
    }
    void runSearch(term, tab);
  }, [term, tab, canSearch, q, runSearch]);

  async function loadMore() {
    if (loading || loadingMore || !hasMore) return;
    const key = keyRef.current;
    setLoadingMore(true);
    try {
      const page = await searchSoundcloud({
        data: { q: term, tab, limit: PAGE, offset: nextOffset, full: true },
      });
      if (keyRef.current !== key) return;
      if (!page.ok) {
        setError(page.error);
        return;
      }
      setResults((prev) => mergeUnique(prev, page.results));
      setNextOffset(page.nextOffset);
      setHasMore(page.hasMore);
    } catch {
      if (keyRef.current === key) setError("Could not load more results. Try again.");
    } finally {
      setLoadingMore(false);
    }
  }

  function changeTab(next: SearchTab) {
    if (next !== tab) trackSearch({ source: "search_page", tab: next, term });
    void navigate({ to: "/search", search: { q, tab: next }, replace: true });
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const value = input.trim();
    if (value.length < 2) return;
    trackSearch({ source: "search_page", tab, term: value });
    void navigate({ to: "/search", search: { q: value, tab }, replace: true });
  }

  function openItem(item: SearchResult) {
    trackResultOpened({ kind: item.kind, from: "search_page" });
    if (item.kind === "track") {
      void navigate({ to: "/track/$id", params: { id: String(item.id) }, search: {} });
      return;
    }
    setSelection(item.permalink_url, false);
    void navigate({ to: "/", search: { focus: false } });
  }

  function downloadItem(item: SearchResult) {
    trackResultOpened({ kind: item.kind, from: "search_page" });
    if (item.kind === "track") {
      void navigate({
        to: "/track/$id",
        params: { id: String(item.id) },
        search: { download: true },
      });
      return;
    }
    setSelection(item.permalink_url, false);
    void navigate({ to: "/", search: { focus: false } });
  }

  const showSkeletons = canSearch && initialLoading && results.length === 0;

  return (
    <main className="mx-auto w-full max-w-4xl px-4 pb-20 pt-6 md:pt-10">
      <header className="mx-auto max-w-3xl text-center">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          Search <span className="text-primary">SoundCloud</span>
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Original tracks rank first. Switch tabs to find remixes, covers and playlists.
        </p>

        <form
          onSubmit={submit}
          role="search"
          className="mt-6 flex items-center gap-2 rounded-full border border-border bg-card p-2 shadow-lg shadow-primary/5 focus-within:border-primary/60"
        >
          <Search className="ml-2 h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Search an artist, song, or remix…"
            aria-label="Search SoundCloud"
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent px-1 text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          {input && (
            <button
              type="button"
              onClick={() => {
                setInput("");
                void navigate({ to: "/search", search: { q: "", tab }, replace: true });
              }}
              aria-label="Clear search"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
          <button
            type="submit"
            disabled={input.trim().length < 2}
            className="shrink-0 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            Search
          </button>
        </form>

        <SearchTabs
          value={tab}
          onChange={changeTab}
          className="mx-auto mt-4 w-full max-w-3xl md:justify-center"
        />
      </header>

      <section className="mx-auto mt-6 max-w-3xl" aria-live="polite">
        {!canSearch ? (
          <div className="rounded-2xl border border-dashed border-border bg-card/40 px-6 py-14 text-center">
            <p className="text-sm font-medium text-foreground">Search for a song or artist</p>
            <p className="mx-auto mt-1.5 max-w-md text-xs text-muted-foreground">
              Type at least two characters. Originals are ranked above remixes, slowed edits and
              covers.
            </p>
          </div>
        ) : error ? (
          <div
            role="alert"
            className="rounded-2xl border border-destructive/40 bg-destructive/5 px-5 py-6 text-center"
          >
            <p className="inline-flex items-center gap-2 text-sm font-medium text-destructive">
              <AlertCircle className="h-4 w-4" /> {error}
            </p>
            <button
              type="button"
              onClick={() => void runSearch(term, tab)}
              className="mt-3 inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-xs font-semibold text-foreground transition hover:bg-accent"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Try again
            </button>
          </div>
        ) : showSkeletons ? (
          <div className="overflow-hidden rounded-2xl border border-border bg-card/40">
            {Array.from({ length: 7 }).map((_, i) => (
              <SearchResultSkeleton key={i} className="border-b border-border/50 last:border-0" />
            ))}
          </div>
        ) : results.length === 0 ? (
          <div className="rounded-2xl border border-border bg-card/40 px-6 py-14 text-center">
            <p className="text-sm font-medium text-foreground">
              No {tabLabel(tab).toLowerCase()} results for “{term}”
            </p>
            <p className="mx-auto mt-1.5 max-w-md text-xs text-muted-foreground">
              Try a shorter query or switch to the All tab to see every match.
            </p>
            {tab !== "all" && (
              <button
                type="button"
                onClick={() => changeTab("all")}
                className="mt-4 rounded-full bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground transition hover:opacity-90"
              >
                Search all results
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="mb-2 flex items-center justify-between gap-3 px-1 text-xs text-muted-foreground">
              <span>
                {results.length}
                {hasMore ? "+" : ""} {tabLabel(tab).toLowerCase()} result
                {results.length === 1 ? "" : "s"}
                {loading && <Loader2 className="ml-1.5 inline h-3 w-3 animate-spin text-primary" />}
              </span>
              <span className="hidden sm:inline">Ranked by relevance</span>
            </div>
            <div
              aria-busy={loading}
              className={`overflow-hidden rounded-2xl border border-border bg-card/40 transition-opacity ${loading ? "opacity-60" : ""}`}
            >
              {results.map((item) => (
                <SearchResultRow
                  key={`${item.kind}:${item.id}`}
                  item={item}
                  onOpen={openItem}
                  onDownload={downloadItem}
                  className="border-b border-border/50 last:border-0"
                />
              ))}
            </div>
            {hasMore && (
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={loadingMore || loading}
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-full border border-border py-2.5 text-sm font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-60"
              >
                {loadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {loadingMore ? "Loading…" : "Load more results"}
              </button>
            )}
          </>
        )}
      </section>
    </main>
  );
}
