"""Pre-splitting auto-transcribed blob text into lyric-sized lines, before the length bounder runs.

PURE: the upstream length-bounder is injected, so every case here runs with no karaoke-lyrics-processor
installed and no network. One test exercises the real package when it IS present, and skips otherwise.
"""

import re
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.lyrics import presplit as lp  # noqa: E402
from src.lyrics.chain import (  # noqa: E402
    MIN_TOKENS_TO_COMPARE,
    SOURCE_ASR,
    SOURCE_CAPTIONS,
    SOURCE_LRCLIB,
    SUSPECT_COVERAGE,
    TIMING_LINE,
    TIMING_WORD,
    LyricsText,
    is_authoritative_text,
)

# ── the TypeScript authority ─────────────────────────────────────────────────────────
# The four values below are declared TWICE — once in TypeScript (the authority) and once in
# Python (a hand-kept mirror; see the docstrings at chain.py:80 and chain.py:431). Nothing but
# these tests keeps the copies in step. So they must read the TS SOURCE and cross-check the Python
# constant against what the authority ACTUALLY declares today — asserting a Python literal only
# proves Python equals itself, and every TS-side drift (the normal way any of these changes) stays
# green on both suites. These read the .ts files as text (no node/tsc): a source-scan guard whose
# production truth is the file it parses, so it cannot be defeated by reverting a hunk.
_REPO = Path(__file__).resolve().parents[3]
_TV_LYRICS_TS = _REPO / "apps" / "core" / "src" / "lib" / "tv" / "lyrics.ts"
_SHARED_LYRICS_TS = _REPO / "packages" / "shared" / "src" / "lyrics" / "lyrics.ts"


def _ts_number(src_path: Path, name: str) -> float:
    """Extract the numeric literal an `export const <name> = <n>;` declares in a .ts file."""
    text = src_path.read_text(encoding="utf-8")
    m = re.search(rf"export const {re.escape(name)}\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*;", text)
    assert m, f"could not find `export const {name} = <number>;` in {src_path.name}"
    return float(m.group(1))


def _ts_is_authoritative(text_source: str, text_confidence: str) -> bool:
    """Evaluate the TS `isAuthoritativeText` body against Python inputs by parsing its two guards.

    Parses `return c.textSource !== '<x>' && c.textConfidence !== '<y>';` and reconstructs the
    boolean, so a change to EITHER operand or the shape of the expression reds this test.
    """
    text = _SHARED_LYRICS_TS.read_text(encoding="utf-8")
    body = re.search(
        r"export function isAuthoritativeText\([^)]*\)\s*:\s*boolean\s*\{\s*"
        r"return\s+c\.textSource\s*!==\s*'([^']+)'\s*&&\s*c\.textConfidence\s*!==\s*'([^']+)'\s*;\s*\}",
        text,
    )
    assert body, (
        "isAuthoritativeText in packages/shared/src/lyrics/lyrics.ts no longer matches the mirrored shape "
        "`c.textSource !== '<x>' && c.textConfidence !== '<y>'` — the Python mirror in chain.py must "
        "be updated to match the new definition and this parser taught the new shape"
    )
    forbidden_source, forbidden_confidence = body.group(1), body.group(2)
    return text_source != forbidden_source and text_confidence != forbidden_confidence


# A synthetic one-line blob, shaped like what whisper `transcribe()` returns: several lyric lines run
# together. Original text, not a real song.
BLOB = (
    "I walked the empty harbour road, until the morning came around, and every light behind me "
    "faded out. So tell me where the river goes, when all the bridges burn."
)


def passthrough(lines, max_chars):
    """A bounder that bounds nothing — isolates OUR boundary logic from upstream's."""
    return lines


# ── the gate: only auto-transcribed text is touched ──────────────────────────────────
def test_is_authoritative_text_mirrors_the_ts_predicate():
    # Cross-check the Python mirror against the TS AUTHORITY's actual body, not against literals.
    # Every combination the two axes can take (source in {lrclib, captions, asr} × confidence in
    # {high, medium, low}) must give the SAME answer on both sides, so tightening OR loosening the
    # TS predicate reds this test.
    for source in (SOURCE_LRCLIB, SOURCE_CAPTIONS, SOURCE_ASR):
        for confidence in ("high", "medium", "low"):
            assert is_authoritative_text(source, confidence) == _ts_is_authoritative(source, confidence), (
                f"Python is_authoritative_text disagrees with the TS authority for "
                f"source={source!r}, confidence={confidence!r} — the two have drifted"
            )
    # And the known-truth rows still hold, so a bug that broke BOTH sides identically is still caught.
    assert is_authoritative_text(SOURCE_LRCLIB, "high")
    assert is_authoritative_text(SOURCE_CAPTIONS, "medium")  # a real human caption track
    assert not is_authoritative_text(SOURCE_ASR, "high")  # ASR is never authoritative, however sure
    assert not is_authoritative_text(SOURCE_CAPTIONS, "low")  # auto-captions: ASR wearing a caption hat


def test_agreement_thresholds_mirror_the_ts_authority():
    # MIN_TOKENS_TO_COMPARE / SUSPECT_COVERAGE are declared authoritative in packages/shared/src/
    # lyrics.ts (chain.py calls itself their mirror) but nothing cross-checked them. Read the TS
    # values and assert the Python copies equal them, so a threshold change on the authority side reds.
    # SUSPECT_COVERAGE replaced SUSPECT_AGREEMENT — a different metric on a different axis, so
    # the constant was renamed rather than re-valued. tests/test_lyrics_agreement_542.py carries the
    # behavioural half of that parity guard (a shared corpus both suites assert against).
    assert MIN_TOKENS_TO_COMPARE == _ts_number(_SHARED_LYRICS_TS, "MIN_TOKENS_TO_COMPARE")
    assert SUSPECT_COVERAGE == _ts_number(_SHARED_LYRICS_TS, "SUSPECT_COVERAGE")


def bound_only(lines, max_chars):
    """A length-only bounder: bisect any line wider than the budget at a word boundary, greedily.

    Stands in for upstream (`karaoke-lyrics-processor`) in the pure tests — it BOUNDS by length and
    does nothing else, which is exactly the job the authoritative tier is meant to get. It has none of
    boundary_split's comma/opener/sentence rules, so if a re-lineation shows up in the output it can
    only have come from boundary_split, not from here.
    """
    out = []
    for line in lines:
        while len(line) > max_chars:
            cut = line.rfind(" ", 0, max_chars + 1)
            if cut <= 0:
                break
            out.append(line[:cut])
            line = line[cut + 1 :]
        out.append(line)
    return out


# A short authoritative line and a long one on their own segments. The long one is a single human lyric
# line that overflows a TV row; the short one already fits.
LONG_AUTHORITATIVE = "and I will wait right here for you until the very last light goes out tonight"


def test_presplit_length_bounds_authoritative_text_INTO_ALIGNER_WINDOWS_not_segments():
    # THE fix started length-bounding LRCLIB synced/plain text (before it, only the display-time
    # LINE_MAX_CHARS fallback caught an over-long human line). that bounding must NOT rewrite the
    # source's own line timings. An over-long authoritative line yields tight per-row ALIGNER WINDOWS
    # (`align_windows`) while `segments` stay the human lines verbatim — because the line-sync fallback
    # publishes `segments` as `high`, and a character-count-derived boundary shipped there is a
    # fabricated timestamp masquerading as the source's own.
    seg = [{"start": 0.0, "end": 8.0, "text": LONG_AUTHORITATIVE, "words": []}]
    lrclib = LyricsText(text_source=SOURCE_LRCLIB, segments=seg, timing=TIMING_LINE, text_confidence="high")
    out = lp.presplit_texts([lrclib], bounder=bound_only)
    # segments: the source's own line, un-subdivided, timing untouched
    assert len(out[0].segments) == 1
    assert out[0].segments[0]["text"] == LONG_AUTHORITATIVE
    assert (out[0].segments[0]["start"], out[0].segments[0]["end"]) == (0.0, 8.0)
    # align_windows: the bounded per-row search hints for the forced aligner
    assert out[0].align_windows is not None
    assert len(out[0].align_windows) > 1
    assert all(len(w["text"]) <= lp.MAX_LINE_CHARS for w in out[0].align_windows)


def test_line_sync_publishes_the_authoritative_source_OWN_timings_not_a_char_count_guess():
    # THE regression. The line-sync fallback publishes `line_synced_lyrics(text.segments)` as
    # timingConfidence "high" ("the source's own timings, unmodified"). If presplit subdivides an
    # over-long authoritative line, the interior boundary it invents is `start + (chars/total)*span`
    # — a character count, not a timestamp — and it ships as the human source's own. This pins that
    # the boundaries published for a bounded authoritative text are EXACTLY the source's own line
    # starts, no invented interior boundary between them.
    from src.lyrics.source import line_synced_lyrics

    over_long = "I walked the empty harbour road until the very morning came around again"  # > MAX_LINE_CHARS
    assert len(over_long) > lp.MAX_LINE_CHARS
    seg = [
        {"start": 10.0, "end": 34.0, "text": over_long, "words": []},
        {"start": 34.0, "end": 38.0, "text": "and every light behind me faded out", "words": []},
    ]
    lrclib = LyricsText(text_source=SOURCE_LRCLIB, segments=seg, timing=TIMING_LINE, text_confidence="high")
    out = lp.presplit_texts([lrclib], bounder=bound_only)
    doc = line_synced_lyrics(out[0].segments)
    published_starts = [line["start"] for line in doc["lines"]]
    # The source authored exactly two lines at 10.0 and 34.0; nothing between them was invented.
    assert published_starts == [10.0, 34.0]
    # No published boundary sits strictly inside the first line's [10, 34] window — that is exactly
    # where a proportional-char subdivision guess would land (the bug published ~[10, 23.9, 34]).
    assert not any(10.0 < s < 34.0 for s in published_starts)
    # The aligner still gets tight windows to search — the bounded pieces are not lost, only rerouted.
    assert out[0].align_windows is not None and len(out[0].align_windows) > 1


def test_presplit_does_NOT_run_the_semantic_splitter_on_authoritative_text():
    # The guard the issue asks for: length bounding runs on every tier, but the semantic re-lineator
    # (comma/opener/sentence rules) must NOT touch human-authored lines. With a bounder that bounds
    # nothing, an authoritative line FULL of boundary_split triggers (commas, ", and", a capital
    # opener) still comes back as ONE segment — proof boundary_split never ran. The same text on the
    # ASR tier is shredded into its clauses (asserted below), so the fence is doing real work.
    rich = "I walked the harbour road, and every light faded. So tell me where it goes"
    assert len(lp.boundary_split(rich)) > 1  # boundary_split WOULD split this
    seg = [{"start": 0.0, "end": 8.0, "text": rich, "words": []}]
    lrclib = LyricsText(
        text_source=SOURCE_LRCLIB, segments=list(seg), timing=TIMING_LINE, text_confidence="high"
    )
    out = lp.presplit_texts([lrclib], bounder=passthrough)
    assert len(out[0].segments) == 1
    assert out[0].segments[0]["text"] == rich  # verbatim: not re-lineated
    # and the SAME text on the auto-transcribed tier IS re-lineated — the fence, not luck
    asr = LyricsText(text_source=SOURCE_ASR, segments=list(seg), timing=TIMING_LINE, text_confidence="low")
    asr_out = lp.presplit_texts([asr], bounder=passthrough)
    assert len(asr_out[0].segments) > 1


def test_presplit_leaves_an_already_short_authoritative_line_as_the_same_object():
    # A human line that already fits a row is not touched — bound_blob_text returns the SAME segment
    # object when the line maps to one piece, so provenance and identity are preserved.
    seg = {"start": 0.0, "end": 4.0, "text": "and I will wait for you", "words": []}
    lrclib = LyricsText(text_source=SOURCE_LRCLIB, segments=[seg], timing=TIMING_LINE, text_confidence="high")
    out = lp.presplit_texts([lrclib], bounder=bound_only)
    assert out[0].segments == [seg]


def test_bound_blob_text_preserves_provenance_and_does_not_mutate_input():
    seg = [{"start": 0.0, "end": 8.0, "text": LONG_AUTHORITATIVE, "words": []}]
    lrclib = LyricsText(
        text_source=SOURCE_LRCLIB, segments=seg, timing=TIMING_LINE, text_confidence="high", language="en"
    )
    out = lp.bound_blob_text(lrclib, bounder=bound_only)
    assert len(lrclib.segments) == 1  # input untouched
    assert (out.text_source, out.timing, out.text_confidence, out.language) == (
        SOURCE_LRCLIB,
        TIMING_LINE,
        "high",
        "en",
    )


def test_bound_blob_text_passes_a_WORD_TIMED_authoritative_segment_through_whole():
    # A synced LRC line that already carries word timings must not be re-partitioned: splitting the
    # text would orphan the timings from the words. Same guard split_blob_text has, shared via
    # _relineate_segments.
    seg = {
        "start": 0.0,
        "end": 8.0,
        "text": LONG_AUTHORITATIVE,
        "words": [{"word": "and", "start": 0.0, "end": 0.2}],
    }
    lrclib = LyricsText(text_source=SOURCE_LRCLIB, segments=[seg], timing=TIMING_WORD, text_confidence="high")
    assert lp.bound_blob_text(lrclib, bounder=bound_only).segments == [seg]


def test_presplit_splits_asr_and_low_confidence_captions():
    seg = [{"start": 0.0, "end": 8.0, "text": BLOB, "words": []}]
    asr = LyricsText(text_source=SOURCE_ASR, segments=list(seg), timing=TIMING_LINE, text_confidence="low")
    auto_caps = LyricsText(
        text_source=SOURCE_CAPTIONS, segments=list(seg), timing=TIMING_LINE, text_confidence="low"
    )
    out = lp.presplit_texts([asr, auto_caps], bounder=passthrough)
    assert len(out[0].segments) > 1
    assert len(out[1].segments) > 1


# ── boundary_split: the half upstream measurably gets wrong ──────────────────────────
def test_splits_on_a_sentence_boundary():
    # upstream never does this at all — it produced "never made a sound. So tell me"
    assert lp.boundary_split("faded out. So tell me where it goes.") == [
        "faded out.",
        "So tell me where it goes.",
    ]


def test_breaks_BEFORE_a_conjunction_keeping_the_comma_behind():
    # THE upstream defect: it split after the comma, gluing "and" onto the previous line's tail.
    assert lp.boundary_split("until the morning came around, and every light faded") == [
        "until the morning came around,",
        "and every light faded",
    ]


@pytest.mark.parametrize("conj", ["and", "but", "so", "then", "or", "because", "'cause", "And", "BUT"])
def test_the_conjunction_set_is_case_insensitive(conj):
    assert lp.boundary_split(f"the bridges burn down tonight, {conj} I will wait for you") == [
        "the bridges burn down tonight,",
        f"{conj} I will wait for you",
    ]


def test_a_BARE_comma_is_SPENT_ONLY_on_a_line_that_does_not_fit():
    # A comma is weaker evidence than a sentence end or an opener, so it buys a break only where there
    # is a problem to solve. MEASURED on 171 real over-long ASR lines: using it took the share fully
    # resolved with no bisection from 3% to 47%. Whisper puts commas at breath boundaries in sung
    # vocals, so on real transcripts it usually IS the lyric line break.
    fits = "I walked the harbour road, alone"
    assert lp.boundary_split(fits) == [fits]  # 32 chars — one row, leave it whole
    assert lp.boundary_split("I walked the empty harbour road, until the morning came around again") == [
        "I walked the empty harbour road,",
        "until the morning came around again",
    ]


# ── capitalisation as a boundary (whisper marks phrase starts with case) ─────────────
def test_a_capitalised_OPENER_breaks_a_line_that_has_no_punctuation_at_all():
    # Real corpus shape: whisper omitted every comma but still capitalised each phrase start.
    assert lp.boundary_split("Don't you know I still believe That you will be here") == [
        "Don't you know",
        "I still believe",
        "That you will be here",
    ]


def test_a_capitalised_PROPER_NOUN_is_not_a_boundary():
    # Why `_LINE_OPENERS` is a closed set: splitting every lowercase->Capital transition would break
    # these two real-corpus lines mid-phrase. Neither "Africa" nor "London" opens a lyric line.
    assert lp.boundary_split("I bless the rains down in Africa tonight") == [
        "I bless the rains down in Africa tonight"
    ]
    assert lp.boundary_split("look me first rest to my fancy house in London town") == [
        "look me first rest to my fancy house in London town"
    ]


# ── coalescing fragments too short to hold a row ─────────────────────────────────────
def test_a_STRANDED_fragment_is_folded_into_the_phrase_it_opens():
    # Two individually-reasonable rules firing in sequence (", but" then a capital "I") stranded
    # "but still" on a 9-char row of its own, with "I lose my mind" beneath it.
    assert lp.boundary_split("I must confess, but still I lose my mind") == [
        "I must confess,",
        "but still I lose my mind",
    ]


def test_coalescing_never_reaches_across_a_full_STOP():
    # "faded out." is short but it is a real lyric line; gluing it to the next sentence because the pair
    # happens to fit would be a worse read, so coalescing is scoped per sentence.
    assert lp.boundary_split("faded out. So tell me where it goes.") == [
        "faded out.",
        "So tell me where it goes.",
    ]


def test_a_fragment_with_nowhere_to_fit_is_KEPT_not_dropped():
    # Neither neighbour can absorb it without blowing the row budget. Keeping a short row beats
    # deleting words from the screen.
    out = lp.boundary_split("I need to know right now this very moment. Oh. Tell me all about it please")
    assert "Oh." in out


def test_conservative_when_there_is_nothing_unambiguous_to_split_on():
    # Exactly the unpunctuated shape whisper returns. We add nothing; length bounding is upstream's job.
    line = "i walked the empty harbour road until the morning came around"
    assert lp.boundary_split(line) == [line]


def test_a_decimal_point_is_not_a_sentence_end():
    assert lp.boundary_split("we waited 3.5 hours") == ["we waited 3.5 hours"]


def test_empty_and_whitespace_yield_nothing():
    assert lp.boundary_split("") == []
    assert lp.boundary_split("   \n  ") == []


def test_the_full_blob_lands_on_its_real_lyric_lines():
    # Every break here is a true lyric boundary, and every line fits a row without upstream bisecting
    # anything — which is the whole point of doing the semantic pass BEFORE the length bounder.
    out = lp.boundary_split(BLOB)
    assert out == [
        "I walked the empty harbour road,",
        "until the morning came around,",
        "and every light behind me faded out.",
        "So tell me where the river goes,",
        "when all the bridges burn.",
    ]
    assert all(len(ln) <= lp.MAX_LINE_CHARS for ln in out)


# ── timing subdivision ───────────────────────────────────────────────────────────────
def test_subdivided_bounds_are_ordered_and_span_exactly_the_original_window():
    asr = LyricsText(
        text_source=SOURCE_ASR,
        segments=[{"start": 10.0, "end": 20.0, "text": BLOB, "words": []}],
        timing=TIMING_LINE,
        text_confidence="low",
    )
    segs = lp.split_blob_text(asr, bounder=passthrough).segments
    assert len(segs) == 5
    assert segs[0]["start"] == 10.0
    assert segs[-1]["end"] == 20.0  # no drift: the pieces tile the original window
    for a, b in zip(segs, segs[1:], strict=False):
        assert a["end"] <= b["start"]  # contiguous and monotonic
        assert a["start"] < a["end"]


def test_a_segment_with_no_numeric_bounds_keeps_its_missing_bounds():
    asr = LyricsText(
        text_source=SOURCE_ASR,
        segments=[{"text": BLOB, "words": []}],
        timing=TIMING_LINE,
        text_confidence="low",
    )
    segs = lp.split_blob_text(asr, bounder=passthrough).segments
    assert len(segs) == 5
    assert all(s["start"] is None and s["end"] is None for s in segs)


def test_a_WORD_TIMED_segment_is_passed_through_whole():
    # Splitting the text would orphan the word timings from the words they belong to. Measured: whisper
    # transcribe() returns no word timings, so this is a guard against a case that shouldn't arise.
    seg = {"start": 0.0, "end": 8.0, "text": BLOB, "words": [{"word": "I", "start": 0.0, "end": 0.2}]}
    asr = LyricsText(text_source=SOURCE_ASR, segments=[seg], timing=TIMING_WORD, text_confidence="low")
    assert lp.split_blob_text(asr, bounder=passthrough).segments == [seg]


def test_an_unsplittable_segment_is_left_as_the_SAME_object():
    seg = {"start": 0.0, "end": 4.0, "text": "i walked the empty harbour road", "words": []}
    asr = LyricsText(text_source=SOURCE_ASR, segments=[seg], timing=TIMING_LINE, text_confidence="low")
    assert lp.split_blob_text(asr, bounder=passthrough).segments == [seg]


def test_split_does_not_mutate_its_input_and_preserves_provenance():
    seg = [{"start": 0.0, "end": 8.0, "text": BLOB, "words": []}]
    asr = LyricsText(
        text_source=SOURCE_ASR, segments=seg, timing=TIMING_LINE, text_confidence="low", language="en"
    )
    out = lp.split_blob_text(asr, bounder=passthrough)
    assert len(asr.segments) == 1  # input untouched
    assert (out.text_source, out.timing, out.text_confidence, out.language) == (
        SOURCE_ASR,
        TIMING_LINE,  # subdividing line-timed segments yields line-timed segments — still true
        "low",
        "en",
    )


# ── the upstream seam ────────────────────────────────────────────────────────────────
def test_the_bounder_receives_the_boundary_split_pieces_and_the_char_budget():
    seen = {}

    def spy(lines, max_chars):
        seen["lines"], seen["max_chars"] = lines, max_chars
        return lines

    asr = LyricsText(
        text_source=SOURCE_ASR,
        segments=[{"start": 0.0, "end": 8.0, "text": BLOB, "words": []}],
        timing=TIMING_LINE,
        text_confidence="low",
    )
    lp.split_blob_text(asr, max_chars=42, bounder=spy)
    assert seen["max_chars"] == 42
    assert seen["lines"] == lp.boundary_split(BLOB)


def test_a_bounder_that_splits_further_is_honoured():
    asr = LyricsText(
        text_source=SOURCE_ASR,
        segments=[{"start": 0.0, "end": 6.0, "text": "one. two.", "words": []}],
        timing=TIMING_LINE,
        text_confidence="low",
    )
    out = lp.split_blob_text(asr, bounder=lambda lines, _m: [w for ln in lines for w in ln.split()])
    assert [s["text"] for s in out.segments] == ["one.", "two."]


def test_bound_lines_is_a_NO_OP_when_upstream_is_absent(monkeypatch):
    # The dependency is genuinely optional: the boundary split still ran, and the TV's LINE_MAX_CHARS
    # fallback still bounds a row. A missing package must not cost us the lineation we can do ourselves.
    monkeypatch.setattr(lp, "_KLP", None)
    lines = ["a line that upstream would otherwise have to bound because it is rather long indeed"]
    assert lp.bound_lines(lines) == lines


def test_a_raising_upstream_degrades_to_the_unbounded_lines(monkeypatch):
    class Exploding:
        def __init__(self, **_kw):
            raise RuntimeError("upstream changed its constructor")

    monkeypatch.setattr(lp, "_KLP", Exploding)
    assert lp.bound_lines(["some text"]) == ["some text"]


def test_max_line_chars_mirrors_the_tv_row_width():
    # LINE_MAX_CHARS in apps/core/src/lib/tv/lyrics.ts is the authority (the TV row width the worker
    # bounds cook-time lines to). Read it from the TS source and assert the worker constant equals it,
    # so narrowing the TV row on the authority side reds here instead of silently re-splitting at
    # display time. Explicitly NOT upstream's default of 36.
    assert lp.MAX_LINE_CHARS == _ts_number(_TV_LYRICS_TS, "LINE_MAX_CHARS")


# ── the real package, when installed ─────────────────────────────────────────────────
def test_real_upstream_bounds_an_over_long_line_and_isolates_parentheses():
    if lp._load_klp() is None:
        pytest.skip("karaoke-lyrics-processor is not installed (installed --no-deps in the image)")
    lines = lp.bound_lines(["and I will wait right here for you at seventeen (ooh, ooh)"], 42)
    assert all(len(ln) <= 42 for ln in lines)
    assert "(ooh, ooh)" in lines  # nested-paren isolation is the half upstream does well
    # and the handler it attaches to its module logger does not accumulate across calls
    import logging

    lp.bound_lines(["another line"], 42)
    assert len(logging.getLogger("karaoke_lyrics_processor.karaoke_lyrics_processor").handlers) == 0


# A second over-long human line, distinct from LONG_AUTHORITATIVE, to stand in as a losing LRCLIB
# version attached as an alternate. Both overflow a TV row (len > MAX_LINE_CHARS = 42).
LONG_ALTERNATE = "so hold my hand and don't you ever let it go no matter what the morning brings us now"


def test_presplit_bounds_a_candidates_ALTERNATES_not_just_the_top_level_246():
    # THE fix. presplit runs BEFORE select_by_baselines, which grades `[cand, *cand.alternates]`
    # and may publish an alternate (a normal two-tier outcome — the version that best matches what was
    # heard wins). presplit_texts used to map over the top-level list only, so an alternate winner
    # reached the aligner with align_windows=None — the whole song then re-split by display-time
    # char count, the exact fallback the length bounds exist to avoid. The fence must run on alternates too.
    assert len(LONG_ALTERNATE) > lp.MAX_LINE_CHARS  # the fixture actually overflows a row
    cand = LyricsText(
        text_source=SOURCE_LRCLIB,
        segments=[{"start": 10.0, "end": 40.0, "text": LONG_AUTHORITATIVE, "words": []}],
        timing=TIMING_LINE,
        text_confidence="high",
    )
    alt = LyricsText(
        text_source=SOURCE_LRCLIB,
        segments=[{"start": 10.0, "end": 40.0, "text": LONG_ALTERNATE, "words": []}],
        timing=TIMING_LINE,
        text_confidence="high",
    )
    cand.alternates = [alt]

    out = lp.presplit_texts([cand], bounder=bound_only)

    # Top-level still bounded (proves the run did the ordinary work).
    assert out[0].align_windows is not None and len(out[0].align_windows) > 1
    # THE BITE: the alternate is bounded too. On base this is None (the alternate is never visited),
    # so these three assertions all fail there.
    assert len(out[0].alternates) == 1
    alt_out = out[0].alternates[0]
    assert alt_out.align_windows is not None
    assert len(alt_out.align_windows) > 1
    assert all(len(w["text"]) <= lp.MAX_LINE_CHARS for w in alt_out.align_windows)
    # The alternate's own segments stay the source's verbatim line (bounding produces windows, not a
    # segment rewrite — same invariant as the top-level).
    assert len(alt_out.segments) == 1
    assert alt_out.segments[0]["text"] == LONG_ALTERNATE
    # And the fence is a fresh object, not the untouched input alternate.
    assert alt_out is not alt


def test_presplit_leaves_a_SHORT_alternate_unwindowed_246():
    # The fence is honest, not blanket: an alternate whose line already fits a row gets align_windows
    # left None, exactly as a short top-level text would. This pins that we route alternates through
    # the SAME fence (which no-ops on short/authoritative text) rather than force-bounding them.
    short = "a short line that fits"
    assert len(short) <= lp.MAX_LINE_CHARS
    cand = LyricsText(
        text_source=SOURCE_LRCLIB,
        segments=[{"start": 0.0, "end": 4.0, "text": short, "words": []}],
        timing=TIMING_LINE,
        text_confidence="high",
    )
    alt = LyricsText(
        text_source=SOURCE_LRCLIB,
        segments=[{"start": 0.0, "end": 4.0, "text": short, "words": []}],
        timing=TIMING_LINE,
        text_confidence="high",
    )
    cand.alternates = [alt]

    out = lp.presplit_texts([cand], bounder=bound_only)

    assert out[0].align_windows is None
    assert out[0].alternates[0].align_windows is None


# ── absent / broken / no-op must be THREE distinguishable observations, not one ────────────
#
# The defect: `_load_klp` cached `_KLP = None` on ANY failure with no report, so "package absent",
# "stub broke on import" and "no line was over-long" (a legitimate no-op of a WORKING package) all
# looked identical to an operator — the same "a dead provider looks like a song with no lyrics"
# conflation an earlier change killed for LRCLIB. klp is installed --no-deps on the deploy box and absent on the
# dev box, so a regression on deploy would look exactly like the always-absent dev box. The fix keeps
# the three facts distinct in `klp_status()` and reports one at startup via `klp_probe_line()`.


def _reset_klp_cache(monkeypatch):
    """Force the next `_load_klp` to re-probe from scratch (the import is cached across the run)."""
    monkeypatch.setattr(lp, "_KLP", lp._UNSET)
    monkeypatch.setattr(lp, "_KLP_STATUS", None)
    monkeypatch.setattr(lp, "_KLP_DETAIL", "")


def test_klp_status_ABSENT_when_the_package_is_not_installed(monkeypatch):
    # find_spec says None AND the import raises ModuleNotFoundError -> not installed. This is the
    # normal dev-box state and an EXPECTED degrade, not a fault.
    _reset_klp_cache(monkeypatch)
    monkeypatch.setattr(lp.importlib.util, "find_spec", lambda _name: None)
    monkeypatch.delitem(sys.modules, "karaoke_lyrics_processor", raising=False)

    assert lp._load_klp() is None
    status, detail = lp.klp_status()
    assert status == "absent"
    assert "not installed" in detail


def test_klp_status_BROKEN_when_installed_but_the_import_raises(monkeypatch):
    # find_spec finds it (installed) but importing raises (a shim/version regression). This is the
    # one an operator MUST be able to see, because on base it is indistinguishable from "absent".
    _reset_klp_cache(monkeypatch)
    # Pretend the package IS installed...
    monkeypatch.setattr(lp.importlib.util, "find_spec", lambda _name: object())

    # ...but importing it raises. A module object whose attribute access raises makes
    # `from karaoke_lyrics_processor import KaraokeLyricsProcessor` fail at the attribute bind.
    class _Broken(types.ModuleType):
        def __getattr__(self, _n):
            raise ImportError("stub broke: KaraokeLyricsProcessor renamed upstream")

    monkeypatch.setitem(sys.modules, "karaoke_lyrics_processor", _Broken("karaoke_lyrics_processor"))

    assert lp._load_klp() is None
    status, detail = lp.klp_status()
    assert status == "broken"
    assert "failed to import" in detail


def test_klp_status_AVAILABLE_when_it_imports(monkeypatch):
    # find_spec finds it and the class imports -> available. bound_lines will actually run.
    _reset_klp_cache(monkeypatch)
    monkeypatch.setattr(lp.importlib.util, "find_spec", lambda _name: object())

    class _KLPClass:
        def __init__(self, **_kw):
            raise AssertionError("not instantiated in this test")

    fake = types.ModuleType("karaoke_lyrics_processor")
    fake.KaraokeLyricsProcessor = _KLPClass  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "karaoke_lyrics_processor", fake)

    assert lp._load_klp() is _KLPClass
    status, _detail = lp.klp_status()
    assert status == "available"


def test_the_three_klp_outcomes_are_ALL_DISTINGUISHABLE(monkeypatch):
    # THE BITE in one place: absent, broken and available must yield three DIFFERENT status
    # strings. On base there is no klp_status at all (the three collapse to one silent `None`), so
    # this fails at import; with the fix the set has exactly three members.
    def _status_for(*, spec, module):
        _reset_klp_cache(monkeypatch)
        monkeypatch.setattr(lp.importlib.util, "find_spec", lambda _n: spec)
        if module is None:
            monkeypatch.delitem(sys.modules, "karaoke_lyrics_processor", raising=False)
        else:
            monkeypatch.setitem(sys.modules, "karaoke_lyrics_processor", module)
        return lp.klp_status()[0]

    class _Broken(types.ModuleType):
        def __getattr__(self, _n):
            raise ImportError("boom")

    good = types.ModuleType("karaoke_lyrics_processor")
    good.KaraokeLyricsProcessor = type("K", (), {})  # type: ignore[attr-defined]

    absent = _status_for(spec=None, module=None)
    broken = _status_for(spec=object(), module=_Broken("karaoke_lyrics_processor"))
    available = _status_for(spec=object(), module=good)

    assert {absent, broken, available} == {"absent", "broken", "available"}


def test_klp_probe_line_names_the_resolved_state(monkeypatch):
    # The startup line an operator reads (wired into dial_home._run_forever next to the other probed
    # lines). It must carry the resolved status word, not a bare "disabled".
    _reset_klp_cache(monkeypatch)
    monkeypatch.setattr(lp.importlib.util, "find_spec", lambda _name: None)
    monkeypatch.delitem(sys.modules, "karaoke_lyrics_processor", raising=False)

    line = lp.klp_probe_line()
    assert "karaoke-lyrics-processor" in line
    assert "absent" in line


def test_bound_blob_text_emits_align_window_opens_mapping_each_segment_to_its_opening_window():
    # presplit KNOWS the segment->window map as it subdivides, so it emits `align_window_opens`
    # (the index of each human segment's OPENING window) beside `align_windows`. The consumer then uses
    # this exact map instead of re-deriving it by float-equality on window starts — a re-derivation that
    # strands every later line the moment one start fails to match to 1e-6.
    segs, t = [], 0.0
    for i in range(4):
        txt = f"a very long human authored karaoke lyric line that overflows a tv row number {i} here"
        segs.append({"start": round(t, 3), "end": round(t + 18.0, 3), "text": txt, "words": []})
        t += 18.0
    text = LyricsText(text_source=SOURCE_LRCLIB, segments=segs, timing=TIMING_LINE, text_confidence="high")
    out = lp.bound_blob_text(text, max_chars=42, bounder=bound_only)
    assert out.align_windows is not None and len(out.align_windows) > len(out.segments)
    assert out.align_window_opens is not None
    # one open per human segment...
    assert len(out.align_window_opens) == len(out.segments)
    # ...strictly increasing, first at 0, and each opening window's start equals its segment's start
    # (the opening window is the one carrying the source's own timestamp).
    assert out.align_window_opens[0] == 0
    assert out.align_window_opens == sorted(out.align_window_opens)
    for seg_i, win_i in enumerate(out.align_window_opens):
        assert out.align_windows[win_i]["start"] == segs[seg_i]["start"]


def test_bound_blob_text_leaves_opens_None_when_no_line_overflows():
    # When nothing overflows a row, align_windows is None (the aligner searches segments as-is), so the
    # opens map is None too — there are no windows to index into.
    seg = {"start": 0.0, "end": 4.0, "text": "and I will wait for you", "words": []}
    lrclib = LyricsText(text_source=SOURCE_LRCLIB, segments=[seg], timing=TIMING_LINE, text_confidence="high")
    out = lp.bound_blob_text(lrclib, bounder=bound_only)
    assert out.align_windows is None
    assert out.align_window_opens is None
