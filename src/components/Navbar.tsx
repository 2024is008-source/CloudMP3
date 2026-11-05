import { Link } from "@tanstack/react-router";
import { Menu, Search, X } from "lucide-react";
import { useEffect, useState } from "react";

import { HeaderSearch } from "@/components/HeaderSearch";
import { SITE } from "@/lib/site";
import { cn } from "@/lib/utils";

export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary",
        className,
      )}
    >
      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-primary-foreground/15">
        <span className="h-1.5 w-1.5 rounded-full bg-primary-foreground" />
      </span>
    </span>
  );
}

const LINK_CLASS =
  "whitespace-nowrap rounded-full px-2.5 py-2 text-nav text-muted-foreground transition-colors hover:bg-accent hover:text-foreground lg:px-3";
const ACTIVE_CLASS = "bg-secondary text-foreground";
const ICON_BTN =
  "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-border text-foreground";

export function Navbar() {
  const [open, setOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const close = () => {
    setOpen(false);
    setSearchOpen(false);
  };

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const solid = scrolled || open || searchOpen;

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-50 transition-colors duration-300",
        solid
          ? "border-b border-border/60 bg-background/80 backdrop-blur-md"
          : "border-b border-transparent bg-transparent",
      )}
    >
      <div className="mx-auto flex h-16 max-w-page items-center justify-between gap-4 px-5">
        <Link
          to="/"
          search={{ focus: false }}
          className="flex shrink-0 items-center gap-2.5"
          onClick={close}
        >
          <BrandMark />
          <span
            className={cn(
              "font-display text-lg font-bold tracking-tight text-foreground",
              searchOpen && "max-lg:hidden",
            )}
          >
            {SITE.name}
          </span>
        </Link>

        {/* Below lg the bar has no room for a field beside four labels, so it offers
            a lookup button that expands in place instead. */}
        <div
          className={cn(
            "flex items-center gap-2 lg:hidden",
            searchOpen ? "min-w-0 flex-1" : "ml-auto",
          )}
        >
          {searchOpen ? (
            <>
              <div className="min-w-0 flex-1">
                <HeaderSearch onPicked={() => setSearchOpen(false)} autoFocus />
              </div>
              <button
                type="button"
                aria-label="Close search"
                onClick={() => setSearchOpen(false)}
                className={ICON_BTN}
              >
                <X className="h-5 w-5" />
              </button>
            </>
          ) : (
            <button
              type="button"
              aria-label="Search SoundCloud"
              onClick={() => setSearchOpen(true)}
              className={ICON_BTN}
            >
              <Search className="h-5 w-5" />
            </button>
          )}
        </div>

        <nav className="hidden items-center gap-1 md:flex">
          <Link
            to="/"
            search={{ focus: false }}
            className={LINK_CLASS}
            activeOptions={{ exact: true }}
            activeProps={{ className: ACTIVE_CLASS }}
          >
            Home
          </Link>
          <Link
            to="/how-to-download"
            className={LINK_CLASS}
            activeProps={{ className: ACTIVE_CLASS }}
          >
            How to Download
          </Link>
          <Link to="/faq" className={LINK_CLASS} activeProps={{ className: ACTIVE_CLASS }}>
            Features &amp; FAQ
          </Link>
          <Link to="/contact" className={LINK_CLASS} activeProps={{ className: ACTIVE_CLASS }}>
            Contact / Report
          </Link>
          <div className="ml-2 hidden lg:block">
            <HeaderSearch />
          </div>
        </nav>

        <button
          type="button"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={cn(ICON_BTN, "lg:hidden", searchOpen && "max-lg:hidden")}
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {open && (
        <nav className="border-t border-border/60 bg-background px-5 pb-5 pt-1 shadow-2xl md:hidden">
          <div className="flex flex-col gap-1 pt-2">
            <Link
              to="/"
              search={{ focus: false }}
              onClick={close}
              className="rounded-xl px-3 py-2.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              Home
            </Link>
            <Link
              to="/how-to-download"
              onClick={close}
              className="rounded-xl px-3 py-2.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              How to Download
            </Link>
            <Link
              to="/faq"
              onClick={close}
              className="rounded-xl px-3 py-2.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              Features &amp; FAQ
            </Link>
            <Link
              to="/contact"
              onClick={close}
              className="rounded-xl px-3 py-2.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              Contact / Report
            </Link>
          </div>
        </nav>
      )}
    </header>
  );
}
