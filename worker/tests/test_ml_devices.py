"""The ML adapter's PURE parts, in the fast suite — no models, no torch, no downloads.

WHY THIS IS SEPARATE FROM `test_ml_real.py`. Those tests are marked `ml` and deselected by default, so
leaving the device policy covered only there would mean the suite that runs on every edit could not catch
a regression in the very code written to fix a bug. The policy is a pure function over strings; there is
no reason for it to need a model.

It also pins the property that makes this file possible: `adapters/ml.py` has NO heavy imports at module
level. Every `torch`/`whisperx`/`pyannote` import is inside a function, which is what lets a box with no ML
installed import the module, resolve capabilities, and decline the work rather than crashing at startup.
"""

from __future__ import annotations

import ast
import inspect
import re
import sys
import types
from collections.abc import Callable
from pathlib import Path

import pytest

from encore_worker.adapters.cli import OutOfMemory
from encore_worker.adapters.ml import (
    CTRANSLATE2_DEVICES,
    ModelUnavailable,
    clear_cache,
    transcriber_device,
)
from encore_worker.adapters.ports import InfraFault
from encore_worker.host.config import Config, ConfigError

#: Packages that cost seconds and hundreds of megabytes to import.
HEAVY = frozenset({"torch", "torchaudio", "torchvision", "whisperx", "pyannote", "demucs", "mlx"})


# ── the device policy ────────────────────────────────────────────────────────────────────────────


def test_mps_is_resolved_to_cpu_for_the_transcriber() -> None:
    """THE bug. torch reports MPS available on every Apple Silicon box, so a single globally-resolved
    device hands whisperx's CTranslate2 transcriber `mps` — and it raises `ValueError: unsupported device
    mps`. That raise comes out of the MANDATORY ASR fallback, the one path that must never fail, so it
    would have broken lyrics for every song on every Mac.
    """
    assert transcriber_device("mps") == "cpu"


@pytest.mark.parametrize("device", ["cpu", "cuda"])
def test_a_supported_device_passes_through(device: str) -> None:
    assert transcriber_device(device) == device
    assert device in CTRANSLATE2_DEVICES


@pytest.mark.parametrize("device", ["mps", "xpu", "rocm", "vulkan", "", "MPS", "CUDA"])
def test_anything_ctranslate2_does_not_know_falls_back_to_cpu(device: str) -> None:
    """Fail-safe rather than fail-closed, deliberately: a device the transcriber cannot use should cost
    speed, not the whole ASR tier. Note the case sensitivity — `CUDA` is not `cuda` to CTranslate2, so it
    resolves to cpu rather than being silently normalised into something that might not work.
    """
    assert transcriber_device(device) == "cpu"


def test_the_supported_set_excludes_mps_explicitly() -> None:
    """Pinned as data, so a future edit that adds `mps` to the tuple has to confront this test rather than
    quietly reintroduce the failure."""
    assert "mps" not in CTRANSLATE2_DEVICES
    assert set(CTRANSLATE2_DEVICES) == {"cpu", "cuda"}


def test_the_aligner_is_deliberately_not_restricted_to_those_devices() -> None:
    """The asymmetry that made a per-component policy necessary rather than one global device: the aligner
    is plain torch wav2vec2 and runs on Metal; only the transcriber is CTranslate2. `build_aligner` takes
    the device unchanged, which `test_ml_real` proves works on mps against a real model.
    """
    import inspect

    from encore_worker.adapters import ml

    source = inspect.getsource(ml.build_aligner)
    assert "transcriber_device" not in source, (
        "the aligner must not be narrowed by the transcriber's device policy — it supports mps"
    )


# ── laziness, which is what makes a no-ML box work at all ────────────────────────────────────────


def test_no_heavy_import_happens_at_module_level() -> None:
    """`import torch` costs seconds and several hundred megabytes of resident memory, paid at process start
    on a box that may only ever serve fetch jobs. It is also what lets this whole suite import the module
    with no ML installed — including this file.

    Checked by reading the AST rather than by importing, because an import-based check would itself pay the
    cost it is asserting against.
    """
    tree = ast.parse(Path(__file__).parent.parent.joinpath("encore_worker/adapters/ml.py").read_text())
    offenders: list[str] = []
    for node in tree.body:  # module level only; a nested import is the point of the design
        if isinstance(node, ast.Import):
            offenders += [a.name for a in node.names if a.name.split(".")[0] in HEAVY]
        elif isinstance(node, ast.ImportFrom) and node.module:
            if node.module.split(".")[0] in HEAVY:
                offenders.append(node.module)
    assert not offenders, f"these must be imported lazily inside a function: {offenders}"


def test_the_separator_adapter_is_lazy_too() -> None:
    """Same reasoning: a box serving only align jobs should not pay for demucs at startup."""
    tree = ast.parse(Path(__file__).parent.parent.joinpath("encore_worker/adapters/separate.py").read_text())
    offenders = [
        a.name
        for node in tree.body
        if isinstance(node, ast.Import)
        for a in node.names
        if a.name.split(".")[0] in HEAVY
    ]
    assert not offenders, f"these must be imported lazily: {offenders}"


# ── the cache and the failure type ───────────────────────────────────────────────────────────────


def test_clearing_the_cache_needs_no_models() -> None:
    """An operator reclaiming VRAM should not have to restart the worker, and the call must be safe on a
    box that never loaded anything."""
    clear_cache()
    clear_cache()


def test_a_missing_model_is_not_retryable() -> None:
    """A missing package or an absent checkpoint is not fixed by trying again, and spending three attempts
    proving it delays the fallback that would have worked."""
    assert ModelUnavailable.retryable is False


def test_builders_return_none_rather_than_raising_when_ml_is_absent() -> None:
    """`host.capabilities` already declines to advertise `align` on such a box; a builder that raised would
    turn a capability question into a crash at startup.

    Skipped when ML IS installed, because then there is no absence to observe — and a test that quietly
    asserts nothing is worse than one that says why it did not run.
    """
    from encore_worker.adapters.ml import build_aligner, build_transcriber
    from encore_worker.host.hardware import module_available

    if module_available("whisperx"):
        pytest.skip("whisperx is installed, so the absent-ML path cannot be observed here")
    assert build_transcriber(device="cpu", checkpoint="base") is None
    assert build_aligner(device="cpu") is None


# ── typed machinery faults (review M7) ───────────────────────────────────────────────────────────


def fake_whisperx(
    monkeypatch: pytest.MonkeyPatch,
    *,
    load_align_model: Callable[..., object] | None = None,
    load_audio: Callable[[str], object] | None = None,
    languages: frozenset[str] = frozenset({"en"}),
) -> None:
    """A `whisperx` (and its `alignment` tables) in `sys.modules`, so the adapter's failure typing runs with
    no model, no download and no torch. The pyannote shim is marked done: it imports torch."""
    from encore_worker.adapters import ml

    module = types.ModuleType("whisperx")
    alignment = types.ModuleType("whisperx.alignment")
    alignment.DEFAULT_ALIGN_MODELS_TORCH = {lang: f"torch-{lang}" for lang in languages}  # type: ignore[attr-defined]
    alignment.DEFAULT_ALIGN_MODELS_HF = {}  # type: ignore[attr-defined]
    if load_align_model is not None:
        module.load_align_model = load_align_model  # type: ignore[attr-defined]
    if load_audio is not None:
        module.load_audio = load_audio  # type: ignore[attr-defined]
    module.alignment = alignment  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "whisperx", module)
    monkeypatch.setitem(sys.modules, "whisperx.alignment", alignment)
    monkeypatch.setattr(ml, "_SAFE_GLOBALS_REGISTERED", True)
    clear_cache()


def raising(exc: Exception) -> Callable[..., object]:
    def call(*_a: object, **_k: object) -> object:
        raise exc

    return call


def test_a_model_download_failure_is_a_retryable_machinery_fault(monkeypatch: pytest.MonkeyPatch) -> None:
    """whisperx wraps a Hub download failure in the same `ValueError` it raises for an unknown language, so
    the adapter asks whisperx's own tables which one it was. A known language that would not load is the
    machinery's, and worth another attempt."""
    from encore_worker.adapters.ml import WhisperXAligner

    fake_whisperx(
        monkeypatch, load_align_model=raising(ValueError('The chosen align_model "x" could not be found'))
    )
    with pytest.raises(InfraFault, match="loading the 'en' alignment model failed") as raised:
        WhisperXAligner(device="cpu")._aligner("en")
    assert raised.value.retryable is True and not isinstance(raised.value, ModelUnavailable)
    assert isinstance(raised.value.__cause__, ValueError), "the original is kept as the cause"


def test_a_language_with_no_alignment_model_stays_one_attempt_declining(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No model for the TEXT's language is not the box failing: the step declines the attempt, and a timed
    text still reaches LINE_SYNC, which needs no model. Typed as a fault, it would fail that job instead."""
    from encore_worker.adapters.ml import WhisperXAligner

    unknown = ValueError("No default align-model for language: xx")
    fake_whisperx(monkeypatch, load_align_model=raising(unknown))
    with pytest.raises(ValueError) as raised:
        WhisperXAligner(device="cpu")._aligner("xx")
    assert raised.value is unknown and not isinstance(raised.value, InfraFault)


def test_a_model_that_runs_out_of_memory_loading_is_not_retried(monkeypatch: pytest.MonkeyPatch) -> None:
    from encore_worker.adapters.ml import WhisperXAligner

    fake_whisperx(
        monkeypatch, load_align_model=raising(RuntimeError("MPS backend out of memory (MPS allocated)"))
    )
    with pytest.raises(OutOfMemory) as raised:
        WhisperXAligner(device="mps")._aligner("en")
    assert raised.value.retryable is False and isinstance(raised.value, InfraFault)


def test_audio_ffmpeg_will_not_decode_is_a_machinery_fault(monkeypatch: pytest.MonkeyPatch) -> None:
    """The job's own file: no text changes whether ffmpeg can read it, so every attempt would fail alike."""
    from encore_worker.adapters.ml import load_audio_mono_16k

    fake_whisperx(
        monkeypatch, load_audio=raising(RuntimeError("Failed to load audio: vocals.wav: Invalid data"))
    )
    with pytest.raises(InfraFault, match="through ffmpeg") as raised:
        load_audio_mono_16k("/media/m1/vocals.wav")
    assert raised.value.retryable is True and "Invalid data" in str(raised.value)


def test_a_ctc_kernel_that_is_gone_is_a_non_retryable_machinery_fault(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """torchaudio 2.9 deprecates `forced_align` for removal. A torchaudio without it cannot decode any text,
    and the same box lacks it on the next attempt too. Faked as modules, so this runs with no torch."""
    from encore_worker.adapters.ml import forced_align_decoder

    monkeypatch.setitem(sys.modules, "torch", types.ModuleType("torch"))
    monkeypatch.setitem(sys.modules, "torchaudio", types.ModuleType("torchaudio"))
    monkeypatch.setitem(sys.modules, "torchaudio.functional", types.ModuleType("torchaudio.functional"))
    with pytest.raises(ModelUnavailable, match="forced_align") as raised:
        forced_align_decoder(object(), [1, 2, 3])
    assert raised.value.retryable is False and isinstance(raised.value, InfraFault)


def test_an_untimed_search_segment_declines_the_attempt_not_the_job(monkeypatch: pytest.MonkeyPatch) -> None:
    """Review W1 r2. The windowed aligner's contract check (every search segment needs a start) raised
    `ModelUnavailable` — since M7 a non-retryable `InfraFault`, which fails the JOB. The shape is THIS text's
    (`place.spread_over` leaves an untimed text as it is when the probe could not read a duration), so it
    must be what `_time_text_windowed` declines: a plain error, raised before any model is touched."""
    from encore_worker.adapters.ml import WhisperXAligner

    loaded: list[str] = []

    def load(**_k: object) -> tuple[object, dict[str, object]]:
        loaded.append("model")
        return object(), {}

    fake_whisperx(monkeypatch, load_align_model=load)
    search: list[dict[str, object]] = [{"text": "timed", "start": 0.0, "end": 1.0}, {"text": "untimed"}]
    with pytest.raises(ValueError, match="needs a start on every search segment") as raised:
        WhisperXAligner(device="cpu").align(search, "/media/m1/vocals.wav", "en")
    assert not isinstance(raised.value, InfraFault), "an InfraFault fails the job for one text's shape"
    assert loaded == [], "checked before any model load"


@pytest.mark.parametrize(
    ("failed", "kind"),
    [
        (RuntimeError("MPS backend out of memory (MPS allocated: 17.2 GB)"), OutOfMemory),
        (RuntimeError("CUDA error: an illegal memory access was encountered"), InfraFault),
        (OSError("HTTP Error 503: Service Unavailable"), InfraFault),
    ],
    ids=["oom", "device", "download"],
)
def test_a_machinery_failure_is_typed_by_its_own_message(failed: Exception, kind: type[InfraFault]) -> None:
    """Out-of-memory is read off torch's message with the markers `cli.run` reads off a subprocess, and is
    the one kind not retried; the message keeps the original's type and text as the diagnosis."""
    from encore_worker.adapters.ml import _machinery_fault

    fault = _machinery_fault("the emission pass on mps", failed)
    assert type(fault) is kind
    assert type(failed).__name__ in str(fault) and str(failed) in str(fault)


# ── the English bundle, per device and per operator (review §3 item 6b; W4b) ──────────────────────


def test_the_english_bundle_is_a_function_of_the_device() -> None:
    """HuBERT-Large on EVERY device since W5's flip, because the exception table is still empty.

    A pure function over a device string, like `transcriber_device`: the candidate bundles differ by three
    times in weights (1.2 vs 3.8 GB) and in seconds per song (4.3-8.6 vs 11.8-24 on MPS), so the shape has
    to admit a per-device answer even while today's answer is one name. `ALIGN_MODELS_BY_DEVICE` is EMPTY by
    measurement rather than laziness: W5's flip is a BUNDLE result (32 songs x 16 modes at both bench
    levels) and nothing in it is a fact about MPS. HuBERT-XLarge is the entry the table must not grow,
    nobody having run it on CUDA."""
    from encore_worker.adapters.ml import ALIGN_MODELS_BY_DEVICE, DEFAULT_ALIGN_MODEL, default_align_model

    assert ALIGN_MODELS_BY_DEVICE == {}, "no device class has earned an exception on measured numbers"
    assert default_align_model("cuda") == default_align_model("mps") == default_align_model("cpu")
    assert default_align_model("mps") == DEFAULT_ALIGN_MODEL == "HUBERT_ASR_LARGE"
    assert default_align_model("rocm-someday") == DEFAULT_ALIGN_MODEL, "an unknown device is not a crash"
    assert "HUBERT_ASR_XLARGE" not in ALIGN_MODELS_BY_DEVICE.values(), (
        "XL on CUDA is a projection: no box on this tree has run it end to end"
    )

    # AND THE CALIBRATION RECORD MAY NOT CONTRADICT THIS TABLE. `lexical` once said XL was "CUDA's default
    # (`ml.ALIGN_MODELS_BY_DEVICE`...)" for a wave that had already reverted the flip, citing the now EMPTY
    # table as its evidence — so a CUDA operator concluded their box shipped XL on a mix wrong-text margin of
    # 0.0021. An empty table means nothing there may call any bundle a device's default. Read off the module
    # SOURCE and not `__doc__`, because since W7b the record is the `CALIBRATED` table and its `#:` block
    # rather than an essay in the docstring, and `#:` comments carry no `__doc__`.
    from encore_worker.domain.lyrics import lexical

    record = Path(inspect.getsourcefile(lexical) or "").read_text(encoding="utf-8")
    assert "CUDA's default" not in record, (
        "no bundle is any device's default while ALIGN_MODELS_BY_DEVICE is empty"
    )
    assert DEFAULT_ALIGN_MODEL in lexical.CALIBRATED, (
        "and the record names the bundle a box actually loads — a row, not a passing mention: a substring "
        "search over the whole module would pass on any incidental occurrence of the name"
    )

    # AND THE XL PARAGRAPH MAY NOT READ AS A MEASUREMENT (W5's flip spec; W4b review r2 correctness-3 is the
    # same defect one bundle over). W7c moved that paragraph into the DESIGN DOCUMENT the table now cites, so
    # the pair is checked where it lives: the code must still point at docs/arch/04-alignment.md §3.1, and
    # that section must still call XL a projection. Reading the code alone would pass on a pointer to a
    # section that had lost the caveat.
    from encore_worker.adapters import ml

    source = Path(inspect.getsourcefile(ml) or "").read_text(encoding="utf-8")
    # The slice is the `#:` RUN IMMEDIATELY ABOVE the assignment, walked back to, not the whole file before
    # it (W7c review r1-correctness-3): the module docstring cites docs/arch/04-alignment.md §3.1 too, so a
    # prefix window stayed true with this block deleted and the pointer it pins could be dropped silently.
    lines = source.splitlines()
    assignment = next(n for n, line in enumerate(lines) if line.startswith("ALIGN_MODELS_BY_DEVICE"))
    first = assignment
    while first and lines[first - 1].lstrip().startswith("#:"):
        first -= 1
    table = "\n".join(lines[first:assignment])
    assert table, "the exception table has lost its `#:` block: nothing points at XL's caveat any more"
    assert "docs/arch/04-alignment.md §3.1" in table, (
        "the block above the table must point at the section carrying XL's caveat"
    )
    assert "XLarge" in table, (
        "and must name what the pointer is for: the CUDA XLarge row the empty table may not grow"
    )
    design = Path(__file__).resolve().parents[2] / "docs/arch/04-alignment.md"
    section = re.split(r"\n#{2,4} ", design.read_text(encoding="utf-8").split("### 3.1 ")[1])[0]
    assert "accuracy claim is a projection" in section, (
        "docs/arch/04-alignment.md §3.1 must call XLarge's accuracy claim a projection, never a measured one"
    )
    assert "must not grow a CUDA row" in section, (
        "docs/arch/04-alignment.md §3.1 must keep the caveat the empty table exists for: no CUDA row for "
        "XLarge without a CUDA sweep"
    )


def test_a_named_bundle_is_loaded_for_english_only(monkeypatch: pytest.MonkeyPatch) -> None:
    """The knob names an ENGLISH bundle (HuBERT is LibriSpeech-trained), so it must not be pushed onto the
    XLSR fine-tune whisperx tables for German — that would align German text against an English vocabulary
    and name the matrix a model that never saw the song. Dormant until W7 gives the language a value, wired
    now so W7 cannot detonate it."""
    from encore_worker.adapters.ml import WhisperXAligner

    calls: list[object] = []

    def load(**kw: object) -> tuple[object, dict[str, object]]:
        calls.append(kw.get("model_name"))
        return object(), {"dictionary": {}}

    fake_whisperx(monkeypatch, load_align_model=load, languages=frozenset({"en", "de"}))
    aligner = WhisperXAligner(device="cpu", model="HUBERT_ASR_LARGE")
    aligner._aligner("en")
    aligner._aligner("de")
    assert calls == ["HUBERT_ASR_LARGE", None], "None is whisperx's own per-language resolution"
    assert aligner._bundle_name("en") == "HUBERT_ASR_LARGE", "and the matrix says which bundle it came from"
    assert aligner._bundle_name("de") == "torch-de", "while German stays whisperx's table's"


def test_two_bundles_on_one_device_do_not_share_one_loaded_handle(monkeypatch: pytest.MonkeyPatch) -> None:
    """The model cache used to be keyed `(device, f"align:{language}")`, which was safe only while the bundle
    was a function of the language alone. With the name settable, that key would hand the second aligner
    whatever the first loaded — and then every threshold read off the matrix is another model's scale, with
    nothing to say so (`Emissions.model` would name the bundle that did NOT produce the frames)."""
    from encore_worker.adapters import ml
    from encore_worker.adapters.ml import WhisperXAligner

    def load(**kw: object) -> tuple[object, dict[str, object]]:
        return str(kw.get("model_name")), {"dictionary": {}}

    fake_whisperx(monkeypatch, load_align_model=load)
    large = WhisperXAligner(device="cpu", model="HUBERT_ASR_LARGE")._aligner("en")
    xlarge = WhisperXAligner(device="cpu", model="HUBERT_ASR_XLARGE")._aligner("en")
    default = WhisperXAligner(device="cpu")._aligner("en")
    assert large[0] == "HUBERT_ASR_LARGE" and xlarge[0] == "HUBERT_ASR_XLARGE" and default[0] == "None"
    assert set(ml._MODELS) == {
        ("cpu", "align:en:HUBERT_ASR_LARGE"),
        ("cpu", "align:en:HUBERT_ASR_XLARGE"),
        ("cpu", "align:en:default"),
    }
    clear_cache()


def test_a_named_bundle_that_will_not_load_is_the_machinerys_fault(monkeypatch: pytest.MonkeyPatch) -> None:
    """The "no model for this language" escape hatch belongs to whisperx's own resolution ONLY. When THIS BOX
    named the bundle, the same `ValueError` is a fact about this box's settings or its Hub cache, not about
    the text's language — so it is the machinery's fault (the job fails loudly) rather than one attempt
    declining while every later attempt declines identically."""
    from encore_worker.adapters.ml import WhisperXAligner

    unknown = ValueError("No default align-model for language: en")
    fake_whisperx(monkeypatch, load_align_model=raising(unknown))
    with pytest.raises(InfraFault, match="loading the 'en' alignment model failed"):
        WhisperXAligner(device="cpu", model="HUBERT_ASR_LARGE")._aligner("en")


def test_the_factory_resolves_the_device_default_and_the_bare_constructor_does_not() -> None:
    """WHERE THE POLICY LIVES. `build_aligner` is the factory the host and the bench both go through, so it
    is what resolves an unset `ENCORE_ALIGN_MODEL` into this device's bundle; the bare constructor stays
    "load what you were told to", which is what lets `test_ml_contract` pin the 320/400 frame grid on the
    bundle its constants were measured on."""
    from encore_worker.adapters.ml import WhisperXAligner, build_aligner, default_align_model
    from encore_worker.host.hardware import module_available

    assert WhisperXAligner(device="cpu")._model is None
    assert WhisperXAligner(device="cpu", model="X")._model == "X"
    if not module_available("whisperx"):
        pytest.skip("no whisperx: the factory returns None and there is nothing to resolve")
    for device in ("cpu", "mps", "cuda"):
        built = build_aligner(device=device)
        assert built is not None and built._model == default_align_model(device)
    named = build_aligner(device="cpu", model="HUBERT_ASR_XLARGE")
    assert named is not None and named._model == "HUBERT_ASR_XLARGE", "an operator's name wins"


def test_the_composition_root_refuses_a_model_nothing_calibrated() -> None:
    """THE LOUD HALF of "fail loudly or refuse to gate" (`domain.lyrics.lexical`). A matrix from an
    uncalibrated model makes every emission-scale gate stand down — right for a per-language bundle nobody
    chose, and wrong for one an operator typed, since that worker would run every job with its wrong-text
    gate silently off. So the name is refused before the process accepts work, with `host.config`'s manners:
    name the variable, list what is accepted, do not retry.
    """
    from encore_worker import __main__ as entry
    from encore_worker.adapters.ml import default_align_model
    from encore_worker.domain.lyrics import lexical

    assert entry.align_model_for(Config(), "cuda") == default_align_model("cuda")
    assert entry.align_model_for(Config(align_model=lexical.BANDS.model), "mps") == lexical.BANDS.model
    with pytest.raises(ConfigError, match=r"ENCORE_ALIGN_MODEL='WAV2VEC2_LARGE_XLSR_53_DE'") as raised:
        entry.align_model_for(Config(align_model="WAV2VEC2_LARGE_XLSR_53_DE"), "cpu")
    assert raised.value.retryable is False
    assert "recalibrate with scripts/lift_gate.py" in str(raised.value), "the fix, not just the refusal"
    assert default_align_model("cpu") in str(raised.value), "and what leaving it unset would have loaded"

    # AND THE REFUSAL IS REACHABLE FROM THE ENVIRONMENT, not only from a `Config` a test built (W5, which owed
    # a proof that the knob and the check meet). The brief asked for the check at `Config.from_env` time; it
    # cannot live there — `host/` may not import `domain/` (`tests/test_layers.py`) — so what holds is that
    # the string a person exports survives parsing and reaches this refusal unchanged, which is the same
    # guarantee one layer out. Both spellings of the default are accepted, since `is_calibrated` is a lookup.
    for name in (lexical.BANDS.model, default_align_model("mps"), "HUBERT_ASR_XLARGE"):
        parsed = Config.from_env({"ENCORE_ALIGN_MODEL": name})
        assert parsed.align_model == name
        assert entry.align_model_for(parsed, "mps") == name
    typed = Config.from_env({"ENCORE_ALIGN_MODEL": "  WAV2VEC2_LARGE_XLSR_53_DE  "})
    with pytest.raises(ConfigError, match=r"ENCORE_ALIGN_MODEL='WAV2VEC2_LARGE_XLSR_53_DE'"):
        entry.align_model_for(typed, "mps")  # the name the refusal quotes is the PARSED one, trimmed
    assert entry.align_model_for(Config.from_env({}), "mps") == default_align_model("mps"), (
        "an unset knob is this device's default, not a refusal"
    )

    # AND THE RESOLVED BUNDLE IS ON THE BOX'S RECORD (W4b review r1): nothing named it — not the startup
    # banner, not a job's evidence note — so a box whose `ENCORE_ALIGN_MODEL` was set could not be told from
    # one whose was not. `main` prints it beside ffmpeg's version, for the same reason. Read off the SOURCE
    # because the banner is three prints into a coroutine that probes hardware and starts DBOS, and the
    # regression to guard is the line being dropped in a later edit of that function.
    startup = Path(inspect.getsourcefile(entry) or "").read_text(encoding="utf-8")
    assert "[worker] align bundle {align_model_for(config, device)}" in startup, (
        "the startup banner must name the bundle every emission-scale threshold is read off"
    )
