"""Guards on the worker's package structure: domains/runtime/steps (docs/ARCHITECTURE.md §7.1).
Packaging has failure modes that are silent until something far away breaks, so they are pinned here.
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

#: The HOST layer: what this box is, and what the operator told it. A third category on purpose — it is
#: neither a domain (it owns no pipeline concern) nor runtime (it executes nothing). It is measured facts
#: plus configuration, and everything else is allowed to read it.
HOST_PACKAGES = ["host"]

ALL_PACKAGES = DOMAIN_PACKAGES + RUNTIME_PACKAGES + HOST_PACKAGES

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
    """A mis-merged `git mv` plus a re-export can leave one module importable under two names, so two
    copies of the same class exist and `isinstance` starts failing in ways that look like anything
    except a packaging mistake."""
    for name in MOVED_AWAY:
        assert not (Path(__file__).resolve().parents[1] / "src" / f"{name}.py").exists(), (
            f"src/{name}.py still exists — it was supposed to move into a package"
        )


def test_no_package_reexport_SHADOWS_one_of_its_own_submodules():
    """A package that re-exports a member with the SAME NAME as one of its own submodules shadows the
    submodule in its own namespace: `from src.metadata import annotate` would resolve to a re-exported
    function rather than the `annotate` submodule, and accessing a submodule attribute on it raises
    an AttributeError that says nothing about the real cause.
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
    """Pins the separation domain's audio policy prose against two false claims that would RELAX it:
    (1) the vocals stem is NOT unplayed — it is the guiding track the TV mixes under the instrumental
    and pitch-shifts with the key, so the reason must be named, not merely the false claim absent.
    (2) The AAC vocals path (STEM_BITRATE / encode_stem_argv / ENCORE_STEM_BITRATE) is dead now that
    both stems encode through encode_flac_argv, so those names must not reappear anywhere in worker/src.
    """
    src = Path(__file__).resolve().parents[1] / "src"

    # (1) The "nothing plays it" clause is false and must not reappear at any of its three former sites.
    init_doc = importlib.import_module("src.separation").__doc__ or ""
    separate_src = (src / "steps" / "separate.py").read_text(encoding="utf-8")
    for name, text in (("separation/__init__.py", init_doc), ("steps/separate.py", separate_src)):
        assert "nothing plays" not in text, (
            f"{name} still claims the vocals stem is unplayed — it is the guiding track"
        )
    # The true reason must be stated where the policy lives, not merely absent.
    assert "GUIDING TRACK" in init_doc, "separation/__init__.py must name the guiding track as the reason"
    assert "GUIDING TRACK" in separate_src, "steps/separate.py must name the guiding track as the reason"

    # (2) STEM_BITRATE and encode_stem_argv must not reappear anywhere in worker/src, with line
    # comments and docstrings stripped (so retired-policy prose can neither satisfy nor trip this). A
    # sentinel proves the strip did not silently blank the corpus.
    def _code_only(text):
        # drop triple-quoted blocks (docstrings), then drop line comments
        parts = text.split('"""')
        no_doc = "".join(parts[::2]) if len(parts) % 2 == 1 else text
        return "\n".join(ln.split("#", 1)[0] for ln in no_doc.splitlines())

    code_only = "\n".join(_code_only((f).read_text(encoding="utf-8")) for f in sorted(src.rglob("*.py")))
    # non-vacuous sentinel: a live symbol that must survive the strip, else the strip ate everything.
    assert "encode_flac_argv" in code_only, (
        "comment/docstring strip removed live code — the STEM_BITRATE guard would pass vacuously"
    )
    for dead in ("STEM_BITRATE", "encode_stem_argv"):
        assert dead not in code_only, f"{dead} still reaches code in worker/src — nothing consumes it now"

    # And the current reality must be positively stated where the policy lives: both stems are FLAC.
    demucs_src = (src / "separation" / "demucs.py").read_text(encoding="utf-8")
    assert "Used for BOTH stems" in demucs_src, "encode_flac_argv must state it encodes BOTH stems"


def test_the_key_detect_band_floor_comment_does_not_misstate_the_rfft_resolution_limit():
    """Pins the `_MIN_MIDI` band-floor comment's prose against two false justifications: (1) that the
    rfft bin spacing below C1 is coarser than a semitone (the real crossover is ~MIDI 42 at
    frame=8192, so the floor's lowest ~18 semitones are BELOW that limit, not above it), and (2) that
    the floor keeps sub-bass rumble out (the band starts at 32.7Hz, which IS sub-bass). The constant
    itself (_MIN_MIDI=24) is correct; only its justification was wrong. Also pins the crossover
    arithmetic to the code's own defaults, so a future `frame` change surfaces here.
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
    assert "BOUND the fold" in key_detect_src, "key_detect.py must state that the floor bounds the fold"
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
    """Pins the separation domain header's seam-note prose against four claims false at HEAD:
    roformer.py does not import demucs (that import lives in engines.py); whisperx.py does not exist
    (dissolved); and the described refactor pending is not pending — it landed. The header must
    instead name the REAL surviving sites (ffmpeg builders + subprocess_runner in demucs.py, consumed
    by steps/separate.py and dial_home.py), and must say the silence probe lives in processor.py, not here.
    """
    init_doc = importlib.import_module("src.separation").__doc__ or ""
    lowered = init_doc.lower()

    # (1) roformer.py imports only os; that import line lives in engines.py, not roformer.py.
    assert "`roformer` does `from . import demucs as d`" not in init_doc, (
        "separation/__init__.py again claims roformer imports demucs — that import lives in engines.py:25, "
        "not roformer.py"
    )
    # (2)/(3) The whisperx module was dissolved; the header must not reach for it as a live site.
    assert "whisperx" not in lowered, (
        "separation/__init__.py again names ../whisperx as reaching into the seam, but that module "
        "does not exist"
    )
    # (4) The header must not describe the borrowing-fix refactor as pending — it already landed.
    assert "lifts them out; this stage only moved files" not in init_doc, (
        "separation/__init__.py again says the refactor is pending — it already removed the demucs "
        "import from roformer.py and lifted the yt-dlp half to acquisition/fetch.py"
    )

    # PRESENCE: the header must point at the REAL surviving seam.
    assert "acquisition/fetch.py" in init_doc, (
        "separation/__init__.py must state that S3 lifted the yt-dlp half to acquisition/fetch.py"
    )
    # The ffmpeg half is what remains, consumed engine-agnostically at the two real current sites.
    assert "steps/separate.py" in init_doc, (
        "separation/__init__.py must name steps/separate.py as a real consumer of the demucs.py ffmpeg "
        "builders on a roformer process"
    )
    assert "dial_home.py" in init_doc, (
        "separation/__init__.py must name dial_home.py as a real consumer of demucs.py's subprocess_runner "
    )

    # SECONDARY: the silence probe is not in separation/, it is in processor.py.
    assert "processor.py" in init_doc, (
        "separation/__init__.py must state that the silence probe (volumedetect_argv/parse_max_volume_db/"
        "is_silent/SILENCE_FLOOR_DB) lives in processor.py, not here"
    )


def test_no_docstring_claims_step_timings_reach_the_metrics_page():
    """Pins three docstrings' prose against a false observability claim: the runner measures per-step
    timing and puts it on the wire as the `stepTimingsSec` fact, but the core's `pickFacts` allowlist
    (src/lib/server/jobs/attempts.ts) drops it, so `/metrics` gains no per-step resolution from it.
    Production behaviour is correct; only the claim that this data reaches `/metrics` was false.
    """
    src = Path(__file__).resolve().parents[1] / "src"
    runner_src = (src / "runtime" / "runner.py").read_text(encoding="utf-8")
    plans_src = (src / "plans.py").read_text(encoding="utf-8")

    # Ban the three discredited claims at their exact sites.
    assert "gives the internal metrics page real resolution" not in runner_src, (
        "runner.py again claims per-step timing gives the internal metrics page real resolution — the core "
        "drops stepTimingsSec at its fact allowlist (attempts.ts pickFacts), so /metrics gets "
        "none"
    )
    assert "its cost shows up in `/metrics`" not in plans_src, (
        "plans.py again claims ProbeSilence's cost shows up in /metrics — the step timing is dropped by the "
        "core's fact allowlist and never reaches the metrics page"
    )
    assert "so nothing could see what it cost" not in plans_src, (
        "plans.py again ends the KeyAndRange rationale implying a step's cost is now observable — it is "
        "measured but not surfaced (dropped at the allowlist)"
    )

    # PRESENCE: the corrected framing must be NAMED, not merely absent, so a revert reds this test.
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

    # Sanity: prove the ban strings actually matched the OLD text, so the guard
    # cannot silently rot into a tautology.
    _old_runner = "  * per-step timing, which is what finally gives the internal metrics page real resolution"
    _old_plans_probe = "engines get it, its cost shows up in `/metrics`, and it is testable with no ffmpeg."
    _old_plans_kar = "`profiler` parameters, so nothing could see what it cost."
    assert "gives the internal metrics page real resolution" in _old_runner
    assert "its cost shows up in `/metrics`" in _old_plans_probe
    assert "so nothing could see what it cost" in _old_plans_kar
