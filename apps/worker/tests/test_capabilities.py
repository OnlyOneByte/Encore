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
