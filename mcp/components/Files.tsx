"use client";
// Files: everything in one place. Generated = what the GPU made (takes, subtitles, images, videos), kept in your R2
// bucket. Uploads = what the two of you added to the shared workspace (thumbnails, B-roll, final cuts).
import { Microphone } from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import Library from "./Library";
import MediaLibrary from "./MediaLibrary";
import { PageHeader } from "./ui";
import { Info } from "./Info";

export default function Files() {
  const params = useSearchParams();
  const router = useRouter();
  const tab = params.get("tab") === "uploads" ? "uploads" : "generated";
  const pick = (t: "generated" | "uploads") => router.replace(t === "uploads" ? "/files?tab=uploads" : "/files", { scroll: false });
  return (
    <>
      <PageHeader title="Files" sub={<>Every take, subtitle, image and upload, kept privately. <Info label="Where files are kept">Generated files live in your R2 bucket, so they stay after the GPU shuts down. Uploads live in the shared workspace (Appwrite), backed up to R2 when they fit.</Info></>}
        actions={<Link href="/voiceover" className="btn"><Microphone size={15} weight="bold" />New voiceover</Link>} />
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "generated"} className={tab === "generated" ? "on" : ""} onClick={() => pick("generated")}>Generated</button>
        <button role="tab" aria-selected={tab === "uploads"} className={tab === "uploads" ? "on" : ""} onClick={() => pick("uploads")}>Uploads</button>
      </div>
      {tab === "generated" ? <Library /> : <MediaLibrary />}
    </>
  );
}
