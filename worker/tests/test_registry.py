"""The separator registry: the invariants that keep "anyone may pick anything" safe.

The registry deliberately does NOT gate on memory — a ceiling moves with segment size and precision, so a
gate would refuse configurations that work. What makes that safe is two things, both asserted here: an entry
may only be dispatched once its stem semantics are MEASURED, and an out-of-memory failure is non-retryable
with a legible message (see `test_cli_adapters`).
"""

from __future__ import annotations

import ast
import inspect
import textwrap

import pytest

from encore_worker.adapters import registry as reg
from encore_worker.adapters.registry import Architecture, Runtime, SeparatorSpec, Stems


def test_every_token_is_unique() -> None:
    """The token is what the core routes on and what a historical `job_attempts.model` row holds. A duplicate
    would make `by_token` return whichever came first, silently separating with the wrong model."""
    tokens = [s.token for s in reg.SPECS]
    assert len(tokens) == len(set(tokens))


def test_every_spec_declares_a_capability() -> None:
    """Capability is THE gate, because it is binary and provable. An entry without one could be offered to a
    box that cannot run it."""
    for s in reg.SPECS:
        assert s.capability, f"{s.token} declares no capability"


def test_no_spec_declares_a_memory_requirement() -> None:
    """Deliberate: a memory ceiling is a continuum, not a yes/no, and it moves with segment size, overlap and
    precision. The repo's own Intel note says a 4 GB card needs "a reduced segment size" rather than a
    different model — so a gate would refuse a configuration that works.

    Asserted as a test because "add a min_vram field" is the obvious-looking improvement, and the reason not
    to is a decision rather than an oversight.
    """
    assert not any(hasattr(s, "min_vram") or hasattr(s, "min_memory_bytes") for s in reg.SPECS)


# ── the one hard refusal ─────────────────────────────────────────────────────────────────────────


def test_an_unmeasured_spec_is_not_runnable() -> None:
    """THE safety property. Which file is the backing track is not a matter of preference: publishing the
    vocals as the karaoke master is silent — the silence probe passes it, because the vocals stem is loud.

    So memory, speed and quality are the operator's call, and stem semantics are not.
    """
    unmeasured = SeparatorSpec(
        token="x",
        label="X",
        architecture=Architecture.MDXC,
        runtime=Runtime.SUBPROCESS,
        capability="stems:x",
        weights="w",
        stems=Stems(measured=False),
    )
    assert unmeasured.runnable is False


def test_a_measured_spec_is_runnable() -> None:
    measured = SeparatorSpec(
        token="x",
        label="X",
        architecture=Architecture.MDXC,
        runtime=Runtime.SUBPROCESS,
        capability="stems:x",
        weights="w",
        stems=Stems(instrumental_suffix="_a", vocals_suffix="_b", measured=True),
    )
    assert measured.runnable is True


def test_the_passthrough_model_is_not_registered() -> None:
    """`melband-zfturbo-vocals-v1` was registered and has been REMOVED: on a 30s commercial excerpt its vocals
    stem came back at peak 0.000122 / rms 0.000022 — silence to within one 16-bit LSB — and its instrumental
    differed from the input mixture by 0.00009. It does not separate at all.

    Asserted so it cannot drift back in on the strength of "the geometry matches and it runs fast", which is
    exactly how it got in the first time.
    """
    assert reg.by_token("melband-zfturbo-vocals-v1") is None
    assert not any("zfturbo" in s.token for s in reg.SPECS)


def test_the_registry_records_why_the_passthrough_was_removed() -> None:
    """The reason has to be reachable from the registry, not left in a commit message. Anyone evaluating MLX
    checkpoints will find this model again — it is fast, MIT, and its preset geometry verifies — and needs to
    know that none of those facts predicted whether it works.

    W7c moved the MEASUREMENT into the benchmark document the comment cites, so both halves are checked: the
    registry still says PASSTHROUGH and still names the document, and that document still carries the rms
    figure. Asserting only the code would let a pointer survive the number it points at.
    """
    import pathlib

    body = pathlib.Path(reg.__file__).read_text()
    assert "PASSTHROUGH" in body
    cited = "docs/benchmarks/stem-separation/README.md"
    assert cited in body, "the registry must point at where the measurement lives"
    measured = (pathlib.Path(__file__).resolve().parents[2] / cited).read_text()
    assert "0.000022" in measured, "the measurement, not just the conclusion"


# ── the capability intersection the core offers from ─────────────────────────────────────────────


def test_runnable_with_returns_only_proven_capabilities() -> None:
    """The intersection is capability-driven. Both MLX checkpoints share one capability, so proving it offers
    both — quality differences travel in the notes rather than gating availability."""
    got = reg.runnable_with(frozenset({"stems", "stems:melband-mlx"}))
    tokens = {s.token for s in got}
    assert "htdemucs" in tokens
    assert "melband-kim-vocal-2" in tokens
    assert "bs-roformer-1297" not in tokens, "its capability was not proven"


def test_an_unmeasured_entry_would_be_withheld_even_with_its_capability_proven() -> None:
    """The refusal still exists — there simply is no unmeasured entry left in the registry. Asserted against a
    constructed spec so the mechanism stays covered as rows come and go."""
    unmeasured = SeparatorSpec(
        token="future-model",
        label="Future",
        architecture=Architecture.MELBAND,
        runtime=Runtime.MLX,
        capability="stems:melband-mlx",
        weights="w",
        stems=Stems(measured=False),
    )
    assert unmeasured.runnable is False


def test_a_box_with_no_capabilities_is_offered_nothing() -> None:
    assert reg.runnable_with(frozenset()) == ()


def test_capability_is_the_gate_not_the_hardware() -> None:
    """An Apple Silicon box WITHOUT `mlx-audio` installed proves no `stems:melband-mlx`, so it must be offered
    none of those models. A hardware selector could not express that — which is why the gate is the proven
    capability rather than the accelerator vendor."""
    apple_without_mlx = frozenset({"stems"})
    tokens = {s.token for s in reg.runnable_with(apple_without_mlx)}
    assert not any(t.startswith("melband") for t in tokens)


def _tokens_the_probe_can_emit() -> set[str]:
    """Every capability string `hardware.capabilities` is able to add, read off its own source.

    Read rather than restated here: a hand-kept copy would go stale, and a list the probe no longer agrees
    with is exactly the typo this is looking for.
    """
    from encore_worker.host import hardware

    tree = ast.parse(textwrap.dedent(inspect.getsource(hardware.capabilities)))
    return {
        argument.value
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "add"
        for argument in node.args
        if isinstance(argument, ast.Constant) and isinstance(argument.value, str)
    }


def test_every_capability_used_is_one_the_host_probe_can_prove() -> None:
    """A spec needing a capability nothing ever advertises is unreachable: it would sit in the registry
    looking available and never be dispatched to anything.

    A capability the probe CAN emit but THIS box cannot prove is an absent runtime rather than a registry
    defect, so that half skips (docs/arch/05-worker.md §9.1).
    """
    from encore_worker.host import hardware

    emittable = _tokens_the_probe_can_emit()
    provable: set[str] = set()
    for backend in ("torch", "mlx"):
        provable |= set(hardware.capabilities(backend=backend))
    assert provable <= emittable, (
        f"the probe emitted {sorted(provable - emittable)}, which reading its source did not find: "
        "`_tokens_the_probe_can_emit` no longer sees how capabilities are added and proves nothing."
    )

    # Only the tokens this registry actually needs, and only the stems family — `align`/`fetch` are other
    # actions' concerns.
    needed = {c for c in reg.capabilities_used() if c.startswith("stems")}
    unreachable = sorted(needed - emittable)
    assert not unreachable, (
        f"these capabilities are needed by a spec and NO probe can ever emit them: {unreachable}. That is a "
        "typo, and the spec would be permanently unreachable."
    )
    unprovable = sorted(needed - provable)
    if unprovable:
        pytest.skip(
            f"this box cannot prove {unprovable}, so the specs needing them are correctly withheld here. "
            "Every one of those tokens IS emittable, which is what this test can check anywhere."
        )


# ── measured costs stay honest ────────────────────────────────────────────────────────────────────


def test_a_cost_cites_where_it_was_measured() -> None:
    """A cost must point at the record that produced it, not merely claim the word "measured".

    This test used to check for that word, which is how `htdemucs` carried 0.29x labelled "measured" while
    being copied from core's contract — a GPU figure, where on CPU it is 1.24x. Requiring a citation makes
    that mistake impossible: there is nowhere to write "measured" without naming a machine and a row in the
    benchmark document. The repo learned the softer version already, core's ensemble entry carrying
    `provenance: 'estimated'` because an estimate wearing a measured label is worse than no number."""
    for s in reg.SPECS:
        if s.rt_factor is None:
            assert "unmeasured" in s.provenance, f"{s.token} has no cost and does not say why"
        else:
            assert "docs/benchmarks/stem-separation" in s.provenance, (
                f"{s.token} states a cost of {s.rt_factor} without citing where it was measured. "
                "Record the run in docs/benchmarks/stem-separation/README.md and reference it here."
            )
            assert any(c.isdigit() for c in s.provenance), (
                f"{s.token}'s provenance cites the doc but carries no actual timing"
            )


def test_the_benchmark_document_exists_and_names_every_measured_model() -> None:
    """The citation has to resolve. A provenance string pointing at a document that does not mention the model
    is a dead reference, which is the same failure as no citation at all — it just takes longer to discover.
    """
    import pathlib

    doc = pathlib.Path(__file__).parent.parent.parent / "docs/benchmarks/stem-separation/README.md"
    assert doc.is_file(), f"the cited benchmark document is missing: {doc}"
    body = doc.read_text()
    for s in reg.SPECS:
        if s.rt_factor is None:
            continue
        # Matched on the weights/model name rather than the token, since the doc is organised by model.
        needle = s.weights.rsplit("/", 1)[-1].split("-mlx")[0]
        assert needle in body or s.token in body, (
            f"{s.token} claims a measured cost but appears nowhere in {doc.name}"
        )


@pytest.mark.parametrize("token", ["htdemucs", "bs-roformer-1297", "melband-kim-vocal-2"])
def test_the_runnable_specs_carry_a_measured_cost(token: str) -> None:
    """Anything dispatchable should be comparable: an operator choosing between models needs a real number,
    and these three were each timed on a real clip."""
    spec = reg.by_token(token)
    assert spec is not None and spec.rt_factor is not None


def test_the_mlx_runtime_beats_the_cpu_roformer_by_enough_to_justify_itself() -> None:
    """The reason the MLX runtime exists, stated as the comparison that actually supports it.

    This used to assert "the fastest measured model is the MLX one" with an `or token == 'htdemucs'` escape
    hatch, which went green the moment htdemucs was re-measured on a real song (0.474 against MLX's 0.555)
    while asserting nothing. The honest claim is narrower and survives the new numbers: among models that
    reach ROFORMER QUALITY (~17.4 dB instrumental SI-SDR on tfr-flyaway against htdemucs's 14.9) MLX is the
    cheap one — both roformers tie on quality to within 0.02 dB and MLX wins cost by 4x, while htdemucs is
    faster still and 2.5 dB worse, which is a different trade."""
    mlx = [s for s in reg.SPECS if s.runtime is Runtime.MLX and s.rt_factor is not None]
    cpu_roformer = reg.by_token("bs-roformer-1297")
    assert mlx, "no timed MLX entry — the runtime's justification cannot be checked"
    assert cpu_roformer is not None and cpu_roformer.rt_factor is not None

    cheapest_mlx = min(s.rt_factor or 1e9 for s in mlx)
    assert cheapest_mlx * 3 < cpu_roformer.rt_factor, (
        f"MLX costs {cheapest_mlx} against the CPU roformer's {cpu_roformer.rt_factor} for the same measured "
        "quality. Under a 3x margin the sidecar-free MLX runtime stops paying for itself and the choice "
        "needs rereading."
    )


# ── the property that removes a whole bug class ───────────────────────────────────────────────────


def test_a_derived_instrumental_needs_no_suffix() -> None:
    """A single-stem model emits only vocals and the instrumental is `mixture - vocals`. The two are then
    SAMPLE-ALIGNED BY CONSTRUCTION — no second file whose start could differ, no length mismatch for the guide
    mix to refuse, and no filename whose role could be inverted, because this worker names them."""
    spec = reg.by_token("melband-kim-vocal-2")
    assert spec is not None
    assert spec.stems.derived_instrumental is True
    assert spec.stems.instrumental_suffix == "", "a derived instrumental is computed, not found"


def test_the_measured_inversion_is_recorded_rather_than_corrected_silently() -> None:
    """bs-roformer's `_instrumental` file holds the VOCALS — verified with a chords-only control where
    `_other` carried 99.1% of the signal and `_instrumental` carried 2.4%. Recorded as data so a future
    "surely this is backwards" edit has to argue with a measurement."""
    spec = reg.by_token("bs-roformer-1297")
    assert spec is not None
    assert spec.stems.instrumental_suffix == "_other"
    assert spec.stems.vocals_suffix == "_instrumental"


# ── the MLX runtime runs in-process, and it took a dependency upgrade to get there ─────────────────


def test_the_mlx_runtime_shares_this_process() -> None:
    """In-process, and that was EARNED rather than assumed.

    On whisperx 3.8.6 it could not be: that release requires huggingface-hub<1.0.0 while `mlx-audio`
    requires >=1.0, so the two were unsatisfiable together and MLX separation ran in a sidecar virtualenv
    behind a subprocess. whisperx 3.8.7rc1 drops the ceiling, which removed the sidecar, the
    `ENCORE_MLX_AUDIO_PYTHON` knob and its probe. Pinned as a test because reverting the whisperx pin would
    silently make this impossible again — the lock would fail, but only for someone who ran `uv lock`."""
    for spec in reg.SPECS:
        if spec.architecture is Architecture.MELBAND:
            assert spec.runtime is Runtime.MLX


def test_alignment_and_mlx_separation_can_coexist() -> None:
    """THE property the upgrade bought. A box must be able to do both: this project's Mac aligns lyrics with
    whisperx AND separates with MLX, and the pre-upgrade alternative (declaring them conflicting extras) would
    have forced it to choose.

    Skipped rather than faked when the `mlx` extra is absent — most boxes are not Apple Silicon, and a test
    that quietly asserts nothing is worse than one that says why it did not run.
    """
    import importlib.util

    if importlib.util.find_spec("mlx_audio") is None:
        pytest.skip("the `mlx` extra is not installed here, so there is no coexistence to observe")
    assert importlib.util.find_spec("whisperx") is not None, (
        "mlx-audio is importable but whisperx is not — the huggingface-hub conflict has returned"
    )


def test_the_melband_capability_needs_the_runtime_not_the_hardware() -> None:
    """The gate is `mlx-audio` being installed, never the accelerator being Apple Silicon. A Mac WITHOUT the
    `mlx` extra must advertise none of these models, because it cannot run them."""
    import importlib.util

    from encore_worker.host import hardware

    proven = "stems:melband-mlx" in hardware.capabilities(backend="mlx")
    installed = importlib.util.find_spec("mlx_audio") is not None
    assert proven is installed, "the capability must track the runtime's presence exactly"
