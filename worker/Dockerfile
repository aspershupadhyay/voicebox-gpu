# The GPU worker as an always-on container: the same launcher the Colab notebook runs (gateway, Cloudflare tunnel,
# heartbeat to the dashboard), for any host with an NVIDIA GPU (RunPod, Vast.ai, Lambda, a box of your own).
#
#   docker build -t voicebox-worker worker/
#   docker run --gpus all -v voicebox:/data -e WORKER_SECRET=... -e REGISTER_URL=https://<app>/api/register voicebox-worker
#
# Mount /data on a persistent volume: engine venvs, model weights and your trained voice live there, so a restart takes
# seconds instead of a fresh install. See docs/HOSTING.md.
FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1 VOICEBOX_HOME=/data/voicebox HF_HOME=/data/hf \
    UV_CACHE_DIR=/data/uv-cache UV_PYTHON_INSTALL_DIR=/data/uv-python
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
        python3 python3-pip python3-dev build-essential git curl ca-certificates ffmpeg libsndfile1 procps \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --no-cache-dir -q uv numpy scipy soundfile
COPY . /app/worker
WORKDIR /app/worker
CMD ["python3", "launcher.py"]
