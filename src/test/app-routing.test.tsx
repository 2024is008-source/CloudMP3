import { QueryClient } from "@tanstack/react-query";
import { createRouter, rootRouteId } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import { routeTree } from "@/routeTree.gen";

// Match routes without running loaders or rendering: loaders may need a server or
// network the test run lacks, and jsdom never loads the stylesheets React waits on.
describe("App routing", () => {
  const router = createRouter({ routeTree, context: { queryClient: new QueryClient() } });

  const matches = (path: string) => router.matchRoutes(path).at(-1)?.routeId;

  it("matches a page for / instead of falling back to not found", () => {
    expect(matches("/")).not.toBe(rootRouteId);
  });

  it.each([
    "/search",
    "/how-to-download",
    "/faq",
    "/contact",
    "/terms",
    "/privacy",
    "/dmca",
    "/sitemap.xml",
  ])("serves the %s page", (path) => {
    expect(matches(path)).not.toBe(rootRouteId);
  });

  it("matches a track detail page", () => {
    expect(matches("/track/301161123")).toBe("/track/$id");
  });

  it("keeps the download endpoint public", () => {
    expect(matches("/api/public/track")).toBe("/api/public/track");
  });

  it("keeps the preview endpoint public", () => {
    expect(matches("/api/public/preview")).toBe("/api/public/preview");
  });
});
