import type { Metadata } from "next";
import { Suspense } from "react";
import Files from "@/components/Files";

export const metadata: Metadata = { title: "Files" };

export default function Page() {
  return <div className="page"><Suspense><Files /></Suspense></div>;
}
