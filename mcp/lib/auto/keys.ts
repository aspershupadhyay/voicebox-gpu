// Model keys (Settings → Claude & API → Other models): one bearer key per model (Gemini CLI, a script, another
// assistant) so a new model connects without sharing MCP_TOKEN. Each is shown once, kept only as a SHA-256, names the
// model in the call log (it wins over X-Model, so a model can't sign as another), can be held to a role, and stops
// working the moment it's revoked. A key opens /api/mcp and /api/mcp/lean, nothing on the dashboard.
import { createHash, randomBytes } from "node:crypto";
import { getJson } from "../store";
import { safeEqual } from "../worker";
import { mutate } from "./control";
import { later } from "./wrap";

const KEYS = "auto/model-keys.json";
export const PREFIX = "vbmk_";
type Key = { id: string; name: string; role?: string; hash: string; at: number; by: string; used: number | null };
export type ModelKey = Omit<Key, "hash">;
const hash = (k: string) => createHash("sha256").update(k).digest("hex");
const all = async () => (await getJson<Key[]>(KEYS).catch(() => null)) ?? [];

export async function listModelKeys(): Promise<ModelKey[]> {
  return (await all()).map(({ hash: _, ...k }) => k);
}

export async function createModelKey(name: string, role: string | undefined, by: string) {
  const model = name.replace(/[^\w .:/@+-]/g, "").trim().slice(0, 60);
  if (!model) throw new Error("Name the model the key is for, e.g. gemini");
  const r = role?.trim().toLowerCase() || undefined;
  if (r && !(await (await import("./agents")).role(r))) throw new Error(`No role called ${r}`);
  const key = `${PREFIX}${randomBytes(24).toString("base64url")}`;
  const k: Key = { id: randomBytes(6).toString("hex"), name: model, ...(r ? { role: r } : {}), hash: hash(key), at: Date.now(), by, used: null };
  await mutate<Key[]>(KEYS, [], (cur) => {
    if (cur.length >= 20) throw new Error("Up to 20 model keys; revoke one first.");
    return [...cur, k];
  });
  return { key, id: k.id, name: k.name, role: k.role };
}

export async function revokeModelKey(id: string) {
  await mutate<Key[]>(KEYS, [], (cur) => cur.filter((k) => k.id !== id));
}

/** The key behind a bearer token, if it's a live model key (read fresh each time, so a revoke takes effect at once). */
export async function modelKey(token: string): Promise<ModelKey | null> {
  if (!token.startsWith(PREFIX)) return null;
  const h = hash(token);
  const k = (await all()).find((x) => safeEqual(x.hash, h));
  if (!k) return null;
  if (!k.used || Date.now() - k.used > 3600_000)
    later(mutate<Key[]>(KEYS, [], (cur) => cur.map((x) => (x.id === k.id ? { ...x, used: Date.now() } : x))).catch(() => {}));
  const { hash: _, ...rest } = k;
  return rest;
}
