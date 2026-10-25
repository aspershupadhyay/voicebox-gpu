import type { Metadata } from "next";
import CloneVoice from "@/components/CloneVoice";

export const metadata: Metadata = { title: "Instant voice clone" };

export default function Page() {
  return <div className="page"><CloneVoice /></div>;
}
