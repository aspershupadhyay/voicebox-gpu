// Connect a YouTube channel or an Instagram account: /api/publish/<youtube|instagram>/connect sends you to Google or
// Instagram; they send you back to /api/publish/<network>/callback, which keeps the tokens (sealed, lib/publish/accounts.ts)
// and returns you to Posts → Autopilot. Signed-in people only; the state cookie ties the two halves to this browser.
import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";
import { origin } from "@/lib/oauth";
import { currentUser, isAuthed } from "@/lib/session";
import { safeEqual } from "@/lib/worker";
import { configured, type Network } from "@/lib/publish/accounts";
import * as IG from "@/lib/publish/instagram";
import * as YT from "@/lib/publish/youtube";

export const dynamic = "force-dynamic";

const STATE = "vb_pub_state";
type Ctx = { params: Promise<{ network: string; step: string }> };
const back = (req: Request, q: Record<string, string>) => Response.redirect(new URL(`/posts?view=autopilot&${new URLSearchParams(q)}`, origin(req)), 303);

export async function GET(req: Request, ctx: Ctx) {
  if (!(await isAuthed(req))) return Response.redirect(new URL("/login?next=/posts?view=autopilot", origin(req)), 303);
  const { network, step } = await ctx.params;
  if (network !== "youtube" && network !== "instagram") return Response.json({ error: "not found" }, { status: 404 });
  const n = network as Network;
  if (!configured(n)) return back(req, { error: n === "youtube" ? "YouTube isn't set up yet: add YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET on Vercel (docs/PUBLISHING.md)." : "Instagram isn't set up yet: add INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET on Vercel (docs/PUBLISHING.md)." });
  const redirect = `${origin(req)}/api/publish/${n}/callback`;
  const jar = await cookies();
  if (step === "connect") {
    const state = randomBytes(18).toString("base64url");
    jar.set(STATE, `${n}.${state}`, { httpOnly: true, secure: true, sameSite: "lax", path: "/api/publish", maxAge: 600 });
    return Response.redirect(n === "youtube" ? YT.authUrl(redirect, state) : IG.authUrl(redirect, state), 303);
  }
  if (step !== "callback") return Response.json({ error: "not found" }, { status: 404 });
  const q = new URL(req.url).searchParams;
  const [net, state] = (jar.get(STATE)?.value ?? "").split(".");
  jar.delete({ name: STATE, path: "/api/publish" });
  if (net !== n || !state || !safeEqual(state, q.get("state") ?? "")) return back(req, { error: "That sign-in expired or was started in another browser. Try Connect again." });
  if (q.get("error")) return back(req, { error: `${n === "youtube" ? "Google" : "Instagram"} said: ${q.get("error_description") || q.get("error_reason") || q.get("error")}` });
  try {
    const by = (await currentUser())?.name ?? "someone";
    const a = n === "youtube" ? await YT.connect(q.get("code") ?? "", redirect, by) : await IG.connect(q.get("code") ?? "", redirect, by);
    return back(req, { connected: `${a.name}` });
  } catch (e) {
    return back(req, { error: (e as Error).message });
  }
}
