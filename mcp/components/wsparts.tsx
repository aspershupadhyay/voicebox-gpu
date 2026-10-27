"use client";
// Building blocks shared by Posts and Files: the sign-in gate, avatars, uploads and media tiles.
import { FileAudio, FileText, FilmStrip, Paperclip, Play, UsersThree } from "@phosphor-icons/react";
import { useCallback, useState } from "react";
import { AW, fileUrl, initials, kindOf, type Media, type MediaKind } from "@/lib/workspace";
import { aw, getMe, ID, logActivity, signOut, useMe } from "./aw";
import { Empty, PageHeader } from "./ui";
import { FileViewer } from "./Viewer";

/** The workspace needs a real account (the token login is single-user). Renders children only when signed in;
 *  otherwise the page's header and a clear next step. */
export function Gate({ children, title }: { children: React.ReactNode; title?: string }) {
  const me = useMe();
  if (!me) return <div className="ws-skel" aria-busy />;
  if (me.user && me.session && me.workspace) return <>{children}</>;
  return (
    <>
      {title && <PageHeader title={title} />}
      <Empty icon={<UsersThree size={22} />} title={!me.workspace ? "The shared workspace isn't set up yet" : "Sign in with your account to see the shared workspace"}
        action={me.workspace ? <button className="sm" onClick={async () => { await signOut(); location.href = "/login"; }}>Sign in with email</button> : undefined}>
        {!me.workspace
          ? "Posts, comments and shared files appear here once the owner connects the workspace (APPWRITE_API_KEY, see docs/WORKSPACE.md). Voiceovers, voices and files keep working meanwhile."
          : "The access token opens the studio, but posts, comments and media belong to people. Sign in with your own account and you'll both see the same desk, live."}
      </Empty>
    </>
  );
}

const tone = (id?: string | null) => (!id ? "" : id.charCodeAt(id.length - 1) % 2 ? "a1" : "a2");
export function Avatar({ id, name, sm }: { id?: string | null; name?: string | null; sm?: boolean }) {
  return <span className={`avatar ${tone(id)} ${sm ? "sm" : ""}`} title={name ?? undefined}>{initials(name)}</span>;
}

export type Upload = { key: string; name: string; size: number; kind: MediaKind; progress: number; error?: string; done?: boolean; mediaId?: string };

// files going up at once: many small ones fill the line in parallel; big ones go two or three at a time so each finishes soon
const lanesFor = (files: File[]) => (files.every((f) => f.size < 8e6) ? 6 : files.some((f) => f.size > 200e6) ? 2 : 3);

/** Upload to Appwrite Storage (chunked, resumable), record it in the media table, then mint a view token (the R2 backup
 *  copy follows on the server). `onRow` hears about each file as soon as its row exists; `onStart` as it's queued. */
export function useUploader(postId?: string | null) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const upload = useCallback(async (files: FileList | File[], onRow?: (m: Media, file: File, key: string) => void, onStart?: (key: string, file: File) => void) => {
    const list = Array.from(files); // copy now: the caller clears the <input>, which empties a live FileList
    const jobs = list.map((file) => ({ file, key: `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}` }));
    setUploads((u) => [...u, ...jobs.map(({ file, key }) => ({ key, name: file.name, size: file.size, kind: kindOf(file.type, file.name), progress: 0 }))]);
    jobs.forEach(({ file, key }) => onStart?.(key, file));
    const { user } = await getMe();
    const finishing: Promise<void>[] = [];
    const one = async ({ file, key }: { file: File; key: string }) => {
      const set = (p: Partial<Upload>) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, ...p } : x)));
      try {
        const f = await aw().storage.createFile({ bucketId: AW.bucket, fileId: ID.unique(), file, onProgress: (p) => set({ progress: Math.min(0.99, p.progress / 100) }) });
        set({ progress: 0.99 });
        // the bytes are up: the lane takes the next file while this one is recorded and gets its link
        finishing.push((async () => {
          try {
            const row = await aw().tables.createRow<Media>({
              databaseId: AW.db, tableId: "media", rowId: ID.unique(),
              data: { file_id: f.$id, name: file.name.slice(0, 255), mime: file.type || null, size: file.size, kind: kindOf(file.type, file.name), post_id: postId ?? null,
                uploaded_by: user?.id ?? null, uploaded_name: user?.name ?? null, r2_key: null, token: null },
            });
            set({ mediaId: row.$id });
            onRow?.(row, file, key);
            const fin = await fetch(`/api/ws/media/${row.$id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then((r) => r.json()).catch(() => ({}));
            set({ progress: 1, done: true, error: fin.backup || undefined });
            logActivity(postId ?? null, "uploaded", file.name);
          } catch (e) {
            set({ error: (e as Error).message || "Upload failed" });
          }
        })());
      } catch (e) {
        set({ error: (e as Error).message || "Upload failed" });
      }
    };
    const queue = [...jobs];
    await Promise.all(Array.from({ length: Math.min(lanesFor(list), queue.length) }, async () => { for (let j = queue.shift(); j; j = queue.shift()) await one(j); }));
    await Promise.all(finishing);
  }, [postId]);
  const clear = useCallback(() => setUploads((u) => u.filter((x) => !x.done && !x.error)), []);
  return { uploads, upload, clear };
}

export function UploadList({ uploads: all }: { uploads: Upload[] }) {
  const uploads = all.filter((u) => !u.done || u.error);
  if (!uploads.length) return null;
  return (
    <div className="stack" style={{ gap: 6, margin: "10px 0" }}>
      {uploads.map((u) => (
        <div key={u.key} className="up-row">
          <span className="small" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.name}</span>
          {u.error ? <span className="tiny" style={{ color: u.progress >= 1 ? "var(--warn)" : "var(--danger)" }}>{u.error}</span>
            : <span className="mono tiny dim">{Math.round(u.progress * 100)}%</span>}
          <div className="bar thin" style={{ width: 90 }}><i style={{ width: `${u.progress * 100}%` }} /></div>
        </div>
      ))}
    </div>
  );
}

const fmtSize = (b?: number | null) => (!b ? "" : b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

/** One file as a tile: image thumbnail, video poster frame, or an icon. Waits for the token before loading. */
export function MediaTile({ m, onOpen, selected }: { m: Media; onOpen?: () => void; selected?: boolean }) {
  const ready = !!m.token;
  return (
    <button className={`media-tile ${selected ? "on" : ""}`} onClick={onOpen} title={m.name}>
      <div className="mt-art">
        {!ready ? <span className="mt-wait" />
          : m.kind === "image" ? <img src={fileUrl(m, "preview", 480)} alt="" loading="lazy" />
          : m.kind === "video" ? <><video src={`${fileUrl(m)}#t=0.5`} preload="metadata" muted playsInline /><span className="mt-play"><Play size={14} weight="fill" /></span></>
          : m.kind === "audio" ? <FileAudio size={30} weight="light" />
          : m.kind === "doc" ? <FileText size={30} weight="light" />
          : <Paperclip size={28} weight="light" />}
        {m.kind === "video" && ready && <span className="mt-kind"><FilmStrip size={12} weight="bold" /></span>}
      </div>
      <div className="mt-meta">
        <span className="mt-name">{m.name}</span>
        <span className="tiny faint">{fmtSize(m.size)}{m.uploaded_name ? ` · ${m.uploaded_name.split(" ")[0]}` : ""}{m.r2_key ? " · backed up" : ""}</span>
      </div>
    </button>
  );
}

/** Full-size viewer for one media file (the Files viewer), with download and delete. */
export function MediaViewer({ m, onClose, onDelete }: { m: Media; onClose: () => void; onDelete?: () => void }) {
  return (
    <FileViewer onClose={onClose} onDelete={onDelete} file={{
      key: `m:${m.$id}`, name: m.name, kind: m.kind, mime: m.mime, size: m.size, url: fileUrl(m), download: fileUrl(m, "download"), by: m.uploaded_name, at: Date.parse(m.$createdAt),
    }} />
  );
}

export async function deleteMedia(m: Media) {
  await aw().storage.deleteFile({ bucketId: AW.bucket, fileId: m.file_id }).catch(() => {});
  await aw().tables.deleteRow({ databaseId: AW.db, tableId: "media", rowId: m.$id });
  logActivity(m.post_id, "deleted file", m.name);
}
