// Canonicals, og:url, sitemap and robots all have to name the host the app is actually
// served from; a hardcoded origin makes every page declare a foreign canonical.
// Deploying to any host other than the fallback below requires VITE_SITE_ORIGIN.
const FALLBACK_ORIGIN = "https://cloudmp3.site";

const DISALLOWED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^\[?::1\]?$/,
  /\.local$/i,
  /\.internal$/i,
  /\.vercel\.app$/i,
  /\.netlify\.app$/i,
  /\.pages\.dev$/i,
  /\.workers\.dev$/i,
  /\.ngrok(-free)?\.app$/i,
];

export function resolveOrigin(
  raw: unknown = import.meta.env["VITE_SITE_ORIGIN"],
): string {
  const trimmed = typeof raw === "string" ? raw.trim().replace(/\/+$/, "") : "";
  if (!trimmed.startsWith("https://")) return FALLBACK_ORIGIN;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:") return FALLBACK_ORIGIN;
    if (url.username || url.password) return FALLBACK_ORIGIN;
    if (url.port && url.port !== "443") return FALLBACK_ORIGIN;
    const host = url.hostname.toLowerCase();
    if (!host || !host.includes(".")) return FALLBACK_ORIGIN;
    if (DISALLOWED_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
      return FALLBACK_ORIGIN;
    }
    if (host === "www.cloudmp3.site") {
      return FALLBACK_ORIGIN;
    }
    return `https://${host}`;
  } catch {
    return FALLBACK_ORIGIN;
  }
}

const origin = resolveOrigin();

export const SITE = {
  name: "CloudMP3",
  origin,
  // Legal copy and the footer disclaimer name the domain actually being served.
  domain: new URL(origin).hostname,
  supportEmail: "support@cloudmp3.site",
  dmcaEmail: "dmca@cloudmp3.site",
  tagline:
    "Fast, clean SoundCloud track and playlist downloader. Download single files or full playlists as ZIP archives.",
} as const;

export const NAV_LINKS = [
  { label: "Home", to: "/" as const, search: undefined },
  { label: "How to Download", to: "/how-to-download" as const, search: undefined },
  { label: "Features & FAQ", to: "/faq" as const, search: undefined },
  { label: "Contact / Report", to: "/contact" as const, search: undefined },
];

export const LEGAL_LINKS = [
  { label: "Terms of Service", to: "/terms" as const },
  { label: "Privacy Policy", to: "/privacy" as const },
  { label: "DMCA & Copyright", to: "/dmca" as const },
];
