// One endpoint that adapts (docs/FACTORY.md C): /api/mcp lists a small core, and a model loads a toolset when it needs
// one (`tools action=load set=video`); the client is told the list changed and lists again. Every tool is always
// callable (by name, or through call_tool), listed or not. ?full=1 lists everything; /api/mcp/lean is an alias of the
// core. Loaded sets are kept per key (a hash of the bearer token) for 12 hours, since each request is a fresh server.
// The listing is also where schemas are made safe for every client (H): a strict subset for clients that aren't
// Claude (Gemini, ChatGPT…) or that ask for it (?schema=strict), and readOnly / destructive hints on every tool.
import { createHash } from "node:crypto";
import { z } from "zod";
import { getJson, putJson } from "../store";

export const CORE = ["tools", "find_tools", "call_tool", "run", "get_job", "project", "playbook", "approvals", "worker_status"];

export const SETS: Record<string, { about: string; tools: string[] }> = {
  video: { about: "edit, templates, repurpose, inspect, images, captions, the factory", tools: ["edit_video", "video_template", "repurpose", "inspect_media", "imagine", "captions", "transcribe", "attach_voiceover", "post_pipeline", "factory", "script_check", "list_jobs", "cancel_job"] },
  voice: { about: "voiceovers, voices, clean-up, re-voice, training", tools: ["voice_lines", "list_voices", "my_voices", "revoice", "clean_audio", "preview_pronunciation", "voice_coach", "voice_profile", "voice_dataset", "train_voice", "benchmark_voices", "add_reference_voice", "engine", "get_settings", "update_settings", "list_jobs", "cancel_job"] },
  files: { about: "Files: list, get, save, upload, folders, trash, carousels, downloads, share links", tools: ["list_files", "get_file", "save_file", "upload_media", "add_media", "upload_link", "import_file", "delete_media", "create_folder", "update_folder", "delete_folder", "move_files", "rename_file", "star_files", "delete_files", "restore_files", "empty_trash", "carousels", "download", "downloads", "workspace_media", "share_links", "find_photos", "list_library"] },
  posts: { about: "the board, posts, calendar, packages, publishing", tools: ["workspace_board", "get_post", "create_post", "update_post", "delete_post", "comment_on_post", "content_calendar", "post_package", "auto_post", "publish_accounts", "publish_post", "publish_status", "automation_rules", "workspace_activity", "workspace_members", "hook_score", "title_lab", "seo_score"] },
  analytics: { about: "channel analytics, Radar (competitors), keywords, the weekly digest", tools: ["analytics", "radar", "radar_watch", "keyword_research", "weekly_digest", "hook_score", "title_lab", "seo_score"] },
  repo: { about: "repos, the browser and search, workflows, memory, roles, the audit, control", tools: ["repo", "browse", "workflow", "memory", "agents", "audit", "control", "gpu"] },
};
export const SET_NAMES = Object.keys(SETS) as [string, ...string[]];

const KEY = (h: string) => `auto/toolsets/${h}.json`;
const TTL = 12 * 3600_000;
const who = (token?: string) => (token ? createHash("sha256").update(token).digest("hex").slice(0, 24) : null);

export async function loaded(token?: string): Promise<string[]> {
  const h = who(token);
  if (!h) return [];
  const v = await getJson<{ sets: string[]; at: number }>(KEY(h)).catch(() => null);
  return v && Date.now() - v.at < TTL ? v.sets : [];
}

export async function setLoaded(token: string | undefined, sets: string[]) {
  const h = who(token);
  if (!h) throw new Error("no key to remember the toolsets by");
  await putJson(KEY(h), { sets: [...new Set(sets)].filter((s) => SETS[s]), at: Date.now() });
}

/** The tools a listing shows: everything, or the core plus the loaded sets. */
export function listed(all: string[], sets: string[] | "all") {
  if (sets === "all") return new Set(all);
  return new Set([...CORE, ...sets.flatMap((s) => SETS[s]?.tools ?? [])].filter((t) => all.includes(t)));
}

// ── hints, so clients can skip confirmations on safe reads ────────────────────────────────────────────────────────

const READ = /^(list_|get_|my_voices|worker_status|downloads|workspace_board|workspace_activity|workspace_members|workspace_media|content_calendar|publish_accounts|publish_status|analytics|post_package|hook_score|seo_score|title_lab|keyword_research|weekly_digest|preview_pronunciation|find_tools|playbook|find_photos|voice_profile)/;
const DESTROY = new Set(["delete_post", "delete_media", "delete_folder", "delete_files", "empty_trash"]);
export function hints(name: string) {
  return { readOnlyHint: READ.test(name), destructiveHint: DESTROY.has(name), openWorldHint: ["browse", "download", "add_media", "repo", "publish_post", "auto_post"].includes(name) };
}

// ── the strict schema subset (Gemini follows an OpenAPI 3.0 subset; other clients differ) ─────────────────────────

const KEEP = new Set(["type", "description", "properties", "required", "items", "enum", "format", "minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength", "pattern", "default", "nullable", "additionalProperties", "title"]);

/** One type per field, no $schema / anyOf / propertyNames / const: what every client accepts. A union of a number and
 *  text becomes text (the tools take a number written as text too). */
export function strict(s: unknown): unknown {
  if (!s || typeof s !== "object") return s;
  if (Array.isArray(s)) return s.map(strict);
  let o = { ...(s as Record<string, unknown>) };
  const alts = (o.anyOf ?? o.oneOf) as Record<string, unknown>[] | undefined;
  if (alts?.length) {
    const real = alts.filter((a) => a.type !== "null");
    const consts = real.filter((a) => "const" in a);
    const desc = o.description;
    if (consts.length === real.length) o = { type: typeof consts[0].const === "number" ? "number" : "string", enum: consts.map((a) => a.const) };
    else if (real.length === 1) o = { ...real[0] };
    else o = { type: "string", description: `${real.map((a) => ("const" in a ? JSON.stringify(a.const) : a.type)).join(" or ")} (as text)` };
    if (desc) o.description = `${desc}${o.description && o.description !== desc ? `; ${o.description}` : ""}`;
    if (real.length < alts.length) o.nullable = true;
  }
  if ("const" in o) { o.enum = [o.const]; o.type ??= typeof o.const === "number" ? "number" : "string"; }
  if (Array.isArray(o.type)) o.type = (o.type as string[]).find((t) => t !== "null") ?? "string";
  if (o.exclusiveMinimum != null && o.minimum == null) o.minimum = o.exclusiveMinimum;
  if (o.exclusiveMaximum != null && o.maximum == null) o.maximum = o.exclusiveMaximum;
  if (o.additionalProperties === false || (o.additionalProperties && typeof o.additionalProperties === "object" && !Object.keys(o.additionalProperties as object).length)) delete o.additionalProperties;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (!KEEP.has(k)) continue;
    if (k === "properties") out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([p, x]) => [p, strict(x)]));
    else if (k === "items" || k === "additionalProperties") out[k] = strict(v);
    else out[k] = v;
  }
  if (!out.type && out.properties) out.type = "object";
  return out;
}

/** Keys the strict subset may hold (scripts/check-register.mts checks every tool against it). */
export function strictProblems(s: unknown, path = "$"): string[] {
  if (!s || typeof s !== "object") return [];
  const o = s as Record<string, unknown>;
  const bad = Object.keys(o).filter((k) => !KEEP.has(k)).map((k) => `${path}.${k}`);
  if (Array.isArray(o.type)) bad.push(`${path}.type is a list`);
  for (const [p, x] of Object.entries((o.properties as Record<string, unknown>) ?? {})) bad.push(...strictProblems(x, `${path}.${p}`));
  if (o.items) bad.push(...strictProblems(o.items, `${path}[]`));
  if (o.additionalProperties && typeof o.additionalProperties === "object") bad.push(...strictProblems(o.additionalProperties, `${path}{}`));
  return bad;
}

/** Whether this client gets the strict subset: anyone but Claude, or anyone who asks. */
export function wantsStrict(req?: Request) {
  if (!req) return false;
  const u = new URL(req.url);
  if (u.searchParams.get("schema") === "strict") return true;
  if (u.searchParams.get("schema") === "full") return false;
  const ua = `${req.headers.get("user-agent") ?? ""} ${req.headers.get("x-model") ?? ""}`.toLowerCase();
  return !/claude|anthropic/.test(ua);
}

/** The JSON a listing sends for one zod input schema. */
export function jsonSchema(schema: z.ZodType | undefined, strictMode: boolean) {
  if (!schema) return { type: "object", properties: {} };
  const j = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete j.$schema;
  return strictMode ? strict(j) : j;
}
