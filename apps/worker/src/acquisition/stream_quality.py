"""Source-audio stream quality policy. PURE -- no network, no subprocess, no yt-dlp import.

WHY THIS EXISTS. This module decides which audio the whole cook pipeline consumes, and that decision
is unrecoverable: the separator, the lossless FLAC instrumental, and the ASR lyrics tier all inherit
whatever arrives here. Encoding the instrumental as FLAC cannot restore fidelity that was discarded at
download time, so this is the upstream-most quality lever Encore has.

`-f bestaudio` alone was not enough. yt-dlp's default ranking is bitrate-led, so an OLD upload that
carries both a modern Opus stream and a legacy AAC stream can hand back the AAC one purely because its
nominal bitrate is higher. Opus is a materially better codec at equal or lower bitrate, and it is also
what YouTube serves for anything recent -- so codec GENERATION, not bitrate, is the axis worth ranking
on. `FORMAT_SELECTOR` encodes that preference by POSITION and hands the decision to yt-dlp's own
selector engine, which is where the multiple-format data actually exists.
"""

from __future__ import annotations

#: yt-dlp format selector: ordered alternatives, FIRST match wins.
#:
#: Preference is expressed by POSITION rather than by bitrate, which is the whole point -- a bitrate
#: comparison is what picks legacy AAC over modern Opus.
#:
#: The final branch is a bare `best`, NOT a bare `bestaudio`. Every `bestaudio*` branch requires an
#: audio-only (adaptive/DASH) stream to exist, and there are real videos where none does -- when
#: YouTube refuses the player API, the only surviving format can be the legacy MUXED `18`
#: (360p mp4, AAC 128k). Against such a video every `bestaudio` branch misses and the cook dies at
#: download with "Requested format is not available", which is strictly WORSE than yt-dlp's own
#: default (it would have fallen back to `best`). `best` restores the guarantee this selector is
#: supposed to make: it can only ever REORDER what yt-dlp would have taken, never reduce what is
#: downloadable. Extracting audio from a muxed stream costs nothing extra -- the decode stage already
#: runs ffmpeg over whatever arrived, and it simply picks the audio stream.
#:
#: Still never a TRANSCODE and still native-container: no `bestvideo`, no `-x`, no `--audio-format`.
#: `best` may carry a video track, which the decode stage discards; that is not the same as asking
#: yt-dlp to re-encode, which is the regression these constraints exist to prevent.
FORMAT_SELECTOR = "bestaudio[acodec=opus]/bestaudio[acodec^=mp4a]/bestaudio[ext=m4a]/bestaudio/best"
