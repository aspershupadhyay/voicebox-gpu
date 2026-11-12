// The public legal pages Meta asks for before an app can be published (/privacy, /terms, /data-deletion): plain
// text in the studio's matte black, readable at 390px, no sign-in and no data.
import Link from "next/link";

export const UPDATED = "November 12, 2026";
export const ACCOUNTS = ["@catchtheerror", "@byeliteminds"];

export function LegalPage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="legal">
      <nav className="legal-nav" aria-label="Legal">
        <b>Voicebox Studio</b>
        <span><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link><Link href="/data-deletion">Data deletion</Link></span>
      </nav>
      <h1>{title}</h1>
      <p className="legal-updated">Last updated {UPDATED}</p>
      {children}
    </main>
  );
}
