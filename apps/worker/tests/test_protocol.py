"""Pure protocol layer — message shapes, capacity/capability gating, stage plans."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # make `src` importable

from src import protocol  # noqa: E402


def test_hello_shape_matches_wire_contract():
    msg = protocol.hello("w1", ["stems", "align"], 2, "0.2.0")
    assert msg == {
        "type": "worker:hello",
        "workerId": "w1",
        "capabilities": ["stems", "align"],
        "concurrency": 2,
        "version": "0.2.0",
    }


def test_progress_omits_eta_when_absent_and_includes_it_when_set():
    assert "etaSec" not in protocol.progress("w1", "j1", "separating", 50)
    assert protocol.progress("w1", "j1", "separating", 68, 12)["etaSec"] == 12


def test_complete_and_failed_shapes():
    c = protocol.complete("w1", "j1", "media/x.wav", {"stems": {"instrumental": "media/x.wav"}})
    assert c["type"] == "job:complete" and c["mediaUri"] == "media/x.wav"
    assert c["artifacts"]["stems"]["instrumental"] == "media/x.wav"
    f = protocol.failed("w1", "j1", "boom", retryable=True)
    assert f == {"type": "job:failed", "workerId": "w1", "jobId": "j1", "error": "boom", "retryable": True}


def test_worker_state_capacity_and_capability_gating():
    st = protocol.WorkerState("w1", ["stems"], concurrency=1)
    assert st.slots_free == 1
    ok, _ = st.can_accept("stems")
    assert ok
    bad, reason = st.can_accept("align")  # not advertised
    assert not bad and "unsupported" in reason

    st.start("j1")
    assert st.slots_free == 0
    full, reason = st.can_accept("stems")  # no free slot now
    assert not full and "no free slots" in reason
    st.finish("j1")
    assert st.slots_free == 1


def test_stage_plans_per_job_type():
    assert protocol.stages_for("stems") == ["downloading", "separating"]
    assert protocol.stages_for("align") == ["downloading", "aligning"]
    # unknown type falls back to a download+separate plan (never empty)
    assert protocol.stages_for("mystery") == ["downloading", "separating"]
