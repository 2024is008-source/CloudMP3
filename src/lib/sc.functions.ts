import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export const getInfo = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z
      .object({
        url: z
          .string()
          .url()
          .refine(
            (u) => /(^|\.)soundcloud\.com$|on\.soundcloud\.com/.test(new URL(u).hostname),
            "Not a SoundCloud link",
          ),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { resolveUrl } = await import("./soundcloud.server");
    // Whether this deployment can run FFmpeg at all decides where a batch's
    // conversions happen, so the page is told alongside the tracks.
    const { serviceConfigured } = await import("./original.server");
    try {
      return { ok: true as const, info: await resolveUrl(data.url), service: serviceConfigured() };
    } catch (e) {
      return {
        ok: false as const,
        error: e instanceof Error ? e.message : "Could not resolve link",
      };
    }
  });

export const getTrackPage = createServerFn({ method: "GET" })
  .validator((d: unknown) =>
    z.object({ id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).parse(d),
  )
  .handler(async ({ data }) => {
    const { getTrackDetails } = await import("./soundcloud.server");
    try {
      return { ok: true as const, track: await getTrackDetails(data.id) };
    } catch (e) {
      return {
        ok: false as const,
        error: e instanceof Error ? e.message : "Could not load this track",
      };
    }
  });

export const getRelatedTracks = createServerFn({ method: "GET" })
  .validator((d: unknown) =>
    z
      .object({
        id: z.coerce.number().int().positive(),
        artist: z.string().trim().min(1).max(160),
        title: z.string().trim().min(1).max(240),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { findRelatedTracks } = await import("./soundcloud.server");
    try {
      return { ok: true as const, ...(await findRelatedTracks(data)) };
    } catch (e) {
      return {
        ok: false as const,
        error: e instanceof Error ? e.message : "Could not load related tracks",
      };
    }
  });

export const searchSoundcloud = createServerFn({ method: "GET" })
  .validator((d: unknown) =>
    z
      .object({
        q: z.string().trim().min(2).max(120),
        filter: z.enum(["all", "tracks", "playlists"]).default("all"),
        limit: z.number().int().min(1).max(50).default(12),
        offset: z.number().int().min(0).max(1000).default(0),
        tab: z.enum(["original", "remixes", "covers", "playlists", "all"]).optional(),
        full: z.boolean().default(false),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { searchRanked, searchSc } = await import("./soundcloud.server");
    try {
      if (data.tab) {
        const page = await searchRanked(data.q, data.tab, data.limit, data.offset, data.full);
        return { ok: true as const, ...page };
      }
      const results = await searchSc(data.q, data.filter, data.limit, data.offset);
      return {
        ok: true as const,
        results,
        nextOffset: data.offset + data.limit,
        hasMore: results.length === data.limit,
      };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : "Search failed" };
    }
  });
