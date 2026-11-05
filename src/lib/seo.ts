import { SITE } from "./site";

export const OG_IMAGE = "/og/default.png";

/** Canonical URL for a path on this site. Always absolute — crawlers resolve relative canonicals inconsistently. */
export function absoluteUrl(path: string): string {
  return `${SITE.origin}${path}`;
}

export type PageSeo = {
  title: string;
  description: string;
  /** Site-relative path, "" for the homepage. */
  path: string;
  ogType?: string;
  /** Social cards read better without the site-name suffix carried by the title tag. */
  ogTitle?: string;
  /** Site-relative asset or absolute URL. Track pages pass SoundCloud artwork. */
  image?: string;
  imageAlt?: string;
};

export function seoHead({
  title,
  ogTitle = title,
  description,
  path,
  ogType = "website",
  image = OG_IMAGE,
  imageAlt = `${SITE.name} — SoundCloud to MP3 converter`,
}: PageSeo) {
  // SoundCloud sometimes hands back protocol-relative artwork URLs ("//i1.sndcdn…").
  const imageUrl = image.startsWith("//")
    ? `https:${image}`
    : image.startsWith("http")
      ? image
      : absoluteUrl(image);
  return {
    meta: [
      { title },
      { name: "description", content: description },
      { property: "og:title", content: ogTitle },
      { property: "og:description", content: description },
      { property: "og:type", content: ogType },
      { property: "og:url", content: absoluteUrl(path) },
      { property: "og:image", content: imageUrl },
      { property: "og:image:alt", content: imageAlt },
      { name: "twitter:image", content: imageUrl },
    ],
    links: [{ rel: "canonical", href: absoluteUrl(path) }],
  };
}
