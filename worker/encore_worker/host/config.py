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
#: such arms: never silently default-on) — except `ends-raw`, `h3-mix-envelope` and `conf-legacy`, which are
#: default-ON features' CONTROLS and say so at their entries. A NAME THAT BECOMES THE DEFAULT IS RETIRED, and
#: its control takes its place: W4 review r1 flipped the mix's wrong-text verdict to the lift's floor, so
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
#:                    (the default-arm row is `results/w4-stemless-time_text.json`, both on the BASE bundle,
#:                    which was the shipped default when they were measured — W5 flipped it). The
#:                    numbers that flipped it, from the stemless bench mode (`e2e.py --no-stem`, 32 songs x
#:                    truth/blind/drop20/drop50 + 2 wrong donors, `gates/w4-stemless.yaml`, README's "The
#:                    stemless mode"): this arm publishes 77 of 128 right-text cases where the default's
#:                    floor publishes 91, refuses 10 of 32 truth texts where the floor refuses 7, holds
#:                    42.3% of published line starts within ±500 ms against 53.5%, and admits 27 of 64
#:                    wrong texts — 42.2%, where review §3.4 allows 1% (`lexical`'s MIX section owns that
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
#:   linesep          the CTC targets carry the vocabulary's WORD SEPARATOR (`|`) between lines — emitted at
#:                    line boundaries only, its frames relabelled to blank before the spans are grouped
#:                    (review 6c / D1; W4b, `domain/lyrics/generate.separator_of`). DISPUTED by the reviewers
#:                    three ways, which is why it is an arm before it is a number: FOR, line-level `|` cut
#:                    blind Jamendo gross lines 47 -> 23 and word ±300 91.3 -> 93.0; AGAINST, net-negative on
#:                    11 songs, never-be-alone gross 23 -> 28, E2E with claims flat (25 -> 26) and onset bias
#:                    +21 ms.
#:                    THE DECODE AXIS OF 6c's FACTORIAL IS MEASURED and the FOR column reproduces
#:                    (`--level generate --modes blind --songs jamendo`, 20 songs, 4 cells; rows in
#:                    `results/w4b-linesep-*-generate.json`, README's section, and the grid at the head of
#:                    `gates/w4b-linesep-generate.yaml`): blind Jamendo gross 41 -> 29 on the base model and
#:                    28 -> 15 on HuBERT-L, line ±500 +5.1 / +4.6 pts, word ±300 +1.4 / +1.2, and the bias
#:                    moves TOWARD zero on both (-3.1 -> -1.9, -7.0 -> -6.4), so the review's +21 ms was the
#:                    old 30 s-chunk clock's. OFF because it REJECTS 7/10 and 8/10 there, on two gates: a
#:                    song's gross count rises (4 songs on the base model, ONE on HuBERT-L) and highlight
#:                    falls 0.9 pt. The second is the LEVEL rather than the arm — `--level generate` scores
#:                    the raw decode's ends, which the shipped word-end post-pass re-fits, and a 4-song
#:                    `--level time_text` probe reads highlight -0.1 with phrase-final ends +6.6 — so the E2E
#:                    half of the factorial is what would flip this, and it is the bench runner's
#:                    (`gates/w4b-linesep.yaml`: the four cells' commands, the truth/jit gross bounds nobody
#:                    has read yet, and the wrong-text bound the arm must not buy anything from).
#:                    The arm is INERT, not fatal, on a vocabulary that names no separator or maps it to the
#:                    blank column, and the trail note says which of the two happened.
#:                    THE EVERY-WORD VARIANT IS NOT BUILT, in either direction: D1's own mechanism is that a
#:                    `|` inside a line makes CTC's path leave the letters for a boundary the model did not
#:                    hear, and review 6c asks for line boundaries only.
#:   conf-legacy      THE THIRD CONTROL: per-line grading ignores the placement margin, so a line's
#:                    confidence is what provenance and the blind reconcile alone said — the rule W6
#:                    replaced (review §3.7; `domain/lyrics/margin.py`, `align_steps._placement_margins`).
#:                    It is the A/B switch for a DEFAULT-ON grading change, and the only thing the bench can
#:                    move without editing code. What it restores, measured over the 20 Jamendo songs' blind
#:                    decode (866 published lines, base model): 51.5% of lines graded `high` instead of
#:                    33.0%, with 11.88% of those more than 0.5 s off instead of 2.80% and TWENTY-THREE more
#:                    than 2 s off instead of none — and 12.86% of the `low` ones bad, which is the at-chance
#:                    reading review §3.7 opens with. On HUBERT_ASR_LARGE, the bundle W4b left reachable by
#:                    name, the same pair reads 51.4% / 8.97% / 20 against W6's 34.7% / 2.66% / ZERO — the
#:                    rule transfers with no per-bundle refit. It also skips the two Viterbi passes it costs
#:                    (0.43 s median over the 20 Jamendo songs, 1.16 s on the longest song measured), the
#:                    only other reason to set it.
#:                    IT MUST SKIP THE WHOLE RULE, score half included: `low_lines` without margins still
#:                    demotes on the score, and an A/B against that compares two versions of W6 (measured
#:                    while building it: 385 `high` lines against the real control's 446).
#:                    SO THE ARM IS NOT A SPECIAL CASE ANY MORE: it is one of FIVE reasons the rule reads no
#:                    margins (`align_steps._Placement.silence` — this arm; a bundle with no fitted
#:                    `lexical.Bands.margin_floor_nats`; a document already graded `low` throughout, which no
#:                    margin could move; a fault inside the two Viterbi passes; and a matrix that carried no
#:                    path to compare), and all five take the same GRADING branch, which is what W6 review
#:                    r1-correctness-2 found the FAULT path was not doing. They do NOT take the same trail
#:                    sentence: this arm and a swallowed `MemoryError` printed byte-identical notes until W6
#:                    review r2-spec-7, so an operator's deliberate A/B and a default-on rule silently falling
#:                    back to the rule it replaced were one string. Each names itself now.
#:   conf-fuzzy-repeats  the demotion also fires on NEAR-repeats (`margin.fuzzy_repeats`, `difflib` ratio
#:                    >= 0.8) and not only on the margin and the score — review §3.7's optional half, built
#:                    because the review measured near-matching finding 50 repeated lines an exact match
#:                    misses, 8 of them blind-gross lines graded `high`, against 42 correct lines demoted.
#:                    IT NEEDS NO CALIBRATION AND IS NOT GATED ON ONE (W6 review r2-correctness-5): a
#:                    `difflib` ratio over the line TEXTS has no emission scale, so the arm fires on a bundle
#:                    with no measured margin floor, on a fault and on an unreadable matrix, where it used to
#:                    go silently inert and leave a bench row recorded under the arm's name having measured
#:                    the default path. `conf-legacy` stands it down (there is no demotion to widen) and so
#:                    does an already-`low` document (quadratic work on a fixed grade); both say so on trail.
#:                    OFF because the trade reproduces and is negative: over the 20 Jamendo songs' blind
#:                    decode it finds 49 near-but-not-exact repeats, and among the lines W6 already grades
#:                    `high` it would demote 3 that are more than 0.5 s off (NONE more than 2 s) and 30 that
#:                    are correct — a 10:1 loss on a population the margin has already cleaned out. End to
#:                    end it reads 29.7% coverage / 1.95% bad-among-high / 0 gross against the default's
#:                    33.0% / 2.80% / 0: 29 word wipes for 0.85 pt, and not one gross line, because the
#:                    review's 8 were `high` under the rule W6 replaced and the margin takes them first.
#:   adlibs           mid-line / trailing LEXICAL parentheticals and ECHO-TAIL lines are held out of the
#:                    LEAD decode and timed afterwards inside their host line (review §3.13; W5,
#:                    `domain/lyrics/parts.py`, which carries both rules, their counter-examples and the
#:                    corpus reach). THE REACH IS SMALL AND MEASURED: 12 parenthetical hosts in 4 songs and
#:                    15 echo tails in 6 songs out of the corpus's 1712 served lines, 10 of 32 songs
#:                    touched, and on the other 22 the whole module is IDENTITY (`parts.untouched`), so a
#:                    run on them is byte-identical by construction.
#:                    OFF BECAUSE THE REVIEW'S ONE MEASUREMENT DOES NOT REPRODUCE ON THE TREE THAT SHIPS,
#:                    and that is the critics' own objection ("one song") answered with numbers rather than
#:                    agreed with (`_runs/w5-adlibs2-{off,on}`, the 5 songs the two rules reach most x
#:                    truth/blind at `--level time_text`, HuBERT-L, same code `f8ac0b65440fe508`). Pooled
#:                    blind gross **14 = 14** (hello -1, numb +1), ±500 +0.6, ±1 s +0.6, zero-gross songs
#:                    2 (-1); truth gross 0 = 0, ±500 -0.0, ±1 s -0.3. Per line, which is what decides it:
#:                    the ONE echo tail whose timing moved got WORSE (hello `♪ Other side ♪` +1.84 ->
#:                    **+2.08 s**, i.e. it became the gross line it had not been), hello's apparent win is
#:                    four lines — one spoken line and three CUE lines (`(wind buffeting) (phone
#:                    clacking)`) — that the SHIPPED path never serves at all, because `nonlyric.py` drops
#:                    them at clean time and only the bench's raw `--level time_text` text still has them;
#:                    numb gains a gross line AFTER two aside hosts (`CHORUS: I've become so numb` -0.56 ->
#:                    **-2.25 s**); and never-be-alone LOSES a published line, because taking an echo's
#:                    targets out moves the never-sung rule's median and drops one more host (46 -> 45
#:                    lines, both modes).
#:                    WHY THE REVIEW SAW 21 -> 11 AND THIS SEES NOTHING: its population is gone. Hello's
#:                    blind decode had 21 gross LEAD lines on the base bundle before W6's clamp fix; on
#:                    this tree it has SIX gross lines in total (the flip repays that song ±500 61.64 ->
#:                    75.00 and ~40 gross lines by itself), so the drag §3.13 was built to remove had
#:                    already been removed by other means, and what is left is a trade between an
#:                    interpolated ad-lib and a decoded one.
#:                    WHAT WOULD CHANGE THE VERDICT, and neither is this wave's: timing each aside with a
#:                    WINDOW DECODE in the gap instead of interpolating it (`generate.regenerate`'s
#:                    primitive, the gap being evidence the lead decode produced), and a `run_align` read —
#:                    every number above is `time_text`, where the text is served RAW, and the shipped
#:                    cleaning changes which lines the rules even see.
#:   lang-route-mix   a LATIN-SCRIPT song is timed on the MIX by whisperx's own per-language bundle instead of
#:                    this box's English default (review M8 / §3 item 9; W7,
#:                    `domain.lyrics.language.model_language`, which is the one place the rule lives). The
#:                    STEM is never routed, arm or no arm, and a NON-LATIN script always routes whatever this
#:                    says — the English vocabulary maps zero characters of Hangul, Han, Cyrillic or Arabic,
#:                    so there the alternative is `no lyrics` (review M8's repro s12) rather than a trade.
#:                    WHY IT IS AN ARM AND NOT THE DEFAULT, measured on 59 songs rather than argued: see the
#:                    numbers in `language.model_language` and `README.md`'s "The language reading". Two
#:                    independent reasons, and either alone would be enough. (1) ACCURACY: on the STEM the
#:                    English default wins, which is the reading the review had at n=7 and this wave widened
#:                    to the whole fr/de/es third of JamendoLyrics under the bundle that ships. (2) GATING: a
#:                    routed bundle has NO `lexical.CALIBRATED` row, so every emission-scale threshold stands
#:                    down on it — the wrong-text lift cannot refuse, the doubt band cannot grade and the
#:                    placement margin abstains (`lexical.calibration` answers None by design, which is the
#:                    review's high-severity W3 finding working as intended). Turning this on by default would
#:                    therefore trade measured accuracy for an ungated wrong-text path on every non-English
#:                    Latin song. The wave that fits five numbers per language with
#:                    `lift_gate.py --model VOXPOPULI_ASR_BASE_10K_{FR,DE,ES}` and `line_gate.py --model …` is
#:                    the wave that may flip it.
#:   ends-raw         THE ONE CONTROL, not a failed arm: the word-end post-pass does not run, so ends are
#:                    the raw decode's, which is the column review §3.5's reject-if gates measure a gain
#:                    over (highlight +5 pts, phrase-final end ±100 +10). A display post-pass has to be
#:                    A/B-able and the arm switch is the only thing the bench can move without editing code;
#:                    it is also the off switch if the corpus run rejects the post-pass after all.
#:
#: (`steps/align_steps.py`, `_time_text_global`, `_clamped`, `_bundle_language` and `_SPOKEN_RATIO`.) An
#: unknown name is refused
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
    "linesep",
    "adlibs",
    "lang-route-mix",
    "conf-legacy",
    "conf-fuzzy-repeats",
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
    #: The ENGLISH alignment bundle (`ENCORE_ALIGN_MODEL`, review §3 item 6b) — a torchaudio pipeline name
    #: such as `HUBERT_ASR_LARGE`. Every other language keeps whisperx's own per-language table
    #: (`adapters.ml.align_model_name`), because these bundles are English.
    #:
    #: UNSET MEANS THIS DEVICE'S DEFAULT: `adapters.ml.default_align_model`, which is `HUBERT_ASR_LARGE` on
    #: every device since W5's flip (W4b's corpus sweep had rejected it, W6 found the cause to be the repair
    #: clamp rather than the decode, and W5 took it on `results/w6-hubert-*` — `ALIGN_MODELS_BY_DEVICE` is
    #: still empty, and HuBERT-XLarge on CUDA is still a PROJECTION nobody has run). It is resolved where the
    #: device is (`__main__.align_model_for`) rather than here, since this box's accelerator is probed and not
    #: configured — which is also what lets a measured per-device row land later without touching this field.
    #: THE BENCH KEEPS THIS FIELD OUT OF `align_config` ALTOGETHER (`e2e_lib.SPELLING_ONLY`, W4b review r2),
    #: so the default path keys the emission cache exactly as it did before the knob existed AND
    #: `ENCORE_ALIGN_MODEL=X` keys it identically to `--model X` — one bundle, one computation, one namespace.
    #: Which bundle a run loaded is recorded as its `run.json` / summary `model` plus `model_identity`.
    #:
    #: SETTING IT IS HOW AN OPERATOR RUNS A MEASURED-BUT-NOT-DEFAULT BUNDLE, which since W5 means going BACK:
    #: `ENCORE_ALIGN_MODEL=WAV2VEC2_ASR_BASE_960H` is the base bundle every row set up to `results/w6-base-*`
    #: was measured on (2.7-5.2 s a song against the default's 4.3-8.6, and 360 MB of weights against 1.2 GB),
    #: and `=HUBERT_ASR_XLARGE` is the CUDA candidate nobody has run end to end. What the default buys over
    #: base bundle, and the four things it costs, are at `ml.DEFAULT_ALIGN_MODEL`.
    #:
    #: NOT VALIDATED HERE, and that is a layering fact rather than an oversight: the only check worth making
    #: is "does `domain.lyrics.lexical.CALIBRATED` hold a row for it" — a worker whose lift gate cannot judge
    #: this model's emission scale has no wrong-text gate — and `host/` may not import `domain/`
    #: (`tests/test_layers.py`). `__main__.align_model_for` makes it, with this module's own "fail fast and
    #: name the setting" manners, before a single job is accepted.
    align_model: str | None = None
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
            align_model=optional("ENCORE_ALIGN_MODEL"),
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
