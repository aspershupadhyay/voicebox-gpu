import { Suspense } from "react";
import AnalyticsShell from "@/components/AnalyticsShell";

// Analytics' six views share one frame (header, range, tabs) and one loaded report: see components/AnalyticsShell.tsx.
export default function Layout({ children }: { children: React.ReactNode }) {
  return <div className="page wide"><AnalyticsShell><Suspense>{children}</Suspense></AnalyticsShell></div>;
}
