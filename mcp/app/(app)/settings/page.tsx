import type { Metadata } from "next";
import Settings from "@/components/Settings";

export const metadata: Metadata = { title: "Settings" };

export default function Page() {
  return <div className="page"><Settings /></div>;
}
