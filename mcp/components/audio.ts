"use client";
// Audio in the browser: read a file's length, and join several clips into one WAV (several voice samples become one
// reference; a voiceover's lines become one full take). Decoding uses the browser's own codecs, so anything it can
// play (wav, mp3, m4a, webm, most video) works.

let ctx: AudioContext | null = null;
export const audioCtx = () => (ctx ??= new AudioContext());

/** Decode a file or URL to PCM. */
export async function decode(src: Blob | string): Promise<AudioBuffer> {
  const bytes = typeof src === "string" ? await (await fetch(src)).arrayBuffer() : await src.arrayBuffer();
  return audioCtx().decodeAudioData(bytes);
}

/** Length in seconds, or null if the browser can't read it. */
export async function durationOf(src: Blob | string): Promise<number | null> {
  try { return (await decode(src)).duration; } catch { return null; }
}

/** One mono 16-bit WAV from several buffers, with `gap` seconds of silence between them. */
export function joinWav(parts: AudioBuffer[], gap = 0.4): Blob {
  const rate = parts[0]?.sampleRate ?? 48000;
  const gapN = Math.round(gap * rate);
  const mono = parts.map((b) => {
    // the context resamples everything it decodes to its own rate, so the parts already agree
    const out = new Float32Array(b.length);
    for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) out[i] += d[i] / b.numberOfChannels; }
    return out;
  });
  const total = mono.reduce((n, m) => n + m.length, 0) + gapN * Math.max(0, mono.length - 1);
  const buf = new ArrayBuffer(44 + total * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + total * 2, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, total * 2, true);
  let o = 44;
  mono.forEach((m, k) => {
    for (let i = 0; i < m.length; i++, o += 2) v.setInt16(o, Math.max(-1, Math.min(1, m[i])) * 0x7fff, true);
    if (k < mono.length - 1) o += gapN * 2;
  });
  return new Blob([buf], { type: "audio/wav" });
}

/** Microphones this browser can use (names appear once the site has been allowed the mic). */
export async function microphones(): Promise<{ id: string; name: string }[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === "audioinput").map((d, i) => ({ id: d.deviceId, name: d.label || (d.deviceId === "default" || !i ? "Default microphone" : `Microphone ${i + 1}`) }));
}
