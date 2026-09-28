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

import numpy as np
import pytest
import soundfile as sf

from encore_worker.adapters.ports import InfraFault
from encore_worker.artifacts.local import LocalArtifactStore, Roots
from encore_worker.domain.document import Segment
from encore_worker.domain.lyrics.policy import Knob, Tier
from encore_worker.domain.lyrics.report import Engine
from encore_worker.host.config import Config
from encore_worker.protocol.vocabulary import Stage
from encore_worker.steps.align_steps import Adapters, AlignStepsImpl
from encore_worker.steps.api import NotOurJob
from encore_worker.steps.records import (
    TIMING_LINE,
    AudioRef,
    JobRef,
    Refused,
    TextRef,
    TimedDoc,
    TimeRequest,
)
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
    """The windowed engine keeps the port's contract too (review M7): a fault the adapter TYPED as the
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
    attempt of every text: the ladder's "no lyrics", for words nothing had tried to time (review M7)."""
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
    document is measured on its LINES, so it can commit (review M1: measured on words it read as empty)."""
    aligner = FakeAligner()
    reporter = Reporter()
    impl = steps(tmp_path, aligner=aligner, reporter=reporter)
    doc = await impl.time_text(line_sync(tmp_path, sheet(SUNG), sung_stem(tmp_path)))
    assert isinstance(doc, TimedDoc)
    assert doc.timing == "line"
    assert doc.confidence == "low", "line sync is a degradation and must say so"
    # ...of its TIMING. The words are still the sheet's: the record carries the text's tier, which is what
    # core's `textConfidence` is read from (review M3: the grade above went out in its place).
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
    M1's bug kept that off the TV. Here the sheet claims singing where the stem has none — the sheet-span
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
    from encore_worker.steps.align_steps import _SHEET_SPAN_CAP_SEC, _sheet_spans

    lrc: list[Segment] = [
        {"text": "a", "start": 1.0, "end": 20.0},
        {"text": "b", "start": 20.0, "end": 22.0},
        {"start": 22.0},
    ]
    assert _sheet_spans(lrc) == [(1.0, 1.0 + _SHEET_SPAN_CAP_SEC), (20.0, 22.0)], "the last end is b's"
    captions = [{"text": "a", "start": 1.0, "end": 9.0}, {"text": "b", "start": 12.0, "end": 14.0}]
    assert _sheet_spans(captions) == [(1.0, 9.0), (12.0, 14.0)]
    assert _sheet_spans([{"text": "untimed"}]) == []


def test_the_sheet_gate_does_not_trust_zero_lag() -> None:
    """Tier 2 of the envelope gate (weak r at zero lag) is evidence for a DECODE measured on this audio;
    a broad sheet envelope best-fits near zero lag whatever the text, so the sheet gate drops it."""
    from encore_worker.domain.audio.activity import ShiftFit
    from encore_worker.steps.align_steps import _envelope_passes, _sheet_passes

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
    """Audio ffmpeg will not decode is the MACHINERY's fault (review M7), and under `syncMode=lines` this gate
    is the only reader of it: declined, every text went the same way and the ladder ran on to a transcript
    or "no lyrics" (review W1 r1). It raises the adapter's `InfraFault`, as every other audio read does."""
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
    """Review W1 r2. A caption track of THIS video fits the singing whatever its words — the sheet-span gate
    passes it at r ~ 1 — so an uploader's translation, or the machine-translated `en` track, was published
    by this rung once M1 let it commit. The words are not what the stem sings: `Refused`, nothing written."""
    stem, aligner = hearing(tmp_path, monkeypatch)
    reporter = Reporter()
    impl = steps(tmp_path, aligner=aligner, reporter=reporter)
    got = await impl.time_text(line_sync(tmp_path, worded(TRANSLATED_WORDS), stem))
    assert isinstance(got, Refused), got
    assert got.report.engine is Engine.LINE_SYNC and got.report.refused is not None
    assert "sheet-span envelope r=" in got.report.refused, "the timings passed: they are this video's"
    assert "below the lexical gate" in got.report.refused
    assert not any(tmp_path.rglob("*-line.json")), "a refused line document is never written"


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
    """A KNOWN LIMIT, pinned (W3; the bench has no translated sheet to measure, `e2e_lib.OPS`): a translation
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
    """W3. The sheet-span gate refused 107 of 320 right texts under `syncMode=lines` (truth 4/32: hello at
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


async def test_line_sync_refuses_sung_words_on_a_clock_they_are_not_sung_on(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The other half of the timing gate: the right words, claimed 3 s late where the envelope cannot place
    them (the fit abstains), would publish every line 3 s late. The decode hears each line 3 s before its
    claim: `Refused`, nothing written, the lift's pass on the trail beside the reason."""
    stem, aligner = hearing(tmp_path, monkeypatch, envelope=())
    reporter = Reporter()
    impl = steps(tmp_path, aligner=aligner, reporter=reporter)
    late = [(a + 3.0, b + 3.0) for a, b in SUNG]
    got = await impl.time_text(line_sync(tmp_path, worded(SUNG_WORDS, late), stem))
    assert isinstance(got, Refused), got
    assert got.report.refused is not None
    assert "lexical lift +" in got.report.refused, "the words passed: they are sung"
    # -3.04: the decode's onsets lead the sung frames by `generate.ONSET_LEAD_SEC`.
    assert "starts 0% of 6 lines within 1.0 s of their claims (median lag -3.04 s)" in got.report.refused
    assert "below 50%" in got.report.refused
    assert not any(tmp_path.rglob("*-line.json")), "a refused line document is never written"


async def test_line_sync_of_a_text_the_lexical_check_cannot_measure_is_still_timed_by_its_decode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Under `lexical.MIN_LETTERS` alignable letters the lift's contrast is noise, so no lexical check runs —
    but the decode still reads where the lines are: three short sung lines publish, and a sheet of unsung
    ones (W1 line-synced it on the sheet gate alone, its envelope being the stem's own) is refused."""
    stem, aligner = hearing(tmp_path, monkeypatch)
    reporter = Reporter()
    impl = steps(tmp_path, aligner=aligner, reporter=reporter)
    short = [1, 3, 4]  # "with me tonight", "carry me home", "stars are out": 35 letters
    text = worded([SUNG_WORDS[i] for i in short], [SUNG[i] for i in short])
    doc = await impl.time_text(line_sync(tmp_path, text, stem))
    assert isinstance(doc, TimedDoc), doc
    # 2 of 3: decoded over the whole song, one short line binds to letters another sung line holds.
    assert any(
        "no lexical check: under 40 alignable letters" in why and "blind decode starts 67% of 3" in why
        for why in reporter.reasons
    )
    unsung = await impl.time_text(line_sync(tmp_path, sheet(SUNG), stem))  # "line 0" ...: 24 letters
    assert isinstance(unsung, Refused) and unsung.report.refused is not None
    assert "no lexical check: under 40" in unsung.report.refused and "below 50%" in unsung.report.refused


async def test_line_sync_with_no_decode_to_read_rests_on_the_sheet_gate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Where the decode cannot be read the sheet gate decides, exactly as W1 shipped it, and the trail says
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
    """The timing check's decode faulting is the machinery's (review M7), as the lift's is: declined, it would
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
    """An emission pass that faults is the machinery's (review M7): declining it would publish every text on
    the sheet gate alone, the hole the check closes."""

    class Faulting:
        def emissions(self, path: str, language: str) -> object:
            raise InfraFault("the emission pass on mps faulted")

    impl = steps(tmp_path, aligner=Faulting())
    with pytest.raises(InfraFault, match="emission pass"):
        await impl.time_text(line_sync(tmp_path, worded(SUNG_WORDS), sung_stem(tmp_path)))


async def test_line_sync_declines_a_song_with_no_vocals_stem(tmp_path: Path) -> None:
    """Review W1 r2. Forced mode's own fallback to this rung ran the sheet gate on the MIX when there was no
    stem, where it cannot discriminate (39/416 right texts, 3/320 wrong, measured): a wrong text whose decode
    was declined or inverted reached a rung M1 used to drop it at. Declined — no verdict on the text."""
    reporter = Reporter()
    impl = steps(tmp_path, aligner=FakeAligner(), reporter=reporter)
    stem = sung_stem(tmp_path)
    mix_only = AudioRef(path=str(stem.vocals_path), duration_sec=stem.duration_sec, vocals_path=None)
    assert await impl.time_text(line_sync(tmp_path, sheet(SUNG), mix_only)) is None
    assert ("align-line-sync", "declined", None) in reporter.states
    assert any("no vocals stem" in why for why in reporter.reasons)


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
    """Review H2: the mix retry rewrote the stem attempt's file at the same ref, so a workflow that wanted
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
    """Review W1 r1. An attempt used to be written straight into the store, and only a job that reached
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
    """So the policy may offer it the knobs the global engine does not read (review H2)."""
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

    assert await impl.fetch_provider_lyrics(job(tmp_path, artist="a-ha"), audio(tmp_path)) is None
    assert provider.calls == [], "an incomplete lookup must not be attempted at all"

    got = await impl.fetch_provider_lyrics(job(tmp_path, artist="a-ha", track="Take On Me"), audio(tmp_path))
    assert got is not None and got.tier is Tier.CANDIDATE


async def test_unsynced_provider_lyrics_carry_no_line_timing(tmp_path: Path) -> None:
    """Which is what makes LINE_SYNC unavailable for them — there is nothing to fall back to."""
    impl = steps(tmp_path, providers=(FakeProvider([{"text": "a wall of text"}]),))
    got = await impl.fetch_provider_lyrics(job(tmp_path, artist="a", track="b"), audio(tmp_path))
    assert got is not None and got.has_line_timings is False


async def test_a_provider_miss_is_none(tmp_path: Path) -> None:
    impl = steps(tmp_path, providers=(FakeProvider([]),))
    assert await impl.fetch_provider_lyrics(job(tmp_path, artist="a", track="b"), audio(tmp_path)) is None


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


async def test_a_transcription_is_the_asr_tier_and_has_no_own_timings(tmp_path: Path) -> None:
    """Word-timed, but measured on THIS audio — so placement, and `Knob.RESHIFT`, are meaningless."""

    class FakeTranscriber:
        def transcribe(self, audio_path: str, *, language: str | None = None) -> Sequence[Segment]:
            return [{"start": 0.0, "end": 1.0, "text": "heard this"}]

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


async def test_the_first_provider_that_hits_wins(tmp_path: Path) -> None:
    first = FakeChainProvider("mux", cues=LINE)
    second = FakeChainProvider("direct", cues=LINE)
    impl = steps(tmp_path, providers=(first, second))

    got = await impl.fetch_provider_lyrics(job(tmp_path, artist="a", track="b"), audio(tmp_path))
    assert got is not None and got.label == "mux"
    assert second.calls == 0, "a hit must short-circuit the rest of the chain"


async def test_a_miss_falls_through_to_the_next_provider(tmp_path: Path) -> None:
    empty = FakeChainProvider("mux", cues=())
    backup = FakeChainProvider("direct", cues=LINE)
    impl = steps(tmp_path, providers=(empty, backup))

    got = await impl.fetch_provider_lyrics(job(tmp_path, artist="a", track="b"), audio(tmp_path))
    assert got is not None and got.label == "direct"


async def test_a_provider_that_raises_does_not_stop_the_chain(tmp_path: Path) -> None:
    """One being unreachable is exactly when the next matters most — a network that blocks one host may
    reach another."""
    broken = FakeChainProvider("mux", raises=OSError("blocked by proxy"))
    backup = FakeChainProvider("direct", cues=LINE)
    impl = steps(tmp_path, providers=(broken, backup))

    got = await impl.fetch_provider_lyrics(job(tmp_path, artist="a", track="b"), audio(tmp_path))
    assert got is not None and got.label == "direct"
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

    assert got is None
    verdicts = [verdict for _state, verdict, _knob in reporter.states]
    assert "providers-down" in verdicts


async def test_an_ordinary_miss_is_not_reported_as_an_outage(tmp_path: Path) -> None:
    reporter = Reporter()
    impl = steps(tmp_path, reporter=reporter, providers=(FakeChainProvider("mux", cues=()),))
    assert await impl.fetch_provider_lyrics(job(tmp_path, artist="a", track="b"), audio(tmp_path)) is None
    assert "providers-down" not in [v for _s, v, _k in reporter.states]


async def test_word_level_lyrics_are_recorded_as_word_timed(tmp_path: Path) -> None:
    """LRCmux can return word spans; LRCLIB cannot. The timing is read from the PAYLOAD, so a word-timed
    sheet gets the knobs a word-timed sheet should have."""
    impl = steps(tmp_path, providers=(FakeChainProvider("mux", cues=WORDS),))
    got = await impl.fetch_provider_lyrics(job(tmp_path, artist="a", track="b"), audio(tmp_path))
    assert got is not None and got.timing == "word"
    assert got.has_own_timings is True, "not ASR, so placement and RESHIFT apply"


async def test_a_multiplexers_upstream_reaches_the_label(tmp_path: Path) -> None:
    """The trail should say `mux:KuGou`, so a systematically bad source is identifiable."""
    provider = FakeChainProvider("mux", cues=LINE)
    provider.last_source = "KuGou"
    impl = steps(tmp_path, providers=(provider,))
    got = await impl.fetch_provider_lyrics(job(tmp_path, artist="a", track="b"), audio(tmp_path))
    assert got is not None and got.label == "mux:KuGou"


async def test_no_providers_at_all_is_a_quiet_miss(tmp_path: Path) -> None:
    impl = steps(tmp_path, providers=())
    assert await impl.fetch_provider_lyrics(job(tmp_path, artist="a", track="b"), audio(tmp_path)) is None


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
