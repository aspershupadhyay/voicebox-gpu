"use client";
// Shared media: thumbnails, B-roll, final cuts, music. Stored in Appwrite (up to 2 GB a file, previews resized on the
// fly), each upload also copied to R2 as a backup when it fits a serverless function (~180 MB).
import { UploadSimple } from "@phosphor-icons/react";
import { useMemo, useRef, useState } from "react";
import type { Media, MediaKind, Post } from "@/lib/workspace";
import { Query, useLive } from "./aw";
import { useDialog } from "./Dialog";
import { deleteMedia, Gate, MediaTile, MediaViewer, UploadList, useUploader } from "./wsparts";

const KINDS: { id: MediaKind | ""; label: string }[] = [
  { id: "", label: "All" }, { id: "image", label: "Images" }, { id: "video", label: "Video" }, { id: "audio", label: "Audio" }, { id: "doc", label: "Docs" },
];

function MediaInner() {
  const { confirm } = useDialog();
  const { rows } = useLive<Media>("media", [Query.orderDesc("$createdAt"), Query.limit(500)]);
  const { rows: posts } = useLive<Post>("posts", [Query.orderDesc("$updatedAt"), Query.limit(500)]);
  const { uploads, upload } = useUploader(null);
  const [kind, setKind] = useState<MediaKind | "">("");
  const [q, setQ] = useState("");
  const [view, setView] = useState<Media | null>(null);
  const [drop, setDrop] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const title = useMemo(() => Object.fromEntries(posts.map((p) => [p.$id, p.title])), [posts]);

  const shown = rows.filter((m) => (!kind || m.kind === kind) && (!q || `${m.name} ${m.post_id ? title[m.post_id] ?? "" : ""}`.toLowerCase().includes(q.toLowerCase())));
  const total = rows.reduce((s, m) => s + (m.size ?? 0), 0);

  return (
    <div onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDrop(true); } }} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop(false); }}
      onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); setDrop(false); upload(e.dataTransfer.files); } }}>
      <div className="head">
        <div>
          <div className="eyebrow">Workspace</div>
          <h1>Media. <em>Every file, both of you.</em></h1>
          <p className="sub">{rows.length} files · {(total / 1e9).toFixed(2)} GB in Appwrite. Drop anything here; attach files to a post from the post itself.</p>
        </div>
        <button onClick={() => input.current?.click()}><UploadSimple size={15} weight="bold" /> Upload</button>
        <input ref={input} type="file" multiple hidden onChange={(e) => { if (e.target.files?.length) upload(e.target.files); e.target.value = ""; }} />
      </div>
      <div className="filters">
        <div className="seg">{KINDS.map((k) => <button key={k.id} className={kind === k.id ? "on" : ""} onClick={() => setKind(k.id)}>{k.label}</button>)}</div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by file or post" style={{ flex: 1, minWidth: 180 }} />
      </div>
      <UploadList uploads={uploads} />
      {shown.length ? (
        <div className="media-grid">{shown.map((m) => (
          <div key={m.$id}>
            <MediaTile m={m} onOpen={() => setView(m)} />
            {m.post_id && title[m.post_id] && <a className="tiny dim mt-post" href={`/workspace?post=${m.post_id}`}>{title[m.post_id]}</a>}
          </div>
        ))}</div>
      ) : (
        <div className={`drop ${drop ? "over" : ""}`} style={{ padding: "60px 20px" }} onClick={() => input.current?.click()}>
          <UploadSimple size={26} />
          <b>{rows.length ? "Nothing matches" : "Drop your first files"}</b>
          <span className="small dim">Images, videos up to 2 GB, audio, scripts. Your partner sees them the moment they land.</span>
        </div>
      )}
      {drop && <div className="page-drop">Drop to upload</div>}
      {view && <MediaViewer m={view} onClose={() => setView(null)}
        onDelete={async () => { if (await confirm({ title: "Delete this file?", body: `${view.name}. The R2 backup copy (if any) is kept.`, confirm: "Delete", danger: true })) { await deleteMedia(view); setView(null); } }} />}
    </div>
  );
}

export default function MediaLibrary() {
  return <Gate><MediaInner /></Gate>;
}
