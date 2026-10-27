"use client";
// Building blocks shared by Posts and Files: the sign-in gate, avatars, uploads and media tiles.
import { FileAudio, FileText, FilmStrip, Paperclip, Play, UsersThree } from "@phosphor-icons/react";
import { useCallback, useState } from "react";
import { AW, fileUrl, initials, kindOf, type Media } from "@/lib/workspace";
import { aw, getMe, ID, logActivity, signOut, useMe } from "./aw";
import { Empty, PageHeader } from "./ui";

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

export type Upload = { key: string; name: string; progress: number; error?: string };

/** Upload to Appwrite Storage (chunked, resumable), record it in the media table, then mint a view token + R2 backup.
 *  `onRow` hears about each file as soon as its row exists (the Files page files it into the open folder). */
export function useUploader(postId?: string | null) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const upload = useCallback(async (files: FileList | File[], onRow?: (m: Media) => void) => {
    const list = Array.from(files); // copy now: the caller clears the <input>, which empties a live FileList
    const { user } = await getMe();
    await Promise.all(list.map(async (file) => {
      const key = `${file.name}-${file.size}-${Math.random()}`;
      setUploads((u) => [...u, { key, name: file.name, progress: 0 }]);
      const set = (p: Partial<Upload>) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, ...p } : x)));
      try {
        const f = await aw().storage.createFile({ bucketId: AW.bucket, fileId: ID.unique(), file, onProgress: (p) => set({ progress: p.progress / 100 }) });
        const row = await aw().tables.createRow<Media>({
          databaseId: AW.db, tableId: "media", rowId: ID.unique(),
          data: { file_id: f.$id, name: file.name.slice(0, 255), mime: file.type || null, size: file.size, kind: kindOf(file.type, file.name), post_id: postId ?? null,
            uploaded_by: user?.id ?? null, uploaded_name: user?.name ?? null, r2_key: null, token: null },
        });
        set({ progress: 1 });
        onRow?.(row);
        const fin = await fetch(`/api/ws/media/${row.$id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then((r) => r.json());
        if (fin.backup) set({ error: fin.backup });
        logActivity(postId ?? null, "uploaded", file.name);
        setTimeout(() => setUploads((u) => u.filter((x) => x.key !== key)), fin.backup ? 6000 : 900);
      } catch (e) {
        set({ error: (e as Error).message });
      }
    }));
  }, [postId]);
  return { uploads, upload };
}

export function UploadList({ uploads }: { uploads: Upload[] }) {
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

/** Full-size viewer for one media file, with download, R2-backup link and delete. */
export function MediaViewer({ m, onClose, onDelete }: { m: Media; onClose: () => void; onDelete?: () => void }) {
  const [backup, setBackup] = useState<string | null>(null);
  return (
    <div className="lightbox" onClick={onClose}>
      <div className="stage" onClick={(e) => e.stopPropagation()}>
        {m.kind === "image" ? <img src={fileUrl(m)} alt={m.name} />
          : m.kind === "video" ? <video src={fileUrl(m)} controls autoPlay playsInline />
          : m.kind === "audio" ? <audio src={fileUrl(m)} controls autoPlay style={{ width: "min(560px, 90vw)" }} />
          : <div className="card" style={{ textAlign: "center" }}><FileText size={40} weight="light" /><p>{m.name}</p></div>}
      </div>
      <div className="bar2" onClick={(e) => e.stopPropagation()}>
        <span className="lb-name">{m.name}</span>
        <a className="btn ghost sm" href={fileUrl(m, "download")}>Download</a>
        {m.r2_key && (backup
          ? <a className="btn ghost sm" href={backup} target="_blank" rel="noreferrer">Open R2 copy</a>
          : <button className="ghost sm" onClick={async () => { const r = await fetch(`/api/ws/backup/${m.$id}`).then((x) => x.json()); if (r.url) setBackup(r.url); }}>R2 backup</button>)}
        {onDelete && <button className="ghost sm" onClick={onDelete}>Delete</button>}
        <button className="sm" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

export async function deleteMedia(m: Media) {
  await aw().storage.deleteFile({ bucketId: AW.bucket, fileId: m.file_id }).catch(() => {});
  await aw().tables.deleteRow({ databaseId: AW.db, tableId: "media", rowId: m.$id });
  logActivity(m.post_id, "deleted file", m.name);
}
