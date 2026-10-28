"use client";
// Smart search on the Files page (the server half is lib/insight.ts). MobileCLIP S0, a small image-and-text model
// (23 MB to see, 43 MB to read; downloaded once, then cached by the browser; the 8-bit image half is broken, so it's 16-bit), runs in a Web Worker so the page never
// stutters. It turns each photo into 512 numbers and a few tags from the list below; a search turns the words into
// numbers the same way and ranks photos by how close they are, so "red bottle" finds a red bottle nobody named.
// New photos are seen in the background, one at a time, while the Files page is open on a computer; what's seen is
// sent to the server so every device (and the MCP tools, by tag) shares it.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

export type Look = { h: string | null; ar: number | null; c: string[]; hex: string | null; t?: string[]; e?: 1; at?: number };
type Insight = { files: Record<string, Look>; colors: string[]; model: string };

const LIB = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6/dist/transformers.min.js";

/** Everyday things a creator's photos show; a photo gets the few that fit it best. */
export const VOCAB = [
  "person", "man", "woman", "child", "baby", "group of people", "crowd", "face", "selfie", "hands", "portrait",
  "dog", "cat", "bird", "horse", "fish", "insect", "animal",
  "strawberry", "apple", "banana", "orange", "lemon", "grapes", "watermelon", "fruit", "vegetables", "salad", "pizza", "burger", "sandwich", "pasta", "rice", "noodles",
  "cake", "cookie", "chocolate", "ice cream", "dessert", "bread", "coffee", "tea", "juice", "smoothie", "cocktail", "wine", "beer", "water", "food", "meal", "breakfast",
  "bottle", "cup", "mug", "glass", "plate", "bowl", "box", "bag", "backpack", "shoes", "sneakers", "clothes", "dress", "shirt", "jacket", "hat", "glasses", "sunglasses", "watch", "jewelry", "ring", "necklace",
  "makeup", "lipstick", "perfume", "skincare", "cosmetics", "product", "packaging", "label",
  "phone", "smartphone", "laptop", "computer", "keyboard", "mouse", "monitor", "screen", "tablet", "headphones", "earbuds", "camera", "microphone", "speaker", "tv", "game controller", "robot", "chip", "circuit board", "drone",
  "car", "motorcycle", "bicycle", "bus", "train", "airplane", "boat", "road", "street", "city", "building", "skyscraper", "house", "room", "kitchen", "bedroom", "office", "desk", "studio", "classroom", "shop", "restaurant", "cafe",
  "beach", "ocean", "sea", "lake", "river", "mountain", "forest", "tree", "flower", "plant", "garden", "park", "field", "desert", "snow", "rain", "sky", "clouds", "sunset", "sunrise", "night", "stars", "moon", "fire",
  "book", "notebook", "paper", "pen", "document", "chart", "graph", "diagram", "map", "money", "coins", "credit card",
  "text", "headline", "quote", "slide", "infographic", "screenshot", "meme", "poster", "logo", "icon", "illustration", "drawing", "cartoon", "3d render", "pattern", "abstract",
  "sports", "football", "basketball", "cricket", "gym", "fitness", "yoga", "running", "dance", "music", "guitar", "piano", "concert", "party", "wedding", "gift", "christmas", "birthday",
  "movie scene", "film still", "video game", "anime", "space", "planet", "science", "medicine", "hospital", "doctor", "school", "travel", "holiday", "nature", "architecture", "art", "fashion", "beauty", "technology", "business",
] as const;

// the worker: the model and its two halves, loaded only when needed
const WORKER = `
import { AutoTokenizer, CLIPTextModelWithProjection, AutoProcessor, CLIPVisionModelWithProjection, RawImage, env } from "${LIB}";
env.allowLocalModels = false;
let vis, txt;
const vision = () => (vis ??= Promise.all([AutoProcessor.from_pretrained(M), CLIPVisionModelWithProjection.from_pretrained(M, { dtype: "fp16" })]));
const text = () => (txt ??= Promise.all([AutoTokenizer.from_pretrained(M), CLIPTextModelWithProjection.from_pretrained(M, { dtype: "q8" })]));
let M = "";
const norm = (a) => { let s = 0; for (const v of a) s += v * v; s = Math.sqrt(s) || 1; return Float32Array.from(a, (v) => v / s); };
self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    M = data.model;
    if (type === "image") {
      const [proc, model] = await vision();
      const img = await RawImage.fromURL(data.url);
      const { image_embeds } = await model(await proc(img));
      self.postMessage({ id, ok: true, vec: norm(image_embeds.data) });
    } else {
      const [tok, model] = await text();
      const inputs = tok(data.texts, { padding: "max_length", truncation: true });
      const { text_embeds } = await model(inputs);
      const d = text_embeds.dims[1], out = [];
      for (let i = 0; i < data.texts.length; i++) out.push(norm(text_embeds.data.slice(i * d, (i + 1) * d)));
      self.postMessage({ id, ok: true, vecs: out });
    }
  } catch (e) { self.postMessage({ id, ok: false, error: String(e && e.message || e) }); }
};`;

let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, (r: { ok: boolean; vec?: Float32Array; vecs?: Float32Array[]; error?: string }) => void>();
function ask<T>(msg: Record<string, unknown>): Promise<T> {
  if (!worker) {
    worker = new Worker(URL.createObjectURL(new Blob([WORKER], { type: "text/javascript" })), { type: "module" });
    worker.onmessage = (e) => { const f = waiting.get(e.data.id); waiting.delete(e.data.id); f?.(e.data); };
  }
  const id = ++seq;
  return new Promise((res, rej) => {
    waiting.set(id, (r) => (r.ok ? res(r as T) : rej(new Error(r.error))));
    worker!.postMessage({ ...msg, id });
  });
}

// 512 numbers ↔ 512 bytes (int8), base64: small enough to keep every photo's in one file
export function pack(v: Float32Array) {
  let mx = 0; for (const x of v) mx = Math.max(mx, Math.abs(x));
  const q = Int8Array.from(v, (x) => Math.round((x / (mx || 1)) * 127));
  let s = ""; const u = new Uint8Array(q.buffer); for (const b of u) s += String.fromCharCode(b);
  return btoa(s);
}
export function unpack(b64: string) {
  const s = atob(b64); const q = new Int8Array(s.length);
  for (let i = 0; i < s.length; i++) q[i] = (s.charCodeAt(i) << 24) >> 24;
  let n = 0; for (const x of q) n += x * x; n = Math.sqrt(n) || 1;
  return Float32Array.from(q, (x) => x / n);
}
const dot = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

let vocabVecs: Promise<Float32Array[]> | null = null;
const vocab = (model: string) => (vocabVecs ??= ask<{ vecs: Float32Array[] }>({ type: "text", model, texts: VOCAB.map((w) => `a photo of ${/^[aeiou]/.test(w) ? "an" : "a"} ${w}`) }).then((r) => r.vecs));

/** The few tags that fit a photo best (CLIP's softmax over the list, keeping the clear winners). */
function tagsFor(v: Float32Array, vv: Float32Array[]) {
  const logits = vv.map((t) => dot(v, t) * 100);
  const mx = Math.max(...logits);
  const ex = logits.map((l) => Math.exp(l - mx));
  const sum = ex.reduce((a, b) => a + b, 0);
  return ex.map((e, i) => ({ w: VOCAB[i] as string, p: e / sum })).sort((a, b) => b.p - a.p).filter((x, i) => i === 0 || x.p >= 0.08).slice(0, 4).map((x) => x.w);
}

const capable = () => typeof window !== "undefined" && typeof Worker !== "undefined" && !(navigator as { connection?: { saveData?: boolean } }).connection?.saveData;

/** The Files page's smart search: looks (colours, tags) for every photo, background seeing, and meaning search. */
export function useSmartSearch(covers: Map<string, string>, on: boolean) {
  const [looks, setLooks] = useState<Record<string, Look>>({});
  const [left, setLeft] = useState(0);
  const emb = useRef<Map<string, Float32Array> | null>(null);
  const info = useRef<Insight | null>(null);
  const coversRef = useRef(covers);
  coversRef.current = covers;
  const load = useCallback(async () => {
    const r = await api<Insight>("files/insight").catch(() => null);
    if (!r) return null;
    info.current = r; setLooks(r.files);
    return r;
  }, []);

  useEffect(() => {
    if (!on) return;
    let dead = false;
    (async () => {
      await new Promise((res) => setTimeout(res, 4000)); // after the page has loaded and settled
      if (dead) return;
      let r = await load();
      if (!r || dead) return;
      // photos the server hasn't looked at (colours): one round per visit, in the background
      if ([...coversRef.current.keys()].some((k) => !r!.files[k]?.at)) { await api("files/insight/scan", { body: {} }).catch(() => null); r = (await load()) ?? r; }
      // then this browser tags what's untagged: computers only, never on a data saver
      if (dead || !capable() || !matchMedia("(pointer: fine)").matches || ((navigator as { deviceMemory?: number }).deviceMemory ?? 8) < 4) return;
      const todo = [...coversRef.current.keys()].filter((k) => !r!.files[k]?.e).slice(0, 300);
      setLeft(todo.length);
      if (!todo.length) return;
      const vv = await vocab(r.model).catch(() => null);
      if (!vv) return;
      let batch: { id: string; emb: string; tags: string[] }[] = [];
      const flush = async () => { if (!batch.length) return; const b = batch; batch = []; await api("files/insight/vision", { body: { items: b } }).catch(() => null); };
      for (const k of todo) {
        if (dead) break;
        while (document.visibilityState !== "visible" && !dead) await new Promise((res) => setTimeout(res, 2000));
        const url = coversRef.current.get(k);
        if (!url) continue;
        try {
          const { vec } = await ask<{ vec: Float32Array }>({ type: "image", model: r.model, url });
          const tags = tagsFor(vec, vv);
          batch.push({ id: k, emb: pack(vec), tags });
          emb.current?.set(k, vec);
          setLooks((x) => ({ ...x, [k]: { ...(x[k] ?? { h: null, ar: null, c: [], hex: null }), t: tags, e: 1 } }));
        } catch { /* a photo that won't load: skip it */ }
        setLeft((n) => Math.max(0, n - 1));
        if (batch.length >= 8) await flush();
        await new Promise((res) => ("requestIdleCallback" in window ? requestIdleCallback(() => res(null), { timeout: 600 }) : setTimeout(res, 150)));
      }
      await flush();
    })();
    return () => { dead = true; };
  }, [on, load]);

  /** Photos ranked by how well they fit the words: id → closeness (0-1, only the good ones). */
  const search = useCallback(async (q: string): Promise<Map<string, number>> => {
    if (!capable() || !info.current) return new Map();
    if (!emb.current) {
      const r = await api<{ files: Record<string, string> }>("files/insight/emb").catch(() => null);
      emb.current = new Map(Object.entries(r?.files ?? {}).map(([k, v]) => [k, unpack(v)]));
    }
    if (!emb.current.size) return new Map();
    const { vecs } = await ask<{ vecs: Float32Array[] }>({ type: "text", model: info.current.model, texts: [`a photo of ${q}`] });
    const t = vecs[0];
    const all = [...emb.current].map(([k, v]) => [k, dot(v, t)] as const).sort((a, b) => b[1] - a[1]);
    const best = all[0]?.[1] ?? 0;
    // close to the best match and clearly above the crowd: a few strong hits, not the whole library
    const mean = all.reduce((s, x) => s + x[1], 0) / all.length;
    if (best < 0.09) return new Map(); // nothing really fits
    const floor = Math.max(0.09, mean + 0.035, best - 0.045);
    return new Map(all.filter(([, s]) => s >= floor).slice(0, 60));
  }, []);

  return { looks, left, search, colors: info.current?.colors ?? [] };
}
