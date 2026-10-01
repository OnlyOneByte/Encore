"""The subprocess-backed adapters: yt-dlp for audio and captions, ffmpeg/ffprobe for measurement.

ARGV IS BUILT PURELY, then run. Every `*_argv` function below is a pure list-of-strings builder with no
side effects, so the exact command line is assertable in a unit test — which is the only way to check a
flag that only matters on a real download. The old worker learned this the hard way: a missing
`--no-playlist` turned one song into a 200-track download, and a missing `ENCORE_YTDLP_BIN` silently
shelled a bare `yt-dlp` off PATH and missed.

NOTHING HERE IMPORTS torch, whisperx OR ANY MODEL. These adapters work on a box with no ML installed,
which is why fetch-only workers are possible.
"""

from __future__ import annotations

import glob
import os
import re
import subprocess
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from encore_worker.adapters.ports import InfraFault, ProgressSink
from encore_worker.domain.document import Segment
from encore_worker.domain.lyrics.clean import clean_segments

#: yt-dlp writes progress as a percentage; this is the only shape worth parsing out of its output.
_PCT = re.compile(r"\[download\]\s+(\d{1,3})(?:\.\d+)?%")

#: `ffmpeg -i` reports duration on stderr in this shape. ffprobe is cleaner but is a second binary, and
#: a box is far more likely to have ffmpeg alone.
_DURATION = re.compile(r"Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)")

#: `-af volumedetect` summary. The number that decides whether an instrumental is digital silence.
_MAX_VOLUME = re.compile(r"max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB")


class ToolFailed(RuntimeError):
    """A subprocess exited non-zero. Carries its output, because the message is the diagnosis."""

    def __init__(self, argv: Sequence[str], code: int, output: str) -> None:
        super().__init__(f"{argv[0]} exited {code}: {output.strip()[-400:]}")
        self.argv = tuple(argv)
        self.code = code
        self.output = output

    def __reduce__(self) -> tuple[type[ToolFailed], tuple[tuple[str, ...], int, str]]:
        # DBOS pickles a workflow's exception. The default reduce replays `__init__` with `self.args` — the
        # one formatted message — so unpickling raised a TypeError that replaced the diagnosis it carried.
        return (type(self), (self.argv, self.code, self.output))


#: Substrings every accelerator uses to say "not enough memory". Matched case-insensitively against a failed
#: command's combined output.
#:
#: WHY THIS EXISTS AT ALL. Model choice is deliberately NOT gated on VRAM — a memory ceiling is a continuum,
#: not a yes/no, and it moves with segment size, overlap and precision, so a gate would block configurations
#: that work. The cost of letting anyone pick anything is that the FAILURE has to be legible: an OOM must say
#: "this model needs more memory than this box has", once, rather than burning three attempts producing the
#: same crash with a stack trace about tensors.
OOM_MARKERS = (
    "out of memory",
    "outofmemoryerror",
    "cuda error: out of memory",
    "mps backend out of memory",
    "hip out of memory",
    "failed to allocate",
    "cannot allocate memory",
    "killed",  # the OOM killer, which leaves no message of its own
)


class OutOfMemory(InfraFault):
    """A model needed more memory than this box has.

    `retryable = False`, and that is the whole point: the same model on the same audio on the same box will
    exhaust the same memory every time, so three attempts cost three long failures and tell the operator
    nothing the first did not. Deterministic failures must not be retried — the same reasoning
    `SilentInstrumental` uses.

    Recoverable by CHANGING something — a smaller model, a reduced segment, a bigger box — which is a
    decision for a person, not for a retry loop.

    An `InfraFault`, so an alignment step lets it through rather than declining one attempt over it: the
    in-process emission pass raises it too (`ml.WhisperXAligner.emissions`, from torch's own message).
    """

    retryable = False


def looks_like_oom(output: str) -> bool:
    """Did this failure run out of memory? Read from the command's own output, since a subprocess cannot
    raise a typed exception across the boundary."""
    low = output.lower()
    return any(marker in low for marker in OOM_MARKERS)


def run(argv: Sequence[str], *, on_progress: ProgressSink | None = None, timeout_sec: float = 3600.0) -> str:
    """Run a command to completion, returning its combined output.

    SYNCHRONOUS on purpose. Every caller is already inside `asyncio.to_thread` (see `align_steps`), so
    an async subprocess here would add a second concurrency model for no benefit. `start_new_session`
    puts the child in its own process group, so a timeout kills the whole tree rather than orphaning
    ffmpeg children that keep writing to a scratch directory nobody is watching any more.
    """
    lines: list[str] = []
    proc = subprocess.Popen(  # noqa: S603 - argv is built by the pure builders above, never a shell string
        list(argv),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        start_new_session=True,
    )
    try:
        # `stdout=PIPE` above guarantees this; narrowed without an `assert`, which `-O` would strip.
        stream = proc.stdout
        if stream is None:  # pragma: no cover - unreachable with stdout=PIPE
            raise ToolFailed(argv, -1, "no stdout pipe")
        for line in stream:
            lines.append(line)
            if on_progress is not None:
                pct = parse_pct(line)
                if pct is not None:
                    on_progress(pct)
        code = proc.wait(timeout=timeout_sec)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        raise ToolFailed(argv, -1, f"timed out after {timeout_sec:.0f}s") from None
    except BaseException:
        proc.kill()
        proc.wait()
        raise
    output = "".join(lines)
    if code != 0:
        if looks_like_oom(output):
            # Raised INSTEAD of ToolFailed so the non-retryable classification survives: a subprocess cannot
            # raise a typed exception across the boundary, so the only evidence is its output.
            raise OutOfMemory(
                f"{argv[0]} ran out of memory. This model needs more than this box has — try a smaller "
                f"model, or a box with more memory. Exit {code}."
            )
        raise ToolFailed(argv, code, output)
    return output


def parse_pct(line: str) -> int | None:
    """A 0..100 percentage from a yt-dlp progress line, or None. Clamped, never trusted blindly."""
    found = _PCT.search(line)
    if found is None:
        return None
    return max(0, min(100, int(found.group(1))))


# ── argv builders (pure) ─────────────────────────────────────────────────────────────────────────


def audio_argv(source_uri: str, out_dir: str, ytdlp_bin: str = "yt-dlp") -> list[str]:
    """Download the best audio-only stream as a single file.

    `--no-playlist` is load-bearing: a YouTube url carrying a list parameter otherwise downloads the
    whole list, which is how one song became two hundred. `-f bestaudio` avoids muxing a video stream we
    would immediately discard.
    """
    return [
        ytdlp_bin,
        "--no-playlist",
        # Newline-delimited progress, so `run` can parse a percentage out of it line by line.
        "--newline",
        "-f",
        "bestaudio/best",
        "-o",
        os.path.join(out_dir, "original.%(ext)s"),
        source_uri,
    ]


def caption_argv(
    source_uri: str, out_template: str, ytdlp_bin: str = "yt-dlp", *, automatic: bool
) -> list[str]:
    """Fetch ONE kind of caption track and nothing else.

    `--skip-download` matters: without it this re-downloads the audio for every caption tier, tripling
    the bandwidth of an align job. The authored and automatic tracks are requested separately because
    they mean different things — one is a claim about the words, the other is evidence of what is
    audible — and a single call that returns "whichever exists" cannot tell them apart.
    """
    return [
        ytdlp_bin,
        "--no-playlist",
        "--skip-download",
        "--write-auto-subs" if automatic else "--write-subs",
        "--sub-langs",
        "en.*,en",
        "--sub-format",
        "vtt/srt/best",
        "-o",
        out_template,
        source_uri,
    ]


def duration_argv(path: str, ffmpeg_bin: str = "ffmpeg") -> list[str]:
    """Ask ffmpeg to describe the file. Exits non-zero by design — there is no output to produce."""
    return [ffmpeg_bin, "-hide_banner", "-i", path]


def volume_argv(path: str, ffmpeg_bin: str = "ffmpeg") -> list[str]:
    """Measure peak level without writing anything. `-f null -` discards the decoded stream."""
    return [ffmpeg_bin, "-hide_banner", "-i", path, "-af", "volumedetect", "-f", "null", "-"]


def parse_duration(output: str) -> float:
    """Seconds from ffmpeg's `Duration:` line, or 0.0 when it said nothing.

    Zero means UNKNOWN, and every consumer treats it that way rather than as a zero-length song — see
    `measure.measure`, which reports no coverage rather than guessing when the duration is not positive.
    """
    found = _DURATION.search(output)
    if found is None:
        return 0.0
    hours, minutes, seconds = found.groups()
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def parse_max_volume(output: str) -> float | None:
    """Peak dBFS from volumedetect, or None when ffmpeg said nothing parseable.

    NONE IS NOT 0.0, and the asymmetry with `parse_duration` is deliberate rather than inconsistent:
    0.0 seconds is not a duration any recording has, so it can serve as a sentinel for "unknown". 0.0
    dBFS is a REAL peak — full scale, the loudest a sample can be — so using it for "unmeasured" makes a
    measurement failure read as the loudest possible signal. That is the exact shape of a silence guard
    that passes everything: the one reading that must never be faked is the one that means "safe".
    """
    found = _MAX_VOLUME.search(output)
    if found is None:
        return None
    return float(found.group(1))


# ── adapters ─────────────────────────────────────────────────────────────────────────────────────


class YtDlpAudio:
    """`AudioFetcher` over yt-dlp."""

    def __init__(self, ytdlp_bin: str = "yt-dlp") -> None:
        self._bin = ytdlp_bin

    def fetch(self, source_uri: str, out_dir: str, *, on_progress: ProgressSink | None = None) -> str:
        run(audio_argv(source_uri, out_dir, self._bin), on_progress=on_progress)
        found = sorted(glob.glob(os.path.join(out_dir, "original.*")))
        if not found:
            raise ToolFailed([self._bin], 0, f"yt-dlp reported success but wrote nothing into {out_dir}")
        return found[0]


class YtDlpCaptions:
    """`CaptionSource` over yt-dlp. A missing track is a miss, not an error."""

    def __init__(self, ytdlp_bin: str = "yt-dlp") -> None:
        self._bin = ytdlp_bin

    def fetch(self, source_uri: str, out_dir: str, *, automatic: bool) -> Sequence[Segment]:
        template = os.path.join(out_dir, "captions.%(ext)s")
        try:
            run(caption_argv(source_uri, template, self._bin, automatic=automatic))
        except ToolFailed:
            return ()  # a video with no track of this kind is the common case
        path = find_caption_file(out_dir)
        if path is None:
            return ()
        with open(path, encoding="utf-8", errors="replace") as handle:
            return parse_vtt(handle.read())


def find_caption_file(out_dir: str) -> str | None:
    """The caption file yt-dlp wrote, preferring vtt. Deterministic, so a retry reads the same bytes."""
    for ext in ("vtt", "srt"):
        found = sorted(glob.glob(os.path.join(out_dir, f"*.{ext}")))
        if found:
            return found[0]
    return None


def parse_vtt(text: str) -> tuple[Segment, ...]:
    """Cues from a WebVTT or SRT body, with YouTube's ROLLING auto-caption shape handled (review M12).

    Both formats are handled by one parser because they differ only in the timestamp separator and a
    numeric index line. Two parsers for two nearly identical formats is two things to drift.

    Cue text is JOINED with spaces rather than newlines: a caption line-wrapped for a video player is
    one lyric line, and preserving the wrap would publish a lyric broken at whatever width YouTube chose.

    WHAT A ROLLING TRACK IS, and why the old parser mangled it. YouTube's `--write-auto-subs` output is a
    roll-up: the words appear one at a time, so every line of lyric is emitted THREE times — once as the
    growing line with per-word timestamps, once as a 10 ms "the line is now complete" cue, and once again
    as the carried-over first line of the NEXT cue. Reproduced on dQw4w9WgXcQ (the review's own case,
    re-fetched; 103 raw cues), the shipped parser published **86 cues and 769 words for 284 sung words**,
    lost the FIRST cue entirely, and threw away **239 inline word onsets**. Four defects, four rules:

      1. THE CUE SEPARATOR IS AN EMPTY LINE, not a blank-looking one. YouTube writes a lone SPACE as a
         placeholder for the roll-up's empty half (`' '` on its own line), and a parser that split blocks
         on `line.strip() == ""` cut every such cue in two — the half with the timestamp had no body and
         was dropped, the half with the body had no timestamp and was dropped too. That is why the first
         cue vanished. This parser is TIMESTAMP-DRIVEN instead of block-driven: a `-->` line opens a cue
         and the next `-->` line or the next truly empty line closes it, which is spec-correct for both
         formats and is robust to either convention.
      2. CUES UNDER `MIN_CUE_SEC` ARE DROPPED. 51 of dQw4w9WgXcQ's 103 cues are 10 ms long; they carry no
         new words and exist only to mark a line complete. A 10 ms claim is also a claim no clock can use.
      3. ONLY THE NEW LINE OF A ROLLING CUE IS KEPT. When a cue's leading body lines repeat the text the
         previous KEPT cue published, they are the roll-up's carry and the last line is the new one. An
         AUTHORED cue that is merely line-wrapped repeats nothing, so it is still joined whole.
         AND THE TRACK MUST BE A ROLL-UP FOR THIS TO APPLY AT ALL (W5 review r1-correctness-2): identity
         alone also matches a line REPEATED across a cue boundary, which is ordinary in song captions, and
         on a plain authored track that deleted the repeat from the served text. The evidence is `_Roll` —
         an inline onset tag, or `_ROLLING_OVERLAPS` cue spans overlapping their predecessor — accumulated
         per TRACK, because a rolling track's last cue often carries no new word and so no tag of its own.
      4. INLINE `<hh:mm:ss.mmm>` TAGS BECOME WORD CLAIMS. They are the only per-word timing a rolling
         track carries and `clean_line` strips them, so they are read here, before the clean, and attached
         as `words`.
         THE CAPTION TRACK IS STILL DECLARED LINE-TIMED, DELIBERATELY (W5 review r2-correctness-6). This rule
         used to claim the word claims are "what makes an auto track a WORD-timed candidate": they are not —
         `steps.align_steps.fetch_captions` builds its `TextRef` with `timing=TIMING_LINE`, and nothing on the
         caption path reads a cue's `words` (the claim clock is built from `measure.line_spans`, one span per
         segment). The payload is carried and not yet declared because declaring it would make these the
         job's CLAIMS instead of the cue's line spans — a different claim stream, on a track whose per-word
         timing is a machine's guess at a sung word — which is a measured change and not a label change. The
         claims stay attached so the wave that measures it has them; see `fetch_captions`.

    After all four: dQw4w9WgXcQ parses to 48 cues and 287 words against the 284 sung, with 280 word
    claims over its 41 word-timed cues — and its first cue back, `We're no strangers to` at 18.80 s.
    """
    blocks: list[tuple[tuple[float, float], list[str]]] = []
    open_at: tuple[float, float] | None = None
    body: list[str] = []

    def close() -> None:
        nonlocal open_at, body
        if open_at is not None:
            blocks.append((open_at, [line for line in body if line.strip()]))
        open_at, body = None, []

    # NO `.strip()` ON THE LINE ITSELF: a line of one space is cue payload (rule 1 above), and only `\r`
    # from a CRLF file and a leading BOM are removed. The timestamp pattern searches, so a line's own
    # indentation never hides it.
    for raw in text.replace("\r\n", "\n").split("\n"):
        line = raw.lstrip("﻿").rstrip("\r")
        found = _TIMESTAMP.search(line)
        if found is not None:
            close()
            open_at = (_secs(*found.groups()[:4]), _secs(*found.groups()[4:]))
            continue
        if not line:
            close()
            continue
        if open_at is not None:
            body.append(line)
    close()

    # RULE 3's VERDICT IS READ OVER THE WHOLE TRACK BEFORE ANY CUE IS BUILT (`_track_roll`), because that is
    # what it is a fact about — and a one-pass latch judged every cue BEFORE the evidence appeared as if the
    # track were authored (W5 review r2-correctness-3: with overlap now needing to repeat, a latch would have
    # cost a tagless roll-up its first carry removal). Two passes over a parsed caption file cost nothing.
    rolling = _track_roll(blocks).certain
    cues: list[dict[str, object]] = []
    for span, lines in blocks:
        cue = _cue_of(span, lines, previous=cues[-1] if cues else None, rolling=rolling)
        if cue is not None:
            cues.append(cue)
    # CAPTION FORMAT IS NOT LYRIC. A cue body carries italic tags, ASR per-word timestamp spans, music
    # notes and speaker dashes; published unfiltered they were drawn on the television as words to sing
    # (measured: `- ♪♪ Gotta get that ♪♪ <i>- ♪♪ Boom boom boom ♪♪</i>`). See `domain/lyrics/clean.py`
    # for what is removed and — more importantly — what deliberately is not.
    return clean_segments(cues)


_TIMESTAMP = re.compile(r"(\d{1,2}):(\d\d):(\d\d)[.,](\d{1,3})\s*-->\s*(\d{1,2}):(\d\d):(\d\d)[.,](\d{1,3})")

#: An inline per-word onset in a roll-up track: `we're<00:00:19.039><c> no</c>`. The tag precedes the word
#: it times; the cue's own start times the first word.
_INLINE_ONSET = re.compile(r"<(\d{1,2}):(\d\d):(\d\d)[.,](\d{1,3})>")

#: Markup inside a cue line, removed only for the word split and the carry comparison — the published
#: text keeps it until `clean_line` decides what is format (`domain/lyrics/clean.py` owns that list).
_TAG_SPAN = re.compile(r"</?[a-zA-Z][^<>]*>")

#: Below this a cue is a roll-up MARKER rather than a caption (review M12: 51 of dQw4w9WgXcQ's 103 cues are
#: exactly 10 ms). 50 ms is two decoder frames at the 20 ms hop `adapters/ml` runs, so nothing under it can
#: carry a usable claim either. The two populations on that track are 10 ms and 1.15–18.47 s, so the floor
#: sits in an empty band three orders of magnitude wide.
MIN_CUE_SEC = 0.05

#: How many cues must overlap their predecessor before OVERLAP ALONE proves a roll-up (W5 review
#: r2-correctness-3). One pair is not a convention: real authored and SDH tracks do overlap a cue here and
#: there — two simultaneous speakers, a backing-vocal overlay, karaoke-style stacked subtitles — and latching
#: rule 3 on that single pair deleted a line REPEATED later in the same track, which is the r1-correctness-2
#: defect with the weaker signal left armed. A real roll-up overlaps on EVERY cue it grows through (each
#: growing cue opens before the previous one closes), so it reaches two in its first three cues and nothing
#: measured is lost by asking. MEASURED ON THE CORPUS'S OWN 16 REAL CAPTION TRACKS (6 `.vtt` fetched by the
#: review + 10 committed `json3`): overlapping pairs 0 on every one of them, and inline onset tags 0 as well
#: — so neither signal nor false positive has a corpus instance, and the TAG is the one with evidence behind
#: it (dQw4w9WgXcQ's rolling track carries 239 of them over 41 cues). The overlap signal stays because a
#: roll-up with no per-word timing is a real shape; it just no longer fires on one pair.
_ROLLING_OVERLAPS = 2


@dataclass(frozen=True, slots=True)
class _Roll:
    """A track's accumulated roll-up evidence (rule 3's precondition; W5 review r1-correctness-2).

    Two signals of unequal strength, which is why this is a record and not a bool: a tag PROVES the track
    tags its words, where an overlap has to REPEAT before it proves anything (`_ROLLING_OVERLAPS`).
    """

    tagged: bool = False
    overlaps: int = 0

    @property
    def certain(self) -> bool:
        """Is the track a roll-up, so rule 3's carry removal applies to every cue of it?"""
        return self.tagged or self.overlaps >= _ROLLING_OVERLAPS


def _cue_of(
    span: tuple[float, float],
    body: Sequence[str],
    previous: Mapping[str, object] | None,
    *,
    rolling: bool,
) -> dict[str, object] | None:
    """One cue, or None when it carries no words, is a roll-up marker, or is all carried-over text.

    `previous` is the last cue this parse KEPT, which is what rule 3 compares against — comparing with the
    raw previous block instead would compare against a 10 ms marker that rule 2 has already dropped.
    `rolling` is the WHOLE TRACK's answer to "is this a roll-up", decided by `_track_roll` before the first
    cue is built (see `parse_vtt` and `_rolled`).
    """
    start, end = span
    if end - start < MIN_CUE_SEC:
        return None
    lines = [line for line in body if line.strip()]
    if not lines:
        return None  # a timestamp and no words is a positioning or style cue, not a lyric
    lines = _rolled(lines, previous, rolling=rolling)
    if not lines:
        return None
    text = " ".join(lines).strip()
    if not text:
        return None
    cue: dict[str, object] = {"start": start, "end": end, "text": text}
    words = _inline_words(lines, start, end)
    if words:
        cue["words"] = words
    return cue


def _track_roll(blocks: Sequence[tuple[tuple[float, float], Sequence[str]]]) -> _Roll:
    """The whole track's roll-up evidence (W5 review r1-correctness-2, then r2-correctness-3).

    Two signals: an `_INLINE_ONSET` tag (a growing cue tags every word but its first — the same signal
    `_inline_words` reads), which is proof on its own, and a span that OVERLAPS its predecessor's, which is
    COUNTED because a single overlapping pair is something a real authored track does too (see
    `_ROLLING_OVERLAPS`). ADJACENCY IS NOT OVERLAP: `--> 00:00:04.000` then `00:00:04.000 -->` is exactly how
    authored cues abut, and reading that as a roll-up would be the defect again with a different spelling.

    RULE 2's MARKER CUES AND THE POSITIONING CUES ARE NOT EVIDENCE: a 10 ms cue is dropped before rule 3 ever
    sees it, and a cue with no words is not a caption, so neither can prove or disprove a convention.
    """
    tagged = False
    overlaps = 0
    previous_end: float | None = None
    for (start, end), lines in blocks:
        if end - start < MIN_CUE_SEC or not lines:
            continue
        if any(_INLINE_ONSET.search(line) for line in lines):
            tagged = True
        if previous_end is not None and start < previous_end:
            overlaps += 1
        previous_end = end
    return _Roll(tagged=tagged, overlaps=overlaps)


def _rolled(lines: Sequence[str], previous: Mapping[str, object] | None, *, rolling: bool) -> list[str]:
    """Rule 3: the roll-up's carried-over leading lines removed, or `lines` unchanged.

    The carry is identified by TEXT IDENTITY against what the previous cue published, with the inline
    timestamps taken off — the growing cue writes `love.<00:00:22.800><c> You</c>` and the next cue carries
    it as the plain `love. You know the rules and so do`. A line-wrapped AUTHORED cue matches nothing here,
    which is the whole reason the comparison is identity and not a heuristic about line counts.

    AND IDENTITY ALONE IS NOT ENOUGH, SO THE TRACK MUST BE A ROLL-UP FIRST (`rolling`, W5 review
    r1-correctness-2): a REPEATED LINE across a cue boundary is ordinary in song captions — a chorus line
    that ends one cue and opens the next — and on a plain authored track, with no inline tag anywhere and
    cues that merely abut, this rule deleted it, so the repeat never reached the TV and the words on screen
    disagreed with the words being sung. `_rolling_evidence` is the evidence and `parse_vtt` accumulates it
    per TRACK, because a rolling track's last cue often carries no new word and so no tag of its own — and
    ONE overlapping pair is not enough of it either (`_ROLLING_OVERLAPS`, W5 review r2-correctness-3: an
    authored track with two simultaneous speakers overlaps once and lost a repeated line to this rule).
    """
    if previous is None or len(lines) < 2 or not rolling:
        return list(lines)
    carried = _plain(str(previous.get("text") or ""))
    if not carried:
        return list(lines)
    kept = list(lines)
    while len(kept) > 1 and _plain(kept[0]) and carried.endswith(_plain(kept[0])):
        kept.pop(0)
    return kept


def _plain(line: str) -> str:
    """A cue line with its inline onsets and tags removed, whitespace collapsed — for comparison only."""
    return re.sub(r"\s+", " ", _INLINE_ONSET.sub("", _TAG_SPAN.sub("", line))).strip()


def _inline_words(lines: Sequence[str], start: float, end: float) -> tuple[Segment, ...]:
    """Rule 4: `<hh:mm:ss.mmm>`-tagged words as word claims, or empty when the cue carries no tags.

    EVERY WORD GETS A SPAN. A rolling cue tags every word but its first, so the first takes the cue's own
    start; each word ends where the next begins and the last at the cue's end. The cue is refused whole —
    the line keeps line timing — only when it carries NO tag at all, since a word list that disagreed with
    the line would be read in preference to it (`measure.timed_words` reads `word["word"]`).

    A TAG TIMES A RUN, NOT ALWAYS ONE WORD, and the run is APPORTIONED (W5 review r1-tests-19). This
    docstring used to claim a partially tagged cue was refused; it was not, and every untagged token was
    given the PREVIOUS word's onset, so `zzz yyy<00:00:11.500><c> xxx</c> www vvv` published three
    ZERO-WIDTH words — and the TV lights the word with `start <= pos < end` (`core/src/lib/tv/lyrics.ts`),
    which a zero-width span never satisfies. So a run of tokens sharing one onset is spread across the room
    to the NEXT onset by character count, which is `presplit`'s rule and `parts._spread`'s, for the same
    reason (an even split gives a one-letter token the same span as a six-letter one). Refusing the cue
    instead would cost the real track word timing wherever it tagged a phrase, which is a loss measured in
    whole cues against a defect measured in single words.
    """
    runs: list[tuple[float, list[str]]] = []
    tagged = False
    for line in lines:
        for at, piece in _onset_runs(line):
            if at is not None:
                tagged = True
            tokens = _TAG_SPAN.sub(" ", piece).split()
            if not tokens:
                continue
            if at is None:
                # The run no tag opens. On the cue's FIRST line that is the cue's own start; on a later line
                # it continues the run the line before it left open, which is where a wrapped rolling cue
                # puts the rest of a tagged phrase.
                if runs:
                    runs[-1][1].extend(tokens)
                    continue
                at = start
            runs.append((at, tokens))
    if not tagged or not runs:
        return ()
    out: list[Segment] = []
    for index, (at, tokens) in enumerate(runs):
        closes = runs[index + 1][0] if index + 1 < len(runs) else end
        out.extend(_apportioned(tokens, at, max(at, closes)))
    return tuple(out)


def _apportioned(tokens: Sequence[str], low: float, high: float) -> list[Segment]:
    """`tokens` across `[low, high]` BY CHARACTER COUNT — one claim each, no zero-width span unless the
    room itself is zero (two tags on the same centisecond, which no clock can separate either)."""
    room = max(0.0, high - low)
    total = sum(len(token) for token in tokens) or 1
    out: list[Segment] = []
    at = low
    for position, token in enumerate(tokens):
        closes = high if position == len(tokens) - 1 else at + room * (len(token) / total)
        out.append({"word": token, "start": at, "end": max(at, closes)})
        at = max(at, closes)
    return out


def _onset_runs(line: str) -> list[tuple[float | None, str]]:
    """The line as `(onset of what follows, text)` runs. The first run's onset is None (the cue's own)."""
    out: list[tuple[float | None, str]] = []
    at: float | None = None
    pos = 0
    for found in _INLINE_ONSET.finditer(line):
        out.append((at, line[pos : found.start()]))
        at = _secs(*found.groups())
        pos = found.end()
    out.append((at, line[pos:]))
    return out


def _secs(hours: str, minutes: str, seconds: str, millis: str) -> float:
    return int(hours) * 3600 + int(minutes) * 60 + int(seconds) + int(millis.ljust(3, "0")) / 1000.0


class FfmpegProbe:
    """`AudioProbe` over ffmpeg. Never raises for an unmeasurable file — 0.0 means unknown."""

    def __init__(self, ffmpeg_bin: str = "ffmpeg") -> None:
        self._bin = ffmpeg_bin

    def duration_sec(self, audio_path: str) -> float:
        try:
            # `-i` with no output makes ffmpeg exit non-zero after printing what we want.
            return parse_duration(run(duration_argv(audio_path, self._bin), timeout_sec=60.0))
        except ToolFailed as failed:
            return parse_duration(failed.output)

    def peak_dbfs(self, audio_path: str) -> float | None:
        """Peak level, or None when it could not be measured at all.

        A `ToolFailed` is still worth parsing: ffmpeg exits non-zero after printing the summary for some
        inputs, so the number is often present in the output of a "failed" run.
        """
        try:
            return parse_max_volume(run(volume_argv(audio_path, self._bin), timeout_sec=600.0))
        except ToolFailed as failed:
            return parse_max_volume(failed.output)
