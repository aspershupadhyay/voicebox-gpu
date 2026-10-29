import type { Metadata } from "next";
import Download from "@/components/Download";

export const metadata: Metadata = { title: "Download" };

export default function Page() {
  return <div className="page"><Download /></div>;
}
