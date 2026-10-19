#!/usr/bin/env python
"""The MULTI-PROVIDER POOL gate (W7, M13 + L5): what the candidate ranking actually CHOOSES, measured.

    cd worker && .venv/bin/python ../docs/benchmarks/forced-alignment/scripts/pool_gate.py \\
        --songs youtube [--out rows.json]
    cd worker && .venv/bin/python ../docs/benchmarks/forced-alignment/scripts/pool_gate.py --from rows.json

`e2e.py --level run_align` serves ONE text per case, so its pool of one can exercise neither the
corroboration-ordered candidate tier nor the LRCLIB retry. This drives the same shipped acquisition, ranking,
ladder and gates with a pool of three to four texts to choose between, and writes its own rows, so nothing
under `results/` moves. The pools, the arms and the synthetic pool's three stated limitations are in README,
"The harness scripts: what each one is for, and the limit it states".
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import dataclasses
import json
import math
import sys
import time
import urllib.error
from collections.abc import Iterator, Mapping, Sequence
from pathlib import Path
from typing import Any, cast

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
try:
    import encore_worker  # noqa: F401 - probe: the worker venv normally has it installed
except ImportError:  # pragma: no cover - only when run with a python that lacks the editable install
    sys.path.insert(0, str(REPO / "worker"))

import e2e  # noqa: E402 - after the path setup above
import e2e_lib as lib  # noqa: E402

from encore_worker.adapters.lrclib import LrclibClient  # noqa: E402
from encore_worker.adapters.ratelimit import RateLimiter  # noqa: E402
from encore_worker.domain.lyrics.policy import corroboration  # noqa: E402
from encore_worker.host.config import Config  # noqa: E402
from encore_worker.steps.align_steps import Adapters, AlignStepsImpl  # noqa: E402
from encore_worker.steps.records import (  # noqa: E402
    TIMING_LINE,
    AudioRef,
    JobRef,
    Segment,
    TextRef,
)
from encore_worker.workflows import align as align_flow  # noqa: E402

#: `workflows.align` as a patchable namespace. The workflow BOUND `policy.corroboration` as its own module
#: attribute, so the `arrival` control takes the reading there — and a module attribute mypy cannot see as
#: exported is reached through this cast rather than through a `type: ignore` on each line.
_ALIGN = cast(Any, align_flow)

# ── the texts a pool serves ───────────────────────────────────────────────────────────────────────────

#: How early an SDH subtitler opens a cue, seconds. Not invented: `domain/lyrics/claimmap.py` records
#: believer's authored SDH captions leading the singing by ~0.5 s, and the YouTube group's per-song truth bias
#: runs -147 to +430 ms for the same reason. `clean_line` strips a `♪`; it cannot un-shift a clock.
SDH_LEAD_SEC = 0.5

#: One word misheard every Nth lettered line — a subtitler typing by ear. Deliberately SPARSE: a quarter of
#: the vocabulary would push the track under `policy.CORROBORATION_SHARE` and the pool would stop being the
#: review's case (an SDH track OF THIS SONG, which therefore agrees with a clean sheet of it).
MISHEARD_EVERY = 7

#: Vowel-for-vowel, so a misheard word is still a word the aligner can target (and still the same length,
#: which keeps `score_words`' positional pairing intact on the Jamendo songs).
_MISHEARD: Mapping[str, str] = {"a": "e", "e": "a", "i": "o", "o": "i", "u": "o", "y": "i"}

#: Whole lines an SDH track carries that are not words of the song. [0] is the shape the corpus's authored
#: tracks open with (believer's first event is `♪ ♪`), which hygiene drops for carrying no word; [1] is what
#: `nonlyric` R4's closed vocabulary deletes; [-1] is the one that SURVIVES, so it is the cue injected.
SOUND_CUES = ("♪ ♪", "[MUSIC PLAYING]", "[CHEERING]")

POOLS = ("sdh", "wrong-track", "allwrong", "clean")

#: M13 has two separable halves, which is why `pre-tie` exists: `arrival` turns BOTH off
#: (every-provider-a-candidate AND the corroboration tie-break), `pre-tie` only the tie-break, so each step
#: along the arms prices one half. README, "The four pools and the four arms".
ARMS = ("ranked", "arrival", "pre-tie", "no-l5")

#: (pool, arm) pairs a bare run measures: the review's case and where the tie-break bites, each against both
#: of its pre-M13 controls; the MUST; L5's absence; and the clean-sheet counterfactual.
DEFAULT_PLAN: tuple[tuple[str, str], ...] = (
    ("clean", "ranked"),
    ("sdh", "ranked"),
    ("sdh", "arrival"),
    ("sdh", "pre-tie"),
    ("sdh", "no-l5"),
    ("wrong-track", "ranked"),
    ("wrong-track", "arrival"),
    ("wrong-track", "pre-tie"),
    ("wrong-track", "no-l5"),
    ("allwrong", "ranked"),
    ("allwrong", "arrival"),
)

#: Labels production builds for the texts this script serves (`align_steps.fetch_captions` /
#: `_provider_label`). Spelled out so a row can be read without re-deriving them, and asserted per run.
AUTHORED, MACHINE, LRCMUX, LRCLIB = "captions:authored", "captions:machine", "lrcmux:KuGou", "lrclib"


@dataclasses.dataclass(frozen=True, slots=True)
class PoolText:
    """One text the pool serves: how it reaches production, and the claim identity metrics pair on.

    `claims` is the e2e corpus claim object — line texts with the truth index each one IS — so a document
    timed from this text scores through `e2e_lib.score_lines` exactly as a single-text case does. `label`
    is what production will build for it, which is how a row names the chosen text.
    """

    label: str
    claims: lib.Claims
    #: One line for the printed table and the row: what this text IS.
    why: str

    @property
    def truth_lines(self) -> int:
        """How many of the song's truth lines this text contains — 0 for another song's words."""
        return len(self.claims.truth_indexes())


def _misheard(word: str) -> str:
    """`word` with its first vowel swapped for another — a subtitler's slip, still a targetable word."""
    for position, letter in enumerate(word):
        swap = _MISHEARD.get(letter.lower())
        if swap is not None:
            return word[:position] + (swap.upper() if letter.isupper() else swap) + word[position + 1 :]
    return word


def sdh_track(claims: lib.Claims, *, lead_sec: float = SDH_LEAD_SEC) -> lib.Claims:
    """`claims` as an SDH subtitler of this video typed them. Pure.

    Three things a real SDH track does, each changing a different thing downstream: it OPENS EVERY CUE
    `lead_sec` EARLY, the damage that survives text hygiene; it MISHEARS one word every `MISHEARD_EVERY`
    worded lines, keeping the word COUNT so positional pairing survives; and it WRITES THE SOUND DOWN, with
    `[CHEERING]` rather than a marker `nonlyric` R4 would delete. What it deliberately does NOT do is ♪-wrap
    or upper-case the lines, the YouTube group's truth text being a caption track already, so re-decorating
    it ARMS `nonlyric` R3. The truth index of every sung line is KEPT, so the documents are comparable."""
    out: list[lib.ClaimLine] = []
    first = next((line.start for line in claims.lines if line.start is not None), 0.0)
    out.append(lib.ClaimLine(SOUND_CUES[0], 0.0, max(first - lead_sec, 0.0), truth=None))
    worded = 0
    for line in claims.lines:
        words = line.text.split()
        if words:
            worded += 1
            if worded % MISHEARD_EVERY == 0:
                longest = max(range(len(words)), key=lambda k: (len(words[k]), -k))
                words = [*words[:longest], _misheard(words[longest]), *words[longest + 1 :]]
        out.append(
            dataclasses.replace(
                line,
                text=" ".join(words) if words else line.text,
                start=None if line.start is None else max(line.start - lead_sec, 0.0),
                end=None if line.end is None else max(line.end - lead_sec, 0.0),
            )
        )
    gap = _longest_gap(out)
    if gap is not None:
        position, start, end = gap
        out.insert(position, lib.ClaimLine(SOUND_CUES[-1], start, end, truth=None))
    return dataclasses.replace(claims, lines=tuple(out))


def _longest_gap(lines: Sequence[lib.ClaimLine]) -> tuple[int, float, float] | None:
    """Where this sheet's longest internal silence is, as (insert position, start, end), or None.

    `e2e_lib._extra_verse`'s own reading of a gap, kept to its `SECTION_GAP_SEC` floor: a break shorter
    than that is a breath, not something a subtitler writes a cue into.
    """
    gaps: list[tuple[float, float, int]] = []
    for position in range(1, len(lines)):
        before, after = lines[position - 1], lines[position]
        if before.end is not None and after.start is not None and after.start - before.end >= _CUE_GAP_SEC:
            gaps.append((before.end, after.start, position))
    if not gaps:
        return None
    start, end, position = max(gaps, key=lambda g: (g[1] - g[0], -g[2]))
    return position, start, end


#: A silence this long between two claimed lines is an instrumental break a subtitler writes a cue into.
#: `e2e_lib.SECTION_GAP_SEC`'s value, for the same reason it has it (that is where a sheet puts a header).
_CUE_GAP_SEC = lib.SECTION_GAP_SEC


def machine_track(claims: lib.Claims) -> lib.Claims:
    """`claims` as YouTube's AUTO track: lower-cased, unpunctuated, no sound cues.

    A measurement of what is audible, so it keeps the WORDS — the one thing a machine track cannot be is the
    wrong song, which is why `policy.Tier.MACHINE` exists and why this text is the third WITNESS that lets a
    clean sheet outrank an authored track agreeing with nothing. ITS CLOCK IS THE CALLER'S, AND MUST NOT BE
    TRUTH'S: `pool_texts` builds it from the `jit` mode's claims, because a machine track is a MEASUREMENT
    with error and a control holding the truth clock is an ORACLE — measured, with the truth clock it beat the
    clean sheet by 7 ±500 lines of 840 (78.70 against 77.91) and failed this gate's own `keeps-pm500`."""
    lines = tuple(
        dataclasses.replace(line, text=" ".join(w.strip(".,!?;:\"'()[]") for w in line.text.lower().split()))
        for line in claims.lines
    )
    return dataclasses.replace(claims, lines=lines)


def quantised(claims: lib.Claims) -> lib.Claims:
    """`claims` with every claimed time rounded to a CENTISECOND — LRC's own resolution.

    So the recorded claims of an `lrclib` text are the ones the real `parse_lrc` will hand the step, rather
    than the float the corpus truth carries. Nothing scored reads a claim's time (`score_lines` reads the
    TRUTH's), so this is fidelity rather than arithmetic.
    """

    def tick(value: float | None) -> float | None:
        return None if value is None else math.floor(value * 100.0 + 0.5) / 100.0

    return dataclasses.replace(
        claims,
        lines=tuple(
            dataclasses.replace(line, start=tick(line.start), end=tick(line.end)) for line in claims.lines
        ),
    )


def lrc_body(claims: lib.Claims) -> str:
    """`claims` as an LRCLIB `syncedLyrics` payload: `[mm:ss.xx] words`, in time order.

    Rendered rather than faked past the parser so the REAL `lrclib.parse_response` -> `parse_lrc` runs,
    review L4's four fixes included — the shape in which an LRC's line ends at the next line's start
    (`sheet_gate.lrc_shaped`), which is how LRCLIB's spans tile a song.
    """
    rows: list[str] = []
    for line in claims.lines:
        if line.start is None:
            continue
        stamp = f"[{int(line.start // 60):02d}:{line.start % 60:05.2f}]"
        rows.append(f"{stamp}{line.text}")
    return "\n".join(rows)


def lrclib_payload(claims: lib.Claims, *, artist: str, track: str, duration_sec: float) -> str:
    """One LRCLIB `/api/get` RESPONSE BODY carrying `claims` — what the opener below serves.

    The whole payload rather than the lyrics alone, because `parse_response` is what reads it: it prefers
    `syncedLyrics`, falls back to `plainLyrics`, and treats `instrumental: true` as a positive "no words".
    Both lyric fields are filled from the same claims, so a run cannot accidentally measure the plain
    fallback while reporting a synced sheet.
    """
    return json.dumps(
        {
            "id": 1,
            "artistName": artist,
            "trackName": track,
            "duration": duration_sec,
            "instrumental": False,
            "plainLyrics": "\n".join(line.text for line in claims.lines),
            "syncedLyrics": lrc_body(claims),
        }
    )


def pool_texts(
    song: lib.Song,
    *,
    pool: str,
    corpus: Sequence[lib.Song],
    duration_sec: float,
    seed: int = 0,
) -> list[PoolText]:
    """The texts `pool` serves for `song`, in the order production ACQUIRES them.

    Arrival order is `_acquire_texts`' own: the authored caption track, then every provider sheet, then the
    machine track. The RANKING is what may reorder them, and that is the thing under measurement — so this
    returns them unranked and never sorts.
    """

    def claims_of(mode: str, variant: int = 0) -> lib.Claims:
        return lib.build_claims(
            song, mode, corpus=corpus, duration_sec=duration_sec, variant=variant, seed=seed
        )

    clean = quantised(claims_of("truth"))
    sheet = PoolText(LRCLIB, clean, "the clean sheet, behind the L5 duration retry")
    if pool == "clean":
        return [sheet]
    wrong_sheet = PoolText(
        LRCMUX, claims_of("wrongtext", variant=0), "another song's sheet, on that song's clock"
    )
    #: On the `jit` clock, never truth's: see `machine_track` for the measurement that says why.
    machine = PoolText(
        MACHINE, machine_track(claims_of("jit")), "YouTube's auto track of this audio, timed by machine"
    )
    if pool == "sdh":
        return [
            PoolText(AUTHORED, sdh_track(clean), "this song's words as an SDH subtitler typed them"),
            wrong_sheet,
            sheet,
            machine,
        ]
    if pool == "wrong-track":
        return [
            PoolText(
                AUTHORED,
                sdh_track(quantised(claims_of("wrongtext+ownclock", variant=1))),
                "another song's words on THIS video's clock, SDH-styled",
            ),
            wrong_sheet,
            sheet,
            machine,
        ]
    if pool == "allwrong":
        return [
            PoolText(
                AUTHORED,
                sdh_track(quantised(claims_of("wrongtext+ownclock", variant=1))),
                "another song's words on THIS video's clock, SDH-styled",
            ),
            wrong_sheet,
            PoolText(
                LRCLIB, quantised(claims_of("wrongtext", variant=2)), "a third song's sheet, duration-retried"
            ),
        ]
    raise ValueError(f"unknown pool {pool!r}; known: {', '.join(POOLS)}")


# ── the ports: production's own acquisition over the pool ─────────────────────────────────────────────


class PoolCaptions:
    """`CaptionSource` over the pool's caption tracks — authored AND machine, as yt-dlp returns them.

    `e2e.ClaimCaptions` answers the machine fetch with nothing, which is the whole reason a bench pool had
    at most one caption witness. Cleaned by `clean_segments` here for the same reason it is there: every
    text adapter cleans what it parses, so text hygiene must be on the path the scores are read from.
    """

    def __init__(self, *, authored: Sequence[Segment] = (), machine: Sequence[Segment] = ()) -> None:
        from encore_worker.domain.lyrics.clean import clean_segments  # noqa: PLC0415

        self._authored = clean_segments(authored)
        self._machine = clean_segments(machine)

    def fetch(self, source_uri: str, out_dir: str, *, automatic: bool) -> Sequence[Segment]:
        return self._machine if automatic else self._authored


class PoolProvider:
    """`LyricsProvider` serving one prepared sheet under a chosen name and upstream.

    `last_source` is read by `align_text._provider_label`, so a multiplexer's text reaches the trail as
    `lrcmux:KuGou` — the label `policy.witness_of` folds into the single `providers` witness, and the one a
    row names when a wrong sheet publishes.
    """

    def __init__(self, cues: Sequence[Segment], *, name: str, upstream: str | None = None) -> None:
        from encore_worker.domain.lyrics.clean import clean_segments  # noqa: PLC0415

        self.name = name
        self.last_source = upstream
        self._cues = clean_segments(cues)

    def fetch(self, *, artist: str, track: str, duration_sec: float | None) -> Sequence[Segment]:
        return self._cues


class OneSheetOpener:
    """LRCLIB's HTTP seam for a song whose UPLOAD is longer than the recording (review L5).

    The duration-QUALIFIED lookup 404s — the music video with an intro that misses LRCLIB's ±2 s match —
    and the unqualified retry answers with the sheet. So the clean sheet is in the pool ONLY because of
    L5's retry, which is what makes L5 visible to a bench at all; `retry=False` 404s both and is the
    `no-l5` arm. Injected into the REAL `LrclibClient`, so `build_url`, the status ladder, `parse_response`
    and `parse_lrc` all run (`tests/test_lrclib.py` uses the same seam for the same reason).
    """

    def __init__(self, body: str, *, retry: bool = True) -> None:
        self._body = body
        self._retry = retry
        #: Every URL asked for, in order: the row records them, so "two lookups, the second unqualified" is
        #: a measurement rather than an assumption.
        self.opened: list[str] = []

    def open(self, request: object, timeout: float | None = None) -> _Answer:
        url = getattr(request, "full_url", str(request))
        self.opened.append(url)
        if "duration=" in url or not self._retry:
            raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)  # type: ignore[arg-type]
        return _Answer(self._body)


class _Answer:
    """What `urlopen` returns, as much of it as `LrclibClient._fetch` touches."""

    def __init__(self, body: str) -> None:
        self._body = body.encode()

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> _Answer:
        return self

    def __exit__(self, *exc: object) -> None:
        return None


def lrclib_over(opener: OneSheetOpener) -> LrclibClient:
    """The shipped client over `opener`, paced by ARITHMETIC: the production gate sleeps 1 s a request."""
    clock = [0.0]
    # The opener is the client's injected seam (`tests/test_lrclib.py` fakes it the same way); it is a
    # duck, not an `OpenerDirector`, because `_fetch` calls nothing else on it.
    return LrclibClient(
        opener=opener,  # type: ignore[arg-type]
        gate=RateLimiter(now=lambda: clock[0], sleep=lambda s: clock.__setitem__(0, clock[0] + s)),
    )


class PoolSteps(e2e.RecordingSteps):
    """`RecordingSteps` that also records THE POOL the workflow acquired, in arrival order.

    Needed because the ladder stops at the first accept: the attempts say which texts were TRIED, and the
    question "was the clean sheet in the pool at all" (the L5 verdict) is about the ones that were not.
    Recorded off the step return values, so it is the list `workflows.align._pool_of` was handed.
    """

    #: True in the `arrival` arm: see `FirstHitSteps`.
    first_hit_only = False

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.acquired: list[TextRef] = []

    async def fetch_captions(self, job: JobRef, *, automatic: bool) -> TextRef | None:
        text = await super().fetch_captions(job, automatic=automatic)
        if text is not None:
            self.acquired.append(text)
        return text

    async def fetch_provider_lyrics(self, job: JobRef, audio: AudioRef) -> list[TextRef]:
        found = await super().fetch_provider_lyrics(job, audio)
        if self.first_hit_only:
            found = found[:1]
        self.acquired.extend(found)
        return found

    async def transcribe(self, job: JobRef, audio: AudioRef, *, on_vocals: bool) -> TextRef | None:
        heard = await super().transcribe(job, audio, on_vocals=on_vocals)
        if heard is not None:
            self.acquired.append(heard)
        return heard


class FirstHitSteps(PoolSteps):
    """`PoolSteps` with `fetch_provider_lyrics` truncated to the FIRST provider that answered.

    PRE-M13 ACQUISITION, as the step's own docstring describes it: "It returned the FIRST hit, and lrcmux is
    first in the chain, so LRCLIB was consulted only when lrcmux was UNREACHABLE". Done here rather than by
    editing the step so the `ranked` arm runs the shipped code untouched and the control is one named,
    reviewable override. The truncation happens BEFORE the pool is recorded, because pre-M13 the second
    provider's sheet was not in the pool at all.
    """

    first_hit_only = True


@contextlib.contextmanager
def arrival_order() -> Iterator[None]:
    """`workflows.align`'s corroboration reading neutralised: every candidate reads UNCORROBORATED.

    Which makes `policy.order_pool` fall back to arrival order — the pool walk exactly as it was before
    M13, and the other half of the `arrival` control. A module-attribute wrap, like `e2e.capture_lifts`:
    the workflow imported the name, so this is where the reading is taken.
    """
    original = _ALIGN.corroboration

    def none_agree(texts: Sequence[Sequence[str]], labels: Sequence[str]) -> list[bool]:
        return [False] * len(texts)

    _ALIGN.corroboration = none_agree
    try:
        yield
    finally:
        _ALIGN.corroboration = original


# ── one job ───────────────────────────────────────────────────────────────────────────────────────────


class PoolDriver(e2e.RunAlignDriver):
    """One `run_align` job per (song, pool, arm), over a pool of three to four texts.

    `e2e.RunAlignDriver`'s media tree, stem placement, duration and emissions cache, with the ports and the
    scoring replaced: the captions port serves BOTH tracks, two providers serve sheets (one of them the real
    `LrclibClient`), and the published document is scored against the claims of WHICHEVER pool text
    published — which is the measurement, and the one thing a single-text harness cannot do.
    """

    level = "pool"

    def run_pool(self, song: lib.Song, pool: str, arm: str) -> dict[str, Any]:
        """Run the job and score it. One broken case must not lose the run, so this never raises."""
        if arm not in ARMS:
            raise ValueError(f"unknown arm {arm!r}; known: {', '.join(ARMS)}")
        case = e2e.Case(song, f"{pool}-{arm}", 0)
        texts = pool_texts(
            song, pool=pool, corpus=self.corpus, duration_sec=self.duration_of(song), seed=self.seed
        )
        started = time.perf_counter()
        extra: dict[str, object] = {
            "pool": pool,
            "arm": arm,
            "sync_mode": self.sync_mode,
            "pool_texts": [{"label": t.label, "why": t.why, "truth_lines": t.truth_lines} for t in texts],
            #: THE POOL'S OWN DENOMINATOR: the most truth lines any text in it carries. `row_of`'s `in_text`
            #: is the PUBLISHED text's, which is 0 when a wrong text published, and pooling over that would
            #: make a job that published another song's words read as one with nothing to find.
            "pool_in_text": max((t.truth_lines for t in texts), default=0),
            "wrong_published": False,
            "verdict": "?",
            "why": "",
            "lift": None,
        }
        published_claims = texts[0].claims
        outcome: str = lib.ERROR
        lines: list[lib.DocLine] = []
        faulted = len(e2e.emission_faults(self.aligner))
        try:
            outcome, lines, published_claims = self._run(case, texts, arm, extra)
        except Exception as exc:  # noqa: BLE001 - one broken case must not lose the run
            outcome, lines = lib.ERROR, []
            extra["exception"] = f"{type(exc).__name__}: {exc}"
        faults = e2e.emission_faults(self.aligner)[faulted:]
        if faults and outcome != lib.ERROR:
            outcome, lines = lib.ERROR, []
            extra["exception"] = f"emissions: {faults[0]}"
        extra["seconds"] = round(time.perf_counter() - started, 2)
        return lib.row_of(
            song=song, mode=pool, variant=0, claims=published_claims, outcome=outcome, doc=lines, extra=extra
        )

    def _run(
        self, case: e2e.Case, texts: Sequence[PoolText], arm: str, extra: dict[str, object]
    ) -> tuple[str, list[lib.DocLine], lib.Claims]:
        """Drive the real workflow over the pool, then score what it published."""
        media_dir = self._media_dir(case)
        trail = e2e.Trail()
        served = {text.label: e2e.served_claims(text.claims) for text in texts}
        by_label = {text.label: text for text in texts}
        sheets = [t for t in texts if t.label in (LRCMUX, LRCLIB)]
        opener = OneSheetOpener(
            lrclib_payload(
                next((t.claims for t in sheets if t.label == LRCLIB), texts[0].claims),
                artist=case.song.slug,
                track=case.song.slug,
                duration_sec=self.duration_of(case.song),
            ),
            retry=arm != "no-l5",
        )
        providers: list[Any] = []
        for text in sheets:
            if text.label == LRCLIB:
                providers.append(lrclib_over(opener))
            else:
                name, _, upstream = text.label.partition(":")
                providers.append(PoolProvider(served[text.label][0], name=name, upstream=upstream or None))
        impl = AlignStepsImpl(
            config=self.config,
            adapters=Adapters(
                captions=PoolCaptions(
                    authored=served[AUTHORED][0] if AUTHORED in served else (),
                    machine=served[MACHINE][0] if MACHINE in served else (),
                ),
                providers=tuple(providers),
                probe=e2e.FixedProbe(self.duration_of(case.song)),
                transcriber=self.transcriber,
                aligner=self.aligner,
            ),
            reporter=trail,
        )
        job = JobRef(
            job_id=case.song.slug,
            media_id=case.song.slug,
            media_dir=str(media_dir),
            source_uri=str(Path(case.song.mix).resolve()),
            params={
                "fetcher": "local",
                "artist": case.song.slug,
                "track": case.song.slug,
                "language": self.language,
                **({"syncMode": self.sync_mode} if self.sync_mode != e2e.SYNC_FORCED else {}),
            },
        )
        with e2e.capture_generated() as captured, e2e.capture_lifts() as lifts:
            steps_type = FirstHitSteps if arm == "arrival" else PoolSteps
            steps = steps_type(impl, trail=trail, captured=captured, lifts=lifts)
            with arrival_order() if arm in ("arrival", "pre-tie") else contextlib.nullcontext():
                result = asyncio.run(align_flow.run_align(job, steps))
        extra["lrclib_lookups"] = list(opener.opened)
        return self._score(case, steps, result, by_label, served, extra)

    def _score(
        self,
        case: e2e.Case,
        steps: PoolSteps,
        result: Any,
        by_label: Mapping[str, PoolText],
        served: Mapping[str, tuple[tuple[Segment, ...], tuple[tuple[int, str], ...]]],
        extra: dict[str, object],
    ) -> tuple[str, list[lib.DocLine], lib.Claims]:
        """Every attempt scored against ITS OWN text's truth, and the published one reported as the row.

        A text the step did not acquire (the `no-l5` arm's sheet) simply never appears among the attempts;
        a label no pool text explains is an ERROR, because then the row cannot say what was timed.
        """
        attempts = steps.attempts
        #: The order the ladder TRIED the pool in — one entry per label, first attempt first. Deduplicated
        #: by LABEL because a `TextRef` holds its segments as dicts and so cannot be a set member.
        order: list[str] = []
        for attempt in attempts:
            if attempt.request.text.label not in order:
                order.append(attempt.request.text.label)
        records: list[dict[str, object]] = []
        for number, attempt in enumerate(attempts, 1):
            label = attempt.request.text.label
            record: dict[str, object] = {
                "n": number,
                "text": label,
                "tier": attempt.request.text.tier.value,
                "knobs": sorted(k.value for k in attempt.request.knobs),
                "result": (
                    attempt.doc.timing
                    if attempt.doc is not None
                    else ("refused" if attempt.refused is not None else "none")
                ),
                "refused": attempt.refused,
                "lift": attempt.lifts[-1] if attempt.lifts else None,
                "seconds": attempt.seconds,
            }
            verdict, why = e2e.global_verdict(attempt.states)
            record.update(verdict=verdict, why=why)
            if attempt.body is not None and label in by_label:
                claims = by_label[label].claims
                scored, identity = e2e.doc_lines(
                    json.loads(attempt.body), attempt.generated, claims, served[label][1]
                )
                counts = lib.count_lines(lib.score_lines(case.song, claims, scored)[0])
                record.update(
                    scored=counts["scored"],
                    gross=counts["gross"],
                    w500=counts["w500"],
                    identity=identity,
                    truth_lines=len(claims.truth_indexes()),
                )
            records.append(record)
        published = result.published
        chosen = e2e.published_attempt(attempts, published)
        extra.update(
            acquired=[text.label for text in steps.acquired],
            pool_order=order,
            attempts=records,
            terminal=(
                "published"
                if published is not None
                else ("abandoned" if result.why.startswith("abandoned") else "no-lyrics")
            ),
            outcome_why=result.why,
            published_label=None if published is None else published.label,
            published_attempt=None if chosen is None else chosen + 1,
            trail=[dict(e) for e in result.trail],
            transcriptions=[{"on_vocals": v, "heard": h} for v, h in steps.transcriptions],
            agrees=self._agreement(steps),
        )
        if published is None or chosen is None:
            return lib.REFUSED, [], _any_claims(by_label)
        label = published.label
        if label not in by_label:
            extra["exception"] = f"the job published {label!r}, which is no pool text: nothing to score it on"
            return lib.ERROR, [], _any_claims(by_label)
        claims = by_label[label].claims
        attempt = attempts[chosen]
        body = (Path(attempt.request.job.media_dir) / published.ref).read_bytes()
        if body != attempt.body:
            extra["exception"] = (
                "the published ref holds other bytes than the published attempt's: the TV would show "
                "another document than the one the job published"
            )
            return lib.ERROR, [], claims
        if [str(s.get("text") or "") for s in attempt.request.text.segments] != [
            text for _index, text in served[label][1]
        ]:
            extra["exception"] = (
                f"the request for {label!r} is not the text this pool served, so its lines cannot be paired "
                "to truth by identity"
            )
            return lib.ERROR, [], claims
        lines, identity = e2e.doc_lines(json.loads(body), attempt.generated, claims, served[label][1])
        extra.update(
            identity=identity,
            confidence=published.confidence,
            coverage=round(published.report.coverage, 4),
            doc_sha256=lib.doc_digest(body),
            onsets_sha256=lib.onset_digest(lines),
            wrong_published=by_label[label].truth_lines == 0,
        )
        unpaired = e2e.unpaired_word_doc(identity, published.timing)
        if unpaired is not None:
            extra["exception"] = unpaired
            return lib.ERROR, [], claims
        verdict, why = e2e.global_verdict(attempt.states)
        extra.update(verdict=verdict, why=why, lift=records[chosen]["lift"])
        return (lib.LINE_SYNC if published.timing == TIMING_LINE else lib.PUBLISHED), lines, claims

    @staticmethod
    def _agreement(steps: PoolSteps) -> dict[str, bool]:
        """`policy.corroboration`'s SHIPPED reading of the pool the steps acquired, per label.

        Recomputed from the acquired texts rather than read out of the workflow, which has no seam for it —
        identical by construction (`corroboration` is pure and `_pool_of` calls it with these exact
        arguments). Recorded in EVERY arm, including `arrival`, where the arm's own reading is all False:
        the row then says both what the control used and what the shipped tree would have read.
        """
        texts = steps.acquired
        if not texts:
            return {}
        agrees = corroboration(
            [[str(segment.get("text") or "") for segment in text.segments] for text in texts],
            [text.label for text in texts],
        )
        return {text.label: backed for text, backed in zip(texts, agrees, strict=True)}


def _any_claims(by_label: Mapping[str, PoolText]) -> lib.Claims:
    """A claim object for a row that published nothing: the CLEAN sheet's when the pool has one.

    `row_of` keeps the text-side denominators of a refusal (`in_text`, the words the text asked for), and
    for a pool the honest denominator is the sheet that CONTAINS the song — otherwise a pool that refuses
    everything would read as a pool with nothing to find.
    """
    for label in (LRCLIB, AUTHORED, LRCMUX, MACHINE):
        text = by_label.get(label)
        if text is not None and text.truth_lines:
            return text.claims
    return next(iter(by_label.values())).claims


# ── the summary ───────────────────────────────────────────────────────────────────────────────────────


def key_of(pool: str, arm: str, sync_mode: str | None) -> str:
    """The name one (pool, arm, sync mode) cell is tallied and looked up under.

    ONE FUNCTION BECAUSE TWO SPELLINGS COST A WHOLE RUN'S GATES: `tally` keyed `pool/arm` plus a `/lines`
    suffix while `verdicts` looked up a bare `pool/arm`, so under `--sync-mode lines` every per-pool MUST
    found `None` and `continue`d — `results/w7-pool-lines.json` records 2 verdicts against the forced run's
    13, both passing, and the script exited 0. The suffix itself is right (a `lines` document carries LINE
    timings only); what was wrong was spelling the rule twice. `verdicts` now FAILs on a missing reading."""
    return f"{pool}/{arm}" + ("/lines" if sync_mode == "lines" else "")


def tally(rows: Sequence[Mapping[str, Any]]) -> dict[str, dict[str, Any]]:
    """Per (pool, arm, sync mode): what published, how it scored, and whether a wrong text ever did."""
    out: dict[str, dict[str, Any]] = {}
    for row in rows:
        key = key_of(str(row["pool"]), str(row["arm"]), row.get("sync_mode"))
        entry = out.setdefault(
            key,
            {
                "songs": 0,
                "chosen": {},
                "published": 0,
                "no_lyrics": 0,
                "errors": 0,
                "scored": 0,
                "gross": 0,
                "w500": 0,
                "in_text": 0,
                "pool_in_text": 0,
                "wrong_published": 0,
                #: `time_text` calls, and how many of them a gate REFUSED. The ranking's other price: a text
                #: tried before a better one costs a whole attempt — emission pass, repairs and gates — even
                #: when the document finally published is the same one.
                "attempts": 0,
                "refused_attempts": 0,
            },
        )
        entry["songs"] += 1
        entry["attempts"] += len(row.get("attempts") or [])
        entry["refused_attempts"] += sum(1 for a in row.get("attempts") or [] if a.get("result") == "refused")
        label = row.get("published_label") or row["terminal"] if row["outcome"] != lib.ERROR else "ERROR"
        entry["chosen"][label] = entry["chosen"].get(label, 0) + 1
        if row["outcome"] == lib.ERROR:
            entry["errors"] += 1
            continue
        entry["published"] += 1 if row["outcome"] in (lib.PUBLISHED, lib.LINE_SYNC) else 0
        entry["no_lyrics"] += 1 if row["terminal"] != "published" else 0
        for field in ("scored", "gross", "w500", "in_text", "pool_in_text"):
            entry[field] += int(row.get(field) or 0)
        entry["wrong_published"] += 1 if row.get("wrong_published") else 0
    for entry in out.values():
        entry["w500_pct"] = lib.pct(entry["w500"], entry["scored"])
        # Over THE POOL's lines, never the published text's: see `pool_in_text`.
        entry["w500_pct_text"] = lib.pct(entry["w500"], entry["pool_in_text"])
    return out


def common_lines(
    first: Mapping[str, Any], second: Mapping[str, Any]
) -> tuple[dict[str, int], dict[str, int]]:
    """Each row's counts over the truth lines BOTH of them scored.

    Two texts of one song do not publish the same line set: hygiene drops a different number of lines from a
    caption track than from a sheet, the never-sung rule drops acoustically absent ones, and a wrong text
    scores none at all. Comparing each row's own `gross`/`w500` then prices a changed DENOMINATOR as changed
    timing — "a smaller denominator, not better timing". On the common lines the two documents answer the
    same question."""

    def errors_of(row: Mapping[str, Any]) -> dict[int, float]:
        return {int(e[0]): float(e[1]) for e in row.get("line_errors") or []}

    left, right = errors_of(first), errors_of(second)
    shared = sorted(set(left) & set(right))
    return (
        {
            "scored": len(shared),
            "gross": sum(1 for i in shared if abs(left[i]) > lib.GROSS_SEC),
            "w500": sum(1 for i in shared if abs(left[i]) <= lib.LINE_TOLERANCES_SEC[0]),
        },
        {
            "scored": len(shared),
            "gross": sum(1 for i in shared if abs(right[i]) > lib.GROSS_SEC),
            "w500": sum(1 for i in shared if abs(right[i]) <= lib.LINE_TOLERANCES_SEC[0]),
        },
    )


def pair_diff(
    rows: Sequence[Mapping[str, Any]],
    left: tuple[str, str],
    right: tuple[str, str],
    *,
    moved_only: bool = True,
) -> dict[str, Any]:
    """Two (pool, arm) runs compared song by song: whose text differs, and by how much against truth.

    The answer M13 is owed — how many songs' CHOSEN text differs from first-accept-wins, and whether the one
    the ranking chose is better or worse — priced BOTH ways: on each row's own lines and on the lines the two
    rows SHARE (`common_lines`), because a pool's texts do not publish the same line set. The pooled deltas
    are the COMMON ones, `left` minus `right`. `moved_only` is for the ARM comparison, where a song whose
    chosen text did not move produced a byte-identical document; off for a CROSS-POOL comparison."""
    shown = "/".join(left)
    other = "/".join(right)
    mine = {r["song"]: r for r in rows if (r["pool"], r["arm"]) == left}
    theirs = {r["song"]: r for r in rows if (r["pool"], r["arm"]) == right}
    moved: list[dict[str, Any]] = []
    for slug in sorted(set(mine) & set(theirs)):
        a, b = mine[slug], theirs[slug]
        if moved_only and a.get("published_label") == b.get("published_label"):
            continue
        first, second = common_lines(a, b)
        moved.append(
            {
                "song": slug,
                shown: a.get("published_label") or a["terminal"],
                other: b.get("published_label") or b["terminal"],
                "gross": [a.get("gross"), b.get("gross")],
                "w500": [a.get("w500"), b.get("w500")],
                "scored": [a.get("scored"), b.get("scored")],
                "common": [first, second],
                "wrong": [bool(a.get("wrong_published")), bool(b.get("wrong_published"))],
            }
        )
    return {
        "left": shown,
        "right": other,
        "songs": len(set(mine) & set(theirs)),
        "moved": moved,
        "gross_delta": sum(m["common"][0]["gross"] - m["common"][1]["gross"] for m in moved),
        "w500_delta": sum(m["common"][0]["w500"] - m["common"][1]["w500"] for m in moved),
        "common_scored": sum(m["common"][0]["scored"] for m in moved),
    }


def chosen_diff(rows: Sequence[Mapping[str, Any]], pool: str, *, against: str = "arrival") -> dict[str, Any]:
    """`pair_diff` for one pool's shipped arm against its pre-M13 control."""
    return pair_diff(rows, (pool, "ranked"), (pool, against))


#: The MUSTs, each a (name, predicate) over the rows. A failure exits 3, as `e2e.py --gates` does.
def verdicts(rows: Sequence[Mapping[str, Any]]) -> list[tuple[str, bool, str]]:
    """The gate's own reject-ifs, read off the rows. `(name, passed, what was measured)`."""
    out: list[tuple[str, bool, str]] = []
    wrong = [r for r in rows if r.get("wrong_published")]
    out.append(
        (
            "no-wrong-text-publishes",
            not wrong,
            f"{len(wrong)} of {len(rows)} jobs published a text with no truth line"
            + ("".join(f"\n      {r['song']} {r['pool']}/{r['arm']}: {r['published_label']}" for r in wrong)),
        )
    )
    errors = [r for r in rows if r["outcome"] == lib.ERROR]
    said = "".join(f"\n      {r['song']} {r['pool']}/{r['arm']}: {r.get('exception')}" for r in errors[:6])
    out.append(("no-error-rows", not errors, f"{len(errors)} of {len(rows)} jobs could not be read{said}"))
    arms = tally(rows)
    #: EVERY SYNC MODE THE ROWS HOLD, read off the rows rather than assumed `forced`. A run is one mode today,
    #: so this is normally one value; it is a loop so that a merged rows file gates each population against
    #: its own control instead of silently gating neither, with the mode in the gate NAME where not default.
    modes = sorted({str(r.get("sync_mode") or e2e.SYNC_FORCED) for r in rows})
    present = {(str(r["pool"]), str(r["arm"]), str(r.get("sync_mode") or e2e.SYNC_FORCED)) for r in rows}
    unread: list[str] = []
    for pool in sorted({str(r["pool"]) for r in rows}):
        for mode in modes:
            suffix = "" if mode == e2e.SYNC_FORCED else f"-{mode}"
            for against in ("arrival", "pre-tie"):
                ranked = arms.get(key_of(pool, "ranked", mode))
                control = arms.get(key_of(pool, against, mode))
                if ranked is None or control is None:
                    # A PAIR THE PLAN CARRIES BUT THE ROWS DO NOT is a legitimate absence (the `lines` plan
                    # runs no `pre-tie` arm); a pair whose rows ARE here and whose gate still found nothing is
                    # the defect. Both are reported by `every-planned-comparison-was-read` below, which can
                    # tell them apart: it only complains where the rows exist.
                    unread += [
                        key_of(pool, arm, mode)
                        for arm, entry in (("ranked", ranked), (against, control))
                        if entry is None and (pool, arm, mode) in present
                    ]
                    continue
                out.append(
                    (
                        f"{pool}-ranking-adds-no-gross-line-vs-{against}{suffix}",
                        ranked["gross"] <= control["gross"],
                        f"gross ranked {ranked['gross']} against {against} {control['gross']}",
                    )
                )
                a, b = ranked["w500_pct_text"], control["w500_pct_text"]
                out.append(
                    (
                        f"{pool}-ranking-keeps-pm500-vs-{against}{suffix}",
                        a is None or b is None or a >= b - 0.5,
                        f"±500 over the pool ranked {a} against {against} {b} (allowance 0.5 pt)",
                    )
                )
    out.append(
        (
            "every-planned-comparison-was-read",
            not unread,
            (
                f"{len(unread)} (pool, arm) cell(s) have rows but no gate read them"
                + "".join(f"\n      {key}" for key in sorted(set(unread)))
            )
            if unread
            else f"every pair the rows carry was gated, in {', '.join(modes)}",
        )
    )
    sheets = [r for r in rows if r["arm"] == "no-l5" and r["pool"] != "clean"]
    if sheets:
        gone = sum(1 for r in sheets if LRCLIB not in (r.get("acquired") or []))
        out.append(
            (
                "l5-is-why-the-clean-sheet-is-in-the-pool",
                gone == len(sheets),
                f"the clean sheet is absent from {gone} of {len(sheets)} pools without the retry",
            )
        )
    return out


def format_tally(summary: Mapping[str, Mapping[str, Any]]) -> list[str]:
    head = (
        f"{'pool/arm':24} {'songs':>5} {'pub':>4} {'none':>5} {'err':>4} {'att':>4} {'ref':>4} "
        f"{'scored':>7} {'gross':>6} {'±500%':>7}  chosen"
    )
    rows = [head, "-" * len(head)]
    for key, entry in summary.items():
        chosen = ", ".join(f"{label}×{count}" for label, count in sorted(entry["chosen"].items()))
        rows.append(
            f"{key:24} {entry['songs']:>5} {entry['published']:>4} {entry['no_lyrics']:>5} "
            f"{entry['errors']:>4} {entry['attempts']:>4} {entry['refused_attempts']:>4} "
            f"{entry['scored']:>7} {entry['gross']:>6} "
            f"{'-' if entry['w500_pct'] is None else f'{entry["w500_pct"]:.2f}':>7}  {chosen}"
        )
    return rows


def format_diff(diff: Mapping[str, Any]) -> list[str]:
    left, right = str(diff["left"]), str(diff["right"])
    rows = [
        f"{left} vs {right} — {len(diff['moved'])} of {diff['songs']} songs differ; on their "
        f"{diff['common_scored']} shared lines gross {diff['gross_delta']:+d}, ±500 {diff['w500_delta']:+d}"
    ]
    for moved in diff["moved"]:
        mine, theirs = moved["common"]
        rows.append(
            f"    {moved['song']:20} {moved[left]:20} <- {moved[right]:20} "
            f"shared {mine['scored']:>3}: gross {mine['gross']}/{theirs['gross']} "
            f"±500 {mine['w500']}/{theirs['w500']}  "
            f"own scored {moved['scored'][0]}/{moved['scored'][1]}"
            + ("  WRONG TEXT published by the control" if moved["wrong"][1] else "")
        )
    return rows


def diffs_of(rows: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Every comparison the report reads: each pool's shipped arm against its pre-M13 control and against
    `no-l5`, plus every pool's chosen document against the CLEAN SHEET's on the same song.

    The last one is the review's own question — "is the chosen text better or worse against truth" — and it
    needs a pool whose text is known-clean to compare with, which is what the `clean` pool is for.
    """
    pools = sorted({str(r["pool"]) for r in rows} - {"clean"})
    present = {(str(r["pool"]), str(r["arm"])) for r in rows}
    out: list[dict[str, Any]] = []
    for pool in pools:
        for against in ("arrival", "pre-tie", "no-l5"):
            if (pool, "ranked") in present and (pool, against) in present:
                out.append(pair_diff(rows, (pool, "ranked"), (pool, against)))
    for pool in pools:
        if (pool, "ranked") in present and ("clean", "ranked") in present:
            out.append(pair_diff(rows, (pool, "ranked"), ("clean", "ranked"), moved_only=False))
    return out


def report(rows: Sequence[Mapping[str, Any]]) -> tuple[list[str], bool]:
    """The printed report and whether every MUST passed."""
    out = format_tally(tally(rows))
    for diff in diffs_of(rows):
        out.append("")
        out.extend(format_diff(diff))
    out.append("")
    passed = True
    for name, ok, detail in verdicts(rows):
        passed = passed and ok
        out.append(f"  [{'PASS' if ok else 'FAIL'}] {name}: {detail}")
    return out, passed


# ── the run ───────────────────────────────────────────────────────────────────────────────────────────


def document(meta: Mapping[str, Any], rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """The written result: the run's settings, every summary clause, and the rows they are computed from."""
    return {
        "meta": dict(meta),
        "summary": tally(rows),
        "diffs": diffs_of(rows),
        "verdicts": [{"name": n, "passed": ok, "detail": d} for n, ok, d in verdicts(rows)],
        "rows": list(rows),
    }


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    ap.add_argument("--songs", default="youtube", help="slug list, or a group (youtube/jamendo/all)")
    ap.add_argument("--pools", default=None, help=f"comma-separated, of {', '.join(POOLS)}")
    ap.add_argument("--arms", default=None, help=f"comma-separated, of {', '.join(ARMS)}")
    ap.add_argument("--sync-mode", choices=e2e.SYNC_MODES, default=e2e.SYNC_FORCED)
    ap.add_argument("--device", default=None, help="cpu/mps/cuda (default: this box's best)")
    ap.add_argument("--model", default=None, help="align bundle (default: the shipped one for this device)")
    ap.add_argument("--language", default="en")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out", default=None, help="write every row here (JSON)")
    ap.add_argument("--media", default=None, help="where the jobs' media trees go (default: a temp tree)")
    ap.add_argument("--from", dest="source", default=None, help="re-read rows written earlier; runs nothing")
    ap.add_argument(
        "--emissions-cache", choices=("use", "off"), default="use", help="the shared disk matrix cache"
    )
    args = ap.parse_args(argv)

    if args.source is not None:
        stored = json.loads(Path(args.source).read_text(encoding="utf-8"))
        recorded: list[dict[str, Any]] = stored["rows"]
        said, passed = report(recorded)
        print("\n".join(said))
        if args.out:
            # RE-SUMMARISED, not re-run: every number in this file is a function of the rows, so a summary
            # clause added after a run is recomputable from the rows it was measured on (no model pass).
            Path(args.out).write_text(json.dumps(document(stored["meta"], recorded)), encoding="utf-8")
        return 0 if passed else 3

    try:
        config = Config.from_env()
    except Exception as exc:  # noqa: BLE001 - a bad env must say so, not traceback
        print(f"configuration: {exc}", file=sys.stderr)
        return 2
    plan = [
        (pool, arm)
        for pool, arm in DEFAULT_PLAN
        if (args.pools is None or pool in args.pools.split(","))
        and (args.arms is None or arm in args.arms.split(","))
    ]
    if args.pools is not None and args.arms is not None:
        # Both named: the CROSS PRODUCT, so a pair the default plan does not carry is still runnable.
        plan = [(p, a) for p in args.pools.split(",") for a in args.arms.split(",")]
    unknown = [f"pool {p!r}" for p, _a in plan if p not in POOLS] + [
        f"arm {a!r}" for _p, a in plan if a not in ARMS
    ]
    if unknown:
        print(f"unknown {', '.join(sorted(set(unknown)))}", file=sys.stderr)
        return 2
    if not plan:
        print("no (pool, arm) pair selected", file=sys.stderr)
        return 2

    root = lib.bench_root()
    corpus = lib.discover(root)
    songs = lib.select(corpus, args.songs)
    missing = [f"{s.slug}: {p}" for s in songs for p in s.missing_files()]
    if missing:
        print("missing audio:\n  " + "\n  ".join(missing), file=sys.stderr)
        return 2
    device = e2e.resolve_device(args.device)
    named, refused = e2e.resolve_bundle(args.model, config, args.language)
    if refused is not None:
        print(refused, file=sys.stderr)
        return 2
    label = named or e2e.default_model(args.language, device)
    store = (
        None
        if args.emissions_cache == "off"
        else lib.EmissionStore(root / "_emissions", model=label, emitter=e2e.emitter_fingerprint(config))
    )
    media = Path(args.media) if args.media else root / "_runs" / f"pool-{label}" / "media"
    driver = PoolDriver(
        aligner=e2e.BenchAligner(device=device, model=named, store=store),
        corpus=corpus,
        media_root=media,
        language=args.language,
        seed=args.seed,
        config=config,
        sync_mode=args.sync_mode,
    )
    rows: list[dict[str, Any]] = []
    for song in songs:
        for pool, arm in plan:
            row = driver.run_pool(song, pool, arm)
            rows.append(row)
            print(
                f"{song.slug:22} {pool:12} {arm:8} {row['outcome']:9} "
                f"{row.get('published_label') or row.get('terminal')!s:20} "
                f"gross {row.get('gross')} ±500 {row.get('w500')}/{row.get('scored')} "
                f"{row.get('seconds')}s",
                file=sys.stderr,
                flush=True,
            )
    lines, passed = report(rows)
    print("\n".join(lines))
    if args.out:
        meta = {
            "model": label,
            "device": device,
            "language": args.language,
            "seed": args.seed,
            "sync_mode": args.sync_mode,
            "align_config": lib.align_config(config),
            "code": e2e.code_fingerprint(),
            "emitter": e2e.emitter_fingerprint(config),
            "songs": [s.slug for s in songs],
            "plan": [list(pair) for pair in plan],
        }
        Path(args.out).write_text(json.dumps(document(meta, rows)), encoding="utf-8")
    return 0 if passed else 3


if __name__ == "__main__":
    raise SystemExit(main())
