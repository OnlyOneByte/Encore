"""Source-audio stream quality policy. PURE -- no network, no subprocess, no yt-dlp import.

This decides which audio the whole pipeline consumes, and the decision is UNRECOVERABLE: the
separator, the lossless FLAC instrumental, and the ASR lyrics tier all inherit whatever arrives here.

`-f bestaudio` alone is not enough: yt-dlp's default ranking is bitrate-led, so an OLD upload with
both a modern Opus stream and a legacy AAC stream can hand back the AAC one purely on nominal
bitrate. Opus is a materially better codec at equal or lower bitrate, so codec GENERATION, not
bitrate, is the axis worth ranking on. `FORMAT_SELECTOR` encodes that preference by POSITION.
"""

from __future__ import annotations

#: yt-dlp format selector: ordered alternatives, FIRST match wins. Preference is by POSITION, not
#: bitrate (a bitrate comparison is what picks legacy AAC over modern Opus).
#:
#: The final branch is a bare `best`, NOT `bestaudio`: every `bestaudio*` branch requires an
#: audio-only stream to exist, and when YouTube refuses the player API the only surviving format can
#: be a legacy MUXED stream. Missing that would fail the download entirely — strictly WORSE than
#: yt-dlp's own default. `best` restores the guarantee this selector makes: it can only ever REORDER
#: what yt-dlp would have taken, never reduce what is downloadable (the decode stage discards any
#: video track for free).
#:
#: Still never a TRANSCODE: no `bestvideo`, no `-x`, no `--audio-format`.
FORMAT_SELECTOR = "bestaudio[acodec=opus]/bestaudio[acodec^=mp4a]/bestaudio[ext=m4a]/bestaudio/best"
