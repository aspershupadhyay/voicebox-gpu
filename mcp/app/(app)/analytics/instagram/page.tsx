import type { Metadata } from "next";
import { InstagramView } from "@/components/Analytics";

export const metadata: Metadata = { title: "Instagram · Analytics" };

export default function Page() {
  return <InstagramView />;
}
