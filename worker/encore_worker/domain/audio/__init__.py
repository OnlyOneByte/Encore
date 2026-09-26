"""Pure numeric audio analysis: the `songProfile` artifact core records per song.

PURE by the same rule as the rest of `domain/`: numpy and stdlib only, no torch, no event loop, no I/O
beyond reading a file handed to it. That is what lets every algorithm here be tested against synthesised
signals with no models installed.

`profile.build_song_profile` is the entry point and the contract: it ALWAYS returns the full wire shape,
and no failure inside it can raise. Core's process gate reads a PRESENT profile as "the analysis ran", so
an absent one makes core wait forever for a step it thinks already happened.
"""
