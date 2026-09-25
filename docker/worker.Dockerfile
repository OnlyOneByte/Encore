# Encore worker — container 2 (the make-karaoke ML box). Gated behind the compose `stems` profile, so the
# MVP never builds or ships this multi-GB image. Dials home to core over WS (ARCHITECTURE §3). CPU by
# default — a GPU deploy overrides the torch index (docs/deploy/README.md).
FROM python:3.12-slim-bookworm AS runtime
WORKDIR /app/worker

# ffmpeg = audio decode/encode for the stems pipeline. Pinned base image, no bare latest.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ffmpeg ca-certificates gcc build-essential \
	&& rm -rf /var/lib/apt/lists/*

# Python deps first for layer caching; torch CPU wheels from the official index (override the build-arg
# for CUDA). `yt-dlp --version` runs in the SAME layer as the install that provides it, so a missing or
# broken source fetcher breaks the BUILD rather than the first cook.
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu
COPY worker/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --extra-index-url "${TORCH_INDEX_URL}" -r requirements.txt \
	&& yt-dlp --version

# karaoke-lyrics-processor is --no-deps, and so its own layer: its declared deps are ~30 packages serving
# .doc ingestion and a clipboard copy this worker never calls (requirements.txt pins the three it imports;
# src/lyrics/presplit.py stubs `textract` at import time).
RUN pip install --no-cache-dir --no-deps karaoke-lyrics-processor==0.6.0

# deno — the JavaScript runtime yt-dlp needs to solve YouTube's player challenge, and the only one it
# enables by default, so it belongs in the image rather than an operator's setup notes. Paired with
# /etc/yt-dlp.conf below, and version-verified in the same layer for the same reason `yt-dlp --version`
# is. The asset is named by `uname -m` verbatim, so one line covers arm64 and x86_64; zipfile + urllib
# avoid needing `unzip` or `curl`. Placed AFTER the pip layers on purpose — layers invalidate everything
# below them, so a ~40 MB download above a multi-GB torch install would make a DENO_VERSION bump
# re-download torch. This way a deno bump costs 40 MB, not a torch re-fetch.
ARG DENO_VERSION=2.9.6
RUN python3 -c "import io,os,stat,urllib.request,zipfile; \
v=os.environ['DENO_VERSION']; arch=os.uname().machine; \
url=f'https://github.com/denoland/deno/releases/download/v{v}/deno-{arch}-unknown-linux-gnu.zip'; \
print('fetching', url, flush=True); \
zipfile.ZipFile(io.BytesIO(urllib.request.urlopen(url, timeout=300).read())).extract('deno', '/usr/local/bin'); \
p='/usr/local/bin/deno'; os.chmod(p, os.stat(p).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)" \
	&& deno --version \
	&& deno --version | grep -q "deno ${DENO_VERSION}"

# Enables yt-dlp's challenge-solver remote component, without which the runtime above solves nothing.
# See the file for the trade-off it makes explicit.
COPY worker/yt-dlp.conf /etc/yt-dlp.conf

# worker sources (the dial-home client + processor + pure protocol)
COPY worker/src ./src

# ENCORE_WORKER_CAPABILITIES is deliberately NOT baked. It is a NARROWING filter over what
# host/capabilities.py proves at startup, so a baked `stems` would cap every container from this image to
# separation only — dropping the fetch and align it is capable of and leaving those jobs unclaimed.
ENV PYTHONUNBUFFERED=1 \
	ENCORE_CORE_WS=ws://core:3000/ws?role=worker \
	MEDIA_DIR=/app/media
VOLUME ["/app/media"]

# Run as a non-root user: the worker never needs root. It owns the shared media volume so it can write
# stems, and a writable home because demucs caches model weights under $HOME. $XDG_CACHE_HOME is created
# HERE, owned by the worker, rather than left to appear at runtime: Docker initialises a named volume from
# the image directory it covers, so if that directory is missing the volume is created root-owned and the
# unprivileged worker cannot write to it. This is what makes compose's `worker-cache` need no chown step.
RUN useradd --create-home --uid 10001 worker \
	&& mkdir -p /app/media /home/worker/.cache \
	&& chown -R worker:worker /app /home/worker
USER worker
ENV HOME=/home/worker XDG_CACHE_HOME=/home/worker/.cache

# `python -m src.dial_home` so the package-relative imports (from . import protocol) resolve.
CMD ["python", "-m", "src.dial_home"]
