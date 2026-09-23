"""python-audio-separator engine: pure helpers + engine routing + an end-to-end process.

The real audio-separator process is REAL-ML/NET and unverified in this environment (audio-separator is
not installed on the aarch64 box — see audiosep.py's module warning), the identical stance test_roformer
takes. These cover the argv-free logic — model-token→checkpoint resolution, output-stem discovery, argv
shape — and drive a full stems process with a FAKE `audio-separator` subprocess so the SeparatorEngine seam
is exercised without the package.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.separation import audiosep  # noqa: E402
from tests.conftest import drain as _drain  # noqa: E402


def test_every_whitelist_token_resolves_to_a_checkpoint_filename():
    """Each token must map to a concrete `--model_filename` audio-separator can resolve. A token with no
    mapping would reach the CLI as the token string and fail to download."""
    for token in audiosep.AUDIOSEP_MODELS:
        ckpt = audiosep.resolve_audiosep_checkpoint({"model": token})
        assert ckpt.endswith(".ckpt"), f"{token} → {ckpt} is not a checkpoint filename"


def test_the_default_token_is_the_measured_becruily_checkpoint():
    """The owner ruled Option A on `instrumental_becruily` specifically; the default token must be
    that model and resolve to the exact checkpoint the benchmark measured (checkpoint_cost.py)."""
    assert audiosep.DEFAULT_AUDIOSEP_MODEL == "instrumental_becruily"
    assert audiosep.resolve_audiosep_checkpoint({}) == "mel_band_roformer_instrumental_becruily.ckpt"


def test_resolve_audiosep_checkpoint_rejects_unknown():
    """An explicit-but-unknown token raises (job fails non-retryable) rather than silently separating
    with the default — the same contract as resolve_demucs_model / resolve_roformer_slug."""
    with pytest.raises(ValueError, match="unknown audiosep model"):
        audiosep.resolve_audiosep_checkpoint({"model": "htdemucs"})  # a demucs token is unknown here


def test_resolve_audiosep_checkpoint_defaults_when_unset():
    assert (
        audiosep.resolve_audiosep_checkpoint({}) == audiosep.AUDIOSEP_MODELS[audiosep.DEFAULT_AUDIOSEP_MODEL]
    )


def test_find_audiosep_stems_matches_case_insensitively(tmp_path):
    (tmp_path / "input_(Instrumental)_mel_band_roformer_instrumental_becruily.flac").write_text("x")
    (tmp_path / "input_(Vocals)_mel_band_roformer_instrumental_becruily.flac").write_text("x")
    assert audiosep.find_audiosep_instrumental(str(tmp_path)).endswith(
        "_(Instrumental)_mel_band_roformer_instrumental_becruily.flac"
    )
    assert audiosep.find_audiosep_vocals(str(tmp_path)).endswith(
        "_(Vocals)_mel_band_roformer_instrumental_becruily.flac"
    )


def test_find_audiosep_instrumental_none_when_absent(tmp_path):
    assert audiosep.find_audiosep_instrumental(str(tmp_path)) is None
    assert audiosep.find_audiosep_instrumental(str(tmp_path / "nope")) is None


def test_stem_discovery_is_not_fooled_by_the_instrumental_named_checkpoint(tmp_path):
    """audio-separator names outputs `<name>_(Stem)_<model>.<ext>`, and the model name is INSIDE both
    output filenames. A bare-substring role search would let the model suffix satisfy the wrong role.
    Use a model name that contains BOTH role words (`..._instrumental_..._vocals_...`) so a bare
    `instrumental`/`vocal` substring matches the WRONG file for each search — only the delimited
    `_(Instrumental)_` / `_(Vocals)_` marker keeps them apart. Reds if the marker is a bare substring."""
    model = "some_instrumental_and_vocals_model"  # contains both role words in the suffix
    inst = tmp_path / f"input_(Instrumental)_{model}.flac"
    vox = tmp_path / f"input_(Vocals)_{model}.flac"
    inst.write_bytes(b"INST")
    vox.write_bytes(b"VOX")
    assert audiosep.find_audiosep_instrumental(str(tmp_path)) == str(inst)
    assert audiosep.find_audiosep_vocals(str(tmp_path)) == str(vox)


def test_audiosep_argv_shape():
    argv = audiosep.audiosep_argv("/work/input.wav", "/out", "mel_band_roformer_instrumental_becruily.ckpt")
    assert argv[0] == "audio-separator"
    assert argv[1] == "/work/input.wav", "the input FILE is the positional argument (not a folder)"
    assert argv[argv.index("--model_filename") + 1] == "mel_band_roformer_instrumental_becruily.ckpt"
    assert argv[argv.index("--output_dir") + 1] == "/out"
    assert argv[argv.index("--output_format") + 1] == "FLAC"
    assert "--model_file_dir" not in argv  # omitted when unset


def test_audiosep_argv_includes_model_file_dir_when_set():
    argv = audiosep.audiosep_argv("/in.wav", "/out", "m.ckpt", model_file_dir="/models")
    assert argv[argv.index("--model_file_dir") + 1] == "/models"


def test_engine_for_builds_a_real_audiosep_engine():
    """The parity contract for the new token: `engine_for("audiosep")` must build a real engine
    (capabilities.py advertises `stems:audiosep` only when the dep is present, and the core routes a
    stems:audiosep process here — an unbuildable engine would dispatch and die at plan selection)."""
    from src.separation.engines import AudioSepEngine, engine_for

    eng = engine_for("audiosep")
    assert isinstance(eng, AudioSepEngine)
    assert eng.id == "audiosep"
    assert eng.backend == "audio-separator"


def test_engine_selection_reads_audiosep_from_the_job_param():
    from src.plans import resolve_engines
    from src.runtime.ctx import ResolvedEngines
    from src.separation.engines import engine_for

    assert engine_for(resolve_engines({"engine": "audiosep"}, ResolvedEngines()).separator).id == "audiosep"


def test_a_demucs_default_cannot_reach_the_audiosep_engine():
    """`plans.stems_runner` forwards this worker's `demucs_model` into `engine_for` on every process.
    The audiosep branch must ignore it and keep its OWN default (`instrumental_becruily`), never
    resolve to a demucs checkpoint."""
    from src.separation.audiosep import DEFAULT_AUDIOSEP_MODEL, resolve_audiosep_checkpoint
    from src.separation.engines import engine_for

    eng = engine_for("audiosep", demucs_model="htdemucs")
    assert eng.id == "audiosep"
    assert eng.resolve_model({}) == resolve_audiosep_checkpoint({}, DEFAULT_AUDIOSEP_MODEL)


import os as _os  # noqa: E402

from src import plans  # noqa: E402
from src.processor import CompleteResult, JobSpec, ProgressEvent  # noqa: E402
from src.retry_policy import is_retryable  # noqa: E402
from tests.cli_fakes import fake_cli_runner  # noqa: E402


def _audiosep_fake_runner(store_writes: bool = True, write_vocals: bool = True):
    """A fake runner scripting the real audiosep process shape: yt-dlp → ffmpeg decode → audio-separator →
    ffmpeg volumedetect probe → ffmpeg encode. Records every argv so the test can assert the seam, and
    writes the stems audio-separator would into --output_dir under the UVR `_(Stem)_<model>` template,
    with the model name in the filename that find_outputs must DISCOVER by globbing (not derive)."""
    calls: list[list[str]] = []

    async def audiosep_handler(argv):
        out_dir = argv[argv.index("--output_dir") + 1]
        _os.makedirs(out_dir, exist_ok=True)
        model = "mel_band_roformer_instrumental_becruily"  # a suffix find_outputs cannot have derived
        if store_writes:
            Path(_os.path.join(out_dir, f"input_(Instrumental)_{model}.flac")).write_bytes(b"FAKE_INST")
            if write_vocals:
                Path(_os.path.join(out_dir, f"input_(Vocals)_{model}.flac")).write_bytes(b"FAKE_VOX")
        # coarse tqdm progress — parse_progress returns None by design, so the step emits [0, 100] only
        yield "  0%|          | 0/1 [00:00<?, ?it/s]"
        yield " 47%|████▋     | 1/2 [00:10<00:10]"  # an INTERMEDIATE pct that must NOT leak
        yield "100%|██████████| 1/1 [00:20<00:00]"

    run = fake_cli_runner(handlers={"audio-separator": audiosep_handler}, record=calls)
    return run, calls


def _aspec(tmp_path, **params):
    params.setdefault("engine", "audiosep")
    return JobSpec(
        job_id="ja",
        media_id="ma",
        job_type="stems",
        source_uri="https://www.youtube.com/watch?v=asep",
        params=params,
        media_dir=str(tmp_path),
    )


@pytest.mark.asyncio
async def test_an_audiosep_process_runs_the_real_audiosep_engine_end_to_end(tmp_path):
    """Drives a stems job with engine=audiosep through plans.stems_runner and asserts the seam: the
    engine that ran, the resolved-checkpoint fact, the input FILE (not a dir), and DISCOVERED outputs.

    No `engine=` override, so stems_runner resolves the REAL AudioSepEngine from params.engine; the fake
    runner only stands in for the audio-separator SUBPROCESS."""
    runner, calls = _audiosep_fake_runner()
    proc = plans.stems_runner(runner=runner)  # no engine= override → real AudioSepEngine from params
    events = await _drain(proc, _aspec(tmp_path, model="instrumental_becruily"))

    completes = [e for e in events if isinstance(e, CompleteResult)]
    assert len(completes) == 1, "the audiosep process must publish"
    facts = completes[0].facts

    # the engine that ran is audiosep, its backend is the CLI, not torch
    assert facts["engine"] == "audiosep"
    assert facts["backend"] == "audio-separator"

    # model is the RESOLVED CHECKPOINT filename, never the token (the reason facts.model exists)
    assert facts["model"] == "mel_band_roformer_instrumental_becruily.ckpt"
    assert facts["model"] != "instrumental_becruily", (
        "facts must record the resolved checkpoint, not the token"
    )

    # locate the audio-separator invocation: the decoded input WAV is the POSITIONAL argument (a file,
    # not a folder), and --output_dir is where stems land
    asep = [c for c in calls if c[0] == "audio-separator"]
    assert len(asep) == 1, "the audio-separator CLI ran exactly once"
    argv = asep[0]
    assert _os.path.basename(argv[1]) == "input.wav", "input is the positional FILE argument"
    out_dir = argv[argv.index("--output_dir") + 1]
    assert _os.path.basename(out_dir) == "separated"

    # outputs are DISCOVERED by globbing --output_dir, not derived: the published instrumental resolves
    # to the discovered file (its name carries a model suffix find_outputs could not have derived)
    inst = completes[0].artifacts["stems"]["instrumental"]
    assert inst.endswith("ma-instrumental.flac")
    assert Path(inst).exists()
    # the isolated vocals stem — the guiding track — is ALSO published (lossless FLAC)
    vox = completes[0].artifacts["stems"]["vocals"]
    assert vox.endswith("ma-vocals.flac")
    assert Path(vox).exists()

    # audiosep's parse_progress returns None, so the child's tqdm percentages must NEVER leak — no
    # INTERMEDIATE (0 < pct < 100) value ever appears in the separating stream
    seps = [e.pct for e in events if isinstance(e, ProgressEvent) and e.stage == "separating"]
    assert 0 in seps and 100 in seps
    assert not any(0 < p < 100 for p in seps), f"audiosep must never leak an intermediate pct, got {seps}"


@pytest.mark.asyncio
async def test_an_audiosep_process_that_produces_no_instrumental_fails_loudly(tmp_path):
    """The find_outputs discovery contract from the failure side: if audio-separator writes nothing into
    --output_dir, Separate must raise rather than publish a phantom process — the same guard demucs and
    roformer have, now proven on the audiosep path. And the raise is non-retryable (class): a
    wrong output-filename contract is deterministic, so every retry re-runs the same pass identically."""
    runner, _ = _audiosep_fake_runner(store_writes=False)
    proc = plans.stems_runner(runner=runner)
    with pytest.raises(RuntimeError) as exc:  # PermanentError IS-A RuntimeError
        await _drain(proc, _aspec(tmp_path, model="instrumental_becruily"))
    assert "audiosep produced no instrumental" in str(exc.value)
    assert is_retryable(exc.value) is False


@pytest.mark.asyncio
async def test_an_audiosep_process_missing_vocals_is_best_effort_still_publishes_instrumental(tmp_path):
    """The vocals-LESS half of the discovery contract — the audiosep analogue of the demucs/roformer
    siblings. When audio-separator writes the instrumental but no vocals output, find_audiosep_vocals
    returns None, the publish step drops the null stem, and the process still completes best-effort with the
    vocals key ABSENT (not a None value)."""
    runner, _ = _audiosep_fake_runner(write_vocals=False)
    proc = plans.stems_runner(runner=runner)
    events = await _drain(proc, _aspec(tmp_path, model="instrumental_becruily"))

    completes = [e for e in events if isinstance(e, CompleteResult)]
    assert len(completes) == 1, "the audiosep process must still complete best-effort"
    stems = completes[0].artifacts["stems"]
    assert stems["instrumental"].endswith("ma-instrumental.flac")
    assert Path(stems["instrumental"]).exists()
    assert "vocals" not in stems  # the guiding track is simply ABSENT, never a None value
