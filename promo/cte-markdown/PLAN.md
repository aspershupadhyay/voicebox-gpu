# Catch the Error: Markdown is the new malware

**What it's for:** a Reel / Short (1080×1920, 81 s of voice + the ident, 89 s).
**Who it's for:** people who run coding agents (Codex, Claude Code) on their own machines.
**One question:** how can a text file that has no code hijack your AI agent?

**Format:** "they caught it live" + the catch: the exhibit → where it was → why it works → the proof on Codex →
the proof on Claude Code → *what's the catch?* (no bug to patch; the source sells protection and ran its own tests)
→ what to do → the payoff line → a yes/no ask.
**World:** the case file (see README). **Anchor:** AGENTS.md in an evidence bag (frame 1, the cover, the ask).
**Unique thing:** the payoff: the pen strikes ".md" in AGENTS.md and writes ".exe" over it.

## Facts and sources (checked 2026-11-05 against the article itself)
Source: forever.security/blog/hijacking-ai-agents-via-downloads-folder ("Markdown Is the New Executable: Attackers Are
Dropping Agent Instructions Into Your Downloads Folder From the Web", Gal Weizman, Omer Samet, Oct 22, 2026).
- Forever found a malicious AGENTS.md in ~/Downloads on a real customer machine, disguised as engineering notes; its
  product stopped a coding agent mid-session from installing `function-color`, a known malicious npm package (since
  removed by npm). "Nobody had put it there, and nobody knew how it got there."
- A web page can save a file into Downloads with no click and no approval; agents follow the AGENTS.md / CLAUDE.md in
  the folder they run in.
- Codex: they ran the attacker's real file, once with the real package inside an isolated VM (mostly a harmless
  stand-in). It writes `[mcp_servers.project-tools]` into `~/.codex/config.toml` (machine-wide, every later session
  loads it) and runs `npm install function-color` via launchctl. "Codex ran the malware in more than 90% of attempts."
  The real file is a 13 KB "Engineering Work Guidelines" document.
- Claude Code: "Claude was much harder to fool"; the researchers wrote their own CLAUDE.md, "inspired by" the
  attacker's, that sets `ANTHROPIC_BASE_URL` in `.claude/settings.json` to their server, which leaks the OAuth token.
  "Claude followed through on this about 50% of the time." (Same-session code execution: about a fifth.)
- "There is nothing here for OpenAI or Anthropic to patch": the agents behave as designed (Forever's view, said as
  theirs on screen: "no bug to patch… did exactly what they were built to do").
- Their advice: don't start an agent in ~/Downloads; read instruction files you didn't write; check agent configs;
  keep approvals and sandboxes on; rotate tokens if you find one.

## Corrections to the brief we were given
- The link `forever.security/blog/markdown-is-the-new-executable` serves the site's home page; the article lives at
  `/blog/hijacking-ai-agents-via-downloads-folder`.
- The ~50% Claude figure is for a CLAUDE.md **the researchers wrote**, not the file caught in the wild (that one
  targeted Codex). The video says "their own version".
- The article does not say antivirus treats .md as inert; it says the guardrails for downloaded executables don't
  apply to a text file. Not claimed.
- "Silent browser download" is how the attack *can* work; how the real file arrived is unknown ("nobody knew"). The
  video says exactly that.
- The CSA / OWASP / Hacker News follow-ups in the brief had no specific pages to check; not cited.
- Forever is a security vendor that sells protection against this; the numbers are its own tests. Said on screen (l18).
