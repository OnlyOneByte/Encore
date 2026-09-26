"""What a song IS: artist, track, and how confidently we know.

Pure, and in `domain/` rather than beside the fetch workflow because `steps/` needs it too — and a step
importing a workflow inverts the dependency direction. The layer test caught exactly that.

WHY THIS MATTERS DISPROPORTIONATELY. These two fields are what a later align job hands to the lyrics
provider. A wrong identification produces a confident lookup of the WRONG SONG, whose text then aligns
badly and costs the align flow several retries to reject. So the bias throughout is toward admitting
ignorance: `confident` requires BOTH fields, and `identify_from_title` refuses to guess.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Identified:
    """What a song turned out to be. Every field optional, because not knowing is a real answer."""

    artist: str | None = None
    track: str | None = None
    #: Where the identification came from: "tags", "title-parse", "musicbrainz", "job-params", "none".
    #: Recorded so a bad lookup downstream is traceable to how the song was named rather than to the provider.
    source: str = "none"
    #: MusicBrainz recording id, set ONLY by a musicbrainz match. Core requires it for a `musicbrainz`
    #: annotation and ignores the field otherwise, so a title parse must leave it None rather than invent one.
    mbid: str | None = None
    #: `high` only when a duration corroborated the names; a title parse is `medium` by construction. Core
    #: treats `high` as fact, so the two tiers are not interchangeable — see `domain/metadata.confidence_for`.
    confidence: str = "medium"

    @property
    def confident(self) -> bool:
        """Both fields present. The align flow's provider step requires exactly this.

        A partial identification is NOT usable: a lookup on a title with no artist returns another
        song's words, which is worse than a miss because it looks like a hit.
        """
        return bool(self.artist and self.track)


def identify_from_title(title: str) -> Identified:
    """Split an upload title into artist and track. Pure, and deliberately conservative.

    Only the unambiguous `Artist - Track` shape is accepted. Everything else returns nothing, because a
    wrong split is worse than no split: it produces a confident provider lookup of a song that is not
    this one, and the align flow then spends real alignment passes discovering that.

    The noise suffixes uploaders add are stripped, but no attempt is made to parse a title without a
    separator — "Bohemian Rhapsody Queen Live 1985" has no reliable boundary, and guessing one is how a
    library ends up with lyrics for the wrong recording.
    """
    cleaned = title.strip()
    for noise in (
        "(official video)",
        "(official music video)",
        "(official audio)",
        "(lyrics)",
        "(lyric video)",
        "(audio)",
        "(hd)",
        "[official video]",
        "[official audio]",
        "[lyrics]",
    ):
        low = cleaned.lower()
        while noise in low:
            at = low.index(noise)
            cleaned = (cleaned[:at] + cleaned[at + len(noise) :]).strip()
            low = cleaned.lower()

    # An en dash and a hyphen are both used as the separator; a colon is not, because it appears inside
    # real titles far more often than it separates an artist from one.
    for separator in (" - ", " – ", " — "):
        if separator in cleaned:
            artist, _, track = cleaned.partition(separator)
            if artist.strip() and track.strip():
                return Identified(artist=artist.strip(), track=track.strip(), source="title-parse")
    return Identified(source="none")
