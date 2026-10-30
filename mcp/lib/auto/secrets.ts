// Keys the tools use (Settings → Automation → Keys): the GitHub key for repo and the search key for browse, pasted
// in the dashboard instead of on Vercel. Stored in R2 encrypted (AES-256-GCM, key derived from MCP_TOKEN, so a
// rotated MCP_TOKEN just asks for them again), never sent back to the browser (only the last 4 characters) and never
// to a model: tools use them server side. A Vercel variable of the same name is the fallback.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { getJson } from "../store";
import { mutate } from "./control";

const FILE = "auto/secrets.json";
export const SECRETS = {
  github: { env: "GITHUB_AGENT_TOKEN", label: "GitHub key" },
  search: { env: "SEARCH_API_KEY", label: "Search key" },
} as const;
export type SecretName = keyof typeof SECRETS;
type Stored = { enc: string; last4: string; at: number; by: string; note?: string };
type File = Partial<Record<SecretName, Stored>>;

const box = () => createHash("sha256").update(`voicebox-secrets-v1:${process.env.MCP_TOKEN ?? ""}`).digest();
function seal(s: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", box(), iv);
  const body = Buffer.concat([c.update(s, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
}
function open(e: string): string | null {
  try {
    const b = Buffer.from(e, "base64");
    const d = createDecipheriv("aes-256-gcm", box(), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
  } catch { return null; }
}
// a repo task calls GitHub many times: one R2 read per few seconds, cleared on a change here
let memo: { at: number; f: Promise<File> } | null = null;
const read = () => {
  if (!memo || Date.now() - memo.at > 10_000) memo = { at: Date.now(), f: getJson<File>(FILE).catch(() => null).then((f) => f ?? {}) };
  return memo.f;
};

/** The key a tool uses: the one saved in the dashboard, else the Vercel variable. */
export async function secret(name: SecretName): Promise<string | undefined> {
  const s = (await read())[name];
  return (s && open(s.enc)) || process.env[SECRETS[name].env] || undefined;
}

/** What the dashboard shows: where each key comes from, never the key. */
export async function secretsStatus() {
  const f = await read();
  return Object.fromEntries((Object.keys(SECRETS) as SecretName[]).map((n) => {
    const s = f[n];
    const ok = s && open(s.enc) != null;
    return [n, ok ? { from: "dashboard", last4: s.last4, at: s.at, by: s.by, note: s.note }
      : process.env[SECRETS[n].env] ? { from: "vercel" }
      : { from: s ? "unreadable" : "none" }];
  })) as Record<SecretName, { from: "dashboard" | "vercel" | "unreadable" | "none"; last4?: string; at?: number; by?: string; note?: string }>;
}

export async function setSecret(name: SecretName, value: string | null, by: string) {
  if (!(name in SECRETS)) throw new Error("no such key");
  let note: string | undefined;
  if (value != null) {
    value = value.trim();
    if (value.length < 16 || value.length > 400 || /\s/.test(value)) throw new Error(`That doesn't look like a ${SECRETS[name].label}`);
    if (name === "github") note = await checkGithub(value);
  }
  memo = null;
  await mutate<File>(FILE, {}, (f) => {
    if (value == null) delete f[name];
    else f[name] = { enc: seal(value), last4: value.slice(-4), at: Date.now(), by, ...(note ? { note } : {}) };
    return f;
  });
  memo = null;
  return secretsStatus();
}

/** A GitHub key that GitHub accepts: whose it is. */
async function checkGithub(key: string) {
  const api = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
  const r = await fetch(`${api}/user`, { headers: { Authorization: `Bearer ${key}`, Accept: "application/vnd.github+json", "User-Agent": "voicebox" }, cache: "no-store" });
  if (r.status === 401) throw new Error("GitHub doesn't accept that key: check you copied all of it and it hasn't expired");
  if (!r.ok) return undefined;
  const u = (await r.json().catch(() => ({}))) as { login?: string };
  return u.login ? `works as ${u.login}` : undefined;
}
