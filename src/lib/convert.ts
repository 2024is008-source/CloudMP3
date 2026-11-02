// Browser-only audio conversion: decode source (AAC/MP3) via Web Audio, re-encode to WAV or MP3.
export type Format = "original-high" | "original-low" | "mp3-320" | "mp3-256" | "mp3-192" | "mp3-128" | "wav";

export const FORMATS: { value: Format; label: string }[] = [
  { value: "original-high", label: "Original AAC · 160kbps" },
  { value: "original-low", label: "Original AAC · 96kbps" },
  { value: "mp3-320", label: "MP3 · 320kbps" },
  { value: "mp3-256", label: "MP3 · 256kbps" },
  { value: "mp3-192", label: "MP3 · 192kbps" },
  { value: "mp3-128", label: "MP3 · 128kbps" },
  { value: "wav", label: "WAV · 16-bit lossless" },
];

async function decode(data: Uint8Array): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, 1, 44100);
  return ctx.decodeAudioData(data.slice().buffer);
}

function toInt16(f: Float32Array) {
  const o = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const s = Math.max(-1, Math.min(1, f[i]!));
    o[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return o;
}

function encodeWav(b: AudioBuffer): Uint8Array {
  const ch = Math.min(2, b.numberOfChannels);
  const len = b.length;
  const out = new DataView(new ArrayBuffer(44 + len * ch * 2));
  const w = (o: number, s: string) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); out.setUint32(4, 36 + len * ch * 2, true); w(8, "WAVE"); w(12, "fmt ");
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true);
  out.setUint32(24, b.sampleRate, true); out.setUint32(28, b.sampleRate * ch * 2, true);
  out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true); w(36, "data"); out.setUint32(40, len * ch * 2, true);
  const chans = Array.from({ length: ch }, (_, c) => toInt16(b.getChannelData(c)));
  let p = 44;
  for (let i = 0; i < len; i++) for (let c = 0; c < ch; c++) { out.setInt16(p, chans[c]![i]!, true); p += 2; }
  return new Uint8Array(out.buffer);
}

async function encodeMp3(b: AudioBuffer, kbps: number, onProgress?: (p: number) => void): Promise<Uint8Array> {
  const { Mp3Encoder } = await import("@breezystack/lamejs");
  const ch = Math.min(2, b.numberOfChannels);
  const enc = new Mp3Encoder(ch, b.sampleRate, kbps);
  const l = toInt16(b.getChannelData(0));
  const r = ch > 1 ? toInt16(b.getChannelData(1)) : l;
  const parts: Uint8Array[] = [];
  const BLOCK = 1152 * 20;
  for (let i = 0; i < l.length; i += BLOCK) {
    const chunk = ch > 1 ? enc.encodeBuffer(l.subarray(i, i + BLOCK), r.subarray(i, i + BLOCK)) : enc.encodeBuffer(l.subarray(i, i + BLOCK));
    if (chunk.length) parts.push(new Uint8Array(chunk));
    onProgress?.(Math.min(1, (i + BLOCK) / l.length));
    if (i % (BLOCK * 20) === 0) await new Promise((res) => setTimeout(res)); // keep UI responsive
  }
  const end = enc.flush();
  if (end.length) parts.push(new Uint8Array(end));
  onProgress?.(1);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export async function convert(
  data: Uint8Array,
  srcExt: string,
  fmt: Format,
  onPhase?: (phase: "decode" | "encode", progress: number) => void,
) {
  if (fmt.startsWith("original")) return { data, ext: srcExt, mime: srcExt === "mp3" ? "audio/mpeg" : "audio/mp4" };
  onPhase?.("decode", 0);
  const buf = await decode(data);
  onPhase?.("encode", 0);
  if (fmt === "wav") {
    const out = encodeWav(buf);
    onPhase?.("encode", 1);
    return { data: out, ext: "wav", mime: "audio/wav" };
  }
  const out = await encodeMp3(buf, Number(fmt.split("-")[1]), (p) => onPhase?.("encode", p));
  return { data: out, ext: "mp3", mime: "audio/mpeg" };
}
