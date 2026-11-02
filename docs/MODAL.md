# Modal: the second GPU

The studio has two GPUs that run the same worker code (`worker/`):

- **Colab**: on while its runtime runs (started from Settings → GPU & engines, or the notebook).
- **Modal** (`modal_app/voicebox_modal.py`): asleep until a job wakes it (about a minute; the very first start also
  installs the engines). It bills by the second and goes back to sleep 10 minutes after the last request. Engines and
  weights stay on a Modal Volume (`voicebox-home`), so they download once.

## Which one takes the work

`mcp/lib/gpus.ts` holds the choice and `mcp/lib/worker.ts` routes every call through it:

- **Prefer** Colab or Modal for new work. **Fall back** (on by default): when the first is off, past its cap or certainly
  never got the request (its address doesn't resolve, refuses, Cloudflare's 530), the other takes it. A request that may
  have arrived (a timeout mid-way) is never sent again, so no job runs twice.
- A job's follow-ups (progress, push, cancel) go to the GPU that has it: Modal's job ids are noted in R2
  (`voicebox/modal-jobs.json`); every other id is Colab's.
- A sleeping Modal is woken only by work (a POST), never by a read: every open tab polls status and lists.
- An awake cloud GPU never gets those polls either (status, metrics, the job list): every request restarts its sleep
  timer, so an open dashboard would keep it awake for ever. Status comes from its heartbeat; the job list asks it only
  while it's busy or took a job in the last 30 minutes. It gets work, its own jobs' follow-ups and explicit tests.
- **Cap**: hours of Modal a month (default 30; 0 = Modal off), counted from its heartbeats (`voicebox/modal-usage.json`).
  Past it Modal takes no new work until the month turns. A job that runs longer than 4 hours is let go (the container's
  own backstop, `VOICEBOX_MODAL_MAX_BUSY_H`).
- **Heavy jobs** (training, Orpheus drafts, video) stay on Colab unless "Training and video on Modal too" is on.

Change it in Settings → GPU & engines → Which GPU, or with the MCP: `gpu` action `backend` (`prefer`, `fallback`,
`modal_cap_h`, `modal_heavy`, `modal_url`, and `test_modal: true` to wake it and see its GPU). `worker_status` and the dashboard's status show both GPUs (`gpus`).

## Setting it up (once)

1. Make a free account at https://modal.com.
2. Settings → GPU & engines → Which GPU → **Set up Modal**. It shows four commands; copy them into a terminal (Mac or
   Linux; on Windows, WSL):
   - install Modal and sign in (opens modal.com in the browser),
   - download this app from the studio (`/api/modal/app`),
   - give Modal its key and the studio's address (`modal secret create voicebox …`),
   - deploy, then `python3 voicebox_modal.py <key> <studio>`, which tells the studio Modal's address. The card turns green.

A start never depends on reaching the studio: the deploy step bakes the worker code into the image (`VOICEBOX_KEY` and
`VOICEBOX_STUDIO` in the command), each start fetches the newest and keeps it on the Volume, and falls back to the last
one. A start that fails anyway answers every request with why (HTTP 424), which Test Modal shows.

The commands carry **Modal's own key**, made by the studio for this (`lib/gpus.ts`, kept sealed in R2). Nothing has to be
looked up: Modal never needs `WORKER_SECRET`. It's the password between the studio and the Modal worker and opens the
worker routes (heartbeat, bundle, settings, weight cache) and `/api/modal/app`, nothing else; it can't stand in for
the Colab worker's record. Pressing Set up Modal again makes a new key and the old one stops working (run the commands
again). The key is made only for a signed-in person in the browser, never for the MCP or a model.

If the last step says it couldn't reach the studio (on a Mac with the python.org Python, `CERTIFICATE_VERIFY_FAILED`
before 2026-11-02: that Python trusts no certificates until its "Install Certificates" step; the script now uses
certifi's), the GPU is deployed anyway: run the last command again, or paste the address it printed in the card.
Then press **Test Modal** (or the MCP: `gpu` action `backend` with `test_modal: true`): it wakes Modal and answers with
its GPU.

By hand instead: the same commands with the Worker's `WORKER_SECRET` as the key work too, and the address can be pasted
in the card (or set on the Worker: `npx wrangler secret put MODAL_WORKER_URL`).

Optional: add `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` (from `modal token new`) as repository secrets, and every merge
that changes `modal_app/` redeploys it. The worker code itself needs no redeploy: each start fetches the newest from
`/api/bundle`, like the Colab notebook.

The GPU is the first of L4, A10G, A100 40 GB and L40S that Modal has free (L4 alone queued for 8+ minutes with no
capacity); `VOICEBOX_MODAL_GPU=L4 modal deploy …` (or a comma list) pins it. To see a start step by step:
`python3 -m modal run voicebox_modal.py::doctor`. Check https://modal.com/pricing for
what an hour costs and how much credit the free plan includes; set the cap to match.

## Cerebrium: the third GPU

The same as Modal on a second cloud (`cerebrium_app/`: `cerebrium.toml` and `voicebox_cerebrium.py`): asleep until a
job wakes it, billed by the second, its own monthly hour cap (default 15), Stop, and the same fallback. The order is
Colab, Modal, Cerebrium after whichever goes first. It runs the gateway as a custom web server on port 8000, auth off at
Cerebrium (the gateway checks the cloud key itself), engines and weights on `/persistent-storage`, one replica,
asleep 10 min after the last request. GPU: the first free of L4 and L40. It runs on **protected** capacity (2x the
interruptible rate): on interruptible, Cerebrium started a second container mid-job and the job's polls went to it.

Setting it up: Settings → GPU & engines → Cerebrium → **Set up Cerebrium**, then paste the four commands (Mac or
Linux): the CLI and sign-in, the two files from the studio (`/api/modal/app?f=…`), `voicebox.env` with the cloud key
(deployed with the app: Cerebrium has no secrets command), then deploy and connect (the address is read from what the
deploy printed). Modal and Cerebrium share the **cloud key**: Set up reuses it, so setting one up never breaks the
other (`new_key: true` on `gpus/<cloud>-setup` replaces it; then both need their setup run again).

The MCP: `gpu` action `backend` with `prefer: "cerebrium"`, `cerebrium_url`, `cerebrium_cap_h`, and `cloud:
"cerebrium"` with `test_modal` / `stop_modal`.

## Deploying from the website (no terminal)

Settings → GPU & engines → Modal / Cerebrium → **Deploy from the website** (`lib/clouddeploy.ts`):

1. Paste the cloud's tokens once: Modal's token id and secret (modal.com → Settings → API Tokens → New token), or
   Cerebrium's Service Account key and project id (dashboard.cerebrium.ai → API Keys → Create Service Account). They're
   sealed in R2 like the cloud key; the page shows only their last 4 characters, and no model ever gets them.
2. **Deploy** starts `.github/workflows/gpu-deploy.yml` with the studio's GitHub key (Settings → Automation → Keys; it
   needs **Actions: read and write** on this repository) and a one-time deploy id.
3. The run proves itself with GitHub's OIDC token (audience `voicebox-deploy`, that workflow on main), turns the id in
   once (within 30 minutes) for the tokens and the cloud key (`/api/gpus/deploy-keys`), masks them, deploys the
   cloud's app from this repository, connects its address, and reports (`/api/gpus/deploy-report`). The card shows
   Deploying… / Deployed / Failed with a link to the run. Nothing is stored in GitHub.

## Checks

`cd mcp && npx -y tsx scripts/check-clouddeploy.mts`: deploying from the website against a fake GitHub (tokens sealed,
the start, the one-time id, the report, the GitHub-only routes).


`cd mcp && npx -y tsx scripts/check-gpus.mts`: the routing against two fake GPUs (preference, fallback both ways, job
follow-ups, a read never waking Modal, the cap, heavy jobs, Modal's own key, Cerebrium as the third GPU).
