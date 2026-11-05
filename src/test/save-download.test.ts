import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { saveDownload } from "@/lib/save-download";

const revoked: string[] = [];
let counter = 0;

beforeEach(() => {
  revoked.length = 0;
  counter = 0;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => `blob:mock/${++counter}`),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn((url: string) => revoked.push(url)),
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function leavePage() {
  window.dispatchEvent(new Event("pagehide"));
}

describe("saveDownload", () => {
  it("revokes the object URL once the browser has taken the file", () => {
    saveDownload(new Uint8Array([1, 2, 3]), "song.mp3", "audio/mpeg");

    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1);
    expect(revoked).toEqual([]);

    vi.advanceTimersByTime(10_000);
    expect(revoked).toEqual(["blob:mock/1"]);
  });

  it("releases every pending download when the visitor leaves the site", () => {
    saveDownload(new Uint8Array([1]), "a.mp3", "audio/mpeg");
    saveDownload(new Uint8Array([2]), "b.mp3", "audio/mpeg");

    leavePage();
    expect(revoked).toEqual(["blob:mock/1", "blob:mock/2"]);

    // The pending timers must not revoke a second time after the URL is gone.
    vi.advanceTimersByTime(10_000);
    expect(revoked).toEqual(["blob:mock/1", "blob:mock/2"]);
  });
});
