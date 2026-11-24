"""The align completion core reads, written from the worker and parsed by core.

A CROSS-LANGUAGE CONTRACT in both directions: `build()` drives the REAL `run_align` and the REAL `diarize`
step and records the `job:complete` frames and lyric documents they produce together with what the worker
MEANT by them; the fixture lands in `core/tests/unit/contract/lyrics/worker-align-contract.json`, where
`worker-align-contract.test.ts` feeds each frame through `setMediaLyrics` and each document through the TV's
`parseLyricsDoc`. Both bugs it closes were contracts each side kept honestly on its own and broke between
them: the worker sent the timing grade in core's `textConfidence`, and diarization wrote `speaker` where the
TV reads `part`. REGENERATE, never hand-edit: `cd worker && .venv/bin/python -m tests.test_core_contract` —
the test below fails while the fixture differs from what the worker sends, and core's while core differs.
"""

from __future__ import annotations

import asyncio
import json
import tempfile
from collections.abc import Callable, Sequence
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from encore_worker.__main__ import _align_completion
from encore_worker.artifacts import keys
from encore_worker.domain.document import Segment
from encore_worker.domain.lyrics.policy import Knob, Tier
from encore_worker.domain.lyrics.report import TimingReport
from encore_worker.host.config import Config
from encore_worker.steps.align_steps import Adapters, AlignStepsImpl
from encore_worker.steps.api import pin_of
from encore_worker.steps.records import (
    TIMING_LINE,
    TIMING_WORD,
    AlignOutcome,
    AudioRef,
    JobRef,
    Refused,
    TextRef,
    TimedDoc,
    TimeRequest,
)
from encore_worker.workflows.align import run_align
from tests.test_align_flow import CLEAN, INCOHERENT, LINE_SYNCED, REFUSED, THIN, WINDOWED, Fake, lrc
from tests.test_align_steps import Reporter

#: Walked up to, as `test_job_params._core` does: the fixture is core's, and a moved file must fail here.
FIXTURE_RELATIVE = "tests/unit/contract/lyrics/worker-align-contract.json"
#: One stamp for every frame, so the fixture is byte-stable (`_lyrics_artifacts(now_ms=)`).
NOW_MS = 1_790_000_000_000
MEDIA = "m1"
CONFIG = Config(worker_id="w1")


def _fixture_path() -> Path:
    here = Path(__file__).resolve()
    for parent in here.parents:
        core = parent / "core"
        if (core / "package.json").is_file():
            return core / FIXTURE_RELATIVE
    raise AssertionError(f"could not find core/ above {here}: the M3/M15 contract is UNCHECKED")


class _Stored(Fake):
    """`Fake`, with the refs `AlignStepsImpl._write` mints — `{media}-{label}{-knob…}-{timing}.json` — so
    the fixture's candidates are the shape core stores and `_pinned_label` reads back, and with the grade
    `_time_line_sync` gives every line document (`low`), which is what made line-sync docs rank last."""

    async def time_text(self, req: TimeRequest) -> TimedDoc | Refused | None:
        got = await super().time_text(req)
        if not isinstance(got, TimedDoc):
            return got
        knobs = "".join(f"-{knob.value}" for knob in Knob if knob in req.knobs)
        name = f"{req.text.label.replace(':', '-')}{knobs}-{got.timing}.json"
        grade = "low" if got.timing == TIMING_LINE else got.confidence
        return replace(got, ref=f"derived/lyrics/{req.job.media_id}-{name}", confidence=grade)


class _Doubted(_Stored):
    """`_Stored`, with the lexical DOUBT band's verdict on every document it times: published, the grade
    `medium`, and the WORDS unvouched (`align_steps._time_text_global` sets both together; nothing here
    decodes, so the band is scripted). Also the shape of a pin the gate would have refused — `pin-unvouched`,
    whose grade is `low` — since both reach core as `vouched: false` (`TimedDoc.vouched`)."""

    async def time_text(self, req: TimeRequest) -> TimedDoc | Refused | None:
        got = await super().time_text(req)
        if not isinstance(got, TimedDoc):
            return got
        return replace(got, confidence="medium", vouched=False)


def _job(job_id: str, **params: object) -> JobRef:
    return JobRef(
        job_id=job_id, media_id=MEDIA, media_dir="/media/m1", source_uri="https://x.test/v", params=params
    )


#: A mix retry covering less than the stem attempt it retried (`test_align_flow`'s best-so-far case).
WORSE = TimingReport(words=30, coverage=0.2, duration_sec=200.0, engine=WINDOWED)


def _machine_captions() -> TextRef:
    return TextRef(
        tier=Tier.MACHINE,
        label="captions:machine",
        segments=({"start": 0.0, "end": 2.0, "text": "hello"},),
        timing=TIMING_LINE,
    )


def _transcript() -> TextRef:
    return TextRef(
        tier=Tier.ASR,
        label="asr:vocals",
        segments=({"start": 0.1, "end": 1.9, "text": "hello"},),
        timing=TIMING_WORD,
    )


def _paste() -> TextRef:
    return TextRef(tier=Tier.CANDIDATE, label="manual", segments=({"text": "my own words"},))


#: The stored documents a person re-picks below: `fetch_pinned_text` serves their words untimed, at the tier
#: their label was acquired at (`records.tier_of_label`).
REPICKED_MACHINE = f"derived/lyrics/{MEDIA}-captions-machine-word.json"
REPICKED_TRANSCRIPT = f"derived/lyrics/{MEDIA}-asr-vocals-word.json"


def _re_picked(tier: Tier, label: str) -> TextRef:
    return TextRef(tier=tier, label=label, segments=({"text": "hello"},))


#: (name, why, the job, a factory for its scripted steps — fresh per build, since a fake consumes its
#: reports). Each is a ladder shape whose frame core used to read wrongly.
_SCENARIOS: tuple[tuple[str, str, JobRef, Callable[[], _Stored]], ...] = (
    (
        "line-sync-after-a-rejected-word-attempt",
        "the word decode came back out of order, so the sheet's own line timings published; the rejected "
        "word doc outranked it (authoritative + word) and was what core showed",
        _job("j-line-sync"),
        lambda: _Stored(provider=lrc(), transcribed=_transcript(), reports=[INCOHERENT, LINE_SYNCED]),
    ),
    (
        "a-worse-retry-loses-to-the-attempt-it-retried",
        "best-so-far kept the stem attempt; the mix retry ties it on rank and on grade, and every candidate "
        "carried one createdAt, so only list order decided between them",
        _job("j-best-so-far"),
        lambda: _Stored(provider=lrc(), reports=[THIN, WORSE]),
    ),
    (
        "machine-captions-word-doc",
        "YouTube's machine track, well timed: its `high` grade went out as textConfidence and ranked it "
        "authoritative, as 'Captions', above a correct line-synced sheet",
        _job("j-machine"),
        lambda: _Stored(machine=_machine_captions(), reports=[CLEAN]),
    ),
    (
        "no-lyrics-after-an-unusable-transcript",
        "the job published NOTHING, yet the document its one attempt wrote was ranked and shown",
        _job("j-no-lyrics"),
        lambda: _Stored(transcribed=_transcript(), reports=[INCOHERENT]),
    ),
    (
        "a-pinned-paste",
        "a person's paste, re-timed and placed at core's manual key: a claim, and the only candidate",
        _job("j-paste", pinnedRef=keys.manual_lyrics_key(MEDIA), pinnedText="my own words"),
        lambda: _Stored(pinned=_paste(), reports=[CLEAN]),
    ),
    (
        "a-refused-text-withdraws-an-earlier-jobs-candidate",
        "a re-align's gate refused the sheet an earlier job had published as a word doc; a refused attempt "
        "writes nothing, so that doc stayed selectable at rank 5 and was shown over the transcript this job "
        "published (review W1 r2)",
        _job("j-withdraw"),
        lambda: _Stored(provider=lrc(), transcribed=_transcript(), reports=[REFUSED, CLEAN]),
    ),
    (
        "a-re-picked-machine-caption",
        "a person re-picked YouTube's machine track: a pin is sent textConfidence `high` whatever its tier "
        "(the old worker's 'a human chose this text'; W3), where W1 sent the tier's `low`, so core now reads "
        "the chosen words as a claim, 'Captions'",
        _job("j-re-pick-machine", pinnedRef=REPICKED_MACHINE),
        lambda: _Stored(pinned=_re_picked(Tier.MACHINE, "captions:machine"), reports=[CLEAN]),
    ),
    (
        "a-re-picked-transcript",
        "a person re-picked this recording's transcript: sent `high` like every pin, and still no claim in "
        "core, which never counts `asr` words as one",
        _job("j-re-pick-transcript", pinnedRef=REPICKED_TRANSCRIPT),
        lambda: _Stored(pinned=_re_picked(Tier.ASR, "asr:vocals"), reports=[CLEAN]),
    ),
    (
        "a-doubt-band-word-document",
        "the lexical gate DOUBTS this sheet's words (W3 r1-r2): the document publishes, but nothing vouches "
        "for them, so it goes out `vouched: false` — not a claim, and under any document a gate passed. Sent "
        "as the timing grade alone it ranked 5, tied with a fully vouched word doc: this band's grade is "
        "`medium`, and core's `lyricsRank` read `timingConfidence` nowhere before W6 and reads only a `low` "
        "one since; sent as textConfidence `low` it also claimed the words were machine-generated, which is "
        "what that field says for a caption track",
        _job("j-doubted"),
        lambda: _Doubted(provider=lrc(), reports=[CLEAN]),
    ),
    (
        "a-pin-the-lexical-gate-refused",
        "a person pinned words the gate measured as not the sung ones (`pin-unvouched`): published all-`low` "
        "because a person chose them, and NOT sent as a claim — a pin's `high` says who chose the text, and "
        "`vouched: false` says no gate found the audio singing it",
        _job("j-pin-unvouched", pinnedRef=keys.manual_lyrics_key(MEDIA), pinnedText="my own words"),
        lambda: _Doubted(pinned=_paste(), reports=[CLEAN]),
    ),
)

#: What an EARLIER job left in the store for a scenario, by name: (ref, document). Written into a scratch
#: media dir for that scenario's run, so the frame builder's store scan (`superseded_candidates`) finds it.
_EARLIER: dict[str, tuple[tuple[str, dict[str, object]], ...]] = {
    "a-refused-text-withdraws-an-earlier-jobs-candidate": (
        (
            f"derived/lyrics/{MEDIA}-lrclib-word.json",
            {"language": "en", "lines": [{"text": "hello", "start": 0.0, "end": 2.0, "words": []}]},
        ),
    ),
}


class _Turns:
    """A diarizer that answers with scripted turns."""

    def __init__(self, turns: tuple[Segment, ...]) -> None:
        self._turns = turns

    def diarize(self, audio_path: str) -> tuple[Segment, ...]:
        return self._turns


def _line(text: str, start: float) -> dict[str, object]:
    words = text.split()
    return {
        "text": text,
        "start": start,
        "end": start + len(words) * 0.5,
        "words": [
            {"word": w, "start": start + 0.5 * i, "end": start + 0.5 * i + 0.4} for i, w in enumerate(words)
        ],
        "confidence": "high",
    }


#: (name, the published document, the diarizer's turns). Short lines, so the TV's re-segmentation (42
#: characters) leaves the rows as written and the parts are read line for line.
_DOCUMENTS: tuple[tuple[str, dict[str, object], tuple[Segment, ...]], ...] = (
    (
        "a-duet",
        {
            "language": "en",
            "lines": [
                _line("you take the high road", 0.0),
                _line("and I take the low", 5.0),
                _line("we meet in the middle", 10.0),
                _line("where the rivers flow", 15.0),
                _line("an unheard echo", 40.0),
            ],
        },
        # The diarizer's labels are not in line order, so the letters must come from FIRST APPEARANCE.
        (
            {"start": 0.0, "end": 4.0, "speaker": "SPEAKER_01"},
            {"start": 4.5, "end": 9.0, "speaker": "SPEAKER_00"},
            {"start": 9.5, "end": 14.0, "speaker": "SPEAKER_01"},
            {"start": 14.5, "end": 19.0, "speaker": "SPEAKER_00"},
        ),
    ),
    (
        "an-over-segmented-solo",
        {
            "language": "en",
            "lines": [
                _line("one voice all along", 0.0),
                _line("heard as three", 5.0),
                _line("by the diarizer", 10.0),
            ],
        },
        (
            {"start": 0.0, "end": 4.0, "speaker": "SPEAKER_00"},
            {"start": 4.5, "end": 9.0, "speaker": "SPEAKER_01"},
            {"start": 9.5, "end": 14.0, "speaker": "SPEAKER_02"},
        ),
    ),
)


def _intent(
    outcome: AlignOutcome, withdrawn: Sequence[str] = (), *, pinned: bool = False
) -> dict[str, object]:
    """What the worker MEANT by a frame, in core's terms: the one candidate it chose (or none), which
    candidates' words are CLAIMS (core's `isAuthoritativeText`) rather than measurements of the audio, and
    which earlier jobs' candidates it WITHDREW (`superseded_candidates`: all of them claims here).

    A claim is a CANDIDATE-tier text, or a PIN of anything but a transcript: a person vouched for the words,
    and a transcript is this recording's audio heard back, which neither worker ever counted as a
    claim (the old worker's `is_authoritative_text`, f04a2d0e^ `lyrics/grading.py`, is core's rule) — UNLESS
    a wrong-text gate doubted the words (`TimedDoc.vouched`), which no tier and no pin overrides."""
    return {
        "chosen": outcome.published.ref if outcome.published else None,
        "authoritative": sorted(
            [
                doc.ref
                for doc in outcome.candidates
                if doc.vouched and (doc.tier is Tier.CANDIDATE or (pinned and doc.tier is not Tier.ASR))
            ]
            + list(withdrawn)
        ),
        "withdrawn": sorted(withdrawn),
    }


async def _attributed(doc: dict[str, object], turns: tuple[Segment, ...]) -> dict[str, object]:
    """`doc` as the REAL `diarize` step leaves it on disk: it rewrites the published file in place."""
    with tempfile.TemporaryDirectory() as media_dir:
        ref = f"derived/lyrics/{MEDIA}-lrclib-word.json"
        path = Path(media_dir) / ref
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps(doc), encoding="utf-8")
        impl = AlignStepsImpl(config=CONFIG, adapters=Adapters(diarizer=_Turns(turns)), reporter=Reporter())
        record = TimedDoc(ref=ref, timing=TIMING_WORD, confidence="high", report=CLEAN, tier=Tier.CANDIDATE)
        job = JobRef(job_id="j-diarize", media_id=MEDIA, media_dir=media_dir)
        await impl.diarize(job, AudioRef(path=str(Path(media_dir) / "mix.wav"), duration_sec=60.0), record)
        loaded: dict[str, object] = json.loads(path.read_text(encoding="utf-8"))
        return loaded


async def build() -> dict[str, Any]:
    """The fixture, from scratch. Deterministic: fixed stamp, scripted steps, no trail prose (which other
    work rewords freely and core's contract does not read)."""
    frames: list[dict[str, object]] = []
    for name, why, job, steps in _SCENARIOS:
        with tempfile.TemporaryDirectory() as media_dir:
            earlier = _EARLIER.get(name, ())
            for ref, doc in earlier:
                (Path(media_dir) / ref).parent.mkdir(parents=True, exist_ok=True)
                (Path(media_dir) / ref).write_text(json.dumps(doc), encoding="utf-8")
            here = replace(job, media_dir=media_dir) if earlier else job
            outcome = await run_align(here, steps())
            wire = _align_completion(here, CONFIG, outcome, now_ms=NOW_MS).to_wire()
        wire.pop("trail", None)
        intent = _intent(outcome, [ref for ref, _doc in earlier], pinned=pin_of(here) is not None)
        frames.append({"name": name, "why": why, "frame": wire, "intent": intent})
    documents: list[dict[str, object]] = []
    for name, doc, turns in _DOCUMENTS:
        attributed = await _attributed(doc, turns)
        lines = attributed["lines"]
        assert isinstance(lines, list)
        documents.append({"name": name, "doc": attributed, "parts": [line.get("part") for line in lines]})
    return {"generator": "worker/tests/test_core_contract.py", "frames": frames, "documents": documents}


def dump(fixture: dict[str, Any]) -> str:
    return json.dumps(fixture, indent=1, ensure_ascii=False) + "\n"


# ── the worker's side of the contract ────────────────────────────────────────────────────────────────


async def test_the_committed_core_fixture_is_what_the_worker_sends() -> None:
    committed = _fixture_path().read_text(encoding="utf-8")
    assert dump(await build()) == committed, (
        "the worker's align completion changed: regenerate core's fixture with "
        "`.venv/bin/python -m tests.test_core_contract`, then run core's worker-align-contract test"
    )


def _frame(fixture: dict[str, Any], name: str) -> dict[str, Any]:
    found: dict[str, Any] = next(f["frame"] for f in fixture["frames"] if f["name"] == name)
    return found


def _candidates(frame: dict[str, Any]) -> list[dict[str, Any]]:
    got: list[dict[str, Any]] = frame["artifacts"]["lyrics"]["candidates"]
    return got


async def test_every_report_selects_exactly_the_published_document() -> None:
    """`selectable` is the ladder's verdict: true on the one document published, false on every other,
    and false on all of them when the job published nothing."""
    fixture = await build()
    for entry in fixture["frames"]:
        frame, intent = entry["frame"], entry["intent"]
        selectable = [c["ref"] for c in _candidates(frame) if c["selectable"]]
        assert selectable == ([intent["chosen"]] if intent["chosen"] else []), entry["name"]
        assert frame["artifacts"]["lyrics"]["uri"] == (intent["chosen"] or ""), entry["name"]


async def test_text_confidence_is_the_texts_tier_and_the_grade_is_timing_confidence() -> None:
    """On the wire: the machine track's words are `low` however well it timed, and a line-synced
    sheet's words are `high` though its timing grade is `low`."""
    fixture = await build()
    machine = _candidates(_frame(fixture, "machine-captions-word-doc"))
    assert [(c["textSource"], c["textConfidence"], c["timingConfidence"]) for c in machine] == [
        ("captions", "low", "high")
    ]
    line_sync = {
        c["timing"]: c for c in _candidates(_frame(fixture, "line-sync-after-a-rejected-word-attempt"))
    }
    assert (line_sync["line"]["textConfidence"], line_sync["line"]["timingConfidence"]) == ("high", "low")
    assert line_sync["line"]["selectable"] is True and line_sync["word"]["selectable"] is False
    paste = _candidates(_frame(fixture, "a-pinned-paste"))
    assert [(c["ref"], c["textSource"], c["textConfidence"]) for c in paste] == [
        (keys.manual_lyrics_key(MEDIA), "manual", "high")
    ]
    transcript = _candidates(_frame(fixture, "no-lyrics-after-an-unusable-transcript"))
    assert [(c["textSource"], c["textConfidence"], c["selectable"]) for c in transcript] == [
        ("asr", "low", False)
    ]


async def test_a_pin_is_sent_as_high_text_confidence_whatever_its_tier() -> None:
    """A person's re-pick is `high` words, as the old worker sent every pin;
    an earlier version sent the stored text's tier, `low` for a machine track or a transcript. Only the words'
    standing moves: the timing grade is still the grade, and the source still says what the text is."""
    fixture = await build()
    machine = _candidates(_frame(fixture, "a-re-picked-machine-caption"))
    assert [(c["ref"], c["textSource"], c["textConfidence"], c["selectable"]) for c in machine] == [
        (REPICKED_MACHINE, "captions", "high", True)
    ]
    transcript = _candidates(_frame(fixture, "a-re-picked-transcript"))
    assert [(c["ref"], c["textSource"], c["textConfidence"], c["selectable"]) for c in transcript] == [
        (REPICKED_TRANSCRIPT, "asr", "high", True)
    ]


async def test_a_document_no_wrong_text_gate_vouches_for_is_sent_on_its_own_axis() -> None:
    """The lexical doubt band and an unvouched pin publish, so core must be told
    the WORDS are not vouched for — and on a field of their own, `vouched: false`, which
    `isAuthoritativeText` reads. The timing grade could not say it: this band's grade is `medium`, and
    `timingConfidence` was a tie-break alone when this was written (`lyricsRank` now reads it, but only a
    `low` one), so the doubted document tied with a fully vouched one at rank 5 and was shown either way.
    `textConfidence` could not either: it carries PROVENANCE, and core reads `captions` + `low` as "Auto
    captions", so the doubt turned an uploader's hand-authored track into a machine-generated one on screen.
    Both fields therefore keep saying what they mean — the tier's standing, and the timing grade."""
    fixture = await build()
    doubted = _candidates(_frame(fixture, "a-doubt-band-word-document"))
    assert [
        (c["textSource"], c["textConfidence"], c.get("vouched"), c["timingConfidence"], c["timing"])
        for c in doubted
    ] == [("lrclib", "high", False, "medium", "word")]
    pin = _candidates(_frame(fixture, "a-pin-the-lexical-gate-refused"))
    assert [
        (c["ref"], c["textSource"], c["textConfidence"], c.get("vouched"), c["timingConfidence"]) for c in pin
    ] == [(keys.manual_lyrics_key(MEDIA), "manual", "high", False, "medium")]
    vouched = _candidates(_frame(fixture, "a-pinned-paste"))
    assert [(c["textConfidence"], "vouched" in c) for c in vouched] == [("high", False)], (
        "the same paste, no gate doubting it: the field is sent only to withhold"
    )


@pytest.mark.parametrize("tier", list(Tier))
def test_the_pin_not_the_tier_decides_a_pinned_frames_text_confidence(tier: Tier) -> None:
    """The frame builder reads the PIN off the job (`pin_of`): the same outcome sent for an ordinary job
    keeps its tier's standing, and for a pinned one is `high`. A pin that could not be honoured (a ref
    outside the store) placed nothing, so its frame names no candidate to raise."""
    doc = TimedDoc(
        ref=REPICKED_MACHINE, timing=TIMING_WORD, confidence="low", report=CLEAN, label="x", tier=tier
    )
    outcome = AlignOutcome(published=doc, why="accepted", candidates=(doc,))

    def sent(job: JobRef) -> tuple[str, str]:
        lyrics = _align_completion(job, CONFIG, outcome, now_ms=NOW_MS).artifacts["lyrics"]  # type: ignore[index]
        (candidate,) = lyrics["candidates"]
        return candidate["textConfidence"], candidate["timingConfidence"]

    assert sent(_job("j-ordinary")) == (tier.text_confidence, "low")
    assert sent(_job("j-re-pick", pinnedRef=REPICKED_MACHINE)) == ("high", "low")
    assert sent(_job("j-paste", pinnedText="hello")) == ("high", "low")
    nothing = AlignOutcome(published=None, why="pin-refused")
    frame = _align_completion(_job("j-bad-pin", pinnedRef="../escape.json"), CONFIG, nothing, now_ms=NOW_MS)
    assert frame.artifacts is None


async def test_one_created_at_per_report() -> None:
    """Recency is a tie-break between JOBS; within a report `selectable` decides, so no attempt is stamped
    newer than the job's own choice."""
    fixture = await build()
    for entry in fixture["frames"]:
        assert {c["createdAt"] for c in _candidates(entry["frame"])} == {NOW_MS}, entry["name"]


async def test_a_refused_text_withdraws_the_candidate_an_earlier_job_stored_for_it() -> None:
    """On the wire: the earlier job's word doc for the refused sheet is reported
    `selectable: false`, with its text's standing and its own timing, beside this job's choice."""
    fixture = await build()
    entry = next(
        f for f in fixture["frames"] if f["name"] == "a-refused-text-withdraws-an-earlier-jobs-candidate"
    )
    by_ref = {c["ref"]: c for c in _candidates(entry["frame"])}
    earlier = by_ref[f"derived/lyrics/{MEDIA}-lrclib-word.json"]
    assert (earlier["textSource"], earlier["textConfidence"], earlier["timing"], earlier["selectable"]) == (
        "lrclib",
        "high",
        "word",
        False,
    )
    assert "timingConfidence" not in earlier, "its grade is not known to this job"
    assert entry["intent"]["chosen"] == f"derived/lyrics/{MEDIA}-asr-vocals-word.json"


def _stored_doc(media_dir: Path, ref: str, texts: Sequence[str], **extra: object) -> None:
    path = media_dir / ref
    path.parent.mkdir(parents=True, exist_ok=True)
    doc = {
        "language": "en",
        "lines": [{"text": t, "start": float(i), "end": i + 0.5} for i, t in enumerate(texts)],
    }
    path.write_text(json.dumps({**doc, **extra}), encoding="utf-8")


def test_only_documents_of_the_refused_words_under_their_label_are_withdrawn(tmp_path: Path) -> None:
    """Matched on the label read off the ref (any knob suffix, either timing) AND on the words (`sourceLines`
    first, as a re-pick reads them): a provider that now serves different words under the same label refused
    nothing about what an earlier job stored. Another media's file, another label's, and a ref this job
    placed itself are left to their own reports."""
    words = ["hello there", "general kenobi"]
    sheet = TextRef(
        tier=Tier.CANDIDATE,
        label="lrclib",
        segments=tuple({"text": t, "start": float(i)} for i, t in enumerate(words)),
        timing=TIMING_LINE,
    )
    for ref in (
        "derived/lyrics/m1-lrclib-word.json",
        "derived/lyrics/m1-lrclib-line-sync-line.json",
        "derived/lyrics/m1-captions-authored-word.json",
        "derived/lyrics/m10-lrclib-word.json",
        "derived/lyrics/m1-asr-vocals-word.json",
    ):
        _stored_doc(tmp_path, ref, words)
    _stored_doc(tmp_path, "derived/lyrics/m1-lrclib-reshift-word.json", ["other words"])
    _stored_doc(
        tmp_path, "derived/lyrics/m1-lrclib-drop-windows-word.json", ["hello there"], sourceLines=words
    )
    placed = TimedDoc(
        ref="derived/lyrics/m1-asr-vocals-word.json",
        timing=TIMING_WORD,
        confidence="high",
        report=CLEAN,
        label="asr:vocals",
        tier=Tier.ASR,
    )
    outcome = AlignOutcome(published=placed, why="accepted", candidates=(placed,), refused=(sheet,))
    job = JobRef(job_id="j", media_id="m1", media_dir=str(tmp_path))

    lyrics = _align_completion(job, CONFIG, outcome, now_ms=NOW_MS).artifacts["lyrics"]  # type: ignore[index]
    reported = {c["ref"]: (c["timing"], c["selectable"]) for c in lyrics["candidates"]}
    assert reported == {
        "derived/lyrics/m1-asr-vocals-word.json": ("word", True),
        "derived/lyrics/m1-lrclib-drop-windows-word.json": ("word", False),
        "derived/lyrics/m1-lrclib-line-sync-line.json": ("line", False),
        "derived/lyrics/m1-lrclib-word.json": ("word", False),
    }
    nothing = AlignOutcome(published=None, why="no lyrics", refused=(sheet,))
    frame = _align_completion(job, CONFIG, nothing, now_ms=NOW_MS)
    assert frame.artifacts is not None and frame.artifacts["lyrics"]["uri"] == "", "withdrawals alone report"
    gone = replace(job, media_dir=str(tmp_path / "nowhere"))
    assert _align_completion(gone, CONFIG, nothing, now_ms=NOW_MS).artifacts is None


def test_every_tier_has_the_text_confidence_core_expects() -> None:
    """Core's `isAuthoritativeText` reads `low` as "not a claim": only a CANDIDATE's words may rank as one."""
    assert {tier: tier.text_confidence for tier in Tier} == {
        Tier.CANDIDATE: "high",
        Tier.ASR: "low",
        Tier.MACHINE: "low",
    }


async def test_a_duet_reaches_the_tv_as_parts_and_a_solo_does_not() -> None:
    """Through the real `diarize` step: the document on disk carries `part`, lettered by first
    appearance, and never the diarizer's `speaker`; an over-segmented solo is left one colour."""
    fixture = await build()
    by_name = {d["name"]: d for d in fixture["documents"]}
    assert by_name["a-duet"]["parts"] == ["A", "B", "A", "B", None]
    assert by_name["an-over-segmented-solo"]["parts"] == [None, None, None]
    for doc in by_name.values():
        assert not any("speaker" in line for line in doc["doc"]["lines"]), doc["name"]


async def test_a_duet_rewrite_that_fails_midway_leaves_the_old_document(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The TV reads this file, so a crash or full disk mid-rewrite must not leave it truncated."""
    _, doc, turns = _DOCUMENTS[0]
    ref = f"derived/lyrics/{MEDIA}-lrclib-word.json"
    path = tmp_path / ref
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(doc), encoding="utf-8")
    before = path.read_bytes()

    def half_then_full_disk(obj: object, fp: Any, **_: object) -> None:
        fp.write(json.dumps(obj)[:10])
        raise OSError("No space left on device")

    monkeypatch.setattr(json, "dump", half_then_full_disk)
    impl = AlignStepsImpl(config=CONFIG, adapters=Adapters(diarizer=_Turns(turns)), reporter=Reporter())
    record = TimedDoc(ref=ref, timing=TIMING_WORD, confidence="high", report=CLEAN, tier=Tier.CANDIDATE)
    job = JobRef(job_id="j-diarize", media_id=MEDIA, media_dir=str(tmp_path))
    await impl.diarize(job, AudioRef(path=str(tmp_path / "mix.wav"), duration_sec=60.0), record)

    assert path.read_bytes() == before
    assert sorted(p.name for p in path.parent.iterdir()) == [path.name]


if __name__ == "__main__":
    path = _fixture_path()
    path.write_text(dump(asyncio.run(build())), encoding="utf-8")
    print(f"wrote {path}")
