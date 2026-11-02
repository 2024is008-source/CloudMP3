// Canonicals, og:url, sitemap and robots all have to name the host the app is actually
// served from; a hardcoded origin makes every page declare a foreign canonical.
// Deploying to any host other than the fallback below requires VITE_SITE_ORIGIN.
const FALLBACK_ORIGIN = "https://cloudmp3.site";

function resolveOrigin(): string {
  const raw = import.meta.env["VITE_SITE_ORIGIN"];
  const trimmed = typeof raw === "string" ? raw.trim().replace(/\/+$/, "") : "";
  return trimmed.startsWith("https://") ? trimmed : FALLBACK_ORIGIN;
}

const origin = resolveOrigin();

export const SITE = {
  name: "CloudMP3",
  origin,
  // Legal copy and the footer disclaimer name the domain actually being served.
  domain: new URL(origin).hostname,
  supportEmail: "support@cloudmp3.site",
  dmcaEmail: "dmca@cloudmp3.site",
  tagline: "Fast, clean SoundCloud track and playlist downloader. Download single files or full playlists as ZIP archives.",
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
