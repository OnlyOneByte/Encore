"""songProfile builder + engine wiring — the always-publish contract. Core reads a PRESENT profile as
'the analysis step ran' and an ABSENT one as 'still processing', so the load-bearing assertion is that a
songProfile object is ALWAYS in the completion artifacts, with null inner fields when analysis found
or produced nothing. A profile failure must NEVER fail the job."""

import os
import sys
import wave
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import plans  # noqa: E402
from src.analysis import song_profile  # noqa: E402
from src.processor import CompleteResult, JobSpec  # noqa: E402
from src.separation import demucs  # noqa: E402
from tests.cli_fakes import fake_cli_runner  # noqa: E402
from tests.conftest import drain as _drain  # noqa: E402

WIRE_KEYS = {
    "keyTonic",
    "keyMode",
    "keyConfidence",
    "lowMidi",
    "highMidi",
    "p05Midi",
    "p95Midi",
    "histogram",
    "loudnessLufs",
}


def _write_wav(path, samples, sr=22050):
    path = str(path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    pcm = np.clip(samples, -1, 1)
    pcm = (pcm * 32767).astype("<i2")
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm.tobytes())


# ── the builder ─────────────────────────────────────────────────────────────────────
def test_empty_profile_has_the_exact_wire_shape():
    prof = song_profile.empty_profile()
    assert set(prof) == WIRE_KEYS
    assert all(v is None for v in prof.values())


def test_missing_files_yield_a_full_null_profile():
    prof = song_profile.build_song_profile(None, None, "m1")
    assert set(prof) == WIRE_KEYS
    assert all(v is None for v in prof.values())


def test_unreadable_wav_degrades_to_nulls_never_raises(tmp_path):
    # A file that exists but is not a WAV (the shape the subprocess-fake tests produce).
    bad = tmp_path / "not_audio.wav"
    bad.write_bytes(b"FAKE_INSTRUMENTAL")
    logs = []
    prof = song_profile.build_song_profile(str(bad), str(bad), "m1", log=lambda *a, **k: logs.append(a))
    assert set(prof) == WIRE_KEYS
    assert all(v is None for v in prof.values())
    assert logs, "an analysis failure must be logged with its reason"


def test_real_wavs_populate_key_and_range(tmp_path):
    sr = 22050
    # instrumental: a sustained C-major chord → a detectable key
    t = np.arange(sr * 2) / sr
    chord = sum(np.sin(2 * np.pi * (440.0 * 2 ** ((m - 69) / 12.0)) * t) for m in (60, 64, 67))
    _write_wav(tmp_path / "inst.wav", chord, sr)
    # vocals: a steady 220Hz tone → a detectable narrow range
    _write_wav(tmp_path / "voc.wav", np.sin(2 * np.pi * 220.0 * t), sr)

    prof = song_profile.build_song_profile(str(tmp_path / "inst.wav"), str(tmp_path / "voc.wav"), "m1")
    assert prof["keyTonic"] == 0 and prof["keyMode"] == "major"
    assert 0.0 <= prof["keyConfidence"] <= 1.0
    assert prof["lowMidi"] is not None and prof["highMidi"] is not None
    assert isinstance(prof["histogram"], list) and prof["histogram"]


def test_key_survives_when_vocals_missing(tmp_path):
    sr = 22050
    t = np.arange(sr * 2) / sr
    chord = sum(np.sin(2 * np.pi * (440.0 * 2 ** ((m - 69) / 12.0)) * t) for m in (60, 64, 67))
    _write_wav(tmp_path / "inst.wav", chord, sr)
    # no vocals file → key present, range null (independent best-effort halves)
    prof = song_profile.build_song_profile(str(tmp_path / "inst.wav"), None, "m1")
    assert prof["keyTonic"] == 0
    assert prof["lowMidi"] is None


def test_silent_vocals_yield_null_range_not_a_failure(tmp_path):
    sr = 22050
    _write_wav(tmp_path / "voc.wav", np.zeros(sr * 2), sr)  # digital silence
    prof = song_profile.build_song_profile(None, str(tmp_path / "voc.wav"), "m1")
    # the whole point of always-publishing: a silent vocals stem reads as 'ran, found nothing'
    assert prof["lowMidi"] is None and prof["histogram"] is None
    assert set(prof) == WIRE_KEYS


# ── engine wiring: demucs always publishes songProfile ────────────────────────────────
def _demucs_fake_runner(tmp_path):
    """A demucs process fake that writes both stems and emits nothing useful. The acquisition / volumedetect
    / encode branches live in the shared `fake_cli_runner` (issue #455) — including the volumedetect
    branch that makes the silence probe real; only the demucs stem writes are here."""

    async def demucs_handler(argv):
        out_dir = argv[argv.index("-o") + 1]
        model = argv[argv.index("-n") + 1]
        inst = demucs.demucs_no_vocals_path(out_dir, model)
        os.makedirs(os.path.dirname(inst), exist_ok=True)
        Path(inst).write_bytes(b"FAKE_INSTRUMENTAL")
        Path(demucs.demucs_vocals_path(out_dir, model)).write_bytes(b"FAKE_VOCALS")
        return
        yield  # pragma: no cover — makes this an async generator; the return above wins

    return fake_cli_runner(handlers={"demucs": demucs_handler})


@pytest.mark.asyncio
async def test_demucs_publishes_songprofile_even_when_analysis_fails(tmp_path):
    # The fake runner writes placeholder-byte "WAV"s, so the REAL profiler will fail to parse them and
    # degrade to nulls — exactly the always-publish path. songProfile MUST still be present.
    job = JobSpec(
        job_id="j",
        media_id="m1",
        job_type="stems",
        source_uri="https://youtube.com/watch?v=x",
        params={},
        media_dir=str(tmp_path),
    )
    proc = plans.stems_runner(runner=_demucs_fake_runner(tmp_path))  # default (real) profiler
    events = await _drain(proc, job)
    complete = [e for e in events if isinstance(e, CompleteResult)][0]
    assert "songProfile" in complete.artifacts, "profile must ALWAYS be present"
    assert set(complete.artifacts["songProfile"]) == WIRE_KEYS
    assert all(v is None for v in complete.artifacts["songProfile"].values())
    # the load-bearing instrumental is untouched by a profile failure
    assert complete.artifacts["stems"]["instrumental"].endswith("m1-instrumental.flac")


@pytest.mark.asyncio
async def test_demucs_passes_the_raw_wavs_to_the_profiler(tmp_path):
    # Assert the wiring feeds the RAW separated WAVs (no_vocals.wav / vocals.wav) — not the encoded
    # FLAC/m4a — so analysis costs no extra decode.
    seen = {}

    def spy_profiler(inst, voc, media_id):
        seen["inst"], seen["voc"], seen["media_id"] = inst, voc, media_id
        return song_profile.empty_profile()

    job = JobSpec(
        job_id="j",
        media_id="m1",
        job_type="stems",
        source_uri="https://youtube.com/watch?v=x",
        params={},
        media_dir=str(tmp_path),
    )
    proc = plans.stems_runner(runner=_demucs_fake_runner(tmp_path), profiler=spy_profiler)
    await _drain(proc, job)
    assert seen["inst"].endswith("no_vocals.wav")
    assert seen["voc"].endswith("vocals.wav")
    assert seen["media_id"] == "m1"
