"""The lyrics source registry: which sources exist, what each needs, and why one sat out.

A source that swallows its own precondition as an early `return None` makes "this song has no
lyrics" and "this provider has been dead for a month" the same observation — indistinguishable misses.
So a source DECLARES what it requires, one place decides whether the requirement is met, and an
unmet requirement is REPORTED by name. A source that declines for its own reasons still can, but a
source that never got the chance says which input was missing.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .grading import (
    BASELINE_ASR_MIX,
    BASELINE_ASR_VOCALS,
    BASELINE_CAPTIONS_AUTO,
    ROLE_BASELINE,
    ROLE_CANDIDATE,
    AsrSource,
    AutoCaptionsSource,
    CaptionsSource,
    LrclibSource,
    LyricsRequest,
    LyricsSource,
)

#: Confident artist AND track. Without them an authoritative lookup is not possible — a query on a
#: guessed title returns another song's words, which is worse than a miss.
NEEDS_METADATA = "metadata"
#: The isolated vocals stem. ASR wants this; a full mix transcribes badly. Absent until stems are processed,
#: which is exactly why align is CHAINED after stems rather than enqueued alongside it.
NEEDS_VOCALS_STEM = "vocals_stem"
#: The retained original. Present for any job that got past acquisition.
NEEDS_AUDIO = "audio"
#: Cues from the upload's own AUTHORED caption track.
NEEDS_AUTHORED_CUES = "authored_cues"
#: Cues from YouTube's MACHINE track.
NEEDS_MACHINE_CUES = "machine_cues"


#: The ONE place a requirement name is tied to the property of the request that satisfies it: the
#: constants above name the requirements, this pairs each with its check, and `unmet` reads it.
_REQUIREMENT_PREDICATES: tuple[tuple[str, Callable[[LyricsRequest], bool]], ...] = (
    (NEEDS_METADATA, lambda req: bool(req.artist and req.track)),
    (NEEDS_VOCALS_STEM, lambda req: bool(req.vocals_path)),
    (NEEDS_AUDIO, lambda req: bool(req.audio_path)),
    (NEEDS_AUTHORED_CUES, lambda req: bool(req.caption_segments)),
    (NEEDS_MACHINE_CUES, lambda req: bool(req.auto_caption_segments)),
)


def unmet(requirements: frozenset[str], req: LyricsRequest) -> list[str]:
    """Which of these requirements this request does not satisfy.

    Fail-open on a name not in the table (`.get(r, True)`): a requirement nothing knows how to check
    is treated as MET rather than silently excluding a source."""
    have = {name: predicate(req) for name, predicate in _REQUIREMENT_PREDICATES}
    return sorted(r for r in requirements if not have.get(r, True))


@dataclass(frozen=True)
class SourceSpec:
    """One place lyrics text can come from, described rather than constructed.

    `build` is a callable rather than an instance because two of these need a transcriber or an LRCLIB
    client, and building those eagerly would load models and open sockets for sources that will not run.
    """

    id: str
    role: str
    requires: frozenset[str]
    build: Callable[..., LyricsSource]
    baseline_rank: int | None = None

    @property
    def is_baseline(self) -> bool:
        return self.role == ROLE_BASELINE


#: Every source this worker knows about, in the order they are offered. Order is informational — `acquire`
#: runs them all and `select_by_baselines` decides — but it reads best-evidence-first, which is the same
#: order a human would list them in.
SPECS: tuple[SourceSpec, ...] = (
    SourceSpec(
        id="lrclib",
        role=ROLE_CANDIDATE,
        requires=frozenset({NEEDS_METADATA}),
        build=lambda client, to_segments, **_: LrclibSource(client, to_segments),
    ),
    SourceSpec(
        id="captions:authored",
        role=ROLE_CANDIDATE,
        requires=frozenset({NEEDS_AUTHORED_CUES}),
        build=lambda **_: CaptionsSource(),
    ),
    SourceSpec(
        id="asr:vocals",
        role=ROLE_BASELINE,
        baseline_rank=BASELINE_ASR_VOCALS,
        requires=frozenset({NEEDS_VOCALS_STEM}),
        build=lambda transcriber, normalize, **_: AsrSource(
            transcriber, normalize, audio=AsrSource.AUDIO_VOCALS
        ),
    ),
    SourceSpec(
        id="asr:mix",
        role=ROLE_BASELINE,
        baseline_rank=BASELINE_ASR_MIX,
        requires=frozenset({NEEDS_AUDIO}),
        build=lambda transcriber, normalize, **_: AsrSource(
            transcriber, normalize, audio=AsrSource.AUDIO_MIX
        ),
    ),
    SourceSpec(
        id="captions:machine",
        role=ROLE_BASELINE,
        baseline_rank=BASELINE_CAPTIONS_AUTO,
        requires=frozenset({NEEDS_MACHINE_CUES}),
        build=lambda **_: AutoCaptionsSource(),
    ),
)


@dataclass(frozen=True)
class _Classified:
    """One built source, wearing the tier its spec assigns it.

    A source answers only "what text can I get"; the registry answers "and what is that text's
    standing" (`SourceSpec.role`/`baseline_rank`), so there is exactly one place a text's tier is
    decided rather than two that could drift. The stamp covers the fetched text AND its alternates:
    an alternate is another version of the same song that `select_by_baselines` grades alongside the
    parent and may publish, so it must wear the same tier or a winning alternate would publish at the
    fail-closed ROLE_UNSPECIFIED default.
    """

    inner: LyricsSource
    role: str
    baseline_rank: int | None

    @property
    def name(self) -> str:
        return self.inner.name  # delegate to the wrapped source

    def fetch(self, req: LyricsRequest) -> Any:
        got = self.inner.fetch(req)
        if got is None:
            return None
        got.role = self.role
        got.baseline_rank = self.baseline_rank
        # Alternates are OTHER versions of the same song that select_by_baselines grades alongside
        # the parent and MAY PUBLISH, so they must carry the same tier — in-place mutation is safe
        # here since `got` and its alternates were just built and are held by nobody else yet.
        for alt in got.alternates:
            alt.role = self.role
            alt.baseline_rank = self.baseline_rank
        return got


def build_sources(
    req: LyricsRequest,
    *,
    client: Any = None,
    to_segments: Any = None,
    transcriber: Any = None,
    normalize: Any = None,
) -> tuple[list[LyricsSource], list[str]]:
    """The sources that CAN run for this request, plus a line per source that cannot.

    Returns (sources, notes). The notes are the whole point: a source excluded because its requirement was
    not met says which one, so a dead provider is distinguishable from a song with no lyrics.
    """
    sources: list[LyricsSource] = []
    notes: list[str] = []
    for spec in SPECS:
        missing = unmet(spec.requires, req)
        if missing:
            notes.append(f"{spec.id}: did not run — no {', '.join(missing)}")
            continue
        sources.append(
            _Classified(
                inner=spec.build(
                    client=client, to_segments=to_segments, transcriber=transcriber, normalize=normalize
                ),
                role=spec.role,
                baseline_rank=spec.baseline_rank,
            )
        )
    return sources, notes
