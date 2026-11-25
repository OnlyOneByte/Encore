"""The real step implementations, with every adapter faked.

These are thin by design, so the tests are about the few decisions a step is allowed to make: which audio
to align against, whether a source's miss is a miss or an error, and the ownership guard on `publish`.

`AlignStepsImpl` is exercised DIRECTLY, with no DBOS launched — that is the reason the decorators live in
`workflows/dbos_align.py` rather than on these methods.
"""

from __future__ import annotations

import json
import math
from collections.abc import Sequence
from pathlib import Path
from typing import cast

import numpy as np
import pytest
import soundfile as sf

from encore_worker.adapters import ports
from encore_worker.adapters.lrclib import parse_lrc
from encore_worker.adapters.ports import InfraFault
from encore_worker.artifacts.local import LocalArtifactStore, Roots
from encore_worker.domain.document import Segment
from encore_worker.domain.lyrics import lexical, measure
from encore_worker.domain.lyrics.clean import clean_segments
from encore_worker.domain.lyrics.generate import ONSET_LEAD_SEC
from encore_worker.domain.lyrics.policy import Knob, Tier
from encore_worker.domain.lyrics.report import Engine
from encore_worker.host.config import Config
from encore_worker.protocol.vocabulary import Stage
from encore_worker.steps.align_steps import Adapters, AlignStepsImpl
from encore_worker.steps.align_text import _written, seed_times
from encore_worker.steps.api import NotOurJob
from encore_worker.steps.records import (
    TIMING_LINE,
    TIMING_WORD,
    AudioRef,
    JobRef,
    Refused,
    TextRef,
    TimedDoc,
    TimeRequest,
)
from encore_worker.workflows import align
from tests.ctc_fixture import ctc_viterbi, sung_matrix
from tests.test_align_provenance import DIC, PathAligner

CFG = Config(worker_id="w1")


class Reporter:
    """A `Reporter` that records, and whose ownership answer is scriptable."""

    def __init__(self, *, owns: bool = True) -> None:
        self.owns = owns
        self.states: list[tuple[str, str, str | None]] = []
        #: Each state's `why`, in the same order.
        self.reasons: list[str] = []
        self.asked: list[str] = []

    async def progress(self, job_id: str, stage: Stage, pct: int) -> None:
        pass

    async def state(
        self, job_id: str, state: str, attempt: int, verdict: str, why: str, knob: str | None
    ) -> None:
        self.states.append((state, verdict, knob))
        self.reasons.append(why)

    async def confirm_ownership(self, job_id: str, *, timeout_sec: float = 10.0) -> bool:
        self.asked.append(job_id)
        return self.owns

    def explain_ownership(self, job_id: str) -> str:
        return f"job {job_id} was taken from us"


class FakeAligner:
    """Returns word-timed lines, recording what it was asked to search and on which file."""

    def __init__(self, *, fail: bool = False, words: int = 4, fault: Exception | None = None) -> None:
        self.fail = fail
        self.words = words
        #: Raised as-is when set: an adapter's typed machinery fault (`InfraFault`), not a refusal.
        self.fault = fault
        self.calls: list[tuple[tuple[Segment, ...], str]] = []

    def align(self, search: Sequence[Segment], audio_path: str, language: str) -> Sequence[Segment]:
        self.calls.append((tuple(search), audio_path))
        if self.fault is not None:
            raise self.fault
        if self.fail:
            raise RuntimeError("the aligner fell over")
        return [
            {
                "text": "hello world",
                "words": [
                    {"word": f"w{n}", "start": float(n), "end": float(n) + 0.4} for n in range(self.words)
                ],
            }
        ]


class FakeProvider:
    name = "lrclib"

    def __init__(self, cues: Sequence[Segment] | None = None) -> None:
        self.cues = cues
        self.calls: list[tuple[str, str]] = []

    def fetch(self, *, artist: str, track: str, duration_sec: float | None) -> Sequence[Segment]:
        self.calls.append((artist, track))
        return self.cues or ()


def job(tmp: Path, **params: object) -> JobRef:
    return JobRef(
        job_id="j1", media_id="m1", media_dir=str(tmp), source_uri="https://x.test/v", params=params
    )


def steps(tmp: Path, *, reporter: Reporter | None = None, **adapters: object) -> AlignStepsImpl:
    return AlignStepsImpl(
        config=CFG,
        adapters=Adapters(**adapters),  # type: ignore[arg-type]
        reporter=reporter or Reporter(),
    )


def audio(tmp: Path, *, vocals: bool = True) -> AudioRef:
    return AudioRef(
        path=str(tmp / "original.mp3"),
        duration_sec=200.0,
        vocals_path=str(tmp / "vocals.wav") if vocals else None,
    )


def lrc_text() -> TextRef:
    return TextRef(
        tier=Tier.CANDIDATE,
        label="lrclib",
        segments=({"start": 0.0, "end": 2.0, "text": "hello"},),
        windows=({"start": 0.0, "end": 2.2, "text": "hello"},),
        timing=TIMING_LINE,
        language="en",
    )


# ── which audio gets aligned ─────────────────────────────────────────────────────────────────────


async def test_aligns_against_the_vocals_stem_by_default(tmp_path: Path) -> None:
    """The mix smears word boundaries wherever the band is loud, so the stem is the default."""
    aligner = FakeAligner()
    impl = steps(tmp_path, aligner=aligner)
    await impl.time_text(
        TimeRequest(job=job(tmp_path), text=lrc_text(), audio=audio(tmp_path), language="en")
    )
    assert aligner.calls[0][1].endswith("vocals.wav")


async def test_the_mix_knob_actually_changes_the_file(tmp_path: Path) -> None:
    """A retry that did not change its input would spend a pass to produce the identical result."""
    aligner = FakeAligner()
    impl = steps(tmp_path, aligner=aligner)
    await impl.time_text(
        TimeRequest(
            job=job(tmp_path),
            text=lrc_text(),
            audio=audio(tmp_path),
            language="en",
            knobs=frozenset({Knob.ALIGN_ON_MIX}),
        )
    )
    assert aligner.calls[0][1].endswith("original.mp3")


async def test_with_no_stem_the_mix_is_used_from_the_start(tmp_path: Path) -> None:
    aligner = FakeAligner()
    impl = steps(tmp_path, aligner=aligner)
    await impl.time_text(
        TimeRequest(job=job(tmp_path), text=lrc_text(), audio=audio(tmp_path, vocals=False), language="en")
    )
    assert aligner.calls[0][1].endswith("original.mp3")


async def test_drop_windows_widens_the_search_to_the_whole_segment(tmp_path: Path) -> None:
    """A window derived from a mis-placed text confines the aligner to the wrong span."""
    aligner = FakeAligner()
    impl = steps(tmp_path, aligner=aligner)
    text = lrc_text()

    await impl.time_text(TimeRequest(job=job(tmp_path), text=text, audio=audio(tmp_path), language="en"))
    assert aligner.calls[0][0] == text.windows, "the narrow window is searched first"

    await impl.time_text(
        TimeRequest(
            job=job(tmp_path),
            text=text,
            audio=audio(tmp_path),
            language="en",
            knobs=frozenset({Knob.DROP_WINDOWS}),
        )
    )
    assert aligner.calls[1][0] == text.segments, "dropping the window searches the whole segment"


# ── what time_text produces ──────────────────────────────────────────────────────────────────────


async def test_writes_the_document_and_returns_a_relative_ref(tmp_path: Path) -> None:
    """The core merges on `ref`, so an absolute path would embed this worker's layout in the core's row."""
    impl = steps(tmp_path, aligner=FakeAligner())
    doc = await impl.time_text(
        TimeRequest(job=job(tmp_path), text=lrc_text(), audio=audio(tmp_path), language="en")
    )
    assert isinstance(doc, TimedDoc)
    assert not doc.ref.startswith("/"), "the ref must be media-dir-relative"
    written = tmp_path / doc.ref
    assert written.exists()
    assert json.loads(written.read_text())["language"] == "en"


async def test_measures_what_it_wrote(tmp_path: Path) -> None:
    impl = steps(tmp_path, aligner=FakeAligner(words=4))
    doc = await impl.time_text(
        TimeRequest(job=job(tmp_path), text=lrc_text(), audio=audio(tmp_path), language="en")
    )
    assert doc is not None
    assert doc.report.words == 4
    assert doc.report.duration_sec == 200.0


async def test_an_aligner_fault_is_one_attempt_failing_not_the_job(tmp_path: Path) -> None:
    """The search has other things to try, so this returns None rather than raising."""
    impl = steps(tmp_path, aligner=FakeAligner(fail=True))
    assert (
        await impl.time_text(
            TimeRequest(job=job(tmp_path), text=lrc_text(), audio=audio(tmp_path), language="en")
        )
        is None
    )


async def test_an_aligner_machinery_fault_fails_the_job_not_the_attempt(tmp_path: Path) -> None:
    """The windowed engine keeps the port's contract too: a fault the adapter TYPED as the
    machinery's passes through, where a plain raise (above) is this text failing."""
    fault = InfraFault("loading the 'en' alignment model failed (OSError: HTTP Error 503)")
    impl = steps(tmp_path, aligner=FakeAligner(fault=fault))
    with pytest.raises(InfraFault) as raised:
        await impl.time_text(
            TimeRequest(job=job(tmp_path), text=lrc_text(), audio=audio(tmp_path), language="en")
        )
    assert raised.value is fault


async def test_no_aligner_at_all_is_a_permanent_fault_not_no_lyrics(tmp_path: Path) -> None:
    """A box without an aligner never advertises `align`. Reaching here anyway used to be None on every
    attempt of every text: the ladder's "no lyrics", for words nothing had tried to time."""
    impl = steps(tmp_path)
    with pytest.raises(InfraFault, match="no aligner") as raised:
        await impl.time_text(
            TimeRequest(job=job(tmp_path), text=lrc_text(), audio=audio(tmp_path), language="en")
        )
    assert raised.value.retryable is False, "the same box has no aligner on the next attempt either"


#: Where the synthetic stem below is "sung": a tone inside each span, faint noise elsewhere.
SUNG = [(5.0, 7.0), (8.0, 10.0), (12.0, 14.5), (16.0, 18.0), (22.0, 24.0), (25.5, 27.5)]


def sung_stem(tmp: Path, spans: Sequence[tuple[float, float]] = SUNG, *, duration: float = 40.0) -> AudioRef:
    """A real WAV for the envelope the LINE_SYNC gate reads (it decodes the file through ffmpeg)."""
    rate = 16000
    signal = np.random.default_rng(0).normal(0.0, 0.002, int(duration * rate))
    for start, end in spans:
        t = np.arange(int((end - start) * rate)) / rate
        first = int(start * rate)
        signal[first : first + len(t)] += 0.3 * np.sin(2 * math.pi * 220.0 * t)
    wav = tmp / "vocals.wav"
    sf.write(wav, signal, rate)
    return AudioRef(path=str(tmp / "original.mp3"), duration_sec=duration, vocals_path=str(wav))


def sheet(spans: Sequence[tuple[float, float]], *, offset: float = 0.0) -> TextRef:
    """A line-timed sheet claiming `spans` (shifted by `offset`)."""
    return TextRef(
        tier=Tier.CANDIDATE,
        label="lrclib",
        segments=tuple(
            {"text": f"line {n}", "start": start + offset, "end": end + offset}
            for n, (start, end) in enumerate(spans)
        ),
        timing=TIMING_LINE,
    )


def line_sync(tmp: Path, text: TextRef, audio: AudioRef) -> TimeRequest:
    return TimeRequest(job=job(tmp), text=text, audio=audio, language="en", knobs=frozenset({Knob.LINE_SYNC}))


async def test_the_line_sync_knob_publishes_the_texts_own_timings(tmp_path: Path) -> None:
    """Terminal knob: word timing is abandoned, so the aligner must not be called at all — and the line
    document is measured on its LINES, so it can commit (not on words it read as empty)."""
    aligner = FakeAligner()
    reporter = Reporter()
    impl = steps(tmp_path, aligner=aligner, reporter=reporter)
    doc = await impl.time_text(line_sync(tmp_path, sheet(SUNG), sung_stem(tmp_path)))
    assert isinstance(doc, TimedDoc)
    assert doc.timing == "line"
    assert doc.confidence == "low", "line sync is a degradation and must say so"
    # ...of its TIMING. The words are still the sheet's: the record carries the text's tier, which is what
    # core's `textConfidence` is read from (the grade above once went out in its place).
    assert doc.tier is Tier.CANDIDATE and doc.tier.text_confidence == "high"
    assert aligner.calls == [], "no alignment pass should be spent"
    assert doc.report.engine is Engine.LINE_SYNC and doc.report.lines == len(SUNG)
    assert doc.report.usable, "a clean line document must be publishable"
    assert doc.ref == "work/j1/lyrics/m1-lrclib-line-sync-line.json", "the knob is in the ref"
    lines = json.loads((tmp_path / doc.ref).read_text())["lines"]
    assert [(line["start"], line["end"]) for line in lines] == pytest.approx(SUNG, abs=0.05)
    assert ("align-line-sync", "line-sync", None) in reporter.states, "the gate's numbers are on the trail"


async def test_an_offset_sheet_is_line_synced_onto_the_audio(tmp_path: Path) -> None:
    """The sheet-span gate reads SHAPE: a 2 s offset is a different master, not a different song, and the
    published lines are placed onto the audio's own activity."""
    impl = steps(tmp_path, aligner=FakeAligner())
    doc = await impl.time_text(line_sync(tmp_path, sheet(SUNG, offset=2.0), sung_stem(tmp_path)))
    assert isinstance(doc, TimedDoc)
    starts = [line["start"] for line in json.loads((tmp_path / doc.ref).read_text())["lines"]]
    assert starts == pytest.approx([start for start, _end in SUNG], abs=0.05)


async def test_line_sync_refuses_a_sheet_that_does_not_describe_the_audio(tmp_path: Path) -> None:
    """THE HAZARD this gate exists for: ungated, LINE_SYNC published ANY timed text's own timings, and only
    a bug kept that off the TV. Here the sheet claims singing where the stem has none — the sheet-span
    null the envelope thresholds were calibrated on — so nothing is written and the refusal is a VERDICT
    (`Refused`), which the policy answers with the next text."""
    reporter = Reporter()
    impl = steps(tmp_path, aligner=FakeAligner(), reporter=reporter)
    elsewhere = [(0.5, 1.0), (2.0, 2.4), (29.0, 29.3), (31.0, 34.5), (36.0, 39.5)]
    got = await impl.time_text(line_sync(tmp_path, sheet(elsewhere), sung_stem(tmp_path)))
    assert isinstance(got, Refused)
    assert got.report.engine is Engine.LINE_SYNC and got.report.refused is not None
    assert "sheet-span envelope r=" in got.report.refused
    assert not got.report.usable
    assert not (tmp_path / "derived").exists(), "a refused line document is never written"
    assert ("align-line-sync", "refused", None) in reporter.states


def test_sheet_spans_cap_an_end_that_is_only_the_next_lines_start() -> None:
    """An LRC has onsets, not ends: `parse_lrc` ends each line at the next stamp, so its spans tile the
    song and the envelope degenerates to one block any text matches (measured: 31 of 320 bench wrong texts
    passed in that shape uncapped). Such an end is capped; a caption's own end is kept."""
    from encore_worker.steps.align_lines import _SHEET_SPAN_CAP_SEC, _sheet_spans

    lrc: list[Segment] = [
        {"text": "a", "start": 1.0, "end": 20.0},
        {"text": "b", "start": 20.0, "end": 22.0},
        {"start": 22.0},
    ]
    assert _sheet_spans(lrc) == [(1.0, 1.0 + _SHEET_SPAN_CAP_SEC), (20.0, 22.0)], "the last end is b's"
    captions = [{"text": "a", "start": 1.0, "end": 9.0}, {"text": "b", "start": 12.0, "end": 14.0}]
    assert _sheet_spans(captions) == [(1.0, 9.0), (12.0, 14.0)]
    assert _sheet_spans([{"text": "untimed"}]) == []


def test_a_cue_whose_end_is_not_after_its_start_wrote_no_end_at_all() -> None:
    """A zero-length or reversed cue — common in provider-converted SRT/VTT, and the
    reason the window is clamped at all — was recorded as "the sheet wrote an end" while its window carried
    the START as its end, so `end_bias` averaged in a line's whole DURATION as if it were an end gap.

    The WINDOWS are unchanged: such a cue keeps its own zero length, as `claimmap.ClaimMap.windows` preserves
    it; only the claim to have WRITTEN an end is withdrawn.
    """
    from encore_worker.steps.align_claims import _CLAIM_DEFAULT_END_SEC, _claims_as_served

    served = _claims_as_served(
        [
            {"text": "a", "start": 10.0, "end": 12.0},
            {"text": "b", "start": 20.0, "end": 20.0},
            {"text": "c", "start": 30.0, "end": 29.5},
            {"text": "d", "start": 40.0},
            {"text": "e"},
        ]
    )
    assert served.ends_given == {0}, "only the cue whose end is after its start wrote one"
    assert served.starts == {0: 10.0, 1: 20.0, 2: 30.0, 3: 40.0}
    assert served.windows == {
        0: (10.0, 12.0),
        1: (20.0, 20.0),
        2: (30.0, 30.0),
        3: (40.0, 40.0 + _CLAIM_DEFAULT_END_SEC),
    }
    assert _claims_as_served([]) == _claims_as_served([{"text": "untimed"}]), "no claims either way"


def test_the_rungs_clock_abstains_rather_than_voting_no(monkeypatch: pytest.MonkeyPatch) -> None:
    """`_line_sync_clock` returns None for "there was no vote" and an UNAPPLIED map for "the vote said
    no", and the two must not be confused: None sends `_placed_by` back to the unconditional activity shift
    and the gate to the sheet-span envelope (the old rung), while an unapplied map deliberately leaves
    the sheet where the text put it. A sheet too short for `claimmap.MIN_PAIRS` cannot be fitted at all."""
    from encore_worker.domain.audio.activity import ShiftFit
    from encore_worker.domain.lyrics import claimmap
    from encore_worker.domain.lyrics import reconcile as rc
    from encore_worker.domain.lyrics.generate import Generated, Line
    from encore_worker.steps.align_lines import _line_sync_clock

    def decoded(starts: Sequence[float]) -> Generated:
        return Generated(
            lines=tuple(
                Line(text=f"l{i}", start=at, end=at + 1.0, words=(), score=-0.4, index=i)
                for i, at in enumerate(starts)
            ),
            language="en",
        )

    fit = ShiftFit(seconds=-3.0, correlation=0.8)
    late = {i: 3.0 * i + 3.0 for i in range(6)}
    sung = decoded([3.0 * i for i in range(6)])
    assert _line_sync_clock(fit, late, None) is None, "no decode: no vote"
    short = Generated(lines=sung.lines[:4], language="en")
    assert _line_sync_clock(fit, dict(list(late.items())[:4]), short) is None, "4 pairs, 5 needed"

    mapped = _line_sync_clock(fit, late, sung)
    assert mapped is not None and mapped.applied and mapped.candidate == claimmap.ENVELOPE_LAG
    assert mapped.at(late[0]) == pytest.approx(0.0), "the claims land on our clock"
    # The vote says NO where the claims already agree: an unapplied map, not None.
    agreed = _line_sync_clock(fit, {i: 3.0 * i for i in range(6)}, sung)
    assert agreed is not None and not agreed.applied and agreed.at(9.0) == 9.0
    assert "claims left on their own clock" in agreed.why

    # A DECODE THAT MAY NOT SPEAK FOR THE SHEET decides neither its verdict nor its clock (`_enough_decoded`):
    # the mixed-script shape, where `generate` drops every line with no alignable character.
    fragment = {i: 3.0 * i + 3.0 for i in range(40)}
    assert _line_sync_clock(fit, fragment, sung) is None, "6 of 40 lines decoded: no vote"
    assert _line_sync_clock(fit, dict(list(fragment.items())[:12]), sung) is not None, "6 of 12: it may"

    # THE BAND IS THE RUNG'S, NOT `reconcile`'s — the one deliberate difference from the global engine's call,
    # and the reason a sheet already near our clock keeps its own timings. A sheet 0.6 s off separates them:
    # in the rung's 1.0 s band no candidate beats no-shift, and in `reconcile`'s 0.25 s one the median does.
    # every line. The fit offered here is one `ShiftFit.usable` would have accepted (r 0.8) and `_placed_by`
    # would have applied — the vote refuses it, which is how the truth sheets stop being shifted.
    near = {i: 3.0 * i + 0.6 for i in range(6)}
    kept = _line_sync_clock(fit, near, sung)
    assert kept is not None and not kept.applied and kept.candidate == claimmap.NO_SHIFT, "0.6 s is near"
    assert kept.baseline == 6, "the rung's band explains every line without moving anything"
    tighter = claimmap.consensus(
        {line.index: line.start for line in sung.lines}, near, tolerance_sec=rc.AGREE_TOLERANCE_SEC
    )
    assert tighter.applied and tighter.candidate == claimmap.DECODE_MEDIAN, "reconcile's band would move it"
    assert tighter.baseline == 0


def test_the_rungs_gate_and_its_clock_read_a_decode_at_one_bar() -> None:
    """One floor for both readers of the decode: the rung's gate and its clock abstain together.

    `_enough_decoded`'s floor was `reconcile.MIN_PAIRS` (3) while `_line_sync_clock` took
    `max(claimmap.MIN_PAIRS, this)` (5), and between them lay a band of sheets where the CLOCK abstained
    and the GATE was armed — the worse of the two states: with no clock `_placed_by` falls back to
    `ShiftFit.usable`'s unconditional activity shift, so the gate read the decode against the SHIFTED
    claims, found them near, and published the sheet displaced with both witnesses agreeing on the one
    misplacement (the failure this guards: 23 published song-modes with no line within ±500 ms of truth)."""
    from encore_worker.domain.audio.activity import ShiftFit
    from encore_worker.domain.lyrics import claimmap
    from encore_worker.domain.lyrics import reconcile as rc
    from encore_worker.domain.lyrics.generate import Generated, Line
    from encore_worker.steps.align_lines import _agreement_of, _enough_decoded, _line_sync_clock

    assert claimmap.MIN_PAIRS > rc.MIN_PAIRS, "the gap this test exists for"
    fit = ShiftFit(seconds=-2.0, correlation=0.8)

    def decode(pairs: int) -> Generated:
        return Generated(
            lines=tuple(
                Line(text=f"l{i}", start=4.0 * i, end=4.0 * i + 1.0, words=(), score=-0.4, index=i)
                for i in range(pairs)
            ),
            language="en",
        )

    #: The finding's own sheet: 7 claimed lines, 4 decoded. `ceil(0.5 * 7)` = 4 armed the gate; 5 abstained
    #: the clock. Claims are 2 s late throughout, so a gate that DID read them would have something to say.
    claims = {i: 4.0 * i + 2.0 for i in range(7)}
    placed: list[Segment] = [{"text": f"l{i}", "start": at, "end": at + 1.0} for i, at in claims.items()]
    assert _enough_decoded(7) == claimmap.MIN_PAIRS
    assert _line_sync_clock(fit, claims, decode(4)) is None, "4 pairs, 5 needed"
    unread, why = _agreement_of(decode(4), placed)
    assert unread is None, "and the gate must not read what the clock could not vote on"
    assert f"under the {claimmap.MIN_PAIRS} this check needs to speak for the sheet" in why, why

    for size in range(5, 15):
        bar = _enough_decoded(size)
        sheet = {i: 4.0 * i + 2.0 for i in range(size)}
        rows: list[Segment] = [{"text": f"l{i}", "start": at, "end": at + 1.0} for i, at in sheet.items()]
        assert (_line_sync_clock(fit, sheet, decode(bar - 1)) is None) and (
            _agreement_of(decode(bar - 1), rows)[0] is None
        ), f"{size} claims, {bar - 1} pairs: both abstain"
        assert (_line_sync_clock(fit, sheet, decode(bar)) is not None) and (
            _agreement_of(decode(bar), rows)[0] is not None
        ), f"{size} claims, {bar} pairs: both read"


def test_a_line_document_never_publishes_a_backwards_claim() -> None:
    """`_in_claim_order`, on its own: the held count is what the trail reports, the input is never
    mutated (a `TextRef` is checkpointed and replayed), an untimed line passes through untouched, and a held
    line keeps BOTH edges in order — its end PAST its predecessor's, not nested inside it and not equal to it.
    Idempotent, so `_line_doc`'s own guarantee is not a second rule (Tom_Orlando jit: 1 of 72 held)."""
    from encore_worker.steps.align_lines import _in_claim_order, _line_doc

    sheet: list[Segment] = [
        {"text": "a", "start": 5.0, "end": 7.0},
        {"text": "b", "start": 4.0, "end": 4.5},  # the stray: stamped before the line ahead of it
        {"text": "untimed"},
        {"text": "c", "start": 12.0, "end": 14.0},
    ]
    frozen = json.dumps(sheet)
    ordered, held, unheld = _in_claim_order(sheet)
    assert (held, unheld) == (1, 0)
    assert [s.get("start") for s in ordered] == [5.0, 5.0, None, 12.0]
    assert [s.get("end") for s in ordered] == [7.0, 7.2, None, 14.0], "stretched past its predecessor's end"
    assert json.dumps(sheet) == frozen, "the input is not mutated"
    assert _in_claim_order(ordered)[1:] == (0, 0), "idempotent"
    lines = _line_doc(sheet, "en")["lines"]
    assert isinstance(lines, list)
    assert [line["start"] for line in lines] == [5.0, 5.0, None, 12.0], "the document, not just the rung"


def test_a_held_claim_is_not_nested_inside_the_line_before_it() -> None:
    """A held claim keeps its start AND its end, stretched past the line before it rather than level with it.

    `core`'s `activeLineIndex` returns the FIRST line whose bounds contain the playhead
    (`core/src/lib/tv/lyrics.ts`), so a line sharing its predecessor's start and ending before it can
    never be lit while it is sung. Holding the end at `max(previous, previous_end)` is a no-op on this
    fixture — b's own end (13.8) is already below a's (14.5), so b came back byte-identical to a — hence
    the stretch of `_REPAIRED_MIN_SEC` past the floor, 14.7 here. The invariant is `<=`, not `<`, because
    the equal-span case is the one that shipped."""
    from encore_worker.steps.align_geometry import _REPAIRED_MIN_SEC
    from encore_worker.steps.align_lines import _in_claim_order

    sheet: list[Segment] = [
        {"text": "a", "start": 12.0, "end": 14.5},
        {"text": "b", "start": 11.8, "end": 13.8},  # ends 0.7 s BEFORE its predecessor
        {"text": "c", "start": 22.0, "end": 24.0},
    ]
    ordered, held, unheld = _in_claim_order(sheet)
    assert (held, unheld) == (1, 0)
    assert ordered[1]["start"] == 12.0
    stretched = pytest.approx(14.5 + _REPAIRED_MIN_SEC)
    assert ordered[1]["end"] == stretched, "a stretch, not its predecessor's end"
    spans = [(float(s["start"]), float(s["end"])) for s in ordered]  # type: ignore[arg-type]
    assert all(
        not (later[0] >= earlier[0] and later[1] <= earlier[1])
        for earlier, later in zip(spans, spans[1:], strict=False)
    ), "no line's whole span is swallowed by the one before it"


def test_a_held_claims_stretch_stops_at_the_next_lines_stamp() -> None:
    """The stretch's ceiling. Lighting the held line must not cost the line AFTER it its own
    start, so the stretch stops at the next kept stamp — and where that stamp leaves no room at all the span
    stays identical to the predecessor's, on purpose: one line that is never lit is a published sheet, and the
    alternative this whole rule exists to avoid is `measure.out_of_order` reaching `decide` and the room
    getting NO LYRICS.

    Here a ends at 14.5 and c is stamped 0.05 s later, so b's stretch is cut from 14.7 to 14.55; in the second
    sheet c is stamped at a's own end, so there is no room and b comes back at 14.5."""
    from encore_worker.steps.align_lines import _in_claim_order

    room: list[Segment] = [
        {"text": "a", "start": 12.0, "end": 14.5},
        {"text": "b", "start": 11.8, "end": 13.8},
        {"text": "c", "start": 14.55, "end": 16.0},
    ]
    assert _in_claim_order(room)[0][1]["end"] == pytest.approx(14.55), "cut at c's stamp, not 14.7"
    none: list[Segment] = [*room[:2], {"text": "c", "start": 14.5, "end": 16.0}]
    ordered, held, unheld = _in_claim_order(none)
    assert (held, unheld) == (1, 0), "still held: the order gate must not see the inversion"
    assert ordered[1]["end"] == pytest.approx(14.5), "no room to stretch into, so the span stays identical"


def test_mapping_a_reversed_caption_cue_holds_its_end_at_its_start() -> None:
    """`_mapped`'s `max(mapped_end, at)`, and the only input that reaches it: a cue that arrived REVERSED.

    `ClaimMap.at` is non-decreasing by construction, so no map can invert a span handed to it in order. A
    caption track can deliver one already inverted: `parse_vtt` reads both edges off a single `-->` line
    and neither it nor `clean_segments` checks their order, while `parse_lrc` derives every end from the
    next sorted stamp and cannot. Without the hold such a cue publishes 18.0 -> 16.5 s, a span running
    backwards. The well-formed cue beside it is mapped end and all, so real spans are not flattened."""
    from encore_worker.domain.lyrics import claimmap as cm
    from encore_worker.steps.align_lines import _mapped

    clock = cm.ClaimMap(pieces=(cm.Piece(from_sec=0.0, offset_sec=-2.0, scale=1.0),), applied=True)
    sheet: list[Segment] = [
        {"text": "in order", "start": 10.0, "end": 12.0},
        {"text": "reversed cue", "start": 20.0, "end": 18.5},
        {"text": "untimed"},
    ]
    got = _mapped(sheet, clock)
    assert got[0]["start"] == pytest.approx(8.0) and got[0]["end"] == pytest.approx(10.0)
    assert clock.at(18.5) == pytest.approx(16.5), "what the map alone says about the reversed end"
    assert got[1]["start"] == pytest.approx(18.0) and got[1]["end"] == pytest.approx(18.0)
    assert got[2] == {"text": "untimed"}, "an untimed line passes through"
    assert sheet[1]["end"] == 18.5, "copies, never in place: a TextRef is checkpointed and replayed"


def test_one_late_stamp_does_not_drag_the_lines_after_it() -> None:
    """THE DRAG. `[01:00.00]` typed for `[00:10.00]` — or stacked stamps, or
    rolling captions — makes every correctly-stamped line after it "backwards". Holding them all at the late
    stamp produced nine lines sharing the instant 60.0 with `out_of_order` 0 and `usable` True, so `decide`
    committed it and the room saw one line's text for 30 s while the rest were sung. Originally that sheet was
    DROPPED, and it must be again: an inversion is held only where the next claim recovers above the last kept
    start, which is what tells a stray stamp from a run.

    The trail says which happened, because "found clean" and "could not be normalised" are different facts."""
    from encore_worker.steps.align_lines import _in_claim_order

    starts = [10.0, 60.0, 15.0, 20.0, 25.0, 30.0, 35.0, 40.0, 45.0, 50.0, 90.0, 95.0]
    sheet: list[Segment] = [
        {"text": f"line {i}", "start": start, "end": start + 2.0} for i, start in enumerate(starts)
    ]
    ordered, held, unheld = _in_claim_order(sheet)
    assert (held, unheld) == (0, 8), "eight lines sit under the late stamp; none of them is a stray"
    assert [s["start"] for s in ordered] == starts, "the sheet goes on as it came"
    report = measure.measure({"lines": ordered}, duration_sec=120.0, engine=Engine.LINE_SYNC)
    assert report.out_of_order == 1 and not report.usable, "the order gate sees it; `decide` drops the text"


def test_a_drag_inside_the_held_share_is_still_refused_by_the_recovery_test() -> None:
    """The `recovers` half of the held-stamp rule, alone.

    The 12-line sheet above has EIGHT inversions against a cap of `max(1, int(0.05 * 12))` = 1, so
    `_MAX_HELD_SHARE` refuses it and deleting the recovery test left the suite green. This sheet is 40
    lines, cap 2, and one late stamp puts exactly two lines under the cap, where only the recovery test
    can refuse them: line 5 reads 41.0 for 30.0, lines 6 and 7 are then backwards and neither recovers
    above the last kept start, so the sheet is left as it came and `decide` sees the defect. Held, both
    would sit at 41.0 — two correctly-stamped lines moved, `out_of_order` 0, the sheet published clean."""
    from encore_worker.steps.align_lines import _MAX_HELD_SHARE, _in_claim_order

    starts = [10.0 + 4.0 * i for i in range(40)]
    starts[5] = 41.0
    sheet: list[Segment] = [
        {"text": f"line {i}", "start": start, "end": start + 2.0} for i, start in enumerate(starts)
    ]
    assert max(1, int(_MAX_HELD_SHARE * len(starts))) == 2, "two inversions are INSIDE the cap"
    ordered, held, unheld = _in_claim_order(sheet)
    assert (held, unheld) == (0, 2), "the cap admits them; the recovery test is what refuses them"
    assert [s["start"] for s in ordered] == starts, "the sheet goes on as it came"
    report = measure.measure({"lines": ordered}, duration_sec=200.0, engine=Engine.LINE_SYNC)
    assert report.out_of_order == 1 and not report.usable, "the order gate still sees the late stamp"


def test_too_many_strays_leave_the_sheet_alone() -> None:
    """`_MAX_HELD_SHARE`: one stray stamp is a typo, a dozen is a sheet whose order nobody can reconstruct —
    and normalising that quietly would hide the one defect `policy.decide` drops a text for. Measured cost of
    the cap: none. Over the 1056 committed gate cases the largest `held` is ONE (Tom_Orlando and
    never-be-alone under `jit`), so nothing in the corpus comes near it."""
    from encore_worker.steps import align_lines as st

    #: Alternating strays: each is isolated (the sheet recovers above the last kept start every time), so only
    #: the cap can refuse them.
    starts = [10.0 + 4.0 * i for i in range(20)]
    for index in (3, 7, 11, 15):
        starts[index] = starts[index - 1] - 0.2
    sheet: list[Segment] = [
        {"text": f"line {i}", "start": start, "end": start + 2.0} for i, start in enumerate(starts)
    ]
    assert max(1, int(st._MAX_HELD_SHARE * len(starts))) == 1, "a 20-line sheet is allowed one stray"
    ordered, held, unheld = st._in_claim_order(sheet)
    assert (held, unheld) == (0, 4)
    assert [s["start"] for s in ordered] == starts
    one_stray = [dict(s) for s in sheet]
    for index in (7, 11, 15):
        one_stray[index]["start"] = starts[index - 1] + 2.0  # back in order, leaving a single stray
    assert st._in_claim_order(one_stray)[1:] == (1, 0), "the same sheet with one stray IS held"


def test_the_sheet_gate_does_not_trust_zero_lag() -> None:
    """Tier 2 of the envelope gate (weak r at zero lag) is evidence for a DECODE measured on this audio;
    a broad sheet envelope best-fits near zero lag whatever the text, so the sheet gate drops it."""
    from encore_worker.domain.audio.activity import ShiftFit
    from encore_worker.steps.align_lines import _envelope_passes, _sheet_passes

    weak_in_place = ShiftFit(seconds=0.0, correlation=0.3)
    assert _envelope_passes(weak_in_place) and not _sheet_passes(weak_in_place)
    assert _sheet_passes(ShiftFit(seconds=0.4, correlation=0.45))
    assert not _sheet_passes(ShiftFit(seconds=2.0, correlation=0.45)), "a moderate fit far off is refused"
    assert _sheet_passes(ShiftFit(seconds=-3.0, correlation=0.7)), "a shape that agrees is an offset"


async def test_line_sync_that_cannot_measure_the_fit_is_no_verdict(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A fit that fails answers nothing about the TEXT, so it is None (nothing timed), not `Refused`."""
    from encore_worker.domain.audio import activity

    def broken(*_args: object) -> object:
        raise ValueError("an envelope with no frames")

    monkeypatch.setattr(activity, "fit_sheet_to_audio", broken)
    reporter = Reporter()
    impl = steps(tmp_path, aligner=FakeAligner(), reporter=reporter)
    assert await impl.time_text(line_sync(tmp_path, sheet(SUNG), sung_stem(tmp_path))) is None
    assert ("align-line-sync", "declined", None) in reporter.states


async def test_line_sync_on_audio_the_machinery_cannot_read_fails_the_job(tmp_path: Path) -> None:
    """Audio ffmpeg will not decode is the MACHINERY's fault, and under `syncMode=lines` this gate
    is the only reader of it: declined, every text went the same way and the ladder ran on to a transcript
    or "no lyrics". It raises the adapter's `InfraFault`, as every other audio read does."""
    reporter = Reporter()
    impl = steps(tmp_path, aligner=FakeAligner(), reporter=reporter)
    with pytest.raises(InfraFault, match="through ffmpeg"):
        await impl.time_text(line_sync(tmp_path, sheet(SUNG), audio(tmp_path)))
    assert not any(state == "align-line-sync" for state, _verdict, _knob in reporter.states)


#: Six lines sung on `SUNG`'s spans, and the same six translated (French: the CTC fixture scores letters, so
#: a cognate-heavy language would share the sung letters in order; see `test_job_params.TRANSLATED`).
SUNG_WORDS = [
    "come and fly away",
    "with me tonight",
    "over the silver water",
    "carry me home",
    "stars are out",
    "morning light across the river",
]
TRANSLATED_WORDS = [
    "viens et envole toi",
    "avec moi ce soir",
    "sur l'eau d'argent",
    "ramene moi chez moi",
    "les etoiles sont sorties",
    "lumiere du matin sur le fleuve",
]


def worded(words: Sequence[str], spans: Sequence[tuple[float, float]] = SUNG) -> TextRef:
    """A caption track carrying `words` on `spans`, one cue per line."""
    return TextRef(
        tier=Tier.CANDIDATE,
        label="captions:authored",
        segments=tuple({"text": w, "start": a, "end": b} for w, (a, b) in zip(words, spans, strict=True)),
        timing=TIMING_LINE,
    )


def hearing(
    tmp: Path, monkeypatch: pytest.MonkeyPatch, *, envelope: Sequence[tuple[float, float]] = SUNG
) -> tuple[AudioRef, PathAligner]:
    """`sung_stem`, and an aligner whose emission matrix for it SINGS `SUNG_WORDS` on `SUNG` (the CTC fixture,
    decoded by its exact Viterbi in place of torchaudio's kernel). `envelope` is where the stem's WAV has
    its tones — what the sheet-span fit reads — built apart from the matrix, so the two can disagree."""
    from encore_worker.adapters import ml

    monkeypatch.setattr(ml, "forced_align_decoder", ctc_viterbi)
    stem = sung_stem(tmp, envelope)
    assert stem.vocals_path is not None
    phrases = [(w, a, b) for w, (a, b) in zip(SUNG_WORDS, SUNG, strict=True)]
    return stem, PathAligner({stem.vocals_path: sung_matrix(phrases, DIC, 40.0)})


async def test_line_sync_publishes_words_the_stem_sings_and_says_so(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Past the sheet gate, the lexical check reads the words on the STEM's emission matrix: sung words in
    their sung order explain it far better than shuffles of them. Its number is on the trail."""
    stem, aligner = hearing(tmp_path, monkeypatch)
    reporter = Reporter()
    impl = steps(tmp_path, aligner=aligner, reporter=reporter)
    doc = await impl.time_text(line_sync(tmp_path, worded(SUNG_WORDS), stem))
    assert isinstance(doc, TimedDoc) and doc.timing == "line"
    assert aligner.asked == [stem.vocals_path], "one emission pass, on the stem"
    assert any("lexical lift +" in why for why in reporter.reasons)


async def test_line_sync_refuses_words_that_are_not_sung_on_timings_that_are(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A caption track of THIS video fits the singing whatever its words — the sheet-span gate
    passes it at r ~ 1 — so an uploader's translation, or the machine-translated `en` track, was published
    by this rung once it could commit. The words are not what the stem sings: `Refused`, nothing written."""
    stem, aligner = hearing(tmp_path, monkeypatch)
    reporter = Reporter()
    impl = steps(tmp_path, aligner=aligner, reporter=reporter)
    got = await impl.time_text(line_sync(tmp_path, worded(TRANSLATED_WORDS), stem))
    assert isinstance(got, Refused), got
    assert got.report.engine is Engine.LINE_SYNC and got.report.refused is not None
    assert "sheet-span envelope r=" in got.report.refused, "the timings passed: they are this video's"
    assert "below the lexical gate" in got.report.refused
    assert not any(tmp_path.rglob("*-line.json")), "a refused line document is never written"


async def test_the_rung_reads_the_same_band_a_recalibration_moves(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The rung used to gate on its OWN copy of 0.2 (`_LINE_SYNC_MIN_LIFT`) while the global
    engine gated on `lexical.BANDS.refuse_below`, and `lexical`'s PER MODEL recipe — what is followed when the
    model becomes HuBERT — replaces only `BANDS`. A recalibration to a higher floor must refuse here too;
    otherwise this rung would silently keep the base model's number on the new model's emission scale."""
    stem, aligner = hearing(tmp_path, monkeypatch)
    words = worded(SUNG_WORDS)
    impl = steps(tmp_path, aligner=aligner, reporter=Reporter())
    assert isinstance(await impl.time_text(line_sync(tmp_path, words, stem)), TimedDoc)

    recalibrated = lexical.Bands(
        model="hubert-like",
        refuse_below=1e3,
        ok_from=2e3,
        mix_floor=1.0,
        mix_ok_from=2.0,
        line_sync_min_agreement=0.5,
        margin_floor_nats=10.0,
    )
    monkeypatch.setattr(lexical, "BANDS", recalibrated)
    got = await impl.time_text(line_sync(tmp_path, words, stem))
    assert isinstance(got, Refused), got
    assert got.report.refused is not None and "below the lexical gate (1000.0)" in got.report.refused


class NamingAligner:
    """`PathAligner` whose matrices NAME a bundle, as `ml.Emissions` does — so a test can put the rung on a
    model the calibration table does not have. Delegates, so `asked` stays the one emission-pass ledger."""

    def __init__(self, inner: PathAligner, model: str) -> None:
        self._inner, self._model = inner, model

    @property
    def asked(self) -> list[str]:
        return self._inner.asked

    def emissions(self, path: str, language: str) -> object:
        from dataclasses import dataclass

        got = self._inner.emissions(path, language)

        @dataclass(frozen=True)
        class Named:
            log_probs: object
            frame_sec: float
            dictionary: dict[str, int]
            model: str

            @property
            def frames(self) -> int:
                return len(self.log_probs)  # type: ignore[arg-type]

        return Named(got.log_probs, got.frame_sec, got.dictionary, self._model)


async def test_the_trail_names_the_alignment_bundle_on_both_engines(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Both engines open their evidence note with the alignment bundle (`_bundle_why`).

    `Emissions.model` had one reader in `steps/`, so a job whose `ENCORE_ALIGN_MODEL` changed between
    attempts published timings from one bundle with a note indistinguishable from the other's, and a "the
    timings got worse" report could not tell which bundle produced them — while every threshold in the
    rest of the note is read off THAT bundle's calibration row. The bench records it per run
    (`e2e_lib.align_config`), so this is asserted on the STATE the audit page reads."""
    stem, inner = hearing(tmp_path, monkeypatch)
    aligner = NamingAligner(inner, "HUBERT_ASR_LARGE")
    rung = Reporter()
    got = await steps(tmp_path, aligner=aligner, reporter=rung).time_text(
        line_sync(tmp_path, worded(SUNG_WORDS), stem)
    )
    assert isinstance(got, TimedDoc), got
    assert any(why.startswith("bundle HUBERT_ASR_LARGE; sheet-span envelope") for why in rung.reasons), (
        rung.reasons
    )

    words = tmp_path / "global"
    words.mkdir()
    stem2, inner2 = hearing(words, monkeypatch)
    reporter = Reporter()
    impl = steps(words, aligner=NamingAligner(inner2, "HUBERT_ASR_LARGE"), reporter=reporter)
    timed = await impl.time_text(
        TimeRequest(job=job(words), text=worded(SUNG_WORDS), audio=stem2, language="en")
    )
    assert isinstance(timed, TimedDoc), timed
    assert any(why.startswith("bundle HUBERT_ASR_LARGE; envelope r=") for why in reporter.reasons), (
        reporter.reasons
    )


async def test_the_rung_keeps_gating_the_decode_when_the_model_has_no_calibration(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Without a calibration row the rung's LEXICAL floor stands down and its decode check does not.

    `lexical.band` is nats per letter and belongs to the matrix's own model; the decode-agreement share
    is a fraction of lines within a tolerance in SECONDS, so it means the same thing on any bundle and is
    read through `lexical.line_sync_share`, which falls back to `LINE_SYNC_SHARE_UNCALIBRATED`. Standing
    both down left the per-language bundles on the sheet-span envelope gate alone — the gate this check
    replaced, which a same-video translation fits at r ~ 1. The sheet here is refused by the decode check
    and passed by the sheet gate, so both refusals are asserted, the uncalibrated wording included."""
    warped = [(5.0, 7.0), (5.5, 7.5), (6.0, 8.0), (20.0, 22.0), (30.0, 32.0), (31.0, 33.0)]
    stem, aligner = hearing(tmp_path, monkeypatch, envelope=warped)
    text = worded(SUNG_WORDS, warped)
    refused = await steps(tmp_path, aligner=aligner, reporter=Reporter()).time_text(
        line_sync(tmp_path, text, stem)
    )
    assert isinstance(refused, Refused), "the calibrated model gates on its share"
    assert refused.report.refused is not None and "below 50%" in refused.report.refused

    other = tmp_path / "uncalibrated"
    other.mkdir()
    stem2, inner = hearing(other, monkeypatch, envelope=warped)
    reporter = Reporter()
    impl = steps(other, aligner=NamingAligner(inner, "WAV2VEC2_LARGE_XLSR_53_DE"), reporter=reporter)
    got = await impl.time_text(line_sync(other, worded(SUNG_WORDS, warped), stem2))
    assert isinstance(got, Refused), got
    said = got.report.refused
    assert said is not None and "below 50%" in said, (
        "the share survives a missing row: it is a count of lines, not an emission scale"
    )
    assert "no lexical calibration for" in said, "the WORDS went unread, and the trail names the model"
    assert "sheet-span envelope r=" in said, "the envelope's reading stays on the trail, not gating"
    assert not any(other.rglob("*-line.json")), "a refused line document is never written"

    # ...and the same matrix with a share it DOES meet still publishes, unvouched, so the fallback is a
    # threshold and not a blanket refusal of every uncalibrated bundle.
    monkeypatch.setattr(lexical, "LINE_SYNC_SHARE_UNCALIBRATED", 0.1)
    passed = await impl.time_text(line_sync(other, worded(SUNG_WORDS, warped), stem2))
    assert isinstance(passed, TimedDoc), passed
    assert passed.vouched is False, "nothing read these words"


async def test_the_rung_gates_on_the_matrixs_own_row_and_not_the_shipped_one(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The rung's lexical floor comes off the MATRIX's calibration row, not the shipped one.

    Every other test here moves `lexical.BANDS`, which an unnamed fake resolves to anyway, so reverting
    this call site to the module-global row — one model's thresholds on another model's matrix — left the
    whole suite green. Here the matrix NAMES a bundle whose row is not the shipped one, and only the named
    row refuses this sheet: the shipped floor (0.20) publishes a text this bundle refuses. The refusal
    must print that row's number, because the note is where an operator learns which floor applied."""
    other = lexical.Bands(
        model="HUBERT_ASR_LARGE",
        refuse_below=1e3,
        ok_from=2e3,
        mix_floor=1.0,
        mix_ok_from=2.0,
        line_sync_min_agreement=0.5,
        margin_floor_nats=10.0,
    )
    monkeypatch.setitem(lexical.CALIBRATED, (other.model, other.language), other)
    stem, inner = hearing(tmp_path, monkeypatch)
    shipped = await steps(tmp_path, aligner=inner, reporter=Reporter()).time_text(
        line_sync(tmp_path, worded(SUNG_WORDS), stem)
    )
    assert isinstance(shipped, TimedDoc), "the shipped row publishes this sheet, so the rows disagree"

    named = tmp_path / "named"
    named.mkdir()
    stem2, inner2 = hearing(named, monkeypatch)
    impl = steps(named, aligner=NamingAligner(inner2, other.model), reporter=Reporter())
    got = await impl.time_text(line_sync(named, worded(SUNG_WORDS), stem2))
    assert isinstance(got, Refused), got
    said = got.report.refused
    assert said is not None and "below the lexical gate (1000.0)" in said, said
    assert not any(named.rglob("*-line.json")), "a refused line document is never written"


async def test_the_rung_reads_the_agreement_share_off_the_matrixs_row_too(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """All three shipped rows fit `line_sync_min_agreement` 0.5 and
    `LINE_SYNC_SHARE_UNCALIBRATED` is 0.5, so no test could tell "read the row" from "read the constant" —
    `line_sync_share` reduced to the constant passed the whole suite. The sheet here is the warped one the
    share refuses at 0.5 (17% of its lines near), and a row that fits 0.10 PUBLISHES it, which only reading
    the field can do."""
    warped = [(5.0, 7.0), (5.5, 7.5), (6.0, 8.0), (20.0, 22.0), (30.0, 32.0), (31.0, 33.0)]
    stem, inner = hearing(tmp_path, monkeypatch, envelope=warped)
    refused = await steps(tmp_path, aligner=inner, reporter=Reporter()).time_text(
        line_sync(tmp_path, worded(SUNG_WORDS, warped), stem)
    )
    assert isinstance(refused, Refused) and refused.report.refused is not None
    assert "below 50%" in refused.report.refused, "the shipped row's share refuses this sheet"

    lenient = lexical.Bands(
        model="HUBERT_ASR_LARGE",
        refuse_below=lexical.BANDS.refuse_below,
        ok_from=lexical.BANDS.ok_from,
        mix_floor=lexical.BANDS.mix_floor,
        mix_ok_from=lexical.BANDS.mix_ok_from,
        line_sync_min_agreement=0.1,
        margin_floor_nats=10.0,
    )
    monkeypatch.setitem(lexical.CALIBRATED, (lenient.model, lenient.language), lenient)
    named = tmp_path / "named"
    named.mkdir()
    stem2, inner2 = hearing(named, monkeypatch, envelope=warped)
    reporter = Reporter()
    impl = steps(named, aligner=NamingAligner(inner2, lenient.model), reporter=reporter)
    got = await impl.time_text(line_sync(named, worded(SUNG_WORDS, warped), stem2))
    assert isinstance(got, TimedDoc), got
    assert got.vouched is True, "the same row's lexical floor read these words"
    assert any("17% of 6 lines" in why and "bundle HUBERT_ASR_LARGE" in why for why in reporter.reasons), (
        "the share this row admitted is on the trail with the bundle that set it",
        reporter.reasons,
    )


async def test_a_sheet_refused_for_its_words_never_votes_a_clock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The rung's gate ORDER, which both `_time_line_sync` and docs/arch/04-alignment.md §5.3 had backwards.

    Both said the clock was voted "before either question"; the words gate returns first, so the rung's
    commonest refusal pays for no decode and no vote and its note carries no clock clause at all. Only a
    note read on BOTH refusals can tell that order from a note that never carries one.
    """
    refusing = lexical.Bands(
        model="HUBERT_ASR_LARGE",
        refuse_below=1e3,
        ok_from=2e3,
        mix_floor=1.0,
        mix_ok_from=2.0,
        line_sync_min_agreement=0.5,
        margin_floor_nats=10.0,
    )
    monkeypatch.setitem(lexical.CALIBRATED, (refusing.model, refusing.language), refusing)
    stem, inner = hearing(tmp_path, monkeypatch)
    impl = steps(tmp_path, aligner=NamingAligner(inner, refusing.model), reporter=Reporter())
    words = await impl.time_text(line_sync(tmp_path, worded(SUNG_WORDS), stem))
    assert isinstance(words, Refused) and words.report.refused is not None
    assert "below the lexical gate" in words.report.refused, words.report.refused
    assert "clock" not in words.report.refused, (
        "the words gate returns before the vote, so a refused sheet's note names no clock: "
        + words.report.refused
    )

    warped = [(5.0, 7.0), (5.5, 7.5), (6.0, 8.0), (20.0, 22.0), (30.0, 32.0), (31.0, 33.0)]
    timings = tmp_path / "timings"
    timings.mkdir()
    stem2, inner2 = hearing(timings, monkeypatch, envelope=warped)
    later = await steps(timings, aligner=inner2, reporter=Reporter()).time_text(
        line_sync(timings, worded(SUNG_WORDS, warped), stem2)
    )
    assert isinstance(later, Refused) and later.report.refused is not None
    assert "below 50%" in later.report.refused, later.report.refused
    assert "clock" in later.report.refused, (
        "a sheet that PASSED the words gate is voted a clock before the timings gate: " + later.report.refused
    )


async def test_a_line_sync_text_in_the_doubt_band_publishes_unvouched(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """One rule for both engines: a text the band DOUBTS publishes, and core is told its words
    are not vouched for. No text measured at this rung has landed there (the bench's read +0.36 and up), so
    the band is moved over the sung words to reach the path at all."""
    stem, aligner = hearing(tmp_path, monkeypatch)
    doubting = lexical.Bands(
        model="test",
        refuse_below=0.2,
        ok_from=1e3,
        mix_floor=0.15,
        mix_ok_from=1e3,
        line_sync_min_agreement=0.5,
        margin_floor_nats=10.0,
    )
    monkeypatch.setattr(lexical, "BANDS", doubting)
    reporter = Reporter()
    impl = steps(tmp_path, aligner=aligner, reporter=reporter)
    doc = await impl.time_text(line_sync(tmp_path, worded(SUNG_WORDS), stem))
    assert isinstance(doc, TimedDoc) and doc.vouched is False
    assert doc.confidence == "low", "a line document's TIMING grade is low either way"
    assert any("in the doubt band: nothing vouches for these words" in why for why in reporter.reasons)


async def test_a_line_sync_text_whose_words_nothing_read_publishes_unvouched(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`vouched` used to be "the band did not doubt it", which is True when NOTHING measured the
    words: an aligner with no emission matrix, an emission pass or lift decode that raised, a text under
    `lexical.MIN_LETTERS`. Only the TIMINGS were checked then (the sheet gate, or the decode agreement), and
    this rung's own hazard is a text whose timings are perfect and whose words are someone else's — sent
    vouched, a CANDIDATE-tier caption track goes to core as `textConfidence` high and ranks as a claim."""
    stem = sung_stem(tmp_path)
    blind_to_words = Reporter()
    impl = steps(tmp_path, aligner=FakeAligner(), reporter=blind_to_words)
    doc = await impl.time_text(line_sync(tmp_path, worded(TRANSLATED_WORDS), stem))
    assert isinstance(doc, TimedDoc), doc
    assert doc.vouched is False, "the sheet gate passed the TIMINGS; no gate read the words"
    assert any(
        "no lexical check: this aligner produces no emission matrix" in w for w in blind_to_words.reasons
    )

    stem, aligner = hearing(tmp_path, monkeypatch)
    heard = steps(tmp_path, aligner=aligner, reporter=Reporter())
    short = [1, 3, 4]  # 35 letters: under `lexical.MIN_LETTERS`, so the contrast is noise
    text = worded([SUNG_WORDS[i] for i in short], [SUNG[i] for i in short])
    brief = await heard.time_text(line_sync(tmp_path, text, stem))
    assert isinstance(brief, TimedDoc) and brief.vouched is False

    vouched = await heard.time_text(line_sync(tmp_path, worded(SUNG_WORDS), stem))
    assert isinstance(vouched, TimedDoc) and vouched.vouched is True, "measured and not doubted: a claim"


#: A caption track in two scripts: the CTC fixture's dictionary has no id for a Hangul syllable, so
#: `generate` drops those lines entirely and only the English ones decode (the motivating threat —
#: an uploader's translation of a K-pop song, Korean verses around an English chorus).
MIXED_SCRIPT = [
    "사랑해 그대여",
    "come and fly away",
    "내 마음 깊은 곳",
    "over the silver water",
    "그리운 밤",
    "morning light across the river",
    "별빛 아래서",
    "언제나 너와",
]
#: The English lines sit on the spans the fixture SINGS them on (`SUNG_WORDS` 0, 2, 5), so their decode
#: agrees with their claims and the 3-pair verdict would be a pass.
MIXED_SPANS = [(3.0, 4.5), SUNG[0], (11.0, 11.5), SUNG[2], (20.0, 21.0), SUNG[5], (30.0, 32.0), (33.0, 35.0)]


async def test_the_decode_check_may_not_decide_for_a_sheet_most_of_which_never_decoded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The decode check may not decide for a sheet most of which never decoded.

    The agreement share's DENOMINATOR is only the lines that decoded, so three lines could speak for a
    forty-line sheet. Here 3 of 8 claimed lines decode and the sheet gate reads the WHOLE sheet's spans:
    it refuses on a stem whose wav is silent and publishes on one that sings them, with the decode named
    as abstaining in both. Without `_enough_decoded` the 3-line verdict decides instead and refuses both
    ways, so the audible case flips. At eight claims the bound that binds is the floor
    (`claimmap.MIN_PAIRS` = 5), not the share's `ceil(0.5 * 8)` = 4, and the trail must name that one."""
    silent, aligner = hearing(tmp_path, monkeypatch, envelope=())
    impl = steps(tmp_path, aligner=aligner, reporter=Reporter())
    text = worded(MIXED_SCRIPT, MIXED_SPANS)
    got = await impl.time_text(line_sync(tmp_path, text, silent))
    assert isinstance(got, Refused), got
    assert got.report.refused is not None
    assert "below the sheet gate" in got.report.refused, "the fallback decided"
    assert (
        "no decode check: only 3 of 8 claimed lines decoded, under the 5 this check needs to speak for "
        "the sheet (the floor a placement may be read on)" in got.report.refused
    )

    audible, aligner = hearing(tmp_path, monkeypatch, envelope=MIXED_SPANS)
    heard = Reporter()
    published = await steps(tmp_path, aligner=aligner, reporter=heard).time_text(
        line_sync(tmp_path, text, audible)
    )
    assert isinstance(published, TimedDoc), "the sheet gate decides this one too, and it passes"
    assert any("only 3 of 8 claimed lines decoded" in why for why in heard.reasons)
    assert published.vouched is True, "the lift read the 58 letters that did decode and did not doubt them"

    sung, aligner = hearing(tmp_path, monkeypatch)
    passes = await steps(tmp_path, aligner=aligner).time_text(line_sync(tmp_path, worded(SUNG_WORDS), sung))
    assert isinstance(passes, TimedDoc), "a sheet whose lines all decode is decided by the decode as before"


#: `SUNG_WORDS` in German: its words keep many of the sung letters in order ("komm und flieg weg").
COGNATE_WORDS = [
    "komm und flieg weg",
    "mit mir heute nacht",
    "uber das silberne wasser",
    "trag mich nach hause",
    "die sterne sind draussen",
    "morgenlicht uber den fluss",
]


async def test_a_cognate_heavy_translation_on_this_videos_clock_line_syncs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A KNOWN LIMIT, pinned (the bench has no translated sheet to measure, `e2e_lib.OPS`): a translation
    whose words keep the sung letters in order lifts (+1.99 here, where French reads -0.87 on this matrix),
    and its decode follows the sung lines well enough (4 of 6 within 1 s) — it is published as line sync.
    Should a gate come to refuse it, this test is the one to turn around."""
    stem, aligner = hearing(tmp_path, monkeypatch)
    reporter = Reporter()
    impl = steps(tmp_path, aligner=aligner, reporter=reporter)
    got = await impl.time_text(line_sync(tmp_path, worded(COGNATE_WORDS), stem))
    assert isinstance(got, TimedDoc), got
    assert any("lexical lift +1.99" in why and "starts 67% of 6 lines" in why for why in reporter.reasons)


async def test_line_sync_publishes_sung_words_whose_envelope_the_sheet_gate_cannot_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The sheet-span gate refused 107 of 320 right texts under `syncMode=lines` (truth 4/32: hello at
    r 0.36, rap-god 0.21 — songs whose stem envelope is busy between lines), every one of them words the stem
    sings. The text's own blind decode on the stem's matrix is the timing witness now: here the stem's WAV
    gives the envelope nothing to fit, while the matrix sings each line where the text claims it."""
    stem, aligner = hearing(tmp_path, monkeypatch, envelope=())
    reporter = Reporter()
    impl = steps(tmp_path, aligner=aligner, reporter=reporter)
    doc = await impl.time_text(line_sync(tmp_path, worded(SUNG_WORDS), stem))
    assert isinstance(doc, TimedDoc) and doc.timing == "line", doc
    lines = json.loads((tmp_path / doc.ref).read_text())["lines"]
    assert [line["start"] for line in lines] == pytest.approx([start for start, _end in SUNG])
    note = next(
        why
        for (state, verdict, _k), why in zip(reporter.states, reporter.reasons, strict=True)
        if state == "align-line-sync" and verdict == "line-sync"
    )
    assert "(not gating: the decode is)" in note and "blind decode starts 100% of 6 lines" in note
    assert aligner.asked == [stem.vocals_path], "one emission pass: the lift and the decode share it"


async def test_line_sync_maps_sung_words_off_this_clock_instead_of_refusing_them(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The claim clock, ON THIS RUNG. The right words claimed 3 s late where the envelope cannot place them
    (the fit abstains) used to be REFUSED — the decode heard every line 3 s before its claim, the gate read
    0% agreement and a `syncMode=lines` refusal is terminal. That is 12 right texts on the corpus (off15 /
    off3 / tempo102 / drop50 at `run_align`), each with a lift of +0.46 to +3.60: the words are right and only
    the clock is wrong. `_line_sync_clock`'s vote now maps the sheet onto the decode first, so the gate reads
    the MAPPED claims, and what publishes is the sung spans rather than nothing."""
    stem, aligner = hearing(tmp_path, monkeypatch, envelope=())
    reporter = Reporter()
    impl = steps(tmp_path, aligner=aligner, reporter=reporter)
    late = [(a + 3.0, b + 3.0) for a, b in SUNG]
    doc = await impl.time_text(line_sync(tmp_path, worded(SUNG_WORDS, late), stem))
    assert isinstance(doc, TimedDoc), doc
    lines = json.loads((tmp_path / doc.ref).read_text())["lines"]
    # Not -3.00 but a lead short of it: the decode's onsets lead the sung frames by
    # `generate.ONSET_LEAD_SEC`, and the map puts the claims where the decode heard them. Read from the
    # constant, since it was re-fitted 40 -> 30 ms on the exact frame grid.
    lead = ONSET_LEAD_SEC
    assert [line["start"] for line in lines] == pytest.approx([a - lead for a, _b in SUNG], abs=0.02)
    note = next(why for why in reporter.reasons if "claims mapped" in why)
    assert f"by decode-median -{3.0 + lead:.2f}s (6/6)" in note and "against no-shift's 0" in note
    assert "blind decode starts 100% of 6 lines within 1.0 s of their claims" in note


async def test_line_sync_refuses_a_sheet_no_map_can_reach(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The other half of the timing gate, and the half the claim clock does NOT dissolve: a sheet whose claims
    no ONE map explains — never-be-alone's shape, where the sheet and the decode disagree
    line by line rather than by a constant. No candidate beats no-shift by the margin, so the claims stay
    where the text put them and the gate refuses them: `Refused`, nothing written, and the trail carries both
    the vote's abstention and the lift's pass, so the reason is the timings and nobody re-reads it as the
    words."""
    stem, aligner = hearing(tmp_path, monkeypatch, envelope=())
    reporter = Reporter()
    impl = steps(tmp_path, aligner=aligner, reporter=reporter)
    warped = [(5.0, 7.0), (5.5, 7.5), (6.0, 8.0), (20.0, 22.0), (30.0, 32.0), (31.0, 33.0)]
    got = await impl.time_text(line_sync(tmp_path, worded(SUNG_WORDS, warped), stem))
    assert isinstance(got, Refused), got
    assert got.report.refused is not None
    assert "lexical lift +" in got.report.refused, "the words passed: they are sung"
    assert "claims left on their own clock" in got.report.refused
    assert "under the 2-line margin" in got.report.refused
    assert "starts 17% of 6 lines" in got.report.refused and "below 50%" in got.report.refused
    assert not any(tmp_path.rglob("*-line.json")), "a refused line document is never written"


async def test_line_sync_keeps_a_sheet_already_on_our_clock_the_envelope_would_have_moved(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """THE COST THE VOTE REMOVES. `_placed_by` shifted a sheet by the activity fit
    whenever `ShiftFit.usable` held, whatever the claims already said: 23 of the documents this rung published
    had NO line within ±500 ms of truth and EVERY line within 1 s — bad-guy shifted +0.72 s, numb +0.62 s,
    their TRUTH sheets included — and the decode then read the shifted claims as near, so both witnesses
    agreed on one misplacement. Here the stem's tones sit 0.7 s before the words' matrix, so the fit is usable
    and wrong; the vote sees no-shift explain as many lines as the lag and TIES TO NO-SHIFT, so the sheet
    publishes on its own (correct) timings."""
    early = [(a - 0.7, b - 0.7) for a, b in SUNG]
    stem, aligner = hearing(tmp_path, monkeypatch, envelope=early)
    reporter = Reporter()
    impl = steps(tmp_path, aligner=aligner, reporter=reporter)
    doc = await impl.time_text(line_sync(tmp_path, worded(SUNG_WORDS), stem))
    assert isinstance(doc, TimedDoc), doc
    lines = json.loads((tmp_path / doc.ref).read_text())["lines"]
    assert [line["start"] for line in lines] == pytest.approx([a for a, _b in SUNG]), "not moved"
    note = next(why for why in reporter.reasons if "align-line-sync" not in why and "lift +" in why)
    assert "@ -0.70s" in note, "the fit measured the lag, and would have applied it before W2"
    assert "claims left on their own clock" in note


async def test_line_sync_holds_a_backwards_claim_at_the_line_before_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Tom_Orlando under `jit`: 1 of 72 claimed starts landed before the line ahead of it (sheet noise
    σ 0.3 s), the line document came back with `out_of_order` 1, and `policy.decide` sent the whole text away
    — NO LYRICS for a song whose lift was +2.92 and whose document had 63 of 72 lines within ±500 ms of truth.
    `_in_claim_order` holds such a start at its predecessor's — BOTH edges, so the held line is not nested
    inside the line before it (a nested line is one `core` can never light while it is sung) and
    not byte-identical to it either (`activeLineIndex` gives a shared span to the FIRST line, so the held
    line is stretched `_REPAIRED_MIN_SEC` past its predecessor's end, 14.5 -> 14.7 here) — and the trail says
    how many it held."""
    stem, aligner = hearing(tmp_path, monkeypatch)
    reporter = Reporter()
    impl = steps(tmp_path, aligner=aligner, reporter=reporter)
    jittered = [*SUNG[:3], (11.8, 13.8), *SUNG[4:]]  # line 3 stamped 0.2 s before line 2
    doc = await impl.time_text(line_sync(tmp_path, worded(SUNG_WORDS, jittered), stem))
    assert isinstance(doc, TimedDoc) and doc.report.out_of_order == 0, doc
    lines = json.loads((tmp_path / doc.ref).read_text())["lines"]
    assert [line["start"] for line in lines] == pytest.approx([5.0, 8.0, 12.0, 12.0, 22.0, 25.5])
    assert [line["end"] for line in lines] == pytest.approx([7.0, 10.0, 14.5, 14.7, 24.0, 27.5])
    assert any("1 claimed start(s) held at the line before them" in why for why in reporter.reasons)


async def test_line_sync_of_a_text_the_lexical_check_cannot_measure_is_still_timed_by_its_decode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Under `lexical.MIN_LETTERS` alignable letters no lexical check runs, and the timings still are.

    Three short sung lines publish; a sheet of unsung ones (once line-synced on the sheet gate alone) is
    refused. The three-line sheet is gated by its ENVELOPE, not its decode: `_enough_decoded`'s floor is
    `claimmap.MIN_PAIRS` = 5 for both readers, so on three lines the clock cannot vote and the gate cannot
    read the decode either — which is the point of one literal for both bars, the alternative being the
    state where `_placed_by`'s unconditional shift moved the claims and the gate then called the one
    misplacement near. The trail says which bound refused it."""
    stem, aligner = hearing(tmp_path, monkeypatch)
    reporter = Reporter()
    impl = steps(tmp_path, aligner=aligner, reporter=reporter)
    short = [1, 3, 4]  # "with me tonight", "carry me home", "stars are out": 35 letters
    text = worded([SUNG_WORDS[i] for i in short], [SUNG[i] for i in short])
    doc = await impl.time_text(line_sync(tmp_path, text, stem))
    assert isinstance(doc, TimedDoc), doc
    assert any(
        "no lexical check: under 40 alignable letters" in why
        and "only 3 of 3 claimed lines decoded, under the 5 this check needs to speak for the sheet" in why
        and "sheet-span envelope r=" in why
        for why in reporter.reasons
    )
    unsung = await impl.time_text(line_sync(tmp_path, sheet(SUNG), stem))  # "line 0" ...: 24 letters
    assert isinstance(unsung, Refused) and unsung.report.refused is not None
    assert "no lexical check: under 40" in unsung.report.refused and "below 50%" in unsung.report.refused


async def test_line_sync_with_no_decode_to_read_rests_on_the_sheet_gate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Where the decode cannot be read the sheet gate decides, exactly as it first shipped, and the trail says
    why: an aligner with no emission matrix (the windowed capability path), a decode that raised — which the
    bench scores as an ERROR row (`e2e.FAULT_DECODE`) — and a text with fewer than 3 lines to pair."""
    from encore_worker.domain.lyrics import generate as generate_module

    stem = sung_stem(tmp_path)
    windowed = Reporter()
    impl = steps(tmp_path, aligner=FakeAligner(), reporter=windowed)
    assert isinstance(await impl.time_text(line_sync(tmp_path, worded(TRANSLATED_WORDS), stem)), TimedDoc)
    unmeasured = "no lexical check: this aligner produces no emission matrix"
    assert any(unmeasured in why and "no decode check: this aligner" in why for why in windowed.reasons)

    stem, aligner = hearing(tmp_path, monkeypatch)

    def broken(*_args: object, **_kwargs: object) -> object:
        raise ValueError("the grouping disagrees")

    monkeypatch.setattr(generate_module, "generate", broken)
    raised = Reporter()
    impl = steps(tmp_path, aligner=aligner, reporter=raised)
    assert isinstance(await impl.time_text(line_sync(tmp_path, worded(SUNG_WORDS), stem)), TimedDoc)
    assert any(
        "lexical lift +" in why and "no decode check: it raised ValueError" in why for why in raised.reasons
    )
    monkeypatch.undo()

    stem, aligner = hearing(tmp_path, monkeypatch, envelope=())
    two = Reporter()
    impl = steps(tmp_path, aligner=aligner, reporter=two)
    got = await impl.time_text(line_sync(tmp_path, worded(SUNG_WORDS[:2], SUNG[:2]), stem))
    assert isinstance(got, Refused) and got.report.refused is not None, "the sheet gate refuses a silent stem"
    assert "below the sheet gate" in got.report.refused
    assert "no decode check: fewer than 3 lines both decoded and claimed" in got.report.refused


async def test_a_decode_the_machinery_cannot_run_fails_the_job(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The timing check's decode faulting is the machinery's, as the lift's is: declined, it would
    leave every text to the sheet gate the decode replaced."""
    from encore_worker.domain.lyrics import generate as generate_module

    def faulting(*_args: object, **_kwargs: object) -> object:
        raise InfraFault("the CTC kernel is gone")

    stem, aligner = hearing(tmp_path, monkeypatch)
    monkeypatch.setattr(generate_module, "generate", faulting)
    impl = steps(tmp_path, aligner=aligner)
    with pytest.raises(InfraFault, match="kernel"):
        await impl.time_text(line_sync(tmp_path, worded(SUNG_WORDS), stem))


async def test_a_line_sync_fit_that_failed_leaves_the_lines_where_the_text_put_them(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The envelope fit only PLACES the lines now: one that fails abstains (as `_placed` does), and the decode
    still gates. With neither readable the rung declines (`test_line_sync_that_cannot_measure_the_fit...`)."""
    from encore_worker.domain.audio import activity

    def broken(*_args: object) -> object:
        raise ValueError("an envelope with no frames")

    stem, aligner = hearing(tmp_path, monkeypatch)
    monkeypatch.setattr(activity, "fit_sheet_to_audio", broken)
    reporter = Reporter()
    impl = steps(tmp_path, aligner=aligner, reporter=reporter)
    doc = await impl.time_text(line_sync(tmp_path, worded(SUNG_WORDS), stem))
    assert isinstance(doc, TimedDoc), doc
    assert any(
        "sheet-span envelope unreadable, 6 lines left where the text put them" in w for w in reporter.reasons
    )


async def test_a_lexical_check_the_machinery_cannot_run_fails_the_job(tmp_path: Path) -> None:
    """An emission pass that faults is the machinery's: declining it would publish every text on
    the sheet gate alone, the hole the check closes."""

    class Faulting:
        def emissions(self, path: str, language: str) -> object:
            raise InfraFault("the emission pass on mps faulted")

    impl = steps(tmp_path, aligner=Faulting())
    with pytest.raises(InfraFault, match="emission pass"):
        await impl.time_text(line_sync(tmp_path, worded(SUNG_WORDS), sung_stem(tmp_path)))


async def test_line_sync_declines_a_song_with_no_vocals_stem(tmp_path: Path) -> None:
    """Forced mode's own fallback to this rung ran the sheet gate on the MIX when there was no
    stem, where it cannot discriminate (39/416 right texts, 3/320 wrong, measured): a wrong text whose decode
    was declined or inverted reached a rung that used to drop it. Declined — no verdict on the text."""
    reporter = Reporter()
    impl = steps(tmp_path, aligner=FakeAligner(), reporter=reporter)
    stem = sung_stem(tmp_path)
    mix_only = AudioRef(path=str(stem.vocals_path), duration_sec=stem.duration_sec, vocals_path=None)
    assert await impl.time_text(line_sync(tmp_path, sheet(SUNG), mix_only)) is None
    assert ("align-line-sync", "declined", None) in reporter.states
    assert any("no vocals stem" in why for why in reporter.reasons)


async def test_the_asr_tier_leaves_this_rung_before_either_gate_and_before_the_stemless_decline(
    tmp_path: Path,
) -> None:
    """The exit the rung's docstring has to name: a transcript is not a sheet.

    Its spans were measured on this recording, so it publishes them with NO sheet gate — and because that
    happens before the decline above, on the mix as well (docs/arch/04-alignment.md §5.3).
    """
    reporter = Reporter()
    impl = steps(tmp_path, aligner=FakeAligner(), reporter=reporter)
    stem = sung_stem(tmp_path)
    mix_only = AudioRef(path=str(stem.vocals_path), duration_sec=stem.duration_sec, vocals_path=None)
    heard = TextRef(tier=Tier.ASR, label="asr:vocals", segments=sheet(SUNG).segments, timing=TIMING_LINE)
    got = await impl.time_text(line_sync(tmp_path, heard, mix_only))
    assert isinstance(got, TimedDoc), "a transcript read as a sheet would fail both gates; it is not read so"
    assert got.timing == "line" and got.confidence == "low"
    assert ("align-line-sync", "line-sync", None) in reporter.states
    assert any("no sheet gate" in why for why in reporter.reasons)
    assert not any("no vocals stem" in why for why in reporter.reasons), "it left before that decline"


async def test_line_sync_gates_on_the_stem_even_after_a_mix_retry(tmp_path: Path) -> None:
    """The sheet gate is calibrated on stems, so it reads the stem whatever the attempt aligned on: a windowed
    `ALIGN_ON_MIX` retry's knobs are this rung's too. The mix here is not even a file — gating on it would
    have raised ffmpeg's fault."""
    impl = steps(tmp_path, aligner=FakeAligner())
    req = TimeRequest(
        job=job(tmp_path),
        text=sheet(SUNG),
        audio=sung_stem(tmp_path),
        language="en",
        knobs=frozenset({Knob.ALIGN_ON_MIX, Knob.LINE_SYNC}),
    )
    assert isinstance(await impl.time_text(req), TimedDoc)


async def test_a_retry_never_overwrites_the_attempt_it_retried(tmp_path: Path) -> None:
    """The mix retry rewrote the stem attempt's file at the same ref, so a workflow that wanted
    the stem document back could only publish the mix one's bytes. The knob set is in the ref now; a
    first attempt keeps the plain ref it always had."""
    impl = steps(tmp_path, aligner=FakeAligner())
    first = await impl.time_text(
        TimeRequest(job=job(tmp_path), text=lrc_text(), audio=audio(tmp_path), language="en")
    )
    retry = await impl.time_text(
        TimeRequest(
            job=job(tmp_path),
            text=lrc_text(),
            audio=audio(tmp_path),
            language="en",
            knobs=frozenset({Knob.DROP_WINDOWS, Knob.ALIGN_ON_MIX}),
        )
    )
    assert isinstance(first, TimedDoc) and isinstance(retry, TimedDoc)
    assert first.ref == "work/j1/lyrics/m1-lrclib-word.json"
    assert retry.ref == "work/j1/lyrics/m1-lrclib-align-on-mix-drop-windows-word.json", "Knob order"
    assert (tmp_path / first.ref).exists() and (tmp_path / retry.ref).exists()


async def test_attempts_are_staged_in_scratch_and_placed_only_once_the_job_is_ours(tmp_path: Path) -> None:
    """An attempt used to be written straight into the store, and only a job that reached
    `publish` reported it — so one an `InfraFault` failed mid-ladder left its earlier attempts there, named
    by nothing core's retention reads, for good; and a re-align overwrote the document the TV showed with
    an attempt the ladder might reject. Attempts are staged in job scratch now: nothing is in the store
    until `publish` has re-asserted ownership, and then every attempt the job wrote is, under the ref core
    is told (`store_ref`), byte for byte."""
    from encore_worker.steps.api import store_ref

    lost = Reporter(owns=False)
    impl = steps(tmp_path, reporter=lost, aligner=FakeAligner())
    first = await impl.time_text(
        TimeRequest(job=job(tmp_path), text=lrc_text(), audio=audio(tmp_path), language="en")
    )
    retry = await impl.time_text(
        TimeRequest(
            job=job(tmp_path),
            text=lrc_text(),
            audio=audio(tmp_path),
            language="en",
            knobs=frozenset({Knob.ALIGN_ON_MIX}),
        )
    )
    assert isinstance(first, TimedDoc) and isinstance(retry, TimedDoc)
    store = tmp_path / "derived" / "lyrics"
    assert not store.exists(), "an attempt reaches the store only through publish"
    with pytest.raises(NotOurJob):
        await impl.publish(job(tmp_path), first, placing=[first, retry])
    assert not store.exists(), "a job that is no longer ours places nothing"

    impl = steps(tmp_path, reporter=Reporter(owns=True), aligner=FakeAligner())
    uri = await impl.publish(job(tmp_path), first, placing=[first, retry])
    assert uri == store_ref(job(tmp_path), first.ref) == "derived/lyrics/m1-lrclib-word.json"
    assert sorted(p.name for p in store.iterdir()) == [
        "m1-lrclib-align-on-mix-word.json",
        "m1-lrclib-word.json",
    ]
    for attempt in (first, retry):
        placed = tmp_path / store_ref(job(tmp_path), attempt.ref)
        assert placed.read_bytes() == (tmp_path / attempt.ref).read_bytes()


async def test_the_windowed_engine_declares_itself(tmp_path: Path) -> None:
    """So the policy may offer it the knobs the global engine does not read."""
    impl = steps(tmp_path, aligner=FakeAligner())
    doc = await impl.time_text(
        TimeRequest(job=job(tmp_path), text=lrc_text(), audio=audio(tmp_path), language="en")
    )
    assert isinstance(doc, TimedDoc) and doc.report.engine is Engine.WINDOWED


async def test_an_out_of_order_windowed_document_names_its_lines_on_the_trail(tmp_path: Path) -> None:
    """whisperx aligns each segment inside its own crop, so nothing orders one segment's words against
    the next's. The document is still returned (`decide` answers the inversion with line sync), and the
    trail says which lines ran backwards."""

    class Inverting(FakeAligner):
        def align(self, search: Sequence[Segment], audio_path: str, language: str) -> Sequence[Segment]:
            return [
                {
                    "text": "a b",
                    "words": [
                        {"word": "a", "start": 5.0, "end": 5.4},
                        {"word": "b", "start": 5.5, "end": 5.9},
                    ],
                },
                {
                    "text": "c d",
                    "words": [
                        {"word": "c", "start": 4.0, "end": 4.4},
                        {"word": "d", "start": 4.5, "end": 4.9},
                    ],
                },
            ]

    class Whys(Reporter):
        def __init__(self) -> None:
            super().__init__()
            self.whys: list[tuple[str, str, str]] = []

        async def state(
            self, job_id: str, state: str, attempt: int, verdict: str, why: str, knob: str | None
        ) -> None:
            self.whys.append((state, verdict, why))

    reporter = Whys()
    impl = steps(tmp_path, reporter=reporter, aligner=Inverting())
    doc = await impl.time_text(
        TimeRequest(job=job(tmp_path), text=lrc_text(), audio=audio(tmp_path), language="en")
    )
    assert isinstance(doc, TimedDoc) and doc.report.out_of_order == 1
    assert reporter.whys == [("align-windowed", "out-of-order", "1 word starts run backwards, in lines [1]")]


# ── acquisition ──────────────────────────────────────────────────────────────────────────────────


async def test_a_local_source_is_not_downloaded(tmp_path: Path) -> None:
    """Decided from the DECLARED fetcher, never by sniffing the uri — an unrecognised scheme would
    otherwise reach ffmpeg stages later as an opaque failure."""
    (tmp_path / "already.mp3").write_bytes(b"x")
    impl = steps(tmp_path)
    got = await impl.acquire_audio(
        JobRef(
            job_id="j1",
            media_id="m1",
            media_dir=str(tmp_path),
            source_uri=str(tmp_path / "already.mp3"),
            params={"fetcher": "local"},
        )
    )
    assert got.path.endswith("already.mp3")


async def test_a_remote_source_with_no_fetcher_fails_permanently(tmp_path: Path) -> None:
    """A capability this box lacks is not fixed by retrying."""
    impl = steps(tmp_path)
    with pytest.raises(RuntimeError) as raised:
        await impl.acquire_audio(job(tmp_path))
    assert getattr(raised.value, "retryable", True) is False


async def test_a_recorded_stem_that_is_not_on_disk_is_ignored(tmp_path: Path) -> None:
    """A stems job that refused to publish a silent instrumental leaves the ref recorded and the file
    absent. Aligning against it would fail deep inside the model instead of degrading to the mix."""
    (tmp_path / "a.mp3").write_bytes(b"x")
    impl = steps(tmp_path)
    got = await impl.acquire_audio(
        JobRef(
            job_id="j1",
            media_id="m1",
            media_dir=str(tmp_path),
            source_uri=str(tmp_path / "a.mp3"),
            params={"fetcher": "local", "vocalsRef": "derived/stems/missing.wav"},
        )
    )
    assert got.vocals_path is None


async def test_a_present_stem_is_used(tmp_path: Path) -> None:
    (tmp_path / "a.mp3").write_bytes(b"x")
    (tmp_path / "derived").mkdir()
    (tmp_path / "derived" / "v.wav").write_bytes(b"x")
    impl = steps(tmp_path)
    got = await impl.acquire_audio(
        JobRef(
            job_id="j1",
            media_id="m1",
            media_dir=str(tmp_path),
            source_uri=str(tmp_path / "a.mp3"),
            params={"fetcher": "local", "vocalsRef": "derived/v.wav"},
        )
    )
    assert got.vocals_path is not None and got.vocals_path.endswith("v.wav")


# ── the provider ─────────────────────────────────────────────────────────────────────────────────


async def test_the_provider_is_not_asked_without_both_artist_and_track(tmp_path: Path) -> None:
    """A lookup on a guessed title returns another song's words, which is worse than a miss."""
    provider = FakeProvider([{"start": 0.0, "text": "x"}])
    impl = steps(tmp_path, providers=(provider,))

    assert await impl.fetch_provider_lyrics(job(tmp_path, artist="a-ha"), audio(tmp_path)) == []
    assert provider.calls == [], "an incomplete lookup must not be attempted at all"

    got = await impl.fetch_provider_lyrics(job(tmp_path, artist="a-ha", track="Take On Me"), audio(tmp_path))
    assert [t.tier for t in got] == [Tier.CANDIDATE]


async def test_unsynced_provider_lyrics_carry_no_line_timing(tmp_path: Path) -> None:
    """Which is what makes LINE_SYNC unavailable for them — there is nothing to fall back to."""
    impl = steps(tmp_path, providers=(FakeProvider([{"text": "a wall of text"}]),))
    got = await impl.fetch_provider_lyrics(job(tmp_path, artist="a", track="b"), audio(tmp_path))
    assert [t.timing for t in got] == [None]
    assert [t.has_own_timings for t in got] == [False]


async def test_a_word_timed_provider_sheet_keeps_the_line_sync_rung(tmp_path: Path) -> None:
    """`clean_segments` rewrites word lists as TUPLES, so a provider that
    returns word spans is labelled `TIMING_WORD` — and the rung must still be offered for it, because its
    segments carry their lines' spans and the rung is the only fallback once its word timing cannot ship."""
    cues = [
        {"start": 1.0, "end": 2.0, "text": "aaa bbb", "words": [{"word": "aaa", "start": 1.0, "end": 1.5}]},
        {"start": 2.0, "end": 3.0, "text": "ccc ddd", "words": [{"word": "ccc", "start": 2.0, "end": 2.5}]},
    ]
    impl = steps(tmp_path, providers=(FakeProvider(cues),))
    got = await impl.fetch_provider_lyrics(job(tmp_path, artist="a", track="b"), audio(tmp_path))
    assert [t.timing for t in got] == [TIMING_WORD]
    assert [t.has_own_timings for t in got] == [True]
    assert align._candidate_of(got[0]).first_attempt(aligned_on_stem=True).can(Knob.LINE_SYNC)


async def test_a_provider_miss_is_an_empty_pool(tmp_path: Path) -> None:
    impl = steps(tmp_path, providers=(FakeProvider([]),))
    assert await impl.fetch_provider_lyrics(job(tmp_path, artist="a", track="b"), audio(tmp_path)) == []


# ── tiers ────────────────────────────────────────────────────────────────────────────────────────


class FakeCaptions:
    def __init__(self, cues: Sequence[Segment]) -> None:
        self.cues = cues

    def fetch(self, source_uri: str, out_dir: str, *, automatic: bool) -> Sequence[Segment]:
        return self.cues


async def test_authored_captions_are_a_candidate_and_machine_captions_are_not(tmp_path: Path) -> None:
    """A machine track is evidence of what is audible, never a claim about the words."""
    impl = steps(tmp_path, captions=FakeCaptions([{"start": 0.0, "end": 1.0, "text": "hi"}]))

    authored = await impl.fetch_captions(job(tmp_path), automatic=False)
    machine = await impl.fetch_captions(job(tmp_path), automatic=True)

    assert authored is not None and authored.tier is Tier.CANDIDATE
    assert machine is not None and machine.tier is Tier.MACHINE


async def test_a_caption_track_stays_line_timed_even_when_its_cues_carry_word_claims(
    tmp_path: Path,
) -> None:
    """Pinned as a decision rather than left to a docstring: `parse_vtt`'s rule 4
    attaches a rolling track's inline onsets as `words`, and this path still declares `TIMING_LINE`, because
    declaring word timing would make a machine's per-word guesses the job's CLAIMS. The payload rides along
    for the wave that measures that; the label does not move until then (`fetch_captions` carries the why)."""
    cues: list[Segment] = [
        {
            "start": 0.0,
            "end": 2.0,
            "text": "aaa bbb",
            "words": ({"word": "aaa", "start": 0.0, "end": 1.0}, {"word": "bbb", "start": 1.0, "end": 2.0}),
        }
    ]
    got = await steps(tmp_path, captions=FakeCaptions(cues)).fetch_captions(job(tmp_path), automatic=True)

    assert got is not None
    assert got.timing == TIMING_LINE
    assert "words" in got.segments[0], "the claims are carried, not dropped"


async def test_a_transcription_is_the_asr_tier_and_has_no_own_timings(tmp_path: Path) -> None:
    """Word-timed, but measured on THIS audio — so placement, and `Knob.RESHIFT`, are meaningless."""

    class FakeTranscriber:
        def transcribe(self, audio_path: str, *, language: str | None = None) -> ports.Transcribed:
            return ports.Transcribed(segments=({"start": 0.0, "end": 1.0, "text": "heard this"},))

    impl = steps(tmp_path, transcriber=FakeTranscriber())
    got = await impl.transcribe(job(tmp_path), audio(tmp_path), on_vocals=True)

    assert got is not None
    assert got.tier is Tier.ASR
    assert got.label == "asr:vocals"
    assert got.has_own_timings is False


async def test_no_transcriber_yields_none(tmp_path: Path) -> None:
    """Which the search reads as "ASR had its turn and heard nothing"."""
    assert await steps(tmp_path).transcribe(job(tmp_path), audio(tmp_path), on_vocals=True) is None


# ── the guarded publish ──────────────────────────────────────────────────────────────────────────


async def test_publish_asks_the_core_first(tmp_path: Path) -> None:
    """A lease can expire DURING a 45-minute alignment, so checking only at reconnect leaves the window
    where two workers publish different lyrics for one song."""
    reporter = Reporter(owns=True)
    impl = steps(tmp_path, reporter=reporter, aligner=FakeAligner())
    doc = await impl.time_text(
        TimeRequest(job=job(tmp_path), text=lrc_text(), audio=audio(tmp_path), language="en")
    )
    assert isinstance(doc, TimedDoc)
    assert await impl.publish(job(tmp_path), doc) != ""
    assert reporter.asked == ["j1"], "ownership must be re-asserted at publish time"


async def test_publish_refuses_when_ownership_is_gone(tmp_path: Path) -> None:
    reporter = Reporter(owns=False)
    impl = steps(tmp_path, reporter=reporter, aligner=FakeAligner())
    with pytest.raises(NotOurJob, match="taken from us"):
        await impl.publish(job(tmp_path), None)


async def test_the_no_lyrics_outcome_still_publishes(tmp_path: Path) -> None:
    """Readiness waits on align, so a silent completion strands the song in "processing" forever."""
    impl = steps(tmp_path, reporter=Reporter(owns=True))
    assert await impl.publish(job(tmp_path), None) == ""


async def test_a_note_failure_never_fails_a_job(tmp_path: Path) -> None:
    """Diagnostics must not be able to break work."""

    class Broken(Reporter):
        async def state(
            self, job_id: str, state: str, attempt: int, verdict: str, why: str, knob: str | None
        ) -> None:
            raise OSError("socket gone")

    impl = steps(tmp_path, reporter=Broken())
    await impl.note(job(tmp_path), "time", 1, "try", "because", None)  # must not raise


# ── the silence probe's honesty ──────────────────────────────────────────────────────────────────


def _store(tmp_path: Path) -> LocalArtifactStore:
    """A real store over a temp tree. Real rather than faked: it holds four strings and touches no disk
    until something is published, and these tests publish nothing."""
    return LocalArtifactStore(Roots.under(str(tmp_path / "media")))


async def test_probe_silence_reports_none_rather_than_inventing_a_loud_reading(tmp_path: Path) -> None:
    """With no probe the step must say "I do not know", not return a number meaning "definitely fine"."""
    from encore_worker.steps.separate_steps import SeparateStepsImpl

    impl = SeparateStepsImpl(
        config=CFG,
        audio=steps(tmp_path),
        reporter=Reporter(),
        store=_store(tmp_path),
        separator=None,
        probe=None,
    )
    assert await impl.probe_silence(job(tmp_path), audio(tmp_path)) is None


async def test_probe_silence_passes_through_a_real_measurement(tmp_path: Path) -> None:
    from encore_worker.steps.separate_steps import SeparateStepsImpl

    class Probe:
        def duration_sec(self, audio_path: str) -> float:
            return 200.0

        def peak_dbfs(self, audio_path: str) -> float | None:
            return -6.5

    impl = SeparateStepsImpl(
        config=CFG,
        audio=steps(tmp_path),
        reporter=Reporter(),
        store=_store(tmp_path),
        separator=None,
        probe=Probe(),
    )
    assert await impl.probe_silence(job(tmp_path), audio(tmp_path)) == -6.5


# ── RESHIFT actually re-places ────────────────────────────────────────────────────────────────────


async def test_reshift_without_a_reference_is_the_identity(tmp_path: Path) -> None:
    """Correct for a first attempt: there is no series measured on this recording to place against."""
    aligner = FakeAligner()
    impl = steps(tmp_path, aligner=aligner)
    text = lrc_text()
    await impl.time_text(
        TimeRequest(
            job=job(tmp_path),
            text=text,
            audio=audio(tmp_path),
            language="en",
            knobs=frozenset({Knob.RESHIFT, Knob.DROP_WINDOWS}),
        )
    )
    assert aligner.calls[0][0] == text.segments, "with no reference the text must be searched unmoved"


async def test_reshift_moves_the_text_onto_the_previous_alignment(tmp_path: Path) -> None:
    """THE fix. An earlier version fitted the text against its own windows — two views of one series —
    which was a near-identity, so the knob burned an alignment pass and changed nothing."""
    aligner = FakeAligner()
    impl = steps(tmp_path, aligner=aligner)
    text = TextRef(
        tier=Tier.CANDIDATE,
        label="lrclib",
        segments=(
            {"start": 0.0, "end": 1.0, "text": "one"},
            {"start": 10.0, "end": 11.0, "text": "two"},
            {"start": 20.0, "end": 21.0, "text": "three"},
            {"start": 30.0, "end": 31.0, "text": "four"},
        ),
        timing=TIMING_LINE,
        language="en",
    )
    # The previous alignment found those lines five seconds later than the sheet claims.
    await impl.time_text(
        TimeRequest(
            job=job(tmp_path),
            text=text,
            audio=audio(tmp_path),
            language="en",
            knobs=frozenset({Knob.RESHIFT}),
            reference_starts=(5.0, 15.0, 25.0, 35.0),
        )
    )
    searched = aligner.calls[0][0]
    assert [s["start"] for s in searched] == [5.0, 15.0, 25.0, 35.0], (
        "the searched spans must be moved onto the reference, not left where the sheet put them"
    )


async def test_the_written_record_carries_line_starts_for_the_next_attempt(tmp_path: Path) -> None:
    """Without these the next RESHIFT has no reference and silently degrades to the identity."""
    impl = steps(tmp_path, aligner=FakeAligner(words=3))
    doc = await impl.time_text(
        TimeRequest(job=job(tmp_path), text=lrc_text(), audio=audio(tmp_path), language="en")
    )
    assert isinstance(doc, TimedDoc)
    assert doc.line_starts == (0.0,), "one line, starting at its first timed word"


async def test_line_starts_come_from_the_first_timed_word_not_the_line_field(tmp_path: Path) -> None:
    """Some aligners copy the input's line `start` through while moving the words inside it. Reading that
    field would hand the next RESHIFT the very series it was trying to correct."""

    class CopiesThroughLineStart(FakeAligner):
        def align(self, search, audio_path, language):  # type: ignore[no-untyped-def]
            self.calls.append((tuple(search), audio_path))
            return [{"start": 0.0, "words": [{"word": "a", "start": 7.5, "end": 8.0}]}]

    impl = steps(tmp_path, aligner=CopiesThroughLineStart())
    doc = await impl.time_text(
        TimeRequest(job=job(tmp_path), text=lrc_text(), audio=audio(tmp_path), language="en")
    )
    assert isinstance(doc, TimedDoc)
    assert doc.line_starts == (7.5,), "must read the word, not the copied-through line field"


# ── the provider chain ────────────────────────────────────────────────────────────────────────────


class FakeChainProvider:
    """A provider that hits, misses, or fails — for exercising the chain."""

    def __init__(self, name: str, *, cues: Sequence[Segment] = (), raises: Exception | None = None) -> None:
        self.name = name
        self._cues = cues
        self._raises = raises
        self.calls = 0
        self.last_source: str | None = None

    def fetch(self, *, artist: str, track: str, duration_sec: float | None) -> Sequence[Segment]:
        self.calls += 1
        if self._raises is not None:
            raise self._raises
        return self._cues


LINE = ({"start": 0.0, "end": 2.0, "text": "hello"},)
WORDS = ({"start": 0.0, "end": 2.0, "text": "hello", "words": [{"word": "hello", "start": 0.0, "end": 2.0}]},)


async def test_every_provider_is_asked_even_after_one_hits(tmp_path: Path) -> None:
    """The first hit used to short-circuit the chain, and lrcmux is first, so LRCLIB was
    queried only when lrcmux was UNREACHABLE — never when it merely answered with a worse sheet."""
    first = FakeChainProvider("mux", cues=LINE)
    second = FakeChainProvider("direct", cues=({"start": 0.0, "end": 2.0, "text": "a different sheet"},))
    impl = steps(tmp_path, providers=(first, second))

    got = await impl.fetch_provider_lyrics(job(tmp_path, artist="a", track="b"), audio(tmp_path))
    assert [t.label for t in got] == ["mux", "direct"]
    assert second.calls == 1, "a hit must NOT short-circuit the rest of the chain"


async def test_two_providers_returning_the_same_words_are_one_candidate(tmp_path: Path) -> None:
    """LRCLIB is one of the sources lrcmux queries, so byte-identical answers are the common case. A
    duplicate in the pool would spend a whole second attempt — emission pass included — on the same words.

    Compared on the NORMALISED words, so punctuation and case do not read as a second opinion."""
    first = FakeChainProvider("mux", cues=({"start": 0.0, "end": 2.0, "text": "Hello, world!"},))
    second = FakeChainProvider("direct", cues=({"text": "hello world"},))
    impl = steps(tmp_path, providers=(first, second))

    got = await impl.fetch_provider_lyrics(job(tmp_path, artist="a", track="b"), audio(tmp_path))
    assert [t.label for t in got] == ["mux"], "the first provider to answer keeps the slot"
    assert second.calls == 1, "it is still asked; only the duplicate text is dropped"


async def test_a_miss_falls_through_to_the_next_provider(tmp_path: Path) -> None:
    empty = FakeChainProvider("mux", cues=())
    backup = FakeChainProvider("direct", cues=LINE)
    impl = steps(tmp_path, providers=(empty, backup))

    got = await impl.fetch_provider_lyrics(job(tmp_path, artist="a", track="b"), audio(tmp_path))
    assert [t.label for t in got] == ["direct"]


async def test_a_provider_that_raises_does_not_stop_the_chain(tmp_path: Path) -> None:
    """One being unreachable is exactly when the next matters most — a network that blocks one host may
    reach another."""
    broken = FakeChainProvider("mux", raises=OSError("blocked by proxy"))
    backup = FakeChainProvider("direct", cues=LINE)
    impl = steps(tmp_path, providers=(broken, backup))

    got = await impl.fetch_provider_lyrics(job(tmp_path, artist="a", track="b"), audio(tmp_path))
    assert [t.label for t in got] == ["direct"]
    assert backup.calls == 1


async def test_every_provider_failing_is_reported_not_swallowed(tmp_path: Path) -> None:
    """ "Every provider is down" and "this song is obscure" must stay distinguishable — conflating them is
    what once hid a month-long outage."""
    reporter = Reporter()
    impl = steps(
        tmp_path,
        reporter=reporter,
        providers=(
            FakeChainProvider("mux", raises=OSError("blocked")),
            FakeChainProvider("direct", raises=OSError("also blocked")),
        ),
    )
    got = await impl.fetch_provider_lyrics(job(tmp_path, artist="a", track="b"), audio(tmp_path))

    assert got == []
    verdicts = [verdict for _state, verdict, _knob in reporter.states]
    assert "providers-down" in verdicts


async def test_an_ordinary_miss_is_not_reported_as_an_outage(tmp_path: Path) -> None:
    reporter = Reporter()
    impl = steps(tmp_path, reporter=reporter, providers=(FakeChainProvider("mux", cues=()),))
    assert await impl.fetch_provider_lyrics(job(tmp_path, artist="a", track="b"), audio(tmp_path)) == []
    assert "providers-down" not in [v for _s, v, _k in reporter.states]


async def test_word_level_lyrics_are_recorded_as_word_timed(tmp_path: Path) -> None:
    """LRCmux can return word spans; LRCLIB cannot. The timing is read from the PAYLOAD, so a word-timed
    sheet gets the knobs a word-timed sheet should have."""
    impl = steps(tmp_path, providers=(FakeChainProvider("mux", cues=WORDS),))
    got = await impl.fetch_provider_lyrics(job(tmp_path, artist="a", track="b"), audio(tmp_path))
    assert [t.timing for t in got] == ["word"]
    assert got[0].has_own_timings is True, "not ASR, so placement and RESHIFT apply"


async def test_an_a2_sheets_word_onsets_make_it_a_word_timed_candidate(tmp_path: Path) -> None:
    """`_has_word_spans` tested `isinstance(..., list)`, while EVERY provider payload
    comes back through `clean_segments`, which rewrites the word list as a TUPLE on purpose (its own comment:
    "A TUPLE, matching every other segment producer"). So the one shape A2 parsing was built for could never
    be classified word-timed, and `parse_lrc`'s claim that reading A2 tags "makes the sheet a WORD-TIMED
    candidate instead" was false for every enhanced sheet — as it would be for lrcmux's own word payload."""
    cues = parse_lrc("[ar:x]\n[00:12.00] <00:12.10> aaa <00:12.44> bbb\n[00:15.00] <00:15.10> ccc ddd\n")
    assert all(isinstance(cue.get("words"), tuple) for cue in cues), "the shape the list test could not see"
    impl = steps(tmp_path, providers=(FakeChainProvider("direct", cues=cues),))

    got = await impl.fetch_provider_lyrics(job(tmp_path, artist="a", track="b"), audio(tmp_path))
    assert [t.timing for t in got] == ["word"]


async def test_a_multiplexers_upstream_reaches_the_label(tmp_path: Path) -> None:
    """The trail should say `mux:KuGou`, so a systematically bad source is identifiable."""
    provider = FakeChainProvider("mux", cues=LINE)
    provider.last_source = "KuGou"
    impl = steps(tmp_path, providers=(provider,))
    got = await impl.fetch_provider_lyrics(job(tmp_path, artist="a", track="b"), audio(tmp_path))
    assert [t.label for t in got] == ["mux:KuGou"]


async def test_no_providers_at_all_is_a_quiet_miss(tmp_path: Path) -> None:
    impl = steps(tmp_path, providers=())
    assert await impl.fetch_provider_lyrics(job(tmp_path, artist="a", track="b"), audio(tmp_path)) == []


# ── untimed text gets provisional spans before the aligner sees it ─────────────────────────────────


async def test_an_untimed_text_is_given_spans_before_alignment(tmp_path: Path) -> None:
    """The step-level half of a bug found only by running the real aligner: whisperx crops per segment, so
    it raises `KeyError: 'start'` on untimed input — which the broad `except` below turned into a silently
    discarded candidate, dropping every plain lyrics sheet to the ASR tier."""
    aligner = FakeAligner()
    impl = steps(tmp_path, aligner=aligner)
    plain = TextRef(
        tier=Tier.CANDIDATE,
        label="plain-sheet",
        segments=({"text": "first line"}, {"text": "second line here"}),
    )

    await impl.time_text(TimeRequest(job=job(tmp_path), text=plain, audio=audio(tmp_path), language="en"))

    searched = aligner.calls[0][0]
    assert all("start" in span and "end" in span for span in searched), (
        f"every span handed to the aligner must be timed; got {searched}"
    )
    assert float(searched[0]["start"]) == 0.0  # type: ignore[arg-type]
    assert float(searched[-1]["end"]) == 200.0, "the spans must cover the whole audio"  # type: ignore[arg-type]


async def test_an_already_timed_text_is_not_re_spanned(tmp_path: Path) -> None:
    """Its own timings are measured; replacing them with a character-share guess would throw away real
    information and undo the placement the search depends on."""
    aligner = FakeAligner()
    impl = steps(tmp_path, aligner=aligner)
    text = lrc_text()

    await impl.time_text(
        TimeRequest(
            job=job(tmp_path),
            text=text,
            audio=audio(tmp_path),
            language="en",
            knobs=frozenset({Knob.DROP_WINDOWS}),
        )
    )
    assert aligner.calls[0][0] == text.segments, "timed segments must reach the aligner unchanged"


async def test_an_untimed_text_with_an_unknown_duration_is_left_alone(tmp_path: Path) -> None:
    """Nothing to apportion against. The aligner then refuses by name, which is the honest outcome."""
    aligner = FakeAligner()
    impl = steps(tmp_path, aligner=aligner)
    plain = TextRef(tier=Tier.CANDIDATE, label="plain", segments=({"text": "words"},))

    await impl.time_text(
        TimeRequest(
            job=job(tmp_path),
            text=plain,
            audio=AudioRef(path=str(tmp_path / "a.mp3"), duration_sec=0.0),
            language="en",
        )
    )
    assert "start" not in aligner.calls[0][0][0]


# ── a pasted sheet gets the same text hygiene as a provider's ────────────────────────────────────

GENIUS_PASTE = """[Verse 1]
Tired of being what you want me to be
Feeling so faithless, lost under the surface

[Chorus]
CHORUS: I've become so numb, I can't feel you there
♪ Become so tired, so much more aware ♪

[Instrumental]
"""


async def test_a_pasted_sheets_section_headers_do_not_become_words_to_sing(tmp_path: Path) -> None:
    """THE ONE PATH THAT NEVER CLEANED. A stored candidate was cleaned by the adapter that fetched it, and
    the bench's `headers` mode arrives through a port that calls `clean_segments` — so a person pasting from
    a lyrics site was the only way a `[Verse 1]` reached the decode as a CTC target. The measured
    cost on Numb's own labels: 17 fake words with onsets up to ~2.5 s early, verdict COARSE."""
    impl = steps(tmp_path)
    got = await impl.fetch_pinned_text(job(tmp_path, pinnedText=GENIUS_PASTE))

    assert got is not None
    assert [s["text"] for s in got.segments] == [
        "Tired of being what you want me to be",
        "Feeling so faithless, lost under the surface",
        "I've become so numb, I can't feel you there",
        "Become so tired, so much more aware",
    ]


#: A transcript copied off a video: the sung lines wrapped in music notes by whoever typed them, the spoken
#: ones not. Synthetic words — what matters is the SHAPE (4+ noted lines, and a noted share over
#: `nonlyric.NOTED_SHARE`: 9 of 11 worded lines here, 0.818), read off the WHOLE paste by `nonlyric.R3`.
VIDEO_TRANSCRIPT_PASTE = """♪ aaa bbb ccc ♪
♪ ddd eee fff ♪
ggg hhh iii, spoken
♪ jjj kkk lll ♪
♪ mmm nnn ooo ♪
ppp qqq rrr, spoken
♪ sss ttt uuu ♪
♪ vvv www xxx ♪
♪ yyy zzz aab ♪
♪ bbc ccd dde ♪
♪ eef ffg ggh ♪
"""


async def test_a_pasted_transcripts_unmarked_lines_are_not_judged_not_sung(tmp_path: Path) -> None:
    """The contract for this path is "the paste, verbatim", and `nonlyric`'s R3
    is the one rule whose precondition is read off the WHOLE text rather than anchored in the line: with the
    paste's noted share over `NOTED_SHARE`, every UNMARKED line of a person's own text was deleted, and the
    only note emitted is for a paste that ends up completely empty. The anchored rules still apply."""
    impl = steps(tmp_path)
    got = await impl.fetch_pinned_text(job(tmp_path, pinnedText=VIDEO_TRANSCRIPT_PASTE))

    assert got is not None
    assert [s["text"] for s in got.segments] == [
        "aaa bbb ccc",
        "ddd eee fff",
        "ggg hhh iii, spoken",
        "jjj kkk lll",
        "mmm nnn ooo",
        "ppp qqq rrr, spoken",
        "sss ttt uuu",
        "vvv www xxx",
        "yyy zzz aab",
        "bbc ccd dde",
        "eef ffg ggh",
    ]
    # The SAME text down a provider's path keeps R3, which is where the author's marking IS evidence.
    served = clean_segments([{"text": line} for line in VIDEO_TRANSCRIPT_PASTE.splitlines()])
    assert len(served) == 9, "R3 is not removed, only kept off the one text a person typed"


async def test_a_pasted_header_is_still_dropped_and_a_label_still_stripped(tmp_path: Path) -> None:
    """The anchored half of the same decision: leaving R3 out is not leaving the hygiene out."""
    impl = steps(tmp_path)
    got = await impl.fetch_pinned_text(job(tmp_path, pinnedText="[Chorus]\nCHORUS: aaa bbb\n♪♪\nccc ddd\n"))

    assert got is not None
    assert [s["text"] for s in got.segments] == ["aaa bbb", "ccc ddd"]


async def test_what_the_hygiene_takes_off_a_paste_is_noted(tmp_path: Path) -> None:
    """The comment here used to say the whole paste is recorded on the document via
    `sourceLines`; it is not — that field is built from the CLEANED segments, and it has to be, because it is
    what a re-pick re-times. So the record of the loss is a trail note, naming how many lines went and why."""
    reporter = Reporter()
    impl = steps(tmp_path, reporter=reporter)
    got = await impl.fetch_pinned_text(job(tmp_path, pinnedText="[Chorus]\naaa bbb\n♪♪\nccc ddd\n"))

    assert got is not None and len(got.segments) == 2
    assert "pin-cleaned" in [verdict for _state, verdict, _knob in reporter.states]


async def test_a_verbatim_paste_is_noted_about_nothing(tmp_path: Path) -> None:
    """The other half: a paste the hygiene did not touch must not emit a note about a loss that never
    happened — the note is a record of a difference, not a step that always runs."""
    reporter = Reporter()
    impl = steps(tmp_path, reporter=reporter)
    got = await impl.fetch_pinned_text(job(tmp_path, pinnedText="aaa bbb\nccc ddd\n"))

    assert got is not None and len(got.segments) == 2
    assert "pin-cleaned" not in [verdict for _state, verdict, _knob in reporter.states]


def _old_doc(tmp: Path, *, worded: bool = True) -> str:
    ref = "derived/lyrics/m1-asr-word.json"
    words = [{"word": "iii", "start": 28.0, "end": 29.0}, {"word": "jjj", "start": 29.0, "end": 30.0}]
    lines: list[dict[str, object]] = [
        {"text": "aaa bbb", "start": 10.0, "end": 12.0, "words": []},
        {"text": "ccc dde", "start": 14.0, "end": 16.0, "words": []},
        {"text": "eee fff", "start": 20.0, "end": 24.0, "words": []},
        {"text": "ggg hhh", "start": 24.5, "end": 26.0, "words": []},
        # A null bound falls back to the line's own words.
        {"text": "iii jjj", "start": None, "end": None, "words": words},
    ]
    if not worded:
        lines[-1] = {"text": "iii jjj", "start": 28.0, "end": 30.0, "words": []}
    (tmp / "derived" / "lyrics").mkdir(parents=True, exist_ok=True)
    (tmp / ref).write_text(json.dumps({"lines": lines}))
    return ref


async def _seeded(tmp: Path, paste: str, *, worded: bool = True) -> list[tuple[str, object, object]]:
    seed = _old_doc(tmp, worded=worded)
    got = await steps(tmp).fetch_pinned_text(
        job(tmp, pinnedRef="derived/lyrics/m1-edit-r1.json", pinnedText=paste, pinnedFrom=seed)
    )
    assert got is not None and got.timing == "line" and got.has_own_timings
    return [(str(s["text"]), s.get("start"), s.get("end")) for s in got.segments]


async def test_a_fix_keeps_the_slots_of_kept_edited_and_rewritten_lines(tmp_path: Path) -> None:
    """A host changes which words, not when they are sung: the paste claims the old line slots."""
    paste = "aaa bbb\nccc ddd\nsomething else entirely\nggg hhh\niii jjj"
    assert await _seeded(tmp_path, paste) == [
        ("aaa bbb", 10.0, 12.0),
        ("ccc ddd", 14.0, 16.0),  # an edited word
        ("something else entirely", 20.0, 24.0),  # rewritten in place
        ("ggg hhh", 24.5, 26.0),
        ("iii jjj", 28.0, 30.0),
    ]


async def test_a_line_the_host_left_alone_is_written_back_with_its_old_words(tmp_path: Path) -> None:
    """Re-aligning an untouched line can only move it; its old words are written back as they were."""
    paste, seed = "aaa bbb\nccc ddd\niii jjj", _old_doc(tmp_path)
    got = await steps(tmp_path).fetch_pinned_text(
        job(tmp_path, pinnedRef="derived/lyrics/m1-edit-r1.json", pinnedText=paste, pinnedFrom=seed)
    )
    assert got is not None
    old_words = [{"word": "iii", "start": 28.0, "end": 29.0}, {"word": "jjj", "start": 29.0, "end": 30.0}]
    moved = [{"word": "iii", "start": 27.6, "end": 28.4}, {"word": "jjj", "start": 28.4, "end": 29.6}]
    first: dict[str, object] = {"text": "aaa bbb", "start": 10.1, "end": 12.0, "words": []}
    second: dict[str, object] = {"text": "ccc ddd", "start": 14.0, "end": 16.0, "words": []}
    last: dict[str, object] = {"text": "iii jjj", "start": 27.6, "end": 29.6, "words": moved}

    def written(*lines: dict[str, object]) -> list[dict[str, object]]:
        return cast(list[dict[str, object]], _written({"lines": list(lines)}, got.segments)["lines"])

    out = written(first, second, last)
    assert out[2] == {"text": "iii jjj", "start": 28.0, "end": 30.0, "words": old_words}
    assert out[0]["start"] == 10.1  # an old line with no words to give back keeps the new timing
    crowding = {"text": "ccc ddd", "start": 27.0, "end": 28.5, "words": []}  # past the old start: new kept
    assert written(first, second, crowding, last)[3]["words"] == moved


async def test_a_fix_to_case_or_punctuation_alone_shows_the_hosts_words(tmp_path: Path) -> None:
    """The TV draws the sung line from its `words`, so only an EXACT text match counts as untouched."""
    paste, seed = "aaa bbb\nccc ddd\nIii, jjj", _old_doc(tmp_path)  # the old line reads "iii jjj"
    got = await steps(tmp_path).fetch_pinned_text(
        job(tmp_path, pinnedRef="derived/lyrics/m1-edit-r1.json", pinnedText=paste, pinnedFrom=seed)
    )
    assert got is not None
    new_words = [{"word": "Iii,", "start": 28.0, "end": 29.0}, {"word": "jjj", "start": 29.0, "end": 30.0}]
    fixed_line = {"text": "Iii, jjj", "start": 28.0, "end": 30.0, "words": new_words}
    aligned: dict[str, object] = {"lines": [fixed_line]}
    line = cast(list[dict[str, object]], _written(aligned, got.segments)["lines"])[0]
    assert [w["word"] for w in cast(list[dict[str, object]], line["words"])] == ["Iii,", "jjj"]


async def test_an_added_line_is_found_in_one_window_with_the_line_before_it(tmp_path: Path) -> None:
    """The line before a missed one may have swallowed its audio, so it keeps only its start and both are
    decoded up to the next claimed start; the line after keeps its slot."""
    paste = "aaa bbb\nccc ddd\neee fff\nthe missed line\nggg hhh\niii jjj"
    assert await _seeded(tmp_path, paste) == [
        ("aaa bbb", 10.0, 12.0),
        ("ccc ddd", 14.0, 16.0),
        ("eee fff", 20.0, None),
        ("the missed line", None, None),
        ("ggg hhh", 24.5, 26.0),
        ("iii jjj", 28.0, 30.0),
    ]


def test_a_line_added_into_a_repeated_chorus_pairs_every_other_line_with_its_own_slot() -> None:
    """difflib paired [one, chosen] one line early here, dropping the first `one` and shifting the rest."""
    old = [("cause one", 50.0, 52.0), ("one", 53.0, 56.0), ("one", 60.0, 67.5), ("chosen", 68.0, 70.0)]
    assert seed_times(["cause one", "one", "chosen", "one", "chosen"], old, line_timed=True) == [
        (50.0, 52.0),
        (53.0, 56.0),
        (56.0, 60.0),
        (60.0, 67.5),
        (68.0, 70.0),
    ]


async def test_in_a_line_timed_document_added_lines_share_the_gap_the_provider_left(tmp_path: Path) -> None:
    """A provider's own line spans swallow nothing, so the gap between them is where the missed lines go."""
    paste = "aaa bbb\nccc ddd\none missed\ntwo missed\neee fff\nggg hhh\niii jjj"
    assert await _seeded(tmp_path, paste, worded=False) == [
        ("aaa bbb", 10.0, 12.0),
        ("ccc ddd", 14.0, 16.0),
        ("one missed", 16.0, 18.0),
        ("two missed", 18.0, 20.0),
        ("eee fff", 20.0, 24.0),
        ("ggg hhh", 24.5, 26.0),
        ("iii jjj", 28.0, 30.0),
    ]


@pytest.mark.parametrize(
    "seed",
    [None, "derived/lyrics/gone.json", "../outside.json"],
    ids=["no document", "evicted", "outside the store"],
)
async def test_with_no_old_timings_a_fix_is_decoded_blind(tmp_path: Path, seed: str | None) -> None:
    params: dict[str, object] = {"pinnedRef": "derived/lyrics/m1-edit-r1.json", "pinnedText": "aaa\nccc"}
    if seed:
        params["pinnedFrom"] = seed
    got = await steps(tmp_path).fetch_pinned_text(job(tmp_path, **params))
    assert got is not None and got.timing is None and all("start" not in s for s in got.segments)


async def test_a_rewrite_rather_than_a_fix_is_decoded_blind(tmp_path: Path) -> None:
    """Under half the lines pair with the old document: its slots would place other words."""
    seed = _old_doc(tmp_path)
    paste = "one two\nthree four\nfive six\naaa bbb"
    got = await steps(tmp_path).fetch_pinned_text(
        job(tmp_path, pinnedRef="derived/lyrics/m1-edit-r1.json", pinnedText=paste, pinnedFrom=seed)
    )
    assert got is not None and got.timing is None


async def test_a_paste_of_nothing_but_headers_is_an_unreadable_pin_not_an_empty_decode(
    tmp_path: Path,
) -> None:
    """Which leaves the candidate the core holds exactly as it is, rather than re-timing no words at all."""
    reporter = Reporter()
    impl = steps(tmp_path, reporter=reporter)
    got = await impl.fetch_pinned_text(job(tmp_path, pinnedText="[Chorus]\n[Outro]\n"))

    assert got is None
    assert "pin-unreadable" in [verdict for _state, verdict, _knob in reporter.states]
