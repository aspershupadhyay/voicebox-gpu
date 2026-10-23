# Always-on worker (no Colab)

Colab is fine for sessions, but it sleeps, recycles its disk and needs you to press *Run all*. The same worker runs
as a container on any NVIDIA GPU host, so the studio answers at any hour and engines stay warm.

## What to rent

| GPU | VRAM | Good for |
|---|---|---|
| L4 | 24 GB | everything voice (your model, Orpheus, Qwen, Chatterbox, Whisper) and training |
| A10G / RTX A5000 | 24 GB | the same, usually cheaper per hour |
| L40S / A100 40 GB | 48 / 40 GB | voice + video engines without swapping, faster training |

Give it a **persistent volume of 100 GB+** (voice only) or 250 GB+ (with video models), mounted at `/data`.
Engine venvs, model weights, your trained adapter and the job outputs live there, so a restart takes seconds.

## Run it

```bash
docker build -t voicebox-worker worker/
docker run -d --restart unless-stopped --gpus all -v voicebox:/data \
  -e WORKER_SECRET=<same as the dashboard> \
  -e REGISTER_URL=https://<app>/api/register \
  -e PREWARM=myvoice,whisper \
  -e VOICEBOX_IDLE_MIN=720 \
  voicebox-worker
```

- `PREWARM` loads engines at start, so the first request doesn't wait for a model load. `myvoice,whisper` keeps your
  voice and the listening pass ready.
- `VOICEBOX_IDLE_MIN` is how long an idle engine stays loaded (default 30). On a box you pay for by the hour anyway,
  keep them loaded.
- `HF_TOKEN` (optional) avoids Hugging Face rate limits on first download. The rest (your model, R2 links) comes from the
  dashboard through `/api/worker-env`, exactly as on Colab.

The launcher opens a Cloudflare quick tunnel and heartbeats the dashboard every 60 s, so nothing needs a public port.
If the gateway or the tunnel dies it restarts them; `--restart unless-stopped` covers the container itself.

**RunPod / Vast.ai:** push the image to a registry (`docker tag voicebox-worker <you>/voicebox-worker && docker push ...`),
create a pod from it with the volume at `/data`, and put the variables above in the pod's environment.

## Cost

An always-on L4 runs about $0.40–0.80 an hour depending on the provider. If that's more than you want, stop the pod
when you're done and start it before a session: with the volume kept, it's ready again in under a minute.
