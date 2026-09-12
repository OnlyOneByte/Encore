"""The lyrics agreement metric: counts, position, and the recalibrated judgement axis.

Three things are guarded here.

1. **Parity with the TypeScript authority.** `agreement` is implemented twice (here and in
   `src/shared/lyrics/lyrics.ts`) and the two suites cannot import each other, so both read the same
   hand-computed corpus — `src/shared/lyrics/lyrics-agreement-corpus.ts`. This file SOURCE-SCANS that
   module rather than importing it, the same technique `test_lyrics_presplit.py` uses for the constants:
   the production truth is the file it parses, so it cannot be defeated by reverting a hunk.

2. **The metric counts and positions.** The two pairs symmetric set Jaccard scored a perfect 1.0 — a
   chorus said twice against audio that has it once, and identical words in reversed order — now score
   below 0.5. Those are the two blind spots this metric was filed for.

3. **The recalibration is measured, not asserted.** `SUSPECT_COVERAGE` replaced `SUSPECT_AGREEMENT` on a
   different AXIS, so the band it sits in is re-derived here from a synthetic corpus with an explicit
   ASR-degradation model, and the tests assert the SEPARATION (different-song ceiling vs correct-candidate
   floor) rather than restating the constant. The corpus is synthetic — original text, no real lyrics —
   because the real corpus from the prod snapshot is still open; what it measures is the metric's
   own systematic behaviour, which is what choosing between two axes needs.
"""

from __future__ import annotations

import dataclasses
import random
import re
from pathlib import Path

def _repo_root() -> Path:
    """The repo root, by walking up for `bunfig.toml`.

    Not a hop count: `parents[N]` encodes this file's distance from the root, and flattening the `apps/`
    layer changed that distance for every worker test at once — 15 of them failed reading files that had
    moved outside their computed root. The marker is the same file the TypeScript harness uses, so both
    sides of the repo agree on the answer by construction.
    """
    here = Path(__file__).resolve()
    for candidate in [here.parent, *here.parents]:
        if (candidate / "bunfig.toml").is_file():
            return candidate
    raise SystemExit(f"no bunfig.toml above {here}")


from src.lyrics.chain import (
    MIN_TOKENS_TO_COMPARE,
    ROLE_BASELINE,
    ROLE_CANDIDATE,
    SEQUENCE_WEIGHT,
    SOURCE_ASR,
    SOURCE_LRCLIB,
    SUSPECT_COVERAGE,
    TIMING_LINE,
    LyricsText,
    Selection,
    agreement,
    agreement_score,
    composite_score,
    lyrics_tokens,
    select_by_baselines,
)
from src.lyrics.chain import agreement as _chain_agreement


_REPO = _repo_root()
_SHARED_LYRICS_TS = _REPO / "src" / "lib" / "contract" / "lyrics" / "lyrics.ts"
_CORPUS_TS = _REPO / "src" / "lib" / "contract" / "lyrics" / "lyrics-agreement-corpus.ts"


# ── reading the TypeScript authority ─────────────────────────────────────────────────
def _ts_number(name: str) -> float:
    """The numeric literal `export const <name> = <n>;` declares in lyrics.ts."""
    text = _SHARED_LYRICS_TS.read_text(encoding="utf-8")
    found = re.search(rf"export const {re.escape(name)}\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*;", text)
    assert found, f"could not find `export const {name} = <number>;` in {_SHARED_LYRICS_TS.name}"
    return float(found.group(1))


def _ts_corpus() -> list[dict[str, object]]:
    """Parse AGREEMENT_PARITY_CORPUS out of the shared corpus module.

    Deliberately a parser and not a JSON load: the corpus is a typed TS module so the TS suite can import
    it with no tooling, and this side reads the same bytes. Every step asserts, so a shape change here is
    a loud failure telling the reader to teach this parser the new shape — never a silent skip that leaves
    the mirror unguarded.
    """
    text = _CORPUS_TS.read_text(encoding="utf-8")
    consts = dict(re.findall(r"^const (\w+) = '([^']*)';", text, re.MULTILINE))
    assert consts, f"no `const NAME = '...';` token vocabulary found in {_CORPUS_TS.name}"

    def resolve(expr: str) -> str:
        expr = expr.strip()
        if expr.startswith("`"):  # a template literal joining named consts: `${A} ${B}`
            parts = re.findall(r"\$\{(\w+)\}", expr)
            assert parts, f"template literal {expr!r} interpolates nothing this parser understands"
            for part in parts:
                assert part in consts, f"template literal references unknown const {part!r}"
            return " ".join(consts[part] for part in parts)
        assert expr in consts, f"corpus field {expr!r} is neither a known const nor a template literal"
        return consts[expr]

    def ratio(raw: str) -> float | None:
        raw = raw.strip()
        if raw == "null":
            return None
        pair = re.fullmatch(r"\[\s*(\d+)\s*,\s*(\d+)\s*\]", raw)
        assert pair, f"expected `[numerator, denominator]` or `null`, got {raw!r}"
        return int(pair.group(1)) / int(pair.group(2))

    body = re.search(
        r"export const AGREEMENT_PARITY_CORPUS[^=]*=\s*\[(.*)\];\s*$", text, re.DOTALL
    )
    assert body, f"could not find `export const AGREEMENT_PARITY_CORPUS = [...]` in {_CORPUS_TS.name}"
    cases: list[dict[str, object]] = []
    for block in re.findall(r"\{(.*?)\n\t\}", body.group(1), re.DOTALL):
        name = re.search(r"name:\s*'([^']*)'", block)
        candidate = re.search(r"candidate:\s*(`[^`]*`|\w+),", block)
        baseline = re.search(r"baseline:\s*(`[^`]*`|\w+),", block)
        assert name and candidate and baseline, f"corpus case is missing name/candidate/baseline: {block!r}"
        case: dict[str, object] = {
            "name": name.group(1),
            "candidate": resolve(candidate.group(1)),
            "baseline": resolve(baseline.group(1)),
        }
        for field in ("coverage", "fidelity", "sequence", "oldSetJaccard"):
            raw = re.search(rf"{field}:\s*(\[[^\]]*\]|null)", block)
            assert raw, f"corpus case {name.group(1)!r} is missing `{field}`"
            case[field] = ratio(raw.group(1))
        cases.append(case)
    assert len(cases) >= 4, f"expected the whole parity corpus, parsed only {len(cases)} case(s)"
    return cases


def _old_set_jaccard(a: str, b: str) -> float:
    """The metric this one REPLACED, kept here as the contrast the corpus records.

    Reimplemented in the test rather than imported, because production no longer has it. This is what
    makes the corpus's `oldSetJaccard` column checkable instead of decorative.
    """
    set_a, set_b = set(lyrics_tokens(a)), set(lyrics_tokens(b))
    return len(set_a & set_b) / len(set_a | set_b)


# ── 1. parity ────────────────────────────────────────────────────────────────────────
def test_the_thresholds_mirror_the_typescript_authority():
    """The constants are declared authoritative in lyrics.ts; assert the Python copies equal THEM.

    RED ON BASE in the other direction too: asserting a Python literal only proves Python equals itself,
    so every TS-side drift — the normal way any of these changes — would stay green on both suites.
    """
    assert MIN_TOKENS_TO_COMPARE == _ts_number("MIN_TOKENS_TO_COMPARE")
    assert SUSPECT_COVERAGE == _ts_number("SUSPECT_COVERAGE")
    assert SEQUENCE_WEIGHT == _ts_number("SEQUENCE_WEIGHT")
    # And the retired name is no longer DECLARED, so a half-finished rename cannot read as parity. Matched
    # as a declaration rather than as a substring: the new constant's docstring names the old one on
    # purpose, to tell a reader carrying 0.25 in their head that the axis moved.
    assert not re.search(
        r"export const SUSPECT_AGREEMENT\s*=", _SHARED_LYRICS_TS.read_text(encoding="utf-8")
    ), "lyrics.ts still declares SUSPECT_AGREEMENT — the rename is half-applied"


def test_python_agreement_matches_the_hand_computed_shared_corpus():
    """Every case in the shared corpus, checked against counts worked out by hand — not by this code.

    The TS suite asserts the SAME table in lyrics.test.ts, so this is the parity guard: a change to
    either implementation that the other does not receive reds one of the two suites.
    """
    for case in _ts_corpus():
        name = case["name"]
        got = agreement(str(case["candidate"]), str(case["baseline"]))
        if case["coverage"] is None:
            assert got is None, f"{name}: expected an abstention, got {got}"
            assert agreement_score(str(case["candidate"]), str(case["baseline"])) is None
            continue
        assert got is not None, f"{name}: expected a comparison, got an abstention"
        assert got.coverage == case["coverage"], f"{name}: coverage"
        assert got.fidelity == case["fidelity"], f"{name}: fidelity"
        assert got.sequence == case["sequence"], f"{name}: sequence"
        # The old metric's column is checked too, so the contrast the corpus claims is a measurement.
        assert _old_set_jaccard(str(case["candidate"]), str(case["baseline"])) == case["oldSetJaccard"], (
            f"{name}: oldSetJaccard"
        )


def test_the_rank_score_blend_is_pinned_to_a_hand_computed_value():
    """One case's rank score pinned as a DECIMAL, computed by hand: 0.5·(11/12) + 0.5·(10/11).

    The corpus checks the three components; this checks the SHAPE that combines them. Without it, both
    suites could agree on coverage/fidelity/sequence while the blend silently changed weight, dropped the
    position term, or averaged the two count directions instead of taking the weaker one.
    """
    twelve = "alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo lima"
    swapped = "alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo mike"
    got = agreement_score(twelve, swapped)
    assert got is not None
    assert abs(got - 0.9128787878787878) < 1e-12, got


# ── 2. what the new metric sees that set Jaccard could not ───────────────────────────
def test_repeated_and_reordered_text_no_longer_scores_a_perfect_agreement():
    """The two blind spots, stated as behaviour rather than as corpus rows.

    RED ON BASE: on origin/main both pairs score exactly 1.0, because token SETS are identical. The
    absolute judgement must NOT fire on either — the words are all there, so it is the same song — which
    is why coverage stays 1.0 while the ranking score drops.
    """
    twelve = "alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo lima"

    twice = agreement(f"{twelve} {twelve}", twelve)
    assert twice is not None
    assert twice.coverage == 1.0  # every audible word IS in the candidate
    assert twice.fidelity == 0.5  # but half the candidate is not audible
    assert twice.rank_score < 0.5, "saying the chorus twice must cost rank"

    reversed_words = " ".join(reversed(twelve.split()))
    backwards = agreement(twelve, reversed_words)
    assert backwards is not None
    assert backwards.coverage == 1.0 and backwards.fidelity == 1.0
    assert backwards.sequence == 0.0, "not one adjacent pair survives a full reversal"
    assert backwards.rank_score == 0.5, "position is worth exactly SEQUENCE_WEIGHT of the score"


def test_argument_order_is_load_bearing():
    """coverage and fidelity are the two DIRECTIONS of one overlap, so swapping the arguments swaps them.

    Set Jaccard was symmetric, so callers could pass either order and nothing noticed. They cannot now,
    and a caller that gets it backwards judges "is the baseline inside the candidate" — the wrong
    question. This pins the contract `composite_score(candidate, baselines)` relies on.
    """
    twelve = "alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo lima"
    forwards = agreement(f"{twelve} {twelve}", twelve)
    backwards = agreement(twelve, f"{twelve} {twelve}")
    assert forwards is not None and backwards is not None
    assert (forwards.coverage, forwards.fidelity) == (1.0, 0.5)
    assert (backwards.coverage, backwards.fidelity) == (0.5, 1.0)
    assert forwards.rank_score == backwards.rank_score  # rank itself stays symmetric


# ── 3. the measured band SUSPECT_COVERAGE sits in ────────────────────────────────────
#
# A synthetic corpus with an explicit degradation model, all original text. Not a calibration set (the real corpus
# is still open); it measures how the METRIC behaves on the three pair shapes that matter, which is what
# choosing the judgement axis and its threshold needs.

_VERSE_A = (
    "i left the harbour lights behind me on a tuesday in the rain "
    "and the ferry horn was calling out a name i could not say"
)
_VERSE_B = (
    "you were standing at the crossing with a coat too thin for snow "
    "and you told me every ending is a door you have to close"
)
_CHORUS = (
    "so carry me over the water carry me over the line "
    "if the morning never finds us i will still call this one mine"
)
_BRIDGE = (
    "there are letters in the attic that i never learned to send "
    "and a photograph of nothing at the corner of the bend"
)

#: The song, as an authored lyrics candidate would carry it.
SONG = " ".join([_VERSE_A, _CHORUS, _VERSE_B, _CHORUS])
#: THE SAME SONG'S LONGER MASTER — the report's shape: an extra section and extra chorus repeats.
SONG_LONG = " ".join([_VERSE_A, _CHORUS, _VERSE_B, _CHORUS, _BRIDGE, _CHORUS, _CHORUS])
#: An unrelated song. Written function-word-heavy on purpose, because shared "the/and/i/it" is what
#: pushes a different song's coverage UP, and the threshold has to survive the adversarial case.
OTHER_SONG = (
    "and i was in the room and it was on the wall and i could not tell you what it was "
    "so i told them that it is what it is and that i have been in it for a while now "
    "there is a way that you could be in the one that i am in and it is not the same "
    "but i will tell you that the one you are on is the one that i was on before"
)

#: Plausible mishearings, so a degraded baseline looks like ASR rather than like noise.
_MISHEARD = {
    "harbour": "arbour", "lights": "light", "tuesday": "choose day", "rain": "reign",
    "ferry": "fairy", "horn": "warn", "calling": "call in", "name": "aim",
    "standing": "stand in", "crossing": "cross in", "coat": "code", "thin": "tin",
    "snow": "no", "ending": "end in", "door": "doe", "close": "clothes",
    "carry": "carrie", "water": "waterer", "line": "lion", "morning": "mourning",
    "still": "steel", "mine": "mind", "letters": "letting", "attic": "add it",
    "learned": "learnt", "send": "sent", "photograph": "photo graph", "corner": "cornea",
    "bend": "bent", "left": "lift", "behind": "be hind", "over": "of a",
    "one": "won", "told": "toad", "every": "ever",
}


def asr_baseline(text: str, word_error: float, seed: int = 7) -> str:
    """A synthetic ASR transcript of `text`: a `word_error` fraction of words comes out wrong.

    Seeded, so every number in this file is reproducible by running it. A word with no entry in
    `_MISHEARD` is reversed, which stands in for ASR inventing a word that is not in the song at all.
    """
    rnd = random.Random(seed)
    out = []
    for word in text.split():
        key = word.lower()
        out.append(_MISHEARD.get(key, key[::-1]) if rnd.random() < word_error else word)
    return " ".join(out)


def _coverage(candidate: str, baseline: str) -> float:
    got = agreement(candidate, baseline)
    assert got is not None, "the corpus texts are all far above MIN_TOKENS_TO_COMPARE"
    return got.coverage


def test_a_different_song_stays_below_the_threshold_with_margin():
    """The UPPER tail of the different-song band: measured ceiling 0.300, threshold 0.40."""
    worst = max(
        _coverage(OTHER_SONG, SONG if wer == 0 else asr_baseline(SONG, wer))
        for wer in (0.0, 0.10, 0.25)
    )
    assert worst < SUSPECT_COVERAGE, worst
    assert worst < 0.32, f"the different-song ceiling moved: {worst:.3f} (was 0.300 when 0.40 was chosen)"


def test_a_correct_candidate_stays_above_the_threshold_even_on_a_bad_baseline():
    """The LOWER tail of the correct-candidate band, across degradation AND across seeds.

    50% word error is already an unusable baseline and coverage is still 0.468 — above 0.40. This is the
    assertion that would catch a threshold raised until it starts rejecting correct lookups, which is the
    failure that matters most here: publishing an ASR guess over correct lyrics.
    """
    for wer in (0.10, 0.20, 0.30, 0.40, 0.50):
        got = _coverage(SONG, asr_baseline(SONG, wer))
        assert got > SUSPECT_COVERAGE, f"word_error={wer}: coverage {got:.3f} would be called a wrong song"
    spread = [_coverage(SONG, asr_baseline(SONG, 0.45, seed=seed)) for seed in range(1, 21)]
    assert min(spread) > SUSPECT_COVERAGE, f"worst of 20 seeds at 45% word error: {min(spread):.3f}"


def test_a_partial_baseline_does_not_condemn_a_correct_candidate():
    """THE REGRESSION THIS AXIS CHANGE EXISTS FOR — and the one a lowered threshold would not have fixed.

    A baseline covering a third of the audio (YouTube's ASR suppresses sung vocals, so this is the normal
    case, not a corner) leaves a CORRECT candidate scoring 0.186 on the ranking score — while a DIFFERENT
    song scores 0.165 on that same score. Those bands are 0.02 apart, so no threshold on the ranking score
    separates them; thresholding it either rejects correct lyrics or accepts wrong songs. Coverage is
    immune to the size asymmetry, and here it separates them by more than 0.17.
    """
    third = " ".join(asr_baseline(SONG, 0.20).split()[: len(SONG.split()) // 3])
    partial_but_correct = agreement(SONG, third)
    different_song = agreement(OTHER_SONG, asr_baseline(SONG, 0.20))
    assert partial_but_correct is not None and different_song is not None

    # On the RANKING score the correct candidate and the different song are indistinguishable...
    assert abs(partial_but_correct.rank_score - different_song.rank_score) < 0.05
    # ...while on the COVERAGE axis they are far apart, and only the different song is condemned.
    assert partial_but_correct.coverage > SUSPECT_COVERAGE + 0.25
    assert different_song.coverage < SUSPECT_COVERAGE
    assert partial_but_correct.coverage - different_song.coverage > 0.17


def test_the_wrong_longer_version_shows_the_directional_fingerprint():
    """High coverage, low fidelity — the "right song, wrong version" shape, which one number cannot say.

    And the reason the judgement must not be asked to catch it: coverage is HIGH, exactly as it should be
    (it IS the song's words), so this case belongs to the comparison and to #667's overshoot demotion, not
    to a threshold. What this metric buys is that the comparison can now see it at all.
    """
    baseline = asr_baseline(SONG, 0.20)
    wrong_version = agreement(SONG_LONG, baseline)
    right_version = agreement(SONG, baseline)
    assert wrong_version is not None and right_version is not None

    assert wrong_version.coverage > 0.75, "the longer master does carry the audible words"
    assert wrong_version.fidelity < 0.55, "but a large part of it is never sung"
    assert wrong_version.coverage - wrong_version.fidelity > 0.25, "the fingerprint is the GAP"
    assert right_version.coverage - right_version.fidelity < 0.05, "a correct pick has no such gap"

    # Set Jaccard scored the wrong version 0.610 here — 88% of what it gave the right one, which is what
    # let a wrong-version pick look fine. The new ranking score opens that gap up.
    old_ratio = _old_set_jaccard(SONG_LONG, baseline) / _old_set_jaccard(SONG, baseline)
    new_ratio = wrong_version.rank_score / right_version.rank_score
    assert old_ratio > 0.85, f"old metric barely separated them: {old_ratio:.3f}"
    assert new_ratio < 0.65, f"new metric must separate them: {new_ratio:.3f}"


def test_a_truncated_candidate_is_now_caught_where_set_jaccard_accepted_it():
    """A lookup returning only the chorus against a full baseline: coverage 0.235, so it is condemned.

    Set Jaccard scored that pair 0.306 — above the old 0.25 — so a candidate carrying a quarter of the
    words the room can hear was published as the song's lyrics. A detection the axis change adds, rather
    than a case it merely preserves.
    """
    baseline = asr_baseline(SONG, 0.15)
    got = agreement(_CHORUS, baseline)
    assert got is not None
    assert got.fidelity > 0.9, "everything the truncated candidate says IS audible..."
    assert got.coverage < SUSPECT_COVERAGE, "...but it is missing most of what was heard"
    assert _old_set_jaccard(_CHORUS, baseline) > 0.25, "the old metric accepted exactly this"


# ── 4. through the real selection seam, not just the metric ──────────────────────────
def _text(body: str, *, role: str, source: str, rank: int | None = None, variant: str | None = None):
    return LyricsText(
        text_source=source,
        timing=TIMING_LINE,
        text_confidence="low" if role == ROLE_BASELINE else "high",
        role=role,
        baseline_rank=rank,
        variant=variant,
        segments=[{"start": 0.0, "end": 4.0, "text": body}],
    )


def test_selection_prefers_the_right_version_over_the_longer_master():
    """The call chain the issue describes: acquire → select_by_baselines → publish.

    #542's report is a wrong-version pick winning selection. Both candidates are the same song, so no
    threshold can order them (`SUSPECT_COVERAGE` correctly fires on neither) — the argmax over the ranking
    score has to, and it can only do that if the score is count- and position-aware. On origin/main both
    candidates score within a few percent of each other on set Jaccard.
    """
    baseline = _text(asr_baseline(SONG, 0.20), role=ROLE_BASELINE, source=SOURCE_ASR, rank=0)
    right = _text(SONG, role=ROLE_CANDIDATE, source=SOURCE_LRCLIB, variant="right")
    wrong = _text(SONG_LONG, role=ROLE_CANDIDATE, source=SOURCE_LRCLIB, variant="wrong")

    sel = select_by_baselines([baseline, wrong, right])
    assert sel.publish[0].variant == "right", "the version that matches the audio must win"
    assert not sel.winner_suspect, "both are the right song; the wrong-song judgement must stay quiet"
    assert sel.winner_coverage is not None and sel.winner_coverage > SUSPECT_COVERAGE


def test_selection_judges_on_coverage_so_a_partial_baseline_publishes_the_candidate_alone():
    """A correct candidate + a baseline that only heard a third: NOT suspect, so no fallback is published.

    RED ON BASE in the sense that matters: with the judgement on a mixed score, this candidate is demoted
    to `low` confidence and the ASR baseline is published beside it — the room is shown a warning and a
    transcript for lyrics that were right all along.
    """
    third = " ".join(asr_baseline(SONG, 0.20).split()[: len(SONG.split()) // 3])
    sel = select_by_baselines(
        [
            _text(third, role=ROLE_BASELINE, source=SOURCE_ASR, rank=0),
            _text(SONG, role=ROLE_CANDIDATE, source=SOURCE_LRCLIB, variant="correct"),
        ]
    )
    assert not sel.winner_suspect
    assert len(sel.publish) == 1, "nothing to fall back to is needed when the winner is trustworthy"
    assert sel.publish[0].text_confidence == "high", "a correct lookup must not be demoted"


def test_selection_still_condemns_a_genuinely_different_song():
    """The judgement has not been defanged: a different song is still caught and the baseline published."""
    sel = select_by_baselines(
        [
            _text(asr_baseline(SONG, 0.15), role=ROLE_BASELINE, source=SOURCE_ASR, rank=0),
            _text(OTHER_SONG, role=ROLE_CANDIDATE, source=SOURCE_LRCLIB, variant="wrong-song"),
        ]
    )
    assert sel.winner_suspect, "a different song must still be called out"
    assert len(sel.publish) == 2, "what was actually heard is published alongside it"
    assert sel.publish[1].role == ROLE_BASELINE


def test_composite_reports_both_axes_over_the_same_quorum():
    """`coverage` must not be formed from a different set of baselines than `score`.

    A baseline that abstains abstains on both axes, so a mean coverage cannot be quietly built from
    evidence that was too thin to vote on the ranking score.
    """
    candidate = _text(SONG, role=ROLE_CANDIDATE, source=SOURCE_LRCLIB)
    speaks = _text(asr_baseline(SONG, 0.20), role=ROLE_BASELINE, source=SOURCE_ASR, rank=0)
    abstains = _text("la la la", role=ROLE_BASELINE, source=SOURCE_ASR, rank=1)

    with_abstainer = composite_score(candidate, [speaks, abstains])
    alone = composite_score(candidate, [speaks])
    assert with_abstainer == alone, "an abstaining baseline must not move either axis"
    assert len(with_abstainer.votes) == 1

    nothing = composite_score(candidate, [abstains])
    assert nothing.score is None and nothing.coverage is None and nothing.votes == []


# ── the public surface the rename moved ───────────────────────────────────────────────
def test_the_package_root_re_exports_the_new_agreement_surface():
    """`src.lyrics` is the import surface every caller outside this module uses, so the rename is not
    finished until the package root carries it.

    This is deliberately an API-surface guard rather than a behavioural one. The three new names and the
    renamed threshold are re-exported by `src/lyrics/__init__.py`; dropping one of those re-export lines
    changes NO behaviour reachable from a test that imports `src.lyrics.chain` directly (which every
    other test here does), so nothing else in either suite notices. Importing through the ROOT is what
    makes a dropped line red.

    It also catches the half-applied rename in the other direction: `SUSPECT_AGREEMENT` must be gone from
    the root, not merely shadowed, or a caller keeps importing a name whose axis silently changed.
    """
    import src.lyrics as pkg

    # Reached through the package root on purpose — `from .chain import ...` is the thing under test.
    from src.lyrics import (  # noqa: F401  — imported for the surface, not to be called
        Agreement,
        Composite,
        agreement,
    )
    from src.lyrics import SUSPECT_COVERAGE as root_threshold

    assert root_threshold == SUSPECT_COVERAGE
    assert agreement is _chain_agreement, "the root must re-export chain's agreement, not a copy"

    # `__all__` is the declared surface, and it is a separate hunk from the imports above: a name can be
    # imported and still be missing from `__all__`, which breaks `from src.lyrics import *` for callers.
    for name in ("SUSPECT_COVERAGE", "Agreement", "Composite", "agreement"):
        assert name in pkg.__all__, f"{name} is missing from src.lyrics.__all__"
    assert "SUSPECT_AGREEMENT" not in pkg.__all__, "the retired threshold is still declared at the root"
    assert not hasattr(pkg, "SUSPECT_AGREEMENT"), "the retired threshold is still re-exported"


def test_a_fresh_Selection_reports_an_unknown_coverage_rather_than_raising():
    """`Selection.winner_coverage` must be a DECLARED field with a `None` default.

    `Selection` is a plain (non-slots) dataclass and `select_by_baselines` assigns the winner's coverage
    as an attribute, so Python would happily create it on the instance even with the field declaration
    deleted — which is exactly why the rest of the suite stays green when that hunk is reverted. The
    declaration is still load-bearing: any consumer holding a `Selection` that did NOT come out of
    `select_by_baselines` reads the default, and without the field that read is an AttributeError instead
    of "not judged". `steps/lyrics.py` formats this value on the suspect path.

    Asserting the DEFAULT on a directly-constructed instance is the only thing that distinguishes a
    declared field from an attribute the selection path happens to set.
    """
    fresh = Selection()
    assert fresh.winner_coverage is None
    assert "winner_coverage" in {f.name for f in dataclasses.fields(Selection)}
