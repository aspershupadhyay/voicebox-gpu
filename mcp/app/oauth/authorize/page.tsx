// OAuth consent: an MCP client (e.g. a claude.ai connector) asks for access; the owner approves with MCP_TOKEN.
import { GithubLogo, LockKey } from "@phosphor-icons/react/dist/ssr";
import { redirect } from "next/navigation";
import { Logo, Orb } from "@/components/art";
import { githubEnabled, githubHref } from "@/lib/github";
import { checkAuthorize, issueCode, requestError, trustedRedirect } from "@/lib/oauth";
import { isAuthed } from "@/lib/session";

export const dynamic = "force-dynamic";

const PASS = ["client_id", "redirect_uri", "state", "response_type", "code_challenge", "code_challenge_method", "scope", "resource"];

export default async function Authorize({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const p = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  const a = checkAuthorize(p);
  const bad = "error" in a ? a.error : requestError(a) && "This sign-in request is missing PKCE or uses an unsupported response type.";
  const signedIn = await isAuthed();
  const name = "error" in a ? "" : a.client.name || new URL(a.redirect_uri).host;

  // Signed in + a known client (claude.ai): connect straight away, like Figma's "already logged in" flow.
  if (!bad && !("error" in a) && signedIn && trustedRedirect(a.redirect_uri)) {
    const back = new URL(a.redirect_uri);
    if (a.state) back.searchParams.set("state", a.state);
    back.searchParams.set("code", issueCode(a.client_id, a.redirect_uri, a.code_challenge));
    redirect(back.toString());
  }
  const here = `/oauth/authorize?${new URLSearchParams(PASS.flatMap((k) => (p[k] ? [[k, p[k]!]] : []))).toString()}`;

  return (
    <div className="login">
      <div className="l-art">
        <Orb />
        <p className="quote">Voices that sound <em>human</em>,<br />subtitles that land on the word.</p>
      </div>
      <div className="l-form">
        <div style={{ width: "100%", maxWidth: 380 }}>
          <div className="row" style={{ gap: 12, marginBottom: 34 }}><Logo size={36} /><span style={{ font: "600 26px var(--sans)", letterSpacing: "-.02em" }}>Voicebox <em style={{ font: "italic 400 28px var(--serif)", color: "var(--dim)" }}>Studio</em></span></div>
          <div className="eyebrow">Connect an app</div>
          {bad ? (
            <>
              <h1 style={{ fontSize: 36 }}>Can&apos;t connect.</h1>
              <p className="err">{bad}</p>
            </>
          ) : (
            <form method="post" action="/api/oauth/authorize">
              <h1 style={{ fontSize: 36 }}>Allow {name}?</h1>
              <p className="sub" style={{ marginBottom: 28 }}>It will be able to use every voicebox tool: generate voiceovers, subtitles, images and video, and read your library.</p>
              {PASS.map((k) => p[k] ? <input key={k} type="hidden" name={k} value={p[k]} /> : null)}
              {!signedIn && githubEnabled() && (
                <>
                  <a className="btn sig lg" href={githubHref(here)} style={{ width: "100%" }}><GithubLogo size={18} weight="fill" /> Continue with GitHub</a>
                  <p className="faint tiny" style={{ margin: "18px 0" }}>or use your access token</p>
                </>
              )}
              {!signedIn && (
                <>
                  <label className="f" htmlFor="tok">Access token</label>
                  <div style={{ position: "relative" }}>
                    <LockKey size={17} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "var(--faint)" }} />
                    <input id="tok" name="token" type="password" required={!githubEnabled()} autoFocus={!githubEnabled()} autoComplete="current-password" placeholder="MCP_TOKEN from .secrets.local" style={{ paddingLeft: 38, height: 46 }} />
                  </div>
                </>
              )}
              {p.wrong && <p className="err">That token didn&apos;t match.</p>}
              <button className={!signedIn && githubEnabled() ? "lg" : "sig lg"} name="action" value="allow" style={{ width: "100%", marginTop: 16 }}>Allow access</button>
              <button className="lg" name="action" value="deny" formNoValidate style={{ width: "100%", marginTop: 10 }}>Cancel</button>
              <p className="faint tiny" style={{ margin: "14px 0 0" }}>Rotate MCP_TOKEN to revoke every connected app.</p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
