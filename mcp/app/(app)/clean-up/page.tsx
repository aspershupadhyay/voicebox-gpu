import type { Metadata } from "next";
import Studio from "@/components/Studio";

export const metadata: Metadata = { title: "Clean-up" };

export default function Page() {
  return <div className="page"><Studio /></div>;
}
