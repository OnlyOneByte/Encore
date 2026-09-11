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
    parse_action,
    parse_backend,
    parse_engine,
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
    assert parse_engine("audiosep") is Engine.AUDIOSEP  # #483: the mel-band RoFormer engine
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
