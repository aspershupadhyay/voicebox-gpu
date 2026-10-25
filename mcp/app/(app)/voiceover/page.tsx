import type { Metadata } from "next";
import Voiceover from "@/components/Voiceover";

export const metadata: Metadata = { title: "Voiceover" };

export default function Page() {
  return <Voiceover />;
}
