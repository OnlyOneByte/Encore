"""The ownership guard, and the config boundary.

The guard exists to prevent ONE failure: two workers publishing different lyrics for one song after the
core reassigned a job mid-alignment. Every test below is about a path to that, so the bias throughout is
fail-closed — an unknown or unconfirmed job may not publish, and being wrong that way costs one
redundant re-claim.
"""

from __future__ import annotations

import pytest

from encore_worker.host.config import ALIGN_EXPERIMENTS, ASR_MODELS, Config, ConfigError
from encore_worker.host.hardware import Report, resolve_backend
from encore_worker.transport.ownership import Ownership, Reason, Standing

# ── the ledger ───────────────────────────────────────────────────────────────────────────────────


def strict() -> Ownership:
    """A ledger with the PULL half enabled — i.e. against a core that answers `job:claim`.

    Explicit because the default is now False: today's core implements neither claim frame, and requiring a
    confirmation it can never send would refuse every publish. Tests of the strong guarantee must opt in, so
    that what they prove is unambiguous.
    """
    return Ownership(require_confirmation=True)


def confirmed(*job_ids: str) -> Ownership:
    """A ledger holding these jobs, accepted AND confirmed by a claim round."""
    own = strict()
    for job_id in job_ids:
        own.accepted(job_id)
    own.claim_answered(owned=frozenset(job_ids), revoked=frozenset(), unknown=frozenset())
    return own


def test_an_unknown_job_may_not_publish() -> None:
    """FAIL CLOSED. Publishing for a job we cannot account for is the exact failure being prevented."""
    own = Ownership()
    assert own.standing("j1") is Standing.UNKNOWN
    assert own.may_publish("j1") is False
    assert "not in this worker's ledger" in own.explain("j1")


def test_a_confirmed_job_may_publish() -> None:
    own = confirmed("j1")
    assert own.standing("j1") is Standing.OURS
    assert own.may_publish("j1") is True


def test_an_accepted_but_unconfirmed_job_may_not_publish_yet() -> None:
    """The pull half. Until a claim round answers, we do not know the core still agrees."""
    own = strict()
    own.accepted("j1")
    assert own.standing("j1") is Standing.OURS
    assert own.may_publish("j1") is False, "ours, but not yet confirmed"
    assert own.pending_claims() == frozenset({"j1"})
    assert "unconfirmed" in own.explain("j1")


def test_a_revoked_job_may_not_publish() -> None:
    """The push half: the core told us, so no round trip is needed."""
    own = confirmed("j1")
    own.revoked("j1")
    assert own.standing("j1") is Standing.LOST
    assert own.may_publish("j1") is False
    assert own.lost_reason("j1") is Reason.REVOKED
    assert "taken from us" in own.explain("j1")


def test_revocation_is_idempotent() -> None:
    """A duplicate frame after a reconnect replay must not change anything."""
    own = confirmed("j1")
    own.revoked("j1")
    own.revoked("j1")
    assert own.standing("j1") is Standing.LOST
    assert own.running() == frozenset()


def test_a_disconnect_makes_everything_unconfirmed_without_abandoning_it() -> None:
    """A blip must not abandon healthy in-flight work — but nothing may publish until re-claimed.

    A disconnect is the event that both expires a lease AND hides the resulting revoked frame, so it is
    exactly when a stale "ours" is most dangerous.
    """
    own = confirmed("j1", "j2")
    own.disconnected()

    assert own.standing("j1") is Standing.OURS, "still ours; a blip is not a reassignment"
    assert own.may_publish("j1") is False, "but unconfirmed, so it may not publish"
    assert own.pending_claims() == frozenset({"j1", "j2"})


def test_a_reconnect_claim_round_restores_publishing() -> None:
    own = confirmed("j1", "j2")
    own.disconnected()
    own.claim_answered(owned=frozenset({"j1"}), revoked=frozenset({"j2"}), unknown=frozenset())

    assert own.may_publish("j1") is True
    assert own.may_publish("j2") is False
    assert own.lost_reason("j2") is Reason.CLAIM_DENIED
    assert own.pending_claims() == frozenset()


def test_a_job_the_core_never_heard_of_is_lost_with_its_own_reason() -> None:
    """A real desync — we are running something the core has no row for — must not read as an ordinary
    reassignment, or it disappears into the noise. It may not publish either way."""
    own = Ownership()
    own.accepted("ghost")
    own.claim_answered(owned=frozenset(), revoked=frozenset(), unknown=frozenset({"ghost"}))

    assert own.may_publish("ghost") is False
    assert own.lost_reason("ghost") is Reason.CORE_NEVER_HEARD_OF_IT
    assert own.lost_reason("ghost") is not Reason.CLAIM_DENIED


def test_cancellation_is_recorded_distinctly_from_reassignment() -> None:
    """An operator cancelling and the reaper reassigning both stop the work, for different reasons."""
    own = confirmed("j1")
    own.revoked("j1", Reason.CANCELLED)
    assert own.lost_reason("j1") is Reason.CANCELLED


def test_re_accepting_a_previously_lost_job_clears_the_loss() -> None:
    """The core may legitimately hand a requeued job back to this worker."""
    own = confirmed("j1")
    own.revoked("j1")
    own.accepted("j1")
    assert own.standing("j1") is Standing.OURS
    assert own.lost_reason("j1") is None


def test_finished_jobs_release_their_slot() -> None:
    own = confirmed("j1")
    own.finished("j1")
    assert own.standing("j1") is Standing.UNKNOWN
    assert own.running() == frozenset()


def test_a_loss_outlives_the_job_it_ended() -> None:
    """A revoked job's driver cleans up the instant it is cancelled. Clearing the reason there would
    erase why the job produced nothing, exactly when an operator asks."""
    own = confirmed("j1")
    own.revoked("j1", Reason.CANCELLED)
    own.finished("j1")
    assert own.lost_reason("j1") is Reason.CANCELLED
    assert own.may_publish("j1") is False


def test_retained_losses_are_bounded() -> None:
    """This process is long-lived; a revoked job id must not stay forever."""
    own = Ownership(_lost_cap=4)
    for n in range(10):
        own.revoked(f"j{n}")
    assert len(own._lost) == 4
    assert own.lost_reason("j9") is Reason.REVOKED, "the newest must be kept"
    assert own.lost_reason("j0") is None, "the oldest must be evicted"


def test_running_reports_what_the_heartbeat_should_claim() -> None:
    own = confirmed("j1", "j2")
    own.revoked("j2")
    assert own.running() == frozenset({"j1"})


# ── config ───────────────────────────────────────────────────────────────────────────────────────


def test_defaults_need_no_environment() -> None:
    cfg = Config.from_env({})
    assert cfg.concurrency == 1, "one job at a time: two GPU passes on one device is slower than two in a row"
    assert cfg.asr_model in ASR_MODELS
    assert cfg.backend is None, "unset means auto-select, not a guess"


def test_reads_the_environment() -> None:
    cfg = Config.from_env(
        {
            "ENCORE_CORE_URL": "ws://core.test/worker",
            "ENCORE_WORKER_ID": "w9",
            "ENCORE_WORKER_CONCURRENCY": "3",
            "ENCORE_SEPARATOR_BACKEND": "mlx",
            "ENCORE_ASR_MODEL": "large-v3",
            "ENCORE_KEEP_RAW_CAPTIONS": "true",
        }
    )
    assert (cfg.core_url, cfg.worker_id, cfg.concurrency) == ("ws://core.test/worker", "w9", 3)
    assert (cfg.backend, cfg.asr_model, cfg.keep_raw_captions) == ("mlx", "large-v3", True)


def test_an_unknown_backend_is_refused_at_the_boundary() -> None:
    """Named here, or it reaches a subprocess several stages later as an opaque failure."""
    with pytest.raises(ConfigError, match="ENCORE_SEPARATOR_BACKEND"):
        Config.from_env({"ENCORE_SEPARATOR_BACKEND": "cuda-maybe"})


@pytest.mark.parametrize(
    "url",
    [
        "http://core:3000/ws?role=worker",
        "core:3000/ws?role=worker",
        "ws:/core:3000/ws",
        "ws:///ws?role=worker",
    ],
)
def test_a_core_url_that_is_not_ws_is_refused_at_the_boundary(url: str) -> None:
    """Otherwise it fails at dial time, and websockets' InvalidURI echoes the dialled URL, token included,
    into the reconnect log on every attempt. The refusal itself never prints a `token=` value."""
    with pytest.raises(ConfigError, match="ENCORE_CORE_URL") as refused:
        Config.from_env({"ENCORE_CORE_URL": f"{url}&token=SECRET", "ENCORE_WORKER_TOKEN": "SECRET"})
    assert "SECRET" not in str(refused.value)


def test_a_ws_or_wss_core_url_is_accepted() -> None:
    for url in ("ws://core:3000/ws?role=worker", "wss://karaoke.example/ws?role=worker"):
        assert Config.from_env({"ENCORE_CORE_URL": url}).core_url == url


def test_an_unknown_asr_checkpoint_is_refused() -> None:
    with pytest.raises(ConfigError, match="ENCORE_ASR_MODEL"):
        Config.from_env({"ENCORE_ASR_MODEL": "enormous"})


def test_alignment_experiments_are_off_unless_named() -> None:
    """PLAN-alignment-v3's rule for an arm that fails its gate: built, tested and measured, but OFF unless
    the operator names it. Spelling is forgiving (case, spaces, empty items); the set is exact."""
    assert Config.from_env({}).align_experiments == frozenset()
    cfg = Config.from_env({"ENCORE_ALIGN_EXPERIMENTS": " l1-mix-kept, L1-BLIND-MEDIAN ,, "})
    assert cfg.align_experiments == frozenset({"l1-mix-kept", "l1-blind-median"})
    assert cfg.align_experiments <= set(ALIGN_EXPERIMENTS)


def test_an_unknown_alignment_experiment_is_refused() -> None:
    """A typo would otherwise measure the default path under the arm's name."""
    with pytest.raises(ConfigError, match=r"ENCORE_ALIGN_EXPERIMENTS names 'l1-mix-kpet'"):
        Config.from_env({"ENCORE_ALIGN_EXPERIMENTS": "l1-mix-kept,l1-mix-kpet"})


def test_the_alignment_model_is_unset_unless_named() -> None:
    """`ENCORE_ALIGN_MODEL` names the ENGLISH bundle, and UNSET means "this device's default" rather
    than any particular model — the device is probed, not configured, so only `__main__.align_model_for` can
    resolve it. An empty or blank value is unset, not a request to load "".

    None also keeps the field out of a bench run's `align_config`, which is what stops the knob's mere
    existence from re-keying every cached emission matrix (`e2e_lib.align_config`).
    """
    assert Config.from_env({}).align_model is None
    assert Config.from_env({"ENCORE_ALIGN_MODEL": "   "}).align_model is None
    assert Config.from_env({"ENCORE_ALIGN_MODEL": " HUBERT_ASR_LARGE "}).align_model == "HUBERT_ASR_LARGE"


#: The modules BESIDE the align step allowed to READ an arm name. `units` is the one reader of the four
#: stage-2 names, and keeping them there rather than in the step is what stops the bench harness from
#: spelling them a second time (docs/arch/04-alignment.md §9.1).
ARM_READERS = ("domain/lyrics/units.py", "__main__.py")

#: The align step itself, as ONE source: its module-level helpers live in siblings, so an arm named
#: in one of them is still named by the step (docs/arch/05-worker.md §1.1).
STEP_GLOB = "steps/align_*.py"


def test_every_declared_arm_is_read_by_the_step() -> None:
    """The other half of the typo guard, and the one the config cannot catch: an arm the CONFIG accepts and
    NOTHING reads is measured as the default path under the arm's name, and a whole bench run says "no
    change" for the most honest-looking reason there is. Every name in `ALIGN_EXPERIMENTS` must therefore
    appear as a literal in the step or in one of `ARM_READERS` (source text, not an import, because
    reading them is a branch deep inside `_time_text_global` that no unit call can enumerate)."""
    from pathlib import Path

    package = Path(__file__).resolve().parent.parent / "encore_worker"
    step_files = sorted(package.glob(STEP_GLOB))
    assert len(step_files) >= 7, f"the step's module set has shrunk to {[p.name for p in step_files]}"
    step = "\n".join(path.read_text() for path in step_files)
    source = "\n".join([step, *((package / name).read_text() for name in ARM_READERS)])
    unread = [arm for arm in ALIGN_EXPERIMENTS if f'"{arm}"' not in source]
    assert not unread, f"declared but never switched on anything: {', '.join(unread)}"
    delegated = [arm for arm in ALIGN_EXPERIMENTS if f'"{arm}"' not in step]
    assert delegated == ["nonlatin-units", "zh-simplify", "mms-roman", "nonlatin-unrouted"], (
        "an arm the step itself does not name must be read by a module this test lists, and the list of "
        f"such arms is part of the claim: {delegated}"
    )


#: The arms table's heading, how it spells a control arm, and the words `config.py` counts them in.
_ARMS_TABLE = "## 14. The experiments knob"
_CONTROL_CELL = "| **control**"
_COUNTED = {"four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10}


def test_the_index_in_config_agrees_with_the_table_it_points_at() -> None:
    """`ALIGN_EXPERIMENTS`' own comment is the INDEX into the arms table — it says how many
    of the names are controls over a default-ON feature — and it had drifted: it read "five" against six rows
    and an edit bumped it to "six" against seven, so the number has never been the table's. A count nobody
    checks is a count a reader trusts, and the arms are the one place this build says "default-off" out loud.

    Held as a pair: every declared arm has a row, and the spelled-out number is the table's `**control**`
    count (docs/arch/04-alignment.md §14).
    """
    from pathlib import Path

    repo = Path(__file__).resolve().parents[2]
    table = (repo / "docs" / "arch" / "04-alignment.md").read_text(encoding="utf-8")
    section = table.split(_ARMS_TABLE, 1)[1].split("### 14.1", 1)[0]
    rows = [line for line in section.splitlines() if line.startswith("| `")]
    named = {line.split("`")[1] for line in rows}
    declared = set(ALIGN_EXPERIMENTS)
    assert named == declared, (
        f"the arms table and `ALIGN_EXPERIMENTS` disagree: only in the table {sorted(named - declared)}, "
        f"only in the code {sorted(declared - named)}"
    )

    controls = [line.split("`")[1] for line in rows if _CONTROL_CELL in line]
    config_doc = (repo / "worker" / "encore_worker" / "host" / "config.py").read_text(encoding="utf-8")
    said = [word for word in _COUNTED if f"{word} of these" in config_doc]
    assert len(said) == 1, f"config.py's arm comment names {said or 'no'} count of the controls"
    assert _COUNTED[said[0]] == len(controls), (
        f"config.py says {said[0]} of the arms are controls; the table marks {len(controls)}: "
        f"{sorted(controls)}"
    )


def test_config_errors_are_not_retryable() -> None:
    """Re-reading the same environment yields the same value; retrying only burns attempts."""
    assert ConfigError.retryable is False


@pytest.mark.parametrize("raw", ["0", "-1", "abc", "1.5"])
def test_a_bad_concurrency_is_refused(raw: str) -> None:
    with pytest.raises(ConfigError, match="ENCORE_WORKER_CONCURRENCY"):
        Config.from_env({"ENCORE_WORKER_CONCURRENCY": raw})


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("1", True),
        ("true", True),
        ("TRUE", True),
        ("yes", True),
        ("on", True),
        ("0", False),
        ("false", False),
        ("no", False),
        ("", False),
        ("maybe", False),
    ],
)
def test_flags_read_what_an_operator_actually_types(raw: str, expected: bool) -> None:
    """`bool("0")` and `bool("false")` are both True, which is the opposite of what was meant."""
    assert Config.from_env({"ENCORE_KEEP_RAW_CAPTIONS": raw}).keep_raw_captions is expected


def test_whitespace_only_values_fall_back_to_the_default() -> None:
    """An env var set to nothing in a compose file is absent, not an override to empty string."""
    assert Config.from_env({"ENCORE_WORKER_ID": "   "}).worker_id == Config.from_env({}).worker_id


# ── backend resolution ───────────────────────────────────────────────────────────────────────────


def mac(**over: object) -> Report:
    base: dict[str, object] = {
        "machine": "arm64",
        "python": "3.12.0",
        "platform": "macOS",
        "apple_silicon": True,
    }
    base.update(over)
    return Report(**base)  # type: ignore[arg-type]


def test_an_explicit_backend_always_wins() -> None:
    """Even on a box that cannot honour it: the failure then names the setting, which is what the
    operator who typed it needs to see."""
    chosen = resolve_backend("torch", report=mac())
    assert chosen.name == "torch"
    assert "explicitly configured" in chosen.why


def test_a_linux_box_auto_selects_torch() -> None:
    linux = Report(machine="x86_64", python="3.12.0", platform="Linux", apple_silicon=False)
    assert resolve_backend(None, report=linux).name == "torch"


def test_the_reason_distinguishes_explicit_from_automatic() -> None:
    """Both behave identically and mean different things when a box turns out on the wrong engine."""
    explicit = resolve_backend("torch", report=mac())
    automatic = resolve_backend(None, report=mac())
    assert explicit.why != automatic.why


def test_cuda_is_derived_from_the_accelerator_not_stored() -> None:
    """So the two cannot disagree. ROCm reports as cuda to torch, which is why this is derived."""
    assert Report(machine="x86_64", python="3", platform="Linux", accelerator="cuda").cuda is True
    assert Report(machine="arm64", python="3", platform="macOS", accelerator="mps").cuda is False
