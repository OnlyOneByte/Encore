# Encore worker — container 2 (the make-karaoke ML box). Gated behind the compose `stems` profile,
# so the MVP never builds or ships it. Dials home to core over WS (§5); runs Demucs htdemucs (M7-C5)
# + WhisperX (M7-C8). CPU by default — a GPU deploy overrides the torch index + adds a CUDA base.
#
# Heavy by nature (torch is multi-GB); that's exactly WHY it's quarantined from the one-container MVP.
FROM python:3.12-slim-bookworm AS runtime
WORKDIR /app/apps/worker

# ffmpeg = audio decode/encode for the stems pipeline. Pinned base image (Finding #4), no bare latest.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ffmpeg ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

# Python deps first for layer caching. Torch CPU wheels from the official index (override with a
# build-arg for CUDA). --no-cache-dir keeps the (already large) image from bloating further.
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu
COPY apps/worker/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --extra-index-url "${TORCH_INDEX_URL}" -r requirements.txt

# worker sources (the dial-home client + processor + pure protocol)
COPY apps/worker/src ./src

ENV PYTHONUNBUFFERED=1 \
	ENCORE_CORE_WS=ws://core:3000/ws?role=worker \
	ENCORE_WORKER_CONCURRENCY=1 \
	ENCORE_WORKER_CAPABILITIES=stems \
	MEDIA_DIR=/app/media
VOLUME ["/app/media"]

# Run as a non-root user (Finding #4): the worker never needs root. Own the shared media volume so
# it can write stems. Demucs caches model weights under $HOME — give the user a writable home.
RUN useradd --create-home --uid 10001 worker \
	&& mkdir -p /app/media \
	&& chown -R worker:worker /app
USER worker
ENV HOME=/home/worker XDG_CACHE_HOME=/home/worker/.cache

# `python -m src.dial_home` so the package-relative imports (from . import protocol) resolve.
CMD ["python", "-m", "src.dial_home"]
