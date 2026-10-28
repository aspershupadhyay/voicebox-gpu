// A share link (lib/shares.ts): public by design, but it shows only what one unexpired, unrevoked link names. The token
// in the address is checked against its SHA-256; anything else (a wrong, expired or revoked link) is the same page.
import type { Metadata } from "next";
import { SharePage } from "@/components/SharePage";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Shared with you", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { openShare } = await import("@/lib/shares");
  const got = await openShare(token).catch(() => null);
  return <SharePage data={got ? { name: got.share.name, kind: got.share.kind, expires: got.share.expires, by: got.share.by, downloads: got.share.downloads, files: got.files } : null} />;
}
