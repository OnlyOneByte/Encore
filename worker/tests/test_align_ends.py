"""The word-end post-pass through the REAL step: what it moves, and everything it must not.

`tests/test_ends.py` holds the pure function's properties; this file holds the two things only the step can
say. ANY ONSET MOVING is a rejection: every published start, word and line, must be bit-for-bit what the
decode produced, with the post-pass on and off (`ends-raw`, the control arm). And THE PLACEMENT IS
LOAD-BEARING: extending ends inside `generate` would change `Line.end` before the never-sung rule, before
the blind envelope fit the wrong-text gate judges and before R4 — loosening two gates while looking like an
accuracy win — so the whole trail note must be IDENTICAL in both arms but for its own clause, which is the
stronger statement that nothing else moved. docs/arch/04-alignment.md §10 carries the rule.

The rig is `test_align_provenance`'s: a tone under each phrase, and the CTC fixture's Viterbi over a matrix.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest

from encore_worker.domain.lyrics.ends import MAX_EXTENSION_SEC
from tests.ctc_fixture import sung_matrix
from tests.test_align_provenance import (
    DIC,
    FAINT,
    UNIQUE,
    UNIQUE_DURATION,
    Outcome,
    align,
    truth,
    weakly_sung,
)

#: The unsung line every run below carries: an uploader's credit, claimed over the outro, sung on neither the
#: stem nor the mix. The never-sung rule must bin it in BOTH arms — the drop is decided on the raw spans, and
#: extended ends would hand the line envelope overlap it has not got.
CREDIT = "thanks for watching everyone"


def run(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, arm: str = "") -> Outcome:
    """One `time_text` over the s5-s7 song plus the unsung credit, with claims for all of it."""
    from encore_worker.steps import align_steps

    # As `test_align_provenance.any_tempo`: the never-sung tempo signal is calibrated on real songs, and a
    # synthetic trace short enough to fit these silences smears faster. Relaxed so the drop is reached.
    monkeypatch.setattr(align_steps, "_NEVER_SUNG_RATE", 1000.0)
    where = tmp_path / (arm or "default")
    where.mkdir()
    return align(
        where,
        monkeypatch,
        phrases=UNIQUE,
        duration=UNIQUE_DURATION,
        claims=[*truth(UNIQUE), (44.0, 47.0)],
        stem_matrix=weakly_sung(sung_matrix(UNIQUE, DIC, UNIQUE_DURATION), (CREDIT, 43.0, 49.0), FAINT),
        extra_text=[CREDIT],
        experiments=frozenset({arm} if arm else ()),
    )


def plain(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, arm: str = "") -> Outcome:
    """The same song with no unsung line, so nothing is dropped and no re-decode runs. The shape the
    placement spy below needs: an extension made too early SURVIVES to the gate here, where the
    never-sung rule's own re-decode would have erased it."""
    where = tmp_path / f"plain-{arm or 'default'}"
    where.mkdir()
    return align(
        where,
        monkeypatch,
        phrases=UNIQUE,
        duration=UNIQUE_DURATION,
        claims=truth(UNIQUE),
        experiments=frozenset({arm} if arm else ()),
    )


def mix_only(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, arm: str = "") -> tuple[Outcome, Path]:
    """The same song with NO vocals stem, and an instrumental bed under the mix.

    The shape a song the separator could not run on takes (and the one `e2e.py --no-stem` measures): the
    MIX is the align target at every stage, so the envelope the post-pass would read is a mix's — active
    nearly everywhere, which is the measured fact `ends.ACTIVE_LEVEL` is calibrated against.
    """
    where = tmp_path / f"mix-{arm or 'default'}"
    where.mkdir()
    got = align(
        where,
        monkeypatch,
        phrases=UNIQUE,
        duration=UNIQUE_DURATION,
        claims=truth(UNIQUE),
        stemless=True,
        mix_bed=0.1,
        experiments=frozenset({arm} if arm else ()),
    )
    return got, where / "mix.wav"


def spans_the_gate_saw(monkeypatch: pytest.MonkeyPatch) -> list[tuple[tuple[float, float], ...]]:
    """Records the line spans of every envelope fit the step makes, in order.

    `activity.fit_sheet_to_audio` is what the wrong-text gate and every repair stage judge a document on,
    and the spans it is handed are `Line.start`/`Line.end`. If the post-pass ran before any of them, this
    is where it would show — the trail's `r=0.61` prints two decimals and would not."""
    from encore_worker.domain.audio import activity

    seen: list[tuple[tuple[float, float], ...]] = []
    real = activity.fit_sheet_to_audio

    def spy(signal: Any, rate: int, spans: Any, **kwargs: Any) -> Any:
        seen.append(tuple((float(start), float(end)) for start, end in spans))
        return real(signal, rate, spans, **kwargs)

    monkeypatch.setattr(activity, "fit_sheet_to_audio", spy)
    return seen


def words_of(got: Outcome) -> list[dict[str, Any]]:
    return [word for line in got.lines for word in line["words"]]


def ends_clause(why: str) -> str:
    return next(part for part in why.split("; ") if part.startswith("word ends:"))


def without_ends(why: str) -> str:
    return "; ".join(part for part in why.split("; ") if not part.startswith("word ends:"))


def test_no_published_onset_moves_when_the_ends_are_held(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Review §3.5's reject-if, as an assertion rather than a bench row: the post-pass is one-sided.

    A corpus metric could hide one moved onset inside an improved average, so this compares the two
    documents word for word — starts EXACTLY equal, ends at or after the decode's, and at least one end
    actually held, so the test cannot pass by the post-pass having done nothing."""
    raw, held = run(tmp_path, monkeypatch, "ends-raw"), run(tmp_path, monkeypatch)
    assert [line["start"] for line in held.lines] == [line["start"] for line in raw.lines]
    assert [word["start"] for word in words_of(held)] == [word["start"] for word in words_of(raw)]
    assert [word["word"] for word in words_of(held)] == [word["word"] for word in words_of(raw)]
    moved = [
        (word["end"] - before["end"]) for word, before in zip(words_of(held), words_of(raw), strict=True)
    ]
    assert all(delta >= 0.0 for delta in moved), "an end went backwards"
    assert all(delta <= MAX_EXTENSION_SEC for delta in moved)
    # Non-vacuity, and the phrase-final ends measured early are the ones that must have moved: the
    # synthetic decode already fills 70% of each interior char's slot, so only about half its ends have
    # anywhere to go, while every line's LAST word stops short of the tone that is still sounding.
    assert sum(1 for delta in moved if delta > 0.0) >= len(held.lines)
    for line, before in zip(held.lines, raw.lines, strict=True):
        assert line["words"][-1]["end"] > before["words"][-1]["end"], line["text"]


def test_everything_the_gates_read_is_identical_with_the_post_pass_on_and_off(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """THE placement test. The post-pass sits after the wrong-text gate, the never-sung drop, R1-R4 and
    `_clamped`, so the entire verdict note — envelope correlations, the lexical lift, the never-sung
    drop, the repair list, the timing sources and the grade count — must be the same string in both arms
    once its own clause is removed. Moving `extend_ends` any earlier turns this red: the credit line's
    envelope overlap and char rate would move first, and the blind fit with them."""
    raw, held = run(tmp_path, monkeypatch, "ends-raw"), run(tmp_path, monkeypatch)
    assert without_ends(held.verdict[4]) == without_ends(raw.verdict[4])
    assert held.verdict[3] == raw.verdict[3], "the reconcile verdict is the same one"
    assert [line["confidence"] for line in held.lines] == [line["confidence"] for line in raw.lines]
    assert held.timed.confidence == raw.timed.confidence
    # Non-vacuity: the note has to actually carry the gate and the drop, or the comparison proves nothing.
    why = raw.verdict[4]
    assert "envelope r=" in why and f"'{CREDIT[:40]}'" in why and "dropped never-sung" in why
    assert "lines high" in why


def test_no_envelope_fit_is_ever_measured_on_a_held_end(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No envelope fit is ever measured on a held end, which is where the placement bites.

    The wrong-text gate is an envelope fit of the document's LINE SPANS against the audio's own activity,
    and a held end makes every span longer — more expected-singing mass, a different correlation, a
    different verdict at the margin — so every fit must be handed the spans the DECODE produced: the
    recorded span lists are compared between the arm and the default and must be identical. Proved to
    bite: applying `extend_ends` right after the envelope is measured turns this red while every other
    test here stays green, a song with no never-sung drop having no re-decode to erase the extension."""
    # ONE spy, emptied between the runs: installing a second would wrap the first, which then records both
    # runs and makes the comparison pass for the wrong reason (it did, until this comment existed).
    seen = spans_the_gate_saw(monkeypatch)
    raw = plain(tmp_path, monkeypatch, "ends-raw")
    raw_seen = list(seen)
    seen.clear()
    held = plain(tmp_path, monkeypatch)
    assert raw_seen, "no fit was recorded: the spy is watching the wrong function"
    assert list(seen) == raw_seen, "a fit was measured on held ends"
    # Non-vacuity: this song's document really does differ between the two arms, so "identical fits" is a
    # statement about the fits and not about the runs being the same run.
    assert [line["end"] for line in held.lines] != [line["end"] for line in raw.lines]


def test_the_unsung_credit_line_is_still_dropped(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The consequence of the placement, stated on its own so a failure says which half broke: a line the
    audio never sings is binned by the never-sung rule in both arms. Extended ends would have given it
    envelope overlap it has not got."""
    for arm in ("ends-raw", ""):
        got = run(tmp_path, monkeypatch, arm)
        assert [line["text"] for line in got.lines] == [text for text, _s, _e in UNIQUE]
        assert "dropped never-sung after all" not in got.verdict[4]


def test_the_ends_reach_the_end_of_the_singing_and_no_further(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """What the room sees. Each of this song's phrases is a 2-3 s tone with silence after it, so every
    line's last word should now be lit to the end of its own phrase — the phrase-final ends that
    measured a median 107 ms early — and NOT into the silence beyond it."""
    got = run(tmp_path, monkeypatch)
    for line, (_text, _start, sung_until) in zip(got.lines, UNIQUE, strict=True):
        last = line["words"][-1]
        assert last["end"] == pytest.approx(sung_until, abs=0.05), line["text"]
        assert line["end"] == pytest.approx(last["end"], abs=1e-9), "the line grew with its last word"


def test_nothing_is_extended_past_the_audio(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The walk stops at the last envelope frame, so the post-pass cannot manufacture an overshoot —
    which `policy.decide` answers with a re-place on the windowed engine and reports either way."""
    got = run(tmp_path, monkeypatch)
    assert got.timed.report is not None
    assert got.timed.report.overshoot_sec == 0.0
    assert max(word["end"] for word in words_of(got)) <= UNIQUE_DURATION + 2.0


def test_the_trail_says_how_many_ends_it_held(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A display change no field of `TimingReport` can show — order is judged on starts — is invisible on
    the audit page unless the trail says it. "The ball leaves the word early" is the report this answers."""
    held, raw = run(tmp_path, monkeypatch), run(tmp_path, monkeypatch, "ends-raw")
    assert ends_clause(raw.verdict[4]) == "word ends: the raw decode's (ends-raw)"
    clause = ends_clause(held.verdict[4])
    match = re.fullmatch(
        r"word ends: held (\d+) of (\d+) through the singing, median \+(\d+) ms, worst \+(\d+\.\d\d)s",
        clause,
    )
    assert match is not None, clause
    assert 0 < int(match[1]) <= int(match[2]) == len(words_of(held))
    assert float(match[4]) <= MAX_EXTENSION_SEC


def test_a_stemless_song_publishes_the_decodes_own_ends(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`theta` is a VOCALS STEM's calibration, so the post-pass does not run on a mix target.

    `ends.ACTIVE_LEVEL` is 0.1 of the TARGET's own 95th-percentile level: on a stem that is a silence
    test, on a mix it is true almost everywhere (92-98% of frames on the corpus mixes, with active runs of
    38-184 s, against 59-77% and 10-19 s on the same songs' stems), so the walk would never stop and the
    default would silently become the `ends-tile` arm plus a run to the next line's onset — on the one
    population the corpus cannot measure, all 20 of its songs having stems. Both halves are asserted: the
    step publishes the raw ends on a mix, and the pure walk over this mix's envelope tiles every line."""
    got, wav = mix_only(tmp_path, monkeypatch)
    control, _ = mix_only(tmp_path, monkeypatch, "ends-raw")
    assert [word["end"] for word in words_of(got)] == [word["end"] for word in words_of(control)]
    assert [word["start"] for word in words_of(got)] == [word["start"] for word in words_of(control)]
    assert ends_clause(got.verdict[4]) == (
        "word ends: the raw decode's (no vocals stem: the envelope's silence level is a stem's)"
    )

    # The counterfactual, on the audio the step just declined to walk: a mix's envelope clears the stem's
    # theta nearly everywhere, and the walk then reaches its cap for every word it is given.
    import soundfile as sf

    from encore_worker.domain.audio import activity
    from encore_worker.domain.lyrics.ends import ACTIVE_LEVEL, extend_ends
    from encore_worker.domain.lyrics.generate import Generated, Line, Word

    signal, rate = sf.read(wav, dtype="float32", always_2d=False)
    env = activity.envelope(signal, rate)
    assert float((env >= ACTIVE_LEVEL).mean()) > 0.95, "the bed must make the mix active almost everywhere"
    document = Generated(
        lines=tuple(
            Line(
                text=str(line["text"]),
                start=float(line["start"]),
                end=float(line["end"]),
                words=tuple(
                    Word(word=str(w["word"]), start=float(w["start"]), end=float(w["end"]), score=0.0)
                    for w in line["words"]
                ),
                score=0.0,
                index=index,
            )
            for index, line in enumerate(got.lines)
        ),
        language="en",
    )
    would = extend_ends(document, env.tolist(), activity.HOP_SEC)
    flat = [word for line in would.lines for word in line.words]
    raw = [word for line in document.lines for word in line.words]
    # Every word reaches its CAP: the next onset, or +3 s where the next onset is further away than that.
    caps = [
        min(raw[position + 1].start, before.end + MAX_EXTENSION_SEC)
        if position + 1 < len(raw)
        else before.end + MAX_EXTENSION_SEC
        for position, before in enumerate(raw)
    ]
    # To the FRAME: the walk consumes only frames that fit wholly before the cap, so it lands on the last
    # frame boundary at or before it.
    assert all(
        cap - activity.HOP_SEC - 1e-9 <= word.end <= max(cap, before.end) + 1e-9
        for word, before, cap in zip(flat, raw, caps, strict=True)
    ), "on a mix the walk does not stop: every end runs to its cap — the `ends-tile` arm plus a tail"
    assert flat[-1].end > raw[-1].end + 1.0, "and the document's last word runs on for the whole hold"


def test_the_tile_arm_tiles_each_published_line(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """`ends-tile` through the real step: inside a published line there is no dark gap left between words,
    and the arm names itself on the trail. Starts are still the decode's."""
    tiled, held = run(tmp_path, monkeypatch, "ends-tile"), run(tmp_path, monkeypatch)
    assert "tiling within each line (ends-tile)" in ends_clause(tiled.verdict[4])
    assert [word["start"] for word in words_of(tiled)] == [word["start"] for word in words_of(held)]
    gapless = 0
    for line in tiled.lines:
        for word, ahead in zip(line["words"], line["words"][1:], strict=False):
            assert word["end"] == pytest.approx(ahead["start"], abs=1e-9), line["text"]
            gapless += 1
    assert gapless >= 20, "the song must have interior words for this to mean anything"
    # And the default did NOT tile everything: that is the difference the bench is being asked to judge.
    assert any(
        word["end"] < ahead["start"] - 1e-9
        for line in held.lines
        for word, ahead in zip(line["words"], line["words"][1:], strict=False)
    )
