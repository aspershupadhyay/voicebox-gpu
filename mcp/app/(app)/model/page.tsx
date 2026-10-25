import type { Metadata } from "next";
import MyModel from "@/components/MyModel";

export const metadata: Metadata = { title: "Voice model" };

export default function Page() {
  return <div className="page"><MyModel /></div>;
}
