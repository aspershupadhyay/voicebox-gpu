"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [["/", "Dashboard"], ["/generate", "Generate"], ["/library", "Library"]] as const;

export default function Nav() {
  const path = usePathname();
  return (
    <nav className="nav">
      <span className="brand">voice<b>box</b></span>
      {TABS.map(([href, name]) => (
        <Link key={href} href={href} className={`tab ${path === href ? "on" : ""}`}>{name}</Link>
      ))}
      <span className="grow" />
      <button className="ghost tiny" onClick={async () => { await fetch("/api/login", { method: "DELETE" }); location.href = "/login"; }}>
        Log out
      </button>
    </nav>
  );
}
