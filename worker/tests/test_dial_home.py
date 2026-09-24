"""I/O dial-home loop driven by an in-memory fake socket (no network, no torch). Proves the full
assign -> accept -> progress* -> complete flow, capacity reject, cancel, and failure reporting."""

import asyncio
import contextlib
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
    # Field-by-field, not whole-frame: `hello` also carries machine-specific HOST facts.
    assert sent["type"] == protocol.HELLO
    assert sent["workerId"] == "w1"
    assert sent["capabilities"] == ["stems"]
    assert sent["concurrency"] == 1
    assert sent["version"] == "test"


@pytest.mark.asyncio
async def test_hello_describes_the_box_it_runs_on(tmp_path):
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
    assert types[0] == protocol.ACCEPT
    progresses = sock.of_type(protocol.PROGRESS)
    assert [p["stage"] for p in progresses] == ["downloading", "separating"]
    assert progresses[-1]["pct"] == 100
    completes = sock.of_type(protocol.COMPLETE)
    assert len(completes) == 1
    out = completes[0]["mediaUri"]
    assert Path(out).exists()
    assert "m1-instrumental.flac" in out
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
    assert client.state.slots_free == 1


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
    from src.processor import RoutingProcessor
    from src.runtime.runner import PlanRunner

    monkeypatch.delenv("ENCORE_PROCESSOR", raising=False)
    # from_env leaves capabilities unresolved (resolve() fills them from probes), so state them here.
    from src.host.config import WorkerConfig as _WC

    full_process = _WC(capabilities=("fetch:ytdlp", "stems", "align"))
    p = _build_processor(full_process)
    assert isinstance(p, RoutingProcessor)
    by_type = p._by_type
    assert isinstance(by_type["stems"], PlanRunner)
    assert by_type["stems"] is by_type["stems-upgrade"], "an upgrade is a separation job like any other"
    assert isinstance(by_type["align"], PlanRunner)
    assert "fetch" in by_type  # acquisition rides its own capability (fetch:ytdlp)

    # A stems-ONLY worker is still expressible.
    only_stems = _build_processor(_WC(capabilities=("stems",)))._by_type
    assert "align" not in only_stems and "fetch" not in only_stems

    # A fetch-ONLY worker is legitimate: acquisition routes on its own capability, not stems'.
    from src.host.config import WorkerConfig

    pf = _build_processor(WorkerConfig(capabilities=("fetch:ytdlp",)))
    assert isinstance(pf._by_type["fetch"], PlanRunner)
    assert "stems" not in pf._by_type

    p2 = _build_processor(WorkerConfig(capabilities=("stems", "align")))
    assert isinstance(p2._by_type["align"], PlanRunner)


@pytest.mark.asyncio
async def test_routing_processor_dispatches_by_job_type(tmp_path):
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
    """The worker cleans its own scratch: a core-side rmtree would get EACCES on these dirs in a
    two-container deployment (different uid)."""
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
async def test_scratch_is_cleaned_on_a_PERMANENT_failure(tmp_path):
    """A NON-retryable failure is terminal — the core will not re-dispatch it — so its scratch is
    reclaimed here exactly as a success is (the retryable case, below, is the opposite invariant)."""
    work = tmp_path / "work" / "j2"
    work.mkdir(parents=True)
    (work / "input.wav").write_bytes(b"BIG")

    class GoneProcessor:
        async def process(self, job):
            raise RuntimeError("source not found (404)")  # permanent -> non-retryable
            yield  # pragma: no cover

    async def send(_m):
        return None

    client = WorkerClient(send, GoneProcessor())
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
    assert not work.exists(), "a permanent (non-retryable) failure is terminal; its scratch must be reclaimed"


@pytest.mark.asyncio
async def test_scratch_is_PRESERVED_across_a_RETRYABLE_failure_issue_469(tmp_path):
    """A RETRYABLE failure must NOT destroy scratch: the core requeues the SAME jobId, so
    scratch_for resolves to the same work/<jobId> dir on attempt 2, and the completed-step work
    living there is what the retry reuses instead of re-downloading/re-separating from step 1."""
    work = tmp_path / "work" / "j469"
    work.mkdir(parents=True)
    (work / "input.wav").write_bytes(b"decoded source - expensive to recompute")

    class BlipProcessor:
        async def process(self, job):
            yield ProgressEvent("downloading", 50)
            raise RuntimeError("transient network blip")  # retryable -> preserve

    sent = []

    async def send(m):
        sent.append(m)

    client = WorkerClient(send, BlipProcessor(), capabilities=["stems"], media_dir=str(tmp_path))
    await client._run_job(
        JobSpec(
            job_id="j469",
            media_id="m1",
            job_type="stems",
            source_uri="https://y/x",
            params={},
            media_dir=str(tmp_path),
        )
    )
    # the failure was reported as retryable...
    failed = [m for m in sent if m["type"] == protocol.FAILED]
    assert len(failed) == 1 and failed[0]["retryable"] is True
    # ...and BECAUSE it is retryable, the partial scratch survives for attempt 2 to reuse.
    assert work.exists(), "a retryable failure must keep scratch so the same-jobId retry reuses it"
    assert (work / "input.wav").exists(), "the completed-step artifact in scratch must survive the retry"
    # slot is still freed (the finally's state.finish is unconditional, only the rmtree is gated).
    assert client.state.slots_free == 1


@pytest.mark.asyncio
async def test_a_retried_job_REUSES_completed_step_artifacts_and_does_not_re_run_them_issue_469(tmp_path):
    """End-to-end via the runner's call log. A job whose step N fails on attempt 1 and succeeds on
    attempt 2 must NOT re-execute steps 1..N-1. Build a real PlanRunner over three toy steps whose
    `applies()` returns False once their on-disk marker in ctx.work exists — the "my output is
    already on disk, skip me" shape real steps use (AcquireAudio, Separate, ProbeSilence). Drive it
    through dial_home._run_job on the SAME jobId twice: attempt 1 writes step-1/step-2 markers, step 3
    fails RETRYABLY; attempt 2 must skip steps 1 and 2 and run only step 3."""
    import os

    from src.runtime import Ctx, LinearPlan, PlanRunner, Step, StepResult  # noqa: F401
    from src.vocabulary import Stage

    ran: list[str] = []

    class MarkerStep(Step):
        """Skips itself once its marker file exists in scratch — the on-disk reuse guard shape."""

        stage = Stage.DOWNLOADING

        def __init__(self, name: str, *, fail_times: int = 0) -> None:
            self.name = name
            self.writes = frozenset()
            self.reads = frozenset({"work"})
            self._fail_times = fail_times
            self._marker = None

        def _marker_path(self, ctx: Ctx) -> str:
            return os.path.join(ctx.work, f"{self.name}.done")

        def applies(self, ctx: Ctx) -> bool:
            return not os.path.exists(self._marker_path(ctx))

        async def run(self, ctx: Ctx):
            ran.append(self.name)
            if self._fail_times > 0:
                self._fail_times -= 1
                raise RuntimeError("transient network blip")  # retryable
            os.makedirs(ctx.work, exist_ok=True)
            with open(self._marker_path(ctx), "w") as fh:
                fh.write("done")
            yield ProgressEvent(stage=self.stage, pct=100)

    step1 = MarkerStep("acquire")
    step2 = MarkerStep("separate")
    step3 = MarkerStep("align", fail_times=1)  # fails ONCE (attempt 1), succeeds on attempt 2
    plan = LinearPlan("process", [step1, step2, step3])

    async def noop_runner(argv):
        if False:
            yield ""

    processor = PlanRunner(runner=noop_runner, plans=lambda j, e: plan)

    async def send(_m):
        return None

    spec = JobSpec(
        job_id="jReuse",
        media_id="m1",
        job_type="stems",
        source_uri="https://y/x",
        params={},
        media_dir=str(tmp_path),
    )

    # Attempt 1: steps 1 and 2 complete (write markers), step 3 fails retryably.
    client = WorkerClient(send, processor, capabilities=["stems"], media_dir=str(tmp_path))
    await client._run_job(spec)
    assert ran == ["acquire", "separate", "align"], f"attempt 1 ran all three, got {ran}"
    assert (tmp_path / "work" / "jReuse" / "acquire.done").exists(), "scratch must survive the retryable fail"

    # Attempt 2, SAME jobId and scratch: steps 1 and 2 skip on their markers, only step 3 reruns.
    ran.clear()
    await client._run_job(spec)
    assert ran == ["align"], f"attempt 2 must reuse completed steps' scratch, running ONLY step 3, got {ran}"


# capabilities="none" matches neither stems nor align, so this exercises the config path without
# importing demucs or whisperx.
def test_torch_threads_exports_omp_for_the_demucs_SUBPROCESS(monkeypatch):
    """demucs runs as a separate CLI, so torch.set_num_threads() in THIS process cannot reach it.
    The cap has to ride os.environ, which the child inherits."""
    import os

    from src.host.config import WorkerConfig

    monkeypatch.delenv("OMP_NUM_THREADS", raising=False)
    monkeypatch.delenv("MKL_NUM_THREADS", raising=False)
    cfg = WorkerConfig.from_env({"ENCORE_TORCH_THREADS": "3", "ENCORE_WORKER_CAPABILITIES": "none"})
    _build_processor(cfg)
    assert os.environ["OMP_NUM_THREADS"] == "3"
    assert os.environ["MKL_NUM_THREADS"] == "3"


def test_no_torch_threads_leaves_the_environment_alone(monkeypatch):
    import os

    from src.host.config import WorkerConfig

    monkeypatch.delenv("OMP_NUM_THREADS", raising=False)
    # Nothing can contend, the one case that keeps torch's physical-core default over a derived cap.
    _build_processor(WorkerConfig.from_env({"ENCORE_WORKER_CAPABILITIES": "none", "ENCORE_DEMUCS_JOBS": "1"}))
    assert "OMP_NUM_THREADS" not in os.environ


def test_threads_are_capped_automatically_once_separations_can_contend(monkeypatch):
    import os

    from src.host.config import WorkerConfig

    monkeypatch.delenv("OMP_NUM_THREADS", raising=False)
    # concurrency x jobs > 1 derives a cap, and that cap must reach the demucs SUBPROCESS via the env.
    cfg = WorkerConfig.from_env(
        {"ENCORE_WORKER_CAPABILITIES": "none", "ENCORE_WORKER_CONCURRENCY": "2", "ENCORE_DEMUCS_JOBS": "4"}
    )
    assert cfg.torch_threads is not None, "8 parallel separations must not each default to all cores"
    _build_processor(cfg)
    assert os.environ["OMP_NUM_THREADS"] == str(cfg.torch_threads)


def test_oversubscription_warns_when_concurrency_times_jobs_exceeds_cores():
    from src.host.config import WorkerConfig

    cfg = WorkerConfig.from_env({"ENCORE_WORKER_CONCURRENCY": "4", "ENCORE_DEMUCS_JOBS": "4"})
    warns = dh.oversubscription_warnings(cfg, 10)
    assert any("16 parallel" in w for w in warns)
    # from_env already derived the cap, so a warning would name a fix already in place.
    assert not any("ENCORE_TORCH_THREADS" in w for w in warns)


def test_oversubscription_silent_when_it_fits_and_threads_are_capped():
    from src.host.config import WorkerConfig

    cfg = WorkerConfig.from_env(
        {"ENCORE_WORKER_CONCURRENCY": "2", "ENCORE_DEMUCS_JOBS": "4", "ENCORE_TORCH_THREADS": "1"}
    )
    assert dh.oversubscription_warnings(cfg, 10) == []


def test_oversubscription_is_a_noop_when_cores_are_unknown():
    from src.host.config import WorkerConfig

    cfg = WorkerConfig.from_env({"ENCORE_WORKER_CONCURRENCY": "8", "ENCORE_DEMUCS_JOBS": "8"})
    assert dh.oversubscription_warnings(cfg, None) == []


# A cancel message cancels the in-flight task, which kills the child via GeneratorExit.
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

    # Slot freed, no dangling task entry, and NO spurious job:failed.
    assert client.state.slots_free == 1
    assert "jX" not in client._tasks
    assert sock.of_type(protocol.FAILED) == []


@pytest.mark.asyncio
async def test_cancel_for_an_untracked_job_still_frees_the_slot(tmp_path):
    # A job whose task already finished, or a slot held without one, must still be freed by cancel.
    sock = FakeSocket()
    client = make_client(sock, tmp_path)
    client.state.start("ghost")
    assert client.state.slots_free == 0
    client._on_cancel({"type": protocol.CANCEL, "jobId": "ghost"})
    assert client.state.slots_free == 1


@pytest.mark.asyncio
async def test_malformed_assign_missing_jobtype_rejects_just_that_job(tmp_path):
    sock = FakeSocket()
    client = make_client(sock, tmp_path)
    # A jobId with no jobType/mediaId must not raise out of the read loop and kill the socket.
    await client.handle({"type": protocol.ASSIGN, "jobId": "bad1"})
    await client.drain()
    rejects = sock.of_type(protocol.REJECT)
    assert len(rejects) == 1 and rejects[0]["jobId"] == "bad1"
    assert "malformed" in rejects[0]["reason"]
    # The slot was never consumed and the client is still usable.
    assert client.state.slots_free == 1


@pytest.mark.asyncio
async def test_malformed_assign_missing_jobid_is_dropped_without_raising(tmp_path):
    sock = FakeSocket()
    client = make_client(sock, tmp_path)
    # No usable jobId, so there is no job-scoped reject to send: log and ignore, never raise.
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
    # The good job still ran to completion after the bad one was handled.
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
    """Building the stems runner must not import torch or bs_roformer: both separators shell out to
    a CLI, so the multi-GB ML frameworks belong to the subprocess, not to this process — a
    demucs-only box must never pay for roformer's machinery just from constructing the runner.
    """
    import sys

    from src import plans

    plans.stems_runner(runner=None)
    loaded = {m.split(".")[0] for m in sys.modules}
    assert "torch" not in loaded
    assert "bs_roformer" not in loaded


@pytest.mark.asyncio
async def test_drain_cancel_cancels_inflight_tasks(tmp_path):
    """drain(cancel=True) is what the reconnect path calls when the socket drops: the abandoned
    client's process would otherwise run to completion against a dead socket, lose its result, and
    race the core's reaper (which requeues the same job) — duplicate GPU work."""
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

    # The reconnect-loop finally block on a socket drop.
    await asyncio.wait_for(client.drain(cancel=True), timeout=5)

    assert cancelled.is_set(), "the abandoned process was cancelled (GeneratorExit reaches the child)"
    assert old_task.cancelled() or old_task.done()
    assert "jDrop" not in client._tasks  # done-callback popped it
    # A cancelled process reports NO job:failed — CancelledError is not the broad except that does.
    assert sock.of_type(protocol.FAILED) == []


@pytest.mark.asyncio
async def test_drain_without_cancel_still_awaits(tmp_path):
    # cancel=False keeps the graceful-settle behaviour every other test relies on.
    sock = FakeSocket()
    client = make_client(sock, tmp_path)
    await client.handle(assign())
    await client.drain()  # no cancel arg
    assert sock.of_type(protocol.COMPLETE), "the job ran to completion, not cancelled"


@pytest.mark.asyncio
async def test_object_store_without_uploader_rejects_the_job(tmp_path):
    """MEDIA_STORE=object on the core + a worker with no S3 uploader = the worker would write a
    local path and report it, the core marks the song ready, and serves from S3 where nothing was
    put — refuse the job instead."""
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
    # With an uploader wired, object mode is honoured normally.
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
    # Local mode, the default and the bucketless-object fallback.
    sock = FakeSocket()
    client = make_client(sock, tmp_path)
    await client.handle({"type": protocol.WELCOME, "mediaStore": {"kind": "local"}})
    await client.handle(assign(job_id="jLocal"))
    await client.drain()
    assert sock.of_type(protocol.COMPLETE)


# The worker must SEND worker:heartbeat itself, not only answer a ping the core never emits:
# registry.heartbeat is the only path that reconciles slotsFree after a reap, so without a periodic
# sender one reaped job strands the worker's capacity forever.


@pytest.mark.asyncio
async def test_heartbeat_loop_sends_periodically_without_a_ping(tmp_path):
    # heartbeat_loop is the ONLY production path, since the core sends no `ping`.
    sock = FakeSocket()
    client = make_client(sock, tmp_path)
    client.heartbeat_interval_sec = 0.1  # the loop floors the sleep at 0.1s to avoid spinning
    task = asyncio.create_task(client.heartbeat_loop())
    # Two ticks, then stop the unbounded loop.
    await asyncio.sleep(0.35)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    hb = sock.of_type(protocol.HEARTBEAT)
    assert len(hb) >= 2, f"expected periodic heartbeats, got {sock.types()}"
    # No PING involved: this leg cannot depend on a command the core never sends.
    assert protocol.PING not in sock.types()
    # The frame carries this worker's live capacity, which registry.heartbeat reads.
    assert hb[0]["slotsFree"] == 1 and hb[0]["workerId"] == "w1"


@pytest.mark.asyncio
async def test_heartbeat_loop_reports_reduced_slots_while_a_job_runs(tmp_path):
    # slotsFree must reflect running jobs: that reconciled number is what hands a slot back after a reap.
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
    # The WELCOME arm adopts heartbeatIntervalSec and the loop ticks at it.
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
    # Welcome still replies with nothing.
    assert sock.sent == []


@pytest.mark.asyncio
async def test_welcome_ignores_a_missing_or_bad_interval(tmp_path):
    # A missing or garbage field must not silence the leg: the default floor keeps heartbeats flowing.
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


# WIRING GUARDS: a mechanism never wired to its call site is invisible to behavioural tests, so these
# pin the wiring at the source level (ast).
import ast as _ast  # noqa: E402
from pathlib import Path as _Path  # noqa: E402


def _run_forever_ast():
    src = _Path(dh.__file__).read_text(encoding="utf-8")
    for node in _ast.walk(_ast.parse(src)):
        if isinstance(node, (_ast.FunctionDef, _ast.AsyncFunctionDef)) and node.name == "_run_forever":
            return node
    raise AssertionError("_run_forever not found in dial_home.py")


def test_run_forever_starts_the_heartbeat_loop():
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
    )


def test_run_forever_cancels_the_heartbeat_task_in_a_finally():
    fn = _run_forever_ast()
    cancels_in_finally = []
    for node in _ast.walk(fn):
        if isinstance(node, _ast.Try) and node.finalbody:
            for stmt in _ast.walk(_ast.Module(body=node.finalbody, type_ignores=[])):
                if isinstance(stmt, _ast.Call) and getattr(stmt.func, "attr", None) == "cancel":
                    cancels_in_finally.append(stmt)
    assert cancels_in_finally, (
        "_run_forever never cancels the heartbeat task in a finally — it would leak across reconnects"
    )


def test_run_forever_finally_cancels_in_flight_synchronously_and_does_NOT_await_drain_inline_459():
    fn = _run_forever_ast()
    finalies = [n for n in _ast.walk(fn) if isinstance(n, _ast.Try) and n.finalbody]
    assert finalies, "_run_forever has no try/finally"
    calls_cancel_now = False
    awaits_drain_inline = False
    for node in finalies:
        mod = _ast.Module(body=node.finalbody, type_ignores=[])
        for stmt in _ast.walk(mod):
            if isinstance(stmt, _ast.Call) and getattr(stmt.func, "attr", None) == "cancel_now":
                calls_cancel_now = True
            # An `await <x>.drain(...)` directly in the finally is what blocks redial.
            if isinstance(stmt, _ast.Await):
                inner = stmt.value
                if isinstance(inner, _ast.Call) and getattr(inner.func, "attr", None) == "drain":
                    awaits_drain_inline = True
    assert calls_cancel_now, (
        "_run_forever's finally never calls client.cancel_now() — the synchronous cancel that lets "
        "redial proceed without awaiting an uninterruptible ML pass would be gone"
    )
    assert not awaits_drain_inline, (
        "_run_forever's finally awaits client.drain(...) INLINE, holding the reconnect loop for a "
        "full align while the reaper has requeued the job. The drain must be DETACHED (scheduled, "
        "not awaited) so redial is concurrent with the settle"
    )


def test_run_forever_detaches_the_drain_rather_than_awaiting_it_459():
    fn = _run_forever_ast()
    schedules_drain = False
    for node in _ast.walk(fn):
        if isinstance(node, _ast.Call) and getattr(node.func, "attr", None) in (
            "ensure_future",
            "create_task",
        ):
            for a in node.args:
                if isinstance(a, _ast.Call) and getattr(a.func, "attr", None) == "drain":
                    schedules_drain = True
    assert schedules_drain, (
        "_run_forever never SCHEDULES client.drain(...) as a detached task — the settle must run in "
        "the background so redial is not blocked by it"
    )
    # The set that keeps the detached task alive must be referenced by name in dial_home.
    src = _Path(dh.__file__).read_text(encoding="utf-8")
    assert "_DETACHED_DRAINS" in src, (
        "the _DETACHED_DRAINS tracking set is gone — a detached drain task could be GC'd mid-flight "
    )


@pytest.mark.asyncio
async def test_build_processor_threads_ENCORE_YTDLP_BIN_into_the_align_plan(tmp_path):
    """`_build_processor` builds the align runner from a WorkerConfig; the configured `cfg.ytdlp_bin`
    (ENCORE_YTDLP_BIN) must reach the FetchCaptions steps that plan actually runs, not stop at the
    capability probe. Drives the align PlanRunner, extracts a real FetchCaptions step, runs it
    through a recording runner, and asserts the configured binary lands at argv[0].
    """
    from src.host.config import WorkerConfig
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


def test_sweep_reclaims_an_aged_orphan_but_never_a_live_one(tmp_path):
    """A retryable failure on the LAST attempt leaks scratch (no attempt count on the wire); this
    periodic, age-bounded sweep reclaims an aged orphan but leaves a live job's dir alone."""
    from src.dial_home import sweep_orphaned_scratch

    work = tmp_path / "work"
    orphan = work / "jExhausted"  # a job that exhausted its retries; nothing will re-run it
    live = work / "jRunning"  # this worker's in-flight job
    for d in (orphan, live):
        d.mkdir(parents=True)
        (d / "input.wav").write_bytes(b"BIG")

    removed = sweep_orphaned_scratch(str(tmp_path), frozenset({"jRunning"}), min_age_sec=0)

    assert removed == ["jExhausted"], f"only the orphan must be reclaimed, got {removed}"
    assert not orphan.exists(), "the exhausted-retry orphan must be reclaimed"
    assert live.exists(), "this worker's live job's scratch must NEVER be swept"


def test_sweep_never_touches_a_FRESH_dir_even_when_not_in_the_live_set(tmp_path):
    """On a shared media volume, another worker's in-flight scratch is not in THIS worker's live
    set, so the AGE bound is the real guard: a scratch touched within min_age_sec is never swept
    regardless of the live set."""
    from src.dial_home import sweep_orphaned_scratch

    other_worker_live = tmp_path / "work" / "jOtherWorkerLive"
    other_worker_live.mkdir(parents=True)
    (other_worker_live / "decoded.wav").write_bytes(b"another worker is writing this RIGHT NOW")

    removed = sweep_orphaned_scratch(str(tmp_path), frozenset())  # empty live set, default 6h age bound

    assert removed == [], f"a freshly-written scratch must never be swept, got {removed}"
    assert other_worker_live.exists(), (
        "a concurrent worker's in-flight scratch was destroyed — the shared-volume regression (round 2)"
    )


def test_sweep_uses_the_NEWEST_mtime_in_the_subtree_not_the_top_dir(tmp_path):
    """The age check must track the newest file anywhere under the dir, not the top dir's own mtime,
    or a long separation writing deep inside it reads as 'old' scratch."""
    import os
    import time as _time

    from src.dial_home import sweep_orphaned_scratch

    d = tmp_path / "work" / "jDeepWrite"
    d.mkdir(parents=True)
    fresh = d / "stems" / "vocals.wav"
    fresh.parent.mkdir(parents=True)
    fresh.write_bytes(b"being written now")
    old = _time.time() - 10 * 3600  # 10h ago, older than the 6h bound
    os.utime(d, (old, old))  # backdate ONLY the top dir; the deep file stays fresh

    removed = sweep_orphaned_scratch(str(tmp_path), frozenset(), min_age_sec=6 * 3600)

    assert removed == [], "a dir with a fresh file deep inside must not be swept on the top dir's stale mtime"
    assert fresh.exists()


def test_sweep_reclaims_a_dir_whose_whole_subtree_is_old(tmp_path):
    """The positive side of the age bound: an orphan untouched for longer than the bound IS reclaimed."""
    import os
    import time as _time

    from src.dial_home import sweep_orphaned_scratch

    d = tmp_path / "work" / "jStaleOrphan"
    inner = d / "input.wav"
    d.mkdir(parents=True)
    inner.write_bytes(b"old decoded source")
    old = _time.time() - 10 * 3600
    for path in (inner, d):
        os.utime(path, (old, old))

    removed = sweep_orphaned_scratch(str(tmp_path), frozenset(), min_age_sec=6 * 3600)

    assert removed == ["jStaleOrphan"], f"an aged orphan must be reclaimed, got {removed}"
    assert not d.exists()


def test_sweep_is_a_noop_when_there_is_no_work_dir(tmp_path):
    # A fresh box has no work/ yet, and the sweep must not crash on that.
    from src.dial_home import sweep_orphaned_scratch

    assert sweep_orphaned_scratch(str(tmp_path), frozenset()) == []


def test_run_forever_starts_the_periodic_scratch_sweep():
    fn = _run_forever_ast()
    started = [
        n
        for n in _ast.walk(fn)
        if isinstance(n, _ast.Call)
        and getattr(n.func, "attr", None) in ("create_task", "ensure_future")
        and any(
            getattr(a.func, "id", None) == "_scratch_sweep_loop" for a in n.args if isinstance(a, _ast.Call)
        )
    ]
    assert started, (
        "_run_forever never starts _scratch_sweep_loop — an exhausted-retry job's preserved scratch "
        "would leak until the worker restarts"
    )


@pytest.mark.asyncio
async def test_scratch_sweep_loop_sweeps_once_before_its_first_sleep(monkeypatch):
    """The reaper's FIRST pass must not wait out the interval, or a worker restarted to clear a
    stuck box reclaims nothing for the whole interval. Patches `src.scratch_reaper`, where the loop
    and sweep actually live, not the re-export on `dial_home`."""
    import src.scratch_reaper as dh

    calls: list[frozenset[str]] = []
    monkeypatch.setattr(dh, "sweep_orphaned_scratch", lambda md, live, **kw: calls.append(live) or [])

    slept = asyncio.Event()

    async def _fake_sleep(_secs):
        slept.set()
        raise asyncio.CancelledError  # end the loop at its first sleep so the test terminates

    monkeypatch.setattr(dh.asyncio, "sleep", _fake_sleep)
    with contextlib.suppress(asyncio.CancelledError):
        await dh._scratch_sweep_loop("/media", lambda: frozenset({"live"}))

    assert calls, "the reaper slept before its first sweep — the startup reclaim never runs"
    assert slept.is_set(), "the loop never reached its interval sleep"


@pytest.mark.asyncio
async def test_scratch_sweep_loop_survives_a_failing_pass(monkeypatch, capsys):
    """A raising pass (e.g. EACCES on a shared volume) is logged and the NEXT interval still runs."""
    import src.scratch_reaper as dh

    passes = {"n": 0}

    def _explode(md, live, **kw):
        passes["n"] += 1
        if passes["n"] == 1:
            raise PermissionError("EACCES on a shared volume")
        return ["jOrphan"]

    monkeypatch.setattr(dh, "sweep_orphaned_scratch", _explode)

    async def _fake_sleep(_secs):
        if passes["n"] >= 2:
            raise asyncio.CancelledError
        return None

    monkeypatch.setattr(dh.asyncio, "sleep", _fake_sleep)
    with contextlib.suppress(asyncio.CancelledError):
        await dh._scratch_sweep_loop("/media", lambda: frozenset())

    assert passes["n"] >= 2, "the reaper stopped after a failing pass instead of retrying next interval"
    out = capsys.readouterr().out
    assert "scratch sweep failed" in out, "a failed sweep left nothing in the log"


def test_run_forever_pins_and_observes_the_sweep_task():
    """A bare `ensure_future` leaves the reaper task weakly referenced (collectable mid-flight) and
    its exception unretrieved, so both ways it can stop are invisible without this pin."""
    fn = _run_forever_ast()
    src = _ast.dump(fn)
    assert "_SCRATCH_SWEEPS" in src, "the sweep task is not pinned — it can be garbage-collected mid-flight"
    assert "_on_scratch_sweep_done" in src, "nothing observes the sweep task, so a dead reaper is silent"


@pytest.mark.asyncio
async def test_processing_id_from_assign_frame_reaches_the_job_spec(tmp_path):
    """the assign frame now carries processingId so the worker can tag its own logs/notes with the
    same trace id the operator sees on /metrics/<mediaId>. Capture the JobSpec the processor is
    handed and prove the id threaded through."""
    captured: list[JobSpec] = []

    class CapturingProcessor:
        async def process(self, job: JobSpec):
            captured.append(job)
            yield CompleteResult(media_uri=str(Path(tmp_path) / "out.flac"), artifacts={})

    sock = FakeSocket()
    client = WorkerClient(
        sock.send,
        CapturingProcessor(),
        worker_id="w1",
        capabilities=["stems"],
        concurrency=1,
        media_dir=str(tmp_path),
        version="test",
    )
    frame = assign()
    frame["processingId"] = "process-xyz"
    await client.handle(frame)
    await client.drain()

    assert len(captured) == 1
    assert captured[0].processing_id == "process-xyz"


@pytest.mark.asyncio
async def test_processing_id_defaults_empty_for_a_legacy_frame_without_it(tmp_path):
    """A core that predates the field sends no processingId; the worker must not KeyError, it defaults to
    the empty string (the ledger's own sentinel for a pre-processingId row)."""
    captured: list[JobSpec] = []

    class CapturingProcessor:
        async def process(self, job: JobSpec):
            captured.append(job)
            yield CompleteResult(media_uri=str(Path(tmp_path) / "out.flac"), artifacts={})

    sock = FakeSocket()
    client = WorkerClient(
        sock.send,
        CapturingProcessor(),
        worker_id="w1",
        capabilities=["stems"],
        concurrency=1,
        media_dir=str(tmp_path),
        version="test",
    )
    await client.handle(assign())  # no processingId key
    await client.drain()

    assert len(captured) == 1
    assert captured[0].processing_id == ""


def test_run_forever_reports_the_klp_line_bounder_state_at_startup():
    # klp_probe_line() is worthless unless _run_forever actually CALLS it at startup.
    import ast

    src = Path(dh.__file__).read_text(encoding="utf-8")
    fn = next(
        n
        for n in ast.walk(ast.parse(src))
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == "_run_forever"
    )
    calls_probe = any(
        isinstance(node, ast.Call)
        and (
            (isinstance(node.func, ast.Name) and node.func.id == "klp_probe_line")
            or (isinstance(node.func, ast.Attribute) and node.func.attr == "klp_probe_line")
        )
        for node in ast.walk(fn)
    )
    assert calls_probe, "_run_forever must call klp_probe_line() to report the line-bounder state"


@pytest.mark.asyncio
async def test_reject_when_params_is_not_an_object_issue_459(tmp_path):
    # `params` is the last required assign field with no parse layer at the boundary. A non-dict would
    # raise deeper in the process, escape into the reconnect handler and tear down the socket for one
    # bad frame, so it must be rejected job-scoped HERE.
    sock = FakeSocket()
    client = make_client(sock, tmp_path)
    bad = assign()
    bad["params"] = ["not", "an", "object"]
    await client.handle(bad)
    await client.drain()
    rejects = sock.of_type(protocol.REJECT)
    assert len(rejects) == 1, f"expected exactly one reject, got {sock.types()}"
    assert rejects[0]["jobId"] == "j1"
    assert "params" in rejects[0]["reason"]
    # Never accepted, never started a task, slot untouched.
    assert protocol.ACCEPT not in sock.types()
    assert client.state.slots_free == 1


@pytest.mark.asyncio
async def test_cancel_now_cancels_in_flight_without_awaiting_issue_459(tmp_path):
    # The reconnect finally must cancel SYNCHRONOUSLY, so a subprocess step's GeneratorExit fires at
    # once, without blocking the loop on an uninterruptible run_blocking thread. cancel_now() requests
    # cancellation and returns, leaving the settle to a detached drain.
    sock = FakeSocket()
    client = make_client(sock, tmp_path)

    async def _never():
        await asyncio.sleep(3600)

    t = asyncio.ensure_future(_never())
    client._tasks["stuck"] = t
    # One loop turn, so the task is actually awaiting the sleep before cancellation.
    await asyncio.sleep(0)
    client.cancel_now()
    # cancel_now returns without awaiting: the task is asked to stop, not settled.
    assert not t.done()
    # ...and the cancellation lands when the task is finally awaited.
    with pytest.raises(asyncio.CancelledError):
        await t
    assert t.cancelled()


def test_protocol_complete_emits_selection_only_when_present_669():
    """The complete message carries the variant-pick provenance so the core can persist it:
    selection is emitted when given and omitted when None (mirrors stages)."""
    rec = {"choices": [{"textSource": "lrclib", "chosen": "v1", "decidedBy": "agreement", "votes": 2}]}
    msg = protocol.complete("w1", "j1", "derived/lyrics/m1.json", selection=rec)
    assert msg["selection"] == rec
    assert "selection" not in protocol.complete("w1", "j1", "u")


@pytest.mark.asyncio
async def test_worker_forwards_the_processor_selection_onto_the_complete_message_669(tmp_path):
    """dial_home must forward the CompleteResult.selection the processor produced onto the wire —
    the last link of the worker emit chain (selection=result.selection)."""
    rec = {
        "baselineFallback": False,
        "winnerSuspect": False,
        "winnerScore": 0.94,
        "choices": [
            {
                "textSource": "lrclib",
                "considered": 2,
                "chosen": "lrclib-main",
                "chosenScore": 0.94,
                "decidedBy": "agreement",
                "votes": 2,
                "rejected": [{"label": "lrclib-alt", "score": 0.61}],
            }
        ],
    }

    class _SelProc:
        async def process(self, job):
            yield ProgressEvent(stage="aligning", pct=100)
            yield CompleteResult(media_uri="derived/lyrics/m1.json", artifacts={}, selection=rec)

    sock = FakeSocket()
    client = WorkerClient(
        sock.send,
        _SelProc(),
        worker_id="w1",
        capabilities=["align"],
        concurrency=1,
        media_dir=str(tmp_path),
        version="test",
    )
    await client.handle(assign(job_type="align"))
    await client.drain()

    completes = sock.of_type(protocol.COMPLETE)
    assert len(completes) == 1
    assert completes[0]["selection"] == rec
