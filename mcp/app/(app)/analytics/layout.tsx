import { Suspense } from "react";
import AnalyticsShell from "@/components/AnalyticsShell";

// Analytics' six views share one frame (header, range, account, tabs) and one loaded report: see
// components/AnalyticsShell.tsx. The frame reads the link's ?acc=, so it sits inside Suspense too.
export default function Layout({ children }: { children: React.ReactNode }) {
  return <div className="page wide"><Suspense><AnalyticsShell><Suspense>{children}</Suspense></AnalyticsShell></Suspense></div>;
}
