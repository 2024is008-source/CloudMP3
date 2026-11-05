// A saved download lives in memory as an object URL until the browser takes it.
// Revoking on pagehide releases the audio a job buffered the moment the visitor
// leaves, rather than waiting out the timer in a page that is already gone.
const liveUrls = new Set<string>();

function release(url: string) {
  if (liveUrls.delete(url)) URL.revokeObjectURL(url);
}

export function saveDownload(data: BlobPart, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  liveUrls.add(url);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  anchor.click();
  window.setTimeout(() => release(url), 10_000);
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    for (const url of liveUrls) URL.revokeObjectURL(url);
    liveUrls.clear();
  });
}
