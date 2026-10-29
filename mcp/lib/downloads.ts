// Download (Create → Download, the `download` MCP tool): paste a link from Instagram, YouTube, TikTok, X, Pinterest,
// Cosmos or any page, and the photo or video lands in Files, in a folder, named so the post package can credit the
// creator ("@handle on X - …"). Two routes, the fastest that works:
//   server: X (its public syndication feed), Pinterest (the pin's page: the video, else the original-size image),
//           a direct file link, or any page's own preview (og:video / og:image: Cosmos, Unsplash, news sites…);
//   worker: Instagram, YouTube, TikTok, Facebook, Threads, Reddit, Vimeo and anything the server can't read go to the
//           Colab worker's yt-dlp (kind "fetch", worker/gateway.py), which uploads each file straight to R2 through a
//           presigned PUT; the next look at the list (or the worker's next heartbeat) copies them into Files. With the
//           worker off, the first such link starts a Colab CPU runtime by itself (yt-dlp needs no GPU; the cheap voice
//           GPU if Colab won't give one), which is stopped again as soon as its downloads are in (lib/colab.ts
//           onHeartbeat). The worker calls back when each one is done (/api/downloads/done), so it's saved at once.
// Each site gets its own folder inside the one picked (default "Downloads"): Downloads/Instagram, Downloads/YouTube…
// Every link the server fetches is checked first (http(s) only, no private or internal addresses, on every redirect).
// The list lives in workspace/downloads.json (written with If-Match so two people never lose each other's).
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { getJson, getJsonTagged, getObj, headObj, presign, putJson, putJsonIf, putObj } from "./store";

export type Source = "instagram" | "youtube" | "tiktok" | "x" | "pinterest" | "cosmos" | "facebook" | "threads" | "reddit" | "vimeo" | "web";
export type DlItem = { media: string; name: string; kind: string; size: number; preview: string | null };
export type Dl = {
  id: string; url: string; source: Source; status: "fetching" | "waiting" | "worker" | "saving" | "done" | "error";
  via: "server" | "worker" | null; title: string | null; author: string | null; thumb: string | null;
  folder: string | null; post: string | null; name: string | null; by: string; at: number; updated: number;
  items: DlItem[]; error: string | null; job: string | null; pct: number | null; stage: string | null; saving_at?: number;
  requeued?: number; // times the worker went away mid-download and it was handed to the next one
};
type Actor = { id?: string; name: string };

const KEY = "workspace/downloads.json";
const COOKIES = "workspace/downloads/cookies.txt"; // optional sign-ins for yt-dlp (Netscape format), never sent back
const MAX = 200;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const SERVER_MAX = 140e6; // bigger files go through the worker (the server holds a file in memory to copy it)
const SLOTS = 20;
const GPU_CLAIM = "workspace/downloads-gpu.json"; // who started the GPU for downloads and when: one start, not one per link

// name: in labels ("@handle on Instagram"); its folder is the same name, except "the web", which goes to "Web"
export const SOURCES: Record<Source, { name: string; via: "server" | "worker" }> = {
  instagram: { name: "Instagram", via: "worker" }, youtube: { name: "YouTube", via: "worker" }, tiktok: { name: "TikTok", via: "worker" },
  x: { name: "X", via: "server" }, pinterest: { name: "Pinterest", via: "server" }, cosmos: { name: "Cosmos", via: "server" },
  facebook: { name: "Facebook", via: "worker" }, threads: { name: "Threads", via: "worker" }, reddit: { name: "Reddit", via: "worker" },
  vimeo: { name: "Vimeo", via: "worker" }, web: { name: "the web", via: "server" },
};

export function sourceOf(url: string): Source {
  const h = new URL(url).hostname.replace(/^(www|m|mobile)\./, "").toLowerCase();
  if (/(^|\.)instagram\.com$|^instagr\.am$/.test(h)) return "instagram";
  if (/(^|\.)youtube\.com$|^youtu\.be$|^youtube-nocookie\.com$/.test(h)) return "youtube";
  if (/(^|\.)tiktok\.com$/.test(h)) return "tiktok";
  if (/^(x|twitter|fxtwitter|vxtwitter|fixupx)\.com$/.test(h)) return "x";
  if (/(^|\.)pinterest\.[a-z.]+$|^pin\.it$/.test(h)) return "pinterest";
  if (/(^|\.)cosmos\.so$/.test(h)) return "cosmos";
  if (/(^|\.)facebook\.com$|^fb\.watch$/.test(h)) return "facebook";
  if (/(^|\.)threads\.(net|com)$/.test(h)) return "threads";
  if (/(^|\.)reddit\.com$|^redd\.it$/.test(h)) return "reddit";
  if (/(^|\.)vimeo\.com$/.test(h)) return "vimeo";
  return "web";
}

/* ───────────── fetching only what's safe to fetch */

export class DlError extends Error { constructor(m: string, public status = 400) { super(m); } }

function privateIp(ip: string) {
  const v4 = ip.replace(/^::ffff:/i, "");
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
  }
  const s = ip.toLowerCase();
  return s === "::" || s === "::1" || /^f[cd]/.test(s) || /^fe[89ab]/.test(s);
}

/** An http(s) link to a public address (checked on every hop). */
export async function checkUrl(raw: string) {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new DlError("that isn't a link"); }
  if (!/^https?:$/.test(u.protocol)) throw new DlError("only http(s) links can be downloaded");
  if (u.username || u.password) throw new DlError("links with a user name or password can't be downloaded");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i.test(host)) throw new DlError("that address isn't public");
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => { throw new DlError(`couldn't find ${host}`); })).map((a) => a.address);
  if (!addrs.length || addrs.some(privateIp)) throw new DlError("that address isn't public");
  return u;
}

async function safeFetch(raw: string, init: { headers?: Record<string, string>; ms?: number; method?: string } = {}) {
  let url = raw;
  for (let hop = 0; hop < 6; hop++) {
    await checkUrl(url);
    const r = await fetch(url, { method: init.method ?? "GET", redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(init.ms ?? 20_000),
      headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", ...init.headers } });
    const to = r.status >= 300 && r.status < 400 ? r.headers.get("location") : null;
    if (!to) return Object.assign(r, { finalUrl: url });
    url = new URL(to, url).toString();
  }
  throw new DlError("too many redirects");
}

/* ───────────── the server's routes */

type Found = { title: string | null; author: string | null; thumb: string | null; files: { url: string; name: string }[] };

const meta = (html: string, ...names: string[]) => {
  for (const n of names) {
    const m = new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*>`, "i").exec(html)?.[0];
    const c = m && /content=["']([^"']+)/i.exec(m)?.[1];
    if (c) return c.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }
  return null;
};
const unent = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const words = (s: string | null | undefined, n = 60) => (s ?? "").replace(/https?:\/\/\S+/g, "").replace(/[\\/:*?"<>|#\n\r\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n).trim();
const extOf = (url: string, fallback: string) => /\.(mp4|mov|webm|m4a|mp3|jpe?g|png|webp|gif)(?:$|\?)/i.exec(new URL(url).pathname)?.[1].toLowerCase().replace("jpeg", "jpg") ?? fallback;

/** X: the public syndication feed the embeds use (no key): photos at full size, the best mp4 of a video or GIF. */
async function fromX(url: string): Promise<Found | null> {
  const id = /\/status(?:es)?\/(\d{5,25})/.exec(url)?.[1];
  if (!id) return null;
  const token = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
  const r = await safeFetch(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${token}&lang=en`);
  if (!r.ok) return null;
  const d = await r.json() as { text?: string; user?: { screen_name?: string }; mediaDetails?: { type: string; media_url_https: string; video_info?: { variants: { content_type: string; url: string; bitrate?: number }[] } }[] };
  const who = d.user?.screen_name ?? null;
  const base = `${who ? `@${who} on X` : "X"} - ${words(d.text, 50) || id}`;
  const media = d.mediaDetails ?? [];
  const files = media.map((m, i) => {
    const n = media.length > 1 ? ` (${i + 1})` : "";
    if (m.type === "photo") return { url: `${m.media_url_https}?name=orig`, name: `${base}${n}.${extOf(m.media_url_https, "jpg")}` };
    const best = (m.video_info?.variants ?? []).filter((v) => v.content_type === "video/mp4").sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];
    return best ? { url: best.url, name: `${base}${n}.mp4` } : null;
  }).filter((x): x is { url: string; name: string } => !!x);
  return files.length ? { title: words(d.text, 120) || null, author: who, thumb: media[0]?.media_url_https ?? null, files } : null;
}

/** Pinterest: the pin's own page has its video (the biggest mp4) or its image (asked for at original size). */
async function fromPinterest(url: string): Promise<Found | null> {
  const r = await safeFetch(url);
  if (!r.ok) return null;
  const html = await r.text();
  const pin = /\/pin\/(\d{6,})/.exec(r.finalUrl)?.[1] ?? /\/pin\/(\d{6,})/.exec(html)?.[1] ?? null;
  const title = words(unent(meta(html, "og:title") ?? /<title>([^<]*)/.exec(html)?.[1] ?? "").replace(/\s*\|.*$/, ""), 60) || null;
  const base = `Pinterest pin id ${pin ?? "unknown"}${title ? ` - ${title}` : ""}`;
  const vids = [...new Set(html.match(/https:\/\/v1\.pinimg\.com\/videos\/[^"'\\\s]+?\.mp4/g) ?? [])];
  const rank = (u: string) => Number(/(\d{3,4})p/.exec(u)?.[1] ?? (/expMp4/.test(u) ? 720 : 0));
  const video = vids.sort((a, b) => rank(b) - rank(a))[0];
  const img = meta(html, "og:image");
  if (video) return { title, author: null, thumb: img, files: [{ url: video, name: `${base}.mp4` }] };
  if (!img) return null;
  const orig = img.replace(/\/\d+x(\d+)?(_RS)?\//, "/originals/");
  const ok = orig !== img && (await safeFetch(orig, { method: "HEAD", ms: 8000 }).then((x) => x.ok).catch(() => false));
  const pick = ok ? orig : img;
  return { title, author: null, thumb: img, files: [{ url: pick, name: `${base}.${extOf(pick, "jpg")}` }] };
}

/** Any page: a direct file, or the page's own preview (og:video before og:image), with a Google Images link unwrapped. */
async function fromWeb(url: string, source: Source): Promise<Found | null> {
  const u = new URL(url);
  const inner = u.hostname.includes("google.") ? u.searchParams.get("imgurl") ?? u.searchParams.get("url") : null;
  if (inner && /^https?:\/\//.test(inner)) return fromWeb(inner, sourceOf(inner));
  const r = await safeFetch(url, { headers: { Accept: "text/html,image/*,video/*,*/*;q=0.8" } });
  if (!r.ok) throw new DlError(`the site answered ${r.status}`);
  const type = (r.headers.get("content-type") ?? "").split(";")[0].toLowerCase();
  const host = new URL(r.finalUrl).hostname.replace(/^www\./, "");
  if (/^(image|video|audio)\//.test(type)) {
    r.body?.cancel().catch(() => null);
    const file = decodeURIComponent(new URL(r.finalUrl).pathname.split("/").pop() || "file");
    const name = /\.[a-z0-9]{2,4}$/i.test(file) ? file : `${file}.${type.split("/")[1].replace("jpeg", "jpg").replace("quicktime", "mov")}`;
    return { title: null, author: null, thumb: type.startsWith("image/") ? r.finalUrl : null, files: [{ url: r.finalUrl, name: `${host} - ${name}`.slice(0, 200) }] };
  }
  if (!type.includes("html")) return null;
  const html = (await r.text()).slice(0, 2_000_000);
  const title = words(unent(meta(html, "og:title", "twitter:title") ?? /<title>([^<]*)/.exec(html)?.[1] ?? ""), 60) || null;
  const author = meta(html, "author", "twitter:creator", "article:author");
  const video = meta(html, "og:video:secure_url", "og:video:url", "og:video", "twitter:player:stream");
  const image = meta(html, "og:image:secure_url", "og:image", "twitter:image", "twitter:image:src");
  const label = `${source === "web" ? host : SOURCES[source].name}${author && !/^https?:/.test(author) ? ` @${words(author, 30).replace(/^@/, "")}` : ""}${title ? ` - ${title}` : ""}`;
  const abs = (x: string) => new URL(x, r.finalUrl).toString();
  if (video && /\.(mp4|mov|webm)(\?|$)/i.test(video)) return { title, author, thumb: image ? abs(image) : null, files: [{ url: abs(video), name: `${label}.${extOf(abs(video), "mp4")}` }] };
  // a video anywhere on the page (a <video>/<source>, a bare .mp4 in its scripts): that, not the preview image. A
  // stream (.m3u8), an embedded player or an og:video that isn't a file goes to the worker, whose yt-dlp joins it up
  const flat = html.replace(/\\u002F/gi, "/").replace(/\\\//g, "/").replace(/&amp;/g, "&");
  const tag = /<(?:video|source)[^>]+src=["']([^"']+\.(?:mp4|webm|mov)(?:\?[^"']*)?)["']/i.exec(flat)?.[1]
    ?? /https?:\/\/[^\s"'<>\\]+?\.mp4(?:\?[^\s"'<>\\]*)?/i.exec(flat)?.[0];
  if (tag && !/preview|thumb|poster/i.test(tag)) return { title, author, thumb: image ? abs(image) : null, files: [{ url: abs(tag), name: `${label}.${extOf(abs(tag), "mp4")}` }] };
  if (source === "web" && (video || /\.m3u8|<video[\s>]|player\.vimeo|youtube\.com\/embed|jwplayer|videojs/i.test(flat))) return null;
  if (image) return { title, author, thumb: abs(image), files: [{ url: abs(image), name: `${label}.${extOf(abs(image), "jpg")}` }] };
  return null;
}

/** What the server can download itself from a link: the files and who made them, or null (the worker's turn). */
export const resolve = (url: string, source = sourceOf(url)) => source === "x" ? fromX(url) : source === "pinterest" ? fromPinterest(url) : fromWeb(url, source);

/* ───────────── the list */

async function change<T>(fn: (list: Dl[]) => T): Promise<T> {
  for (let i = 0; i < 6; i++) {
    const { value, etag } = await getJsonTagged<{ list: Dl[] }>(KEY);
    const list = value?.list ?? [];
    const out = fn(list);
    if (await putJsonIf(KEY, { list: list.slice(0, MAX) }, etag)) return out;
  }
  throw new DlError("the download list is busy: try again", 409);
}
const patch = (id: string, p: Partial<Dl>) => change((list) => { const d = list.find((x) => x.id === id); if (d) Object.assign(d, p, { updated: Date.now() }); return d ? { ...d } : null; });
export async function listDownloads() { return (await getJson<{ list: Dl[] }>(KEY))?.list ?? []; }

const folderName = (source: Source) => (source === "web" ? "Web" : SOURCES[source].name);

/** Where downloads go: the folder given (an id or a name path, made if it's a new name), else "Downloads", and in it
 *  the site's own folder (Downloads/Instagram, Downloads/YouTube…), made the first time. */
async function folderFor(ref: string | null | undefined, source: Source, by: string) {
  const fs = await import("./files");
  const t = await fs.getTree();
  const name = (ref?.trim() || "Downloads").replace(/^\/+|\/+$/g, "");
  let parent: string | null = null;
  let base: string[] = name.split("/").map((s) => s.trim()).filter(Boolean);
  try { const f = fs.findFolder(t, name); if (f) { parent = f.id; base = []; } } catch { /* not there yet: made below */ }
  for (const part of [...base, folderName(source)]) {
    const t2 = await fs.getTree();
    const have = t2.folders.find((f) => f.parent === parent && f.name.toLowerCase() === part.toLowerCase() && !t2.trash[`f:${f.id}`]);
    parent = have ? have.id : (await fs.createFolder({ name: part, parent }, by)).id;
  }
  return parent;
}

async function cookies() {
  const r = await getObj(COOKIES);
  return r ? (await r.text()).slice(0, 200_000) : "";
}
export async function cookieState() { return { set: !!(await headObj(COOKIES)) }; }
export async function setCookies(text: string | null) {
  if (!text?.trim()) { await putObj(COOKIES, "", "text/plain"); return { set: false }; }
  if (!/^#?\s*(Netscape )?HTTP Cookie File|\t(TRUE|FALSE)\t/m.test(text)) throw new DlError("paste a cookies.txt export (Netscape format)");
  await putObj(COOKIES, text.slice(0, 200_000), "text/plain");
  return { set: true };
}

/** Start downloads for one or more links. Each returns at once; the copying runs after the response (`later`). */
export async function startDownloads(urls: string[], o: { folder?: string | null; name?: string | null; post?: string | null }, actor: Actor, later: (f: () => Promise<unknown>) => void) {
  const clean = [...new Set(urls.map((u) => u.trim()).filter(Boolean))].slice(0, 20);
  if (!clean.length) throw new DlError("give a link to download");
  for (const u of clean) await checkUrl(u);
  const folders = new Map<Source, string | null>();
  for (const src of new Set(clean.map(sourceOf))) folders.set(src, await folderFor(o.folder, src, actor.name)); // one at a time: no twin folders
  const now = Date.now();
  const made: Dl[] = clean.map((url, i) => ({
    id: `${now.toString(36)}${i}${Math.random().toString(36).slice(2, 6)}`, url, source: sourceOf(url), status: "fetching", via: null, title: null, author: null, thumb: null,
    folder: folders.get(sourceOf(url)) ?? null, post: o.post ?? null, name: clean.length === 1 ? o.name?.trim().slice(0, 150) || null : null, by: actor.name, at: now, updated: now, items: [], error: null, job: null, pct: 0, stage: "Reading the link",
  }));
  await change((list) => { list.unshift(...made); });
  for (const d of made) later(() => run(d, actor));
  return made;
}

export async function retryDownload(id: string, actor: Actor, later: (f: () => Promise<unknown>) => void) {
  const d = await patch(id, { status: "fetching", error: null, job: null, pct: 0, stage: "Reading the link", via: null, saving_at: undefined });
  if (!d) throw new DlError("no such download", 404);
  later(() => run(d, actor));
  return d;
}
export const forgetDownload = (id: string) => change((list) => { const i = list.findIndex((x) => x.id === id); if (i >= 0) list.splice(i, 1); return i >= 0; });

/** The server route, else the worker's. Never throws: a failure is written on the row. */
async function run(d: Dl, actor: Actor) {
  try {
    const route = SOURCES[d.source].via;
    let found: Found | null = null;
    if (route === "server") found = await resolve(d.url, d.source).catch(() => null); // a site that refuses servers: the worker tries
    if (found?.files.length) {
      await patch(d.id, { via: "server", title: found.title, author: found.author, thumb: found.thumb, stage: "Downloading", pct: 0.2 });
      const items = await saveFromServer(d, found, actor);
      if (items) { await finish(d.id, items, actor); return; }
    }
    await toWorker(d, found);
  } catch (e) {
    await patch(d.id, { status: "error", error: plain((e as Error).message), stage: null });
  }
}

async function saveFromServer(d: Dl, found: Found, actor: Actor): Promise<DlItem[] | null> {
  const { addMediaBytes, mimeFor } = await import("./appwrite");
  const { getSettings } = await import("./settings");
  const backup = (await getSettings()).backup_media;
  const items: DlItem[] = [];
  for (const [i, f] of found.files.entries()) {
    const r = await safeFetch(f.url, { ms: 120_000, headers: { Referer: d.url } });
    if (!r.ok) throw new DlError(`the file answered ${r.status}`);
    const size = Number(r.headers.get("content-length") ?? 0);
    if (size > SERVER_MAX) { r.body?.cancel().catch(() => null); return null; } // big: the worker streams it instead
    const bytes = new Uint8Array(await r.arrayBuffer());
    const mime = (r.headers.get("content-type") ?? "").split(";")[0] || mimeFor(f.name);
    const name = nameFor(d, f.name, i, found.files.length);
    const { media } = await addMediaBytes(bytes, mime.startsWith("binary") || mime === "application/octet-stream" ? mimeFor(name) : mime, name, { postId: d.post, backup }, actor);
    items.push(await itemOf(media));
    await patch(d.id, { pct: 0.2 + 0.75 * ((i + 1) / found.files.length), stage: found.files.length > 1 ? `Saved ${i + 1} of ${found.files.length}` : "Saving to Files" });
  }
  return items;
}

const nameFor = (d: Dl, name: string, i: number, n: number) => {
  if (!d.name) return name.slice(0, 200);
  const ext = /\.[a-z0-9]{2,4}$/i.exec(name)?.[0] ?? "";
  return `${d.name}${n > 1 ? ` (${i + 1})` : ""}${ext}`.slice(0, 200);
};

async function itemOf(media: { $id: string; name: string; kind: string; size?: number | null; token?: string | null }): Promise<DlItem> {
  const { fileUrl } = await import("./workspace");
  return { media: media.$id, name: media.name, kind: media.kind, size: media.size ?? 0, preview: media.kind === "image" && media.token ? fileUrl(media as never, "preview", 320) : null };
}

async function finish(id: string, items: DlItem[], actor: Actor) {
  const d = (await listDownloads()).find((x) => x.id === id);
  if (d?.folder) await (await import("./files")).moveItems(items.map((x) => `m:${x.media}`), d.folder).catch(() => null);
  await patch(id, { status: "done", items, pct: 1, stage: null, error: null, saving_at: undefined });
  void actor;
}

/** Hand the link to the worker's yt-dlp; with the worker off it starts the GPU and waits, and goes as soon as the
 *  worker is on (its first heartbeat hands the waiting ones over). */
async function toWorker(d: Dl, found: Found | null) {
  const { call, WorkerOffline } = await import("./worker");
  const slots = await Promise.all(Array.from({ length: SLOTS }, (_, i) => presign(`workspace/downloads/${d.id}/${i}`, "PUT", 6 * 3600)));
  const info = await presign(`workspace/downloads/${d.id}/info.json`, "PUT", 6 * 3600);
  try {
    const job = await call<{ id: string }>("/jobs", { body: { kind: "fetch", url: d.url, put_urls: slots, info_put: info, cookies: await cookies(), label: `Download from ${SOURCES[d.source].name}`, notify: true } });
    await patch(d.id, { status: "worker", via: "worker", job: job.id, stage: "Queued on the worker", pct: 0.05, ...(found ? { title: found.title, author: found.author, thumb: found.thumb } : {}) });
  } catch (e) {
    if (!(e instanceof WorkerOffline)) throw e;
    await patch(d.id, { status: "waiting", via: "worker", pct: 0, stage: `Starting the downloader for ${SOURCES[d.source].name} (about a minute)` });
    const why = await startGpu();
    if (why) await patch(d.id, { stage: `${SOURCES[d.source].name} needs the Colab worker, and it couldn't start: ${why}` });
  }
}

/** The worker is off: start a CPU runtime for the downloads (the cheap GPU if Colab won't give one), once (a claim kept 5 min, so a dozen links start one GPU;
 *  colab.start refuses too while a runtime is assigned). null when it started or one is on its way, else why not. */
async function startGpu(): Promise<string | null> {
  const { value, etag } = await getJsonTagged<{ at: number; error?: string | null }>(GPU_CLAIM);
  if (value && Date.now() - value.at < 5 * 60_000) return value.error ?? null; // a failed start is tried again after 5 min, not on every look
  if (!(await putJsonIf(GPU_CLAIM, { at: Date.now() }, etag))) return null; // someone else is starting it
  const colab = await import("./colab");
  try {
    if ((await colab.runtimes()).length) return null; // assigned already: its worker is booting
    await colab.start(colab.appOrigin(), undefined, { purpose: "voice", high_ram: false, for_downloads: true, cpu: true });
    return null;
  } catch (e) {
    const m = (e as Error).message;
    const error = /not connected|token|sign.?in|oauth/i.test(m) ? "connect Colab in Settings → GPU & engines, or run the notebook" : m.slice(0, 160);
    await putJson(GPU_CLAIM, { at: Date.now(), error }).catch(() => null);
    return error;
  }
}

/** Something still under way (the GPU started for downloads stays on until there isn't). */
export const anyLive = async () => (await listDownloads()).some((d) => ["fetching", "worker", "waiting", "saving"].includes(d.status) && Date.now() - d.updated < 30 * 60_000);

/** Bring running downloads up to date (the page and the MCP tool call this when they look, and every worker heartbeat). */
export async function refresh(later: (f: () => Promise<unknown>) => void, actor: Actor) {
  const list = await listDownloads();
  const live = list.filter((d) => d.status === "worker" || d.status === "waiting" || (d.status === "saving" && Date.now() - (d.saving_at ?? 0) > 120_000));
  if (!live.length) return list;
  const { call, WorkerOffline } = await import("./worker");
  for (const d of live) {
    if (d.status === "waiting") { if (Date.now() - d.updated < 20_000) continue; later(() => toWorker(d, null).catch((e) => patch(d.id, { status: "error", error: plain((e as Error).message) }))); continue; }
    if (d.status === "saving") { later(() => saveFromWorker(d, actor)); continue; }
    try {
      const j = await call<{ status: string; error?: string | null; stage?: string; dl?: { pct: number; files: number } }>(`/jobs/${d.job}`, { timeoutMs: 8000 });
      if (j.status === "done") {
        const claimed = await change((l) => { const x = l.find((y) => y.id === d.id); if (!x || x.status !== "worker") return false; x.status = "saving"; x.saving_at = Date.now(); x.stage = "Saving to Files"; x.pct = 0.97; return true; });
        if (claimed) later(() => saveFromWorker(d, actor));
      } else if (j.status === "error" || j.status === "cancelled") {
        await patch(d.id, { status: "error", error: plain(j.error ?? j.status), stage: null });
      } else {
        const stage = j.status === "queued" ? "Queued on the worker" : j.stage === "preparing" ? "Getting the downloader ready" : j.stage === "uploading" ? "Sending it to Files" : j.stage === "downloading photos" ? "Downloading the photos" : "Downloading";
        const pct = Math.max(0.05, j.dl?.pct ?? 0);
        if (stage !== d.stage || Math.abs(pct - (d.pct ?? 0)) >= 0.03) await patch(d.id, { stage, pct }); // no write for nothing new
      }
    } catch (e) {
      if (e instanceof WorkerOffline || /not found|404/i.test((e as Error).message)) {
        // the worker went away (a restart, the CPU runtime making way for a GPU): the next worker takes it, twice at most
        if ((d.requeued ?? 0) < 2) await patch(d.id, { status: "waiting", job: null, pct: 0, requeued: (d.requeued ?? 0) + 1, stage: "The worker restarted: starting it again" });
        else await patch(d.id, { status: "error", error: "The worker kept restarting before it finished: Retry", stage: null });
      }
    }
  }
  return listDownloads();
}

async function saveFromWorker(d: Dl, actor: Actor) {
  try {
    const info = await getJson<{ title?: string; uploader?: string; handle?: string; thumbnail?: string; items: { slot: number; name: string; mime: string; size: number }[] }>(`workspace/downloads/${d.id}/info.json`);
    if (!info?.items?.length) throw new DlError("the worker sent nothing back");
    const { addMediaFromR2 } = await import("./appwrite");
    const who = (info.handle || info.uploader || "").replace(/^@/, "");
    const base = `${who ? `@${words(who, 30).replace(/\s+/g, "")} on ` : ""}${SOURCES[d.source].name}${info.title ? ` - ${words(info.title, 60)}` : ""}`;
    const items: DlItem[] = [];
    for (const it of info.items) {
      const ext = /\.[a-z0-9]{2,4}$/i.exec(it.name)?.[0] ?? "";
      const name = nameFor(d, `${base}${info.items.length > 1 ? ` (${it.slot + 1})` : ""}${ext}`, it.slot, info.items.length);
      const key = `workspace/downloads/${d.id}/${it.slot}`;
      const size = (await headObj(key))?.size ?? it.size;
      // a fixed file id per slot: a second save of the same download is refused by storage instead of copied twice
      const media = await addMediaFromR2(key, size, it.mime, name, `dl${d.id}x${it.slot}`.slice(0, 36), { postId: d.post }, actor).then((x) => x.media).catch((e: { status?: number }) => { if (e.status === 409) return null; throw e; });
      if (media) items.push(await itemOf(media));
    }
    await patch(d.id, { title: info.title ?? d.title, author: who || d.author, thumb: info.thumbnail ?? d.thumb });
    await finish(d.id, items, actor);
  } catch (e) {
    await patch(d.id, { status: "error", error: plain((e as Error).message), stage: null });
  }
}

/** What went wrong, in words a person can act on. */
function plain(m: string) {
  if (/confirm you.?re not a bot|sign in to confirm/i.test(m)) return "YouTube asked the worker to sign in. Add your sign-in cookies (Download → Sign-ins), then Retry.";
  if (/login required|rate-limit reached|requested content is not available|empty media response|log in/i.test(m)) return "Instagram wants a sign-in for this one. Add your sign-in cookies (Download → Sign-ins), then Retry.";
  if (/private/i.test(m)) return "That post is private.";
  if (/unsupported url/i.test(m)) return "Nothing to download at that link: it needs a photo or a video on the page.";
  if (/HTTP Error 404|not found|404/i.test(m)) return "That link is gone (404).";
  return m.replace(/^ERROR:\s*/, "").slice(0, 240);
}
