"""Tests for aligned-timing validation and the LRC-as-guide fit.

The numbers here are the shapes six REAL artifacts exhibited on the reference box while passing the
old `is_valid_lyrics` check, so each test names a defect that actually shipped.
"""

from src.lyrics.validate import (
    LONG_GAP_SEC,
    MIN_COVERAGE,
    MIN_SHIFT_SEC,
    SUSPECT_RESIDUAL_SEC,
    LrcShift,
    estimate_lrc_shift,
    fit_lrc_to_aligned,
    line_starts,
    repair_word_spans,
    shift_segments,
    validate_timing,
)


def doc(words, line_bounds=None):
    """One-line doc from (word, start, end) triples."""
    ws = [{"word": w, "start": s, "end": e} for w, s, e in words]
    start = line_bounds[0] if line_bounds else (ws[0]["start"] if ws else 0.0)
    end = line_bounds[1] if line_bounds else (ws[-1]["end"] if ws else 0.0)
    return {
        "language": "en",
        "lines": [{"text": " ".join(w for w, _, _ in words), "start": start, "end": end, "words": ws}],
    }


def multiline(starts):
    return {
        "language": "en",
        "lines": [{"text": f"l{i}", "start": s, "end": s + 1.0, "words": []} for i, s in enumerate(starts)],
    }


# ── validation ───────────────────────────────────────────────────────────────────────────────────


def test_clean_timing_is_usable():
    d = doc([("Coming", 1.0, 1.3), ("out", 1.3, 1.5), ("of", 1.5, 1.7)])
    rep = validate_timing(d, duration_sec=2.0)
    assert rep.usable
    assert rep.words == 3
    assert not rep.smeared and not rep.flashed and rep.out_of_order == 0


def test_a_smeared_word_is_reported_but_not_disqualifying():
    # Measured worst case when aligning against the mix: one word held 5.7s. validate_timing still
    # DETECTS and REPORTS the smear and still does not disqualify on it (order is the only disqualifier).
    # The repair decision reversed what happens NEXT: the smear is no longer LEFT as-is — repair_word_spans
    # clamps it downstream (see test_repair_clamps_a_smeared_word). Detection lives here; the repair is
    # a separate function so this diagnostic assertion is unchanged.
    d = doc([("ugly", 10.0, 15.71), ("How", 15.8, 16.0), ("can", 16.0, 16.2)])
    rep = validate_timing(d, duration_sec=17.0)
    assert rep.smeared and rep.smeared[0][0] == "ugly"
    assert rep.smeared[0][1] > 5.0
    assert rep.usable  # a defect, not a disqualification


def test_a_flashed_word_is_reported():
    # Measured: "a" at 20ms. Invisible on screen.
    d = doc([("its", 1.0, 1.2), ("a", 1.2, 1.22), ("kiss", 1.25, 1.6)])
    rep = validate_timing(d, duration_sec=2.0)
    assert [w for w, _ in rep.flashed] == ["a"]
    assert rep.usable


def test_a_long_gap_is_reported():
    # Measured: a 63s hole mid-song where a whole verse was dropped.
    d = doc([("ugly", 90.0, 90.2), ("How", 153.4, 153.6)])
    rep = validate_timing(d, duration_sec=225.0)
    assert len(rep.long_gaps) == 1
    gap = rep.long_gaps[0]
    assert gap[1] - gap[0] > LONG_GAP_SEC
    assert "gap(s)" in rep.summary()


def test_out_of_order_words_are_DISQUALIFYING():
    # The highlight would jump backwards. Nothing salvageable about that.
    d = doc([("one", 5.0, 5.5), ("two", 4.0, 4.5)])
    rep = validate_timing(d, duration_sec=10.0)
    assert rep.out_of_order == 1
    assert not rep.usable


# ── repair (act on smears/flashes, do not merely report them) ────────────────────────────────────


def test_repair_clamps_a_smeared_word():
    # "ugly" is held 10.0->15.71 (5.71s). MAX_WORD_SEC is 3.0, so its end must be clamped to
    # 10.0 + 3.0 = 13.0 exactly. Expected value is a hard literal (10.0 + 3.0), NOT re-derived from
    # MAX_WORD_SEC arithmetic on the smear's own numbers.
    d = doc([("ugly", 10.0, 15.71), ("How", 15.8, 16.0), ("can", 16.0, 16.2)])
    report = repair_word_spans(d)
    assert report.changed
    assert [w for w, _ in report.smeared_clamped] == ["ugly"]
    words = d["lines"][0]["words"]
    assert words[0]["end"] == 13.0  # clamped down to start + MAX_WORD_SEC
    assert words[0]["start"] == 10.0  # start never moves
    # the clamp only shrank the span, so it cannot reach "How" at 15.8 — no overlap, no reorder
    assert words[0]["end"] < words[1]["start"]
    # non-smeared words untouched
    assert words[1]["end"] == 16.0 and words[2]["end"] == 16.2


def test_repair_leaves_non_smeared_words_alone():
    d = doc([("Coming", 1.0, 1.3), ("out", 1.3, 1.5), ("of", 1.5, 1.7)])
    report = repair_word_spans(d)
    assert not report.changed
    words = d["lines"][0]["words"]
    assert [w["end"] for w in words] == [1.3, 1.5, 1.7]  # byte-for-byte unchanged


def test_repair_extends_a_flashed_word_when_there_is_room():
    # "a" flashes at 20ms (1.2->1.22). MIN_WORD_SEC is 0.03, so it must extend to 1.2 + 0.03 = 1.23,
    # which is still before "kiss" at 1.25, so there IS room. Hard-literal expectation.
    d = doc([("its", 1.0, 1.2), ("a", 1.2, 1.22), ("kiss", 1.25, 1.6)])
    report = repair_word_spans(d)
    assert [w for w, _ in report.flashed_extended] == ["a"]
    assert not report.flashed_uncorrectable
    words = d["lines"][0]["words"]
    assert words[1]["end"] == 1.23  # extended up to start + MIN_WORD_SEC
    assert words[1]["end"] <= words[2]["start"]  # still no collision with "kiss"


def test_repair_leaves_a_flash_uncorrectable_when_it_would_collide():
    # "a" flashes at 1.20->1.22, but "kiss" starts at 1.225 — extending to 1.23 would overrun it and
    # create a backwards edge. A flash beats an out-of-order jump, so it is LEFT and reported.
    d = doc([("its", 1.0, 1.2), ("a", 1.2, 1.22), ("kiss", 1.225, 1.6)])
    report = repair_word_spans(d)
    assert not report.flashed_extended
    assert [w for w, _ in report.flashed_uncorrectable] == ["a"]
    words = d["lines"][0]["words"]
    assert words[1]["end"] == 1.22  # untouched — no room


def test_repair_never_creates_an_out_of_order_word():
    # A repaired doc must re-validate with zero order violations — the one defect repair must never mint.
    d = doc([("ugly", 10.0, 15.71), ("a", 15.8, 15.82), ("How", 15.83, 16.0)])
    repair_word_spans(d)
    rep = validate_timing(d, duration_sec=17.0)
    assert rep.out_of_order == 0
    assert not rep.smeared  # the 5.71s smear is gone after repair


def test_thin_coverage_is_REPORTED_but_still_published():
    # Refusing on coverage was tried and was wrong: it dropped the ASR candidate entirely and published
    # NOTHING, which is worse than what it prevented. The timed portion is still correctly timed, and
    # line sync over the same partial text freezes in the same place. It is a TRANSCRIPTION gap.
    d = doc([("only", 1.0, 1.5), ("start", 1.5, 2.0)])
    rep = validate_timing(d, duration_sec=200.0)
    assert rep.coverage < MIN_COVERAGE
    assert rep.thin_coverage
    assert rep.usable  # reported, not refused


def test_a_real_outro_still_passes_coverage():
    # Every mix-aligned artifact measured covered 87-96%; the threshold must not reject those.
    d = doc([("last", 1.0, 1.2), ("word", 205.0, 209.3)])
    rep = validate_timing(d, duration_sec=224.0)
    assert rep.coverage > MIN_COVERAGE
    assert not rep.thin_coverage
    assert rep.usable


def test_missing_duration_does_not_fail_the_document():
    # A missing duration is our gap, not the alignment's.
    d = doc([("x", 1.0, 1.2)])
    assert validate_timing(d, duration_sec=None).coverage == 1.0
    assert validate_timing(d, duration_sec=0).usable


def test_an_empty_document_is_not_usable():
    assert not validate_timing({"lines": []}, duration_sec=100.0).usable


# ── the LRC as a guide, not an anchor ────────────────────────────────────────────────────────────


def test_same_recording_fits_with_a_small_residual():
    lrc = [10.0, 20.0, 30.0, 40.0, 50.0]
    aligned = [10.1, 20.05, 29.95, 40.1, 50.0]  # same master, alignment jitter only
    fit = fit_lrc_to_aligned(lrc, aligned)
    assert fit.verdict == "same_version"
    assert fit.residual_sec < SUSPECT_RESIDUAL_SEC


def test_a_pure_offset_is_absorbed_not_flagged():
    # A different upload with a 4s longer intro is the SAME performance. Offset must be fitted away,
    # and the fitted value is a measured display offset rather than a hand-tuned lead.
    lrc = [10.0, 20.0, 30.0, 40.0]
    fit = fit_lrc_to_aligned(lrc, [x + 4.0 for x in lrc])
    assert fit.verdict == "same_version"
    assert abs(fit.offset_sec - 4.0) < 0.01
    assert abs(fit.scale - 1.0) < 0.01


def test_a_tempo_difference_is_absorbed_by_scale():
    # A remaster running 2% faster is still the same lyrics in the same order.
    lrc = [10.0, 20.0, 30.0, 40.0, 50.0]
    fit = fit_lrc_to_aligned(lrc, [x * 1.02 for x in lrc])
    assert fit.verdict == "same_version"
    assert abs(fit.scale - 1.02) < 0.001


def test_a_DIFFERENT_VERSION_is_detected_and_its_timing_discarded():
    # The case that makes hard anchoring unsafe, in its realistic form: the LRC is timed against the
    # studio cut, the audio is a live version with a longer intro AND an inserted solo halfway. That is
    # a STEP in the mapping, and no single offset+scale can absorb a step — which is exactly why the
    # residual, not the fit quality, is what decides trust.
    lrc = [10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0, 80.0, 90.0, 100.0]
    aligned = [x + 8.0 for x in lrc[:5]] + [x + 28.0 for x in lrc[5:]]  # +20s solo after line 5
    fit = fit_lrc_to_aligned(lrc, aligned)
    assert fit.verdict == "different_version"  # keep the aligner's timing, drop the LRC's
    assert fit.residual_sec > SUSPECT_RESIDUAL_SEC


def test_one_bad_REGION_is_localised_rather_than_condemning_the_song():
    # Residual fine everywhere except one span -> that span is where alignment failed. This is how the
    # 63s hole gets caught automatically instead of by forensics.
    lrc = [10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0]
    aligned = [10.0, 20.0, 30.0, 95.0, 50.0, 60.0, 70.0]  # line 3 landed 55s late
    fit = fit_lrc_to_aligned(lrc, aligned)
    assert fit.verdict == "same_version"  # the song as a whole still matches
    assert 3 in fit.outlier_lines  # but that line is called out


def test_a_median_residual_means_one_bad_line_cannot_condemn_the_song():
    # Deliberately contrasts with the mean: a single 55s outlier would drag a mean past the threshold
    # and mislabel a matching recording as the wrong version.
    lrc = [10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0]
    aligned = [10.0, 20.0, 30.0, 95.0, 50.0, 60.0, 70.0]
    assert fit_lrc_to_aligned(lrc, aligned).residual_sec < SUSPECT_RESIDUAL_SEC


def test_mismatched_line_counts_are_inconclusive_not_a_forced_fit():
    # Different line counts mean the two texts are not the same lyrics; pretending otherwise would
    # pair line 5 against line 9 and invent a scale.
    fit = fit_lrc_to_aligned([1.0, 2.0, 3.0], [1.0, 2.0])
    assert fit.verdict == "inconclusive"


def test_too_few_lines_to_fit_two_parameters_is_inconclusive():
    assert fit_lrc_to_aligned([1.0, 2.0], [1.0, 2.0]).verdict == "inconclusive"


def test_degenerate_lrc_all_same_timestamp_is_inconclusive():
    assert fit_lrc_to_aligned([5.0, 5.0, 5.0, 5.0], [1.0, 2.0, 3.0, 4.0]).verdict == "inconclusive"


def test_line_starts_reads_both_doc_shapes():
    assert line_starts(multiline([1.0, 2.0])) == [1.0, 2.0]
    assert line_starts({"segments": [{"start": 3.0}, {"start": 4.0}]}) == [3.0, 4.0]


# ── overshoot: lyrics timed PAST the end of the audio ──────────────────────────────────────
#
# The clamp at validate.py:161 makes `coverage` one-sided: under-coverage shows, over-coverage reads as
# a flawless 1.0. These pin the OTHER side as its own number, `overshoot_sec`, leaving coverage's clamp
# and its thin/MIN_COVERAGE meaning untouched. MECHANISM: coverage stays clamped to 1.0 while
# overshoot_sec carries the seconds past audio-end — proven on the real +105.8s Total Eclipse shape.


def test_lyrics_timed_past_audio_end_report_overshoot_while_coverage_stays_clamped():
    """The real Bonnie Tyler case in miniature: last word ends well past duration.

    On base this test does not exist because TimingReport has no `overshoot_sec` field — the signal is
    computed one character before it could be used (min(1.0, …)) and thrown away. Coverage MUST stay
    clamped at 1.0 (the two are different questions); overshoot MUST be the positive seconds past the end.
    """
    d = doc([("last", 260.0, 373.8)])  # duration 268s, last_end 373.8s -> +105.8s, coverage clamps to 1.0
    rep = validate_timing(d, duration_sec=268.0)
    assert rep.coverage == 1.0, "coverage MUST remain clamped — merging overshoot into it breaks its meaning"
    assert rep.overshoot_sec > 0, "lyrics running past audio-end MUST surface as positive overshoot"
    assert abs(rep.overshoot_sec - 105.8) < 1e-6


def test_lyrics_within_the_audio_have_zero_overshoot():
    d = doc([("in", 1.0, 1.3), ("bounds", 1.3, 1.9)])
    rep = validate_timing(d, duration_sec=200.0)
    assert rep.overshoot_sec == 0.0


def test_overshoot_is_zero_when_duration_is_unknown():
    """Same fail-open policy as coverage: without a length we cannot judge, so it is 0.0, not a guess."""
    d = doc([("late", 400.0, 500.0)])
    assert validate_timing(d, duration_sec=None).overshoot_sec == 0.0
    assert validate_timing(d, duration_sec=0).overshoot_sec == 0.0


def test_overshoot_is_named_in_the_summary():
    d = doc([("late", 260.0, 373.8)])
    rep = validate_timing(d, duration_sec=268.0)
    assert "OVERSHOOT" in rep.summary()
    assert "+106s" in rep.summary()


# ── placing the LRC on THIS audio's timeline BEFORE aligning ───────────────────────────────────────


def _lrc(*pairs):
    """LRC lines as [{start, end, text}]. Each pair is (start, text)."""
    return [{"start": s, "end": s + 2.0, "text": t} for s, t in pairs]


# A verse the LRC and a rough Whisper baseline both roughly agree on, line for line.
_L1, _L2, _L3, _L4 = (
    "white shirt now red my bloody nose",
    "sleeping you're on your tippy toes",
    "creeping around like no one knows",
    "think you're so criminal",
)


def test_estimate_lrc_shift_measures_a_late_vocal_and_flags_it_applied():
    """`bad guy`'s shape: the LRC master starts 2.5s BEFORE this upload's vocal (a quiet pre-section).
    The baseline heard the same four lines 2.5s later on the real audio. The estimator must recover
    +2.5s and mark it worth applying."""
    lrc = _lrc((1.0, _L1), (4.0, _L2), (7.0, _L3), (10.0, _L4))
    baseline = [
        {"start": s + 2.5, "end": s + 4.5, "text": t}
        for s, t in ((1.0, _L1), (4.0, _L2), (7.0, _L3), (10.0, _L4))
    ]
    sh = estimate_lrc_shift(lrc, baseline)
    assert sh.applied
    assert sh.pairs >= 3
    assert abs(sh.offset_sec - 2.5) < 0.2, sh.offset_sec


def test_estimate_lrc_shift_pairs_FUZZILY_when_the_baseline_misheard_words():
    """The baseline is Whisper's GUESS, so exact-text pairing (what the post-align fit uses) would
    match nothing. A few misheard words per line must still pair to the right LRC line by token
    overlap, so the shift is still measured."""
    lrc = _lrc((1.0, _L1), (4.0, _L2), (7.0, _L3), (10.0, _L4))
    # each baseline line mishears ~one word but keeps the rest, and sits +2.0s late
    baseline = [
        {"start": 3.0, "end": 5.0, "text": "white shirt now read my bloody nose"},
        {"start": 6.0, "end": 8.0, "text": "sleeping you are on your tippy toes"},
        {"start": 9.0, "end": 11.0, "text": "creeping around like no won knows"},
        {"start": 12.0, "end": 14.0, "text": "think your so criminal"},
    ]
    sh = estimate_lrc_shift(lrc, baseline)
    assert sh.applied
    assert abs(sh.offset_sec - 2.0) < 0.3, sh.offset_sec


def test_estimate_lrc_shift_is_a_noop_when_the_lrc_is_already_placed():
    """A song already on this audio's timeline (offset within noise) must NOT be perturbed —
    `applied` is False so the caller leaves the windows untouched."""
    lrc = _lrc((1.0, _L1), (4.0, _L2), (7.0, _L3), (10.0, _L4))
    baseline = [
        {"start": s + 0.05, "end": s + 2.05, "text": t}
        for s, t in ((1.0, _L1), (4.0, _L2), (7.0, _L3), (10.0, _L4))
    ]
    sh = estimate_lrc_shift(lrc, baseline)
    assert not sh.applied
    assert abs(sh.offset_sec) < MIN_SHIFT_SEC


def test_estimate_lrc_shift_abstains_with_no_baseline():
    """No baseline spoke -> nothing to measure against -> abstain, never a fabricated shift."""
    lrc = _lrc((1.0, _L1), (4.0, _L2), (7.0, _L3), (10.0, _L4))
    sh = estimate_lrc_shift(lrc, [])
    assert not sh.applied
    assert sh.offset_sec == 0.0
    assert sh.pairs == 0


def test_estimate_lrc_shift_abstains_when_too_few_lines_pair():
    """Only one line overlaps the baseline — below the pairs floor, so two parameters cannot be fit
    robustly and the estimator abstains rather than trusting a single point."""
    lrc = _lrc((1.0, _L1), (4.0, _L2), (7.0, _L3))
    baseline = [
        {"start": 6.0, "end": 8.0, "text": _L2},
        {"start": 20.0, "end": 22.0, "text": "totally unrelated words here"},
    ]
    sh = estimate_lrc_shift(lrc, baseline)
    assert not sh.applied


def test_estimate_lrc_shift_does_not_pair_a_line_to_an_unrelated_baseline_line():
    """A verse line whose baseline counterpart was never heard must not pair onto some unrelated
    baseline line just to have a match — that would inject a garbage point into the fit. Here only
    three of four LRC lines have a real baseline; the fourth baseline line is unrelated noise, and the
    fit should rest on the three good pairs (offset +2.0s), not be dragged by the fourth."""
    lrc = _lrc((1.0, _L1), (4.0, _L2), (7.0, _L3), (10.0, _L4))
    baseline = [
        {"start": 3.0, "end": 5.0, "text": _L1},
        {"start": 6.0, "end": 8.0, "text": _L2},
        {"start": 9.0, "end": 11.0, "text": _L3},
        {"start": 40.0, "end": 42.0, "text": "advertisement jingle buy now today"},
    ]
    sh = estimate_lrc_shift(lrc, baseline)
    assert sh.applied
    assert abs(sh.offset_sec - 2.0) < 0.3, sh.offset_sec


def test_shift_segments_applies_the_affine_model_without_mutating_the_source():
    src = [{"start": 1.0, "end": 3.0, "text": "a"}, {"start": 5.0, "end": 7.0, "text": "b"}]
    sh = estimate_lrc_shift(
        _lrc((1.0, _L1), (4.0, _L2), (7.0, _L3), (10.0, _L4)),
        [
            {"start": s + 2.5, "end": s + 4.5, "text": t}
            for s, t in ((1.0, _L1), (4.0, _L2), (7.0, _L3), (10.0, _L4))
        ],
    )
    out = shift_segments(src, sh)
    assert out[0]["start"] > src[0]["start"]  # moved later
    assert src[0]["start"] == 1.0  # original untouched — line-sync fallback still publishes it verbatim
    assert out[0]["text"] == "a"  # text preserved


def test_shift_segments_is_a_copy_noop_for_an_unapplied_shift():
    src = [{"start": 1.0, "end": 3.0, "text": "a"}]
    out = shift_segments(src, LrcShift())  # applied == False
    assert out == src
    assert out is not src  # a copy, so a later mutation cannot reach the source
