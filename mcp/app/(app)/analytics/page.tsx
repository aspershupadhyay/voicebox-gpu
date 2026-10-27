import type { Metadata } from "next";
import Analytics from "@/components/Analytics";

export const metadata: Metadata = { title: "Analytics" };

export default function Page() {
  return <div className="page wide"><Analytics /></div>;
}
