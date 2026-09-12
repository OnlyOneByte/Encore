"""What this worker can PROVE it can do.

A worker's capabilities decide what the core will route to it. They used to be a hand-typed env
string sent unverified, and the failure that produces is uniquely nasty: advertise `stems` alone and
the core still enqueues `fetch` and `align`, nothing ever claims them, and the song sits at 0%
forever. From the outside that is indistinguishable from a hung worker, so the operator restarts a
process that was working correctly. That bug has been hit twice on this project and both times the
fix was to change the default string — which leaves the next mistyped deployment to rediscover it.

So capabilities are DERIVED here instead. Every token is backed by a probe that answers "is the thing
that executes this actually present", and the reason is recorded either way so startup logs say why a
capability is missing rather than leaving the operator to infer it from a stalled song.

The env var survives as an override that can only NARROW the proven set. Subtracting is legitimate —
"this box has demucs but I want it to only fetch" is a real fleet layout. Adding is not: a claim the
box cannot honour is precisely the failure being removed, and the worker would accept the job and
then fail it (or worse, sit on it).

Probes are import-free where possible (`find_spec`, `shutil.which`) so building this list does not
drag multi-GB of torch into the dial-home process — the lazy-import discipline in dial_home.py
depends on that.
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass

from .backends import _module_available


@dataclass(frozen=True)
class Probe:
    """One capability and the evidence for or against it."""

    token: str
    available: bool
    reason: str


def _either(module: str, binary: str) -> tuple[bool, str]:
    """Present if the module imports OR the CLI is on PATH.

    Both count because the worker shells out by NAME for the heavy lifting (demucs, bs-roformer-infer
    and yt-dlp all run as subprocesses), so a box can be perfectly capable with the CLI installed and
    the module invisible to this interpreter — a venv-vs-system-python split, which is the normal
    shape of a native install.
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
    probes.append(Probe("fetch:ytdlp", fetch_ok, fetch_why))

    stems_ok, stems_why = _either("demucs", demucs_bin)
    probes.append(Probe("stems", stems_ok, stems_why))

    rof_ok, rof_why = _either("bs_roformer", roformer_bin)
    probes.append(Probe("stems:roformer", rof_ok, rof_why))

    # python-audio-separator: the mel-band RoFormer engine, run through the `audio-separator`
    # CLI. Advertised only when the dep is present — the same honesty contract as every other token, so
    # the parity guard (test_every_advertised_stems_capability_resolves_to_a_real_engine) holds:
    # engine_for("audiosep") builds a real AudioSepEngine, so a box advertising this can actually run it.
    asep_ok, asep_why = _either("audio_separator", audiosep_bin)
    probes.append(Probe("stems:audiosep", asep_ok, asep_why))

    # An ensemble would run both engines and keep the better result, so it would need both present.
    # But no ensemble engine is implemented: `engine_for` (separation/engines.py) has branches for
    # `demucs` and `roformer` only, so an ensemble upgrade dispatches and then raises `RuntimeError:
    # no separator engine: ensemble` at plan selection — the exact "the box cannot honour this claim"
    # failure this module exists to remove, and it also defeats the core's unservable-capability
    # diagnostic (worker-hub.ts) which would otherwise name the missing capability cleanly.
    #
    # So the token is NOT advertised until an engine backs it, mirroring the OPENVINO backend one
    # domain over (backends.py): kept in the vocabulary so configuration and routing can name it, but
    # it never reports available. `stems_ok`/`rof_ok` are read only so the reason can distinguish
    # "engine unimplemented" from "engines absent"; neither can flip this to available.
    probes.append(
        Probe(
            "stems:ensemble",
            False,
            "no ensemble engine implemented"
            if stems_ok and rof_ok
            else "no ensemble engine implemented (and needs both demucs and roformer)",
        )
    )

    align_ok = _module_available("whisperx")
    probes.append(
        Probe(
            "align",
            align_ok,
            "whisperx importable" if align_ok else "whisperx not importable",
        )
    )

    # Diarization — the SOURCE of duet part attribution. Its own probe because an advertised
    # capability the box cannot run is the exact failure this module exists to remove: pyannote is
    # HF-gated (needs a token this box may not have) and heavy, so `diarize` is opt-in and reports
    # available only when the pipeline can actually be imported. It rides the `align` action rather
    # than a new job type, so an align worker without pyannote simply publishes single-colour lyrics —
    # the owner's fallback — and this token stays absent rather than promising work that would degrade.
    diarize_ok = _module_available("pyannote.audio")
    probes.append(
        Probe(
            "diarize",
            diarize_ok,
            "pyannote.audio importable" if diarize_ok else "pyannote.audio not importable",
        )
    )

    return probes


def missing_js_runtime(*, ytdlp_bin: str = "yt-dlp") -> str | None:
    """Warn when yt-dlp is present but no JavaScript runtime is.

    YouTube's player challenge (the signature and `n` parameters) cannot be solved without a JS
    runtime, and the degradation is silent and total: extraction narrows until no audio-only format
    resolves at all, so every process dies at download with "Requested format is not available" — which
    reads as a broken worker rather than a missing dependency.

    Deliberately a WARNING, not a veto on `fetch:ytdlp`. Making it fatal would strip the capability
    from a deployment that is currently limping along successfully, and the honest signal is "this
    will fail at download", not "this box cannot fetch".
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
    was not proven is dropped WITH a warning naming the evidence, because silently honouring an
    unprovable claim is the whole failure mode, and silently dropping it without saying so just moves
    the mystery somewhere else.
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
        # Not fatal: a worker with no capabilities is useless but harmless, and it must still connect
        # so its startup log (and its hardware report) reach the operator. Failing to start would hide
        # the very diagnosis they need.
        warnings.append(
            "this worker can prove NO capabilities — it will connect but never be given work. "
            "Check that yt-dlp/demucs/whisperx are installed and on PATH."
        )

    # Sorted so the advertised set is stable across restarts: an unordered set would make the core's
    # logs and the worker's differ run to run for no reason.
    return tuple(sorted(caps)), probes, warnings


def narrow_for_backend(
    capabilities: tuple[str, ...], backend: str | None
) -> tuple[tuple[str, ...], list[str]]:
    """Drop any stems capability the RESOLVED separator backend cannot build an engine for.

    Returns (narrowed_capabilities, warnings). This is the second half of the honesty contract the
    module header describes, and it runs at the ONE site that has both the proven capability set and
    the resolved backend in hand (`dial_home._build_processor`, right after `resolve_backend`). It
    must, because ordering forbids folding it into `resolve` above: the backend is resolved AFTER the
    capability set is fixed (the backend probe depends on `cfg.separator_backend`/`cfg.device`, and
    resolving it eagerly for a fetch-only box would be work that box never needs).

    Why it is needed at all: `resolve` proves `stems` from `_either("demucs", demucs_bin)` — the
    module or CLI is present — but an earlier change made the resolved backend DRIVE which demucs engine runs, and
    only `torch` has an implementation. So an Apple-Silicon box with `demucs` importable AND
    `demucs-mlx` importable proves `stems`, AUTO-resolves the backend to `mlx`, and advertises `stems`
    anyway — then kills every process it is handed when `engine_for("demucs", backend="mlx")` raises at
    plan selection (the advertise→process→die failure this module exists to remove). Narrowing here makes
    the box refuse the work at boot instead: honest, and diagnosable from the startup log.

    Only `stems` is backend-driven. `stems:roformer` runs through its own CLI regardless of the demucs
    backend, so it is untouched; `stems:ensemble` is already never advertised (no ensemble engine).
    Mirrors the two in-repo precedents for an unimplemented executor (`stems:ensemble`, `OPENVINO`):
    the token stays in the vocabulary, it just never reports available on this box. No new token is
    introduced — capabilities key on the engine, not the backend (test_architecture_capability_tokens).
    """
    from .separation.engines import demucs_engine_backed_by

    if "stems" not in capabilities or demucs_engine_backed_by(backend):
        return capabilities, []

    narrowed = tuple(c for c in capabilities if c != "stems")
    warning = (
        f"dropping capability 'stems': the resolved separator backend {backend!r} has no demucs "
        "engine implementation, so this box would accept stems processes and then fail every one of them "
        "non-retryably at plan selection. Set ENCORE_SEPARATOR_BACKEND=torch to run the portable "
        "engine, or leave it unset to auto-select an available backend."
    )
    return narrowed, [warning]
