"""Pure numeric audio analysis: the `songProfile` artifact core records per song.

numpy and stdlib only. `profile.build_song_profile` is the entry point and the contract — it ALWAYS returns
the full wire shape and cannot raise; docs/arch/05-worker.md §3 and §3.1.
"""
