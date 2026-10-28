import type { Metadata } from "next";
import { Overview } from "@/components/Analytics";

export const metadata: Metadata = { title: "Analytics" };

export default function Page() {
  return <Overview />;
}
