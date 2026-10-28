import type { Metadata } from "next";
import { Suspense } from "react";
import Writing from "@/components/Writing";

export const metadata: Metadata = { title: "Writing room" };

export default function Page() {
  return <div className="page"><Suspense><Writing /></Suspense></div>;
}
