"""Guards on the worker's package structure.

These exist because the worker was repackaged into domains/runtime/steps (docs/ARCHITECTURE.md
§7.1), and packaging has two
failure modes that are silent until something far away breaks. Both were hit while doing the move, which
is why they are pinned rather than remembered.

They are the first of the spec's enforcement tests (§7). The rest arrive with the runtime.
"""

from __future__ import annotations

import importlib
import pkgutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

#: The domain packages. Each owns one concern and is named for it.
DOMAIN_PACKAGES = ["acquisition", "analysis", "diarize", "lyrics", "metadata", "separation"]

#: The runtime layers. These execute a plan and know nothing about audio, lyrics or separation — see
#: docs/ARCHITECTURE.md §7.1. Listed separately from the domains because the layering guard
#: treats them differently: a domain may not import these, and these may not import a domain.
RUNTIME_PACKAGES = ["runtime", "steps"]

ALL_PACKAGES = DOMAIN_PACKAGES + RUNTIME_PACKAGES

#: Modules that USED to live flat in src/ and were moved into a package. Importing one of these again
#: means either a stale copy survived the move or someone re-created it beside its package.
MOVED_AWAY = [
    "annotate",
    "whisperx",
    "captions",
    "demucs",
    "fetch",
    "key_detect",
    "lyrics_chain",
    "lyrics_presplit",
    "lyrics_source",
    "lyrics_validate",
    "roformer",
    "song_profile",
    "stream_quality",
    "vocal_range",
]


def test_no_module_is_importable_by_its_OLD_flat_path():
    """S0's own guarantee. A mis-merged `git mv` plus a re-export can leave one module importable under
    two names, and then two copies of the same class exist and `isinstance` starts failing in ways that
    look like anything except a packaging mistake."""
    for name in MOVED_AWAY:
        assert not (Path(__file__).resolve().parents[1] / "src" / f"{name}.py").exists(), (
            f"src/{name}.py still exists — it was supposed to move into a package"
        )


def test_no_package_reexport_SHADOWS_one_of_its_own_submodules():
    """The trap that actually bit during S0.

    `metadata/__init__.py` re-exported the function `annotate` from the submodule `annotate`. The name
    bound in the package namespace is then the FUNCTION, so `from src.metadata import annotate as ann`
    gives you something whose `.parse_recordings` raises AttributeError on a plain function object — an
    error that says nothing about the real cause. Any package with a submodule and a same-named member is
    a landmine, so the rule is enforced rather than reviewed.
    """
    for pkg_name in ALL_PACKAGES:
        pkg = importlib.import_module(f"src.{pkg_name}")
        submodules = {m.name for m in pkgutil.iter_modules(pkg.__path__)}
        exported = set(getattr(pkg, "__all__", []))
        clash = submodules & exported
        assert not clash, (
            f"src/{pkg_name}/__init__.py re-exports {sorted(clash)}, which shadows the submodule(s) of "
            f"the same name. Reach those at their full path instead."
        )


def test_every_domain_package_explains_what_belongs_in_it():
    """A package boundary that is not written down is a boundary the next person guesses at. Each one
    states what it owns AND what it deliberately does not."""
    for pkg_name in ALL_PACKAGES:
        pkg = importlib.import_module(f"src.{pkg_name}")
        doc = (pkg.__doc__ or "").strip()
        assert len(doc) > 200, f"src/{pkg_name}/__init__.py needs a docstring saying what belongs in it"


def test_the_domain_packages_are_exactly_the_ones_declared():
    """Catches a package added without a decision — the point of the layering in the spec is that a new
    domain is a deliberate act, not something that appears because a file needed somewhere to go."""
    src = Path(__file__).resolve().parents[1] / "src"
    found = sorted(
        p.name
        for p in src.iterdir()
        if p.is_dir() and (p / "__init__.py").exists() and not p.name.startswith("_")
    )
    assert found == sorted(ALL_PACKAGES), (
        f"packages on disk {found} != declared {sorted(ALL_PACKAGES)}. Add it to DOMAIN_PACKAGES or\n"
        f"RUNTIME_PACKAGES (and give it a docstring) if the new package is intended."
    )


def test_the_separation_audio_policy_does_not_claim_the_vocals_stem_is_unplayed():
    """The separation domain's audio policy is the rule that stops a reader re-encoding a stem
    badly, and its load-bearing clauses were false in the direction that RELAXES the rule.

    Part (1) is the original finding: "nothing plays [the vocals stem]" — false, the vocals stem is
    the guiding track, a second <audio> the TV mixes under the instrumental at up to full gain and pitch-
    shifts with the key (apps/core/src/lib/tv/TvPlayer.svelte). Part (2) is the tail-cleanup that followed:
    once PublishStems was pointed at encode_flac_argv, the AAC vocals path (STEM_BITRATE + encode_stem_argv
    + the ENCORE_STEM_BITRATE knob) reached no argv, so it was deleted. There is no behaviour to test, so
    this pins the prose and the delete: the guiding-track reason stays named, and the dead AAC names must
    not reappear in apps/worker/src."""
    src = Path(__file__).resolve().parents[1] / "src"

    # (1) The "nothing plays it" clause is false and must not reappear at any of its three former sites.
    init_doc = importlib.import_module("src.separation").__doc__ or ""
    separate_src = (src / "steps" / "separate.py").read_text(encoding="utf-8")
    for name, text in (("separation/__init__.py", init_doc), ("steps/separate.py", separate_src)):
        assert "nothing plays" not in text, (
            f"{name} still claims the vocals stem is unplayed — it is the guiding track"
        )
    # The true reason must be stated where the policy lives, not merely absent.
    assert "GUIDING TRACK" in init_doc, (
        "separation/__init__.py must name the guiding track as the reason"
    )
    assert "GUIDING TRACK" in separate_src, (
        "steps/separate.py must name the guiding track as the reason"
    )

    # (2) The AAC vocals path is dead. STEM_BITRATE and encode_stem_argv reached
    # no argv once PublishStems was pointed at encode_flac_argv, so both were removed. Guard that
    # neither name reappears anywhere in apps/worker/src, with line comments and docstrings stripped
    # so the retired-policy prose in demucs.py can neither satisfy nor trip this. A sentinel proves the
    # strip did not silently blank the corpus.
    def _code_only(text):
        # drop triple-quoted blocks (docstrings), then drop line comments
        parts = text.split('"""')
        no_doc = ''.join(parts[::2]) if len(parts) % 2 == 1 else text
        return "\n".join(ln.split("#", 1)[0] for ln in no_doc.splitlines())

    code_only = "\n".join(_code_only((f).read_text(encoding="utf-8")) for f in sorted(src.rglob("*.py")))
    # non-vacuous sentinel: a live symbol that must survive the strip, else the strip ate everything.
    assert "encode_flac_argv" in code_only, (
        "comment/docstring strip removed live code — the STEM_BITRATE guard would pass vacuously"
    )
    for dead in ("STEM_BITRATE", "encode_stem_argv"):
        assert dead not in code_only, (
            f"{dead} still reaches code in apps/worker/src — pointing PublishStems at encode_flac_argv "
            "made the AAC vocals path dead and it was removed; nothing consumes the AAC bitrate knob now"
        )

    # And the current reality must be positively stated where the policy lives: both stems are FLAC.
    demucs_src = (src / "separation" / "demucs.py").read_text(encoding="utf-8")
    assert "Used for BOTH stems" in demucs_src, (
        "encode_flac_argv must state it encodes BOTH stems"
    )


def test_the_key_detect_band_floor_comment_does_not_misstate_the_rfft_resolution_limit():
    """The _MIN_MIDI band-floor comment justified the floor with arithmetic that was wrong
    by 18 semitones and is exactly the kind of reasoning the next person to touch the chromagram trusts.

    The constant (_MIN_MIDI = 24, C1, 32.7Hz) is CORRECT and measured. What was false:
    (1) that below C1 the rfft bin spacing is coarser than a semitone (the crossover is actually ~90Hz /
    MIDI ~42 at frame=8192, so the band's lowest 18 semitones are BELOW the limit, not above it); and
    (2) that the floor keeps sub-bass rumble out (the band starts at 32.7Hz, which IS sub-bass). There is
    no behaviour to test, so this pins the prose: the false clauses stay gone and the true reason (the
    floor bounds the fold and deliberately reaches below the resolution limit) stays stated. It also pins
    the crossover arithmetic to the code's own defaults, so a future `frame` change surfaces here.
    """
    src = Path(__file__).resolve().parents[1] / "src"
    key_detect_src = (src / "analysis" / "key_detect.py").read_text(encoding="utf-8")

    # (1) The false "coarser than a semitone below C1 / unreliable fold" justification must not reappear.
    for banned in ("bin spacing is coarser than a semitone", "the fold is unreliable"):
        assert banned not in key_detect_src, (
            f"key_detect.py still justifies _MIN_MIDI with the false clause {banned!r} — the resolution "
            "crossover is ~90Hz/MIDI ~42, not the C1 floor"
        )
    # (2) The false "keeps sub-bass out" justification must not reappear: the band STARTS in sub-bass.
    assert "keeps sub-bass rumble and hiss out" not in key_detect_src, (
        "key_detect.py still claims the band floor keeps sub-bass out — the band starts at 32.7Hz, which "
        "is sub-bass, and sums raw magnitudes there"
    )
    # The true reason must be NAMED where the constant lives, not merely absent: the floor bounds the
    # fold and reaches below the resolution limit on purpose.
    assert "BOUND the fold" in key_detect_src, (
        "key_detect.py must state that the floor bounds the fold"
    )
    assert "BELOW the rfft resolution limit" in key_detect_src, (
        "key_detect.py must state the floor sits below the resolution limit on purpose"
    )

    # Pin the arithmetic to the code's own defaults so a future `frame` change surfaces HERE: the
    # semitone-equals-one-bin crossover is ~MIDI 42, ~18 semitones above the _MIN_MIDI = 24 floor.
    import numpy as np

    from src.analysis.key_detect import _MIN_MIDI

    frame, sample_rate = 8192, 44100
    bin_hz = sample_rate / frame
    # crossover freq where a semitone (f*(2**(1/12)-1)) first equals one bin, in MIDI
    f_cross = bin_hz / (2 ** (1 / 12) - 1)
    midi_cross = 69.0 + 12.0 * np.log2(f_cross / 440.0)
    assert _MIN_MIDI == 24, "this floor was measured as correct; do not change the constant"
    assert 41.0 < midi_cross < 42.5, (
        f"resolution crossover moved to MIDI {midi_cross:.2f}; the band-floor comment "
        "quotes ~MIDI 42 at frame=8192 and must be re-derived if `frame` changed"
    )
    assert midi_cross - _MIN_MIDI > 15, (
        "the comment's whole point is that the band reaches ~18 semitones below the "
        f"resolution limit; that gap is now only {midi_cross - _MIN_MIDI:.1f} semitones"
    )


def test_the_separation_seam_note_points_at_the_real_current_sites():
    """The separation domain header's KNOWN SEAM PROBLEM paragraph recorded the seam at
    three sites that no longer exist and said the fixing refactor was still pending.

    Every claim was false at HEAD: (1) "`roformer` does `from . import demucs as d`" — roformer.py imports
    only os; that line lives in engines.py:25. (2) "`acquisition/fetch` ... reach[es] in" — fetch.py's own
    header states download_argv/parse_ytdlp_progress live THERE now, lifted out by S3. (3) "`../whisperx`
    reach[es] in" — apps/worker/src/whisperx.py was dissolved in S0-S6 and does not exist. (4) "S3 lifts
    them out; this stage only moved files, so the borrowing is unchanged" — 8f7212c (S3) already removed the
    demucs import from roformer.py, so the header described a pending refactor that had landed.

    There is no behaviour to test, so this pins the prose: the four discredited claims stay gone and the
    header names the REAL surviving sites (the ffmpeg builders + subprocess_runner in demucs.py, consumed
    engine-agnostically by steps/separate.py and dial_home.py). The related secondary line — the silence
    probe listed under WHAT BELONGS HERE though it lives in processor.py — is also corrected here.
    """
    init_doc = importlib.import_module("src.separation").__doc__ or ""
    lowered = init_doc.lower()

    # ── BAN the four discredited claims (each was disproven against HEAD) ──────────────────────────
    # (1) The claim that roformer borrows demucs via its own import. roformer.py imports only os; the
    #     line lives in engines.py. The corrected header may MENTION the removed line, but must not
    #     assert roformer performs it. Ban the specific subject-verb-object phrasing.
    assert "`roformer` does `from . import demucs as d`" not in init_doc, (
        "separation/__init__.py again claims roformer imports demucs — that import lives in engines.py:25, "
        "not roformer.py"
    )
    # (2)/(3) The whisperx module was dissolved; the header must not reach for it as a live site.
    assert "whisperx" not in lowered, (
        "separation/__init__.py again names ../whisperx as reaching into the seam — that module was "
        "dissolved in S0-S6 and does not exist"
    )
    # (4) The header must not describe S3 as a pending future that would fix the borrowing — S3 landed.
    assert "lifts them out; this stage only moved files" not in init_doc, (
        "separation/__init__.py again says the S3 refactor is pending — 8f7212c (S3) already removed the "
        "demucs import from roformer.py and lifted the yt-dlp half to acquisition/fetch.py"
    )

    # ── PRESENCE: the header must point at the REAL surviving seam ────────────────────────────────
    # The yt-dlp half was lifted; acquisition/fetch.py owns download_argv now.
    assert "acquisition/fetch.py" in init_doc, (
        "separation/__init__.py must state that S3 lifted the yt-dlp half to acquisition/fetch.py"
    )
    # The ffmpeg half is what remains, consumed engine-agnostically at the two real current sites.
    assert "steps/separate.py" in init_doc, (
        "separation/__init__.py must name steps/separate.py as a real consumer of the demucs.py ffmpeg "
        "builders on a roformer cook"
    )
    assert "dial_home.py" in init_doc, (
        "separation/__init__.py must name dial_home.py as a real consumer of demucs.py's subprocess_runner "
        ""
    )

    # ── SECONDARY (:12-13): the silence probe is not in separation/, it is in processor.py ────────
    assert "processor.py" in init_doc, (
        "separation/__init__.py must state that the silence probe (volumedetect_argv/parse_max_volume_db/"
        "is_silent/SILENCE_FLOOR_DB) lives in processor.py, not here"
    )


def test_no_docstring_claims_step_timings_reach_the_metrics_page():
    """Three docstrings justified structural decisions with observability the code does not
    deliver. The runner measures `ctx.out.timings_sec[step.name]` per step (runner.py) and puts it on the
    wire as the `stepTimingsSec` fact (runner.py `setdefault`), but the core drops it: `pickFacts`'s
    allowlist (apps/core/src/server/jobs/attempts.ts) keeps eight keys and `stepTimingsSec` is not among
    them, and `ResolvedFacts` (packages/shared/src/core/events.ts) does not declare it. So `/metrics` gains no
    per-step resolution from it and structurally cannot until the core is wired for it — a separate,
    owner-gated change (a second branch of the same work; another open request wants the same data).

    Production behaviour is correct; only the three claims were false, so this pins the prose. The false
    `/metrics`-resolution clauses stay gone and the corrected framing (measured for the worker's own log /
    not yet surfaced) stays stated, so reverting either docstring reds this test.
    """
    src = Path(__file__).resolve().parents[1] / "src"
    runner_src = (src / "runtime" / "runner.py").read_text(encoding="utf-8")
    plans_src = (src / "plans.py").read_text(encoding="utf-8")

    # ── BAN the three discredited claims at their exact sites ──────────────────────────────────────
    # runner.py:12 — "which is what finally gives the internal metrics page real resolution".
    assert "gives the internal metrics page real resolution" not in runner_src, (
        "runner.py again claims per-step timing gives the internal metrics page real resolution — the core "
        "drops stepTimingsSec at its fact allowlist (attempts.ts pickFacts), so /metrics gets "
        "none"
    )
    # plans.py:69 — ProbeSilence "its cost shows up in `/metrics`".
    assert "its cost shows up in `/metrics`" not in plans_src, (
        "plans.py again claims ProbeSilence's cost shows up in /metrics — the step timing is dropped by the "
        "core's fact allowlist and never reaches the metrics page"
    )
    # plans.py:72 — KeyAndRange "so nothing could see what it cost", implying that as a step something can.
    assert "so nothing could see what it cost" not in plans_src, (
        "plans.py again ends the KeyAndRange rationale with 'so nothing could see what it cost', implying a "
        "step's cost is now observable — it is measured but not surfaced (dropped at the "
        "allowlist)"
    )

    # ── PRESENCE: the corrected framing must be NAMED, not merely absent, so a revert reds this test ─
    # runner.py must state the timing is for the worker's own job:complete log and that the core drops it.
    assert "job:complete" in runner_src and "the core drops it" in runner_src, (
        "runner.py must state per-step timing rides the job:complete payload for the worker's own log and "
        "that the core drops it at its fact allowlist"
    )
    # plans.py must state KeyAndRange's cost is measured but not yet surfaced.
    assert "not yet surfaced" in plans_src, (
        "plans.py must state KeyAndRange's cost is now measured but not yet surfaced anywhere "
        "(the core drops "
        "it at its fact allowlist)"
    )

    # Sanity: the ban regex must actually match the OLD text, and not match the corrected text. Prove it
    # against reconstructed original clauses so the guard cannot silently rot into a tautology.
    _old_runner = "  * per-step timing, which is what finally gives the internal metrics page real resolution"
    _old_plans_probe = "engines get it, its cost shows up in `/metrics`, and it is testable with no ffmpeg."
    _old_plans_kar = "`profiler` parameters, so nothing could see what it cost."
    assert "gives the internal metrics page real resolution" in _old_runner
    assert "its cost shows up in `/metrics`" in _old_plans_probe
    assert "so nothing could see what it cost" in _old_plans_kar
