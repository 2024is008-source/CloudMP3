import { describe, expect, it } from "vitest";

import { estimateBytes, formatBytes } from "@/lib/audio-size";

describe("audio size estimates", () => {
  it("uses milliseconds and kbps correctly", () => {
    // 3:55 at 160 kbps ≈ 4.7 MB.
    expect(estimateBytes(235_000, 160)).toBe(4_700_000);
    expect(formatBytes(estimateBytes(235_000, 160))).toBe("4.7 MB");
  });

  it("formats KB, MB and GB ranges", () => {
    expect(formatBytes(900)).toBe("1 KB");
    expect(formatBytes(2_400_000)).toBe("2.4 MB");
    expect(formatBytes(24_000_000)).toBe("24.0 MB");
    expect(formatBytes(240_000_000)).toBe("240 MB");
    expect(formatBytes(2_400_000_000)).toBe("2.40 GB");
  });

  it("returns a dash for missing data", () => {
    expect(estimateBytes(0, 160)).toBe(0);
    expect(formatBytes(0)).toBe("—");
  });
});
