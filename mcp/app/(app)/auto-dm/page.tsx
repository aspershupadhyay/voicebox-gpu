import type { Metadata } from "next";
import { Suspense } from "react";
import AutoDm from "@/components/autodm/AutoDm";

export const metadata: Metadata = { title: "Auto-DM" };

export default function Page() {
  return <div className="page"><Suspense><AutoDm /></Suspense></div>;
}
