// Tiny cross-component store: the header search bar hands a picked
// SoundCloud URL to the home page, which fills its box and fetches it.
export type Selection = { url: string; autoDownload: boolean; nonce: number };

let current: Selection | null = null;
const listeners = new Set<() => void>();

export function setSelection(url: string, autoDownload: boolean) {
  current = { url, autoDownload, nonce: Date.now() + Math.random() };
  for (const l of listeners) l();
}

export function clearSelection() {
  current = null;
}

export function getSelection(): Selection | null {
  return current;
}

export function subscribeSelection(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
