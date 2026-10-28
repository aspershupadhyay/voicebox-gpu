import type { Metadata } from "next";
import { YouTubeView } from "@/components/Analytics";

export const metadata: Metadata = { title: "YouTube · Analytics" };

export default function Page() {
  return <YouTubeView />;
}
