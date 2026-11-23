"""What THIS box can do, probed rather than assumed.

`probe()` describes the machine for the dashboard and is best-effort; `resolve_backend()` and
`capabilities()` are load-bearing, since a box that advertises work it cannot finish accepts it and then
fails it. Import-free where possible, and what each capability gate proves: XW-14, docs/arch/05-worker.md §9
and §9.1.
"""

from __future__ import annotations

import importlib.util
import platform
import shutil
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Report:
    """A description of this machine; every field past `platform` is optional."""

    machine: str
    python: str
    platform: str
    #: "cuda" / "mps" / "cpu", from what is importable AND usable, never from the OS alone.
    accelerator: str = "cpu"
    apple_silicon: bool = False
    torch_version: str | None = None
    device_name: str | None = None

    @property
    def cuda(self) -> bool:
        """Derived so it cannot disagree with `accelerator`. False for ROCm, which reports as cuda."""
        return self.accelerator == "cuda"

    def to_wire(self) -> dict[str, object]:
        """`Hello.host`, in core's `WorkerHost` shape. Unknown fields are omitted, never guessed."""
        fields: dict[str, object | None] = {
            "platform": self.platform,
            "machine": self.machine,
            "python": self.python,
            "torch": self.torch_version,
            "cuda": self.cuda,
            "accelerator": self.accelerator,
            "deviceName": self.device_name,
        }
        return {k: v for k, v in fields.items() if v is not None}


def module_available(name: str) -> bool:
    """Is this importable, without importing it? A missing PARENT package is a miss, not an error."""
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
    """The resolved separator backend, and `why` — which is not decoration (docs/arch/05-worker.md §9.1)."""

    name: str
    why: str


def resolve_backend(configured: str | None, *, report: Report | None = None) -> Backend:
    """Which separator implementation will run. An EXPLICIT setting always wins, even where the box cannot
    honour it (docs/arch/05-worker.md §9.1)."""
    if configured:
        return Backend(configured, f"explicitly configured {configured}")
    box = report if report is not None else probe()
    if box.apple_silicon and module_available("demucs_mlx"):
        return Backend("mlx", "auto-selected mlx (Apple Silicon, demucs_mlx present)")
    return Backend("torch", "auto-selected torch")


def youtube_gap(config_paths: tuple[str, ...], *, deno: str = "deno") -> str | None:
    """What yt-dlp is missing to download from YouTube, or None. A warning, not a capability gate: other
    sites still work, and `fetch:ytdlp` is about the binary.

    YouTube needs deno to solve its player challenge, and `--remote-components ejs:github` to fetch the
    solver. dev.sh and the image set both up (`docker/yt-dlp.conf`); a native boot outside them has neither,
    and every YouTube song fails with "Requested format is not available".
    """
    missing = []
    if not binary_available(deno):
        missing.append("deno on PATH")
    if not any(_mentions(path, "remote-components") for path in config_paths):
        missing.append(f"--remote-components ejs:github in a yt-dlp config ({', '.join(config_paths)})")
    return " and ".join(missing) or None


def _mentions(path: str, text: str) -> bool:
    try:
        with open(path, encoding="utf-8") as fh:
            return text in fh.read()
    except OSError:
        return False


def capabilities(*, backend: str, ytdlp: str = "yt-dlp", ffmpeg: str = "ffmpeg") -> frozenset[str]:
    """What this box can PROVE it can do, so core only routes work it can finish.

    Every gate below is chosen to prove the last thing that could still be missing, and the table of what
    each one is for is docs/arch/05-worker.md §9.1.
    """
    caps: set[str] = set()
    if binary_available(ytdlp):
        caps.add("fetch:ytdlp")
    if module_available("whisperx"):
        caps.add("align")

    # Advertised but not routed on, and gated on the module rather than a binary
    # (docs/arch/05-worker.md §9.1).
    if module_available("pyannote.audio"):
        caps.add("diarize")

    # EVERY stems variant needs ffmpeg: the input is normalised by shelling it and the output verified by
    # shelling it (docs/arch/05-worker.md §9.1).
    if not binary_available(ffmpeg):
        return frozenset(caps)

    has_engine = module_available("demucs_mlx") if backend == "mlx" else module_available("demucs")
    if has_engine:
        caps.add("stems")
    # Gated on the CLI and not the module, which was a real bug (docs/arch/05-worker.md §9.1).
    if binary_available("bs-roformer-infer"):
        caps.add("stems:roformer")
    # The runtime being INSTALLED, never the accelerator being Apple Silicon
    # (docs/arch/05-worker.md §9.1).
    if module_available("mlx_audio"):
        caps.add("stems:melband-mlx")
    # The module is sufficient here in a way it was NOT for roformer, the zoo running in-process
    # (docs/arch/05-worker.md §9.1).
    if module_available("audio_separator"):
        caps.add("stems:audiosep")
    return frozenset(caps)
