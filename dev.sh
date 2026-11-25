#!/usr/bin/env bash
# Local dev runner for Encore (personal project — github.com/OnlyOneByte/Encore).
# Runs core + the make-karaoke worker NATIVELY, no Docker/Finch. On a Mac that is the better dev loop:
# a Finch/Lima VM has no GPU passthrough at all, so the worker would cook on VM CPU.
#
# Usage:
#   bash dev.sh                  # start core + worker (build first if needed)
#   bash dev.sh --core-only      # core only (no ML, no venv needed)
#   bash dev.sh --ui             # vite dev server — UI HMR only, NO realtime/WS (see below)
#   bash dev.sh --pull           # git pull + refresh deps + rebuild, then start
#   bash dev.sh --reset          # DELETE all local state (media, db, builds), then start
#   bash dev.sh --fresh          # --pull + --reset: the "start over completely" button
#   bash dev.sh --reset --no-start        # clean and exit
#   bash dev.sh --reset --nuke-models     # also drop the multi-GB ML model caches
#   bash dev.sh --reset --yes    # skip the destructive-action confirmation
#
#   ./dev.sh compose up                     # DOCKER instead of native: core only
#   ./dev.sh compose --stems up         # core + the karaoke worker
#   ./dev.sh compose --cuda --stems up -d      # the NVIDIA deploy target
#     Everything after `compose` is passed to `docker compose` verbatim, against
#     docker/compose.yaml. Skips all native-dev preflight.
#
# Environment:
#   PORT                   core's port (default 3000); read here as well as by server.ts
#   ENCORE_SKIP_DENO=1     do not fetch deno; YouTube downloads will fail without it
#   ENCORE_SKIP_FFMPEG=1   do not check ffmpeg at all (presence OR codecs); stems will not encode and
#                          every loudness reading becomes "unmeasurable", which publishes silent stems
#   ENCORE_ENV_FILE        a .env other than ./docker/.env
#
# WHY --ui IS SEPARATE. `bun run dev` (vite) serves the UI with HMR but NOT the WebSocket hub —
# server.ts owns both in one process, and vite only runs the SvelteKit half. A song will never cook
# and the queue will never move under --ui. Use it for pure styling work, nothing else.
set -eo pipefail
# Job control makes every `&` job a process-group LEADER, so cleanup can signal a whole tree. Without
# it the worker's demucs/yt-dlp children and core's nested `bun run ./server.ts` outlive ctrl-c.
set -m
# `set -e` exits silently, and the last thing printed is usually a child's unrelated output. Name the line.
trap 'code=$?; [ "$code" -eq 0 ] || echo "dev.sh: failed at line $LINENO (exit $code)" >&2' ERR
cd "$(dirname "$0")"
ROOT="$PWD"

# ── `dev.sh compose ...` — the DOCKER path, handled before anything else ──────────────────────────
# Intercepted here, ahead of the flag parser, for two reasons: the parser rejects unknown flags and would
# choke on `--profile stems up -d`, and none of the native-dev preflight below (uv sync, deno, ffmpeg codec
# probe) applies to a container build.
#
# It exists so `-f docker/compose.yaml` is written ONCE. Compose derives its project directory from the
# compose file's folder, so a bare `docker compose -f docker/compose.yaml` would resolve `../data` and
# `../media` against docker/ — correct — but every doc and muscle-memory command would need the path
# spelled out, and a forgotten `-f` silently acts on nothing.
#
# `--cuda` is sugar for adding the GPU override, since that is the real deploy target and the two-file
# invocation is the single most-mistyped command in the runbook. Without it the override is added when a GPU
# and Docker's nvidia runtime are both there (docs/deploy/README.md). ENCORE_TORCH_EXTRA=cu128 forces it too,
# and =cpu opts out. One line on every run says which worker image it is and why, so a CPU worker on a GPU box
# says what it missed.
if [ "${1:-}" = "compose" ]; then
	shift
	compose_files=(-f "$ROOT/docker/compose.yaml")
	gpu=cpu
	if [ "${1:-}" = "--cuda" ]; then
		shift
		gpu=cuda why="--cuda"
	else
		# Captured, not piped into `grep -q`: under pipefail an early-exiting grep fails the whole check.
		extra="${ENCORE_TORCH_EXTRA:-$(sed -n 's/^ENCORE_TORCH_EXTRA=\([a-z0-9]*\).*/\1/p' "$ROOT/docker/.env" 2>/dev/null | tail -n 1 || true)}"
		platform="$(uname -s)/$(uname -m)"
		if [ "$extra" = cpu ] || [ "$extra" = cu128 ]; then
			if [ "$extra" = cu128 ]; then gpu=cuda; fi
			why="ENCORE_TORCH_EXTRA=$extra"
		elif [ "$platform" != Linux/x86_64 ]; then
			why="no CUDA build for $platform"
		elif [[ "$(timeout 10 docker info --format '{{json .Runtimes}}' 2>/dev/null || true)" != *'"nvidia"'* ]]; then
			why="Docker has no nvidia runtime"
		elif ! timeout 10 nvidia-smi -L >/dev/null 2>&1; then
			why="nvidia-smi sees no GPU"
		else
			gpu=cuda why="an NVIDIA GPU and Docker's nvidia runtime"
		fi
	fi
	if [ "$gpu" = cuda ]; then compose_files+=(-f "$ROOT/docker/compose.cuda.yaml"); fi
	echo "dev.sh compose: $gpu worker image ($why; --cuda or ENCORE_TORCH_EXTRA=cu128 forces CUDA, =cpu opts out)" >&2
	# `--stems` is sugar for the worker's compose profile. Spelled here rather than left to the caller
	# because the two worker profiles must never run together: they advertise overlapping capabilities, so
	# the core would round-robin jobs between them and any comparison would measure whichever was idle.
	if [ "${1:-}" = "--stems" ]; then
		shift
		set -- --profile stems "$@"
	fi
	command -v docker >/dev/null 2>&1 || { echo "dev.sh compose: no docker on PATH" >&2; exit 127; }
	# NO --project-directory: it would override the default and send Compose looking for `.env` in the
	# repo root, where it no longer lives. Letting it default to docker/ is what makes `docker/.env` and
	# the `../data` defaults line up.
	exec docker compose "${compose_files[@]}" "$@"
fi

# .env is loaded FOR THE WORKER'S BENEFIT, and for core's: the worker has no dotenv dependency and is
# launched through a bare `env`, so it sees only what this script exports — and Bun does NOT walk up for
# a `.env`, it reads only its own cwd, which for core is core/. So neither half finds docker/.env by
# itself. Every ENCORE_* setting is inert under dev.sh without this, and ENCORE_WORKER_TOKEN is the sharp
# one: core starts returning 401 to role=worker upgrades the moment it sees a token the worker lacks,
# which stops all processing with nothing in the queue to explain why.
#
# It lives in docker/ because that is where Compose reads it from without a flag (the project directory
# is the compose file's folder). One file serves both run modes; ENCORE_ENV_FILE overrides for anything else.
#
# Precedence matches Bun: a variable already in the environment WINS over the file, so both halves can
# never disagree about a key. PARSED, NOT SOURCED — `set -a; . .env` would execute a value containing
# $(...) or a backtick.
ENV_FILE="${ENCORE_ENV_FILE:-$ROOT/docker/.env}"
ENV_REPORT="no .env — using defaults"
if [ -f "$ENV_FILE" ]; then
	env_set=() env_shadowed=()
	while IFS= read -r line || [ -n "$line" ]; do
		case "$line" in ''|'#'*) continue ;; esac
		line="${line#export }"
		key="${line%%=*}"
		[ "$key" != "$line" ] || continue            # no '=' → not an assignment
		val="${line#*=}"
		key="${key//[[:space:]]/}"
		case "$key" in ''|*[!A-Za-z0-9_]*) continue ;; esac   # skip anything not a shell name
		val="${val#"${val%%[![:space:]]*}"}"         # ltrim
		case "$val" in
			\"*\") val="${val#\"}"; val="${val%\"}" ;;
			\'*\') val="${val#\'}"; val="${val%\'}" ;;
			# Unquoted: drop a trailing ` # comment`, then rtrim. Quoted values keep '#' verbatim.
			*) val="${val%%[[:space:]]#*}"; val="${val%"${val##*[![:space:]]}"}" ;;
		esac
		if [ -n "${!key+x}" ]; then
			env_shadowed+=("$key")
		else
			export "$key=$val"
			env_set+=("$key")
		fi
	done < "$ENV_FILE"
	ENV_REPORT="${ENV_FILE#"$ROOT"/} — ${#env_set[@]} set${env_set[*]:+: ${env_set[*]}}"
	[ "${#env_shadowed[@]}" -gt 0 ] && ENV_REPORT="$ENV_REPORT; shadowed by shell: ${env_shadowed[*]}"
fi

# MEDIA_DIR and DATA_DIR are pinned ABSOLUTE because the app resolves their defaults relative to CWD:
# two processes started from different directories get different stores, and the worker then writes stems
# core cannot find. These three also OUTRANK .env — which is why the loader runs above, not below — since
# the container-correct values it ships (relative paths, `core` as compose DNS) are all wrong natively.
# The override is announced rather than silently dropped.
for v in MEDIA_DIR DATA_DIR ENCORE_CORE_URL; do
	case " ${env_set[*]:-} " in
		*" $v "*) echo "note: $v from ${ENV_FILE##*/} overridden — a native run needs absolute paths and localhost" ;;
	esac
done
# The TypeScript half is its own project now (its own package.json, node_modules and configs), mirroring
# worker/. Every bun invocation below runs in there; everything else stays rooted at the repo.
CORE="$ROOT/core"

export MEDIA_DIR="$ROOT/media"
export DATA_DIR="$ROOT/data"
# With no ENCORE_WORKER_TOKEN, core writes its token here (0600) on first boot and the worker reads it.
export ENCORE_WORKER_TOKEN_FILE="${ENCORE_WORKER_TOKEN_FILE:-$ROOT/auth/worker-token}"
# Read from the environment or .env, because server.ts does (`process.env.PORT ?? 3000`). Every check
# below uses it: hardcoding 3000 here while .env moved the listener costs a 45-second wait and then a
# "core did not become healthy" that names the wrong cause.
export PORT="${PORT:-3000}"
CORE_URL="http://localhost:$PORT"

DO_PULL=0 DO_RESET=0 DO_START=1 CORE_ONLY=0 UI_MODE=0 ASSUME_YES=0 NUKE_MODELS=0
for arg in "$@"; do
	case "$arg" in
		--pull) DO_PULL=1 ;;
		--reset) DO_RESET=1 ;;
		--fresh) DO_PULL=1; DO_RESET=1 ;;
		--core-only) CORE_ONLY=1 ;;
		--ui) UI_MODE=1 ;;
		--no-start) DO_START=0 ;;
		--yes|-y) ASSUME_YES=1 ;;
		--nuke-models) NUKE_MODELS=1 ;;
		# --help IS the header block, printed up to the first non-comment line, so it cannot drift.
		-h|--help) awk 'NR>1 { if (!/^#/) exit; sub(/^# ?/, ""); print }' "$0"; exit 0 ;;
		*) echo "unknown flag: $arg (try --help)" >&2; exit 2 ;;
	esac
done

if [ "$DO_RESET" != 1 ]; then
	[ "$NUKE_MODELS" = 1 ] && { echo "--nuke-models only applies with --reset; nothing to do." >&2; exit 2; }
	[ "$ASSUME_YES" = 1 ] && echo "note: --yes only skips the --reset confirmation; ignoring it." >&2
fi

say() { printf '\n=== %s ===\n' "$*"; }

need() {
	command -v "$1" >/dev/null 2>&1 || { echo "missing required tool: $1${2:+ — $2}" >&2; return 1; }
}

# ── ffmpeg, CHECKED BY CAPABILITY ────────────────────────────────────────────────────
# `command -v ffmpeg` is a presence check, and presence is NOT sufficiency. A DECODE-ONLY build is a real
# thing — a box was observed whose ffmpeg was decode-only: no encoding, and the loudness probe's
# volumedetect filter absent — and it passes any presence check, then fails at RUNTIME, where it
# reads as a broken worker rather than as a stripped codec set. What the code actually calls, read out of the
# code rather than assumed:
#
#   volumedetect (FILTER)  src/lib/server/media/loudness.ts and the worker's encode path and core both shell
#                          `-af volumedetect -f null -` and parse `mean_volume:`/`max_volume:` off stderr.
#                          Absent, parseVolumeDetect() returns null forever — and null is DELIBERATELY
#                          "unmeasurable, not silent", so nothing throws: every guiding track links
#                          unverified, a digitally silent stem publishes as though it were fine, and no
#                          screen anywhere says why.
#   join (FILTER)          worker adapters/encode.py guide_mix_argv folds both stems into ONE
#                          4-channel FLAC via `join=inputs=2:channel_layout=quad`. That single file is what
#                          stops the guiding track drifting against the instrumental.
#   amix (FILTER)          worker adapters/separate.py mix_minus_argv sums the MLX engine's
#                          non-vocal stems with `amix=inputs=N:normalize=0`.
#   flac (ENCODER)         every PUBLISHED stem and the guide mix (demucs.py encode_flac_argv and
#                          encode_guide_mix_argv, `-c:a flac`), plus core's own legacy-stem recompress in
#                          src/lib/server/media/retention.ts.
#   pcm_s16le (ENCODER)    demucs.py decode_argv writes the scratch WAV every separator consumes
#                          (`-c:a pcm_s16le`), as does mlx.py's summed instrumental.
#
# Split CORE vs WORKER because --core-only and --ui never separate anything, and the worker's extras would
# then be a fatal error about work that is not going to happen.
FFMPEG_FILTERS_CORE="volumedetect"
FFMPEG_ENCODERS_CORE="flac"
FFMPEG_FILTERS_WORKER="join amix"
FFMPEG_ENCODERS_WORKER="pcm_s16le"
# Each half takes its own override and defaults to a bare `ffmpeg` (core: FFMPEG_BIN, worker:
# ENCORE_FFMPEG_BIN — and .env is already loaded above, so either may be set by the time we get here).
# Probing PATH while the app runs some other binary would pass and then fail in exactly the way this check
# exists to prevent. ENCORE_FFMPEG_BIN wins when both are set: it is the encode path, which needs the larger set.
FFMPEG_BIN_PROBED="${ENCORE_FFMPEG_BIN:-${FFMPEG_BIN:-ffmpeg}}"
FFMPEG_REPORT=""

# The version field, exactly as the banner has always printed it. Never fails: `set -o pipefail` would
# otherwise make a binary that exits non-zero on `-version` abort the whole script from inside an assignment.
ffmpeg_version() {
	"$FFMPEG_BIN_PROBED" -version 2>/dev/null | head -1 | cut -d' ' -f3 || true
}

# Which of the wanted capabilities are MISSING, as `filter:x encoder:y` — empty output means complete.
# Names the gap rather than reporting "ffmpeg is broken", because the name is the whole fix.
# ONE process per listing (~120 ms for both), never a test transcode.
ffmpeg_gaps() {
	local filters encoders name gaps=""
	filters="$("$FFMPEG_BIN_PROBED" -hide_banner -filters 2>/dev/null)" || filters=""
	encoders="$("$FFMPEG_BIN_PROBED" -hide_banner -encoders 2>/dev/null)" || encoders=""
	# The NAME is column 2 of both listings, behind a flags column whose shape differs (`..`/`T.C` for a
	# filter, `A....D` for an encoder) — so match on POSITION, not on the flags. Unquoted $1/$2 on purpose:
	# these are space-separated lists.
	for name in $1; do
		grep -qE "^[[:space:]]*[^[:space:]]+[[:space:]]+$name([[:space:]]|\$)" <<<"$filters" || gaps="$gaps filter:$name"
	done
	for name in $2; do
		grep -qE "^[[:space:]]*[^[:space:]]+[[:space:]]+$name([[:space:]]|\$)" <<<"$encoders" || gaps="$gaps encoder:$name"
	done
	echo "${gaps# }"
}

# The command THIS box would use, never a guessed one: apt/dnf/pacman all spell it differently and a wrong
# line sends the user to a search engine. Empty when nothing recognisable is installed.
ffmpeg_install_cmd() {
	case "$(uname -s)" in
		Darwin) command -v brew >/dev/null 2>&1 && echo "brew install ffmpeg" ;;
		Linux)
			if command -v apt-get >/dev/null 2>&1; then echo "sudo apt-get update && sudo apt-get install -y ffmpeg"
			elif command -v dnf >/dev/null 2>&1; then echo "sudo dnf install -y ffmpeg"
			elif command -v pacman >/dev/null 2>&1; then echo "sudo pacman -S --needed ffmpeg"
			fi ;;
	esac
	return 0  # a missing brew is not an error here, it is an empty answer
}

# Offer the install, or print the command and give up. NEVER sudo: on Linux this only ever PRINTS, because a
# dev script that escalates privileges unasked is a worse surprise than a missing codec.
# $1/$2 are the wanted filter/encoder lists, re-probed after an install so "installed" cannot mean "fixed".
ffmpeg_install() {
	local cmd reply gaps named=FFMPEG_BIN
	cmd="$(ffmpeg_install_cmd)"
	[ -n "${ENCORE_FFMPEG_BIN:-}" ] && named=ENCORE_FFMPEG_BIN
	if [ "$FFMPEG_BIN_PROBED" != ffmpeg ]; then
		echo "  $named=$FFMPEG_BIN_PROBED is a binary you named, so installing a package would not change" >&2
		echo "  what it resolves to. Point it at a full build, or unset it to use PATH${cmd:+ and run: $cmd}." >&2
		return 1
	fi
	if [ -z "$cmd" ]; then
		echo "  no package manager this script knows (brew / apt-get / dnf / pacman) on $(uname -s). Install a" >&2
		echo "  full ffmpeg yourself, point FFMPEG_BIN at one, or ENCORE_SKIP_FFMPEG=1 to start without it." >&2
		return 1
	fi
	if [ "$(uname -s)" != Darwin ]; then
		echo "  install it with:  $cmd" >&2
		echo "  dev.sh will not run that for you — it needs sudo, and this script never escalates." >&2
		return 1
	fi
	# Consent, or nothing happens. Same shape as the --reset confirmation: prompt, `read -r reply`, compare
	# against a literal. --yes is honoured (that is what -y means) but SAYS SO, so an unprompted brew install
	# can never look like something dev.sh did on its own.
	if [ "$ASSUME_YES" = 1 ]; then
		echo "  running \`$cmd\` without a prompt because --yes was passed." >&2
	elif [ -t 0 ]; then
		printf '\nrun `%s` now? [y/N] ' "$cmd"
		read -r reply || reply=""
		[ "$reply" = "y" ] || { echo "  declined — nothing installed. Run it yourself:  $cmd" >&2; return 1; }
	else
		echo "  stdin is not a terminal, so there is nobody to ask. Run:  $cmd" >&2
		echo "  (or re-run with --yes to let dev.sh run it for you.)" >&2
		return 1
	fi
	brew install ffmpeg || { echo "  \`$cmd\` failed — its output is above." >&2; return 1; }
	hash -r 2>/dev/null || true  # a binary that did not exist a moment ago
	command -v "$FFMPEG_BIN_PROBED" >/dev/null 2>&1 || {
		echo "  \`$cmd\` reported success and there is STILL no ffmpeg on PATH — check its output above." >&2
		return 1
	}
	gaps="$(ffmpeg_gaps "$1" "$2")"
	[ -z "$gaps" ] || {
		echo "  installed, and this ffmpeg STILL cannot: $gaps — that is a stripped formula, not a missing one." >&2
		return 1
	}
	FFMPEG_REPORT="$(ffmpeg_version) (installed just now)"
	return 0
}

ensure_ffmpeg() {
	local want_f="$FFMPEG_FILTERS_CORE" want_e="$FFMPEG_ENCODERS_CORE" gaps version
	# Gated exactly like the uv sync and the deno fetch below — --core-only / --ui run no worker, so the
	# separation codecs are not their problem. The CORE set is NOT gated, and deliberately so: vite serves the
	# same +page.server.ts/+server.ts handlers server.ts does, they all call getApp(), and getApp()'s boot
	# chain runs the volumedetect probe over every linked stem and recompresses legacy ones with the flac
	# encoder. --ui therefore needs both, and two listings cost ~120 ms, so nothing here makes --ui slower.
	if [ "$CORE_ONLY" != 1 ] && [ "$UI_MODE" != 1 ]; then
		want_f="$want_f $FFMPEG_FILTERS_WORKER"
		want_e="$want_e $FFMPEG_ENCODERS_WORKER"
	fi

	# The escape hatch, same shape as ENCORE_SKIP_DENO: it does not pretend the capability is there, it says
	# what breaks and gets out of the way.
	if [ "${ENCORE_SKIP_FFMPEG:-0}" = 1 ]; then
		FFMPEG_REPORT="NOT CHECKED (ENCORE_SKIP_FFMPEG=1)"
		echo "WARNING: ENCORE_SKIP_FFMPEG=1 — no stem will encode, and every loudness reading becomes" >&2
		echo "         'unmeasurable', which PUBLISHES a silent stem instead of refusing it." >&2
		return 0
	fi

	if command -v "$FFMPEG_BIN_PROBED" >/dev/null 2>&1; then
		version="$(ffmpeg_version)"
		gaps="$(ffmpeg_gaps "$want_f" "$want_e")"
		if [ -z "$gaps" ]; then
			FFMPEG_REPORT="$version (filters: $want_f; encoders: $want_e)"
			return 0
		fi
		# Name the BINARY, not just "ffmpeg": with an override set, "the one on PATH" is the wrong file to go
		# looking at, and that misdirection is most of the cost of this failure.
		echo "ffmpeg ${version:-?} at $(command -v "$FFMPEG_BIN_PROBED") CANNOT DO THE JOB — missing: $gaps" >&2
		echo "  a decode-only build passes a presence check and then fails mid-cook, or worse: with no" >&2
		echo "  volumedetect, loudness is silently 'unmeasurable' forever and silent stems publish clean." >&2
	else
		echo "missing required tool: $FFMPEG_BIN_PROBED — the worker transcodes every stem" >&2
	fi
	ffmpeg_install "$want_f" "$want_e"
}

# ── preflight ────────────────────────────────────────────────────────────────────────
say "preflight"
need bun "install from https://bun.sh" || exit 1
ensure_ffmpeg || exit 1
# The health probe IS curl: without it the probe can never succeed and the script blames core, reporting
# "core did not become healthy" after 45 seconds of waiting for a request it never made.
need curl "install curl — the startup health probe uses it" || exit 1
# lsof is how `port_owner` works. Missing, it returns empty, so the refusal-to-start-twice silently stops
# refusing and two cores race on one SQLite file. A warning rather than fatal, because a slim container
# may legitimately lack it — but the lost protection is named rather than discovered later.
if ! command -v lsof >/dev/null 2>&1; then
	echo "WARNING: no lsof — the port check is DISABLED, so nothing will stop a second core starting on"
	echo "         port $PORT over the first. Stop any previous run yourself."
fi
# Solving YouTube's player challenge takes TWO things, and missing either kills every download with
# "Requested format is not available" — which reads as a broken worker. The image has both baked in; a
# native run has neither, so dev.sh supplies the config and checks for the runtime.
#   1. deno on PATH. The image installs deno specifically, so that is what this checks for.
#   2. `--remote-components ejs:github`, which lives in docker/yt-dlp.conf. The image copies that to
#      /etc/yt-dlp.conf; natively we point the worker's XDG_CONFIG_HOME at a copy instead.
YTDLP_CONFIG_HOME="$ROOT/worker/.dev-ytdlp"
TOOLS_DIR="$ROOT/worker/.dev-tools/bin"
DENO_DIR="$TOOLS_DIR"
# The SAME version docker/worker.Dockerfile installs, read out of the Dockerfile so a bump there cannot
# leave a dev box on a different deno than prod.
#
# CHECKED, not just read: a wrong path or a renamed ARG makes sed print nothing and succeed, and the empty
# result would be interpolated into a download URL that 404s much later — inverting the guarantee this line
# exists for. It is the one place in this script that depends on another file's internal text.
WORKER_DOCKERFILE="$ROOT/docker/worker.Dockerfile"
DENO_VERSION="$(sed -n 's/^ARG DENO_VERSION=\(.*\)$/\1/p' "$WORKER_DOCKERFILE")"
[ -n "$DENO_VERSION" ] || {
	echo "dev.sh: no 'ARG DENO_VERSION=' found in $WORKER_DOCKERFILE" >&2
	echo "  the dev deno version is pinned FROM that file so dev and prod cannot drift apart." >&2
	echo "  if the Dockerfile moved or the ARG was renamed, fix this line rather than hardcoding a version." >&2
	exit 1
}

# Fetched PROJECT-LOCAL, never system-wide: no brew, no sudo, nothing outside the repo, and a system deno
# always wins if there is one. The zip is checksum-verified BEFORE it is made executable, because this
# downloads a binary and then runs it.
#
# `uname -m` is NOT deno's target name on a Mac — it reports `arm64` where deno ships `aarch64`. The
# Dockerfile interpolates uname directly because a Linux container reports `aarch64`/`x86_64` verbatim;
# copying that line here would 404 on Apple Silicon.
deno_target() {
	local os arch
	case "$(uname -s)" in
		Darwin) os="apple-darwin" ;;
		Linux) os="unknown-linux-gnu" ;;
		*) return 1 ;;
	esac
	case "$(uname -m)" in
		arm64 | aarch64) arch="aarch64" ;;
		x86_64 | amd64) arch="x86_64" ;;
		*) return 1 ;;
	esac
	echo "${arch}-${os}"
}

ensure_deno() {
	if command -v deno >/dev/null 2>&1; then
		echo "deno    $(deno --version 2>/dev/null | head -1 | cut -d' ' -f2) (system)"
		return 0
	fi
	if [ -x "$DENO_DIR/deno" ] && "$DENO_DIR/deno" --version 2>/dev/null | grep -q "deno $DENO_VERSION"; then
		echo "deno    $DENO_VERSION (repo-local)"
		return 0
	fi
	if [ "${ENCORE_SKIP_DENO:-0}" = 1 ]; then
		echo "WARNING: no deno, and ENCORE_SKIP_DENO=1 — every YouTube download will fail." >&2
		return 0
	fi
	local target
	target="$(deno_target)" || {
		echo "WARNING: no deno, and this platform ($(uname -s)/$(uname -m)) has no deno release to fetch." >&2
		return 0
	}
	say "fetching deno $DENO_VERSION for $target (~40 MB, into worker/.dev-ytdlp/bin)"
	"${PY:-python3}" - "$DENO_VERSION" "$target" "$DENO_DIR" <<'PYEOF' || {
import hashlib, io, os, stat, sys, urllib.request, zipfile

version, target, dest = sys.argv[1], sys.argv[2], sys.argv[3]
base = f"https://github.com/denoland/deno/releases/download/v{version}/deno-{target}.zip"
blob = urllib.request.urlopen(base, timeout=300).read()
want = urllib.request.urlopen(base + ".sha256sum", timeout=60).read().decode().split()[0]
got = hashlib.sha256(blob).hexdigest()
if got != want:
    sys.exit(f"deno checksum mismatch: expected {want}, got {got} — refusing to install")
os.makedirs(dest, exist_ok=True)
zipfile.ZipFile(io.BytesIO(blob)).extract("deno", dest)
path = os.path.join(dest, "deno")
os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
PYEOF
		echo "WARNING: could not fetch deno — every YouTube download will fail with 'Requested format is" >&2
		echo "         not available'. Install it yourself (brew install deno) or set ENCORE_SKIP_DENO=1." >&2
		return 0
	}
	echo "deno    $("$DENO_DIR/deno" --version | head -1 | cut -d' ' -f2) (repo-local, checksum-verified)"
}
echo "bun     $(bun --version)"
echo "ffmpeg  $FFMPEG_REPORT"
echo "media   $MEDIA_DIR"
echo "data    $DATA_DIR"
echo "env     $ENV_REPORT"

# Refuse to start alongside a previous run rather than killing something we did not start: a leftover
# worker reconnects every 3s and two workers cooking the same media race on the same paths. Both checks
# run only when we are about to START — refusing a --reset because something holds :3000 would block the
# one command that gets you unstuck.

# `-sTCP:LISTEN` is essential: a bare `lsof -ti:3000` also matches CLIENTS, so a browser tab left open on
# the TV view reports as "port in use" and refuses a perfectly fine start.
port_owner() { lsof -ti:"$PORT" -sTCP:LISTEN 2>/dev/null || true; }

preflight_free() {
	local stale owner
	stale="$(pgrep -f 'encore_worker|bun run \./server\.ts' 2>/dev/null || true)"
	if [ -n "$stale" ]; then
		echo
		echo "refusing to start — an earlier core/worker is still running:" >&2
		pgrep -fl 'encore_worker|bun run \./server\.ts' >&2
		echo >&2
		echo "stop it first:  pkill -f 'encore_worker'; pkill -f 'bun run ./server.ts'" >&2
		return 1
	fi
	owner="$(port_owner)"
	if [ -n "$owner" ]; then
		echo
		echo "refusing to start — something is LISTENING on port $PORT:" >&2
		ps -o pid,command -p "$(echo "$owner" | tr '\n' ',' | sed 's/,$//')" >&2 || true
		return 1
	fi
	return 0
}

# ── pull ─────────────────────────────────────────────────────────────────────────────
if [ "$DO_PULL" = 1 ]; then
	say "pulling"
	need git "install git — --pull needs it" || exit 1
	if [ -n "$(git status --porcelain)" ]; then
		echo "working tree is dirty — commit or stash first, refusing to pull over local changes:" >&2
		git status --short >&2
		exit 1
	fi
	env -u GIT_SSH_COMMAND git pull --ff-only
	git log -1 --format='now at %h %s'
fi

# ── reset ────────────────────────────────────────────────────────────────────────────
if [ "$DO_RESET" = 1 ]; then
	say "reset — DESTRUCTIVE"
		# Untracked local state only, so this cannot destroy source — but audio/ holds originals that need
		# the network to refetch and derived/ holds stems that cost real GPU time.
	TARGETS=(
		"$ROOT/media"      # audio + derived + meta + job scratch — the whole library
		"$ROOT/data"       # sqlite + WAL + shm
		"$ROOT/temp"       # an abandoned store from an older layout; nothing reads it
		"$CORE/.svelte-kit" "$CORE/build"
		"$ROOT/worker/.pytest_cache" "$ROOT/worker/.mypy_cache" "$ROOT/worker/.ruff_cache"
		"$YTDLP_CONFIG_HOME/yt-dlp"   # the generated config; the deno beside it is a tool, not state
	)
	if [ "$NUKE_MODELS" = 1 ]; then
			# Demucs checkpoints plus whisper/wav2vec2 weights. Multi-GB, slow to refetch, and never the
			# cause of a stale-state bug — hence opt-in.
		TARGETS+=("$HOME/.cache/torch" "$HOME/.cache/huggingface")
	fi

	echo "will delete:"
	for t in "${TARGETS[@]}"; do
		[ -e "$t" ] && printf '  %-52s %s\n' "${t#"$ROOT"/}" "$(du -sh "$t" 2>/dev/null | cut -f1)"
	done
	echo "  (plus every __pycache__ under worker/)"

	if [ "$ASSUME_YES" != 1 ]; then
		printf '\nthis cannot be undone. type RESET to continue: '
		read -r reply
		[ "$reply" = "RESET" ] || { echo "aborted."; exit 1; }
	fi

	for t in "${TARGETS[@]}"; do rm -rf "$t"; done
	find "$ROOT/worker" -name '__pycache__' -type d -not -path '*/.venv/*' -exec rm -rf {} + 2>/dev/null || true
	echo "reset done — next boot recreates the dirs and applies drizzle/0000_baseline.sql from empty."
fi

# ── deps ─────────────────────────────────────────────────────────────────────────────
if [ "$DO_PULL" = 1 ] || [ ! -d "$CORE/node_modules" ]; then
	say "js deps"
	(cd "$CORE" && bun install)
fi

# ── the worker's Python environment ──────────────────────────────────────────────────
# ONE COMMAND, because the new worker ships a LOCKFILE. Everything that used to live here — pick_python,
# a hand-rolled uv fetch, a requirements/constraints sha stamp, a websockets canary, a karaoke-lyrics-processor
# --no-deps pin — existed because `requirements.txt` pinned 16 direct deps that resolved to ~128 packages
# whose versions were whatever the day of your install decided. `uv sync --frozen` reads
# worker/uv.lock, so the dev box and docker/worker.Dockerfile resolve the identical wheels, and uv
# supplies its own 3.12 on a box whose python3 is older.
#
# `--frozen` FAILS rather than re-resolving when the lock disagrees with pyproject.toml, which is the whole
# point of committing one: a silent re-resolve is how a dev box ends up testing versions nobody pinned.
WORKER_DIR="$ROOT/worker"
VENV="$WORKER_DIR/.venv"

# The extras a dev box needs. `ffmpeg` bundles a static FFmpeg 7.x so publication does not depend on what
# Homebrew installed; `audiosep` is the ~135-model zoo; `mlx` is marker-gated and installs nothing off
# Apple Silicon; `romanize` + `nonlatin` are the non-Latin lane's 49 MB, in the DEFAULT install since W10 so
# a CJK sheet is readable and routable in a room rather than only in a test (docs/arch/04-alignment.md
# §9.2, §11.2). They stay EXTRAS, so `uv sync --only-group dev` still installs neither.
#
# The torch wheels: ENCORE_TORCH_EXTRA wins (`cpu` or `cu128`, the same name the Docker build arg takes).
# Unset, CUDA wheels on Linux x86_64 when `nvidia-smi -L` sees a GPU, else CPU. CPU wheels on an NVIDIA box
# run every song at CPU speed with only `accelerator=cpu` in the worker log to say so. Linux aarch64 with
# NVIDIA (GH200, DGX Spark) stays CPU by choice: the lock carries cu128 wheels for x86_64 only. The timeout
# is for a wedged driver, which can hang `nvidia-smi` for minutes.
torch_extra() {
	if [ -n "${ENCORE_TORCH_EXTRA:-}" ]; then
		case "$ENCORE_TORCH_EXTRA" in
		cpu | cu128) echo "$ENCORE_TORCH_EXTRA" ;;
		*) echo "ENCORE_TORCH_EXTRA=$ENCORE_TORCH_EXTRA: expected cpu or cu128" >&2 && return 1 ;;
		esac
	elif [ "$(uname -s)/$(uname -m)" = Linux/x86_64 ] && timeout 10 nvidia-smi -L >/dev/null 2>&1; then
		echo cu128
	else
		echo cpu
	fi
}

# Inside the worker gate: --core-only and --ui run no worker, so they probe no GPU and read no torch extra.
if [ "$CORE_ONLY" != 1 ] && [ "$UI_MODE" != 1 ]; then
	TORCH_EXTRA="$(torch_extra)"
	WORKER_EXTRAS="--extra ml --extra text --extra ffmpeg --extra audiosep --extra mlx --extra $TORCH_EXTRA"
	WORKER_EXTRAS="$WORKER_EXTRAS --extra romanize --extra nonlatin"
	if ! command -v uv >/dev/null 2>&1; then
		echo "dev.sh: uv is required to run the worker (it reads worker/uv.lock)." >&2
		echo "  brew install uv        # or: curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
		echo "  # core alone needs none of this: bash dev.sh --core-only" >&2
		exit 1
	fi
	say "syncing worker deps from worker/uv.lock with $TORCH_EXTRA torch (multi-GB on a cold cache; ENCORE_TORCH_EXTRA)"
	# shellcheck disable=SC2086 # WORKER_EXTRAS is a deliberate word list
	(cd "$WORKER_DIR" && uv sync --frozen $WORKER_EXTRAS)
fi

# The worker's own yt-dlp config, mirroring what docker/worker.Dockerfile puts at /etc/yt-dlp.conf. Rewritten
# every run so an edit to docker/yt-dlp.conf lands without a --reset.
if [ "$CORE_ONLY" != 1 ] && [ "$UI_MODE" != 1 ]; then
	mkdir -p "$YTDLP_CONFIG_HOME/yt-dlp"
	cp "$ROOT/docker/yt-dlp.conf" "$YTDLP_CONFIG_HOME/yt-dlp/config"
	ensure_deno
fi

# ── build ────────────────────────────────────────────────────────────────────────────
# server.ts serves the BUILT SvelteKit output, so a stale build/ shows yesterday's UI while the source on
# disk says otherwise — which reads as "my change did nothing" rather than as a missing build. `--help` has
# always promised "build first if needed"; needed means CURRENT, not merely present.
build_stale() {
	[ -f "$CORE/build/index.js" ] || return 0
	[ -n "$(find "$CORE/src" "$CORE/server.ts" -type f -newer "$CORE/build/index.js" -print -quit 2>/dev/null)" ]
}
if [ "$UI_MODE" != 1 ] && { [ "$DO_PULL" = 1 ] || [ "$DO_RESET" = 1 ] || build_stale; }; then
	say "building core"
	(cd "$CORE" && bun run build)
fi

[ "$DO_START" = 1 ] || { say "done (--no-start)"; exit 0; }

# Checked here rather than in preflight: --pull / --reset need no port, and blocking them on a port
# conflict blocks the command that unsticks you.
[ "$UI_MODE" = 1 ] || preflight_free || exit 1

# ── run ──────────────────────────────────────────────────────────────────────────────
CORE_PID="" WORKER_PID=""

# Stop one job and everything it spawned, then verify it is gone. `kill -- -PID` signals the process
# GROUP, which matters because a cook shells out to demucs/yt-dlp and core runs a nested bun —
# signalling only the leader reparents those to init and a stranded demucs keeps a GPU busy. TERM
# first (the worker installs no handlers and exits cleanly on it), KILL only if it refuses.
stop_tree() {
	local pid="$1" name="$2" i
	[ -n "$pid" ] || return 0
	kill -0 "$pid" 2>/dev/null || return 0
	kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
	for i in $(seq 1 20); do
		kill -0 "$pid" 2>/dev/null || return 0
		sleep 0.25
	done
	echo "  $name ignored TERM — sending KILL"
	kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
}

cleanup() {
	trap - EXIT INT TERM HUP
	set +m  # stop bash announcing "Terminated: 15" for each job as we take it down
	printf '\nstopping...\n'
	stop_tree "$WORKER_PID" worker
	stop_tree "$CORE_PID" core
	wait 2>/dev/null || true

	# Prove it: a silent "stopped." that left a worker reconnecting every 3s means the next run fights an
	# invisible second worker. Checked by PID and PORT, never `pgrep -f`, because a pattern broad enough
	# to catch the worker also matches this script's own forks and reports a phantom straggler.
	local left="" i
	for i in $(seq 1 12); do
		left=""
		[ -n "$WORKER_PID" ] && kill -0 "$WORKER_PID" 2>/dev/null && left="$left worker($WORKER_PID)"
		[ -n "$CORE_PID" ] && kill -0 "$CORE_PID" 2>/dev/null && left="$left core($CORE_PID)"
		[ -n "$(port_owner)" ] && left="$left port-$PORT-still-listening"
		[ -z "$left" ] && break
		sleep 0.25
	done
	if [ -n "$left" ]; then
		echo "WARNING: still running after cleanup —$left"
		echo "  kill with: pkill -f 'encore_worker'; pkill -f 'bun run ./server.ts'"
	else
		echo "stopped — core and worker both gone, port $PORT released."
	fi
}
# EXIT runs cleanup and nothing more; a SIGNAL runs it and then leaves, with the conventional 128+n status.
# Being explicit matters now that the script ends in a poll loop rather than `wait`: bash runs a trap and then
# RESUMES the interrupted command, so a signal handler that only tidies up would hand control back to the
# loop and carry on supervising children it had just killed. `cleanup` disarms every trap first, so EXIT
# cannot run it twice.
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM
trap 'cleanup; exit 129' HUP

if [ "$UI_MODE" = 1 ]; then
	say "vite dev — UI HMR ONLY, no WebSocket hub (queue will not move, songs will not cook)"
	cd "$CORE" && exec bun run dev
fi

say "starting core"
(cd "$CORE" && bun run start) & CORE_PID=$!

# Wait for health first: the worker retries every 3s anyway, but a clean first connect reads better.
for _ in $(seq 1 45); do
	curl -fsS -m 2 "$CORE_URL/health" >/dev/null 2>&1 && break
	kill -0 "$CORE_PID" 2>/dev/null || { echo "core exited during startup" >&2; exit 1; }
	sleep 1
done
curl -fsS -m 2 "$CORE_URL/health" || { echo "core did not become healthy" >&2; exit 1; }
echo

if [ "$CORE_ONLY" != 1 ]; then
	say "starting worker"
		# PATH must carry the venv bin: the worker shells out to demucs / yt-dlp BY NAME and host/hardware.py
		# proves a capability with shutil.which(), so an importable-but-not-on-PATH tool reports differently.
		# `exec` is load-bearing — it replaces the subshell with python, so $! is python's own pid; without
		# it cleanup kills a shell that has already forked and the worker survives.
	(
		cd "$WORKER_DIR"
		# `ENCORE_CORE_URL`, not `ENCORE_CORE_WS`: the new worker reads the full ws URL from one variable.
		# No `token=` here: the worker appends ENCORE_WORKER_TOKEN (from .env) or reads ENCORE_WORKER_TOKEN_FILE.
		# `ENCORE_DBOS_DB` is per-box durable state and must NOT sit under MEDIA_DIR, where a retention
		# sweep would be free to evict the checkpoints a resumed job replays from.
		exec env \
			PATH="$VENV/bin:$DENO_DIR:$PATH" \
			ENCORE_CORE_URL="ws://localhost:$PORT/ws?role=worker" \
			XDG_CONFIG_HOME="$YTDLP_CONFIG_HOME" \
			ENCORE_MEDIA_DIR="$MEDIA_DIR" \
			MEDIA_DIR="$MEDIA_DIR" \
			ENCORE_DBOS_DB="$DATA_DIR/worker.sqlite" \
			"$VENV/bin/python" -m encore_worker
	) & WORKER_PID=$!
fi

say "up"
# Phones cannot use localhost. en0 is Wi-Fi on a Mac; fall back to en1, then hostname -I on Linux.
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"
echo "  core     $CORE_URL"
echo "  tv       $CORE_URL/tv        (open on the television)"
if [ -n "$LAN_IP" ]; then
	echo "  phones   http://$LAN_IP:$PORT        (the TV's QR encodes this)"
else
	echo "  phones   could not resolve a LAN IP — the TV will say so on screen rather than show a dead QR"
fi
echo "  ctrl-c to stop both"

# Bare `wait` blocks until everything exits, which cannot distinguish a healthy run from one whose worker
# died half an hour ago. Both deaths are invisible from the outside: a dead worker leaves every Karaoke
# request sitting at `queued` with nothing on screen to explain it (the README calls that the most common
# first-run surprise), and a dead core leaves the worker reconnecting to nothing every 3s. So poll, and say
# which one went. Exiting runs the cleanup trap, which takes the survivor down with it.
while :; do
	sleep 2
	if [ -n "$CORE_PID" ] && ! kill -0 "$CORE_PID" 2>/dev/null; then
		echo >&2
		echo "core exited on its own (pid $CORE_PID). Its output is above; the worker is being stopped too." >&2
		exit 1
	fi
	if [ -n "$WORKER_PID" ] && ! kill -0 "$WORKER_PID" 2>/dev/null; then
		echo >&2
		echo "the WORKER exited on its own (pid $WORKER_PID). Core is still healthy, which is why this needs" >&2
		echo "saying: nothing will cook from here, and every request would sit at 'queued' forever with no" >&2
		echo "error on any screen. Its output is above — a torch/demucs import failure prints there." >&2
		exit 1
	fi
done
