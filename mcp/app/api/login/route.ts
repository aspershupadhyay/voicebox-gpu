import { cookies } from "next/headers";
import { COOKIE, sessionValue, tokenOk } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { token } = await req.json().catch(() => ({ token: "" }));
  if (!tokenOk(String(token ?? "").trim())) {
    await new Promise((r) => setTimeout(r, 600)); // slow down guessing
    return Response.json({ error: "wrong token" }, { status: 401 });
  }
  (await cookies()).set(COOKIE, sessionValue(), {
    httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30,
  });
  return Response.json({ ok: true });
}

export async function DELETE() {
  (await cookies()).delete(COOKIE);
  return Response.json({ ok: true });
}
