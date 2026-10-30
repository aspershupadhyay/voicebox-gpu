// Upload links (docs/FACTORY.md H): a page anyone with the link opens on a phone or a computer to drop images and
// videos into one folder (a project's, usually), for chat apps whose attachments never reach a tool (ChatGPT, Gemini).
// The link is a signed claim (folder, project, expiry, a file cap), public by design like a share link (/s/<token>):
// it can only start and finish uploads into that folder, nothing else: no reading, no listing, no deleting.
import { randomBytes } from "node:crypto";
import { sign, verify } from "../oauth";
import { getJsonTagged, putJsonIf } from "../store";

type Link = { typ: "upl"; id: string; f: string | null; p?: string; by: string; exp: number; max: number; name: string };
const COUNT = (id: string) => `auto/uplinks/${id}.json`;

export function makeLink(opts: { folder: string | null; folderName: string; project?: string; by: string; hours?: number; max?: number }, origin: string) {
  const hours = Math.max(1, Math.min(72, opts.hours ?? 24));
  const l: Link = { typ: "upl", id: randomBytes(6).toString("hex"), f: opts.folder, ...(opts.project ? { p: opts.project } : {}), by: opts.by.slice(0, 60),
    exp: Math.floor(Date.now() / 1000) + hours * 3600, max: Math.max(1, Math.min(100, opts.max ?? 30)), name: opts.folderName.slice(0, 120) };
  return { url: `${origin}/u/${sign(l)}`, expires_at: new Date(l.exp * 1000).toISOString(), max_files: l.max, folder: opts.folderName };
}

export const openLink = (token: string) => verify<Link>(token, "upl") ?? null;

/** Count n more files against the link's cap; false when it's used up. */
export async function take(l: Link, n: number) {
  for (let i = 0; i < 5; i++) {
    const { value, etag } = await getJsonTagged<{ used: number }>(COUNT(l.id));
    const used = value?.used ?? 0;
    if (used + n > l.max) return false;
    if (await putJsonIf(COUNT(l.id), { used: used + n }, etag)) return true;
  }
  return false;
}
