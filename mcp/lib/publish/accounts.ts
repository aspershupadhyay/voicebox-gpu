// Connected YouTube channels and Instagram accounts, shared by the studio. One small file each in R2
// (workspace/publish/accounts/<network>-<id>.json): what the dashboard shows (name, handle, avatar) in the clear, the
// tokens sealed with AES-256-GCM under a key derived from PUBLISH_KEY (or MCP_TOKEN). Tokens never leave the server.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { delObjs, getJson, listObjs, putJson } from "../store";
import type { Network } from "./shared";

export type { Network };
export const NETWORK_IDS: Network[] = ["youtube", "instagram"];
export type Account = {
  id: string; network: Network; name: string; handle: string | null; avatar: string | null; connected_at: number; by: string;
  /** Instagram: BUSINESS or MEDIA_CREATOR; YouTube: the channel's subscriber count when connected */
  kind?: string | null; subscribers?: number | null;
  /** when the stored token stops working unless it's refreshed (Instagram: 60 days, refreshed automatically) */
  expires_at?: number | null;
  /** last problem talking to the network ("reconnect"), cleared on the next success */
  error?: string | null;
};
export type Tokens = { access_token: string; refresh_token?: string | null; expires_at: number; scope?: string };
type Stored = { account: Account; sealed: string };

const DIR = "workspace/publish/accounts/";
const keyOf = (network: Network, id: string) => `${DIR}${network}-${id.replace(/[^A-Za-z0-9_-]/g, "_")}.json`;

function key() {
  const s = process.env.PUBLISH_KEY || process.env.MCP_TOKEN || "";
  if (s.length < 16) throw new Error("Set PUBLISH_KEY (or MCP_TOKEN) on Vercel before connecting accounts.");
  return createHash("sha256").update(`voicebox-publish-v1:${s}`).digest();
}
function seal(t: Tokens) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(JSON.stringify(t), "utf8"), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
}
function unseal(s: string): Tokens {
  const [iv, tag, body] = s.split(".").map((x) => Buffer.from(x, "base64url"));
  const d = createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(body), d.final()]).toString("utf8"));
}

export async function listAccounts(): Promise<Account[]> {
  const objs = await listObjs(DIR).catch(() => []);
  const all = await Promise.all(objs.filter((o) => o.key.endsWith(".json")).map((o) => getJson<Stored>(o.key).catch(() => null)));
  return all.filter(Boolean).map((s) => s!.account).sort((a, b) => a.connected_at - b.connected_at);
}

export async function getAccount(id: string): Promise<(Account & { tokens: Tokens }) | null> {
  for (const n of NETWORK_IDS) {
    const s = await getJson<Stored>(keyOf(n, id)).catch(() => null);
    if (s) return { ...s.account, tokens: unseal(s.sealed) };
  }
  return null;
}

export async function saveAccount(account: Account, tokens: Tokens) {
  await putJson(keyOf(account.network, account.id), { account, sealed: seal(tokens) } satisfies Stored);
  return account;
}

/** Update what's shown (an error, a fresh expiry) without touching the tokens, or the tokens too. */
export async function patchAccount(id: string, patch: Partial<Account>, tokens?: Tokens) {
  const a = await getAccount(id);
  if (!a) return null;
  const { tokens: old, ...acc } = a;
  return saveAccount({ ...acc, ...patch }, tokens ?? old);
}

export async function removeAccount(id: string) {
  const a = await getAccount(id);
  if (!a) return false;
  await delObjs([keyOf(a.network, a.id)]);
  return a;
}

export const configured = (n: Network) =>
  n === "youtube" ? !!(process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET) : !!(process.env.INSTAGRAM_APP_ID && process.env.INSTAGRAM_APP_SECRET);
