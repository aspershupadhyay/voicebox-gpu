// Consent form target: checks MCP_TOKEN (or the dashboard cookie), then redirects back to the client with a code.
import { checkAuthorize, issueCode, origin, requestError } from "@/lib/oauth";
import { isAuthed, tokenOk } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const form = new URLSearchParams(await req.text());
  const a = checkAuthorize(form);
  if ("error" in a) return new Response(a.error, { status: 400 });

  const back = new URL(a.redirect_uri);
  if (a.state) back.searchParams.set("state", a.state);
  const err = form.get("action") === "deny" ? "access_denied" : requestError(a);
  if (err) {
    back.searchParams.set("error", err);
    return Response.redirect(back, 303);
  }
  if (!tokenOk(form.get("token")?.trim()) && !(await isAuthed())) {
    await new Promise((r) => setTimeout(r, 600)); // slow down guessing
    const retry = new URL("/oauth/authorize", origin(req));
    for (const k of ["client_id", "redirect_uri", "state", "response_type", "code_challenge", "code_challenge_method", "scope", "resource"])
      if (form.get(k)) retry.searchParams.set(k, form.get(k)!);
    retry.searchParams.set("wrong", "1");
    return Response.redirect(retry, 303);
  }
  back.searchParams.set("code", issueCode(a.client_id, a.redirect_uri, a.code_challenge));
  return Response.redirect(back, 303);
}
