// Tells the server render which page was asked for, so a signed-out visit to /files#take can come back to it after
// sign-in (lib/guard.ts). It only sets a request header; it doesn't decide who gets in (that is lib/session.ts).
import { NextResponse, type NextRequest } from "next/server";

export function proxy(req: NextRequest) {
  const headers = new Headers(req.headers);
  headers.set("x-vb-path", req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ["/((?!api|_next/static|_next/image|icons|icon.svg|sw.js|manifest.webmanifest|login|oauth|\\.well-known).*)"] };
