"use client";
// What the Auto-DM page's tabs share: the data from /api/dash/publish/autodm, small formatters and inputs.
import { X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { Automation, DmDefaults, DmSettings, ModRule } from "@/lib/publish/autodm";
import type { Stat, Totals } from "@/lib/publish/dmstore";

export type Acct = { id: string; handle: string | null; name: string; avatar: string | null; error: string | null; messages: boolean | null; subscribed: number | null };
export type Status = { flag: boolean; app_secret: boolean; verify_token: boolean; last_event: number | null; ai_key: boolean; ai_key_last4: string | null; accounts: Acct[] };
export type Overview = { settings: DmSettings; status: Status; stats: Record<string, Stat>; defaults: DmDefaults; totals: Totals | null };
export type { Automation, DmDefaults, DmSettings, ModRule, Stat, Totals };

export const ago = (t: number | string | null | undefined) => {
  if (!t) return "never";
  const m = Math.round((Date.now() - (typeof t === "string" ? Date.parse(t) : t)) / 6e4);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 60 * 36 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
export const handleOf = (a?: Acct) => (a ? `@${a.handle ?? a.name}` : "");
export const compact = (n: number) => Intl.NumberFormat(undefined, { notation: "compact" }).format(n);
export const rate = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "–");

/** What starts an automation and what it answers, in a few words: "Comments · CATCH (typos ok) · 2 posts". */
export function summary(a: Automation, accounts: Acct[]) {
  const on = [a.triggers.comments && "Comments", a.triggers.dms && "DMs", a.triggers.story_replies && "Story replies", a.triggers.mentions && "Story mentions"].filter(Boolean).join(", ") || "Nothing yet";
  const kw = a.match === "any" ? "anything" : a.keywords.length ? `${a.keywords.slice(0, 2).map((k) => k.toUpperCase()).join(" / ")}${a.keywords.length > 2 ? ` +${a.keywords.length - 2}` : ""}${a.match === "fuzzy" ? " (typos ok)" : ""}` : "";
  const where = !a.triggers.comments ? "" : a.where === "all" ? "every post" : `${a.media.length + a.posts.length} post${a.media.length + a.posts.length === 1 ? "" : "s"}`;
  const who = a.accounts.length && accounts.length > 1 ? a.accounts.map((id) => handleOf(accounts.find((x) => x.id === id)) || "an account").join(", ") : "";
  return [on, kw && (a.triggers.comments || a.triggers.dms || a.triggers.story_replies) ? kw : "", where, who].filter(Boolean).join(" · ");
}

/** The flow's extra steps, as short tags for a row. */
export function features(a: Automation) {
  return [
    a.follow_gate.on && "Followers",
    a.collect.on && "Email",
    a.choices.length > 0 && `${a.choices.length} choices`,
    a.ab.on && a.ab.message && (a.ab.winner ? `A/B: ${a.ab.winner.toUpperCase()} won` : "A/B"),
    a.ai.on && "AI",
    a.made_from && "Auto",
  ].filter(Boolean) as string[];
}

export function useDebounced<T>(v: T, ms = 300) {
  const [x, setX] = useState(v);
  useEffect(() => { const t = setTimeout(() => setX(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return x;
}

/** Download rows as a CSV file. */
export function downloadCsv(name: string, head: string[], rows: unknown[][]) {
  const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const out = [head.join(","), ...rows.map((r) => r.map(cell).join(","))].join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([out], { type: "text/csv" }));
  a.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Words as removable chips: type and press Enter or a comma. */
export function Chips({ value, set, placeholder, label, max = 30 }: { value: string[]; set: (v: string[]) => void; placeholder: string; label: string; max?: number }) {
  const [t, setT] = useState("");
  const add = (raw: string) => {
    const next = raw.split(",").map((x) => x.trim()).filter(Boolean).filter((x) => !value.some((v) => v.toLowerCase() === x.toLowerCase()));
    if (next.length) set([...value, ...next].slice(0, max));
    setT("");
  };
  return (
    <div className="dm-chips" onClick={(e) => (e.currentTarget.querySelector("input") as HTMLInputElement | null)?.focus()}>
      {value.map((v) => (
        <span key={v} className="chip-x">{v}<button type="button" className="icon-btn" aria-label={`Remove ${v}`} onClick={() => set(value.filter((x) => x !== v))}><X size={12} /></button></span>
      ))}
      <input aria-label={label} value={t} placeholder={value.length ? "" : placeholder}
        onChange={(e) => (e.target.value.includes(",") ? add(e.target.value) : setT(e.target.value))}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(t); } else if (e.key === "Backspace" && !t && value.length) set(value.slice(0, -1)); }}
        onBlur={() => t.trim() && add(t)} />
    </div>
  );
}

/** A choice of a few, as a segmented control. */
export function Seg<T extends string>({ value, set, options, label }: { value: T; set: (v: T) => void; options: readonly (readonly [T, string])[]; label: string }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map(([v, l]) => <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? "on" : ""} onClick={() => set(v)}>{l}</button>)}
    </div>
  );
}
