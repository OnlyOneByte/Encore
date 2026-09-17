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
# WHY --ui IS SEPARATE. `bun run dev` (vite) serves the UI with HMR but NOT the WebSocket hub —
# server.ts owns both in one process, and vite only runs the SvelteKit half. A song will never cook
# and the queue will never move under --ui. Use it for pure styling work, nothing else.
set -eo pipefail
# Job control ON in a non-interactive script, deliberately: it makes every `&` job a process-group
# LEADER, which is what lets cleanup below signal a whole tree instead of just the parent. Without it
# the worker's demucs/yt-dlp children and core's nested `bun run ./server.ts` outlive ctrl-c.
set -m
cd "$(dirname "$0")"
ROOT="$PWD"

# ── .env ─────────────────────────────────────────────────────────────────────────────
# FOR THE WORKER'S BENEFIT, not core's. Core is `bun run ./server.ts` and Bun reads .env by itself, so
# it has always seen this file. The worker is `python -m src.dial_home` with NO dotenv dependency
# (deliberately — the container gets its env from compose), and dev.sh launches it via a bare `env`,
# which passes on only what this script exported. So every worker-side setting in .env.example was
# silently inert under dev.sh: ENCORE_STEM_FORMAT, ENCORE_DEMUCS_MODEL, ENCORE_WORKER_CONCURRENCY,
# ENCORE_PROCESSOR, ENCORE_WHISPERX_DEVICE, ENCORE_WORKER_CAPABILITIES (all read by config.py's
# from_env) landed on core, which does not read them, and never reached the process that does.
#
# ENCORE_WORKER_TOKEN is the sharp one. Core gates role=worker upgrades the moment it sees a token and
# returns 401 otherwise (config.py:197) — so a token set here reached core, the worker connected without
# one, and ALL processing stopped with nothing in the queue to explain why. Exporting the file fixes
# that class of split-brain outright: both processes now read one source.
#
# PRECEDENCE MATCHES BUN: a variable already in the environment WINS over the file, so `FOO=x bash
# dev.sh` overrides for both halves and core/worker cannot end up disagreeing about the same key.
# Parsed, not sourced: `set -a; . .env` would execute a value containing $(...) or a backtick.
ENV_FILE="${ENCORE_ENV_FILE:-$ROOT/.env}"
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
	ENV_REPORT="${ENV_FILE#$ROOT/} — ${#env_set[@]} set${env_set[*]:+: ${env_set[*]}}"
	[ "${#env_shadowed[@]}" -gt 0 ] && ENV_REPORT="$ENV_REPORT; shadowed by shell: ${env_shadowed[*]}"
fi

# ── paths pinned ABSOLUTE, deliberately ──────────────────────────────────────────────
# The app resolves MEDIA_DIR ?? './media' and DATA_DIR ?? './data' relative to CWD (paths.ts:27,
# db/index.ts:29). Two processes started from different directories therefore get DIFFERENT stores,
# which is how a stray ./media appears beside the real one and the worker writes stems
# the core cannot find. Pinning both here means core and worker cannot disagree.
#
# THESE THREE OUTRANK .env, which is why the loader runs above rather than below. .env.example ships
# MEDIA_DIR=./media, DATA_DIR=./data and ENCORE_CORE_WS=ws://core:3000 — all correct INSIDE the
# container (relative to /app, and `core` is compose DNS), all wrong for a native run, where a relative
# path is resolved per-process and `core` resolves to nothing. Announced rather than silently dropped,
# since a setting that appears to be read but is not is the whole bug class this section exists for.
for v in MEDIA_DIR DATA_DIR ENCORE_CORE_WS; do
	case " ${env_set[*]:-} " in
		*" $v "*) echo "note: $v from ${ENV_FILE##*/} overridden — a native run needs absolute paths and localhost" ;;
	esac
done
export MEDIA_DIR="$ROOT/media"
export DATA_DIR="$ROOT/data"
CORE_URL="http://localhost:3000"

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
		# Print the header block and stop at the first non-comment line, so the help text cannot
		# drift out of sync with a hardcoded line range.
		-h|--help) awk 'NR>1 { if (!/^#/) exit; sub(/^# ?/, ""); print }' "$0"; exit 0 ;;
		*) echo "unknown flag: $arg (try --help)" >&2; exit 2 ;;
	esac
done

say() { printf '\n=== %s ===\n' "$*"; }

need() {
	command -v "$1" >/dev/null 2>&1 || { echo "missing required tool: $1${2:+ — $2}" >&2; return 1; }
}

# ── preflight ────────────────────────────────────────────────────────────────────────
say "preflight"
need bun "install from https://bun.sh" || exit 1
need ffmpeg "brew install ffmpeg — the worker transcodes every stem" || exit 1
# deno/node/bun is what yt-dlp's JS challenge solver needs; without one, YouTube resolves NO
# audio-only format and every cook dies at download. Warn rather than fail: --core-only is still fine.
if ! command -v deno >/dev/null && ! command -v node >/dev/null; then
	echo "WARNING: no deno or node on PATH — yt-dlp cannot solve YouTube's JS challenge, so downloads will fail."
fi
echo "bun     $(bun --version)"
echo "ffmpeg  $(ffmpeg -version 2>/dev/null | head -1 | cut -d' ' -f3)"
echo "media   $MEDIA_DIR"
echo "data    $DATA_DIR"
echo "env     $ENV_REPORT"

# Refuse to start alongside a previous run. A leftover worker is not harmless: it reconnects every 3s,
# the core hands it jobs, and two workers cooking the same media race each other on the same paths.
# Refusing (rather than killing something we did not start) keeps this script from being a surprise.
#
# NOTE both checks run only when we are actually going to START something — see below. Cleaning or
# pulling does not need the port, and refusing to --reset because something holds :3000 just blocks
# the one command that would have got you unstuck.

# Who is LISTENING on the core port. `-sTCP:LISTEN` is essential: a bare `lsof -ti:3000` also matches
# CLIENTS connected to it, so a browser tab left open on the TV view reports as "port in use" and
# refuses a perfectly fine start. (It reported Firefox, holding an ESTABLISHED connection from an
# earlier run — never a listener.)
port_owner() { lsof -ti:3000 -sTCP:LISTEN 2>/dev/null || true; }

preflight_free() {
	local stale owner
	stale="$(pgrep -f 'src\.dial_home|bun run \./server\.ts' 2>/dev/null || true)"
	if [ -n "$stale" ]; then
		echo
		echo "refusing to start — an earlier core/worker is still running:" >&2
		pgrep -fl 'src\.dial_home|bun run \./server\.ts' >&2
		echo >&2
		echo "stop it first:  pkill -f 'src.dial_home'; pkill -f 'bun run ./server.ts'" >&2
		return 1
	fi
	owner="$(port_owner)"
	if [ -n "$owner" ]; then
		echo
		echo "refusing to start — something is LISTENING on port 3000:" >&2
		ps -o pid,command -p "$(echo "$owner" | tr '\n' ',' | sed 's/,$//')" >&2 || true
		return 1
	fi
	return 0
}

# ── pull ─────────────────────────────────────────────────────────────────────────────
if [ "$DO_PULL" = 1 ]; then
	say "pulling"
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
	# Everything listed is UNTRACKED local state. Nothing here is in git, so this can never destroy
	# source. It CAN destroy hours of downloading and cooking: audio/ holds raw originals that are not
	# regenerable without the network, and derived/ holds stems that cost real GPU/CPU time.
	TARGETS=(
		"$ROOT/media"      # audio + derived + meta + job scratch — the whole library
		"$ROOT/data"       # sqlite + WAL + shm
		"$ROOT/media" "$ROOT/data"   # strays from a process started at the repo root
		"$ROOT/.svelte-kit" "$ROOT/build"
		"$ROOT/worker/.pytest_cache"
	)
	if [ "$NUKE_MODELS" = 1 ]; then
		# Demucs checkpoints (torch hub) + whisper/wav2vec2 weights (HF). Multi-GB and slow to refetch,
		# which is why they are opt-in: they are never the cause of a stale-state bug.
		TARGETS+=("$HOME/.cache/torch" "$HOME/.cache/huggingface")
	fi

	echo "will delete:"
	for t in "${TARGETS[@]}"; do
		[ -e "$t" ] && printf '  %-52s %s\n' "${t#$ROOT/}" "$(du -sh "$t" 2>/dev/null | cut -f1)"
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
if [ "$DO_PULL" = 1 ] || [ ! -d "$ROOT/node_modules" ]; then
	say "js deps"
	bun install
fi

VENV="$ROOT/worker/.venv"
REQS="$ROOT/worker/requirements.txt"
# Not in requirements.txt on purpose — the image installs it --no-deps because its own dependency
# list is 30 packages of .doc/.rtf readers we never call. Same treatment here.
KLP_PIN="karaoke-lyrics-processor==0.6.0"
# The venv is "ready" only when this file says so, and it is written LAST — see install_worker_deps.
STAMP="$VENV/.encore-deps"

# The interpreter MUST be >= 3.11, and it is deliberately NOT bare `python3`.
#
# scipy 1.16.2 sets that floor — it declares Requires-Python >=3.11, so on a 3.10 interpreter pip
# resolves NO distribution for it and aborts the ENTIRE install, including websockets, which sits on
# line 11 of requirements.txt and had already resolved. That is not theoretical: a shell exporting
# PYENV_VERSION=3.10.13 makes `python3` a 3.10 shim, and the abort then surfaced three steps downstream
# as the worker dying on "ModuleNotFoundError: No module named 'websockets'" — which reads like a missing
# pin rather than a venv that was never populated.
# 3.12 is tried FIRST because that is what the image ships (worker/Dockerfile: python:3.12-slim-bookworm),
# so a dev venv resolves the same wheels prod does. 3.14 is deliberately NOT a candidate: torch 2.8
# publishes no cp314 wheel and audio-separator excludes 3.14.1 outright, so preferring it would trade
# this clear failure for an opaque one. Override with ENCORE_WORKER_PYTHON=/path/to/python.
pick_python() {
	local cand
	for cand in "${ENCORE_WORKER_PYTHON:-}" python3.12 python3.13 python3.11 python3; do
		[ -n "$cand" ] || continue
		command -v "$cand" >/dev/null 2>&1 || continue
		# Let python do the version comparison — a shell glob over "3.10" vs "3.9" gets it wrong.
		"$cand" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null || continue
		echo "$cand"
		return 0
	done
	return 1
}

# Two granularities, on purpose. py_tag is for HUMANS (log lines); py_abi is what the stamp compares.
# The stamp must NOT carry the patch level: every wheel in requirements.txt is tagged by minor (cp312),
# so 3.12.12 → 3.12.14 changes nothing about what is installable — but a full x.y.z in the stamp turns
# an incidental `brew upgrade python@3.12` into a spurious multi-GB reinstall of the whole torch set.
py_tag() { "$1" -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])' 2>/dev/null || echo unknown; }
py_abi() { "$1" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || echo unknown; }

sha_of() {
	if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
	else sha256sum "$1" | cut -d' ' -f1; fi
}

install_worker_deps() {
	# Drop any previous stamp FIRST: if this install dies halfway, the next run must see an unready
	# venv and retry, not trust a stamp describing a state that no longer exists.
	rm -f "$STAMP"
	"$VENV/bin/pip" install --quiet --upgrade pip
	"$VENV/bin/pip" install -r "$REQS"
	"$VENV/bin/pip" install --quiet --no-deps "$KLP_PIN"
	printf 'python=%s\nrequirements=%s\nklp=%s\n' \
		"$(py_abi "$VENV/bin/python")" "$(sha_of "$REQS")" "$KLP_PIN" > "$STAMP"
}

if [ "$CORE_ONLY" != 1 ] && [ "$UI_MODE" != 1 ]; then
	PY="$(pick_python)" || {
		echo "no Python >= 3.11 on PATH — scipy 1.16.2 publishes nothing below it, and pip then" >&2
		echo "refuses the WHOLE requirements.txt (websockets included)." >&2
		echo "  brew install python@3.12      # matches worker/Dockerfile" >&2
		echo "  # or: ENCORE_WORKER_PYTHON=/path/to/python3.12 bash dev.sh" >&2
		[ -n "${PYENV_VERSION:-}" ] && echo "  (note: PYENV_VERSION=$PYENV_VERSION is pinning your python3)" >&2
		exit 1
	}

	# A venv on the wrong interpreter can never hold this dependency set, so it is rebuilt rather than
	# reported. Safe to do unasked: a venv is a regenerable cache, and pip's wheel cache means the
	# refetch is mostly local. Announced loudly because it is minutes, not seconds.
	if [ -x "$VENV/bin/python" ] && ! "$VENV/bin/python" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null; then
		say "worker venv is Python $(py_tag "$VENV/bin/python") — too old for the pinned deps, rebuilding on $PY"
		rm -rf "$VENV"
	fi

	if [ ! -x "$VENV/bin/python" ]; then
		say "creating worker venv on $PY $(py_tag "$PY") (multi-GB: torch + demucs + whisperx)"
		"$PY" -m venv "$VENV"
		install_worker_deps
	else
		# READINESS IS THE STAMP, NOT THE DIRECTORY. The old test here was `[ -x $VENV/bin/python ]`,
		# which `python3 -m venv` satisfies BEFORE a single package is installed — so one failed install
		# left a venv holding nothing but pip and setuptools, and every later run skipped straight past
		# it to launch a worker that could not import websockets. Comparing a stamp of the interpreter +
		# a hash of requirements.txt also makes --pull's refresh automatic: a pull that changes the
		# pins changes the hash.
		want="python=$(py_abi "$VENV/bin/python")
requirements=$(sha_of "$REQS")
klp=$KLP_PIN"
		if [ "$(cat "$STAMP" 2>/dev/null)" != "$want" ]; then
			say "worker deps out of date (or never finished installing) — installing"
			install_worker_deps
		elif ! "$VENV/bin/python" -c 'import websockets' 2>/dev/null; then
			# Cheap backstop for a venv edited by hand behind the stamp's back. websockets is the right
			# canary: dial_home imports it lazily at connect time, so its absence is otherwise invisible
			# until after core is already up and the log has scrolled.
			say "worker venv is stamped but incomplete (websockets missing) — reinstalling"
			install_worker_deps
		fi
	fi
fi

# ── build ────────────────────────────────────────────────────────────────────────────
# server.ts serves the built SvelteKit output; without a build it starts with "ui:not built".
if [ "$UI_MODE" != 1 ] && { [ "$DO_PULL" = 1 ] || [ "$DO_RESET" = 1 ] || [ ! -d "$ROOT/build" ]; }; then
	say "building core"
	bun run build
fi

[ "$DO_START" = 1 ] || { say "done (--no-start)"; exit 0; }

# Checked HERE, not in preflight: maintenance (--pull / --reset) does not touch the port or care about
# a stale worker, and blocking those on a port conflict blocks the very command that unsticks you.
preflight_free || exit 1

# ── run ──────────────────────────────────────────────────────────────────────────────
CORE_PID="" WORKER_PID=""

# Stop one job and EVERYTHING it spawned, then verify it is actually gone.
#
# `kill -- -PID` signals the process GROUP. Both halves of that matter and both were bugs here:
#   * the group, because a cook shells out to demucs/yt-dlp and core runs a nested bun — signalling
#     only the leader reparents those to init and they keep going (a stranded demucs keeps a GPU busy);
#   * and a real PID, because `( ... ) & $!` yields the SUBSHELL's pid, not the command's. That is why
#     the first version of this script left `python -m src.dial_home` running after ctrl-c, reconnecting
#     every 3s forever. The launch below uses `exec` so the subshell IS the process.
# TERM first because the worker installs no signal handlers and exits cleanly on it; KILL only if it
# refuses, and say so rather than escalating silently.
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
	trap - EXIT INT TERM
	set +m  # stop bash announcing "Terminated: 15" for each job as we take it down
	printf '\nstopping...\n'
	stop_tree "$WORKER_PID" worker
	stop_tree "$CORE_PID" core
	wait 2>/dev/null || true

	# Prove it, because a silent "stopped." that actually left a worker reconnecting every 3s is worse
	# than no message at all — the next run then fights an invisible second worker for the same jobs.
	#
	# Checked by PID and PORT, deliberately NOT by `pgrep -f <pattern>`: a pattern broad enough to catch
	# the worker also matches this script's own forks (command substitutions inherit its argv), so the
	# first version of this check reported a phantom straggler on every clean shutdown. Our own pids and
	# the listening socket are the two things that cannot lie.
	local left="" i
	for i in $(seq 1 12); do
		left=""
		[ -n "$WORKER_PID" ] && kill -0 "$WORKER_PID" 2>/dev/null && left="$left worker($WORKER_PID)"
		[ -n "$CORE_PID" ] && kill -0 "$CORE_PID" 2>/dev/null && left="$left core($CORE_PID)"
		[ -n "$(port_owner)" ] && left="$left port-3000-still-listening"
		[ -z "$left" ] && break
		sleep 0.25
	done
	if [ -n "$left" ]; then
		echo "WARNING: still running after cleanup —$left"
		echo "  kill with: pkill -f 'src.dial_home'; pkill -f 'bun run ./server.ts'"
	else
		echo "stopped — core and worker both gone, port 3000 released."
	fi
}
trap cleanup EXIT INT TERM

if [ "$UI_MODE" = 1 ]; then
	say "vite dev — UI HMR ONLY, no WebSocket hub (queue will not move, songs will not cook)"
	exec bun run dev
fi

say "starting core"
bun run start & CORE_PID=$!

# Wait for health before starting the worker: it retries every 3s anyway (RECONNECT_BACKOFF_SEC),
# but a clean first connect keeps the log readable.
for _ in $(seq 1 45); do
	curl -fsS -m 2 "$CORE_URL/health" >/dev/null 2>&1 && break
	kill -0 "$CORE_PID" 2>/dev/null || { echo "core exited during startup" >&2; exit 1; }
	sleep 1
done
curl -fsS -m 2 "$CORE_URL/health" || { echo "core did not become healthy" >&2; exit 1; }
echo

if [ "$CORE_ONLY" != 1 ]; then
	say "starting worker"
	# PATH must carry the venv bin: the worker shells out to demucs / yt-dlp BY NAME, and
	# capabilities.py proves a capability with shutil.which() — so a capability whose tool is only
	# importable, not on PATH, gets reported differently. See its "venv-vs-system-python" note.
	# `exec` is load-bearing: it REPLACES the subshell with python, so $! is python's own pid. Without
	# it $! is the subshell and cleanup kills a shell that has already forked, leaving the worker alive.
	(
		cd "$ROOT/worker"
		exec env \
			PATH="$VENV/bin:$PATH" \
			ENCORE_CORE_WS="ws://localhost:3000/ws?role=worker" \
			MEDIA_DIR="$MEDIA_DIR" \
			"$VENV/bin/python" -m src.dial_home
	) & WORKER_PID=$!
fi

say "up"
# Phones cannot use localhost, so resolve the actual LAN address. en0 is Wi-Fi on a Mac; fall back to
# en1 (ethernet/dongle) and then to hostname -I on Linux before giving up.
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"
echo "  core     $CORE_URL"
echo "  tv       $CORE_URL/tv        (open on the television)"
if [ -n "$LAN_IP" ]; then
	echo "  phones   http://$LAN_IP:3000        (the TV's QR encodes this)"
else
	echo "  phones   could not resolve a LAN IP — the TV will say so on screen rather than show a dead QR"
fi
echo "  ctrl-c to stop both"
wait
