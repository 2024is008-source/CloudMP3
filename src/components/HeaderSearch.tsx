import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AlertCircle, Loader2, Search, X } from "lucide-react";

import { SearchResultRow, SearchResultSkeleton } from "@/components/SearchResultRow";
import { SearchTabs } from "@/components/SearchTabs";
import { searchSoundcloud } from "@/lib/sc.functions";
import { setSelection } from "@/lib/selection";
import type { SearchResult, SearchTab } from "@/lib/search-rank";

const MIN_CHARS = 2;
const QUICK_LIMIT = 8;

export function HeaderSearch({
  onPicked,
  autoFocus,
}: {
  onPicked?: () => void;
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<SearchTab>("original");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const reqRef = useRef(0);
  const navigate = useNavigate();

  // Debounced search; previous results stay visible while the next request runs.
  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_CHARS) {
      reqRef.current++;
      setResults([]);
      setSearched(false);
      setBusy(false);
      setError(null);
      return;
    }
    const reqId = ++reqRef.current;
    setBusy(true);
    setError(null);
    const timer = setTimeout(async () => {
      try {
        const r = await searchSoundcloud({ data: { q, tab, limit: QUICK_LIMIT, offset: 0 } });
        if (reqId !== reqRef.current) return;
        if (r.ok) {
          setResults(r.results);
          setError(null);
          setOpen(true);
        } else {
          setError(r.error);
        }
      } catch {
        if (reqId === reqRef.current) setError("Search is unavailable right now. Try again.");
      } finally {
        if (reqId === reqRef.current) {
          setBusy(false);
          setSearched(true);
        }
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [query, tab]);

  // Pointer-down dismissal so a tap outside the field also closes the panel on touch devices.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, []);

  function select(item: SearchResult, autoDownload: boolean) {
    setOpen(false);
    setQuery("");
    setResults([]);
    setSearched(false);
    onPicked?.();
    if (item.kind === "track") {
      void navigate({
        to: "/track/$id",
        params: { id: String(item.id) },
        search: autoDownload ? { download: true } : {},
      });
      return;
    }
    setSelection(item.permalink_url, autoDownload);
    void navigate({ to: "/", search: { focus: false } });
  }

  function seeAll() {
    const q = query.trim();
    if (q.length < MIN_CHARS) return;
    setOpen(false);
    onPicked?.();
    void navigate({ to: "/search", search: { q, tab } });
  }

  return (
    <div ref={boxRef} className="relative w-full lg:w-64 xl:w-80">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <input
        value={query}
        autoFocus={autoFocus}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => results.length > 0 && setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
          if (e.key === "Enter" && query.trim().length >= MIN_CHARS) {
            e.preventDefault();
            seeAll();
          }
        }}
        placeholder="Search artist or song..."
        aria-label="Search SoundCloud"
        className="w-full rounded-full border border-border bg-secondary/90 py-2.5 pl-9 pr-8 text-base text-foreground outline-none transition-all placeholder:text-muted-foreground hover:bg-secondary focus:border-primary/70 focus:bg-secondary lg:py-2 lg:text-nav"
      />
      {busy ? (
        <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-primary" />
      ) : query ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            setQuery("");
            setResults([]);
            setOpen(false);
          }}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      ) : null}

      {open && query.trim().length >= MIN_CHARS && (
        <div className="fixed inset-x-4 top-[4.25rem] z-50 flex max-h-[70vh] flex-col overflow-hidden rounded-2xl border border-border bg-popover shadow-2xl md:absolute md:inset-x-auto md:right-0 md:top-full md:mt-2 md:max-h-none md:w-96">
          <div className="shrink-0 border-b border-border/80 bg-secondary/40 p-2">
            <SearchTabs value={tab} onChange={setTab} className="border-0 bg-transparent p-0" />
          </div>

          <div className="no-scrollbar max-h-96 min-h-0 flex-1 overflow-y-auto" aria-busy={busy}>
            {error ? (
              <p role="alert" className="flex items-start gap-2 p-4 text-xs text-destructive">
                <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" /> {error}
              </p>
            ) : busy && results.length === 0 ? (
              Array.from({ length: 3 }).map((_, i) => <SearchResultSkeleton key={i} />)
            ) : results.length > 0 ? (
              results.map((r) => (
                <SearchResultRow
                  key={`${r.kind}:${r.id}`}
                  item={r}
                  onOpen={(item) => select(item, false)}
                  onDownload={(item) => select(item, item.kind === "track")}
                  className="border-b border-border/40 last:border-0"
                />
              ))
            ) : searched && !busy ? (
              <p className="p-4 text-center text-xs text-muted-foreground">
                No {tab === "all" ? "" : `${tab} `}results found.
              </p>
            ) : null}
          </div>

          <button
            type="button"
            onClick={seeAll}
            className="w-full shrink-0 border-t border-border/80 bg-secondary/30 px-3 py-2.5 text-left text-xs font-semibold text-primary transition hover:bg-secondary/60"
          >
            See all results for “{query.trim()}” →
          </button>
        </div>
      )}
    </div>
  );
}
