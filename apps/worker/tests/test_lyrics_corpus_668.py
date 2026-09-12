"""The real lyrics corpus: what real song structure pins that an inline string cannot.

`apps/worker/tests/` had no lyrics fixtures at all; every input across the six lyrics test files was an
inline Python string. That is enough to pin an invariant and not enough to calibrate a threshold,
because position and repetition are properties of real song structure — where a chorus recurs, how many
times, how long a tail runs — so a number tuned against invented text is tuned against whoever typed it.

`fixtures/lyrics/` now holds eight artifacts taken verbatim off a real party's media store, with
provenance in `manifest.json` and the source snapshot in `README.md`. This file is what makes them
load-bearing rather than eight files nobody reads: every specimen is consumed here, through the real
production functions in `src/lyrics/chain.py` and `src/lyrics/artifact.py`, and deleting any one of them
reds this module.

Four things are guarded.

1. **Provenance cannot rot silently.** Every manifest specimen exists, hashes to its recorded sha256,
   parses as a published lyrics artifact, and is named in the README — and the README carries the
   snapshot branch and commit. The owner's ruling made that table the whole mechanism: a stale commit
   makes the other 22 artifacts unreachable in practice and turns every file here into a blob.

2. **`OVERSHOOT_FRACTION_MAX` is separated by real data, not by two quoted numbers.** The two
   wrong-version picks are labelled *by construction* — their own timings run past the end of their own
   audio, which needs no human judgement — and five same-recording specimens supply the negatives the
   constant's comment never had.

3. **The overshoot demotion flips a real pair.** A wrong-version pick scoring higher than a clean rival
   is the outcome the overshoot penalty exists to prevent, and the two real specimens make that argmax measurable.

4. **The coverage threshold is honestly NOT calibrated here.** `chain.py` says to re-derive
   `SUSPECT_COVERAGE` once this corpus lands. It cannot be: the archive holds exactly one same-audio
   pair, cross-language, measuring 0.0 — one point at the extreme, not a band. The pair count is pinned
   at one, so the day an interior pair arrives this reds and the README's calibration section has to be
   rewritten with a real number instead of a claim.

Expected values are literals read off the committed bytes or computed by hand, never re-derived with the
operation under test: the overshoot assertions carry the raw `last_end` seconds and hand-computed
fractions rather than dividing the way `overshoot_penalized` does.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import pytest

from src.lyrics.artifact import is_valid_lyrics
from src.lyrics.chain import (
    MIN_TOKENS_TO_COMPARE,
    OVERSHOOT_FRACTION_MAX,
    ROLE_BASELINE,
    ROLE_CANDIDATE,
    SUSPECT_COVERAGE,
    TIMING_WORD,
    LyricsText,
    agreement,
    candidate_last_end,
    lyrics_tokens,
    overshoot_penalized,
)

CORPUS = Path(__file__).resolve().parent / "fixtures" / "lyrics"
MANIFEST = CORPUS / "manifest.json"
README = CORPUS / "README.md"

#: The snapshot the corpus was cut from. Duplicated from the manifest ON PURPOSE: this is the one fact
#: whose loss makes the rest of the archive unreachable, so the test states it independently rather than
#: reading it from the file it is checking.
SNAPSHOT_BRANCH = "debug_real_data_e2bc8c16710db759137379a47efa9b3ab7f63f11"
SNAPSHOT_COMMIT = "e5ffab6"


def _read_json(path: Path) -> dict[str, Any]:
    doc: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return doc


def _manifest() -> dict[str, Any]:
    return _read_json(MANIFEST)


def _specimens() -> dict[str, dict[str, Any]]:
    return {s["file"]: s for s in _manifest()["specimens"]}


def _artifact(name: str) -> dict[str, Any]:
    """One committed lyrics artifact, exactly as the media store holds it."""
    return _read_json(CORPUS / name)


def _as_text(name: str, role: str) -> LyricsText:
    """A specimen rehydrated into the shape selection judges.

    A published artifact's `lines` ARE `LyricsText.segments` — same keys, same timing — which is why the
    corpus can be committed verbatim off disk instead of in a test-only shape.
    """
    spec = _specimens()[name]
    doc = _artifact(name)
    return LyricsText(
        text_source=spec["kind"],
        segments=doc["lines"],
        timing=TIMING_WORD,
        language=doc.get("language"),
        role=role,
    )


# ── 1. provenance ────────────────────────────────────────────────────────────────────────


def test_every_manifest_specimen_is_present_byte_pinned_and_a_real_artifact() -> None:
    """The corpus is what the manifest says it is, or the suite says so.

    sha256 rather than a shape check: the measured numbers below are properties of these exact bytes, so
    a re-export that changed a timing by a millisecond has to announce itself here rather than silently
    moving a calibration. `is_valid_lyrics` is the production bar for a word-timed artifact and is
    asserted per specimen from the manifest, since the line-only caption track is deliberately not one.
    """
    specimens = _specimens()
    assert specimens, "the manifest must list the corpus, not be an empty shell"

    for name, spec in specimens.items():
        path = CORPUS / name
        assert path.exists(), f"{name} is in the manifest and missing from disk"
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        assert digest == spec["sha256"], f"{name} bytes moved: {digest} != recorded {spec['sha256']}"

        doc = _artifact(name)
        assert set(doc) == {"language", "lines", "words"}, (
            f"{name} must be a published lyrics artifact, verbatim off the media store"
        )
        assert len(doc["lines"]) == spec["lines"], f"{name} line count disagrees with its manifest row"
        assert len(doc["words"]) == spec["words"], f"{name} word count disagrees with its manifest row"

    on_disk = {p.name for p in CORPUS.glob("*.json")} - {"manifest.json"}
    assert on_disk == set(specimens), (
        "every committed specimen needs a manifest row and vice versa — an unexplained blob is exactly "
        f"what the provenance rule exists to prevent (on disk only: {sorted(on_disk - set(specimens))}, "
        f"manifest only: {sorted(set(specimens) - on_disk)})"
    )


def test_the_readme_names_the_snapshot_and_every_specimen_in_it() -> None:
    """The README's honesty is the mechanism, so it is checked rather than trusted.

    A fixture whose source commit has drifted out of the README is unreachable in practice: the other 22
    artifacts and 2273 sidecars on that branch can no longer be found from here. The branch and commit
    are asserted as literals held in THIS file, so an edit to the README alone cannot satisfy it.
    """
    prose = README.read_text(encoding="utf-8")
    assert SNAPSHOT_BRANCH in prose, "the README must name the snapshot BRANCH the corpus was cut from"
    assert SNAPSHOT_COMMIT in prose, "the README must name the snapshot COMMIT the corpus was cut from"

    manifest = _manifest()
    assert manifest["snapshotBranch"] == SNAPSHOT_BRANCH
    assert manifest["snapshotCommit"] == SNAPSHOT_COMMIT

    for name, spec in _specimens().items():
        assert name in prose, f"{name} must be explained in the README, not just listed in the manifest"
        assert spec["pins"].strip(), f"{name} must record WHAT it pins, or it is an unexplained blob"
        assert spec["mediaId"] and spec["sourceRef"], f"{name} must keep its trace back to the snapshot"


# ── 2. the overshoot band, from real wrong-version picks ──────────────────────────────────

#: Every timed specimen with the raw seconds its own timings reach, and the audio it was fetched for.
#: Literals read off the committed bytes — not computed here with the arithmetic under test.
_LAST_END_SEC = {
    "wrong-version-overshoot-total-eclipse.json": (373.800, 268),
    "wrong-version-overshoot-friends-in-low-places.json": (357.130, 281),
    "clean-control-since-u-been-gone.json": (185.000, 191),
    "junk-glyph-line-skyfall.json": (274.881, 290),
    "caption-word-legends-never-die.json": (223.503, 236),
    "caption-line-mr-brightside.json": (176.160, 224),
    "same-audio-pair-japanese-goblin-captions.json": (239.379, 244),
}

#: Hand-computed from the pair above: (373.8 - 268) / 268 and (357.13 - 281) / 281.
_WRONG_VERSION_FRACTION = {
    "wrong-version-overshoot-total-eclipse.json": 0.394776,
    "wrong-version-overshoot-friends-in-low-places.json": 0.270925,
}


@pytest.mark.parametrize(("name", "expected"), sorted(_LAST_END_SEC.items()))
def test_candidate_last_end_reads_the_real_timings_off_each_specimen(
    name: str, expected: tuple[float, int]
) -> None:
    """The production reader agrees with the seconds the committed bytes carry.

    This is the input to every overshoot number below, so it is pinned separately: if `candidate_last_end`
    ever read the flattened word list instead of the segments, the line-only caption track would report
    None and the band test would pass by measuring nothing.
    """
    last_end, _duration = expected
    assert candidate_last_end(_as_text(name, ROLE_CANDIDATE)) == pytest.approx(last_end, abs=1e-3)


def test_the_real_overshoot_band_separates_wrong_version_from_same_recording() -> None:
    """The two classes are 0.271 apart with nothing in between, and 0.10 sits in the gap.

    The constant's own comment quotes +39% and +27% from the issue that filed it. These are those two
    numbers measured through the production reader on committed bytes, plus five real negatives the
    comment did not have — which is the half that stops an overshoot guard passing vacuously by flagging
    everything.

    The margins are asserted, not just the verdicts: a threshold that merely happens to separate this
    corpus by 0.001 would be luck, and the assertion would not say so.
    """
    fractions: dict[str, float] = {}
    for name, (last_end, duration) in _LAST_END_SEC.items():
        fractions[name] = max(0.0, last_end - duration) / duration

    wrong = {n: f for n, f in fractions.items() if n in _WRONG_VERSION_FRACTION}
    clean = {n: f for n, f in fractions.items() if n not in _WRONG_VERSION_FRACTION}
    assert len(wrong) == 2, "the band needs both labelled wrong-version picks"
    assert len(clean) == 5, "the band needs the same-recording negatives too"

    for name, expected in _WRONG_VERSION_FRACTION.items():
        assert fractions[name] == pytest.approx(expected, abs=1e-5)

    assert all(f == 0.0 for f in clean.values()), (
        f"every same-recording specimen must overshoot by exactly nothing, got {clean}"
    )

    nearest_wrong = min(wrong.values())
    assert OVERSHOOT_FRACTION_MAX < nearest_wrong, (
        f"OVERSHOOT_FRACTION_MAX={OVERSHOOT_FRACTION_MAX} must flag both real wrong-version picks"
    )
    assert nearest_wrong - OVERSHOOT_FRACTION_MAX > 0.15, (
        "the nearest wrong-version case must clear the threshold with real margin, not by a hair: "
        f"{nearest_wrong:.6f} - {OVERSHOOT_FRACTION_MAX} = {nearest_wrong - OVERSHOOT_FRACTION_MAX:.6f}"
    )
    assert OVERSHOOT_FRACTION_MAX - max(clean.values()) >= 0.10, (
        "and it must sit clear of the clean floor, so a same-recording pick is never demoted"
    )


def test_the_overshoot_demotion_flips_a_real_wrong_version_pick_against_a_real_clean_rival() -> None:
    """A wrong-version pick that RANKS HIGHER still loses, which is the outcome the overshoot penalty is for.

    Detection without re-selection made things worse (`chain.py`'s own selection note), so the guarded
    behaviour is the argmax, not the flag. Real specimens on both sides: Total Eclipse timed to a 374s
    master against 268s of audio, versus Kelly Clarkson fitting inside her own audio. The raw scores are
    deliberately stacked AGAINST the correct pick — 0.90 for the wrong version, 0.55 for the rival — so
    only the demotion can produce the right winner.
    """
    wrong = _as_text("wrong-version-overshoot-total-eclipse.json", ROLE_CANDIDATE)
    rival = _as_text("clean-control-since-u-been-gone.json", ROLE_CANDIDATE)

    wrong_penalized = overshoot_penalized(0.90, wrong, 268.0)
    rival_penalized = overshoot_penalized(0.55, rival, 191.0)

    assert wrong_penalized < rival_penalized, (
        "the wrong-version pick must lose to a rival that fits the audio: "
        f"{wrong_penalized:.6f} vs {rival_penalized:.6f}"
    )
    assert rival_penalized == 0.55, "a candidate inside its own audio must not be demoted at all"
    assert overshoot_penalized(0.90, wrong, None) == 0.90, (
        "an unknown duration means no judgement is possible — fail open, as coverage does"
    )


# ── 3. the coverage threshold this corpus does NOT calibrate ──────────────────────────────


def test_the_only_real_same_audio_pair_votes_at_coverage_zero_and_cannot_calibrate_the_threshold() -> None:
    """`SUSPECT_COVERAGE` still needs the `baselines/` half, and this is the proof.

    `chain.py` says to re-derive the constant once this corpus lands. It cannot be re-derived from these
    files: a coverage threshold needs real (candidate, baseline) pairs and the archive holds exactly one,
    whose two texts are in different languages. Measured coverage is 0.0 — one point at the extreme end,
    which constrains a threshold no better than no point at all.

    The degenerate baseline is the sharp part. 1594 words crammed into 12 `ja` lines still leaves 30
    DISTINCT tokens against a floor of 12, so it clears `MIN_TOKENS_TO_COMPARE` and VOTES instead of
    abstaining. Abstention is what makes a weak baseline safe to include; a distinct-token floor does not
    deliver it for a transcript this repetitive.

    The pair count is pinned at one on purpose: when a specimen with interior coverage is added, this
    reds and the README's calibration section has to be rewritten with a real band.
    """
    by_media: dict[str, list[str]] = {}
    for name, spec in _specimens().items():
        by_media.setdefault(spec["mediaId"], []).append(name)
    pairs = {mid: sorted(files) for mid, files in by_media.items() if len(files) > 1}

    assert len(pairs) == 1, (
        "the corpus holds exactly ONE same-audio pair; add an interior-coverage pair and rewrite the "
        f"README's SUSPECT_COVERAGE section rather than leaving it stale (found {pairs})"
    )

    baseline = _as_text("same-audio-pair-japanese-goblin-asr.json", ROLE_BASELINE)
    candidate = _as_text("same-audio-pair-japanese-goblin-captions.json", ROLE_CANDIDATE)

    baseline_distinct = len(set(lyrics_tokens(baseline.plain_text)))
    assert baseline_distinct >= MIN_TOKENS_TO_COMPARE, (
        f"the degenerate baseline clears the floor ({baseline_distinct} distinct >= "
        f"{MIN_TOKENS_TO_COMPARE}) and therefore votes — that is the finding, not an accident"
    )

    got = agreement(candidate.plain_text, baseline.plain_text)
    assert got is not None, "a baseline over the floor does not abstain, so a verdict is returned"
    assert got.coverage == 0.0, (
        f"the only real pair measures at the extreme, not in a calibratable band: {got.coverage}"
    )
    assert got.coverage < SUSPECT_COVERAGE, "so it lands on the suspect side by the widest possible margin"


# ── 4. real shapes an inline string never produces ────────────────────────────────────────


def test_a_real_line_whose_whole_text_is_a_music_glyph_tokenises_to_nothing() -> None:
    """Real authoritative text opens with a bare music glyph, and it is a TIMED line.

    Not a hypothetical: Adele's Skyfall lyrics as the provider serves them begin with a glyph and no
    words, and that line reaches the tokeniser, the aligner and the TV. It carries a timed word, so it
    is not filtered as empty upstream. What must hold is that it contributes nothing to the token stream
    the agreement metric compares — dropping it leaves the stream byte-identical — so a glyph line can
    neither depress coverage nor buy a candidate rank.
    """
    doc = _artifact("junk-glyph-line-skyfall.json")
    first = doc["lines"][0]

    assert first["text"].strip() == "\N{MULTIPLE MUSICAL NOTES}", "specimen must still open with the glyph"
    assert lyrics_tokens(first["text"]) == [], "a glyph-only line contributes no comparable tokens"
    assert len(first["words"]) == 1, "and it is a timed line, so nothing upstream drops it as empty"

    whole = lyrics_tokens("\n".join(line["text"] for line in doc["lines"]))
    without_glyph_line = lyrics_tokens("\n".join(line["text"] for line in doc["lines"][1:]))
    assert whole == without_glyph_line, "the glyph line must not shift the token stream it sits in"
    assert len(whole) == 287, "and the rest of the real text still tokenises (a hand-counted literal)"


def test_the_real_line_only_caption_track_is_not_a_word_timed_artifact_and_the_word_one_is() -> None:
    """Two real caption tracks of the same tier, one line-only and one word-level.

    `is_valid_lyrics` is the forced-alignment success bar — at least one line with at least one timed
    word — and line-level sync is the floor case that must stay on the other side of it. Every input in
    the existing lyrics tests is an inline word-timed string, so nothing in the suite could catch a
    regression that let a line-only track through as word-timed. These two make it measurable.
    """
    line_only = _artifact("caption-line-mr-brightside.json")
    word_level = _artifact("caption-word-legends-never-die.json")

    assert line_only["words"] == [], "the line-only track carries no timed words at all"
    assert all(line["words"] == [] for line in line_only["lines"]), "not on its lines either"
    assert all(line.get("start") is not None for line in line_only["lines"]), "but every LINE is timed"
    assert is_valid_lyrics(line_only) is False, "so it is not a word-timed artifact"

    assert len(word_level["words"]) == 252, "the word-level track of the same tier carries timed words"
    assert is_valid_lyrics(word_level) is True, "so it clears the bar the line-only track does not"
