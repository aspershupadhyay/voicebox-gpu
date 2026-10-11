import Nav from "@/components/Nav";
import Dashboard from "@/components/Dashboard";
import { requireLogin } from "@/lib/guard";

export const dynamic = "force-dynamic";

export default async function Page() {
  await requireLogin();
  return <div className="shell"><Nav /><Dashboard /></div>;
}
