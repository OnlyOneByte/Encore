"""The diarize step: attribute a `part` to each lyric line from the vocals stem.

Where it sits and why. This runs in the ALIGN plan, AFTER TimeTexts has written the word-timed
candidate docs to disk, and BEFORE PublishLyrics points the result at one. That order is forced by
what it needs: attribution is a mapping from speaker turns onto TIMED lyric lines, so the timed lines
have to exist first, and it must be applied before the artifact is pointed at. It reads the same
isolated vocals stem the aligner used (`ctx.audio.vocals_path`).

It is the SOURCE half of the duet feature the owner ruled for ("diarize in the worker"); the
render half reads the `part` this writes. On its own it changes nothing a singer sees — that is what
the `internal` label records — so every failure mode here is a silent fall-back to one colour, never a job
failure: a box that cannot diarize, a stem that will not diarize, or a song that is not a confident
duet all publish exactly today's single-colour artifact.
"""

from __future__ import annotations

import json
import os
from collections.abc import AsyncIterator
from typing import Any

from ..diarize import attribute_parts, diarizer_for
from ..processor import ProgressEvent
from ..runtime.ctx import Ctx
from ..runtime.runner import run_blocking
from ..runtime.step import Step, StepResult
from ..vocabulary import Stage, Timing


class Diarize(Step):
    """Diarize the vocals stem and stamp an abstract `part` onto each WORD-TIMED candidate doc.

    Reads the published candidates TimeTexts wrote (`out.artifacts.lyrics.candidates`) and re-writes the
    word-timed ones on disk with parts added. Only word-timed docs: a line-synced fallback has no
    per-line words for the render layer to colour per part, and the same feature's precedent (`romanization`) is
    likewise carried only where the timing supports it.

    Best-effort throughout. No vocals stem, no diarizer on this box, a diarizer that raises, or a song
    the attribution layer judges not a confident duet — each leaves the docs exactly as TimeTexts wrote
    them (no `part` field), which the render layer reads as one colour. The attribution layer
    (`diarize.attribution`) owns the "is this actually a duet" judgement; this step owns only running
    the model and rewriting the files.
    """

    name = "diarize"
    stage = Stage.ALIGNING
    reads = frozenset({"job", "audio.vocals_path", "out"})
    writes = frozenset({"out"})

    def __init__(self, diarizer: Any = None) -> None:
        self._diarizer = diarizer

    def applies(self, ctx: Ctx) -> bool:
        # Needs the isolated vocals stem — diarizing the mix is worse than useless — and a lyrics
        # artifact to attribute. A song with no stem, or an instrumental that produced no lyrics, takes
        # the single-colour fallback by not running at all.
        lyrics = ctx.out.artifacts.get("lyrics")
        return bool(ctx.audio.vocals_path) and bool(lyrics and lyrics.get("candidates"))

    async def run(self, ctx: Ctx) -> AsyncIterator[ProgressEvent | StepResult]:
        yield ProgressEvent(stage=self.stage, pct=0)

        # Only word-timed candidates can carry per-part colour; skip if none. `candidate['ref']` is the
        # media-dir-relative path TimeTexts wrote the doc to. Read the artifact via `.get()` and a local
        # rather than subscripting `ctx.out.artifacts["lyrics"]` — this step is a CONSUMER of the lyrics
        # artifact TimeTexts wrote, not a second writer of it, and the one-writer-per-kind guard
        # (test_worker_layers) reads any `out.artifacts["lyrics"]` subscript as a write.
        lyrics = ctx.out.artifacts.get("lyrics") or {}
        candidates = lyrics.get("candidates") or []
        word_timed = [c for c in candidates if c.get("timing") == Timing.WORD.value]
        if not word_timed:
            ctx.note("diarize: no word-timed lyrics to attribute — leaving as single-colour")
            yield ProgressEvent(stage=self.stage, pct=100)
            return

        diarizer = self._diarizer or diarizer_for(ctx.engines.device or "cpu")
        vocals = ctx.audio.vocals_path or ""

        segments: list[dict[str, Any]] = []
        try:
            async for kind, val in run_blocking(lambda: diarizer.diarize(vocals), self.stage, 50):
                if kind == "progress":
                    yield val
                else:
                    segments = val or []
        except Exception as exc:  # noqa: BLE001 — an internal enhancement must never fail an align job
            ctx.note(f"diarize: diarization failed ({type(exc).__name__}: {exc}) — single colour")
            yield ProgressEvent(stage=self.stage, pct=100)
            return

        colored = 0
        for candidate in word_timed:
            final = os.path.join(ctx.job.media_dir, candidate["ref"])
            try:
                with open(final, encoding="utf-8") as f:
                    doc = json.load(f)
            except (OSError, ValueError) as exc:
                ctx.note(f"diarize: could not re-read {candidate['ref']} ({exc}) — leaving as-is")
                continue
            attributed = attribute_parts(doc, segments)
            # attribute_parts returns the doc UNCHANGED (no `part` on any line) unless it judged a
            # confident duet, so a rewrite here only ever adds parts on a real duet. Only write back
            # when something actually changed, to keep an undiarized process byte-identical to today.
            if any(isinstance(ln, dict) and "part" in ln for ln in attributed.get("lines", [])):
                with open(final, "w", encoding="utf-8") as f:
                    json.dump(attributed, f, ensure_ascii=False)
                colored += 1

        if colored:
            ctx.note(f"diarize: attributed duet parts on {colored} lyric candidate(s)")
        else:
            ctx.note("diarize: not a confident duet — single colour (unchanged from today)")
        yield ProgressEvent(stage=self.stage, pct=100)
