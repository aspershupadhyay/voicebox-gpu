// YouTube: sign in with Google (YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET, a Google Cloud OAuth client with the YouTube
// Data API v3 on), then resumable uploads straight from storage to YouTube in 32 MB pieces. A run stops before the
// function's time is up and the next one carries on from YouTube's own offset, so any size gets there.
// Quota: an upload is its own bucket (about 100 a day by default); thumbnails and playlists come from the 10,000-unit one.
import { patchAccount, saveAccount, type Account, type Tokens } from "./accounts";
import type { YtOptions } from "./shared";

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/youtube/v3";
const UPLOAD = "https://www.googleapis.com/upload/youtube/v3";
// upload + manage (playlists, thumbnails, reading the channel back) + read the channel's analytics (Analytics page)
export const SCOPES = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube", "https://www.googleapis.com/auth/yt-analytics.readonly"];
export const CHUNK = 32 * 1024 * 1024; // a multiple of 256 KiB, as YouTube asks

export class YtError extends Error {
  constructor(message: string, public status = 0, public reason = "") { super(message); }
  /** worth trying again later (quota resets, YouTube hiccups), as opposed to a bad request */
  get transient() { return this.status === 0 || this.status >= 500 || this.status === 429 || ["quotaExceeded", "uploadLimitExceeded", "rateLimitExceeded", "backendError"].includes(this.reason); }
}

async function yt<T>(url: string, token: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const r = await fetch(url, {
    method: init.method ?? "GET", cache: "no-store",
    headers: { Authorization: `Bearer ${token}`, ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}), ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : {};
  if (!r.ok) throw ytErr(r.status, data);
  return data as T;
}
function ytErr(status: number, data: { error?: { message?: string; errors?: { reason?: string; message?: string }[] } }) {
  const reason = data.error?.errors?.[0]?.reason ?? "";
  const nice: Record<string, string> = {
    quotaExceeded: "YouTube's daily API quota is used up. It resets at midnight Pacific time; Voicebox will try again.",
    uploadLimitExceeded: "This channel hit YouTube's upload limit for today. Voicebox will try again later.",
    youtubeSignupRequired: "This Google account has no YouTube channel yet. Create one at youtube.com, then reconnect.",
    forbidden: "YouTube refused this. Check the channel is verified (phone) for custom thumbnails and long videos.",
    invalidTitle: "YouTube didn't accept the title.", invalidDescription: "YouTube didn't accept the description.", invalidTags: "YouTube didn't accept the tags.",
    invalidCategoryId: "That category isn't available.", invalidPublishAt: "The scheduled time must be in the future.",
    authError: "The connection to YouTube expired. Reconnect the channel.",
  };
  return new YtError(nice[reason] ?? data.error?.message ?? `YouTube ${status}`, status, reason);
}

/** A read for the Analytics page (Data API or YouTube Analytics API), with the same errors as everything else. */
export const ytGet = <T>(url: string, token: string) => yt<T>(url, token);

export function authUrl(redirect: string, state: string) {
  const u = new URL(AUTH);
  u.search = new URLSearchParams({
    client_id: process.env.YOUTUBE_CLIENT_ID ?? "", redirect_uri: redirect, response_type: "code", scope: SCOPES.join(" "),
    access_type: "offline", prompt: "consent select_account", include_granted_scopes: "true", state,
  }).toString();
  return u.toString();
}

async function tokenCall(body: Record<string, string>) {
  const r = await fetch(TOKEN, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, cache: "no-store",
    body: new URLSearchParams({ client_id: process.env.YOUTUBE_CLIENT_ID ?? "", client_secret: process.env.YOUTUBE_CLIENT_SECRET ?? "", ...body }) });
  const j = await r.json() as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };
  if (!j.access_token) throw new YtError(j.error === "invalid_grant" ? "The YouTube connection was revoked or expired. Reconnect the channel." : (j.error_description || j.error || "Google sign-in failed"), r.status, j.error ?? "");
  return { ...j, access_token: j.access_token };
}

type Channel = { id: string; snippet: { title: string; customUrl?: string; thumbnails?: { default?: { url: string } } }; statistics?: { subscriberCount?: string } };

/** Finish "Connect YouTube": keep the tokens, read which channel this is. */
export async function connect(code: string, redirect: string, by: string): Promise<Account> {
  const t = await tokenCall({ code, grant_type: "authorization_code", redirect_uri: redirect });
  if (!t.refresh_token) throw new YtError("Google didn't hand over a long-lived key. Remove Voicebox at myaccount.google.com/permissions and connect again.");
  const ch = (await yt<{ items?: Channel[] }>(`${API}/channels?part=snippet,statistics&mine=true`, t.access_token)).items?.[0];
  if (!ch) throw new YtError("This Google account has no YouTube channel yet. Create one at youtube.com, then connect again.");
  const account: Account = {
    id: ch.id, network: "youtube", name: ch.snippet.title, handle: ch.snippet.customUrl ?? null, avatar: ch.snippet.thumbnails?.default?.url ?? null,
    connected_at: Date.now(), by, subscribers: ch.statistics?.subscriberCount ? Number(ch.statistics.subscriberCount) : null, error: null, expires_at: null,
  };
  await saveAccount(account, { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + (t.expires_in ?? 3600) * 1000, scope: t.scope });
  return account;
}

/** A working access token (refreshed when it's about to run out). */
export async function accessToken(a: Account & { tokens: Tokens }) {
  if (a.tokens.expires_at > Date.now() + 120_000) return a.tokens.access_token;
  if (!a.tokens.refresh_token) throw new YtError("Reconnect the YouTube channel.", 401, "authError");
  try {
    const t = await tokenCall({ refresh_token: a.tokens.refresh_token, grant_type: "refresh_token" });
    const tokens = { ...a.tokens, access_token: t.access_token!, expires_at: Date.now() + (t.expires_in ?? 3600) * 1000 };
    const { tokens: _, ...acc } = a;
    await patchAccount(a.id, { ...acc, error: null }, tokens);
    a.tokens = tokens;
    return tokens.access_token;
  } catch (e) {
    await patchAccount(a.id, { error: (e as Error).message }).catch(() => null);
    throw e;
  }
}

export async function playlists(token: string) {
  const out: { id: string; title: string; count: number; privacy: string }[] = [];
  let page = "";
  for (let i = 0; i < 4; i++) {
    const r = await yt<{ items: { id: string; snippet: { title: string }; contentDetails: { itemCount: number }; status: { privacyStatus: string } }[]; nextPageToken?: string }>(
      `${API}/playlists?part=snippet,contentDetails,status&mine=true&maxResults=50${page ? `&pageToken=${page}` : ""}`, token);
    out.push(...r.items.map((p) => ({ id: p.id, title: p.snippet.title, count: p.contentDetails.itemCount, privacy: p.status.privacyStatus })));
    if (!r.nextPageToken) break;
    page = r.nextPageToken;
  }
  return out;
}

/** The video resource YouTube gets: every option on the plan. `publishAt` uploads it private and YouTube makes it public then. */
export function videoBody(o: YtOptions, publishAt: string | null) {
  return {
    snippet: {
      title: o.title.trim().slice(0, 100), description: o.description, tags: o.tags, categoryId: o.category,
      ...(o.language ? { defaultLanguage: o.language, defaultAudioLanguage: o.language } : {}),
    },
    status: {
      privacyStatus: publishAt ? "private" : o.privacy, ...(publishAt ? { publishAt } : {}),
      selfDeclaredMadeForKids: o.made_for_kids, containsSyntheticMedia: o.synthetic, license: o.license,
      embeddable: o.embeddable, publicStatsViewable: o.public_stats,
    },
    ...(o.recording_date ? { recordingDetails: { recordingDate: o.recording_date } } : {}),
  };
}

/** Open a resumable upload session; returns its URL (good for about a week). */
export async function startUpload(token: string, o: YtOptions, size: number, mime: string, publishAt: string | null) {
  const parts = ["snippet", "status", ...(o.recording_date ? ["recordingDetails"] : [])].join(",");
  const r = await fetch(`${UPLOAD}/videos?uploadType=resumable&part=${parts}&notifySubscribers=${o.notify}`, {
    method: "POST", cache: "no-store",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Length": String(size), "X-Upload-Content-Type": mime || "video/mp4" },
    body: JSON.stringify(videoBody(o, publishAt)),
  });
  if (!r.ok) throw ytErr(r.status, await r.json().catch(() => ({})));
  const loc = r.headers.get("location");
  if (!loc) throw new YtError("YouTube didn't open an upload session.");
  return loc;
}

/** Where YouTube is in an upload session: bytes it has, or the finished video. */
export async function uploadStatus(session: string, token: string, size: number): Promise<{ offset: number; video?: { id: string; status?: { privacyStatus?: string; uploadStatus?: string } } }> {
  const r = await fetch(session, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Range": `bytes */${size}`, "Content-Length": "0" }, cache: "no-store" });
  if (r.status === 308) return { offset: rangeEnd(r.headers.get("range")) };
  if (r.ok) return { offset: size, video: await r.json() };
  if (r.status === 404 || r.status === 410) throw new YtError("The upload session expired; starting over.", r.status, "sessionGone");
  throw ytErr(r.status, await r.json().catch(() => ({})));
}
const rangeEnd = (h: string | null) => (h ? Number(h.split("-")[1]) + 1 : 0);

/** Send one piece. Returns the new offset, or the finished video. */
export async function putChunk(session: string, token: string, bytes: Uint8Array, offset: number, size: number) {
  const end = offset + bytes.byteLength - 1;
  const r = await fetch(session, {
    method: "PUT", cache: "no-store", body: bytes as BodyInit,
    headers: { Authorization: `Bearer ${token}`, "Content-Length": String(bytes.byteLength), "Content-Range": `bytes ${offset}-${end}/${size}` },
  });
  if (r.status === 308) return { offset: rangeEnd(r.headers.get("range")) };
  if (r.ok) return { offset: size, video: (await r.json()) as { id: string; status?: { privacyStatus?: string; uploadStatus?: string } } };
  if (r.status === 404 || r.status === 410) throw new YtError("The upload session expired; starting over.", r.status, "sessionGone");
  throw ytErr(r.status, await r.json().catch(() => ({})));
}

/** Custom thumbnail (needs a verified channel; up to 50 MB, JPEG or PNG). */
export async function setThumbnail(token: string, videoId: string, bytes: Uint8Array, mime: string) {
  const r = await fetch(`${UPLOAD}/thumbnails/set?videoId=${videoId}&uploadType=media`, {
    method: "POST", cache: "no-store", body: bytes as BodyInit, headers: { Authorization: `Bearer ${token}`, "Content-Type": /png/.test(mime) ? "image/png" : "image/jpeg" },
  });
  if (!r.ok) throw ytErr(r.status, await r.json().catch(() => ({})));
}

export const addToPlaylist = (token: string, playlistId: string, videoId: string) =>
  yt(`${API}/playlistItems?part=snippet`, token, { method: "POST", body: { snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } } } });

/** How the video is doing on YouTube's side (processing, rejected, the privacy it really got). */
export async function videoState(token: string, id: string) {
  const r = await yt<{ items: { status: { uploadStatus: string; privacyStatus: string; publishAt?: string; failureReason?: string; rejectionReason?: string } ; processingDetails?: { processingStatus?: string } }[] }>(
    `${API}/videos?part=status,processingDetails&id=${id}`, token);
  return r.items[0] ?? null;
}

export const watchUrl = (id: string, short: boolean) => (short ? `https://youtube.com/shorts/${id}` : `https://youtu.be/${id}`);
