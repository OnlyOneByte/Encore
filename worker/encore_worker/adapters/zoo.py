"""The model zoo as a browsable catalogue: 169 separators, READ from `audio-separator`'s own metadata rather
than described here, so an entry cannot drift from what the library can run.

THE SCORES ARE UPSTREAM'S, NOT OURS, so every figure crossing from here is labelled `upstream` and never
`measured`. Why most entries are filtered out, and the three role cases: `docs/arch/05-worker.md` §2.3.
"""

from __future__ import annotations

import functools
from dataclasses import dataclass
from typing import Any

#: Declared stem names that mean "the voice". Matched case-insensitively against the metadata.
_VOCAL_NAMES = frozenset({"vocals", "vocal", "voice", "lead_vocals", "lead vocals"})

#: Declared stem names that mean "everything else" — the thing that plays in the room.
_BACKING_NAMES = frozenset({"instrumental", "instrument", "no_vocals", "accompaniment", "other", "music"})

#: The four-source demucs decomposition, reachable through the native demucs adapter instead
#: (docs/arch/05-worker.md §2.3).
_FOUR_STEM = frozenset({"vocals", "drums", "bass", "other"})


@dataclass(frozen=True, slots=True)
class ZooModel:
    """One separator the zoo can run, as this worker needs to describe it."""

    #: The library's own key, e.g. `"MDX-Net Model: UVR-MDX-NET Inst HQ 1"`. What gets passed back to it.
    name: str
    #: Our stable token: a slug of `name`, which is what core stores in `job_attempts.model`.
    token: str
    #: `VR` / `MDX` / `MDXC` / `Demucs`.
    architecture: str
    filename: str
    stems: tuple[str, ...]
    #: `"declared"` when the metadata names a vocals/backing pair, `"unknown"` when it names nothing. Either
    #: way the roles are verified from the audio — this only says whether there was a hint to start from.
    role_source: str
    #: Upstream instrumental SDR where published, else None. NEVER presented as our own measurement.
    upstream_instrumental_sdr: float | None
    upstream_vocals_sdr: float | None

    @property
    def provenance(self) -> str:
        if self.upstream_instrumental_sdr is None:
            return "upstream catalogue entry, no published score"
        return (
            f"upstream (audio-separator models-scores.json): instrumental SDR "
            f"{self.upstream_instrumental_sdr:.2f} dB, museval — NOT comparable to "
            f"docs/benchmarks/stem-separation figures"
        )


def slugify(name: str) -> str:
    """The library's display name to a stable token.

    Deterministic and lossy on purpose: the token is what lands in `job_attempts.model` forever, so it must
    not contain spaces or colons, and it must not change when upstream edits a label's punctuation.
    """
    out = []
    for ch in name.lower():
        if ch.isalnum():
            out.append(ch)
        elif out and out[-1] != "-":
            out.append("-")
    return "".join(out).strip("-")


def _role_source(stems: tuple[str, ...]) -> str | None:
    """How this model's stem roles are known: `"declared"`, `"unknown"`, or None meaning "not a separator".

    Three cases, and the middle one is why `domain/audio/roles` exists: docs/arch/05-worker.md §2.3.
    """
    lowered = {s.lower() for s in stems}
    if not lowered:
        return "unknown"
    if _FOUR_STEM.issubset(lowered):
        return None
    if lowered & _VOCAL_NAMES and lowered & _BACKING_NAMES:
        return "declared"
    return None


def _score(entry: object, stem: str) -> float | None:
    """`scores[stem]["SDR"]`, defensively: upstream metadata is not schema-checked."""
    if not isinstance(entry, dict):
        return None
    scores = entry.get("scores")
    if not isinstance(scores, dict):
        return None
    for key, value in scores.items():
        if key.lower() == stem and isinstance(value, dict):
            sdr = value.get("SDR")
            if isinstance(sdr, (int, float)):
                return float(sdr)
    return None


@functools.cache
def catalogue() -> tuple[ZooModel, ...]:
    """Every usable model the installed `audio-separator` can run, or `()` when it cannot be listed.

    CACHED because `list_supported_model_files` constructs a `Separator`, which probes torch, ONNX runtime
    and the accelerator, and on a cold cache downloads the catalogue JSON. Called once per process.

    `()` rather than raising, for an absent extra and an unreadable listing alike: `host.capabilities`
    decides whether to advertise the zoo, and a crash here would turn that question into a failed startup.
    """
    try:
        from audio_separator.separator import Separator  # noqa: PLC0415 - an extra, absent by default
    except ImportError:
        return ()

    try:
        # Enumeration FETCHES the upstream listing and caches it in the default `model_file_dir` (`/tmp`,
        # which macOS wipes), so a cold box needs the network for it. Per-job directories come from the
        # adapter; `tests/zoo_fixture.py` is how the tests tell "unreadable" from "wrong".
        listed = Separator(log_level=50).list_supported_model_files()
    except Exception:  # noqa: BLE001 - a broken install must degrade to "no zoo", not to a crash
        return ()

    found: list[ZooModel] = []
    seen: set[str] = set()
    for architecture, entries in listed.items():
        if not isinstance(entries, dict):
            continue
        for name, entry in entries.items():
            stems = tuple(entry.get("stems") or ()) if isinstance(entry, dict) else ()
            role_source = _role_source(stems)
            if role_source is None:
                continue
            token = slugify(name)
            if token in seen:  # two labels slugging to one token: keep the first, deterministically
                continue
            seen.add(token)
            found.append(
                ZooModel(
                    name=name,
                    token=token,
                    architecture=str(architecture),
                    filename=str(entry.get("filename", "")) if isinstance(entry, dict) else "",
                    stems=stems,
                    role_source=role_source,
                    upstream_instrumental_sdr=_score(entry, "instrumental"),
                    upstream_vocals_sdr=_score(entry, "vocals"),
                )
            )
    # Best published instrumental first, unscored last. The order IS the recommendation — an operator
    # browsing 100+ models needs the list to mean something before they have measured any of them.
    found.sort(key=lambda m: (-(m.upstream_instrumental_sdr or -1e9), m.token))
    return tuple(found)


def by_token(token: str) -> ZooModel | None:
    for model in catalogue():
        if model.token == token:
            return model
    return None


#: Prefix for the per-model capability token, which makes model-aware routing free
#: (docs/arch/05-worker.md §2.3; `core/src/lib/server/jobs/dispatch.ts:requiredCapability`).
MODEL_CAPABILITY_PREFIX = "stems:model:"


def capability_for(token: str) -> str:
    return f"{MODEL_CAPABILITY_PREFIX}{token}"


def announcement() -> tuple[frozenset[str], tuple[Any, ...]]:
    """`(extra capability tokens, offers)` for the `worker:catalogue` frame. Satisfies `client.Catalogue`.

    Lives here rather than in the transport because WHICH models exist is this module's question; the client
    only knows when to ask it. A FOLLOW-UP FRAME and not `host.capabilities`, which runs before registration
    where reading the catalogue is slow (docs/arch/05-worker.md §2.3). Returns empty tuples on a box without
    the extra, which the client reads as "nothing to announce" and skips the frame entirely.
    """
    from encore_worker.protocol.frames import SeparatorOffer  # noqa: PLC0415 - avoids an import cycle

    models = catalogue()
    offers = tuple(
        SeparatorOffer(
            token=m.token,
            label=m.name,
            architecture=m.architecture,
            upstream_instrumental_sdr=m.upstream_instrumental_sdr,
            upstream_vocals_sdr=m.upstream_vocals_sdr,
            role_source=m.role_source,
        )
        for m in models
    )
    return frozenset(capability_for(m.token) for m in models), offers
