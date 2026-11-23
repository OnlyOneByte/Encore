# Encore worker — the make-karaoke box: fetch, separate, align. Gated behind the compose `stems` profile,
# so the default MVP `up` does not build this multi-GB image.
#
# Dependencies come from `uv` against a LOCKFILE, so the image resolves the same versions the dev box
# tested — `--frozen` below turns a lock/manifest disagreement into a build failure rather than a silent
# re-resolve. The deno runtime, /etc/yt-dlp.conf, the non-root uid and the cache volume were each paid for
# in the predecessor image this replaced, and none of the reasons changed.
FROM python:3.12-slim-bookworm AS runtime
WORKDIR /app/worker

# ffmpeg is NOT optional here: `host/hardware.py` refuses to advertise `stems` without it, because
# publication encodes stems to FLAC and the guide mix is an ffmpeg filter graph. A box without it would
# connect, advertise nothing, and look broken.
#
# KEPT EVEN THOUGH THE `ffmpeg` EXTRA BELOW BUNDLES ONE, and the two serve different callers.
# `host.ffmpeg` prefers the bundled static build, so that is what encodes every stem — which is the point:
# one pinned build instead of bookworm's 5.1 versus whatever Homebrew has. Not one version everywhere: the
# Linux wheels (x86_64 and aarch64) ship 7.0.2, macOS arm64 7.1. This apt package stays for anything that shells `ffmpeg`
# BY NAME rather than through our config: whisperx's `load_audio` does, and yt-dlp would if a format ever
# needed merging.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ffmpeg ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

# uv is copied from its own published image rather than installed with pip: it is a build TOOL, so it has
# no business in the runtime's dependency resolution, and the pinned tag is reproducible.
COPY --from=ghcr.io/astral-sh/uv:0.9.2 /uv /usr/local/bin/uv

# ── dependencies, from the lockfile ──────────────────────────────────────────────────────────────
# Manifests ONLY in this layer, so editing a source file does not re-resolve or re-download torch.
#
# `--frozen` fails the build if the lockfile disagrees with pyproject.toml, rather than silently
# re-resolving to versions no one tested — the whole reason for locking. `--no-install-project` installs
# the dependencies without the package itself, which is what keeps this layer independent of `encore_worker`.
COPY worker/pyproject.toml worker/uv.lock ./

# Which torch index, and therefore which accelerator. `cpu` by default; a CUDA deploy overrides the extra
# rather than the index URL, because `[tool.uv.sources]` already maps each extra to its own index and the
# two are declared mutually exclusive.
ARG TORCH_EXTRA=cpu
ENV UV_LINK_MODE=copy \
	UV_PYTHON_DOWNLOADS=never \
	UV_PROJECT_ENVIRONMENT=/usr/local
#
# `romanize` + `nonlatin` are the non-Latin lane's 49 MB (47 of it unidic-lite's MeCab dictionary), in the
# image because romanization requires them: without them `build_romanizer` answers None, no CJK line gains
# its second script, and the per-language stage-2 table cannot route zh or ko to MMS_FA at all
# (docs/arch/04-alignment.md §9.2).
RUN --mount=type=cache,target=/root/.cache/uv \
	uv sync --frozen --no-install-project --extra "${TORCH_EXTRA}" --extra ml --extra text --extra ffmpeg --extra audiosep --extra romanize --extra nonlatin

# ── deno, for yt-dlp's challenge solver ──────────────────────────────────────────────────────────
# Placed AFTER the dependency layer on purpose: a layer invalidates everything below it, so a ~40 MB
# download above a multi-GB torch install would make a DENO_VERSION bump re-download torch. This way a
# deno bump costs 40 MB.
#
# The version is READ FROM worker.Dockerfile by dev.sh so a dev box cannot drift from prod — keep the
# `ARG DENO_VERSION=` spelling greppable if that ever points here instead.
ARG DENO_VERSION=2.9.6
RUN python3 -c "import io,os,stat,urllib.request,zipfile; \
v=os.environ['DENO_VERSION']; arch=os.uname().machine; \
url=f'https://github.com/denoland/deno/releases/download/v{v}/deno-{arch}-unknown-linux-gnu.zip'; \
print('fetching', url, flush=True); \
zipfile.ZipFile(io.BytesIO(urllib.request.urlopen(url, timeout=300).read())).extract('deno', '/usr/local/bin'); \
p='/usr/local/bin/deno'; os.chmod(p, os.stat(p).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)" \
	&& deno --version | grep -q "deno ${DENO_VERSION}"

# Enables yt-dlp's challenge-solver remote component, without which the deno runtime above solves nothing.
# Shared verbatim with the old worker: yt-dlp reads /etc/yt-dlp.conf before the command line, so this
# covers every call site without threading a flag through each one.
COPY docker/yt-dlp.conf /etc/yt-dlp.conf

# ── the application ──────────────────────────────────────────────────────────────────────────────
# Last, so a source edit rebuilds only from here down.
COPY worker/encore_worker ./encore_worker
COPY worker/README.md ./README.md

ENV PYTHONUNBUFFERED=1 \
	PYTHONDONTWRITEBYTECODE=1 \
	MEDIA_DIR=/app/media \
	ENCORE_MEDIA_DIR=/app/media \
	# Durable state is PER BOX: it holds in-flight checkpoints, so it must not be shared between workers
	# and must not sit on the media volume, where a retention sweep would be free to evict it.
	ENCORE_DBOS_DB=/home/worker/state/encore-worker.sqlite
VOLUME ["/app/media"]

# Non-root, matching the old worker's uid so a shared media volume keeps one owner across both images —
# a mismatched uid on the same bind mount is a permission failure that reads as a missing file.
RUN useradd --create-home --uid 10001 worker \
	&& mkdir -p /app/media /home/worker/.cache /home/worker/state \
	&& chown -R worker:worker /app /home/worker
USER worker
ENV HOME=/home/worker XDG_CACHE_HOME=/home/worker/.cache

# PID-1 zombie reaping is the COMPOSE side's job (`init: true`): demucs and yt-dlp grandchildren reparent
# to this process, which is not an init and would accumulate them.
CMD ["python", "-m", "encore_worker"]
