// The Kaggle notebook's first call (lib/kaggle.ts): its boot ticket (HMAC-signed, 30 minutes, one use, only for the
// start in flight) for the worker's secret. Public by design: the ticket is the claim; nothing else is read or listed.
import { redeemTicket } from "@/lib/kaggle";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const b = await req.json().catch(() => null);
  const secret = typeof b?.ticket === "string" && b.ticket.length < 300 ? await redeemTicket(b.ticket).catch(() => null) : null;
  if (!secret) return Response.json({ error: "this boot ticket isn't valid (expired, used, or not the latest start)" }, { status: 403 });
  return Response.json({ secret }, { headers: { "Cache-Control": "no-store" } });
}
