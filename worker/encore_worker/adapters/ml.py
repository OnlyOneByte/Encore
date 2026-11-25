"""The model-backed adapters: whisper for transcription, whisperX for alignment, pyannote for diarization.

EVERY IMPORT IS LAZY — the rule this module exists to enforce, and what lets the whole test suite import it
with no ML installed. MODELS ARE CACHED AT MODULE LEVEL, which is what makes this worker a resident process.
EVERYTHING HERE IS SYNCHRONOUS, called from inside `asyncio.to_thread`, because torch blocks.
The frame clock, the chunking and both caches are docs/arch/04-alignment.md §3.1.
"""

from __future__ import annotations

import os
from collections import OrderedDict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, cast

from encore_worker.adapters.cli import OutOfMemory, looks_like_oom
from encore_worker.adapters.ports import InfraFault, Transcribed
from encore_worker.domain.document import Segment
from encore_worker.host.mlrt import ML_LOCK

#: (device, checkpoint) -> loaded handle. MODEL WEIGHTS ONLY, and it must never evict
#: (docs/arch/04-alignment.md §3.1).
_MODELS: dict[tuple[str, str], Any] = {}

#: Devices CTranslate2, which whisperx runs its transcriber on, will actually accept. Measured, not assumed
#: (docs/arch/04-alignment.md §3.1).
CTRANSLATE2_DEVICES = ("cpu", "cuda")

#: The language the model knob names a bundle FOR: the override applies to this one and every other language
#: keeps whisperx's own table (docs/arch/04-alignment.md §3.1, §9).
ENGLISH = "en"

#: THE ENGLISH ALIGNMENT BUNDLE per device class: the exception table, EMPTY and finished. Why it stays a
#: table, why it must not grow a CUDA XLarge row without a sweep, and why every name in it needs a
#: `lexical.CALIBRATED` row: docs/arch/04-alignment.md §3.1.
ALIGN_MODELS_BY_DEVICE: Mapping[str, str] = {}

#: THE ENGLISH BUNDLE THIS BOX LOADS WHEN NOBODY NAMES ONE: ~2x the base bundle's seconds a song and a
#: one-time 1.2 GB download, A/B'd in LOG.md, "The English bundle is a setting" and "W5: the flip, landed".
DEFAULT_ALIGN_MODEL = "HUBERT_ASR_LARGE"

#: The ONE bundle that times a NON-LATIN language off a romanised target sequence, under the `mms-roman`
#: arm. ITS WEIGHTS ARE CC-BY-NC, so it may not become anybody's default: docs/arch/04-alignment.md §9.1.
MMS_ALIGN_MODEL = "MMS_FA"


def default_align_model(device: str) -> str:
    """The English bundle this box loads when the operator names none — a function of the DEVICE, which is
    resolved from what the box has. `ALIGN_MODELS_BY_DEVICE` is empty, so this reads like a constant."""
    return ALIGN_MODELS_BY_DEVICE.get(device, DEFAULT_ALIGN_MODEL)


#: Whether the pyannote-checkpoint unpickling shim has been installed. Once per process.
_SAFE_GLOBALS_REGISTERED = False


def transcriber_device(device: str) -> str:
    """The device the TRANSCRIBER can use, which is not always the device torch offers: each component asks
    for what it can take (docs/arch/04-alignment.md §3.1)."""
    return device if device in CTRANSLATE2_DEVICES else "cpu"


def _allow_pyannote_checkpoints() -> None:
    """Register the globals pyannote's checkpoints need under torch's weights-only unpickler. NARROW BY
    DESIGN, and discovered one refusal at a time (docs/arch/04-alignment.md §3.1)."""
    global _SAFE_GLOBALS_REGISTERED
    if _SAFE_GLOBALS_REGISTERED:
        return
    import collections  # noqa: PLC0415
    import typing  # noqa: PLC0415

    import torch  # noqa: PLC0415
    import torch.serialization  # noqa: PLC0415

    allowed: list[Any] = [
        list,
        dict,
        int,
        collections.defaultdict,
        typing.Any,
        torch.torch_version.TorchVersion,
    ]
    for path in (
        "omegaconf.listconfig.ListConfig",
        "omegaconf.base.ContainerMetadata",
        "omegaconf.base.Metadata",
        "omegaconf.nodes.AnyNode",
        "pyannote.audio.core.model.Introspection",
        "pyannote.audio.core.task.Specifications",
        "pyannote.audio.core.task.Problem",
        "pyannote.audio.core.task.Resolution",
    ):
        module, _, attr = path.rpartition(".")
        try:
            import importlib  # noqa: PLC0415

            allowed.append(getattr(importlib.import_module(module), attr))
        except (ImportError, AttributeError):
            # A version that no longer ships this type does not need it allowlisted.
            continue
    torch.serialization.add_safe_globals(allowed)
    _SAFE_GLOBALS_REGISTERED = True


class ModelUnavailable(InfraFault):
    """A model this box was asked for, or the kernel that decodes against it, cannot be loaded.

    Not retryable, and an `InfraFault` rather than a decline: it fails every text the same way, and
    declining attempt after attempt over it ended the ladder in a published "no lyrics".
    """

    retryable = False


def _machinery_fault(doing: str, failed: BaseException) -> InfraFault:
    """`failed`, raised while `doing` something only the machinery does, as the typed fault it is.

    Out-of-memory is told apart by `cli.run`'s markers and is not retried: the same pass on the same box
    exhausts the same memory again. Anything else is a plain `InfraFault`.
    """
    detail = f"{type(failed).__name__}: {str(failed).strip()[-400:]}"
    if looks_like_oom(detail):
        return OutOfMemory(
            f"{doing} ran out of memory ({detail}). This model needs more than this box has — try a "
            "smaller model, or a box with more memory."
        )
    return InfraFault(f"{doing} failed ({detail})")


def _has_default_align_model(language: str) -> bool:
    """Does whisperx name a default alignment model for `language`? True when it cannot be asked.

    Read off whisperx's own tables, `load_align_model` raising the SAME `ValueError` for "no model for this
    language" as for "the checkpoint would not download" where only the second is the machinery's.
    """
    try:
        from whisperx.alignment import (  # noqa: PLC0415
            DEFAULT_ALIGN_MODELS_HF,
            DEFAULT_ALIGN_MODELS_TORCH,
        )
    except ImportError:
        return True
    return bool(language in DEFAULT_ALIGN_MODELS_TORCH or language in DEFAULT_ALIGN_MODELS_HF)


def align_model_name(
    language: str, model: str | None = None, nonlatin: Mapping[str, str] | None = None
) -> str:
    """The alignment bundle `_aligner` loads for `language` — the name, without loading anything.

    `model` wins for `ENGLISH` and for an UNDETECTED language, which `_bundle_of` loads it for too, and
    `nonlatin` is the PER-LANGUAGE stage-2 table (`units.ROUTED`, resolved at the composition root): a
    language it names takes that bundle, a language it does not keeps whisperx's own, so no language borrows
    a neighbour's route (XA-21). The rest comes off whisperx's tables, so this and `_aligner` name the same
    thing, which is what a calibrated reader trusts (XA-06).
    """
    if model is not None and (language == ENGLISH or not language):
        return model
    routed = (nonlatin or {}).get(language)
    if routed and language and not _is_latin(language):
        return routed
    try:
        from whisperx.alignment import (  # noqa: PLC0415
            DEFAULT_ALIGN_MODELS_HF,
            DEFAULT_ALIGN_MODELS_TORCH,
        )
    except ImportError:  # pragma: no cover - whisperx is a hard dependency of the ml extra
        return f"unknown:{language}"
    named = DEFAULT_ALIGN_MODELS_TORCH.get(language) or DEFAULT_ALIGN_MODELS_HF.get(language)
    return str(named or f"default:{language}")


def _is_latin(language: str) -> bool:
    """Is `language` one whisperx tables a LATIN-script bundle for? The `mms-roman` arm's own scope: a Latin
    language's MMS reading is already measurable through `ENCORE_ALIGN_MODEL` on English."""
    from encore_worker.domain.lyrics.language import LATIN_LANGUAGES  # noqa: PLC0415

    return language in LATIN_LANGUAGES


def _cached(device: str, checkpoint: str, build: Any) -> Any:
    key = (device, checkpoint)
    if key not in _MODELS:
        _MODELS[key] = build()
    return _MODELS[key]


def clear_cache() -> None:
    """Drop every loaded model AND every cached emission matrix: for tests, and for reclaiming VRAM."""
    _MODELS.clear()
    _EMISSIONS.clear()


#: Samples a second the bundles are trained at; every other rate is resampled to it.
_EMISSION_SAMPLE_RATE = 16000

#: wav2vec2's feature extractor in samples at 16 kHz: the hop per output frame, and the field one needs
#: (docs/arch/04-alignment.md §3.1).
_FRAME_HOP_SAMPLES = 320
_FRAME_FIELD_SAMPLES = 400

#: Seconds in one emission frame: EXACTLY the hop over the rate, which is arithmetic rather than evidence
#: (LOG.md, "The clock was wrong twice over").
FRAME_SEC = _FRAME_HOP_SAMPLES / _EMISSION_SAMPLE_RATE

#: Seconds of audio one forward pass STAMPS, which is what bounds memory (docs/arch/04-alignment.md §3.1).
_EMISSION_CHUNK_SEC = 30

#: Seconds computed on EACH SIDE of a chunk and discarded, so every stamped frame has an interior frame's
#: context. ~1.1x of forward passes (docs/arch/04-alignment.md §3.1).
_EMISSION_CONTEXT_SEC = 2

#: Emission matrices, most-recently-used LAST, keyed on CONTENT and not path; bounded, and separate from
#: `_MODELS` (docs/arch/04-alignment.md §3.1).
_EMISSIONS: OrderedDict[tuple[Any, ...], Emissions] = OrderedDict()

#: Matrices ONE align job can be reading at once: its target, and the MIX witness R4 decodes.
_MATRICES_PER_JOB = 2


def _emission_cache_size(jobs: int) -> int:
    """How many matrices to keep on a box running `jobs` at a time (`Config.concurrency`): derived from the
    concurrency and bounded by the resident set (docs/arch/04-alignment.md §3.1)."""
    return _MATRICES_PER_JOB * (max(1, jobs) + 1)


#: The default bound: one job at a time (`Config.concurrency`) — see `_emission_cache_size`.
_EMISSION_CACHE_SIZE = _emission_cache_size(1)

#: The names a vocabulary gives CTC's BLANK, lowercased as whisperx lowercases its dictionary. A torchaudio
#: bundle has no pad token and puts `-` at id 0, which is its blank (XA-10).
_BLANK_NAMES = ("[pad]", "<pad>")

#: Vocabulary entries that are NOT characters of the language: the blank under either name, the word
#: separator, and the unknown / sentence markers. Named on `Emissions.specials`.
_SPECIAL_NAMES = ("[pad]", "<pad>", "[unk]", "<unk>", "<s>", "</s>", "|")


@dataclass(frozen=True)
class Emissions:
    """A song's per-frame `(frames, vocab)` log-probabilities, plus what is needed to decode against them:
    `dictionary`, `model` and `blank_id` are all the producing bundle's (XA-06, XA-10)."""

    log_probs: Any
    frame_sec: float
    dictionary: dict[str, int]
    #: The bundle these frames came from (XA-06), the VOCABULARY's identity, and part of the cache key.
    #: EMPTY means unnamed, which `lexical.calibration` reads as the BASE bundle's row.
    model: str = ""
    #: CTC's blank column in THIS matrix, NOT always 0 — which is why hard-coding it survived — and read
    #: with `getattr` so older bench entries still decode (LOG.md, "M9: the blank is the matrix's").
    blank_id: int = 0
    #: The vocabulary's non-character entries by name -> id, blank included, READ BY THE TARGET FILTER
    #: (`generate.excluded_of`): a single-character special is reachable from a lyric. Empty = not reported.
    specials: Mapping[str, int] = field(default_factory=dict)

    @property
    def frames(self) -> int:
        return int(self.log_probs.shape[0]) if self.log_probs is not None else 0


def blank_id_of(dictionary: Mapping[str, int]) -> int:
    """CTC's blank id in `dictionary`, by whisperx's own rule (`whisperx/alignment.py:267-270`), so the
    global decode and the windowed one cannot disagree about it on one loaded model (XA-10)."""
    for name in _BLANK_NAMES:
        code = dictionary.get(name)
        if code is not None:
            return int(code)
    return 0


def specials_of(dictionary: Mapping[str, int]) -> dict[str, int]:
    """The `_SPECIAL_NAMES` this vocabulary has, for `Emissions.specials` — plus `-` WHEN IT IS THE BLANK,
    the torchaudio bundles' case, where it is not a hyphen the text may align on, and `*` under
    `OWN_STAR_NAME` where the vocabulary ships its own star column (MMS_FA's)."""
    out = {name: int(code) for name in _SPECIAL_NAMES if (code := dictionary.get(name)) is not None}
    blank = blank_id_of(dictionary)
    if dictionary.get("-") == blank:
        out["-"] = blank
    own_star = dictionary.get("*")
    if own_star is not None and int(own_star) != blank:
        out[OWN_STAR_NAME] = int(own_star)
    return out


#: `Emissions.specials`' name for the STAR column THIS ARM INSTALLED, priced at `STAR_PENALTY_NATS`. NOT
#: `*`, which a vocabulary could hold as a character. Restated in `generate.star_of` because `domain/` may
#: not import this; a test holds the copies equal.
STAR_NAME = "<star>"

#: `Emissions.specials`' name for a star column THE VOCABULARY ITSELF SHIPS (MMS_FA's `*`): excluded from
#: every target, and NOT `STAR_NAME`, this arm's star being one it priced (docs/arch/04-alignment.md §14.1).
OWN_STAR_NAME = "<model-star>"

#: Nats BELOW each frame's own best log-probability that the star column sits at (docs/arch/04-alignment.md
#: §3.1). The sweep, the objectives and the verdict: LOG.md, "W9: the star re-fitted out of sample, at an
#: optimum outside the review's range" and "W7: the star/filler token, phase A" (its in-sample 1.0).
STAR_PENALTY_NATS = 0.3


def starred(emissions: Any, *, penalty: float = STAR_PENALTY_NATS) -> Emissions:
    """`emissions` with a STAR column appended, scored `frame max − penalty` and named `STAR_NAME` on
    `specials` (docs/arch/04-alignment.md §3.1, §14).

    A COLUMN AND NOT A KERNEL is phase A's whole point. INERT ON AN EMPTY MATRIX, torch or numpy in, and
    duck-typed in with `Emissions` out for `generate.blank_of`'s reason.
    """
    matrix = emissions.log_probs
    named_already: Mapping[str, int] = getattr(emissions, "specials", None) or {}
    if matrix is None or emissions.frames == 0 or STAR_NAME in named_already:
        # The SAME OBJECT, so an inert arm is not even a copy; `cast` because the parameter is a duck type.
        # Idempotent: a matrix this already starred keeps the one column it was priced with.
        return cast("Emissions", emissions)
    star = int(matrix.shape[1])
    installed: Any
    try:
        import torch  # noqa: PLC0415 - lazy by design; see the module docstring

        installed = torch
    except ImportError:  # a box with no torch at all: then the matrix cannot be a tensor either
        installed = None
    widened: Any
    if installed is not None and isinstance(matrix, installed.Tensor):
        widened = installed.cat((matrix, (matrix.max(dim=1).values - penalty).unsqueeze(1)), dim=1)
    else:
        import numpy as np  # noqa: PLC0415 - lazy for the same reason

        plain = np.asarray(matrix)
        widened = np.concatenate((plain, (plain.max(axis=1) - penalty)[:, None]), axis=1)
    named: Mapping[str, int] = getattr(emissions, "specials", None) or {}
    return Emissions(
        log_probs=widened,
        frame_sec=float(emissions.frame_sec),
        dictionary=dict(emissions.dictionary),
        model=str(getattr(emissions, "model", "") or ""),
        blank_id=int(getattr(emissions, "blank_id", 0)),
        specials={**{str(name): int(code) for name, code in named.items()}, STAR_NAME: star},
    )


def _content_key(audio_path: str) -> tuple[str, int, int] | None:
    """(resolved path, size, mtime_ns) — what `_EMISSIONS` keys a matrix's AUDIO on, or None when the file
    cannot be stat'ed, in which case the caller computes WITHOUT caching: an unreadable target must still
    fail inside `load_audio_mono_16k` as a typed `InfraFault`, not as an `OSError` from a cache key."""
    try:
        real = os.path.realpath(audio_path)
        stat = os.stat(real)
    except OSError:
        return None
    return (real, stat.st_size, stat.st_mtime_ns)


def _cached_emissions(key: tuple[Any, ...], build: Any, keep: int = _EMISSION_CACHE_SIZE) -> Emissions:
    """`build()`'s matrix under `key`, from the bounded LRU when it is there. `keep` is the caller's bound,
    defaulted for a caller with no config: the cache is module-global because the WEIGHTS are."""
    hit = _EMISSIONS.get(key)
    if hit is not None:
        _EMISSIONS.move_to_end(key)
        return hit
    made: Emissions = build()
    _EMISSIONS[key] = made
    while len(_EMISSIONS) > max(1, keep):
        _EMISSIONS.popitem(last=False)
    return made


@dataclass(frozen=True, slots=True)
class _Pass:
    """One forward pass of the emission grid: what to feed the model, and which frames to keep."""

    #: First audio sample of the slice handed to the model. A multiple of the hop, so `trim` is exact.
    offset: int
    #: One past the last sample READ from the audio; a shorter slice is zero-padded up to `samples`.
    stop: int
    #: Length of the (padded) slice, so the model produces at least `trim + keep` frames.
    samples: int
    #: Leading frames of this pass that are CONTEXT: computed for their receptive field, then discarded.
    trim: int
    #: Frames after `trim` that belong to the song's grid.
    keep: int


def _frame_passes(total_samples: int) -> list[_Pass]:
    """The exact 20 ms frame grid over `total_samples`, as the forward passes that produce it.

    PURE AND SEPARATE FROM THE MODEL, so the arithmetic that was wrong twice over is tested without torch,
    weights or audio. Every offset is a whole number of hops (docs/arch/04-alignment.md §3.1).
    """
    hop, field_ = _FRAME_HOP_SAMPLES, _FRAME_FIELD_SAMPLES
    chunk = _EMISSION_CHUNK_SEC * _EMISSION_SAMPLE_RATE // hop
    context = _EMISSION_CONTEXT_SEC * _EMISSION_SAMPLE_RATE // hop
    frames = -(-max(total_samples, 0) // hop)  # ceil
    passes: list[_Pass] = []
    for first in range(0, frames, chunk):
        keep = min(chunk, frames - first)
        offset = max(0, first - context) * hop
        trim = (first * hop - offset) // hop
        # Far enough right that the LAST context frame has its field too; the audio may end sooner.
        stop = min(total_samples, (first + keep + context - 1) * hop + field_)
        passes.append(
            _Pass(
                offset=offset,
                stop=stop,
                samples=max(stop - offset, (trim + keep - 1) * hop + field_),
                trim=trim,
                keep=keep,
            )
        )
    return passes


def load_audio_mono_16k(path: str) -> Any:
    """A mono float32 signal at 16 kHz from ANY container ffmpeg can read, as a numpy array.

    `whisperx.load_audio`, which shells ffmpeg: `read_wav_mono` reads only WAV/FLAC while alignment's MIX
    target is the raw download. An undecodable file raises `InfraFault` — the JOB's audio, not a text's.
    """
    import whisperx  # noqa: PLC0415

    try:
        return whisperx.load_audio(path)
    except Exception as failed:
        raise _machinery_fault(f"decoding {path!r} through ffmpeg", failed) from failed


def log_probs_like(original: Any, computed: Any) -> Any:
    """`computed` as the KIND `original` is: a tensor where `original` is one, else itself — what `domain/`
    computes comes back as numpy and the CTC kernel needs a tensor (docs/arch/04-alignment.md §3.2)."""
    try:
        import torch  # noqa: PLC0415 - lazy by design; see the module docstring
    except ImportError:  # no torch here, so `original` is not a tensor either
        return computed
    if not isinstance(original, torch.Tensor) or isinstance(computed, torch.Tensor):
        return computed
    return torch.as_tensor(computed, dtype=original.dtype, device=original.device)


def forced_align_decoder(
    log_probs: Any, targets: Sequence[int], blank: int = 0
) -> tuple[list[int], list[float]]:
    """`domain.lyrics.generate`'s Decoder, over torchaudio's CTC kernel. `blank` is the matrix's own column
    and not a constant (XA-10); a kernel that is GONE raises `ModelUnavailable`, an `InfraFault` that fails
    the job rather than declining text after text (docs/arch/04-alignment.md §15)."""
    try:
        import torch  # noqa: PLC0415
        from torchaudio.functional import forced_align  # noqa: PLC0415
    except ImportError as gone:
        raise ModelUnavailable(
            "torchaudio's CTC kernel (`torchaudio.functional.forced_align`) is not importable on this box: "
            f"{gone}. It is deprecated for removal in torchaudio 2.9; pin 2.8, or vendor the kernel."
        ) from gone

    aligned, scores = forced_align(
        log_probs.unsqueeze(0), torch.tensor([list(targets)], dtype=torch.int32), blank=blank
    )
    return aligned[0].tolist(), scores[0].tolist()


class WhisperTranscriber:
    """`Transcriber` over whisperX's batched whisper — the ASR tier, and so the mandatory fallback: its
    output cannot be the wrong song and cannot be misplaced in time (docs/arch/04-alignment.md §3)."""

    def __init__(self, *, device: str = "cpu", checkpoint: str = "base", compute: str | None = None) -> None:
        self._device = device
        self._checkpoint = checkpoint
        self._compute = compute

    def _model(self) -> Any:
        def build() -> Any:
            try:
                import whisperx  # noqa: PLC0415 - lazy by design; see the module docstring
            except ImportError as missing:
                raise ModelUnavailable(
                    "whisperx is not installed, so this worker cannot transcribe. "
                    "Install the `ml` extra, or leave `align` out of this box's capabilities."
                ) from missing
            _allow_pyannote_checkpoints()
            # The transcriber's device is NOT the job's (docs/arch/04-alignment.md §3.1).
            device = transcriber_device(self._device)
            # float32 everywhere but CUDA, where float16 is an optimisation; elsewhere it reads as a bad
            # transcription rather than as a wrong dtype.
            compute = self._compute or ("float16" if device == "cuda" else "float32")
            return whisperx.load_model(self._checkpoint, device, compute_type=compute)

        # Cached under the RESOLVED device, so asking for mps and getting cpu shares one handle.
        return _cached(transcriber_device(self._device), f"whisper:{self._checkpoint}", build)

    def warm(self) -> None:
        """Load (and fetch) the checkpoint and run it once on silence, ahead of the first song."""
        with ML_LOCK:
            import numpy as np  # noqa: PLC0415

            self._model().transcribe(np.zeros(_EMISSION_SAMPLE_RATE, dtype=np.float32), language=ENGLISH)

    def transcribe(self, audio_path: str, *, language: str | None = None) -> Transcribed:
        """What was heard, AND IN WHICH LANGUAGE — whisper's own detection, the one language signal MEASURED
        from the recording (docs/arch/04-alignment.md §9). NOT defaulted to `"en"`: a backend that says
        nothing must stay distinguishable from one that heard English."""
        # ML_LOCK covers LOADING AND RUNNING (docs/arch/05-worker.md §9.1).
        with ML_LOCK:
            import whisperx  # noqa: PLC0415

            audio = whisperx.load_audio(audio_path)
            result = self._model().transcribe(audio, language=language)
            heard = result.get("language") if isinstance(result, dict) else None
            spoken = str(heard).strip().lower() or None if isinstance(heard, str) else None
            segments = result.get("segments") if isinstance(result, dict) else None
            if not segments:
                # Nothing intelligible: a RESULT, not an error, and the language is still REPORTED — whisper
                # detects it before it decodes a word, and an empty transcript leaves no text to carry it.
                return Transcribed(segments=(), language=spoken)
            return Transcribed(
                segments=tuple(
                    {"start": s.get("start"), "end": s.get("end"), "text": str(s.get("text") or "").strip()}
                    for s in segments
                    if str(s.get("text") or "").strip()
                ),
                language=spoken,
            )


class WhisperXAligner:
    """`Aligner` over whisperX's wav2vec2 forced alignment, and the reason this worker stays Python."""

    def __init__(
        self,
        *,
        device: str = "cpu",
        jobs: int = 1,
        model: str | None = None,
        nonlatin_routes: Mapping[str, str] | None = None,
    ) -> None:
        self._device = device
        #: The emission LRU's bound, from the box's configured concurrency (`_emission_cache_size`).
        self._matrices = _emission_cache_size(jobs)
        #: The ENGLISH bundle to load, or None for whisperx's own per-language table, which is what a bare
        #: constructor keeps: the per-device policy lives in `build_aligner`, so this class stays "load what
        #: you were told to load".
        self._model = model
        #: `{language: bundle}` where the per-language stage-2 table REPLACES whisperx's own (today MMS_FA
        #: for the languages `units.ROUTED` sends there). Resolved at the composition root; a language
        #: absent from it keeps whisperx's table rather than a neighbour's bundle (XA-21).
        self._nonlatin_routes = dict(nonlatin_routes or {})

    def _bundle_of(self, language: str) -> str | None:
        """The bundle to LOAD for `language`: the configured English one (an UNDETECTED language too,
        whisperx having no row for `""`), its routed non-Latin one, else None = whisperx's own table."""
        if language == ENGLISH or not language:
            return self._model
        return None if _is_latin(language) else self._nonlatin_routes.get(language)

    def _aligner(self, language: str) -> tuple[Any, Any]:
        bundle = self._bundle_of(language)

        def build() -> tuple[Any, Any]:
            try:
                import whisperx  # noqa: PLC0415
            except ImportError as missing:
                raise ModelUnavailable("whisperx is not installed, so this worker cannot align") from missing
            _allow_pyannote_checkpoints()
            try:
                # whisperx is untyped, so the unpack is annotated here rather than letting Any escape up.
                # `model_name=None` is whisperx's own "use the default for this language".
                loaded: tuple[Any, Any] = whisperx.load_align_model(
                    language_code=language, device=self._device, model_name=bundle
                )
            except Exception as failed:
                if bundle is None and not _has_default_align_model(language):
                    # A fact about the TEXT's language, so one attempt declines rather than the job failing.
                    # Not reached for a NAMED bundle, whose failure is this box's settings'.
                    raise
                # A download, a Hub/cache failure, a device refusing the weights.
                raise _machinery_fault(f"loading the {language!r} alignment model", failed) from failed
            return loaded

        # Keyed by the BUNDLE too: two aligners on one device can want different weights for one language.
        cached: tuple[Any, Any] = _cached(self._device, f"align:{language}:{bundle or 'default'}", build)
        model, metadata = cached
        return model, metadata

    def warm(self) -> None:
        """Load (and fetch) the English bundle and run it once on silence, ahead of the first song."""
        with ML_LOCK:
            import torch  # noqa: PLC0415

            model, _metadata = self._aligner(ENGLISH)
            model_device = next(model.parameters()).device
            with torch.inference_mode():
                model(torch.zeros((1, _EMISSION_SAMPLE_RATE), device=model_device))

    def _bundle_name(self, language: str) -> str:
        """The bundle `_aligner` loads for `language`, for `Emissions.model` — resolved, never a placeholder:
        a calibrated reader trusts it and the cache keys on it (XA-06)."""
        return align_model_name(language, self._model, self._nonlatin_routes)

    def emissions(self, audio_path: str, language: str) -> Emissions:
        """The full song's per-frame character log-probabilities, computed ONCE and reusable: THE EVIDENCE
        LAYER of this design (docs/arch/04-alignment.md §1, §3.1). ITS FAILURES ARE THE MACHINERY'S, the pass
        reading audio and a language and no text, so all of them raise `InfraFault`."""
        with ML_LOCK:
            bundle = self._bundle_name(language)

            def build() -> Emissions:
                import torch  # noqa: PLC0415

                model, metadata = self._aligner(language)
                # ffmpeg-backed and already 16 kHz; see `load_audio_mono_16k` for why not `read_wav_mono`.
                mono = torch.from_numpy(load_audio_mono_16k(audio_path))

                # ON THE MODEL'S DEVICE, discovered from its parameters (docs/arch/04-alignment.md §3.1).
                model_device = next(model.parameters()).device
                chunks = []
                try:
                    with torch.inference_mode():
                        for plan in _frame_passes(len(mono)):
                            piece = mono[plan.offset : plan.stop]
                            # PADDED, NEVER DROPPED (docs/arch/04-alignment.md §3.1).
                            if len(piece) < plan.samples:
                                piece = torch.nn.functional.pad(piece, (0, plan.samples - len(piece)))
                            out = model(piece.unsqueeze(0).to(model_device))
                            # A tuple from torchaudio-backed models, `.logits` from HF-backed ones.
                            logits = out[0] if isinstance(out, tuple) else out.logits
                            # Back to CPU immediately: the matrix outlives this pass in a cache.
                            got = torch.log_softmax(logits, dim=-1)[0].cpu()
                            # EQUALITY, NOT A MINIMUM (docs/arch/04-alignment.md §3.1).
                            expected = (plan.samples - _FRAME_FIELD_SAMPLES) // _FRAME_HOP_SAMPLES + 1
                            if len(got) != expected:
                                raise ValueError(
                                    f"{bundle} produced {len(got)} frames from {plan.samples} samples "
                                    f"where the 320/400 grid needs exactly {expected}; this model's "
                                    "frame rate is not the one `FRAME_SEC` describes"
                                )
                            # Context frames DISCARDED, and CLONED rather than sliced: a view would hold its
                            # whole parent alive until the `cat` (docs/arch/04-alignment.md §3.1).
                            chunks.append(got[plan.trim : plan.trim + plan.keep].clone())
                    matrix = torch.cat(chunks) if chunks else torch.zeros((0, 0))
                except Exception as failed:
                    # The pass reads no text, so whatever it raises is the device's or the model's.
                    raise _machinery_fault(f"the emission pass on {model_device}", failed) from failed
                dictionary = dict(metadata.get("dictionary") or {})
                return Emissions(
                    log_probs=matrix,
                    # The MODEL's hop, never a ratio off this matrix; an EMPTY matrix keeps 0.0.
                    frame_sec=FRAME_SEC if matrix.shape[0] else 0.0,
                    dictionary=dictionary,
                    model=bundle,
                    blank_id=blank_id_of(dictionary),
                    specials=specials_of(dictionary),
                )

            content = _content_key(audio_path)
            if content is None:
                return build()
            return _cached_emissions((*content, bundle, language, self._device), build, self._matrices)

    def align(self, search: Sequence[Segment], audio_path: str, language: str) -> Sequence[Segment]:
        # CHECKED FIRST, so the failure names the contract rather than surfacing as `KeyError: 'start'` from
        # inside whisperx's cropping loop. A plain `ValueError` and NOT an `InfraFault`: one attempt is
        # failing on one text's shape, which `spread_over` can reach on an unknown duration.
        untimed = [
            index
            for index, segment in enumerate(search)
            if not isinstance(segment.get("start"), (int, float)) or isinstance(segment.get("start"), bool)
        ]
        if untimed:
            raise ValueError(
                f"the aligner needs a start on every search segment (missing on {len(untimed)} of "
                f"{len(search)}); whisperx crops the audio per segment. Give untimed text provisional "
                "spans with domain.lyrics.place.spread_over first."
            )
        with ML_LOCK:
            import whisperx  # noqa: PLC0415

            model, metadata = self._aligner(language)
            audio = whisperx.load_audio(audio_path)
            # The search spans ARE the input segments, whisperX cropping per segment — which is what
            # `Knob.DROP_WINDOWS` widens.
            aligned = whisperx.align(
                [dict(s) for s in search], model, metadata, audio, self._device, return_char_alignments=False
            )
            segments = aligned.get("segments") if isinstance(aligned, dict) else None
            if not segments:
                # Raising rather than returning empty: an aligner handed real text that produces no words
                # has failed, which is not a fact about the song. One attempt's failure, not the job's.
                raise RuntimeError("the aligner returned no word-timed segments")
            return tuple(dict(s) for s in segments)


#: Gated on Hugging Face: loading it needs a token whose account accepted its terms, or a cached copy.
DIARIZE_CHECKPOINT = "pyannote/speaker-diarization-3.1"


def diarizer_blocked(checkpoint: str = DIARIZE_CHECKPOINT) -> str | None:
    """Why the diarizer cannot load on this box, or None. Checked ONCE at boot and without importing pyannote.

    With no token and no cached copy every load fails, and a failed load is not cached, so each align job paid
    the attempt again while the box advertised `diarize`. A token that is present but not accepted still
    fails per job, which is the old behaviour.
    """
    try:
        import huggingface_hub  # noqa: PLC0415 - lazy by design; see the module docstring
    except ImportError:
        return None
    if huggingface_hub.get_token():
        return None
    if isinstance(huggingface_hub.try_to_load_from_cache(checkpoint, "config.yaml"), str):
        return None
    return f"{checkpoint} is gated on Hugging Face and this box has no token or cached copy: set HF_TOKEN"


class PyannoteDiarizer:
    """`Diarizer` over pyannote. Optional throughout: a failure degrades, never fails a job.

    FED A PRELOADED WAVEFORM RATHER THAN A PATH, which takes torchcodec off the runtime path and is what
    makes the `diarize` capability honest (docs/arch/05-worker.md §5).
    """

    def __init__(self, *, device: str = "cpu", checkpoint: str = DIARIZE_CHECKPOINT) -> None:
        self._device = device
        self._checkpoint = checkpoint

    @staticmethod
    def _preloaded(audio_path: str) -> dict[str, Any]:
        """The file as pyannote's in-memory input: a `(channel, time)` float32 tensor plus its rate.

        MONO, and not a loss: pyannote downmixes internally anyway.
        """
        import torch  # noqa: PLC0415 - lazy by design; see the module docstring

        from encore_worker.domain.audio.wav import read_wav_mono  # noqa: PLC0415

        signal, rate = read_wav_mono(audio_path)
        # float32 because pyannote's models are, and `[None, :]` for the shape its loader asserts on.
        waveform = torch.from_numpy(signal.astype("float32", copy=False))[None, :]
        return {"waveform": waveform, "sample_rate": int(rate)}

    def diarize(self, audio_path: str) -> Sequence[Segment]:
        # ML_LOCK covers LOADING AND RUNNING (docs/arch/05-worker.md §9.1).
        with ML_LOCK:

            def build() -> Any:
                try:
                    from pyannote.audio import Pipeline  # noqa: PLC0415
                except ImportError as missing:
                    raise ModelUnavailable("pyannote.audio is not installed") from missing
                return Pipeline.from_pretrained(self._checkpoint)

            pipeline = _cached(self._device, f"diarize:{self._checkpoint}", build)
            annotation = pipeline(self._preloaded(audio_path))
            return tuple(
                {"start": float(turn.start), "end": float(turn.end), "speaker": str(speaker)}
                for turn, _track, speaker in annotation.itertracks(yield_label=True)
            )


def asr_offline_gap(checkpoint: str) -> str | None:
    """Why ASR can't run OFFLINE, or None: faster-whisper's own lookup finds `checkpoint` in no cache."""
    if os.path.isdir(checkpoint):
        return None
    try:
        from faster_whisper.utils import download_model  # noqa: PLC0415
        from huggingface_hub.errors import LocalEntryNotFoundError  # noqa: PLC0415
    except ImportError:
        return None
    try:
        download_model(checkpoint, local_files_only=True)
    except LocalEntryNotFoundError:
        return f"whisper {checkpoint} isn't cached and this worker is offline"
    return None


def build_transcriber(
    *, device: str, checkpoint: str, compute: str | None = None
) -> WhisperTranscriber | None:
    """A transcriber, or None when this box has no whisperx. Never raises at build time: a box without it
    should not advertise `align` at all (docs/arch/05-worker.md §9.1)."""
    from encore_worker.host.hardware import module_available

    if not module_available("whisperx"):
        return None
    return WhisperTranscriber(device=device, checkpoint=checkpoint, compute=compute)


def build_aligner(
    *,
    device: str,
    jobs: int = 1,
    model: str | None = None,
    nonlatin_routes: Mapping[str, str] | None = None,
) -> WhisperXAligner | None:
    """The aligner, or None on a box with no whisperx. `jobs` is `Config.concurrency` and sizes the emission
    LRU; `model` is the English bundle, already checked for a calibration row by `__main__.align_model_for`,
    and unset takes THIS DEVICE's default. `nonlatin_routes` is the per-language stage-2 table as
    `__main__.nonlatin_routes_for` resolved it (XA-21)."""
    from encore_worker.host.hardware import module_available

    if not module_available("whisperx"):
        return None
    return WhisperXAligner(
        device=device,
        jobs=jobs,
        model=model or default_align_model(device),
        nonlatin_routes=nonlatin_routes,
    )


def build_diarizer(*, device: str) -> PyannoteDiarizer | None:
    from encore_worker.host.hardware import module_available

    if not module_available("pyannote.audio"):
        return None
    return PyannoteDiarizer(device=device)
