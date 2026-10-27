"use client";
// Files: a file manager like Google Drive over everything you have. Uploads (the shared workspace, Appwrite) and
// generated items (takes, subtitles, images and videos the GPU made, in R2) sit side by side. Five category folders
// file everything by kind on their own (Videos, Images, Audio, Docs & scripts, Other); your folders sit beside them
// (lib/filetree.ts). Upload with the button, by dropping files anywhere or by pasting (a photo, files or a link); drag
// cards onto a folder or the path to move them; right-click or ⋮ for the rest. Deleting moves things to the trash for
// 30 days (with Undo). Everything changes on screen at once and is saved behind it; the last listing is kept in this
// browser so the page opens instantly. Keys: ⌘F search, ⌘A select all, ⌘C copy links, ⌘X then ⌘V move, F2 rename,
// Delete, Esc. Parts in fileparts.tsx; rules in docs/DESIGN.md.
import {
  ArrowClockwise, ArrowCounterClockwise, ArrowSquareOut, ArrowsDownUp, CaretRight, Check, CheckSquare, ClosedCaptioning, Copy, DownloadSimple, FolderOpen,
  FolderPlus, FolderSimple, LinkSimple, ListBullets, MagnifyingGlass, PencilSimple, Scissors, SquaresFour, Star, Trash, TrashSimple, UploadSimple,
  UsersThree, X,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { folderFor, folderTrashed, isTrashed, newFolderId, normalize, ROOT, subtree, SYSTEM, within as inside, type FileTree, type Folder } from "@/lib/filetree";
import { fileUrl as mediaUrl, kindOf, libKind, libName, libType, type Media, type MediaKind } from "@/lib/workspace";
import { api, fileUrl as libFileUrl } from "./api";
import { Query, signOut, useLive, useMe } from "./aw";
import { useDialog } from "./Dialog";
import {
  ContextMenu, DT, FileCard, FileRow, FilterPill, FolderCard, FolderRow, MoveDialog, NewFolderCard, Snack, UploadPanel,
  type Anchor, type Item, type JobSum, type MenuEntry, type UpRow,
} from "./fileparts";
import { ImageCard, JobCard, VideoCard, type LibJob } from "./Library";
import { useStatus } from "./Shell";
import { Notice, PageHeader } from "./ui";
import { MediaViewer, useUploader } from "./wsparts";

type Sort = "new" | "old" | "name" | "size";
type Tree = FileTree & { poster_urls?: Record<string, string> };
const TYPES = [["all", "All"], ["image", "Images"], ["video", "Videos"], ["audio", "Audio"], ["doc", "Docs & scripts"], ["other", "Other"]] as const;
const SOURCES = [["any", "Any"], ["upload", "Uploads"], ["generated", "Generated"]] as const;
const DATES = [["any", "Any"], ["1", "Today"], ["7", "Last 7 days"], ["30", "Last 30 days"], ["365", "This year"]] as const;
const SORTS: [Sort, string][] = [["new", "Newest first"], ["old", "Oldest first"], ["name", "Name A–Z"], ["size", "Largest first"]];
const EMPTY: Tree = normalize(null);
const CACHE = "vb-files-v2";
const CACHE_MS = 5 * 3600_000; // its links stay good for at least 6 h (lib/store.ts signs in 3-hour windows)
const RECENT = 12;
const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const changed = () => window.dispatchEvent(new Event("vb-files-changed")); // the sidebar's favourites follow

type Cache = { at: number; jobs: JobSum[]; tree: Tree; media: Media[] };
function readCache(): Cache | null {
  try { const c = JSON.parse(localStorage.getItem(CACHE) ?? "null") as Cache | null; return c && Date.now() - c.at < CACHE_MS ? c : null; } catch { return null; }
}

/** A frame of a video (a File or a link) as a small JPEG, so a card never loads the video itself. */
async function grabFrame(src: File | string): Promise<string | null> {
  const v = document.createElement("video");
  const url = typeof src === "string" ? src : URL.createObjectURL(src);
  try {
    v.muted = true; v.playsInline = true; v.preload = "auto"; v.crossOrigin = "anonymous"; v.src = url;
    await new Promise<void>((ok, bad) => { v.onloadedmetadata = () => ok(); v.onerror = () => bad(new Error("no video")); setTimeout(() => bad(new Error("slow")), 20_000); });
    v.currentTime = Math.min(1.5, (v.duration || 2) * 0.1);
    await new Promise<void>((ok, bad) => { v.onseeked = () => ok(); setTimeout(() => bad(new Error("slow")), 20_000); });
    const w = Math.min(640, v.videoWidth || 640), h = Math.round(w * ((v.videoHeight || 360) / (v.videoWidth || 640)));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    c.getContext("2d")!.drawImage(v, 0, 0, w, h);
    return c.toDataURL("image/jpeg", 0.8);
  } catch { return null; } finally {
    v.removeAttribute("src"); v.load();
    if (typeof src !== "string") URL.revokeObjectURL(url);
  }
}

function fromJob(j: JobSum, t: Tree, starred: Set<string>): Item {
  const key = `g:${j.id}`;
  const kind = libKind(j);
  return {
    key, src: "generated", name: libName({ ...j, results: [{ text: j.text }] }), kind, type: libType(j), size: j.video?.size ?? null,
    seconds: j.kind === "video" ? j.video?.duration ?? null : j.kind === "image" ? null : j.seconds || null,
    at: j.created, by: null, byId: null, folder: folderFor(t, key, kind), placed: key in t.place, starred: starred.has(key), cover: j.cover, audio: j.audio,
    subs: j.subs, post: null, backedUp: true, snippet: j.kind === "transcribe" ? j.text : "", j, trashedAt: t.trash[key]?.at,
  };
}
function fromMedia(m: Media, t: Tree, starred: Set<string>, local: Record<string, string>): Item {
  const key = `m:${m.$id}`;
  const ready = !!m.token;
  const poster = t.poster_urls?.[key] ?? local[key] ?? null;
  return {
    key, src: "upload", name: m.name, kind: m.kind, type: m.kind === "doc" ? "Doc" : m.kind[0].toUpperCase() + m.kind.slice(1), size: m.size, seconds: null,
    at: Date.parse(m.$createdAt), by: m.uploaded_name, byId: m.uploaded_by, folder: folderFor(t, key, m.kind), placed: key in t.place, starred: starred.has(key),
    cover: m.kind === "image" ? (ready ? mediaUrl(m, "preview", 480) : local[key] ?? null) : m.kind === "video" ? poster : null,
    audio: ready && m.kind === "audio" ? mediaUrl(m) : null, subs: false, post: m.post_id, backedUp: !!m.r2_key, snippet: "", m, trashedAt: t.trash[key]?.at,
  };
}

/** Where to download a file from. */
function downloadHref(it: Item) {
  if (it.m) return mediaUrl(it.m, "download");
  const j = it.j!;
  const slug = it.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60) || j.id;
  if (j.kind === "video") return libFileUrl(j.id, "video.mp4", `${slug}.mp4`);
  if (j.kind === "image" && j.images === 1 && j.image) return libFileUrl(j.id, j.image.file, `${slug}.png`);
  return `/api/zip/${j.id}`;
}
const linkOf = (it: Item) => (it.m ? mediaUrl(it.m) : `${location.origin}/files#${it.j!.id}`);

export default function Files() {
  const params = useSearchParams();
  const router = useRouter();
  const cwd = params.get("folder");
  const trashView = params.get("view") === "trash";
  const { status } = useStatus();
  const { confirm, toast } = useDialog();
  const me = useMe();
  const wsOn = !!(me?.user && me.session && me.workspace);
  const { rows: liveMedia, setRows: setMedia, loading: mediaLoading } = useLive<Media>("media", [Query.orderDesc("$createdAt"), Query.limit(1000)]);
  const { uploads, upload, clear: clearUploads } = useUploader(null);

  const [jobs, setJobs] = useState<JobSum[] | null>(null);
  const [jobsErr, setJobsErr] = useState("");
  const [tree, setTree] = useState<Tree | null>(null);
  const [cachedMedia, setCachedMedia] = useState<Media[]>([]);
  const [local, setLocal] = useState<Record<string, string>>({}); // this browser's previews of fresh uploads (m:<id> -> blob or frame)
  const [pendingUp, setPendingUp] = useState<Record<string, { folder: string | null; preview: string | null; kind: MediaKind; at: number }>>({});
  const [q, setQ] = useState("");
  const [type, setType] = useState<(typeof TYPES)[number][0]>("all");
  const [source, setSource] = useState<(typeof SOURCES)[number][0]>(params.get("tab") === "uploads" ? "upload" : "any");
  const [date, setDate] = useState<(typeof DATES)[number][0]>("any");
  const [by, setBy] = useState("anyone");
  const [starOnly, setStarOnly] = useState(false);
  const [sort, setSort] = useState<Sort>("new");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ at: Anchor; keys: string[] } | null>(null);
  const [moving, setMoving] = useState<string[] | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [full, setFull] = useState<Record<string, LibJob>>({});
  const [cut, setCut] = useState<string[]>([]);
  const [dragging, setDragging] = useState<string[] | null>(null);
  const [over, setOver] = useState<string | null>(null); // a folder id, "root" for All files
  const [osDrag, setOsDrag] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const [sortAt, setSortAt] = useState<Anchor | null>(null);
  const [subNote, setSubNote] = useState("");
  const [snack, setSnack] = useState<{ text: string; action?: string; run?: () => void } | null>(null);
  const anchor = useRef<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const sortBtn = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const player = useRef<HTMLAudioElement | null>(null);
  const pending = useRef<Map<string, string[]>>(new Map());
  const flushT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busy = useRef(0); // writes in flight: a background refresh mustn't undo what's on screen

  const media = liveMedia.length || !mediaLoading ? liveMedia : cachedMedia;

  // ── data: the cached listing at once, then the fresh one
  const loadJobs = useCallback(() => api<{ jobs: JobSum[] }>("files/items").then((r) => { setJobs(r.jobs); setJobsErr(""); }).catch((e) => setJobsErr(e.message)), []);
  const loadTree = useCallback(() => { if (busy.current) return Promise.resolve(); return api<Tree>("files").then((x) => { if (!busy.current) setTree({ ...normalize(x), poster_urls: x.poster_urls }); }).catch(() => setTree((t) => t ?? EMPTY)); }, []);
  useEffect(() => {
    const c = readCache();
    if (c) { setJobs(c.jobs); setTree({ ...normalize(c.tree), poster_urls: c.tree.poster_urls }); setCachedMedia(c.media); }
    loadJobs(); loadTree();
    try { const v = localStorage.getItem("vb-files-view"); if (v === "list" || v === "grid") setView(v); } catch {}
    // folders aren't on the live socket: check now and then, and whenever the tab comes back
    const t = setInterval(() => { if (document.visibilityState === "visible") loadTree(); }, 20_000);
    const onVis = () => { if (document.visibilityState === "visible") { loadTree(); loadJobs(); } };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  }, [loadJobs, loadTree]);
  useEffect(() => {
    if (!jobs || !tree) return;
    const id = setTimeout(() => {
      try { localStorage.setItem(CACHE, JSON.stringify({ at: Date.now(), jobs, tree, media: wsOn ? liveMedia : [] } satisfies Cache)); } catch { /* full: skip */ }
    }, 800);
    return () => clearTimeout(id);
  }, [jobs, tree, liveMedia, wsOn]);
  const pickView = (v: "grid" | "list") => { setView(v); try { localStorage.setItem("vb-files-view", v); } catch {} };

  /** Change it on screen now, save it behind; on failure, say so and reload what's true. */
  const write = useCallback(async <T,>(local: () => void, remote: () => Promise<T>): Promise<T | null> => {
    local();
    busy.current++;
    try { return await remote(); } catch (e) { toast((e as Error).message, "bad"); return null; } finally {
      busy.current--;
      if (!busy.current) setTimeout(loadTree, 400);
    }
  }, [toast, loadTree]);
  const edit = (fn: (t: Tree) => Tree) => setTree((x) => fn(x ?? EMPTY));

  const t = tree ?? EMPTY;
  const starred = useMemo(() => new Set(t.starred), [t.starred]);
  const allItems = useMemo(() => {
    const out = [
      ...((wsOn || (!me && cachedMedia.length)) ? media.map((m) => fromMedia(m, t, starred, local)) : []),
      ...(jobs ?? []).map((j) => fromJob(j, t, starred)),
    ];
    // uploads still on their way: a card right away, with this browser's preview
    const have = new Set(media.map((m) => m.$id));
    for (const u of uploads) {
      if (u.mediaId && have.has(u.mediaId)) continue;
      if (u.done && !u.error) continue;
      const p = pendingUp[u.key];
      if (!p) continue;
      out.push({ key: `u:${u.key}`, src: "upload", name: u.name, kind: u.kind, type: u.kind[0].toUpperCase() + u.kind.slice(1), size: u.size, seconds: null, at: p.at,
        by: me?.user?.name ?? null, byId: me?.user?.id ?? null, folder: p.folder ?? folderFor(t, "u:x", u.kind), starred: false, cover: p.preview, audio: null,
        subs: false, post: null, backedUp: false, snippet: "", progress: u.progress, error: u.error });
    }
    return out;
  }, [media, jobs, t, starred, local, wsOn, me, cachedMedia.length, uploads, pendingUp]);
  const items = useMemo(() => allItems.filter((i) => !isTrashed(t, i.key)), [allItems, t]);
  const byKey = useMemo(() => new Map(allItems.map((i) => [i.key, i])), [allItems]);
  const liveFolders = useMemo(() => t.folders.filter((f) => !folderTrashed(t, f.id) && !folderGone(t, f)), [t]);
  const folderById = useMemo(() => new Map(t.folders.map((f) => [f.id, f])), [t.folders]);
  const here = cwd ? folderById.get(cwd) ?? null : null;
  const cwdId = here && !trashView ? here.id : null;
  useEffect(() => { if (tree && cwd && (!folderById.has(cwd) || folderTrashed(t, cwd) || folderGone(t, folderById.get(cwd)!))) router.replace("/files", { scroll: false }); }, [tree, cwd, folderById, router, t]);

  const path = useMemo(() => {
    const out: Folder[] = [];
    for (let cur = here, n = 0; cur && n < 64; n++) { out.unshift(cur); cur = cur.parent ? folderById.get(cur.parent) ?? null : null; }
    return out;
  }, [here, folderById]);
  const pathName = useCallback((id: string | null) => {
    const parts: string[] = [];
    for (let cur = id ? folderById.get(id) : undefined, n = 0; cur && n < 64; n++) { parts.unshift(cur.name); cur = cur.parent ? folderById.get(cur.parent) : undefined; }
    return parts.join(" / ") || "All files";
  }, [folderById]);

  // how many things a folder holds (files and folders, all the way down) and who put them there
  const counts = useMemo(() => {
    const direct = new Map<string, number>();
    for (const i of items) if (i.folder) direct.set(i.folder, (direct.get(i.folder) ?? 0) + 1);
    const total = (id: string, n = 0): number => n > 64 ? 0 : (direct.get(id) ?? 0) + liveFolders.filter((f) => f.parent === id).reduce((s, f) => s + 1 + total(f.id, n + 1), 0);
    return new Map(liveFolders.map((f) => [f.id, total(f.id)]));
  }, [items, liveFolders]);
  const people = useMemo(() => {
    const out = new Map<string, Map<string, { id: string | null; name: string }>>();
    for (const i of items) if (i.folder) {
      const m = out.get(i.folder) ?? new Map();
      const k = i.src === "generated" ? "gpu" : i.byId ?? i.by ?? "?";
      if (!m.has(k)) m.set(k, i.src === "generated" ? { id: "gpu", name: "GPU" } : { id: i.byId, name: i.by ?? "Someone" });
      out.set(i.folder, m);
    }
    return out;
  }, [items]);
  const peopleIn = (id: string) => [...(people.get(id)?.values() ?? [])];
  /** What went to the trash with a folder: its folders and the files in them. */
  const trashedCount = (id: string) => { const sub = subtree(t, id); return sub.size - 1 + allItems.filter((i) => sub.has(t.place[i.key])).length; };

  const uploaders = useMemo(() => [...new Set(items.filter((i) => i.by).map((i) => i.by!))].sort(), [items]);
  const BY = useMemo(() => [["anyone", "Anyone"], ...(me?.user ? [["me", "Me"]] : []), ...uploaders.filter((p) => p !== me?.user?.name).map((p) => [`p:${p}`, p]), ["gpu", "The GPU"]] as [string, string][], [uploaders, me]);

  // ── what's shown: this folder; everything when searching, filtering at the top or showing starred; or the trash
  const ql = q.trim().toLowerCase();
  const filtered = type !== "all" || source !== "any" || date !== "any" || by !== "anyone";
  const global = !trashView && (!!ql || starOnly || (filtered && !cwdId));
  const atRoot = !trashView && !global && !cwdId;
  const match = useCallback((i: Item) => {
    const since = date === "any" ? 0 : date === "1" ? new Date().setHours(0, 0, 0, 0) : Date.now() - Number(date) * 864e5;
    return (!starOnly || i.starred) && (type === "all" || i.kind === type) && (source === "any" || i.src === source) && i.at >= since &&
      (by === "anyone" || (by === "gpu" ? i.src === "generated" : by === "me" ? i.byId === me?.user?.id : i.by === by.slice(2))) &&
      (!ql || `${i.name} ${i.type} ${i.j ? `${i.j.engine} ${i.j.voice} ${i.j.text}` : ""}`.toLowerCase().includes(ql));
  }, [date, starOnly, type, source, by, me, ql]);
  const cmp = useMemo(() => ({
    new: (a: Item, b: Item) => b.at - a.at, old: (a: Item, b: Item) => a.at - b.at,
    name: (a: Item, b: Item) => a.name.localeCompare(b.name, undefined, { numeric: true }), size: (a: Item, b: Item) => (b.size ?? b.seconds ?? 0) - (a.size ?? a.seconds ?? 0),
  })[sort], [sort]);
  const trashFiles = useMemo(() => allItems.filter((i) => t.trash[i.key]).sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0)), [allItems, t.trash]);
  const shownFiles = useMemo(() => {
    if (trashView) return trashFiles;
    if (atRoot) return items.filter((i) => i.folder === null).sort(cmp); // only what you put at the top yourself
    return items.filter((i) => (global || i.folder === cwdId) && match(i)).sort(cmp);
  }, [trashView, trashFiles, atRoot, items, global, cwdId, match, cmp]);
  const recent = useMemo(() => (atRoot && !filtered ? [...items].sort((a, b) => b.at - a.at).slice(0, RECENT) : []), [atRoot, filtered, items]);
  const shownFolders = useMemo(() => {
    if (trashView) return t.folders.filter((f) => t.trash[`f:${f.id}`]);
    const list = global ? liveFolders.filter((f) => (starOnly ? starred.has(`f:${f.id}`) : !!ql) && (!ql || f.name.toLowerCase().includes(ql)))
      : filtered && !cwdId ? [] : liveFolders.filter((f) => f.parent === cwdId);
    const sys = (f: Folder) => (f.system ? SYSTEM.findIndex((s) => s.id === f.id) : 99);
    return [...list].sort((a, b) => sys(a) - sys(b) || (sort === "new" ? b.created - a.created : sort === "old" ? a.created - b.created : a.name.localeCompare(b.name, undefined, { numeric: true })));
  }, [trashView, t, global, liveFolders, starOnly, starred, ql, filtered, cwdId, sort]);
  const order = useMemo(() => [...shownFolders.map((f) => `f:${f.id}`), ...shownFiles.map((i) => i.key), ...recent.map((i) => `r:${i.key}`)], [shownFolders, shownFiles, recent]);
  const firstLoad = jobs === null && !jobsErr;

  // drop selections that vanished (deleted, moved out of view)
  useEffect(() => { setSel((s) => { const n = new Set([...s].filter((k) => order.includes(k) || order.includes(`r:${k}`))); return n.size === s.size ? s : n; }); }, [order]);
  const renameNext = useRef<string | null>(null); // a folder made inside another: rename it once we're in there
  useEffect(() => { setSel(new Set()); setRenaming(renameNext.current); renameNext.current = null; }, [cwdId, trashView]);

  // a link to one file: /files#<library id> (Home, Voiceover, posts) or /files?file=m:<id> (MCP, favourites)
  useEffect(() => {
    const open = () => {
      const h = location.hash.slice(1);
      const f = new URLSearchParams(location.search).get("file");
      if (h && jobs?.some((j) => j.id === h)) setDetail(`g:${h}`);
      else if (f && byKey.has(f)) setDetail(f);
    };
    open();
    addEventListener("hashchange", open);
    return () => removeEventListener("hashchange", open);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, media.length, params]);

  // video posters: uploads made before posters existed get one, a video at a time, in the background
  useEffect(() => {
    if (!tree || !wsOn) return;
    const tried = (() => { try { return new Set(JSON.parse(sessionStorage.getItem("vb-posters-tried") ?? "[]") as string[]); } catch { return new Set<string>(); } })();
    const next = media.find((m) => m.kind === "video" && m.token && !t.posters[`m:${m.$id}`] && !local[`m:${m.$id}`] && !tried.has(m.$id));
    if (!next) return;
    let dead = false;
    const id = setTimeout(async () => {
      tried.add(next.$id);
      try { sessionStorage.setItem("vb-posters-tried", JSON.stringify([...tried])); } catch {}
      const frame = await grabFrame(mediaUrl(next));
      if (dead) return;
      if (frame) { setLocal((l) => ({ ...l, [`m:${next.$id}`]: frame })); savePoster(`m:${next.$id}`, frame); }
      else setLocal((l) => ({ ...l })); // look at the next one
    }, 1200);
    return () => { dead = true; clearTimeout(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, media, wsOn, local]);
  function savePoster(key: string, frame: string) {
    api<{ poster: string }>("files/poster", { body: { item: key, data: frame } })
      .then((r) => edit((x) => ({ ...x, posters: { ...x.posters, [key]: Date.now() }, poster_urls: { ...x.poster_urls, [key]: r.poster } }))).catch(() => null);
  }

  // ── actions
  const go = (id: string | null) => router.push(id ? `/files?folder=${id}` : "/files", { scroll: false });
  const toTrashView = () => { setQ(""); setStarOnly(false); router.push("/files?view=trash", { scroll: false }); };
  const nameOf = (k: string) => (k.startsWith("f:") ? folderById.get(k.slice(2))?.name : byKey.get(k)?.name) ?? k;
  const within = (id: string, ancestor: string) => inside(t, id, ancestor);
  const isSys = (k: string) => k.startsWith("f:") && !!folderById.get(k.slice(2))?.system;

  function newFolder(parent: string | null = cwdId, name = "Untitled folder", rename = true) {
    const id = newFolderId();
    const taken = new Set(liveFolders.filter((f) => f.parent === parent).map((f) => f.name.toLowerCase()));
    let n = name;
    for (let i = 2; taken.has(n.toLowerCase()); i++) n = `${name} ${i}`;
    const f: Folder = { id, name: n, color: (["lavender", "sky", "peach", "mint", "rose", "sand"] as const)[t.folders.length % 6], parent, created: Date.now(), by: me?.user?.name ?? null };
    write(() => { edit((x) => ({ ...x, folders: [...x.folders, f] })); if (rename) { setRenaming(`f:${id}`); setQ(""); setStarOnly(false); } },
      () => api<Folder>("files/folders", { body: { id, name: n, parent, color: f.color } }))
      .then((r) => { if (!r) edit((x) => ({ ...x, folders: x.folders.filter((y) => y.id !== id) })); });
    return id;
  }

  function moveTo(keys: string[], folder: string | null) {
    const ok = keys.filter((k) => !isSys(k) && !(k.startsWith("f:") && folder && (k.slice(2) === folder || within(folder, k.slice(2)))) && !k.startsWith("u:"));
    if (!ok.length) return toast(keys.some(isSys) ? "Category folders stay at the top." : "A folder can't go inside itself.", "bad");
    setSel(new Set());
    write(() => edit((x) => ({
      ...x, place: { ...x.place, ...Object.fromEntries(ok.filter((k) => !k.startsWith("f:")).map((k) => [k, folder ?? ROOT])) },
      folders: x.folders.map((f) => (ok.includes(`f:${f.id}`) ? { ...f, parent: folder } : f)),
    })), () => api("files/move", { body: { items: ok, folder } })).then((r) => {
      if (r) setSnack({ text: `Moved ${ok.length === 1 ? `"${nameOf(ok[0])}"` : `${ok.length} items`} to ${folder ? folderById.get(folder)?.name : "All files"}`, action: "Open", run: () => go(folder) });
    });
  }
  function autoFile(keys: string[]) {
    write(() => edit((x) => { const p = { ...x.place }; keys.forEach((k) => delete p[k]); return { ...x, place: p }; }), () => api("files/auto", { body: { items: keys } }));
  }

  function rename(key: string, name: string | null) {
    setRenaming(null);
    const old = nameOf(key);
    if (!name || name === old) return;
    if (key.startsWith("f:")) {
      write(() => edit((x) => ({ ...x, folders: x.folders.map((y) => (`f:${y.id}` === key ? { ...y, name } : y)) })), () => api(`files/folders/${key.slice(2)}`, { body: { name } })).then(changed);
      return;
    }
    const set = (n: string) => {
      if (key.startsWith("g:")) setJobs((js) => (js ?? []).map((j) => (`g:${j.id}` === key ? { ...j, label: n } : j)));
      else setMedia((ms) => ms.map((m) => (`m:${m.$id}` === key ? { ...m, name: n } : m)));
    };
    write(() => set(name), () => api("files/rename", { body: { item: key, name } })).then((r) => { if (!r) set(old); changed(); });
  }

  function recolor(id: string, color: string) {
    write(() => edit((x) => ({ ...x, folders: x.folders.map((f) => (f.id === id ? { ...f, color: color as Folder["color"] } : f)) })), () => api(`files/folders/${id}`, { body: { color } }));
  }

  function star(keys: string[], on: boolean) {
    write(() => edit((x) => ({ ...x, starred: on ? [...new Set([...x.starred, ...keys])] : x.starred.filter((k) => !keys.includes(k)) })), () => api("files/star", { body: { items: keys, on } })).then(changed);
  }

  /** To the trash, at once, with Undo. */
  function remove(keys: string[]) {
    const k = keys.filter((x) => !isSys(x) && !x.startsWith("u:"));
    if (!k.length) return toast("Category folders can't be deleted.", "bad");
    setSel(new Set());
    if (detail && k.includes(detail)) setDetail(null);
    const at = Date.now();
    write(() => edit((x) => ({ ...x, trash: { ...x.trash, ...Object.fromEntries(k.map((y) => [y, { at, by: me?.user?.name ?? null }])) } })), () => api("files/delete", { body: { items: k } }))
      .then((r) => {
        changed();
        if (r) setSnack({ text: k.length === 1 ? `"${nameOf(k[0])}" moved to the trash` : `${k.length} items moved to the trash`, action: "Undo", run: () => restore(k, true) });
      });
  }
  function restore(keys: string[], quiet = false) {
    write(() => edit((x) => { const tr = { ...x.trash }; keys.forEach((k) => delete tr[k]); return { ...x, trash: tr }; }), () => api("files/restore", { body: { items: keys } }))
      .then((r) => { changed(); if (r && !quiet) setSnack({ text: keys.length === 1 ? `"${nameOf(keys[0])}" restored` : `${keys.length} items restored` }); });
  }
  async function deleteForever(keys: string[]) {
    const names = keys.map(nameOf);
    const ok = await confirm({
      danger: true, title: keys.length === 1 ? `Delete "${names[0]}" forever?` : `Delete ${keys.length} items forever?`,
      body: <>This can&apos;t be undone. {keys.some((k) => k.startsWith("f:")) ? "Folders go with everything in them. " : ""}Uploads keep their R2 backup copy.
        {keys.length > 1 && <ul>{names.slice(0, 50).map((n, i) => <li key={i}>{n}</li>)}{names.length > 50 && <li className="dim">…and {names.length - 50} more</li>}</ul>}</>,
      confirm: keys.length === 1 ? "Delete forever" : `Delete ${keys.length} forever`,
    });
    if (!ok) return;
    setSel(new Set());
    const r = await write(() => edit((x) => ({ ...x, folders: x.folders.filter((f) => !keys.includes(`f:${f.id}`)) })), () => api<{ deleted: string[]; failed: unknown[] }>("files/delete", { body: { items: keys, forever: true } }));
    if (r) {
      setJobs((js) => (js ?? []).filter((j) => !r.deleted.includes(`g:${j.id}`)));
      setMedia((ms) => ms.filter((m) => !r.deleted.includes(`m:${m.$id}`)));
      setSnack({ text: r.failed.length ? `Deleted ${r.deleted.length}; ${r.failed.length} couldn't be. Try again.` : "Deleted forever" });
    }
  }
  async function emptyTrash() {
    const n = Object.keys(t.trash).length;
    if (!n) return;
    const ok = await confirm({ danger: true, title: `Empty the trash?`, body: `${n} item${n === 1 ? "" : "s"} (and everything in trashed folders) will be deleted forever. This can't be undone.`, confirm: "Empty trash" });
    if (!ok) return;
    const r = await write(() => {}, () => api<{ deleted: string[] }>("files/empty-trash", { body: {} }));
    if (r) {
      setJobs((js) => (js ?? []).filter((j) => !r.deleted.includes(`g:${j.id}`)));
      setMedia((ms) => ms.filter((m) => !r.deleted.includes(`m:${m.$id}`)));
      setSnack({ text: "The trash is empty" });
    }
  }

  function download(keys: string[]) {
    const list = keys.map((k) => byKey.get(k)).filter((i): i is Item => !!i && !i.key.startsWith("u:"));
    list.forEach((it, i) => setTimeout(() => {
      const a = document.createElement("a");
      a.href = downloadHref(it); a.download = ""; a.rel = "noreferrer";
      document.body.appendChild(a); a.click(); a.remove();
    }, i * 350)); // one at a time, or the browser blocks all but the first
  }

  async function copyLinks(keys: string[]) {
    const links = keys.map((k) => byKey.get(k)).filter((i): i is Item => !!i && !i.key.startsWith("u:")).map(linkOf);
    if (!links.length) return;
    try { await navigator.clipboard.writeText(links.join("\n")); setSnack({ text: links.length === 1 ? "Link copied" : `${links.length} links copied` }); }
    catch { toast("Couldn't reach the clipboard.", "bad"); }
  }

  // uploads: a card at once (with a preview from this browser), filed into the open folder once its row exists
  const placeLater = useCallback((key: string, folder: string) => {
    const p = pending.current;
    p.set(folder, [...(p.get(folder) ?? []), key]);
    edit((x) => ({ ...x, place: { ...x.place, [key]: folder } }));
    if (flushT.current) clearTimeout(flushT.current);
    busy.current++;
    flushT.current = setTimeout(async () => {
      const batches = [...p.entries()];
      p.clear();
      for (const [f, keys] of batches) await api("files/move", { body: { items: keys, folder: f } }).catch((e) => toast(`Couldn't file the upload: ${(e as Error).message}`, "bad"));
      busy.current = Math.max(0, busy.current - 1);
      loadTree();
    }, 600);
  }, [loadTree, toast]);
  const needWs = useCallback(() => toast(me?.workspace ? "Sign in with your own account to upload: uploads live in the shared workspace." : "Uploads need the shared workspace (see docs/WORKSPACE.md).", "bad"), [me, toast]);
  const sendFiles = useCallback((files: File[], folder: string | null = cwdId) => {
    if (!files.length) return;
    if (!wsOn) return needWs();
        // a category folder files things by kind anyway: only remember a folder you made
    const into = folder && !folderById.get(folder)?.system ? folder : null;
    const previews = new Map<string, string | null>();
    upload(files, (m, file, key) => {
      const k = `m:${m.$id}`;
      const pv = previews.get(key);
      if (pv) setLocal((l) => ({ ...l, [k]: pv }));
      if (into) placeLater(k, into);
      if (file.type.startsWith("video/")) {
        const save = (frame: string | null) => { if (frame) { setLocal((l) => ({ ...l, [k]: frame })); savePoster(k, frame); } };
        if (pv) save(pv); else grabFrame(file).then(save);
      }
    }, (key, file) => {
      const kind = kindOf(file.type, file.name);
      const preview = kind === "image" && file.size < 40e6 ? URL.createObjectURL(file) : null;
      previews.set(key, preview);
      setPendingUp((p) => ({ ...p, [key]: { folder: into, preview, kind, at: Date.now() } }));
      if (kind === "video") grabFrame(file).then((f) => { if (f) { previews.set(key, f); setPendingUp((p) => (p[key] ? { ...p, [key]: { ...p[key], preview: f } } : p)); } });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwdId, wsOn, needWs, upload, placeLater, folderById]);
  const upRows: UpRow[] = uploads.map((u) => ({ key: u.key, name: u.name, size: u.size, kind: u.kind, progress: u.progress, error: u.error && !u.done ? u.error : undefined, done: u.done,
    folder: pendingUp[u.key]?.folder ? folderById.get(pendingUp[u.key].folder!)?.name ?? "All files" : SYSTEM.find((s) => s.kind === u.kind)?.name ?? "All files" }));

  function importLink(url: string) {
    if (!wsOn) return needWs();
    setSnack({ text: "Adding the file from the link…" });
    write(() => {}, () => api<{ folder: string | null }>("files/import", { body: { url, folder: cwdId && !here?.system ? cwdId : null } })).then((r) => { if (r) setSnack({ text: "Added from the link" }); });
  }

  async function subtitle(j: { id: string; label?: string; language?: string | null; text?: string }) {
    if (!status?.online) return toast("The GPU worker is offline. Start the Colab notebook first.", "bad");
    try {
      await api("jobs", { body: { kind: "transcribe", library: j.id, language: j.language || undefined } });
      setSubNote(`Subtitling "${j.label || j.text || j.id}"… it shows a CC badge when done (follow it in the jobs tray).`);
    } catch (e) { toast((e as Error).message, "bad"); }
  }

  function play(it: Item) {
    if (playing === it.key) { player.current?.pause(); setPlaying(null); return; }
    player.current?.pause();
    const a = new Audio(it.audio!);
    a.onended = () => setPlaying((p) => (p === it.key ? null : p));
    a.play().catch(() => toast("Couldn't play that file.", "bad"));
    player.current = a;
    setPlaying(it.key);
  }
  useEffect(() => () => player.current?.pause(), []);

  function open(key: string) {
    if (key.startsWith("u:")) return;
    if (key.startsWith("f:")) { if (trashView) return; setQ(""); setStarOnly(false); go(key.slice(2)); return; }
    if (trashView) return;
    setDetail(key);
  }
  function toggle(key: string, shift: boolean) {
    const from = anchor.current; // read now: the updater below runs later, after the anchor has moved
    setSel((prev) => {
      const next = new Set(prev);
      const ord = order.map((k) => k.replace(/^r:/, ""));
      if (shift && from && ord.includes(from)) {
        const [a, b] = [ord.indexOf(from), ord.indexOf(key)].sort((x, y) => x - y);
        ord.slice(a, b + 1).forEach((x) => next.add(x));
      } else if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    anchor.current = key;
  }
  /** A click opens; with a modifier, once anything is selected, or in the trash, it selects. */
  function click(key: string, e: React.MouseEvent) {
    if (renaming === key) return;
    if (e.shiftKey || e.metaKey || e.ctrlKey || sel.size || trashView) toggle(key, e.shiftKey);
    else open(key);
  }

  // ── keyboard and the clipboard
  useEffect(() => {
    const typing = (el: EventTarget | null) => !!(el as HTMLElement)?.closest?.("input:not([type=checkbox]), textarea, [contenteditable=true]");
    const overlay = () => !!document.querySelector(".modal, .lightbox, .fm-drawer, .palette");
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "f" && !overlay()) { e.preventDefault(); search.current?.focus(); search.current?.select(); return; }
      if (typing(e.target) || overlay() || menu) return;
      const ord = order.map((k) => k.replace(/^r:/, ""));
      if (e.key === "Escape" && (sel.size || cut.length)) { setSel(new Set()); setCut([]); }
      if (mod && e.key.toLowerCase() === "a" && ord.length) { e.preventDefault(); setSel(new Set(ord)); }
      if (trashView) {
        if ((e.key === "Delete" || e.key === "Backspace") && sel.size) { e.preventDefault(); deleteForever([...sel]); }
        return;
      }
      if (mod && e.key.toLowerCase() === "x" && sel.size) { e.preventDefault(); setCut([...sel]); setSnack({ text: `${sel.size} item${sel.size === 1 ? "" : "s"} cut: open a folder and paste (${isMac() ? "⌘" : "Ctrl+"}V)` }); }
      if (mod && e.key.toLowerCase() === "c" && sel.size && !window.getSelection()?.toString()) { e.preventDefault(); copyLinks([...sel].filter((k) => !k.startsWith("f:"))); }
      if (mod && e.key.toLowerCase() === "v" && cut.length) { e.preventDefault(); const c = cut; setCut([]); moveTo(c, cwdId); }
      if ((e.key === "Delete" || e.key === "Backspace") && sel.size) { e.preventDefault(); remove([...sel]); }
      if (e.key === "F2" && sel.size === 1) { e.preventDefault(); setRenaming([...sel][0]); }
      if (e.key === "Enter" && sel.size === 1 && document.activeElement === document.body) { e.preventDefault(); open([...sel][0]); }
    };
    const onPaste = (e: ClipboardEvent) => {
      if (typing(e.target) || overlay() || trashView) return;
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length) {
        e.preventDefault();
        const d = new Date(), p2 = (n: number) => String(n).padStart(2, "0");
        const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} at ${p2(d.getHours())}.${p2(d.getMinutes())}.${p2(d.getSeconds())}`;
        // a pasted screenshot arrives as "image.png": give it a name worth keeping
        sendFiles(files.map((f, i) => (/^image\.(png|jpe?g|gif|webp)$/i.test(f.name) ? new File([f], `Pasted image ${stamp}${files.length > 1 ? ` ${i + 1}` : ""}.${f.name.split(".").pop()}`, { type: f.type }) : f)));
        return;
      }
      const text = e.clipboardData?.getData("text/plain")?.trim() ?? "";
      if (/^https?:\/\/\S+$/i.test(text)) { e.preventDefault(); importLink(text); }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("paste", onPaste);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("paste", onPaste); };
  });

  // ── drag and drop
  function dragStart(key: string, e: React.DragEvent) {
    if (trashView || key.startsWith("u:")) { e.preventDefault(); return; }
    const keys = sel.has(key) ? [...sel] : [key];
    e.dataTransfer.setData(DT, JSON.stringify(keys));
    e.dataTransfer.effectAllowed = "move";
    if (keys.length > 1) {
      const ghost = document.createElement("div");
      ghost.className = "fm-ghost";
      ghost.textContent = `${keys.length} items`;
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 20, 18);
      setTimeout(() => ghost.remove(), 0);
    }
    setDragging(keys);
  }
  const canDrop = (target: string | null) => !dragging || dragging.every((k) => !(k.startsWith("f:") && target && within(target, k.slice(2))));
  const dropOn = (target: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      const internal = e.dataTransfer.types.includes(DT), os = e.dataTransfer.types.includes("Files");
      if ((!internal && !os) || trashView) return;
      if (internal && !canDrop(target)) return;
      e.preventDefault(); e.stopPropagation();
      e.dataTransfer.dropEffect = internal ? "move" : "copy";
      setOver(target ?? "root"); setOsDrag(false);
    },
    onDragLeave: () => setOver((o) => (o === (target ?? "root") ? null : o)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault(); e.stopPropagation();
      setOver(null); setOsDrag(false);
      const raw = e.dataTransfer.getData(DT);
      if (raw) { const keys = (JSON.parse(raw) as string[]).filter((k) => k !== `f:${target}`); setDragging(null); if (keys.length) moveTo(keys, target); }
      else if (e.dataTransfer.files.length) sendFiles([...e.dataTransfer.files], target);
    },
  });

  // ── the menu for one item or the selection
  function menuFor(keys: string[]): { title: string; entries: MenuEntry[] } {
    const many = keys.length > 1;
    const k = keys[0];
    if (trashView) return {
      title: many ? `${keys.length} items` : nameOf(k),
      entries: [{ label: "Restore", icon: <ArrowCounterClockwise size={16} />, run: () => restore(keys) }, "-",
        { label: many ? `Delete ${keys.length} forever` : "Delete forever", icon: <TrashSimple size={16} />, danger: true, run: () => deleteForever(keys) }],
    };
    if (k.startsWith("u:")) return { title: nameOf(k), entries: [{ label: "Uploading…", icon: <UploadSimple size={16} />, run: () => {} }] };
    const allStarred = keys.every((x) => starred.has(x));
    const fileKeys = keys.filter((x) => !x.startsWith("f:"));
    const sys = keys.some(isSys);
    const common: MenuEntry[] = [
      ...(many ? [] : [{ label: sel.has(k) ? "Deselect" : "Select", icon: <CheckSquare size={16} />, run: () => toggle(k, false) }]),
      ...(sys ? [] : [{ label: "Move to…", icon: <FolderSimple size={16} />, run: () => setMoving(keys) },
        { label: "Cut", icon: <Scissors size={16} />, kbd: isMac() ? "⌘X" : "Ctrl+X", run: () => { setCut(keys); setSnack({ text: "Cut: open a folder and paste to move" }); } }]),
      { label: allStarred ? "Remove star" : "Star", icon: <Star size={16} />, run: () => star(keys, !allStarred) },
    ];
    if (many) return {
      title: `${keys.length} items`,
      entries: [...common, ...(fileKeys.length ? [{ label: `Download ${fileKeys.length}`, icon: <DownloadSimple size={16} />, run: () => download(fileKeys) }, { label: "Copy links", icon: <LinkSimple size={16} />, run: () => copyLinks(fileKeys) }] : []),
        ...(sys ? [] : ["-" as const, { label: `Move ${keys.length} to the trash`, icon: <TrashSimple size={16} />, danger: true, run: () => remove(keys) }])],
    };
    if (k.startsWith("f:")) {
      const f = folderById.get(k.slice(2))!;
      return {
        title: f.name,
        entries: [{ label: "Open", icon: <FolderOpen size={16} />, run: () => open(k) }, { label: "Rename", icon: <PencilSimple size={16} />, kbd: "F2", run: () => setRenaming(k) },
          { label: "New folder inside", icon: <FolderPlus size={16} />, run: () => { renameNext.current = `f:${newFolder(f.id, "Untitled folder", false)}`; go(f.id); } },
          ...common, { colors: f.color, pick: (c) => recolor(f.id, c) },
          ...(f.system ? [] : ["-" as const, { label: "Move to the trash", icon: <TrashSimple size={16} />, danger: true, run: () => remove(keys) }])],
      };
    }
    const it = byKey.get(k)!;
    const home = SYSTEM.find((s) => s.kind === it.kind)!;
    return {
      title: it.name,
      entries: [
        { label: "Open", icon: <ArrowSquareOut size={16} />, run: () => open(k) },
        { label: "Rename", icon: <PencilSimple size={16} />, kbd: "F2", run: () => setRenaming(k) },
        ...common,
        ...(it.placed && it.folder !== home.id ? [{ label: `Put back in ${folderById.get(home.id)?.name ?? home.name}`, icon: <FolderSimple size={16} />, run: () => autoFile([k]) }] : []),
        { label: "Download", icon: <DownloadSimple size={16} />, run: () => download(keys) },
        { label: "Copy link", icon: <Copy size={16} />, kbd: isMac() ? "⌘C" : "Ctrl+C", run: () => copyLinks(keys) },
        ...(it.post ? [{ label: "Open its post", icon: <ArrowSquareOut size={16} />, run: () => router.push(`/posts?post=${it.post}`) }] : []),
        ...(it.j && (!it.j.kind || it.j.kind === "tts") && !it.j.subs ? [{ label: "Add subtitles", icon: <ClosedCaptioning size={16} />, run: () => subtitle(it.j!) }] : []),
        ...(it.folder !== cwdId ? [{ label: "Show in folder", icon: <FolderOpen size={16} />, run: () => { setQ(""); setStarOnly(false); go(it.folder); } }] : []),
        "-",
        { label: "Move to the trash", icon: <TrashSimple size={16} />, danger: true, kbd: "Del", run: () => remove(keys) },
      ],
    };
  }
  const openMenu = (key: string, at: Anchor) => {
    const keys = sel.has(key) && sel.size > 1 ? [...sel] : [key];
    if (!sel.has(key) && sel.size) setSel(new Set());
    setMenu({ at, keys });
  };

  const events = (key: string) => ({
    selected: sel.has(key), selecting: sel.size > 0, renaming: renaming === key, dim: cut.includes(key) || !!dragging?.includes(key),
    onOpen: (e: React.MouseEvent) => click(key, e), onToggle: (shift: boolean) => toggle(key, shift), onMenu: (at: Anchor) => openMenu(key, at),
    onRename: (n: string | null) => rename(key, n), onDragStart: (e: React.DragEvent) => dragStart(key, e), onDragEnd: () => { setDragging(null); setOver(null); },
  });

  // the detail drawer loads the whole job (every line) when it opens; the card shows at once from the summary
  const detailItem = detail ? byKey.get(detail) ?? null : null;
  useEffect(() => {
    const id = detailItem?.j?.id;
    if (!id || full[id]) return;
    api<LibJob>(`library/${id}`).then((j) => setFull((f) => ({ ...f, [id]: j }))).catch((e) => toast((e as Error).message, "bad"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailItem?.j?.id]);
  const closeDetail = () => {
    setDetail(null);
    if (location.hash || params.get("file")) history.replaceState(null, "", `/files${cwdId ? `?folder=${cwdId}` : ""}`);
  };
  useEffect(() => {
    if (!detailItem?.m) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector(".modal")) closeDetail(); }; // the viewer closes on Escape too
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  const totalBytes = items.reduce((s, i) => s + (i.size ?? 0), 0);
  const trashCount = Object.keys(t.trash).length;
  const selFiles = [...sel].filter((k) => !k.startsWith("f:"));
  const ord = order.map((k) => k.replace(/^r:/, ""));
  const selAll = ord.length > 0 && ord.every((k) => sel.has(k));
  const mod = isMac() ? "⌘" : "Ctrl";
  const grid = (list: Item[], prefix = "") => view === "grid" ? (
    <div className="fm-grid">{list.map((it) => <FileCard key={prefix + it.key} it={it} playing={playing === it.key} onPlay={() => play(it)} {...events(it.key)} />)}</div>
  ) : (
    <div className="fm-list">
      <div className="frow fr-head" aria-hidden><span /><span /><span>Name</span><span className="fr-col fr-type">Type</span><span className="fr-col fr-size">Size</span><span className="fr-col fr-by">Added by</span><span className="fr-col fr-at">{trashView ? "Deleted" : "Added"}</span><span /></div>
      {list.map((it) => <FileRow key={prefix + it.key} it={it} folderName={(global || prefix) && it.folder !== cwdId ? pathName(it.folder) : undefined} {...events(it.key)} />)}
    </div>
  );

  return (
    <div className={`fm ${sel.size ? "selecting" : ""}`}
      onDragOver={(e) => { if (!trashView && e.dataTransfer.types.includes("Files") && !e.dataTransfer.types.includes(DT)) { e.preventDefault(); setOsDrag(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) { setOsDrag(false); setOver(null); } }}
      onDrop={(e) => { if (!trashView && e.dataTransfer.files.length && !e.dataTransfer.types.includes(DT)) { e.preventDefault(); setOsDrag(false); sendFiles([...e.dataTransfer.files]); } }}>
      <input ref={input} type="file" multiple hidden onChange={(e) => { if (e.target.files?.length) sendFiles([...e.target.files]); e.target.value = ""; }} />
      <PageHeader title={trashView ? "Trash" : "Files"} sub={trashView ? "Deleted things wait here for 30 days, then they're gone for good." : "Every upload and everything the GPU made, sorted by kind. Drop, paste or drag files anywhere."}
        actions={trashView ? <>
          <button className="ghost" onClick={() => go(null)}><FolderSimple size={15} weight="duotone" />Back to files</button>
          <button className="danger" onClick={emptyTrash} disabled={!trashCount}><TrashSimple size={15} weight="bold" />Empty trash</button>
        </> : <>
          <button className="ghost" onClick={() => newFolder()}><FolderPlus size={15} weight="duotone" />New folder</button>
          <button onClick={() => (wsOn ? input.current?.click() : needWs())}><UploadSimple size={15} weight="bold" />Upload</button>
        </>} />

      {me && !wsOn && !trashView && (
        <Notice icon={<UsersThree size={18} />} action={me.workspace ? <button className="sm" onClick={async () => { await signOut(); location.href = "/login"; }}>Sign in</button> : undefined}>
          {me.workspace ? <><b>Shared uploads are hidden.</b> Sign in with your own account to see and add them; generated files are all here.</>
            : <><b>Shared uploads aren&apos;t set up.</b> Generated files are here; uploads appear once the workspace is connected (docs/WORKSPACE.md).</>}
        </Notice>
      )}
      {subNote && <Notice icon={<ClosedCaptioning size={18} />} action={<button className="icon-btn sm" aria-label="Dismiss" onClick={() => setSubNote("")}><X size={14} /></button>}>{subNote}</Notice>}

      {!trashView && (
        <div className="fm-bar">
          <div className="fm-search">
            <MagnifyingGlass size={16} className="ic" aria-hidden />
            <input ref={search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" aria-label="Search every file and folder"
              onKeyDown={(e) => { if (e.key === "Escape") { setQ(""); e.currentTarget.blur(); } }} />
            {q ? <button className="icon-btn xs" aria-label="Clear search" onClick={() => setQ("")}><X size={13} /></button>
              : <span className="fm-kbd" aria-hidden><kbd>{mod === "⌘" ? "⌘" : "Ctrl"}</kbd><kbd>F</kbd></span>}
          </div>
          <div className="fm-pills" role="toolbar" aria-label="Filters">
            <FilterPill label="Type" value={type} options={TYPES} onChange={setType} />
            <FilterPill label="Source" value={source} options={SOURCES} onChange={setSource} />
            <FilterPill label="Date" value={date} options={DATES} onChange={setDate} />
            <FilterPill label="Added by" value={by} options={BY} onChange={setBy} />
            <button type="button" className={`fpill ${starOnly ? "on" : ""}`} aria-pressed={starOnly} onClick={() => setStarOnly((s) => !s)}><Star size={13} weight={starOnly ? "fill" : "regular"} />Starred</button>
            {filtered && <button type="button" className="fpill quiet" onClick={() => { setType("all"); setSource("any"); setDate("any"); setBy("anyone"); }}>Clear</button>}
          </div>
          <div className="fm-tools">
            <button ref={sortBtn} type="button" className="icon-btn boxed" aria-label={`Sort: ${SORTS.find((s) => s[0] === sort)?.[1]}`} title="Sort" aria-haspopup="menu"
              onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setSortAt(sortAt ? null : { x: r.left, y: r.top, w: r.width, h: r.height, align: "end" }); }}><ArrowsDownUp size={16} /></button>
            {sortAt && <ContextMenu at={sortAt} title="Sort" inside={sortBtn} onClose={() => setSortAt(null)} entries={SORTS.map(([v, l]) => ({ label: l, icon: v === sort ? <Check size={14} weight="bold" /> : <span style={{ width: 14 }} />, run: () => setSort(v) }))} />}
            <div className="seg fm-view" role="radiogroup" aria-label="View">
              <button role="radio" aria-checked={view === "grid"} className={view === "grid" ? "on" : ""} onClick={() => pickView("grid")} aria-label="Grid" title="Grid"><SquaresFour size={15} /></button>
              <button role="radio" aria-checked={view === "list"} className={view === "list" ? "on" : ""} onClick={() => pickView("list")} aria-label="List" title="List"><ListBullets size={15} /></button>
            </div>
            <button type="button" className="icon-btn boxed" aria-label="Refresh" title="Refresh" onClick={() => { loadJobs(); loadTree(); }}><ArrowClockwise size={16} /></button>
          </div>
        </div>
      )}

      <nav className="fm-path" aria-label="Folder path">
        <button type="button" className={`fm-crumb ${over === "root" ? "over" : ""}`} aria-current={atRoot ? "page" : undefined} onClick={() => { setQ(""); setStarOnly(false); go(null); }} {...dropOn(null)}>All files</button>
        {!global && !trashView && path.map((f) => (
          <span key={f.id} className="row" style={{ gap: 4, flexWrap: "nowrap", minWidth: 0 }}>
            <CaretRight size={12} className="dim" aria-hidden />
            <button type="button" className={`fm-crumb ${over === f.id ? "over" : ""}`} aria-current={f.id === cwdId ? "page" : undefined} onClick={() => go(f.id)} {...dropOn(f.id)}>{f.name}</button>
          </span>
        ))}
        {global && <><CaretRight size={12} className="dim" aria-hidden /><span className="fm-crumb static">{ql ? `Results for “${q.trim()}”` : starOnly ? "Starred" : "Filtered"}</span></>}
        {trashView && <><CaretRight size={12} className="dim" aria-hidden /><span className="fm-crumb static">Trash</span></>}
        <span className="fm-usage tiny dim mono">{items.length} files · {(totalBytes / 1e9).toFixed(2)} GB</span>
        {!trashView && <button type="button" className="fm-trash-btn" onClick={toTrashView} aria-label={`Trash, ${trashCount} item${trashCount === 1 ? "" : "s"}`}><Trash size={15} weight="duotone" />Trash{trashCount > 0 && <span className="fm-count sm">{trashCount}</span>}</button>}
      </nav>

      {cut.length > 0 && (
        <Notice icon={<Scissors size={18} />} action={<span className="row" style={{ gap: 6 }}>
          <button className="sm" onClick={() => { const c = cut; setCut([]); moveTo(c, cwdId); }}>Paste here</button>
          <button className="ghost sm" onClick={() => setCut([])}>Cancel</button></span>}>
          <b>{cut.length} item{cut.length === 1 ? "" : "s"} cut.</b> Open a folder and paste ({mod}+V) to move {cut.length === 1 ? "it" : "them"} there.
        </Notice>
      )}

      {sel.size > 0 && (
        <div className="selbar" role="region" aria-label="Selection">
          <input type="checkbox" className="selbox" checked={selAll} ref={(el) => { if (el) el.indeterminate = !selAll && sel.size > 0; }} onChange={() => setSel(selAll ? new Set() : new Set(ord))} aria-label="Select everything shown" />
          <b>{sel.size} selected</b>
          <button className="quiet xs" onClick={() => setSel(new Set())}><X size={12} />Clear</button>
          <span className="faint tiny fm-hint" style={{ flex: 1 }}>{trashView ? "Restore brings them back where they were" : "Drag onto a folder to move · Shift-click selects a range · Esc clears"}</span>
          <span className="row" style={{ gap: 6 }}>
            {trashView ? <>
              <button className="quiet xs" onClick={() => restore([...sel])}><ArrowCounterClockwise size={13} />Restore</button>
              <button className="danger sm" onClick={() => deleteForever([...sel])}><TrashSimple size={14} weight="bold" />Delete forever</button>
            </> : <>
              <button className="quiet xs" onClick={() => setMoving([...sel])}><FolderSimple size={13} />Move</button>
              <button className="quiet xs" onClick={() => star([...sel], ![...sel].every((k) => starred.has(k)))}><Star size={13} />Star</button>
              {selFiles.length > 0 && <button className="quiet xs" onClick={() => download(selFiles)}><DownloadSimple size={13} />Download</button>}
              <button className="danger sm" onClick={() => remove([...sel])}><TrashSimple size={14} weight="bold" />Delete</button>
            </>}
          </span>
        </div>
      )}

      {jobsErr && <p className="err">Generated files couldn&apos;t load: {jobsErr}</p>}

      {firstLoad ? (
        <>
          <div className="fm-sec-h"><h2>Folders</h2></div>
          <div className="fm-folders fm-skel-row" aria-busy>{SYSTEM.slice(0, 4).map((s) => <div key={s.id} className={`fold c-${s.color} fold-skel`}><span className="fold-tab" /><span className="fold-back" /><div className="fold-front"><div className="fold-name"><span className="fold-title">{s.name}</span></div><div className="fold-foot" /></div></div>)}</div>
          <div className="fm-skel" style={{ marginTop: 36 }}><div className="skel" /><div className="skel" /><div className="skel" /><div className="skel" /></div>
        </>
      ) : (
        <>
          {(shownFolders.length > 0 || (!global && !filtered && !trashView)) && (
            <section className="fm-sec" aria-labelledby="fm-folders">
              <div className="fm-sec-h"><h2 id="fm-folders">Folders <span className="fm-count">{shownFolders.length}</span></h2></div>
              {view === "grid" ? (
                <div className="fm-folders">
                  {shownFolders.map((f) => (
                    <FolderCard key={f.id} f={f} count={trashView ? trashedCount(f.id) : counts.get(f.id) ?? 0} people={peopleIn(f.id)} over={over === f.id} starred={starred.has(`f:${f.id}`)} {...events(`f:${f.id}`)} {...dropOn(f.id)} />
                  ))}
                  {!global && !trashView && <NewFolderCard onClick={() => newFolder()} />}
                </div>
              ) : (
                <div className="fm-list">
                  {shownFolders.map((f) => <FolderRow key={f.id} f={f} count={trashView ? trashedCount(f.id) : counts.get(f.id) ?? 0} over={over === f.id} starred={starred.has(`f:${f.id}`)} {...events(`f:${f.id}`)} {...dropOn(f.id)} />)}
                  {!global && !trashView && <button type="button" className="frow fr-new" onClick={() => newFolder()}><span className="fr-thumb"><FolderPlus size={16} weight="duotone" /></span>New folder</button>}
                </div>
              )}
            </section>
          )}

          {recent.length > 0 && (
            <section className="fm-sec" aria-labelledby="fm-recent">
              <div className="fm-sec-h"><h2 id="fm-recent">Recent <span className="fm-count">{recent.length}</span></h2></div>
              {grid(recent, "r:")}
            </section>
          )}

          {(shownFiles.length > 0 || !atRoot) && (
            <section className="fm-sec" aria-labelledby="fm-files">
              <div className="fm-sec-h"><h2 id="fm-files">{trashView ? "Files" : atRoot ? "In All files" : "Files"} <span className="fm-count">{shownFiles.length}</span></h2></div>
              {shownFiles.length > 0 ? grid(shownFiles) : trashView ? (
                <div className="empty"><Trash size={26} weight="duotone" /><b>{shownFolders.length ? "No loose files in the trash" : "The trash is empty"}</b><span>Anything you delete waits here for 30 days.</span></div>
              ) : global || filtered ? (
                <div className="empty"><MagnifyingGlass size={22} /><b>Nothing matches</b><span>Try another word or filter.</span>
                  <button className="ghost sm" onClick={() => { setQ(""); setStarOnly(false); setType("all"); setSource("any"); setDate("any"); setBy("anyone"); }}>Clear search and filters</button></div>
              ) : (
                <button type="button" className={`drop fm-drop ${over === (cwdId ?? "root") ? "over" : ""}`} onClick={() => (wsOn ? input.current?.click() : needWs())} {...dropOn(cwdId)}>
                  <span className="d-ic"><UploadSimple size={22} weight="duotone" /></span>
                  <b>{here?.system ? `No ${here.name.toLowerCase()} yet` : "This folder is empty"}</b>
                  <span>Drop files here, paste a photo or a link, or drag files in from another folder.</span>
                  {!items.length && <Link href="/voiceover" className="btn ghost sm" onClick={(e) => e.stopPropagation()}>Or make a voiceover</Link>}
                </button>
              )}
            </section>
          )}
        </>
      )}

      {osDrag && <div className="page-drop">Drop to upload to {here && !here.system ? here.name : "Files (sorted by kind)"}</div>}

      {menu && (() => { const m = menuFor(menu.keys); return <ContextMenu at={menu.at} title={m.title} entries={m.entries} onClose={() => setMenu(null)} />; })()}

      {moving && (
        <MoveDialog folders={liveFolders} moving={moving} from={moving.length === 1 && !moving[0].startsWith("f:") ? byKey.get(moving[0])?.folder ?? null : moving.length === 1 ? folderById.get(moving[0].slice(2))?.parent ?? null : cwdId}
          onClose={() => setMoving(null)} onMove={(to) => { const m = moving; setMoving(null); moveTo(m, to); }}
          onCreate={async (name, parent) => newFolder(parent, name, false)} />
      )}

      {detailItem?.m && (
        <MediaViewer m={detailItem.m} onClose={closeDetail} onDelete={() => { const k = detailItem.key; closeDetail(); remove([k]); }} />
      )}
      {detailItem?.j && (
        <>
          <div className="scrim" onClick={closeDetail} />
          <DetailDrawer it={detailItem} job={full[detailItem.j.id]} onClose={closeDetail} onRename={() => { closeDetail(); setRenaming(detailItem.key); }} onMove={() => setMoving([detailItem.key])}
            onStar={() => star([detailItem.key], !detailItem.starred)} folderName={pathName(detailItem.folder)}
            onDelete={() => { const k = detailItem.key; closeDetail(); remove([k]); }} onSubtitle={() => subtitle(detailItem.j!)} />
        </>
      )}

      {<UploadPanel rows={upRows} onClose={clearUploads} onOpenFolder={(name) => { const f = liveFolders.find((x) => x.name === name); go(f?.id ?? null); }} />}
      {snack && <Snack text={snack.text} action={snack.action} onAction={snack.run} onClose={() => setSnack(null)} />}
    </div>
  );
}

/** A folder whose parent chain is broken (its parent was deleted for good): shown nowhere until it's moved. */
function folderGone(t: FileTree, f: Folder) {
  for (let cur: Folder | undefined = f, n = 0; cur && n < 64; n++) {
    if (!cur.parent) return false;
    cur = t.folders.find((x) => x.id === cur!.parent);
  }
  return true;
}

/** A generated item in full (its player, lines, scores and downloads), in a drawer over the files. */
function DetailDrawer({ it, job, folderName, onClose, onRename, onMove, onStar, onDelete, onSubtitle }: {
  it: Item; job?: LibJob; folderName: string; onClose: () => void; onRename: () => void; onMove: () => void; onStar: () => void; onDelete: () => void; onSubtitle: () => void;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector(".modal")) onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <aside className="drawer fm-drawer" role="dialog" aria-label={it.name}>
      <div className="row between" style={{ marginBottom: 14, flexWrap: "nowrap" }}>
        <div style={{ minWidth: 0 }}>
          <div className="tiny dim">{it.type} · in {folderName}</div>
          <h2 className="ellipsis" style={{ display: "block", fontSize: 18 }}>{it.name}</h2>
        </div>
        <span className="row" style={{ gap: 2, flexWrap: "nowrap" }}>
          <button className="icon-btn" aria-label={it.starred ? "Remove star" : "Star"} title={it.starred ? "Remove star" : "Star"} onClick={onStar}><Star size={17} weight={it.starred ? "fill" : "regular"} className={it.starred ? "fm-star" : ""} /></button>
          <button className="icon-btn" aria-label="Rename" title="Rename" onClick={onRename}><PencilSimple size={17} /></button>
          <button className="icon-btn" aria-label="Move to a folder" title="Move to…" onClick={onMove}><FolderSimple size={17} /></button>
          <button className="icon-btn" aria-label="Close" title="Close (Esc)" onClick={onClose}><X size={17} /></button>
        </span>
      </div>
      {it.cover && !job && <img className="fm-drawer-cover" src={it.cover} alt="" />}
      <div className="lib-list">
        {!job ? <div className="skel" style={{ height: 120, margin: 12 }} aria-busy />
          : job.kind === "image" ? <ImageCard j={job} open onDelete={onDelete} />
          : job.kind === "video" ? <VideoCard j={job} open onDelete={onDelete} />
          : <JobCard j={job} open onDelete={onDelete} onSubtitle={onSubtitle} />}
      </div>
    </aside>
  );
}
