import type { Metadata } from "next";
import Home from "@/components/Home";

export const metadata: Metadata = { title: "Home" };

export default function Page() {
  return <div className="page"><Home /></div>;
}
