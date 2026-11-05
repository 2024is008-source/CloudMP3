/** Byte estimates from the real stream bitrate (kbps) × duration. */
export function estimateBytes(durationMs: number, kbps: number): number {
  if (!Number.isFinite(durationMs) || !Number.isFinite(kbps) || durationMs <= 0 || kbps <= 0)
    return 0;
  return Math.round((kbps * 1000 * (durationMs / 1000)) / 8);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const mb = bytes / 1e6;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (mb >= 100) return `${Math.round(mb)} MB`;
  if (mb >= 10) return `${mb.toFixed(1)} MB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}
