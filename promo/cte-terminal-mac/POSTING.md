# Posting: terminal-mac, a whole Mac inside your terminal (for your AI agent)

**Title (YouTube Shorts):** Your AI Agent Gets Its Own Mac (terminal-mac)
(Radar's title_lab on this channel: the keyword phrase first, under 50 characters; check it with `title_lab` before
posting, since the last run said a number wins and questions lose.)

**Instagram caption:**
Someone just put a whole Mac inside a terminal. And it's not for you. It's for your AI agent. 🖥️

terminal-mac (open source, MIT) runs a real macOS guest in Apple's own Virtualization framework on your Apple silicon
Mac, and streams it into your terminal. Your agent clicks, drags and types in that Mac, and your own pointer and
clipboard stay yours.

✅ 7 MCP tools: screenshot, click, drag, scroll, type, key, status
✅ Claude Code plugin, or any MCP client (Cursor, VS Code, Codex, Windsurf)
✅ Sends a frame only when the screen changes: an idle desktop costs nothing
✅ One-line install: curl -fsSL https://github.com/govijr/terminal-mac/releases/latest/download/get.sh | bash

The catch: it's an early release candidate, self-signed (not notarized by Apple), the first run downloads macOS
(several GB), and the guest is online by default (add --offline to cut it). It isn't a hardened sandbox for
hostile code.

Would you let an agent drive your Mac? Yes or no in the comments 👇

Demo footage: @kirtandopamine on X (credited on screen). Repo: github.com/govijr/terminal-mac

**Hashtags:** #AIagents #ClaudeCode #macOS #MCP #ComputerUse #OpenSource #DevTools #AppleSilicon #Terminal #CatchTheError

**YouTube description:** the caption above, then: "Sources: https://github.com/govijr/terminal-mac ·
https://x.com/kirtandopamine/status/2117678349828976746 · https://x.com/kirtandopamine/status/2117678355440914786"

**Labels:** `youtube.synthetic: false`, `instagram.ai_generated: false` (the owner's call). Not a paid partnership:
no one paid for this, so no "paid partnership" label and no #ad. It's made to look like a $10k launch ad, not sold as one.
**Cover:** `node tools/render.js stills -1` → `out/still--1.00.png`: "Your AI gets its own Mac." over the Droste (the real
frame of macOS in the terminal, inside itself, five deep), the agent's red cursor on it, `~ % terminal-mac`.
**Slot:** from `analytics` best times for Catch the Error when posting.
