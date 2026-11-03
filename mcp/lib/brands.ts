// Brands: the connected accounts grouped by who they are, so Grow can show one at a time. Any number of Instagram
// accounts and YouTube channels work: Catch the Error's Instagram ("CatchTheError") and YouTube ("CatchtheError") are one
// brand, Elite Minds is another, and a new account joins whichever brand its name or handle reads the same as (once case,
// spaces, punctuation, a leading "the" and a trailing "official", "HQ", "TV", "YT" or "IG" are dropped). When a name
// doesn't say, Grow → Audience → Accounts → "Group accounts" sets an account's brand by hand (kept in R2,
// workspace/analytics/brands.json), and that wins. Grow's switcher (?acc=<brand id>) and the analytics MCP tool's
// `account` pick one brand; scores, tips, hashtags and best times are then worked out for it alone (lib/analytics.ts).
import { getJson, putJson } from "./store";

export type Brand = { id: string; name: string; accounts: string[] };
type Acc = { id: string; name: string; handle: string | null; network: "youtube" | "instagram" };
/** account id → the brand name set by hand */
export type Groups = Record<string, string>;

/** "CatchTheError", "Catch the Error", "@catch_the_error" → "catchtheerror". */
export const brandKey = (s: string | null | undefined) => (s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");
/** The same, loosened: "The Elite Minds HQ", "eliteminds_official", "EliteMindsTV" → "eliteminds". */
const looseKey = (s: string | null | undefined) => brandKey(s).replace(/^the(?=.{3})/, "").replace(/(official|hq|tv|yt|ig)$/, "");

const FILE = "workspace/analytics/brands.json";
export async function getGroups(): Promise<Groups> {
  return (await getJson<Groups>(FILE).catch(() => null)) ?? {};
}
/** Put an account in a brand by hand (`brand` empty or null: back to automatic). Signed-in people only (the dash route). */
export async function setGroup(account: string, brand: string | null | undefined): Promise<Groups> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(account)) throw new Error("Not an account id");
  const g = await getGroups();
  const name = (brand ?? "").trim().slice(0, 60);
  if (name && brandKey(name)) g[account] = name; else delete g[account];
  await putJson(FILE, g);
  return g;
}

/** The accounts grouped into brands (a hand-set brand first, else name or handle), biggest brand first. */
export function brandsOf(accounts: Acc[], groups: Groups = {}): Brand[] {
  const sorted = [...accounts].sort((a, b) => Number(!groups[b.id]) - Number(!groups[a.id]) || a.network.localeCompare(b.network) || a.name.localeCompare(b.name));
  const out: (Brand & { keys: Set<string> })[] = [];
  for (const a of sorted) {
    const set = groups[a.id];
    const keys = [...new Set((set ? [brandKey(set), looseKey(set)] : [brandKey(a.name), looseKey(a.name), brandKey(a.handle), looseKey(a.handle)]).filter((k) => k.length >= 2))];
    // a hand-set account matches on the brand it was given only (not its own name), so one taken out of a brand stays out
    const b = out.find((x) => keys.some((k) => x.keys.has(k)));
    if (b) { b.accounts.push(a.id); keys.forEach((k) => b.keys.add(k)); continue; }
    out.push({ id: keys[0] || a.id, name: set || a.name || a.handle || a.id, accounts: [a.id], keys: new Set(keys) });
  }
  // ids are unique and stable even if two brands' keys collide
  const seen = new Set<string>();
  for (const b of out) { let id = b.id, n = 2; while (seen.has(id)) id = `${b.id}${n++}`; b.id = id; seen.add(id); }
  return out.sort((x, y) => y.accounts.length - x.accounts.length || x.name.localeCompare(y.name)).map(({ keys: _, ...b }) => b);
}

/** Which brand `acc` names: a brand id, or any of its accounts' ids, names or handles. Null: every account. */
export function pickBrand(brands: Brand[], accounts: Acc[], acc: string | null | undefined): Brand | null {
  const k = brandKey(acc);
  if (!acc || !k || k === "all") return null;
  const byId = brands.find((b) => b.id === acc || b.id === k) ?? brands.find((b) => b.accounts.includes(acc));
  if (byId) return byId;
  const a = accounts.find((x) => brandKey(x.name) === k || brandKey(x.handle) === k);
  return a ? brands.find((b) => b.accounts.includes(a.id)) ?? null : null;
}
