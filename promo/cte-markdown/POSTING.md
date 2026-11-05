# Posting: Markdown is the new malware

**Title (Shorts):** This text file hijacked an AI coding agent
**Instagram caption / YouTube description:**
A file with no code tried to install malware on a real computer. It was an AGENTS.md sitting in someone's Downloads
folder, and coding agents read that file and do what it says.

Forever Security caught it live, then ran the real file on OpenAI Codex inside an isolated VM: Codex ran the malware in
more than 90% of attempts. Their own version for Claude Code got Claude to reroute its traffic about half the time,
leaking its login token.

The catch: there's no bug to patch (the agents did what they're built to do), and Forever sells protection against
this, so these are its own tests.

What to do: never start an agent in ~/Downloads, and read any AGENTS.md or CLAUDE.md you didn't write.

Source: "Markdown Is the New Executable", Gal Weizman & Omer Samet, Forever Security, Oct 22, 2026 →
forever.security/blog/hijacking-ai-agents-via-downloads-folder

Do you read these files before your agent does? Yes or no 👇

**Hashtags:** #aiagents #cybersecurity #codex #claudecode #promptinjection #infosec #devtools #catchtheerror
**Cover:** `out/cover.jpg` (Files → Videos/Markdown Malware)
**Flags:** youtube.synthetic false · instagram.ai_generated false
