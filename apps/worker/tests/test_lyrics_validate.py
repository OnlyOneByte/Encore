"""Tests for aligned-timing validation and the LRC-as-guide fit.

The numbers here are the shapes six REAL artifacts exhibited on the reference box while passing the
old `is_valid_lyrics` check, so each test names a defect that actually shipped.
"""

from src.lyrics.validate import (
    LONG_GAP_SEC,
    MIN_COVERAGE,
    SUSPECT_RESIDUAL_SEC,
    fit_lrc_to_aligned,
    line_starts,
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
    # Measured worst case when aligning against the mix: one word held 5.7s. The rest of the song is
    # still correctly timed, so line-level sync would be a worse trade than word timing with one smear.
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
