"""The word-end post-pass (`domain/lyrics/ends.py`) as hermetic properties, chiefly invariant XA-01.

Starts are compared EXACTLY so "no onset moved" is bit for bit; extended ends go through `at()`.
Design: docs/arch/04-alignment.md §10. Measurements: the forced-alignment LOG.md, "Word ends, held
through the singing" and "The OOV placeholder's own exhibit".
"""

from __future__ import annotations

import random
from collections.abc import Sequence

import pytest

from encore_worker.domain.lyrics.ends import ACTIVE_LEVEL, MAX_EXTENSION_SEC, extend_ends
from encore_worker.domain.lyrics.generate import Generated, Line, Syllable, Word

HOP = 0.02


def word(text: str, start: float, end: float, *, syllables: Sequence[Syllable] = ()) -> Word:
    return Word(word=text, start=start, end=end, score=-0.4, syllables=tuple(syllables))


def line(index: int, *words: Word) -> Line:
    return Line(
        text=" ".join(w.word for w in words),
        start=min(w.start for w in words),
        end=max(w.end for w in words),
        words=words,
        score=-0.4,
        index=index,
    )


def doc(*lines: Line) -> Generated:
    return Generated(lines=lines, language="en")


def sung(*spans: tuple[float, float], duration: float = 20.0, level: float = 1.0) -> list[float]:
    """An envelope that is `level` over each span's frames and silent elsewhere.

    Frame boundaries are ROUNDED, so a span written `(1.0, 2.0)` is active over exactly the frames whose
    left edges fall in [1.0, 2.0) and the walk stops at 2.0 rather than a frame short of it.
    """
    env = [0.0] * round(duration / HOP)
    for start, end in spans:
        for frame in range(round(start / HOP), min(round(end / HOP), len(env))):
            env[frame] = level
    return env


def ends_of(generated: Generated) -> list[float]:
    return [w.end for ln in generated.lines for w in ln.words]


def starts_of(generated: Generated) -> list[float]:
    return [w.start for ln in generated.lines for w in ln.words]


def at(*seconds: float) -> object:
    """Frame-grid times, compared to the nanosecond: `115 * 0.02` is not the literal `2.3`."""
    return pytest.approx(list(seconds), abs=1e-9)


# ── the one-sided rule ────────────────────────────────────────────────────────────────────────────────


def test_an_end_is_held_while_the_envelope_still_calls_it_singing() -> None:
    """THE fix. The decode stops the last word at 5.2 s; the singer is still going at 6.0 s."""
    before = doc(line(0, word("hold", 4.0, 4.6), word("on", 4.8, 5.2)))
    after = extend_ends(before, sung((4.0, 6.0)), HOP)
    assert [w.end for w in after.lines[0].words] == at(4.8, 6.0)
    assert starts_of(after) == starts_of(before), "no onset may move"


def test_a_silent_envelope_changes_nothing_at_all() -> None:
    """Identity, not "identity to within a float": a document nothing extended must BE the input, so
    "the post-pass did nothing" is a statement a trail note and a bench row can both make."""
    before = doc(line(0, word("hold", 4.0, 4.6)), line(1, word("on", 8.0, 8.4)))
    assert extend_ends(before, sung(duration=20.0), HOP) == before


def test_an_end_stops_at_the_next_words_own_onset() -> None:
    """The cap that makes this NOT the rejected energy-snap: an over-extension can only fill a gap the
    decode left empty, never reach into the next word's span."""
    before = doc(line(0, word("one", 1.0, 1.2), word("two", 2.0, 2.2)))
    after = extend_ends(before, sung((1.0, 5.0)), HOP)
    assert [w.end for w in after.lines[0].words] == at(2.0, 5.0)


def test_an_end_stops_at_the_three_second_cap() -> None:
    """A decode that lost a whole phrase must not light one word across an instrumental break."""
    before = doc(line(0, word("gone", 1.0, 1.2)))
    after = extend_ends(before, sung((1.0, 19.0)), HOP)
    assert after.lines[0].words[0].end == pytest.approx(1.2 + MAX_EXTENSION_SEC, abs=1e-9)


def test_an_end_stops_at_the_last_frame_the_envelope_measured() -> None:
    """So an extension cannot run past the audio and manufacture `TimingReport.overshoot_sec`."""
    before = doc(line(0, word("out", 3.0, 3.2)))
    after = extend_ends(before, sung((3.0, 4.0), duration=4.0), HOP)
    assert after.lines[0].words[0].end == pytest.approx(4.0, abs=1e-9)


def test_a_cap_behind_the_end_is_a_no_op_and_never_a_shrink() -> None:
    """A misbound decode can publish a word whose successor starts BEFORE it ends (v2's clamp still does,
    on the backwards-start shapes). The cap then sits behind the end, and the end stays.

    The trailing word has no successor, so only the envelope and the 3 s cap bound it — and it may then
    overlap the word the document shows before it. That costs nothing: a document with a backwards pair is
    already `out_of_order`, which `policy.decide` degrades to line sync whatever its ends say."""
    before = doc(line(0, word("late", 5.0, 6.0), word("early", 4.0, 4.5)))
    after = extend_ends(before, sung((0.0, 20.0)), HOP)
    assert after.lines[0].words[0].end == 6.0, "the word its successor precedes is left alone"
    assert after.lines[0].words[1].end == pytest.approx(4.5 + MAX_EXTENSION_SEC, abs=1e-9)


def test_the_threshold_is_where_the_singing_stops() -> None:
    """A level below `theta` ends the walk; the same envelope at a lower threshold keeps going."""
    quiet = sung((1.0, 2.0))
    for frame in range(round(2.0 / HOP), round(3.0 / HOP)):
        quiet[frame] = ACTIVE_LEVEL / 2
    before = doc(line(0, word("fade", 1.0, 1.4)))
    assert extend_ends(before, quiet, HOP).lines[0].words[0].end == pytest.approx(2.0, abs=1e-9)
    assert extend_ends(before, quiet, HOP, ACTIVE_LEVEL / 4).lines[0].words[0].end == pytest.approx(
        3.0, abs=1e-9
    )


def test_a_word_the_envelope_never_hears_keeps_its_end() -> None:
    """The never-sung rule's own level (0.10) is this threshold, so a word over silence is not held."""
    before = doc(line(0, word("sung", 1.0, 1.4)), line(1, word("credit", 10.0, 10.4)))
    after = extend_ends(before, sung((1.0, 3.0)), HOP)
    assert ends_of(after) == at(3.0, 10.4)


# ── what the document looks like afterwards ───────────────────────────────────────────────────────────


def test_the_line_grows_with_its_last_word() -> None:
    """`Line.end` is `max(word ends)` when `generate` builds it, and must stay that way: the TV reads it
    as the line's bound (`lineBounds`), and a line ending before its own last word is a document that
    contradicts itself."""
    before = doc(line(0, word("hold", 4.0, 4.6), word("on", 4.8, 5.2)))
    after = extend_ends(before, sung((4.0, 6.0)), HOP)
    assert after.lines[0].end == pytest.approx(6.0, abs=1e-9)
    assert after.lines[0].start == before.lines[0].start


def test_the_last_syllable_is_stretched_with_its_word() -> None:
    """A syllable ball must not stop where the word's end used to be. Every other syllable is untouched."""
    held = word("away", 4.0, 4.6, syllables=[Syllable("a", 4.0, 4.2), Syllable("way", 4.2, 4.6)])
    after = extend_ends(doc(line(0, held)), sung((4.0, 6.0)), HOP)
    got = after.lines[0].words[0]
    assert [s.text for s in got.syllables] == ["a", "way"]
    assert [s.start for s in got.syllables] == [4.0, 4.2]
    assert [s.end for s in got.syllables] == at(4.2, 6.0)
    assert got.end == pytest.approx(6.0, abs=1e-9)


def test_the_nesting_invariant_survives_the_post_pass() -> None:
    """`generate`'s structural invariant — syllables in words in lines, all ordered — restated over the
    document that actually publishes. Only outer bounds grow and no start moves, so it holds by
    construction; this is the test that keeps it true after a refactor."""
    before = doc(
        line(
            0,
            word("come", 1.0, 1.4, syllables=[Syllable("co", 1.0, 1.2), Syllable("me", 1.2, 1.4)]),
            word("away", 1.6, 2.0, syllables=[Syllable("a", 1.6, 1.8), Syllable("way", 1.8, 2.0)]),
        ),
        line(1, word("tonight", 3.0, 3.6)),
    )
    after = extend_ends(before, sung((1.0, 2.6), (3.0, 4.0)), HOP)
    assert ends_of(after) == at(1.6, 2.6, 4.0), "the exhibit has to have moved something"
    previous_line_end = -1.0
    for row in after.lines:
        assert row.start >= previous_line_end
        previous_line_end = row.end
        previous_word_end = None
        for got in row.words:
            assert row.start <= got.start <= got.end <= row.end
            if previous_word_end is not None:
                assert got.start >= previous_word_end
            previous_word_end = got.end
            previous_syllable_end = None
            for syllable in got.syllables:
                assert got.start <= syllable.start <= syllable.end <= got.end
                if previous_syllable_end is not None:
                    assert syllable.start >= previous_syllable_end
                previous_syllable_end = syllable.end


def test_an_interpolated_word_is_held_like_any_other() -> None:
    """An OOV word (a digit run, a non-Latin token) carries an interpolated span and `provenance` low.
    It is still on screen, so it is still extended — and it keeps saying it was interpolated."""
    before = doc(line(0, Word(word="2", start=1.0, end=1.2, score=0.0, provenance="low")))
    after = extend_ends(before, sung((1.0, 2.0)), HOP)
    got = after.lines[0].words[0]
    assert got.end == pytest.approx(2.0, abs=1e-9)
    assert (got.provenance, got.score) == ("low", 0.0)


def test_a_trailing_out_of_vocabulary_token_does_not_absorb_the_hold() -> None:
    """The post-pass, inverted by the one word that has no evidence.

    A line ending in an OOV token — a digit run, a non-Latin word; 497 of the corpus's 5693 Jamendo words
    are interpolated — gets `start = end = the previous word's end` from `generate`'s OOV branch, which read
    as a cap that pinned the sung word at its own end and let the zero-width token run to the NEXT LINE's
    onset: the room saw an unsingable token lit through the sung tail while the word being sung went dark.
    The hold belongs to the word with acoustic evidence and the placeholder stays a point, the TV lighting
    `start <= pos < end`."""
    oov = Word(word="2", start=1.2, end=1.2, score=0.0, provenance="low")
    before = doc(line(0, word("on", 0.6, 1.2), oov), line(1, word("next", 4.0, 4.4)))
    after = extend_ends(before, sung((0.6, 2.6), (4.0, 4.6)), HOP)
    sung_word, placeholder = after.lines[0].words
    assert sung_word.end == pytest.approx(2.6, abs=1e-9), "the sung word is held through the singing"
    assert (placeholder.start, placeholder.end) == (1.2, 1.2), "the placeholder is not held at all"
    assert after.lines[0].end == pytest.approx(2.6, abs=1e-9)
    # And the next line's onset is still the ceiling: the skip reaches past a POINT, not past a word.
    assert extend_ends(
        doc(line(0, word("on", 0.6, 1.2), oov), line(1, word("next", 2.0, 2.4))),
        sung((0.6, 3.0)),
        HOP,
    ).lines[0].words[0].end == pytest.approx(2.0, abs=1e-9)


def test_an_end_exactly_on_a_frame_boundary_is_walked_from_its_own_frame() -> None:
    """Since the exact clock every decoded end IS `k * 0.02` (`generate._char_spans` stamps
    `index * frame_sec`), and `int((k * 0.02) / 0.02)` is `k - 1` for 9721 of the first 200001 k — so the
    walk used to start one frame early, read the frame BEFORE the word's own end frame, find it silent and
    return the end untouched. Frame 29 is the first such k: `(29 * 0.02) / 0.02` is 28.999999999999996.

    The envelope here is silent in frame 28 and active from frame 29, so the two arithmetics differ by the
    WHOLE extension rather than by a rounding: 0.58 s against 1.10 s.
    """
    end = 29 * HOP
    assert int(end / HOP) == 28, "the float case this pins; `29 * 0.02 / 0.02` is 28.999999999999996"
    before = doc(line(0, word("held", 10 * HOP, end)))
    after = extend_ends(before, sung((end, 55 * HOP)), HOP)
    assert after.lines[0].words[0].end == pytest.approx(55 * HOP, abs=1e-9)


def test_an_empty_document_is_returned_as_it_came() -> None:
    assert extend_ends(doc(), sung((0.0, 1.0)), HOP) == doc()


def test_no_envelope_and_no_hop_are_both_no_ops() -> None:
    """A song whose audio could not be read (an empty envelope) must publish its raw ends rather than
    raise: the post-pass is a display improvement, never a requirement."""
    before = doc(line(0, word("hold", 4.0, 4.6)))
    assert extend_ends(before, [], HOP) == before
    assert extend_ends(before, sung((4.0, 6.0)), 0.0) == before


# ── the `ends-tile` arm ───────────────────────────────────────────────────────────────────────────────


def test_the_tile_arm_fills_a_line_gaplessly_and_judges_only_its_last_word() -> None:
    """`ends-tile` (review §3.5's 78.8% variant): inside a line every word runs to the next word's start
    whatever the envelope says; the line's LAST word is still judged acoustically, so a line does not
    bleed into the next one's gap on the strength of a rule."""
    before = doc(
        line(0, word("one", 1.0, 1.2), word("two", 2.0, 2.2)),
        line(1, word("three", 5.0, 5.2)),
    )
    quiet_between = sung((1.0, 1.3), (2.0, 2.3), (5.0, 5.3))
    tiled = extend_ends(before, quiet_between, HOP, tile=True)
    assert [w.end for w in tiled.lines[0].words] == at(2.0, 2.3), "interior tiles, final is acoustic"
    assert [w.end for w in tiled.lines[1].words] == at(5.3)
    assert starts_of(tiled) == starts_of(before)
    plain = extend_ends(before, quiet_between, HOP)
    assert [w.end for w in plain.lines[0].words] == at(1.3, 2.3), "the default stops with the singing"


def test_the_tile_arm_keeps_the_three_second_cap() -> None:
    """A line with a bar's rest in the middle of it does not light one word across the whole rest."""
    before = doc(line(0, word("one", 1.0, 1.2), word("two", 9.0, 9.2)))
    tiled = extend_ends(before, sung(duration=20.0), HOP, tile=True)
    assert tiled.lines[0].words[0].end == pytest.approx(1.2 + MAX_EXTENSION_SEC, abs=1e-9)


# ── the reject-if, as a property ──────────────────────────────────────────────────────────────────────


def random_document(rng: random.Random) -> Generated:
    """A document shaped like the ones the decode produces, including the shapes it gets WRONG: lines out
    of time order, words overlapping, zero-length spans, a line sung after the envelope ends."""
    lines: list[Line] = []
    clock = rng.uniform(0.0, 2.0)
    for index in range(rng.randint(1, 8)):
        words: list[Word] = []
        for _ in range(rng.randint(1, 6)):
            start = clock + rng.uniform(-0.3, 0.8)
            words.append(word("w", start, start + rng.choice([0.0, 0.02, 0.2, 1.0])))
            clock = start + rng.uniform(0.0, 0.6)
        lines.append(line(index, *words))
    return doc(*lines)


def test_no_onset_ever_moves_and_no_end_ever_shrinks() -> None:
    """The reject-if, over 500 random documents x both arms x a random envelope: every start is
    the decode's own, every end is at or after the decode's, none has moved by more than the cap, and
    none crosses the next word's onset unless the decode had already crossed it."""
    rng = random.Random(20260929)
    moved = 0
    for _ in range(500):
        before = random_document(rng)
        env = [rng.choice([0.0, 0.02, 0.1, 0.5, 1.0]) for _ in range(rng.randint(0, 600))]
        for tile in (False, True):
            after = extend_ends(before, env, HOP, tile=tile)
            assert starts_of(after) == starts_of(before)
            assert [ln.start for ln in after.lines] == [ln.start for ln in before.lines]
            pairs = list(zip(ends_of(after), ends_of(before), strict=True))
            assert all(new >= old for new, old in pairs)
            assert all(new <= old + MAX_EXTENSION_SEC + 1e-9 for new, old in pairs)
            moved += sum(1 for new, old in pairs if new > old)
            flat = [w for ln in after.lines for w in ln.words]
            raw = [w for ln in before.lines for w in ln.words]
            for position, (held, decoded) in enumerate(zip(flat, raw, strict=True)):
                # THE NEXT SUNG ONSET, not the next word's: a zero-width interpolated
                # placeholder is not a cap, and the generator above emits them (`0.0` widths). See
                # `test_a_trailing_out_of_vocabulary_token_does_not_absorb_the_hold` for why crossing one
                # cannot light a wrong word, and `_next_sung` for the shape it comes from.
                ahead = next((w.start for w in raw[position + 1 :] if w.end > w.start), None)
                if ahead is not None:
                    assert held.end <= max(ahead, decoded.end) + 1e-9, "an end crossed the next sung onset"
                assert held.end >= held.start
                if decoded.end <= decoded.start:
                    assert held.end == decoded.end, "a zero-width placeholder was extended"
    assert moved > 1000, f"only {moved} ends moved: the property is not exercising the extension"
