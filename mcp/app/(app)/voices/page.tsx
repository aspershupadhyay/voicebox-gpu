import type { Metadata } from "next";
import Voices from "@/components/Voices";

export const metadata: Metadata = { title: "Voices" };

export default function Page() {
  return <div className="page"><Voices /></div>;
}
