import { createFileRoute } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { ArrowRight, ClipboardCopy, Download, FolderArchive, Music, SlidersHorizontal } from "lucide-react";

import { PageHero } from "@/components/Page";
import { SITE } from "@/lib/site";
import { seoHead } from "@/lib/seo";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/how-to-download")({
  head: () => ({
    ...seoHead({
      title: `How to Download SoundCloud Tracks & Playlists — ${SITE.name}`,
      description: `Step-by-step guide to saving a single SoundCloud track or a full playlist as a ZIP on desktop, iPhone and Android with ${SITE.name}.`,
      path: "/how-to-download",
      ogType: "article",
    }),
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "HowTo",
          name: "How to download SoundCloud tracks and playlists as MP3 or ZIP",
          totalTime: "PT1M",
          step: DESKTOP.map((s, i) => ({
            "@type": "HowToStep",
            position: i + 1,
            name: s.title,
            text: s.body,
            url: `${SITE.origin}/how-to-download#step-${i + 1}`,
          })),
        }),
      },
    ],
  }),
  component: HowTo,
});

const DESKTOP = [
  {
    icon: ClipboardCopy,
    title: "Copy the link",
    body: "Open the track, album or playlist on SoundCloud, click Share, then Copy link. You can also copy the address straight from your browser's address bar.",
  },
  {
    icon: Music,
    title: "Paste it into the fetch bar",
    body: `Come back to ${SITE.name} and paste the link into the box on the home page, then press Fetch. The cover, title, track list and total length appear in a few seconds.`,
  },
  {
    icon: SlidersHorizontal,
    title: "Pick your quality",
    body: "Use the format menu to pick MP3 (128–320kbps), lossless-container WAV, or the original AAC file. MP3 · 320kbps is the default and plays everywhere.",
  },
  {
    icon: FolderArchive,
    title: "Save the file or the whole ZIP",
    body: "Hit the download arrow next to one track for a single file, or use Download ZIP to grab everything in the playlist as one archive with numbered filenames.",
  },
];

const MOBILE = [
  {
    icon: ClipboardCopy,
    title: "Tap Share, then Copy link",
    body: "In the SoundCloud app or mobile site, tap the three-dot menu on a track or playlist, choose Share, then Copy link.",
  },
  {
    icon: Music,
    title: "Open the link field",
    body: `Open ${SITE.name} and long-press the box to paste — or type the song or artist name into the search bar in the top menu and tap a result. The full track list loads the same way it does on a computer.`,
  },
  {
    icon: SlidersHorizontal,
    title: "Choose the size you want",
    body: "MP3 · 320kbps sounds best on headphones and plays everywhere; MP3 · 128kbps keeps files small if you are on mobile data.",
  },
  {
    icon: Download,
    title: "Let the browser save it",
    body: "Android saves to your Downloads folder. On iPhone, Safari asks where to put the file — the Files app keeps it, and ZIP archives unzip with a tap.",
  },
];

function Steps({ items }: { items: typeof DESKTOP }) {
  return (
    <ol className="mt-8 grid gap-4 sm:grid-cols-2">
      {items.map((s, i) => (
        <li key={s.title} className="rounded-2xl border border-border bg-card p-5">
          <div className="flex items-center gap-3">
            <span className="font-display text-2xl font-bold text-primary">{String(i + 1).padStart(2, "0")}</span>
            <s.icon className="h-5 w-5 text-muted-foreground" />
          </div>
          <h3 className="mt-3 text-base font-semibold">{s.title}</h3>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
        </li>
      ))}
    </ol>
  );
}

function HowTo() {
  const [tab, setTab] = useState<"desktop" | "mobile">("desktop");
  const items = tab === "desktop" ? DESKTOP : MOBILE;

  return (
    <main>
      <PageHero
        eyebrow="Guide"
        title="How to Download Tracks and Playlists from SoundCloud"
        subtitle="A simple, step-by-step visual guide for desktop, iOS, and Android."
      />

      <div className="mx-auto mt-10 max-w-4xl px-4">
        <div className="flex justify-center">
          <div className="inline-flex rounded-full border border-border bg-card p-1">
            {(["desktop", "mobile"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  "rounded-full px-5 py-2 text-sm font-medium capitalize transition-colors",
                  tab === t ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t} Guide
              </button>
            ))}
          </div>
        </div>

        <Steps items={items} />

        <div className="mt-10 rounded-3xl border border-border bg-card p-8 text-center">
          <h2 className="text-2xl font-bold tracking-tight">Ready to download your favorite music?</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Paste a link and your files are a click away.
          </p>
          <Link
            to="/"
            search={{ focus: true }}
            className="mt-6 inline-flex items-center gap-2 rounded-full bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground transition hover:opacity-90"
          >
            Open the fetch bar <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </main>
  );
}
