import { createFileRoute } from "@tanstack/react-router";

import { SITE } from "@/lib/site";

// Bump this only when a page's content actually changed. A bulk-updated lastmod is
// worse than none: Google treats it as a crawl signal and stops trusting the file.
// It is a constant, never new Date() at request time, which would renew every entry
// on every crawl and teach Google to ignore lastmod altogether.
const SITEMAP_LASTMOD = "2026-11-02";

const PAGES = ["", "/how-to-download", "/faq", "/contact", "/terms", "/privacy", "/dmca"];

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: () => {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${PAGES.map(
  (p) => `  <url><loc>${SITE.origin}${p}</loc><lastmod>${SITEMAP_LASTMOD}</lastmod></url>`,
).join("\n")}
</urlset>`;
        return new Response(xml, {
          headers: { "Content-Type": "application/xml; charset=utf-8" },
        });
      },
    },
  },
});
