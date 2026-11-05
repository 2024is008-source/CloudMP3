import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Check, Clock, Loader2, Mail, Send } from "lucide-react";
import { z } from "zod";

import { PageHero } from "@/components/Page";
import { SITE } from "@/lib/site";
import { seoHead } from "@/lib/seo";

const searchSchema = z.object({ topic: z.string().optional() });

export const Route = createFileRoute("/contact")({
  validateSearch: searchSchema,
  head: () =>
    seoHead({
      title: `Contact & Support — ${SITE.name}`,
      description: `Report a broken link, a failed ZIP download, or send feedback and feature requests to the ${SITE.name} team.`,
      path: "/contact",
      ogType: "article",
    }),
  component: Contact,
});

const CATEGORIES = [
  "Broken Link / Track Fetch Error",
  "ZIP Download Failed",
  "Feature Request",
  "DMCA / Legal",
  "Other",
];

function Contact() {
  const { topic } = Route.useSearch();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [category, setCategory] = useState<string>(CATEGORIES[0]!);

  const [scUrl, setScUrl] = useState("");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent">("idle");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    await new Promise((r) => setTimeout(r, 900));
    setStatus("sent");
  }

  const field =
    "w-full rounded-xl border border-input bg-card px-4 py-2.5 text-sm text-foreground outline-none transition focus-visible:ring-2 focus-visible:ring-ring placeholder:text-muted-foreground";

  return (
    <main>
      <PageHero
        eyebrow="Support"
        title="Get in Touch"
        subtitle="Report an issue with a URL, give feedback, or reach out with general inquiries."
      />

      <div className="mx-auto mt-12 grid max-w-5xl gap-6 px-4 lg:grid-cols-[1fr_20rem]">
        <div className="rounded-3xl border border-border bg-card p-6 sm:p-8">
          {status === "sent" ? (
            <div className="py-10 text-center">
              <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/15">
                <Check className="h-6 w-6 text-primary" />
              </span>
              <h2 className="mt-4 text-xl font-semibold">Message ready</h2>
              <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
                This form does not send on its own yet — copy your details into an email so it
                reaches the right inbox.
              </p>
              <a
                href={`mailto:${SITE.supportEmail}?subject=${encodeURIComponent(`[${category}] ${name || "Support request"}`)}&body=${encodeURIComponent(`${message}\n\n${scUrl ? `SoundCloud URL: ${scUrl}\n` : ""}From: ${name} <${email}>`)}`}
                className="mt-6 inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90"
              >
                <Mail className="h-4 w-4" /> Open in email app
              </a>
              <button
                onClick={() => setStatus("idle")}
                className="mt-3 block w-full text-sm text-muted-foreground hover:text-foreground"
              >
                Write another message
              </button>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="text-sm font-medium">Name</span>
                  <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Your name" className={`mt-1.5 ${field}`} />
                </label>
                <label className="block">
                  <span className="text-sm font-medium">Email</span>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    placeholder="you@example.com"
                    className={`mt-1.5 ${field}`}
                  />
                </label>
              </div>

              <label className="block">
                <span className="text-sm font-medium">Inquiry category</span>
                <select value={category} onChange={(e) => setCategory(e.target.value)} className={`mt-1.5 ${field} [&>option]:bg-popover`}>
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="text-sm font-medium">SoundCloud URL (optional)</span>
                <input
                  value={scUrl}
                  onChange={(e) => setScUrl(e.target.value)}
                  placeholder="https://soundcloud.com/..."
                  className={`mt-1.5 ${field}`}
                />
              </label>

              <label className="block">
                <span className="text-sm font-medium">Message</span>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  required
                  rows={5}
                  placeholder="What happened, and what did you expect?"
                  className={`mt-1.5 resize-y ${field}`}
                />
              </label>

              <button
                disabled={status === "sending"}
                className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
              >
                {status === "sending" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                {status === "sending" ? "Preparing..." : "Send message"}
              </button>
            </form>
          )}
        </div>

        <aside className="space-y-4">
          <div className="rounded-3xl border border-border bg-card p-6">
            <h2 className="text-sm font-semibold">Direct contact</h2>
            <a href={`mailto:${SITE.supportEmail}`} className="mt-3 inline-flex items-center gap-2 text-sm text-primary hover:underline">
              <Mail className="h-4 w-4" /> {SITE.supportEmail}
            </a>
            <p className="mt-4 inline-flex items-center gap-2 text-xs text-muted-foreground">
              <Clock className="h-3.5 w-3.5" /> Typical reply within 24–48 hours
            </p>
          </div>
          <div className="rounded-3xl border border-border bg-card p-6 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">Copyright notices</p>
            <p className="mt-2">
              Rights holders should use{" "}
              <Link to="/dmca" className="text-primary hover:underline">
                the DMCA page
              </Link>{" "}
              and email {SITE.dmcaEmail}.
            </p>
          </div>
          <div className="rounded-3xl border border-border bg-card p-6 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">Track missing or failing?</p>
            <p className="mt-2">
              Most failures are upstream: private, Go+ only, DRM-protected or removed by the owner.
              Include the exact URL and we can confirm.
            </p>
          </div>
        </aside>
      </div>
    </main>
  );
}
