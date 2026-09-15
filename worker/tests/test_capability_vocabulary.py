"""Capability routing tokens as a vocabulary, and the gap that being strings left open.

The tokens were hand-typed at three sites that had to agree: the probes in `capabilities.py` that author
them, and two literal lists in `dial_home._build_processor` that decide which runners get built.
`stems:audiosep` reached the probes and one of the two lists, so a box with `audio-separator` and no
demucs advertised it, matched the core's `stems` routing on the `stems:` prefix, and bound NO stems
runner — it accepted separation work it could not run a single job of.

The regression test here is `test_an_audiosep_only_box_binds_a_stems_runner`. The rest pin the property
that prevents a repeat: family membership is DERIVED from the enum's members, not from a second list.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src import capabilities as caps_mod  # noqa: E402
from src.config import WorkerConfig  # noqa: E402
from src.dial_home import _build_processor  # noqa: E402
from src.protocol import WorkerState  # noqa: E402
from src.vocabulary import Capability, serves_family  # noqa: E402


def _cfg(caps: tuple[str, ...]) -> WorkerConfig:
    base = WorkerConfig.from_env({"ENCORE_CORE_WS": "ws://x", "MEDIA_DIR": "/m"})
    return type(base)(**{**base.__dict__, "capabilities": caps})


# ── the regression ───────────────────────────────────────────────────────────────────────────────


def test_an_audiosep_only_box_binds_a_stems_runner() -> None:
    """THE BUG. A box proving only `stems:audiosep` used to bind nothing while advertising stems."""
    proc = _build_processor(_cfg((Capability.STEMS_AUDIOSEP,)))
    assert "stems" in proc._by_type, (
        "an audio-separator-only worker advertises stems (the core matches the `stems:` prefix) but "
        "bound no stems runner, so it accepted separation jobs it could not run"
    )
    assert "stems-upgrade" in proc._by_type


def test_every_stems_family_token_binds_a_stems_runner() -> None:
    """Generalised, and derived — a future `stems:whatever` is covered without editing this test."""
    for cap in Capability.in_family("stems"):
        if cap is Capability.STEMS_ENSEMBLE:
            continue  # never advertised: no ensemble engine exists (same treatment as Backend.OPENVINO)
        proc = _build_processor(_cfg((cap,)))
        assert "stems" in proc._by_type, f"{cap} advertises stems work but binds no runner"


def test_what_the_worker_advertises_and_what_it_binds_cannot_disagree() -> None:
    """The honesty contract, stated directly: if the core would route it here, a runner must exist."""
    for cap in Capability:
        if cap is Capability.STEMS_ENSEMBLE:
            continue
        state = WorkerState(worker_id="w", capabilities=[cap], concurrency=1)
        bound = _build_processor(_cfg((cap,)))._by_type
        for action in ("fetch", "stems", "align"):
            if state.supports(action):
                assert action in bound, (
                    f"advertising {cap!r} makes the core route {action!r} here, but no {action!r} "
                    f"runner is bound — only {sorted(bound)}"
                )


# ── the vocabulary ───────────────────────────────────────────────────────────────────────────────


def test_the_family_is_the_part_before_the_colon() -> None:
    assert Capability.STEMS_ROFORMER.family == "stems"
    assert Capability.STEMS.family == "stems"
    assert Capability.FETCH_YTDLP.family == "fetch"
    assert Capability.ALIGN.family == "align"
    assert Capability.DIARIZE.family == "diarize"


def test_in_family_is_derived_from_the_members_not_a_second_list() -> None:
    """The anti-drift property. A hardcoded frozenset is what lost `stems:audiosep` in the first place."""
    stems = set(Capability.in_family("stems"))
    assert stems == {
        Capability.STEMS,
        Capability.STEMS_ROFORMER,
        Capability.STEMS_AUDIOSEP,
        Capability.STEMS_ENSEMBLE,
    }
    # Every member is in exactly its own family, so none can be orphaned from the checks.
    for cap in Capability:
        assert cap in Capability.in_family(cap.family)


def test_every_probed_token_is_a_known_capability() -> None:
    """The probes and the enum are one vocabulary — a token authored outside it would show up here."""
    probed = {p.token for p in caps_mod.probe_all()}
    assert probed == set(Capability), f"probes and vocabulary disagree: {probed ^ set(Capability)}"


def test_serves_family_tolerates_a_token_this_build_does_not_know() -> None:
    """`ENCORE_WORKER_CAPABILITIES` is free text; `resolve` warns and drops, so this must not raise."""
    assert serves_family(["stems:future-engine"], "stems") is True
    assert serves_family(["something-else"], "stems") is False
    assert serves_family([], "stems") is False


def test_serves_family_does_not_match_a_different_family_by_prefix() -> None:
    """`stems-upgrade` is an ACTION, not a stems capability — a sloppy prefix test would match it."""
    assert serves_family(["stems-upgrade"], "stems") is False
    assert serves_family(["fetch:ytdlp"], "stem") is False


def test_the_enum_is_usable_everywhere_a_plain_string_was() -> None:
    """The `str` mixin is what makes adoption additive rather than a migration."""
    import json

    assert Capability.STEMS_AUDIOSEP == "stems:audiosep"
    assert Capability.STEMS_AUDIOSEP in ("stems:audiosep", "x")
    assert json.dumps([Capability.ALIGN]) == '["align"]', "must reach the wire as its value"
    assert f"{Capability.ALIGN}" == "align"


def test_narrow_for_backend_still_keys_on_the_plain_stems_token() -> None:
    """It drops `stems` only — roformer and audiosep run through their own CLIs, backend-independent."""
    caps = (Capability.STEMS, Capability.STEMS_ROFORMER, Capability.STEMS_AUDIOSEP)
    narrowed, warnings = caps_mod.narrow_for_backend(caps, "openvino")
    assert Capability.STEMS not in narrowed
    assert Capability.STEMS_ROFORMER in narrowed and Capability.STEMS_AUDIOSEP in narrowed
    assert len(warnings) == 1 and "openvino" in warnings[0]
