"""The separator REGISTRY: every model this worker can run, declared as data.

ADDING A MODEL IS A ROW; adding a RUNTIME is an adapter. Four things vary orthogonally and a row names each,
stem semantics among them — MEASURED, never inferred (XW-01). Every `rt_factor` and purity figure here has a
matching measured row in docs/benchmarks/stem-separation/README.md (XW-02); the four fields, the two refusals
that look like gaps and the cost of a process boundary are docs/arch/05-worker.md §2.1.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class Architecture(StrEnum):
    """The network, independent of what executes it."""

    DEMUCS = "demucs"
    #: BS-RoFormer / Mel-Band RoFormer as `audio-separator` classifies them (`.ckpt` + `.yaml`).
    MDXC = "mdxc"
    #: Mel-Band RoFormer under `mlx-audio`, which is the same architecture in a different runtime.
    MELBAND = "melband"
    MDX = "mdx"
    VR = "vr"


class Runtime(StrEnum):
    """What executes the architecture, and therefore which process it runs in.

    A process boundary is a dependency FACT and a COST, so prefer in-process: docs/arch/05-worker.md §2.1.
    """

    #: In-process torch, sharing this worker's pinned stack.
    TORCH = "torch"
    #: In-process MLX. Apple Silicon only, and the fastest path there; being in-process was EARNED rather
    #: than chosen (docs/arch/05-worker.md §2.1).
    MLX = "mlx"
    #: A separate virtualenv, invoked as a subprocess. Where a dependency conflicts with this worker's pins.
    SUBPROCESS = "subprocess"


@dataclass(frozen=True, slots=True)
class Stems:
    """Which of an engine's outputs is which; `derived_instrumental` removes a whole class of bug
    (docs/arch/05-worker.md §2.1)."""

    #: Filename suffix of the instrumental, before the extension. Empty when it is derived by subtraction.
    instrumental_suffix: str = ""
    #: Filename suffix of the vocals stem. Empty when the engine emits no separate vocals.
    vocals_suffix: str = ""
    #: True when the instrumental is computed as `mixture - vocals` rather than read from a file.
    derived_instrumental: bool = False
    #: False until a real run confirmed which output is which. An unmeasured entry must not be dispatched.
    measured: bool = False


@dataclass(frozen=True, slots=True)
class SeparatorSpec:
    """One runnable model, declared."""

    #: The stable id the core routes on and the operator selects, never a checkpoint filename.
    token: str
    label: str
    architecture: Architecture
    runtime: Runtime
    #: The capability a worker must PROVE to be given this model. Binary and checkable.
    capability: str
    #: Where the weights come from: an HF repo id, a zoo filename, or a package-managed name.
    weights: str
    stems: Stems
    #: Realtime factor, MEASURED on this project's hardware; None means never timed (docs/arch/05-worker.md
    #: §2.1).
    rt_factor: float | None = None
    #: How `rt_factor` was obtained — `unmeasured` rather than a number nobody measured.
    provenance: str = "unmeasured"
    #: Free-text note for an operator choosing between models.
    note: str = ""

    @property
    def runnable(self) -> bool:
        """Is this safe to dispatch? Requires MEASURED stem semantics, the one hard refusal in this module
        (docs/arch/05-worker.md §2.1)."""
        return self.stems.measured


#: Every model this worker can run today. Deliberately short: a registry's value is that adding a row is
#: cheap, not that it starts large.
SPECS: tuple[SeparatorSpec, ...] = (
    SeparatorSpec(
        token="htdemucs",
        label="HT-Demucs",
        architecture=Architecture.DEMUCS,
        runtime=Runtime.SUBPROCESS,
        capability="stems",
        weights="htdemucs",
        # Demucs writes a directory per model with fixed stem names; the instrumental is summed.
        stems=Stems(instrumental_suffix="no_vocals", vocals_suffix="vocals", measured=True),
        # CPU rather than MPS on purpose: the floor every box can reach, and corrected twice to get here
        # (docs/benchmarks/stem-separation/README.md, "Results — `m1pro`, `tfr-flyaway` (194 s)").
        rt_factor=0.474,
        provenance=(
            "m1pro: cpu 92.12s / mps 28.19s inference for 194.26s audio "
            "(docs/benchmarks/stem-separation: tfr-flyaway)"
        ),
        note=(
            "The incumbent, and the capability every existing worker already advertises. 2.5 dB behind the "
            "roformers on real music (14.93 vs 17.44 dB instrumental SI-SDR) and far cheaper — on MPS it is "
            "the fastest option here at 0.145x, with quality identical to its own CPU path."
        ),
    ),
    SeparatorSpec(
        token="bs-roformer-1297",
        label="BS-RoFormer (instrumental)",
        architecture=Architecture.MDXC,
        runtime=Runtime.SUBPROCESS,
        capability="stems:roformer",
        weights="roformer-model-bs-roformer-instrumental-resurrection-by-unwa",
        # MEASURED INVERTED (XW-01): `_other` is the backing track.
        stems=Stems(instrumental_suffix="_other", vocals_suffix="_instrumental", measured=True),
        # Re-measured on a 194 s song; the 20 s control was pessimistic (stem-separation README).
        rt_factor=2.224,
        provenance=(
            "m1pro cpu: 432.01s inference for 194.26s audio (docs/benchmarks/stem-separation: tfr-flyaway)"
        ),
        note=(
            "STRICTLY DOMINATED ON APPLE SILICON, and measured so rather than assumed: its instrumental "
            "SI-SDR is 17.37 dB against melband-kim-vocal-2's 17.35 — a 0.02 dB difference, i.e. the same "
            "model quality — while costing 4x the time (432s vs 108s). It stays registered because it is the "
            "only roformer available to a box WITHOUT MLX, which is every non-Apple machine. Filenames are "
            "inverted; see the registry docstring."
        ),
    ),
    SeparatorSpec(
        token="melband-kim-vocal-2",
        label="Mel-Band RoFormer (Kim Vocal 2, MLX)",
        architecture=Architecture.MELBAND,
        runtime=Runtime.MLX,
        capability="stems:melband-mlx",
        weights="mlx-community/mel-roformer-kim-vocal-2-mlx",
        # Single-stem: the instrumental is `mixture - vocals`, so the two cannot drift apart.
        stems=Stems(vocals_suffix="vocals", derived_instrumental=True, measured=True),
        # The ONE clip figure that survived a real-song re-measurement (stem-separation README).
        rt_factor=0.555,
        provenance=(
            "m1pro metal: 107.83s inference + 0.32s warm load for 194.26s audio "
            "(docs/benchmarks/stem-separation: tfr-flyaway)"
        ),
        note=(
            "THE QUALITY PICK, and it ties the CPU roformer rather than beating it — 17.35 dB instrumental "
            "SI-SDR against 17.37, at a quarter of the cost. 2.5 dB ahead of htdemucs. Apple Silicon only; "
            "MIT weights. Its `chunk_size` MUST be respected by the caller: handed a whole 194s song in one "
            "call it returns SILENCE, with no error (see the benchmark doc)."
        ),
    ),
    # `melband-zfturbo-vocals-v1` WAS REGISTERED HERE AND HAS BEEN REMOVED: it is a PASSTHROUGH on real
    # music, which only real music could show (docs/benchmarks/stem-separation/README.md, "Findings that came
    # out of running these"). Do not re-add it without a real-music measurement of non-zero extraction.
)


def by_token(token: str) -> SeparatorSpec | None:
    for spec in SPECS:
        if spec.token == token:
            return spec
    return None


def runnable_with(capabilities: frozenset[str]) -> tuple[SeparatorSpec, ...]:
    """Every spec this box can actually serve: capability proven AND stem semantics measured — the
    intersection core needs to decide what to OFFER, and capability-driven rather than hardware-driven
    (docs/arch/05-worker.md §2.1)."""
    return tuple(s for s in SPECS if s.capability in capabilities and s.runnable)


def capabilities_used() -> frozenset[str]:
    """Every capability any registered spec needs — what `host/hardware.py` must be able to prove."""
    return frozenset(s.capability for s in SPECS)
