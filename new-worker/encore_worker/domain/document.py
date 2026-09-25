"""The lyric document shape, defined ONCE.

This existed in three places before — `adapters/ports.py`, `steps/records.py` and
`domain/lyrics/measure.py` each declared a `Segment`, and two of them disagreed about whether it was a
`dict` or a `Mapping`. mypy caught it the moment a step tried to pass one to the other, which is the
argument for a single definition rather than a convention.

It lives in `domain/` because that is the lowest layer both `adapters/` and `steps/` may import, and it
is data with no behaviour, so nothing below it is needed.

`Mapping`, not `dict`: these travel inside frozen records that DBOS checkpoints, and a mutable value
inside a frozen record is a mutation that survives nothing — invisible after a replay, where the record
is rebuilt from the checkpoint rather than from the object that was mutated.
"""

from __future__ import annotations

from collections.abc import Mapping

#: One line of lyrics, timed or not. Keys the pipeline reads: `text`, `start`, `end`, and `words` for a
#: word-timed line. A plain mapping because it is written into the JSON artifact verbatim and the shape
#: is the core's contract, not this worker's.
Segment = Mapping[str, object]

#: A whole lyric document: `{"language": str, "lines": [Segment, ...]}`.
Doc = Mapping[str, object]

#: Word timing: each line carries per-word spans. What a karaoke highlight needs.
TIMING_WORD = "word"

#: Line timing: a start and an end per line and nothing finer. The floor for publishable lyrics.
TIMING_LINE = "line"
