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
# requirements.txt also pins yt-dlp (B-9-C1) so the source fetcher ships WITH the image: it used to be
# hand-installed into a live container, which a `docker rm` silently undid.
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu
COPY apps/worker/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --extra-index-url "${TORCH_INDEX_URL}" -r requirements.txt \
	&& yt-dlp --version

# karaoke-lyrics-processor, deliberately --no-deps and therefore in its own layer (see the long note
# in requirements.txt): its declared deps are 30 packages serving .doc ingestion + a clipboard copy,
# neither of which this worker calls. The three it genuinely imports are pinned in requirements.txt;
# `textract` is stubbed at import time in src/lyrics_presplit. If this layer is ever dropped, lyrics
# still work — the boundary pre-split runs standalone and the TV's LINE_MAX_CHARS still bounds a row.
RUN pip install --no-cache-dir --no-deps karaoke-lyrics-processor==0.6.0

# deno — the JavaScript runtime yt-dlp needs to solve YouTube's player challenge. Without a runtime,
# extraction degrades until NO audio-only format resolves and every cook dies at download with
# "Requested format is not available"; deno is the only runtime yt-dlp enables by default, so it
# belongs in the image rather than in an operator's setup notes. Pinned and verified in the SAME layer
# for the same reason `yt-dlp --version` is: a missing or wrong binary must break the BUILD, not a
# party. Paired with /etc/yt-dlp.conf below, which enables the solver script deno executes.
#
# The release asset is named by `uname -m` verbatim (aarch64 / x86_64), so this one line covers both
# an arm64 dev box and an x86_64 GPU host. Unpacked with python's zipfile so the image needs no
# `unzip` package, and fetched with urllib so it needs no `curl`.
#
# Placed AFTER the pip layers on purpose. Layers invalidate everything below them, so putting a ~40 MB
# download above a multi-GB torch install means a DENO_VERSION bump re-downloads torch. This ordering
# inverts that: a deno bump costs 40 MB, and a requirements change costs re-fetching deno — the cheap
# thing, not the expensive one.
ARG DENO_VERSION=2.9.6
RUN python3 -c "import io,os,stat,urllib.request,zipfile; \
v=os.environ['DENO_VERSION']; arch=os.uname().machine; \
url=f'https://github.com/denoland/deno/releases/download/v{v}/deno-{arch}-unknown-linux-gnu.zip'; \
print('fetching', url, flush=True); \
zipfile.ZipFile(io.BytesIO(urllib.request.urlopen(url, timeout=300).read())).extract('deno', '/usr/local/bin'); \
p='/usr/local/bin/deno'; os.chmod(p, os.stat(p).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)" \
	&& deno --version \
	&& deno --version | grep -q "deno ${DENO_VERSION}"

# Enables yt-dlp's challenge-solver remote component, without which the runtime above cannot actually
# solve anything. See the file for the trade-off it makes explicit.
COPY apps/worker/yt-dlp.conf /etc/yt-dlp.conf

# worker sources (the dial-home client + processor + pure protocol)
COPY apps/worker/src ./src

# ENCORE_WORKER_CAPABILITIES is deliberately NOT baked here. It is now a narrowing filter over what
# the worker can prove it can do (capabilities.py probes PATH and imports at startup), so a baked
# `stems` would silently cap every container built from this image to separation only — dropping the
# fetch and align it is perfectly capable of, and leaving those jobs unclaimed. That is exactly the
# failure the probe was written to remove, so the image must stay silent and let the box speak.
ENV PYTHONUNBUFFERED=1 \
	ENCORE_CORE_WS=ws://core:3000/ws?role=worker \
	MEDIA_DIR=/app/media
VOLUME ["/app/media"]

# Run as a non-root user (Finding #4): the worker never needs root. Own the shared media volume so
# it can write stems. Demucs caches model weights under $HOME — give the user a writable home.
#
# $XDG_CACHE_HOME is created HERE, owned by the worker, rather than left to appear at runtime. It is
# the mount point for the model cache (demucs weights, the RoFormer checkpoint, yt-dlp's solver
# script), and Docker initialises a named volume from the image directory it covers — so if the
# directory does not exist the volume is created root-owned and the unprivileged worker cannot write
# to it. Creating it here is what makes the volume work with no operator chown step.
RUN useradd --create-home --uid 10001 worker \
	&& mkdir -p /app/media /home/worker/.cache \
	&& chown -R worker:worker /app /home/worker
USER worker
ENV HOME=/home/worker XDG_CACHE_HOME=/home/worker/.cache

# `python -m src.dial_home` so the package-relative imports (from . import protocol) resolve.
CMD ["python", "-m", "src.dial_home"]
