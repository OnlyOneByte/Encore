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

from src.host import capabilities


def _fake_bin(tmp_path, name: str) -> None:
    """Create an executable on a PATH entry, so shutil.which finds it."""
    p = tmp_path / name
    p.write_text("#!/bin/sh\nexit 0\n")
    p.chmod(p.stat().st_mode | stat.S_IXUSR)


def _with_path(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("PATH", str(tmp_path))


def test_a_capability_is_only_advertised_when_it_can_be_proven(monkeypatch, tmp_path):
    _with_path(monkeypatch, tmp_path)
    _fake_bin(tmp_path, "yt-dlp")  # only the fetcher exists on this fake box

    caps, probes, _warnings = capabilities.resolve()
    assert "fetch:ytdlp" in caps
    assert "stems" not in caps, "no demucs on PATH and no importable module — must not be claimed"
    assert "align" not in caps, "whisperx is not importable here"
    # Evidence is recorded either way, so the startup log says WHY rather than a song stuck at 0%.
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
    # Narrowing is legitimate, so no "cannot prove" complaint. Unrelated box warnings pass through.
    assert not any("cannot prove" in w for w in warnings)


def test_an_override_may_NOT_claim_something_unprovable(monkeypatch, tmp_path):
    # Honouring the claim routes work here that can never complete: the original bug, requested politely.
    _with_path(monkeypatch, tmp_path)
    _fake_bin(tmp_path, "yt-dlp")

    caps, _probes, warnings = capabilities.resolve(("fetch:ytdlp", "stems", "align"))
    assert caps == ("fetch:ytdlp",)
    assert any("stems" in w and "cannot prove" in w for w in warnings)
    assert any("align" in w and "cannot prove" in w for w in warnings)


def test_dropping_a_requested_capability_is_never_silent(monkeypatch, tmp_path):
    # Dropping it silently moves the mystery: nothing anywhere would say why align never runs.
    _with_path(monkeypatch, tmp_path)
    _, _probes, warnings = capabilities.resolve(("align",))
    assert warnings, "a dropped capability must be reported"
    assert any("align" in w for w in warnings)


def test_ensemble_is_never_advertised_because_no_engine_implements_it(monkeypatch, tmp_path):
    # No ensemble engine exists, so this token must never be advertised even with both real engines.
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

    # Evidence either way, so the log names WHY rather than an upgrade dying mid-dispatch.
    ens = next(p for p in probes2 if p.token == "stems:ensemble")
    assert not ens.available
    assert "no ensemble engine" in ens.reason


def test_every_advertised_stems_capability_resolves_to_a_real_engine(monkeypatch, tmp_path):
    """A `stems*` capability token routes a separation job to an engine: the core resolves the required
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
        eng = engine_for(engine_name)  # must not raise
        assert eng is not None


def test_audiosep_is_advertised_only_when_its_dep_is_present(monkeypatch, tmp_path):
    # A box with demucs but no audio-separator must NOT claim stems:audiosep, or the core routes a
    # mel-band process that dies at plan selection.
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
    # The worker shells out BY NAME, so a venv-vs-system-python split is a perfectly capable box.
    _with_path(monkeypatch, tmp_path)
    _fake_bin(tmp_path, "demucs")
    caps, probes, _w = capabilities.resolve()
    assert "stems" in caps
    assert "on PATH" in next(p.reason for p in probes if p.token == "stems")


def test_missing_js_runtime_warns_but_does_not_remove_the_fetch_capability(monkeypatch, tmp_path):
    # The player challenge needs a JS runtime and degrades silently and totally, but vetoing fetch would
    # strip the capability from a deployment currently limping along — so a loud WARNING instead.
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


def test_a_worker_that_can_prove_nothing_says_so_and_still_starts(monkeypatch, tmp_path):
    # NOT fatal on purpose: it must still connect so its startup log reaches the operator, since refusing
    # to start hides the diagnosis. Both proof paths must be closed to reach this state — an empty PATH is
    # not enough, because `yt_dlp` is importable in the test interpreter.
    _with_path(monkeypatch, tmp_path)
    monkeypatch.setattr(capabilities, "_module_available", lambda _name: False)
    caps, _p, warnings = capabilities.resolve()
    assert caps == ()
    assert any("prove NO capabilities" in w for w in warnings)


def test_advertised_order_is_stable_across_restarts(monkeypatch, tmp_path):
    # An unordered set makes the core's logs and the worker's differ run to run.
    _with_path(monkeypatch, tmp_path)
    _fake_bin(tmp_path, "yt-dlp")
    _fake_bin(tmp_path, "demucs")
    first, _p, _w = capabilities.resolve()
    second, _p2, _w2 = capabilities.resolve()
    assert first == second == tuple(sorted(first))


def test_stems_survives_on_an_mlx_box(monkeypatch):
    """`stems` is dropped when the resolved backend has no demucs engine, but an Apple-Silicon box
    that auto-resolves to `mlx` HAS one (demucs-mlx CLI + mix-minus derivation), so it must KEEP
    advertising `stems` — dropping it would refuse work it can do.

    Simulates the box exactly as test_backends.py does: patch platform to Darwin/arm64 and make the
    module probe report `demucs_mlx` importable, so the backend genuinely auto-resolves to mlx.
    """
    from src.host import backends, config
    from src.host.config import WorkerConfig

    monkeypatch.setattr("platform.system", lambda: "Darwin")
    monkeypatch.setattr("platform.machine", lambda: "arm64")
    # demucs + demucs_mlx importable; no separator binary on PATH so only the module path counts.
    monkeypatch.setattr(
        backends, "_module_available", lambda name: name in ("demucs", "demucs_mlx", "whisperx")
    )
    monkeypatch.setattr(
        capabilities, "_module_available", lambda name: name in ("demucs", "demucs_mlx", "whisperx")
    )

    # AUTO backend selection (no ENCORE_SEPARATOR_BACKEND) — reachable with no operator action.
    cfg = WorkerConfig(demucs_bin="__no_such_bin__", ytdlp_bin="__no_such_bin__")
    resolved, warnings, _probes = config.resolve(cfg, device=None)

    # sanity: the backend genuinely resolves to mlx on this simulated box
    assert backends.resolve_backend(None).backend.value == "mlx"

    assert "stems" in resolved.capabilities, (
        "an mlx-resolved box now HAS a demucs engine, so it must keep advertising stems"
    )
    assert "align" in resolved.capabilities
    assert not [w for w in warnings if "dropping capability 'stems'" in w], (
        "mlx is backed now, so the drop must not fire"
    )


def test_stems_survives_on_a_torch_box(monkeypatch):
    """The complement: a box whose backend resolves to torch (the portable default with a real engine)
    keeps `stems` and gets no drop warning — the narrowing must not fire when an engine backs the
    resolved backend."""
    from src.host import backends, config
    from src.host.config import WorkerConfig

    # Linux/x86_64, demucs importable, NO demucs_mlx -> AUTO resolves to torch.
    monkeypatch.setattr("platform.system", lambda: "Linux")
    monkeypatch.setattr("platform.machine", lambda: "x86_64")
    monkeypatch.setattr(backends, "_module_available", lambda name: name in ("demucs", "whisperx"))
    monkeypatch.setattr(capabilities, "_module_available", lambda name: name in ("demucs", "whisperx"))
    monkeypatch.setattr(backends, "torch_device_available", lambda d: d in ("", "cpu"))

    cfg = WorkerConfig(demucs_bin="__no_such_bin__", ytdlp_bin="__no_such_bin__")
    resolved, warnings, _probes = config.resolve(cfg, device=None)

    assert backends.resolve_backend(None).backend.value == "torch"
    assert "stems" in resolved.capabilities
    assert not [w for w in warnings if "dropping capability 'stems'" in w]


def test_narrow_for_backend_keys_on_a_real_engine_impl():
    """`demucs_engine_backed_by` decides which backends have an engine, and it cannot drift from
    `engine_for`: it returns True for exactly the backends `engine_for("demucs", backend=b)` builds
    an engine for."""
    from src.separation.engines import MlxDemucsEngine, demucs_engine_backed_by, engine_for

    assert demucs_engine_backed_by("torch") is True
    assert demucs_engine_backed_by(None) is True
    assert demucs_engine_backed_by("mlx") is True
    # openvino is registered but has no runtime and can never RESOLVE; the predicate stays conservative.
    assert demucs_engine_backed_by("openvino") is False
    assert demucs_engine_backed_by("nonsense") is False

    assert engine_for("demucs", backend="torch").backend == "torch"
    assert isinstance(engine_for("demucs", backend="mlx"), MlxDemucsEngine)
    assert engine_for("demucs", backend="mlx").backend == "mlx"

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
    assert capabilities.narrow_for_backend(("align"), "openvino") == (("align"), [])
