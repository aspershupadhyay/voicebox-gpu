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
import * as FB from "@/lib/publish/facebook";

export const dynamic = "force-dynamic";

const STATE = "vb_pub_state";
type Ctx = { params: Promise<{ network: string; step: string }> };
const back = (req: Request, q: Record<string, string>) => Response.redirect(new URL(`/posts?view=autopilot&${new URLSearchParams(q)}`, origin(req)), 303);

export async function GET(req: Request, ctx: Ctx) {
  if (!(await isAuthed(req))) return Response.redirect(new URL("/login?next=/posts?view=autopilot", origin(req)), 303);
  const { network, step } = await ctx.params;
  if (network === "facebook") return facebook(req, step);
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

/** Facebook Login (lib/publish/facebook.ts): only for reading Instagram rivals, so it returns to Grow → Competitors. */
async function facebook(req: Request, step: string) {
  const home = (q: Record<string, string>) => Response.redirect(new URL(`/analytics/competitors?${new URLSearchParams(q)}`, origin(req)), 303);
  if (!FB.fbConfigured()) return home({ fb_error: "Facebook isn't set up yet: add FACEBOOK_APP_SECRET on the Worker (docs/PUBLISHING.md)." });
  const redirect = `${origin(req)}/api/publish/facebook/callback`;
  const jar = await cookies();
  if (step === "connect") {
    const state = randomBytes(18).toString("base64url");
    jar.set(STATE, `facebook.${state}`, { httpOnly: true, secure: true, sameSite: "lax", path: "/api/publish", maxAge: 600 });
    return Response.redirect(FB.authUrl(redirect, state), 303);
  }
  if (step !== "callback") return Response.json({ error: "not found" }, { status: 404 });
  const q = new URL(req.url).searchParams;
  const [net, state] = (jar.get(STATE)?.value ?? "").split(".");
  jar.delete({ name: STATE, path: "/api/publish" });
  if (net !== "facebook" || !state || !safeEqual(state, q.get("state") ?? "")) return home({ fb_error: "That sign-in expired or was started in another browser. Try Connect Facebook again." });
  if (q.get("error")) return home({ fb_error: `Facebook said: ${q.get("error_description") || q.get("error_reason") || q.get("error")}` });
  try {
    const by = (await currentUser())?.name ?? "someone";
    const s = await FB.connect(q.get("code") ?? "", redirect, by);
    return home({ fb_connected: s.pages.filter((p) => p.ig).map((p) => `@${p.ig!.username}`).join(", ") });
  } catch (e) {
    return home({ fb_error: (e as Error).message });
  }
}
