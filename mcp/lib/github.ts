// "Continue with GitHub": replaces pasting MCP_TOKEN in the browser, for the dashboard and for connecting Claude / MCP
// clients. Enabled when GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are set. Who may sign in: OWNER_GITHUB
// (comma-separated logins, on Vercel) plus up to 4 people added in Settings → Claude / MCP access.
export const STATE_COOKIE = "vb_gh_state";

export const githubEnabled = () => !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);

export const owners = () =>
  (process.env.OWNER_GITHUB ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

/** Everyone allowed: OWNER_GITHUB and the people added in Settings. */
export async function allowedLogins() {
  const { getSettings } = await import("./settings");
  const extra = await getSettings().then((s) => s.mcp_github).catch(() => [] as string[]);
  return [...new Set([...owners(), ...extra])];
}

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
