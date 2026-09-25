"""The wire contract, asserted in both directions.

Two properties matter more than the individual fields. Outbound: an optional field must be OMITTED
rather than sent as `null`, because that is what keeps a newer worker compatible with an older core.
Inbound: an unparseable or unknown frame must RAISE, because the failure mode being prevented is a
frame whose fields silently defaulted and a worker that acts on it.
"""

from __future__ import annotations

import json
import typing

import pytest

from encore_worker.protocol import frames as f
from encore_worker.protocol.vocabulary import Action, Capability, Stage, serves

# ── outbound ─────────────────────────────────────────────────────────────────────────────────────


def test_every_outbound_frame_is_json_serializable() -> None:
    """Every frame ends up in `json.dumps`, so a tuple or StrEnum that does not survive it is a bug.

    Built with every optional field POPULATED, which is the arm that would catch a `Stage` enum or a
    tuple reaching the encoder unconverted.
    """
    outbound: list[f.ToCore] = [
        f.Hello(
            worker_id="w1",
            capabilities=(Capability.ALIGN, Capability.STEMS),
            concurrency=2,
            version="1",
            backend="mlx",
            device="mps",
            host={"platform": "macOS"},
        ),
        f.Heartbeat(worker_id="w1", slots_free=1, running_job_ids=("j1",)),
        f.Accept(worker_id="w1", job_id="j1"),
        f.Reject(worker_id="w1", job_id="j1", reason="no free slots"),
        f.Progress(worker_id="w1", job_id="j1", stage=Stage.ALIGNING, pct=50, eta_sec=30),
        f.State(
            worker_id="w1",
            job_id="j1",
            state="verify",
            attempt=2,
            knob="align-on-mix",
            verdict="retime",
            why="coverage 0.42",
        ),
        f.Complete(
            worker_id="w1",
            job_id="j1",
            media_uri="media/m1.mp3",
            artifacts={"lyrics": {"candidates": []}},
            facts={"backend": "mlx"},
            selection={"winner": "lrclib"},
            stages=({"stage": "aligning", "ms": 1200},),
            trail=({"state": "verify", "verdict": "accept"},),
        ),
        f.Failed(worker_id="w1", job_id="j1", error="boom", retryable=True),
        f.Claim(worker_id="w1", job_ids=("j1", "j2")),
    ]
    for frame in outbound:
        wire = frame.to_wire()
        assert wire["type"] == frame.TYPE
        # Round-trips through JSON without an encoder hook.
        assert json.loads(json.dumps(wire)) == wire


def test_optional_fields_are_omitted_not_nulled() -> None:
    """An unset optional must be ABSENT. An explicit `null` is not equivalent to an older core."""
    bare = f.Hello(worker_id="w1", capabilities=(), concurrency=1, version="1").to_wire()
    for absent in ("backend", "device", "host"):
        assert absent not in bare, f"{absent} must be omitted when unset, not sent as null"

    progress = f.Progress(worker_id="w1", job_id="j1", stage=Stage.ALIGNING, pct=0).to_wire()
    assert "etaSec" not in progress

    complete = f.Complete(worker_id="w1", job_id="j1", media_uri="m").to_wire()
    assert set(complete) == {"type", "workerId", "jobId", "mediaUri"}


def test_stage_serializes_as_its_wire_string() -> None:
    """The core matches on the string, so a `Stage.ALIGNING` repr reaching the wire would break it."""
    wire = f.Progress(worker_id="w1", job_id="j1", stage=Stage.SEPARATING, pct=10).to_wire()
    assert wire["stage"] == "separating"


def test_outbound_frames_are_immutable() -> None:
    """Frozen, because a frame handed to the transport must not be mutated after it is queued."""
    frame = f.Accept(worker_id="w1", job_id="j1")
    with pytest.raises(AttributeError):
        frame.job_id = "j2"  # type: ignore[misc]


# ── inbound ──────────────────────────────────────────────────────────────────────────────────────


def test_parses_each_inbound_frame() -> None:
    assign = f.parse(
        {
            "type": "job:assign",
            "jobId": "j1",
            "mediaId": "m1",
            "jobType": "align",
            "mediaDir": "/media/m1",
            "sourceUri": "https://example.test/v",
            "params": {"asrModel": "base"},
        }
    )
    assert isinstance(assign, f.Assign)
    assert assign.action == Action.ALIGN
    assert assign.params == {"asrModel": "base"}

    revoked = f.parse({"type": "job:revoked", "jobId": "j1", "reason": "lease expired"})
    assert revoked == f.Revoked(job_id="j1", reason="lease expired")

    ack = f.parse({"type": "job:claim-ack", "owned": ["j1"], "revoked": ["j2"], "unknown": ["j3"]})
    assert ack == f.ClaimAck(owned=("j1",), revoked=("j2",), unknown=("j3",))

    assert f.parse({"type": "ping"}) == f.Ping()
    assert f.parse({"type": "job:cancel", "jobId": "j1"}) == f.Cancel(job_id="j1")
    assert f.parse({"type": "worker:welcome", "workerId": "w1"}) == f.Welcome(worker_id="w1")


def test_claim_ack_keeps_owned_and_revoked_separate() -> None:
    """A job in NEITHER list is `unknown`, never silently "not owned".

    Collapsing unknown into revoked would turn a genuine core/worker desync — the core has never heard
    of a job this worker is running — into an ordinary reassignment, and hide it.
    """
    ack = f.parse({"type": "job:claim-ack", "owned": ["j1"]})
    assert ack == f.ClaimAck(owned=("j1",), revoked=(), unknown=())


@pytest.mark.parametrize(
    "raw",
    [
        pytest.param("not a dict", id="not-an-object"),
        pytest.param({"jobId": "j1"}, id="no-type"),
        pytest.param({"type": 7}, id="non-string-type"),
        pytest.param({"type": "job:unheard-of"}, id="unknown-type"),
        pytest.param({"type": "job:assign", "mediaId": "m1"}, id="assign-missing-jobId"),
        pytest.param(
            {"type": "job:assign", "jobId": 1, "mediaId": "m", "jobType": "align", "mediaDir": "/d"},
            id="assign-jobId-wrong-type",
        ),
        pytest.param({"type": "job:cancel"}, id="cancel-missing-jobId"),
        pytest.param({"type": "job:claim-ack", "owned": "j1"}, id="claim-ack-owned-not-a-list"),
    ],
)
def test_malformed_frames_raise(raw: object) -> None:
    with pytest.raises(f.ProtocolError):
        f.parse(raw)


def test_protocol_error_is_not_retryable() -> None:
    """The failure policy reads `.retryable`; re-receiving a malformed frame cannot fix it."""
    assert f.ProtocolError.retryable is False


def test_parser_table_covers_exactly_the_inbound_union() -> None:
    """A new inbound frame must be registered, or `parse` rejects it as unknown at runtime.

    The non-vacuity floor for this module: every other inbound test names a frame explicitly, so a
    frame added to the union and forgotten in `_PARSERS` would be caught by nothing.
    """
    in_union = {member.TYPE for member in typing.get_args(f.FromCore)}
    assert in_union == set(f._PARSERS), "FromCore members and _PARSERS must match exactly"


# ── vocabulary ───────────────────────────────────────────────────────────────────────────────────


def test_capability_family_match_not_literal() -> None:
    """A worker advertising a VARIANT serves the family, and both separation actions map onto `stems`."""
    roformer = frozenset({Capability.STEMS_ROFORMER.value})
    assert serves(roformer, Action.STEMS)
    assert serves(roformer, Action.STEMS_UPGRADE), "an upgrade is served by the stems family"
    assert not serves(roformer, Action.ALIGN)

    # The reverse must not hold: `stems` is the demucs family and must not be read as a roformer token.
    assert Capability.STEMS_ROFORMER.family == "stems"
    assert not serves(frozenset({Capability.ALIGN.value}), Action.STEMS)


def test_stage_is_not_the_state_machine() -> None:
    """Stages stay coarse. Adding a state must not add a stage, or every internal rename hits a phone."""
    assert {s.value for s in Stage} == {"downloading", "separating", "aligning"}
