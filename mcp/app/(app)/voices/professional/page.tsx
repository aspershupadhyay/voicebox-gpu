import type { Metadata } from "next";
import MyModel from "@/components/MyModel";

export const metadata: Metadata = { title: "Professional voice clone" };

export default function Page() {
  return <div className="page"><MyModel /></div>;
}
