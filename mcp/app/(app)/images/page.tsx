import type { Metadata } from "next";
import Images from "@/components/Images";

export const metadata: Metadata = { title: "Images" };

export default function Page() {
  return <div className="page wide"><Images /></div>;
}
