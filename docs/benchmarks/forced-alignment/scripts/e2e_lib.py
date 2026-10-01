"""The pure half of the end-to-end alignment bench: corpus, claim modes, pairing, metrics, emissions cache.

`e2e.py` is the CLI that drives the SHIPPED `AlignStepsImpl.time_text`; everything here is plain data in,
plain data out, so it is unit-tested hermetically (`worker/tests/test_bench_e2e.py` — no model, no audio,
no torch). The split exists because this bench is the GATE every later alignment wave is judged by: a
metric or claim-construction bug here would silently move every reject-if verdict, so this half must be
testable without an hour of model time.

WHERE THE DEFINITIONS COME FROM. The song list, claim construction for truth/jit/offset, and the line
metrics are the review's scratch harness (`_review-scratch/pe-acc/e2e2.py`), kept exactly, because that
harness produced the baseline this one must reproduce (base model, `time_text`: truth 25 gross / 89.3%
±500 / 97.5% ±1 s; jit 34 / 84.1 / 95.4; blind 122 / 78.6 / 88.3). The word metrics are `bench.py --global
--words` (only `aligned`-provenance words, a line scored only when its word count matches the truth's).
Two deliberate differences, both measured-harmless on the baseline documents and both documented where
they live: lines pair by IDENTITY rather than by text (`score_lines`), and every random draw is seeded by
a stable hash (`rng_for`) instead of the process-salted `hash(slug)` e2e2 used. So this harness's jit row is
a different, repeatable draw. e2e2's draw was recovered for 29/32 songs from its adopted lines, and replayed
here it gives e2e2's documents byte for byte (README, "jit caveat"). One deliberate ADDITION: every count
e2e2 took over published lines also exists over the claimed TEXT, where a refused case's lines are misses
(`line_metrics`); PCO, the highlight and `missing` count refused cases too (`row_of`), because the
published-only figures read a policy that refuses its worst songs as an improvement.

WORD ENDS AND THE HIGHLIGHT come from the review's `_review-scratch/pe-acc/exp_ends.py`. On the shipped
emissions its base-model raw decode reads word end ±100 73.2%, phrase-final end ±100 40.6% / ±250 73.6% /
bias −106 ms, painted highlight 67.3%. The review printed 40.0 / 73.5 / −107 / 67.7 because it ran on its
own 30 s-chunk matrices; on those this scorer reads its numbers exactly. The review's "end ±100 68.2" drops
the onset filter, and ungated it reads 68.4 here. `gates/w0-reproduce-generate.yaml` has the provenance.
There is ONE deliberate difference: the highlight reads the lit word through a port of the TV's own logic
(`core/src/lib/tv/lyrics.ts` — parse, pause re-segmentation, `activeLineIndex`, `activeWordIndex`) instead
of painting each word's span. The two agree wherever published lines are in order and do not overlap; they
differ exactly where the TV does something the painting cannot see — a misbound line that starts later than
its successor stops `activeLineIndex` early, so the TV lights NOTHING until playback reaches it.
"""

from __future__ import annotations

import ast
import bisect
import dataclasses
import hashlib
import io
import json
import math
import os
import random
import re
import statistics
import zlib
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from encore_worker.adapters import ports

HERE = Path(__file__).resolve().parent

#: The bench corpus. DURABLE on purpose: the review's copy lived in /tmp, which macOS wipes on reboot.
DEFAULT_BENCH_ROOT = "/Volumes/workplace/personal/encore-align-bench"

#: The 3 TheFatRat songs live in the repo (their truth is pinned there; their audio is rebuilt by
#: `stem-separation/scripts/prepare.py`), not in the bench root.
REPO_SONGS = HERE.parent.parent / "benchmark-songs"

#: The 9 YouTube songs with AUTHORED caption truth, in e2e2's order (order only affects the printout).
YOUTUBE_SLUGS = (
    "never-be-alone",
    "believer",
    "shape-of-you",
    "hello",
    "rap-god",
    "bohemian-rhapsody",
    "feel-my-heart",
    "numb",
    "bad-guy",
)
TFR_SLUGS = ("tfr-flyaway", "tfr-mayday", "tfr-chosen")

#: Which audio the 3 TheFatRat songs run on (`--tfr-audio`). `youtube`, the default, is PRODUCTION-SHAPED:
#: the worker's own input (`youtube-mix.wav`, fetched with yt-dlp as `adapters/cli` fetches it) as the mix,
#: and an htdemucs vocals stem separated from THAT file (`e2e.py --prepare-tfr`, under
#: `$ENCORE_BENCH_ROOT/<slug>/mix/vocals.wav`, the layout of the other 29 songs' stems) as the target —
#: what a stems job leaves, on the timeline the authored-caption truth was written against. `reference` is
#: the producer's multitrack: `reference-vocals.wav`, the ORACLE vocals, with `reference-mix.wav`, the
#: stems summed, as R4's mix. The review's baseline ran on `reference`, and review M14 names exactly that
#: as a defect of the old headline, so it is kept only to reproduce the review. The two are not
#: interchangeable even for timing: the master and the stems differ in rate and length (flyaway 48 000 vs
#: 44 100 Hz, 194.258 vs 194.065 s; `stem-separation/scripts/prepare.py`).
TFR_YOUTUBE, TFR_REFERENCE = "youtube", "reference"
TFR_AUDIO = (TFR_YOUTUBE, TFR_REFERENCE)

#: What a run's `target` metadata says it aligned on (`e2e.py --no-stem`, `e2e_gates.SETUP_META`): the vocals
#: stem every corpus song has, or the MIX of a song run as if no stems job could separate it. A STEMLESS run
#: measures a whole other path of the shipped step — the mix's lexical bands, no R4 mix witness, no
#: ALIGN_ON_MIX knob, a LINE_SYNC rung that declines — against the same truth, which is why it is setup and
#: not an arm: comparing it with a stem baseline metric for metric compares two different audio files.
STEM_TARGET, STEMLESS_TARGET = "stem", "mix"

#: Report groups. Jamendo's truth is MEASURED (hand-timed word + line onsets); YouTube's is AUTHORED
#: captions whose own per-song bias runs −147 to +430 ms — so the two are never averaged silently.
JAMENDO, YOUTUBE, ALL = "jamendo", "youtube", "all"
GROUPS = (JAMENDO, YOUTUBE, ALL)

# ── claim modes ───────────────────────────────────────────────────────────────────────────────────────

#: σ of the per-line claim jitter, seconds (e2e2's `jit`). An LRC typed by ear sits within a few hundred ms.
JITTER_SEC = 0.3

#: A whole-sheet offset: an LRC written for another master (intro edit, different upload).
OFFSETS_SEC: Mapping[str, float] = {
    "off05": 0.5,
    "off1": 1.0,
    "off15": 1.5,
    "off3": 3.0,
    "off5": 5.0,
    "offm05": -0.5,
    "offm1": -1.0,
    "offm15": -1.5,
    "offm3": -3.0,
}

#: A clock-rate error: claims = truth x factor. 2% is a 4 s drift across a 200 s song — the case where
#: reconcile's unbounded scale fit (review M4) falsely flagged 38/50 lines gross.
TEMPOS: Mapping[str, float] = {"tempo098": 0.98, "tempo102": 1.02}

#: A PARTIAL sheet: this fraction of lines deleted from the claimed text AND its timings.
DROPS: Mapping[str, float] = {"drop20": 0.2, "drop50": 0.5}

#: Lines in an injected extra verse. Six, the size of the unsung verse the review measured 142 gross with.
EXTRA_VERSE_LINES = 6

#: Margin kept free either side of an injected verse inside the gap it is placed in.
EXTRA_VERSE_MARGIN_SEC = 0.5

#: A section starts after a silence this long between claimed lines, or after this many lines without one
#: — roughly where a Genius sheet puts its `[Verse 2]` / `[Chorus]` headers.
SECTION_GAP_SEC = 2.0
SECTION_MAX_LINES = 8

#: A whole-line header's claim ends where its section's first line starts and opens at most this early:
#: a synced sheet that times a header times it just before the section.
HEADER_LEAD_SEC = 1.0

#: Credit lines of the kind providers and caption tracks prepend (tfr-chosen's authored track ends in one).
CREDIT_LINES = (
    "Lyrics by Musixmatch",
    "Subtitles by the Amara.org community",
    "Lyrics powered by LyricFind",
    "Transcribed by Jamie Rivers for Encore",
)

#: Default number of wrong-text cross-pairs per song (the review's "32 songs x 10 wrong texts").
WRONG_K = 10

#: Every op a mode may combine with `+`, in the CANONICAL order they apply whatever the spelling: replace
#: the text (wrong-text), put it on this song's own clock (`ownclock`), edit which lines exist (partial
#: sheet first, then injections), perturb the timings (clock rate, then offset, then per-line jitter:
#: t' = f*t + d + noise), and strip timings last. So `jit+headers` jitters the injected headers too, and
#: `blind+anything` is always untimed.
#:
#: `ownclock` (W1 review r2): each of the song's truth lines keeps its OWN span and takes the text's line
#: in the same position (the text repeats from its start when it has fewer lines) — a caption track of
#: THIS video in other words. `wrongtext+ownclock` is the same-video wrong-words case the LINE_SYNC rung's
#: sheet-span gate cannot see: an uploader's English translation of a non-English song, or YouTube's
#: machine-translated `en` track, whose timings were made on this very video. Alone it is the identity.
#:
#: NO `translated` OP, because no honest one can be built offline (W3, checked): every caption track in the
#: bench root is English (`captions.en*.json3` on the 9 YouTube songs, `tfr-*.authored.en.json3`), and
#: JamendoLyrics MultiLang's 79 songs (20 en, the rest fr / de / es) are each sung and transcribed in ONE
#: language — no song carries its lyrics in a second one. A translation written for the bench would be the
#: bench's own text, not one an uploader or YouTube produced. `wrongtext+ownclock` is the stand-in (another
#: song's words on this song's clock: a translation's order is as arbitrary as a shuffle's), and what it
#: cannot stand in for — a translation into a language that shares the sung words' letters IN ORDER
#: (cognates) — is pinned as a known limit on the CTC fixture (`test_lexical`: German +1.98 nats/letter
#: where French reads -0.12, truth +15.2).
OPS: tuple[str, ...] = (
    "wrongtext",
    "ownclock",
    *DROPS,
    "extraverse",
    "headers",
    "credit",
    *TEMPOS,
    *OFFSETS_SEC,
    "jit",
    "blind",
)

#: The modes a bare run measures: the three the review baseline reproduces.
DEFAULT_MODES = ("truth", "jit", "blind")

#: Every single-op mode, for `--modes all`.
ALL_MODES = (
    "truth",
    "jit",
    "off05",
    "off15",
    "off3",
    "offm1",
    "tempo098",
    "tempo102",
    "drop20",
    "drop50",
    "extraverse",
    "blind",
    "wrongtext",
    "headers",
    "credit",
)


def parse_mode(mode: str) -> tuple[str, ...]:
    """`jit+off15` -> its ops in PHASE order; `truth` -> (). Raises on an unknown or repeated op."""
    if mode == "truth":
        return ()
    ops = mode.split("+")
    unknown = [op for op in ops if op not in OPS]
    if unknown or not ops:
        known = ", ".join(["truth", *OPS])
        raise ValueError(f"unknown claim op(s) {unknown} in mode {mode!r}; known: {known}")
    if len(set(ops)) != len(ops):
        raise ValueError(f"mode {mode!r} repeats an op")
    return tuple(sorted(ops, key=OPS.index))


def variants_of(mode: str, wrong_k: int = WRONG_K) -> int:
    """How many cases one song contributes to `mode`: K cross-pairs for wrong-text, else one."""
    return wrong_k if "wrongtext" in parse_mode(mode) else 1


def rng_for(seed: int, *parts: object) -> random.Random:
    """A seeded stream per (seed, song, op, ...), STABLE across processes.

    `hash(str)` is salted per process (PYTHONHASHSEED), which is how e2e2's jit row became unrepeatable.
    crc32 of the joined parts is not.
    """
    return random.Random(zlib.crc32("|".join(str(p) for p in (seed, *parts)).encode("utf-8")))


# ── corpus ────────────────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class TruthLine:
    text: str
    start: float
    end: float


@dataclass(frozen=True, slots=True)
class TruthWord:
    start: float
    end: float


@dataclass(frozen=True, slots=True)
class Song:
    slug: str
    #: JAMENDO or YOUTUBE (the tfr songs report with YouTube: both are authored-caption truth).
    group: str
    mix: Path
    #: The vocals stem the corpus has — what production aligns on when stems exist.
    vocals: Path
    truth: tuple[TruthLine, ...]
    #: Measured word onsets (Jamendo), positional against the truth lines' whitespace tokens. None when
    #: the song has none or its token count disagrees with its line texts (bench.py skips those too).
    words: tuple[TruthWord, ...] | None = None

    def missing_files(self) -> list[str]:
        return [str(p) for p in (self.mix, self.vocals) if not p.is_file()]


def bench_root() -> Path:
    """`$ENCORE_BENCH_ROOT`, defaulting to the durable corpus."""
    return Path(os.environ.get("ENCORE_BENCH_ROOT") or DEFAULT_BENCH_ROOT)


def load_truth_lines(path: Path) -> tuple[TruthLine, ...]:
    raw = json.loads(path.read_text(encoding="utf-8"))["lines"]
    return tuple(TruthLine(str(t["text"]), float(t["start"]), float(t["end"])) for t in raw)


#: A truth word with no measured end ends at the next truth word's start within its line (the review found
#: 80% of Jamendo's non-final ends are already exactly that), else at its line's end — capped this far after
#: its onset, the
#: cap the review's end extension used. Dormant on today's corpus (all 5693 Jamendo words carry an end);
#: it exists so a truth set that times onsets only still scores ends and the highlight.
TRUTH_END_CAP_SEC = 3.0


def load_truth_words(path: Path, lines: Sequence[TruthLine]) -> tuple[TruthWord, ...] | None:
    if not path.is_file():
        return None
    raw = json.loads(path.read_text(encoding="utf-8"))["words"]
    counts = [len(line.text.split()) for line in lines]
    if sum(counts) != len(raw):
        return None
    out: list[TruthWord] = []
    offset = 0
    for line, count in zip(lines, counts, strict=True):
        for k in range(count):
            start = float(raw[offset + k]["start"])
            end = raw[offset + k].get("end")
            if end is None:
                follows = float(raw[offset + k + 1]["start"]) if k + 1 < count else line.end
                end = min(follows, start + TRUTH_END_CAP_SEC)
            out.append(TruthWord(start, max(float(end), start)))
        offset += count
    return tuple(out)


def discover(root: Path, repo_songs: Path = REPO_SONGS, *, tfr_audio: str = TFR_YOUTUBE) -> list[Song]:
    """The 32-song corpus in e2e2's order: 20 English Jamendo, 9 YouTube, 3 TheFatRat.

    A Jamendo song without a separated vocals stem is skipped (as e2e2 did); a YouTube/tfr song is always
    listed, and `Song.missing_files` says whether its audio is there, so a missing file fails loudly at
    selection instead of shrinking the corpus silently.

    The Jamendo MIX is read from the dataset checkout under the bench root when present: the per-song
    `mix.mp3` is a symlink into the review's /tmp copy, which dies on reboot (and would move the emissions
    cache key with it). The tfr songs' audio follows `tfr_audio` (see `TFR_AUDIO`).
    """
    if tfr_audio not in TFR_AUDIO:
        raise ValueError(f"tfr audio {tfr_audio!r}; expected one of {', '.join(TFR_AUDIO)}")
    songs: list[Song] = []
    jamendo = root / "jamendo"
    for directory in sorted(jamendo.iterdir()) if jamendo.is_dir() else []:
        vocals = directory / "mix" / "vocals.wav"
        if not vocals.is_file():
            continue
        durable = root / "jamendolyrics" / "mp3" / f"{directory.name}.mp3"
        truth = load_truth_lines(directory / "truth-lines.json")
        songs.append(
            Song(
                slug=directory.name,
                group=JAMENDO,
                mix=durable if durable.is_file() else directory / "mix.mp3",
                vocals=vocals,
                truth=truth,
                words=load_truth_words(directory / "truth-words.json", truth),
            )
        )
    for slug in YOUTUBE_SLUGS:
        directory = root / slug
        songs.append(
            Song(
                slug=slug,
                group=YOUTUBE,
                mix=directory / "mix.wav",
                vocals=directory / "mix" / "vocals.wav",
                truth=load_truth_lines(directory / "truth-lines.json"),
            )
        )
    for slug in TFR_SLUGS:
        directory = repo_songs / slug
        youtube = tfr_audio == TFR_YOUTUBE
        songs.append(
            Song(
                slug=slug,
                group=YOUTUBE,
                mix=directory / ("youtube-mix.wav" if youtube else "reference-mix.wav"),
                vocals=tfr_stem(root, slug) if youtube else directory / "reference-vocals.wav",
                truth=load_truth_lines(directory / "truth-lines.json"),
            )
        )
    return songs


def tfr_stem(root: Path, slug: str) -> Path:
    """Where `e2e.py --prepare-tfr` leaves a tfr song's production-shaped vocals stem."""
    return root / slug / "mix" / "vocals.wav"


def select(songs: Sequence[Song], spec: str | None) -> list[Song]:
    """`--songs`: comma-separated slugs, slug prefixes, or group names (`jamendo`, `youtube`)."""
    if not spec:
        return list(songs)
    wanted = [part.strip() for part in spec.split(",") if part.strip()]
    chosen = [
        song
        for song in songs
        if any(w == song.group or w == song.slug or song.slug.startswith(w) for w in wanted)
    ]
    unmatched = [w for w in wanted if not any(w in (s.group, s.slug) or s.slug.startswith(w) for s in songs)]
    if unmatched:
        raise ValueError(f"--songs matched nothing for {unmatched}")
    return chosen


# ── claims ────────────────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class ClaimLine:
    """One line of the text handed to the aligner, and which truth line it IS.

    `truth` is the identity every metric pairs on: None for a line with no truth counterpart (a header,
    a credit, an extra verse, another song's text). `lead_words` counts injected label words at the head
    of the line (`CHORUS: ...`). The word metrics pair the truth words with the line's LAST words, so the
    line scores whether the label published or a text-hygiene rule stripped it (`_truth_offset`).
    """

    text: str
    start: float | None
    end: float | None
    truth: int | None
    lead_words: int = 0


@dataclass(frozen=True, slots=True)
class Claims:
    lines: tuple[ClaimLine, ...]
    #: False for `blind`: the text arrives with no timings at all (a plain sheet, an operator paste).
    timed: bool
    #: The other corpus song a `wrongtext` / `extraverse` case borrowed from.
    donor: str | None = None

    @property
    def label(self) -> str:
        """e2e2's TextRef labels; they name the written document, so they are kept for byte-parity."""
        return "lrc" if self.timed else "plain"

    def segments(self) -> tuple[dict[str, object], ...]:
        if not self.timed:
            return tuple({"text": line.text} for line in self.lines)
        return tuple({"text": line.text, "start": line.start, "end": line.end} for line in self.lines)

    def truth_indexes(self) -> set[int]:
        return {line.truth for line in self.lines if line.truth is not None}


def _has_letters(text: str) -> bool:
    return re.search(r"[^\W\d_]", text) is not None


def _norm(text: str) -> str:
    return " ".join(text.lower().split())


def build_claims(
    song: Song,
    mode: str,
    *,
    corpus: Sequence[Song],
    duration_sec: float,
    variant: int = 0,
    seed: int = 0,
    wrong_k: int = WRONG_K,
) -> Claims:
    """The text + claimed timings one case hands `time_text`, perturbed per `mode`.

    `corpus` is the DONOR POOL for wrong-text / extra-verse and must be the full corpus, not a `--songs`
    selection — otherwise narrowing a run would change which texts the cases borrow.
    """
    lines = [ClaimLine(t.text, t.start, t.end, truth=i) for i, t in enumerate(song.truth)]
    donor: str | None = None
    timed = True
    others = [s for s in corpus if s.slug != song.slug]
    for op in parse_mode(mode):
        rng = rng_for(seed, song.slug, op, variant)
        if op == "wrongtext":
            if not others:
                raise ValueError("wrong-text needs at least one other song in the corpus")
            pool = rng_for(seed, song.slug, op).sample(others, min(wrong_k, len(others)))
            other = pool[variant % len(pool)]
            donor = other.slug
            lines = [ClaimLine(t.text, t.start, t.end, truth=None) for t in other.truth]
        elif op == "ownclock":
            lines = _own_clock(lines, song.truth)
        elif op in DROPS:
            lines = _drop(lines, DROPS[op], rng)
        elif op == "extraverse":
            lines, donor = _extra_verse(lines, others, rng, duration_sec)
        elif op == "headers":
            lines = _headers(lines)
        elif op == "credit":
            lines = _credit(lines, rng)
        elif op == "jit":
            # One draw per line, in text order — e2e2's construction (it applied `rng.gauss` per line).
            lines = [_retimed(line, shift=rng.gauss(0.0, JITTER_SEC)) for line in lines]
        elif op in OFFSETS_SEC:
            lines = [_retimed(line, shift=OFFSETS_SEC[op]) for line in lines]
        elif op in TEMPOS:
            lines = [_retimed(line, scale=TEMPOS[op]) for line in lines]
        elif op == "blind":
            timed = False
    # e2e2 clamps every claimed time at zero (a negative offset cannot claim before the recording starts).
    lines = [_retimed(line, floor=0.0) for line in lines]
    return Claims(lines=tuple(lines), timed=timed, donor=donor)


def _retimed(
    line: ClaimLine, *, scale: float = 1.0, shift: float = 0.0, floor: float | None = None
) -> ClaimLine:
    """`line` with both claimed times mapped `t -> max(floor, scale*t + shift)`; untimed stays untimed."""

    def move(t: float | None) -> float | None:
        if t is None:
            return None
        moved = scale * t + shift
        return moved if floor is None else max(floor, moved)

    return dataclasses.replace(line, start=move(line.start), end=move(line.end))


def _own_clock(lines: list[ClaimLine], truth: Sequence[TruthLine]) -> list[ClaimLine]:
    """`lines`' texts on `truth`'s spans, position for position, cycling `lines` when it is the shorter.

    One cue per sung line, as a caption track has, so its timings describe this recording whatever the
    words are. A line keeps the truth index its TEXT carries (None for another song's), so `ownclock` alone
    is the identity and `wrongtext+ownclock` scores every line as unsung.
    """
    if not lines:
        return lines
    return [dataclasses.replace(lines[i % len(lines)], start=t.start, end=t.end) for i, t in enumerate(truth)]


def _drop(lines: list[ClaimLine], fraction: float, rng: random.Random) -> list[ClaimLine]:
    count = math.floor(len(lines) * fraction + 0.5)
    gone = set(rng.sample(range(len(lines)), min(count, len(lines))))
    return [line for i, line in enumerate(lines) if i not in gone]


def _extra_verse(
    lines: list[ClaimLine], others: Sequence[Song], rng: random.Random, duration_sec: float
) -> tuple[list[ClaimLine], str]:
    """Another song's verse, inserted where this sheet claims its longest silence (often the outro).

    Placed in the largest claim-free gap (between two claimed lines, or after the last one), keeping the
    donor's own line rhythm, compressed only if the gap is shorter than the verse. That is where a sheet
    for a longer edit would claim a verse this recording does not have; the text order follows the time.
    """
    if not others:
        raise ValueError("an extra verse needs at least one other song in the corpus")
    donor = rng.choice(list(others))
    lettered = [t for t in donor.truth if _has_letters(t.text)] or list(donor.truth)
    size = min(EXTRA_VERSE_LINES, len(lettered))
    first = rng.randrange(len(lettered) - size + 1)
    verse = lettered[first : first + size]

    # (gap start, gap end, insert position)
    gaps: list[tuple[float, float, int]] = []
    for position in range(1, len(lines)):
        before, after = lines[position - 1], lines[position]
        if before.end is not None and after.start is not None:
            gaps.append((before.end, after.start, position))
    last_end = max((line.end for line in lines if line.end is not None), default=0.0)
    gaps.append((last_end, max(duration_sec, last_end), len(lines)))
    gap_start, gap_end, position = max(gaps, key=lambda g: (g[1] - g[0], -g[2]))

    span = max(verse[-1].end - verse[0].start, 1e-6)
    room = gap_end - gap_start - 2 * EXTRA_VERSE_MARGIN_SEC
    scale = min(1.0, max(room, EXTRA_VERSE_MARGIN_SEC) / span)
    origin = gap_start + min(EXTRA_VERSE_MARGIN_SEC, max(gap_end - gap_start, 0.0) / 2)
    injected = [
        ClaimLine(
            t.text,
            origin + (t.start - verse[0].start) * scale,
            origin + (t.end - verse[0].start) * scale,
            truth=None,
        )
        for t in verse
    ]
    return lines[:position] + injected + lines[position:], donor.slug


def _headers(lines: list[ClaimLine]) -> list[ClaimLine]:
    """Genius-style section labels, in the three shapes real sheets use, cycled per section.

    `[Chorus]` / `[Verse 2]` as a whole line, `Verse 2:` as a whole line, and `CHORUS: <first line>` as an
    inline prefix (Numb's authored captions label 17/35 lines that way). A section is `Chorus` when its
    first line's text recurs elsewhere in the sheet, else the next `Verse N`.
    """
    counts: dict[str, int] = {}
    for line in lines:
        counts[_norm(line.text)] = counts.get(_norm(line.text), 0) + 1
    starts: list[int] = []
    for position, line in enumerate(lines):
        before = lines[position - 1] if position else None
        silent = (
            before is not None
            and before.end is not None
            and line.start is not None
            and line.start - before.end >= SECTION_GAP_SEC
        )
        if position == 0 or silent or position - starts[-1] >= SECTION_MAX_LINES:
            starts.append(position)

    out: list[ClaimLine] = []
    verse = 0
    for section, (first, stop) in enumerate(zip(starts, [*starts[1:], len(lines)], strict=True)):
        head = lines[first]
        if counts[_norm(head.text)] > 1:
            label = "Chorus"
        else:
            verse += 1
            label = f"Verse {verse}"
        previous_end = out[-1].end if out and out[-1].end is not None else 0.0
        # NEVER INVERTED: when the previous line's claimed end runs past the section start (authored captions
        # overlap; a section also starts every SECTION_MAX_LINES lines with no gap at all) there is no room
        # before the section, and the header is claimed AT its start. Unclamped, 12 of the corpus's 233
        # injected headers (8 songs; truth-derived, so both tfr audios) claimed start > end, most by an ulp,
        # but The_Rinn's `Chorus:` 226.51 -> 218.88 s and Rxbyn's `[Verse 6]` 169.13 -> 168.79 s:
        # `time_text` keeps a claim's START, so that header was claimed 7.6 s after the section it labels.
        opens = (
            None
            if head.start is None
            else min(max(previous_end, head.start - HEADER_LEAD_SEC, 0.0), head.start)
        )
        closes = head.start
        style = section % 3
        if style == 0:
            out.append(ClaimLine(f"[{label}]", opens, closes, truth=None))
            out.extend(lines[first:stop])
        elif style == 1:
            out.append(ClaimLine(f"{label}:", opens, closes, truth=None))
            out.extend(lines[first:stop])
        else:
            prefix = f"{label.upper()}:"
            out.append(
                dataclasses.replace(
                    head, text=f"{prefix} {head.text}", lead_words=head.lead_words + len(prefix.split())
                )
            )
            out.extend(lines[first + 1 : stop])
    return out


def _credit(lines: list[ClaimLine], rng: random.Random) -> list[ClaimLine]:
    """A credit line on top, claimed from 0 to the first line — how an LRC's `[00:00.00]` credit parses."""
    first = next((line.start for line in lines if line.start is not None), 0.0)
    return [ClaimLine(rng.choice(CREDIT_LINES), 0.0, max(first, 0.0), truth=None), *lines]


# ── what the aligner published ────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class DocWord:
    start: float
    end: float
    #: False for an interpolated (OOV) or claim-adopted word — bench.py scores only aligned ones.
    aligned: bool
    #: The word as published. The TV's pause re-segmentation reads word LENGTHS (`LINE_MAX_CHARS`), so
    #: the highlight's port of it needs the text.
    text: str = ""


@dataclass(frozen=True, slots=True)
class DocLine:
    """One published line, with its IDENTITY: `source` indexes `Claims.lines` (None when unknown)."""

    text: str
    start: float
    end: float
    confidence: str | None
    source: int | None
    words: tuple[DocWord, ...] = ()


def pair_by_text(doc_texts: Sequence[str], claim_texts: Sequence[str]) -> list[int | None]:
    """Each published line's claim index by in-order text match — the FALLBACK when identity is unknown.

    Only for documents the capture hook did not see (a line-synced doc). A published doc is a subsequence
    of the claimed text, so this is exact unless a dropped line's text equals the next kept line's.
    """
    out: list[int | None] = []
    cursor = 0
    for text in doc_texts:
        found = next((i for i in range(cursor, len(claim_texts)) if claim_texts[i] == text), None)
        out.append(found)
        if found is not None:
            cursor = found + 1
    return out


def legacy_pairs(doc_texts: Sequence[str], truth_texts: Sequence[str]) -> dict[int, int]:
    """e2e2's pairing, kept only to COUNT where it and identity pairing disagree (a diagnostic).

    Truth-driven and greedy: a doc line matches the next truth line with equal text. When the aligner drops
    one of two identical lines it binds the survivor to the wrong occurrence — the F1-style mispairing.
    """
    out: dict[int, int] = {}
    cursor = 0
    for index, text in enumerate(truth_texts):
        if cursor < len(doc_texts) and doc_texts[cursor] == text:
            out[cursor] = index
            cursor += 1
    return out


@dataclass(frozen=True, slots=True)
class LineError:
    truth: int
    #: Published line start minus truth line start, seconds (e2e2's signed error).
    error: float
    confidence: str | None


def score_lines(song: Song, claims: Claims, doc: Sequence[DocLine]) -> tuple[list[LineError], int | None]:
    """Signed start errors for every published line that IS a truth line, plus a pairing diagnostic.

    PAIRED BY IDENTITY (`DocLine.source` -> `ClaimLine.truth`), never by text: a dropped or injected line
    shifts positions, and a repeated chorus makes text ambiguous. Lines with no truth counterpart are not
    scored. The diagnostic is how many published lines e2e2's text pairing would have bound differently
    (None when the claimed text is not the truth text, or a published line's text is not its claim's —
    the `run_align` ports clean the text — where e2e2's pairing does not apply).
    """
    errors: list[LineError] = []
    identity: dict[int, int] = {}
    for position, line in enumerate(doc):
        if line.source is None:
            continue
        truth_index = claims.lines[line.source].truth
        if truth_index is None:
            continue
        identity[position] = truth_index
        errors.append(LineError(truth_index, line.start - song.truth[truth_index].start, line.confidence))
    plain = [c.text for c in claims.lines] == [t.text for t in song.truth] and all(
        line.text == claims.lines[line.source].text for line in doc if line.source is not None
    )
    disagreements = None
    if plain:
        legacy = legacy_pairs([line.text for line in doc], [t.text for t in song.truth])
        disagreements = sum(
            1 for position in set(legacy) | set(identity) if legacy.get(position) != identity.get(position)
        )
    return errors, disagreements


@dataclass(frozen=True, slots=True)
class WordScore:
    #: Signed onset errors of every ALIGNED word paired with a measured truth word, seconds.
    errors: tuple[float, ...]
    #: Truth words whose line the claimed text contains — the PCO denominator.
    in_text: int
    #: Paired words that were interpolated or claim-adopted rather than aligned.
    interpolated: int
    #: Words of text lines that published with a different word count (never paired positionally).
    mismatched: int
    #: Signed END errors (published end − truth end) of aligned words whose ONSET is right (see
    #: `END_ONSET_GATE_SEC`), and the same for each line's LAST word — the phrase-final ends, the only
    #: ends Jamendo really measures (its non-final ends are mostly the next word's onset).
    end_errors: tuple[float, ...] = ()
    final_end_errors: tuple[float, ...] = ()


#: An END is scored only for a word whose ONSET is within this of truth — the review's `exp_ends.py`
#: filter. A misplaced word's end measures its misplacement a second time, which the onset metrics
#: already count; what an end metric must isolate is how long a correctly-started word stays lit.
END_ONSET_GATE_SEC = 0.25

#: Word END tolerances, seconds (the review's word-end ±100 / phrase-final ±100 and ±250).
END_TOLERANCES_SEC = (0.1, 0.25)


def _word_offsets(song: Song) -> tuple[list[int], list[int]]:
    """Per truth line: its word count, and the index of its first word in `Song.words`."""
    counts = [len(t.text.split()) for t in song.truth]
    offsets = [0]
    for count in counts:
        offsets.append(offsets[-1] + count)
    return counts, offsets


def _truth_offset(claim: ClaimLine, published: int, expected: int) -> int | None:
    """Where a published line's truth words start among its `published` words, or None (mismatched).

    Two shapes pair: the claimed line exactly (`lead_words` label words, then the lyric), and the lyric
    ALONE. The second is what a label-stripping rule publishes (review M11, W5: `CHORUS: fly away home`
    -> `fly away home`); pairing only the first read that fix as worse than the bug — on the test rig (2
    lines of 3 words exactly on truth, one labelled), stripped read 3/6 aligned and 0.9/1.8 s lit against
    6/6 and 1.8/1.8 s with the label kept. Either way the truth words are the line's LAST `expected` words.
    """
    if published in (expected, claim.lead_words + expected):
        return published - expected
    return None


def score_words(song: Song, claims: Claims, doc: Sequence[DocLine]) -> WordScore | None:
    """bench.py `--words` semantics, through the published document: onsets of aligned words only.

    Ends ride along under the review's `exp_ends.py` definitions (aligned words, onset within
    `END_ONSET_GATE_SEC`, phrase-final = the truth line's last word). An EMPTY `doc` (a case that
    published nothing) still returns the text's `in_text`, so the PCO denominator counts its words.
    """
    if song.words is None:
        return None
    counts, offsets = _word_offsets(song)
    errors: list[float] = []
    ends: list[float] = []
    finals: list[float] = []
    interpolated = mismatched = 0
    for line in doc:
        if line.source is None:
            continue
        claim = claims.lines[line.source]
        if claim.truth is None:
            continue
        expected = counts[claim.truth]
        lead = _truth_offset(claim, len(line.words), expected)
        if lead is None:
            mismatched += expected
            continue
        for k in range(expected):
            word = line.words[lead + k]
            truth = song.words[offsets[claim.truth] + k]
            if not word.aligned:
                interpolated += 1
                continue
            onset = word.start - truth.start
            errors.append(onset)
            if abs(onset) <= END_ONSET_GATE_SEC:
                ends.append(word.end - truth.end)
                if k == expected - 1:
                    finals.append(word.end - truth.end)
    in_text = sum(counts[i] for i in claims.truth_indexes())
    return WordScore(tuple(errors), in_text, interpolated, mismatched, tuple(ends), tuple(finals))


# ── the highlight, as the TV shows it ────────────────────────────────────────────────────────────────
#
# A PORT of `core/src/lib/tv/lyrics.ts` (parseLyricsDoc -> resegmentLine -> coalesceOrphans, then
# activeLineIndex / activeWordIndex as `LyricsOverlay.svelte` calls them), because "which word is lit" is
# decided there and nowhere else. A word is lit while `start <= pos < end` INSIDE the active line, and the
# active line is the first one whose bounds contain `pos` — scanning in document order and stopping at the
# first line that starts after `pos`. Not modelled: the display lead (`lyricsLeadMs`, 0 by default; W6
# revisits it) and JS's UTF-16 string lengths (Python counts code points; only non-BMP text differs). When
# the TV's rendering changes (W8 joins CJK without spaces), this port must change with it, or the metric
# stops measuring what the room sees.
#
# W6 MADE THE FIRST SUCH CHANGE and it is modelled here: a `low` row renders line-level, so it lights no
# word (`tv_wipes_words`, `TvLine.wipes`, `tv_lit(wipe_low=True)`). The `highlight` METRIC deliberately asks
# the other question — see `score_highlight`, which owns that split — while the parity fixture is written
# with the rule ON, so `lyrics.ts` and this port are held to it in both trees.
#
# CROSS-CHECKED against the TypeScript itself (bun, 2026-09-27): 300 random documents — misbound lines,
# blank-text lines, reversed word spans, long lines that re-segment and fold orphans — x 200 positions
# each, the lit word identical at all 60,000. On the raw base-model decode of three Jamendo songs it reads
# within 0.1 pt of the review's painted-span highlight (65.1 / 79.3 / 60.7 vs 65.1 / 79.2 / 60.8%).

#: `lyrics.ts` LINE_GAP_SEC / LINE_MAX_CHARS / COVERAGE_MIN / ORPHAN_MAX_SEC.
TV_LINE_GAP_SEC = 0.45
TV_LINE_MAX_CHARS = 42
TV_COVERAGE_MIN = 0.8
TV_ORPHAN_MAX_SEC = 1.0


@dataclass(frozen=True, slots=True)
class TvWord:
    word: str
    start: float
    end: float
    #: The truth word this published word IS (an index into `Song.words`), or -1: a header's label word,
    #: an injected line, another song's text, or a line whose word count moved.
    truth: int = -1


@dataclass(frozen=True, slots=True)
class TvLine:
    start: float | None
    end: float | None
    text: str
    words: tuple[TvWord, ...]
    #: `lyrics.ts` `wipesWords`: False on a `low` line, which the TV renders as ONE text node with no word
    #: wipe (W6, review §3.7's consumer). Carried per ROW because re-segmentation splits a graded line into
    #: several and each inherits the grade, exactly as `part` and `confidence` do in the TypeScript.
    wipes: bool = True


def tv_wipes_words(confidence: str | None) -> bool:
    """`lyrics.ts` `wipesWords`: every line but a `low` one gets the word-by-word wipe.

    A MISSING GRADE KEEPS THE WIPE, which is the compatibility half of the rule (a v1 document, or any
    worker that did not grade, carries no `confidence`), and `medium` keeps it because the worker grades
    lines `high`/`low` only.
    """
    return confidence != "low"


def _line_from_words(words: Sequence[TvWord], *, wipes: bool = True) -> TvLine:
    """`lineFromWords`."""
    return TvLine(words[0].start, words[-1].end, " ".join(w.word for w in words), tuple(words), wipes=wipes)


def tv_resegment(line: TvLine) -> list[TvLine]:
    """`resegmentLine`: split a line longer than LINE_MAX_CHARS at pauses (and at the char cap)."""
    if len(line.text.strip()) <= TV_LINE_MAX_CHARS or len(line.words) < 2:
        return [line]
    if len(" ".join(w.word for w in line.words)) < len(line.text.strip()) * TV_COVERAGE_MIN:
        return [line]
    out: list[TvLine] = []
    current: list[TvWord] = []
    for word in line.words:
        if current:
            gap = word.start - current[-1].end
            chars = sum(len(x.word) + 1 for x in current) + len(word.word)
            if gap >= TV_LINE_GAP_SEC or chars > TV_LINE_MAX_CHARS:
                out.append(_line_from_words(current))
                current = []
        current.append(word)
    if current:
        out.append(_line_from_words(current))
    # THE GRADE IS THE SOURCE LINE'S, applied to every row it split into — `resegmentLine`'s own last two
    # statements, which write `part` and `confidence` over the whole `split` after the orphan folding
    # rather than threading them through it. Doing it here keeps the merge rules byte-identical.
    return [dataclasses.replace(row, wipes=line.wipes) for row in (_tv_coalesce(out) if out else [line])]


def _tv_coalesce(rows: list[TvLine]) -> list[TvLine]:
    """`coalesceOrphans`: fold a single short word into whichever neighbour it is closer to in time."""
    if len(rows) < 2:
        return rows
    lines = list(rows)
    out: list[TvLine] = []
    for i, line in enumerate(lines):
        prev = out[-1] if out else None
        nxt = lines[i + 1] if i + 1 < len(lines) else None
        first = line.words[0] if line.words else None
        sung = first.end - first.start if first is not None else math.inf
        if (
            len(line.words) != 1
            or sung >= TV_ORPHAN_MAX_SEC
            or (prev is None and nxt is None)
            or first is None
        ):
            out.append(line)
            continue
        prev_end = (prev.words[-1].end if prev.words else prev.end) if prev is not None else None
        next_start = (nxt.words[0].start if nxt.words else nxt.start) if nxt is not None else None
        gap_before = math.inf if prev_end is None else first.start - prev_end
        gap_after = math.inf if next_start is None else next_start - first.end
        if gap_before <= gap_after and out:
            out.append(_line_from_words([*out.pop().words, *line.words]))  # merge BACK
        elif nxt is not None:
            lines[i + 1] = _line_from_words([*line.words, *nxt.words])  # merge FORWARD
        else:  # unreachable from the guard above (the TS would throw); kept so no word is ever lost
            out.append(line)
    return out


def tv_lines(doc: Sequence[tuple[DocLine, Sequence[int]]]) -> list[TvLine]:
    """`parseLyricsDoc` over published lines, each with its words' truth indexes, then re-segmented.

    A word needs non-blank text (a DocWord built without it gets a placeholder, so it still lights); a
    line with no text and no words is dropped, as the TV drops it.
    """
    out: list[TvLine] = []
    for line, truths in doc:
        words = tuple(
            TvWord(w.text if w.text.strip() else "_", w.start, w.end, truth)
            for w, truth in zip(line.words, truths, strict=True)
            if math.isfinite(w.start) and math.isfinite(w.end)
        )
        text = line.text if line.text.strip() else " ".join(w.word for w in words)
        if not text.strip() and not words:
            continue
        start = line.start if math.isfinite(line.start) else None
        end = line.end if math.isfinite(line.end) else None
        out.extend(tv_resegment(TvLine(start, end, text, words, wipes=tv_wipes_words(line.confidence))))
    return out


def _tv_bounds(line: TvLine) -> tuple[float, float] | None:
    """`lineBounds`."""
    start = line.start if line.start is not None else (line.words[0].start if line.words else None)
    end = line.end if line.end is not None else (line.words[-1].end if line.words else None)
    return None if start is None or end is None else (start, end)


def tv_active_line(lines: Sequence[TvLine], pos: float) -> int:
    """`activeLineIndex`: the line being sung, else the last one already ended, else 0 before the first."""
    if not lines:
        return -1
    active = 0
    for i, line in enumerate(lines):
        bounds = _tv_bounds(line)
        if bounds is None:
            continue
        start, end = bounds
        if start <= pos < end:
            return i
        if pos >= end:
            active = i
        else:
            break
    return active


def tv_active_word(line: TvLine, pos: float) -> int:
    """`activeWordIndex`: the first word of `line` with `start <= pos < end`, else -1."""
    for i, word in enumerate(line.words):
        if word.start <= pos < word.end:
            return i
    return -1


def tv_lit(lines: Sequence[TvLine], pos: float, *, wipe_low: bool = False) -> TvWord | None:
    """The word the TV lights at playback position `pos`, or None.

    `wipe_low=True` IS THE SHIPPED TV since W6 (`LyricsOverlay.svelte`'s word branch reads `wipesWords`):
    a `low` row renders as one text node and lights NO word. It is not the default here, and that is a
    deliberate split of two questions — see `score_highlight`, which owns the reason. `tv_parity.py` writes
    the fixture with `wipe_low=True`, so the rule is pinned against `lyrics.ts` in both trees.
    """
    index = tv_active_line(lines, pos)
    if index < 0:
        return None
    if wipe_low and not lines[index].wipes:
        return None
    word = tv_active_word(lines[index], pos)
    return lines[index].words[word] if word >= 0 else None


def highlight_seconds(
    lines: Sequence[TvLine], truth: Sequence[tuple[float, float, int]], *, wipe_low: bool = False
) -> tuple[float, float]:
    """(seconds the CORRECT word is lit, seconds some truth word is sung), exactly, with no time grid.

    Both the lit word and the sung word are piecewise constant between the breakpoints (every bound in
    either series, all half-open), so each elementary interval is judged once at its left end. Where
    truth words overlap, the one that started LATER is the one being sung.
    """
    points = sorted(
        {t for s, e, _k in truth for t in (s, e)}
        | {t for line in lines for w in line.words for t in (w.start, w.end)}
        | {t for line in lines for t in (_tv_bounds(line) or ())}
    )
    if len(points) < 2:
        return 0.0, 0.0
    sung_by = [-1] * (len(points) - 1)
    for start, end, k in sorted(truth, key=lambda t: t[0]):
        for i in range(bisect.bisect_left(points, start), bisect.bisect_left(points, end)):
            sung_by[i] = k
    hit = sung = 0.0
    for i, k in enumerate(sung_by):
        if k < 0:
            continue
        length = points[i + 1] - points[i]
        sung += length
        lit = tv_lit(lines, points[i], wipe_low=wipe_low)
        if lit is not None and lit.truth == k:
            hit += length
    return hit, sung


def score_highlight(
    song: Song, claims: Claims, doc: Sequence[DocLine], *, wipe_low: bool = False
) -> tuple[float, float] | None:
    """(hit, sung) seconds over the truth words of every line the claimed text contains.

    The denominator is the SUNG time of those words — not only of the lines that published: a line the
    aligner dropped lights nothing while it is sung, which is exactly what the room sees. The same holds
    for a case that published NOTHING (an empty `doc`): it scores (0, sung), and `row_of` records that for
    refused and ERROR cases too. A published word counts as correct only when it IS the sung truth word
    (identity pairing, as `score_words`, over lines whose word count held, label or not); every other lit
    word — a header's label, an injected line, a mismatched line — is lit wrongly. A line-synced document
    lights no word at all, so it scores 0.

    W6's LOW-LINE RULE IS MODELLED BY THE PORT AND DELIBERATELY NOT READ HERE (`tv_lit`'s `wipe_low`). This
    metric is an ALIGNMENT reject-if — §3.5's word-end post-pass and 6c's decode axis are both gated on it
    (`gates/w4-ends.yaml`, `gates/w4b-linesep-generate.yaml`), and every recorded row since W0 was measured
    the same way — so it must keep asking ONE question: when the TV lights a word, is it the right one.
    Folding a DISPLAY POLICY in would re-baseline all of those and make a future alignment change's
    highlight number depend on how many lines the grader happened to doubt.
    WHAT MEASURES THE POLICY INSTEAD, already on every row: `high` is how many lines the TV word-wipes,
    and `high_bad` / `high_gross` are how wrong those wipes are (`row_of`). Those three ARE the wipe's
    coverage and its precision, which is what review §3.7's reject-ifs are written in terms of.

    AND THE SHIPPED TV HAS ITS OWN METRIC, NOT A SHARE OF THIS ONE: `wipe_low=True` here is what `row_of`
    records as `highlight_wiped`, pooled by `highlight_metrics` and flattened as `highlight_wiped` (W6 review
    r1-tests-20). NO RECORDED RUN CARRIES IT (W6 review r2-correctness-2): the eight W6 sweeps predate the
    field by three hours, so every one of their 5,636 rows lacks it and `highlight_metrics` answers None for
    them — the number exists as a computation and not yet as a measurement, and the first run that fills it
    is the one that can be quoted. The split above is the argument for two metrics, not for one:
    `high` / `high_bad` / `high_gross` are computed from LINE-START errors on `high`-graded lines, which is
    not the wipe's question ("when the TV lights a word, is it the right one"), so the policy change had no
    number of its own while the policy moved blind coverage 51.5% -> 33.0%. No gate reads the new metric —
    re-baselining §3.5's and 6c's reject-ifs on a display policy is exactly what this function refuses — and
    it costs one more pass over the same breakpoints.
    """
    if song.words is None:
        return None
    counts, offsets = _word_offsets(song)
    paired: list[tuple[DocLine, list[int]]] = []
    for line in doc:
        truths = [-1] * len(line.words)
        claim = claims.lines[line.source] if line.source is not None else None
        if claim is not None and claim.truth is not None:
            expected = counts[claim.truth]
            lead = _truth_offset(claim, len(line.words), expected)
            if lead is not None:
                for k in range(expected):
                    truths[lead + k] = offsets[claim.truth] + k
        paired.append((line, truths))
    sung = [
        (song.words[k].start, song.words[k].end, k)
        for t in sorted(claims.truth_indexes())
        for k in range(offsets[t], offsets[t + 1])
        if song.words[k].end > song.words[k].start
    ]
    return highlight_seconds(tv_lines(paired), sung, wipe_low=wipe_low)


# ── rows and the summary ──────────────────────────────────────────────────────────────────────────────

#: Line tolerances, seconds: e2e2's gross (>2 s), ±500 ms and ±1 s, plus the `high`-but-bad cut at 0.5 s.
GROSS_SEC = 2.0
LINE_TOLERANCES_SEC = (0.5, 1.0)
HIGH_BAD_SEC = 0.5

#: Word onset tolerances, seconds. 0.3 s is MIREX's PCO tolerance.
WORD_TOLERANCES_SEC = (0.1, 0.25, 0.3)
PCO_SEC = 0.3

#: Outcomes a case can end in at `time_text` level.
PUBLISHED, LINE_SYNC, REFUSED, ERROR = "published", "line-sync", "refused", "error"


def row_of(
    *,
    song: Song,
    mode: str,
    variant: int,
    claims: Claims,
    outcome: str,
    doc: Sequence[DocLine],
    extra: Mapping[str, object] | None = None,
) -> dict[str, Any]:
    """One case as a JSON-able row. Raw errors are kept so the summary is recomputable from JSONL alone.

    FULL PRECISION, deliberately (JSON round-trips a float exactly). Rounding looked harmless and is not: a
    claim-adopted line under `off05` sits at exactly +0.5 s +- 1 ulp, and rounding it moves it across the
    ±500 ms tolerance e2e2 compared the raw float against.

    A case that published NOTHING (refused, ERROR) still carries its TEXT-SIDE denominators: `in_text`,
    the words its text asked for (`words.in_text`) and their sung seconds (`highlight.sung`, hit 0). Left
    out, a policy that refuses its hardest songs reads as more accurate: marking hello and bad-guy refused
    in the baseline's truth rows moves e2e2's pooled ±500 89.34 -> 94.04 and gross 25 -> 3, and PCO and
    the highlight rose with it; over the text (`line_metrics`) the same change reads 88.12 -> 85.11.
    Rows written before this carry None there for such cases; re-run, since the summary cannot rebuild a
    text it never saw.
    """
    published = outcome in (PUBLISHED, LINE_SYNC)
    shown: Sequence[DocLine] = doc if published else ()
    errors, disagreements = score_lines(song, claims, shown) if published else ([], None)
    words = score_words(song, claims, shown)
    lit = score_highlight(song, claims, shown)
    # THE SHIPPED TV's own reading, beside the alignment one (W6 review r1-tests-20): a `low` line renders as
    # one text node and lights NO word (`tv_lit(wipe_low=True)`, `lyrics.ts` `wipesWords`), so this is the
    # lit-word accuracy the room actually gets. Ungated, for the reason `score_highlight` gives.
    wiped = score_highlight(song, claims, shown, wipe_low=True)
    return {
        "song": song.slug,
        "group": song.group,
        "mode": mode,
        "variant": variant,
        "donor": claims.donor,
        "outcome": outcome,
        "truth_lines": len(song.truth),
        "text_lines": len(claims.lines),
        "in_text": len(claims.truth_indexes()),
        "doc_lines": len(doc),
        "line_errors": [[e.truth, e.error, e.confidence] for e in errors],
        "pairing_disagreements": disagreements,
        "words": None
        if words is None
        else {
            "in_text": words.in_text,
            "interpolated": words.interpolated,
            "mismatched": words.mismatched,
            "errors": list(words.errors),
            "end_errors": list(words.end_errors),
            "final_end_errors": list(words.final_end_errors),
        },
        "highlight": None if lit is None else {"hit": lit[0], "sung": lit[1]},
        "highlight_wiped": None if wiped is None else {"hit": wiped[0], "sung": wiped[1]},
        **_line_counts([(e.error, e.confidence) for e in errors]),
        **dict(extra or {}),
    }


def count_lines(errors: Sequence[LineError]) -> dict[str, int]:
    """`_line_counts` over `score_lines`' output — one attempt's scored/gross/w500/high counts."""
    return _line_counts([(e.error, e.confidence) for e in errors])


def _line_counts(errors: Sequence[tuple[float, object]]) -> dict[str, int]:
    """e2e2's per-song counts, from (error, confidence) pairs."""
    high = [abs(e) for e, c in errors if c == "high"]
    return {
        "scored": len(errors),
        "gross": sum(1 for e, _c in errors if abs(e) > GROSS_SEC),
        "w500": sum(1 for e, _c in errors if abs(e) <= LINE_TOLERANCES_SEC[0]),
        "w1000": sum(1 for e, _c in errors if abs(e) <= LINE_TOLERANCES_SEC[1]),
        "high": len(high),
        "high_bad": sum(1 for e in high if e > HIGH_BAD_SEC),
        "high_gross": sum(1 for e in high if e > GROSS_SEC),
    }


def pct(part: float, whole: float) -> float | None:
    return round(part / whole * 100.0, 2) if whole else None


def line_metrics(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """e2e2's summary line over `rows`, plus the same counts over the TEXT.

    TWO DENOMINATORS, because they answer different questions:
      * `w500_pct` / `w1000_pct` (flat `pm500` / `pm1000`) are e2e2's, over SCORED lines of PUBLISHED
        cases. A refused case adds no line (e2e2 skipped it). Kept exactly, because the review baseline
        is stated in them, and because they isolate how good a published document is.
      * `w500_text_pct` / `w1000_text_pct` (flat `text_pm500` / `text_pm1000`) are over `in_text`, every
        truth line the claimed text contains, over EVERY case: a line the aligner dropped and a refused
        case's lines are both misses. A change that trades accuracy for refusals, or refuses the songs it
        is worst at, cannot improve these, so a reject-if should use them where that trade must not pass.
    `missing` = `in_text` − `scored` counts both kinds of loss. `text_paired` counts the cases whose lines
    were paired by TEXT because the capture hook did not see their document (line-synced ones; see
    `e2e.doc_lines`), where a repeated line can mispair.

    `unsung` counts PUBLISHED lines that are no truth line — an injected header or credit, an extra verse,
    a sound caption the truth does not carry, every line of a wrong text — which no ±N metric can see: they
    are never scored, so publishing them costs nothing there (review W1 r1: M6's mix witness put back all
    33 unsung lines it spared, and the bench read it as no change). Lower is better outside `wrongtext`.
    """
    published = [r for r in rows if r["outcome"] in (PUBLISHED, LINE_SYNC)]
    errors = [(float(e[1]), e[2]) for r in published for e in r["line_errors"]]
    counts = _line_counts(errors)
    in_text = sum(int(r["in_text"]) for r in rows)
    return {
        "cases": len(rows),
        "published": sum(1 for r in rows if r["outcome"] == PUBLISHED),
        "line_sync": sum(1 for r in rows if r["outcome"] == LINE_SYNC),
        "refused": sum(1 for r in rows if r["outcome"] == REFUSED),
        "error": sum(1 for r in rows if r["outcome"] == ERROR),
        "truth_lines": sum(int(r["truth_lines"]) for r in rows),
        "in_text": in_text,
        "missing": in_text - counts["scored"],
        "unsung": sum(int(r["doc_lines"]) - len(r["line_errors"]) for r in published),
        **counts,
        "w500_pct": pct(counts["w500"], counts["scored"]),
        "w1000_pct": pct(counts["w1000"], counts["scored"]),
        "w500_text_pct": pct(counts["w500"], in_text),
        "w1000_text_pct": pct(counts["w1000"], in_text),
        "zero_gross_songs": sum(
            1 for r in published if not any(abs(float(e[1])) > GROSS_SEC for e in r["line_errors"])
        ),
        "pairing_disagreements": sum(int(r.get("pairing_disagreements") or 0) for r in published),
        "text_paired": sum(1 for r in rows if r.get("identity") == "text"),
    }


def word_metrics(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any] | None:
    """MIREX-style word onset metrics, POOLED over every case of the rows.

    The ±N / AAE / MedAE / bias figures are over ALIGNED words, so only published cases add to them. The
    PCO denominator (`in_text`) counts every truth word every case's text asked for, a refused or ERROR
    case's too (`unpublished` of them), as MIREX's PCO does: a word nobody timed is not a correct onset.
    """
    carried = [r for r in rows if r.get("words")]
    if not carried:
        return None
    scored = [r["words"] for r in carried]
    errors = [float(e) for w in scored for e in w["errors"]]
    in_text = sum(int(w["in_text"]) for w in scored)
    out: dict[str, Any] = {
        "aligned": len(errors),
        "in_text": in_text,
        "unpublished": sum(
            int(r["words"]["in_text"]) for r in carried if r["outcome"] not in (PUBLISHED, LINE_SYNC)
        ),
        "interpolated": sum(int(w["interpolated"]) for w in scored),
        "mismatched": sum(int(w["mismatched"]) for w in scored),
        "gross": sum(1 for e in errors if abs(e) > GROSS_SEC),
    }
    for tol in WORD_TOLERANCES_SEC:
        out[f"w{int(tol * 1000)}_pct"] = pct(sum(1 for e in errors if abs(e) <= tol), len(errors))
    # PCO counts EVERY truth word the text asked for: a word that was not aligned is not a correct onset.
    out["pco300_pct"] = pct(sum(1 for e in errors if abs(e) <= PCO_SEC), in_text)
    if errors:
        out["aae_ms"] = round(statistics.fmean(abs(e) for e in errors) * 1000.0, 1)
        out["medae_ms"] = round(statistics.median(abs(e) for e in errors) * 1000.0, 1)
        out["bias_ms"] = round(statistics.median(errors) * 1000.0, 1)
    # Rows written before ends were scored carry no end lists; they read as "no ends", never as zero.
    out.update(_end_metrics("end", [float(e) for w in scored for e in w.get("end_errors") or []]))
    out.update(_end_metrics("final_end", [float(e) for w in scored for e in w.get("final_end_errors") or []]))
    return out


def _end_metrics(prefix: str, errors: Sequence[float]) -> dict[str, Any]:
    out: dict[str, Any] = {f"{prefix}_scored": len(errors)}
    for tol in END_TOLERANCES_SEC:
        out[f"{prefix}{int(tol * 1000)}_pct"] = pct(sum(1 for e in errors if abs(e) <= tol), len(errors))
    out[f"{prefix}_bias_ms"] = round(statistics.median(errors) * 1000.0, 1) if errors else None
    return out


def highlight_metrics(rows: Sequence[Mapping[str, Any]], *, key: str = "highlight") -> dict[str, Any] | None:
    """The TV highlight, POOLED: correct-lit seconds over sung seconds across EVERY case.

    A case that published nothing lit nothing while its text was sung, so its sung seconds stay in the
    denominator (`unpublished` counts those cases) — "exactly what the room sees" holds per job, not just
    per published line.

    `key` picks which of the two readings `row_of` records: `highlight` is the ALIGNMENT metric (every line
    word-wiped, the question every gate since W0 is written in) and `highlight_wiped` is the SHIPPED TV's
    (`score_highlight`'s docstring owns that split). A run written before the second existed carries None.
    """
    carried = [r for r in rows if r.get(key)]
    if not carried:
        return None
    hit = sum(float(r[key]["hit"]) for r in carried)
    sung = sum(float(r[key]["sung"]) for r in carried)
    return {
        "cases": len(carried),
        "unpublished": sum(1 for r in carried if r["outcome"] not in (PUBLISHED, LINE_SYNC)),
        "hit_sec": round(hit, 2),
        "sung_sec": round(sung, 2),
        "pct": pct(hit, sung),
    }


def policy_metrics(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any] | None:
    """What the POLICY did (level `run_align` only): retries, what they published, where the job ended.

    `mix_published` is review H2 made visible — a document aligned on the MIX (the thin-coverage retry)
    published in place of the stem's; `changed_vs_first` counts every case whose published claim-text
    document is not the first attempt's, whatever knob caused it.
    """
    driven = [r for r in rows if isinstance(r.get("attempts"), list)]
    if not driven:
        return None
    retimes = Counter(str(a["knob"]) for r in driven for a in r["attempts"] if a.get("knob"))
    return {
        "attempts": sum(len(r["attempts"]) for r in driven),
        "retried": sum(1 for r in driven if any(a.get("knob") for a in r["attempts"])),
        "retimes": dict(sorted(retimes.items())),
        "mix_published": sum(
            1
            for r in driven
            if r["outcome"] in (PUBLISHED, LINE_SYNC) and "align-on-mix" in (r.get("published_knobs") or ())
        ),
        "changed_vs_first": sum(1 for r in driven if r.get("changed_vs_first")),
        "asr_requested": sum(1 for r in driven if r.get("asr_requested")),
        "asr_published": sum(1 for r in driven if str(r.get("published_label") or "").startswith("asr:")),
        "no_lyrics": sum(1 for r in driven if r.get("terminal") == "no-lyrics"),
    }


#: Song-bootstrap resamples for the 95% intervals. The resampled UNIT is the song (all of its cases
#: together — a wrong-text song's K pairs move as one), because songs, not lines, are what vary between
#: corpora: one repeat-heavy song can hold a third of a mode's gross lines.
BOOTSTRAP_RESAMPLES = 1000

#: The metrics that get an interval, with their printed labels.
CI_LABELS: Mapping[str, str] = {
    "pm500": "±500",
    "text_pm500": "±500/text",
    "gross": "gross",
    "word_pm300": "±300",
    "word_pco300": "PCO@.3",
    "highlight": "highlight",
}


def bootstrap_ci(
    rows: Sequence[Mapping[str, Any]], *, label: str, seed: int = 0, resamples: int = BOOTSTRAP_RESAMPLES
) -> dict[str, list[float] | None]:
    """Percentile 95% intervals for every `CI_LABELS` metric, by resampling SONGS.

    SEEDED from (`seed`, `label`) with crc32, so a mode's interval does not move when other modes join
    the run, and one run's intervals are reproducible. Each resample pools exactly as the point estimate
    does (Σ hits / Σ scored, and the text-denominator metrics over every case), so the interval brackets
    the number printed beside it. None for a metric with no data (YouTube has no word truth).
    """
    songs = sorted({str(r["song"]) for r in rows})
    if not songs:
        return {}
    columns = ("w500", "scored", "gross", "w300", "aligned", "hit", "sung", "in_text", "word_in_text")
    table = np.zeros((len(songs), len(columns)))
    where = {song: i for i, song in enumerate(songs)}
    for r in rows:
        i = where[str(r["song"])]
        words = r.get("words") or {}
        errors = [float(e) for e in words.get("errors") or []]
        lit = r.get("highlight") or {}
        table[i] += np.array(
            [
                float(r["w500"]),
                float(r["scored"]),
                float(r["gross"]),
                sum(1 for e in errors if abs(e) <= WORD_TOLERANCES_SEC[-1]),
                len(errors),
                float(lit.get("hit") or 0.0),
                float(lit.get("sung") or 0.0),
                float(r["in_text"]),
                float(words.get("in_text") or 0.0),
            ]
        )
    rng = np.random.default_rng(zlib.crc32(f"{seed}|{label}".encode()))
    draws = table[rng.integers(0, len(songs), size=(resamples, len(songs)))].sum(axis=1)

    def interval(values: np.ndarray[Any, Any]) -> list[float] | None:
        finite = values[np.isfinite(values)]
        if not len(finite):
            return None
        low, high = np.percentile(finite, [2.5, 97.5])
        return [round(float(low), 2), round(float(high), 2)]

    def ratio(num: int, den: int) -> list[float] | None:
        if not table[:, den].any():
            return None
        with np.errstate(divide="ignore", invalid="ignore"):
            return interval(100.0 * draws[:, num] / draws[:, den])

    # PCO's tolerance IS the last word tolerance, so column 3 is its numerator too.
    assert WORD_TOLERANCES_SEC[-1] == PCO_SEC
    return {
        "pm500": ratio(0, 1),
        "text_pm500": ratio(0, 7),
        "gross": interval(draws[:, 2]) if table[:, 1].any() else None,
        "word_pm300": ratio(3, 4),
        "word_pco300": ratio(3, 8),
        "highlight": ratio(5, 6),
    }


def group_entry(
    rows: Sequence[Mapping[str, Any]], mode: str, *, label: str, ci: bool = True
) -> dict[str, Any]:
    """Every metric block for one set of rows of ONE mode (a group, or one song)."""
    entry: dict[str, Any] = {
        "lines": line_metrics(rows),
        "words": word_metrics(rows),
        "highlight": highlight_metrics(rows),
        "highlight_wiped": highlight_metrics(rows, key="highlight_wiped"),
    }
    if "wrongtext" in parse_mode(mode):
        # An ERROR row is NOT a refused wrong text: counted as one, a helper that raises on some texts
        # would LOWER the pass rate and pass W3's "wrong-text pass rate must fall" on a crash. So errors
        # leave the denominator (and fail the gate run outright; `e2e_gates.run_gates`).
        passed = sum(1 for r in rows if r["outcome"] in (PUBLISHED, LINE_SYNC))
        errors = sum(1 for r in rows if r["outcome"] == ERROR)
        entry["wrongtext"] = {
            "pairs": len(rows) - errors,
            "published": passed,
            "errors": errors,
            "pass_rate_pct": pct(passed, len(rows) - errors),
        }
    policy = policy_metrics(rows)
    if policy is not None:
        entry["policy"] = policy
    if ci:
        entry["ci"] = bootstrap_ci(rows, label=label)
    return entry


def summarize(rows: Sequence[Mapping[str, Any]]) -> dict[str, dict[str, dict[str, Any]]]:
    """`{mode: {group: {"lines", "words", "highlight", "ci", ...}}}` — Jamendo, YouTube(+tfr), all."""
    out: dict[str, dict[str, dict[str, Any]]] = {}
    for mode in dict.fromkeys(r["mode"] for r in rows):
        of_mode = [r for r in rows if r["mode"] == mode]
        out[mode] = {}
        for group in GROUPS:
            members = [r for r in of_mode if group == ALL or r["group"] == group]
            if members:
                out[mode][group] = group_entry(members, mode, label=f"{mode}|{group}")
    return out


# ── the flat view: one name per number, what --compare and --gates read ───────────────────────────────

#: (block, key in the block, flat name). The flat names are the gate language's metric vocabulary.
_FLAT: tuple[tuple[str, str, str], ...] = (
    *(
        ("lines", key, key)
        for key in (
            "cases",
            "published",
            "line_sync",
            "refused",
            "error",
            "in_text",
            "scored",
            "missing",
            "unsung",
            "gross",
            "w500",
            "w1000",
            "zero_gross_songs",
            "high",
            "high_bad",
            "high_gross",
            "text_paired",
        )
    ),
    ("lines", "w500_pct", "pm500"),
    ("lines", "w1000_pct", "pm1000"),
    ("lines", "w500_text_pct", "text_pm500"),
    ("lines", "w1000_text_pct", "text_pm1000"),
    ("words", "aligned", "word_aligned"),
    ("words", "in_text", "word_in_text"),
    ("words", "unpublished", "word_unpublished"),
    ("words", "gross", "word_gross"),
    ("words", "w100_pct", "word_pm100"),
    ("words", "w250_pct", "word_pm250"),
    ("words", "w300_pct", "word_pm300"),
    ("words", "pco300_pct", "word_pco300"),
    ("words", "aae_ms", "word_aae_ms"),
    ("words", "medae_ms", "word_medae_ms"),
    ("words", "bias_ms", "word_bias_ms"),
    ("words", "end100_pct", "end_pm100"),
    ("words", "end250_pct", "end_pm250"),
    ("words", "end_bias_ms", "end_bias_ms"),
    ("words", "final_end100_pct", "final_end_pm100"),
    ("words", "final_end250_pct", "final_end_pm250"),
    ("words", "final_end_bias_ms", "final_end_bias_ms"),
    ("highlight", "pct", "highlight"),
    ("highlight_wiped", "pct", "highlight_wiped"),
    ("wrongtext", "pass_rate_pct", "wrongtext_pass"),
    ("policy", "attempts", "attempts"),
    ("policy", "retried", "retried"),
    ("policy", "mix_published", "mix_published"),
    ("policy", "changed_vs_first", "changed_vs_first"),
    ("policy", "asr_requested", "asr_requested"),
    ("policy", "asr_published", "asr_published"),
    ("policy", "no_lyrics", "no_lyrics"),
)


#: Every `policy.Knob` a retime can carry, by value (`test_bench_e2e` pins this to the enum, so a new knob
#: fails the suite until it is listed). Kept as data so this half imports no worker code.
RETIME_KNOBS = ("reshift", "align-on-mix", "drop-windows", "line-sync")


def flat_metrics(entry: Mapping[str, Any]) -> dict[str, float | None]:
    """One metric block as `{name: number}`: `pm500`, `word_pm300`, `highlight`, `pm500_lo`, ...

    A block the entry does not have (no words on YouTube; no policy below `run_align`) reads as None, which
    the gate evaluator refuses to compare rather than treating as zero.

    EVERY `retime_<knob>` EXISTS: 0 for a knob a `run_align` entry never used, None below `run_align`. Only
    the knobs that occurred used to get a key, so the gate W1's H2 fix implies — `truth.retime_align_on_mix
    == 0` — was an "unknown metric" ERROR exactly when the fix worked (measured: `blind.retime_line_sync`
    on `baseline-v2-run_align.json`, whose blind cases never used LINE_SYNC).
    """
    out: dict[str, float | None] = {}
    for block, key, name in _FLAT:
        value = (entry.get(block) or {}).get(key)
        out[name] = None if value is None else float(value)
    policy = entry.get("policy")
    for knob in RETIME_KNOBS:
        out[f"retime_{knob.replace('-', '_')}"] = None if policy is None else 0.0
    for knob, count in ((policy or {}).get("retimes") or {}).items():
        out[f"retime_{knob.replace('-', '_')}"] = float(count)
    for name, bounds in (entry.get("ci") or {}).items():
        out[f"{name}_lo"], out[f"{name}_hi"] = (None, None) if bounds is None else (bounds[0], bounds[1])
    return out


#: The per-song numbers `summary.json` keeps (for `song.*` gates and per-song deltas). A subset, so the
#: committed baseline stays a small file. `coverage` is the FIRST attempt's stem coverage (the number
#: `policy.decide` retries on; 0.0 when attempt 1 published nothing) — W1's reject-if is "a published doc
#: changes on a song whose coverage is >= 0.80".
SONG_METRICS = (
    "cases",
    "published",
    "refused",
    "error",
    "scored",
    "missing",
    "unsung",
    "gross",
    "pm500",
    "pm1000",
    "text_pm500",
    "high_gross",
    "word_pm100",
    "word_pm300",
    "word_pco300",
    "word_bias_ms",
    "end_pm100",
    "final_end_pm100",
    "highlight",
    "wrongtext_pass",
    "mix_published",
    "changed_vs_first",
    "no_lyrics",
    "coverage",
)

#: The per-song DIGESTS `summary.json` keeps: (per-song key, row field). Not numbers — the gates read
#: them only as `song.doc_changed` / `song.onsets_changed`, run against baseline. `doc` is the published
#: document's bytes (the file the TV reads); `onsets` its line and word START times alone, for W4's "no
#: onset moves" when a change is meant to touch only word ends.
SONG_DIGESTS: tuple[tuple[str, str], ...] = (("doc", "doc_sha256"), ("onsets", "onsets_sha256"))

#: The digest of "published nothing" (a refusal, an error): a document appearing or vanishing is a change.
NO_DOCUMENT = "-"


#: The worker's top-level record of a document's whole TEXT, written only when its `lines` lost some of it
#: (`align_steps._with_source_lines`, review W1 r1: a re-pick re-times it). Not rendered and not timed.
SOURCE_LINES_KEY = "sourceLines"


def doc_digest(body: bytes) -> str:
    """The published document's identity: sha256 of the exact bytes the TV fetches, 16 hex.

    EXCEPT `sourceLines` (`SOURCE_LINES_KEY`), which the TV's parser never reads: a document carrying it is
    digested as the bytes the worker writes without it (the same `json.dump`, and JSON floats round-trip
    exactly), so the key it gained in W1 does not read as a changed document against a baseline written
    before it — every `doc_changed` gate keeps meaning "what the TV renders or times changed". A document
    without the key is its bytes, as ever.
    """
    try:
        loaded = json.loads(body)
    except ValueError:
        loaded = None
    if isinstance(loaded, dict) and SOURCE_LINES_KEY in loaded:
        del loaded[SOURCE_LINES_KEY]
        body = json.dumps(loaded, ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(body).hexdigest()[:16]


def onset_digest(lines: Sequence[DocLine]) -> str:
    """Every published line's identity and START, and every word's start, at full precision, 16 hex.

    Ends are left out on purpose: a word-end change (W4 6b) must leave this unchanged, and any onset that
    moves at all — even by one ulp — changes it.
    """
    starts = [[line.source, line.start, [w.start for w in line.words]] for line in lines]
    return hashlib.sha256(json.dumps(starts).encode("utf-8")).hexdigest()[:16]


def _combined_digest(digests: Sequence[str | None]) -> str:
    """One song's digest over its cases (a wrong-text song has K), in case order."""
    shown = [d or NO_DOCUMENT for d in digests]
    if len(shown) == 1:
        return shown[0]
    return hashlib.sha256("|".join(shown).encode("utf-8")).hexdigest()[:16]


def per_song(rows: Sequence[Mapping[str, Any]]) -> dict[str, dict[str, dict[str, Any]]]:
    """`{mode: {song: {"group": ..., <SONG_METRICS>, <SONG_DIGESTS>}}}`; a song's variants pool together.

    A digest is kept only when the rows carry it (the `generate` level writes no document, and rows from
    before digests existed carry none), so `song.doc_changed` errors instead of comparing nothing.
    """
    out: dict[str, dict[str, dict[str, Any]]] = {}
    for mode in dict.fromkeys(r["mode"] for r in rows):
        of_mode = [r for r in rows if r["mode"] == mode]
        out[mode] = {}
        for song in dict.fromkeys(str(r["song"]) for r in of_mode):
            mine = sorted((r for r in of_mode if r["song"] == song), key=lambda r: int(r["variant"]))
            flat = flat_metrics(group_entry(mine, mode, label="", ci=False))
            coverage = [float(r["first_coverage"]) for r in mine if r.get("first_coverage") is not None]
            if coverage:
                flat["coverage"] = round(statistics.fmean(coverage), 4)
            values: dict[str, Any] = {name: flat[name] for name in SONG_METRICS if flat.get(name) is not None}
            for key, field in SONG_DIGESTS:
                if all(field in r for r in mine):
                    values[key] = _combined_digest([r[field] for r in mine])
            out[mode][song] = {"group": str(mine[0]["group"]), **values}
    return out


def _fmt(value: object, width: int, spec: str = "") -> str:
    return ("-" if value is None else format(value, spec)).rjust(width)


def format_summary(summary: Mapping[str, Mapping[str, Mapping[str, Any]]]) -> str:
    """The printed table: one block per mode, one row per group, words on Jamendo's row."""
    out: list[str] = []
    for mode, groups in summary.items():
        out.append(f"== {mode}")
        out.append(
            f"  {'group':<8} {'cases':>5} {'pub':>4} {'ref':>4} {'err':>3} {'lines':>6} {'miss':>5} "
            f"{'gross':>5} {'±500':>6} {'±1s':>6} {'txt500':>6} {'0-gr':>5} {'high':>5} {'h>.5':>5} "
            f"{'h>2':>4}"
        )
        for group, entry in groups.items():
            m = entry["lines"]
            out.append(
                f"  {group:<8} {m['cases']:>5} {m['published'] + m['line_sync']:>4} {m['refused']:>4} "
                f"{m['error']:>3} {m['scored']:>6} "
                f"{m['missing']:>5} {m['gross']:>5} {_fmt(m['w500_pct'], 6, '.1f')} "
                f"{_fmt(m['w1000_pct'], 6, '.1f')} {_fmt(m.get('w500_text_pct'), 6, '.1f')} "
                f"{m['zero_gross_songs']:>5} {m['high']:>5} {m['high_bad']:>5} {m['high_gross']:>4}"
            )
            if m.get("text_paired"):
                out.append(
                    f"  {'':<8} {m['text_paired']} case(s) paired by TEXT: the capture did not see their "
                    "document (line-synced), so a repeated line may mispair"
                )
            if entry.get("wrongtext"):
                wt = entry["wrongtext"]
                out.append(
                    f"  {'':<8} wrong-text pass rate {wt['published']}/{wt['pairs']} = "
                    f"{_fmt(wt['pass_rate_pct'], 0, '.1f')}%"
                    + (f" ({wt['errors']} ERROR rows left out)" if wt.get("errors") else "")
                )
            w = entry.get("words")
            if w and w["in_text"] and group != ALL:
                out.append(
                    f"  {'':<8} words {w['aligned']}/{w['in_text']}  ±100 {_fmt(w['w100_pct'], 0, '.1f')}"
                    f"  ±250 {_fmt(w['w250_pct'], 0, '.1f')}  ±300 {_fmt(w['w300_pct'], 0, '.1f')}"
                    f"  PCO@.3 {_fmt(w['pco300_pct'], 0, '.1f')}  AAE {_fmt(w.get('aae_ms'), 0, '.0f')}ms"
                    f"  MedAE {_fmt(w.get('medae_ms'), 0, '.0f')}ms"
                    f"  bias {_fmt(w.get('bias_ms'), 0, '+.0f')}ms"
                    f"  >2s {w['gross']}"
                    + (f"  (unpublished {w['unpublished']})" if w.get("unpublished") else "")
                )
            if w and w.get("end_scored") and group != ALL:
                out.append(
                    f"  {'':<8} ends {w['end_scored']}  ±100 {_fmt(w.get('end100_pct'), 0, '.1f')}"
                    f"  ±250 {_fmt(w.get('end250_pct'), 0, '.1f')}"
                    f"  bias {_fmt(w.get('end_bias_ms'), 0, '+.0f')}ms"
                    f"  | phrase-final {w.get('final_end_scored')}"
                    f"  ±100 {_fmt(w.get('final_end100_pct'), 0, '.1f')}"
                    f"  ±250 {_fmt(w.get('final_end250_pct'), 0, '.1f')}"
                    f"  bias {_fmt(w.get('final_end_bias_ms'), 0, '+.0f')}ms"
                )
            lit = entry.get("highlight")
            if lit and group != ALL:
                # The SHIPPED TV's reading sits beside the alignment one, never instead of it (W6 review
                # r1-tests-20): the first is "when a word is lit, is it the right one", the second is what
                # the room gets once `low` rows stop wiping. A run written before it carries None.
                wiped = entry.get("highlight_wiped") or {}
                out.append(
                    f"  {'':<8} highlight {_fmt(lit['pct'], 0, '.1f')}% of {lit['sung_sec']:.0f}s sung "
                    f"(TV semantics, {lit['cases']} cases"
                    + (f", {lit['unpublished']} published nothing)" if lit.get("unpublished") else ")")
                    + (f"  | as shipped (no `low` wipe) {_fmt(wiped.get('pct'), 0, '.1f')}%" if wiped else "")
                )
            ci = entry.get("ci") or {}
            # Word and highlight intervals print on Jamendo's row only, as their point estimates do.
            shown = (
                ("pm500", "text_pm500", "gross")
                if group == ALL
                else ("pm500", "text_pm500", "gross", "word_pm300", "word_pco300", "highlight")
            )
            spans = [
                f"{CI_LABELS[key]} {bounds[0]:g}–{bounds[1]:g}"
                for key in shown
                if (bounds := ci.get(key)) is not None
            ]
            if spans:
                out.append(f"  {'':<8} 95% CI (song bootstrap)  " + "  ".join(spans))
            policy = entry.get("policy")
            if policy:
                knobs = ", ".join(f"{k} {v}" for k, v in policy["retimes"].items()) or "none"
                out.append(
                    f"  {'':<8} policy: {policy['attempts']} attempts, {policy['retried']} retried "
                    f"({knobs}); mix published {policy['mix_published']}; changed vs first "
                    f"{policy['changed_vs_first']}; ASR asked {policy['asr_requested']}, published "
                    f"{policy['asr_published']}; no-lyrics {policy['no_lyrics']}"
                )
    return "\n".join(out)


def read_rows(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def row_codes(rows: Sequence[Mapping[str, Any]]) -> list[str]:
    """The distinct worker-tree fingerprints among `rows` (`?` for rows written before rows carried one)."""
    return sorted({str(r.get("code") or "?") for r in rows})


def rows_document(path: Path) -> dict[str, Any]:
    """The summary document of a `rows.jsonl`, re-summarized; its meta is the `run.json` beside it.

    `--summarize` and a rows-file baseline used to carry only `rows` / `row_codes` as meta, so an offline
    `--summarize NEW --compare BASE --gates` could not tell a run on other tfr audio, level or seed from a
    comparable one — not even as a warning. `run.json` is what `e2e.py` wrote when the rows were measured
    (and what `--resume` holds every later row to), so it IS the rows' setup. Absent (rows copied out of
    their run directory), the meta says nothing, and `e2e_gates.run_gates` refuses baseline gates on it.

    Rows without `line_errors` are refused by name: that is a compact `results/*.cases.jsonl`, the file
    beside every committed baseline, and re-summarizing it died in `line_metrics` on a bare
    `KeyError: 'line_errors'` that `--compare` did not even report as a bad baseline.
    """
    rows = read_rows(path)
    bare = next((number for number, row in enumerate(rows, 1) if "line_errors" not in row), None)
    if bare is not None:
        raise ValueError(
            f"{path}: row {bare} has no `line_errors`, so it is not a raw rows file (a compact "
            ".cases.jsonl?); pass the summary .json, or the raw rows its meta.rows_full names"
        )
    config = path.parent / "run.json"
    recorded: object = json.loads(config.read_text(encoding="utf-8")) if config.is_file() else {}
    meta: dict[str, Any] = dict(recorded) if isinstance(recorded, dict) else {}
    meta.update(rows=str(path), row_codes=row_codes(rows))
    return {"meta": meta, "summary": summarize(rows), "songs": per_song(rows)}


#: The row fields a compact case keeps (`compact_row`), in this order.
COMPACT_KEEP = (
    "song",
    "group",
    "mode",
    "variant",
    "donor",
    "outcome",
    "verdict",
    "confidence",
    "coverage",
    "truth_lines",
    "text_lines",
    "in_text",
    "doc_lines",
    "scored",
    "gross",
    "w500",
    "w1000",
    "high",
    "high_bad",
    "high_gross",
    "report_words",
    "identity",
    "terminal",
    "published_attempt",
    "published_label",
    "published_knobs",
    "changed_vs_first",
    "asr_requested",
    "doc_sha256",
    "onsets_sha256",
    "first_coverage",
    "code",
    "served_lines",
    "published_file_attempt",
    "exception",
    # W3: the lexical gate's reading and the LINE_SYNC rung's own note (sheet fit, lift, decode agreement).
    "lift",
    "line_sync_verdict",
    "line_sync_why",
)

#: The per-attempt fields a compact case keeps.
COMPACT_ATTEMPT = (
    "n",
    "text",
    "knobs",
    "result",
    "verdict",
    "coverage",
    "words",
    "out_of_order",
    "scored",
    "gross",
    "w500",
    "decision",
    "lift",
    "line_sync_verdict",
    "line_sync_why",
)


def compact_row(row: Mapping[str, Any]) -> dict[str, Any]:
    """One raw row as the compact per-case digest committed beside a summary (`results/*.cases.jsonl`).

    The raw per-line / per-word error arrays are dropped (they stay in the bench root's `rows.jsonl`, and a
    compact file is refused as a baseline by `rows_document`); identity, outcome, verdict, line counts, the
    word / highlight aggregates and, at `run_align`, the attempt story are kept. Before W3 this lived in a
    scratch script that kept only the `align-global` verdict, so a LINE_SYNC attempt's gate — its sheet fit
    and lexical lift — could be read only by re-running the case under a wrapper (W1 review r2's probe);
    `lift` and the rung's own note are kept now, per case and per attempt. A value of None is left out.
    """
    out: dict[str, Any] = {key: row[key] for key in COMPACT_KEEP if row.get(key) is not None}
    if isinstance(out.get("lift"), float):
        out["lift"] = round(out["lift"], 4)
    out["repair_faults"] = len(row.get("repair_faults") or [])
    words = row.get("words")
    if words:
        errors = [float(e) for e in words.get("errors") or []]
        out["words"] = {
            "aligned": len(errors),
            "in_text": words.get("in_text"),
            "pm100": sum(abs(e) <= 0.1 for e in errors),
            "pm300": sum(abs(e) <= 0.3 for e in errors),
            "gross": sum(abs(e) > GROSS_SEC for e in errors),
            "bias_ms": round(statistics.median(errors) * 1000, 1) if errors else None,
        }
    for key in ("highlight", "highlight_wiped"):
        lit = row.get(key)
        if lit:
            out[key] = {"hit": round(float(lit["hit"]), 2), "sung": round(float(lit["sung"]), 2)}
    attempts = row.get("attempts")
    if attempts:
        out["attempts"] = [
            {
                key: round(value, 4) if key == "lift" and isinstance(value, float) else value
                for key in COMPACT_ATTEMPT
                if (value := attempt.get(key)) is not None
            }
            for attempt in attempts
        ]
    return out


def dump_document(document: Mapping[str, Any]) -> str:
    """`summary.json`'s text: indented, except that each per-song entry sits on ONE line.

    The per-song block is most of the file (32 songs x every mode), and a committed baseline is reviewed as
    a diff — one line per song halves the file and makes a moved song one changed line. Plain JSON either
    way (`json.loads` reads it back unchanged; tested).
    """
    head = {key: value for key, value in document.items() if key != "songs"}
    text = json.dumps(head, indent=1, ensure_ascii=False)
    songs: Mapping[str, Mapping[str, Any]] = document.get("songs") or {}
    if not songs:
        return text + "\n"
    blocks = []
    for mode, entries in songs.items():
        rows = ",\n".join(
            f"   {json.dumps(song, ensure_ascii=False)}: {json.dumps(entry, ensure_ascii=False)}"
            for song, entry in entries.items()
        )
        blocks.append(f"  {json.dumps(mode, ensure_ascii=False)}: {{\n{rows}\n  }}")
    opening = text[: text.rfind("}")].rstrip()
    separator = "," if head else ""
    return f'{opening}{separator}\n "songs": {{\n' + ",\n".join(blocks) + "\n }\n}\n"


# ── the emissions disk cache ──────────────────────────────────────────────────────────────────────────

#: Bump when the stored layout changes; old entries then miss instead of loading wrong.
STORE_VERSION = 2


def emitter_fingerprint(sources: Iterable[Path], versions: Mapping[str, str]) -> str:
    """What PRODUCED an emission matrix, beyond its inputs: the emitting code and the ML library versions.

    Part of the cache key because the bench outlives the code it measures — a later wave that changes the
    frame grid (review 6a) or the blank handling must not be scored on matrices the old code emitted.
    Keyed on whole modules — `sources` is the emitting module's import closure (`module_closure`) — so even
    a docstring edit costs one recompute; that is the safe direction for a gate. `versions` must name
    everything else that shapes the matrix: the caller adds the ffmpeg build that decodes and resamples
    the audio (the Jamendo mixes, R4's witness, are mp3), the transformers version that runs a Hub
    checkpoint, and the worker's `align_*` settings (`e2e.emitter_fingerprint`).
    """
    digest = hashlib.sha256()
    for path in sources:
        digest.update(path.read_bytes())
    digest.update(json.dumps(dict(versions), sort_keys=True).encode("utf-8"))
    return digest.hexdigest()[:16]


def module_closure(entry: Path, root: Path) -> list[Path]:
    """`entry` and every module of the package at `root` it imports, TRANSITIVELY, sorted.

    Read with `ast`, so a lazy import inside a function counts (every ML import in `adapters/ml.py` is
    lazy), and each imported module's package `__init__` rides along, since importing runs it. Relative
    imports resolve against the importing module's package. What this cannot see is an import built at
    run time (`importlib`), which the worker does not use.

    WHY THE CLOSURE and not the one defining file: the emissions key used to hash `adapters/ml.py` alone,
    so a later wave that moves the frame grid or the context trim (review 6a) into a helper module ml.py
    calls — a vendored `generate_emissions`, a pure frame-grid function — would leave ml.py's bytes as
    they were and serve every pre-change matrix to the post-change bench. Today the closure is 10 files:
    ml.py, what it imports (`domain/document.py`, `domain/audio/wav.py`, `host/mlrt.py`,
    `host/hardware.py`) and their package inits. A new THIRD-PARTY library on the emission path is not
    found this way; it goes into `e2e.emitter_versions`.
    """
    root = root.resolve()
    package = root.name
    seen: set[Path] = set()
    queue = [entry.resolve()]
    while queue:
        path = queue.pop()
        if path in seen:
            continue
        seen.add(path)
        home = list(path.relative_to(root).parts[:-1])  # the importing module's package, under `root`
        for depth in range(len(home) + 1):  # its own package inits run first
            found = _module_file(root, home[:depth])
            if found is not None and found not in seen:
                queue.append(found)
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"), filename=str(path))):
            names: list[list[str]] = []
            if isinstance(node, ast.Import):
                names = [alias.name.split(".") for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                if node.level:
                    base = [package, *home[: max(len(home) - (node.level - 1), 0)]]
                else:
                    base = []
                module = [*base, *(node.module.split(".") if node.module else [])]
                names = [module, *([*module, alias.name] for alias in node.names)]
            for name in names:
                if name[:1] != [package]:
                    continue
                for depth in range(1, len(name) + 1):  # every package on the way runs its __init__
                    found = _module_file(root, name[1:depth])
                    if found is not None and found not in seen:
                        queue.append(found)
    return sorted(seen)


def _module_file(root: Path, parts: Sequence[str]) -> Path | None:
    """The file `root.<parts>` imports: a module, else a package's `__init__`, else None (a name in one)."""
    module = root.joinpath(*parts).with_suffix(".py") if parts else None
    if module is not None and module.is_file():
        return module
    package = root.joinpath(*parts, "__init__.py")
    return package if package.is_file() else None


def tree_digest(roots: Iterable[Path]) -> str:
    """Every file under `roots` (bytecode caches excepted), by relative path and content, 16 hex.

    The CODE a bench row measured. HEAD alone cannot say it: every wave of this plan lands uncommitted on
    one HEAD (23c44114), so a `--resume` across a fix, or a baseline recorded mid-wave, would pool two
    versions of `time_text` under one commit id.
    """
    digest = hashlib.sha256()
    for root in roots:
        files = sorted(
            p
            for p in root.rglob("*")
            if p.is_file()
            and "__pycache__" not in p.parts
            and p.suffix not in (".pyc", ".pyo")
            and not p.name.startswith(".")  # .DS_Store and editor droppings are not code
        )
        for path in files:
            digest.update(f"{root.name}/{path.relative_to(root).as_posix()}\0".encode())
            digest.update(path.read_bytes())
            digest.update(b"\0")
    return digest.hexdigest()[:16]


#: An `align_*` setting that names WHAT a run computed rather than HOW it computed it, so recording it here
#: would split one computation across two emitter fingerprints depending on how the operator spelled it
#: (`align_config`, W4b review r2). Only `align_model` qualifies, and only because the resolved bundle is
#: recorded three other ways; a knob that CHANGES the matrices or the timings must never be added.
SPELLING_ONLY = frozenset({"align_model"})


def align_config(config: object) -> dict[str, object]:
    """The alignment settings of a worker `Config`: every field named `align_*`, JSON-able.

    Recorded in `run.json` (a `--resume` under other settings is refused) and in the summary's meta
    (`--compare` warns when they differ), because the default-off arms of PLAN-alignment-v3 live behind
    `Config.align_experiments` and an arm measured with its knob silently OFF reads exactly like the
    baseline. A new alignment setting must follow the `align_` naming to be recorded here.

    AN UNSET SETTING IS LEFT OUT — an empty set (no arm switched on). That is the default path, so it
    records, compares and keys the emission cache exactly as a worker without the knob did: W1 added
    `align_experiments`, and recording it empty would have moved every matrix's key (a cold recompute of the
    whole corpus for an identical computation) and made every W0 baseline warn on `--compare`.

    `align_model` IS EXCLUDED OUTRIGHT (`SPELLING_ONLY`), which this docstring used to argue for and the code
    used to do only for a None — the defect W4b review r2 (spec-14, correctness-6) found. `e2e.resolve_bundle`
    folds `ENCORE_ALIGN_MODEL` and `--model` into ONE resolved bundle, but it does not write the answer back
    into the dataclass, so `--model HUBERT_ASR_LARGE` left this `{}` while the env spelling of the SAME
    command left `{'align_model': 'HUBERT_ASR_LARGE'}` — two emitter fingerprints
    (`e2e.emitter_fingerprint`), hence two disjoint emission-store namespaces for one computation, and a
    `--compare` warning between them (`COMPARED_META`). Since every committed W4b row was measured with the
    flag, an operator following README's own recipe (`ENCORE_ALIGN_MODEL=… e2e.py --modes all`) recomputed 64
    matrices cold. WHICH MODEL A RUN LOADED IS NOT LOST BY THIS, which is what makes dropping it safe: the
    resolved bundle is `run.json`'s and the summary's `model`, its weights are digested in `model_identity`,
    and the emission store's own key carries `<label>@<identity>` (`e2e.BenchAligner`) — all three moving with
    the bundle. This field would only have said whether the operator typed the name or took the default.
    """
    out: dict[str, object] = {}
    for field in dataclasses.fields(config):  # type: ignore[arg-type]
        if field.name.startswith("align_") and field.name not in SPELLING_ONLY:
            value = getattr(config, field.name)
            if value is None:
                continue
            if isinstance(value, (set, frozenset)):
                if not value:
                    continue
                value = sorted(value)
            out[field.name] = value
    return out


class EmissionStore:
    """Emission matrices on disk under `$ENCORE_BENCH_ROOT/_emissions`, one `.npz` per key.

    KEY = (resolved audio path, size, mtime_ns, model, language, emitter fingerprint). `model` is what the
    aligner LOADED, not what the harness asked for: `e2e.BenchAligner` keys each language's entries on
    the label plus a digest of the loaded weights and dictionary (`for_model`). A name alone would serve
    one model's matrices to another the moment the shipped adapter picks its model some other way (W4
    6b: `ENCORE_ALIGN_MODEL`, a per-device default) or a Hub checkpoint moves. DEVICE-INDEPENDENT by
    design: the review measured MPS and CPU emissions identical (100% argmax agreement, 0 ms per-word
    difference), so a matrix computed on either serves both; if the model choice ever depends on the
    device, the weights digest moves with it. The device that produced an entry is kept in its metadata
    for provenance only.

    Stores numpy; the caller rebuilds its own `Emissions` (torch tensor) from what `load` returns, so this
    half stays torch-free. Writes are atomic (temp file + `os.replace`): an interrupted run leaves either
    the old entry or none, never a truncated matrix that would load as a silent wrong answer.
    """

    def __init__(self, directory: Path, *, model: str, emitter: str) -> None:
        self.directory = directory
        self.model = model
        self.emitter = emitter

    def for_model(self, model: str) -> EmissionStore:
        """The same store keyed on another model identity."""
        return EmissionStore(self.directory, model=model, emitter=self.emitter)

    def key(self, audio_path: str, language: str) -> tuple[str, dict[str, object]]:
        real = os.path.realpath(audio_path)
        stat = os.stat(real)
        parts: dict[str, object] = {
            "version": STORE_VERSION,
            "path": real,
            "size": stat.st_size,
            "mtime_ns": stat.st_mtime_ns,
            "model": self.model,
            "language": language,
            "emitter": self.emitter,
        }
        digest = hashlib.sha256(json.dumps(parts, sort_keys=True).encode("utf-8")).hexdigest()[:32]
        return digest, parts

    def path_of(self, digest: str) -> Path:
        return self.directory / f"{digest}.npz"

    def load(self, audio_path: str, language: str) -> tuple[np.ndarray[Any, Any], dict[str, Any]] | None:
        digest, parts = self.key(audio_path, language)
        path = self.path_of(digest)
        if not path.is_file():
            return None
        with np.load(path, allow_pickle=False) as stored:
            meta: dict[str, Any] = json.loads(str(stored["meta"]))
            if meta.get("key") != parts:
                return None  # a digest collision or a hand-copied file: never serve a foreign matrix
            matrix = np.array(stored["log_probs"])
        return matrix, meta

    def save(
        self,
        audio_path: str,
        language: str,
        log_probs: np.ndarray[Any, Any],
        fields: Mapping[str, Any],
        *,
        produced_on: str,
        kind: str = "numpy",
    ) -> Path:
        """Store one matrix. `kind` names the array type the caller must rebuild (`torch` / `numpy`)."""
        digest, parts = self.key(audio_path, language)
        self.directory.mkdir(parents=True, exist_ok=True)
        meta = {"key": parts, "fields": dict(fields), "kind": kind, "produced_on": produced_on}
        buffer = io.BytesIO()
        np.savez(buffer, log_probs=np.ascontiguousarray(log_probs), meta=np.array(json.dumps(meta)))
        final = self.path_of(digest)
        staging = final.with_suffix(f".{os.getpid()}.tmp")
        staging.write_bytes(buffer.getvalue())
        os.replace(staging, final)
        return final


# ── the transcript disk cache (level run_align, --asr whisper) ────────────────────────────────────────


class TranscriptStore:
    """Whisper transcripts on disk under `$ENCORE_BENCH_ROOT/_transcripts`, one `.json` per key.

    The emission store's key exactly — (resolved audio path, size, mtime_ns, `model` = the whisper
    checkpoint, language, fingerprint of the transcribing code + libraries) — so a re-run is free and a
    changed stem or library misses instead of serving a stale transcript. Stored as plain segments: what
    the `Transcriber` port returns, and what `AlignStepsImpl.transcribe` then presplits.
    """

    def __init__(self, directory: Path, *, model: str, emitter: str) -> None:
        self.directory = directory
        self._keys = EmissionStore(directory, model=model, emitter=emitter)

    def key(self, audio_path: str, language: str) -> tuple[str, dict[str, object]]:
        return self._keys.key(audio_path, language)

    def path_of(self, digest: str) -> Path:
        return self.directory / f"{digest}.json"

    def load_segments(self, audio_path: str, language: str) -> tuple[list[dict[str, Any]], str | None] | None:
        """The stored (segments, HEARD language), or None for a miss.

        THE LANGUAGE IS STORED TOO SINCE W7 (review M8): whisper's own detection is half the port's return
        value now (`ports.Transcribed`), and a cache that served only the segments would hand every replayed
        transcript a `None` language — so a cached `run_align` row would route a non-English song to the
        default bundle where a cold one routed it to its own. An entry written BEFORE the field existed has
        no `language` key and reads as None, which is exactly what it recorded.
        """
        digest, parts = self.key(audio_path, language)
        path = self.path_of(digest)
        if not path.is_file():
            return None
        stored = json.loads(path.read_text(encoding="utf-8"))
        if stored.get("key") != parts:
            return None
        heard = stored.get("language")
        return (
            [dict(segment) for segment in stored["segments"]],
            str(heard) if isinstance(heard, str) and heard else None,
        )

    def save_segments(
        self,
        audio_path: str,
        language: str,
        segments: Sequence[Mapping[str, Any]],
        heard: str | None = None,
    ) -> Path:
        digest, parts = self.key(audio_path, language)
        self.directory.mkdir(parents=True, exist_ok=True)
        final = self.path_of(digest)
        staging = final.with_suffix(f".{os.getpid()}.tmp")
        body: dict[str, Any] = {"key": parts, "segments": [dict(segment) for segment in segments]}
        if heard is not None:
            body["language"] = heard
        staging.write_text(json.dumps(body, ensure_ascii=False), encoding="utf-8")
        os.replace(staging, final)
        return final


class CachedTranscriber:
    """A `Transcriber` port that serves `TranscriptStore` hits and stores every miss.

    `inner` is duck-typed (the shipped `WhisperTranscriber` in the CLI, a fake in tests), which keeps this
    half torch-free. An EMPTY transcript is stored too: "heard nothing" is a result the policy acts on
    (`asr_produced_nothing`), so re-running whisper to rediscover it would only cost time.
    """

    def __init__(self, inner: Any, store: TranscriptStore) -> None:
        self.inner = inner
        self.store = store
        #: disk / computed — how each call was served, for the run's metadata.
        self.served: Counter[str] = Counter()

    def transcribe(self, audio_path: str, *, language: str | None = None) -> ports.Transcribed:
        key_language = language or ""
        stored = self.store.load_segments(audio_path, key_language)
        if stored is not None:
            self.served["disk"] += 1
            return ports.Transcribed(segments=tuple(stored[0]), language=stored[1])
        heard = self.inner.transcribe(audio_path, language=language)
        segments = tuple(dict(s) for s in heard.segments)
        self.served["computed"] += 1
        self.store.save_segments(audio_path, key_language, segments, heard.language)
        return ports.Transcribed(segments=segments, language=heard.language)
