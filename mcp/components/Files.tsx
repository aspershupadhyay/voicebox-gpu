"use client";
// Files: a file manager over everything you have. Uploads (the shared workspace, Appwrite) and generated items (takes,
// subtitles, images and videos the GPU made, in R2) sit side by side, filed in folders (lib/files.ts). Upload with the
// button, by dropping files anywhere or by pasting (a photo, files or a link); drag cards onto a folder or the path to
// move them; right-click or ⋮ for rename, move, star, download and delete. Keys: ⌘F search, ⌘A select all, ⌘C copy
// links, ⌘X then ⌘V move, F2 rename, Delete, Esc. Parts in fileparts.tsx; rules in docs/DESIGN.md.
import {
  ArrowClockwise, ArrowSquareOut, ArrowsDownUp, CaretRight, Check, CheckSquare, ClosedCaptioning, Copy, DownloadSimple, FolderOpen, FolderPlus, FolderSimple, LinkSimple,
  ListBullets, MagnifyingGlass, PencilSimple, Scissors, SquaresFour, Star, TrashSimple, UploadSimple, UsersThree, X,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileTree, Folder } from "@/lib/files";
import { fileUrl as mediaUrl, libKind, libName, libType, type Media, type MediaKind } from "@/lib/workspace";
import { api, fileUrl as libFileUrl } from "./api";
import { Query, signOut, useLive, useMe } from "./aw";
import { useDialog } from "./Dialog";
import {
  ContextMenu, DT, FileCard, FileRow, FilterPill, FolderCard, FolderRow, MoveDialog, NewFolderCard, type Anchor, type Item, type MenuEntry,
} from "./fileparts";
import { ImageCard, JobCard, VideoCard, type LibJob } from "./Library";
import { useStatus } from "./Shell";
import { Notice, PageHeader } from "./ui";
import { MediaViewer, UploadList, useUploader } from "./wsparts";

type Sort = "new" | "old" | "name" | "size";
const TYPES = [["all", "All"], ["image", "Images"], ["video", "Videos"], ["audio", "Audio"], ["doc", "Docs & subtitles"], ["other", "Other"]] as const;
const SOURCES = [["any", "Any"], ["upload", "Uploads"], ["generated", "Generated"]] as const;
const DATES = [["any", "Any"], ["1", "Today"], ["7", "Last 7 days"], ["30", "Last 30 days"], ["365", "This year"]] as const;
const SORTS: [Sort, string][] = [["new", "Newest first"], ["old", "Oldest first"], ["name", "Name A–Z"], ["size", "Largest first"]];
const EMPTY: FileTree = { folders: [], place: {}, starred: [] };
const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** One generated library item, as a file. */
function fromJob(j: LibJob, place: Record<string, string>, starred: Set<string>): Item {
  const key = `g:${j.id}`;
  const img = j.images?.[0];
  return {
    key, src: "generated", name: libName(j), kind: libKind(j), type: libType(j), size: j.video?.size ?? null,
    seconds: j.kind === "video" ? j.video?.duration ?? null : j.kind === "image" ? null : j.results.reduce((s, r) => s + r.duration, 0) || null,
    at: j.created, by: null, byId: null, folder: place[key] ?? null, starred: starred.has(key),
    cover: j.kind === "image" ? img?.thumb_url ?? img?.url ?? null : j.kind === "video" ? j.poster_url ?? null : null,
    video: j.kind === "video" && !j.poster_url ? j.video_url ?? null : null, audio: !j.kind || j.kind === "tts" ? j.results[0]?.audio ?? null : null,
    subs: !!j.subs, post: null, backedUp: true, snippet: j.kind === "transcribe" ? j.results.map((r) => r.text).join(" ").replace(/<[^>]+>/g, "").slice(0, 160) : "", j,
  };
}
function fromMedia(m: Media, place: Record<string, string>, starred: Set<string>): Item {
  const key = `m:${m.$id}`;
  const ready = !!m.token;
  return {
    key, src: "upload", name: m.name, kind: m.kind, type: m.kind === "doc" ? "Doc" : m.kind[0].toUpperCase() + m.kind.slice(1), size: m.size, seconds: null,
    at: Date.parse(m.$createdAt), by: m.uploaded_name, byId: m.uploaded_by, folder: place[key] ?? null, starred: starred.has(key),
    cover: ready && m.kind === "image" ? mediaUrl(m, "preview", 480) : null, video: ready && m.kind === "video" ? mediaUrl(m) : null,
    audio: ready && m.kind === "audio" ? mediaUrl(m) : null, subs: false, post: m.post_id, backedUp: !!m.r2_key, snippet: "", m,
  };
}

/** Where to download a file from. */
function downloadHref(it: Item) {
  if (it.m) return mediaUrl(it.m, "download");
  const j = it.j!;
  const slug = it.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60) || j.id;
  if (j.kind === "video") return libFileUrl(j.id, "video.mp4", `${slug}.mp4`);
  if (j.kind === "image" && j.images?.length === 1) return libFileUrl(j.id, j.images[0].file, `${slug}.png`);
  return `/api/zip/${j.id}`;
}
const linkOf = (it: Item) => (it.m ? mediaUrl(it.m) : `${location.origin}/files#${it.j!.id}`);

export default function Files() {
  const params = useSearchParams();
  const router = useRouter();
  const cwd = params.get("folder");
  const { status } = useStatus();
  const { confirm, toast } = useDialog();
  const me = useMe();
  const wsOn = !!(me?.user && me.session && me.workspace);
  const { rows: media, setRows: setMedia } = useLive<Media>("media", [Query.orderDesc("$createdAt"), Query.limit(1000)]);
  const { uploads, upload } = useUploader(null);

  const [jobs, setJobs] = useState<LibJob[] | null>(null);
  const [jobsErr, setJobsErr] = useState("");
  const [tree, setTree] = useState<FileTree | null>(null);
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
  const [cut, setCut] = useState<string[]>([]);
  const [dragging, setDragging] = useState<string[] | null>(null);
  const [over, setOver] = useState<string | null>(null); // a folder id, "root" for All files
  const [osDrag, setOsDrag] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const [sortAt, setSortAt] = useState<Anchor | null>(null);
  const [subNote, setSubNote] = useState("");
  const anchor = useRef<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const sortBtn = useRef<HTMLButtonElement>(null);
  const player = useRef<HTMLAudioElement | null>(null);
  const pending = useRef<Map<string, string[]>>(new Map());
  const flushT = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── data
  const loadJobs = useCallback(() => api<{ jobs: LibJob[] }>("library").then((r) => { setJobs(r.jobs); setJobsErr(""); }).catch((e) => setJobsErr(e.message)), []);
  const loadTree = useCallback(() => api<FileTree>("files").then(setTree).catch(() => setTree((t) => t ?? EMPTY)), []);
  useEffect(() => {
    loadJobs(); loadTree();
    try { const v = localStorage.getItem("vb-files-view"); if (v === "list" || v === "grid") setView(v); } catch {}
    // folders aren't on the live socket: check now and then, and whenever the tab comes back
    const t = setInterval(() => { if (document.visibilityState === "visible") loadTree(); }, 20_000);
    const onVis = () => { if (document.visibilityState === "visible") { loadTree(); loadJobs(); } };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  }, [loadJobs, loadTree]);
  const pickView = (v: "grid" | "list") => { setView(v); try { localStorage.setItem("vb-files-view", v); } catch {} };

  const t = tree ?? EMPTY;
  const folderIds = useMemo(() => new Set(t.folders.map((f) => f.id)), [t.folders]);
  const place = useMemo(() => Object.fromEntries(Object.entries(t.place).filter(([, f]) => folderIds.has(f))), [t.place, folderIds]);
  const starred = useMemo(() => new Set(t.starred), [t.starred]);
  const items = useMemo(() => [
    ...(wsOn ? media.map((m) => fromMedia(m, place, starred)) : []),
    ...(jobs ?? []).map((j) => fromJob(j, place, starred)),
  ], [media, jobs, place, starred, wsOn]);
  const byKey = useMemo(() => new Map(items.map((i) => [i.key, i])), [items]);
  const folderById = useMemo(() => new Map(t.folders.map((f) => [f.id, f])), [t.folders]);
  const here = cwd ? folderById.get(cwd) ?? null : null;
  const cwdId = here?.id ?? null;
  useEffect(() => { if (tree && cwd && !folderById.has(cwd)) router.replace("/files", { scroll: false }); }, [tree, cwd, folderById, router]);

  const path = useMemo(() => {
    const out: Folder[] = [];
    for (let cur = here, n = 0; cur && n < 64; n++) { out.unshift(cur); cur = cur.parent ? folderById.get(cur.parent) ?? null : null; }
    return out;
  }, [here, folderById]);
  const pathName = useCallback((id: string | null) => {
    const parts: string[] = [];
    for (let cur = id ? folderById.get(id) : undefined, n = 0; cur && n < 64; n++) { parts.unshift(cur.name); cur = cur.parent ? folderById.get(cur.parent) : undefined; }
    return parts.join(" / ");
  }, [folderById]);

  // how many things a folder holds (files and folders, all the way down) and who put them there
  const counts = useMemo(() => {
    const direct = new Map<string, number>();
    for (const i of items) if (i.folder) direct.set(i.folder, (direct.get(i.folder) ?? 0) + 1);
    const total = (id: string, n = 0): number => n > 64 ? 0 : (direct.get(id) ?? 0) + t.folders.filter((f) => f.parent === id).reduce((s, f) => s + 1 + total(f.id, n + 1), 0);
    return new Map(t.folders.map((f) => [f.id, total(f.id)]));
  }, [items, t.folders]);
  const peopleIn = useCallback((id: string) => {
    const seen = new Map<string, { id: string | null; name: string }>();
    for (const i of items) if (i.folder === id) {
      const k = i.src === "generated" ? "gpu" : i.byId ?? i.by ?? "?";
      if (!seen.has(k)) seen.set(k, i.src === "generated" ? { id: "gpu", name: "GPU" } : { id: i.byId, name: i.by ?? "Someone" });
    }
    return [...seen.values()];
  }, [items]);

  const people = useMemo(() => [...new Map(items.filter((i) => i.by).map((i) => [i.by!, i.by!])).values()].sort(), [items]);
  const BY = useMemo(() => [["anyone", "Anyone"], ...(me?.user ? [["me", "Me"]] : []), ...people.filter((p) => p !== me?.user?.name).map((p) => [`p:${p}`, p]), ["gpu", "The GPU"]] as [string, string][], [people, me]);

  // ── what's shown: this folder, or everything when searching or showing starred
  const global = !!q.trim() || starOnly;
  const filtered = type !== "all" || source !== "any" || date !== "any" || by !== "anyone";
  const ql = q.trim().toLowerCase();
  const shownFiles = useMemo(() => {
    const since = date === "any" ? 0 : date === "1" ? new Date().setHours(0, 0, 0, 0) : Date.now() - Number(date) * 864e5;
    const list = items.filter((i) => (global || i.folder === cwdId) && (!starOnly || i.starred) && (type === "all" || i.kind === type) && (source === "any" || i.src === source) &&
      i.at >= since && (by === "anyone" || (by === "gpu" ? i.src === "generated" : by === "me" ? i.byId === me?.user?.id : i.by === by.slice(2))) &&
      (!ql || `${i.name} ${i.type} ${i.j ? `${i.j.engine} ${i.j.voice} ${i.j.results.map((r) => r.text).join(" ")}` : ""}`.toLowerCase().includes(ql)));
    const cmp: Record<Sort, (a: Item, b: Item) => number> = {
      new: (a, b) => b.at - a.at, old: (a, b) => a.at - b.at, name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }), size: (a, b) => (b.size ?? b.seconds ?? 0) - (a.size ?? a.seconds ?? 0),
    };
    return list.sort(cmp[sort]);
  }, [items, global, cwdId, starOnly, type, source, date, by, ql, sort, me]);
  const shownFolders = useMemo(() => {
    const list = global ? t.folders.filter((f) => (starOnly ? starred.has(`f:${f.id}`) : true) && (!ql || f.name.toLowerCase().includes(ql)))
      : filtered ? [] : t.folders.filter((f) => f.parent === cwdId);
    return list.sort(sort === "new" ? (a, b) => b.created - a.created : sort === "old" ? (a, b) => a.created - b.created : (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }, [t.folders, global, starOnly, starred, ql, filtered, cwdId, sort]);
  const order = useMemo(() => [...shownFolders.map((f) => `f:${f.id}`), ...shownFiles.map((i) => i.key)], [shownFolders, shownFiles]);
  const loading = jobs === null && !jobsErr;

  // drop selections that vanished (deleted, moved out of view)
  useEffect(() => { setSel((s) => { const n = new Set([...s].filter((k) => order.includes(k))); return n.size === s.size ? s : n; }); }, [order]);
  const renameNext = useRef<string | null>(null); // a folder made inside another: rename it once we're in there
  useEffect(() => { setSel(new Set()); setRenaming(renameNext.current); renameNext.current = null; }, [cwdId]);

  // a link to one file: /files#<library id> (Home, Voiceover, posts) or /files?file=m:<id> (MCP)
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
  }, [jobs, media.length]);

  // ── actions
  const go = (id: string | null) => router.push(id ? `/files?folder=${id}` : "/files", { scroll: false });
  const actorFail = (e: unknown) => { toast((e as Error).message, "bad"); loadTree(); };

  async function newFolder(parent: string | null = cwdId, name = "Untitled folder", rename = true) {
    try {
      const f = await api<Folder>("files/folders", { body: { name, parent } });
      setTree((x) => ({ ...(x ?? EMPTY), folders: [...(x ?? EMPTY).folders, f] }));
      if (rename) { setRenaming(`f:${f.id}`); setQ(""); setStarOnly(false); }
      return f.id;
    } catch (e) { actorFail(e); return null; }
  }

  async function moveTo(keys: string[], folder: string | null) {
    const ok = keys.filter((k) => !(k.startsWith("f:") && folder && (k.slice(2) === folder || within(folder, k.slice(2)))));
    if (!ok.length) return toast("A folder can't go inside itself.", "bad");
    setTree((x) => {
      const cur = x ?? EMPTY;
      const pl = { ...cur.place };
      for (const k of ok) if (!k.startsWith("f:")) { if (folder) pl[k] = folder; else delete pl[k]; }
      return { ...cur, place: pl, folders: cur.folders.map((f) => (ok.includes(`f:${f.id}`) ? { ...f, parent: folder } : f)) };
    });
    setSel(new Set());
    try {
      await api("files/move", { body: { items: ok, folder } });
      toast(`Moved ${ok.length === 1 ? `"${nameOf(ok[0])}"` : `${ok.length} items`} to ${folder ? folderById.get(folder)?.name : "All files"}.`, "ok");
      loadTree();
    } catch (e) { actorFail(e); }
  }
  function within(id: string, ancestor: string) {
    for (let cur: string | null = id, n = 0; cur && n < 64; n++) { if (cur === ancestor) return true; cur = folderById.get(cur)?.parent ?? null; }
    return false;
  }
  const nameOf = (k: string) => (k.startsWith("f:") ? folderById.get(k.slice(2))?.name : byKey.get(k)?.name) ?? k;

  async function rename(key: string, name: string | null) {
    setRenaming(null);
    const old = nameOf(key);
    if (!name || name === old) return;
    try {
      if (key.startsWith("f:")) {
        const f = await api<Folder>(`files/folders/${key.slice(2)}`, { body: { name } });
        setTree((x) => ({ ...(x ?? EMPTY), folders: (x ?? EMPTY).folders.map((y) => (y.id === f.id ? f : y)) }));
      } else {
        const r = await api<{ name: string }>("files/rename", { body: { item: key, name } });
        if (key.startsWith("g:")) setJobs((js) => (js ?? []).map((j) => (`g:${j.id}` === key ? { ...j, label: r.name } : j)));
        else setMedia((ms) => ms.map((m) => (`m:${m.$id}` === key ? { ...m, name: r.name } : m)));
      }
    } catch (e) { actorFail(e); }
  }

  async function recolor(id: string, color: string) {
    setTree((x) => ({ ...(x ?? EMPTY), folders: (x ?? EMPTY).folders.map((f) => (f.id === id ? { ...f, color: color as Folder["color"] } : f)) }));
    try { await api(`files/folders/${id}`, { body: { color } }); } catch (e) { actorFail(e); }
  }

  async function star(keys: string[], on: boolean) {
    setTree((x) => ({ ...(x ?? EMPTY), starred: on ? [...new Set([...(x ?? EMPTY).starred, ...keys])] : (x ?? EMPTY).starred.filter((k) => !keys.includes(k)) }));
    try { await api("files/star", { body: { items: keys, on } }); } catch (e) { actorFail(e); }
  }

  async function remove(keys: string[]) {
    const files = keys.filter((k) => !k.startsWith("f:"));
    const folders = keys.filter((k) => k.startsWith("f:")).map((k) => folderById.get(k.slice(2))).filter(Boolean) as Folder[];
    if (!files.length && !folders.length) return;
    const one = keys.length === 1;
    const names = keys.map(nameOf);
    const ok = await confirm({
      danger: true,
      title: one ? `Delete "${names[0]}"?` : `Delete ${keys.length} items?`,
      body: (
        <>
          {files.length > 0 && <>{files.length === 1 ? "The file is" : `${files.length} files are`} deleted for good (uploads keep their R2 backup copy). It can&apos;t be undone. </>}
          {folders.length > 0 && <>{folders.length === 1 ? "The folder is" : `${folders.length} folders are`} removed; what&apos;s inside moves up a level.</>}
          {!one && <ul>{names.slice(0, 50).map((n, i) => <li key={i}>{n}</li>)}{names.length > 50 && <li className="dim">…and {names.length - 50} more</li>}</ul>}
        </>
      ),
      confirm: one ? "Delete" : `Delete ${keys.length}`,
    });
    if (!ok) return;
    setSel(new Set());
    try {
      let failed = 0;
      if (files.length) {
        const r = await api<{ deleted: string[]; failed: { id: string }[] }>("files/delete", { body: { items: files } });
        failed = r.failed.length;
        setJobs((js) => (js ?? []).filter((j) => !r.deleted.includes(`g:${j.id}`)));
        setMedia((ms) => ms.filter((m) => !r.deleted.includes(`m:${m.$id}`)));
      }
      for (const f of folders) await api(`files/folders/${f.id}`, { method: "DELETE" });
      await loadTree();
      toast(failed ? `Deleted ${keys.length - failed}; ${failed} failed. Try again.` : one ? "Deleted." : `Deleted ${keys.length} items.`, failed ? "bad" : "ok");
    } catch (e) { actorFail(e); }
  }

  function download(keys: string[]) {
    const list = keys.map((k) => byKey.get(k)).filter(Boolean) as Item[];
    list.forEach((it, i) => setTimeout(() => {
      const a = document.createElement("a");
      a.href = downloadHref(it); a.download = ""; a.rel = "noreferrer";
      document.body.appendChild(a); a.click(); a.remove();
    }, i * 350)); // one at a time, or the browser blocks all but the first
  }

  async function copyLinks(keys: string[]) {
    const links = keys.map((k) => byKey.get(k)).filter(Boolean).map((it) => linkOf(it!));
    if (!links.length) return;
    try { await navigator.clipboard.writeText(links.join("\n")); toast(links.length === 1 ? "Link copied." : `${links.length} links copied.`, "ok"); }
    catch { toast("Couldn't reach the clipboard.", "bad"); }
  }

  // uploads: into a folder once each row exists (batched, so many files make one write)
  const placeLater = useCallback((key: string, folder: string) => {
    const p = pending.current;
    p.set(folder, [...(p.get(folder) ?? []), key]);
    setTree((x) => ({ ...(x ?? EMPTY), place: { ...(x ?? EMPTY).place, [key]: folder } }));
    if (flushT.current) clearTimeout(flushT.current);
    flushT.current = setTimeout(async () => {
      const batches = [...p.entries()];
      p.clear();
      for (const [f, keys] of batches) await api("files/move", { body: { items: keys, folder: f } }).catch((e) => toast(`Couldn't file the upload: ${(e as Error).message}`, "bad"));
      loadTree();
    }, 700);
  }, [loadTree, toast]);
  const needWs = useCallback(() => toast(me?.workspace ? "Sign in with your own account to upload: uploads live in the shared workspace." : "Uploads need the shared workspace (see docs/WORKSPACE.md).", "bad"), [me, toast]);
  const sendFiles = useCallback((files: File[], folder: string | null = cwdId) => {
    if (!files.length) return;
    if (!wsOn) return needWs();
    upload(files, folder ? (m) => placeLater(`m:${m.$id}`, folder) : undefined);
    if (folder !== cwdId) toast(`Uploading to ${folderById.get(folder!)?.name ?? "All files"}…`, "info");
  }, [cwdId, wsOn, needWs, upload, placeLater, folderById, toast]);
  const input = useRef<HTMLInputElement>(null);

  async function importLink(url: string) {
    if (!wsOn) return needWs();
    toast("Adding the file from the link…", "info");
    try {
      const r = await api<{ folder: string | null }>("files/import", { body: { url, folder: cwdId } });
      if (r.folder) loadTree();
      toast("Added from the link.", "ok");
    } catch (e) { toast((e as Error).message, "bad"); }
  }

  async function subtitle(j: LibJob) {
    if (!status?.online) return toast("The GPU worker is offline. Start the Colab notebook first.", "bad");
    try {
      await api("jobs", { body: { kind: "transcribe", library: j.id, language: j.language || undefined } });
      setSubNote(`Subtitling "${libName(j)}"… it shows a CC badge when done (follow it in the jobs tray).`);
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
    if (key.startsWith("f:")) { setQ(""); setStarOnly(false); go(key.slice(2)); return; }
    setDetail(key);
  }
  function toggle(key: string, shift: boolean) {
    const from = anchor.current; // read now: the updater below runs later, after the anchor has moved
    setSel((prev) => {
      const next = new Set(prev);
      if (shift && from && order.includes(from)) {
        const [a, b] = [order.indexOf(from), order.indexOf(key)].sort((x, y) => x - y);
        order.slice(a, b + 1).forEach((x) => next.add(x));
      } else if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    anchor.current = key;
  }
  /** A click opens; with a modifier, or once anything is selected, it selects. */
  function click(key: string, e: React.MouseEvent) {
    if (renaming === key) return;
    if (e.shiftKey || e.metaKey || e.ctrlKey || sel.size) toggle(key, e.shiftKey);
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
      if (e.key === "Escape" && (sel.size || cut.length)) { setSel(new Set()); setCut([]); }
      if (mod && e.key.toLowerCase() === "a" && order.length) { e.preventDefault(); setSel(new Set(order)); }
      if (mod && e.key.toLowerCase() === "x" && sel.size) { e.preventDefault(); setCut([...sel]); toast(`${sel.size} item${sel.size === 1 ? "" : "s"} cut: open a folder and paste (${isMac() ? "⌘" : "Ctrl+"}V) to move.`, "info"); }
      if (mod && e.key.toLowerCase() === "c" && sel.size && !window.getSelection()?.toString()) { e.preventDefault(); copyLinks([...sel].filter((k) => !k.startsWith("f:"))); }
      if (mod && e.key.toLowerCase() === "v" && cut.length) { e.preventDefault(); const c = cut; setCut([]); moveTo(c, cwdId); }
      if ((e.key === "Delete" || e.key === "Backspace") && sel.size) { e.preventDefault(); remove([...sel]); }
      if (e.key === "F2" && sel.size === 1) { e.preventDefault(); setRenaming([...sel][0]); }
      if (e.key === "Enter" && sel.size === 1 && document.activeElement === document.body) { e.preventDefault(); open([...sel][0]); }
    };
    const onPaste = (e: ClipboardEvent) => {
      if (typing(e.target) || overlay()) return;
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
      if (!internal && !os) return;
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
    const allStarred = keys.every((x) => starred.has(x));
    const fileKeys = keys.filter((x) => !x.startsWith("f:"));
    const common: MenuEntry[] = [
      ...(many ? [] : [{ label: sel.has(k) ? "Deselect" : "Select", icon: <CheckSquare size={16} />, run: () => toggle(k, false) }]),
      { label: "Move to…", icon: <FolderSimple size={16} />, run: () => setMoving(keys) },
      { label: "Cut", icon: <Scissors size={16} />, kbd: isMac() ? "⌘X" : "Ctrl+X", run: () => { setCut(keys); toast("Cut: open a folder and paste to move.", "info"); } },
      { label: allStarred ? "Remove star" : "Star", icon: <Star size={16} />, run: () => star(keys, !allStarred) },
    ];
    if (many) return {
      title: `${keys.length} items`,
      entries: [...common, ...(fileKeys.length ? [{ label: `Download ${fileKeys.length}`, icon: <DownloadSimple size={16} />, run: () => download(fileKeys) }, { label: "Copy links", icon: <LinkSimple size={16} />, run: () => copyLinks(fileKeys) }] : []),
        "-", { label: `Delete ${keys.length}`, icon: <TrashSimple size={16} />, danger: true, run: () => remove(keys) }],
    };
    if (k.startsWith("f:")) {
      const f = folderById.get(k.slice(2))!;
      return {
        title: f.name,
        entries: [{ label: "Open", icon: <FolderOpen size={16} />, run: () => open(k) }, { label: "Rename", icon: <PencilSimple size={16} />, kbd: "F2", run: () => setRenaming(k) },
          { label: "New folder inside", icon: <FolderPlus size={16} />, run: async () => { const id = await newFolder(f.id, "Untitled folder", false); if (id) { renameNext.current = `f:${id}`; go(f.id); } } },
          ...common, { colors: f.color, pick: (c) => recolor(f.id, c) }, "-", { label: "Delete folder", icon: <TrashSimple size={16} />, danger: true, run: () => remove(keys) }],
      };
    }
    const it = byKey.get(k)!;
    return {
      title: it.name,
      entries: [
        { label: "Open", icon: <ArrowSquareOut size={16} />, run: () => open(k) },
        { label: "Rename", icon: <PencilSimple size={16} />, kbd: "F2", run: () => setRenaming(k) },
        ...common,
        { label: "Download", icon: <DownloadSimple size={16} />, run: () => download(keys) },
        { label: "Copy link", icon: <Copy size={16} />, kbd: isMac() ? "⌘C" : "Ctrl+C", run: () => copyLinks(keys) },
        ...(it.post ? [{ label: "Open its post", icon: <ArrowSquareOut size={16} />, run: () => router.push(`/posts?post=${it.post}`) }] : []),
        ...(it.j && (!it.j.kind || it.j.kind === "tts") && !it.j.subs ? [{ label: "Add subtitles", icon: <ClosedCaptioning size={16} />, run: () => subtitle(it.j!) }] : []),
        ...(it.folder && global ? [{ label: "Show in folder", icon: <FolderOpen size={16} />, run: () => { setQ(""); setStarOnly(false); go(it.folder); } }] : []),
        "-",
        { label: "Delete", icon: <TrashSimple size={16} />, danger: true, run: () => remove(keys) },
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

  const detailItem = detail ? byKey.get(detail) ?? null : null;
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
  const selFiles = [...sel].filter((k) => !k.startsWith("f:"));
  const selAll = order.length > 0 && order.every((k) => sel.has(k));
  const mod = isMac() ? "⌘" : "Ctrl";

  return (
    <div className={`fm ${sel.size ? "selecting" : ""}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files") && !e.dataTransfer.types.includes(DT)) { e.preventDefault(); setOsDrag(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) { setOsDrag(false); setOver(null); } }}
      onDrop={(e) => { if (e.dataTransfer.files.length && !e.dataTransfer.types.includes(DT)) { e.preventDefault(); setOsDrag(false); sendFiles([...e.dataTransfer.files]); } }}>
      <input ref={input} type="file" multiple hidden onChange={(e) => { if (e.target.files?.length) sendFiles([...e.target.files]); e.target.value = ""; }} />
      <PageHeader title="Files" sub="Uploads and everything the GPU made, in folders. Drop, paste or drag files anywhere."
        actions={<>
          <button className="ghost" onClick={() => newFolder()}><FolderPlus size={15} />New folder</button>
          <button onClick={() => (wsOn ? input.current?.click() : needWs())}><UploadSimple size={15} weight="bold" />Upload</button>
        </>} />

      {me && !wsOn && (
        <Notice icon={<UsersThree size={18} />} action={me.workspace ? <button className="sm" onClick={async () => { await signOut(); location.href = "/login"; }}>Sign in</button> : undefined}>
          {me.workspace ? <><b>Shared uploads are hidden.</b> Sign in with your own account to see and add them; generated files are all here.</>
            : <><b>Shared uploads aren&apos;t set up.</b> Generated files are here; uploads appear once the workspace is connected (docs/WORKSPACE.md).</>}
        </Notice>
      )}
      {subNote && <Notice icon={<ClosedCaptioning size={18} />} action={<button className="icon-btn sm" aria-label="Dismiss" onClick={() => setSubNote("")}><X size={14} /></button>}>{subNote}</Notice>}

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

      <nav className="fm-path" aria-label="Folder path">
        <button type="button" className={`fm-crumb ${over === "root" ? "over" : ""}`} aria-current={!cwdId && !global ? "page" : undefined} onClick={() => { setQ(""); setStarOnly(false); go(null); }} {...dropOn(null)}>All files</button>
        {!global && path.map((f) => (
          <span key={f.id} className="row" style={{ gap: 4, flexWrap: "nowrap", minWidth: 0 }}>
            <CaretRight size={12} className="dim" aria-hidden />
            <button type="button" className={`fm-crumb ${over === f.id ? "over" : ""}`} aria-current={f.id === cwdId ? "page" : undefined} onClick={() => go(f.id)} {...dropOn(f.id)}>{f.name}</button>
          </span>
        ))}
        {global && <><CaretRight size={12} className="dim" aria-hidden /><span className="fm-crumb static">{starOnly && !q ? "Starred" : `Results for “${q.trim()}”`}</span></>}
        <span className="fm-usage tiny dim mono">{items.length} files · {(totalBytes / 1e9).toFixed(2)} GB</span>
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
          <input type="checkbox" className="selbox" checked={selAll} ref={(el) => { if (el) el.indeterminate = !selAll && sel.size > 0; }} onChange={() => setSel(selAll ? new Set() : new Set(order))} aria-label="Select everything shown" />
          <b>{sel.size} selected</b>
          <button className="quiet xs" onClick={() => setSel(new Set())}><X size={12} />Clear</button>
          <span className="faint tiny fm-hint" style={{ flex: 1 }}>Drag onto a folder to move · Shift-click selects a range · Esc clears</span>
          <span className="row" style={{ gap: 6 }}>
            <button className="quiet xs" onClick={() => setMoving([...sel])}><FolderSimple size={13} />Move</button>
            <button className="quiet xs" onClick={() => star([...sel], ![...sel].every((k) => starred.has(k)))}><Star size={13} />Star</button>
            {selFiles.length > 0 && <button className="quiet xs" onClick={() => download(selFiles)}><DownloadSimple size={13} />Download</button>}
            <button className="danger sm" onClick={() => remove([...sel])}><TrashSimple size={14} weight="bold" />Delete {sel.size}</button>
          </span>
        </div>
      )}

      <UploadList uploads={uploads} />
      {jobsErr && <p className="err">Generated files couldn&apos;t load: {jobsErr}</p>}

      {loading ? (
        <div className="fm-skel" aria-busy><div className="skel" /><div className="skel" /><div className="skel" /><div className="skel" /></div>
      ) : (
        <>
          {(shownFolders.length > 0 || (!global && !filtered)) && (
            <section className="fm-sec" aria-labelledby="fm-folders">
              <div className="fm-sec-h"><h2 id="fm-folders">Folders <span className="fm-count">{shownFolders.length}</span></h2></div>
              {view === "grid" ? (
                <div className="fm-folders">
                  {shownFolders.map((f) => (
                    <FolderCard key={f.id} f={f} count={counts.get(f.id) ?? 0} people={peopleIn(f.id)} over={over === f.id} starred={starred.has(`f:${f.id}`)} {...events(`f:${f.id}`)} {...dropOn(f.id)} />
                  ))}
                  {!global && <NewFolderCard onClick={() => newFolder()} />}
                </div>
              ) : (
                <div className="fm-list">
                  {shownFolders.map((f) => <FolderRow key={f.id} f={f} count={counts.get(f.id) ?? 0} over={over === f.id} starred={starred.has(`f:${f.id}`)} {...events(`f:${f.id}`)} {...dropOn(f.id)} />)}
                  {!global && <button type="button" className="frow fr-new" onClick={() => newFolder()}><span className="fr-thumb"><FolderPlus size={16} /></span>New folder</button>}
                </div>
              )}
            </section>
          )}

          <section className="fm-sec" aria-labelledby="fm-files">
            <div className="fm-sec-h"><h2 id="fm-files">Files <span className="fm-count">{shownFiles.length}</span></h2></div>
            {shownFiles.length > 0 ? (
              view === "grid" ? (
                <div className="fm-grid">
                  {shownFiles.map((it) => <FileCard key={it.key} it={it} playing={playing === it.key} onPlay={() => play(it)} {...events(it.key)} />)}
                </div>
              ) : (
                <div className="fm-list">
                  <div className="frow fr-head" aria-hidden><span /><span /><span>Name</span><span className="fr-col fr-type">Type</span><span className="fr-col fr-size">Size</span><span className="fr-col fr-by">Added by</span><span className="fr-col fr-at">Added</span><span /></div>
                  {shownFiles.map((it) => <FileRow key={it.key} it={it} folderName={global && it.folder ? pathName(it.folder) : undefined} {...events(it.key)} />)}
                </div>
              )
            ) : global || filtered ? (
              <div className="empty"><MagnifyingGlass size={22} /><b>Nothing matches</b><span>Try another word or filter.</span>
                <button className="ghost sm" onClick={() => { setQ(""); setStarOnly(false); setType("all"); setSource("any"); setDate("any"); setBy("anyone"); }}>Clear search and filters</button></div>
            ) : (
              <button type="button" className={`drop fm-drop ${over === (cwdId ?? "root") ? "over" : ""}`} onClick={() => (wsOn ? input.current?.click() : needWs())} {...dropOn(cwdId)}>
                <span className="d-ic"><UploadSimple size={22} /></span>
                <b>{cwdId ? "This folder is empty" : items.length ? "Nothing loose here" : "Drop your first files"}</b>
                <span>{cwdId ? "Drop files here, paste a photo, or drag files in from another folder." : items.length ? "Everything is in folders. Drop or paste files to add more." : "Images, videos up to 2 GB, audio and docs. Or paste a photo or a link."}</span>
                {!cwdId && !items.length && <Link href="/voiceover" className="btn ghost sm" onClick={(e) => e.stopPropagation()}>Or make a voiceover</Link>}
              </button>
            )}
          </section>
        </>
      )}

      {osDrag && <div className="page-drop">Drop to upload to {here?.name ?? "All files"}</div>}

      {menu && (() => { const m = menuFor(menu.keys); return <ContextMenu at={menu.at} title={m.title} entries={m.entries} onClose={() => setMenu(null)} />; })()}

      {moving && (
        <MoveDialog folders={t.folders} moving={moving} from={moving.length === 1 && !moving[0].startsWith("f:") ? byKey.get(moving[0])?.folder ?? null : moving.length === 1 ? folderById.get(moving[0].slice(2))?.parent ?? null : cwdId}
          onClose={() => setMoving(null)} onMove={(to) => { const m = moving; setMoving(null); moveTo(m, to); }}
          onCreate={(name, parent) => newFolder(parent, name, false)} />
      )}

      {detailItem?.m && (
        <MediaViewer m={detailItem.m} onClose={closeDetail} onDelete={async () => { const k = detailItem.key; closeDetail(); await remove([k]); }} />
      )}
      {detailItem?.j && (
        <>
          <div className="scrim" onClick={closeDetail} />
          <DetailDrawer it={detailItem} onClose={closeDetail} onRename={() => { closeDetail(); setRenaming(detailItem.key); }} onMove={() => setMoving([detailItem.key])}
            onStar={() => star([detailItem.key], !detailItem.starred)} folderName={detailItem.folder ? pathName(detailItem.folder) : "All files"}
            onDelete={async () => { const k = detailItem.key; closeDetail(); await remove([k]); }} onSubtitle={() => subtitle(detailItem.j!)} />
        </>
      )}
    </div>
  );
}

/** A generated item in full (its player, lines, scores and downloads), in a drawer over the files. */
function DetailDrawer({ it, folderName, onClose, onRename, onMove, onStar, onDelete, onSubtitle }: {
  it: Item; folderName: string; onClose: () => void; onRename: () => void; onMove: () => void; onStar: () => void; onDelete: () => void; onSubtitle: () => void;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector(".modal")) onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  const j = it.j!;
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
      <div className="lib-list">
        {j.kind === "image" ? <ImageCard j={j} open onDelete={onDelete} />
          : j.kind === "video" ? <VideoCard j={j} open onDelete={onDelete} />
          : <JobCard j={j} open onDelete={onDelete} onSubtitle={onSubtitle} />}
      </div>
    </aside>
  );
}
