import type { Metadata } from "next";
import { TimingView } from "@/components/Analytics";

export const metadata: Metadata = { title: "When to post · Analytics" };

export default function Page() {
  return <TimingView />;
}
