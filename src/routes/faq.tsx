import { createFileRoute } from "@tanstack/react-router";
import { Archive, Globe2, Headphones, SlidersHorizontal } from "lucide-react";

import { PageHero } from "@/components/Page";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { SITE } from "@/lib/site";
import { seoHead } from "@/lib/seo";

export const Route = createFileRoute("/faq")({
  head: () => ({
    ...seoHead({
      title: `SoundCloud Downloader Features & FAQ — ${SITE.name}`,
      description: `What ${SITE.name} does well — playlist ZIP exports, MP3, WAV and original AAC with ID3 tags — plus honest answers about quality, speed and limits.`,
      path: "/faq",
      ogType: "article",
    }),
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: FAQS.map((f) => ({
            "@type": "Question",
            name: f.q,
            acceptedAnswer: { "@type": "Answer", text: f.a },
          })),
        }),
      },
    ],
  }),
  component: Faq,
});

const FEATURES = [
  {
    icon: Archive,
    title: "Full playlist ZIP support",
    body: "Point it at an album or playlist and every track is collected into one ZIP archive, numbered in playlist order.",
  },
  {
    icon: Headphones,
    title: "High-quality audio",
    body: "You get the best audio SoundCloud still serves publicly — original AAC at up to 160kbps, or MP3 and WAV converted from that same stream in your browser.",
  },
  {
    icon: SlidersHorizontal,
    title: "Seven output formats",
    body: "Pick Original AAC (160 or 96kbps), MP3 at 128, 192, 256 or 320kbps, or 16-bit WAV. Higher MP3 bitrates improve compatibility, not the detail in the source.",
  },
  {
    icon: Globe2,
    title: "No software required",
    body: "100% web-based: no browser extensions, no desktop apps, no account, no queue, no watermarks.",
  },
];

const FAQS = [
  {
    q: "Why do some playlists take longer to download?",
    a: "Tracks are fetched several at a time and then packed into the archive. Long lists, and MP3 or WAV conversion (done in your browser), take longer, so the progress line counts up as each track finishes.",
  },
  {
    q: "Can I download SoundCloud Go+ (premium) tracks?",
    a: "No. Tracks that are private, paywalled or DRM-protected cannot be extracted — the service only handles audio SoundCloud already serves publicly.",
  },
  {
    q: "Where are my downloaded files stored?",
    a: "Wherever your browser puts downloads: Windows and Mac use the Downloads folder by default, iPhone saves through Safari to the Files app, and Android saves to Downloads.",
  },
  {
    q: "What audio format do you provide?",
    a: "Choose MP3 (128, 192, 256 or 320kbps), WAV, or the original AAC (.m4a) file. SoundCloud streams most audio as AAC at up to 160kbps, so MP3 and WAV are converted from that source — a higher bitrate changes compatibility, not the original recording's detail.",
  },
  {
    q: "Do you keep copies of what I download?",
    a: "No. Audio is streamed straight through to your browser and nothing is written to disk on our side — see the Privacy Policy for the full wording.",
  },
];

function Faq() {
  return (
    <main>
      <PageHero
        eyebrow="Features & FAQ"
        title="Features & Frequently Asked Questions"
        subtitle={`Everything you need to know about ${SITE.name}'s audio quality, playlist extraction, and limitations.`}
      />

      <div className="mx-auto mt-12 max-w-5xl px-4">
        <div className="grid gap-4 sm:grid-cols-2">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-2xl border border-border bg-card p-6">
              <f.icon className="h-6 w-6 text-primary" />
              <h2 className="mt-4 text-lg font-semibold tracking-tight">{f.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{f.body}</p>
            </div>
          ))}
        </div>

        <div className="mx-auto mt-14 max-w-3xl">
          <h2 className="text-2xl font-bold tracking-tight">Frequently asked questions</h2>
          <Accordion type="single" collapsible className="mt-5">
            {FAQS.map((f, i) => (
              <AccordionItem key={f.q} value={`item-${i}`}>
                <AccordionTrigger className="text-left text-sm font-medium">{f.q}</AccordionTrigger>
                <AccordionContent className="text-sm leading-relaxed text-muted-foreground">{f.a}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </div>
    </main>
  );
}
