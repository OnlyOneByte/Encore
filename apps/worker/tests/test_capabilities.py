"""Capability probing — the fix for the failure that has bitten this deployment twice.

The bug: a worker advertises `stems` alone, the core still enqueues `fetch` and `align`, nothing ever
claims them, and the song sits at 0% forever looking exactly like a hung worker. Both previous fixes
changed the DEFAULT STRING, which leaves the next mistyped deployment to rediscover it. These tests
pin the property that actually removes it — a capability is only advertised if it can be proven.

Probes are driven through the `*_bin` arguments so a fixture can create a fake executable rather than
depending on what happens to be installed on the test machine.
"""

from __future__ import annotations

import stat

from src import capabilities


def _fake_bin(tmp_path, name: str) -> None:
    """Create an executable on a PATH entry, so shutil.which finds it."""
    p = tmp_path / name
    p.write_text("#!/bin/sh\nexit 0\n")
    p.chmod(p.stat().st_mode | stat.S_IXUSR)


def _with_path(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("PATH", str(tmp_path))


# ── the core property ───────────────────────────────────────────────────────────────
def test_a_capability_is_only_advertised_when_it_can_be_proven(monkeypatch, tmp_path):
    _with_path(monkeypatch, tmp_path)
    _fake_bin(tmp_path, "yt-dlp")  # only the fetcher exists on this fake box

    caps, probes, _warnings = capabilities.resolve()
    assert "fetch:ytdlp" in caps
    assert "stems" not in caps, "no demucs on PATH and no importable module — must not be claimed"
    assert "align" not in caps, "whisperx is not importable here"
    # And the evidence is recorded either way, so the startup log can say WHY, rather than leaving the
    # operator to infer it from a song stuck at 0%.
    assert any(p.token == "stems" and not p.available and p.reason for p in probes)


def test_an_override_may_narrow_the_proven_set(monkeypatch, tmp_path):
    # A legitimate fleet layout: this box could fetch and separate, but should only fetch.
    _with_path(monkeypatch, tmp_path)
    _fake_bin(tmp_path, "yt-dlp")
    _fake_bin(tmp_path, "demucs")

    caps, _probes, _w = capabilities.resolve()
    assert {"fetch:ytdlp", "stems"} <= set(caps)

    narrowed, _p, warnings = capabilities.resolve(("fetch:ytdlp",))
    assert narrowed == ("fetch:ytdlp",)
    # Narrowing is legitimate, so it must not produce a "cannot prove" complaint. (Unrelated warnings,
    # like the missing-JS-runtime one, are allowed through — they are about the box, not the override.)
    assert not any("cannot prove" in w for w in warnings)


def test_an_override_may_NOT_claim_something_unprovable(monkeypatch, tmp_path):
    # This is the whole point. Honouring the claim means the core routes work here that can never
    # complete — the original bug, just requested politely.
    _with_path(monkeypatch, tmp_path)
    _fake_bin(tmp_path, "yt-dlp")

    caps, _probes, warnings = capabilities.resolve(("fetch:ytdlp", "stems", "align"))
    assert caps == ("fetch:ytdlp",)
    assert any("stems" in w and "cannot prove" in w for w in warnings)
    assert any("align" in w and "cannot prove" in w for w in warnings)


def test_dropping_a_requested_capability_is_never_silent(monkeypatch, tmp_path):
    # Silently dropping it just moves the mystery: the operator asked for align, the worker does not do
    # align, and nothing anywhere says so.
    _with_path(monkeypatch, tmp_path)
    _, _probes, warnings = capabilities.resolve(("align",))
    assert warnings, "a dropped capability must be reported"
    assert any("align" in w for w in warnings)


# ── specific tokens ─────────────────────────────────────────────────────────────────
def test_ensemble_is_never_advertised_because_no_engine_implements_it(monkeypatch, tmp_path):
    # issue #118: the worker used to advertise `stems:ensemble` whenever both engines were present, but
    # NO ensemble engine exists — `engine_for("ensemble")` raises. So the core would route an ensemble
    # upgrade to this box and the job would die at plan selection with "no separator engine: ensemble",
    # which is the exact "claim the box cannot honour" failure this module exists to remove, and it
    # also defeats the core's unservable-capability diagnostic. The token must never be advertised
    # until an engine backs it (mirroring the OPENVINO backend, which is registered-but-never-available).
    _with_path(monkeypatch, tmp_path)
    _fake_bin(tmp_path, "demucs")

    caps, probes, _w = capabilities.resolve()
    assert "stems" in caps
    assert "stems:ensemble" not in caps

    # Even with BOTH engines present — the case the old code advertised on — it stays unadvertised.
    _fake_bin(tmp_path, "bs-roformer-infer")
    caps2, probes2, _w2 = capabilities.resolve()
    assert {"stems", "stems:roformer"} <= set(caps2)
    assert "stems:ensemble" not in caps2, "no ensemble engine implements this — must not be claimed"

    # The evidence is recorded either way, so the startup log names WHY rather than the operator
    # inferring it from an ensemble upgrade dying mid-dispatch.
    ens = next(p for p in probes2 if p.token == "stems:ensemble")
    assert not ens.available
    assert "no ensemble engine" in ens.reason


def test_every_advertised_stems_capability_resolves_to_a_real_engine(monkeypatch, tmp_path):
    """Parity guard closing issue #118's CLASS, not just its instance.

    A `stems*` capability token routes a separation job to an engine: the core resolves the required
    capability to an `engine` name (bare `stems` -> `demucs`, `stems:<name>` -> `<name>`) which the
    worker feeds to `engine_for` at plan selection. If a token is advertised but `engine_for` cannot
    build an engine for it, the job dispatches and dies. This asserts the ROUTED set (what the worker
    actually claims on a fully-equipped box), not a hand-maintained table — so a future capability
    added without an engine reds here instead of in production.
    """
    from src.separation.engines import engine_for

    # A box with every separator binary present, so the widest possible stems* set is advertised.
    _with_path(monkeypatch, tmp_path)
    _fake_bin(tmp_path, "demucs")
    _fake_bin(tmp_path, "bs-roformer-infer")
    caps, _p, _w = capabilities.resolve()

    stems_caps = [c for c in caps if c == "stems" or c.startswith("stems:")]
    assert stems_caps, "the fully-equipped box must advertise at least the bare `stems` token"
    for token in stems_caps:
        engine_name = "demucs" if token == "stems" else token.split(":", 1)[1]
        # Must not raise: an advertised stems* token that engine_for cannot honour is issue #118.
        eng = engine_for(engine_name)
        assert eng is not None


def test_audiosep_is_advertised_only_when_its_dep_is_present(monkeypatch, tmp_path):
    # #483: the mel-band RoFormer engine (python-audio-separator). Advertised only when the dep is
    # present — the same honesty contract as every other token. A box with demucs but no audio-separator
    # must NOT claim stems:audiosep, or the core would route a mel-band cook that dies at plan selection.
    _with_path(monkeypatch, tmp_path)
    _fake_bin(tmp_path, "demucs")  # separator present, but NOT audio-separator
    monkeypatch.setattr(capabilities, "_module_available", lambda _name: False)

    caps, probes, _w = capabilities.resolve()
    assert "stems" in caps
    assert "stems:audiosep" not in caps, "no audio-separator on PATH and no module — must not be claimed"
    asep = next(p for p in probes if p.token == "stems:audiosep")
    assert not asep.available and asep.reason

    # With the audio-separator CLI present, it is advertised and engine_for builds a real engine.
    _fake_bin(tmp_path, "audio-separator")
    caps2, _p2, _w2 = capabilities.resolve()
    assert "stems:audiosep" in caps2
    from src.separation.engines import AudioSepEngine, engine_for

    assert isinstance(engine_for("audiosep"), AudioSepEngine)


def test_a_cli_on_PATH_counts_even_when_the_module_is_invisible(monkeypatch, tmp_path):
    # The worker shells out BY NAME for the heavy lifting, so a venv-vs-system-python split (the normal
    # shape of a native install) is a perfectly capable box. Requiring the import would deny it.
    _with_path(monkeypatch, tmp_path)
    _fake_bin(tmp_path, "demucs")
    caps, probes, _w = capabilities.resolve()
    assert "stems" in caps
    assert "on PATH" in next(p.reason for p in probes if p.token == "stems")


# ── the JS runtime trap ─────────────────────────────────────────────────────────────
def test_missing_js_runtime_warns_but_does_not_remove_the_fetch_capability(monkeypatch, tmp_path):
    # YouTube's player challenge cannot be solved without a JS runtime, and the degradation is silent
    # and total — every cook dies at download with "Requested format is not available", which reads as
    # a broken worker. But vetoing fetch would strip the capability from a deployment that is currently
    # limping along, so the honest signal is a loud warning.
    _with_path(monkeypatch, tmp_path)
    _fake_bin(tmp_path, "yt-dlp")

    caps, _p, warnings = capabilities.resolve()
    assert "fetch:ytdlp" in caps
    assert any("JavaScript runtime" in w for w in warnings)


def test_no_warning_when_a_js_runtime_is_present(monkeypatch, tmp_path):
    _with_path(monkeypatch, tmp_path)
    _fake_bin(tmp_path, "yt-dlp")
    _fake_bin(tmp_path, "deno")
    assert capabilities.missing_js_runtime() is None


def test_no_js_warning_when_ytdlp_itself_is_absent(monkeypatch, tmp_path):
    # Nothing to warn about: the box is not going to attempt a download at all.
    _with_path(monkeypatch, tmp_path)
    assert capabilities.missing_js_runtime() is None


# ── the useless-worker case ─────────────────────────────────────────────────────────
def test_a_worker_that_can_prove_nothing_says_so_and_still_starts(monkeypatch, tmp_path):
    # Not fatal on purpose: it must still connect so its startup log and hardware report reach the
    # operator. Refusing to start would hide the very diagnosis they need.
    #
    # Both proof paths have to be closed to reach this state: an empty PATH is not enough, because the
    # `yt_dlp` module happens to be importable in the test interpreter — which is itself the behaviour
    # `test_a_cli_on_PATH_counts_even_when_the_module_is_invisible` pins from the other direction.
    _with_path(monkeypatch, tmp_path)
    monkeypatch.setattr(capabilities, "_module_available", lambda _name: False)
    caps, _p, warnings = capabilities.resolve()
    assert caps == ()
    assert any("prove NO capabilities" in w for w in warnings)


def test_advertised_order_is_stable_across_restarts(monkeypatch, tmp_path):
    # An unordered set would make the core's logs and the worker's differ run to run for no reason.
    _with_path(monkeypatch, tmp_path)
    _fake_bin(tmp_path, "yt-dlp")
    _fake_bin(tmp_path, "demucs")
    first, _p, _w = capabilities.resolve()
    second, _p2, _w2 = capabilities.resolve()
    assert first == second == tuple(sorted(first))


# ── issue #606 / #595: advertise `stems` only when the RESOLVED backend has a demucs engine ──────
def test_stems_survives_on_an_mlx_box(monkeypatch):
    """Issue #606 established that `stems` is dropped when the resolved backend has no demucs engine.
    #595 IMPLEMENTED the MLX engine, so an Apple-Silicon box that auto-resolves its backend to `mlx`
    now HAS a demucs engine and must KEEP advertising `stems` — the box can genuinely run the cook
    (demucs-mlx CLI + mix-minus derivation), so dropping it would refuse work it can do.

    This is the inverse of the pre-#595 pin: before, an mlx box dropped `stems` (advertise -> cook ->
    die at the unimplemented engine); now it keeps it and no drop warning fires.

    Simulates the box exactly as test_backends.py does: patch platform to Darwin/arm64 and make the
    module probe report `demucs_mlx` importable, so the backend genuinely auto-resolves to mlx.
    """
    from src import backends, config
    from src.config import WorkerConfig

    monkeypatch.setattr("platform.system", lambda: "Darwin")
    monkeypatch.setattr("platform.machine", lambda: "arm64")
    # demucs + demucs_mlx importable; no separator binary on PATH so only the module path counts.
    monkeypatch.setattr(
        backends, "_module_available", lambda name: name in ("demucs", "demucs_mlx", "whisperx")
    )
    monkeypatch.setattr(
        capabilities, "_module_available", lambda name: name in ("demucs", "demucs_mlx", "whisperx")
    )

    # AUTO backend selection (no ENCORE_SEPARATOR_BACKEND) — the reachable trigger with no operator action.
    cfg = WorkerConfig(demucs_bin="__no_such_bin__", ytdlp_bin="__no_such_bin__")
    resolved, warnings = config.resolve(cfg, device=None)

    # sanity: the backend genuinely resolves to mlx on this simulated box
    assert backends.resolve_backend(None).backend.value == "mlx"

    assert "stems" in resolved.capabilities, (
        "an mlx-resolved box now HAS a demucs engine (#595), so it must keep advertising stems"
    )
    assert "align" in resolved.capabilities
    assert not [w for w in warnings if "dropping capability 'stems'" in w], (
        "mlx is backed now, so the drop must not fire"
    )


def test_stems_survives_on_a_torch_box(monkeypatch):
    """The complement: a box whose backend resolves to torch (the portable default with a real engine)
    keeps `stems` and gets no drop warning — the narrowing must not fire when an engine backs the
    resolved backend."""
    from src import backends, config
    from src.config import WorkerConfig

    # Linux/x86_64, demucs importable, NO demucs_mlx -> AUTO resolves to torch.
    monkeypatch.setattr("platform.system", lambda: "Linux")
    monkeypatch.setattr("platform.machine", lambda: "x86_64")
    monkeypatch.setattr(backends, "_module_available", lambda name: name in ("demucs", "whisperx"))
    monkeypatch.setattr(capabilities, "_module_available", lambda name: name in ("demucs", "whisperx"))
    monkeypatch.setattr(backends, "torch_device_available", lambda d: d in ("", "cpu"))

    cfg = WorkerConfig(demucs_bin="__no_such_bin__", ytdlp_bin="__no_such_bin__")
    resolved, warnings = config.resolve(cfg, device=None)

    assert backends.resolve_backend(None).backend.value == "torch"
    assert "stems" in resolved.capabilities
    assert not [w for w in warnings if "dropping capability 'stems'" in w]


def test_narrow_for_backend_keys_on_a_real_engine_impl():
    """Unit pin on the narrowing primitive and its source of truth. `demucs_engine_backed_by` decides
    which backends have an engine, and it cannot drift from `engine_for`: it returns True for exactly
    the backends `engine_for("demucs", backend=b)` builds an engine for."""
    from src.separation.engines import MlxDemucsEngine, demucs_engine_backed_by, engine_for

    # torch, None (portable default) AND mlx (#595) all build a real demucs engine.
    assert demucs_engine_backed_by("torch") is True
    assert demucs_engine_backed_by(None) is True
    assert demucs_engine_backed_by("mlx") is True
    # A backend name no engine implements is NOT backed (openvino is registered in the enum but has no
    # runtime; it can never be a RESOLVED backend — resolve_backend raises before narrowing — but the
    # predicate is conservative rather than trusting that).
    assert demucs_engine_backed_by("openvino") is False
    assert demucs_engine_backed_by("nonsense") is False

    # `engine_for` builds an engine for every backed backend and the built engine reports that backend,
    # so the predicate the capability site reads cannot drift from the engine the cook actually builds.
    assert engine_for("demucs", backend="torch").backend == "torch"
    assert isinstance(engine_for("demucs", backend="mlx"), MlxDemucsEngine)
    assert engine_for("demucs", backend="mlx").backend == "mlx"

    # narrow_for_backend keeps `stems` for a backed backend (torch, mlx) and leaves other tokens alone.
    caps = ("align", "fetch:ytdlp", "stems", "stems:roformer")
    kept, warns = capabilities.narrow_for_backend(caps, "torch")
    assert kept == caps and warns == []
    kept_mlx, warns_mlx = capabilities.narrow_for_backend(caps, "mlx")
    assert kept_mlx == caps and warns_mlx == []
    # An UNBACKED backend still drops bare `stems` and leaves the engine-scoped tokens alone.
    dropped, warns = capabilities.narrow_for_backend(caps, "openvino")
    assert "stems" not in dropped
    assert set(dropped) == {"align", "fetch:ytdlp", "stems:roformer"}  # only bare `stems` is backend-driven
    assert warns and "openvino" in warns[0]
    # a box that never proved `stems` is untouched even on an unbacked backend
    assert capabilities.narrow_for_backend(("align",), "openvino") == (("align",), [])
