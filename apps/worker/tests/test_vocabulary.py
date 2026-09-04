"""Enumerated vocabulary: boundary parsing, the declared quality ladder, and capability tokens."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.vocabulary import (  # noqa: E402
    Action,
    Backend,
    Engine,
    Stage,
    capability_token,
    is_upgrade,
    parse_action,
    parse_backend,
    parse_engine,
    quality_rank,
    stages_for,
)


def test_members_are_plain_strings():
    # the str mixin is what lets these drop into dict keys, JSON and argv unchanged
    assert Action.STEMS == "stems"
    assert Stage.SEPARATING == "separating"
    assert Engine.ROFORMER == "roformer"
    assert f"{Backend.MLX}" == "mlx"


def test_separation_actions_are_flagged():
    assert Action.STEMS.is_separation
    assert Action.STEMS_UPGRADE.is_separation
    assert not Action.ALIGN.is_separation


def test_parse_action_rejects_unknown_at_the_boundary():
    assert parse_action("stems-upgrade") is Action.STEMS_UPGRADE
    with pytest.raises(ValueError, match="unknown action"):
        parse_action("stemz")


def test_parse_engine_defaults_when_absent_and_rejects_unknown():
    assert parse_engine(None) is Engine.DEMUCS
    assert parse_engine("") is Engine.DEMUCS
    assert parse_engine("roformer") is Engine.ROFORMER
    with pytest.raises(ValueError, match="unknown engine"):
        parse_engine("spleeter")  # registered as a slot in the design, not a runnable engine


def test_parse_backend_defaults_to_torch_and_rejects_unknown():
    assert parse_backend(None) is Backend.TORCH
    assert parse_backend("mlx") is Backend.MLX
    with pytest.raises(ValueError, match="unknown backend"):
        parse_backend("cuda")  # a DEVICE, not a backend — torch covers cuda/xpu/mps


def test_every_action_has_a_stage_plan_ending_in_work():
    for action in Action:
        plan = stages_for(action)
        assert plan and plan[0] is Stage.DOWNLOADING
    assert stages_for(Action.ALIGN)[-1] is Stage.ALIGNING
    assert stages_for(Action.STEMS_UPGRADE)[-1] is Stage.SEPARATING


# ── the upgrade ladder ────────────────────────────────────────────────────────────
def test_quality_ranks_order_the_ladder_as_designed():
    assert quality_rank(Engine.DEMUCS, "htdemucs") < quality_rank(Engine.DEMUCS, "htdemucs_ft")
    assert quality_rank(Engine.DEMUCS, "htdemucs_ft") < quality_rank(Engine.ROFORMER, "bs-roformer-1297")
    assert quality_rank(Engine.ROFORMER, "bs-roformer-1297") < quality_rank(Engine.ENSEMBLE, "instrumental_clean")


def test_unranked_pair_scores_zero_so_it_never_wins():
    assert quality_rank(Engine.DEMUCS, "not-a-model") == 0
    assert is_upgrade((Engine.DEMUCS, "htdemucs"), (Engine.DEMUCS, "not-a-model")) is False


def test_upgrade_requires_strictly_better():
    fast = (Engine.DEMUCS, "htdemucs")
    better = (Engine.DEMUCS, "htdemucs_ft")
    best = (Engine.ENSEMBLE, "instrumental_clean")
    assert is_upgrade(fast, better) is True
    assert is_upgrade(fast, best) is True
    assert is_upgrade(better, fast) is False  # never regress
    assert is_upgrade(better, better) is False  # equal is not an upgrade, so a re-cook is a no-op


def test_missing_current_counts_as_an_upgrade():
    assert is_upgrade(None, (Engine.DEMUCS, "htdemucs")) is True


# ── capability tokens ─────────────────────────────────────────────────────────────
def test_demucs_torch_keeps_the_bare_stems_token():
    # existing workers advertise exactly 'stems'; the scheme must not break their routing
    assert capability_token(Action.STEMS, Engine.DEMUCS, Backend.TORCH) == "stems"
    assert capability_token(Action.STEMS_UPGRADE, Engine.DEMUCS) == "stems-upgrade"


def test_non_default_engine_and_backend_extend_the_token():
    assert capability_token(Action.STEMS, Engine.ROFORMER) == "stems:roformer"
    assert capability_token(Action.STEMS, Engine.DEMUCS, Backend.MLX) == "stems:mlx"
    assert capability_token(Action.STEMS, Engine.ROFORMER, Backend.MLX) == "stems:roformer:mlx"
