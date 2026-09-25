"""The model zoo as a browsable catalogue: 169 separators, read from `audio-separator`'s own metadata.

WHAT THIS REPLACES. Three models were hand-registered, each with a hand-verified note about which output
file was the backing track. That is the right shape for three and impossible for a hundred and sixty-nine,
so this module does not describe models — it READS them, from the metadata the library already ships:

    {"filename": "...", "stems": ["instrumental", "vocals"], "target_stem": "instrumental",
     "scores": {"vocals": {"SDR": 8.78, ...}, "instrumental": {"SDR": 15.40, ...}}}

which means a catalogue entry costs nothing to add and cannot drift from what the library can actually run.

THE SCORES ARE UPSTREAM'S, NOT OURS, and that distinction is load-bearing in this repo. `SeparatorSpec`
carries `provenance` precisely because an `htdemucs` cost of 0.29x once sat here labelled "measured" while
having been copied from core's GPU contract. So every figure crossing from this module is labelled
`upstream`, never `measured`: it is a real benchmark run by someone else, on tracks we did not choose, with
a metric (BSS-eval SDR via museval) that is NOT the plain SDR `docs/benchmarks/stem-separation` reports.
Useful for RANKING a hundred unknowns; not comparable to our own numbers, and not evidence about this
hardware.

WHAT IS FILTERED OUT, and why it is not merely tidiness. The zoo is not 169 vocal separators — it also
contains de-reverb, de-noise, de-echo, drum separation, crowd removal and lead-versus-backing karaoke
models. A de-reverb model emits `["noreverb", "reverb"]`; asking it for a karaoke master gets you a
slightly drier copy of the whole song, published as an instrumental, with nothing downstream able to
notice. So an entry is offered only if its declared stems contain a vocals side and a non-vocals side that
`roles` can then verify from the audio.
"""

from __future__ import annotations

import functools
from dataclasses import dataclass

#: Declared stem names that mean "the voice". Matched case-insensitively against the metadata.
_VOCAL_NAMES = frozenset({"vocals", "vocal", "voice", "lead_vocals", "lead vocals"})

#: Declared stem names that mean "everything else" — the thing that plays in the room.
_BACKING_NAMES = frozenset({"instrumental", "instrument", "no_vocals", "accompaniment", "other", "music"})

#: The four-source demucs decomposition. Not a 2-stem model, but the instrumental is the sum of the three
#: non-vocal sources, which `separate.instrumental_sources` already knows how to do.
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

    THREE CASES, and the middle one is why `domain/audio/roles` exists.

    `declared`  the metadata names a vocals side and a backing side. Still verified from the audio before
                publication — bs-roformer-infer's filenames are inverted, so a declaration is a hint.
    `unknown`   the metadata declares NO stems at all, which is true of 62 of the 169 entries, including
                real vocal separators like `UVR-BVE-4B_SN-44100-2`. These used to be dropped. They are
                offered instead, because runtime role detection does not need the declaration — that is
                the entire point of measuring. If the measurement cannot decide, the job is refused.
    None        the metadata declares stems that are not a vocals/backing pair, so no amount of running it
                yields a karaoke master. De-reverb (`["noreverb","reverb"]`), de-echo, de-noise, drum
                separation, bass/woodwind isolation, and the four-source demucs decomposition.

    FOUR-STEM DEMUCS IS EXCLUDED DELIBERATELY. Its instrumental has to be summed from three sources, which
    `separate.py` already does for the native demucs path — and `htdemucs_ft`/`htdemucs_6s` are reachable
    there. Two routes to one set of weights is a way for two answers to disagree, not a feature.
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
    """`scores[stem]["SDR"]`, defensively — upstream metadata is not schema-checked and a missing score is
    normal rather than an error."""
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
    """Every usable model the installed `audio-separator` can run, or `()` when the extra is absent.

    CACHED because `list_supported_model_files` constructs a `Separator`, which probes torch, ONNX runtime
    and the accelerator, and on a cold cache downloads the catalogue JSON. Called once per process.

    Returns `()` rather than raising when the extra is missing: `host.capabilities` decides whether to
    advertise the zoo, and an import error here would turn a capability question into a crashed startup.
    """
    try:
        from audio_separator.separator import Separator  # noqa: PLC0415 - an extra, absent by default
    except ImportError:
        return ()

    try:
        # `output_dir`/`model_file_dir` are required by the constructor but unused for enumeration; the real
        # ones are supplied per job by the adapter.
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
