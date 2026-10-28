import Link from "next/link";
import { Logo } from "@/components/art";

export default function NotFound() {
  return (
    <main className="nf">
      <div className="nf-card">
        <Logo size={36} />
        <span className="nf-code">404</span>
        <h1>This page doesn&apos;t exist</h1>
        <p className="dim" style={{ margin: 0 }}>It may have moved when the studio was reorganised.</p>
        <Link href="/home" className="btn" style={{ marginTop: 8 }}>Back to the studio</Link>
      </div>
    </main>
  );
}
