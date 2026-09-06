"""I/O dial-home loop driven by an in-memory fake socket (no network, no torch). Proves the full
assign -> accept -> progress* -> complete flow, capacity reject, cancel, and failure reporting."""

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import dial_home as dh  # noqa: E402
from src import protocol  # noqa: E402
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
    sent = sock.sent[0]
    # Compared field-by-field rather than whole-frame: `hello` also carries best-effort HOST facts,
    # which are by nature machine-specific (cpu count, platform string), so an equality assertion
    # against a rebuilt frame would only pass on the box that wrote it.
    assert sent["type"] == protocol.HELLO
    assert sent["workerId"] == "w1"
    assert sent["capabilities"] == ["stems"]
    assert sent["concurrency"] == 1
    assert sent["version"] == "test"


@pytest.mark.asyncio
async def test_hello_describes_the_box_it_runs_on(tmp_path):
    # An operator reading "stems took 43 minutes" needs to know whether that was a GPU or four shared
    # cores. The worker already resolved all of this at startup and only ever printed it.
    sock = FakeSocket()
    client = make_client(sock, tmp_path)
    await client.hello()
    host = sock.sent[0]["host"]
    assert isinstance(host["cpuCount"], int) and host["cpuCount"] >= 1
    assert host["platform"] and host["machine"] and host["python"]


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

    client = WorkerClient(
        sock.send,
        BoomProcessor(),
        worker_id="w1",
        capabilities=["stems"],
        concurrency=1,
        media_dir=str(tmp_path),
    )
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

    client = WorkerClient(
        sock.send,
        GoneProcessor(),
        worker_id="w1",
        capabilities=["stems"],
        concurrency=1,
        media_dir=str(tmp_path),
    )
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
    await client.handle(
        {
            "type": protocol.WELCOME,
            "heartbeatIntervalSec": 30,
            "ackTimeoutSec": 10,
            "mediaStore": {"kind": "local"},
        }
    )
    assert sock.sent == []  # welcome requires no reply
    assert client.media_store.kind == "local"

    # an object-store welcome is recorded so the worker pushes stems to S3
    await client.handle(
        {
            "type": protocol.WELCOME,
            "heartbeatIntervalSec": 30,
            "ackTimeoutSec": 10,
            "mediaStore": {"kind": "object", "bucket": "encore-media", "prefix": "encore/"},
        }
    )
    assert client.media_store.kind == "object"
    assert client.media_store.bucket == "encore-media"
    assert sock.sent == []


def test_build_processor_stub_override(monkeypatch):
    from src.processor import StubProcessor as Stub

    monkeypatch.setenv("ENCORE_PROCESSOR", "stub")
    assert isinstance(_build_processor(), Stub)


def test_build_processor_routes_by_capability(monkeypatch):
    # The DEFAULT is now the whole cook (fetch:ytdlp,stems,align), so the default routing table carries
    # all three.
    from src.processor import RoutingProcessor
    from src.runtime.runner import PlanRunner

    monkeypatch.delenv("ENCORE_PROCESSOR", raising=False)
    # There is no longer a DEFAULT capability string to lean on: from_env leaves the set unresolved and
    # config.resolve() fills it from probes, so a test that wants the full cook states the full cook.
    # (That is the point — the routing table is built from what the box can prove, and this box has
    # neither demucs nor whisperx installed.)
    from src.config import WorkerConfig as _WC

    full_cook = _WC(capabilities=("fetch:ytdlp", "stems", "align"))
    p = _build_processor(full_cook)
    assert isinstance(p, RoutingProcessor)
    by_type = p._by_type  # introspect the routing table
    # stems is a PlanRunner too: the engine is resolved per JOB into ctx.engines before the first step
    # runs, so EngineRouter's second dispatch layer is gone (see the spec §5.2c).
    assert isinstance(by_type["stems"], PlanRunner)
    assert by_type["stems"] is by_type["stems-upgrade"], "an upgrade is a separation job like any other"
    assert isinstance(by_type["align"], PlanRunner)  # part of the full cook
    assert "fetch" in by_type  # acquisition rides its own capability (fetch:ytdlp)

    # A stems-ONLY worker is still expressible — it just has to say so explicitly.
    only_stems = _build_processor(_WC(capabilities=("stems",)))._by_type
    assert "align" not in only_stems and "fetch" not in only_stems

    # A fetch-ONLY worker is legitimate: it downloads and cannot separate. That asymmetry is why
    # acquisition routes on its own capability instead of riding along with stems.
    from src.config import WorkerConfig

    pf = _build_processor(WorkerConfig(capabilities=("fetch:ytdlp",)))
    assert isinstance(pf._by_type["fetch"], PlanRunner)
    assert "stems" not in pf._by_type

    # Capabilities come from the CONFIG seam, not a mutable module global — pass one explicitly.
    from src.config import WorkerConfig

    p2 = _build_processor(WorkerConfig(capabilities=("stems", "align")))
    assert isinstance(p2._by_type["align"], PlanRunner)


@pytest.mark.asyncio
async def test_routing_processor_dispatches_by_job_type(tmp_path):
    # RoutingProcessor.process picks the sub-processor by job.job_type; unknown → raises
    from src.processor import JobSpec, RoutingProcessor, StubProcessor

    routed = RoutingProcessor({"stems": StubProcessor()})
    stems_job = JobSpec(
        job_id="j", media_id="m", job_type="stems", source_uri="x", params={}, media_dir=str(tmp_path)
    )
    events = [ev async for ev in routed.process(stems_job)]
    assert events  # stub ran
    with pytest.raises(RuntimeError, match="no processor for job type"):
        bad = JobSpec(
            job_id="j", media_id="m", job_type="align", source_uri="x", params={}, media_dir=str(tmp_path)
        )
        [ev async for ev in routed.process(bad)]


def test_is_retryable_prefers_structured_flag():
    from src.separation.demucs import ProcessError

    # structured .retryable wins over the string heuristic
    assert _is_retryable(ProcessError(["demucs"], 1, "CUDA out of memory")) is True
    assert _is_retryable(ProcessError(["yt-dlp"], 1, "ERROR: Video unavailable")) is False
    # plain exceptions fall back to the substring heuristic
    assert _is_retryable(RuntimeError("source not found")) is False
    assert _is_retryable(RuntimeError("temporary blip")) is True


@pytest.mark.asyncio
async def test_worker_cleans_its_own_scratch_after_a_job(tmp_path):
    """work/<jobId> holds the decoded source + both WAV stems -- hundreds of MB that nothing
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
    await client._run_job(
        JobSpec(
            job_id="j1",
            media_id="m1",
            job_type="stems",
            source_uri="https://y/x",
            params={},
            media_dir=str(tmp_path),
        )
    )
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
    await client._run_job(
        JobSpec(
            job_id="j2",
            media_id="m1",
            job_type="stems",
            source_uri="https://y/x",
            params={},
            media_dir=str(tmp_path),
        )
    )
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
    # jobs=1 with concurrency=1 means nothing can contend, which is the one case that keeps torch's own
    # physical-core-aware default instead of a derived cap.
    _build_processor(WorkerConfig.from_env({"ENCORE_WORKER_CAPABILITIES": "none", "ENCORE_DEMUCS_JOBS": "1"}))
    assert "OMP_NUM_THREADS" not in os.environ


def test_threads_are_capped_automatically_once_separations_can_contend(monkeypatch):
    import os

    from src.config import WorkerConfig

    monkeypatch.delenv("OMP_NUM_THREADS", raising=False)
    # The knob no longer has to be set by hand: concurrency x jobs > 1 derives a cap, and the cap has
    # to reach the demucs SUBPROCESS via the environment.
    cfg = WorkerConfig.from_env(
        {"ENCORE_WORKER_CAPABILITIES": "none", "ENCORE_WORKER_CONCURRENCY": "2", "ENCORE_DEMUCS_JOBS": "4"}
    )
    assert cfg.torch_threads is not None, "8 parallel separations must not each default to all cores"
    _build_processor(cfg)
    assert os.environ["OMP_NUM_THREADS"] == str(cfg.torch_threads)


def test_oversubscription_warns_when_concurrency_times_jobs_exceeds_cores():
    from src.config import WorkerConfig

    cfg = WorkerConfig.from_env({"ENCORE_WORKER_CONCURRENCY": "4", "ENCORE_DEMUCS_JOBS": "4"})
    warns = dh.oversubscription_warnings(cfg, 10)
    assert any("16 parallel" in w for w in warns)
    # No "you forgot ENCORE_TORCH_THREADS" advice any more: from_env already derived the cap, so
    # repeating it as a warning would name a fix that is already in place.
    assert not any("ENCORE_TORCH_THREADS" in w for w in warns)


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


# ── FIX 4: a cancel message cancels the in-flight task (which kills the child via GeneratorExit) ──
@pytest.mark.asyncio
async def test_cancel_cancels_the_inflight_task_and_frees_the_slot(tmp_path):
    sock = FakeSocket()
    started = asyncio.Event()
    cancelled = asyncio.Event()

    class SlowProcessor:
        async def process(self, job):
            yield ProgressEvent("downloading", 0)
            started.set()
            try:
                await asyncio.sleep(300)  # stand-in for a long separation holding a child
            except asyncio.CancelledError:
                cancelled.set()
                raise
            yield  # pragma: no cover

    client = WorkerClient(
        sock.send,
        SlowProcessor(),
        worker_id="w1",
        capabilities=["stems"],
        concurrency=1,
        media_dir=str(tmp_path),
    )
    await client.handle(assign(job_id="jX"))
    await asyncio.wait_for(started.wait(), timeout=5)
    assert client.state.slots_free == 0
    task = client._tasks["jX"]

    client._on_cancel({"type": protocol.CANCEL, "jobId": "jX"})
    await asyncio.wait_for(cancelled.wait(), timeout=5)
    await asyncio.gather(task, return_exceptions=True)
    await asyncio.sleep(0)  # let the task's done-callback (which pops _tasks) run

    # slot freed, no dangling task entry, and NO spurious job:failed reported to the core
    assert client.state.slots_free == 1
    assert "jX" not in client._tasks
    assert sock.of_type(protocol.FAILED) == []


@pytest.mark.asyncio
async def test_cancel_for_an_untracked_job_still_frees_the_slot(tmp_path):
    # A job whose task already finished (or a slot held without one) must still be freed by cancel —
    # the pre-fix behaviour is preserved for that path.
    sock = FakeSocket()
    client = make_client(sock, tmp_path)
    client.state.start("ghost")
    assert client.state.slots_free == 0
    client._on_cancel({"type": protocol.CANCEL, "jobId": "ghost"})
    assert client.state.slots_free == 1


# ── FIX 5: a malformed frame fails only that job, never the connection ──────────────
@pytest.mark.asyncio
async def test_malformed_assign_missing_jobtype_rejects_just_that_job(tmp_path):
    sock = FakeSocket()
    client = make_client(sock, tmp_path)
    # a frame with a jobId but no jobType/mediaId used to raise KeyError and kill the socket
    await client.handle({"type": protocol.ASSIGN, "jobId": "bad1"})
    await client.drain()
    rejects = sock.of_type(protocol.REJECT)
    assert len(rejects) == 1 and rejects[0]["jobId"] == "bad1"
    assert "malformed" in rejects[0]["reason"]
    # the slot was never consumed and the client is still usable
    assert client.state.slots_free == 1


@pytest.mark.asyncio
async def test_malformed_assign_missing_jobid_is_dropped_without_raising(tmp_path):
    sock = FakeSocket()
    client = make_client(sock, tmp_path)
    # no usable jobId → cannot send a job-scoped reject; must log-and-ignore, never raise
    await client.handle({"type": protocol.ASSIGN, "mediaId": "m1", "jobType": "stems"})
    await client.drain()
    assert sock.sent == []  # nothing sent, nothing crashed
    assert client.state.slots_free == 1


@pytest.mark.asyncio
async def test_a_bad_assign_frame_does_not_prevent_a_later_good_one(tmp_path):
    sock = FakeSocket()
    client = make_client(sock, tmp_path)
    await client.handle({"type": protocol.ASSIGN, "jobId": "bad"})  # malformed
    await client.handle(assign(job_id="good"))  # well-formed
    await client.drain()
    # the good job still ran to completion after the bad one was handled
    completes = sock.of_type(protocol.COMPLETE)
    assert len(completes) == 1


@pytest.mark.asyncio
async def test_unknown_message_type_is_logged(tmp_path, capsys):
    sock = FakeSocket()
    client = make_client(sock, tmp_path)
    await client.handle({"type": "some:future:message"})
    assert sock.sent == []  # no reply
    out = capsys.readouterr().out
    assert "unhandled message type" in out
    assert "some:future:message" in out


def test_building_a_stems_runner_pulls_NO_ml_framework():
    """What the old `_by_engine` assertion was really protecting.

    It checked that roformer was not CONSTRUCTED without the `stems:roformer` capability, because the point
    was keeping a demucs-only box from paying for roformer's machinery. With engines resolved per job that
    assertion has nothing to hold, so this states the underlying invariant directly and for both engines:
    building the runner must not import torch or bs_roformer. Both separators shell out to a CLI, so the
    multi-GB frameworks belong to the subprocess, not to this process.
    """
    import sys

    from src import plans

    plans.stems_runner(runner=None)
    loaded = {m.split(".")[0] for m in sys.modules}
    assert "torch" not in loaded
    assert "bs_roformer" not in loaded


# ── FIX 1: a dropped socket must CANCEL the abandoned client's in-flight tasks, not orphan them ──
@pytest.mark.asyncio
async def test_drain_cancel_cancels_inflight_tasks(tmp_path):
    """drain(cancel=True) is what the reconnect path calls when the socket drops. The old client is
    abandoned; without cancelling, its cook runs to completion against a dead socket, loses its
    result, and races the core's reaper (which requeues the same job) -- duplicate GPU work. Proven
    non-vacuous: on the old drain() (await-only, no cancel arg) this raises TypeError, and even a
    no-cancel await would hang forever on the 300s sleep instead of returning."""
    sock = FakeSocket()
    started = asyncio.Event()
    cancelled = asyncio.Event()

    class SlowProcessor:
        async def process(self, job):
            yield ProgressEvent("downloading", 0)
            started.set()
            try:
                await asyncio.sleep(300)  # a long separation holding a child process
            except asyncio.CancelledError:
                cancelled.set()
                raise
            yield  # pragma: no cover

    client = make_client(sock, tmp_path)
    client._processor = SlowProcessor()
    await client.handle(assign(job_id="jDrop"))
    await asyncio.wait_for(started.wait(), timeout=5)
    assert client.state.slots_free == 0
    old_task = client._tasks["jDrop"]

    # simulate the reconnect-loop finally block on a socket drop
    await asyncio.wait_for(client.drain(cancel=True), timeout=5)

    assert cancelled.is_set(), "the abandoned cook was cancelled (GeneratorExit reaches the child)"
    assert old_task.cancelled() or old_task.done()
    assert "jDrop" not in client._tasks  # done-callback popped it
    # a cancelled cook reports NO job:failed (CancelledError is not the broad except that sends failed)
    assert sock.of_type(protocol.FAILED) == []


@pytest.mark.asyncio
async def test_drain_without_cancel_still_awaits(tmp_path):
    # The default (cancel=False) preserves the graceful-settle behaviour every other test relies on.
    sock = FakeSocket()
    client = make_client(sock, tmp_path)
    await client.handle(assign())
    await client.drain()  # no cancel arg
    assert sock.of_type(protocol.COMPLETE), "the job ran to completion, not cancelled"


# ── FIX 2: object MediaStore with no uploader wired must REFUSE, not silently store locally ──
@pytest.mark.asyncio
async def test_object_store_without_uploader_rejects_the_job(tmp_path):
    """MEDIA_STORE=object on the core + a worker with no S3 uploader = the worker would write a local
    path and report it, the core marks the song ready and serves from S3 where nothing was put.
    Proven non-vacuous: without the _on_assign guard this job is ACCEPTED and completes (see
    test_full_assign_to_complete_flow with the same stub), so the reject asserted here would be
    absent on the old code."""
    sock = FakeSocket()
    client = make_client(sock, tmp_path)  # can_publish_object defaults False
    await client.handle(
        {"type": protocol.WELCOME, "mediaStore": {"kind": "object", "bucket": "encore-media"}}
    )
    await client.handle(assign(job_id="jObj"))
    await client.drain()
    rejects = sock.of_type(protocol.REJECT)
    assert len(rejects) == 1 and rejects[0]["jobId"] == "jObj"
    assert "no S3 uploader" in rejects[0]["reason"]
    assert sock.of_type(protocol.ACCEPT) == [] and sock.of_type(protocol.COMPLETE) == []
    assert client.state.slots_free == 1  # slot never consumed


@pytest.mark.asyncio
async def test_object_store_with_uploader_accepts(tmp_path):
    # When a build DOES wire an uploader (can_publish_object=True), object mode is honoured normally.
    sock = FakeSocket()
    client = WorkerClient(
        sock.send,
        StubProcessor(),
        worker_id="w1",
        capabilities=["stems"],
        concurrency=1,
        media_dir=str(tmp_path),
        version="test",
        can_publish_object=True,
    )
    await client.handle(
        {"type": protocol.WELCOME, "mediaStore": {"kind": "object", "bucket": "encore-media"}}
    )
    await client.handle(assign(job_id="jOk"))
    await client.drain()
    assert sock.of_type(protocol.ACCEPT) and sock.of_type(protocol.COMPLETE)


@pytest.mark.asyncio
async def test_local_store_is_unaffected_by_the_object_guard(tmp_path):
    # Local mode (the default and the missing/bucketless-object fallback) accepts as before.
    sock = FakeSocket()
    client = make_client(sock, tmp_path)
    await client.handle({"type": protocol.WELCOME, "mediaStore": {"kind": "local"}})
    await client.handle(assign(job_id="jLocal"))
    await client.drain()
    assert sock.of_type(protocol.COMPLETE)


# ── issue #132: the worker must SEND worker:heartbeat on its own, not only answer a ping the core
#    never emits. registry.heartbeat is the only path that reconciles slotsFree after the reaper
#    requeues a lease-expired job, so without a periodic sender one reaped job strands the worker's
#    capacity forever. These pin the production path (heartbeat_loop), not the passive PING responder.


@pytest.mark.asyncio
async def test_heartbeat_loop_sends_periodically_without_a_ping(tmp_path):
    # The core sends no `ping`, so the ONLY way worker:heartbeat leaves the worker in production is
    # heartbeat_loop. Drive it directly with a tiny interval and prove frames arrive with no ping.
    sock = FakeSocket()
    client = make_client(sock, tmp_path)
    client.heartbeat_interval_sec = 0.1  # the loop floors the sleep at 0.1s to avoid spinning
    task = asyncio.create_task(client.heartbeat_loop())
    # Yield long enough for at least two ticks, then stop the unbounded loop.
    await asyncio.sleep(0.35)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    hb = sock.of_type(protocol.HEARTBEAT)
    assert len(hb) >= 2, f"expected periodic heartbeats, got {sock.types()}"
    # Not one PING was involved — this leg does not depend on a command the core never sends.
    assert protocol.PING not in sock.types()
    # The frame carries this worker's live capacity (the source of truth registry.heartbeat reads).
    assert hb[0]["slotsFree"] == 1 and hb[0]["workerId"] == "w1"


@pytest.mark.asyncio
async def test_heartbeat_loop_reports_reduced_slots_while_a_job_runs(tmp_path):
    # slotsFree in the frame must reflect running jobs — that reconciled number is the whole point
    # of the leg (the core hands the slot back from it after a reap).
    sock = FakeSocket()
    client = make_client(sock, tmp_path)
    client.heartbeat_interval_sec = 0.1
    client.state.start("jBusy")
    task = asyncio.create_task(client.heartbeat_loop())
    await asyncio.sleep(0.25)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    hb = sock.of_type(protocol.HEARTBEAT)
    assert hb and all(m["slotsFree"] == 0 for m in hb)
    assert hb[0]["runningJobIds"] == ["jBusy"]


@pytest.mark.asyncio
async def test_welcome_stores_heartbeat_interval_and_the_loop_honours_it(tmp_path):
    # The declared wire field heartbeatIntervalSec was previously supplied by every producer and
    # test and READ by nobody. Now the WELCOME arm adopts it and the loop ticks at it.
    sock = FakeSocket()
    client = make_client(sock, tmp_path)
    assert client.heartbeat_interval_sec == dh.DEFAULT_HEARTBEAT_INTERVAL_SEC
    await client.handle(
        {
            "type": protocol.WELCOME,
            "heartbeatIntervalSec": 42,
            "ackTimeoutSec": 10,
            "mediaStore": {"kind": "local"},
        }
    )
    assert client.heartbeat_interval_sec == 42.0
    # Welcome still replies with nothing (the media-store contract is unchanged).
    assert sock.sent == []


@pytest.mark.asyncio
async def test_welcome_ignores_a_missing_or_bad_interval(tmp_path):
    # A welcome without the field (older core), or a garbage value, must not silence the leg: the
    # default floor stands so heartbeats keep flowing.
    sock = FakeSocket()
    client = make_client(sock, tmp_path)
    await client.handle({"type": protocol.WELCOME, "mediaStore": {"kind": "local"}})
    assert client.heartbeat_interval_sec == dh.DEFAULT_HEARTBEAT_INTERVAL_SEC
    await client.handle(
        {"type": protocol.WELCOME, "heartbeatIntervalSec": 0, "mediaStore": {"kind": "local"}}
    )
    assert client.heartbeat_interval_sec == dh.DEFAULT_HEARTBEAT_INTERVAL_SEC
    await client.handle(
        {"type": protocol.WELCOME, "heartbeatIntervalSec": "nope", "mediaStore": {"kind": "local"}}
    )
    assert client.heartbeat_interval_sec == dh.DEFAULT_HEARTBEAT_INTERVAL_SEC


# ── issue #132 WIRING GUARD: the whole production fix is one line in _run_forever —
#    asyncio.create_task(client.heartbeat_loop()) — and the behavioural tests above prove the loop
#    BEHAVES, never that it RUNS. This repo's most-repeated defect is a mechanism built, unit-tested,
#    and never wired to the path that needs it; deleting that one line leaves the whole suite green
#    with #132 fully reintroduced. Pin the wiring at the source level (ast, no async harness needed):
#    _run_forever must START heartbeat_loop AND cancel that task in a finally so it dies with its socket.
import ast as _ast  # noqa: E402
from pathlib import Path as _Path  # noqa: E402


def _run_forever_ast():
    src = _Path(dh.__file__).read_text(encoding="utf-8")
    for node in _ast.walk(_ast.parse(src)):
        if isinstance(node, (_ast.FunctionDef, _ast.AsyncFunctionDef)) and node.name == "_run_forever":
            return node
    raise AssertionError("_run_forever not found in dial_home.py")


def test_run_forever_starts_the_heartbeat_loop():
    # A create_task(...heartbeat_loop()) call inside _run_forever. Deleting the wiring line reddens this.
    fn = _run_forever_ast()
    started = [
        n
        for n in _ast.walk(fn)
        if isinstance(n, _ast.Call)
        and getattr(n.func, "attr", None) == "create_task"
        and any(getattr(a.func, "attr", None) == "heartbeat_loop" for a in n.args if isinstance(a, _ast.Call))
    ]
    assert started, (
        "_run_forever never starts client.heartbeat_loop() — worker:heartbeat would never be sent "
        "(issue #132)"
    )


def test_run_forever_cancels_the_heartbeat_task_in_a_finally():
    # The task is bound to one socket's lifetime: a Try/finally that calls <name>.cancel().
    fn = _run_forever_ast()
    cancels_in_finally = []
    for node in _ast.walk(fn):
        if isinstance(node, _ast.Try) and node.finalbody:
            for stmt in _ast.walk(_ast.Module(body=node.finalbody, type_ignores=[])):
                if isinstance(stmt, _ast.Call) and getattr(stmt.func, "attr", None) == "cancel":
                    cancels_in_finally.append(stmt)
    assert cancels_in_finally, (
        "_run_forever never cancels the heartbeat task in a finally — it would leak across "
        "reconnects (issue #132)"
    )


@pytest.mark.asyncio
async def test_build_processor_threads_ENCORE_YTDLP_BIN_into_the_align_plan(tmp_path):
    """Issue #192 — the wiring seam. `_build_processor` builds the align runner from a WorkerConfig; the
    configured `cfg.ytdlp_bin` (ENCORE_YTDLP_BIN) must reach the FetchCaptions steps that plan actually
    runs, not stop at the capability probe. Before the fix `_build_processor` passed no yt-dlp argument
    to `align_runner` at all, so the align caption fetches ran a bare "yt-dlp" from PATH regardless of
    what the operator configured.

    Drives the align PlanRunner `_build_processor` produced, extracts a real FetchCaptions step from the
    plan it builds, runs it through a recording runner, and asserts the configured binary lands at
    argv[0]. `/opt/encore/bin/yt-dlp` is a literal path the code never constructs.
    """
    from src.config import WorkerConfig
    from src.runtime import Ctx
    from src.steps.lyrics import FetchCaptions

    configured = "/opt/encore/bin/yt-dlp"
    cfg = WorkerConfig(capabilities=("align",), ytdlp_bin=configured)
    align = _build_processor(cfg)._by_type["align"]

    job = JobSpec(
        job_id="j1",
        media_id="m1",
        job_type="align",
        source_uri="https://youtube.com/watch?v=abc",
        params={},
        media_dir=str(tmp_path),
    )
    plan = align._plan_for(job, None)
    caption_steps = [s for s in plan.steps() if isinstance(s, FetchCaptions)]
    assert caption_steps, "the align plan must fetch captions"

    seen: list[list[str]] = []

    async def spy(argv):
        seen.append(argv)
        return
        yield  # pragma: no cover — async generator with no output lines

    ctx = Ctx(job=job, work=str(tmp_path / "cap"), runner=spy)
    async for _ in caption_steps[0].run(ctx):
        pass

    assert seen, "the caption step must have invoked yt-dlp"
    assert seen[0][0] == configured, (
        f"ENCORE_YTDLP_BIN must reach the align caption argv[0], got {seen[0][0]!r}"
    )
