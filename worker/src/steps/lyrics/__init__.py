"""The lyrics steps, split by pipeline stage.

One file held all six — 1029 lines, 55% of every step in the worker, where no other step file holds more
than four. Split by the stage each step belongs to: `acquire` gets words, `grade` chooses which words,
`align` puts them on this recording's clock, `publish` hands them to the core, and `pinned` carries the
re-time path the first three all touch.

Every name the old module exposed is re-exported here, so `from .steps.lyrics import TimeTexts` and the
suite's `from src.steps.lyrics import _time_one` keep resolving unchanged.
"""

from ...lyrics.validate import _opening_window_indices as _opening_window_indices  # noqa: F401
from .acquire import AUTHORED as AUTHORED  # noqa: F401
from .acquire import MACHINE as MACHINE  # noqa: F401
from .acquire import AcquireTexts as AcquireTexts  # noqa: F401
from .acquire import FetchCaptions as FetchCaptions  # noqa: F401
from .align import TimeTexts as TimeTexts  # noqa: F401
from .align import _opens_for as _opens_for  # noqa: F401
from .align import _time_one as _time_one  # noqa: F401
from .grade import GradeAndSelect as GradeAndSelect  # noqa: F401
from .grade import PresplitTexts as PresplitTexts  # noqa: F401
from .publish import PublishLyrics as PublishLyrics  # noqa: F401
