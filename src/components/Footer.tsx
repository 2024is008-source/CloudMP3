import { Link } from "@tanstack/react-router";
import { CircleAlert, Mail } from "lucide-react";

import { BrandMark } from "@/components/Navbar";
import { SITE } from "@/lib/site";

const FOOTER_LINK = "text-muted-foreground transition-colors hover:text-foreground";

export function Footer() {
  return (
    <footer className="mt-section border-t border-border/60 bg-card/40">
      <div className="mx-auto grid max-w-page gap-10 px-5 py-14 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <div className="flex items-center gap-2.5">
            <BrandMark />
            <span className="font-display text-lg font-bold tracking-tight">{SITE.name}</span>
          </div>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{SITE.tagline}</p>
          <p className="mt-4 inline-flex items-center gap-2 rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
            </span>
            All Systems Operational
          </p>
        </div>

        <div>
          <h2 className="text-sm font-semibold text-foreground">Navigation</h2>
          <ul className="mt-4 space-y-2.5 text-sm">
            <li>
              <Link to="/" search={{ focus: false }} className={FOOTER_LINK}>
                Home
              </Link>
            </li>
            <li>
              <Link to="/how-to-download" className={FOOTER_LINK}>
                How to Download
              </Link>
            </li>
            <li>
              <Link to="/faq" className={FOOTER_LINK}>
                Features &amp; FAQ
              </Link>
            </li>
          </ul>
        </div>

        <div>
          <h2 className="text-sm font-semibold text-foreground">Legal</h2>
          <ul className="mt-4 space-y-2.5 text-sm">
            <li>
              <Link to="/terms" className={FOOTER_LINK}>
                Terms of Service
              </Link>
            </li>
            <li>
              <Link to="/privacy" className={FOOTER_LINK}>
                Privacy Policy
              </Link>
            </li>
            <li>
              <Link to="/dmca" className={FOOTER_LINK}>
                DMCA &amp; Copyright
              </Link>
            </li>
          </ul>
        </div>

        <div>
          <h2 className="text-sm font-semibold text-foreground">Support</h2>
          <ul className="mt-4 space-y-2.5 text-sm">
            <li>
              <Link to="/contact" className={FOOTER_LINK}>
                Contact &amp; Support
              </Link>
            </li>
            <li>
              <Link
                to="/contact"
                search={{ topic: "broken-link" }}
                className={`inline-flex items-center gap-1.5 ${FOOTER_LINK}`}
              >
                <CircleAlert className="h-3.5 w-3.5" /> Report Broken Link
              </Link>
            </li>
            <li>
              <a
                href={`mailto:${SITE.supportEmail}`}
                className={`inline-flex items-center gap-1.5 ${FOOTER_LINK}`}
              >
                <Mail className="h-3.5 w-3.5" /> {SITE.supportEmail}
              </a>
            </li>
          </ul>
        </div>
      </div>

      <div className="border-t border-border/60">
        <div className="mx-auto max-w-page px-5 py-6 text-xs leading-relaxed text-muted-foreground">
          <p>
            © {new Date().getFullYear()} {SITE.name}. All rights reserved.
          </p>
          <p className="mt-2 max-w-3xl">
            Disclaimer: {SITE.name} ({SITE.domain}) is not affiliated with, endorsed by, or
            associated with SoundCloud Limited. All trademarks, service marks, and logos belong to
            their respective owners.
          </p>
        </div>
      </div>
    </footer>
  );
}
