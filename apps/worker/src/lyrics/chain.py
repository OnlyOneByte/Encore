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

New module rather than an addition to lyrics_source.py: the LRCLIB adapter needs
`whisperx.lrclib_to_segments`, and whisperx.py already imports lyrics_source — putting the adapter
there would close an import cycle.

PURE of network/ML by construction: every source is injectable, so the whole chain tests with fakes.
Candidate metadata mirrors `LyricsCandidate` in packages/shared/src/lyrics.ts — that TS module is the
authority on RANKING; this side only reports what it produced and how trustworthy it is.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Protocol

from .source import MAX_VARIANTS, rank_lrclib_candidates

# Text-source ids — must match LyricsTextSource in packages/shared/src/lyrics.ts.
SOURCE_LRCLIB = "lrclib"
SOURCE_CAPTIONS = "captions"
SOURCE_ASR = "asr"
SOURCE_MANUAL = "manual"

# Timing fidelity a source supplies UNAIDED — must match LyricsTiming in the same TS module.
TIMING_WORD = "word"
TIMING_LINE = "line"
TIMING_NONE = "none"

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
ROLE_BASELINE = "baseline"
ROLE_CANDIDATE = "candidate"

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
    re-lineating (see lyrics_presplit.py). One definition, two consumers — a second, drifting notion of
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
    role: str = ROLE_CANDIDATE
    #: Preference among baselines when one must be SHOWN. None for candidates.
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
    #: `select_variants` makes it once the ASR transcript exists to decide with.
    alternates: list["LyricsText"] = field(default_factory=list)

    @property
    def plain_text(self) -> str:
        """Flattened text, for ASR-vs-authoritative agreement scoring."""
        return "\n".join(str(s.get("text") or "") for s in self.segments).strip()

    def is_usable(self) -> bool:
        return any(str(s.get("text") or "").strip() for s in self.segments)


class LyricsSource(Protocol):
    """One place text can come from. MUST NOT raise for an ordinary miss — return None."""

    name: str

    def fetch(self, req: LyricsRequest) -> LyricsText | None: ...


class LrclibSource:
    """Authoritative human-authored lyrics, line-timed when LRCLIB has an LRC for the track.

    Declines (None) rather than raising on: no confident metadata, a 404, an instrumental, or a
    network failure. A dead LRCLIB must degrade the RESULT, not fail the job — that conflation is the
    bug this whole commit exists to fix.

    SEARCHES rather than gets, because a popular song has SEVERAL records and /api/get returns one of
    them by fiat. Asking for a single record is how "Telephone (feat. Beyoncé)" ends up singing the
    lyrics of "Telephone": both records match artist+track, /api/get picks whichever satisfies its ±2s
    duration filter first, and nothing downstream ever learns there was a choice. This tier therefore
    returns the metadata-best record with the rest attached as `alternates`, and defers the real
    decision to `select_variants`, which has the ASR transcript to settle it with.

    Falls back to `get()` when the search finds nothing: a record reachable by exact match but absent
    from search results is unlikely but costs one request to rule out, and a regression from
    "lyrics" to "no lyrics" is not an acceptable price for adding version selection.
    """

    name = SOURCE_LRCLIB

    def __init__(self, client: Any, to_segments: Any, max_variants: int = MAX_VARIANTS) -> None:
        self._client = client
        self._to_segments = to_segments  # whisperx.lrclib_to_segments, injected to avoid a cycle
        self._max_variants = max_variants

    def _to_text(self, res: Any, req: LyricsRequest) -> LyricsText | None:
        segments = self._to_segments(res, req.duration)
        if not segments:
            return None  # instrumental, or no usable lyrics body
        return LyricsText(
            text_source=SOURCE_LRCLIB,
            segments=segments,
            # An LRC gives real line timings; plainLyrics segments carry only synthetic even spacing,
            # which is NOT sync and must not be presented as the line-level floor.
            timing=TIMING_LINE if bool(getattr(res, "has_synced", False)) else TIMING_NONE,
            text_confidence="high",
            language=None,
            role=ROLE_CANDIDATE,
            variant=getattr(res, "label", None),
        )

    def fetch(self, req: LyricsRequest) -> LyricsText | None:
        if not req.artist or not req.track:
            return None  # no confident metadata → an authoritative lookup is not possible

        # The credit we can compare a record's artist string against. `artist_credit` carries the full
        # billing ("Lady Gaga feat. Beyoncé") when the upload named one; `artist` alone is the primary.
        credit = req.artist_credit or req.artist

        pool: list[Any] = []
        try:
            found = self._client.search(req.artist, req.track)
        except Exception:  # noqa: BLE001 — unreachable/5xx/TLS: a miss, not a job failure
            found = []
        if found:
            pool = rank_lrclib_candidates(found, req.duration, credit, self._max_variants)

        if not pool:
            try:
                one = self._client.get(req.artist, req.track, duration=req.duration)
            except Exception:  # noqa: BLE001 — same class, same treatment
                return None
            if one is None:
                return None
            pool = [one]

        texts = [t for t in (self._to_text(r, req) for r in pool) if t is not None]
        if not texts:
            return None
        best, rest = texts[0], texts[1:]
        best.alternates = rest
        return best


class CaptionsSource:
    """Lyrics from the upload's own HUMAN-AUTHORED caption track — a CANDIDATE.

    Uniquely version-proof among candidates. Every other authored tier is indexed by artist+track and can
    only return a record for *some* recording of the song; these are attached to the exact upload being
    sung over, so they cannot be about a different version. That makes this the candidate least able to
    be wrong about which recording it is — and it still gets graded, because "attached to this upload"
    does not mean "correct" (a captioner mistypes, or captions a different language).

    Distinct from AutoCaptionsSource, which is a BASELINE. The two arrive from separate yt-dlp fetches
    into separate directories precisely so that this distinction cannot blur: the guarantee that no
    machine-generated track reaches this tier is structural, not a filter. See captions.py.

    Timing is LINE and stays line: a caption cue bounds a whole line, and any word timing comes from the
    same forced aligner every other tier goes through.

    PURE — the yt-dlp call happens in the align processor's async stage, through the same injected runner
    the audio download uses, and the parsed cues arrive on the request. This tier owns no subprocess of
    its own: an earlier draft did, and it made every existing processor test shell out to the network,
    because the harness's injected fake runner had no way to reach a second private path to yt-dlp.
    """

    name = SOURCE_CAPTIONS

    def fetch(self, req: LyricsRequest) -> LyricsText | None:
        if not req.caption_segments:
            return None  # no manual track on this upload — the common case, and not an error
        return LyricsText(
            text_source=SOURCE_CAPTIONS,
            segments=list(req.caption_segments),
            timing=TIMING_LINE,
            text_confidence="high",
            language=None,
            role=ROLE_CANDIDATE,
            tag="manual",
            variant="uploader captions",
        )


class AsrSource:
    """Transcribe what is ACTUALLY SUNG — a BASELINE, not an answer.

    Two instances of this run per align job, one on the isolated vocals stem and one on the raw mix, and
    that is deliberate rather than wasteful. The stem gives better words when separation worked; the mix
    is the only baseline that still speaks when it did not, and on this library separation demonstrably
    fails (2 of 9 vocals stems were digital silence and shipped as `ready`). Their errors are also
    largely independent, which is the property that makes averaging them a steadier ruler than either
    alone. `audio` selects which one this instance reads.

    Text confidence is always `low` — this is a guess at sung words, and `isAuthoritativeText` in
    shared/lyrics.ts uses exactly that to keep it below any real lookup and to make the TV label it. That
    is not in tension with its role: a baseline is untrustworthy about WORDS and trustworthy about WHICH
    RECORDING, which is the opposite of a candidate and precisely why it grades one.

    MEASURED, not assumed (2026-09-02, real stem, `base` on CPU): whisper's `transcribe()` returns
    segment bounds and NO word timings, so this tier reports `line`. Word timings come from the SAME
    forced aligner an LRCLIB lookup goes through — the aligner is not text-source-specific, it upgrades
    any text from line to word.
    """

    name = SOURCE_ASR

    #: Which audio this instance transcribes. 'vocals' needs a cooked stems job; 'mix' never does.
    AUDIO_VOCALS = "vocals"
    AUDIO_MIX = "mix"

    def __init__(self, transcriber: Any, normalize: Any, audio: str = AUDIO_VOCALS) -> None:
        self._transcriber = transcriber
        self._normalize = normalize  # whisperx.normalize_lyrics, injected to avoid an import cycle
        self._audio = audio

    def _audio_path(self, req: LyricsRequest) -> str | None:
        if self._audio == self.AUDIO_MIX:
            return req.audio_path or None
        return req.vocals_path

    def fetch(self, req: LyricsRequest) -> LyricsText | None:
        path = self._audio_path(req)
        if not path:
            # No stem yet (a later align run picks it up), or no retained original. Declining is right:
            # silently transcribing the OTHER audio would make two baselines into one opinion counted
            # twice, which is worse than one honest vote.
            return None
        try:
            raw = self._transcriber.transcribe(path, None)
        except Exception:  # noqa: BLE001 — no model / no network for the weights: a miss, not a failure
            return None
        doc = self._normalize(raw)
        lines = doc.get("lines") or []
        if not lines:
            return None
        # normalize_lyrics already produced the artifact shape; hand back its lines as segments so the
        # timing layer sees word timings that are ALREADY there and keeps them.
        return LyricsText(
            text_source=SOURCE_ASR,
            segments=[
                {"start": l.get("start"), "end": l.get("end"), "text": l.get("text"), "words": l.get("words") or []}
                for l in lines
            ],
            timing=TIMING_WORD if any(l.get("words") for l in lines) else TIMING_LINE,
            text_confidence="low",
            language=doc.get("language"),
            role=ROLE_BASELINE,
            baseline_rank=BASELINE_ASR_MIX if self._audio == self.AUDIO_MIX else BASELINE_ASR_VOCALS,
            tag=self._audio,
            variant=f"whisper/{self._audio}",
        )


class AutoCaptionsSource:
    """YouTube's OWN automatic captions — a BASELINE, never a candidate.

    This is the reversal that the two-tier split earns. Treated as authored text these are actively
    dangerous: they are ASR wearing a caption's clothes, made from the MIXED audio, and accepted as
    "captions" they would be ranked as authoritative and could outrank a correct database lookup. As a
    BASELINE the same text is simply a third opinion on what is audible — which is all it ever was — and
    it is structurally barred from being chosen as the song's words while any candidate exists.

    Weak but real, measured across five uploads: YouTube's ASR suppresses sung vocals into [Music]
    marker cues, so it was absent or near-useless on three of the five (a-ha "Take On Me": 8 words plus
    15 music markers). A baseline that thin cannot reach MIN_TOKENS_TO_COMPARE and therefore ABSTAINS
    rather than dragging the mean down — see `composite_score`. That abstention is what makes including
    a weak baseline safe.
    """

    name = SOURCE_CAPTIONS

    def fetch(self, req: LyricsRequest) -> LyricsText | None:
        if not req.auto_caption_segments:
            return None
        return LyricsText(
            text_source=SOURCE_CAPTIONS,
            segments=list(req.auto_caption_segments),
            timing=TIMING_LINE,
            # `low` is load-bearing, not decorative: it is what makes isAuthoritativeText() false, so
            # even when this is the only text left to show, the TV labels it as auto-transcribed.
            text_confidence="low",
            language=None,
            role=ROLE_BASELINE,
            baseline_rank=BASELINE_CAPTIONS_AUTO,
            tag="auto",
            variant="youtube auto-captions",
        )


def acquire(sources: list[LyricsSource], req: LyricsRequest) -> list[LyricsText]:
    """Run EVERY source and return everything that yielded usable text.

    Not first-hit: the ideal artifact is authoritative text force-aligned to the audio, so an
    authoritative source and ASR are complements, not alternatives. A source that raises is skipped —
    one broken tier must never cost the others.
    """
    out: list[LyricsText] = []
    for s in sources:
        try:
            got = s.fetch(req)
        except Exception:  # noqa: BLE001 — a misbehaving source is a miss, never a job failure
            continue
        if got is not None and got.is_usable():
            out.append(got)
    return out


def candidate_key(media_id: str, text_source: str, timing: str = TIMING_WORD, tag: str | None = None) -> str:
    """Artifact key per (text source, TAG, TIMING TIER), so texts coexist instead of overwriting.

    The single `derived/lyrics/<id>.json` key could hold exactly one answer, which is what forced the
    old "pick one winner" design. One file per source is what makes the upgrade path possible: a
    baseline lands first, LRCLIB is re-tried later, neither clobbers the other.

    The TIMING tier is in the key too, because source alone still allowed a regression WITHIN a source:
    a re-run whose aligner failed would write line-level output over the same key and replace perfectly
    good word timings — the never-regress guarantee held across sources but not within one. Separate
    keys mean the word-level artifact survives on disk and in the candidate set, and `pickBestLyrics`
    keeps choosing it.

    The TAG exists because a source is no longer one text. Two baselines are both `asr` (one reads the
    vocals stem, one the mix) and two caption tiers are both `captions` (one authored, one automatic), so
    without it the second write of a pair would silently destroy the first — and destroy exactly the
    independence that makes averaging baselines worth doing.
    """
    parts = [media_id, text_source] + ([tag] if tag else []) + [timing]
    return f"derived/lyrics/{'-'.join(parts)}.json"


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
    """Words, lowercased, punctuation and [bracket] markers stripped. Compares CONTENT, not form."""
    cleaned = _TOKEN_KEEP.sub(" ", _TOKEN_STRIP.sub(" ", text.lower()))
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
    votes = [s for s in (agreement_score(candidate.plain_text, b.plain_text) for b in baselines) if s is not None]
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
            f"{label or '?'}" + (f" {score:.2f}" if score is not None else " —") for label, score in self.rejected
        )
        return head + (f", over {losers}" if losers else "")


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
            pick = max(range(len(pool)), key=lambda i: (scored[i][0] if scored[i][0] is not None else -1.0, -i))
            decided_by = "agreement"
        else:
            decided_by = "metadata"
        winner, (score, votes) = pool[pick], scored[pick]
        winner.alternates = []  # the choice is made; carrying the losers further would only confuse
        if len(pool) > 1:
            sel.choices.append(
                VariantChoice(
                    text_source=winner.text_source,
                    considered=len(pool),
                    chosen=winner.variant,
                    chosen_score=score,
                    rejected=[(c.variant, s) for i, (c, (s, _)) in enumerate(zip(pool, scored)) if i != pick],
                    decided_by=decided_by,
                    votes=len(votes),
                )
            )
        # Across sources, the same comparison decides. An unjudged candidate (-1.0) never displaces a
        # judged one, and among unjudged candidates the first acquired stands.
        if best is None or (score if score is not None else -1.0) > (best_score if best_score is not None else -1.0):
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
