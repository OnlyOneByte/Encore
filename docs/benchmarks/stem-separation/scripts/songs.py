"""The benchmark songs, declared: which file sums into the vocals ground truth, which into the instrumental,
and which is present but deliberately unused, with the reason.

A manifest rather than a filename rule, because the three songs decompose three different ways and adding a
song is a new entry rather than a generalisation. The measurements behind each choice — the pre-summed
references, the wet-vocal rule, TheFatRat's attribution condition — are in
docs/benchmarks/stem-separation/README.md, "Test inputs".
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

HERE = os.path.dirname(os.path.abspath(__file__))
SONGS_DIR = os.path.normpath(os.path.join(HERE, "..", "..", "benchmark-songs"))


@dataclass(frozen=True, slots=True)
class Song:
    """One benchmark song: where its audio comes from, and how to build ground truth from it."""

    song_id: str
    title: str
    video: str
    #: Filenames (relative to the song directory) that sum to the VOCALS ground truth.
    vocals: tuple[str, ...]
    #: Filenames that sum to the INSTRUMENTAL ground truth.
    instrumental: tuple[str, ...]
    #: Files present but deliberately NOT used, with the reason. Recorded so a reader does not assume an
    #: omission was an oversight — and so nobody "fixes" it by adding them back.
    excluded: dict[str, str] = field(default_factory=dict)

    @property
    def directory(self) -> str:
        return os.path.join(SONGS_DIR, self.song_id)

    def path(self, name: str) -> str:
        return os.path.join(self.directory, name)

    @property
    def youtube_mix(self) -> str:
        """The worker's own input path: yt-dlp output, used for TIMING."""
        return self.path("youtube-mix.wav")

    @property
    def reference_mix(self) -> str:
        """Built from the stems, used for SCORING — see `prepare.py` for why the two differ."""
        return self.path("reference-mix.wav")

    @property
    def reference_instrumental(self) -> str:
        return self.path("reference-instrumental.wav")

    @property
    def reference_vocals(self) -> str:
        return self.path("reference-vocals.wav")


SONGS: tuple[Song, ...] = (
    Song(
        song_id="tfr-flyaway",
        title="TheFatRat - Fly Away (feat. Anjulie)",
        video="https://www.youtube.com/watch?v=cMg8KaMdDYo",
        vocals=("Fly Away - Stems 06 Vocals Wet.wav",),
        instrumental=(
            "Fly Away - Stems 01 Melodies and Brass.wav",
            "Fly Away - Stems 02 Pads and Bass.wav",
            "Fly Away - Stems 03 Drums.wav",
            "Fly Away - Stems 04 FX.wav",
        ),
        excluded={
            "Fly Away - Stems 05 Vocals Dry.wav": (
                "the same performance pre-effects. Including it alongside the wet vocal would count the "
                "vocal twice; using it INSTEAD would score every model down for the reverb it correctly left "
                "in place."
            ),
        },
    ),
    Song(
        song_id="tfr-mayday",
        title="TheFatRat & Laura Brehm - Mayday",
        video="https://www.youtube.com/watch?v=DT61L8hbbJ4",
        vocals=("MAYDAY - ACCAPELLA REFERENCE.wav",),
        instrumental=("MAYDAY - INSTRUMENTAL REFERENCE.wav",),
        excluded={
            "* STEM PM.wav (24 files)": (
                "MEASURED as unusable rather than merely redundant: summing all 24 gives a signal differing "
                "from (accapella + instrumental) by up to 3.28, so they are not a decomposition of the "
                "references. The references are authoritative. Safe to delete — about 1.5 GB."
            ),
            "MAYDAY - TV TRACK WITHOUT HOOK LEADS REFERENCE.wav": (
                "instrumental plus backing vocals, for live performance. A 2-stem benchmark has no use for a "
                "third mix, and its existence is the clue that some stems are alternates."
            ),
        },
    ),
    Song(
        song_id="tfr-chosen",
        title="TheFatRat - The Chosen",
        video="https://www.youtube.com/watch?v=9YHTVML4PTE",
        vocals=("01 Chosen Vox.wav",),
        instrumental=(
            "02 Chosen Drums.wav",
            "03 Chosen Backing Instruments.wav",
            "04 Chosen Melody Instruments.wav",
        ),
    ),
)

BY_ID = {s.song_id: s for s in SONGS}


def get(song_id: str) -> Song:
    if song_id not in BY_ID:
        raise SystemExit(f"unknown song {song_id!r}; known: {', '.join(sorted(BY_ID))}")
    return BY_ID[song_id]
