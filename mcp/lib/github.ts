// "Continue with GitHub" for the owner: replaces pasting MCP_TOKEN in the browser.
// Enabled when GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET and OWNER_GITHUB (comma-separated logins) are set.
export const STATE_COOKIE = "vb_gh_state";

export const githubEnabled = () =>
  !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET && owners().length);

export const owners = () =>
  (process.env.OWNER_GITHUB ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

/** Only same-site paths, so the callback can't be turned into an open redirect. */
export const safeNext = (n: string | null | undefined) => (n && n.startsWith("/") && !n.startsWith("//") && !n.startsWith("/\\") ? n : "/");

export const githubHref = (next: string) => `/api/auth/github?next=${encodeURIComponent(safeNext(next))}`;

export async function githubLogin(code: string, redirect_uri: string) {
  const tok = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: process.env.GITHUB_CLIENT_ID, client_secret: process.env.GITHUB_CLIENT_SECRET, code, redirect_uri }),
  }).then((r) => r.json() as Promise<{ access_token?: string; error_description?: string }>);
  if (!tok.access_token) throw new Error(tok.error_description || "GitHub sign-in failed");
  const user = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${tok.access_token}`, Accept: "application/vnd.github+json", "User-Agent": "voicebox" },
  }).then((r) => r.json() as Promise<{ login?: string }>);
  return user.login?.toLowerCase() ?? "";
}
