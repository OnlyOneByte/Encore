"""Pin: an operator RE-PICK re-times exactly the pinned candidate, and nothing else.

The core sends `pinnedRef` (the MediaStore key to write under) and optionally `pinnedText` (pasted
words). Four things must hold, one arm each:

  1. pasted words are timed verbatim as a `manual` candidate and written under `pinnedRef`;
  2. `pinnedRef` alone re-times the text ALREADY on disk and preserves that candidate's own
     textSource, which by then survives only in its artifact KEY;
  3. a ref that escapes the media directory is REFUSED, not silently downgraded to a normal process;
  4. NEGATIVE CONTROL: with no pinned params the comparative selection path is untouched.

MECHANISM. On base `pinnedRef`/`pinnedText` are params nothing reads, so arms 1-3 red: AcquireTexts
runs the (empty) source list and STOPs with "no text from any source", leaving `ctx.out.artifacts`
with no `lyrics` key at all. Arm 4 must pass on base AND head — it is what proves the guards did not
capture the ordinary path, and that the ref override cannot leak onto a graded candidate.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from src.lyrics.chain import (
    ROLE_BASELINE,
    ROLE_CANDIDATE,
    SOURCE_ASR,
    SOURCE_LRCLIB,
    SOURCE_MANUAL,
    TIMING_LINE,
    TIMING_WORD,
    LyricsText,
    candidate_key,
)
from src.processor import JobSpec
from src.runtime.ctx import AudioCtx, Ctx, LyricsCtx
from src.runtime.step import Outcome, StepResult
from src.steps.lyrics import AcquireTexts, GradeAndSelect, TimeTexts

PASTED = "hello darkness my old friend\nive come to talk with you again"
STORED_REF = candidate_key("m1", SOURCE_LRCLIB, TIMING_WORD)
MANUAL_REF = candidate_key("m1", SOURCE_MANUAL, TIMING_WORD)
SHARED = "once upon a time i was falling in love but now im only falling apart"


class _Aligner:
    """Times whatever segments it is handed: one token per second, 0.5s each, sequential.

    Monotonic by construction so `validate_timing` finds nothing out of order, and it records the
    segments it received — the pinned path must hand it TEXT-ONLY segments, because a re-time takes
    its timings from the audio and not from whatever was stored.
    """

    def __init__(self) -> None:
        self.calls: list[tuple[list[dict[str, Any]], str, str]] = []

    def align(self, segments, audio_path, language):
        self.calls.append(([dict(s) for s in segments], audio_path, language))
        out, t = [], 0.0
        for seg in segments:
            toks = str(seg["text"]).split()
            if not toks:
                continue
            words = []
            for tok in toks:
                words.append({"word": tok, "start": round(t, 3), "end": round(t + 0.5, 3)})
                t += 1.0
            out.append(
                {
                    "start": words[0]["start"],
                    "end": words[-1]["end"],
                    "text": seg["text"],
                    "words": words,
                }
            )
        return {"language": language, "segments": out}


def _ctx(tmp_path, params: dict[str, Any], texts: list[LyricsText] | None = None) -> Ctx:
    return Ctx(
        job=JobSpec(
            job_id="j",
            media_id="m1",
            job_type="align",
            source_uri="/x.wav",
            params=params,
            media_dir=str(tmp_path),
        ),
        work=str(tmp_path),
        audio=AudioCtx(path="/x.wav", vocals_path="/vocals.wav", duration_sec=60.0),
        lyrics=LyricsCtx(texts=list(texts or [])),
    )


def _drive(ctx: Ctx, aligner: _Aligner, *, sources: list[Any] | None = None) -> None:
    """Run the three align steps that own the pinned decision, honouring `applies()`.

    `applies()` is honoured deliberately: the GradeAndSelect skip IS the fix, so a driver that ran
    every step unconditionally could not tell head from base.
    """
    steps = [
        AcquireTexts(sources=sources if sources is not None else []),
        GradeAndSelect(),
        TimeTexts(aligner=aligner),
    ]

    async def _go() -> None:
        for step in steps:
            if not step.applies(ctx):
                continue
            async for ev in step.run(ctx):
                if isinstance(ev, StepResult) and ev.outcome is Outcome.STOP:
                    return

    asyncio.run(_go())


def _write_stored_candidate(tmp_path) -> None:
    """A candidate already on disk, carrying STALE timings (900s+) an operator would reject."""
    doc = {
        "language": "en",
        "lines": [
            {
                "start": 900.0,
                "end": 902.0,
                "text": "stored line one",
                "words": [{"word": "stored", "start": 900.0, "end": 901.0}],
            },
            {
                "start": 903.0,
                "end": 905.0,
                "text": "stored line two",
                "words": [{"word": "two", "start": 903.0, "end": 904.0}],
            },
        ],
        "words": [{"word": "stored", "start": 900.0, "end": 901.0}],
    }
    path = tmp_path / STORED_REF
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc), encoding="utf-8")


def test_pinned_text_is_timed_verbatim_as_a_manual_candidate_under_the_pinned_ref(tmp_path):
    """Arm 1. Pasted words: SOURCE_MANUAL's first producer, written under the ref the CORE chose."""
    ctx = _ctx(tmp_path, {"language": "en", "pinnedRef": MANUAL_REF, "pinnedText": PASTED})
    _drive(ctx, _Aligner())

    cands = ctx.out.artifacts["lyrics"]["candidates"]  # RED ON BASE: no "lyrics" artifact at all
    assert len(cands) == 1, cands
    assert cands[0]["ref"] == MANUAL_REF
    assert cands[0]["textSource"] == SOURCE_MANUAL
    assert cands[0]["timing"] == TIMING_WORD
    # No comparative grading happened, so neither graded axis may be claimed.
    assert "agreement" not in cands[0] and "coverage" not in cands[0], cands[0]
    assert ctx.lyrics.selection is None and ctx.out.selection is None
    # The doc landed at the pinned ref and holds the PASTED lines, in order.
    doc = json.loads((tmp_path / MANUAL_REF).read_text(encoding="utf-8"))
    assert [ln["text"] for ln in doc["lines"]] == PASTED.splitlines()


def test_pinned_ref_alone_retimes_the_stored_doc_and_preserves_its_text_source(tmp_path):
    """Arm 2. Re-time an existing candidate: same ref, its own textSource, fresh timings."""
    _write_stored_candidate(tmp_path)
    aligner = _Aligner()
    ctx = _ctx(tmp_path, {"language": "en", "pinnedRef": STORED_REF})
    _drive(ctx, aligner)

    cands = ctx.out.artifacts["lyrics"]["candidates"]  # RED ON BASE
    assert len(cands) == 1, cands
    assert cands[0]["ref"] == STORED_REF
    assert cands[0]["textSource"] == SOURCE_LRCLIB, "the stored candidate's tier must survive a re-time"
    assert "agreement" not in cands[0] and "coverage" not in cands[0], cands[0]
    # The aligner was handed the stored WORDS with no timings — a re-time reads the audio, not the doc.
    assert aligner.calls, "the pinned text was never aligned"
    handed = aligner.calls[0][0]
    assert [s["text"] for s in handed] == ["stored line one", "stored line two"]
    assert all("start" not in s and "end" not in s for s in handed), handed
    # The doc at the pinned ref was OVERWRITTEN with the fresh timings, not left at 900s.
    doc = json.loads((tmp_path / STORED_REF).read_text(encoding="utf-8"))
    assert doc["words"][0]["start"] == 0.0, doc["words"][:2]
    assert all(w["start"] < 100.0 for w in doc["words"]), doc["words"]
    assert [ln["text"] for ln in doc["lines"]] == ["stored line one", "stored line two"]


def test_a_pinned_ref_that_escapes_the_media_directory_is_refused(tmp_path):
    """Arm 3. A traversing key must STOP the job, never read or write outside the store, and never be
    silently downgraded into an ordinary comparative process."""
    ctx = _ctx(tmp_path, {"language": "en", "pinnedRef": "../../etc/passwd.json", "pinnedText": PASTED})
    _drive(ctx, _Aligner())

    assert "lyrics" not in ctx.out.artifacts, ctx.out.artifacts
    assert ctx.lyrics.selection is None, "a refused pin must not fall through to grading"


def _timed(source: str, body: str, role: str) -> LyricsText:
    t = LyricsText(
        text_source=source,
        segments=[{"start": 0.0, "end": 30.0, "text": body}],
        timing=TIMING_LINE,
        text_confidence="high",
        role=role,
    )
    if role == ROLE_BASELINE:
        t.baseline_rank = 0
        t.text_confidence = "low"
    return t


def test_with_no_pinned_params_the_comparative_path_is_unchanged(tmp_path):
    """Arm 4, the control. Grading still runs, the ref is still the DERIVED candidate_key, and the
    graded axes still ship. Passes on base and on head; it is what proves the guards are inert on an
    ordinary process and that the pinned ref override cannot leak onto a graded candidate.

    Drives GradeAndSelect + TimeTexts over PRE-ACQUIRED texts (the neighbour overshoot test's idiom),
    not AcquireTexts: acquisition runs source objects, and seeding it with finished LyricsTexts is not
    what the ordinary path does. What this arm guards is the two GUARDS the fix adds — that
    GradeAndSelect.applies() stays True and TimeTexts uses the derived key — when nothing is pinned."""
    texts = [_timed(SOURCE_LRCLIB, SHARED, ROLE_CANDIDATE), _timed(SOURCE_ASR, SHARED, ROLE_BASELINE)]
    ctx = _ctx(tmp_path, {"language": "en"}, texts=texts)
    aligner = _Aligner()
    grade, time_step = GradeAndSelect(), TimeTexts(aligner=aligner)

    async def _go() -> None:
        assert grade.applies(ctx), "GradeAndSelect must not be skipped when nothing is pinned"
        async for _ in grade.run(ctx):
            pass
        async for ev in time_step.run(ctx):
            if isinstance(ev, StepResult) and ev.outcome is Outcome.STOP:
                return

    asyncio.run(_go())

    assert ctx.lyrics.selection is not None, "GradeAndSelect must still run when nothing is pinned"
    cands = ctx.out.artifacts["lyrics"]["candidates"]
    refs = [c["ref"] for c in cands]
    assert candidate_key("m1", SOURCE_LRCLIB, TIMING_WORD) in refs, refs
    # The MANUAL source only ever appears via a pin; the ordinary path must never fabricate it.
    # (STORED_REF is itself m1-lrclib-word — the same key the ordinary lrclib candidate legitimately
    # produces here — so it is deliberately NOT asserted absent.)
    assert MANUAL_REF not in refs, refs
    assert any("agreement" in c for c in cands), cands
