import Shell from "@/components/Shell";
import { requireLogin } from "@/lib/guard";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireLogin();
  return <Shell>{children}</Shell>;
}
