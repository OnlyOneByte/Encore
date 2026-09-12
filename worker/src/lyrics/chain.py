"""Lyrics ACQUISITION, separated from TIMING.

whisperx.py used to conflate the two: stage 2 was hardwired to `LrclibClient.get()` and raised when
it returned nothing, so "LRCLIB unreachable" meant "no lyrics" instead of "no AUTHORITATIVE lyrics".
Since WhisperX supplies the timing, all a source has to deliver is accurate TEXT — which makes plain
text first-class and pre-timed `.lrc` a bonus rather than a requirement.

This module owns "where does text come from". A `LyricsSource` yields text plus its provenance; the
timing layer in whisperx.py then force-aligns whatever arrived. Sources are collected into a list and
run INDEPENDENTLY — not first-hit — because text quality and timing fidelity are independent axes and
ASR runs on every process regardless (it is also the only signal that catches a confidently WRONG
LRCLIB match; see agreementScore in src/lib/contract/lyrics/lyrics.ts).

New module rather than an addition to lyrics/source.py: the LRCLIB adapter needs
`whisperx.lrclib_to_segments`, and whisperx.py already imports the lyrics package — putting the adapter
there would close an import cycle.

PURE of network/ML by construction: every source is injectable, so the whole chain tests with fakes.
Candidate metadata mirrors `LyricsCandidate` in src/lib/contract/lyrics/lyrics.ts — that TS module is the
authority on RANKING; this side only reports what it produced and how trustworthy it is.
"""

from __future__ import annotations

import re
import unicodedata
from collections import Counter
from dataclasses import dataclass, field, replace
from typing import Any, NamedTuple

from ..vocabulary import ROLE_BASELINE, ROLE_CANDIDATE, ROLE_UNSPECIFIED, TextSource, Timing
from .artifact import (
    candidate_key as candidate_key,  # noqa: F401 — re-export: moved to artifact.py in an earlier change, kept importable from chain
)
from .source import LyricsFetchError

# Text-source ids and timing tiers. Promoted to enums in src/vocabulary.py (TextSource, Timing) so the
# TS↔Python guard in src/lib/server/jobs/vocabulary-parity.test.ts covers them — a comment saying
# "must match LyricsTextSource" cannot fail a build; the enum can. Re-exported under the original names
# so every importer of chain.py is unchanged, and `.value` keeps them plain strings for JSON/argv/keys.
SOURCE_LRCLIB = TextSource.LRCLIB.value
SOURCE_CAPTIONS = TextSource.CAPTIONS.value
SOURCE_ASR = TextSource.ASR.value
SOURCE_MANUAL = TextSource.MANUAL.value

TIMING_WORD = Timing.WORD.value
TIMING_LINE = Timing.LINE.value
TIMING_NONE = Timing.NONE.value

# ── ROLES: the two-tier split ─────────────────────────────────────────────────────
#
# The axis that decides HOW a text is judged, orthogonal to where it came from.
#
# A BASELINE is evidence of what is actually heard in THIS audio. It is never scored, because it is
# the ruler: scoring a baseline would mean measuring it against itself. Baselines are guesses at the
# words — none is authoritative — but they are guesses about the right recording BY CONSTRUCTION,
# which is exactly the property every authored source lacks.
#
# A CANDIDATE is authored text that claims to be this song's words. It is trustworthy about WORDS and
# untrustworthy about WHICH RECORDING: a lyrics database holds one record per release and they all
# match the same artist+track, so a candidate can be confidently, fluently about a different version.
#
# Every candidate is scored against EVERY baseline, and the mean of those scores picks the winner. The
# mean matters: one baseline is a single opinion, and the failure modes are independent — a separation
# that produced a silent vocals stem, an upload YouTube captioned badly, a passage no model hears.
# Averaging over independent errors is what makes the ruler steadier than any of its parts.
#
# The role constants themselves now live in src/vocabulary.py beside TextSource/Timing (moved in an earlier change)
# and are re-exported here — imported above — so every importer of chain.py is unchanged. ROLE_UNSPECIFIED
# is the fail-closed default for a hand-built text: see LyricsText.role and vocabulary.py's ROLES note.

#: Preference among BASELINES, lower first. Only consulted to pick a fallback to SHOW when no candidate
#: is trustworthy — never to weight the grading, where every baseline that can speak gets one equal vote.
#:
#: Ordered by how clean the evidence is, measured on this library rather than assumed:
#:   0  local transcription of the isolated vocals stem — the cleanest input a model can get
#:   1  local transcription of the raw mix — worse words, but it is the ONLY baseline that still works
#:      when separation fails, and separation does fail (2 of 9 stems on this library were digital
#:      silence and shipped as 'ready')
#:   2  YouTube's automatic captions — measured across five uploads, these suppress sung vocals into
#:      [Music] markers and were absent or useless on three of them. Real evidence when present, but
#:      the weakest, so it is chosen to show only when nothing else spoke.
BASELINE_ASR_VOCALS = 0
BASELINE_ASR_MIX = 1
BASELINE_CAPTIONS_AUTO = 2


def is_authoritative_text(text_source: str, text_confidence: str) -> bool:
    """Is this text trustworthy enough to be the song's real words? Mirror of `isAuthoritativeText`
    in src/lib/contract/lyrics/lyrics.ts — that module is the authority; keep the two in step.

    Mirrored rather than re-derived because it is now load-bearing on BOTH sides of the seam: the TV
    uses it to decide whether to caption the overlay "auto-transcribed", and the worker uses the same
    predicate to decide whether text arrived as human-authored LINES or as an ASR blob that needs
    re-lineating (see lyrics/presplit.py). One definition, two consumers — a second, drifting notion of
    "authoritative" would silently split the wrong tier.
    """
    return text_source != SOURCE_ASR and text_confidence != "low"


@dataclass
class LyricsRequest:
    """Everything a source might need to find text for one song."""

    media_id: str
    #: Confidence-gated canonicals from the core. None when the parse was not confident —
    #: a source that needs them must decline rather than look up a guess.
    artist: str | None = None
    track: str | None = None
    duration: float | None = None
    #: The FULL billing as the upload wrote it ("Lady Gaga feat. Beyoncé") when one was parsed, versus
    #: `artist` which is only the primary. Not a lookup key — LRCLIB is queried on the primary, because
    #: querying the full credit misses every record filed under the primary alone. It is a RANKING
    #: signal: among records that all match "Lady Gaga / Telephone", the one whose own artist string
    #: also mentions Beyoncé is the better metadata match.
    artist_credit: str | None = None
    #: The raw mixed audio (retained original). Fine for forced alignment.
    audio_path: str = ""
    #: The isolated vocals stem, when a stems job has already produced it. ASR wants THIS — a full mix
    #: transcribes badly — so it may be absent for a song whose stems have not been processed.
    vocals_path: str | None = None
    #: Cues from the upload's own human-authored caption track, already fetched and parsed by the
    #: processor's async stage. None/[] means the upload has no manual track. Passed in rather than
    #: fetched by the tier so this module performs no I/O.
    caption_segments: list[dict[str, Any]] | None = None
    #: Cues from YouTube's AUTOMATIC caption track, fetched into a separate directory so the two can
    #: never be confused for one another. A BASELINE input — see AutoCaptionsSource.
    auto_caption_segments: list[dict[str, Any]] | None = None


@dataclass
class LyricsText:
    """Text from one source, with the provenance the TV needs to be honest about it."""

    text_source: str
    #: [{start?, end?, text}] lines. `start`/`end` present only when the source itself is timed.
    segments: list[dict[str, Any]] = field(default_factory=list)
    #: What this source supplies on its own, BEFORE the timing layer runs.
    timing: str = TIMING_NONE
    text_confidence: str = "medium"
    language: str | None = None
    #: BASELINE (evidence of what is heard) or CANDIDATE (authored text to be judged). See the role
    #: constants above — this is what decides whether a text is scored or does the scoring.
    #:
    #: ASSIGNED BY THE REGISTRY, not by the source that fetched the text: `lyrics/registry.py` stamps it
    #: from the fetching source's `SourceSpec`. The sources used to set it themselves, which made the
    #: registry's `role`/`baseline_rank` fields a second declaration of the same fact that nothing read —
    #: so the two could disagree and every test would stay green. The default below therefore applies
    #: only to a text built by hand (a test, or one rehydrated from disk by `split_blob_text`) — and it is
    #: fail-CLOSED: ROLE_UNSPECIFIED is in neither `candidates_of` nor `baselines_of`, so an
    #: unspecified text is NOT published as the song's words (and is not used as grading evidence) until a
    #: role is stamped. The registry stamps a fetched text AND its `alternates`, because
    #: `select_by_baselines` grades `[cand, *cand.alternates]` and may publish an alternate — so an
    #: alternate left unspecified could win and publish as unspecified, the very hole this default guards.
    #: The old default was ROLE_CANDIDATE — the PUBLISHABLE tier — which silently let an
    #: unspecified construction publish, exactly the fail-open the `presplit.py` replace() note guards
    #: against (a dropped role once turned a baseline into a candidate).
    role: str = ROLE_UNSPECIFIED
    #: Preference among baselines when one must be SHOWN. None for candidates. Registry-assigned, as above.
    baseline_rank: int | None = None
    #: A short stable id for this text WITHIN its source, so two baselines from the same source can
    #: coexist on disk ('vocals' and 'mix' are both `asr`). Part of the artifact key; see candidate_key.
    tag: str | None = None
    #: Which VERSION of the song this text is, for logs. None when the source has no notion of one.
    variant: str | None = None
    #: Other versions of this song the same source offered, best-first by cheap metadata ranking.
    #:
    #: Held on the winner rather than returned alongside it because only ONE of them may ever be
    #: published: the artifact key is (media, source, timing), so two LRCLIB candidates would collide
    #: on disk and in the candidate set. These are the losers of a choice that has not been made yet —
    #: `select_by_baselines` makes it once the ASR transcript exists to decide with.
    alternates: list[LyricsText] = field(default_factory=list)
    #: Length-bounded search WINDOWS for the forced aligner, when `segments` are the source's OWN
    #: (human) lines and must stay un-subdivided so the line-sync fallback publishes them verbatim.
    #: `presplit` sets this on authoritative text whose lines overflow a row: the aligner gets tight
    #: per-row windows to search, but `segments` keeps the true human line timings for the line-sync
    #: publish path (which would otherwise ship a character-count-derived boundary as `high`). None
    #: means "the aligner searches `segments` as-is" — the ASR tier, where line structure is invented
    #: anyway, subdivides `segments` directly and leaves this None.
    align_windows: list[dict[str, Any]] | None = None
    #: Index into ``align_windows`` of the OPENING window of each human segment — the one window
    #: per line that carries the source's own timestamp (its ``start`` equals the segment start
    #: exactly). Emitted by ``bound_blob_text`` when it builds the windows, because that is where
    #: the segment->window mapping is KNOWN; re-deriving it later by float-equality strands every
    #: line after the first start that fails to match to 1e-6. ``len`` equals the
    #: number of segments, and index ``i`` opens segment ``i``. None whenever ``align_windows`` is.
    align_window_opens: list[int] | None = None

    @property
    def plain_text(self) -> str:
        """Flattened text, for ASR-vs-authoritative agreement scoring."""
        return "\n".join(str(s.get("text") or "") for s in self.segments).strip()

    def is_usable(self) -> bool:
        return any(str(s.get("text") or "").strip() for s in self.segments)


def acquire_with_notes(sources: list[LyricsSource], req: LyricsRequest) -> tuple[list[LyricsText], list[str]]:
    """Run EVERY source; return everything that yielded usable text PLUS an operator note per source
    that ran and did not.

    Not first-hit: the ideal artifact is authoritative text force-aligned to the audio, so an
    authoritative source and ASR are complements, not alternatives. A source that raises is skipped —
    one broken tier must never cost the others.

    The notes are the point. `acquire()` used to drop every miss on the floor, so a
    provider that had been failing 100% for a month (lrclib.net DNS-sinkholed on the corp box) looked
    EXACTLY like a run of songs that simply have no lyrics — a bare `return None` and "this is an
    instrumental" were the same observation. A source that RAISED (a provider transport/5xx failure,
    now including the sinkhole after `_urllib_fetch` converts URLError → LyricsFetchError) is a
    provider-down signal and gets a loud note; a source that RAN and returned nothing is a genuine
    per-song miss and gets a quiet one. Either way the operator can now tell them apart.
    """
    out: list[LyricsText] = []
    notes: list[str] = []
    for s in sources:
        name = _source_name(s)
        try:
            got = s.fetch(req)
        except LyricsFetchError as exc:
            notes.append(f"{name}: ran but FAILED — {exc}. Provider down, not a song without lyrics.")
            continue
        except Exception as exc:  # noqa: BLE001 — a misbehaving source is a miss, never a job failure
            notes.append(f"{name}: ran but errored — {exc}")
            continue
        if got is not None and got.is_usable():
            out.append(got)
        else:
            notes.append(f"{name}: ran and found nothing")
    return out, notes


def acquire(sources: list[LyricsSource], req: LyricsRequest) -> list[LyricsText]:
    """Texts-only view of :func:`acquire_with_notes`, kept for callers that do not surface notes."""
    texts, _notes = acquire_with_notes(sources, req)
    return texts


# ── ASR agreement: catching a confidently WRONG lookup ────────────────────────────
#
# Mirrors agreement / agreementScore / SUSPECT_COVERAGE / SEQUENCE_WEIGHT / MIN_TOKENS_TO_COMPARE in
# src/lib/contract/lyrics/lyrics.ts, and every number below is cross-checked against that authority by
# tests/test_lyrics_presplit.py's source-scan guard plus the shared-corpus parity guard in
# tests/test_lyrics_agreement_542.py.
# Computed HERE, in the worker, because this is the only place both texts exist in memory at once — the
# core holds refs, and reading two artifacts back off disk inside the realtime hub to compare them would
# be I/O on the wrong side of the seam.
#
# This is what makes "ASR on every process" pay for itself beyond being a fallback: LRCLIB's dangerous
# failure is not a miss but a confident MISMATCH (fuzzy metadata returns another song's words), and
# comparing the lookup against a transcript of what is actually being sung is the only signal we have.

MIN_TOKENS_TO_COMPARE = 12

#: Below this BASELINE COVERAGE the winner is probably a different song entirely.
#:
#: Replaces SUSPECT_AGREEMENT = 0.25, which was a threshold on symmetric set Jaccard. Both the metric
#: and the axis changed, so the constant is renamed rather than re-valued: a same-named threshold on a
#: different scale is a trap for anyone carrying the old number in their head.
#:
#: WHY COVERAGE AND NOT THE RANKING SCORE. Jaccard, multiset Jaccard and the ranking score below all
#: mix the two directions of the comparison, so they cannot tell "the candidate is a different song"
#: from "the baseline only heard part of the song" — and a partial baseline is the NORMAL case here,
#: because YouTube's ASR suppresses sung vocals. Measured on the synthetic corpus in
#: tests/test_lyrics_agreement_542.py: a CORRECT candidate against a baseline covering a third of the
#: audio scores 0.292 on set Jaccard (accepted at 0.25 by a hair) and 0.186 on the ranking score
#: (rejected) — while a DIFFERENT song scores 0.165 on that same ranking score. Those two bands are
#: 0.02 apart, so no threshold on a mixed score can separate them. Coverage — how much of what IS
#: audible the candidate carries — is immune to that size asymmetry and separates them by 0.17.
#:
#: THE BAND, measured (same corpus, so these numbers are reproducible by running that test file):
#:   different song, ceiling      0.300  (incl. a deliberately function-word-heavy adversary)
#:   correct candidate, floor     0.468  at a 50%-word-error baseline, i.e. already unusable
#:                                0.476  worst of 20 seeds at 45% word error
#:   correct candidate, partial   0.485  baseline covering only a third of the audio
#: 0.40 sits in that gap with 0.10 of margin above the different-song ceiling and 0.07 below the worst
#: usable correct floor. It tolerates a baseline mishearing ~60% of the words before calling a correct
#: lookup a different song, which is the direction to err in: publishing an ASR guess over correct
#: lyrics is the failure this whole tier exists to avoid.
#:
#: NOT A CORPUS CALIBRATION. The corpus is synthetic (original text, an explicit ASR-degradation model)
#: because an earlier change — commit a real lyrics corpus from the prod snapshot — is still open. What it measures
#: is the metric's own systematic behaviour, which is what choosing between two axes needs; it is not
#: evidence about the real distribution of songs. Re-derive this number once an earlier change lands.
SUSPECT_COVERAGE = 0.40

#: How much of the ranking score is the POSITION-aware term. Equal weight with the count-aware
#: term, for the same reason `composite_score` weights baselines equally: any other split would be a
#: coefficient nobody has measured. Only the ranking score uses this, and ranking is threshold-free —
#: `select_by_baselines` takes an argmax — so the weight steers a comparison and cannot, on its own,
#: accept or reject anything.
SEQUENCE_WEIGHT = 0.5

#: How far past the end of the audio a candidate's own timings may run before selection DEMOTES it
#: (owner ruling B). Expressed as a FRACTION of the song's duration, not raw seconds, because
#: a fixed second-count would be lenient on a 30s clip and harsh on a 7-minute track. The two real
#: wrong-version cases overshoot by +39% (Total Eclipse, 268s->374s) and +27% (Friends in Low
#: Places, 281s->357s), so 10% clears both with margin while leaving room for the owner's stated
#: trap — a legitimate LRC for the SAME recording carrying a short trailing artefact cue, which is
#: seconds, not tens of percent. PROPOSED FOR REVIEW: Q2 of an earlier change was ruled "a percentage, proposed
#: by the implementer" — 0.10 is that proposal. Raise it if a same-recording false positive appears.
OVERSHOOT_FRACTION_MAX = 0.10

_TOKEN_STRIP = re.compile(r"\[[^\]]*\]")
_TOKEN_KEEP = re.compile(r"[^\w\s']", re.UNICODE)


def lyrics_tokens(text: str) -> list[str]:
    """Words, lowercased, punctuation and [bracket] markers stripped. Compares CONTENT, not form.

    NFKC-normalised first so text differing only in Unicode FORM tokenises the same: full-width vs
    half-width digits/letters, composed vs decomposed accents, ligatures. Without it "Beyonc\u00e9" (one
    codepoint) and "Beyonce\u0301" (e + combining acute) are distinct tokens on both the intersection
    and the union of `agreement_score`, counting a correct candidate as disagreeing twice. Idempotent
    on ASCII (unicodedata.normalize("NFKC", ascii) == ascii), so it cannot move an all-ASCII score.
    Mirrors src/lib/contract/lyrics/lyrics.ts:lyricsTokens (kept in one commit) and the established fold in
    metadata/annotate.py:normalize_for_match.
    """
    folded = unicodedata.normalize("NFKC", text).lower()
    cleaned = _TOKEN_KEEP.sub(" ", _TOKEN_STRIP.sub(" ", folded))
    return [t for t in cleaned.split() if t]


def _multiset_overlap(a: list[str], b: list[str]) -> int:
    """How many tokens the two sequences share COUNTING MULTIPLICITY: Σ min(count_a, count_b).

    The count is what set Jaccard threw away. A candidate that repeats a chorus four times where the
    audio has it twice agrees on the words and disagrees on how many of them there are, and "how many"
    is half of what tells one version of a recording from another.
    """
    counts_b = Counter(b)
    return sum(min(n, counts_b.get(token, 0)) for token, n in Counter(a).items())


def _adjacent_pairs(tokens: list[str]) -> list[tuple[str, str]]:
    """Every neighbouring token pair, in order — the position-aware view of a token sequence.

    Adjacent pairs, not whole-sequence alignment: an LCS or difflib ratio is O(n·m) on texts that run to
    thousands of tokens and would be re-run for every candidate × baseline pair inside selection, and
    difflib's own ratio is not reproducible in TypeScript (its autojunk heuristic silently drops tokens
    appearing in >1% of a long sequence). Pairs are O(n), and they carry what this comparison actually
    needs: a reordered bridge or a verse swapped between versions breaks the pairs at the seams, while a
    text with the same words in a different arrangement shares far fewer pairs than words.
    """
    return list(zip(tokens, tokens[1:], strict=False))


class Agreement(NamedTuple):
    """One candidate compared against one baseline, kept as the THREE numbers instead of an average.

    The directional split is the point. Symmetric Jaccard averages the two directions into one
    number and destroys the fingerprint of "right song, WRONG version": near-complete coverage of the
    audible words while a large part of the candidate is not audible at all. Measured on the real
    reported mis-pick: coverage 0.857, fidelity 0.485 — one number cannot say that.

    coverage  |C ∩ B| / |B|, multiset — how much of what IS audible the candidate carries.
              The absolute judgement (`SUSPECT_COVERAGE`) reads THIS, because it is the only one of the
              three that a partial baseline does not depress: a baseline that heard a third of the song
              still has all of its own words inside a correct candidate.
    fidelity  |C ∩ B| / |C|, multiset — how much of the candidate is actually audible. Low fidelity
              with high coverage IS the wrong-version fingerprint. It steers the COMPARISON only.
    sequence  the same overlap over ADJACENT PAIRS, weaker direction — word ORDER, not just counts.
    """

    coverage: float
    fidelity: float
    sequence: float

    @property
    def rank_score(self) -> float:
        """The single 0..1 number `select_by_baselines` ranks candidates by. NOT a threshold axis.

        The weaker of the two count directions, blended with the position-aware term: a candidate is
        only as good as its worse direction, so padding it with words nobody sings cannot buy rank. No
        threshold is applied to this anywhere — argmax needs a difference, not a level — which is why
        it can afford to be the harsh, discriminating number while `coverage` stays the lenient,
        judgeable one.
        """
        counts = min(self.coverage, self.fidelity)
        return (1.0 - SEQUENCE_WEIGHT) * counts + SEQUENCE_WEIGHT * self.sequence


def agreement(candidate: str, baseline: str) -> Agreement | None:
    """Compare a CANDIDATE against a BASELINE, or None when the comparison says nothing.

    ARGUMENT ORDER IS LOAD-BEARING and it was not before: `coverage` and `fidelity` are the two
    directions of the same overlap, so swapping the arguments swaps them. Candidate first, baseline
    second — the same order as `composite_score(candidate, baselines)`.

    Returns None — not 0 — when either side has fewer than MIN_TOKENS_TO_COMPARE distinct tokens: an
    instrumental transcribes to almost nothing, and scoring that as total disagreement would condemn a
    perfectly correct lookup. "Cannot tell" and "these differ" must not be the same answer. The gate
    stays on DISTINCT tokens, unchanged from the set-based metric, and needs no count-aware companion:
    12 distinct tokens already implies at least 12 tokens and at least 11 adjacent pairs.
    """
    tokens_c, tokens_b = lyrics_tokens(candidate), lyrics_tokens(baseline)
    if len(set(tokens_c)) < MIN_TOKENS_TO_COMPARE or len(set(tokens_b)) < MIN_TOKENS_TO_COMPARE:
        return None
    shared = _multiset_overlap(tokens_c, tokens_b)
    pairs_c, pairs_b = _adjacent_pairs(tokens_c), _adjacent_pairs(tokens_b)
    shared_pairs = _multiset_overlap(pairs_c, pairs_b)  # type: ignore[arg-type]
    sequence = (
        min(shared_pairs / len(pairs_b), shared_pairs / len(pairs_c))
        if pairs_c and pairs_b
        else 0.0
    )
    return Agreement(
        coverage=shared / len(tokens_b),
        fidelity=shared / len(tokens_c),
        sequence=sequence)


def agreement_score(candidate: str, baseline: str) -> float | None:
    """The 0..1 ranking score for one candidate against one baseline, or None when not comparable.

    Count- and position-aware since an earlier change; it was symmetric Jaccard over token SETS, which scored the
    reported wrong-version mis-pick at 0.448 — above the old 0.25 threshold, so it was accepted. See
    `Agreement` for why the three numbers are kept apart and `SUSPECT_COVERAGE` for which of them the
    absolute judgement reads.
    """
    got = agreement(candidate, baseline)
    return None if got is None else got.rank_score


def baselines_of(texts: list[LyricsText]) -> list[LyricsText]:
    """The texts that are EVIDENCE, best-evidence first. See BASELINE_* for the ordering rationale."""
    got = [t for t in texts if t.role == ROLE_BASELINE]
    got.sort(key=lambda t: (t.baseline_rank if t.baseline_rank is not None else 99))
    return got


def candidates_of(texts: list[LyricsText]) -> list[LyricsText]:
    """The texts that are CLAIMS, in acquisition order."""
    return [t for t in texts if t.role == ROLE_CANDIDATE]


class Composite(NamedTuple):
    """One candidate graded against every baseline that could speak.

    Two means, not one, because the two mechanisms below read different axes: `score` is what
    selection ranks by, `coverage` is what the absolute wrong-song judgement thresholds. `votes` is the
    per-baseline ranking scores that formed the mean, so `len(votes)` is how many baselines spoke.

    Index 0 stays `score`, so `composite_score(...)[0]` keeps meaning the ranking score.
    """

    score: float | None
    coverage: float | None
    votes: list[float]


def composite_score(candidate: LyricsText, baselines: list[LyricsText]) -> Composite:
    """Mean agreement of one candidate against every baseline that can speak, plus the votes cast.

    Returns (None, None, []) when NO baseline is comparable — nothing was audible enough to judge with,
    which is a real outcome for an instrumental and must not be reported as disagreement.

    ABSTENTION, not zero, is what makes it safe to include a weak baseline. `agreement` yields None
    below MIN_TOKENS_TO_COMPARE, so a baseline that transcribed to almost nothing — a silent vocals stem,
    or YouTube auto-captions that collapsed a song into [Music] markers — simply does not vote. Scoring
    it as total disagreement would let the weakest evidence veto the strongest.

    EQUAL WEIGHT is deliberate. Weighting would need a per-baseline coefficient nobody has measured, and
    the ordering in BASELINE_* is about which evidence to SHOW, not how much to trust its vote. An
    unweighted mean over independent errors is the honest default; if measurement later justifies
    weights, this is the one function that changes.

    The two means are taken over the SAME set of speaking baselines, so `coverage` cannot be formed from
    a different quorum than `score` — a baseline that abstains abstains on both axes.
    """
    spoke = [
        got for got in (agreement(candidate.plain_text, b.plain_text) for b in baselines) if got is not None
    ]
    if not spoke:
        return Composite(None, None, [])
    votes = [got.rank_score for got in spoke]
    return Composite(
        score=sum(votes) / len(votes),
        coverage=sum(got.coverage for got in spoke) / len(spoke),
        votes=votes)


def candidate_last_end(candidate: LyricsText) -> float | None:
    """Latest word/line end time the candidate's OWN timings carry, or None when it is not timed.

    A timed source (lrclib-word, and any TIMING_WORD/TIMING_LINE tier) fills `start`/`end` on its
    `segments`; a text-only source does not. Overshoot is only defined for the former — a text without
    its own timings cannot be "timed past the audio" until it is force-aligned, which happens after
    selection. Reads `end` off segments directly (not the flattened word list) because at SELECTION time
    the line timing is what a wrong-version LRC carries, and an earlier change's two real cases are `lrclib-word`.
    """
    ends = [float(seg["end"]) for seg in candidate.segments if isinstance(seg.get("end"), (int, float))]
    return max(ends) if ends else None


def overshoot_penalized(score: float, candidate: LyricsText, duration_sec: float | None) -> float:
    """The candidate's composite score after DEMOTING it for running past the end of the audio.

    Owner ruling B: a candidate timed well past audio-end is a wrong-version pick — its lyrics belong to
    a longer master, so a quarter of them can never be sung. It must lose to a rival that fits, without
    a threshold masquerading as a similarity judgement. The penalty is COMPARATIVE, applied to the same
    composite score argmax already ranks by, so a clean rival wins on the same axis.

    Below OVERSHOOT_FRACTION_MAX (a fraction of duration) the score is untouched — that band absorbs the
    owner's stated trap, a same-recording LRC with a short trailing artefact cue. Above it, subtract the
    overshoot fraction from the score: +39% overshoot turns a 0.45 into ~0.06, which loses to any rival
    that fits, while a 0.94 wrong-version pick against a 0.55 clean rival (a real measured pair) still
    flips. `duration_sec` unknown, or the candidate untimed, means no judgement is possible — return the
    score unchanged, the same fail-open coverage uses for a missing duration.
    """
    if not duration_sec or duration_sec <= 0:
        return score
    last_end = candidate_last_end(candidate)
    if last_end is None:
        return score
    fraction = max(0.0, last_end - duration_sec) / duration_sec
    if fraction <= OVERSHOOT_FRACTION_MAX:
        return score
    return score - fraction


# ── selection: candidates are judged, baselines do the judging ─────────────────────────
#
# The problem, and why a threshold cannot solve it.
#
# A popular song has several distinct recordings and a lyrics provider holds a record for each. Ask for
# "Lady Gaga / Telephone" and you may be handed the version without Beyoncé's verse. An earlier design
# noticed the mismatch and demoted the text, which dropped it below the transcript — so the singer got
# Whisper's guess at sung words when the CORRECT lyrics were one record away. Detection without
# re-selection made the outcome worse, not better.
#
# THRESHOLDS CANNOT SEPARATE VERSIONS. `SUSPECT_COVERAGE` is calibrated for "a completely different
# song"; two versions of the SAME song share most of their words, so the wrong one still scores far above
# it (measured: baseline coverage 0.857 for the reported wrong-version mis-pick). What separates them is
# not an absolute score but the COMPARISON. Argmax needs no threshold at all — only a difference.
#
# So the two mechanisms are complementary, both run, and since an earlier change they read DIFFERENT AXES of the same
# comparison rather than sharing one averaged number:
#   SELECT   comparative, no threshold — `Composite.score`, the weaker count direction blended with the
#            adjacent-pair term. Harsh and discriminating on purpose: the wrong-version fingerprint is
#            low fidelity (words nobody sings) and broken word order, and both cost rank here.
#   JUDGE    absolute, thresholded — `Composite.coverage` against SUSPECT_COVERAGE. Lenient on purpose:
#            it must not fire because the BASELINE was partial, which is the normal case for ASR on
#            sung vocals. See SUSPECT_COVERAGE for why a mixed score cannot serve both.
#
# COST. Scoring is a multiset intersection over token counts and adjacent pairs, both linear in the text
# already in memory, so judging five candidates against three baselines costs fifteen linear passes and
# no alignment. Whole-sequence alignment (LCS, difflib) would be O(n·m) per pair on texts of thousands of
# tokens — see `_adjacent_pairs`. Only what is published gets aligned, which is why selection
# deliberately happens before the expensive step.


@dataclass
class VariantChoice:
    """What happened when one source offered several versions. Purely a report — for logs and tests."""

    text_source: str
    considered: int
    chosen: str | None
    chosen_score: float | None
    #: (label, score) of everything not chosen, in the order considered.
    rejected: list[tuple[str | None, float | None]] = field(default_factory=list)
    #: "agreement" when the baselines decided it, "metadata" when they could not and cheap ranking stood.
    decided_by: str = "metadata"
    #: How many baselines actually voted on the winner. 0 means the mean could not be formed.
    votes: int = 0

    def summary(self) -> str:
        head = f"{self.text_source}: {self.considered} versions, kept {self.chosen or '?'}"
        if self.chosen_score is not None:
            head += f" (composite {self.chosen_score:.2f} from {self.votes} baseline(s))"
        if self.decided_by == "metadata":
            return head + " — chosen on metadata; no baseline could judge"
        losers = ", ".join(
            f"{label or '?'}" + (f" {score:.2f}" if score is not None else " —")
            for label, score in self.rejected
        )
        return head + (f", over {losers}" if losers else "")

    def to_record(self) -> dict[str, object]:
        """The durable, wire-safe form of this pick — the same facts as `summary()`, as data.

        `summary()` renders these for the process log, which rotates and is per-container; this crosses
        the wire and lands in the job_attempts audit trail so a mis-pick is diagnosable from state
        weeks later. Deliberately NOT the lyric bodies — label + composite score is enough to
        say which of an earlier change's three arms fired (metadata fallback vs a real disagreement), and storing
        four rejected full texts per song would multiply the lyrics footprint for triage-only data.
        """
        return {
            "textSource": self.text_source,
            "considered": self.considered,
            "chosen": self.chosen,
            "chosenScore": self.chosen_score,
            "decidedBy": self.decided_by,
            "votes": self.votes,
            "rejected": [{"label": label, "score": score} for label, score in self.rejected],
        }


@dataclass
class Selection:
    """The outcome of one align job's text selection."""

    #: What to publish, in rank order. The winning candidate first when there is one.
    publish: list[LyricsText] = field(default_factory=list)
    #: Composite RANKING score of the winning candidate, or None when nothing could judge it. Not the
    #: axis `winner_suspect` reads — see SUSPECT_COVERAGE.
    winner_score: float | None = None
    #: Mean BASELINE COVERAGE of the winning candidate — how much of what was audible it carries. This
    #: is the number the wrong-song judgement thresholds. None when no baseline could speak.
    winner_coverage: float | None = None
    #: True when there was no candidate at all, so a baseline is being shown as the answer.
    baseline_fallback: bool = False
    #: True when the winner's coverage fell below SUSPECT_COVERAGE — probably a different song entirely.
    winner_suspect: bool = False
    choices: list[VariantChoice] = field(default_factory=list)
    #: One line per baseline, for the log: which spoke, which abstained.
    baseline_notes: list[str] = field(default_factory=list)

    def to_record(self) -> dict[str, object] | None:
        """Durable provenance for the whole selection, or None when there was nothing to decide.

        None when no source offered a choice among versions (`choices` empty): there is no pick to
        explain, so nothing is persisted rather than an empty shell that reads as a lost record. When
        a decision happened this carries every source's `VariantChoice` plus the two facts that tell
        an earlier change's arm (b) from arm (c) at a glance: whether a baseline actually voted, and on what basis.
        """
        if not self.choices:
            return None
        return {
            "baselineFallback": self.baseline_fallback,
            "winnerSuspect": self.winner_suspect,
            "winnerScore": self.winner_score,
            # The axis `winnerSuspect` is actually decided on. Without it the record reads as a
            # MISSED DETECTION on its own numbers — `winnerSuspect: false` beside a `winnerScore` under
            # the documented threshold — because the score shown is the ranking axis and the threshold
            # belongs to coverage. This is the number that cleared it.
            "winnerCoverage": self.winner_coverage,
            "choices": [c.to_record() for c in self.choices],
        }


def select_by_baselines(texts: list[LyricsText], duration_sec: float | None = None) -> Selection:
    """Pick the song's words: grade every candidate against the baselines, then publish.

    The whole two-tier design lands here.

      1. Split by role. Baselines are evidence of what is audible; candidates are claims about the words.
      2. Score each candidate — and each of its alternate versions — as the MEAN agreement across every
         baseline that can speak (`composite_score`), then DEMOTE any whose own timings run well past the
         end of the audio (`overshoot_penalized`). Argmax over the penalised score wins; ties keep
         the better metadata match. The reported score stays the raw agreement — the penalty steers the
         COMPARISON, it is not itself a similarity claim about the words.
      3. Publish the winner. Also publish the best baseline when the winner cannot be trusted, so there
         is always something honest to fall back to: either no candidate existed, or the winner scored
         below SUSPECT_COVERAGE and is probably a different song.

    WHY A BASELINE IS PUBLISHED ONLY THEN, and not always: everything published gets force-aligned, so a
    baseline published for its own sake would cost a full alignment pass to produce words nobody shows.
    When the winner is trustworthy the baselines have done their job by grading it.

    A baseline is never a candidate. It cannot be chosen over an authored text while any authored text is
    trustworthy — which is the structural reason YouTube's automatic captions are safe to include here
    and were not safe as a source of record.
    """
    baselines = baselines_of(texts)
    candidates = candidates_of(texts)
    sel = Selection()

    for b in baselines:
        tokens = len(set(lyrics_tokens(b.plain_text)))
        sel.baseline_notes.append(
            f"{b.variant or b.text_source}: {tokens} distinct words"
            + ("" if tokens >= MIN_TOKENS_TO_COMPARE else " — too few to judge with, ABSTAINS")
        )

    best: LyricsText | None = None
    best_score: float | None = None
    #: The winner's mean BASELINE COVERAGE — the axis the wrong-song judgement reads. Tracked
    #: alongside the rank so the judgement is made on the coverage of whatever actually wins, never on
    #: a coverage borrowed from a candidate that lost.
    best_coverage: float | None = None
    #: The penalised score the picked winner is RANKED by across sources. Kept apart from
    #: `best_score` so an over-covered winner loses to a clean rival while `winner_score` still reports
    #: the raw agreement of whatever ultimately wins.
    best_rank: float | None = None
    for cand in candidates:
        pool = [cand, *cand.alternates]
        scored = [composite_score(c, baselines) for c in pool]
        # The RANKING key demotes a version timed past audio-end; `scored` itself keeps the raw
        # agreement so provenance and `winner_score` report what the words actually matched, not the
        # penalty. A None-scored (unjudgeable) version stays -1.0 and is never penalised into a lower
        # negative that could reorder the unjudged tail — the penalty only ever touches a real score.
        ranked = [
            (overshoot_penalized(got.score, c, duration_sec) if got.score is not None else None)
            for c, got in zip(pool, scored, strict=False)
        ]
        pick = 0
        if any(s is not None for s in ranked):
            # max on (score, negative index) so an exact tie keeps the earlier — i.e. the better
            # metadata match. `-1.0` sorts an unjudgeable version below every judged one.
            pick = max(
                range(len(pool)), key=lambda i: (ranked[i] if ranked[i] is not None else -1.0, -i)
            )
            decided_by = "agreement"
        else:
            decided_by = "metadata"
        winner, picked = pool[pick], scored[pick]
        score, coverage, votes = picked.score, picked.coverage, picked.votes
        # The choice is made; the winner should no longer carry the losers. Rebind via replace rather
        # than assigning `winner.alternates = []`: `winner` is a caller-owned object (an element of the
        # candidate list passed in, or one of its `alternates`), and mutating it in place reaches across
        # the module boundary into the step layer's data — the same class of cross-object write an earlier change fixes
        # at steps/lyrics.py. See presplit.py's replace() note on why copy-with-replacement is the rule here.
        winner = replace(winner, alternates=[])
        if len(pool) > 1:
            sel.choices.append(
                VariantChoice(
                    text_source=winner.text_source,
                    considered=len(pool),
                    chosen=winner.variant,
                    chosen_score=score,
                    rejected=[
                        (c.variant, got.score)
                        for i, (c, got) in enumerate(zip(pool, scored, strict=False))
                        if i != pick
                    ],
                    decided_by=decided_by,
                    votes=len(votes))
            )
        # Across sources, the same comparison decides — on the PENALISED rank of the pick, so a source
        # whose only version overshoots audio-end loses to a source that fits. An unjudged
        # candidate (-1.0) never displaces a judged one, and among unjudged candidates the first
        # acquired stands. `best_score` records the winner's RAW agreement for provenance either way.
        rank = ranked[pick]
        if best is None or (rank if rank is not None else -1.0) > (
            best_rank if best_rank is not None else -1.0
        ):
            best, best_score, best_coverage, best_rank = winner, score, coverage, rank

    if best is None:
        # No claim at all. The tiering system picks among the baselines — best evidence first.
        sel.baseline_fallback = True
        sel.publish = baselines[:1]
        return sel

    sel.publish = [best]
    sel.winner_score = best_score
    sel.winner_coverage = best_coverage
    # The JUDGE axis is coverage, not the ranking score. A correct candidate graded against a
    # baseline that only heard part of the song has a LOW rank score by construction — most of the
    # candidate is not audible, so its fidelity is low — and thresholding that would demote correct
    # lyrics for a defect in the evidence. Coverage asks the question that is actually absolute: does
    # this candidate contain what was audible at all? See SUSPECT_COVERAGE for the measured band.
    sel.winner_suspect = best_coverage is not None and best_coverage < SUSPECT_COVERAGE
    if sel.winner_suspect and baselines:
        # The winner is probably a different song. Publish what was actually HEARD alongside it, so the
        # room has a real alternative rather than only a warning label on the wrong words.
        sel.publish.append(baselines[0])
    return sel


# ── sources: re-exported from lyrics/sources.py ────────────────────────────────────
#
# The four source adapters, the ``LyricsSource`` protocol and ``_source_name`` were extracted to
# lyrics/sources.py in an earlier change (the ``sources/*`` seam of the declared split). They are imported here at
# the foot of the module -- AFTER LyricsRequest / LyricsText and the SOURCE_* / TIMING_* vocabulary are
# defined above -- so that ``from .chain import AsrSource``, lyrics/registry.py's import group and the
# package surface keep resolving unchanged, and there is no import cycle. ``acquire_with_notes`` above
# still calls ``_source_name``, which is why it is re-imported alongside the classes.
from .sources import (  # noqa: E402, F401 — deliberate re-export of the extracted source classes
    AsrSource,
    AutoCaptionsSource,
    CaptionsSource,
    LrclibSource,
    LyricsSource,
    _CaptionsSource,
    _source_name)
