// Facebook Login for Business, for one thing: reading rivals' Instagram accounts. Instagram only shares another
// account's followers and posts (Business Discovery) with an app signed in through Facebook, through a Facebook Page
// that has your Instagram linked to it. Publishing and your own analytics stay on Instagram Login (instagram.ts).
//
// Setup (docs/PUBLISHING.md → "Instagram rivals"): the Meta app's Facebook Login for Business, configuration
// FACEBOOK_LOGIN_CONFIG_ID with instagram_basic, pages_show_list, pages_read_engagement and business_management, the
// redirect https://<site>/api/publish/facebook/callback, and FACEBOOK_APP_SECRET on the Worker. On connect the sign-in's
// token is swapped for each Page's own token (a Page token from a long-lived sign-in doesn't expire while the person
// stays a Page admin); they're sealed in R2 (workspace/publish/facebook.json) and never leave the server.
import { getJson, putJson } from "../store";
import { sealJson, unsealJson } from "./accounts";

const V = "v24.0";
const GRAPH = `https://graph.facebook.com/${V}`;
/** Not secrets: both travel in the sign-in link anyone's browser sees. */
export const APP_ID = () => process.env.FACEBOOK_APP_ID || "1607876027034664";
const CONFIG_ID = () => process.env.FACEBOOK_LOGIN_CONFIG_ID || "1676190047634985";
const FILE = "workspace/publish/facebook.json";

export const fbConfigured = () => !!process.env.FACEBOOK_APP_SECRET;

export type FbPage = { id: string; name: string; ig: { id: string; username: string } | null };
type Stored = { by: string; at: number; user: string | null; pages: FbPage[]; sealed: string; granted?: string[]; declined?: string[] };
export type FbStatus = { configured: boolean; connected: boolean; by: string | null; at: number | null; user: string | null; pages: FbPage[]; granted: string[]; declined: string[] };
/** What Business Discovery needs on the sign-in (the configuration asks for these). */
export const NEEDED = ["instagram_basic", "pages_show_list", "pages_read_engagement", "business_management"];

type GErr = { error?: { message?: string; code?: number; error_subcode?: number; error_user_msg?: string } };
export class FbError extends Error {
  constructor(message: string, public code = 0) { super(message); }
}
async function fb<T>(path: string, params: Record<string, string>): Promise<T> {
  const r = await fetch(`${path.startsWith("http") ? path : GRAPH + path}?${new URLSearchParams(params)}`, { cache: "no-store" });
  const j = (await r.json().catch(() => ({}))) as T & GErr;
  if (!r.ok || j.error) {
    const e = j.error ?? {};
    const nice: Record<number, string> = {
      190: "The Facebook connection expired or was removed. Connect Facebook again.",
      10: "Facebook didn't give Voicebox this permission. Connect Facebook again and allow every permission it asks for.",
      200: "Facebook didn't give Voicebox this permission. Connect Facebook again and allow every permission it asks for.",
      4: "Facebook is rate limiting. Try again in a few minutes.",
      17: "Facebook is rate limiting. Try again in a few minutes.",
      110: "Instagram can't find that account, or it isn't a Business or Creator account (Instagram only shares those).",
    };
    const said = e.message ? ` (Facebook: "${e.message}", code ${e.code ?? "?"}${e.error_subcode ? `/${e.error_subcode}` : ""})` : "";
    throw new FbError(`${nice[e.code ?? -1] ?? e.error_user_msg ?? e.message ?? `Facebook ${r.status}`}${nice[e.code ?? -1] ? said : ""}`, e.code ?? 0);
  }
  return j;
}

/** Where the Connect button sends you: Facebook's sign-in with the app's configuration (its permissions). */
export function authUrl(redirect: string, state: string) {
  const u = new URL(`https://www.facebook.com/${V}/dialog/oauth`);
  u.search = new URLSearchParams({ client_id: APP_ID(), config_id: CONFIG_ID(), redirect_uri: redirect, response_type: "code", override_default_response_type: "true", state }).toString();
  return u.toString();
}

/** The callback: code → sign-in token → long-lived → each Page's own token and its linked Instagram. */
export async function connect(code: string, redirect: string, by: string): Promise<FbStatus> {
  if (!fbConfigured()) throw new FbError("Facebook isn't set up yet: add FACEBOOK_APP_SECRET on the Worker (docs/PUBLISHING.md).");
  const short = await fb<{ access_token: string }>("/oauth/access_token", { client_id: APP_ID(), client_secret: process.env.FACEBOOK_APP_SECRET!, redirect_uri: redirect, code });
  const long = await fb<{ access_token: string }>("/oauth/access_token", { grant_type: "fb_exchange_token", client_id: APP_ID(), client_secret: process.env.FACEBOOK_APP_SECRET!, fb_exchange_token: short.access_token }).catch(() => short);
  const me = await fb<{ name?: string }>("/me", { fields: "name", access_token: long.access_token }).catch(() => ({ name: undefined }));
  const perms = await fb<{ data?: { permission: string; status: string }[] }>("/me/permissions", { access_token: long.access_token }).catch(() => ({ data: [] as { permission: string; status: string }[] }));
  const granted = (perms.data ?? []).filter((p) => p.status === "granted").map((p) => p.permission);
  const declined = (perms.data ?? []).filter((p) => p.status !== "granted").map((p) => p.permission);
  type P = { id: string; name: string; access_token?: string; instagram_business_account?: { id: string; username?: string } };
  const pages: P[] = [];
  let next: string | null = `${GRAPH}/me/accounts`;
  for (let i = 0; next && i < 5; i++) {
    const r: { data?: P[]; paging?: { next?: string } } = await fb<{ data?: P[]; paging?: { next?: string } }>(next, i === 0 ? { fields: "id,name,access_token,instagram_business_account{id,username}", limit: "50", access_token: long.access_token } : {});
    pages.push(...(r.data ?? []));
    next = r.paging?.next ?? null;
  }
  if (!pages.length) throw new FbError("Facebook signed you in but shared no Pages. Connect again and tick the Facebook Page that your Instagram is linked to.");
  const withIg = pages.filter((p) => p.instagram_business_account && p.access_token);
  if (!withIg.length) throw new FbError(`None of your Pages (${pages.map((p) => p.name).join(", ")}) has an Instagram account linked. Link one (the Page's Settings → Linked accounts → Instagram), then connect again.`);
  // each Page's own token, and the long-lived sign-in itself (60 days) as a fallback: Business Discovery takes either
  const tokens: Record<string, string> = { ...Object.fromEntries(withIg.map((p) => [p.id, p.access_token!])), __user: long.access_token };
  const stored: Stored = {
    by, at: Date.now(), user: me.name ?? null, sealed: sealJson(tokens), granted, declined,
    pages: pages.map((p) => ({ id: p.id, name: p.name, ig: p.instagram_business_account ? { id: p.instagram_business_account.id, username: p.instagram_business_account.username ?? "" } : null })),
  };
  await putJson(FILE, stored);
  return status();
}

export async function status(): Promise<FbStatus> {
  const s = await getJson<Stored>(FILE).catch(() => null);
  return { configured: fbConfigured(), connected: !!s, by: s?.by ?? null, at: s?.at ?? null, user: s?.user ?? null, pages: s?.pages ?? [], granted: s?.granted ?? [], declined: s?.declined ?? [] };
}

export async function disconnect() {
  await putJson(FILE, null);
}

/** A Page with an Instagram linked and its token, to ask Business Discovery through. */
async function via(): Promise<{ ig: string; token: string; user: string | null } | null> {
  const s = await getJson<Stored>(FILE).catch(() => null);
  if (!s) return null;
  const tokens = unsealJson<Record<string, string>>(s.sealed);
  const p = s.pages.find((x) => x.ig && tokens[x.id]);
  return p ? { ig: p.ig!.id, token: tokens[p.id], user: tokens.__user ?? null } : null;
}

export type DiscoveredMedia = {
  id: string; caption?: string; like_count?: number; comments_count?: number; timestamp: string; media_type: string;
  media_product_type?: string; permalink?: string; thumbnail_url?: string; media_url?: string;
};
export type Discovered = {
  id: string; username: string; name?: string; biography?: string; website?: string; profile_picture_url?: string;
  followers_count?: number; follows_count?: number; media_count?: number; media?: { data: DiscoveredMedia[] };
};

/** Another Business or Creator account's public profile and its latest posts (Instagram's Business Discovery). */
export async function discover(username: string, posts = 50): Promise<Discovered> {
  const u = username.replace(/^@/, "").trim().toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/.test(u)) throw new FbError("That isn't an Instagram username.");
  const v = await via();
  if (!v) throw new FbError("Connect Facebook first (Grow → Competitors → Connect Facebook): Instagram only shares other accounts' numbers that way.");
  const fields = `business_discovery.username(${u}){id,username,name,biography,website,profile_picture_url,followers_count,follows_count,media_count,media.limit(${Math.min(100, Math.max(1, posts))}){id,caption,like_count,comments_count,timestamp,media_type,media_product_type,permalink,thumbnail_url,media_url}}`;
  const ask = (token: string) => fb<{ business_discovery?: Discovered }>(`/${v.ig}`, { fields, access_token: token });
  const r = await ask(v.token).catch(async (e: FbError) => {
    if (e.code !== 10 && e.code !== 200) throw e;
    // the Page's token was refused: try the sign-in's own token, then say which permissions are missing
    if (v.user) { const ok = await ask(v.user).catch(() => null); if (ok) return ok; }
    const dbg = await fb<{ data?: { scopes?: string[]; granular_scopes?: { scope: string }[] } }>("/debug_token", { input_token: v.user ?? v.token, access_token: `${APP_ID()}|${process.env.FACEBOOK_APP_SECRET}` }).catch(() => null);
    const has = dbg?.data?.scopes ?? [];
    const missing = NEEDED.filter((p) => !has.includes(p));
    throw new FbError(`${e.message}${has.length ? ` The connection has: ${has.join(", ")}.${missing.length ? ` Missing: ${missing.join(", ")}.` : ""}` : ""}`, e.code);
  });
  if (!r.business_discovery) throw new FbError(`Instagram didn't return @${u}. It may be a personal account (Instagram only shares Business and Creator accounts).`);
  return r.business_discovery;
}
