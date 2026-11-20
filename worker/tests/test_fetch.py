"""The fetch flow and title parsing.

Identification matters disproportionately: `artist` and `track` from here are what a later align job
hands to the lyrics provider, so a wrong split produces a confident lookup of the WRONG SONG, whose text
then aligns badly and costs several retries to reject. Hence the bias throughout — a partial or uncertain
identification must report itself as such rather than guessing.
"""

from __future__ import annotations

import pytest

from encore_worker.domain.identity import Identified, identify_from_title
from encore_worker.steps.api import NotOurJob
from encore_worker.steps.records import AudioRef, JobRef
from encore_worker.workflows.fetch import run_fetch

JOB = JobRef(job_id="j1", media_id="m1", media_dir="/media/m1", source_uri="https://x.test/v")


class Fake:
    def __init__(self, *, found: Identified | None = None, publish_raises: Exception | None = None) -> None:
        self.found = found or Identified(artist="a-ha", track="Take On Me", source="tags")
        self.publish_raises = publish_raises
        self.calls: list[str] = []
        self.notes: list[tuple[str, str]] = []

    async def acquire_audio(self, job: JobRef) -> AudioRef:
        self.calls.append("acquire_audio")
        return AudioRef(path="/media/m1/original.mp3", duration_sec=225.0)

    async def annotate(self, job: JobRef, audio: AudioRef) -> Identified:
        self.calls.append("annotate")
        return self.found

    async def publish_original(self, job: JobRef, audio: AudioRef, found: Identified) -> str:
        self.calls.append("publish_original")
        if self.publish_raises is not None:
            raise self.publish_raises
        return "library/m1.mp3"

    async def note(
        self, job: JobRef, state: str, attempt: int, verdict: str, why: str, knob: str | None
    ) -> None:
        self.notes.append((state, verdict))


# ── the flow ─────────────────────────────────────────────────────────────────────────────────────


async def test_an_identified_song_publishes() -> None:
    fake = Fake()
    outcome = await run_fetch(JOB, fake)

    assert outcome.published == "library/m1.mp3"
    assert outcome.unidentified is False
    assert fake.calls == ["acquire_audio", "annotate", "publish_original"]


async def test_an_unidentified_song_still_publishes() -> None:
    """The bytes are on disk and the song is playable. Not knowing its artist costs it lyrics later, not
    playability now — refusing would lose a download that succeeded over a lookup that did not."""
    fake = Fake(found=Identified(source="none"))
    outcome = await run_fetch(JOB, fake)

    assert outcome.published == "library/m1.mp3"
    assert outcome.unidentified is True
    assert "not identified" in outcome.why


async def test_the_state_note_distinguishes_identified_from_not() -> None:
    """A later wrong-lyrics report is usually traceable to this line."""
    identified = Fake()
    await run_fetch(JOB, identified)
    assert ("annotate", "identified") in identified.notes

    unknown = Fake(found=Identified(source="none"))
    await run_fetch(JOB, unknown)
    assert ("annotate", "unidentified") in unknown.notes


async def test_a_partial_identification_is_not_confident() -> None:
    """A lookup on a title with no artist returns another song's words, which is worse than a miss
    because it looks like a hit."""
    for partial in (Identified(track="Take On Me"), Identified(artist="a-ha")):
        outcome = await run_fetch(JOB, Fake(found=partial))
        assert outcome.unidentified is True
        assert "no lyrics lookup is possible" in outcome.why


async def test_a_lost_lease_at_publish_is_a_normal_outcome() -> None:
    fake = Fake(publish_raises=NotOurJob("reassigned to w2"))
    outcome = await run_fetch(JOB, fake)
    assert outcome.published == ""
    assert "abandoned before publishing" in outcome.why


async def test_an_acquisition_failure_still_raises() -> None:
    """No bytes means nothing to publish, and nothing substitutes."""

    class NoAudio(Fake):
        async def acquire_audio(self, job: JobRef) -> AudioRef:
            raise RuntimeError("video unavailable")

    with pytest.raises(RuntimeError, match="video unavailable"):
        await run_fetch(JOB, NoAudio())


# ── title parsing ────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("title", "artist", "track"),
    [
        ("a-ha - Take On Me", "a-ha", "Take On Me"),
        ("Queen – Bohemian Rhapsody", "Queen", "Bohemian Rhapsody"),
        ("Radiohead — Creep", "Radiohead", "Creep"),
        ("a-ha - Take On Me (Official Video)", "a-ha", "Take On Me"),
        ("Queen - Somebody To Love [Official Audio]", "Queen", "Somebody To Love"),
        ("Toto - Africa (Lyrics)", "Toto", "Africa"),
    ],
)
def test_parses_the_unambiguous_shape(title: str, artist: str, track: str) -> None:
    found = identify_from_title(title)
    assert (found.artist, found.track) == (artist, track)
    assert found.confident
    assert found.source == "title-parse"


@pytest.mark.parametrize(
    "title",
    [
        "Bohemian Rhapsody Queen Live 1985",
        "Take On Me",
        "",
        "   ",
        "-",
        " - ",
        "Artist - ",
        " - Track",
        "Song: A Subtitle",
    ],
)
def test_refuses_to_guess_without_a_clear_separator(title: str) -> None:
    """A wrong split is worse than no split: it produces a confident lookup of a song that is not this
    one, and the align flow spends real alignment passes discovering that."""
    found = identify_from_title(title)
    assert not found.confident
    assert found.source == "none"


def test_a_colon_is_not_treated_as_a_separator() -> None:
    """It appears inside real titles far more often than it separates an artist from one."""
    assert not identify_from_title("Symphony No. 5: Allegro").confident


def test_noise_is_stripped_case_insensitively() -> None:
    assert identify_from_title("a-ha - Take On Me (OFFICIAL VIDEO)").track == "Take On Me"


def test_a_hyphen_inside_an_artist_name_survives() -> None:
    """`a-ha` has a hyphen; only a SPACED separator splits, which is why the spaces are required."""
    assert identify_from_title("a-ha - Take On Me").artist == "a-ha"


def test_only_the_first_separator_splits() -> None:
    """A track whose own name contains one must keep it."""
    found = identify_from_title("Artist - Track - Live Version")
    assert found.artist == "Artist"
    assert found.track == "Track - Live Version"


def test_confident_requires_both_fields() -> None:
    assert Identified(artist="a", track="b").confident
    assert not Identified(artist="a").confident
    assert not Identified(track="b").confident
    assert not Identified().confident


# ── the annotation artifact: how core learns the canonical names ───────────────────────────────────


def test_an_identified_song_reports_an_annotation() -> None:
    """NOT the same as reporting it in `facts`. `facts` is diagnostic; `annotation` is what core APPLIES to
    set `artistCanonical`/`titleCanonical` — and those are exactly the lookup keys `assignParams` later sends
    to an align job. Reporting only facts means core never learns the names, every align arrives with nothing
    to look up, and the provider tier is skipped silently.
    """
    from encore_worker.__main__ import _annotation_artifacts

    got = _annotation_artifacts(
        Identified(artist="Louis Armstrong", track="What a Wonderful World", source="title-parse")
    )
    assert got is not None
    ann = got["annotation"]
    assert ann["artist"] == "Louis Armstrong"
    assert ann["title"] == "What a Wonderful World"


def test_the_annotation_source_is_one_core_accepts() -> None:
    """Core's `applyAnnotation` accepts exactly `youtube` or `musicbrainz` and returns false for anything
    else — so reporting our own internal label (`title-parse`) would be silently discarded."""
    from encore_worker.__main__ import _annotation_artifacts

    got = _annotation_artifacts(Identified(artist="A", track="B", source="title-parse"))
    assert got is not None
    assert got["annotation"]["source"] in ("youtube", "musicbrainz")


def test_a_title_parse_claims_only_medium_confidence() -> None:
    """`high` is a CITATION in core's never-regress rule: a later medium-confidence answer cannot overwrite
    it. A guess at a human-typed string must not lock out a real MusicBrainz lookup later."""
    from encore_worker.__main__ import _annotation_artifacts

    got = _annotation_artifacts(Identified(artist="A", track="B"))
    assert got is not None
    assert got["annotation"]["confidence"] == "medium"


def test_the_floor_carries_no_mbid() -> None:
    """Core requires an MBID only for a `musicbrainz` annotation. Inventing one here would claim a
    MusicBrainz identity this worker never looked up."""
    from encore_worker.__main__ import _annotation_artifacts

    got = _annotation_artifacts(Identified(artist="A", track="B"))
    assert got is not None
    assert not got["annotation"].get("mbid")


def test_an_unidentified_song_reports_no_annotation() -> None:
    """Core requires BOTH names. A half-annotation would claim a lookup key that returns another song's
    words — worse than no key, because it looks like a hit."""
    from encore_worker.__main__ import _annotation_artifacts

    assert _annotation_artifacts(Identified()) is None
    assert _annotation_artifacts(Identified(artist="A")) is None
    assert _annotation_artifacts(Identified(track="B")) is None


def test_a_refused_fetch_publish_is_a_retryable_failure_not_a_completion() -> None:
    """Sent as `job:complete`, core marked the fetch done and queued stems for audio nobody published."""
    from encore_worker.__main__ import _fetch_completion  # noqa: PLC0415
    from encore_worker.host.config import Config  # noqa: PLC0415
    from encore_worker.protocol import frames as f  # noqa: PLC0415
    from encore_worker.workflows.fetch import FetchOutcome  # noqa: PLC0415

    cfg = Config(core_url="ws://core.test/w", worker_id="w1", concurrency=1, version="9")
    refused = FetchOutcome(published="", identified=Identified(), why="abandoned before publishing: revoked")
    frame = _fetch_completion(JOB, cfg, refused)
    assert isinstance(frame, f.Failed)
    assert frame.retryable is True

    done = FetchOutcome(published="media/m1.webm", identified=Identified(artist="a", track="b"), why="ok")
    assert isinstance(_fetch_completion(JOB, cfg, done), f.Complete)
