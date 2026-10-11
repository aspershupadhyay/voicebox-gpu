import Nav from "@/components/Nav";
import Library from "@/components/Library";
import { requireLogin } from "@/lib/guard";

export const dynamic = "force-dynamic";

export default async function Page() {
  await requireLogin();
  return <div className="shell"><Nav /><Library /></div>;
}
