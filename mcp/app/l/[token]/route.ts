// An Auto-DM button's short link (lib/publish/autodm.ts trackUrl): /l/<row>-<which link>-<signature>. Public by design,
// like /s/<token>: whoever got the DM taps it. The signature (an HMAC under the server's secrets) is the claim; it only
// redirects to the link saved on that one row (never to an address in the request, so it isn't an open redirect),
// counts the open, and reads or lists nothing else. Link previews and bots are sent on without being counted.
import { after } from "next/server";
import { readTrack } from "@/lib/publish/autodm";
import * as DB from "@/lib/publish/dmstore";

export const dynamic = "force-dynamic";

const BOT = /bot|crawl|spider|preview|facebookexternalhit|meta-externalagent|facebookcatalog|whatsapp|slurp|embedly|curl|wget/i;

export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const t = readTrack((await params).token);
  if (!t) return new Response("This link isn't valid.", { status: 404, headers: { "Content-Type": "text/plain" } });
  const human = !BOT.test(req.headers.get("user-agent") ?? "") && req.headers.get("purpose") !== "prefetch";
  const row = await DB.click(t.id, human).catch(() => null);
  const url = row?.links?.[t.k];
  if (!url || !/^https?:\/\//i.test(url)) return new Response("This link has expired.", { status: 404, headers: { "Content-Type": "text/plain" } });
  if (human && row.automation) after(() => import("@/lib/publish/autodm-more").then((m) => m.decideAb(row.automation!)).catch(() => null));
  return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
