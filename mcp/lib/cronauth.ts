// Who may knock on the scheduled routes (/api/cron/sweep, /api/cron/backup, /api/cron/live): the Colab worker's
// WORKER_SECRET, a CRON_SECRET, the Cloudflare timer's own secret (workers/live-timer.js; only its SHA-256 is kept here,
// LIVE_TIMER_HASH on Vercel overrides it), or, with no secret to set anywhere, GitHub itself. sweep.yml asks GitHub for a short-lived OIDC token
// (id-token: write) and sends it; it's accepted only when GitHub signed it, for this app, from this repository's
// sweep.yml on main. So the schedule works without copying a secret into GitHub.
import { createHash, createPublicKey, verify } from "node:crypto";

type Jwk = { kty: string; kid?: string; n?: string; e?: string };
import { safeEqual } from "./worker";

const ISSUER = "https://token.actions.githubusercontent.com";
export const CRON_AUDIENCE = "voicebox-cron";
const REPO = process.env.CRON_GITHUB_REPO || "aspershupadhyay/voicebox-gpu";
const WORKFLOW = `${REPO}/.github/workflows/sweep.yml@refs/heads/main`;

let jwks: { at: number; keys: Jwk[] } | null = null;
async function keys(fresh = false) {
  if (!fresh && jwks && Date.now() - jwks.at < 3600_000) return jwks.keys;
  const r = await fetch(`${ISSUER}/.well-known/jwks`, { cache: "no-store" });
  if (!r.ok) throw new Error(`GitHub JWKS ${r.status}`);
  jwks = { at: Date.now(), keys: ((await r.json()) as { keys: Jwk[] }).keys };
  return jwks.keys;
}

const b64 = (s: string) => Buffer.from(s, "base64url");

/** The claims of a GitHub Actions OIDC token from sweep.yml on main, or null for anything else. */
export async function githubCron(token: string) {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return null;
  try {
    const head = JSON.parse(b64(h).toString()) as { alg: string; kid: string };
    if (head.alg !== "RS256") return null;
    let jwk = (await keys()).find((k) => k.kid === head.kid);
    if (!jwk) jwk = (await keys(true)).find((k) => k.kid === head.kid); // GitHub rotated its keys
    if (!jwk) return null;
    if (!verify("RSA-SHA256", Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk as never, format: "jwk" }), b64(s))) return null;
    const c = JSON.parse(b64(p).toString()) as Record<string, unknown>;
    const now = Date.now() / 1000;
    const ok = c.iss === ISSUER && c.aud === CRON_AUDIENCE && c.repository === REPO && c.job_workflow_ref === WORKFLOW && c.ref === "refs/heads/main"
      && typeof c.exp === "number" && c.exp > now && (typeof c.nbf !== "number" || c.nbf <= now + 60);
    return ok ? c : null;
  } catch {
    return null;
  }
}

export const TIMER_HASH = process.env.LIVE_TIMER_HASH || "541b2cb0083a8d393b100b7fd63cc230cdf6b4fb27a5ed79e1fdc03b987060e4";

/** A scheduled knock: a secret, the Cloudflare timer, or GitHub's token for sweep.yml. */
export async function cronAuthed(req: Request) {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (token.length < 24) return false;
  if ([process.env.WORKER_SECRET, process.env.CRON_SECRET].some((s) => (s ?? "").length >= 24 && safeEqual(token, s!))) return true;
  if (safeEqual(createHash("sha256").update(token).digest("hex"), TIMER_HASH)) return true;
  return !!(await githubCron(token));
}
