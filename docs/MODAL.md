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
- **Cap**: hours of Modal a month (default 30; 0 = Modal off), counted from its heartbeats (`voicebox/modal-usage.json`).
  Past it Modal takes no new work until the month turns. A job that runs longer than 4 hours is let go (the container's
  own backstop, `VOICEBOX_MODAL_MAX_BUSY_H`).
- **Heavy jobs** (training, Orpheus drafts, video) stay on Colab unless "Training and video on Modal too" is on.

Change it in Settings → GPU & engines → Which GPU, or with the MCP: `gpu` action `backend` (`prefer`, `fallback`,
`modal_cap_h`, `modal_heavy`). `worker_status` and the dashboard's status show both GPUs (`gpus`).

## Setting it up (once)

1. Make a Modal account (the free plan comes with monthly credit), then on your computer:
   ```bash
   pip install modal && modal setup
   ```
2. Give Modal the worker's secret and the studio's address (the same values the Colab notebook uses):
   ```bash
   modal secret create voicebox WORKER_SECRET=<the WORKER_SECRET on the Worker> REGISTER_URL=https://voiceboxstudio.pages.dev/api/register
   ```
3. Deploy it, and paste the address it prints (`https://<you>--voicebox-worker-gateway.modal.run`) into Settings → GPU &
   engines → Modal address (or set it on the Worker: `npx wrangler secret put MODAL_WORKER_URL`):
   ```bash
   modal deploy modal_app/voicebox_modal.py
   ```
4. Optional: add `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` (from `modal token new`) as repository secrets, and every merge
   that changes `modal_app/` redeploys it. The worker code itself needs no redeploy: each start fetches the newest from
   `/api/bundle`, like the Colab notebook.

The GPU type is L4 by default (`VOICEBOX_MODAL_GPU=A100 modal deploy …` for another). Check https://modal.com/pricing for
what an hour costs and how much credit the free plan includes; set the cap to match.

## Checks

`cd mcp && npx -y tsx scripts/check-gpus.mts`: the routing against two fake GPUs (preference, fallback both ways, job
follow-ups, a read never waking Modal, the cap, heavy jobs).
