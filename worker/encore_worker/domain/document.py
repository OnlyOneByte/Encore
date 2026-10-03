"""The lyric document shape, defined ONCE.

In `domain/` because that is the lowest layer both `adapters/` and `steps/` may import, and `Mapping` rather
than `dict` because these travel inside frozen records DBOS checkpoints: a mutation of one is invisible after
a replay, where the record is rebuilt from the checkpoint (XA-16).
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
