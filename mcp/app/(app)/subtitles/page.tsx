import type { Metadata } from "next";
import Subtitles from "@/components/Subtitles";

export const metadata: Metadata = { title: "Subtitles" };

export default function Page() {
  return <div className="page"><Subtitles /></div>;
}
