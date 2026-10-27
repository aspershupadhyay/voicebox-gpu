# Ask Voicebox

The assistant built into the dashboard: the **Ask** button in the top bar, **⌘J**, or type anything in **⌘K** and pick
"Ask Voicebox". It does the work itself with the same tools Claude gets over MCP (`mcp/lib/mcptools.ts`: files and
folders, posts and scripts, the calendar, voiceovers, clean-up, subtitles, images, the GPU), so chores don't cost your
Claude tokens. Chats are shared by both of you (R2 `workspace/ask/`).

## Two brains

| Brain | Runs on | Pays | Set up |
|---|---|---|---|
| **Antigravity** | Antigravity CLI (`agy`) on the Colab worker, signed in with your Google account | your Google AI plan (no API bill) | Settings → Ask Voicebox → **Sign in with Google** while the worker is on |
| **Gemini API** | the Gemini API, called from Vercel | the key's free tier (or its billing) | `GEMINI_API_KEY` in the Vercel project (an AI Studio key) |

**Auto** (the default) uses Antigravity while the worker is on and Gemini when it's off. Pick one in the panel's menu
or in Settings. `agy` uses no GPU: the model runs at Google, and the worker only starts the program, so it doesn't eat
compute units by itself (only keeping a GPU runtime on does).

## What waits for you

Deleting (posts, uploads, files, folders, emptying the trash), changing settings, starting / stopping / updating the GPU,
training a voice, cancelling a job, and deleting an engine's weights are never run by the assistant: the call is parked
and an **Approve / Decline** card shows in the chat. Approve runs it as you (the activity feed says
"<you> (Ask Voicebox)"). The list is `needsApproval()` in `mcp/lib/ask.ts`; the same gate covers both brains.

## How it works

- **Gemini** (`mcp/lib/gemini.ts`): the tools are collected in-process (`localTools`), their zod schemas become function
  declarations, and the route streams each tool call to the panel as NDJSON while Gemini works (up to 24 steps or
  250 s per message). Gemini's own history (thought signatures included) is kept per chat so follow-ups keep context.
- **Antigravity** (`mcp/lib/agy.ts`, `worker/ask.py`): each message is one `agy -p … --output-format stream-json` run on
  the worker, in an empty folder with none of the worker's secrets in its environment. It reaches the tools through
  `/api/mcp?ask=1` with a token minted for that chat (45 min, `lib/ask.ts` `mintAskToken`), so the gate knows which chat
  an approval belongs to. The panel polls the run every 1.5 s.
- **Sign-in:** `agy` shows a Google link and waits a minute for the code that page gives you. The worker runs it in a
  pseudo-terminal, the dashboard opens the link, you paste the code back. The sign-in files then go to R2 sealed with
  AES-GCM (key from `ASK_SECRET`, else `MCP_TOKEN`), so a fresh Colab runtime is signed in again by itself. Sign out in
  Settings removes them from R2 and the worker.

## Configuration

| Variable | Where | What |
|---|---|---|
| `GEMINI_API_KEY` | Vercel | Turns on the Gemini brain (https://aistudio.google.com/apikey). |
| `GEMINI_MODEL` | optional | Default `gemini-flash-latest`. |
| `ASK_SECRET` | optional | Key for sealing Antigravity's sign-in in R2; defaults to one derived from `MCP_TOKEN` (rotating it means signing in again). |

## Not yet verified

The sign-in and runs were built against Antigravity CLI 1.4.8 (its `-p`, `--output-format stream-json`, MCP config with
headers) and tested up to Google's code exchange; a full signed-in run needs your Google account. If Google changes the
stream format, the reply still arrives as text; only the step chips may be missing.
