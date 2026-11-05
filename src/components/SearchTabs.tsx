import { SEARCH_TABS, type SearchTab } from "@/lib/search-rank";
import { cn } from "@/lib/utils";

export function SearchTabs({
  value,
  onChange,
  className,
}: {
  value: SearchTab;
  onChange: (tab: SearchTab) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label="Search categories"
      className={cn(
        "grid grid-cols-5 items-center gap-1 rounded-full border border-border bg-card/70 p-1",
        "md:flex md:w-fit",
        className,
      )}
    >
      {SEARCH_TABS.map((tab) => {
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.id)}
            className={cn(
              "truncate whitespace-nowrap rounded-full px-1.5 py-1.5 text-center text-xs font-semibold transition-colors",
              "md:px-3.5 md:py-2 md:text-sm",
              active
                ? "bg-primary text-primary-foreground shadow-sm shadow-primary/30"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
