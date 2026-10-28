import type { Metadata } from "next";
import { Suspense } from "react";
import Settings from "@/components/Settings";

export const metadata: Metadata = { title: "Settings" };

export default function Page() {
  return <div className="page"><Suspense><Settings /></Suspense></div>;
}
