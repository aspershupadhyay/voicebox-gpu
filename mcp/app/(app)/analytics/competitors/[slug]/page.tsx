import { RivalView } from "@/components/Grow";

export const metadata = { title: "Rival · Grow" };

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  return <RivalView slug={(await params).slug} />;
}
