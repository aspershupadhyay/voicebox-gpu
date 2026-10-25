import type { Metadata } from "next";
import Gpu from "@/components/Gpu";

export const metadata: Metadata = { title: "GPU & engines" };

export default function Page() {
  return <div className="page"><Gpu /></div>;
}
