import type { Metadata } from "next";
import Revoice from "@/components/Revoice";

export const metadata: Metadata = { title: "Re-voice" };

export default function Page() {
  return <div className="page"><Revoice /></div>;
}
