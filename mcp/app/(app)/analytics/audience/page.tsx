import type { Metadata } from "next";
import { AudienceView } from "@/components/Analytics";

export const metadata: Metadata = { title: "Audience · Analytics" };

export default function Page() {
  return <AudienceView />;
}
