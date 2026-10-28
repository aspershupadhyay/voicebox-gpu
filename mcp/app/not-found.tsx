import Link from "next/link";
import { PixelScene } from "@/components/pixel";

export default function NotFound() {
  return (
    <main className="nf">
      <div className="nf-card">
        <PixelScene className="nf-scene" label="A quiet pixel desk at night" />
        <span className="nf-code">404</span>
        <h1>This page doesn&apos;t exist</h1>
        <p className="dim" style={{ margin: 0 }}>It may have moved when the studio was reorganised.</p>
        <Link href="/analytics" className="btn" style={{ marginTop: 8 }}>Back to the studio</Link>
      </div>
    </main>
  );
}
