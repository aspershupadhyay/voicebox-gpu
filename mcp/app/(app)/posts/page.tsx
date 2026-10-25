import type { Metadata } from "next";
import { Suspense } from "react";
import Posts from "@/components/Posts";

export const metadata: Metadata = { title: "Posts" };

export default function Page() {
  return <div className="page wide"><Suspense><Posts /></Suspense></div>;
}
