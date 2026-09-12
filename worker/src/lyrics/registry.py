"""The lyrics source registry: which sources exist, what each needs, and why one sat out.

WHY THIS EXISTS, and it is not tidiness. Every source used to open-code its own precondition as an early
`return None` — no confident metadata, no vocals stem, no caption cues. `acquire()` then swallowed the
miss, which is correct for one song that genuinely has no lyrics and catastrophic as the only signal:
"this song has no lyrics" and "this provider has been dead for a month" became the same observation.

lrclib.net has been failing 100% on the owner's corp box since a DNS sinkhole put it on an RFC1918
address, and nothing said so. It just looked like songs without lyrics. The separator axis already solved
this class of problem — `backends.py` probes and reports, and refuses loudly rather than degrading
silently — and the lyrics chain had no equivalent.

So a source DECLARES what it requires, one place decides whether the requirement is met, and an unmet
requirement is REPORTED by name. A source that declines for its own reasons still can, but a source that
never got the chance says which input was missing.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .chain import (
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

# ── requirements ──────────────────────────────────────────────────────────────────
#
# Named so an unmet one can be reported. Each is a property of the REQUEST, checkable before a source is
# built, which is what makes "did not run, because X was missing" expressible at all.

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


#: The ONE place a requirement name is tied to the property of the request that satisfies it. This used
#: to be rebuilt as a fresh dict inside `unmet` on every call, parallel to the NEEDS_* constants above —
#: two copies of the same five-way mapping that could drift with nothing comparing them. A single
#: (name, predicate) table folds both into one: the constants name the requirements, this pairs each with
#: its check, and `unmet` reads it. `test_every_spec_declares_a_role_...` and the build path are unchanged.
_REQUIREMENT_PREDICATES: tuple[tuple[str, Callable[[LyricsRequest], bool]], ...] = (
    (NEEDS_METADATA, lambda req: bool(req.artist and req.track)),
    (NEEDS_VOCALS_STEM, lambda req: bool(req.vocals_path)),
    (NEEDS_AUDIO, lambda req: bool(req.audio_path)),
    (NEEDS_AUTHORED_CUES, lambda req: bool(req.caption_segments)),
    (NEEDS_MACHINE_CUES, lambda req: bool(req.auto_caption_segments)),
)


def unmet(requirements: frozenset[str], req: LyricsRequest) -> list[str]:
    """Which of these requirements this request does not satisfy.

    Fail-open on a name not in the table (`.get(r, True)`): a requirement nothing knows how to check is
    treated as MET rather than silently excluding a source — the same defensive default the inline dict
    carried."""
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

    This is what makes `SourceSpec.role` and `SourceSpec.baseline_rank` load-bearing rather than
    decorative. The source classes used to stamp their own tier — `AsrSource` even re-derived which
    baseline rank it was from its `audio` argument — so the registry's declaration was a SECOND copy of a
    fact `chain.py` already owned, read by nothing but the registry's own self-consistency tests. Those
    two copies could drift and the suite would not notice: a source quietly returning CANDIDATE would make
    it eligible to be published as the song's words while the registry still called it a baseline.

    Stamping here deletes the second copy instead of synchronizing it. A source now answers only "what
    text can I get", and the registry answers "and what is that text's standing" — which is where the
    classification was always described. The stamp covers the fetched text AND its alternates: an
    alternate is another version of the same song that `select_by_baselines` grades alongside the parent
    and may publish, so it wears the same tier — stamping only the parent left every alternate at the
    fail-closed ROLE_UNSPECIFIED default and let a winning alternate publish as unspecified.
    """

    inner: LyricsSource
    role: str
    baseline_rank: int | None

    @property
    def name(self) -> str:
        # delegate to the wrapped source, matching the read-only `LyricsSource.name` protocol member.
        return self.inner.name

    def fetch(self, req: LyricsRequest) -> Any:
        got = self.inner.fetch(req)
        if got is None:
            return None
        got.role = self.role
        got.baseline_rank = self.baseline_rank
        # The alternates are OTHER versions of this same song (LrclibSource attaches them at
        # sources.py:123, `best.alternates = rest`), and `select_by_baselines` grades the whole
        # pool `[cand, *cand.alternates]` (chain.py) and MAY PUBLISH an alternate. So they carry the
        # same tier as their parent: stamping only `got` left every alternate at the fail-CLOSED
        # ROLE_UNSPECIFIED default, and a winning alternate then published as the song's words while
        # unspecified — the exact fail-open the role default exists to prevent. In-place is
        # correct here specifically: `got` and its alternates were just built by the source inside
        # this call and are held by nobody else, which is why the two lines above already mutate in
        # place. This is NOT the cross-object write an earlier change removed (that was the step layer reaching
        # into a domain dataclass the caller owned).
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
