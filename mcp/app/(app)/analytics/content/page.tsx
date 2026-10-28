import type { Metadata } from "next";
import { ContentView } from "@/components/Analytics";

export const metadata: Metadata = { title: "Content · Analytics" };

export default function Page() {
  return <ContentView />;
}
