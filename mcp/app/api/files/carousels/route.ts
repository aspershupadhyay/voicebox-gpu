// Carousels for scripts and AIs (lib/carousels.ts): put files already in Files into a carousel, reorder, rename or
// ungroup, without re-uploading. Signed in, Bearer MCP_TOKEN, or Bearer an upload key (it can save files and arrange
// carousels, nothing else: no reading other files, no deleting).
//   GET                      → every carousel with its files in order (?post=<post id> for one post's, ?id=<id or name> for one)
//   POST {carousel, files: ["m:…", …] | [{file_id, position}], post_id?}   → add them (a new name makes a carousel; no
//                               positions: they go in the listed order, after what's there)
//   POST {carousel, order: ["m:…", …]}   → the full new order      POST {carousel, name}   → rename
//   POST {carousel, remove: ["m:…"]}     → take files out           POST {carousel, ungroup: true} → the files stay
import { carouselDetail, carouselList, changeCarousel } from "@/lib/filemanager";
import { joinMany, ungroupCarousel, POST_GROUP_RE } from "@/lib/carousels";
import { uploadKeyOk } from "@/lib/inbox";
import { currentUser, isAuthed } from "@/lib/session";

export const dynamic = "force-dynamic";

async function who(req: Request) {
  if (await isAuthed(req)) { const u = await currentUser().catch(() => null); return { name: u ? u.name : "Upload API", key: false }; }
  const k = await uploadKeyOk(req);
  return k ? { name: `${k.name} (upload key)`, key: true } : null;
}
type Out = { items?: { url?: string | null }[] };
/** An upload key sees a carousel's file ids, names and order, never links to the files. */
const shown = <T,>(c: T, key: boolean): T => (key && c && (c as Out).items ? { ...c, items: (c as Out).items!.map(({ url: _, ...i }) => i) } : c);
const fail = (e: unknown) => Response.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 400 });

export async function GET(req: Request) {
  const actor = await who(req);
  if (!actor) return Response.json({ error: "unauthorized" }, { status: 401 });
  const q = new URL(req.url).searchParams;
  try {
    if (q.get("id")) return Response.json(shown(await carouselDetail(q.get("id")!), actor.key));
    return Response.json({ carousels: (await carouselList({ post_id: q.get("post") ?? undefined })).map((c) => shown(c, actor.key)) });
  } catch (e) { return fail(e); }
}

export async function POST(req: Request) {
  const actor = await who(req);
  if (!actor) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    const b = await req.json().catch(() => ({}));
    const ref = String(b.carousel ?? b.id ?? "").trim();
    if (!ref) throw new Error("give carousel: its id or a name (a new name makes one)");
    if (Array.isArray(b.files)) {
      const files = (b.files as unknown[]).map((f) => (typeof f === "string" ? { key: f, position: null } : { key: String((f as { file_id?: unknown }).file_id ?? ""), position: (f as { position?: number }).position ?? null }));
      const r = await joinMany(ref, files, { post: b.post_id ? String(b.post_id).slice(0, 64) : null, by: actor.name });
      return Response.json({ ...r, carousel: shown(await carouselDetail(r.id).catch(() => null), actor.key) });
    }
    const id = POST_GROUP_RE.test(ref) ? ref : (await carouselDetail(ref)).id; // by id or name
    if (b.ungroup === true) return Response.json(await ungroupCarousel(id));
    const r = await changeCarousel(id, { name: b.name, items: b.order, add: b.add, remove: b.remove }, actor.name);
    return Response.json(r.ungrouped ? r : shown(await carouselDetail(r.id).catch(() => r), actor.key));
  } catch (e) { return fail(e); }
}
