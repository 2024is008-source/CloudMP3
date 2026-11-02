import { createFileRoute } from "@tanstack/react-router";

import { SITE } from "@/lib/site";

const PAGES = [
  "",
  "/how-to-download",
  "/faq",
  "/contact",
  "/terms",
  "/privacy",
  "/dmca",
];

// Bump only the entries whose page content actually changed. A bulk-updated lastmod is
// worse than none: Google treats it as a crawl signal and stops trusting the file.
const LASTMOD: Record<string, string> = {
  "": "2026-11-02",
  "/how-to-download": "2026-11-02",
  "/faq": "2026-11-02",
  "/contact": "2026-11-02",
  "/terms": "2026-11-02",
  "/privacy": "2026-11-02",
  "/dmca": "2026-11-02",
};

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: () => {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${PAGES.map((p) => {
  const lastmod = LASTMOD[p];
  return `  <url><loc>${SITE.origin}${p}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`;
}).join("\n")}
</urlset>`;
        return new Response(xml, {
          headers: { "Content-Type": "application/xml; charset=utf-8" },
        });
      },
    },
  },
});
