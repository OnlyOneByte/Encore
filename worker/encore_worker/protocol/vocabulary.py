"""The shared vocabulary: the string values that appear on the wire and in the core's TypeScript.

These are NOT open for redesign the way the frames are. Each mirrors a union in
`src/lib/contract/`, and the core, the phone's progress bar and the worker all read the same tokens —
changing one is a change to three codebases, so they are declared apart from the frames that carry them.

`StrEnum`, so a member compares equal to its wire string and `json.dumps` needs no encoder hook. The old
worker hand-rolled a `_StrEnum` shim; 3.11+ has it in the stdlib.
"""

from __future__ import annotations

from enum import StrEnum


class Action(StrEnum):
    """What a job asks the worker to do. Mirrors the core's `JobType`."""

    FETCH = "fetch"
    STEMS = "stems"
    STEMS_UPGRADE = "stems-upgrade"
    STEMS_REMAKE = "stems-remake"
    ALIGN = "align"
    ALIGN_REMAKE = "align-remake"

    @property
    def is_separation(self) -> bool:
        """Separation actions run a separator engine and publish stems."""
        return self in (Action.STEMS, Action.STEMS_UPGRADE, Action.STEMS_REMAKE)

    @property
    def is_alignment(self) -> bool:
        """Alignment actions time lyrics: a first `align`, or the host's remake of them."""
        return self in (Action.ALIGN, Action.ALIGN_REMAKE)


#: The two slot lanes, as `Hello.lanes` names them (#1176). Mirrors core's `Lane` in `jobs/registry.ts`.
FETCH_LANE = "fetch"
COMPUTE_LANE = "compute"
#: One download at a time beside the separations: it is network-bound, and a second rarely helps.
FETCH_SLOTS = 1


def lane_of(action: Action) -> str:
    """A download takes the fetch lane; every separation and alignment takes compute."""
    return FETCH_LANE if action is Action.FETCH else COMPUTE_LANE


class Stage(StrEnum):
    """Coarse progress stages, which the core maps onto the phone's status bar.

    Deliberately COARSE and deliberately not the state machine. A state name is for an operator asking
    why a job did what it did (`job:state`); a stage is for a progress bar a singer is watching. Fusing
    them would leak every internal rename onto a phone screen.
    """

    DOWNLOADING = "downloading"
    SEPARATING = "separating"
    ALIGNING = "aligning"


class SyncMode(StrEnum):
    """HOW a song's words get their timestamps: an align job's `syncMode`. Mirrors core's `SyncModeId`
    (`core/src/lib/contract/lyrics/lyrics-engines.ts`, `SYNC_MODES`).

    FORCED times the words on this recording; LINES publishes no word timing and runs none of the word
    ladder, each text publishing its own line timings through the gated LINE_SYNC rung instead
    (docs/arch/04-alignment.md §5.3).
    """

    FORCED = "forced"
    LINES = "lines"


class Capability(StrEnum):
    """What a worker can PROVE it can do, and therefore what the core will route to it.

    A capability is `family` or `family:variant`, and family membership is COMPUTED from the token
    rather than kept in a second list — a hardcoded list is what once let `stems:audiosep` advertise a
    token whose runner was never bound, so a box accepted separation work it could not run.
    """

    FETCH_YTDLP = "fetch:ytdlp"
    #: Plain `stems` is the demucs family; the engine is chosen per job from params, not by the token.
    STEMS = "stems"
    STEMS_ROFORMER = "stems:roformer"
    STEMS_AUDIOSEP = "stems:audiosep"
    ALIGN = "align"

    @property
    def family(self) -> str:
        return self.value.split(":", 1)[0]


def serves(capabilities: frozenset[str], action: Action) -> bool:
    """Does this capability set serve `action`? FAMILY-prefix match, never a literal equality.

    A worker advertising `stems:roformer` serves a `stems` job; one advertising `stems` serves it too.
    Both separation actions map onto the `stems` family, so a new separation action needs no new table.
    """
    family = (
        Action.STEMS.value
        if action.is_separation
        else Action.ALIGN.value
        if action.is_alignment
        else action.value
    )
    return any(c == family or c.startswith(f"{family}:") for c in capabilities)
