"""Guards on the worker's package structure.

These exist because S0 of docs/archive/specs/SPEC-worker-pipeline.md introduced packages, and packaging has two
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
DOMAIN_PACKAGES = ["acquisition", "analysis", "lyrics", "metadata", "separation"]

#: The runtime layers. These execute a plan and know nothing about audio, lyrics or separation — see
#: docs/archive/specs/SPEC-worker-pipeline.md §3. Listed separately from the domains because the layering guard
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
        p.name for p in src.iterdir() if p.is_dir() and (p / "__init__.py").exists() and not p.name.startswith("_")
    )
    assert found == sorted(ALL_PACKAGES), (
        f"packages on disk {found} != declared {sorted(ALL_PACKAGES)}. Add it to DOMAIN_PACKAGES or\n"
        f"RUNTIME_PACKAGES (and give it a docstring) if the new package is intended."
    )


def test_the_separation_audio_policy_does_not_claim_the_vocals_stem_is_unplayed():
    """Issue #85. The separation domain's audio policy is the rule that stops a reader re-encoding a stem
    badly, and its load-bearing clauses were false in the direction that RELAXES the rule.

    Two false facts had to go, at three sites: (1) "nothing plays [the vocals stem]" — the vocals stem is
    the guiding track, a second <audio> the TV mixes under the instrumental at up to full gain and pitch-
    shifts with the key (apps/core/src/lib/tv/TvPlayer.svelte); (2) STEM_BITRATE is the storage format "for
    both stems" — it governs the vocals stem only (encode_stem_argv); the instrumental is FLAC through
    encode_flac_argv. There is no behaviour to test, so this pins the prose instead: the false clauses stay
    gone and the true reason (the guiding track) stays named."""
    src = Path(__file__).resolve().parents[1] / "src"

    # (1) The "nothing plays it" clause is false and must not reappear at any of its three former sites.
    init_doc = importlib.import_module("src.separation").__doc__ or ""
    separate_src = (src / "steps" / "separate.py").read_text(encoding="utf-8")
    for name, text in (("separation/__init__.py", init_doc), ("steps/separate.py", separate_src)):
        assert "nothing plays" not in text, (
            f"{name} still claims the vocals stem is unplayed — it is the guiding track (issue #85)"
        )
    # The true reason must be stated where the policy lives, not merely absent.
    assert "GUIDING TRACK" in init_doc, "separation/__init__.py must name the guiding track as the reason (#85)"
    assert "GUIDING TRACK" in separate_src, "steps/separate.py must name the guiding track as the reason (#85)"

    # (2) STEM_BITRATE must not be described as governing BOTH stems; it is the vocals stem only.
    demucs_src = (src / "separation" / "demucs.py").read_text(encoding="utf-8")
    assert "for both stems" not in demucs_src, (
        "demucs.py STEM_BITRATE still claims it governs both stems — it governs the vocals stem only, the "
        "instrumental is FLAC via encode_flac_argv (issue #85)"
    )


def test_the_key_detect_band_floor_comment_does_not_misstate_the_rfft_resolution_limit():
    """Issue #103. The _MIN_MIDI band-floor comment justified the floor with arithmetic that was wrong
    by 18 semitones and is exactly the kind of reasoning the next person to touch the chromagram trusts.

    The constant (_MIN_MIDI = 24, C1, 32.7Hz) is CORRECT and measured — see the issue. What was false:
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
            "crossover is ~90Hz/MIDI ~42, not the C1 floor (issue #103)"
        )
    # (2) The false "keeps sub-bass out" justification must not reappear: the band STARTS in sub-bass.
    assert "keeps sub-bass rumble and hiss out" not in key_detect_src, (
        "key_detect.py still claims the band floor keeps sub-bass out — the band starts at 32.7Hz, which "
        "is sub-bass, and sums raw magnitudes there (issue #103)"
    )
    # The true reason must be NAMED where the constant lives, not merely absent: the floor bounds the
    # fold and reaches below the resolution limit on purpose.
    assert "BOUND the fold" in key_detect_src, (
        "key_detect.py must state that the floor bounds the fold (issue #103)"
    )
    assert "BELOW the rfft resolution limit" in key_detect_src, (
        "key_detect.py must state the floor sits below the resolution limit on purpose (issue #103)"
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
    assert _MIN_MIDI == 24, "issue #103 measured this floor as correct; do not change the constant"
    assert 41.0 < midi_cross < 42.5, (
        f"resolution crossover moved to MIDI {midi_cross:.2f}; the band-floor comment (issue #103) "
        "quotes ~MIDI 42 at frame=8192 and must be re-derived if `frame` changed"
    )
    assert midi_cross - _MIN_MIDI > 15, (
        "the comment's whole point (issue #103) is that the band reaches ~18 semitones below the "
        f"resolution limit; that gap is now only {midi_cross - _MIN_MIDI:.1f} semitones"
    )

def test_the_stem_bitrate_comment_justifies_aac_by_the_vocals_stem_not_the_instrumental():
    """Issue #236. Residue of closed #85: the STEM_BITRATE comment's closing clause still justified the
    AAC-over-Opus choice by the INSTRUMENTAL's browser needs ("the instrumental has to play in a browser
    <video>, and AAC-in-m4a is the safer bet on Safari"), while the same block's opening sentence (fixed
    in #85) correctly says STEM_BITRATE governs the VOCALS stem only and the instrumental is FLAC. Both
    could not be true. The instrumental is FLAC-in-<audio> (processor.py INSTRUMENTAL_EXT, encode_flac_argv,
    apps/core/src/lib/tv/TvPlayer.svelte:5-13), so the clause reasoned about a file that does not exist.

    There is no behaviour to test, so this pins the prose. The "caller" of this guard is the test itself
    reading the real production source. It scopes both arms to the STEM_BITRATE comment block (the `# ...`
    lines immediately above the `STEM_BITRATE =` assignment), so the legitimate <video>/WebKit prose that
    now lives in encode_flac_argv's docstring can neither satisfy the presence arm nor trip the ban arm.
    """
    src_dir = Path(__file__).resolve().parents[1] / "src"
    demucs_src = (src_dir / "separation" / "demucs.py").read_text(encoding="utf-8")

    # Extract exactly the comment block directly above the STEM_BITRATE assignment.
    lines = demucs_src.splitlines()
    assign_idx = next(i for i, ln in enumerate(lines) if ln.startswith("STEM_BITRATE"))
    block = []
    i = assign_idx - 1
    while i >= 0 and lines[i].lstrip().startswith("#"):
        block.insert(0, lines[i])
        i -= 1
    block_text = "\n".join(block)
    assert block_text, "could not locate the STEM_BITRATE comment block above the assignment (#236)"

    # Presence: the block must justify the container choice by the VOCALS stem being the guiding track.
    assert "GUIDING" in block_text.upper(), (
        "the STEM_BITRATE comment must justify AAC by the vocals stem being the GUIDING TRACK, not by the "
        "instrumental's browser needs (issue #236)"
    )

    # Ban: the discredited instrumental-browser-needs justification must not reappear in this block.
    lowered = block_text.lower()
    assert "instrumental has to play" not in lowered, (
        "the STEM_BITRATE comment again justifies the vocals bitrate by the INSTRUMENTAL's playback — the "
        "instrumental is FLAC-in-<audio>, not AAC-in-m4a in a <video> (issue #236)"
    )
    assert "<video>" not in lowered, (
        "the STEM_BITRATE comment again claims a stem plays in a browser <video> — playback is through "
        "<audio> (apps/core/src/lib/tv/TvPlayer.svelte); the instrumental is FLAC (issue #236)"
    )


def test_the_separation_seam_note_points_at_the_real_current_sites():
    """Issue #237. The separation domain header's KNOWN SEAM PROBLEM paragraph recorded the seam at
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
        "not roformer.py (issue #237)"
    )
    # (2)/(3) The whisperx module was dissolved; the header must not reach for it as a live site.
    assert "whisperx" not in lowered, (
        "separation/__init__.py again names ../whisperx as reaching into the seam — that module was "
        "dissolved in S0-S6 and does not exist (issue #237)"
    )
    # (4) The header must not describe S3 as a pending future that would fix the borrowing — S3 landed.
    assert "lifts them out; this stage only moved files" not in init_doc, (
        "separation/__init__.py again says the S3 refactor is pending — 8f7212c (S3) already removed the "
        "demucs import from roformer.py and lifted the yt-dlp half to acquisition/fetch.py (issue #237)"
    )

    # ── PRESENCE: the header must point at the REAL surviving seam ────────────────────────────────
    # The yt-dlp half was lifted; acquisition/fetch.py owns download_argv now.
    assert "acquisition/fetch.py" in init_doc, (
        "separation/__init__.py must state that S3 lifted the yt-dlp half to acquisition/fetch.py (#237)"
    )
    # The ffmpeg half is what remains, consumed engine-agnostically at the two real current sites.
    assert "steps/separate.py" in init_doc, (
        "separation/__init__.py must name steps/separate.py as a real consumer of the demucs.py ffmpeg "
        "builders on a roformer cook (issue #237)"
    )
    assert "dial_home.py" in init_doc, (
        "separation/__init__.py must name dial_home.py as a real consumer of demucs.py's subprocess_runner "
        "(issue #237)"
    )

    # ── SECONDARY (:12-13): the silence probe is not in separation/, it is in processor.py ────────
    assert "processor.py" in init_doc, (
        "separation/__init__.py must state that the silence probe (volumedetect_argv/parse_max_volume_db/"
        "is_silent/SILENCE_FLOOR_DB) lives in processor.py, not here (issue #237)"
    )
