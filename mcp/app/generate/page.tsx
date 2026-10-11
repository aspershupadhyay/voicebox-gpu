import Nav from "@/components/Nav";
import Generate from "@/components/Generate";
import { requireLogin } from "@/lib/guard";

export const dynamic = "force-dynamic";

export default async function Page() {
  await requireLogin();
  return <div className="shell"><Nav /><Generate /></div>;
}
