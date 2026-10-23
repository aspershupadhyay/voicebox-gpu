// Server half of the shared workspace. The browser reads and writes posts/comments/media straight to Appwrite (that is
// what makes it live); these routes do the parts that need the project's API key.
import { AppwriteError, backupUrl, finalizeMedia, getMedia, hasKey, listMembers } from "@/lib/appwrite";
import { currentUser, isAuthed } from "@/lib/session";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = { params: Promise<{ path: string[] }> };
const ID = /^[A-Za-z0-9._-]{1,36}$/;
const fail = (e: unknown) => Response.json({ error: (e as Error).message }, { status: e instanceof AppwriteError ? (e.status >= 500 ? 502 : e.status) : 500 });

export async function GET(req: Request, ctx: Ctx) {
  if (!(await isAuthed(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const [a, b] = (await ctx.params).path;
  try {
    if (a === "me") return Response.json({ user: await currentUser(), workspace: hasKey() });
    if (a === "members") return Response.json({ members: await listMembers() });
    if (a === "backup" && b && ID.test(b)) {
      const url = await backupUrl(await getMedia(b));
      return url ? Response.json({ url }) : Response.json({ error: "no R2 copy yet" }, { status: 404 });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request, ctx: Ctx) {
  if (!(await isAuthed(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const [a, b] = (await ctx.params).path;
  try {
    if (a === "media" && b && ID.test(b)) {
      const body = (await req.json().catch(() => ({}))) as { backup?: boolean };
      const backup = body.backup ?? (await getSettings()).backup_media;
      return Response.json(await finalizeMedia(b, { backup }));
    }
    return Response.json({ error: "not found" }, { status: 404 });
  } catch (e) {
    return fail(e);
  }
}
