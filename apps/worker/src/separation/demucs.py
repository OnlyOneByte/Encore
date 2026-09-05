"""Real make-karaoke pipeline: yt-dlp (fetch source) → Demucs htdemucs (split vocals) → instrumental.

The PURE half (argv builders, progress parsers, stem-path resolver, retryability classifier) has no
subprocess / torch and is unit-tested. The I/O half (DemucsProcessor) streams the two CLIs through
an INJECTABLE async runner, so the whole flow tests with a fake subprocess; the real binaries only
run on a worker box / GPU.

Demucs `--two-stems=vocals` emits two files; the INSTRUMENTAL (backing track) is `no_vocals.wav`.
Both are published: the instrumental is the karaoke output; the isolated `vocals.wav` feeds pitch
extraction and the vocal-guide mix (docs/archive/reference/vocal-guide-spec.md).
"""
from __future__ import annotations

import asyncio
import os
import re
import shutil
from collections import deque
from typing import AsyncIterator, Awaitable, Callable

from ..processor import (
    CompleteResult,
    JobSpec,
    ProgressEvent,
    source_audio_path,
    instrumental_path,
    vocals_path,
    volumedetect_argv,
    parse_max_volume_db,
    is_silent,
)
from ..acquisition.fetch import job_fetcher, local_source_path
from ..vocabulary import Fetcher
from ..acquisition.stream_quality import FORMAT_SELECTOR
from ..analysis import build_song_profile

# The analysis step: (instrumental_wav, vocals_wav, media_id) -> songProfile dict. Injectable so the
# subprocess-fake tests (whose "WAV" files hold placeholder bytes, not real PCM) can pass a no-op and
# assert the wiring/always-publish contract without needing real audio. The real default reads the
# two scratch WAVs that already exist at stage 3 — no extra separation, no extra decode.
Profiler = Callable[[str | None, str | None, str], dict]

DEFAULT_MODEL = "htdemucs"

# The demucs-family checkpoints this engine will run. Mirrors the `demucs` engine's model
# whitelist in packages/shared/src/separators.ts — defence in depth: the core already validates the
# engine+model pairing before enqueueing, but a worker must never shell `demucs -n <arbitrary>` from
# a job param, so an unknown model is rejected here too rather than silently falling back.
DEMUCS_MODELS = ("htdemucs", "htdemucs_ft", "htdemucs_6s")


def resolve_demucs_model(params: dict, default: str = DEFAULT_MODEL) -> str:
    """Pick the demucs checkpoint for a job: the whitelisted `params['model']`, else the worker
    default. An explicit-but-unknown model raises (the job fails non-retryable) instead of quietly
    separating with the wrong model — a silent substitution would ship a different instrumental than
    the room asked for."""
    requested = params.get("model")
    if requested is None or requested == "":
        return default
    if requested not in DEMUCS_MODELS:
        raise ValueError(f"unknown demucs model {requested!r}; expected one of {DEMUCS_MODELS}")
    return requested

# ── pure helpers (no IO) ─────────────────────────────────────────────────────────


def download_argv(source_uri: str, out_template: str, ytdlp_bin: str = "yt-dlp") -> list[str]:
    """yt-dlp argv: fetch the best audio-only stream in its NATIVE container -- no transcode.

    Passing `-x --audio-format wav` inflated a ~5 MB lossy YouTube stream (Opus 135k / AAC 129k --
    measured) into ~59 MB of WAV: a ~12x cost for ZERO fidelity gain, since you cannot restore
    information YouTube already discarded, so the WAV was a lossless copy of lossy audio. The native
    stream is both smaller and higher fidelity than any re-encode.

    `out_template` must carry `%(ext)s` -- the extension is whatever YouTube served (m4a or webm), so
    the caller discovers the real filename with `find_downloaded` rather than assuming one.

    The selector is `stream_quality.FORMAT_SELECTOR`, not a bare `bestaudio`. yt-dlp's own
    ranking is bitrate-led, so an old upload carrying BOTH a modern Opus stream and a legacy AAC one
    can return the AAC purely because its nominal bitrate is higher. Everything downstream inherits
    that choice -- separator, FLAC instrumental, ASR lyrics -- and no later encode can undo it. Its
    final branch is a bare `best` rather than a bare `bestaudio`, because every `bestaudio` branch
    requires an audio-only stream to exist and a muxed-only video would otherwise fail at download;
    with `best` the selector only reorders preferences and never makes a video undownloadable.
    """
    return [
        ytdlp_bin,
        "--no-playlist",
        "--newline",  # emit progress as discrete lines (not \r) so the parser sees each update
        "-f", FORMAT_SELECTOR,  # audio-only, native container, codec-ranked
        "-o", out_template,
        source_uri,
    ]


def decode_argv(input_path: str, out_wav: str, ffmpeg_bin: str = "ffmpeg") -> list[str]:
    """ffmpeg argv: decode any container to the 44.1kHz stereo WAV that Demucs wants.

    WAV is a WORKING format, never a stored one: this lands in `work/<jobId>/` and dies with the
    scratch dir. Forcing stereo/44.1k also normalizes the input so separation behaves identically
    whether the source arrived as Opus-in-webm or AAC-in-m4a.
    """
    return [
        ffmpeg_bin, "-hide_banner", "-loglevel", "error", "-y",
        "-i", input_path,
        "-ac", "2",
        # NO -ar: keep the SOURCE sample rate. YouTube serves 48 kHz Opus, so forcing 44100 here was a
        # resampling stage that cost quality and bought nothing — every output format we use (FLAC,
        # AAC, Opus) handles 48 kHz natively.
        "-c:a", "pcm_s16le",
        out_wav,
    ]


# Stereo AAC at this bitrate is the storage format for both stems. Rationale:
# the SOURCE is ~129-135 kbps lossy, so 192k leaves headroom for the unavoidable second generation
# while still cutting a 54 MB WAV stem to roughly 7 MB. Stereo is the ceiling that matters -- YouTube
# serves stereo, so a surround receiver upmixes from stereo no matter what we store, and anything
# beyond stereo would be invented data. AAC over Opus deliberately: the instrumental has to play in a
# browser <video>, and AAC-in-m4a is the safer bet on Safari.
STEM_BITRATE = "192k"


def encode_flac_argv(input_wav: str, out_path: str, ffmpeg_bin: str = "ffmpeg", level: int = 8) -> list[str]:
    """ffmpeg argv: encode a separated stem to LOSSLESS FLAC, 16-bit stereo at the source rate.

    Used for the INSTRUMENTAL only. 16-bit is transparent here: the signal originated as a lossy
    48 kHz stream, so extra bit depth would only store quantisation noise. compression_level 8 is the
    size/CPU sweet spot and is decode-cheap, which matters for a browser starting playback.
    """
    return [
        ffmpeg_bin, "-hide_banner", "-loglevel", "error", "-y",
        "-i", input_wav,
        "-c:a", "flac", "-compression_level", str(level), "-sample_fmt", "s16", "-ac", "2",
        out_path,
    ]


def encode_stem_argv(input_wav: str, out_path: str, bitrate: str = STEM_BITRATE, ffmpeg_bin: str = "ffmpeg") -> list[str]:
    """ffmpeg argv: encode a separated WAV stem to stereo AAC in an m4a container (VOCALS stem)."""
    return [
        ffmpeg_bin, "-hide_banner", "-loglevel", "error", "-y",
        "-i", input_wav,
        "-c:a", "aac", "-b:a", bitrate, "-ac", "2",
        "-movflags", "+faststart",  # moov atom first so a browser can start playing before full download
        out_path,
    ]


def find_downloaded(directory: str, media_id: str) -> str | None:
    """The file yt-dlp actually produced for this media id, whatever extension it chose.

    Returns None if nothing landed. Ignores yt-dlp's `.part` fragments so an interrupted download is
    never mistaken for a finished one.
    """
    try:
        names = sorted(os.listdir(directory))
    except OSError:
        return None
    for name in names:
        if name.startswith(f"{media_id}.") and not name.endswith((".part", ".ytdl", ".temp")):
            return os.path.join(directory, name)
    return None


def demucs_argv(
    input_path: str,
    out_dir: str,
    model: str = DEFAULT_MODEL,
    demucs_bin: str = "demucs",
    *,
    device: str | None = None,
    jobs: int = 1,
    overlap: float | None = None,
    segment: int | None = None,
    shifts: int | None = None,
) -> list[str]:
    """demucs argv: two-stem (vocals / no_vocals) separation. `--filename {stem}.{ext}` flattens the
    output to <out_dir>/<model>/<stem>.wav so the result path is deterministic regardless of input.

    Every performance flag is OPTIONAL and omitted when unset, so demucs' own defaults keep applying --
    including its cuda-if-available device pick, which is why forcing a device is opt-in rather than
    the default. These are the knobs that decide how long a cook takes:

      - `jobs`    parallel chunk jobs; each holds its own model copy, trading memory for wall time.
      - `overlap` demucs defaults to 0.25; lower is faster with a small quality cost at chunk seams.
      - `segment` chunk length; smaller cuts peak memory on a small box.
      - `shifts`  averages N shifted predictions: better, and proportionally slower.
      - `device`  force "cpu" / "cuda" / "cuda:1" instead of auto-detection.
    """
    argv = [
        demucs_bin,
        "-n", model,
        "--two-stems", "vocals",
        "-o", out_dir,
        "--filename", "{stem}.{ext}",
    ]
    if device:
        argv += ["-d", device]
    if jobs and jobs > 1:
        argv += ["-j", str(jobs)]
    if overlap is not None:
        argv += ["--overlap", str(overlap)]
    if segment is not None:
        argv += ["--segment", str(segment)]
    if shifts is not None:
        argv += ["--shifts", str(shifts)]
    argv.append(input_path)
    return argv


def demucs_no_vocals_path(out_dir: str, model: str = DEFAULT_MODEL) -> str:
    """Where demucs writes the instrumental given the flattened `--filename {stem}.{ext}` template."""
    return os.path.join(out_dir, model, "no_vocals.wav")


def demucs_vocals_path(out_dir: str, model: str = DEFAULT_MODEL) -> str:
    """Where demucs writes the ISOLATED VOCALS given the flattened `--filename {stem}.{ext}` template.
    `--two-stems=vocals` always emits BOTH no_vocals.wav and vocals.wav; both are published."""
    return os.path.join(out_dir, model, "vocals.wav")


_YTDLP_PCT = re.compile(r"\[download\]\s+([\d.]+)%")
_TQDM_PCT = re.compile(r"(\d+)%\|")  # demucs uses a tqdm bar: "  56%|████▏     | ..."


def parse_ytdlp_progress(line: str) -> int | None:
    """Extract the download percentage from a yt-dlp `[download] 45.2% of ...` line, else None."""
    m = _YTDLP_PCT.search(line)
    return int(float(m.group(1))) if m else None


def parse_demucs_progress(line: str) -> int | None:
    """Extract the separation percentage from a demucs tqdm progress line, else None."""
    m = _TQDM_PCT.search(line)
    return int(m.group(1)) if m else None


# Markers that mean a retry will NEVER succeed (source gone / unusable) → non-retryable.
_PERMANENT_MARKERS = (
    "video unavailable",
    "private video",
    "members-only",
    "removed",
    "404",
    "not found",
    "no such file",
    "unsupported url",
    "is not a valid url",
    "copyright",
)


def classify_retryable(stderr_text: str) -> bool:
    """True if the failure is worth retrying (transient); False for permanent source/format errors."""
    low = stderr_text.lower()
    return not any(m in low for m in _PERMANENT_MARKERS)


class ProcessError(RuntimeError):
    """A CLI exited non-zero. Carries a structured `.retryable` so the dial-home loop reports the
    right flag without re-parsing the message (it still falls back to a string heuristic if absent)."""

    def __init__(self, argv: list[str], returncode: int, output_tail: str) -> None:
        self.returncode = returncode
        self.output_tail = output_tail
        self.retryable = classify_retryable(output_tail)
        super().__init__(f"{argv[0]} exited {returncode}: {output_tail.strip()[-500:]}")


# An IDLE-OUTPUT timeout, NOT a wall-clock cap: a legitimate CPU separation can run 45+ minutes while
# still printing a tqdm progress line, and a wall-clock bound short enough to catch a wedged child
# would also kill a slow-but-healthy cook. So the clock is reset on EVERY line the child emits, and
# only fires when the child has gone completely silent for this long — the signature of a wedged
# process, not a slow one. yt-dlp and demucs both emit progress far more often than this.
SUBPROCESS_IDLE_TIMEOUT_SEC = 600.0


class ProcessTimeout(RuntimeError):
    """A CLI produced no output for SUBPROCESS_IDLE_TIMEOUT_SEC and was killed as wedged. Retryable
    on purpose: a stuck child is exactly the transient the core's existing retry path is meant for."""

    def __init__(self, argv: list[str], idle_sec: float) -> None:
        self.retryable = True
        super().__init__(f"{argv[0]} produced no output for {idle_sec:.0f}s; killed as wedged")


# A runner streams a command's merged stdout/stderr line-by-line and raises ProcessError on a
# non-zero exit. Injecting it lets tests drive DemucsProcessor with canned output + no real binary.
Runner = Callable[[list[str]], AsyncIterator[str]]


async def _iter_lines(stream: asyncio.StreamReader) -> AsyncIterator[str]:
    """Yield lines split on BOTH \\n and \\r (tqdm/yt-dlp redraw progress with carriage returns)."""
    buf = b""
    while True:
        chunk = await stream.read(256)
        if not chunk:
            break
        buf += chunk
        parts = re.split(rb"[\r\n]", buf)
        buf = parts.pop()  # keep the trailing partial line
        for p in parts:
            if p.strip():
                yield p.decode("utf-8", "replace")
    if buf.strip():
        yield buf.decode("utf-8", "replace")


async def _terminate(proc: "asyncio.subprocess.Process") -> None:
    """Kill the child if it is still running, then AWAIT it so it is reaped (no zombie, no leaked
    handle). SIGKILL rather than SIGTERM because these CLIs ignore polite signals mid-work, and by the
    time we terminate we have already decided the process must not survive this generator."""
    if proc.returncode is None:
        try:
            proc.kill()
        except ProcessLookupError:
            pass  # it exited between the check and the kill — nothing to reap beyond the wait
    try:
        await proc.wait()
    except Exception:  # noqa: BLE001 — reaping must never mask the original unwind
        pass


async def subprocess_runner(argv: list[str]) -> AsyncIterator[str]:
    """Real runner: spawn the CLI, stream merged output, raise ProcessError on non-zero exit.

    The child is killed and reaped on EVERY exit path — a normal finish, an exception, or a
    GeneratorExit thrown in when the consuming task is cancelled (the cancel path from dial_home).
    Without that guarantee a cancelled or unwinding job orphaned demucs/roformer/yt-dlp, still holding
    CPU or VRAM, while the core's lease expired and the reaper requeued — so retries STACKED real
    separations of one song on a box that can barely run one. An idle-output timeout also kills a
    child that has gone silent, so a wedged process cannot hold its slot forever.
    """
    proc = await asyncio.create_subprocess_exec(
        *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
    )
    assert proc.stdout is not None
    tail: deque[str] = deque(maxlen=30)
    try:
        lines = _iter_lines(proc.stdout)
        while True:
            try:
                line = await asyncio.wait_for(lines.__anext__(), timeout=SUBPROCESS_IDLE_TIMEOUT_SEC)
            except StopAsyncIteration:
                break
            except asyncio.TimeoutError:
                raise ProcessTimeout(argv, SUBPROCESS_IDLE_TIMEOUT_SEC)
            tail.append(line)
            yield line
        rc = await proc.wait()
        if rc != 0:
            raise ProcessError(argv, rc, "\n".join(tail))
    finally:
        # Normal exit: proc has already been waited and this is a cheap no-op. Exception / timeout /
        # GeneratorExit: this is the path that stops the orphaned child.
        await _terminate(proc)


class DemucsProcessor:
    """Production processor. For a `stems` job: fetch the source audio (yt-dlp, unless the source is
    already a local file), run Demucs htdemucs two-stem separation, and move the resulting
    `no_vocals.wav` to the deterministic MediaStore instrumental path. Emits per-stage progress
    (downloading → separating) for the live phone bar."""

    def __init__(
        self,
        *,
        model: str = DEFAULT_MODEL,
        runner: Runner = subprocess_runner,
        ytdlp_bin: str = "yt-dlp",
        demucs_bin: str = "demucs",
        ffmpeg_bin: str = "ffmpeg",
        bitrate: str = STEM_BITRATE,
        flac_level: int = 8,
        device: str | None = None,
        jobs: int = 1,
        overlap: float | None = None,
        segment: int | None = None,
        shifts: int | None = None,
        mover: Callable[[str, str], None] = shutil.move,
        profiler: "Profiler" = build_song_profile,
    ) -> None:
        self._model = model
        self._runner = runner
        self._ytdlp_bin = ytdlp_bin
        self._demucs_bin = demucs_bin
        self._ffmpeg_bin = ffmpeg_bin
        self._bitrate = bitrate
        self._flac_level = flac_level
        # Separation performance knobs — see demucs_argv. All optional; unset means demucs' default.
        self._device = device
        self._jobs = jobs
        self._overlap = overlap
        self._segment = segment
        self._shifts = shifts
        self._move = mover
        self._profiler = profiler

    async def process(self, job: JobSpec) -> AsyncIterator[ProgressEvent | CompleteResult]:
        work = os.path.join(job.media_dir, "work", job.job_id)
        os.makedirs(work, exist_ok=True)

        # The checkpoint is per-JOB (the room's chosen model rides in job.params.model), not a fixed
        # worker constant. `self._model` is only the fallback, so a raise here means the room asked
        # for a model this build does not carry.
        model = resolve_demucs_model(job.params, self._model)

        # ── stage 1: obtain the source audio ──────────────────────────────────────
        # Lands in the `audio/` storage class in its NATIVE container, NOT as WAV in scratch. Raw
        # audio is the one asset that cannot be regenerated (needs network, disappears with the
        # upload), and transcoding lossy YouTube audio to WAV costs ~12x the bytes for zero fidelity.
        # Reused: an existing file means a later align job skips the download.
        if job_fetcher(job) is Fetcher.LOCAL:
            input_path = local_source_path(job)
        else:
            audio_dir = os.path.dirname(source_audio_path(job.media_dir, job.media_id))
            os.makedirs(audio_dir, exist_ok=True)
            input_path = find_downloaded(audio_dir, job.media_id)
            if input_path is None:
                template = os.path.join(audio_dir, f"{job.media_id}.%(ext)s")
                async for ev in self._run_stage("downloading", download_argv(job.source_uri, template, self._ytdlp_bin), parse_ytdlp_progress):
                    yield ev
                input_path = find_downloaded(audio_dir, job.media_id)
                if input_path is None:
                    raise RuntimeError(f"download produced no audio for {job.media_id}")
            else:
                yield ProgressEvent(stage="downloading", pct=100)  # already on disk

        # ── stage 1b: decode to the WAV Demucs wants (TRANSIENT — dies with the scratch dir) ──
        sep_input = os.path.join(work, "input.wav")
        await self._run_quiet(decode_argv(input_path, sep_input, self._ffmpeg_bin))

        # ── stage 2: separate vocals (Demucs htdemucs) ────────────────────────────
        sep_out = os.path.join(work, "separated")
        demucs_cmd = demucs_argv(
            sep_input,
            sep_out,
            model,
            self._demucs_bin,
            device=self._device,
            jobs=self._jobs,
            overlap=self._overlap,
            segment=self._segment,
            shifts=self._shifts,
        )
        async for ev in self._run_stage("separating", demucs_cmd, parse_demucs_progress):
            yield ev

        # ── stage 3: encode + publish the stems to the MediaStore ──────────────────
        # The instrumental goes to LOSSLESS FLAC: it is the file that plays at volume, and a second
        # lossy generation is audible on high-frequency transients (crash cymbals especially). The
        # vocals stem stays lossy below — nothing plays it aloud.
        produced = demucs_no_vocals_path(sep_out, model)
        if not os.path.exists(produced):
            raise RuntimeError(f"demucs produced no instrumental at {produced}")
        final = instrumental_path(job.media_dir, job.media_id)
        os.makedirs(os.path.dirname(final), exist_ok=True)
        await self._run_quiet(encode_flac_argv(produced, final, self._ffmpeg_bin, self._flac_level))

        stems: dict[str, str] = {"instrumental": final}
        # Also publish the ISOLATED VOCALS stem — `--two-stems=vocals` already produced it. It unblocks
        # pitch extraction and the vocal-guide mix. BEST-EFFORT: a missing or unencodable vocals file
        # must not fail the load-bearing instrumental (the vocals stem is an enhancement).
        vocals_src = demucs_vocals_path(sep_out, model)
        if os.path.exists(vocals_src):
            vocals_final = vocals_path(job.media_dir, job.media_id)
            try:
                await self._run_quiet(encode_stem_argv(vocals_src, vocals_final, self._bitrate, self._ffmpeg_bin))
                # Measure it before reporting it. Separation can succeed and still write silence, and a
                # SILENT guiding track is worse than none — it looks like it works. Reporting no
                # artifact leaves the song playable with no guide, which is the honest outcome.
                if await self._is_silent(vocals_final):
                    print(
                        f"[worker] vocals stem for {job.media_id} is digital silence — not reporting it",
                        flush=True,
                    )
                else:
                    stems["vocals"] = vocals_final
            except Exception:  # noqa: BLE001 — an enhancement must never fail the job
                pass

        # ── songProfile: key (from the INSTRUMENTAL) + vocal range (from the VOCALS) ──────
        # Analysed from the RAW separated WAVs that still exist in scratch here — `produced` and
        # `vocals_src` — so this costs NO extra separation and NO extra decode. The vocals WAV is used
        # even when it measured as digital silence above (so it was NOT published as a stem): the
        # summarizer then finds no voiced frames and returns nulls, which is exactly the "present but
        # empty" profile core needs to see so a silent-vocals song reads as cooked, not stuck.
        # ALWAYS published, even on total analysis failure (nulls) — an ABSENT profile means "still
        # cooking" to core, so omitting it would strand the song forever.
        song_profile = self._profiler(
            produced if os.path.exists(produced) else None,
            vocals_src if os.path.exists(vocals_src) else None,
            job.media_id,
        )

        # Report the model THIS RUN resolved, not the one the core asked for: resolve_demucs_model
        # applies its own default when params carry none, so the two can differ and only the worker
        # knows which weights were actually loaded.
        yield CompleteResult(
            media_uri=final,
            artifacts={"stems": stems, "songProfile": song_profile},
            facts={"engine": "demucs", "model": model, "backend": "torch"},
        )

    async def _run_quiet(self, argv: list[str]) -> None:
        """Run a CLI that emits no useful progress (ffmpeg at loglevel=error), draining its output."""
        async for _ in self._runner(argv):
            pass

    async def _is_silent(self, path: str) -> bool:
        """Does this encoded stem measure as digital silence?

        Unmeasurable (ffmpeg absent, or output we cannot parse) counts as NOT silent: see
        processor.is_silent. Any failure here also degrades to "not silent" so a probe problem can
        never cost the room a working guide.
        """
        try:
            out: list[str] = []
            async for line in self._runner(volumedetect_argv(path, self._ffmpeg_bin)):
                out.append(line)
            return is_silent(parse_max_volume_db("\n".join(out)))
        except Exception:  # noqa: BLE001 — a failed probe must not fail the job or drop a good stem
            return False

    async def _run_stage(
        self, stage: str, argv: list[str], parse: Callable[[str], int | None]
    ) -> AsyncIterator[ProgressEvent]:
        """Run one CLI, translating its progress lines into deduped per-stage ProgressEvents."""
        yield ProgressEvent(stage=stage, pct=0)
        last = -1
        async for line in self._runner(argv):
            pct = parse(line)
            if pct is not None and pct != last:
                last = pct
                yield ProgressEvent(stage=stage, pct=pct)
        if last < 100:
            yield ProgressEvent(stage=stage, pct=100)  # stage finished cleanly
