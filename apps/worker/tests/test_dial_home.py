"""I/O dial-home loop driven by an in-memory fake socket (no network, no torch). Proves the full
assign -> accept -> progress* -> complete flow, capacity reject, cancel, and failure reporting."""
import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import protocol  # noqa: E402
from src import dial_home as dh  # noqa: E402
from src.dial_home import WorkerClient, _build_processor, _is_retryable  # noqa: E402
from src.processor import CompleteResult, JobSpec, ProgressEvent, StubProcessor  # noqa: E402


class FakeSocket:
    """Captures everything the worker sends."""

    def __init__(self):
        self.sent: list[dict] = []

    async def send(self, msg: dict):
        self.sent.append(msg)

    def types(self):
        return [m["type"] for m in self.sent]

    def of_type(self, t: str):
        return [m for m in self.sent if m["type"] == t]


def assign(job_id="j1", media_id="m1", job_type="stems"):
    return {
        "type": protocol.ASSIGN,
        "jobId": job_id,
        "mediaId": media_id,
        "jobType": job_type,
        "sourceUri": "https://www.youtube.com/watch?v=abc",
        "params": {"model": "htdemucs"},
    }


def make_client(sock, tmp_path, capabilities=None, concurrency=1):
    return WorkerClient(
        sock.send,
        StubProcessor(),
        worker_id="w1",
        capabilities=capabilities or ["stems"],
        concurrency=concurrency,
        media_dir=str(tmp_path),
        version="test",
    )


@pytest.mark.asyncio
async def test_hello_announces_capabilities(tmp_path):
    sock = FakeSocket()
    client = make_client(sock, tmp_path)
    await client.hello()
    assert sock.sent[0] == protocol.hello("w1", ["stems"], 1, "test")


@pytest.mark.asyncio
async def test_full_assign_to_complete_flow(tmp_path):
    sock = FakeSocket()
    client = make_client(sock, tmp_path)

    await client.handle(assign())
    await client.drain()  # let the concurrent job task finish

    types = sock.types()
    # accept first, then one progress per stage (stems => downloading, separating), then complete
    assert types[0] == protocol.ACCEPT
    progresses = sock.of_type(protocol.PROGRESS)
    assert [p["stage"] for p in progresses] == ["downloading", "separating"]
    assert progresses[-1]["pct"] == 100
    completes = sock.of_type(protocol.COMPLETE)
    assert len(completes) == 1
    # the placeholder instrumental was actually written to the media dir
    out = completes[0]["mediaUri"]
    assert Path(out).exists()
    assert "m1-instrumental.flac" in out
    # slot is released after completion
    assert client.state.slots_free == 1


@pytest.mark.asyncio
async def test_reject_when_capability_missing(tmp_path):
    sock = FakeSocket()
    client = make_client(sock, tmp_path, capabilities=["stems"])
    await client.handle(assign(job_type="align"))  # worker can't do align
    await client.drain()
    assert sock.types() == [protocol.REJECT]
    assert "unsupported" in sock.of_type(protocol.REJECT)[0]["reason"]


@pytest.mark.asyncio
async def test_reject_when_no_free_slots(tmp_path):
    sock = FakeSocket()
    client = make_client(sock, tmp_path, concurrency=1)
    client.state.start("already-running")  # occupy the only slot
    await client.handle(assign())
    assert sock.of_type(protocol.REJECT)[0]["reason"] == "no free slots"


@pytest.mark.asyncio
async def test_failure_is_reported_with_retryable_flag(tmp_path):
    sock = FakeSocket()

    class BoomProcessor:
        async def process(self, job: JobSpec):
            yield ProgressEvent("downloading", 50)
            raise RuntimeError("transient network blip")

    client = WorkerClient(sock.send, BoomProcessor(), worker_id="w1", capabilities=["stems"], concurrency=1, media_dir=str(tmp_path))
    await client.handle(assign())
    await client.drain()
    failed = sock.of_type(protocol.FAILED)
    assert len(failed) == 1
    assert failed[0]["retryable"] is True  # "blip" isn't in the permanent-error list
    assert client.state.slots_free == 1  # slot freed even on failure


@pytest.mark.asyncio
async def test_non_retryable_failure_for_permanent_errors(tmp_path):
    sock = FakeSocket()

    class GoneProcessor:
        async def process(self, job: JobSpec):
            raise RuntimeError("source not found (404)")
            yield  # pragma: no cover (makes this an async generator)

    client = WorkerClient(sock.send, GoneProcessor(), worker_id="w1", capabilities=["stems"], concurrency=1, media_dir=str(tmp_path))
    await client.handle(assign())
    await client.drain()
    assert sock.of_type(protocol.FAILED)[0]["retryable"] is False


@pytest.mark.asyncio
async def test_ping_triggers_heartbeat(tmp_path):
    sock = FakeSocket()
    client = make_client(sock, tmp_path)
    await client.handle({"type": protocol.PING})
    hb = sock.of_type(protocol.HEARTBEAT)
    assert len(hb) == 1 and hb[0]["slotsFree"] == 1


@pytest.mark.asyncio
async def test_cancel_frees_the_slot(tmp_path):
    sock = FakeSocket()
    client = make_client(sock, tmp_path)
    client.state.start("j9")
    assert client.state.slots_free == 0
    client._on_cancel({"type": protocol.CANCEL, "jobId": "j9", "reason": "removed"})
    assert client.state.slots_free == 1


@pytest.mark.asyncio
async def test_welcome_records_media_store_config_and_sends_nothing(tmp_path):
    sock = FakeSocket()
    client = make_client(sock, tmp_path)
    await client.handle({"type": protocol.WELCOME, "heartbeatIntervalSec": 30, "ackTimeoutSec": 10, "mediaStore": {"kind": "local"}})
    assert sock.sent == []  # welcome requires no reply
    assert client.media_store.kind == "local"

    # an object-store welcome is recorded so the worker pushes stems to S3 (M7-C10)
    await client.handle({"type": protocol.WELCOME, "heartbeatIntervalSec": 30, "ackTimeoutSec": 10,
                         "mediaStore": {"kind": "object", "bucket": "encore-media", "prefix": "encore/"}})
    assert client.media_store.kind == "object"
    assert client.media_store.bucket == "encore-media"
    assert sock.sent == []


def test_build_processor_stub_override(monkeypatch):
    from src.processor import StubProcessor as Stub

    monkeypatch.setenv("ENCORE_PROCESSOR", "stub")
    assert isinstance(_build_processor(), Stub)


def test_build_processor_routes_by_capability(monkeypatch):
    # default CAPABILITIES = ["stems"] → a RoutingProcessor that maps stems→Demucs
    from src.processor import RoutingProcessor
    from src.demucs import DemucsProcessor
    from src.whisperx import WhisperXProcessor
    from src.score import PitchTrackProcessor

    monkeypatch.delenv("ENCORE_PROCESSOR", raising=False)
    p = _build_processor()
    assert isinstance(p, RoutingProcessor)
    by_type = p._by_type  # introspect the routing table
    # B-8: stems now routes through an EngineRouter (engine chosen per-job); demucs is its default.
    from src.processor import EngineRouter

    assert isinstance(by_type["stems"], EngineRouter)
    assert isinstance(by_type["stems"]._by_engine["demucs"], DemucsProcessor)
    assert "roformer" not in by_type["stems"]._by_engine  # not built without the stems:roformer cap
    assert "score" not in by_type  # score is capability-gated (M8-C3), not advertised by default
    assert "align" not in by_type  # not advertised by default

    # Capabilities come from the CONFIG seam, not a mutable module global — pass one explicitly.
    from src.config import WorkerConfig

    ps = _build_processor(WorkerConfig(capabilities=("stems", "score")))
    assert isinstance(ps._by_type["score"], PitchTrackProcessor)

    p2 = _build_processor(WorkerConfig(capabilities=("stems", "align")))
    assert isinstance(p2._by_type["align"], WhisperXProcessor)


@pytest.mark.asyncio
async def test_routing_processor_dispatches_by_job_type(tmp_path):
    # RoutingProcessor.process picks the sub-processor by job.job_type; unknown → raises
    from src.processor import RoutingProcessor, JobSpec, StubProcessor

    routed = RoutingProcessor({"stems": StubProcessor()})
    stems_job = JobSpec(job_id="j", media_id="m", job_type="stems", source_uri="x", params={}, media_dir=str(tmp_path))
    events = [ev async for ev in routed.process(stems_job)]
    assert events  # stub ran
    with pytest.raises(RuntimeError, match="no processor for job type"):
        bad = JobSpec(job_id="j", media_id="m", job_type="align", source_uri="x", params={}, media_dir=str(tmp_path))
        [ev async for ev in routed.process(bad)]


def test_is_retryable_prefers_structured_flag():
    from src.demucs import ProcessError

    # structured .retryable wins over the string heuristic
    assert _is_retryable(ProcessError(["demucs"], 1, "CUDA out of memory")) is True
    assert _is_retryable(ProcessError(["yt-dlp"], 1, "ERROR: Video unavailable")) is False
    # plain exceptions fall back to the substring heuristic
    assert _is_retryable(RuntimeError("source not found")) is False
    assert _is_retryable(RuntimeError("temporary blip")) is True


@pytest.mark.asyncio
async def test_worker_cleans_its_own_scratch_after_a_job(tmp_path):
    """B-7: work/<jobId> holds the decoded source + both WAV stems -- hundreds of MB that nothing
    reads once the encoded artifacts are published. The WORKER must clean it, not the core: in a
    two-container deployment the core runs as a different uid and gets EACCES on these dirs."""
    work = tmp_path / "work" / "j1"
    work.mkdir(parents=True)
    (work / "input.wav").write_bytes(b"BIG")

    sent = []

    class DoneProcessor:
        async def process(self, job):
            yield CompleteResult(media_uri="/x.m4a", artifacts={"stems": {"instrumental": "/x.m4a"}})

    async def send(m):
        sent.append(m)

    client = WorkerClient(send, DoneProcessor())
    await client._run_job(JobSpec(job_id="j1", media_id="m1", job_type="stems",
                                  source_uri="https://y/x", params={}, media_dir=str(tmp_path)))
    assert not work.exists(), "job scratch must be removed once the job is terminal"


@pytest.mark.asyncio
async def test_scratch_is_cleaned_even_when_the_job_FAILS(tmp_path):
    work = tmp_path / "work" / "j2"
    work.mkdir(parents=True)
    (work / "input.wav").write_bytes(b"BIG")

    class BoomProcessor:
        async def process(self, job):
            raise RuntimeError("demucs exploded")
            yield  # pragma: no cover

    async def send(_m):
        return None

    client = WorkerClient(send, BoomProcessor())
    await client._run_job(JobSpec(job_id="j2", media_id="m1", job_type="stems",
                                  source_uri="https://y/x", params={}, media_dir=str(tmp_path)))
    assert not work.exists()


# ── performance knobs must actually cross the process boundary ─────────────────
# capabilities="none" on purpose: it matches neither stems/score nor align, so _build_processor
# exercises the config path WITHOUT importing demucs or whisperx.
def test_torch_threads_exports_omp_for_the_demucs_SUBPROCESS(monkeypatch):
    """demucs runs as a separate CLI, so torch.set_num_threads() in THIS process cannot reach it.
    The cap has to ride os.environ, which the child inherits."""
    import os

    from src.config import WorkerConfig

    monkeypatch.delenv("OMP_NUM_THREADS", raising=False)
    monkeypatch.delenv("MKL_NUM_THREADS", raising=False)
    cfg = WorkerConfig.from_env({"ENCORE_TORCH_THREADS": "3", "ENCORE_WORKER_CAPABILITIES": "none"})
    _build_processor(cfg)
    assert os.environ["OMP_NUM_THREADS"] == "3"
    assert os.environ["MKL_NUM_THREADS"] == "3"


def test_no_torch_threads_leaves_the_environment_alone(monkeypatch):
    import os

    from src.config import WorkerConfig

    monkeypatch.delenv("OMP_NUM_THREADS", raising=False)
    _build_processor(WorkerConfig.from_env({"ENCORE_WORKER_CAPABILITIES": "none"}))
    assert "OMP_NUM_THREADS" not in os.environ


def test_oversubscription_warns_when_concurrency_times_jobs_exceeds_cores():
    from src.config import WorkerConfig

    cfg = WorkerConfig.from_env({"ENCORE_WORKER_CONCURRENCY": "4", "ENCORE_DEMUCS_JOBS": "4"})
    warns = dh.oversubscription_warnings(cfg, 10)
    assert any("16 parallel" in w for w in warns)
    assert any("ENCORE_TORCH_THREADS=" in w for w in warns)  # names the fix, not just the problem


def test_oversubscription_silent_when_it_fits_and_threads_are_capped():
    from src.config import WorkerConfig

    cfg = WorkerConfig.from_env(
        {"ENCORE_WORKER_CONCURRENCY": "2", "ENCORE_DEMUCS_JOBS": "4", "ENCORE_TORCH_THREADS": "1"}
    )
    assert dh.oversubscription_warnings(cfg, 10) == []


def test_oversubscription_is_a_noop_when_cores_are_unknown():
    from src.config import WorkerConfig

    cfg = WorkerConfig.from_env({"ENCORE_WORKER_CONCURRENCY": "8", "ENCORE_DEMUCS_JOBS": "8"})
    assert dh.oversubscription_warnings(cfg, None) == []
