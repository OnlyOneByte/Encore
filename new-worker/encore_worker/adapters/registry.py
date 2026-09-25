"""The separator REGISTRY: every model this worker can run, declared as data.

WHY A REGISTRY AND NOT AN "ANY HUGGING FACE MODEL" ADAPTER. Hugging Face is a file HOST, not a runtime, so
"load any HF model" has nothing to dispatch on. Three real examples from one search of the hub:

  * `htdemucs-ft-vocals-mlx` — same `audio-to-audio` tag, MIT, but no `config.json` and a differently named
    safetensors. A completely different loader.
  * `mel-roformer-mlx` — 28,895 downloads, geometry matching `kim_vocal_2`, but NO `checkpoint_family` field.
    Nothing in the file says which architecture preset to load it with; guess wrong and the weights either
    fail to map or produce noise.
  * `sam-audio-*`, `Cocktail-Fork-MRX` — also `audio-to-audio`, but promptable segmentation and
    speech/music/SFX splitting. Not vocal separation at all.

So the four things that actually vary are orthogonal, and a registry entry names each one:

  ARCHITECTURE  what network            (mdx | vr | demucs | mdxc | melband)
  RUNTIME       what executes it        (torch | onnx | mlx) — and in WHICH process
  WEIGHTS       where the bytes live    (a package's own zoo | an HF repo | a URL)
  STEMS         which output is which   — MEASURED, never inferred

The same architecture appears in several runtimes and the same weights get converted between them: Mel-Band
RoFormer is 97 MDXC entries in `audio-separator` AND the MLX conversion this worker runs. HF is one value of
one field, not a special case.

ADDING A MODEL IS A ROW. Adding a RUNTIME is an adapter. That is the whole point of the split.

WHY `stems` IS DATA AND NOT INFERRED. Measured, because assuming it published the wrong file: bs-roformer's
`<name>_instrumental.wav` holds the VOCALS and `<name>_other.wav` holds the backing track — verified with a
chords-only control where `_other` carried 99.1% of the signal and `_instrumental` carried 2.4%. Had the old
filename pattern matched, the worker would have published vocals as the karaoke master, and the silence probe
would have waved it through because the vocals stem is loud. An unmeasured entry therefore declares nothing
and discovery refuses, rather than guessing.

EVERY `rt_factor` AND PURITY FIGURE HERE IS RECORDED IN docs/benchmarks/stem-separation/README.md, with the
machine, the exact input, and the command that produced it. A number in this file without a matching row
there is a number nobody measured — which already happened once: `htdemucs` carried 0.29x labelled
"measured", copied from core's contract, which is a GPU figure. On CPU it is 1.24x.

WHY THERE IS NO MINIMUM-MEMORY GATE. A memory ceiling is a continuum, not a yes/no: it moves with segment
size, overlap and precision, so a gate would refuse configurations that in fact work — the repo's own Intel
note says a 4 GB card needs "a reduced segment size" rather than a different model. Anyone may pick anything;
what makes that safe is that an out-of-memory failure is classified NON-RETRYABLE with a message naming the
remedy (`adapters/cli.OutOfMemory`), so a bad choice costs one legible failure instead of three silent ones.

CAPABILITY IS THE GATE, because it is binary and PROVABLE: either the runtime is installed on this box or it
is not. `host/hardware.py` proves it and the core routes on it. Hardware vendor is deliberately not the gate —
an Apple Silicon box without `mlx-audio` cannot run an MLX model, so "select Apple" would offer work the box
must reject.
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

    SOMETIMES THE BOUNDARY MUST BE A PROCESS, and when it must, that is a dependency fact rather than a
    style choice. `audio-separator` pulls torch>=2.13 on Apple Silicon while this worker pins torch==2.8.0 for
    whisperX/demucs/pyannote; those cannot share an environment, so it gets its own and is shelled out to. It
    is also already the house style for engines that ship a CLI — `demucs-mlx` and `bs-roformer-infer` both.

    But a process boundary is a COST, not a virtue: an extra venv to provision, a serialisation boundary, and
    a capability probe that has to run an interpreter rather than ask an import. `mlx-audio` needed one until
    the whisperx 3.8.7rc1 pin removed the conflict — so prefer in-process, and reach for this only when a
    version bound genuinely forbids it.
    """

    #: In-process torch, sharing this worker's pinned stack.
    TORCH = "torch"
    #: In-process MLX. Apple Silicon only, and the fastest path there — measured 0.55x realtime against
    #: roughly 3x for CPU torch on the same clip.
    #:
    #: IN-PROCESS WAS EARNED. On whisperx 3.8.6 it could not be: that release requires huggingface-hub<1.0.0
    #: while `mlx-audio` requires >=1.0, so the two were unsatisfiable and this ran in a sidecar virtualenv
    #: behind a subprocess. Pinning whisperx 3.8.7rc1 dropped the ceiling and the sidecar went with it —
    #: verified by the 10 `-m ml` tests passing on the rc, including the two major bumps it pulls in.
    MLX = "mlx"
    #: A separate virtualenv, invoked as a subprocess. Where a dependency conflicts with this worker's pins.
    SUBPROCESS = "subprocess"


@dataclass(frozen=True, slots=True)
class Stems:
    """Which of an engine's outputs is which.

    `derived_instrumental` is the case that removes a whole class of bug: a single-stem model emits only
    vocals and the instrumental is `mixture - vocals`, so the two are SAMPLE-ALIGNED BY CONSTRUCTION. There
    is no second file whose start could differ, no length mismatch for the guide mix to refuse, and no
    filename whose role could be inverted — because this worker names them.
    """

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

    #: The stable id the core routes on and the operator selects. Never the checkpoint filename, which
    #: changes when a model is re-released.
    token: str
    label: str
    architecture: Architecture
    runtime: Runtime
    #: The capability a worker must PROVE to be given this model. Binary and checkable.
    capability: str
    #: Where the weights come from: an HF repo id, a zoo filename, or a package-managed name.
    weights: str
    stems: Stems
    #: Realtime factor, MEASURED on this project's hardware. None means never timed — and `provenance` says
    #: so, rather than a number that reads as authoritative.
    rt_factor: float | None = None
    #: How `rt_factor` was obtained. The repo already learned that an `estimated` cost presented like a
    #: measured one is worse than no number.
    provenance: str = "unmeasured"
    #: Free-text note for an operator choosing between models.
    note: str = ""

    @property
    def runnable(self) -> bool:
        """Is this safe to dispatch? Requires MEASURED stem semantics.

        The one hard refusal in this module. Everything else — memory, speed, quality — is the operator's
        call; which file is the backing track is not a matter of preference.
        """
        return self.stems.measured


#: Every model this worker can run today. Deliberately short: a registry's value is that adding a row is
#: cheap, not that it starts large. Entries whose stems are unmeasured are listed so they are visible and
#: refused, rather than absent and forgotten.
SPECS: tuple[SeparatorSpec, ...] = (
    SeparatorSpec(
        token="htdemucs",
        label="HT-Demucs",
        architecture=Architecture.DEMUCS,
        runtime=Runtime.SUBPROCESS,
        capability="stems",
        weights="htdemucs",
        # Demucs writes a directory per model with fixed stem names; the instrumental is summed from the
        # non-vocal sources rather than read from one file.
        stems=Stems(instrumental_suffix="no_vocals", vocals_suffix="vocals", measured=True),
        # CORRECTED TWICE, and the second correction matters as much as the first.
        #   0.29   copied from core's contract and labelled "measured" — it was not; core's is a GPU figure.
        #   1.24   really measured, but on a 6.94s CLIP, where fixed per-call overhead dominates.
        #   0.474  measured on a 194s SONG, which is what production actually separates.
        # The clip figure was 2.6x pessimistic. Short-input timings are not a conservative estimate of long-
        # input cost; they are a different measurement.
        #
        # CPU rather than MPS on purpose: this is the floor every box can reach. MPS is 0.145 — 3.3x faster
        # for BIT-IDENTICAL quality (14.93 dB both) — but a CUDA or CPU-only box cannot have it, and one
        # number in this field has to be the one nobody is surprised by.
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
        # MEASURED INVERTED — see the module docstring. `_other` is the backing track.
        stems=Stems(instrumental_suffix="_other", vocals_suffix="_instrumental", measured=True),
        # 3.93 came from the 20s control, which was still short enough for per-call overhead to inflate it.
        # On a 194s song the real rate is 2.224 — so the control was 1.8x pessimistic.
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
        # THE ONE CLIP FIGURE THAT SURVIVED a real-song re-measurement: 0.55 -> 0.555. Metal's per-call
        # overhead is small enough that a 7s clip and a 194s song give the same rate, which is exactly why
        # the other two entries moved and this one did not.
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
    # `melband-zfturbo-vocals-v1` WAS REGISTERED HERE AND HAS BEEN REMOVED. It is a PASSTHROUGH on real
    # music: measured on a 30s commercial excerpt its vocals stem came back at peak 0.000122 / rms 0.000022 —
    # silence to within one 16-bit LSB — and its instrumental differed from the input mixture by 0.00009.
    # It does not separate at all.
    #
    # It looked fine for hours because the synthetic benchmark could not tell it apart from a working model:
    # on a chords-only control it returned zero vocals, which scored as "correctly found no vocals" when a
    # passthrough returns zero there too. Only real music distinguished the two. The lesson is recorded in
    # docs/benchmarks/stem-separation: a control that a broken implementation also passes proves nothing.
    #
    # Do not re-add it without a real-music measurement showing non-zero extraction.
)


def by_token(token: str) -> SeparatorSpec | None:
    for spec in SPECS:
        if spec.token == token:
            return spec
    return None


def runnable_with(capabilities: frozenset[str]) -> tuple[SeparatorSpec, ...]:
    """Every spec this box can actually serve: capability proven AND stem semantics measured.

    The intersection the core needs to decide what to OFFER. Note it is capability-driven, not
    hardware-driven: an Apple Silicon box without `mlx-audio` installed proves no `stems:melband-mlx` and is
    correctly given none of those models.
    """
    return tuple(s for s in SPECS if s.capability in capabilities and s.runnable)


def capabilities_used() -> frozenset[str]:
    """Every capability any registered spec needs — what `host/hardware.py` must be able to prove."""
    return frozenset(s.capability for s in SPECS)
