"use client";
// Files: a file manager like Google Drive over everything you have. Uploads (the shared workspace, Appwrite) and
// generated items (takes, subtitles, images and videos the GPU made, in R2) sit side by side. Five category folders
// file everything by kind on their own (Videos, Images, Audio, Docs & scripts, Other); your folders sit beside them
// (lib/filetree.ts). Upload with the button, by dropping files anywhere or by pasting (a photo, files or a link); drag
// cards onto a folder or the path to move them; right-click or ⋮ for the rest. Deleting moves things to the trash for
// 30 days (with Undo). Everything changes on screen at once and is saved behind it; the last listing is kept in this
// browser so the page opens instantly. Keys: ⌘F search, ⌘A select all, ⌘C copy links, ⌘X then ⌘V move, F2 rename,
// Delete, Esc. A post's photos stack as one carousel card (components/Carousel.tsx): it opens onto a curved row, each
// photo opens full size, and [ ] jump between posts. Parts in fileparts.tsx; rules in docs/DESIGN.md.
import {
  ArrowClockwise, ArrowCounterClockwise, ArrowSquareOut, ArrowsDownUp, CaretRight, Check, CheckSquare, ClosedCaptioning, Copy, DownloadSimple, FolderOpen,
  FolderPlus, FolderSimple, LinkSimple, ShareNetwork, ListBullets, MagnifyingGlass, PencilSimple, Scissors, SquaresFour, StackMinus, StackPlus, Star, Trash, TrashSimple,
  UploadSimple, UsersThree, X, Cards, RocketLaunch, PaperPlaneTilt, InstagramLogo, YoutubeLogo,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { folderFor, folderTrashed, isTrashed, newFolderId, normalize, ROOT, subtree, SYSTEM, within as inside, type FileTree, type Folder } from "@/lib/filetree";
import { groupsOf, visual, type Carousel, type Group } from "@/lib/carouselrules";
import type { SpaceId } from "@/lib/spaces";
import { fileUrl as mediaUrl, kindOf, screenPreview, libKind, libName, libType, type Media, type MediaKind, type Post } from "@/lib/workspace";
import { api, fileUrl as libFileUrl } from "./api";
import { Query, signOut, useLive, useMe } from "./aw";
import { useDialog } from "./Dialog";
import {
  ContextMenu, DT, FileCard, FileRow, FilterPill, FolderCard, FolderRow, MoveDialog, NewFolderCard, Snack, UploadPanel,
  type Anchor, type Item, type JobSum, type MenuEntry, type UpRow,
} from "./fileparts";
import { CarouselCard, CarouselRow, CarouselStage, CarouselStrip, countOf, isStack, type Checks, type Stack, type Stats } from "./Carousel";
import { Composer } from "./Publish";
import { UploadOverlay } from "./UploadOverlay";
import { planFor, usePublish } from "./usePublish";
import { ImageCard, JobCard, VideoCard, type LibJob } from "./Library";
import { useStatus } from "./Shell";
import { Notice, PageHeader } from "./ui";
import { useUploader } from "./wsparts";
import { FileViewer, type ViewFile } from "./Viewer";
import { ShareDialog } from "./filetools";
import { useSmartSearch } from "./smartsearch";

type Sort = "new" | "old" | "name" | "size";
type Tree = FileTree & { poster_urls?: Record<string, string>; carousels?: Carousel[] };
type Entry = Item | Stack;
const COLORS = [["any", "Any"], ["red", "Red"], ["orange", "Orange"], ["yellow", "Yellow"], ["green", "Green"], ["teal", "Teal"], ["blue", "Blue"], ["purple", "Purple"], ["pink", "Pink"], ["brown", "Brown"], ["black", "Black"], ["white", "White"], ["grey", "Grey"]] as const;
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

/** An upload as the viewer shows it. */
function viewFile(it: Item): ViewFile {
  const m = it.m!;
  return { key: it.key, name: it.name, kind: it.kind, mime: m.mime, size: m.size, url: mediaUrl(m), download: mediaUrl(m, "download"), poster: it.kind === "video" ? it.cover : null, by: it.by, at: it.at,
    preview: it.kind === "image" && m.token ? screenPreview(m) : null };
}
function StarBtn({ on, onClick }: { on: boolean; onClick: () => void }) {
  return <button className="vp-btn" onClick={onClick} aria-label={on ? "Remove star" : "Star"} aria-pressed={on} title={on ? "Remove star" : "Star"}><Star size={19} weight={on ? "fill" : "regular"} className={on ? "fm-star" : ""} /></button>;
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
  const { rows: posts } = useLive<Post>("posts", [Query.orderDesc("$updatedAt"), Query.limit(500)]); // names a post's carousel

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
  const [color, setColor] = useState<(typeof COLORS)[number][0]>("any");
  const [smart, setSmart] = useState<Map<string, number> | null>(null); // photos that fit the search's meaning (components/smartsearch.ts)
  const [sharing, setSharing] = useState<{ kind: "carousel" | "folder"; ref: string; name: string } | null>(null);
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
  const [dragN, setDragN] = useState(0); // how many files are being dragged in
  const [upOpen, setUpOpen] = useState(false); // the upload overlay
  const [playing, setPlaying] = useState<string | null>(null);
  const [sortAt, setSortAt] = useState<Anchor | null>(null);
  const [subNote, setSubNote] = useState("");
  const [snack, setSnack] = useState<{ text: string; action?: string; run?: () => void } | null>(null);
  const [stage, setStage] = useState<{ id: string; at?: number } | null>(null); // an open carousel
  const [cv, setCv] = useState<{ id: string; i: number } | null>(null); // one of its photos, full size
  const [checks, setChecks] = useState<Record<string, Checks>>({}); // slide checks per carousel, once it's opened
  const [stats, setStats] = useState<Record<string, Stats>>({}); // Instagram numbers per posted carousel
  const [compose, setCompose] = useState<{ id: string; post: Post; space: SpaceId } | null>(null); // the composer on a carousel's or a video's post
  const [igBusy, setIgBusy] = useState<string | null>(null); // a carousel or file being set up to post (one click at a time)
  const { accounts } = usePublish();
  const anchor = useRef<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const sortBtn = useRef<HTMLButtonElement>(null);
  const player = useRef<HTMLAudioElement | null>(null);
  const pending = useRef<Map<string, string[]>>(new Map());
  const flushT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busy = useRef(0); // writes in flight: a background refresh mustn't undo what's on screen

  const media = liveMedia.length || !mediaLoading ? liveMedia : cachedMedia;

  // ── data: the cached listing at once, then the fresh one
  const loadJobs = useCallback(() => api<{ jobs: JobSum[] }>("files/items").then((r) => { setJobs(r.jobs); setJobsErr(""); }).catch((e) => setJobsErr(e.message)), []);
  const loadTree = useCallback(() => { if (busy.current) return Promise.resolve(); return api<Tree>("files").then((x) => { if (!busy.current) setTree({ ...normalize(x), poster_urls: x.poster_urls, carousels: x.carousels ?? [] }); }).catch(() => setTree((t) => t ?? EMPTY)); }, []);
  useEffect(() => {
    const c = readCache();
    if (c) { setJobs(c.jobs); setTree({ ...normalize(c.tree), poster_urls: c.tree.poster_urls, carousels: c.tree.carousels ?? [] }); setCachedMedia(c.media); }
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
  // smart search: what every photo looks like (colours, tags) and meaning search, seen by a small model in this browser
  const covers = useMemo(() => new Map(items.filter((i) => i.kind === "image" && i.cover && !i.key.startsWith("u:")).map((i) => [i.key, i.cover!])), [items]);
  const { looks, left: seeing, search: smartSearch } = useSmartSearch(covers, !!tree && !!jobs);

  // ── carousels: a post's photos and clips (or files you grouped) as one stack (lib/carouselrules.ts)
  const titles = useMemo(() => new Map(posts.map((p) => [p.$id, p.title])), [posts]);
  const groups = useMemo(() => groupsOf(t.carousels ?? [], items.filter((i) => !i.key.startsWith("u:")).map((i) => ({ key: i.key, kind: i.kind, post: i.post, at: i.at })), (id) => titles.get(id)),
    [t.carousels, items, titles]);
  const stacks = useMemo(() => new Map(groups.map((g) => {
    const members = g.items.map((k) => byKey.get(k)!).filter(Boolean);
    return [`c:${g.id}`, { key: `c:${g.id}`, g, members, at: Math.max(...members.map((m) => m.at)), starred: members.every((m) => m.starred) } satisfies Stack];
  })), [groups, byKey]);
  const stackOf = useMemo(() => new Map([...stacks.values()].flatMap((s) => s.g.items.map((k) => [k, s] as const))), [stacks]);
  /** Newest first, the order [ and ] walk through. */
  const stackOrder = useMemo(() => [...stacks.values()].sort((a, b) => b.at - a.at), [stacks]);
  /** A list with each carousel's files as its one card, where its first file would be. */
  const collapse = useCallback((list: Item[]): Entry[] => {
    const seen = new Set<string>();
    const out: Entry[] = [];
    for (const i of list) {
      const s = stackOf.get(i.key);
      if (!s) out.push(i);
      else if (!seen.has(s.key)) { seen.add(s.key); out.push(s); }
    }
    return out;
  }, [stackOf]);
  /** A carousel's card stands for its files. */
  const expand = useCallback((keys: string[]) => [...new Set(keys.flatMap((k) => (k.startsWith("c:") ? stacks.get(k)?.g.items ?? [] : [k])))], [stacks]);
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
  useEffect(() => {
    if (ql.length < 3) { setSmart(null); return; }
    let dead = false;
    const t = setTimeout(() => { smartSearch(ql).then((r) => { if (!dead) setSmart(r.size ? r : null); }).catch(() => { if (!dead) setSmart(null); }); }, 350);
    return () => { dead = true; clearTimeout(t); };
  }, [ql, smartSearch]);
  const qWords = useMemo(() => ql.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1), [ql]);
  /** How well a file fits the search: its name, then its tags and colours, then the photo's meaning. 0 = not at all. */
  const relevance = useCallback((i: Item) => {
    if (!ql) return 1;
    const l = looks[i.key];
    let r = `${i.name} ${i.type} ${i.j ? `${i.j.engine} ${i.j.voice} ${i.j.text}` : ""}`.toLowerCase().includes(ql) ? 2 : 0;
    if (l && qWords.length && qWords.every((w) => l.c.includes(w) || l.t?.some((t) => t === w || t === w.replace(/s$/, "") || t.split(" ").includes(w.replace(/s$/, ""))))) r = Math.max(r, 1.5);
    const sm = smart?.get(i.key);
    if (sm) r = Math.max(r, 1 + sm);
    return r;
  }, [ql, qWords, looks, smart]);
  const filtered = type !== "all" || source !== "any" || date !== "any" || by !== "anyone" || color !== "any";
  const global = !trashView && (!!ql || starOnly || (filtered && !cwdId));
  const atRoot = !trashView && !global && !cwdId;
  const match = useCallback((i: Item) => {
    const since = date === "any" ? 0 : date === "1" ? new Date().setHours(0, 0, 0, 0) : Date.now() - Number(date) * 864e5;
    return (!starOnly || i.starred) && (type === "all" || i.kind === type) && (source === "any" || i.src === source) && i.at >= since &&
      (by === "anyone" || (by === "gpu" ? i.src === "generated" : by === "me" ? i.byId === me?.user?.id : i.by === by.slice(2))) &&
      (color === "any" || !!looks[i.key]?.c.includes(color)) && relevance(i) > 0;
  }, [date, starOnly, type, source, by, me, color, looks, relevance]);
  const cmp = useMemo(() => ({
    new: (a: Item, b: Item) => b.at - a.at, old: (a: Item, b: Item) => a.at - b.at,
    name: (a: Item, b: Item) => a.name.localeCompare(b.name, undefined, { numeric: true }), size: (a: Item, b: Item) => (b.size ?? b.seconds ?? 0) - (a.size ?? a.seconds ?? 0),
  })[sort], [sort]);
  const trashFiles = useMemo(() => allItems.filter((i) => t.trash[i.key]).sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0)), [allItems, t.trash]);
  const shownFiles = useMemo(() => {
    if (trashView) return trashFiles;
    if (atRoot) return items.filter((i) => i.folder === null).sort(cmp); // only what you put at the top yourself
    const list = items.filter((i) => (global || i.folder === cwdId) && match(i));
    return ql ? list.sort((a, b) => relevance(b) - relevance(a) || cmp(a, b)) : list.sort(cmp); // a search shows the best fits first
  }, [trashView, trashFiles, atRoot, items, global, cwdId, match, cmp, ql, relevance]);
  // carousels have their own row at the top, so Recent keeps to loose files
  const recent = useMemo(() => (atRoot && !filtered ? [...items].filter((i) => !stackOf.has(i.key)).sort((a, b) => b.at - a.at).slice(0, RECENT) : []), [atRoot, filtered, items, stackOf]);
  const shownEntries = useMemo(() => (trashView ? shownFiles : collapse(shownFiles)), [trashView, shownFiles, collapse]);
  const shownFolders = useMemo(() => {
    if (trashView) return t.folders.filter((f) => t.trash[`f:${f.id}`]);
    const list = global ? liveFolders.filter((f) => (starOnly ? starred.has(`f:${f.id}`) : !!ql) && (!ql || f.name.toLowerCase().includes(ql)))
      : filtered && !cwdId ? [] : liveFolders.filter((f) => f.parent === cwdId);
    const sys = (f: Folder) => (f.system ? SYSTEM.findIndex((s) => s.id === f.id) : 99);
    return [...list].sort((a, b) => sys(a) - sys(b) || (sort === "new" ? b.created - a.created : sort === "old" ? a.created - b.created : a.name.localeCompare(b.name, undefined, { numeric: true })));
  }, [trashView, t, global, liveFolders, starOnly, starred, ql, filtered, cwdId, sort]);
  const order = useMemo(() => [...shownFolders.map((f) => `f:${f.id}`), ...shownEntries.map((i) => i.key), ...recent.map((i) => `r:${i.key}`)], [shownFolders, shownEntries, recent]);
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
      const c = new URLSearchParams(location.search).get("carousel");
      if (h && jobs?.some((j) => j.id === h)) setDetail(`g:${h}`);
      else if (f && stackOf.has(f)) setStage({ id: stackOf.get(f)!.g.id, at: stackOf.get(f)!.g.items.indexOf(f) });
      else if (f && byKey.has(f)) setDetail(f);
      else if (c && stacks.has(`c:${c}`)) setStage({ id: c });
    };
    open();
    addEventListener("hashchange", open);
    return () => removeEventListener("hashchange", open);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, media.length, params, stacks.size]);

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
  const nameOf = (k: string) => (k.startsWith("f:") ? folderById.get(k.slice(2))?.name : k.startsWith("c:") ? stacks.get(k)?.g.name : byKey.get(k)?.name) ?? k;
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
    if (key.startsWith("c:")) return renameStack(key.slice(2), name);
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

  // ── carousels
  const editCarousels = (fn: (list: Carousel[]) => Carousel[]) => edit((x) => ({ ...x, carousels: fn(x.carousels ?? []) }));
  /** Group files as one carousel (each leaves any other it was in), then name it in place. */
  function groupAs(keys: string[], announce = true) {
    const files = expand(keys).filter((k) => !k.startsWith("f:") && !k.startsWith("u:") && visual(byKey.get(k)?.kind ?? "other"));
    if (files.length < 2) return toast("A carousel needs two or more photos or clips.", "bad");
    const id = newFolderId();
    const d = new Date();
    const name = `Carousel · ${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
    const posts = new Set(files.map((k) => byKey.get(k)?.post).filter(Boolean));
    const c: Carousel = { id, name, items: files, post: posts.size === 1 ? [...posts][0]! : null, created: Date.now(), by: me?.user?.name ?? null };
    setSel(new Set());
    write(() => { editCarousels((l) => [...l.map((x) => ({ ...x, items: x.items.filter((k) => !files.includes(k)) })).filter((x) => x.items.length), c]); setRenaming(`c:${id}`); },
      () => api<Carousel>("files/carousels", { body: { id, name, items: files, post: c.post } }))
      .then((r) => { if (r && announce) setSnack({ text: `Grouped ${files.length} as a carousel`, action: "Open", run: () => setStage({ id }) }); });
  }
  function ungroup(id: string) {
    const was = (t.carousels ?? []).find((c) => c.id === id);
    if (!was) return;
    if (stage?.id === id) setStage(null);
    write(() => editCarousels((l) => l.filter((c) => c.id !== id)), () => api(`files/carousels/${id}/ungroup`, { body: {} }))
      .then((r) => { if (r) setSnack({ text: `"${was.name}" ungrouped: its ${was.items.length} files are loose again`, action: "Undo", run: () => {
        write(() => editCarousels((l) => [...l, was]), () => api("files/carousels", { body: { id: was.id, name: was.name, items: was.items, post: was.post } }));
      } }); });
  }
  /** Rename, or reorder: a post's own carousel becomes one you made (the server keeps its files and order). */
  function changeStack(id: string, patch: { name?: string; items?: string[] }) {
    const made = (t.carousels ?? []).some((c) => c.id === id);
    write(() => { if (made) editCarousels((l) => l.map((c) => (c.id === id ? { ...c, ...patch } : c))); },
      () => api<Carousel>(`files/carousels/${id}`, { body: patch }))
      .then((r) => {
        if (!r || made) return;
        busy.current = 0;
        loadTree();
        if (stage?.id === id) setStage((s) => (s ? { ...s, id: r.id } : s));
        if (cv?.id === id) setCv((v) => (v ? { ...v, id: r.id } : v));
      });
  }
  const renameStack = (id: string, name: string) => changeStack(id, { name });
  function reorder(id: string, from: number, to: number) {
    const s = stacks.get(`c:${id}`);
    if (!s) return;
    const items = [...s.g.items];
    const [k] = items.splice(from, 1);
    items.splice(to, 0, k);
    changeStack(id, { items });
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
    // several photos or clips at once are likely one post: offer to stack them as a carousel once they're all in
    const want = files.filter((f) => visual(kindOf(f.type, f.name))).length;
    const batch: string[] = [];
    upload(files, (m, file, key) => {
      const k = `m:${m.$id}`;
      if (want >= 2 && visual(m.kind)) {
        batch.push(k);
        if (batch.length === want) { const keys = [...batch]; setSnack({ text: `${want} photos and clips uploaded together`, action: "Group as carousel", run: () => groupLater.current(keys) }); }
      }
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
  const groupLater = useRef<(keys: string[]) => void>(() => {});
  groupLater.current = (keys) => groupAs(keys); // the snack outlives this render: group with the current state
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
    if (key.startsWith("c:")) { if (!trashView) setStage({ id: key.slice(2) }); return; }
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
    const overlay = () => !!document.querySelector(".modal, .lightbox, .fm-drawer, .palette, .fv, .cs, .pub, .up-ov:not(.is-drag)");
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
      if (mod && e.key.toLowerCase() === "x" && sel.size) { e.preventDefault(); setCut(expand([...sel])); setSnack({ text: `${sel.size} item${sel.size === 1 ? "" : "s"} cut: open a folder and paste (${isMac() ? "⌘" : "Ctrl+"}V)` }); }
      if (mod && e.key.toLowerCase() === "c" && sel.size && !window.getSelection()?.toString()) { e.preventDefault(); copyLinks(expand([...sel]).filter((k) => !k.startsWith("f:"))); }
      if (mod && e.key.toLowerCase() === "g" && sel.size > 1) { e.preventDefault(); groupAs([...sel]); }
      if (mod && e.key.toLowerCase() === "v" && cut.length) { e.preventDefault(); const c = cut; setCut([]); moveTo(c, cwdId); }
      if ((e.key === "Delete" || e.key === "Backspace") && sel.size) { e.preventDefault(); remove(expand([...sel])); }
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

  // a carousel's photo is open full size: [ ] (or Shift+← →) go to the previous or next post's carousel
  useEffect(() => {
    if (!cv) return;
    const k = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector(".modal") || (e.target as HTMLElement).closest?.("input, textarea")) return;
      const d = e.key === "[" || (e.shiftKey && e.key === "ArrowLeft") ? -1 : e.key === "]" || (e.shiftKey && e.key === "ArrowRight") ? 1 : 0;
      if (!d) return;
      const at = stackOrder.findIndex((x) => x.g.id === cv.id);
      const o = at < 0 ? undefined : stackOrder[at + d];
      if (!o) return;
      e.preventDefault();
      setStage({ id: o.g.id });
      setCv({ id: o.g.id, i: 0 });
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [cv, stackOrder]);

  // an opened carousel: check its slides for Instagram and read its numbers if it's out
  useEffect(() => {
    const id = stage?.id;
    if (!id) return;
    api<Checks>(`files/carousels/${encodeURIComponent(id)}/checks`).then((r) => setChecks((x) => ({ ...x, [id]: r }))).catch(() => null);
    api<Stats>(`files/carousels/${encodeURIComponent(id)}/stats`).then((r) => setStats((x) => ({ ...x, [id]: r }))).catch(() => null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage?.id, stacks.get(`c:${stage?.id}`)?.g.items.join(",")]);
  // posted carousels show their saves and shares on the card
  const posted = [...stacks.values()].filter((x) => x.g.post && planFor(x.g.post, "ig_post")?.state === "published").map((x) => x.g.id);
  useEffect(() => {
    for (const id of posted) if (!stats[id]) {
      setStats((x) => ({ ...x, [id]: { live: false } }));
      api<Stats>(`files/carousels/${encodeURIComponent(id)}/stats`).then((r) => setStats((x) => ({ ...x, [id]: r }))).catch(() => null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posted.join(",")]);
  /** Set the carousel up as an Instagram post (its post, its photos, the target and the plan), then open the composer.
   *  The server reuses the post the photos already belong to and refuses photos that are already live. */
  async function toInstagram(id: string) {
    if (igBusy) return;
    setIgBusy(id);
    try {
      const r = await api<{ post_id: string; post: Post; carousel: string; slides: number; skipped: string[]; over: number; made_post: boolean }>(`files/carousels/${encodeURIComponent(id)}/publish`, { body: {} });
      setStage(null);
      setCompose({ id: r.post_id, post: r.post, space: "ig_post" });
      const left = [r.skipped.length && `${r.skipped.length} made on the GPU stay out`, r.over && `${r.over} over Instagram's 20 stay out`].filter(Boolean).join("; ");
      setSnack({ text: `${r.slides} slides in order on ${r.made_post ? "a new post" : `"${r.post.title}"`}, ready to check and send${left ? ` (${left})` : ""}` });
      if (r.carousel !== id) loadTree();
    } catch (e) {
      const live = (e as { body?: { live?: { url: string } } }).body?.live;
      if (live) {
        setStats((x) => ({ ...x, [id]: { ...(x[id] ?? {}), live: true, url: live.url } }));
        setSnack({ text: "Already live on Instagram: it won't be posted twice", action: "Open", run: () => window.open(live.url, "_blank", "noopener") });
        api<Stats>(`files/carousels/${encodeURIComponent(id)}/stats`).then((r) => setStats((x) => ({ ...x, [id]: r }))).catch(() => null);
      } else toast((e as Error).message, "bad");
    } finally { setIgBusy(null); }
  }
  /** One file straight to one place, like a carousel's "Post to Instagram": a video as a Reel, a Short or a Video, a
   *  photo as an Instagram post. The post, the target and a draft plan with the researched package are set up (nothing is
   *  armed), then the composer opens to check it and send or schedule it. */
  async function postTo(key: string, space: SpaceId) {
    if (igBusy || !key.startsWith("m:")) return;
    setIgBusy(`${key}:${space}`);
    try {
      const r = await api<{ post_id: string; post: Post; targets: { space: string; state: string; error?: string }[] }>("autopost", { body: { files: [key], go: "draft", spaces: [space] } });
      const t = r.targets.find((x) => x.space === space);
      if (t?.state === "published") { setSnack({ text: "Already live there: it won't be posted twice", action: "Open post", run: () => router.push(`/posts?post=${r.post_id}`) }); return; }
      setDetail(null);
      setCompose({ id: r.post_id, post: r.post, space });
      setSnack({ text: `Set up on "${r.post.title}" with a researched title, description and hashtags: check it and send` });
    } catch (e) { toast((e as Error).message, "bad"); }
    finally { setIgBusy(null); }
  }
  /** Where one file can go on its own: a video to a Reel, a Short (3 minutes or less) or a Video; a photo to a post. */
  const postsFor = (it: Item): { space: SpaceId; label: string; short: string; icon: React.ReactNode }[] =>
    !it.m ? [] : it.kind === "video" ? [
      { space: "ig_reel", label: "Post to Instagram as a Reel", short: "Instagram", icon: <InstagramLogo size={16} /> },
      ...((it.seconds ?? 0) <= 180 ? [{ space: "yt_short" as const, label: "Post to YouTube as a Short", short: "YouTube", icon: <YoutubeLogo size={16} /> }] : []),
      { space: "yt_video", label: "Post to YouTube as a Video", short: "YouTube", icon: <YoutubeLogo size={16} /> },
    ] : it.kind === "image" ? [{ space: "ig_post", label: "Post to Instagram", short: "Instagram", icon: <InstagramLogo size={16} /> }] : [];
  /** The one click (lib/postpack.ts): the files become a post with researched title, description, hashtags and credits,
   *  on a Reel and a Short (a video) or an Instagram post (photos), armed for the next posting slots, or sent now. */
  async function autoPost(keys: string[], now = false) {
    const files = keys.filter((x) => x.startsWith("m:") && visual(byKey.get(x)?.kind ?? "other"));
    if (!files.length) { toast("Only uploaded photos and videos can be posted", "bad"); return; }
    const video = files.length === 1 && byKey.get(files[0])?.kind === "video";
    const where = video ? "a Reel and a Short" : files.length > 1 ? "an Instagram carousel" : "an Instagram post";
    if (!(await confirm({ title: now ? "Post it now?" : "Auto-post it?",
      body: `It goes out as ${where} ${now ? "right away" : "at your next posting slots"}, with a researched title, description, keywords, hashtags and credits for the original creator. ${now ? "It's public as soon as it's up." : "You can change anything in its post before then."}`,
      confirm: now ? "Post now" : "Auto-post" }))) return;
    setSnack({ text: "Researching the title, description and hashtags…" });
    try {
      const r = await api<{ post_id: string; title: string; targets: { space: string; state: string; due_at: string | null; error?: string }[]; autopilot: boolean; pack: { hashtags: string[]; credit: string | null } }>("autopost", { body: { files, go: now ? "now" : "arm" } });
      const bad = r.targets.filter((t) => t.error);
      const when = r.targets.map((t) => t.due_at).filter(Boolean).sort()[0];
      setSnack({
        text: bad.length ? `“${r.title}” is set up, but ${bad.map((t) => `${t.space}: ${t.error}`).join("; ")}`
          : now ? `“${r.title}” is going out now` : `“${r.title}” goes out ${when ? new Date(when).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }) : "at the next slot"}${r.autopilot ? "" : " (autopilot is paused: turn it on in Posts → Autopilot)"}`,
        action: "Open post", run: () => router.push(`/posts?post=${r.post_id}`),
      });
      loadTree();
    } catch (e) { setSnack(null); toast((e as Error).message, "bad"); }
  }
  /** A live carousel to the story, as a post card of its first slide (lib/publish/storycard.ts). */
  async function shareStory(postId: string) {
    if (!(await confirm({ title: "Share it to your story?", body: "It goes up now as a post card: the cover slide with your @handle on a blur of itself, like sharing it by hand.", confirm: "Share to story" }))) return;
    try { await api(`publish/${postId}/ig_story/share`, { body: { from: "ig_post", go: "now" } }); toast("Sharing to your story…", "ok"); }
    catch (e) { toast((e as Error).message, "bad"); }
  }
  const composePost = compose ? posts.find((p) => p.$id === compose.id) ?? compose.post : undefined;

  // photos open instantly: the screen-size copies of the ones around the open one are fetched ahead
  useEffect(() => {
    const id = cv?.id ?? stage?.id;
    const s = id ? stacks.get(`c:${id}`) : undefined;
    if (!s) return;
    const at = cv?.i ?? stage?.at ?? 0;
    const near = [0, 1, -1, 2, 3, -2].map((d) => s.members[(at + d + s.members.length) % s.members.length]);
    for (const m of near) if (m?.m && m.kind === "image") { const im = new Image(); im.decoding = "async"; im.src = screenPreview(m.m) ?? mediaUrl(m.m); }
  }, [cv, stage, stacks]);

  // ── drag and drop
  function dragStart(key: string, e: React.DragEvent) {
    if (trashView || key.startsWith("u:")) { e.preventDefault(); return; }
    const keys = expand(sel.has(key) ? [...sel] : [key]);
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
  function menuFor(picked: string[]): { title: string; entries: MenuEntry[] } {
    if (!trashView && picked.length === 1 && picked[0].startsWith("c:")) return stackMenu(picked[0]);
    const keys = expand(picked);
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
    const canGroup = fileKeys.length > 1 && fileKeys.every((x) => visual(byKey.get(x)?.kind ?? "other"));
    if (many) return {
      title: `${keys.length} items`,
      entries: [...common, ...(canGroup ? [{ label: "Group as carousel", icon: <StackPlus size={16} />, kbd: isMac() ? "⌘G" : "Ctrl+G", run: () => groupAs(fileKeys) }] : []),
        ...(canGroup && fileKeys.every((x) => x.startsWith("m:")) ? [{ label: "Auto-post as a carousel", icon: <RocketLaunch size={16} />, run: () => autoPost(fileKeys) }] : []),
        ...(fileKeys.length ? [{ label: `Download ${fileKeys.length}`, icon: <DownloadSimple size={16} />, run: () => download(fileKeys) }, { label: "Copy links", icon: <LinkSimple size={16} />, run: () => copyLinks(fileKeys) }] : []),
        ...(sys ? [] : ["-" as const, { label: `Move ${keys.length} to the trash`, icon: <TrashSimple size={16} />, danger: true, run: () => remove(keys) }])],
    };
    if (k.startsWith("f:")) {
      const f = folderById.get(k.slice(2))!;
      return {
        title: f.name,
        entries: [{ label: "Open", icon: <FolderOpen size={16} />, run: () => open(k) }, { label: "Rename", icon: <PencilSimple size={16} />, kbd: "F2", run: () => setRenaming(k) },
          { label: "New folder inside", icon: <FolderPlus size={16} />, run: () => { renameNext.current = `f:${newFolder(f.id, "Untitled folder", false)}`; go(f.id); } },
          ...(f.system ? [] : [{ label: "Share link…", icon: <LinkSimple size={16} />, run: () => setSharing({ kind: "folder" as const, ref: f.id, name: f.name }) }]),
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
        ...(k.startsWith("m:") && visual(it.kind) && wsOn ? postsFor(it).map((p) => ({ label: `${p.label}…`, icon: p.icon, run: () => postTo(k, p.space) })) : []),
        ...(k.startsWith("m:") && visual(it.kind) ? [{ label: "Auto-post", icon: <RocketLaunch size={16} />, run: () => autoPost([k]) }, { label: "Post now", icon: <PaperPlaneTilt size={16} />, run: () => autoPost([k], true) }] : []),
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
  /** The menu for a carousel's card: it acts on every file in it. */
  function stackMenu(key: string): { title: string; entries: MenuEntry[] } {
    const s = stacks.get(key);
    if (!s) return { title: key, entries: [] };
    const files = s.g.items;
    return {
      title: s.g.name,
      entries: [
        { label: "Open", icon: <Cards size={16} />, run: () => setStage({ id: s.g.id }) },
        ...(files.some((x) => x.startsWith("m:")) ? [{ label: "Auto-post", icon: <RocketLaunch size={16} />, run: () => autoPost(files) }] : []),
        { label: "Rename", icon: <PencilSimple size={16} />, kbd: "F2", run: () => setRenaming(key) },
        { label: sel.has(key) ? "Deselect" : "Select", icon: <CheckSquare size={16} />, run: () => toggle(key, false) },
        { label: `Move all ${files.length} to…`, icon: <FolderSimple size={16} />, run: () => setMoving(files) },
        { label: s.starred ? "Remove star" : "Star all", icon: <Star size={16} />, run: () => star(files, !s.starred) },
        { label: `Download all ${files.length}`, icon: <DownloadSimple size={16} />, run: () => download(files) },
        { label: "Copy links", icon: <LinkSimple size={16} />, run: () => copyLinks(files) },
        { label: "Share link…", icon: <ShareNetwork size={16} />, run: () => setSharing({ kind: "carousel", ref: s.g.id, name: s.g.name }) },
        ...(s.g.post ? [{ label: "Open its post", icon: <ArrowSquareOut size={16} />, run: () => router.push(`/posts?post=${s.g.post}`) }] : []),
        ...(s.g.made ? [{ label: "Ungroup (files stay)", icon: <StackMinus size={16} />, run: () => ungroup(s.g.id) }] : []),
        "-",
        { label: `Move all ${files.length} to the trash`, icon: <TrashSimple size={16} />, danger: true, kbd: "Del", run: () => remove(files) },
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

  const totalBytes = items.reduce((s, i) => s + (i.size ?? 0), 0);
  const trashCount = Object.keys(t.trash).length;
  const selFiles = expand([...sel]).filter((k) => !k.startsWith("f:"));
  const selVisual = selFiles.filter((k) => !k.startsWith("u:") && visual(byKey.get(k)?.kind ?? "other"));
  const ord = order.map((k) => k.replace(/^r:/, ""));
  const selAll = ord.length > 0 && ord.every((k) => sel.has(k));
  const mod = isMac() ? "⌘" : "Ctrl";
  const grid = (list: Entry[], prefix = "") => view === "grid" ? (
    <div className="fm-grid">{list.map((it) => isStack(it) ? <CarouselCard key={prefix + it.key} s={it} stats={stats[it.g.id]} {...events(it.key)} />
      : <FileCard key={prefix + it.key} it={it} playing={playing === it.key} onPlay={() => play(it)} {...events(it.key)} />)}</div>
  ) : (
    <div className="fm-list">
      <div className="frow fr-head" aria-hidden><span /><span /><span>Name</span><span className="fr-col fr-type">Type</span><span className="fr-col fr-size">Size</span><span className="fr-col fr-by">Added by</span><span className="fr-col fr-at">{trashView ? "Deleted" : "Added"}</span><span /></div>
      {list.map((it) => isStack(it) ? <CarouselRow key={prefix + it.key} s={it} folderName={(global || prefix) && it.members[0].folder !== cwdId ? pathName(it.members[0].folder) : undefined} {...events(it.key)} />
        : <FileRow key={prefix + it.key} it={it} folderName={(global || prefix) && it.folder !== cwdId ? pathName(it.folder) : undefined} {...events(it.key)} />)}
    </div>
  );

  return (
    <div className={`fm ${sel.size ? "selecting" : ""}`}
      onDragOver={(e) => { if (!trashView && e.dataTransfer.types.includes("Files") && !e.dataTransfer.types.includes(DT)) { e.preventDefault(); setOsDrag(true); const n = [...e.dataTransfer.items].filter((x) => x.kind === "file").length; if (n !== dragN) setDragN(n); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) { setOsDrag(false); setOver(null); } }}
      onDrop={(e) => { if (!trashView && e.dataTransfer.files.length && !e.dataTransfer.types.includes(DT)) { e.preventDefault(); setOsDrag(false); sendFiles([...e.dataTransfer.files]); } }}>
      <PageHeader title={trashView ? "Trash" : "Files"} sub={trashView ? "Deleted things wait here for 30 days, then they're gone for good." : "Every upload and everything the GPU made, sorted by kind. Drop, paste or drag files anywhere."}
        actions={trashView ? <>
          <button className="ghost" onClick={() => go(null)}><FolderSimple size={15} weight="duotone" />Back to files</button>
          <button className="danger" onClick={emptyTrash} disabled={!trashCount}><TrashSimple size={15} weight="bold" />Empty trash</button>
        </> : <>
          <button className="ghost" onClick={() => newFolder()}><FolderPlus size={15} weight="duotone" />New folder</button>
          <button onClick={() => (wsOn ? setUpOpen(true) : needWs())}><UploadSimple size={15} weight="bold" />Upload</button>
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
            <input ref={search} value={q} onChange={(e) => setQ(e.target.value)} placeholder={seeing ? `Search, or describe a photo… (seeing ${seeing} new)` : "Search, or describe a photo…"} aria-label="Search every file and folder, or describe a photo"
              onKeyDown={(e) => { if (e.key === "Escape") { setQ(""); e.currentTarget.blur(); } }} />
            {q ? <button className="icon-btn xs" aria-label="Clear search" onClick={() => setQ("")}><X size={13} /></button>
              : <span className="fm-kbd" aria-hidden><kbd>{mod === "⌘" ? "⌘" : "Ctrl"}</kbd><kbd>F</kbd></span>}
          </div>
          <div className="fm-pills" role="toolbar" aria-label="Filters">
            <FilterPill label="Type" value={type} options={TYPES} onChange={setType} />
            <FilterPill label="Source" value={source} options={SOURCES} onChange={setSource} />
            <FilterPill label="Date" value={date} options={DATES} onChange={setDate} />
            <FilterPill label="Added by" value={by} options={BY} onChange={setBy} />
            <FilterPill label="Colour" value={color} options={COLORS} onChange={setColor} />
            <button type="button" className={`fpill ${starOnly ? "on" : ""}`} aria-pressed={starOnly} onClick={() => setStarOnly((s) => !s)}><Star size={13} weight={starOnly ? "fill" : "regular"} />Starred</button>
            {filtered && <button type="button" className="fpill quiet" onClick={() => { setType("all"); setSource("any"); setDate("any"); setBy("anyone"); setColor("any"); }}>Clear</button>}
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
              {selVisual.length > 1 && selVisual.length === selFiles.length && <button className="quiet xs" onClick={() => groupAs([...sel])} title={`Group as one carousel (${mod}+G)`}><StackPlus size={13} />Group as carousel</button>}
              <button className="quiet xs" onClick={() => setMoving(expand([...sel]))}><FolderSimple size={13} />Move</button>
              <button className="quiet xs" onClick={() => { const k = expand([...sel]); star(k, !k.every((x) => starred.has(x))); }}><Star size={13} />Star</button>
              {selFiles.length > 0 && <button className="quiet xs" onClick={() => download(selFiles)}><DownloadSimple size={13} />Download</button>}
              {selFiles.length > 0 && selFiles.every((x) => x.startsWith("m:") && visual(byKey.get(x)?.kind ?? "other")) && <button className="quiet xs" onClick={() => autoPost(selFiles)}><RocketLaunch size={13} />Auto-post</button>}
              <button className="danger sm" onClick={() => remove(expand([...sel]))}><TrashSimple size={14} weight="bold" />Delete</button>
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

          {atRoot && !filtered && stackOrder.length > 0 && (
            <section className="fm-sec" aria-labelledby="fm-carousels">
              <div className="fm-sec-h"><h2 id="fm-carousels"><Cards size={16} weight="duotone" />Carousels <span className="fm-count">{stackOrder.length}</span></h2></div>
              {grid(stackOrder.slice(0, 8), "s:")}
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
              <div className="fm-sec-h"><h2 id="fm-files">{trashView ? "Files" : atRoot ? "In All files" : "Files"} <span className="fm-count">{shownEntries.length}</span></h2></div>
              {shownEntries.length > 0 ? grid(shownEntries) : trashView ? (
                <div className="empty"><Trash size={26} weight="duotone" /><b>{shownFolders.length ? "No loose files in the trash" : "The trash is empty"}</b><span>Anything you delete waits here for 30 days.</span></div>
              ) : global || filtered ? (
                <div className="empty"><MagnifyingGlass size={22} /><b>Nothing matches</b><span>Try another word or filter.</span>
                  <button className="ghost sm" onClick={() => { setQ(""); setStarOnly(false); setType("all"); setSource("any"); setDate("any"); setBy("anyone"); setColor("any"); }}>Clear search and filters</button></div>
              ) : (
                <button type="button" className={`drop fm-drop ${over === (cwdId ?? "root") ? "over" : ""}`} onClick={() => (wsOn ? setUpOpen(true) : needWs())} {...dropOn(cwdId)}>
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

      {osDrag && <UploadOverlay mode="drag" count={dragN} where={here && !here.system ? here.name : "Files, sorted by kind"} onClose={() => setOsDrag(false)} onFiles={() => {}} onLink={() => {}} />}
      {upOpen && !osDrag && <UploadOverlay mode="pick" where={here && !here.system ? here.name : "Files, sorted by kind"} onClose={() => setUpOpen(false)} onFiles={(f) => sendFiles(f)} onLink={importLink} />}

      {menu && (() => { const m = menuFor(menu.keys); return <ContextMenu at={menu.at} title={m.title} entries={m.entries} onClose={() => setMenu(null)} />; })()}

      {moving && (
        <MoveDialog folders={liveFolders} moving={moving} from={moving.length === 1 && !moving[0].startsWith("f:") ? byKey.get(moving[0])?.folder ?? null : moving.length === 1 ? folderById.get(moving[0].slice(2))?.parent ?? null : cwdId}
          onClose={() => setMoving(null)} onMove={(to) => { const m = moving; setMoving(null); moveTo(m, to); }}
          onCreate={async (name, parent) => newFolder(parent, name, false)} />
      )}

      {detailItem?.m && (() => {
        // step through the uploads shown here, in the order they're shown
        const seq = [...new Set(order.map((k) => k.replace(/^r:/, "")))].filter((k) => byKey.get(k)?.m);
        const at = seq.indexOf(detailItem.key);
        const step = (d: number) => { const k = seq[(at + d + seq.length) % seq.length]; if (k) setDetail(k); };
        return (
          <FileViewer file={viewFile(detailItem)} index={at} total={seq.length} onClose={closeDetail}
            onPrev={seq.length > 1 && at >= 0 ? () => step(-1) : undefined} onNext={seq.length > 1 && at >= 0 ? () => step(1) : undefined}
            onDelete={() => { const k = detailItem.key; const nxt = seq.length > 1 ? seq[(at + 1) % seq.length] : null; remove([k]); if (nxt && nxt !== k) setDetail(nxt); else closeDetail(); }}
            extra={<>
              {wsOn && postsFor(detailItem).filter((p, i, all) => all.findIndex((x) => x.short === p.short) === i).map((p, i) => {
                const busy = igBusy === `${detailItem.key}:${p.space}`;
                return (
                  <button key={p.space} type="button" className={`sm fv-post ${i ? "ghost" : ""}`} onClick={() => postTo(detailItem.key, p.space)} disabled={!!igBusy} aria-busy={busy} aria-label={p.label} title={p.label}>
                    {busy ? <span className="vp-spin sm" /> : p.icon}<span>{busy ? "Setting up…" : p.short}</span>
                  </button>
                );
              })}
              <StarBtn on={detailItem.starred} onClick={() => star([detailItem.key], !detailItem.starred)} />
            </>} />
        );
      })()}
      {(() => {
        // an open carousel: the curved row, and over it one photo full size with the carousel along the bottom
        const st = stage ? stacks.get(`c:${stage.id}`) : undefined;
        const vs = cv ? stacks.get(`c:${cv.id}`) : undefined;
        const near = (s: Stack | undefined, d: number, viewing: boolean) => {
          const at = s ? stackOrder.findIndex((x) => x.key === s.key) : -1;
          const o = at < 0 ? undefined : stackOrder[at + d];
          return o ? { name: o.g.name, go: () => { setStage({ id: o.g.id }); if (viewing) setCv({ id: o.g.id, i: 0 }); } } : null;
        };
        const m = vs?.members[cv!.i];
        return (
          <>
            {st && (
              <CarouselStage key={st.key} s={st} at={stage!.at} onClose={() => { setStage(null); if (params.get("carousel")) history.replaceState(null, "", `/files${cwdId ? `?folder=${cwdId}` : ""}`); }}
                onOpen={(i) => setCv({ id: st.g.id, i })} onPrev={near(st, -1, false)} onNext={near(st, 1, false)}
                onRename={(n) => renameStack(st.g.id, n)}
                onUngroup={st.g.made ? () => ungroup(st.g.id) : undefined} onMove={(a, b) => reorder(st.g.id, a, b)}
                onDownload={() => download(st.g.items)} onStory={stats[st.g.id]?.post_id ? () => shareStory(stats[st.g.id]!.post_id!) : undefined} onShare={() => setSharing({ kind: "carousel", ref: st.g.id, name: st.g.name })} onStar={() => star(st.g.items, !st.starred)}
                onPost={st.g.post ? () => router.push(`/posts?post=${st.g.post}`) : undefined}
                onInstagram={wsOn ? () => toInstagram(st.g.id) : undefined} igBusy={igBusy === st.g.id} checks={checks[st.g.id] ?? null} stats={stats[st.g.id] ?? null}
                handle={accounts.find((a) => a.network === "instagram")?.handle ?? null} avatar={accounts.find((a) => a.network === "instagram")?.avatar ?? null} />
            )}
            {vs && m && (
              <FileViewer file={m.m ? viewFile(m) : { key: m.key, name: m.name, kind: m.kind, url: m.kind === "video" && m.j ? libFileUrl(m.j.id, "video.mp4") : m.cover ?? "", download: downloadHref(m), poster: m.cover, at: m.at }}
                index={cv!.i} total={vs.members.length} onClose={() => { setStage({ id: vs.g.id, at: cv!.i }); setCv(null); }}
                onPrev={vs.members.length > 1 ? () => setCv({ id: vs.g.id, i: (cv!.i - 1 + vs.members.length) % vs.members.length }) : undefined}
                onNext={vs.members.length > 1 ? () => setCv({ id: vs.g.id, i: (cv!.i + 1) % vs.members.length }) : undefined}
                onDelete={() => { const k = m.key; remove([k]); if (vs.members.length <= 2) setCv(null); else setCv({ id: vs.g.id, i: Math.min(cv!.i, vs.members.length - 2) }); }}
                extra={<StarBtn on={m.starred} onClick={() => star([m.key], !m.starred)} />}
                strip={<CarouselStrip s={vs} index={cv!.i} onPick={(i) => setCv({ id: vs.g.id, i })} onPrev={near(vs, -1, true)} onNext={near(vs, 1, true)} />} />
            )}
          </>
        );
      })()}
      {composePost && compose && <Composer post={composePost} space={compose.space} onClose={() => setCompose(null)} />}
      {detailItem?.j && (
        <>
          <div className="scrim" onClick={closeDetail} />
          <DetailDrawer it={detailItem} job={full[detailItem.j.id]} onClose={closeDetail} onRename={() => { closeDetail(); setRenaming(detailItem.key); }} onMove={() => setMoving([detailItem.key])}
            onStar={() => star([detailItem.key], !detailItem.starred)} folderName={pathName(detailItem.folder)}
            onDelete={() => { const k = detailItem.key; closeDetail(); remove([k]); }} onSubtitle={() => subtitle(detailItem.j!)} />
        </>
      )}

      {<UploadPanel rows={upRows} onClose={clearUploads} onOpenFolder={(name) => { const f = liveFolders.find((x) => x.name === name); go(f?.id ?? null); }} />}
      {sharing && <ShareDialog kind={sharing.kind} refId={sharing.ref} name={sharing.name} onClose={() => setSharing(null)} />}
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
