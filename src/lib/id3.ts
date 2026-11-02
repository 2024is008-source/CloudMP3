// Minimal ID3v2.3 writer: title, artist, album, track number and front cover art.
export type Id3Meta = {
  title: string;
  artist: string;
  album?: string | undefined;
  track?: number | undefined;
  cover?: { data: Uint8Array; mime: string } | undefined;
};

const enc = (s: string) => {
  // UTF-16 with BOM (encoding byte 0x01) so non-Latin titles survive.
  const out = new Uint8Array(2 + s.length * 2);
  out[0] = 0xff;
  out[1] = 0xfe;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[2 + i * 2] = c & 0xff;
    out[3 + i * 2] = c >> 8;
  }
  return out;
};

function frame(id: string, body: Uint8Array) {
  const f = new Uint8Array(10 + body.length);
  for (let i = 0; i < 4; i++) f[i] = id.charCodeAt(i);
  new DataView(f.buffer).setUint32(4, body.length);
  f.set(body, 10);
  return f;
}

const textFrame = (id: string, s: string) => {
  const t = enc(s);
  const b = new Uint8Array(1 + t.length);
  b[0] = 1;
  b.set(t, 1);
  return frame(id, b);
};

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

export function buildId3(meta: Id3Meta): Uint8Array {
  const frames: Uint8Array[] = [textFrame("TIT2", meta.title), textFrame("TPE1", meta.artist)];
  if (meta.album) frames.push(textFrame("TALB", meta.album));
  if (meta.track) frames.push(textFrame("TRCK", String(meta.track)));
  if (meta.cover) {
    const mime = new TextEncoder().encode(meta.cover.mime);
    // encoding(0) mime\0 type(3=front cover) description\0 data
    frames.push(frame("APIC", concat([new Uint8Array([0]), mime, new Uint8Array([0, 3, 0]), meta.cover.data])));
  }
  const body = concat(frames);
  const h = new Uint8Array(10);
  h.set([0x49, 0x44, 0x33, 3, 0, 0]);
  const n = body.length; // syncsafe size
  h[6] = (n >> 21) & 0x7f;
  h[7] = (n >> 14) & 0x7f;
  h[8] = (n >> 7) & 0x7f;
  h[9] = n & 0x7f;
  return concat([h, body]);
}

export const tagMp3 = (mp3: Uint8Array, meta: Id3Meta) => concat([buildId3(meta), mp3]);

export async function fetchCover(url: string | null): Promise<Id3Meta["cover"]> {
  if (!url) return undefined;
  try {
    const r = await fetch(url.replace("-large.", "-t500x500."));
    if (!r.ok) return undefined;
    return { data: new Uint8Array(await r.arrayBuffer()), mime: r.headers.get("Content-Type") ?? "image/jpeg" };
  } catch {
    return undefined;
  }
}
