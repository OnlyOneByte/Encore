"""Everything this worker reads from its environment, parsed once at the boundary.

ONE PLACE, AND IT RAISES. An unknown token is refused here with a message naming the variable and the
accepted values, rather than reaching a subprocess several stages later as an opaque failure. The old
worker learned this: a de-whitelisted engine name failed deep inside a step, where the traceback named
ffmpeg rather than the setting.

NOTHING BELOW READS `os.environ` DIRECTLY. `Config.from_env` is the only call, so a test builds a Config
literal instead of mutating process state — which is also why every field has a default.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field

from encore_worker.host import ffmpeg

#: Emitted every this many seconds while a long step runs, so the core's lease does not expire.
#: MUST stay comfortably under the core's progress lease (30s in the old core), or the reaper requeues a
#: healthy job. With durable resumption a requeue is cheap now rather than fatal, but a keepalive that
#: never fires would still make every long separation look dead.
KEEPALIVE_SEC = 10.0

#: Backends this worker knows how to build a separator for.
BACKENDS = ("torch", "mlx")

#: Whisper checkpoints the ASR fallback may load. A job may not name an arbitrary model.
ASR_MODELS = ("tiny", "base", "small", "medium", "large-v2", "large-v3")

#: Every alignment arm `ENCORE_ALIGN_EXPERIMENTS` may switch on (`Config.align_experiments`). Each is built,
#: tested and measured, and ships OFF because it failed its reject-if gate (PLAN-alignment-v3's rule for
#: such arms: never silently default-on) — except `ends-raw` and `h3-mix-envelope`, which are default-ON
#: features' CONTROLS and say so at their entries. A NAME THAT BECOMES THE DEFAULT IS RETIRED, and its
#: control takes its place: W4 review r1 flipped the mix's wrong-text verdict to the lift's floor, so
#: `h3-mix-lift-alone` is gone and `h3-mix-envelope` restores what it was an arm of. Setting a retired name
#: is refused like a typo, deliberately — measuring the default path under an arm's name is the thing this
#: tuple exists to prevent, and a run recorded under the old name is reproduced by the control, not by it.
#: WHAT RETIRING A NAME COSTS THE RECORD, so the next flip pays it knowingly (W4 review r2): a row recorded
#: BEFORE the flip carries `align_config: {}` and so is metadata-identical to a row of the new default, while
#: the harness deliberately does not compare `code` (`e2e_gates.COMPARED_META`). The two `--modes all`
#: stemless sweeps are exactly that trap and are renamed rather than re-recorded
#: (`results/w4-stemless-all-envelope-time_text.*`, `gates/w4-stemless.yaml`'s last paragraph). The rule a
#: future flip owes: re-record the rows taken under the retiring name, or rename them so the FILE says the
#: configuration its `align_config` no longer can.
#: The reasoning and numbers live where each is read. W1's five were
#: re-judged under W3's lexical gate (2026-09-28). The gate closed `m2-order-clamp`'s wrong-text failure, and
#: every one still fails a reject-if on right texts, which the gate does not touch:
#:
#:   l1-mix-kept      R1 / R2 never re-decode on the stem a line R4 timed on the mix (review L1, repro s6).
#:   l1-blind-median  the adoption test's reference median is the blind decode's, taken once (review L1,
#:                    repro s5).
#:   m2-order-clamp   `_clamped` fits a run of repaired lines IN ORDER between its trusted neighbours, or
#:                    refuses the whole run back to the blind decode (review M2).
#:   m6-mix-spare     a claimed never-sung candidate whose claim window the stem is silent in but the MIX
#:                    sounds in is spared for R4, which puts it back where the mix's acoustic model hears it
#:                    (review M6, the mix witness).
#:   m6-window-spare  a never-sung candidate whose claim window the TARGET sounds in is re-decoded inside it
#:                    and put back where that decode hears it, instead of binned (W1's extension of review
#:                    M6).
#:   h3-mix-floor     on the MIX (a song with no vocals stem) the envelope gate is kept BESIDE the lift's
#:                    floor, so a text must clear both — what W3 first shipped (review H3). OFF because it
#:                    pays the floor's cost AND the envelope gate's: it publishes 54 of the stemless bench
#:                    mode's 128 right-text cases where the default (the floor alone) publishes 91 and W3's
#:                    envelope-only default published 77, and it refuses 0 of 64 wrong texts either way
#:                    (3/14 of `gates/w4-stemless.yaml`, against the default's 13/14).
#:   claimmap-piecewise  the claim clock may split into change-point LEGS instead of one affine map, for a
#:                    sheet with an inserted section, a re-lineated middle or a live rendition's drift
#:                    (review §3.11; W2, `domain/lyrics/claimmap.py`). OFF because the critics measured a
#:                    change-point version WORSE on the unperturbed control and a misbound repeat (failure
#:                    F2) looks exactly like a step to it; the single map it falls back to is default-ON.
#:                    Since review r1 made `_monotonic` judge the LEG BOUNDARIES it refuses every split its
#:                    probe population offered: byte-identical to the default over 48 cases with no `legs`
#:                    sentence on any trail (`results/w2-pwarm-time_text.*`, where it used to move 2
#:                    documents under `jit`, both worse). There is nothing left to switch on.
#:   m5-adopt-floor   a claim span too short to hold its line at `regenerate`'s floor is NOT adopted over a
#:                    window decode that heard nothing; the repair is dropped and the measurement stands
#:                    (review M5's second half; W2). OFF because §3.11's reject-if says the unperturbed row
#:                    may lose 0.3 pt and this costs 0.92 of it — 16 of 1736 lines within ±500 ms and a gross
#:                    line, all on SHORT CAPTION CUES whose start is right and whose end is missing
#:                    (rap-god 15 lines, JASON_MILLER drop50 one). The defect it fixes — a cue 7 s early with
#:                    no end, adopted 5.06 s out — stays pinned hermetically either way.
#:   h3-mix-envelope  THE OTHER CONTROL, not a failed arm (`ends-raw` is the first): the MIX's wrong-text
#:                    verdict is the ENVELOPE GATE alone and the lift's floor merely grades there, which is
#:                    what W3 shipped and what W4 review r1 flipped away from. It is the A/B switch for that
#:                    flip, and the row IT was recorded on is `results/w4-stemless-envelope-time_text.json`
#:                    (the shipped default's is `results/w4-stemless-time_text.json`). The
#:                    numbers that flipped it, from the stemless bench mode (`e2e.py --no-stem`, 32 songs x
#:                    truth/blind/drop20/drop50 + 2 wrong donors, `gates/w4-stemless.yaml`, README's "The
#:                    stemless mode"): this arm publishes 77 of 128 right-text cases where the default's
#:                    floor publishes 91, refuses 10 of 32 truth texts where the floor refuses 7, holds
#:                    42.3% of published line starts within ±500 ms against 53.5%, and admits 27 of 64
#:                    wrong texts — 42.2%, where review §3.4 allows 1% (`lexical.BANDS`, MIX, owns that
#:                    figure and its 26/40.6% pre-r1 history). The floor's own cost is real and is
#:                    why W3 hesitated: 37 of the 128 right-text cases (7 of the 32 truth texts) lift below
#:                    it and are refused TERMINALLY, so numb and Avercage lose documents worth 29/35 and
#:                    41/42 line starts and a `run_align` probe with no transcriber ends in NO LYRICS — but
#:                    the envelope gate loses more of the same, and 27 wrong texts with it.
#:                    SETTING BOTH THIS AND `h3-mix-floor` MEANS `h3-mix-floor` (both gates), which is the
#:                    stricter superset: an arm name must never record a configuration it does not describe
#:                    (`align_steps._time_text_global`, W4 review r2).
#:   ends-tile        the word-end post-pass TILES each line gaplessly — a word that is not its line's last
#:                    runs to the next word's start whatever the envelope says — instead of ending where the
#:                    singing stops (review §3.5; W4, `domain/lyrics/ends.py`). The review measured 78.8%
#:                    highlight against 78.2% for the envelope alone; on 3 Jamendo songs here it buys +1.5
#:                    pts of highlight (79.1 -> 80.6) for -4.0 on word-end ±100 (79.0 -> 75.0), phrase-final
#:                    ends untouched. The other cost is not in a number: the TV splits a line over 42 chars
#:                    at word gaps of 0.45 s (`lyrics.ts` LINE_GAP_SEC), and a tiled line has none, so a
#:                    long line that showed as two rows at its pause now shows as one.
#:   ends-raw         THE ONE CONTROL, not a failed arm: the word-end post-pass does not run, so ends are
#:                    the raw decode's, which is the column review §3.5's reject-if gates measure a gain
#:                    over (highlight +5 pts, phrase-final end ±100 +10). A display post-pass has to be
#:                    A/B-able and the arm switch is the only thing the bench can move without editing code;
#:                    it is also the off switch if the corpus run rejects the post-pass after all.
#:
#: (`steps/align_steps.py`, `_time_text_global`, `_clamped` and `_SPOKEN_RATIO`.) An unknown name is refused
#: like any bad setting: a typo would otherwise measure the default path under the arm's name.
ALIGN_EXPERIMENTS = (
    "l1-mix-kept",
    "l1-blind-median",
    "m2-order-clamp",
    "m6-mix-spare",
    "m6-window-spare",
    "m5-adopt-floor",
    "h3-mix-floor",
    "h3-mix-envelope",
    "claimmap-piecewise",
    "ends-tile",
    "ends-raw",
)


class ConfigError(ValueError):
    """A setting that cannot be honoured.

    `retryable = False`: re-reading the same environment yields the same value, so a worker with a bad
    setting must fail fast and loudly rather than burn attempts proving it.
    """

    retryable = False


@dataclass(frozen=True, slots=True)
class Config:
    """This worker's resolved configuration."""

    #: Where the core is. The one setting with no sensible default — a worker that guesses this
    #: silently dials a machine nobody meant.
    #: `/ws?role=worker` — the path AND the role param are both required: core routes every socket through
    #: one `/ws` endpoint and reads `role` to decide what the connection may do (`core/server.ts`). A worker
    #: dialling `/worker` is simply not upgraded, which looks like the core being down.
    core_url: str = "ws://localhost:3000/ws?role=worker"
    worker_id: str = "worker-1"
    version: str = "0.1.0"
    #: How many jobs at once. One by default: separation and alignment are both GPU-bound, and two
    #: concurrent passes on one device are slower than two in sequence.
    #:
    #: IT ALSO SIZES THE EMISSION CACHE (`adapters.ml._emission_cache_size`, W4 review r1): each live align
    #: job holds up to two matrices, so a bound fitted to one job made a 3-job box evict its own live set.
    concurrency: int = 1
    media_dir: str = "/media"
    #: Where DBOS keeps its durable state. Per-box: it holds in-flight checkpoints, so it is machine
    #: state and must not be shared or committed.
    dbos_db: str = "encore-worker.sqlite"
    backend: str | None = None
    device: str | None = None
    asr_model: str = "base"
    #: The bare name as a DATACLASS default, but `from_env` resolves a real path through `host.ffmpeg` —
    #: bundled static build first, PATH last. Left as "ffmpeg" here so a Config() built in a test does not
    #: depend on the `ffmpeg` extra being installed.
    ffmpeg_bin: str = "ffmpeg"
    ytdlp_bin: str = "yt-dlp"
    mlx_bin: str = "demucs-mlx"
    #: Where zoo checkpoints are cached. NOT `/tmp`, which is `audio-separator`'s own default and wrong for
    #: this: each checkpoint is 100-400 MB, they are downloaded on first use, and /tmp is cleared on reboot
    #: (and is a tmpfs on some hosts, so a 400 MB download lands in RAM). `from_env` derives it from
    #: XDG_CACHE_HOME, which the Docker image already points at the persistent `worker-cache` volume.
    zoo_model_dir: str = ""
    keepalive_sec: float = KEEPALIVE_SEC
    #: The container published stems are written in. CORE'S DECISION, not this box's: core owns the storage
    #: layout and announces this at handshake, because a row's ext is recorded forever and a worker guessing
    #: differently from core makes a file that exists 404 (core's paths.ts: "a mismatch is SILENT").
    #:
    #: NOT `ENCORE_STEM_FORMAT`, which is a different setting — the SCRATCH container a separator writes,
    #: legitimately `wav` to skip an encode on a CPU-bound box. Conflating them would let a scratch choice
    #: silently change what the library stores.
    publish_stem_format: str = "flac"
    #: FLAC compression level. 8 is the size/CPU knee and is decode-cheap, which is what matters for a
    #: browser starting playback in a room.
    flac_level: int = 8
    #: Retain the raw caption track under `derived/` for diagnosing the parser. Off by default: it is
    #: evidence for a specific investigation, not something every room needs on disk.
    keep_raw_captions: bool = False
    #: No outbound internet. Skips the lyrics provider entirely rather than paying its timeout per song;
    #: captions and ASR still work, so a fully offline room still gets lyrics from what it can hear.
    offline: bool = False
    #: The lyrics multiplexer, tried first. Configurable because it is self-hostable, and because a
    #: restricted network may reach one host and not another.
    lrcmux_url: str = "https://api.lrcmux.dev"
    #: The direct provider, tried second. Also self-hostable.
    lrclib_url: str = "https://lrclib.net/api/get"
    #: An explicit HTTPS proxy for provider lookups. Unset falls back to the standard environment
    #: variables — see `adapters/lrcmux.build_opener` for why each client builds its own opener.
    https_proxy: str | None = None
    #: The default-off alignment arms switched on (`ALIGN_EXPERIMENTS`): the ONE place they live, so a bench
    #: run records exactly which arms it measured (`e2e_lib.align_config` reads every `align_*` field).
    align_experiments: frozenset[str] = frozenset()
    extra: Mapping[str, str] = field(default_factory=dict)

    @staticmethod
    def from_env(env: Mapping[str, str] | None = None) -> Config:
        """Parse the environment. The ONLY place `os.environ` is read."""
        src = dict(os.environ if env is None else env)

        def text(key: str, fallback: str) -> str:
            got = src.get(key, "").strip()
            return got or fallback

        def optional(key: str) -> str | None:
            return src.get(key, "").strip() or None

        backend = optional("ENCORE_SEPARATOR_BACKEND")
        if backend is not None and backend not in BACKENDS:
            raise ConfigError(
                f"ENCORE_SEPARATOR_BACKEND={backend!r} is not a backend this worker can build. "
                f"Expected one of {', '.join(BACKENDS)}, or leave it unset to auto-select."
            )

        asr = text("ENCORE_ASR_MODEL", "base")
        if asr not in ASR_MODELS:
            raise ConfigError(
                f"ENCORE_ASR_MODEL={asr!r} is not a known checkpoint. "
                f"Expected one of {', '.join(ASR_MODELS)}."
            )

        return Config(
            core_url=text("ENCORE_CORE_URL", "ws://localhost:3000/ws?role=worker"),
            worker_id=text("ENCORE_WORKER_ID", "worker-1"),
            version=text("ENCORE_WORKER_VERSION", "0.1.0"),
            concurrency=_positive_int(src, "ENCORE_WORKER_CONCURRENCY", 1),
            media_dir=text("ENCORE_MEDIA_DIR", "/media"),
            dbos_db=text("ENCORE_DBOS_DB", "encore-worker.sqlite"),
            backend=backend,
            device=optional("ENCORE_DEVICE"),
            asr_model=asr,
            # RESOLVED, not read. An unset ENCORE_FFMPEG_BIN means "pick the best available", which is the
            # bundled static build ahead of whatever PATH offers — see `host.ffmpeg` for why that order.
            # `optional` rather than `text` so an empty string is treated as unset instead of as a request
            # to exec "".
            ffmpeg_bin=ffmpeg.resolve(optional("ENCORE_FFMPEG_BIN")),
            ytdlp_bin=text("ENCORE_YTDLP_BIN", "yt-dlp"),
            mlx_bin=text("ENCORE_MLX_BIN", "demucs-mlx"),
            zoo_model_dir=text("ENCORE_ZOO_MODEL_DIR", _default_zoo_dir(src)),
            keepalive_sec=_positive_float(src, "ENCORE_KEEPALIVE_SEC", KEEPALIVE_SEC),
            # Read from the environment as a FALLBACK only. Core announces the live value at handshake and
            # that wins, because core owns the storage layout — this exists so a worker started against an
            # older core (which announces nothing) still publishes something core can read.
            publish_stem_format=text("ENCORE_PUBLISH_STEM_FORMAT", "flac").lstrip(".").lower(),
            flac_level=_positive_int(src, "ENCORE_FLAC_LEVEL", 8),
            keep_raw_captions=_flag(src, "ENCORE_KEEP_RAW_CAPTIONS"),
            offline=_flag(src, "ENCORE_OFFLINE"),
            lrcmux_url=text("ENCORE_LRCMUX_URL", "https://api.lrcmux.dev"),
            lrclib_url=text("ENCORE_LRCLIB_URL", "https://lrclib.net/api/get"),
            https_proxy=optional("ENCORE_HTTPS_PROXY"),
            align_experiments=_experiments(src, "ENCORE_ALIGN_EXPERIMENTS"),
        )


def _default_zoo_dir(src: Mapping[str, str]) -> str:
    """Where zoo checkpoints live when the operator has not said.

    XDG_CACHE_HOME first because the Docker image already sets it to the persistent `worker-cache` volume,
    so the default does the right thing in a container with no extra configuration. `~/.cache` is the same
    convention off-container.

    Explicitly NOT `audio-separator`'s own `/tmp/audio-separator-models/`: these are 100-400 MB downloads,
    /tmp is cleared on reboot, and on hosts where it is a tmpfs the download lands in RAM.
    """
    base = src.get("XDG_CACHE_HOME", "").strip() or os.path.join(
        src.get("HOME", "").strip() or os.path.expanduser("~"), ".cache"
    )
    return os.path.join(base, "encore-worker", "separator-models")


def _positive_int(src: Mapping[str, str], key: str, fallback: int) -> int:
    raw = src.get(key, "").strip()
    if not raw:
        return fallback
    try:
        got = int(raw)
    except ValueError as bad:
        raise ConfigError(f"{key}={raw!r} is not an integer") from bad
    if got < 1:
        raise ConfigError(f"{key}={got} must be at least 1")
    return got


def _positive_float(src: Mapping[str, str], key: str, fallback: float) -> float:
    raw = src.get(key, "").strip()
    if not raw:
        return fallback
    try:
        got = float(raw)
    except ValueError as bad:
        raise ConfigError(f"{key}={raw!r} is not a number") from bad
    if got <= 0:
        raise ConfigError(f"{key}={got} must be positive")
    return got


def _experiments(src: Mapping[str, str], key: str) -> frozenset[str]:
    """A comma-separated set of `ALIGN_EXPERIMENTS` names; blanks ignored, anything else refused."""
    named = frozenset(part.strip().lower() for part in src.get(key, "").split(",") if part.strip())
    unknown = sorted(named - set(ALIGN_EXPERIMENTS))
    if unknown:
        raise ConfigError(
            f"{key} names {', '.join(repr(name) for name in unknown)}, which is not an alignment experiment. "
            f"Expected a comma-separated subset of {', '.join(ALIGN_EXPERIMENTS)}, or leave it unset."
        )
    return named


def _flag(src: Mapping[str, str], key: str) -> bool:
    """A boolean env var. Accepts the spellings people actually type; everything else is False.

    Deliberately NOT `bool(value)`: that makes `ENCORE_KEEP_RAW_CAPTIONS=0` and `=false` both TRUE,
    which is the opposite of what the operator who typed it meant.
    """
    return src.get(key, "").strip().lower() in ("1", "true", "yes", "on")
