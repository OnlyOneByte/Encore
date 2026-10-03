"""Ad-libs and echo tails: `domain/lyrics/parts.py` and the `adlibs` arm (review §3.13, PLAN W5).

THE PROPERTY EVERY TEST HERE IS A FACE OF: the arm changes WHAT THE DECODE IS ASKED TO ALIGN and nothing
about what is published. Every word of the served text comes back, in its own line, in order, with no span
walking backwards — because the only thing downstream of this is a TV that would show a missing lyric or a
highlight that jumps.
"""

from __future__ import annotations

import asyncio
import json
import math
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pytest
import soundfile as sf

from encore_worker.domain.document import Segment
from encore_worker.domain.lyrics import parts
from encore_worker.domain.lyrics.generate import Generated, Line, Word, adopted_line, generate
from encore_worker.domain.lyrics.policy import Tier
from encore_worker.host.config import Config
from encore_worker.steps.align_steps import Adapters, AlignStepsImpl
from encore_worker.steps.records import AudioRef, JobRef, TextRef, TimedDoc, TimeRequest
from tests.ctc_fixture import ctc_viterbi, sung_matrix

RATE = 16000
DIC = {ch: i + 1 for i, ch in enumerate("abcdefghijklmnopqrstuvwxyz'")}

#: What the fake song SINGS. The ad-lib and the echo are sung where a backing voice sings them: right after
#: the lead line they belong to, inside the gap before the next lead line.
PHRASES = [
    ("come and fly away", 5.0, 7.0),
    ("fly away", 7.2, 8.0),  # the ECHO TAIL, a second voice
    ("with me tonight", 10.0, 11.5),
    ("oh yeah", 11.6, 12.4),  # the AD-LIB, trailing its host
    ("over the silver water", 15.0, 17.5),
    ("carry me home", 20.0, 22.0),
]
DURATION = 25.0

#: The served text: the echo is its own line (as a caption track writes it) and the ad-lib is a trailing
#: parenthetical on its host (as a lyric sheet writes it).
SERVED = (
    "come and fly away",
    "fly away",
    "with me tonight (oh yeah)",
    "over the silver water",
    "carry me home",
)


# ── the text side: what `split` takes out, and what it refuses to ─────────────────────────────────


def test_a_trailing_parenthetical_leaves_the_lead_decode_and_keeps_every_published_word() -> None:
    got = parts.split(["hold me close (oh yeah)"])
    assert got.lead_texts == ("hold me close",)
    host = got.hosts[0]
    assert host.words == ("hold", "me", "close", "(oh", "yeah)")
    assert host.aside == (False, False, False, True, True)
    assert host.text == "hold me close (oh yeah)", "the PUBLISHED line is the served one, unchanged"


def test_a_mid_line_parenthetical_leaves_the_lead_decode() -> None:
    got = parts.split(["hold me (oh yeah) close"])
    assert got.lead_texts == ("hold me close",)
    assert got.hosts[0].aside == (False, False, True, True, False)


def test_a_leading_parenthetical_stays_in_the_decode() -> None:
    """It is where the line STARTS, and a line's start is the number every metric here scores."""
    got = parts.split(["(ca-ca) Come and fly away"])
    assert got.lead_texts == ("(ca-ca) Come and fly away",)
    assert not got.reaches


def test_a_whole_line_parenthetical_stays_in_the_decode() -> None:
    """`nonlyric.py` owns that question, and `clean.py` measured what reading it as a cue costs:
    `(Oh-I-oh-I-oh-I-oh-I)` is sung."""
    got = parts.split(["(I'm in love with your body)"])
    assert not got.reaches


def test_a_parenthetical_of_punctuation_only_is_not_an_adlib() -> None:
    got = parts.split(["hold me close (...)"])
    assert not got.reaches


def test_a_group_that_starts_inside_a_token_is_left_whole() -> None:
    """The published word list and the lead decode's must agree about what a WORD is; `restored`'s
    pairing rests on it. 0 such lines in the bench corpus."""
    got = parts.split(["la(ha)la and more"])
    assert not got.reaches


def test_an_unbalanced_parenthesis_is_left_whole() -> None:
    """A truncated caption cue writes one; the group never closes, so there is nothing to take out."""
    got = parts.split(["hold me close (oh yeah"])
    assert not got.reaches


def test_an_echo_tail_line_leaves_the_decode_and_names_its_host() -> None:
    got = parts.split(["So hello from the other side", "Other side", "Hello from the outside"])
    assert got.lead_texts == ("So hello from the other side", "", "Hello from the outside")
    assert got.hosts[1].echo_of == 0
    assert got.hosts[1].aside == (True, True)


def test_an_echo_tail_is_matched_through_punctuation_and_case() -> None:
    got = parts.split(["I must've called a thousand times", "thousand times!"])
    assert 1 in got.hosts


def test_a_line_that_is_most_of_its_host_is_a_repeat_and_not_an_echo() -> None:
    """`MAX_ECHO_SHARE`: a near-complete repeat is a repeated LYRIC, which the ladder and the margin own."""
    got = parts.split(["never be alone tonight", "be alone tonight"])
    assert not got.reaches


def test_two_echoes_in_a_row_are_a_sequence_the_singer_performed_and_both_stay() -> None:
    """never-be-alone's eleven triples, measured: `You'll never be alone` / `be alone...` / `be alone` are
    three consecutive spans with no gap between them, so they are lead phrases and not a second voice."""
    got = parts.split(["You'll never be alone", "be alone...", "be alone"])
    assert not got.reaches


def test_an_echo_of_an_echo_is_not_timed_off_an_interpolated_span() -> None:
    """The host chain skips candidates, so the second line of a run never becomes the third's host."""
    got = parts.split(["hold me close tonight", "close tonight", "tonight"])
    assert not got.reaches, "a run of candidates is refused whole (the ALONE clause)"


def test_nothing_fired_still_says_so_on_the_trail() -> None:
    quiet = parts.split(["hold me close", "and never let go"])
    assert not quiet.reaches
    assert "no mid-line parenthetical and no echo tail" in quiet.why()
    loud = parts.split(["hold me close (oh yeah)"])
    assert "held out of the lead decode" in loud.why()


def test_untouched_is_the_identity_and_restored_returns_the_same_object() -> None:
    doc = Generated(lines=(_line("hold me", 1.0, 2.0, index=0),), language="en")
    split = parts.untouched(["hold me"])
    assert split.lead_texts == ("hold me",)
    assert parts.restored(doc, split) is doc


# ── the restore: where the words that never reached the decode end up ──────────────────────────────


def _line(text: str, start: float, end: float, *, index: int, score: float = -0.5) -> Line:
    words = text.split()
    step = (end - start) / len(words)
    return Line(
        text=text,
        start=start,
        end=end,
        words=tuple(
            Word(word=word, start=start + i * step, end=start + (i + 1) * step, score=score)
            for i, word in enumerate(words)
        ),
        score=score,
        index=index,
    )


def test_a_trailing_aside_is_apportioned_across_the_room_before_the_next_line() -> None:
    split = parts.split(["hold me close (oh yeah)", "and never let go"])
    decoded = Generated(
        lines=(_line("hold me close", 1.0, 2.0, index=0), _line("and never let go", 4.0, 5.0, index=1)),
        language="en",
    )
    got = parts.restored(decoded, split)
    first = got.lines[0]
    assert first.text == "hold me close (oh yeah)"
    assert [word.word for word in first.words] == ["hold", "me", "close", "(oh", "yeah)"]
    assert first.words[3].start == pytest.approx(2.0), "starts where the lead line's last word ended"
    assert first.words[-1].end == pytest.approx(4.0), "and ends where the next line starts"
    assert first.end == pytest.approx(4.0)
    assert [word.provenance for word in first.words[3:]] == ["low", "low"]
    assert first.score == decoded.lines[0].score, "an interpolated word does not move the line's score"


def test_a_mid_line_aside_is_apportioned_between_the_lead_words_around_it() -> None:
    split = parts.split(["hold me (oh yeah) close"])
    decoded = Generated(lines=(_line("hold me close", 1.0, 4.0, index=0),), language="en")
    got = parts.restored(decoded, split)
    spelled = [(word.word, word.start, word.end) for word in got.lines[0].words]
    assert [word for word, _s, _e in spelled] == ["hold", "me", "(oh", "yeah)", "close"]
    assert spelled[2][1] == pytest.approx(3.0), "the second lead word's end"
    assert spelled[3][2] == pytest.approx(3.0), "the third lead word's start: there was no room"
    assert [s for _w, s, _e in spelled] == sorted(s for _w, s, _e in spelled)


def test_a_longer_aside_takes_more_of_the_room_than_a_shorter_one() -> None:
    """By CHARACTER COUNT (`presplit`'s rule): an even split would give `(oh)` what `(all of it)` needs."""
    split = parts.split(["hold me close (oh) (all of it)"])
    decoded = Generated(lines=(_line("hold me close", 0.0, 1.0, index=0),), language="en")
    got = parts.restored(decoded, split, until=5.0)
    widths = [word.end - word.start for word in got.lines[0].words[3:]]
    assert widths[0] < sum(widths[1:]), "`(oh)` takes 4 characters' worth of the room, `(all of it)` 9"
    assert got.lines[0].end == pytest.approx(5.0)


def test_a_trailing_aside_on_the_last_line_with_no_recording_end_is_zero_width() -> None:
    """Rather than inventing a span past the audio."""
    split = parts.split(["hold me close (oh yeah)"])
    decoded = Generated(lines=(_line("hold me close", 1.0, 2.0, index=0),), language="en")
    got = parts.restored(decoded, split)
    assert [word.start for word in got.lines[0].words[3:]] == [2.0, 2.0]
    assert got.lines[0].end == pytest.approx(2.0)


def test_an_echo_tail_is_published_as_its_own_line_inside_the_gap_its_host_leaves() -> None:
    split = parts.split(["hold me close tonight baby", "tonight baby", "and never let go"])
    decoded = Generated(
        lines=(
            _line("hold me close tonight baby", 1.0, 2.0, index=0),
            _line("and never let go", 4.0, 5.0, index=2),
        ),
        language="en",
    )
    got = parts.restored(decoded, split)
    assert [line.index for line in got.lines] == [0, 1, 2]
    echo = got.lines[1]
    assert echo.text == "tonight baby"
    assert echo.start == pytest.approx(2.0) and echo.end == pytest.approx(4.0)
    assert echo.score == decoded.lines[0].score, "its host's score: its host's measurement placed it"
    assert parts.unmeasured_lines(got) == frozenset({1})


def test_every_restored_word_sequence_is_monotone_even_with_no_room_anywhere() -> None:
    """The invariant `measure.out_of_order` reads and `policy.decide` degrades a whole document over."""
    split = parts.split(["hold me close tonight baby (oh yeah)", "tonight baby", "and never let go"])
    assert sorted(split.hosts) == [0, 1]
    decoded = Generated(
        lines=(
            _line("hold me close tonight baby", 1.0, 2.0, index=0),
            _line("and never let go", 2.0, 3.0, index=2),
        ),
        language="en",
    )
    got = parts.restored(decoded, split)
    starts = [word.start for line in got.lines for word in line.words]
    assert starts == sorted(starts)
    assert all(word.end >= word.start for line in got.lines for word in line.words)


def test_a_host_whose_lead_text_the_decode_dropped_is_dropped_too() -> None:
    """Exactly as `generate` drops a line with no alignable character: no invented span."""
    split = parts.split(["hold me close (oh yeah)", "and never let go"])
    decoded = Generated(lines=(_line("and never let go", 4.0, 5.0, index=1),), language="en")
    got = parts.restored(decoded, split)
    assert [line.index for line in got.lines] == [1]


def test_an_echo_whose_host_was_not_published_is_dropped_with_it() -> None:
    """W5 review r1-correctness-5. An R2 echo is exempt from the never-sung rule but its HOST is not, and an
    R1/plain host can also be dropped by `generate` for carrying no alignable character. With the anchor
    gone the echo was restored at the document FLOOR (0.0, since nothing had been emitted yet) with
    `score=0.0` — a published line parked across the whole lead-in, and a zero on a log-probability scale is
    an impossibly GOOD score that then entered the never-sung rule's median as one."""
    split = parts.split(["aaa bbb ccc ddd", "ccc ddd", "eee fff ggg hhh"])
    assert split.hosts[1].echo_of == 0, "index 1 is the echo of index 0"
    decoded = Generated(lines=(_line("eee fff ggg hhh", 7.0, 10.0, index=2),), language="en")
    got = parts.restored(decoded, split, until=10.0)
    assert [line.index for line in got.lines] == [2]
    assert all(line.start > 0.0 for line in got.lines), "nothing is parked at the document floor"


def test_an_aside_is_not_held_out_of_a_line_the_matrix_cannot_align_without_it() -> None:
    """`_mark`'s "something is left to align" test is the DECODE's, not a letter test.

    A letter the dictionary lacks is dropped by `generate` exactly as a `♪` is, so a line whose lead words
    are all out-of-vocabulary passed the letter test, `generate` emitted nothing for the index and
    `restored` published nothing: the arm LOST a line the default path publishes. With the matrix in hand
    the test is `generate.alignable_chars`. The lead is HANGUL since W7, and the substitution is the point:
    `ñññ` is NFKD-folded to `nnn` and aligns now, so an accented lead is no longer unalignable on a Latin
    vocabulary — a script the vocabulary has no column for is what "out of vocabulary" still means."""
    texts = ["aaa bbb", "가나다 (ccc ddd)", "eee fff"]
    matrix = FakeEmissions(sung_matrix([("aaa bbb", 1.0, 2.0)], DIC, 5.0), 0.02, DIC)

    blind = parts.split(texts)
    assert blind.hosts[1].aside == (False, True, True), "the letter test alone marks the aside"

    got = parts.split(texts, emissions=matrix)
    assert 1 not in got.hosts, "no lead left that THIS dictionary can align, so the line keeps its aside"
    assert got.lead_texts[1] == "가나다 (ccc ddd)"


def test_an_accented_lead_is_alignable_because_the_filter_folds_it() -> None:
    """The other half of the fixture above, as its own test (W7, review §3 item 9).

    `ñññ` has no column in a 26-letter Latin vocabulary and used to be dropped, so `parts.split` read the
    line as "nothing left to align" and kept its aside. Since the target filter folds NFKD, `ñññ` IS `nnn` to
    the decode, so the lead stands on its own and the aside is held out — which is what the arm is for.
    """
    texts = ["aaa bbb", "ñññ (ccc ddd)", "eee fff"]
    matrix = FakeEmissions(sung_matrix([("aaa bbb", 1.0, 2.0)], DIC, 5.0), 0.02, DIC)

    got = parts.split(texts, emissions=matrix)
    assert 1 in got.hosts, "the fold gives this lead three alignable characters"
    assert got.lead_texts[1] == "ñññ"


def test_unmeasured_lines_reads_the_document_not_a_set_kept_beside_it() -> None:
    """So a line the ladder re-decoded from its FULL text is no longer called interpolated."""
    repaired = Generated(lines=(_line("me close", 2.0, 3.0, index=1),), language="en")
    assert parts.unmeasured_lines(repaired) == frozenset()


def test_a_claim_adopted_line_is_unmeasured_too_arm_or_no_arm() -> None:
    """W5 review r2-spec-13. The docstring said "every R2 echo, and nothing else today" and the call site said
    "empty without the arm": both were false on the DEFAULT path, because `generate.adopted_line` gives every
    word `OOV_CONFIDENCE` provenance — the claim's span copied, not heard — which is this predicate exactly.
    Pinned so the sentence and the set stay in step; no behaviour rides on it (the adopted branch of
    `line_confidence` grades such a line `low` regardless)."""
    line = adopted_line("aaa bbb ccc", 7, 10.0, 12.0)
    assert line is not None
    assert parts.unmeasured_lines(Generated(lines=(line,), language="en")) == frozenset({7})


# ── through a real CTC decode: the lead's path is the lead's alone ─────────────────────────────────


@dataclass(frozen=True)
class FakeEmissions:
    log_probs: object
    frame_sec: float
    dictionary: dict[str, int]
    model: str | None = None

    @property
    def frames(self) -> int:
        return len(self.log_probs)  # type: ignore[arg-type]


def test_the_lead_decode_is_given_fewer_targets_and_the_document_still_holds_every_word() -> None:
    matrix = FakeEmissions(sung_matrix(PHRASES, DIC, DURATION), 0.02, DIC)
    split = parts.split(SERVED)
    decoded = generate(split.lead_texts, matrix, decoder=ctc_viterbi, syllabifier=lambda w, _l: [w])
    assert [line.text for line in decoded.lines] == [
        "come and fly away",
        "with me tonight",
        "over the silver water",
        "carry me home",
    ], "the echo line contributed no target at all"
    got = parts.restored(decoded, split, until=DURATION)
    assert [line.text for line in got.lines] == list(SERVED)
    assert [word.word for line in got.lines for word in line.words] == [
        word for text in SERVED for word in text.split()
    ]


def test_the_echo_tail_lands_where_the_second_voice_sang_it() -> None:
    """Which is the whole mechanism: the gap the lead decode leaves is the ad-lib's own span."""
    matrix = FakeEmissions(sung_matrix(PHRASES, DIC, DURATION), 0.02, DIC)
    split = parts.split(SERVED)
    decoded = generate(split.lead_texts, matrix, decoder=ctc_viterbi, syllabifier=lambda w, _l: [w])
    got = parts.restored(decoded, split, until=DURATION)
    echo = next(line for line in got.lines if line.text == "fly away")
    assert 6.8 <= echo.start <= 7.4, f"echo starts at {echo.start}"
    assert echo.end <= 10.1


# ── through the step, with the arm on ──────────────────────────────────────────────────────────────


Rig = tuple[AlignStepsImpl, Path, JobRef, AudioRef]


def _rig(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    arm: bool,
    phrases: Sequence[tuple[str, float, float]] = tuple(PHRASES),
) -> Rig:
    from encore_worker.adapters import ml
    from encore_worker.domain.lyrics import lexical

    monkeypatch.setattr(ml, "forced_align_decoder", ctc_viterbi)
    # A SCRIPTED decoder scores every frame alike whatever the targets, so the lexical gate reads no lift
    # for any text and would refuse this song's own words (`test_align_v2.unmeasured_lift`'s reason).
    monkeypatch.setattr(lexical, "lift", lambda *_a, **_k: None)

    signal = np.random.default_rng(0).normal(0.0, 0.002, int(DURATION * RATE))
    for _text, start, end in phrases:
        t = np.arange(int((end - start) * RATE)) / RATE
        at = int(start * RATE)
        signal[at : at + len(t)] += 0.3 * np.sin(2 * math.pi * 220.0 * t)
    wav = tmp_path / "vocals.wav"
    sf.write(wav, signal, RATE)

    class Aligner:
        def emissions(self, _path: str, _language: str) -> FakeEmissions:
            return FakeEmissions(sung_matrix(list(phrases), DIC, DURATION), 0.02, DIC)

        def align(self, search: Sequence[Segment], _path: str, _language: str) -> tuple[Segment, ...]:
            raise AssertionError("the windowed path must not run")

    class Trail:
        def __init__(self) -> None:
            self.states: list[tuple[Any, ...]] = []

        async def state(self, *args: Any) -> None:
            self.states.append(args)

        async def progress(self, *args: Any) -> None: ...

        async def confirm_ownership(self, *_a: object, **_k: object) -> bool:
            return True

        def explain_ownership(self, *_a: object) -> str:
            return ""

    impl = AlignStepsImpl(
        config=Config(align_experiments=frozenset({"adlibs"} if arm else set())),
        adapters=Adapters(aligner=Aligner()),
        reporter=Trail(),
    )
    job = JobRef(job_id="j1", media_id="m1", media_dir=str(tmp_path), source_uri=None, params={})
    audio = AudioRef(path=str(wav), vocals_path=str(wav), duration_sec=DURATION)
    return impl, tmp_path, job, audio


def _published(rig: Rig, served: Sequence[str] = SERVED) -> dict[str, Any]:
    impl, tmp, job, audio = rig
    request = TimeRequest(
        job=job,
        text=TextRef(tier=Tier.CANDIDATE, label="test", segments=tuple({"text": t} for t in served)),
        audio=audio,
        language="en",
    )
    timed = asyncio.run(impl.time_text(request))
    assert isinstance(timed, TimedDoc), timed
    doc: dict[str, Any] = json.loads((tmp / timed.ref).read_text())
    return doc


def test_the_arm_publishes_every_served_word_in_order(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    doc = _published(_rig(tmp_path, monkeypatch, arm=True))
    assert [line["text"] for line in doc["lines"]] == list(SERVED)
    starts = [word["start"] for line in doc["lines"] for word in line["words"]]
    assert starts == sorted(starts), "a highlight that jumps is what this must never publish"


#: A served line whose LEAD words are outside the matrix's vocabulary while its parenthetical is inside it,
#: sung in the gap after the song's last lead line. Mutating the step's `parts.split(line_texts,
#: emissions=emissions)` back to `parts.split(line_texts)` left the whole suite green. HANGUL since W7.
OOV_LEAD = "가나다 (yeah yeah)"
OOV_PHRASE = ("yeah yeah", 23.0, 24.0)


def test_the_arm_still_publishes_a_line_whose_lead_the_matrix_cannot_align(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The half of r1-tests-20 that lived only in `parts`' own test: the step must hand `split` the MATRIX.
    Held out on the letter test alone, this line's lead is `ñññ` — nothing `generate` can target — so
    `generate` emits no line for the index and `restored` publishes nothing: the arm LOSES a line the default
    path publishes. With the matrix, R1 refuses to hold the aside out and the whole line is a target."""
    rig = _rig(tmp_path, monkeypatch, arm=True, phrases=(*PHRASES, OOV_PHRASE))
    doc = _published(rig, served=(*SERVED, OOV_LEAD))

    assert [line["text"] for line in doc["lines"]] == [*SERVED, OOV_LEAD]
    assert doc["lines"][-1]["words"], "a published line with no word is the same loss one indirection later"
    matrix = FakeEmissions(sung_matrix([*PHRASES, OOV_PHRASE], DIC, DURATION), 0.02, DIC)
    split = parts.split([*SERVED, OOV_LEAD], emissions=matrix)
    assert split.lead_texts[-1] == OOV_LEAD, "the aside stays in the lead text when nothing else can align"
    assert len(SERVED) not in split.hosts, "so the index is not a host at all"


def test_a_line_no_decode_placed_is_graded_low(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """W6's TV consumer then renders it line-level with no word wipe. A demotion only."""
    doc = _published(_rig(tmp_path, monkeypatch, arm=True))
    grades = {line["text"]: line["confidence"] for line in doc["lines"]}
    assert grades["fly away"] == "low"


def test_the_arm_says_what_it_did_on_the_trail(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    rig = _rig(tmp_path, monkeypatch, arm=True)
    _published(rig)
    trail = rig[0]._out  # noqa: SLF001 - the spy is the point
    notes = " ".join(str(state) for state in trail.states)  # type: ignore[attr-defined]
    assert "ad-libs:" in notes and "echo-tail line(s)" in notes


def test_without_the_arm_the_adlib_words_are_decoded_and_nothing_says_ad_libs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The default path is untouched by this module, and the trail of a run without the arm says nothing
    about it — an arm's clause on every production note would be noise."""
    rig = _rig(tmp_path, monkeypatch, arm=False)
    doc = _published(rig)
    assert [line["text"] for line in doc["lines"]] == list(SERVED)
    echo = next(line for line in doc["lines"] if line["text"] == "fly away")
    assert 6.8 <= echo["words"][0]["start"] <= 7.6, "the default decodes it as a target of its own"
    notes = " ".join(str(state) for state in rig[0]._out.states)  # type: ignore[attr-defined]  # noqa: SLF001
    assert "ad-libs:" not in notes
