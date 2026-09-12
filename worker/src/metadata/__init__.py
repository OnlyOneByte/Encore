"""Metadata: identifying a downloaded song, best-effort.

  * `annotate` — MusicBrainz. Matches a yt-dlp download by title plus exact duration, and reports a
    confidence rather than an answer.

An ANNOTATOR, not a catalog. It runs as the final step of a fetch, because it needs a real title and an
exact duration to match on, and it never fails a process: a declined match, an unreachable service or
`ENCORE_ANNOTATE=0` all leave the title-parser's values standing.

Three things measured against the real service that are easy to get wrong: a query returns many
recordings all scoring 100, so DURATION is the discriminator and not the score; `length` is
milliseconds; and the artist can come back with a Unicode hyphen (U+2010) that ordinary comparison
misses. Album and year are parsed to SELECT a recording but deliberately never published — they resolve
to compilations and bootleggery often enough that a wrong album is worse than none.

MusicBrainz allows one request per second per IP and penalises excess by declining everything, so calls
go through a process-global serialised rate gate. That gate SLEEPS, which is why the `Annotate` step hands
the call to `asyncio.to_thread` rather than awaiting it inline: a blocking sleep on the event loop would
stall the worker, and with concurrency > 1 the
other job's progress events would stop arriving and its lease would start expiring. Waiting on metadata
must not look like a hung separation.
NAME COLLISION, deliberately not papered over: this package has a submodule `annotate` AND that module
has a function `annotate`. Re-exporting the function here would SHADOW the submodule, so
`from .metadata import annotate` would silently bind the function and `annotate.parse_recordings` would
raise AttributeError on a plain function object. So only `MusicBrainzClient` is re-exported; reach the
function at its full path (`from .metadata.annotate import annotate`), which is also more readable at the
call site.
"""

from __future__ import annotations

from .annotate import MusicBrainzClient

__all__ = ["MusicBrainzClient"]
