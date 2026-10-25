import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { safeNext } from "./github";
import { isAuthed } from "./session";

/** Signed out: off to /login, carrying the page you asked for (same-site paths only) so sign-in can return you there. */
export async function requireLogin() {
  if (await isAuthed()) return;
  const next = safeNext((await headers()).get("x-vb-path"));
  redirect(next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`);
}
