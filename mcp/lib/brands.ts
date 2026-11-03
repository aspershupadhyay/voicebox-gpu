// Brands: the connected accounts grouped by who they are, so Grow can show one at a time. Catch the Error's Instagram
// ("CatchTheError") and its YouTube channel ("CatchtheError") are one brand; Elite Minds is another. Accounts join a
// brand when their names (or handles) read the same once case, spaces and punctuation are dropped. Grow's switcher
// (?acc=<brand id>) and the analytics MCP tool's `account` pick one; scores, tips, hashtags and best times are then
// worked out for that brand alone, never across brands (lib/analytics.ts).

export type Brand = { id: string; name: string; accounts: string[] };
type Acc = { id: string; name: string; handle: string | null; network: "youtube" | "instagram" };

/** "CatchTheError", "Catch the Error", "@catch_the_error" → "catchtheerror". */
export const brandKey = (s: string | null | undefined) => (s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");

/** The accounts grouped into brands, Instagram's name first (it carries the brand's capitals), biggest brand first. */
export function brandsOf(accounts: Acc[]): Brand[] {
  const sorted = [...accounts].sort((a, b) => a.network.localeCompare(b.network) || a.name.localeCompare(b.name));
  const out: (Brand & { keys: Set<string> })[] = [];
  for (const a of sorted) {
    const keys = [brandKey(a.name), brandKey(a.handle)].filter(Boolean);
    const b = out.find((x) => keys.some((k) => x.keys.has(k)));
    if (b) { b.accounts.push(a.id); keys.forEach((k) => b.keys.add(k)); continue; }
    out.push({ id: keys[0] || brandKey(a.id) || a.id, name: a.name || a.handle || a.id, accounts: [a.id], keys: new Set(keys) });
  }
  return out.sort((x, y) => y.accounts.length - x.accounts.length || x.name.localeCompare(y.name)).map(({ keys: _, ...b }) => b);
}

/** Which brand `acc` names: a brand id, or any of its accounts' ids, names or handles. Null: every account. */
export function pickBrand(brands: Brand[], accounts: Acc[], acc: string | null | undefined): Brand | null {
  const k = brandKey(acc);
  if (!acc || !k || k === "all") return null;
  const byId = brands.find((b) => b.id === k) ?? brands.find((b) => b.accounts.includes(acc));
  if (byId) return byId;
  const a = accounts.find((x) => brandKey(x.name) === k || brandKey(x.handle) === k);
  return a ? brands.find((b) => b.accounts.includes(a.id)) ?? null : null;
}
