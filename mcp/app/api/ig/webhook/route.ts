// Instagram's webhook for Auto-DM (lib/publish/autodm.ts). Public by design, like /api/files/put: Instagram is the only
// caller and proves it on every delivery.
//   GET  the one-time check when the webhook is saved in the Meta app: hub.verify_token must equal INSTAGRAM_WEBHOOK_TOKEN,
//        and we echo hub.challenge. Nothing else is read or returned.
//   POST a new comment or message. X-Hub-Signature-256 must be the HMAC-SHA256 of the exact body under the app secret
//        (INSTAGRAM_APP_SECRET), or it's refused before the body is parsed. It answers 200 at once and does the work after,
//        so Instagram doesn't retry; each comment or message is answered at most once (markers in R2).
// It reads and lists nothing for the caller: the answer is always {ok: true} or a refusal.
import { createHmac } from "node:crypto";
import { after } from "next/server";
import { safeEqual } from "@/lib/worker";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const want = process.env.INSTAGRAM_WEBHOOK_TOKEN ?? "";
  if (want.length < 12 || q.get("hub.mode") !== "subscribe" || !safeEqual(q.get("hub.verify_token") ?? "", want)) return new Response("forbidden", { status: 403 });
  return new Response((q.get("hub.challenge") ?? "").slice(0, 200).replace(/[^A-Za-z0-9_-]/g, ""), { status: 200, headers: { "Content-Type": "text/plain" } });
}

export async function POST(req: Request) {
  const secrets = [process.env.INSTAGRAM_APP_SECRET, process.env.META_APP_SECRET].filter((s): s is string => !!s && s.length >= 16);
  if (!secrets.length) return new Response("not set up", { status: 503 });
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > 1_000_000) return new Response("too large", { status: 413 });
  const raw = await req.text();
  if (raw.length > 1_000_000) return new Response("too large", { status: 413 });
  const sig = (req.headers.get("x-hub-signature-256") ?? "").replace(/^sha256=/, "");
  if (!/^[a-f0-9]{64}$/.test(sig) || !secrets.some((s) => safeEqual(createHmac("sha256", s).update(raw, "utf8").digest("hex"), sig))) return new Response("bad signature", { status: 401 });
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return new Response("bad body", { status: 400 }); }
  after(async () => { await (await import("@/lib/publish/autodm")).onWebhook(body as never).catch((e) => console.error("autodm", (e as Error).message)); });
  return Response.json({ ok: true });
}
