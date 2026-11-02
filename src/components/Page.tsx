import type { ReactNode } from "react";

import { SITE } from "@/lib/site";

export function PageHero({
  eyebrow,
  title,
  subtitle,
}: {
  eyebrow?: string;
  title: string;
  subtitle: string;
}) {
  return (
    <section className="mx-auto max-w-3xl px-5 pt-section text-center">
      {eyebrow && (
        <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground">
          {eyebrow}
        </span>
      )}
      <h1 className="mt-5 text-4xl font-bold tracking-tight md:text-5xl">{title}</h1>
      <p className="mx-auto mt-3 max-w-prose text-muted-foreground">{subtitle}</p>
    </section>
  );
}

export function LegalPage({
  title,
  updated,
  intro,
  children,
}: {
  title: string;
  updated: string;
  intro: string;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto max-w-4xl px-5 py-section">
      <p className="text-xs uppercase tracking-wider text-muted-foreground">{SITE.name} · {SITE.domain}</p>
      <h1 className="mt-3 text-4xl font-bold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">Last updated: {updated}</p>
      <p className="mt-6 text-sm leading-relaxed text-muted-foreground">{intro}</p>
      <div className="mt-10 space-y-10">{children}</div>
    </main>
  );
}

export function LegalSection({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-xl font-semibold tracking-tight">{heading}</h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted-foreground">{children}</div>
    </section>
  );
}
