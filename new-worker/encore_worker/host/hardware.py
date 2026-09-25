"""What THIS box can do, probed rather than assumed.

Two things live here and they answer different questions:

  * `probe()` — a description of the machine, for the dashboard. Best-effort by contract: a diagnostic
    must never fail a handshake, so every field is optional and a failed probe omits rather than guesses.
  * `resolve_backend()` — which separator implementation will actually run. That one is load-bearing: a
    Mac announcing `mlx` must not run torch demucs while reporting `torch`, and a box that advertises
    `stems` with no engine behind it accepts separation work and then fails every job of it.

IMPORT-FREE WHERE POSSIBLE. `find_spec` and `shutil.which` answer "is it installed" without importing
it, which matters because importing torch costs seconds and several hundred megabytes of RSS — paid on a
box that may only ever serve align jobs.
"""

from __future__ import annotations

import importlib.util
import platform
import shutil
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Report:
    """A description of this machine. Every field past `machine` is optional and may be absent."""

    machine: str
    python: str
    platform: str
    #: "cuda" / "mps" / "cpu". Derived from what is importable AND usable, never from the OS alone.
    accelerator: str = "cpu"
    apple_silicon: bool = False
    torch_version: str | None = None
    device_name: str | None = None

    @property
    def cuda(self) -> bool:
        """Derived so it cannot disagree with `accelerator`. False for ROCm, which reports as cuda."""
        return self.accelerator == "cuda"


def module_available(name: str) -> bool:
    """Is this importable, without importing it?

    `find_spec` raises for a package whose PARENT is missing, which is a miss rather than an error —
    `pyannote.audio` on a box with no pyannote is the common case.
    """
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def binary_available(name: str) -> bool:
    return shutil.which(name) is not None


def is_apple_silicon() -> bool:
    return platform.system() == "Darwin" and platform.machine() in ("arm64", "aarch64")


def probe() -> Report:
    """Describe this box. Never raises — a diagnostic that fails a handshake is worse than a vague one."""
    base = Report(
        machine=platform.machine(),
        python=platform.python_version(),
        platform=platform.platform(),
        apple_silicon=is_apple_silicon(),
    )
    if not module_available("torch"):
        return base
    try:
        import torch  # noqa: PLC0415 - deliberately lazy; see the module docstring
    except Exception:  # noqa: BLE001 - a broken install must degrade to the base report
        return base

    accelerator = "cpu"
    device_name: str | None = None
    try:
        if torch.cuda.is_available():
            accelerator = "cuda"
            device_name = torch.cuda.get_device_name(0)
        elif getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
            accelerator = "mps"
            device_name = "Apple GPU"
    except Exception:  # noqa: BLE001 - probing a driver can fail on a misconfigured box
        accelerator = "cpu"

    return Report(
        machine=base.machine,
        python=base.python,
        platform=base.platform,
        accelerator=accelerator,
        apple_silicon=base.apple_silicon,
        torch_version=str(getattr(torch, "__version__", "")) or None,
        device_name=device_name,
    )


@dataclass(frozen=True, slots=True)
class Backend:
    """The resolved separator backend, and why.

    `why` is not decoration: "auto-selected mlx (Apple Silicon)" and "explicitly configured mlx" behave
    identically but mean different things when a box turns out to be separating on the wrong engine.
    """

    name: str
    why: str


def resolve_backend(configured: str | None, *, report: Report | None = None) -> Backend:
    """Which separator implementation will run.

    An EXPLICIT setting always wins, even when the box cannot honour it: the failure then names the
    setting, which is what an operator who typed it needs. Auto-selection prefers mlx on Apple Silicon
    (Metal, and materially faster there) and otherwise torch.
    """
    if configured:
        return Backend(configured, f"explicitly configured {configured}")
    box = report if report is not None else probe()
    if box.apple_silicon and module_available("demucs_mlx"):
        return Backend("mlx", "auto-selected mlx (Apple Silicon, demucs_mlx present)")
    return Backend("torch", "auto-selected torch")


def capabilities(*, backend: str, ytdlp: str = "yt-dlp", ffmpeg: str = "ffmpeg") -> frozenset[str]:
    """What this box can PROVE it can do, so the core only routes work it can finish.

    NARROWED BY BACKEND, and that narrowing is the point rather than a tidy-up. Presence of `demucs`
    proves the models are installed, but the resolved backend decides which engine actually runs — an
    Apple-Silicon box with both demucs and demucs_mlx installed resolves to `mlx`, and if it advertised
    `stems` while only a torch engine existed it would accept separation work and fail every job of it
    at plan selection, non-retryably.
    """
    caps: set[str] = set()
    if binary_available(ytdlp):
        caps.add("fetch:ytdlp")
    if module_available("whisperx"):
        caps.add("align")

    # ADVERTISED BUT NOT ROUTED ON, and that is core's current behaviour rather than an oversight here:
    # `requiredCapability` maps only fetch/stems/stems-upgrade/align, and core's source never mentions
    # `diarize` at all. So this changes no dispatch — it restores what the old worker reported, which is
    # what an operator reads off the dashboard to tell a box that can attribute lines to singers from one
    # that publishes single-colour lyrics.
    #
    # Gated on the module because diarization IS an import here rather than a subprocess, unlike roformer
    # below — pyannote is HF-gated and heavy, and a box without it simply attributes nothing.
    if module_available("pyannote.audio"):
        caps.add("diarize")

    # EVERY stems variant requires ffmpeg, and that is not a tidy-up. `decode_to_wav` shells it to
    # normalise the input, and the silence probe shells it to verify the output — so a box with demucs
    # and no ffmpeg would advertise `stems`, accept separation work, and fail every job at decode. It is
    # the same defect the backend narrowing above exists to prevent, one dependency further out.
    if not binary_available(ffmpeg):
        return frozenset(caps)

    has_engine = module_available("demucs_mlx") if backend == "mlx" else module_available("demucs")
    if has_engine:
        caps.add("stems")
    # GATED ON THE CLI, not on the importable module — and that distinction was a real bug. The module
    # being present proves the checkpoint code is installed; only the BINARY proves this box can run it,
    # because the engine shells out rather than importing. Advertising on the module alone meant a box
    # could claim `stems:roformer`, be handed a `stems-upgrade` job by the core (roformer is the default
    # upgrade engine), and separate it with DEMUCS instead — publishing demucs output labelled as the
    # upgrade, which no log would contradict.
    if binary_available("bs-roformer-infer"):
        caps.add("stems:roformer")
    # An IMPORT, not a subprocess probe — which only became true with the whisperx 3.8.7rc1 pin: on 3.8.6 the
    # huggingface-hub bound made `mlx-audio` uninstallable alongside whisperx, so this had to run a sidecar
    # interpreter. The rc lifted the bound and the sidecar went with it.
    #
    # Gated on the runtime being INSTALLED, never on the accelerator being Apple Silicon: a Mac without the
    # `mlx` extra cannot run these models, so a hardware-shaped gate would advertise work the box must reject.
    # The platform check is implied — `mlx-audio` only installs on darwin/arm64.
    if module_available("mlx_audio"):
        caps.add("stems:melband-mlx")
    # NOT ADVERTISED, deliberately: `adapters/separate.build_separator` has no audiosep branch, so claiming
    # it would route work here that this worker cannot honour. The old worker has the engine; porting it is
    # tracked in new-worker/README.md's parity notes. Advertising ahead of the implementation is the exact
    # failure the roformer gate above now prevents.
    return frozenset(caps)
