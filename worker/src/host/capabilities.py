"""What this worker can PROVE it can do.

A worker's capabilities decide what the core will route to it. A hand-typed, unverified env string
is dangerous: advertise `stems` alone and a song sits at 0% forever, claimed by nothing —
indistinguishable from a hung worker.

So capabilities are DERIVED here: every token is backed by a probe answering "is the thing that
executes this actually present", with the reason recorded either way. `ENCORE_WORKER_CAPABILITIES`
survives as an override that can only NARROW the proven set, never extend it — claiming a capability
the box cannot honour is exactly the failure being removed.

Probes are import-free where possible (`find_spec`, `shutil.which`) so building this list does not
drag multi-GB of torch into the dial-home process — the lazy-import discipline in dial_home.py
depends on that.
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass

from ..vocabulary import Capability
from .backends import _module_available


@dataclass(frozen=True)
class Probe:
    """One capability and the evidence for or against it."""

    #: A `Capability` in practice. Typed as `str` because an override can name a token this build
    #: does not know, and `resolve` reports that as unprovable rather than raising.
    token: str
    available: bool
    reason: str


def _either(module: str, binary: str) -> tuple[bool, str]:
    """Present if the module imports OR the CLI is on PATH.

    Both count because the worker shells out by NAME for the heavy lifting, so a box can be capable
    with the CLI installed and the module invisible to this interpreter (a venv-vs-system-python split).
    """
    if shutil.which(binary):
        return True, f"{binary} on PATH"
    if _module_available(module):
        return True, f"{module} importable"
    return False, f"neither {binary} on PATH nor {module} importable"


def probe_all(
    *,
    ytdlp_bin: str = "yt-dlp",
    demucs_bin: str = "demucs",
    roformer_bin: str = "bs-roformer-infer",
    audiosep_bin: str = "audio-separator",
) -> list[Probe]:
    """Probe every capability this worker could advertise. Order is the process order, so the startup
    log reads as the pipeline it describes."""
    probes: list[Probe] = []

    fetch_ok, fetch_why = _either("yt_dlp", ytdlp_bin)
    probes.append(Probe(Capability.FETCH_YTDLP, fetch_ok, fetch_why))

    stems_ok, stems_why = _either("demucs", demucs_bin)
    probes.append(Probe(Capability.STEMS, stems_ok, stems_why))

    rof_ok, rof_why = _either("bs_roformer", roformer_bin)
    probes.append(Probe(Capability.STEMS_ROFORMER, rof_ok, rof_why))

    asep_ok, asep_why = _either("audio_separator", audiosep_bin)
    probes.append(Probe(Capability.STEMS_AUDIOSEP, asep_ok, asep_why))

    # No ensemble engine is implemented, so `stems:ensemble` is NEVER advertised — kept in the
    # vocabulary (mirroring the OPENVINO backend precedent) so configuration/routing can name it.
    probes.append(
        Probe(
            Capability.STEMS_ENSEMBLE,
            False,
            "no ensemble engine implemented"
            if stems_ok and rof_ok
            else "no ensemble engine implemented (and needs both demucs and roformer)",
        )
    )

    align_ok = _module_available("whisperx")
    probes.append(
        Probe(
            Capability.ALIGN,
            align_ok,
            "whisperx importable" if align_ok else "whisperx not importable",
        )
    )

    # Diarization is opt-in and rides the `align` action rather than a new job type, so an align
    # worker without pyannote (HF-gated, heavy) simply publishes single-colour lyrics.
    diarize_ok = _module_available("pyannote.audio")
    probes.append(
        Probe(
            Capability.DIARIZE,
            diarize_ok,
            "pyannote.audio importable" if diarize_ok else "pyannote.audio not importable",
        )
    )

    return probes


def missing_js_runtime(*, ytdlp_bin: str = "yt-dlp") -> str | None:
    """Warn when yt-dlp is present but no JavaScript runtime is.

    YouTube's player challenge cannot be solved without a JS runtime, and the degradation is silent
    and total: every process dies at download with an error that reads as a broken worker rather than
    a missing dependency. Deliberately a WARNING, not a veto on `fetch:ytdlp`.
    """
    if not shutil.which(ytdlp_bin):
        return None
    if any(shutil.which(rt) for rt in ("deno", "node", "bun")):
        return None
    return (
        f"{ytdlp_bin} is present but no JavaScript runtime (deno/node/bun) is on PATH; YouTube's "
        "player challenge cannot be solved, so downloads will fail with 'Requested format is not "
        "available'. Install deno."
    )


def resolve(
    override: tuple[str, ...] | None = None,
    *,
    ytdlp_bin: str = "yt-dlp",
    demucs_bin: str = "demucs",
    roformer_bin: str = "bs-roformer-infer",
    audiosep_bin: str = "audio-separator",
) -> tuple[tuple[str, ...], list[Probe], list[str]]:
    """The capability set this worker advertises.

    Returns (capabilities, probes, warnings). `override` narrows the proven set; anything in it that
    was not proven is dropped WITH a warning naming the evidence, so the drop is diagnosable rather
    than moving the mystery somewhere else.
    """
    probes = probe_all(
        ytdlp_bin=ytdlp_bin, demucs_bin=demucs_bin, roformer_bin=roformer_bin, audiosep_bin=audiosep_bin
    )
    proven = {p.token for p in probes if p.available}
    warnings: list[str] = []

    js = missing_js_runtime(ytdlp_bin=ytdlp_bin)
    if js:
        warnings.append(js)

    if override:
        requested = set(override)
        unprovable = requested - proven
        for token in sorted(unprovable):
            why = next((p.reason for p in probes if p.token == token), "not a known capability")
            warnings.append(
                f"ENCORE_WORKER_CAPABILITIES asks for {token!r} but this box cannot prove it ({why}); "
                "dropping it — the core would route work here that could never complete"
            )
        caps = requested & proven
    else:
        caps = proven

    if not caps:
        # Not fatal: failing to start would hide the diagnosis behind a worker that never even connects.
        warnings.append(
            "this worker can prove NO capabilities — it will connect but never be given work. "
            "Check that yt-dlp/demucs/whisperx are installed and on PATH."
        )

    # Sorted so the advertised set is stable across restarts.
    return tuple(sorted(caps)), probes, warnings


def narrow_for_backend(
    capabilities: tuple[str, ...], backend: str | None
) -> tuple[tuple[str, ...], list[str]]:
    """Drop any stems capability the RESOLVED separator backend cannot build an engine for.

    Runs at the ONE site with both the proven capability set and the resolved backend in hand
    (`dial_home._build_processor`, right after `resolve_backend`) — cannot fold into `resolve` above
    because the backend is resolved AFTER the capability set is fixed.

    Needed because `resolve` proves `stems` from module/CLI presence alone, but the resolved backend
    DRIVES which demucs engine actually runs and only `torch` has an implementation: an Apple-Silicon
    box with both `demucs` and `demucs-mlx` importable proves `stems`, auto-resolves to `mlx`, and
    would otherwise advertise `stems` then kill every process at plan selection.

    Only `stems` is backend-driven: `stems:roformer` runs through its own CLI regardless.
    """
    from ..separation.engines import demucs_engine_backed_by

    if Capability.STEMS not in capabilities or demucs_engine_backed_by(backend):
        return capabilities, []

    narrowed = tuple(c for c in capabilities if c != Capability.STEMS)
    warning = (
        f"dropping capability 'stems': the resolved separator backend {backend!r} has no demucs "
        "engine implementation, so this box would accept stems processes and then fail every one of them "
        "non-retryably at plan selection. Set ENCORE_SEPARATOR_BACKEND=torch to run the portable "
        "engine, or leave it unset to auto-select an available backend."
    )
    return narrowed, [warning]
