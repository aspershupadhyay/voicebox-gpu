"use client";
// What the Auto-DM page's tabs share: the data from /api/dash/publish/autodm, small formatters and inputs.
import { X } from "@phosphor-icons/react";
import { useState } from "react";
import type { Automation, DmDefaults, DmSettings } from "@/lib/publish/autodm";

export type Acct = { id: string; handle: string | null; name: string; avatar: string | null; error: string | null; messages: boolean | null; subscribed: number | null };
export type Status = { flag: boolean; app_secret: boolean; verify_token: boolean; last_event: number | null; accounts: Acct[] };
export type Stat = { total: number; sent: number; gated: number; failed: number; last: string | null };
export type Overview = {
  settings: DmSettings; status: Status; stats: Record<string, Stat>; defaults: DmDefaults;
  totals: { total: number; sent: number; gated: number; failed: number; people: number } | null;
};
export type { Automation, DmDefaults, DmSettings };

export const ago = (t: number | string | null | undefined) => {
  if (!t) return "never";
  const m = Math.round((Date.now() - (typeof t === "string" ? Date.parse(t) : t)) / 6e4);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 60 * 36 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
export const handleOf = (a?: Acct) => (a ? `@${a.handle ?? a.name}` : "");
export const compact = (n: number) => Intl.NumberFormat(undefined, { notation: "compact" }).format(n);

/** What an automation does, in one line: "Comments with CATCH on 2 posts → DM with a button, follow first". */
export function summary(a: Automation, accounts: Acct[]) {
  const on = [a.triggers.comments && "comments", a.triggers.dms && "DMs", a.triggers.story_replies && "story replies"].filter(Boolean).join(", ") || "nothing";
  const kw = a.match === "any" ? "anything" : `${a.match === "exact" ? "exactly " : ""}${a.keywords.slice(0, 3).map((k) => k.toUpperCase()).join(" / ")}${a.keywords.length > 3 ? ` +${a.keywords.length - 3}` : ""}${a.match === "fuzzy" ? " (typos ok)" : ""}`;
  const where = !a.triggers.comments ? "" : a.where === "all" ? " on every post" : ` on ${a.media.length + a.posts.length} post${a.media.length + a.posts.length === 1 ? "" : "s"}`;
  const who = a.accounts.length ? ` · ${a.accounts.map((id) => handleOf(accounts.find((x) => x.id === id)) || "an account").join(", ")}` : "";
  return `${on[0].toUpperCase()}${on.slice(1)} with ${kw}${where}${a.follow_gate.on ? " · followers only" : ""}${who}`;
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
