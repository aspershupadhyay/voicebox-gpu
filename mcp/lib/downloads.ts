// Download (Create → Download, the `download` MCP tool): paste a link from Instagram, YouTube, TikTok, X, Pinterest,
// Cosmos or any page, and the photo or video lands in Files, in a folder, named so the post package can credit the
// creator ("@handle on X - …"). Two routes, the fastest that works:
//   server: X (its public syndication feed), Pinterest (the pin's page: the video, else the original-size image),
//           a direct file link, or any page's own preview (og:video / og:image: Cosmos, Unsplash, news sites…);
//   worker: Instagram, YouTube, TikTok, Facebook, Threads, Reddit, Vimeo and anything the server can't read go to the
//           Colab worker's yt-dlp (kind "fetch", worker/gateway.py), which uploads each file straight to R2 through a
//           presigned PUT; the next look at the list (or the worker's next heartbeat) copies them into Files. With the
//           worker off, the first such link starts the voice GPU (an L4) by itself, which is stopped again as soon as
//           its downloads are in (lib/colab.ts onHeartbeat). The worker runs several downloads side by side. The worker calls back when each one is done (/api/downloads/done), so it's saved at once.
// Each site gets its own folder inside the one picked (default "Downloads"): Downloads/Instagram, Downloads/YouTube…
// Every link the server fetches is checked first (http(s) only, no private or internal addresses, on every redirect).
// Like a browser on a computer at home (the owner, 2026-11-13: "download anything, treated like a local system"): every
// request carries the headers Chrome sends (sec-ch-ua, Sec-Fetch-*, the page as Referer), keeps the cookies a site sets
// across its redirects, and sends the saved sign-ins to the sites they belong to, never to any other. Any file comes
// down as it is (a PDF, a zip, an .ogg, a font…), not only photos and videos; a page that only shows a file (Wikimedia
// Commons' File: pages, a link marked download) gives that file, never its preview picture.
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
  server_error?: string | null; // why the server couldn't get it itself (the worker tried next), kept for the final error
  retry_at?: number | null; // a block that passes (too many requests, a 5xx, a timeout): the whole chain runs again then
  auto_retries?: number; // how many times it has done that by itself (RETRY_AFTER_MIN.length at most)
  carousel?: string | null; // a post with several files lands as one carousel in Files (its id), in the post's order
  unreachable?: number; // looks at it while the worker was on but couldn't be reached (a tunnel seconds old)
  note?: string | null; // done, with something to know (a photo the site only gave at preview size)
};
type Actor = { id?: string; name: string };

const KEY = "workspace/downloads.json";
const COOKIES = "workspace/downloads/cookies.txt"; // optional sign-ins for yt-dlp (Netscape format), never sent back
const MAX = 200;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
/** What Chrome 131 on Windows sends: a page it opens ("page") or a file a page asks for ("file", with the page as
 *  Referer). A site that checks for a real browser sees one. */
function browserHeaders(as: "page" | "file", url: string, referer?: string | null): Record<string, string> {
  const same = !!referer && (() => { try { return new URL(referer).hostname === new URL(url).hostname; } catch { return false; } })();
  const h: Record<string, string> = {
    "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9",
    "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"', "sec-ch-ua-mobile": "?0", "sec-ch-ua-platform": '"Windows"',
  };
  if (as === "page") Object.assign(h, { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Upgrade-Insecure-Requests": "1", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": referer ? (same ? "same-origin" : "cross-site") : "none", "Sec-Fetch-User": "?1" });
  else Object.assign(h, { Accept: "*/*", "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Site": referer ? (same ? "same-origin" : "cross-site") : "none" });
  if (referer) h.Referer = referer;
  return h;
}
const SERVER_MAX = 140e6; // bigger files go through the worker
const BUFFER_MAX = 40e6; // a file with no stated size is read whole: only this much (a Worker has 128 MB)

/** The whole body, or null (cancelled) past `max` bytes. */
async function readCapped(r: Response, max: number) {
  if (!r.body) return new Uint8Array(await r.arrayBuffer());
  const reader = r.body.getReader(), parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) { await reader.cancel().catch(() => null); return null; }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
const SLOTS = 20;
const RETRY_AFTER_MIN = [10, 25]; // waits before the 1st and 2nd automatic try: long enough for a site's rate limit to lift
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

/** The cookies a browser would send to this address: the ones sites set during this download (`jar`) and the saved
 *  sign-ins whose domain matches (a cookies.txt line for .example.com goes to example.com and its subdomains only). */
function cookieHeader(url: string, jar: Map<string, string>, saved: Cookie[]) {
  const u = new URL(url), host = u.hostname.toLowerCase(), now = Date.now() / 1000;
  const out = new Map<string, string>();
  for (const c of saved) {
    const f = c.line.split("\t");
    const dom = f[0].replace(/^#HttpOnly_/i, "").toLowerCase(), sub = f[1] === "TRUE" || dom.startsWith(".");
    const d = dom.replace(/^\./, "");
    if (!(host === d || (sub && host.endsWith(`.${d}`)))) continue;
    if (f[3] === "TRUE" && u.protocol !== "https:") continue;
    if (c.expires && c.expires < now) continue;
    if (!u.pathname.startsWith(f[2] || "/")) continue;
    out.set(c.name, f[6] ?? "");
  }
  for (const [k, v] of jar) { const [h, name] = k.split("\n"); if (host === h || host.endsWith(`.${h}`)) out.set(name, v); }
  return [...out].map(([k, v]) => `${k}=${v}`).join("; ");
}
function keepCookies(r: Response, url: string, jar: Map<string, string>) {
  const set = (r.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  const host = new URL(url).hostname.toLowerCase();
  for (const line of set) {
    const [pair, ...attrs] = line.split(";");
    const i = pair.indexOf("=");
    if (i < 1) continue;
    const dom = attrs.map((a) => /^\s*domain=\.?([^;]+)/i.exec(a)?.[1]?.toLowerCase()).find(Boolean);
    const at = dom && (host === dom || host.endsWith(`.${dom}`)) ? dom : host; // a site can't set cookies for another
    jar.set(`${at}\n${pair.slice(0, i).trim()}`, pair.slice(i + 1).trim());
  }
}
let savedCookies: { at: number; list: Cookie[] } | null = null;
async function signIns() {
  if (!savedCookies || Date.now() - savedCookies.at > 60_000) savedCookies = { at: Date.now(), list: parseCookies(await cookies().catch(() => "")) };
  return savedCookies.list;
}

async function safeFetch(raw: string, init: { headers?: Record<string, string>; ms?: number; method?: string; as?: "page" | "file"; referer?: string | null; jar?: Map<string, string> } = {}) {
  let url = raw, referer = init.referer ?? null;
  const jar = init.jar ?? new Map<string, string>(), saved = await signIns();
  for (let hop = 0; hop < 8; hop++) {
    await checkUrl(url);
    const cookie = cookieHeader(url, jar, saved);
    const r = await fetch(url, { method: init.method ?? "GET", redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(init.ms ?? 20_000),
      headers: { ...browserHeaders(init.as ?? "page", url, referer), ...(cookie ? { Cookie: cookie } : {}), ...init.headers } });
    keepCookies(r, url, jar);
    const to = r.status >= 300 && r.status < 400 ? r.headers.get("location") : null;
    if (!to) return Object.assign(r, { finalUrl: url, jar });
    r.body?.cancel().catch(() => null);
    url = new URL(to, url).toString();
  }
  throw new DlError("too many redirects");
}

/** The file name a download says it is (Content-Disposition), else the last part of its address. */
function fileNameOf(r: Response & { finalUrl: string }, type: string) {
  const cd = r.headers.get("content-disposition") ?? "";
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/i.exec(cd)?.[1];
  const plainName = /filename\s*=\s*"?([^";]+)"?/i.exec(cd)?.[1];
  let file = "";
  try { file = star ? decodeURIComponent(star) : plainName ?? decodeURIComponent(new URL(r.finalUrl).pathname.split("/").pop() || ""); } catch { file = plainName ?? ""; }
  file = file.replace(/[\\/:*?"<>|\n\r\t]+/g, " ").trim() || "file";
  if (/\.[a-z0-9]{1,5}$/i.test(file)) return file;
  const ext = EXT_OF[type] ?? type.split("/")[1]?.replace(/^x-/, "").replace("jpeg", "jpg").replace("quicktime", "mov").replace(/[^a-z0-9]/g, "").slice(0, 5);
  return ext ? `${file}.${ext}` : file;
}
const EXT_OF: Record<string, string> = { "application/pdf": "pdf", "application/zip": "zip", "application/json": "json", "text/plain": "txt", "text/csv": "csv",
  "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/flac": "flac", "image/svg+xml": "svg", "application/x-7z-compressed": "7z",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx", "font/ttf": "ttf", "font/otf": "otf", "font/woff2": "woff2" };
/** A response that is a file, not a page to read: any type but HTML (and not an XML feed or page), or one the site marks as a download. */
const isFile = (r: Response, type: string) => /attachment/i.test(r.headers.get("content-disposition") ?? "") || (!!type && !/html|xhtml/.test(type));

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
  const ok = orig !== img && (await safeFetch(orig, { method: "HEAD", ms: 8000, as: "file", referer: url }).then((x) => x.ok).catch(() => false));
  const pick = ok ? orig : img;
  return { title, author: null, thumb: img, files: [{ url: pick, name: `${base}.${extOf(pick, "jpg")}` }] };
}

/** Any page: a direct file, or the page's own preview (og:video before og:image), with a Google Images link unwrapped. */
async function fromWeb(url: string, source: Source): Promise<Found | null> {
  const u = new URL(url);
  const inner = u.hostname.includes("google.") ? u.searchParams.get("imgurl") ?? u.searchParams.get("url") : null;
  if (inner && /^https?:\/\//.test(inner)) return fromWeb(inner, sourceOf(inner));
  // a Wikimedia File: page is about one file (a sound, a video, a PDF, a photo): the original, never the page's preview
  const wiki = /(^|\.)(wikimedia|wikipedia|wiktionary|wikisource|wikibooks|wikinews|wikiversity|wikivoyage|mediawiki)\.org$/.test(u.hostname)
    && /^\/wiki\/(File|Image|Datei|Fichier|Archivo):(.+)$/i.exec(u.pathname);
  if (wiki) return fromWeb(`https://commons.wikimedia.org/wiki/Special:FilePath/${wiki[2]}`, source);
  const r = await safeFetch(url);
  if (!r.ok) throw new DlError(`the site answered ${r.status}`);
  const type = (r.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const host = new URL(r.finalUrl).hostname.replace(/^www\./, "");
  if (isFile(r, type)) {
    r.body?.cancel().catch(() => null);
    return { title: null, author: null, thumb: type.startsWith("image/") ? r.finalUrl : null, files: [{ url: r.finalUrl, name: `${host} - ${fileNameOf(r, type)}`.slice(0, 200) }] };
  }
  const html = (await r.text()).slice(0, 2_000_000);
  // a page that offers one file to download (<a download>, "Download original", a link to the file the address names)
  const want = /\.([a-z0-9]{2,5})$/i.test(u.pathname) ? decodeURIComponent(u.pathname.split("/").pop() ?? "") : null;
  const offered = /<a\b[^>]*\bdownload\b[^>]*\bhref=["']([^"'#]+)["']/i.exec(html)?.[1] ?? /<a\b[^>]*\bhref=["']([^"'#]+)["'][^>]*\bdownload\b/i.exec(html)?.[1]
    ?? (want ? [...html.matchAll(/<a\b[^>]*\bhref=["']([^"'#]+)["']/gi)].map((m) => m[1]).find((h) => { try { return decodeURIComponent(h).endsWith(want) && new URL(unent(h), r.finalUrl).toString() !== r.finalUrl; } catch { return false; } }) : null);
  if (offered && !/^(javascript|mailto|data):/i.test(offered) && (want || !meta(html, "og:video", "og:video:url", "og:video:secure_url"))) {
    const f = new URL(unent(offered), r.finalUrl).toString();
    if (/\.[a-z0-9]{2,5}(\?|$)/i.test(new URL(f).pathname)) return { title: null, author: null, thumb: null, files: [{ url: f, name: `${host} - ${decodeURIComponent(new URL(f).pathname.split("/").pop() || "file")}`.slice(0, 200) }] };
  }
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

// Sign-ins are one cookies.txt for every site, but a browser extension exports one site at a time: so a paste
// replaces only the sites it has cookies for and keeps the rest (pasting YouTube's used to wipe Instagram's).
type Cookie = { line: string; site: string; name: string; expires: number };
const SITE_OF: [RegExp, string][] = [[/(^|\.)(youtube\.com|youtu\.be|google\.com|googlevideo\.com)$/, "youtube.com"], [/(^|\.)(instagram\.com|cdninstagram\.com)$/, "instagram.com"],
  [/(^|\.)(facebook\.com|fbcdn\.net)$/, "facebook.com"], [/(^|\.)(x\.com|twitter\.com)$/, "x.com"], [/(^|\.)(threads\.net|threads\.com)$/, "threads.net"]];
function siteFor(domain: string) {
  const h = domain.replace(/^#HttpOnly_/i, "").replace(/^\./, "").toLowerCase();
  return SITE_OF.find(([re]) => re.test(h))?.[1] ?? h.split(".").slice(-2).join(".");
}
function parseCookies(text: string): Cookie[] {
  const out: Cookie[] = [];
  for (const line of text.replace(/\r/g, "").split("\n")) {
    if (!line.trim() || (line.startsWith("#") && !/^#HttpOnly_/i.test(line))) continue;
    const f = line.split("\t");
    if (f.length < 7) continue;
    out.push({ line, site: siteFor(f[0]), name: f[5], expires: Number(f[4]) || 0 });
  }
  return out;
}
// YouTube only counts as signed in with Google's session cookies; an export from a tab that wasn't signed in has none
const YT_AUTH = ["SAPISID", "__Secure-3PSID", "__Secure-1PSID", "SID", "LOGIN_INFO"];
const ytSignedIn = (cs: Cookie[]) => cs.some((c) => c.site === "youtube.com" && YT_AUTH.includes(c.name));

export async function cookieState() {
  const cs = parseCookies(await cookies());
  const now = Date.now() / 1000;
  const sites = [...new Set(cs.map((c) => c.site))].sort().map((site) => {
    const mine = cs.filter((c) => c.site === site);
    const live = mine.filter((c) => !c.expires || c.expires > now);
    return { site, cookies: mine.length, expired: !live.length, signed_in: site === "youtube.com" ? ytSignedIn(live) : true };
  });
  return { set: cs.length > 0, sites };
}
/** Merge a paste into the sign-ins (its sites replace theirs, the others stay); null or empty with `site` removes that
 *  one site, without `site` removes them all. */
export async function setCookies(text: string | null, site?: string | null) {
  const have = parseCookies(await cookies());
  let keep: Cookie[];
  if (!text?.trim()) {
    keep = site ? have.filter((c) => c.site !== site) : [];
  } else {
    if (!/^#?\s*(Netscape )?HTTP Cookie File|\t(TRUE|FALSE)\t/m.test(text)) throw new DlError("paste a cookies.txt export (Netscape format)");
    const add = parseCookies(text);
    if (!add.length) throw new DlError("no cookies in that paste: export cookies.txt from the site's tab while you're signed in");
    const sites = new Set(add.map((c) => c.site));
    if (sites.has("youtube.com") && !ytSignedIn(add)) throw new DlError("those YouTube cookies have no sign-in in them: sign in to YouTube in that browser first, then export again");
    keep = [...have.filter((c) => !sites.has(c.site)), ...add];
  }
  const body = keep.length ? `# Netscape HTTP Cookie File\n${keep.map((c) => c.line).join("\n")}\n` : "";
  if (body.length > 200_000) throw new DlError("that's too many cookies: export only the site you need (the extension's “current site”)");
  await putObj(COOKIES, body, "text/plain");
  return cookieState();
}

/** A link without what doesn't change the post behind it (share and tracking tags, www, the hash, a last slash). */
export function sameLink(raw: string) {
  try {
    const u = new URL(raw.trim());
    for (const k of [...u.searchParams.keys()]) if (/^(utm_\w+|igsh|igshid|img_index|si|s|feature|fbclid|ref|ref_src|ref_url)$/i.test(k)) u.searchParams.delete(k);
    u.searchParams.sort();
    return `${u.hostname.toLowerCase().replace(/^(www|m|mobile)\./, "")}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch { return raw.trim(); }
}

/** Downloads of these links that are already in Files, whole: finished, every file still there and out of the trash. */
async function alreadySaved(urls: string[]) {
  const want = new Set(urls.map(sameLink));
  const done = (await listDownloads()).filter((d) => d.status === "done" && d.items.length && want.has(sameLink(d.url)));
  if (!done.length) return new Map<string, Dl>();
  const [{ getTree }, { isTrashed }, { getMedia }] = await Promise.all([import("./files"), import("./filetree"), import("./data")]);
  const t = await getTree();
  const out = new Map<string, Dl>();
  for (const d of done) {
    if (out.has(sameLink(d.url))) continue; // the newest one (the list is newest first)
    const there = await Promise.all(d.items.map((x) => !isTrashed(t, `m:${x.media}`) && getMedia(x.media).then(() => true).catch(() => false)));
    if (there.every(Boolean)) out.set(sameLink(d.url), d);
  }
  return out;
}

/** Start downloads for one or more links. Each returns at once; the copying runs after the response (`later`). A link
 *  whose files are already in Files isn't fetched a second time (its earlier download is answered, with a note)
 *  unless `again` asks for it. */
export async function startDownloads(urls: string[], o: { folder?: string | null; name?: string | null; post?: string | null; again?: boolean }, actor: Actor, later: (f: () => Promise<unknown>) => void) {
  const asked = [...new Set(urls.map((u) => u.trim()).filter(Boolean))].slice(0, 20);
  if (!asked.length) throw new DlError("give a link to download");
  for (const u of asked) await checkUrl(u);
  const saved = o.again ? new Map<string, Dl>() : await alreadySaved(asked).catch(() => new Map<string, Dl>());
  const had: Dl[] = [];
  for (const d of new Set(asked.map((u) => saved.get(sameLink(u))).filter((d): d is Dl => !!d))) {
    const where = d.folder ? await import("./files").then(async (f) => f.pathOf(await f.getTree(), d.folder)).catch(() => "") : "";
    had.push((await patch(d.id, { note: `Already in Files${where ? ` (${where})` : ""}: not downloaded again.` })) ?? d);
  }
  const clean = asked.filter((u) => !saved.has(sameLink(u)));
  if (!clean.length) return had;
  const folders = new Map<Source, string | null>();
  for (const src of new Set(clean.map(sourceOf))) folders.set(src, await folderFor(o.folder, src, actor.name)); // one at a time: no twin folders
  const now = Date.now();
  const made: Dl[] = clean.map((url, i) => ({
    id: `${now.toString(36)}${i}${Math.random().toString(36).slice(2, 6)}`, url, source: sourceOf(url), status: "fetching", via: null, title: null, author: null, thumb: null,
    folder: folders.get(sourceOf(url)) ?? null, post: o.post ?? null, name: clean.length === 1 ? o.name?.trim().slice(0, 150) || null : null, by: actor.name, at: now, updated: now, items: [], error: null, job: null, pct: 0, stage: "Reading the link",
  }));
  await change((list) => { list.unshift(...made); });
  for (const d of made) later(() => run(d, actor));
  return [...made, ...had];
}

export async function retryDownload(id: string, actor: Actor, later: (f: () => Promise<unknown>) => void) {
  const d = await patch(id, { status: "fetching", error: null, job: null, pct: 0, stage: "Reading the link", via: null, saving_at: undefined, server_error: null, requeued: 0, retry_at: null, auto_retries: 0, unreachable: 0 });
  if (!d) throw new DlError("no such download", 404);
  later(() => run(d, actor));
  return d;
}
/** What a download leaves in storage besides its files: the Colab downloader's slots and info.json. */
async function dropStaging(ids: string[]) {
  const { delObjs, listObjs } = await import("./store");
  const keys = (await Promise.all(ids.map((id) => listObjs(`workspace/downloads/${id}/`).catch(() => [])))).flat().map((o) => o.key);
  if (keys.length) await delObjs(keys).catch(() => null);
}

/** Off the list, with everything it left in storage (the files it saved stay in Files). */
export async function forgetDownload(id: string) {
  const d = await change((list) => { const i = list.findIndex((x) => x.id === id); return i >= 0 ? list.splice(i, 1)[0] : null; });
  const gone = !!d;
  // one still running is stopped where it runs
  if (d?.job && ACTIVE.has(d.status)) await import("./worker").then((w) => w.call(`/jobs/${d.job}/cancel`, { body: {}, timeoutMs: 5000 })).catch(() => null);
  await dropStaging([id]);
  return gone;
}

const ACTIVE = new Set<Dl["status"]>(["fetching", "waiting", "worker", "saving"]);
/** Clear the history: every download that isn't running (all: running ones too, cancelled where they are), with what
 *  each left in storage. The files they saved stay in Files. */
export async function clearDownloads(all = false) {
  const gone = await change((list) => {
    const out = list.filter((d) => all || !ACTIVE.has(d.status));
    list.splice(0, list.length, ...list.filter((d) => !out.includes(d)));
    return out;
  });
  if (all) {
    const { call } = await import("./worker");
    await Promise.all(gone.filter((d) => d.job && ACTIVE.has(d.status)).map((d) => call(`/jobs/${d.job}/cancel`, { body: {} }).catch(() => null)));
  }
  await dropStaging(gone.map((d) => d.id));
  return { cleared: gone.length };
}

/** The server route, else the worker's. Never throws: a failure is written on the row. */
async function run(d: Dl, actor: Actor) {
  try {
    const route = SOURCES[d.source].via;
    let found: Found | null = null;
    if (route === "server") found = await resolve(d.url, d.source).catch(() => null); // a site that refuses servers: the worker tries
    if (found?.files.length) {
      await patch(d.id, { via: "server", title: found.title, author: found.author, thumb: found.thumb, stage: "Downloading", pct: 0.2 });
      let why: string | null = null;
      const items = await saveFromServer(d, found, actor).catch((e: Error) => { why = e.message; return null; });
      if (items) { await finish(d.id, items, actor); return; }
      // the server couldn't get the file (refused, gone, too slow): the Colab downloader tries it its own way
      if (why) await patch(d.id, { server_error: why, stage: `${why}: trying the Colab downloader` });
    }
    await toWorker(d, found);
  } catch (e) {
    await fail(d, (e as Error).message);
  }
}

async function saveFromServer(d: Dl, found: Found, actor: Actor): Promise<DlItem[] | null> {
  const { addMediaBytes, addMediaStream, mimeFor } = await import("./data");
  const { getSettings } = await import("./settings");
  const backup = (await getSettings()).backup_media;
  const items: DlItem[] = [];
  for (const [i, f] of found.files.entries()) {
    const r = await safeFetch(f.url, { ms: 120_000, as: "file", referer: f.url === d.url ? null : d.url });
    if (!r.ok) { r.body?.cancel().catch(() => null); throw new DlError(`${new URL(r.finalUrl).hostname.replace(/^www\./, "")} refused the file: HTTP ${r.status}`); }
    const size = Number(r.headers.get("content-length") ?? 0);
    if (size > SERVER_MAX) { r.body?.cancel().catch(() => null); return null; } // big: the worker streams it instead
    const raw = (r.headers.get("content-type") ?? "").split(";")[0] || mimeFor(f.name);
    const name = nameFor(d, f.name, i, found.files.length);
    const mime = raw.startsWith("binary") || raw === "application/octet-stream" ? mimeFor(name) : raw;
    // streamed into Files as it arrives (a Worker has 128 MB: a big video held whole, then copied, ran out of memory
    // and left the download stuck); without a size it's read whole, but only up to BUFFER_MAX, else the worker takes it
    const streamed = r.body && size > 0 ? await addMediaStream(r.body as ReadableStream<Uint8Array>, size, mime, name, { postId: d.post }, actor) : null;
    let media = streamed?.media;
    if (!media) {
      const bytes = await readCapped(r, BUFFER_MAX);
      if (!bytes) return null;
      media = (await addMediaBytes(bytes, mime, name, { postId: d.post, backup }, actor)).media;
    }
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
  const keys = items.map((x) => `m:${x.media}`);
  if (d?.folder) await (await import("./files")).moveItems(keys, d.folder).catch(() => null);
  // a carousel (several photos or videos from one post) stays one: grouped in Files, in the post's order, named after
  // the post ("@handle on Instagram - title"), for the post it was downloaded for
  let carousel = d?.carousel ?? null;
  if (keys.length > 1 && !carousel) {
    const name = (d?.name || items[0].name.replace(/ \(\d+\)(\.\w{2,4})?$|\.\w{2,4}$/, "")).slice(0, 120);
    carousel = await (await import("./carousels")).createCarousel({ name, items: keys, post: d?.post ?? null }, actor.name).then((c) => c.id).catch(() => null);
  }
  await patch(id, { status: "done", items, pct: 1, stage: null, error: null, saving_at: undefined, carousel });
  await dropStaging([id]); // the worker's slots were moved into Files; its info.json is all that's left
  // workflows listening for downloads (lib/auto/flows.ts) start
  await import("./auto/flows").then((f) => f.emit("download.done", { download: id, url: d?.url ?? "", source: d?.source ?? "", files: keys, folder: d?.folder ?? null, carousel, post: d?.post ?? null }));
}

/** Hand the link to the worker's yt-dlp; with the worker off it starts the GPU and waits, and goes as soon as the
 *  worker is on (its first heartbeat hands the waiting ones over). */
async function toWorker(d: Dl, found: Found | null) {
  const { call, WorkerOffline, WorkerUnreachable } = await import("./worker");
  const slots = await Promise.all(Array.from({ length: SLOTS }, (_, i) => presign(`workspace/downloads/${d.id}/${i}`, "PUT", 6 * 3600)));
  const info = await presign(`workspace/downloads/${d.id}/info.json`, "PUT", 6 * 3600);
  try {
    const job = await call<{ id: string }>("/jobs", { body: { kind: "fetch", url: d.url, put_urls: slots, info_put: info, cookies: await cookies(), label: `Download from ${SOURCES[d.source].name}`, notify: true } });
    await patch(d.id, { status: "worker", via: "worker", job: job.id, stage: "Queued on the worker", pct: 0.05, unreachable: 0, ...(found ? { title: found.title, author: found.author, thumb: found.thumb } : {}) });
  } catch (e) {
    if (e instanceof WorkerUnreachable) {
      // on, but not answering yet (a tunnel a few seconds old resolves a moment later): wait, the next look sends it
      const n = (d.unreachable ?? 0) + 1;
      if (n > 15) throw new Error(`the Colab downloader is on but can't be reached (${e.message})`);
      // still not answering after a few looks: its runtime is likely gone (stopped, reclaimed). With nothing assigned on
      // Colab this starts a fresh one; with a runtime still there it does nothing
      if (n >= 3) await startGpu();
      await patch(d.id, { status: "waiting", via: "worker", pct: 0, unreachable: n, stage: "Connecting to the Colab downloader" });
      return;
    }
    if (!(e instanceof WorkerOffline)) throw e;
    await patch(d.id, { status: "waiting", via: "worker", pct: 0, stage: `Starting the downloader for ${SOURCES[d.source].name} (about a minute)` });
    const why = await startGpu();
    if (why) await patch(d.id, { stage: `${SOURCES[d.source].name} needs the Colab worker, and it couldn't start: ${why}` });
  }
}

/** The worker is off: start the voice GPU (an L4) for the downloads, once (a claim kept 5 min, so a dozen links start one GPU;
 *  colab.start refuses too while a runtime is assigned). null when it started or one is on its way, else why not. */
async function startGpu(): Promise<string | null> {
  const { value, etag } = await getJsonTagged<{ at: number; error?: string | null }>(GPU_CLAIM);
  if (value && Date.now() - value.at < 5 * 60_000) return value.error ?? null; // a failed start is tried again after 5 min, not on every look
  if (!(await putJsonIf(GPU_CLAIM, { at: Date.now() }, etag))) return null; // someone else is starting it
  const colab = await import("./colab");
  try {
    if ((await colab.runtimes()).length) return null; // assigned already: its worker is booting
    // the L4 (the owner's call: the CPU runtime came up but was slow to answer); stopped again once the downloads are in
    await colab.start(colab.appOrigin(), undefined, { purpose: "voice", high_ram: false, for_downloads: true });
    return null;
  } catch (e) {
    const c = (e as Error & { cause?: { code?: string } }).cause?.code;
    const m = c ? `couldn't reach Colab (${c})` : (e as Error).message;
    const error = /not connected|token|sign.?in|oauth/i.test(m) ? "connect Colab in Settings → GPU & engines, or run the notebook" : m.slice(0, 160);
    await putJson(GPU_CLAIM, { at: Date.now(), error }).catch(() => null);
    return error;
  }
}

/** Something still under way (the GPU started for downloads stays on until there isn't). */
export const anyLive = async () => (await listDownloads()).some((d) => ["fetching", "worker", "waiting", "saving"].includes(d.status)
  && !(d.retry_at && d.retry_at > Date.now()) && Date.now() - d.updated < 30 * 60_000); // one waiting to try again later doesn't keep the runtime on

/** Bring running downloads up to date (the page and the MCP tool call this when they look, and every worker heartbeat). */
export async function refresh(later: (f: () => Promise<unknown>) => void, actor: Actor) {
  // one that stopped moving long ago (the request reading it was cut off, the worker went away for good) ends as an
  // error you can Retry or clear, instead of "Reading the link" for days
  const old = (d: Dl) => {
    const idle = Date.now() - d.updated;
    if (d.status === "fetching" || d.status === "saving") return idle > 15 * 60_000;
    if (d.status === "worker") return idle > 3 * 3600_000;
    if (d.status === "waiting") return !d.retry_at && idle > 3 * 3600_000;
    return false;
  };
  if ((await listDownloads()).some(old)) await change((l) => { for (const d of l) if (old(d)) Object.assign(d, { status: "error", error: "It stopped part way and never finished: Retry, or clear it", stage: null, pct: null, updated: Date.now() }); });
  const list = await listDownloads();
  const live = list.filter((d) => d.status === "worker" || d.status === "waiting" || (d.status === "saving" && Date.now() - (d.saving_at ?? 0) > 120_000));
  if (!live.length) return list;
  const { call, WorkerOffline } = await import("./worker");
  for (const d of live) {
    if (d.status === "waiting" && d.retry_at) {
      if (Date.now() < d.retry_at) continue;
      // its time has come: claim it (the page, the sweep and a heartbeat may all look at once), then the whole chain again
      const claimed = await change((l) => { const x = l.find((y) => y.id === d.id); if (!x || x.status !== "waiting" || !x.retry_at || Date.now() < x.retry_at) return false;
        Object.assign(x, { status: "fetching", retry_at: null, via: null, stage: "Trying again", updated: Date.now() }); return true; });
      if (claimed) later(() => run({ ...d, status: "fetching", retry_at: null }, actor));
      continue;
    }
    if (d.status === "waiting") { if (Date.now() - d.updated < 20_000) continue; later(() => toWorker(d, null).catch((e) => fail(d, (e as Error).message))); continue; }
    if (d.status === "saving") { later(() => saveFromWorker(d, actor)); continue; }
    try {
      const j = await call<{ status: string; error?: string | null; stage?: string; dl?: { pct: number; files: number } }>(`/jobs/${d.job}`, { timeoutMs: 8000 });
      if (j.status === "done") {
        const claimed = await change((l) => { const x = l.find((y) => y.id === d.id); if (!x || x.status !== "worker") return false; x.status = "saving"; x.saving_at = Date.now(); x.stage = "Saving to Files"; x.pct = 0.97; return true; });
        if (claimed) later(() => saveFromWorker(d, actor));
      } else if (j.status === "error" || j.status === "cancelled") {
        await fail(d, j.error ?? j.status);
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
    const info = await getJson<{ title?: string; uploader?: string; handle?: string; thumbnail?: string; warnings?: string[]; items: { slot: number; name: string; mime: string; size: number }[] }>(`workspace/downloads/${d.id}/info.json`);
    if (!info?.items?.length) throw new DlError("the Colab downloader finished but sent no files back: Retry");
    const { addMediaFromR2 } = await import("./data");
    const who = (info.handle || info.uploader || "").replace(/^@/, "");
    const host = (() => { try { return new URL(d.url).hostname.replace(/^www\./, ""); } catch { return "the web"; } })();
    const base = `${who ? `@${words(who, 30).replace(/\s+/g, "")} on ` : ""}${d.source === "web" ? host : SOURCES[d.source].name}${info.title ? ` - ${words(info.title, 60)}` : ""}`;
    const items: DlItem[] = [];
    for (const it of info.items) {
      const ext = /\.[a-z0-9]{2,4}$/i.exec(it.name)?.[0] ?? "";
      // a file with no title of its own (a PDF, a sound from a plain link) keeps the name it came with
      const own = !info.title && d.source === "web" ? it.name.replace(/^\d{2}-/, "") : null;
      const name = nameFor(d, own ? `${host} - ${own}`.slice(0, 200) : `${base}${info.items.length > 1 ? ` (${it.slot + 1})` : ""}${ext}`, it.slot, info.items.length);
      const key = `workspace/downloads/${d.id}/${it.slot}`;
      const size = (await headObj(key))?.size ?? it.size;
      // a fixed file id per slot: a second save of the same download is refused by storage instead of copied twice
      const media = await addMediaFromR2(key, size, it.mime, name, `dl${d.id}x${it.slot}`.slice(0, 36), { postId: d.post }, actor).then((x) => x.media).catch((e: { status?: number }) => { if (e.status === 409) return null; throw e; });
      if (media) items.push(await itemOf(media));
    }
    const small = (info.warnings ?? []).filter((w) => /only came at/.test(w));
    const page = (info.warnings ?? []).some((w) => /saved the page itself/.test(w));
    await patch(d.id, { title: info.title ?? d.title, author: who || d.author, thumb: info.thumbnail ?? d.thumb,
      note: page ? "That page had no file, photo or video to take: saved the page itself (a PDF and a full screenshot)." : small.length ? `${small.length === 1 ? small[0].replace(/^photo/, "Photo").replace(/:.*$/, "") : `${small.length} photos only came at preview size (${/at (\d+x\d+)/.exec(small[0])?.[1] ?? "small"})`}: ${SOURCES[d.source].name} gave a signed-out downloader nothing bigger.` : null });
    await finish(d.id, items, actor);
  } catch (e) {
    await fail(d, (e as Error).message);
  }
}

/** A failure that goes away by itself: the site rate-limiting or blocking for a while (429, an odd 4xx such as 470),
 *  a 5xx, a timeout. Not a missing post, a sign-in wall, a private post or our own storage. */
function passes(raw: string) {
  if (/sign in|log ?in|login|private|age.?restrict|confirm your age|country|unsupported url|nothing to download/i.test(raw)) return false;
  const code = Number(/HTTP(?: Error)?:? (\d{3})|answered (\d{3})|status(?: code)? (\d{3})/i.exec(raw)?.slice(1).find(Boolean) ?? 0);
  if (code) return code === 408 || code === 425 || code === 429 || code >= 500 || (code >= 400 && ![400, 401, 403, 404, 410, 451].includes(code));
  return /timed? ?out|timeout|didn't answer in time|rate.?limit|too many requests|temporarily|try again later|connection (reset|refused|aborted|dropped)|ECONNRESET|fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|can't be reached|couldn't reach|socket hang up|other side closed/i.test(raw);
}

/** A download failed. A block that passes is tried again by itself (the whole chain, from the server's own try) after
 *  RETRY_AFTER_MIN; anything else, or once those are used up, is an error that says what happened. */
async function fail(d: Dl, raw: string) {
  const cur = (await listDownloads()).find((x) => x.id === d.id) ?? d;
  const n = cur.auto_retries ?? 0;
  const yt = cur.source === "youtube" && (await cookieState()).sites.some((x) => x.site === "youtube.com" && x.signed_in && !x.expired);
  const why = plain(raw, siteOf(cur), cur.server_error, yt);
  if (passes(raw) && n < RETRY_AFTER_MIN.length) {
    const mins = RETRY_AFTER_MIN[n];
    await patch(d.id, { status: "waiting", job: null, pct: 0, error: null, retry_at: Date.now() + mins * 60_000, auto_retries: n + 1,
      stage: `${why.replace(/ Wait [^.]*\.| Retry in [^.]*\.| Retry\.|: Retry\.?/g, "").trim()} Trying again by itself in ${mins} min (${n + 1} of ${RETRY_AFTER_MIN.length}).` });
    return;
  }
  await patch(d.id, { status: "error", error: n ? `${why} (tried ${n + 1} times)` : why, stage: null, retry_at: null });
}

const siteOf = (d: Dl) => (d.source === "web" ? (() => { try { return new URL(d.url).hostname.replace(/^www\./, ""); } catch { return "The site"; } })() : SOURCES[d.source].name);
const SIGN_IN = "add your sign-in cookies (Download → Sign-ins), then Retry";

/** What went wrong, in words a person can act on: who refused (the site, Colab, storage), the HTTP code and what it
 *  means, and what to do. serverWhy: what the server got before the worker tried, when that says more. */
export function plain(raw: string, site = "The site", serverWhy?: string | null, ytCookies = false) {
  const m = raw.replace(/\x1b\[[0-9;]*m/g, "").replace(/^ERROR:\s*/, "").replace(/^\[[^\]]+\]\s*[\w-]*:?\s*/, "").trim();
  const was = serverWhy && serverWhy !== raw ? ` (the server's own try: ${serverWhy})` : "";
  if (/confirm you.?re not a bot|sign in to confirm/i.test(m) && ytCookies) return "YouTube didn't accept the saved YouTube sign-in (\"sign in to confirm you're not a bot\"). YouTube signs a browser's cookies out when that browser keeps using them, so export them this way: open a private window, sign in to YouTube, open youtube.com/robots.txt in that tab, export cookies.txt, close the private window without signing out, then paste it in Download → Sign-ins and Retry.";
  if (/confirm you.?re not a bot|sign in to confirm/i.test(m)) return `YouTube wants a signed-in account for this one ("sign in to confirm you're not a bot"): ${SIGN_IN}.`;
  if (/login required|rate-limit reached|requested content is not available|empty media response|log ?in to|logged.?in/i.test(m)) return `${site} wants a signed-in account for this one: ${SIGN_IN}.`;
  if (/private (video|account|post)|is private/i.test(m)) return `That ${site} post is private: only an account that can see it can download it. If yours can, ${SIGN_IN}.`;
  if (/age.?(restricted|verification|gate)|confirm your age/i.test(m)) return `${site} age-restricts this one: ${SIGN_IN}.`;
  if (/not available in your country|geo.?restrict|blocked it in your country/i.test(m)) return `${site} doesn't offer this one in the country the downloader runs in.`;
  if (/^Colab \d{3}|couldn't start|Colab didn't/i.test(m)) return `The Colab downloader couldn't start: ${m.replace(/^Colab \d{3}:\s*/, "")}`;
  if (/can't be reached|couldn't reach the Colab worker/i.test(m)) return `The Colab downloader is on, but the dashboard couldn't connect to it (${m.replace(/^.*?\(/, "").replace(/\)[^)]*$/, "")}). Nothing is wrong with the link: Retry in a minute.`;
  if (/^(TypeError: )?fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket hang up|other side closed/i.test(m)) return `A connection dropped on the way (${m.slice(0, 80)}): nothing is wrong with the link. Retry.`;
  if (/upload failed|storage (GET|PUT)|could not read the upload/i.test(m)) return `Saving to Files failed (${m.slice(0, 140)}). The download itself worked: Retry.`;
  const code = Number(/HTTP(?: Error)?:? (\d{3})|answered (\d{3})|status(?: code)? (\d{3})/i.exec(m)?.slice(1).find(Boolean) ?? 0);
  if (code === 404 || code === 410) return `That link is gone: ${site} says it doesn't exist (HTTP ${code}). Check the link.`;
  if (code === 401 || code === 403) return `${site} refused the download (HTTP ${code}): it wants a signed-in account, or it doesn't allow downloads from servers. If it's yours to download, ${SIGN_IN}.${was}`;
  if (code === 429) return `${site} says too many requests (HTTP 429): it's rate-limiting the downloader. Wait 10 to 15 minutes, then Retry.${was}`;
  if (code === 451) return `${site} withholds this one for legal reasons (HTTP 451).`;
  if (code >= 500) return `${site} is having trouble right now (HTTP ${code}). Retry in a few minutes.${was}`;
  if (code >= 400) return `${site} refused the download with a non-standard code (HTTP ${code}): that's the site blocking automated downloads, not a fault here. Wait a few minutes and Retry; if it keeps happening, ${SIGN_IN}.${was}`;
  if (/unsupported url|nothing to download/i.test(m)) return `Nothing to download at that link: no photo or video on the page (every way the downloader knows came up empty).${was}`;
  if (/timed? ?out|didn't answer in time|timeout/i.test(m)) return `${site} didn't answer in time. Retry.${was}`;
  return `${m.slice(0, 220)}${was}`;
}
