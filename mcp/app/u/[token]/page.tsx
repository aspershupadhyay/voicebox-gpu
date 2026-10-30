// An upload link (lib/auto/uplinks.ts): public by design, like a share link. It only drops files into one folder.
import type { Metadata } from "next";
import { UploadLink } from "@/components/UploadLink";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Send files", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const l = (await import("@/lib/auto/uplinks")).openLink(token);
  return <UploadLink token={token} link={l ? { folder: l.name, by: l.by, expires: l.exp * 1000, max: l.max } : null} />;
}
