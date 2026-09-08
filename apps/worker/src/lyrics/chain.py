"""Lyrics ACQUISITION, separated from TIMING.

whisperx.py used to conflate the two: stage 2 was hardwired to `LrclibClient.get()` and raised when
it returned nothing, so "LRCLIB unreachable" meant "no lyrics" instead of "no AUTHORITATIVE lyrics".
Since WhisperX supplies the timing, all a source has to deliver is accurate TEXT — which makes plain
text first-class and pre-timed `.lrc` a bonus rather than a requirement.

This module owns "where does text come from". A `LyricsSource` yields text plus its provenance; the
timing layer in whisperx.py then force-aligns whatever arrived. Sources are collected into a list and
run INDEPENDENTLY — not first-hit — because text quality and timing fidelity are independent axes and
ASR runs on every cook regardless (it is also the only signal that catches a confidently WRONG
LRCLIB match; see agreementScore in packages/shared/src/lyrics.ts).

New module rather than an addition to lyrics/source.py: the LRCLIB adapter needs
`whisperx.lrclib_to_segments`, and whisperx.py already imports the lyrics package — putting the adapter
there would close an import cycle.

PURE of network/ML by construction: every source is injectable, so the whole chain tests with fakes.
Candidate metadata mirrors `LyricsCandidate` in packages/shared/src/lyrics.ts — that TS module is the
authority on RANKING; this side only reports what it produced and how trustworthy it is.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field, replace
from typing import Any

from ..vocabulary import ROLE_BASELINE, ROLE_CANDIDATE, ROLE_UNSPECIFIED, TextSource, Timing
from .artifact import (
    candidate_key as candidate_key,  # noqa: F401 — re-export: moved to artifact.py in #456, kept importable from chain
)
from .source import LyricsFetchError

# Text-source ids and timing tiers. Promoted to enums in src/vocabulary.py (TextSource, Timing) so the
# TS↔Python guard in apps/core/src/server/jobs/vocabulary-parity.test.ts covers them — a comment saying
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
# The role constants themselves now live in src/vocabulary.py beside TextSource/Timing (moved in #605)
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
    in packages/shared/src/lyrics.ts — that module is the authority; keep the two in step.

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
    #: transcribes badly — so it may be absent for a song whose stems have not been cooked.
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
    #: fail-CLOSED (#605): ROLE_UNSPECIFIED is in neither `candidates_of` nor `baselines_of`, so an
    #: unspecified text is NOT published as the song's words (and is not used as grading evidence) until a
    #: role is stamped. The old default was ROLE_CANDIDATE — the PUBLISHABLE tier — which silently let an
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
    #: line after the first start that fails to match to 1e-6 (issue #459). ``len`` equals the
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

    The notes are the point (issue #444). `acquire()` used to drop every miss on the floor, so a
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
# Mirrors agreementScore / SUSPECT_AGREEMENT / MIN_TOKENS_TO_COMPARE in packages/shared/src/lyrics.ts.
# Computed HERE, in the worker, because this is the only place both texts exist in memory at once — the
# core holds refs, and reading two artifacts back off disk inside the realtime hub to compare them would
# be I/O on the wrong side of the seam.
#
# This is what makes "ASR on every cook" pay for itself beyond being a fallback: LRCLIB's dangerous
# failure is not a miss but a confident MISMATCH (fuzzy metadata returns another song's words), and
# comparing the lookup against a transcript of what is actually being sung is the only signal we have.

MIN_TOKENS_TO_COMPARE = 12
SUSPECT_AGREEMENT = 0.25

_TOKEN_STRIP = re.compile(r"\[[^\]]*\]")
_TOKEN_KEEP = re.compile(r"[^\w\s']", re.UNICODE)


def lyrics_tokens(text: str) -> list[str]:
    """Words, lowercased, punctuation and [bracket] markers stripped. Compares CONTENT, not form.

    NFKC-normalised first so text differing only in Unicode FORM tokenises the same: full-width vs
    half-width digits/letters, composed vs decomposed accents, ligatures. Without it "Beyonc\u00e9" (one
    codepoint) and "Beyonce\u0301" (e + combining acute) are distinct tokens on both the intersection
    and the union of `agreement_score`, counting a correct candidate as disagreeing twice. Idempotent
    on ASCII (unicodedata.normalize("NFKC", ascii) == ascii), so it cannot move an all-ASCII score.
    Mirrors packages/shared/src/lyrics.ts:lyricsTokens (kept in one commit) and the established fold in
    metadata/annotate.py:normalize_for_match.
    """
    folded = unicodedata.normalize("NFKC", text).lower()
    cleaned = _TOKEN_KEEP.sub(" ", _TOKEN_STRIP.sub(" ", folded))
    return [t for t in cleaned.split() if t]


def agreement_score(a: str, b: str) -> float | None:
    """0..1 Jaccard over token SETS, or None when not comparable.

    Order-insensitive on purpose: a repeated chorus or a reordered bridge is not disagreement, whereas a
    different song shares few words in any order. Returns None — not 0 — when either side is too short:
    an instrumental transcribes to almost nothing, and scoring that as total disagreement would condemn
    a perfectly correct lookup. "Cannot tell" and "these differ" must not be the same answer.
    """
    set_a, set_b = set(lyrics_tokens(a)), set(lyrics_tokens(b))
    if len(set_a) < MIN_TOKENS_TO_COMPARE or len(set_b) < MIN_TOKENS_TO_COMPARE:
        return None
    shared = len(set_a & set_b)
    union = len(set_a | set_b)
    return None if union == 0 else shared / union


def baselines_of(texts: list[LyricsText]) -> list[LyricsText]:
    """The texts that are EVIDENCE, best-evidence first. See BASELINE_* for the ordering rationale."""
    got = [t for t in texts if t.role == ROLE_BASELINE]
    got.sort(key=lambda t: (t.baseline_rank if t.baseline_rank is not None else 99))
    return got


def candidates_of(texts: list[LyricsText]) -> list[LyricsText]:
    """The texts that are CLAIMS, in acquisition order."""
    return [t for t in texts if t.role == ROLE_CANDIDATE]


def composite_score(candidate: LyricsText, baselines: list[LyricsText]) -> tuple[float | None, list[float]]:
    """Mean agreement of one candidate against every baseline that can speak, plus the votes cast.

    Returns (None, []) when NO baseline is comparable — nothing was audible enough to judge with, which
    is a real outcome for an instrumental and must not be reported as disagreement.

    ABSTENTION, not zero, is what makes it safe to include a weak baseline. `agreement_score` yields None
    below MIN_TOKENS_TO_COMPARE, so a baseline that transcribed to almost nothing — a silent vocals stem,
    or YouTube auto-captions that collapsed a song into [Music] markers — simply does not vote. Scoring
    it as total disagreement would let the weakest evidence veto the strongest.

    EQUAL WEIGHT is deliberate. Weighting would need a per-baseline coefficient nobody has measured, and
    the ordering in BASELINE_* is about which evidence to SHOW, not how much to trust its vote. An
    unweighted mean over independent errors is the honest default; if measurement later justifies
    weights, this is the one function that changes.
    """
    votes = [
        s for s in (agreement_score(candidate.plain_text, b.plain_text) for b in baselines) if s is not None
    ]
    if not votes:
        return None, []
    return sum(votes) / len(votes), votes


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
# THRESHOLDS CANNOT SEPARATE VERSIONS. SUSPECT_AGREEMENT is calibrated for "a completely different song";
# two versions of the SAME song share most of their words, so the wrong one still scores far above it
# (measured: 0.548 for the wrong version against 0.938 for the right one, threshold 0.25). What separates
# them is not an absolute score but the COMPARISON. Argmax needs no threshold at all — only a difference.
#
# So the two mechanisms are complementary and both run:
#   SELECT   comparative, no threshold — which candidate best matches what is audible.
#   JUDGE    absolute, thresholded — is even the winner about this song at all.
#
# COST. Scoring is a token-set intersection over text already in memory, so judging five candidates
# against three baselines costs fifteen set operations and no alignment. Only what is published gets
# aligned, which is why selection deliberately happens before the expensive step.


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

        `summary()` renders these for the cook log, which rotates and is per-container; this crosses
        the wire and lands in the job_attempts audit trail so a mis-pick is diagnosable from state
        weeks later (#669). Deliberately NOT the lyric bodies — label + composite score is enough to
        say which of #542's three arms fired (metadata fallback vs a real disagreement), and storing
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
    #: Composite score of the winning candidate, or None when nothing could judge it.
    winner_score: float | None = None
    #: True when there was no candidate at all, so a baseline is being shown as the answer.
    baseline_fallback: bool = False
    #: True when the winner scored below SUSPECT_AGREEMENT — probably a different song entirely.
    winner_suspect: bool = False
    choices: list[VariantChoice] = field(default_factory=list)
    #: One line per baseline, for the log: which spoke, which abstained.
    baseline_notes: list[str] = field(default_factory=list)

    def to_record(self) -> dict[str, object] | None:
        """Durable provenance for the whole selection, or None when there was nothing to decide.

        None when no source offered a choice among versions (`choices` empty): there is no pick to
        explain, so nothing is persisted rather than an empty shell that reads as a lost record. When
        a decision happened this carries every source's `VariantChoice` plus the two facts that tell
        #542's arm (b) from arm (c) at a glance: whether a baseline actually voted, and on what basis.
        """
        if not self.choices:
            return None
        return {
            "baselineFallback": self.baseline_fallback,
            "winnerSuspect": self.winner_suspect,
            "winnerScore": self.winner_score,
            "choices": [c.to_record() for c in self.choices],
        }


def select_by_baselines(texts: list[LyricsText]) -> Selection:
    """Pick the song's words: grade every candidate against the baselines, then publish.

    The whole two-tier design lands here.

      1. Split by role. Baselines are evidence of what is audible; candidates are claims about the words.
      2. Score each candidate — and each of its alternate versions — as the MEAN agreement across every
         baseline that can speak (`composite_score`). Argmax wins; ties keep the better metadata match.
      3. Publish the winner. Also publish the best baseline when the winner cannot be trusted, so there
         is always something honest to fall back to: either no candidate existed, or the winner scored
         below SUSPECT_AGREEMENT and is probably a different song.

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
    for cand in candidates:
        pool = [cand, *cand.alternates]
        scored = [composite_score(c, baselines) for c in pool]
        pick = 0
        if any(s is not None for s, _ in scored):
            # max on (score, negative index) so an exact tie keeps the earlier — i.e. the better
            # metadata match. `-1.0` sorts an unjudgeable version below every judged one.
            pick = max(
                range(len(pool)), key=lambda i: (scored[i][0] if scored[i][0] is not None else -1.0, -i)
            )
            decided_by = "agreement"
        else:
            decided_by = "metadata"
        winner, (score, votes) = pool[pick], scored[pick]
        # The choice is made; the winner should no longer carry the losers. Rebind via replace rather
        # than assigning `winner.alternates = []`: `winner` is a caller-owned object (an element of the
        # candidate list passed in, or one of its `alternates`), and mutating it in place reaches across
        # the module boundary into the step layer's data — the same class of cross-object write #605 fixes
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
                        (c.variant, s)
                        for i, (c, (s, _)) in enumerate(zip(pool, scored, strict=False))
                        if i != pick
                    ],
                    decided_by=decided_by,
                    votes=len(votes),
                )
            )
        # Across sources, the same comparison decides. An unjudged candidate (-1.0) never displaces a
        # judged one, and among unjudged candidates the first acquired stands.
        if best is None or (score if score is not None else -1.0) > (
            best_score if best_score is not None else -1.0
        ):
            best, best_score = winner, score

    if best is None:
        # No claim at all. The tiering system picks among the baselines — best evidence first.
        sel.baseline_fallback = True
        sel.publish = baselines[:1]
        return sel

    sel.publish = [best]
    sel.winner_score = best_score
    sel.winner_suspect = best_score is not None and best_score < SUSPECT_AGREEMENT
    if sel.winner_suspect and baselines:
        # The winner is probably a different song. Publish what was actually HEARD alongside it, so the
        # room has a real alternative rather than only a warning label on the wrong words.
        sel.publish.append(baselines[0])
    return sel


# ── sources: re-exported from lyrics/sources.py ────────────────────────────────────
#
# The four source adapters, the ``LyricsSource`` protocol and ``_source_name`` were extracted to
# lyrics/sources.py in #456 (the ``sources/*`` seam of the declared split). They are imported here at
# the foot of the module -- AFTER LyricsRequest / LyricsText and the SOURCE_* / TIMING_* vocabulary are
# defined above -- so that ``from .chain import AsrSource``, lyrics/registry.py's import group and the
# package surface keep resolving unchanged, and there is no import cycle. ``acquire_with_notes`` above
# still calls ``_source_name``, which is why it is re-imported alongside the classes.
from .sources import (  # noqa: E402, F401 — deliberate re-export of the extracted source classes (#456)
    AsrSource,
    AutoCaptionsSource,
    CaptionsSource,
    LrclibSource,
    LyricsSource,
    _CaptionsSource,
    _source_name,
)
