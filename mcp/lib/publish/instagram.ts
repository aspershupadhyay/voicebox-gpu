// Instagram: "Instagram API with Instagram Login" (INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET from a Meta app with the
// Instagram product). Needs a Business or Creator account. Posting is two steps: make a container from a public URL of
// the file (Instagram fetches it), wait until it's FINISHED, then publish it. Long-lived tokens last 60 days and are
// refreshed automatically well before that. About 100 API posts a day per account (content_publishing_limit says).
import { patchAccount, saveAccount, type Account, type Tokens } from "./accounts";
import type { IgOptions } from "./shared";

const V = "v24.0";
const GRAPH = `https://graph.instagram.com/${V}`;
export const SCOPES = ["instagram_business_basic", "instagram_business_content_publish", "instagram_business_manage_comments"];

export class IgError extends Error {
  constructor(message: string, public status = 0, public code = 0, public transient_ = false) { super(message); }
  get transient() { return this.transient_ || this.status === 0 || this.status >= 500 || [1, 2, 4, 17, 341, 368, 9007].includes(this.code); }
}

type GErr = { error?: { message?: string; code?: number; error_subcode?: number; is_transient?: boolean; error_user_msg?: string } };
function igErr(status: number, j: GErr) {
  const e = j.error ?? {};
  const nice: Record<number, string> = {
    190: "The Instagram connection expired. Reconnect the account.",
    10: "Instagram didn't give Voicebox permission for this. Reconnect and allow publishing.",
    9: "Instagram's daily posting limit for this account is reached. Voicebox will try again.",
    4: "Instagram is rate limiting. Voicebox will try again shortly.",
    36003: "Instagram didn't accept the aspect ratio. Feed photos must be between 4:5 and 1.91:1.",
    2207026: "Instagram didn't accept the video format. Use MP4 (H.264, AAC), 3 s to 15 min, under 300 MB.",
  };
  return new IgError(nice[e.error_subcode ?? -1] ?? nice[e.code ?? -1] ?? e.error_user_msg ?? e.message ?? `Instagram ${status}`, status, e.code ?? 0, !!e.is_transient);
}

async function ig<T>(path: string, token: string, init: { method?: string; params?: Record<string, string | undefined> } = {}): Promise<T> {
  const params = new URLSearchParams(Object.entries(init.params ?? {}).filter(([, v]) => v !== undefined) as [string, string][]);
  const method = init.method ?? "GET";
  const url = `${path.startsWith("http") ? path : GRAPH + path}${method === "GET" ? `?${params}${params.size ? "&" : ""}access_token=${encodeURIComponent(token)}` : ""}`;
  if (method !== "GET") params.set("access_token", token);
  const r = await fetch(url, method === "GET" ? { cache: "no-store" } : { method, cache: "no-store", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params });
  const j = (await r.json().catch(() => ({}))) as T & GErr;
  if (!r.ok || j.error) throw igErr(r.status, j);
  return j;
}

export function authUrl(redirect: string, state: string) {
  const u = new URL("https://www.instagram.com/oauth/authorize");
  u.search = new URLSearchParams({ client_id: process.env.INSTAGRAM_APP_ID ?? "", redirect_uri: redirect, response_type: "code", scope: SCOPES.join(","), state, enable_fb_login: "0", force_reauth: "true" }).toString();
  return u.toString();
}

type Me = { user_id: string; username: string; name?: string; profile_picture_url?: string; account_type?: string; followers_count?: number };

export async function connect(code: string, redirect: string, by: string): Promise<Account> {
  const short = await fetch("https://api.instagram.com/oauth/access_token", {
    method: "POST", cache: "no-store", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.INSTAGRAM_APP_ID ?? "", client_secret: process.env.INSTAGRAM_APP_SECRET ?? "", grant_type: "authorization_code", redirect_uri: redirect, code: code.replace(/#_$/, "") }),
  }).then((r) => r.json() as Promise<{ access_token?: string; error_message?: string; error?: { message?: string } }>);
  if (!short.access_token) throw new IgError(short.error_message ?? short.error?.message ?? "Instagram sign-in failed");
  const long = await ig<{ access_token: string; expires_in: number }>(`https://graph.instagram.com/access_token`, short.access_token, { params: { grant_type: "ig_exchange_token", client_secret: process.env.INSTAGRAM_APP_SECRET } });
  const me = await ig<Me>("/me", long.access_token, { params: { fields: "user_id,username,name,profile_picture_url,account_type,followers_count" } });
  if (me.account_type && !["BUSINESS", "MEDIA_CREATOR"].includes(me.account_type))
    throw new IgError("This is a personal Instagram account. Switch it to Creator or Business (Instagram → Settings → Account type), then connect again.");
  const expires_at = Date.now() + long.expires_in * 1000;
  const account: Account = {
    id: me.user_id, network: "instagram", name: me.name || me.username, handle: me.username, avatar: me.profile_picture_url ?? null,
    connected_at: Date.now(), by, kind: me.account_type ?? null, subscribers: me.followers_count ?? null, expires_at, error: null,
  };
  await saveAccount(account, { access_token: long.access_token, expires_at, refresh_token: null });
  return account;
}

/** A working token; refreshed (another 60 days) once it's more than a day old and within 20 days of running out. */
export async function accessToken(a: Account & { tokens: Tokens }, force = false) {
  const left = a.tokens.expires_at - Date.now();
  if (left <= 0) throw new IgError("The Instagram connection expired. Reconnect the account.", 401, 190);
  if (!force && left > 20 * 864e5) return a.tokens.access_token;
  try {
    const r = await ig<{ access_token: string; expires_in: number }>("https://graph.instagram.com/refresh_access_token", a.tokens.access_token, { params: { grant_type: "ig_refresh_token" } });
    const tokens = { ...a.tokens, access_token: r.access_token, expires_at: Date.now() + r.expires_in * 1000 };
    await patchAccount(a.id, { expires_at: tokens.expires_at, error: null }, tokens);
    a.tokens = tokens;
    return tokens.access_token;
  } catch (e) {
    if (left > 864e5) return a.tokens.access_token; // still good for now; try the refresh again next time
    await patchAccount(a.id, { error: (e as Error).message }).catch(() => null);
    throw e;
  }
}

export const publishingLimit = (token: string, user: string) =>
  ig<{ data: { quota_usage: number; config?: { quota_total: number; quota_duration: number } }[] }>(`/${user}/content_publishing_limit`, token, { params: { fields: "quota_usage,config" } })
    .then((r) => ({ used: r.data[0]?.quota_usage ?? 0, total: r.data[0]?.config?.quota_total ?? 100 }));

export type IgItem = { kind: "image" | "video"; url: string };

/** One container: a Reel, a Story, a single photo, or a carousel child. */
export async function createContainer(token: string, user: string, item: IgItem, space: string, o: IgOptions, extra: { cover_url?: string | null; child?: boolean } = {}) {
  const p: Record<string, string | undefined> = {};
  if (item.kind === "video") p.video_url = item.url; else p.image_url = item.url;
  if (extra.child) {
    p.is_carousel_item = "true";
    if (item.kind === "video") p.media_type = "VIDEO";
  } else if (space === "ig_story") {
    p.media_type = "STORIES";
    if (o.user_tags.length) p.user_tags = JSON.stringify(o.user_tags.map((username) => ({ username })));
  } else {
    if (space === "ig_reel" || item.kind === "video") {
      p.media_type = "REELS";
      p.share_to_feed = String(o.share_to_feed);
      if (extra.cover_url) p.cover_url = extra.cover_url; else if (o.thumb_offset_ms != null) p.thumb_offset = String(o.thumb_offset_ms);
      if (o.audio_name) p.audio_name = o.audio_name;
      if (o.trial) p.trial_params = JSON.stringify({ graduation_strategy: o.trial });
    } else if (o.alt_text) p.alt_text = o.alt_text;
    p.caption = o.caption;
    if (o.collaborators.length) p.collaborators = JSON.stringify(o.collaborators);
    if (o.location_id) p.location_id = o.location_id;
    if (o.user_tags.length) p.user_tags = JSON.stringify(o.user_tags.map((username) => (item.kind === "image" ? { username, x: 0.5, y: 0.5 } : { username })));
    if (o.ai_generated) p.is_ai_generated = "true";
  }
  if (extra.child && item.kind === "image" && o.alt_text) p.alt_text = o.alt_text;
  return (await ig<{ id: string }>(`/${user}/media`, token, { method: "POST", params: p })).id;
}

export async function createCarousel(token: string, user: string, children: string[], o: IgOptions) {
  const p: Record<string, string | undefined> = { media_type: "CAROUSEL", children: children.join(","), caption: o.caption };
  if (o.collaborators.length) p.collaborators = JSON.stringify(o.collaborators);
  if (o.location_id) p.location_id = o.location_id;
  if (o.ai_generated) p.is_ai_generated = "true";
  return (await ig<{ id: string }>(`/${user}/media`, token, { method: "POST", params: p })).id;
}

export const containerStatus = (token: string, id: string) =>
  ig<{ status_code: "IN_PROGRESS" | "FINISHED" | "ERROR" | "EXPIRED" | "PUBLISHED"; status?: string }>(`/${id}`, token, { params: { fields: "status_code,status" } });

export const publish = (token: string, user: string, creation: string) =>
  ig<{ id: string }>(`/${user}/media_publish`, token, { method: "POST", params: { creation_id: creation } }).then((r) => r.id);

export const permalink = (token: string, media: string) =>
  ig<{ permalink?: string; shortcode?: string }>(`/${media}`, token, { params: { fields: "permalink,shortcode" } }).then((r) => r.permalink ?? (r.shortcode ? `https://www.instagram.com/p/${r.shortcode}/` : null));

export const comment = (token: string, media: string, message: string) =>
  ig<{ id: string }>(`/${media}/comments`, token, { method: "POST", params: { message } });
