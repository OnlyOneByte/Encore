"""The E2E alignment bench harness (`docs/benchmarks/forced-alignment/scripts/e2e.py` + `e2e_lib.py`).

WHY THE BENCH HAS UNIT TESTS. It is the GATE every later alignment wave is accepted or rejected by, so a
defect in it moves every verdict at once — silently, because a wrong metric still prints a plausible
number. Measured once already: the review's scratch harness paired lines by text, which mis-pairs a
repeated chorus whenever a line is dropped, and seeded jitter with the process-salted `hash(slug)`, which
made its jit row unrepeatable. Both are pinned here.

Hermetic: no model, no corpus. The claim/metric/cache half is plain data; the driver runs the REAL
`AlignStepsImpl.time_text` over a synthetic song with a fake aligner and a spreading decoder, which is
what proves the harness drives the shipped path and pairs its output by identity. The `run_align` level
runs the REAL workflow the same way, including the policy's retries (an H2 mix swap, the LINE_SYNC ->
NextText -> ASR -> GiveUp ladder), and the gate language is pinned on the reject-if forms the plan uses.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import math
import os
import random
import sys
import zlib
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any

import numpy as np
import pytest
import soundfile as sf

from encore_worker.adapters import ports

SCRIPTS = Path(__file__).resolve().parents[2] / "docs" / "benchmarks" / "forced-alignment" / "scripts"


def _load(name: str) -> ModuleType:
    """A bench script as a module. Registered BEFORE exec: dataclasses resolve their module by name."""
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


lib: Any = _load("e2e_lib")
gates: Any = _load("e2e_gates")
e2e: Any = _load("e2e")
sheet_gate: Any = _load("sheet_gate")
line_gate: Any = _load("line_gate")
lift_gate: Any = _load("lift_gate")
unsung_gate: Any = _load("unsung_gate")


def song_of(
    lines: Sequence[tuple[str, float, float]],
    *,
    slug: str = "song",
    group: str = "jamendo",
    words: Sequence[tuple[float, float]] | None = None,
    audio: Path = Path("/nonexistent.wav"),
    mix: Path | None = None,
) -> Any:
    """One corpus song. `audio` is its stem AND its mix, unless `mix` names another file — which only the
    stemless tests need, since there the two are aligned on differently (`e2e.py --no-stem`)."""
    return lib.Song(
        slug=slug,
        group=group,
        mix=audio if mix is None else mix,
        vocals=audio,
        truth=tuple(lib.TruthLine(text, start, end) for text, start, end in lines),
        words=None if words is None else tuple(lib.TruthWord(s, e) for s, e in words),
    )


TEN = [(f"line number {i}", 10.0 * i + 1.0, 10.0 * i + 4.0) for i in range(10)]


def claims(song: Any, mode: str, corpus: Sequence[Any] = (), **kw: Any) -> Any:
    return lib.build_claims(song, mode, corpus=list(corpus) or [song], duration_sec=200.0, **kw)


# ── modes ────────────────────────────────────────────────────────────────────────────────────────────


def test_modes_apply_in_canonical_order_whatever_the_spelling() -> None:
    """`blind` strips LAST and injections precede timing noise, so `jit+headers` jitters the headers."""
    assert lib.parse_mode("truth") == ()
    assert lib.parse_mode("blind+jit+off15+tempo098+headers+drop20+wrongtext") == (
        "wrongtext",
        "drop20",
        "headers",
        "tempo098",
        "off15",
        "jit",
        "blind",
    )
    with pytest.raises(ValueError, match="unknown"):
        lib.parse_mode("jit+bogus")
    with pytest.raises(ValueError, match="repeats"):
        lib.parse_mode("jit+jit")
    assert lib.variants_of("wrongtext", 7) == 7 and lib.variants_of("jit+off15", 7) == 1
    assert set(lib.ALL_MODES) - {"truth"} <= set(lib.OPS)


def test_truth_claims_are_the_truth_verbatim_and_blind_carries_no_timings() -> None:
    song = song_of(TEN)
    truth = claims(song, "truth")
    assert truth.timed and truth.label == "lrc"
    assert [(c.text, c.start, c.end, c.truth) for c in truth.lines] == [
        (t.text, t.start, t.end, i) for i, t in enumerate(song.truth)
    ]
    assert truth.segments()[0] == {"text": "line number 0", "start": 1.0, "end": 4.0}
    blind = claims(song, "blind")
    assert not blind.timed and blind.label == "plain"
    assert all(set(segment) == {"text"} for segment in blind.segments())


def test_offsets_and_tempo_are_exact_and_clamp_at_zero() -> None:
    """e2e2 built `start + 1.5` and `max(0, start - 1)` — byte-parity of the documents depends on it."""
    song = song_of([("early", 0.4, 1.0), *TEN])
    late = claims(song, "off15")
    assert [c.start for c in late.lines] == [t.start + 1.5 for t in song.truth]
    early = claims(song, "offm1")
    assert early.lines[0].start == 0.0 and early.lines[0].end == 0.0
    assert early.lines[1].start == song.truth[1].start - 1.0
    fast = claims(song, "tempo102")
    assert [c.end for c in fast.lines] == [t.end * 1.02 for t in song.truth]


def test_jitter_is_one_stable_draw_per_line() -> None:
    """Stable ACROSS PROCESSES: crc32, not the salted `hash(slug)` that made e2e2's jit row unrepeatable."""
    assert lib.rng_for(0, "hello", "jit", 0).random() == 0.4367466748625257
    assert zlib.crc32(b"0|hello|jit|0") == 2879322332
    song = song_of(TEN, slug="hello")
    got = claims(song, "jit")
    draws = random.Random(zlib.crc32(b"0|hello|jit|0"))
    for claim, truth in zip(got.lines, song.truth, strict=True):
        delta = draws.gauss(0.0, lib.JITTER_SEC)
        assert claim.start == truth.start + delta and claim.end == truth.end + delta
    assert claims(song, "jit").lines == got.lines
    assert claims(song, "jit", seed=1).lines != got.lines


def test_a_partial_sheet_loses_lines_from_the_text_and_the_timings() -> None:
    song = song_of(TEN)
    kept = claims(song, "drop20")
    assert len(kept.lines) == 8 and len(kept.truth_indexes()) == 8
    for claim in kept.lines:
        assert (claim.text, claim.start) == (song.truth[claim.truth].text, song.truth[claim.truth].start)
    assert len(claims(song, "drop50").lines) == 5


def test_an_extra_verse_is_another_songs_lines_in_the_largest_claim_free_gap() -> None:
    song = song_of([("a", 0.0, 2.0), ("b", 3.0, 5.0), ("c", 6.0, 8.0), ("d", 30.0, 32.0)], slug="me")
    donor = song_of([(f"donor {i}", 50.0 + 3 * i, 52.0 + 3 * i) for i in range(8)], slug="donor")
    got = lib.build_claims(song, "extraverse", corpus=[song, donor], duration_sec=40.0)
    assert got.donor == "donor"
    injected = [c for c in got.lines if c.truth is None]
    assert len(injected) == lib.EXTRA_VERSE_LINES
    assert [c.truth for c in got.lines] == [0, 1, 2, *([None] * 6), 3], "inserted between c and d"
    assert all(8.0 < c.start < c.end < 30.0 for c in injected)
    gaps = [b.start - a.end for a, b in zip(injected, injected[1:], strict=False)]
    assert all(g == pytest.approx(1.0) for g in gaps), "the donor's own rhythm is kept"


def test_headers_label_sections_in_all_three_real_shapes() -> None:
    song = song_of(
        [
            ("one", 0.0, 1.0),
            ("two", 1.0, 2.0),
            ("the hook", 5.0, 6.0),
            ("more", 6.0, 7.0),
            ("verse three", 10.0, 11.0),
            ("x", 11.0, 12.0),
            ("the hook", 15.0, 16.0),
            ("y", 16.0, 17.0),
        ]
    )
    got = claims(song, "headers")
    assert [(c.text, c.truth, c.lead_words) for c in got.lines] == [
        ("[Verse 1]", None, 0),
        ("one", 0, 0),
        ("two", 1, 0),
        ("Chorus:", None, 0),
        ("the hook", 2, 0),
        ("more", 3, 0),
        ("VERSE 2: verse three", 4, 2),
        ("x", 5, 0),
        ("[Chorus]", None, 0),
        ("the hook", 6, 0),
        ("y", 7, 0),
    ]
    header = got.lines[3]
    assert (header.start, header.end) == (4.0, 5.0), "a timed header sits just before its section"


def test_a_credit_line_is_claimed_from_zero_to_the_first_line() -> None:
    got = claims(song_of(TEN), "credit")
    assert got.lines[0].truth is None and got.lines[0].text in lib.CREDIT_LINES
    assert (got.lines[0].start, got.lines[0].end) == (0.0, 1.0)
    assert [c.truth for c in got.lines[1:]] == list(range(10))


def test_wrong_text_cross_pairs_are_k_distinct_other_songs() -> None:
    corpus = [song_of(TEN, slug=f"s{i}") for i in range(6)]
    donors = [claims(corpus[0], "wrongtext", corpus, variant=v, wrong_k=4).donor for v in range(4)]
    assert len(set(donors)) == 4 and "s0" not in donors
    first = claims(corpus[0], "wrongtext", corpus, variant=0, wrong_k=4)
    assert first.truth_indexes() == set() and first.timed


def test_own_clock_puts_another_songs_words_on_this_songs_caption_clock() -> None:
    """`wrongtext+ownclock` (W1 review r2): the same-video wrong-words case a caption track of THIS video in
    other words presents (a translation). Every truth line keeps its own span and takes the donor's line in
    the same position, cycling a shorter donor; the donor is the plain wrongtext case's, and no line pairs."""
    corpus = [
        song_of(TEN, slug="s0"),
        song_of([("other words", 0.5, 2.0), ("more of them", 3.0, 5.0)], slug="s1"),
    ]
    assert lib.parse_mode("ownclock+wrongtext") == ("wrongtext", "ownclock")
    got = claims(corpus[0], "wrongtext+ownclock", corpus, variant=0, wrong_k=1)
    plain = claims(corpus[0], "wrongtext", corpus, variant=0, wrong_k=1)
    assert got.donor == plain.donor == "s1"
    assert [(c.start, c.end) for c in got.lines] == [(s, e) for _t, s, e in TEN], "this song's own clock"
    assert [c.text for c in got.lines] == ["other words", "more of them"] * 5
    assert got.truth_indexes() == set() and got.timed
    assert lib.variants_of("wrongtext+ownclock", 4) == 4, "a wrong-text mode: K cross-pairs"
    alone = claims(corpus[0], "ownclock")
    assert [(c.text, c.start, c.end, c.truth) for c in alone.lines] == [
        (c.text, c.start, c.end, c.truth) for c in claims(corpus[0], "truth").lines
    ], "alone it is the identity"


# ── pairing and metrics ──────────────────────────────────────────────────────────────────────────────


def line(source: int | None, start: float, *, confidence: str | None = "high", words: Any = ()) -> Any:
    return lib.DocLine(
        text="", start=start, end=start + 1.0, confidence=confidence, source=source, words=words
    )


def test_identity_pairing_survives_a_dropped_repeat_that_text_pairing_mispairs() -> None:
    """The aligner dropped the FIRST chorus: e2e2's text pairing binds the survivor to it (+10 s error)."""
    song = song_of([("verse", 0.0, 1.0), ("chorus", 10.0, 11.0), ("chorus", 20.0, 21.0), ("end", 30.0, 31.0)])
    got = claims(song, "truth")
    doc = [
        lib.DocLine("verse", 0.0, 1.0, "high", 0),
        lib.DocLine("chorus", 20.0, 21.0, "low", 2),
        lib.DocLine("end", 30.0, 31.0, "high", 3),
    ]
    errors, disagreements = lib.score_lines(song, got, doc)
    assert [(e.truth, e.error) for e in errors] == [(0, 0.0), (2, 0.0), (3, 0.0)]
    assert disagreements == 1
    assert lib.legacy_pairs([d.text for d in doc], [t.text for t in song.truth]) == {0: 0, 1: 1, 2: 3}


def test_injected_lines_are_never_scored() -> None:
    song = song_of(TEN)
    got = claims(song, "credit")
    doc = [line(i, c.start + 0.1) for i, c in enumerate(got.lines)]
    errors, disagreements = lib.score_lines(song, got, doc)
    assert [e.truth for e in errors] == list(range(10))
    assert disagreements is None, "e2e2's text pairing does not apply to a perturbed text"


def test_text_pairing_fallback_follows_the_claimed_order() -> None:
    assert lib.pair_by_text(["a", "b", "a"], ["a", "x", "b", "a", "a"]) == [0, 2, 3]
    assert lib.pair_by_text(["zzz"], ["a"]) == [None]


def test_word_scores_follow_bench_py() -> None:
    """Aligned words only; a line whose word count moved is skipped whole; header words are skipped."""
    song = song_of(
        [("one two", 0.0, 2.0), ("three four", 3.0, 5.0), ("five", 6.0, 7.0)],
        words=[(0.0, 0.5), (1.0, 1.5), (3.0, 3.5), (4.0, 4.5), (6.0, 6.5)],
    )
    got = claims(song, "truth")
    got = lib.Claims(
        lines=(
            got.lines[0],
            lib.ClaimLine("CHORUS: three four", 3.0, 5.0, truth=1, lead_words=1),
            got.lines[2],
        ),
        timed=True,
    )
    doc = [
        line(0, 0.0, words=(lib.DocWord(0.05, 0.4, True), lib.DocWord(1.0, 1.4, False))),
        line(
            1,
            2.5,
            words=(lib.DocWord(2.5, 2.9, True), lib.DocWord(3.2, 3.4, True), lib.DocWord(6.5, 7, True)),
        ),
        line(2, 6.0, words=(lib.DocWord(6.0, 6.2, True), lib.DocWord(6.3, 6.4, True))),
    ]
    score = lib.score_words(song, got, doc)
    assert score.errors == pytest.approx((0.05, 0.2, 2.5))
    assert (score.in_text, score.interpolated, score.mismatched) == (5, 1, 1)
    row = lib.row_of(song=song, mode="truth", variant=0, claims=got, outcome=lib.PUBLISHED, doc=doc)
    words = lib.word_metrics([row])
    assert words["aligned"] == 3 and words["gross"] == 1
    assert words["w250_pct"] == pytest.approx(66.67) and words["pco300_pct"] == pytest.approx(40.0)
    assert words["medae_ms"] == pytest.approx(200.0) and words["bias_ms"] == pytest.approx(200.0)


def test_line_metrics_keep_e2e2s_definitions() -> None:
    """Gross is STRICTLY > 2 s, the tolerances are inclusive, and a refusal adds no line to e2e2's
    percentages — but every line of its text counts as missing, and as a miss over the text."""
    song = song_of(TEN)
    got = claims(song, "truth")
    errors = [0.5, 0.5000001, 2.0, 2.1, -1.0, 0.0, 0.0, 0.0, 0.0, 0.0]
    doc = [
        line(i, song.truth[i].start + err, confidence="high" if i < 4 else "low")
        for i, err in enumerate(errors)
    ]
    published = lib.row_of(song=song, mode="truth", variant=0, claims=got, outcome=lib.PUBLISHED, doc=doc)
    refused = lib.row_of(song=song, mode="truth", variant=0, claims=got, outcome=lib.REFUSED, doc=[])
    metrics = lib.line_metrics([published, refused])
    assert (metrics["scored"], metrics["gross"], metrics["w500"], metrics["w1000"]) == (10, 1, 6, 8)
    assert (metrics["high"], metrics["high_bad"], metrics["high_gross"]) == (4, 3, 1)
    assert (metrics["published"], metrics["refused"], metrics["zero_gross_songs"]) == (1, 1, 0)
    assert metrics["w500_pct"] == 60.0 and metrics["missing"] == 10
    assert (metrics["in_text"], metrics["w500_text_pct"], metrics["w1000_text_pct"]) == (20, 30.0, 40.0)


def test_the_summary_reports_jamendo_and_youtube_apart_and_together() -> None:
    jam = song_of(TEN, slug="j")
    yt = song_of(TEN, slug="y", group="youtube")
    rows = []
    for song, err in ((jam, 0.1), (yt, 3.0)):
        got = claims(song, "truth")
        doc = [line(i, t.start + err) for i, t in enumerate(song.truth)]
        rows.append(
            lib.row_of(song=song, mode="truth", variant=0, claims=got, outcome=lib.PUBLISHED, doc=doc)
        )
    for variant, outcome in enumerate((lib.PUBLISHED, lib.REFUSED, lib.REFUSED)):
        got = claims(jam, "wrongtext", [jam, yt], variant=variant, wrong_k=3)
        rows.append(
            lib.row_of(song=jam, mode="wrongtext", variant=variant, claims=got, outcome=outcome, doc=[])
        )
    summary = lib.summarize(rows)
    assert summary["truth"]["jamendo"]["lines"]["gross"] == 0
    assert summary["truth"]["youtube"]["lines"]["gross"] == 10
    assert summary["truth"]["all"]["lines"]["scored"] == 20
    assert summary["wrongtext"]["all"]["wrongtext"] == {
        "pairs": 3,
        "published": 1,
        "errors": 0,
        "pass_rate_pct": 33.33,
    }
    table = lib.format_summary(summary)
    assert "== truth" in table and "wrong-text pass rate 1/3" in table


# ── the emissions cache ──────────────────────────────────────────────────────────────────────────────


def test_the_emission_store_round_trips_and_misses_on_any_key_change(tmp_path: Path) -> None:
    audio = tmp_path / "vocals.wav"
    audio.write_bytes(b"RIFF....")
    store = lib.EmissionStore(tmp_path / "_emissions", model="M", emitter="e1")
    matrix = np.random.default_rng(0).normal(size=(50, 29)).astype(np.float32)
    assert store.load(str(audio), "en") is None
    store.save(str(audio), "en", matrix, {"frame_sec": 0.02, "dictionary": {"a": 1}}, produced_on="mps")
    loaded, meta = store.load(str(audio), "en")
    assert loaded.dtype == np.float32 and np.array_equal(loaded, matrix)
    assert meta["fields"] == {"frame_sec": 0.02, "dictionary": {"a": 1}} and meta["produced_on"] == "mps"
    assert store.load(str(audio), "fr") is None
    assert lib.EmissionStore(store.directory, model="other", emitter="e1").load(str(audio), "en") is None
    assert lib.EmissionStore(store.directory, model="M", emitter="e2").load(str(audio), "en") is None
    stat = os.stat(audio)
    os.utime(audio, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))
    assert store.load(str(audio), "en") is None, "a rewritten stem must not reuse the old matrix (M10)"
    assert not list(store.directory.glob("*.tmp")), "writes are atomic"


def test_the_emitter_fingerprint_moves_with_the_code_and_the_libraries(tmp_path: Path) -> None:
    source = tmp_path / "ml.py"
    source.write_text("a = 1\n")
    first = lib.emitter_fingerprint([source], {"torch": "2.8.0"})
    assert first == lib.emitter_fingerprint([source], {"torch": "2.8.0"})
    assert first != lib.emitter_fingerprint([source], {"torch": "2.9.0"})
    source.write_text("a = 2\n")
    assert first != lib.emitter_fingerprint([source], {"torch": "2.8.0"})


def test_the_bench_aligner_serves_memory_then_disk_and_never_recomputes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from encore_worker.adapters import ml

    audio = tmp_path / "vocals.wav"
    audio.write_bytes(b"RIFF....")
    computed: list[str] = []

    def fresh(self: Any, audio_path: str, language: str) -> ml.Emissions:
        computed.append(audio_path)
        return ml.Emissions(
            log_probs=np.full((40, 29), -1.5, np.float32), frame_sec=0.02, dictionary={"a": 1}
        )

    monkeypatch.setattr(ml.WhisperXAligner, "emissions", fresh)
    store = lib.EmissionStore(tmp_path / "_emissions", model="M", emitter="e")

    def same(_language: str) -> str:
        return "w1"

    first = e2e.BenchAligner(device="cpu", store=store, identify=same)
    one = first.emissions(str(audio), "en")
    assert first.emissions(str(audio), "en") is one
    second = e2e.BenchAligner(device="cpu", store=store, identify=same)
    two = second.emissions(str(audio), "en")
    assert len(computed) == 1 and dict(first.served) == {"computed": 1, "memory": 1}
    assert dict(second.served) == {"disk": 1} and second.identities == {"en": "w1"}
    assert np.array_equal(two.log_probs, one.log_probs) and two.frame_sec == one.frame_sec
    assert two.dictionary == one.dictionary
    refresh = e2e.BenchAligner(device="cpu", store=store, read=False, write="always", identify=same)
    refresh.emissions(str(audio), "en")
    assert len(computed) == 2 and dict(refresh.served) == {"computed": 1}


def test_the_cache_is_keyed_on_the_model_the_aligner_loaded_not_on_its_label(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Review r1: the key's model part used to be the harness's GUESS (`--model`, else whisperx's static
    default table). An adapter that picks its model another way (an env knob, a per-device default) or a
    Hub checkpoint that moves would then be served the OLD model's matrices under the same label."""
    from encore_worker.adapters import ml

    audio = tmp_path / "vocals.wav"
    audio.write_bytes(b"RIFF....")
    computed: list[str] = []

    def fresh(self: Any, audio_path: str, language: str) -> ml.Emissions:
        computed.append(audio_path)
        return ml.Emissions(log_probs=np.zeros((4, 3), np.float32), frame_sec=0.02, dictionary={"a": 1})

    monkeypatch.setattr(ml.WhisperXAligner, "emissions", fresh)
    store = lib.EmissionStore(tmp_path / "_emissions", model="WAV2VEC2_ASR_BASE_960H", emitter="e")
    e2e.BenchAligner(device="cpu", store=store, identify=lambda _l: "base").emissions(str(audio), "en")
    moved = e2e.BenchAligner(device="cpu", store=store, identify=lambda _l: "large")
    moved.emissions(str(audio), "en")
    assert len(computed) == 2 and dict(moved.served) == {"computed": 1}, "same label, other weights: a miss"
    assert moved.store_for("en").model == "WAV2VEC2_ASR_BASE_960H@large"


def test_the_loaded_identity_digests_the_weights_and_the_dictionary(monkeypatch: pytest.MonkeyPatch) -> None:
    torch = pytest.importorskip("torch")

    class Tiny(torch.nn.Module):  # type: ignore[misc, name-defined]
        def __init__(self, bias: float) -> None:
            super().__init__()
            self.head = torch.nn.Linear(2, 3)
            with torch.no_grad():
                self.head.weight.fill_(0.5)
                self.head.bias.fill_(bias)

    loaded: dict[str, tuple[Any, dict[str, Any]]] = {
        "a": (Tiny(0.0), {"type": "torchaudio", "dictionary": {"a": 1}}),
        "b": (Tiny(0.1), {"type": "torchaudio", "dictionary": {"a": 1}}),
        "c": (Tiny(0.0), {"type": "torchaudio", "dictionary": {"a": 2}}),
        "d": (Tiny(0.0), {"type": "torchaudio", "dictionary": {"a": 1}}),
    }
    monkeypatch.setattr(e2e.BenchAligner, "_aligner", lambda _self, language: loaded[language])
    identity = e2e.BenchAligner(device="cpu").loaded_identity
    assert identity("a") == identity("d"), "equal weights and dictionary: one identity"
    assert len({identity("a"), identity("b"), identity("c")}) == 3, "a weight or a label id moves it"


def test_the_emitter_fingerprint_names_ffmpeg_and_transformers(monkeypatch: pytest.MonkeyPatch) -> None:
    """Review r1: `load_audio` decodes and resamples through the PATH ffmpeg, and transformers runs any
    Hub checkpoint; neither was in the key, so an upgrade of either served stale matrices."""
    monkeypatch.setattr(e2e.shutil, "which", lambda _name: None)
    versions = e2e.emitter_versions()
    assert set(versions) == {"torch", "torchaudio", "whisperx", "transformers", "ffmpeg"}
    assert versions["ffmpeg"] == "absent"
    from encore_worker.host import ffmpeg

    monkeypatch.setattr(e2e.shutil, "which", lambda _name: "/opt/ffmpeg")
    monkeypatch.setattr(ffmpeg, "probe_version", lambda _binary: "ffmpeg version 7.1")
    assert e2e.emitter_versions(("torch",)) == {"torch": versions["torch"], "ffmpeg": "ffmpeg version 7.1"}


def test_the_model_override_loads_the_named_bundle_and_leaves_the_default_alone(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`--model` is the review harness's override: the named torchaudio bundle, cached under its own key."""
    from encore_worker.adapters import ml

    calls: list[dict[str, object]] = []

    def load_align_model(**kw: object) -> tuple[str, dict[str, object]]:
        calls.append(kw)
        return "model", {"dictionary": {}}

    monkeypatch.setitem(sys.modules, "whisperx", ModuleType("whisperx"))
    monkeypatch.setattr(sys.modules["whisperx"], "load_align_model", load_align_model, raising=False)
    monkeypatch.setattr(ml, "_MODELS", {})
    aligner = e2e.BenchAligner(device="cpu", model="HUBERT_ASR_LARGE")
    assert aligner._aligner("en") == ("model", {"dictionary": {}})
    assert aligner._aligner("en") == ("model", {"dictionary": {}})
    assert calls == [{"language_code": "en", "device": "cpu", "model_name": "HUBERT_ASR_LARGE"}]
    assert set(ml._MODELS) == {("cpu", "align:en:HUBERT_ASR_LARGE")}


# ── the driver, through the REAL time_text ───────────────────────────────────────────────────────────

RATE = 16000
FRAME = 0.02
DIC = {ch: i + 1 for i, ch in enumerate("abcdefghijklmnopqrstuvwxyz'")}
PHRASES = [
    ("come and fly away", 5.0, 7.0),
    ("with me tonight", 8.0, 10.0),
    ("over the silver water", 12.0, 14.5),
    ("carry me home", 16.0, 18.0),
    ("come and fly away", 22.0, 24.0),
    ("stars are out", 25.5, 27.5),
    ("morning light across the river", 30.0, 33.0),
    ("come and fly away", 35.0, 37.0),
]
DURATION = 40.0


@dataclass(frozen=True)
class VoicedEmissions:
    """One float per frame: 1.0 where a phrase is sung. The spreading decoder reads it as occupancy."""

    log_probs: list[float]
    frame_sec: float
    dictionary: dict[str, int]

    @property
    def frames(self) -> int:
        return len(self.log_probs)


class VoicedAligner:
    """An `Aligner` whose emissions say only WHERE singing is — the decode below does the rest."""

    def emissions(self, _path: str, _language: str) -> VoicedEmissions:
        voiced = [0.0] * int(DURATION / FRAME)
        for _text, start, end in PHRASES:
            for frame in range(int(start / FRAME), int(end / FRAME)):
                voiced[frame] = 1.0
        return VoicedEmissions(log_probs=voiced, frame_sec=FRAME, dictionary=DIC)

    def align(self, *_a: object, **_k: object) -> tuple[()]:
        raise AssertionError("the global path must not fall back to the windowed aligner")


def spreading_decoder(
    log_probs: Sequence[float], targets: Sequence[int], blank: int = 0
) -> tuple[list[int], list[float]]:
    """Any text, any window: one frame per target, spread evenly over the voiced frames (all, if too few).

    Unlike a decoder scripted to one fixed text, this serves partial sheets, injected headers and the
    repair ladder's window slices — which is what the harness's modes produce.
    """
    frames = [f for f, value in enumerate(log_probs) if value > 0]
    if len(frames) < 2 * len(targets):
        frames = list(range(len(log_probs)))
    labels = [blank] * len(log_probs)
    for i, token in enumerate(targets):
        labels[frames[int((i + 0.5) * len(frames) / len(targets))]] = token
    return labels, [-0.4] * len(log_probs)


def spread_decodes(monkeypatch: pytest.MonkeyPatch) -> None:
    """Every decode through `spreading_decoder`, and no lexical lift. Its scores are flat (-0.4 a frame
    whatever the targets), so every text's lift reads 0 and the global engine's lexical gate (W3) would
    refuse the song's own words before the harness saw a document. These rigs test the HARNESS, so they
    take the check out (`lexical.lift` unmeasurable: the envelope gate decides, as it did before W3); the
    gate itself is tested on the CTC fixture's real Viterbi (`test_lexical_gate.py`)."""
    from encore_worker.adapters import ml
    from encore_worker.domain.lyrics import lexical

    monkeypatch.setattr(ml, "forced_align_decoder", spreading_decoder)
    monkeypatch.setattr(lexical, "lift", lambda *_a, **_k: None)


def write_voiced(
    path: Path, duration: float, *, lag: float = 0.0, phrases: Sequence[tuple[str, float, float]] = PHRASES
) -> Path:
    """A tone wherever a phrase is sung (shifted by `lag`), faint noise elsewhere — for the envelope."""
    signal = np.random.default_rng(0).normal(0.0, 0.002, int(duration * RATE))
    for _text, start, end in phrases:
        t = np.arange(int((end - start) * RATE)) / RATE
        first = int((start + lag) * RATE)
        signal[first : first + len(t)] += 0.3 * np.sin(2 * math.pi * 220.0 * t)
    sf.write(path, signal, RATE)
    return path


@pytest.fixture()
def rig(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Any, Any]:
    """The `time_text` driver over a two-song corpus whose songs have a STEM, as every corpus song does.

    THE MIX IS A SECOND FILE, same samples, different path (W4 review r1). `song_of` defaults a song's mix
    to its stem, which reads as a STEMLESS case to the shipped step — `AudioRef.align_target` returns the
    same path for both, so `target_name` is "mix" and the word-end post-pass does not run (`ends`' theta is
    a stem's). That made this driver's document differ from `RunAlignDriver`'s, which stages the stem into
    its own media tree and so always aligns on a "stem": the parity property below read a fixture artifact
    as a difference between the two paths. Neither the corpus nor production has a song whose mix IS its
    vocals — `--no-stem` passes `vocals_path=None` instead, which the stemless tests do too.
    """
    spread_decodes(monkeypatch)
    wav = write_voiced(tmp_path / "vocals.wav", DURATION)
    mix = write_voiced(tmp_path / "mix.wav", DURATION)
    song = song_of(PHRASES, slug="synthetic", audio=wav, mix=mix)
    other = song_of([("a wholly different sheet of words", 3.0, 9.0)], slug="other", audio=wav, mix=mix)
    driver = e2e.TimeTextDriver(aligner=VoicedAligner(), corpus=[song, other], media_root=tmp_path / "media")
    return driver, song


def test_the_driver_runs_the_shipped_time_text_and_pairs_by_identity(rig: tuple[Any, Any]) -> None:
    from encore_worker.domain.lyrics.generate import Generated

    driver, song = rig
    original = Generated.as_doc
    row = driver.run(e2e.Case(song, "truth", 0))
    assert Generated.as_doc is original, "the capture hook is removed again"
    assert row["outcome"] == lib.PUBLISHED and row["identity"] == "captured"
    assert row["verdict"] != "?" and row["ref"].endswith("-lrc-word.json")
    assert [e[0] for e in row["line_errors"]] == list(range(len(PHRASES)))
    assert row["gross"] == 0 and row["pairing_disagreements"] == 0
    assert driver.duration_of(song) == pytest.approx(DURATION), "real duration, read from the audio"


def test_a_partial_sheet_scores_only_the_lines_it_still_has(rig: tuple[Any, Any]) -> None:
    driver, song = rig
    row = driver.run(e2e.Case(song, "drop50", 0))
    kept = sorted(c.truth for c in driver.claims_for(e2e.Case(song, "drop50", 0)).lines)
    assert row["outcome"] == lib.PUBLISHED and row["in_text"] == 4
    assert sorted(e[0] for e in row["line_errors"]) == kept


def test_injected_header_lines_publish_but_are_not_scored(rig: tuple[Any, Any]) -> None:
    driver, song = rig
    row = driver.run(e2e.Case(song, "blind+headers", 0))
    assert row["outcome"] == lib.PUBLISHED and row["text_lines"] > len(PHRASES)
    assert row["doc_lines"] == row["text_lines"] and row["scored"] == len(PHRASES)
    assert row["pairing_disagreements"] is None


def test_a_row_carries_the_repair_decodes_that_raised(
    rig: tuple[Any, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    """A swallowed repair fault looks exactly like a repair nobody needed (review L8), so each row
    carries the trail's `repair-faults` notes. Clean rows carry an empty list, not a missing key."""
    from encore_worker.adapters import ml

    driver, song = rig
    clean = driver.run(e2e.Case(song, "blind", 0))
    assert clean["repair_faults"] == []

    whole = int(DURATION / FRAME)

    def whole_song_only(
        log_probs: Sequence[float], targets: Sequence[int], blank: int = 0
    ) -> tuple[list[int], list[float]]:
        if len(log_probs) != whole:
            raise RuntimeError("window decode fault")
        return spreading_decoder(log_probs, targets, blank)

    monkeypatch.setattr(ml, "forced_align_decoder", whole_song_only)
    faulted = driver.run(e2e.Case(song, "blind", 0))
    assert faulted["outcome"] == lib.PUBLISHED, "a failed repair keeps the originals"
    assert len(faulted["repair_faults"]) == 1 and faulted["repair_faults"][0].startswith("R3: 3 of 3")


def test_the_generate_level_is_the_raw_decode(rig: tuple[Any, Any], tmp_path: Path) -> None:
    driver, song = rig
    raw = e2e.GenerateDriver(aligner=driver.aligner, corpus=driver.corpus, media_root=tmp_path / "raw")
    row = raw.run(e2e.Case(song, "blind", 0))
    assert row["outcome"] == lib.PUBLISHED and row["verdict"] == "generate"
    assert [e[0] for e in row["line_errors"]] == list(range(len(PHRASES)))
    assert row["high"] == 0, "the raw decode is ungraded"


# ── word ends and the TV highlight ───────────────────────────────────────────────────────────────────


def test_word_ends_follow_the_reviews_exp_ends_definitions() -> None:
    """An end counts only for an ALIGNED word whose onset is within 250 ms; phrase-final = a line's last."""
    song = song_of(
        [("one two", 0.0, 2.0), ("three", 3.0, 4.0), ("four five", 5.0, 7.0)],
        words=[(0.0, 0.5), (1.0, 1.5), (3.0, 3.8), (5.0, 5.5), (6.0, 6.5)],
    )
    got = claims(song, "truth")
    doc = [
        line(0, 0.0, words=(lib.DocWord(0.05, 0.45, True), lib.DocWord(1.2, 1.3, True))),
        line(1, 3.3, words=(lib.DocWord(3.3, 3.9, True),)),  # onset 300 ms off: its end is not an end metric
        line(2, 5.0, words=(lib.DocWord(5.0, 5.5, False), lib.DocWord(6.0, 6.6, True))),  # interpolated first
    ]
    score = lib.score_words(song, got, doc)
    assert score.end_errors == pytest.approx((-0.05, -0.2, 0.1))
    assert score.final_end_errors == pytest.approx((-0.2, 0.1))
    row = lib.row_of(song=song, mode="truth", variant=0, claims=got, outcome=lib.PUBLISHED, doc=doc)
    words = lib.word_metrics([row])
    assert (words["end_scored"], words["end100_pct"], words["end250_pct"]) == (3, 66.67, 100.0)
    assert (words["final_end100_pct"], words["final_end_bias_ms"]) == (50.0, pytest.approx(-50.0))


def test_a_truth_word_with_no_end_ends_at_the_next_onset_in_its_line(tmp_path: Path) -> None:
    """Dormant on today's corpus (every Jamendo word has an end), so pinned here rather than by the bench."""
    lines = (lib.TruthLine("a b", 0.0, 2.0), lib.TruthLine("c", 10.0, 20.0))
    path = tmp_path / "truth-words.json"
    path.write_text(json.dumps({"words": [{"start": 0.0}, {"start": 1.0}, {"start": 10.0, "end": 10.5}]}))
    assert lib.load_truth_words(path, lines) == (
        lib.TruthWord(0.0, 1.0),
        lib.TruthWord(1.0, 2.0),
        lib.TruthWord(10.0, 10.5),
    )
    path.write_text(
        json.dumps({"words": [{"start": 0.0, "end": 0.4}, {"start": 1.0, "end": 1.4}, {"start": 10.0}]})
    )
    assert lib.load_truth_words(path, lines)[2] == lib.TruthWord(10.0, 10.0 + lib.TRUTH_END_CAP_SEC)


def tv_line(*words: tuple[str, float, float, int]) -> Any:
    return lib.TvLine(
        words[0][1], words[-1][2], " ".join(w[0] for w in words), tuple(lib.TvWord(*w) for w in words)
    )


def test_the_tv_lights_the_word_whose_half_open_span_holds_the_position() -> None:
    """`activeLineIndex` / `activeWordIndex`: start inclusive, end exclusive; between lines nothing is lit."""
    first = tv_line(("hello", 1.0, 1.5, 0), ("world", 1.5, 2.0, 1))
    second = tv_line(("again", 3.0, 4.0, 2))
    lines = [first, second]
    assert lib.tv_lit(lines, 1.0) is first.words[0] and lib.tv_lit(lines, 1.5) is first.words[1]
    assert lib.tv_lit(lines, 2.0) is None and lib.tv_active_line(lines, 2.5) == 0, (
        "the sung line stays current"
    )
    assert lib.tv_active_line(lines, 0.0) == 0 and lib.tv_active_line(lines, 9.0) == 1
    assert lib.tv_lit([], 1.0) is None


def test_a_line_misbound_late_blanks_the_tv_until_playback_reaches_it() -> None:
    """The TV scans lines IN ORDER and stops at the first that starts after `pos`, so one line bound 40 s late
    hides every line after it. Painting each word's span (the review's highlight) cannot see this."""
    lines = [
        tv_line(("early", 0.0, 1.0, 0)),
        tv_line(("misbound", 50.0, 51.0, 1)),
        tv_line(("later", 2.0, 3.0, 2)),
    ]
    assert lib.tv_lit(lines, 2.5) is None
    assert lib.highlight_seconds(lines, [(0.0, 1.0, 0), (10.0, 11.0, 1), (2.0, 3.0, 2)]) == (1.0, 3.0)


def test_a_low_graded_row_lights_no_word_because_the_tv_wipes_none(tmp_path: Path) -> None:
    """The port of W6's consumer (review §3.7): `lyrics.ts` `wipesWords` — a `low` line renders as one text
    node, so the TV lights nothing while it is sung. `wipe_low` is OFF by default here and the `highlight`
    metric keeps it off DELIBERATELY (`score_highlight` owns that argument); the fixture is written with it
    ON, so both trees are held to the rule.
    """
    assert lib.tv_wipes_words(None) and lib.tv_wipes_words("high") and lib.tv_wipes_words("medium")
    assert not lib.tv_wipes_words("low"), "only `low` is doubt; a missing grade must not read as one"
    doubted = tv_line(("graded", 1.0, 1.5, 0), ("low", 1.5, 2.0, 1))
    doubted = lib.TvLine(doubted.start, doubted.end, doubted.text, doubted.words, wipes=False)
    lines = [doubted, tv_line(("confident", 3.0, 4.0, 2))]
    assert lib.tv_lit(lines, 1.0) is doubted.words[0], "the metric's reading: the word branch, every line"
    assert lib.tv_lit(lines, 1.0, wipe_low=True) is None, "the TV's reading: no wipe on a doubted row"
    assert lib.tv_active_line(lines, 1.0) == 0, "the ROW is still current and still displayed"
    assert lib.tv_lit(lines, 3.5, wipe_low=True) is lines[1].words[0], "its neighbour is untouched"
    # The document's grade reaches the port through `DocLine.confidence`, and EVERY row a graded line splits
    # into inherits it (`resegmentLine`'s last statements), so a long doubted line wipes on none of them.
    words = "morning light is falling on the rivers and the sea tonight".split()
    doc = lib.DocLine(
        text=" ".join(words),
        start=0.0,
        end=6.0,
        confidence="low",
        source=0,
        words=tuple(lib.DocWord(0.5 * i, 0.5 * i + 0.4, True, word) for i, word in enumerate(words)),
    )
    rows = lib.tv_lines([(doc, list(range(len(words))))])
    assert len(rows) > 1, "it must actually split, or the carry is untested"
    assert [row.wipes for row in rows] == [False] * len(rows)
    assert all(lib.tv_lit(rows, 0.5 * i, wipe_low=True) is None for i in range(len(words)))
    assert lib.tv_lit(rows, 0.0) is not None, "and the metric still scores it word by word"


def test_long_lines_resegment_at_pauses_and_fold_a_short_orphan_into_the_closer_side() -> None:
    """`resegmentLine` + `coalesceOrphans`, ported: only a line over 42 chars splits, at a 0.45 s pause."""
    run = [(w, 0.5 * i, 0.5 * i + 0.4, i) for i, w in enumerate("morning light is falling on rivers".split())]
    tail = [(w, 5.0 + 0.5 * i, 5.4 + 0.5 * i, 7 + i) for i, w in enumerate("waiting for you tonight".split())]
    back = lib.tv_resegment(tv_line(*run, ("here", 3.5, 3.8, 6), *tail))  # gap 0.6 before, 1.2 after
    assert [row.text for row in back] == [
        "morning light is falling on rivers here",
        "waiting for you tonight",
    ]
    assert (back[1].start, back[1].end) == (5.0, 6.9)
    # "I" after nothing merges FORWARD; the 42-char cap then cuts "tonight" off alone, and it merges BACK.
    words = "morning light is falling on the rivers tonight".split()
    lead = [("I", 0.0, 0.2, 0), *[(w, 1.0 + 0.5 * i, 1.4 + 0.5 * i, 1 + i) for i, w in enumerate(words)]]
    (whole,) = lib.tv_resegment(tv_line(*lead))
    assert (whole.text, whole.start, whole.end) == (
        "I morning light is falling on the rivers tonight",
        0.0,
        4.9,
    )
    short = tv_line(("a", 0.0, 0.1, 0), ("pause", 5.0, 5.2, 1))
    assert lib.tv_resegment(short) == [short], "a line that fits is never split, whatever its pauses"


def test_highlight_is_the_share_of_sung_time_the_right_word_is_lit() -> None:
    """Denominator: sung time of EVERY line the text has — a line the aligner dropped lights nothing."""
    song = song_of(
        [("one two", 0.0, 2.0), ("three four", 3.0, 5.0), ("five", 6.0, 7.0)],
        words=[(0.0, 1.0), (1.0, 2.0), (3.0, 4.0), (4.0, 5.0), (6.0, 7.0)],
    )
    got = claims(song, "truth")
    late = lib.DocLine(
        "one two",
        0.25,
        2.0,
        "high",
        0,
        (lib.DocWord(0.25, 1.25, True, "one"), lib.DocWord(1.25, 2.0, True, "two")),
    )
    exact = lib.DocLine("five", 6.0, 7.0, "high", 2, (lib.DocWord(6.0, 7.0, True, "five"),))
    hit, sung = lib.score_highlight(song, got, [late, exact])  # line 1 dropped by the aligner
    assert (hit, sung) == pytest.approx((2.5, 5.0))
    unsynced = [lib.DocLine(d.text, d.start, d.end, "low", d.source) for d in (late, exact)]
    assert lib.score_highlight(song, got, unsynced) == pytest.approx((0.0, 5.0)), "line sync lights no word"
    row = lib.row_of(song=song, mode="truth", variant=0, claims=got, outcome=lib.PUBLISHED, doc=[late, exact])
    assert lib.highlight_metrics([row])["pct"] == 50.0
    assert lib.score_highlight(song_of(TEN), claims(song_of(TEN), "truth"), []) is None, "no word truth"


def test_a_lit_header_label_is_a_wrong_word() -> None:
    song = song_of([("one two", 0.0, 2.0)], words=[(0.0, 1.0), (1.0, 2.0)])
    got = lib.Claims(lines=(lib.ClaimLine("CHORUS: one two", 0.0, 2.0, truth=0, lead_words=1),), timed=True)
    labelled = lib.DocLine(
        "CHORUS: one two",
        0.0,
        2.0,
        "high",
        0,
        (
            lib.DocWord(0.0, 0.5, True, "CHORUS:"),
            lib.DocWord(0.5, 1.0, True, "one"),
            lib.DocWord(1.0, 2.0, True, "two"),
        ),
    )
    assert lib.score_highlight(song, got, [labelled]) == pytest.approx((1.5, 2.0))


# ── bootstrap intervals and the flat view ────────────────────────────────────────────────────────────


def spread_rows(errors: Sequence[float], mode: str = "truth", group: str = "jamendo") -> list[Any]:
    """One song per error: its odd lines published that far off, its even lines exact."""
    rows = []
    for i, err in enumerate(errors):
        song = song_of(TEN, slug=f"s{i}", group=group)
        got = claims(song, "truth")
        doc = [line(k, t.start + (err if k % 2 else 0.0)) for k, t in enumerate(song.truth)]
        rows.append(lib.row_of(song=song, mode=mode, variant=0, claims=got, outcome=lib.PUBLISHED, doc=doc))
    return rows


def test_song_bootstrap_intervals_are_seeded_and_bracket_the_pooled_estimate() -> None:
    rows = spread_rows([0.1, 0.2, 0.9, 3.0, 0.3])
    ci = lib.bootstrap_ci(rows, label="truth|all")
    assert ci == lib.bootstrap_ci(rows, label="truth|all"), "seeded: the same rows give the same interval"
    others = spread_rows([2.5, 0.0, 0.7], mode="jit")
    alone, joined = lib.summarize(rows), lib.summarize([*rows, *others])
    assert alone["truth"]["all"]["ci"] == joined["truth"]["all"]["ci"], "other modes never move an interval"
    point = lib.line_metrics(rows)["w500_pct"]
    assert point == 80.0 and ci["pm500"][0] <= point <= ci["pm500"][1] and ci["pm500"][0] < ci["pm500"][1]
    assert ci["gross"][0] <= 5 <= ci["gross"][1]
    assert ci["word_pm300"] is None and ci["highlight"] is None, "no word truth, no interval"
    solo = lib.bootstrap_ci(rows[3:4], label="x")
    assert solo["pm500"] == [50.0, 50.0] and solo["gross"] == [5.0, 5.0], "one song: nothing to resample"
    wrong = lib.bootstrap_ci(
        [
            lib.row_of(
                song=song_of(TEN),
                mode="truth",
                variant=0,
                claims=claims(song_of(TEN), "truth"),
                outcome=lib.REFUSED,
                doc=[],
            )
        ],
        label="x",
    )
    assert wrong["pm500"] is None and wrong["gross"] is None


def test_the_flat_view_and_per_song_metrics_name_what_the_gates_read() -> None:
    rows = spread_rows([0.1, 3.0])
    summary = lib.summarize(rows)
    flat = lib.flat_metrics(summary["truth"]["all"])
    assert (flat["pm500"], flat["gross"], flat["scored"]) == (75.0, 5.0, 20.0)
    assert flat["pm500_lo"] <= 75.0 <= flat["pm500_hi"]
    assert flat["word_pm300"] is None and flat["attempts"] is None and flat["highlight"] is None
    songs = lib.per_song(rows)
    assert songs["truth"]["s1"] == {
        "group": "jamendo",
        "cases": 1.0,
        "published": 1.0,
        "refused": 0.0,
        "error": 0.0,
        "scored": 10.0,
        "missing": 0.0,
        "gross": 5.0,
        "pm500": 50.0,
        "pm1000": 50.0,
        "text_pm500": 50.0,
        "high_gross": 5.0,
        "unsung": 0.0,
    }
    assert "95% CI (song bootstrap)" in lib.format_summary(summary)


def test_unsung_counts_the_published_lines_no_truth_line_pairs_with() -> None:
    """W1 review r1 (spec-5): an injected header or credit that PUBLISHES is never scored, so no ±N metric
    could see M6 put back all 33 its mix envelope spared. `unsung` counts them per published document,
    none for a refused one, and per song for the gates."""
    song = worded("s")
    got = claims(song, "headers")
    shown = [
        lib.DocLine(c.text, float(c.start or 0.0), float(c.end or 0.0), "high", i)
        for i, c in enumerate(got.lines)
    ]
    headers = sum(1 for c in got.lines if c.truth is None)
    published = lib.row_of(song=song, mode="headers", variant=0, claims=got, outcome=lib.PUBLISHED, doc=shown)
    refused = lib.row_of(song=song, mode="headers", variant=0, claims=got, outcome=lib.REFUSED, doc=[])
    assert headers > 0 and lib.line_metrics([published])["unsung"] == headers
    assert lib.line_metrics([refused])["unsung"] == 0
    assert lib.per_song([published])["headers"]["s"]["unsung"] == headers
    assert lib.flat_metrics(lib.summarize([published])["headers"]["all"])["unsung"] == headers


# ── compare and the gate language ────────────────────────────────────────────────────────────────────


def document(rows: Sequence[Any], **meta: Any) -> dict[str, Any]:
    return {"meta": meta, "summary": lib.summarize(rows), "songs": lib.per_song(rows)}


@pytest.fixture()
def views() -> tuple[Any, Any]:
    """RUN vs BASE: s1 gains 5 gross lines under truth; a youtube song and a second mode on both sides."""
    run = [
        *spread_rows([0.1, 3.0]),
        *spread_rows([0.2], group="youtube"),
        *spread_rows([0.1, 0.1], mode="jit"),
    ]
    base = [
        *spread_rows([0.1, 0.1]),
        *spread_rows([0.2], group="youtube"),
        *spread_rows([0.1, 3.0], mode="jit"),
    ]
    for row in run[2:3] + base[2:3]:
        row["song"] = "yt"
    return gates.view_of(document(run, level="time_text")), gates.view_of(document(base, level="run_align"))


def held(expr: str, views: tuple[Any, Any]) -> bool:
    ok, _detail = gates.evaluate(expr, *views)
    return bool(ok)


def test_gates_read_pooled_numbers_per_song_values_and_the_baseline(views: tuple[Any, Any]) -> None:
    """The plan's reject-if forms, written as the conditions that must HOLD."""
    run, _base = views
    assert run.modes["truth"]["all"]["pm500"] == pytest.approx(83.33)
    assert held("truth.pm500 >= base.truth.pm500 - 20.0", views)
    assert not held("truth.pm500 >= base.truth.pm500 - 1.0", views)
    assert held("delta(truth.gross) == 5", views) and held("truth.gross_up", views)
    assert held("truth.jamendo.gross == 5 and truth.youtube.gross == 0", views)
    assert not held("count(song.gross_up) == 0", views), "s1 gained gross lines under truth"
    assert held("count(truth.song.gross_up) == 1 and count(jit.song.gross_down) == 1", views)
    assert held("count(youtube.song.gross_up) == 0", views), "the group filter keeps only youtube songs"
    assert held("min_song_delta(jamendo.pm500) == -50 and max_song_delta(jamendo.pm500) == 50", views)
    assert held("min_song_delta(truth.jamendo.pm500) == -50", views)
    assert held("max(truth.song.gross) == 5 and mean(truth.jamendo.song.gross) == 2.5", views)
    assert held("abs(truth.pm500 - 83.33) <= 0.01 and 0 <= truth.gross <= 5", views)
    assert held("min(truth.pm500, jit.pm500) == truth.pm500 and not jit.gross_up", views)
    assert held("count(song.pm500 - base.song.pm500 < -10) == 1", views), "per-song arithmetic pairs songs"
    ok, detail = gates.evaluate("truth.pm500 >= base.truth.pm500 - 1.0", *views)
    assert not ok and detail == "83.33 >= 99"


def test_combined_modes_are_named_through_mode_call(views: tuple[Any, Any]) -> None:
    run, base = views
    modes = {**run.modes, "jit+off15": run.modes["jit"]}
    combined = gates.View(modes=modes, songs=run.songs, meta={})
    assert gates.evaluate('mode("jit+off15").pm500 == jit.pm500', combined, base)[0]
    with pytest.raises(gates.GateError, match="not in this summary"):
        gates.evaluate('base.mode("jit+off15").pm500 > 0', combined, base)


@pytest.mark.parametrize(
    ("expr", "why"),
    [
        ("off3.pm500 > 0", "not in this summary"),
        ("truth.word_pm300 > 0", "no value"),
        ("truth.bogus > 0", "unknown metric"),
        ("pm500 > 0", "names no mode"),
        ("truth.song.bogus > 0", "not a per-song metric"),
        ("song.gross > 1", "must be a condition"),
        ("truth.pm500", "must be a condition"),
        ("count(truth.gross) == 0", "reduces per-song values"),
        ("song.gross > 1 and true", "reduce per-song values"),
        ("__import__('os').system('true') == 0", "unknown function"),
        ("truth.pm500.__class__ == 1", "cannot read reference"),
        ("[1][0] == 1", "not part of the gate language"),
        ("(lambda: 1)() == 1", "unknown function"),
        ("truth.pm500 ** 2 > 0", "not part of the gate language"),
        ("truth.pm500 >", "not an expression"),
        ("1 / 0 > 0", "division by zero"),
        ("truth.gross >= 0 or off3.pm500 > 0", "not in this summary"),
    ],
)
def test_a_gate_that_cannot_be_evaluated_is_an_error_never_a_pass(
    views: tuple[Any, Any], expr: str, why: str
) -> None:
    with pytest.raises(gates.GateError, match=why):
        gates.evaluate(expr, *views)


def test_baseline_references_need_a_baseline(views: tuple[Any, Any]) -> None:
    run, _base = views
    for expr in ("truth.pm500 >= base.truth.pm500", "count(song.gross_up) == 0", "delta(truth.pm500) > 0"):
        with pytest.raises(gates.GateError, match="no --compare baseline"):
            gates.evaluate(expr, run, None)
    results = gates.run_gates(
        [gates.Gate("absolute", "truth.gross <= 5"), gates.Gate("relative", "delta(truth.gross) <= 0")],
        run,
        None,
    )
    assert [(r.gate.name, r.status) for r in results] == [
        ("no-error-rows", "PASS"),
        ("absolute", "PASS"),
        ("relative", "ERROR"),
    ]
    assert "REJECT" in gates.format_gates(results) and "2/3 pass" in gates.format_gates(results)


def test_gate_files_are_json_or_a_one_line_per_gate_yaml_subset() -> None:
    text = (
        "# W2 reject-if list\n"
        "truth-holds: truth.pm500 >= base.truth.pm500 - 1.0\n"
        "\n"
        "no-new-gross: 'count(song.gross_up) == 0'  # any song, any mode\n"
    )
    assert gates.parse_gates(text) == [
        gates.Gate("truth-holds", "truth.pm500 >= base.truth.pm500 - 1.0"),
        gates.Gate("no-new-gross", "count(song.gross_up) == 0"),
    ]
    assert gates.parse_gates('{"a": "truth.pm500 > 1"}') == [gates.Gate("a", "truth.pm500 > 1")]
    assert gates.parse_gates('[{"name": "a", "expr": "truth.pm500 > 1"}]') == [
        gates.Gate("a", "truth.pm500 > 1")
    ]
    for bad, why in (
        ("a: truth.gross > 1\n  nested: 1\n", "nested YAML"),
        ("a:\n", "expected `name: expression`"),
        ("a: truth.gross > 1\na: truth.gross > 2\n", "twice"),
        ("just an expression\n", "expected `name: expression`"),
        ("# nothing\n", "no gates"),
    ):
        with pytest.raises(gates.GateError, match=why):
            gates.parse_gates(bad)


#: The bench's committed reject-if files (`docs/benchmarks/forced-alignment/gates`).
GATES_DIR = SCRIPTS.parent / "gates"


def lines_rows(mode: str, songs: int, *, refused: int = 0) -> list[Any]:
    """A `--sync-mode lines` run's shape: every committed case is a LINE_SYNC document whose lines are graded
    `low` (`align_steps._line_doc` + `_write(..., "low")`), here placed exactly on truth."""
    rows = []
    for i in range(songs):
        song = song_of(TEN, slug=f"s{i}")
        got = claims(song, "truth")
        doc = [] if i < refused else [line(k, t.start, confidence="low") for k, t in enumerate(song.truth)]
        outcome = lib.REFUSED if i < refused else lib.LINE_SYNC
        rows.append(lib.row_of(song=song, mode=mode, variant=0, claims=got, outcome=outcome, doc=doc))
    return rows


def lines_run(**refusals: int) -> list[Any]:
    """Rows for all 16 modes of `--modes all,wrongtext+ownclock` at `--sync-mode lines`: 32 songs committed
    per timed mode, `blind` refused (no claims, so the rung has nothing to place) and both wrong-text modes
    refused, as the W3 sweep measured. `refusals` refuses that many songs of a named mode."""
    rows = [
        row
        for mode in lib.ALL_MODES
        if mode not in ("wrongtext", "blind")
        for row in lines_rows(mode, 32, refused=refusals.get(mode, 0))
    ]
    rows += lines_rows("blind", 32, refused=32)
    corpus = [song_of(TEN, slug="j"), song_of(TEN, slug="y", group="youtube")]
    rows += [
        lib.row_of(
            song=corpus[0],
            mode=mode,
            variant=variant,
            claims=claims(corpus[0], mode, corpus, variant=variant, wrong_k=2),
            outcome=lib.REFUSED,
            doc=[],
        )
        for mode in ("wrongtext", "wrongtext+ownclock")
        for variant in range(2)
    ]
    return rows


def test_the_lines_reject_if_files_names_all_resolve_and_its_floors_point_the_right_way() -> None:
    """`gates/w3-lines.yaml` is read 2-3 HOURS after a `--sync-mode lines` sweep starts, so a mistyped mode
    or metric must not read as a clean run. An unmeasured (mode, metric) key is an ERROR by design, so every
    name in it resolving is the check — on synthetic rows carrying all 16 modes, shaped as the run is (line
    documents graded `low`, blind and both wrong-text modes refused), all 38 gates PASS. And the floors point
    the right way: dropping under truth's floor of 31 committed songs fails `committed-not-down-truth` alone
    (its text-denominator ±500 gate, 30 of 32 songs = 93.75%, still clears 90)."""
    rules = gates.parse_gates((GATES_DIR / "w3-lines.yaml").read_text(encoding="utf-8"))
    assert len(rules) == 38 - 1, "the 38 the file's header reports, less the built-in no-error-rows gate"
    view = gates.view_of(document(lines_run(), level="run_align", sync_mode="lines"))
    results = gates.run_gates(rules, view, None)
    assert [(r.gate.name, r.detail) for r in results if r.status != "PASS"] == []
    short = gates.run_gates(rules, gates.view_of(document(lines_run(truth=2))), None)
    assert [r.gate.name for r in short if r.status != "PASS"] == ["committed-not-down-truth"]


def test_the_hubert_reject_if_file_resolves_every_name_and_is_not_vacuous() -> None:
    """`gates/w4b-hubert.yaml` is read 2-3 HOURS after the model flip's two sweeps start (review §3 item 6b),
    so a mistyped mode or metric must not read as a clean run — an unmeasured (mode, metric) key is an ERROR
    by design, and a gate that cannot fail is decoration.

    Scored on the COMMITTED base-model row as BOTH sides, which is exactly how the file's header was checked
    before any HuBERT row existed: every name resolves on a real `--modes all,wrongtext+ownclock` summary
    (0 ERRORs), the "not worse" gates PASS on the identity, and the three gain gates FAIL on it — a run
    compared with itself gains nothing.
    """
    rules = gates.parse_gates((GATES_DIR / "w4b-hubert.yaml").read_text(encoding="utf-8"))
    assert len(rules) == 21, "the 21 the file's header reports; `run_gates` adds the built-in no-error-rows"
    # W4b REVIEW R1 ADDED THE TWO AAE GATES, and they must be REAL ones: `blind-aae-not-up` used to read the
    # signed `word_bias_ms`, so the model axis gated the median and not the absolute error at all.
    absolute = {r.name: r.expr for r in rules if r.name.endswith("aae-not-up")}
    assert set(absolute) == {"blind-aae-not-up", "truth-aae-not-up"}
    assert all("word_aae_ms" in expr and "bias" not in expr for expr in absolute.values()), absolute
    assert "word_bias_ms" in next(r.expr for r in rules if r.name == "blind-onset-bias-not-worse")
    base = gates.view_of(gates.load_document(SCRIPTS.parent / "results" / "w4-time_text.json"))
    statuses = {r.gate.name: r.status for r in gates.run_gates(rules, base, base)}
    assert "ERROR" not in statuses.values(), [
        (name, status) for name, status in statuses.items() if status == "ERROR"
    ]
    assert {name for name, status in statuses.items() if status == "FAIL"} == {
        "blind-jamendo-gross-down",
        "blind-youtube-gross-down",
        "songs-better-at-word-pm300-blind",
    }, "the three SHOULD gains, and only those, must fail on the identity"


def test_the_wave_reject_if_file_reproduces_the_bench_verdict_on_the_committed_rows() -> None:
    """`gates/w4b.yaml` is the WAVE's acceptance test — the six MUSTs the orchestrator set — and it is what
    sent HuBERT-Large back behind `ENCORE_ALIGN_MODEL` (`ml.DEFAULT_ALIGN_MODEL`). Two readings are pinned
    because either alone would be misleading:

    * THE RATCHET reads 30/30 on the tree that set it (the control as BOTH sides), every absolute at its own
      digit and every delta 0.00. That is a property a ratchet must have and NOT evidence that it bites.
    * THE CANDIDATE reads 19/30, failing exactly eleven names, at `time_text` AND at `run_align`. Those are
      the wave's three failing MUSTs (pooled gross up in eight modes, the two named YouTube songs, one Jamendo
      song at ±300), so a later edit that quietly greened any of them changes a published verdict and must
      fail here first.

    THE COUNT MOVED IN REVIEW R2 AND THE VERDICT DID NOT (spec-9): MUST 2's nine claim modes were one summed
    inequality reading `57 <= 56`, so it failed BY ONE LINE while seven of the nine regressed and two
    (credit 28 -> 7, headers 3 -> 2) paid for them. A sum does not rise whenever a term does; the file now
    gates each mode, which is why `pooled-gross-not-up-off05 …` are named here one by one.
    """
    rules = gates.parse_gates((GATES_DIR / "w4b.yaml").read_text(encoding="utf-8"))
    assert len(rules) == 29, "run_gates adds the built-in no-error-rows on top"
    results = SCRIPTS.parent / "results"
    failed_the_flip = {
        "no-jamendo-song-worse-at-word-pm300",
        "pooled-gross-not-up-truth",
        *(f"pooled-gross-not-up-{mode}" for mode in ("off05", "off15", "off3", "offm1")),
        *(f"pooled-gross-not-up-{mode}" for mode in ("tempo098", "tempo102", "extraverse")),
        "no-youtube-song-worse-at-truth-pm500",
        "no-youtube-song-gains-gross-truth",
    }
    for level in ("time_text", "run_align"):
        base = gates.view_of(gates.load_document(results / f"w4b-base-{level}.json"))
        run = gates.view_of(gates.load_document(results / f"w4b-hubert-{level}.json"))
        on_itself = {r.gate.name: r.status for r in gates.run_gates(rules, base, base)}
        assert set(on_itself.values()) == {"PASS"}, [
            (name, status) for name, status in on_itself.items() if status != "PASS"
        ]
        candidate = {r.gate.name: r.status for r in gates.run_gates(rules, run, base)}
        assert "ERROR" not in candidate.values(), [
            (name, status) for name, status in candidate.items() if status == "ERROR"
        ]
        assert {name for name, status in candidate.items() if status == "FAIL"} == failed_the_flip, level


def test_the_w2_displacement_ratchet_keeps_w2s_allowance_and_reads_zero_on_its_own_base() -> None:
    """W4b REVIEW R2 (spec-11): W4b's rebase moved `gates/w2.yaml`'s `--compare` base to `results/w4-*.json`
    AND re-priced eleven of section 12's thirteen per-song displacement literals at W4's own worst-vs-W3. Both
    together make the bound mean "displace a song as far as the last wave did, AGAIN": `credit` -45 evaluated
    against a W4 row already -44.68 below W3 is ~89 pt of cumulative loss on a 0-100 metric, read as green,
    and each new literal sat 0.02-0.6 pt inside the change it excused, so the manoeuvre is repeatable every
    wave. The base may move — that is what a rebase is for — but the ALLOWANCE is W2's, which is what this
    test holds. W4's own excess is recorded in that section as a price paid, and shows up as FAILs in the
    W4-vs-W3 reading the file's header waives.
    """
    rules = gates.parse_gates((GATES_DIR / "w2.yaml").read_text(encoding="utf-8"))
    bounds = {
        gate.name.removeprefix("no-worse-displacement-"): float(gate.expr.rsplit(">=", 1)[1])
        for gate in rules
        if gate.name.startswith("no-worse-displacement-")
    }
    assert bounds == {
        "truth": -11.0,
        "jit": -6.0,
        "off05": -22.0,
        "off15": -5.0,
        "off3": -15.0,
        "offm1": -4.0,
        "tempo098": -9.0,
        "tempo102": 0.0,
        "drop20": -13.0,
        "drop50": -70.0,
        "extraverse": -15.0,
        "headers": -22.0,
        "credit": -18.0,
    }, "W2's own measured worst per mode; a later wave needing more must waive it out loud"

    results = SCRIPTS.parent / "results"
    for level in ("time_text", "run_align"):
        w4 = gates.view_of(gates.load_document(results / f"w4-{level}.json"))
        w3 = gates.view_of(gates.load_document(results / f"w3-{level}.json"))
        ratchet = {r.gate.name: r.status for r in gates.run_gates(rules, w4, w4)}
        assert set(ratchet.values()) == {"PASS"}, [n for n, s in ratchet.items() if s != "PASS"]
        # ...and against the base the literals were READ from, W4's own displacement shows as the price it is.
        priced = gates.run_gates(rules, w4, w3)
        spent = {
            r.gate.name.removeprefix("no-worse-displacement-")
            for r in priced
            if r.status == "FAIL" and r.gate.name.startswith("no-worse-displacement-")
        }
        owed = {"truth", "jit", "off15", "offm1", "tempo098", "drop20", "extraverse", "headers", "credit"}
        assert spent == (owed if level == "time_text" else owed | {"off05", "off3"}), (level, spent)


def test_the_linesep_decode_gate_file_reproduces_the_recorded_verdict_on_both_models() -> None:
    """`gates/w4b-linesep-generate.yaml` and the four cells it judged (review 6c / D1, W4b). Scored on the
    COMMITTED rows, which makes this the one gate test that pins a real measurement rather than a synthetic
    one: the arm ships DEFAULT-OFF because of exactly these verdicts, so a later edit to the file or to the
    rows that quietly changes them must not pass unnoticed.

    Non-vacuity first, the way the other files were checked: each cell against ITSELF gains nothing, so the
    two SHOULD gates FAIL on the identity and every bound PASSES.
    """
    rules = gates.parse_gates((GATES_DIR / "w4b-linesep-generate.yaml").read_text(encoding="utf-8"))
    assert len(rules) == 9, "the 9 the file's header reports; `run_gates` adds the built-in no-error-rows"
    results = SCRIPTS.parent / "results"

    def cell(tag: str) -> Any:
        return gates.view_of(gates.load_document(results / f"w4b-linesep-{tag}-generate.json"))

    def failures(run: str, base: str) -> list[str]:
        got = gates.run_gates(rules, cell(run), cell(base))
        assert "ERROR" not in {r.status for r in got}, [
            (r.gate.name, r.detail) for r in got if r.status == "ERROR"
        ]
        return sorted(r.gate.name for r in got if r.status == "FAIL")

    assert failures("base-off", "base-off") == ["blind-jamendo-gross-down", "songs-better-at-word-pm300"]
    # THE RECORDED VERDICT. 7/10 on the base model: the separator buys 12 gross lines and 5.1 pts of ±500 and
    # still fails review 6c's per-song ±300 bound (HILA -2.48) on top of the two below.
    assert failures("base-line", "base-off") == [
        "highlight-not-down",
        "no-jamendo-song-worse-at-word-pm300",
        "no-song-loses-lines",
    ]
    # 8/10 on HuBERT-L: the per-song bound now HOLDS (worst song -0.62), and what is left is one song's gross
    # line (Avercage 2 -> 3) and 0.9 pt of a highlight this level measures on the RAW decode's word ends —
    # which the shipped post-pass re-fits, and which `gates/w4b-linesep.yaml` is what reads fairly.
    assert failures("hubert-line", "hubert-off") == ["highlight-not-down", "no-song-loses-lines"]


def test_the_linesep_e2e_gate_file_reads_the_recorded_verdict_and_is_not_vacuous() -> None:
    """`gates/w4b-linesep.yaml` decided whether 6c ships, and the bench has now read it: cells A/B, the bundle
    production loads, **14/22 — REJECT** (`results/w4b-linesep-base-line-time_text.json` against
    `results/w4b-base-time_text.json`; 13/20 before W4b review r1 added the two AAE gates). Two readings, both
    pinned:

    * ON THE IDENTITY (the committed base row as both sides) every bound PASSES and only the SHOULD gain fails
      — the typo check the file was written for, kept because it is what proves no gate is green by accident.
    * ON THE ARM, the eight the header names. FOUR of them are gates `--level generate` passed or could not
      read, including `e2e-gross-down-truth` — review 6c's own reject-if nobody had read before this run — and
      the two `highlight-not-down-*` gates PASS here against the decode axis's -0.9, which is the finding
      that the generate-level highlight failure was the LEVEL and not the arm.
    * THE EIGHTH IS `truth-aae-not-up` (W4b review r1): +12.9 ms of absolute word error under truth claims
      with the MEDIAN bias unmoved, so it is asserted beside `onset-bias-not-worse-blind`'s PASS — the two
      metrics are different questions and this file used to ask only the median's.
    """
    rules = gates.parse_gates((GATES_DIR / "w4b-linesep.yaml").read_text(encoding="utf-8"))
    assert len(rules) == 21, "the 21 the file's header reports; `run_gates` adds the built-in no-error-rows"
    results = SCRIPTS.parent / "results"
    base = gates.view_of(gates.load_document(results / "w4-time_text.json"))
    statuses = {r.gate.name: r.status for r in gates.run_gates(rules, base, base)}
    assert "ERROR" not in statuses.values(), [
        (name, status) for name, status in statuses.items() if status == "ERROR"
    ]
    assert {name for name, status in statuses.items() if status == "FAIL"} == {"blind-gross-down"}

    control = gates.view_of(gates.load_document(results / "w4b-base-time_text.json"))
    arm = gates.view_of(gates.load_document(results / "w4b-linesep-base-line-time_text.json"))
    measured = {r.gate.name: r.status for r in gates.run_gates(rules, arm, control)}
    assert "ERROR" not in measured.values(), [
        (name, status) for name, status in measured.items() if status == "ERROR"
    ]
    assert {name for name, status in measured.items() if status == "FAIL"} == {
        "no-jamendo-song-worse-at-word-pm300-truth",
        "no-jamendo-song-worse-at-word-pm300-blind",
        "e2e-gross-down-truth",
        "youtube-blind-gross-not-up",
        "no-youtube-song-loses-lines-blind",
        "unsung-not-up-headers",
        "blind-gross-down",
        "truth-aae-not-up",
    }
    assert measured["highlight-not-down-truth"] == measured["highlight-not-down-blind"] == "PASS"
    assert measured["onset-bias-not-worse-blind"] == measured["blind-aae-not-up"] == "PASS", (
        "the median bias reads clean on both pools and the blind AAE falls: the cost is a truth-claims tail"
    )


def test_the_run_align_reject_if_file_reads_that_levels_own_zero_and_nothing_looser() -> None:
    """`gates/w3-run_align.yaml` exists because one gate file served both levels and its wrong-text cap is the
    LOOSER level's literal (W3 review r2): at `run_align` the measurement is 0/320, so a regression to 1/320
    cleared `gates/w3.yaml`'s `<= 0.32`. These four gates are absolute, and a run where one wrong text
    published fails every one of them — which is what the shared file could not do."""
    rules = gates.parse_gates((GATES_DIR / "w3-run_align.yaml").read_text(encoding="utf-8"))
    assert len(rules) == 5 - 1, "the 4 the file's header reports, less the built-in no-error-rows gate"
    clean = gates.view_of(document(lines_run(), level="run_align"))
    assert [(r.gate.name, r.detail) for r in gates.run_gates(rules, clean, None) if r.status != "PASS"] == []

    published = [
        row
        for row in lines_run()
        if row["mode"] not in ("wrongtext", "wrongtext+ownclock") or row["variant"] != 0
    ]
    corpus = [song_of(TEN, slug="j"), song_of(TEN, slug="y", group="youtube")]
    donor = corpus[0]
    published += [
        lib.row_of(
            song=donor,
            mode=mode,
            variant=0,
            claims=claims(donor, mode, corpus, variant=0, wrong_k=2),
            outcome=lib.PUBLISHED,
            doc=[line(k, t.start, confidence="low") for k, t in enumerate(donor.truth)],
        )
        for mode in ("wrongtext", "wrongtext+ownclock")
    ]
    leaked = gates.run_gates(rules, gates.view_of(document(published, level="run_align")), None)
    assert sorted(r.gate.name for r in leaked if r.status != "PASS") == [
        "ownclock-nothing-published",
        "ownclock-pass-zero",
        "wrongtext-nothing-published",
        "wrongtext-pass-zero",
    ]


def ends_rows(*, held: bool, songs: int = 6, worse: int = 0, moved_onset: bool = False) -> list[Any]:
    """A `blind` run of `songs` Jamendo songs whose truth times three words per line, shaped as the word-end
    post-pass moves them (review §3 item 5; `domain/lyrics/ends.py`).

    `held=False` is the `ends-raw` control: every onset exact, interior ends exact, and each line's LAST word
    ending 120 ms early — CTC's peakiness, which is what the post-pass is for. `held=True` lands that final
    end exactly. In the first `worse` songs the held document also over-extends both interior ends 400 ms
    into the gap before the next word, which is the real trade the corpus showed (Color_Out): phrase-final
    ends improve while word-end ±100 gets WORSE on that song, and the highlight does not notice, because a
    word lit over a gap no truth word occupies is in neither side of that ratio.
    """
    rows = []
    for index in range(songs):
        truth = [(f"one{i} two{i} three{i}", 10.0 * i, 10.0 * i + 2.6) for i in range(3)]
        words = [(10.0 * i + k, 10.0 * i + k + (0.5 if k < 2 else 0.6)) for i in range(3) for k in (0, 1, 2)]
        song = song_of(truth, slug=f"s{index}", words=words)
        over = 0.4 if held and index < worse else 0.0
        doc = [
            line(
                i,
                words[3 * i][0],
                words=tuple(
                    lib.DocWord(
                        start + (0.05 if moved_onset and i == 0 and k == 0 else 0.0),
                        end + (over if k < 2 else (0.0 if held else -0.12)),
                        True,
                    )
                    for k, (start, end) in enumerate(words[3 * i : 3 * i + 3])
                ),
            )
            for i in range(3)
        ]
        got = claims(song, "blind")
        rows.append(
            lib.row_of(
                song=song,
                mode="blind",
                variant=0,
                claims=got,
                outcome=lib.PUBLISHED,
                doc=doc,
                # The digest the `onsets-unchanged` gate reads: the real drivers record it from the written
                # document, and it is starts only, so a held END must leave it alone (`lib.onset_digest`).
                extra={"onsets_sha256": lib.onset_digest(doc)},
            )
        )
    return rows


def test_the_word_end_reject_if_file_reads_the_gain_the_songs_that_lose_and_any_moved_onset() -> None:
    """`gates/w4-ends.yaml` is the encodable half of review §3.5, and it is read hours after a sweep starts,
    so a mistyped mode or metric must not read as a clean run (an unmeasured key is an ERROR by design).

    Each of its four conditions is exercised in the direction it exists for: the two gain gates FAIL on the
    control's own rows (a run compared with itself gains nothing — the non-vacuity check the W3 gate files set
    the habit of); the per-song gate tolerates 3 songs losing word-end ±100 and fails at 4, which is exactly
    where the review drew it; and ONE moved onset fails `onsets-unchanged` while every other gate still
    passes, which is the whole point of the item."""
    rules = gates.parse_gates((GATES_DIR / "w4-ends.yaml").read_text(encoding="utf-8"))
    assert len(rules) == 5, "the 5 the file's header reports; `run_gates` adds the built-in no-error-rows"
    control = gates.view_of(document(ends_rows(held=False), **SETUP))

    def statuses(**kw: Any) -> dict[str, str]:
        view = gates.view_of(document(ends_rows(**kw), **SETUP))
        return {r.gate.name: r.status for r in gates.run_gates(rules, view, control)}

    assert set(statuses(held=True).values()) == {"PASS"}
    assert statuses(held=False) == {
        "no-error-rows": "PASS",
        "highlight-up-at-least-5": "FAIL",
        "final-end-pm100-up-at-least-10": "FAIL",
        "end-pm100-worse-on-at-most-3-songs": "PASS",
        "onsets-unchanged": "PASS",
        "word-pm300-not-down": "PASS",
    }
    assert set(statuses(held=True, worse=3).values()) == {"PASS"}, "3 of 6 songs is the review's tolerance"
    failed = [name for name, status in statuses(held=True, worse=4).items() if status != "PASS"]
    assert failed == ["end-pm100-worse-on-at-most-3-songs"]
    onset = [name for name, status in statuses(held=True, moved_onset=True).items() if status != "PASS"]
    assert onset == ["onsets-unchanged"], "one word 50 ms late is a rejection on its own"


def test_compare_prints_deltas_warns_on_a_level_mismatch_and_names_the_songs_that_moved(
    views: tuple[Any, Any],
) -> None:
    table = gates.format_compare(*views)
    assert "WARNING: level differs" in table
    assert "== truth" in table and "gross 5 (+5)" in table and "±500 83.3 (-16.7)" in table
    assert "songs gross up: s1 +5; down: -" in table
    assert "songs gross up: -; down: s1 -5" in table, "jit's s1 lost its gross lines"


#: A run's measurement setup, as `e2e.py` writes it to `run.json` and into the summary's meta.
SETUP = {
    "level": "time_text",
    "model": "M",
    "seed": 0,
    "wrong_k": 10,
    "language": "en",
    "tfr_audio": "youtube",
}


def test_the_cli_summarizes_compares_and_gates_with_an_exit_code(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    run_rows = tmp_path / "rows.jsonl"
    run_rows.write_text("".join(json.dumps(r) + "\n" for r in spread_rows([0.1, 3.0])))
    (tmp_path / "run.json").write_text(json.dumps(SETUP))
    base = tmp_path / "base"
    base.mkdir()
    (base / "summary.json").write_text(json.dumps(document(spread_rows([0.1, 0.1]), **SETUP)))
    rules = tmp_path / "gates.yaml"
    rules.write_text("holds: truth.pm500 >= base.truth.pm500 - 30\nno-new-gross: count(song.gross_up) == 0\n")
    code = e2e.main(["--summarize", str(run_rows), "--compare", str(base), "--gates", str(rules)])
    out = capsys.readouterr().out
    assert code == 3 and "PASS  holds" in out and "FAIL  no-new-gross" in out and "== compare" in out
    rules.write_text("holds: truth.pm500 >= base.truth.pm500 - 30\n")
    assert e2e.main(["--summarize", str(run_rows), "--compare", str(run_rows), "--gates", str(rules)]) == 0
    rules.write_text("holds: truth.pm500 >= base.truth.pm500 - 30\n")
    assert e2e.main(["--summarize", str(run_rows), "--gates", str(rules)]) == 3, "no baseline: ERROR rejects"


# ── level run_align, through the REAL workflow ───────────────────────────────────────────────────────


def test_run_align_runs_the_real_workflow_and_its_first_attempt_is_the_time_text_call(
    rig: tuple[Any, Any], tmp_path: Path
) -> None:
    driver, song = rig
    job = e2e.RunAlignDriver(aligner=driver.aligner, corpus=driver.corpus, media_root=tmp_path / "ra")
    row = job.run(e2e.Case(song, "truth", 0))
    assert row["outcome"] == lib.PUBLISHED and row["terminal"] == "published"
    assert (row["published_label"], row["published_attempt"], row["published_knobs"]) == (
        "captions:authored",
        1,
        [],
    )
    (only,) = row["attempts"]
    assert (only["text"], only["tier"], only["decision"], only["gross"]) == (
        "captions:authored",
        "candidate",
        "accept",
        0,
    )
    assert [e["verdict"] for e in row["trail"]] == ["accept"] and row["changed_vs_first"] is False
    stem = tmp_path / "ra" / "synthetic" / "truth" / "derived" / "stems" / "synthetic-vocals.wav"
    assert stem.resolve() == song.vocals.resolve(), "the stem sits where a stems job leaves it"
    direct = driver.run(e2e.Case(song, "truth", 0))
    assert (tmp_path / "ra" / row["ref"]).read_bytes() == (driver.media_root / direct["ref"]).read_bytes()
    assert row["line_errors"] == direct["line_errors"] and row["highlight"] == direct["highlight"]


def test_run_align_serves_an_untimed_sheet_through_the_provider(rig: tuple[Any, Any], tmp_path: Path) -> None:
    driver, song = rig
    job = e2e.RunAlignDriver(aligner=driver.aligner, corpus=driver.corpus, media_root=tmp_path / "ra")
    row = job.run(e2e.Case(song, "blind", 0))
    assert row["outcome"] == lib.PUBLISHED and row["published_label"] == "lrclib"
    assert row["ref"].endswith("synthetic-lrclib-word.json")


#: Level run_align's H2 rig: the phrases end at 37 s of 60, so stem coverage is THIN (< 0.80) and the
#: policy retries on the mix — whose vocals, here, sit 3 s later than the stem's. No repeated line, so
#: no R3 re-decode blurs which attempt produced what.
TAIL = 60.0
MIX_LAG = 3.0
UNIQUE = [
    (f"line {word} sung here", start, end) for word, (_t, start, end) in zip("abcdefgh", PHRASES, strict=True)
]


class TwoTrackAligner:
    """Emissions that follow the file: the mix hears every phrase `MIX_LAG` late."""

    def __init__(self, mix: Path) -> None:
        self.mix = os.path.realpath(mix)

    def emissions(self, path: str, _language: str) -> VoicedEmissions:
        lag = MIX_LAG if os.path.realpath(path) == self.mix else 0.0
        voiced = [0.0] * int(TAIL / FRAME)
        for _text, start, end in UNIQUE:
            for frame in range(int((start + lag) / FRAME), int((end + lag) / FRAME)):
                voiced[frame] = 1.0
        return VoicedEmissions(log_probs=voiced, frame_sec=FRAME, dictionary=DIC)

    def align(self, *_a: object, **_k: object) -> tuple[()]:
        raise AssertionError("the global path must not fall back to the windowed aligner")


def test_h2_fixed_the_thin_coverage_stem_document_publishes_with_no_mix_retry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Review H2 as the harness sees it, FIXED (W1). This rig once recorded the swap: the stem document
    (1 gross) replaced by the mix retry's (7), written over the same ref. The global engine reads no mix
    knob now (R4 is its per-line mix witness), so the thin-coverage stem document is the one published."""

    spread_decodes(monkeypatch)
    vocals = write_voiced(tmp_path / "vocals.wav", TAIL, phrases=UNIQUE)
    mix = write_voiced(tmp_path / "mix.wav", TAIL, lag=MIX_LAG, phrases=UNIQUE)
    song = lib.Song(
        slug="synthetic",
        group="jamendo",
        mix=mix,
        vocals=vocals,
        truth=tuple(lib.TruthLine(t, s, e) for t, s, e in UNIQUE),
    )
    job = e2e.RunAlignDriver(aligner=TwoTrackAligner(mix), corpus=[song], media_root=tmp_path / "media")
    # BLIND, so no claim window pulls the mix decode back (with claims, R1/R2 re-decode it in place).
    row = job.run(e2e.Case(song, "blind", 0))
    (first,) = row["attempts"]
    assert (first["knobs"], first["decision"], first["coverage"] < 0.8) == ([], "accept", True)
    assert (first["gross"], first["w500"]) == (1, 6)
    assert (row["published_attempt"], row["published_knobs"], row["published_file_attempt"]) == (1, [], 1)
    assert (row["outcome"], row["gross"], row["w500"], row["changed_vs_first"]) == (
        lib.PUBLISHED,
        1,
        6,
        False,
    )
    policy = lib.summarize([row])["blind"]["all"]["policy"]
    assert (policy["mix_published"], policy["retimes"], policy["changed_vs_first"]) == (0, {}, 0)
    assert not (tmp_path / "media" / "synthetic" / "blind" / "attempts").exists()
    assert e2e._policy_note(row) == "  attempts 1"


#: A text that survives the adapters' cleaning (`clean_line` keeps any line with an alphanumeric char)
#: but holds no char the aligner's dictionary knows: a count-in. `♪`-only lines would not do — cleaning
#: drops them before any attempt, exactly as production does (pinned below). Claimed where the rig's
#: stem is SILENT (its phrases end at 37 s), so its LINE_SYNC rung is refused by the sheet-span gate
#: (r 0.25, at an 8 s lag); `COUNT_IN_ON_THE_SINGING` is a count-in claimed on three sung phrases.
UNSINGABLE = [("1 2 3 4", 38.0, 39.0), ("5 6 7 8", 39.0, 39.8)]
COUNT_IN_ON_THE_SINGING = [("1 2 3 4", 5.0, 7.0), ("5 6 7 8", 8.0, 10.0), ("9 10 11 12", 12.0, 14.5)]


class HeardTranscriber:
    """A `Transcriber` that hears the rig's phrases, as whisper would on the stem."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    def transcribe(self, audio_path: str, *, language: str | None = None) -> ports.Transcribed:
        self.calls.append(audio_path)
        return ports.Transcribed(
            segments=tuple({"text": text, "start": start, "end": end} for text, start, end in PHRASES)
        )


def test_a_text_with_nothing_to_align_walks_the_whole_ladder_to_no_lyrics(
    rig: tuple[Any, Any], tmp_path: Path
) -> None:
    """LINE_SYNC after a declined attempt, refused by the sheet-span gate, ASR (none here), GiveUp."""
    driver, synthetic = rig
    song = song_of(UNSINGABLE, slug="instrumental", audio=synthetic.vocals)
    job = e2e.RunAlignDriver(aligner=driver.aligner, corpus=[song], media_root=tmp_path / "ra")
    row = job.run(e2e.Case(song, "truth", 0))
    assert (row["outcome"], row["terminal"], row["published_label"]) == (lib.REFUSED, "no-lyrics", None)
    first, second = row["attempts"]
    assert (first["result"], first["decision"], first["verdict"]) == ("none", "retime", "declined")
    assert (second["knob"], second["result"], second["decision"]) == ("line-sync", "refused", "next")
    assert [e["verdict"] for e in row["trail"]] == ["retime", "next", "asr-fallback", "give-up"]
    # "bundle unnamed" because this rig's matrices are numpy fakes: the shipped `ml.Emissions` always names
    # its bundle and the rung's note opens with it (W4b review r1, `align_steps._bundle_why`).
    assert str(row["trail"][1]["why"]).startswith("line sync refused: bundle unnamed; sheet-span envelope r=")
    assert row["asr_requested"] is True
    assert row["transcriptions"] == [
        {"on_vocals": True, "heard": False},
        {"on_vocals": False, "heard": False},
    ]
    assert lib.summarize([row])["truth"]["all"]["policy"]["no_lyrics"] == 1


def test_a_count_in_on_the_singing_line_syncs_and_publishes(rig: tuple[Any, Any], tmp_path: Path) -> None:
    """Review M1 through the harness: an unalignable text claimed on the singing passes the sheet-span gate
    (r 0.50 at zero lag) and its LINE_SYNC document is the one published — no longer dropped for ASR and
    then NO LYRICS."""
    driver, synthetic = rig
    song = song_of(COUNT_IN_ON_THE_SINGING, slug="count-in", audio=synthetic.vocals)
    job = e2e.RunAlignDriver(aligner=driver.aligner, corpus=[song], media_root=tmp_path / "ra")
    row = job.run(e2e.Case(song, "truth", 0))
    assert (row["outcome"], row["terminal"], row["published_attempt"]) == (lib.LINE_SYNC, "published", 2)
    first, second = row["attempts"]
    assert (first["result"], first["decision"]) == ("none", "retime")
    assert (second["knob"], second["result"], second["decision"]) == ("line-sync", "line", "accept")
    assert second["ref"].endswith("count-in-captions-authored-line-sync-line.json")
    assert (row["published_file_attempt"], row["asr_requested"]) == (2, False)


def test_sheet_gate_measures_the_shipped_gate_in_both_shapes(rig: tuple[Any, Any]) -> None:
    """`scripts/sheet_gate.py`, the LINE_SYNC gate's calibration: parse_lrc's shape is rebuilt from the
    served claims, and the verdicts are the shipped functions'. A sheet on the singing passes as captions;
    as an LRC its spans tile the song's short breaks and the fit loses shape (why LRC right texts pass
    less); the same lines claimed elsewhere are refused in both shapes."""
    from encore_worker.adapters.ml import load_audio_mono_16k

    _driver, synthetic = rig
    served = [{"text": t, "start": s, "end": e} for t, s, e in reversed(PHRASES)]
    lrc = sheet_gate.lrc_shaped(served)
    assert [line["start"] for line in lrc] == sorted(s for _t, s, _e in PHRASES)
    assert [line.get("end") for line in lrc] == [line["start"] for line in lrc[1:]] + [None]
    signal = load_audio_mono_16k(str(synthetic.vocals))
    right = sheet_gate.measure_case(signal, served)
    assert right["caption"]["passes"] and right["caption"]["literal"]
    assert right["lrc"]["r"] < right["caption"]["r"]
    elsewhere = [{"text": t, "start": s + 19.0, "end": e + 19.0} for t, s, e in PHRASES[:3]]
    wrong = sheet_gate.measure_case(signal, elsewhere)
    assert not wrong["caption"]["passes"] and not wrong["lrc"]["passes"]
    rows = [{"mode": "truth", **right}, {"mode": "wrongtext", **wrong}]
    first = sheet_gate.summarize(rows)[0].split()
    assert first == ["caption", "shipped", "wrong", "0/1", "right", "1/1", "truth", "1/1"]


def test_the_asr_fallback_publishes_a_transcript_that_is_reported_not_scored(
    rig: tuple[Any, Any], tmp_path: Path
) -> None:
    driver, synthetic = rig
    song = song_of(UNSINGABLE, slug="instrumental", audio=synthetic.vocals)
    heard = HeardTranscriber()
    job = e2e.RunAlignDriver(
        aligner=driver.aligner, corpus=[song], media_root=tmp_path / "ra", transcriber=heard
    )
    row = job.run(e2e.Case(song, "truth", 0))
    assert (row["outcome"], row["terminal"], row["published_label"]) == (
        lib.REFUSED,
        "published",
        "asr:vocals",
    )
    assert row["attempts"][-1]["tier"] == "asr" and "gross" not in row["attempts"][-1]
    assert row["scored"] == 0 and len(heard.calls) == 1
    assert lib.summarize([row])["truth"]["all"]["policy"]["asr_published"] == 1


def test_the_transcript_cache_serves_disk_hits_and_remembers_hearing_nothing(tmp_path: Path) -> None:
    audio = tmp_path / "vocals.wav"
    audio.write_bytes(b"RIFF....")
    store = lib.TranscriptStore(tmp_path / "_transcripts", model="whisper:base", emitter="e")
    heard = HeardTranscriber()
    first = lib.CachedTranscriber(heard, store)
    got = first.transcribe(str(audio), language="en")
    again = lib.CachedTranscriber(heard, store).transcribe(str(audio), language="en")
    assert list(again.segments) == list(got.segments)
    assert len(heard.calls) == 1 and dict(first.served) == {"computed": 1}

    class Deaf:
        def transcribe(self, audio_path: str, *, language: str | None = None) -> ports.Transcribed:
            heard.calls.append(audio_path)
            return ports.Transcribed(segments=())

    quiet = lib.TranscriptStore(tmp_path / "_transcripts", model="whisper:tiny", emitter="e")
    assert not lib.CachedTranscriber(Deaf(), quiet).transcribe(str(audio)).segments
    cached = lib.CachedTranscriber(Deaf(), quiet)
    assert not cached.transcribe(str(audio)).segments and dict(cached.served) == {"disk": 1}
    assert len(heard.calls) == 2 and not list(store.directory.glob("*.tmp"))


def test_the_transcript_cache_remembers_the_language_whisper_heard(tmp_path: Path) -> None:
    """Review M8, W7: whisper's detection is half the port's return value now, so a cache that stored only the
    segments would route a REPLAYED `run_align` case to the default bundle where a cold one routed it to the
    song's own — a cached run and a fresh run would then measure different configurations. An entry written
    before the field existed has no `language` key and reads as None, which is what it recorded."""
    audio = tmp_path / "vocals.wav"
    audio.write_bytes(b"RIFF....")

    class Foreign:
        def __init__(self) -> None:
            self.calls = 0

        def transcribe(self, audio_path: str, *, language: str | None = None) -> ports.Transcribed:
            self.calls += 1
            return ports.Transcribed(segments=({"text": "je suis", "start": 0.0, "end": 1.0},), language="fr")

    store = lib.TranscriptStore(tmp_path / "_t", model="whisper:base", emitter="e")
    inner = Foreign()
    assert lib.CachedTranscriber(inner, store).transcribe(str(audio)).language == "fr"
    replayed = lib.CachedTranscriber(inner, store)
    assert replayed.transcribe(str(audio)).language == "fr"
    assert inner.calls == 1 and dict(replayed.served) == {"disk": 1}

    stored = json.loads(next(iter((tmp_path / "_t").glob("*.json"))).read_text(encoding="utf-8"))
    del stored["language"]
    next(iter((tmp_path / "_t").glob("*.json"))).write_text(json.dumps(stored), encoding="utf-8")
    assert lib.CachedTranscriber(inner, store).transcribe(str(audio)).language is None


def test_summary_json_keeps_one_line_per_song_and_reads_back_unchanged() -> None:
    rows = [*spread_rows([0.1, 3.0]), *spread_rows([0.2, 0.3], mode="jit")]
    doc = document(rows, level="time_text")
    text = lib.dump_document(doc)
    assert json.loads(text) == json.loads(json.dumps(doc))
    assert sum(1 for line in text.splitlines() if line.startswith('   "s1": {"group": "jamendo"')) == 2
    assert json.loads(lib.dump_document({"songs": {"m": {"s": {"x": 1}}}})) == {
        "songs": {"m": {"s": {"x": 1}}}
    }
    assert json.loads(lib.dump_document({"meta": {}})) == {"meta": {}}


def test_a_song_that_lost_its_value_fails_a_per_song_delta_instead_of_dropping_out() -> None:
    """Refused now, scored before: the worst regression must not vanish from `min_song_delta`."""
    scored = spread_rows([0.1, 0.1])
    refused = [
        scored[0],
        lib.row_of(
            song=song_of(TEN, slug="s1"),
            mode="truth",
            variant=0,
            claims=claims(song_of(TEN, slug="s1"), "truth"),
            outcome=lib.REFUSED,
            doc=[],
        ),
    ]
    now, before = gates.view_of(document(refused)), gates.view_of(document(scored))
    with pytest.raises(gates.GateError, match=r"s1 \(truth\) had a value in the baseline"):
        gates.evaluate("min_song_delta(truth.pm500) >= -1", now, before)
    assert gates.evaluate("count(song.refused_up) == 1 and count(song.gross_down) == 0", now, before)[0]
    assert gates.evaluate("min_song_delta(truth.pm500) >= -1", before, now)[0], (
        "a song that GAINED is skipped"
    )


# ── review round 1: denominators, gates, identity, provenance ────────────────────────────────────────

#: Two Jamendo-shaped songs with word truth: 2 lines of 3 words, each word sung for 0.3 s.
WORDED = [("fly away home", 1.0, 2.0), ("come back soon", 3.0, 4.0)]
WORD_SPANS = [(1.0, 1.3), (1.3, 1.6), (1.6, 1.9), (3.0, 3.3), (3.3, 3.6), (3.6, 3.9)]


def exact_doc(song: Any, claims_: Any) -> list[Any]:
    """Every claimed truth line published exactly on its truth words."""
    out = []
    for position, claim in enumerate(claims_.lines):
        if claim.truth is None:
            continue
        first = sum(len(t.text.split()) for t in song.truth[: claim.truth])
        words = tuple(
            lib.DocWord(song.words[first + k].start, song.words[first + k].end, True, w)
            for k, w in enumerate(song.truth[claim.truth].text.split())
        )
        out.append(lib.DocLine(claim.text, words[0].start, words[-1].end, "high", position, words))
    return out


def worded(slug: str) -> Any:
    return song_of(WORDED, slug=slug, words=WORD_SPANS)


def test_a_refused_case_stays_in_every_denominator_that_counts_the_text() -> None:
    """Review r1 (correctness-1, spec-8, tests-15): a refused row used to carry no word or highlight
    denominator, and `missing` summed published rows only, so refusing a song RAISED PCO and the
    highlight. Now its words, sung seconds and lines stay in; only e2e2's published-only ±500 ignores it."""
    good, bad = worded("good"), worded("bad")
    published = lib.row_of(
        song=good,
        mode="truth",
        variant=0,
        claims=claims(good, "truth"),
        outcome=lib.PUBLISHED,
        doc=exact_doc(good, claims(good, "truth")),
    )
    refused = lib.row_of(
        song=bad, mode="truth", variant=0, claims=claims(bad, "truth"), outcome=lib.REFUSED, doc=[]
    )
    assert refused["words"]["in_text"] == 6 and refused["words"]["errors"] == []
    assert refused["highlight"] == {"hit": 0.0, "sung": pytest.approx(1.8)}
    alone, both = (
        lib.summarize([published])["truth"]["all"],
        lib.summarize([published, refused])["truth"]["all"],
    )
    assert (alone["words"]["pco300_pct"], both["words"]["pco300_pct"]) == (100.0, 50.0)
    assert (both["words"]["in_text"], both["words"]["unpublished"], both["words"]["w300_pct"]) == (
        12,
        6,
        100.0,
    )
    assert (alone["highlight"]["pct"], both["highlight"]["pct"]) == (100.0, 50.0)
    assert both["highlight"]["unpublished"] == 1
    lines = both["lines"]
    assert (lines["refused"], lines["missing"], lines["w500_pct"], lines["w500_text_pct"]) == (
        1,
        2,
        100.0,
        50.0,
    )
    ci = both["ci"]
    for name, point in (("text_pm500", 50.0), ("word_pco300", 50.0), ("highlight", 50.0), ("pm500", 100.0)):
        assert ci[name][0] <= point <= ci[name][1], name
    table = lib.format_summary({"truth": {"jamendo": both}})
    assert "(unpublished 6)" in table and "1 published nothing" in table and "±500/text" in table


def test_an_error_row_is_not_a_refused_wrong_text_and_fails_the_gate_run() -> None:
    """Review r1 (tests-16): an ERROR used to sit in the wrong-text denominator as a refusal, so a helper
    that raised on some texts LOWERED the pass rate and passed W3's 'must fall' gate on a crash."""
    jam, other = song_of(TEN, slug="j"), song_of(TEN, slug="o", group="youtube")
    rows = [
        lib.row_of(
            song=jam,
            mode="wrongtext",
            variant=v,
            claims=claims(jam, "wrongtext", [jam, other], variant=v, wrong_k=3),
            outcome=outcome,
            doc=[],
        )
        for v, outcome in enumerate((lib.PUBLISHED, lib.REFUSED, lib.ERROR))
    ]
    entry = lib.summarize(rows)["wrongtext"]["all"]
    assert entry["wrongtext"] == {"pairs": 2, "published": 1, "errors": 1, "pass_rate_pct": 50.0}
    assert "(1 ERROR rows left out)" in lib.format_summary({"wrongtext": {"all": entry}})
    assert lib.per_song(rows)["wrongtext"]["j"]["error"] == 1.0
    view = gates.view_of(document(rows))
    builtin = gates.run_gates([gates.Gate("pass", "wrongtext.wrongtext_pass <= 50")], view, None)
    assert [(r.gate.name, r.status) for r in builtin] == [("no-error-rows", "FAIL"), ("pass", "PASS")]
    assert "wrongtext 1" in builtin[0].detail
    clean = gates.view_of(document(rows[:2]))
    assert gates.error_rows_gate(clean).status == "PASS"


def test_error_rows_exit_3_even_without_a_gate_file(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    rows = spread_rows([0.1, 0.1])
    path = tmp_path / "rows.jsonl"
    path.write_text("".join(json.dumps(r) + "\n" for r in rows))
    assert e2e.main(["--summarize", str(path)]) == 0
    broken = {**rows[1], "outcome": lib.ERROR, "exception": "boom"}
    path.write_text("".join(json.dumps(r) + "\n" for r in (rows[0], broken)))
    assert e2e.main(["--summarize", str(path)]) == 3
    assert "FAIL  no-error-rows" in capsys.readouterr().out


def test_a_label_stripped_line_scores_as_the_lyric_it_is() -> None:
    """Review r1 (correctness-3): the `headers` mode's inline label paired only when it PUBLISHED, so a
    W5 rule that strips `CHORUS:` (M11) read as mismatched and lit wrong — worse than the bug. Measured on
    this rig: stripped 3/6 aligned and 0.9/1.8 s lit before the fix; now 6/6 and 1.8/1.8 s either way."""
    song = worded("s")
    got = lib.Claims(
        lines=(
            lib.ClaimLine("CHORUS: fly away home", 1.0, 2.0, truth=0, lead_words=1),
            lib.ClaimLine("come back soon", 3.0, 4.0, truth=1),
        ),
        timed=True,
    )
    stripped = exact_doc(song, got)
    kept = [
        lib.DocLine(
            "CHORUS: fly away home",
            0.8,
            1.9,
            "high",
            0,
            (lib.DocWord(0.8, 1.0, True, "CHORUS:"), *stripped[0].words),
        ),
        stripped[1],
    ]
    for doc in (stripped, kept):
        score = lib.score_words(song, got, doc)
        assert (len(score.errors), score.mismatched) == (6, 0)
        assert lib.score_highlight(song, got, doc) == pytest.approx((1.8, 1.8))
    two_extra = [lib.DocLine("x", 0.5, 1.9, "high", 0, (lib.DocWord(0.5, 0.6, True, "x"), *kept[0].words))]
    assert lib.score_words(song, got, two_extra).mismatched == 3, "any other count is still mismatched"


def test_a_documents_source_lines_do_not_read_as_a_changed_document() -> None:
    """W1 r1: the worker records a document's whole text (`sourceLines`) when its lines lost some of it, for
    a later re-pick. The TV never reads it, so the digest is of the bytes the worker writes WITHOUT it — a
    document written before the key existed and the same document with it compare equal — while any
    change to what the TV renders still changes it."""
    from encore_worker.steps.align_steps import _with_source_lines

    doc: dict[str, object] = {"language": "en", "lines": [{"text": "hello", "start": 0.1 + 0.2, "end": 1.5}]}
    before = json.dumps(doc, ensure_ascii=False).encode("utf-8")
    with_text = _with_source_lines(doc, ({"text": "hello"}, {"text": "never sung ♪"}))
    after = json.dumps(with_text, ensure_ascii=False).encode("utf-8")
    assert after != before and lib.SOURCE_LINES_KEY in with_text
    assert lib.doc_digest(after) == lib.doc_digest(before) == hashlib.sha256(before).hexdigest()[:16]
    moved = json.dumps({**with_text, "lines": [{"text": "hello", "start": 0.4, "end": 1.5}]}).encode("utf-8")
    assert lib.doc_digest(moved) != lib.doc_digest(before)
    assert lib.doc_digest(b"not json") == hashlib.sha256(b"not json").hexdigest()[:16]


def test_documents_are_digested_per_song_for_the_doc_changed_gates() -> None:
    """Review r1 (spec-14): W1's reject-if — 'a published doc changes on a song whose stem coverage is
    >= 0.80' — had nothing to read: no document digest and no attempt-1 coverage per song."""
    song = worded("s")
    doc = exact_doc(song, claims(song, "truth"))
    moved = [dataclasses_replace(doc[0], start=doc[0].start + 0.01), doc[1]]
    ended = [doc[0], dataclasses_replace(doc[1], end=doc[1].end + 0.2)]
    assert lib.onset_digest(doc) == lib.onset_digest(ended) != lib.onset_digest(moved)

    def row(slug: str, digest: str | None, lines: Any, coverage: float) -> Any:
        extra = {"doc_sha256": digest, "onsets_sha256": lib.onset_digest(lines) if lines else None}
        extra["first_coverage"] = coverage
        s = worded(slug)
        outcome = lib.PUBLISHED if lines else lib.REFUSED
        return lib.row_of(
            song=s,
            mode="truth",
            variant=0,
            claims=claims(s, "truth"),
            outcome=outcome,
            doc=lines,
            extra=extra,
        )

    base = [row("a", "d1", doc, 0.95), row("b", "d2", doc, 0.5), row("c", "d3", doc, 0.9)]
    run = [row("a", "d1", ended, 0.95), row("b", "d9", moved, 0.5), row("c", None, [], 0.0)]
    per = lib.per_song(run)["truth"]
    assert (per["a"]["doc"], per["c"]["doc"], per["c"]["coverage"]) == ("d1", lib.NO_DOCUMENT, 0.0)
    views = (gates.view_of(document(run)), gates.view_of(document(base)))
    assert held("count(song.doc_changed) == 2 and count(song.onsets_changed) == 2", views)
    assert held("count(song.doc_changed * (base.song.coverage >= 0.8)) == 1", views), "c vanished at 0.9"
    assert held("count(song.onsets_changed * (base.song.coverage < 0.8)) == 1", views), "b's onset moved"
    raw = gates.view_of(document([{**r, "doc_sha256": None} for r in run[:1]] + run[1:]))
    del raw.songs["truth"]["a"]["doc"]
    with pytest.raises(gates.GateError, match="no `doc` digest"):
        gates.evaluate("count(song.doc_changed) == 0", raw, views[1])


def dataclasses_replace(obj: Any, **changes: Any) -> Any:
    import dataclasses

    return dataclasses.replace(obj, **changes)


def lost_views() -> tuple[Any, Any]:
    """BASE: songs a (90) and b (80) under truth and off15. RUN: b refused under truth; off15 not run."""

    def at(slug: str, err: float, mode: str, outcome: str = lib.PUBLISHED) -> Any:
        s = song_of(TEN, slug=slug)
        doc = [line(k, t.start + (err if k % 5 == 0 else 0.0)) for k, t in enumerate(s.truth)]
        return lib.row_of(
            song=s,
            mode=mode,
            variant=0,
            claims=claims(s, mode),
            outcome=outcome,
            doc=doc if outcome == lib.PUBLISHED else [],
        )

    base = [at("a", 0.9, "truth"), at("b", 3.0, "truth"), at("a", 0.9, "off15"), at("b", 3.0, "off15")]
    run = [at("a", 0.9, "truth"), at("b", 3.0, "truth", lib.REFUSED)]
    return gates.view_of(document(run)), gates.view_of(document(base))


@pytest.mark.parametrize(
    ("expr", "why"),
    [
        # A song that LOST its value, spelled explicitly: correctness-2.
        ("min(truth.song.pm500 - base.truth.song.pm500) >= -1", "had a value in the baseline"),
        ("count(truth.song.pm500 < base.truth.song.pm500 - 1) == 0", "had a value in the baseline"),
        ("min_song_delta(truth.pm500) >= -1", "had a value in the baseline"),
        # A reduction over a song with no value: spec-10.
        ("min(truth.song.pm500) >= 85", "no value"),
        ("count(truth.song.pm500 < 85) == 0", "no value"),
        # Modes / songs the run did not measure: spec-10.
        ("count(song.gross_up) == 0", "did not measure"),
        ("count(jamendo.song.gross_up) == 0", "did not measure"),
        ("count(song.refused_up) == 1", "did not measure"),
        ("min_song_delta(jamendo.gross) >= 0", "did not measure"),
        ("count(off15.song.gross - base.off15.song.gross > 0) == 0", "no per-song data"),
    ],
)
def test_a_per_song_gate_never_passes_over_a_song_that_lost_its_value_or_was_not_run(
    expr: str, why: str
) -> None:
    """Review r1: every one of these used to PASS (`1 >= -1`, `0 == 0`) on this pair of summaries."""
    with pytest.raises(gates.GateError, match=why):
        gates.evaluate(expr, *lost_views())


def test_per_song_gates_still_read_what_was_measured() -> None:
    run, base = lost_views()
    truth_only = gates.View(modes=base.modes, songs={"truth": base.songs["truth"]}, meta={})
    assert gates.evaluate("count(truth.song.refused_up) == 1", run, truth_only)[0]
    assert gates.evaluate("min(truth.song.text_pm500) == 0", run, base)[0], "a refusal reads 0 over its text"
    assert gates.evaluate("count(truth.song.gross_down) == 1", run, truth_only)[0]
    gained = gates.evaluate("min(truth.song.pm500 - base.truth.song.pm500) >= -1", base, run)
    assert gained[0] and gained[1] == "0 >= -1", "a song that GAINED a value is skipped, as in min_song_delta"


def test_a_pooled_baseline_comparison_needs_the_same_songs() -> None:
    """A `--songs` run against the full baseline pooled 1 song against 2 and gated on the difference."""
    run, base = lost_views()
    fewer = gates.View(modes=run.modes, songs={"truth": {"a": run.songs["truth"]["a"]}}, meta={})
    with pytest.raises(gates.GateError, match=r"not measured: b"):
        gates.evaluate("truth.pm500 >= base.truth.pm500 - 1", fewer, base)
    with pytest.raises(gates.GateError, match="only in the run: b"):
        gates.evaluate("delta(truth.gross) <= 0", base, fewer)
    assert gates.evaluate("truth.text_pm500 < base.truth.text_pm500", run, base)[0]


def test_identity_that_falls_back_to_text_on_a_word_timed_document_is_an_error_row(
    rig: tuple[Any, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Review r1 (correctness-7): a capture miss silently reverted a row to e2e2's text pairing."""
    import contextlib

    driver, song = rig
    assert driver.run(e2e.Case(song, "truth", 0))["identity"] == "captured"

    @contextlib.contextmanager
    def blind_capture() -> Any:
        yield []

    monkeypatch.setattr(e2e, "capture_generated", blind_capture)
    row = driver.run(e2e.Case(song, "truth", 0))
    assert row["outcome"] == lib.ERROR and row["identity"] == "text"
    assert "F1 mispairing" in row["exception"] and row["scored"] == 0
    assert lib.line_metrics([row])["text_paired"] == 1
    assert e2e.unpaired_word_doc("text", "line") is None, "a line-synced document may pair by text"


def test_the_drivers_build_the_shipped_steps_with_the_config_they_are_given(
    rig: tuple[Any, Any], monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Review r1 (correctness-6): every driver built a bare `Config()`, so an ENCORE_ALIGN_* knob set for an
    arm run never reached the shipped code. `main` reads `Config.from_env()`; the drivers pass it on."""
    from encore_worker.host.config import Config, ConfigError

    driver, song = rig
    seen: list[Any] = []
    real = e2e.AlignStepsImpl

    class Recording(real):  # type: ignore[misc, valid-type]
        def __init__(self, *, config: Any, **kw: Any) -> None:
            seen.append(config)
            super().__init__(config=config, **kw)

    monkeypatch.setattr(e2e, "AlignStepsImpl", Recording)
    probe = Config(worker_id="bench-probe")
    for level in (e2e.TimeTextDriver, e2e.RunAlignDriver):
        level(aligner=driver.aligner, corpus=driver.corpus, media_root=tmp_path / "m", config=probe).run(
            e2e.Case(song, "truth", 0)
        )
    assert seen == [probe, probe]

    def refuse(env: Any = None) -> Any:
        raise ConfigError("ENCORE_ASR_MODEL='bogus' is not a known checkpoint")

    monkeypatch.setattr(e2e.Config, "from_env", staticmethod(refuse))
    assert e2e.main(["--songs", "hello", "--out", str(tmp_path / "never")]) == 2
    assert "worker config: ENCORE_ASR_MODEL" in capsys.readouterr().err

    @dataclass(frozen=True)
    class WithArms:
        align_experiments: frozenset[str] = frozenset({"claim-clock", "lift"})
        align_model: str = "base"
        core_url: str = "ws://x"

    assert lib.align_config(WithArms()) == {"align_experiments": ["claim-clock", "lift"]}
    # No arm on is the default path, keyed as before the knob existed (W1 added it): the W0 emission cache
    # and baselines stay valid for a default run, and naming an arm still moves the key.
    assert lib.align_config(Config()) == {}
    assert lib.align_config(Config(align_model=None)) == {}
    # `align_model` IS NOT IN IT AT ALL (W4b review r2, spec-14 / correctness-6): it says how the operator
    # SPELLED the bundle, not what was computed, and it sits inside `emitter_fingerprint`, so recording it for
    # the env spelling alone gave one computation two emission-store namespaces — a cold recompute of 64
    # matrices for the recipe README and `Config.align_model` both give — plus a `--compare` warning between
    # two runs of the same bundle. The two spellings are now ONE fingerprint.
    assert lib.align_config(Config(align_model="HUBERT_ASR_LARGE")) == {}
    assert lib.SPELLING_ONLY == frozenset({"align_model"}), "and nothing else may be dropped from the record"
    flagged = e2e.emitter_fingerprint(Config())
    assert e2e.emitter_fingerprint(Config(align_model="HUBERT_ASR_LARGE")) == flagged, (
        "ENCORE_ALIGN_MODEL=X and --model X are the same computation and must key the same matrices"
    )
    assert e2e.emitter_fingerprint(Config(align_experiments=frozenset({"linesep"}))) != flagged, (
        "an arm still re-keys: only the bundle's SPELLING is dropped"
    )
    # ...AND THE KNOB IS LOADED, not only recorded (W4b review r1): `align_config` above wrote
    # `align_model: HUBERT_ASR_LARGE` into `run.json` while the aligner resolved this device's default, so the
    # command README gives for sweeping a non-default bundle measured the DEFAULT one under the candidate's
    # name — 2-3 hours of sweep labelled as the wrong model.
    assert e2e.resolve_bundle(None, Config(align_model="HUBERT_ASR_LARGE"), "en") == (
        "HUBERT_ASR_LARGE",
        None,
    )
    assert e2e.resolve_bundle("HUBERT_ASR_XLARGE", Config(), "en") == ("HUBERT_ASR_XLARGE", None)
    assert e2e.resolve_bundle(None, Config(), "en") == (None, None), "unset is this device's default"
    assert e2e.resolve_bundle(None, Config(align_model="HUBERT_ASR_LARGE"), "de") == (None, None), (
        "the knob is the ENGLISH bundle, as production applies it: it must not relabel another language"
    )
    both = e2e.resolve_bundle("HUBERT_ASR_LARGE", Config(align_model="WAV2VEC2_ASR_BASE_960H"), "en")
    assert both[0] is None and both[1] is not None and "disagrees with ENCORE_ALIGN_MODEL" in both[1]
    agree = e2e.resolve_bundle("HUBERT_ASR_LARGE", Config(align_model="HUBERT_ASR_LARGE"), "en")
    assert agree == ("HUBERT_ASR_LARGE", None), "naming the same bundle twice is not a conflict"
    assert lib.align_config(Config(align_experiments=frozenset({"l1-mix-kept"}))) == {
        "align_experiments": ["l1-mix-kept"]
    }


def test_a_resume_under_other_code_or_settings_is_refused(tmp_path: Path) -> None:
    """Review r1 (correctness-5): the resume guard compared settings only, and HEAD stays one commit for
    a whole uncommitted wave, so rows from two versions of `time_text` pooled under one meta record."""
    package = tmp_path / "encore_worker"
    (package / "__pycache__").mkdir(parents=True)
    (package / "a.py").write_text("x = 1\n")
    first = lib.tree_digest([package])
    (package / "__pycache__" / "a.cpython-312.pyc").write_bytes(b"\0")
    assert lib.tree_digest([package]) == first, "bytecode caches are not code"
    (package / "a.py").write_text("x = 2\n")
    assert lib.tree_digest([package]) != first
    started = {"level": "time_text", "code": "c1", "align_config": {}}
    path = tmp_path / "run.json"
    assert e2e.resume_refusal(path, started) is None, "nothing to resume"
    path.write_text(json.dumps(started))
    assert e2e.resume_refusal(path, started) is None
    refusal = e2e.resume_refusal(path, {**started, "code": "c2"})
    assert refusal is not None and "differs in: code" in refusal
    assert "align_config" in (e2e.resume_refusal(path, {**started, "align_config": {"align_x": 1}}) or "")
    assert lib.row_codes([{"code": "c1"}, {"code": "c2"}, {}]) == ["?", "c1", "c2"]
    mixed = gates.View(
        modes={}, songs={}, meta={"row_codes": ["c1", "c2"], "align_config": {"a": 1}, "code": "c2"}
    )
    plain = gates.View(modes={}, songs={}, meta={"row_codes": ["c1"], "align_config": {}, "code": "c1"})
    table = gates.format_compare(mixed, plain)
    assert "run's rows were measured on 2 different worker trees" in table
    assert "WARNING: align_config differs" in table
    # AND THE TWO SIDES' `code` IS PRINTED AS ITS OWN LINE (W4b review r2, spec-10). It is not a WARNING —
    # a wave's run differs from an earlier wave's baseline in code by definition, which is why `COMPARED_META`
    # leaves it out — but W4b's 6c linesep cell was read against a control measured on an EARLIER TREE OF THE
    # SAME WAVE and nothing said so, so eight failures were attributed wholly to the separator.
    assert "NOTE: code differs — run c2, base c1" in table
    same = gates.View(modes={}, songs={}, meta={"align_config": {}, "code": "c1"})
    assert "code differs" not in gates.format_compare(same, plain), "silent when the trees agree"


def test_the_tfr_songs_run_on_a_stem_separated_from_the_workers_own_mix_by_default(tmp_path: Path) -> None:
    """Review r1 (spec-13, M14): the tfr songs aligned on the producer's ORACLE vocals with the stems' sum
    as the mix. The default is now the youtube mix and a stem separated from it; the oracle pair is kept
    only to reproduce the review."""
    repo = tmp_path / "repo"
    for slug in lib.TFR_SLUGS:
        (repo / slug).mkdir(parents=True)
        (repo / slug / "truth-lines.json").write_text(
            json.dumps({"lines": [{"text": "a", "start": 0, "end": 1}]})
        )
    root = tmp_path / "bench"
    for slug in lib.YOUTUBE_SLUGS:
        (root / slug).mkdir(parents=True)
        (root / slug / "truth-lines.json").write_text(json.dumps({"lines": []}))
    youtube = {s.slug: s for s in lib.discover(root, repo) if s.slug in lib.TFR_SLUGS}
    chosen = youtube["tfr-chosen"]
    assert (chosen.mix, chosen.vocals) == (
        repo / "tfr-chosen" / "youtube-mix.wav",
        lib.tfr_stem(root, "tfr-chosen"),
    )
    assert lib.tfr_stem(root, "tfr-chosen") == root / "tfr-chosen" / "mix" / "vocals.wav"
    assert chosen.missing_files() == [str(chosen.mix), str(chosen.vocals)], "missing audio fails loudly"
    oracle = {s.slug: s for s in lib.discover(root, repo, tfr_audio=lib.TFR_REFERENCE)}["tfr-chosen"]
    assert (oracle.mix.name, oracle.vocals.name) == ("reference-mix.wav", "reference-vocals.wav")
    with pytest.raises(ValueError, match="tfr audio"):
        lib.discover(root, repo, tfr_audio="stems")


# ── run_align: the ports clean like production's, and the file the TV reads is what is scored ────────


def test_run_align_serves_cleaned_claims_and_pairs_them_back_by_identity(
    rig: tuple[Any, Any], tmp_path: Path
) -> None:
    """Review r1 (spec-12): the harness ports returned raw claim text where every production adapter
    returns `clean_segments(...)`, so text hygiene in `clean.py` could never reach a score. A `♪ ♪` line is
    dropped (renumbering the request) and `♪ … ♪` stripped; identity still pairs every line to truth."""
    driver, synthetic = rig
    phrases = [*PHRASES[:3], ("♪ ♪", 14.6, 15.0), (f"♪ {PHRASES[3][0]} ♪", *PHRASES[3][1:]), *PHRASES[4:]]
    song = song_of(phrases, slug="synthetic", audio=synthetic.vocals)
    job = e2e.RunAlignDriver(aligner=driver.aligner, corpus=[song], media_root=tmp_path / "ra")
    row = job.run(e2e.Case(song, "truth", 0))
    assert row["outcome"] == lib.PUBLISHED and row["served_lines"] == len(phrases) - 1
    assert (row["text_lines"], row["in_text"], row["doc_lines"]) == (9, 9, 8)
    assert [e[0] for e in row["line_errors"]] == [0, 1, 2, 4, 5, 6, 7, 8], "the ♪ ♪ line is truth line 3"
    assert row["gross"] == 0 and row["in_text"] - row["scored"] == 1
    assert row["pairing_disagreements"] is None, "e2e2's text pairing does not apply to a cleaned text"
    published = json.loads((tmp_path / "ra" / row["ref"]).read_text())
    assert published["lines"][3]["text"] == PHRASES[3][0], "cleaned exactly as the caption adapter cleans"
    only_notes = song_of([("♪ ♪", 5.0, 7.0), ("[♪♪♪]", 8.0, 10.0)], slug="notes", audio=synthetic.vocals)
    empty = e2e.RunAlignDriver(aligner=driver.aligner, corpus=[only_notes], media_root=tmp_path / "n")
    quiet = empty.run(e2e.Case(only_notes, "truth", 0))
    assert (quiet["outcome"], quiet["attempts"], quiet["terminal"]) == (lib.REFUSED, [], "no-lyrics")
    assert quiet["first_coverage"] == 0.0 and quiet["doc_sha256"] is None


def test_a_request_that_is_not_the_served_claims_is_an_error_row(
    rig: tuple[Any, Any], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from encore_worker.steps.records import TextRef

    driver, song = rig
    real = e2e.AlignStepsImpl.fetch_captions

    async def reworded(self: Any, job: Any, *, automatic: bool) -> Any:
        text = await real(self, job, automatic=automatic)
        if text is None:
            return None
        segments = tuple({**s, "text": str(s["text"]).upper()} for s in text.segments)
        return TextRef(tier=text.tier, label=text.label, segments=segments, timing=text.timing)

    monkeypatch.setattr(e2e.AlignStepsImpl, "fetch_captions", reworded)
    row = e2e.RunAlignDriver(aligner=driver.aligner, corpus=driver.corpus, media_root=tmp_path).run(
        e2e.Case(song, "truth", 0)
    )
    assert row["outcome"] == lib.ERROR and "not the served claims" in row["exception"]


def test_run_align_scores_the_file_the_tv_reads_and_errors_when_it_is_not_the_published_attempts(
    rig: tuple[Any, Any], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Review r1 (spec-9): the published attempt's bytes AS RETURNED were scored. A stem attempt and its mix
    retry share one ref, so a job that publishes attempt 1's record after attempt 2 overwrote the file (a
    partial W1 best-so-far) would show the room one document while the bench scored another."""
    driver, song = rig
    job = e2e.RunAlignDriver(aligner=driver.aligner, corpus=driver.corpus, media_root=tmp_path / "ok")
    fine = job.run(e2e.Case(song, "truth", 0))
    assert (fine["outcome"], fine["published_file_attempt"]) == (lib.PUBLISHED, 1)
    assert fine["doc_sha256"] == lib.doc_digest((tmp_path / "ok" / fine["ref"]).read_bytes())
    assert fine["onsets_sha256"] is not None and fine["first_coverage"] == fine["coverage"]
    real = e2e.AlignStepsImpl.publish

    async def later_writer(self: Any, job_ref: Any, doc: Any, *, placing: Any = ()) -> str:
        path = Path(job_ref.media_dir) / doc.ref
        body = json.loads(path.read_text())
        body["lines"] = body["lines"][1:]
        path.write_text(json.dumps(body))
        return str(await real(self, job_ref, doc, placing=placing))

    monkeypatch.setattr(e2e.AlignStepsImpl, "publish", later_writer)
    row = e2e.RunAlignDriver(aligner=driver.aligner, corpus=driver.corpus, media_root=tmp_path / "bad").run(
        e2e.Case(song, "truth", 0)
    )
    assert row["outcome"] == lib.ERROR and row["published_file_attempt"] is None
    assert "not the published attempt 1's" in row["exception"] and row["scored"] == 0


# ── review round 2: faults, pools, setups, claims, keys, the TV port ────────────────────────────────


class MixFaultAligner:
    """The rig's emissions on the STEM; the MIX's raise, as an out-of-memory would — R4 swallows it."""

    def __init__(self, mix: Path, stem_phrases: Sequence[tuple[str, float, float]]) -> None:
        self.mix = os.path.realpath(mix)
        self.stem_phrases = stem_phrases

    def emissions(self, path: str, _language: str) -> VoicedEmissions:
        if os.path.realpath(path) == self.mix:
            raise RuntimeError("MPS backend out of memory")
        voiced = [0.0] * int(DURATION / FRAME)
        for _text, start, end in self.stem_phrases:
            for frame in range(int(start / FRAME), int(end / FRAME)):
                voiced[frame] = 1.0
        return VoicedEmissions(log_probs=voiced, frame_sec=FRAME, dictionary=DIC)

    def align(self, *_a: object, **_k: object) -> tuple[()]:
        raise AssertionError("the global path must not fall back to the windowed aligner")


def test_a_fault_time_text_caught_is_an_error_row_not_a_refusal(
    rig: tuple[Any, Any], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Review r2 (correctness-1): `time_text` catches an emissions / decode / audio fault itself and DECLINES
    ("decode failed: ..."), so an MPS out-of-memory, a full disk under the cache or a decoder that raises on
    some texts scored as a REFUSAL — a wrong text correctly refused, its lines missing — at both levels."""
    from encore_worker.adapters import ml

    driver, song = rig

    def out_of_memory(self: Any, audio_path: str, language: str) -> Any:
        raise RuntimeError("MPS backend out of memory")

    monkeypatch.setattr(ml.WhisperXAligner, "emissions", out_of_memory)
    bench = e2e.BenchAligner(device="cpu")
    for level in (e2e.TimeTextDriver, e2e.RunAlignDriver):
        row = level(aligner=bench, corpus=driver.corpus, media_root=tmp_path / level.level).run(
            e2e.Case(song, "truth", 0)
        )
        assert row["outcome"] == lib.ERROR, level.level
        assert "MPS backend out of memory" in row["exception"] and "decode failed" in row["exception"]
    assert bench.faults and all("MPS backend out of memory" in f for f in bench.faults)

    def decoder_fault(
        log_probs: Sequence[float], targets: Sequence[int], _blank: int = 0
    ) -> tuple[list[int], list[float]]:
        raise ValueError("a decoder that raises on some texts")

    monkeypatch.setattr(ml, "forced_align_decoder", decoder_fault)
    for level in (e2e.TimeTextDriver, e2e.RunAlignDriver):
        row = level(
            aligner=driver.aligner, corpus=driver.corpus, media_root=tmp_path / f"d{level.level}"
        ).run(e2e.Case(song, "wrongtext", 0))
        assert row["outcome"] == lib.ERROR and "decode failed: ValueError" in row["exception"], level.level
    spread_decodes(monkeypatch)
    judged = driver.run(e2e.Case(song_of(UNSINGABLE, slug="count-in", audio=song.vocals), "truth", 0))
    assert (judged["outcome"], judged["why"]) == (
        lib.REFUSED,
        "no line in this text carries an alignable character",
    )


def test_a_lexical_check_that_raised_is_a_caught_fault_not_a_pass() -> None:
    """W1 review r2: the LINE_SYNC rung publishes on the sheet gate alone when its lexical check raised, and
    says so; the harness must read that as a fault it caught, as it reads a decode that raised."""
    raised = (
        "sheet-span envelope r=0.71 @ +0.00s, 8 lines; no lexical check: it raised ValueError: x; 8 lines"
    )
    measured = "sheet-span envelope r=0.71 @ +0.00s, 8 lines; lexical lift +1.20 nats/letter over 90 letters"
    unmeasured = "sheet-span envelope r=0.71 @ +0.00s, 8 lines; no lexical check: under 40 alignable letters"
    states = [
        ("j", "align-line-sync", 0, "line-sync", raised, None),
        ("j", "align-line-sync", 0, "line-sync", measured, None),
        ("j", "align-line-sync", 0, "line-sync", unmeasured, None),
        ("j", "align-global", 0, "declined", "decode failed: ValueError: y", None),
    ]
    assert e2e.fault_declines(states) == [raised, "decode failed: ValueError: y"]
    assert e2e.case_fault(states[1:3], []) is None, "a measured or unmeasurable check is a verdict"


def test_a_global_lexical_check_that_raised_is_a_caught_fault_not_a_pass() -> None:
    """W3: the global engine gates a word document on the envelope alone when its lexical check raised, and
    its verdict note says so; the harness reads that as a fault it caught. An exemption (the ASR tier, a
    short text) or a measured lift is a verdict."""
    raised = "envelope r=0.61 (blind), r=0.61 (repaired); no lexical check: it raised ValueError: x; untimed"
    exempt = (
        "envelope r=0.61 (blind), r=0.61 (repaired); no lexical check: a transcript of this recording "
        "(its words were heard on this audio); untimed"
    )
    measured = (
        "envelope r=0.61 (blind), r=0.61 (repaired), not gating: the lift is; lexical lift +1.20 nats/letter"
    )
    refused_after = "envelope gate refused: blind r=0.11 @ +3.10s; no lexical check: it raised ValueError: z"
    states = [
        ("j", "align-global", 0, "no-claims", raised, None),
        ("j", "align-global", 0, "no-claims", exempt, None),
        ("j", "align-global", 0, "structural", measured, None),
        ("j", "align-global", 0, "declined", "lexical gate refused: lexical lift -0.02 nats/letter", None),
        ("j", "align-global", 0, "declined", refused_after, None),
    ]
    assert e2e.fault_declines(states) == [raised, refused_after], (
        "a refusal the lift's fault left to the envelope"
    )
    states.pop()
    assert e2e.case_fault(states[1:], []) is None, "an exemption, a measured lift and a refusal are verdicts"


def test_an_emissions_fault_r4_swallowed_is_an_error_row_not_a_clean_document(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """R4's mix witness catches its own emissions fault and PUBLISHES without the repair — no decline to read.
    `BenchAligner.faults` is what shows it: the same case publishes under an aligner that keeps no faults."""
    from encore_worker.adapters import ml

    spread_decodes(monkeypatch)
    stem_phrases = [p for i, p in enumerate(PHRASES) if i != 3]  # line 3 is inaudible on the stem
    vocals = write_voiced(tmp_path / "vocals.wav", DURATION, phrases=stem_phrases)
    mix = write_voiced(tmp_path / "mix.wav", DURATION)
    song = lib.Song(
        slug="lost", group="jamendo", mix=mix, vocals=vocals, truth=tuple(lib.TruthLine(*p) for p in PHRASES)
    )
    fake = MixFaultAligner(mix, stem_phrases)
    blind_to_faults = e2e.TimeTextDriver(aligner=fake, corpus=[song], media_root=tmp_path / "plain")
    assert blind_to_faults.run(e2e.Case(song, "truth", 0))["outcome"] == lib.PUBLISHED, (
        "invisible without faults"
    )

    monkeypatch.setattr(
        ml.WhisperXAligner, "emissions", lambda _self, path, language: fake.emissions(path, language)
    )
    bench = e2e.BenchAligner(device="cpu")
    row = e2e.TimeTextDriver(aligner=bench, corpus=[song], media_root=tmp_path / "bench").run(
        e2e.Case(song, "truth", 0)
    )
    assert row["outcome"] == lib.ERROR and "emissions raised: mix.wav: RuntimeError" in row["exception"]
    assert row["scored"] == 0 and row["doc_sha256"] is not None, "the document was written; it is not scored"


def test_the_bench_aligner_records_a_cache_fault_and_still_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from encore_worker.adapters import ml

    audio = tmp_path / "vocals.wav"
    audio.write_bytes(b"RIFF....")
    monkeypatch.setattr(
        ml.WhisperXAligner,
        "emissions",
        lambda _self, _p, _l: ml.Emissions(
            log_probs=np.zeros((4, 3), np.float32), frame_sec=0.02, dictionary={}
        ),
    )
    store = lib.EmissionStore(tmp_path / "_emissions", model="M", emitter="e")

    def disk_full(*_a: object, **_k: object) -> Path:
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(lib.EmissionStore, "save", disk_full)
    aligner = e2e.BenchAligner(device="cpu", store=store, identify=lambda _l: "w")
    with pytest.raises(OSError, match="No space left"):
        aligner.emissions(str(audio), "en")
    assert aligner.faults == ["vocals.wav: OSError: [Errno 28] No space left on device"]
    assert e2e.emission_faults(aligner) == aligner.faults and e2e.emission_faults(object()) == []


def test_a_published_record_that_matches_no_attempt_is_an_error_row(
    rig: tuple[Any, Any], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Review r2 (correctness-5): a job that published a record no attempt returned (a diarizer or a W1
    best-so-far rebuilding it) scored as REFUSED — lyrics on the TV, missing lines in the bench."""
    import dataclasses

    driver, song = rig
    real = e2e.run_align

    async def rebuilt(job: Any, steps: Any) -> Any:
        result = await real(job, steps)
        # FLIPPED, not a fixed value: whichever grade the attempt had, the record now differs from it (W1's
        # blind-only corroboration, review H4, grades this rig's truth document `medium`).
        flipped = "medium" if result.published.confidence == "high" else "high"
        return dataclasses.replace(
            result, published=dataclasses.replace(result.published, confidence=flipped)
        )

    monkeypatch.setattr(e2e, "run_align", rebuilt)
    row = e2e.RunAlignDriver(aligner=driver.aligner, corpus=driver.corpus, media_root=tmp_path).run(
        e2e.Case(song, "truth", 0)
    )
    assert (row["outcome"], row["terminal"], row["published_attempt"]) == (lib.ERROR, "published", None)
    assert "matches no attempt" in row["exception"]


def test_an_injected_header_is_never_claimed_to_end_before_it_starts() -> None:
    """Review r2 (correctness-6): a header opened at the previous line's claimed END, which authored
    captions run past the next section's start (and a section starts every 8 lines with no gap at all), so
    12 of the corpus's 233 headers were claimed inverted — The_Rinn's `Chorus:` 226.51 -> 218.88 s."""
    overlapping = [(f"line number {i}", 2.5 * i, 2.5 * i + 3.0) for i in range(20)]  # each runs 0.5 s long
    song = song_of(overlapping)
    for mode in (*lib.ALL_MODES, "jit+headers", "tempo098+headers", "offm1+headers"):
        got = claims(song, mode, [song, song_of(TEN, slug="donor")])
        for line_ in got.lines:
            if line_.start is not None:
                assert line_.end is not None and line_.start <= line_.end, (mode, line_)
    headers = claims(song, "headers").lines
    section_two = next(i for i, ln in enumerate(headers) if ln.truth is None and i > 0)
    head = headers[section_two + 1]
    assert (headers[section_two].start, headers[section_two].end) == (head.start, head.start), "claimed AT it"
    assert headers[0].start == 0.0 and headers[0].end == 0.0, "the first header before a line at 0 s"


def gross_rows(grosses: Sequence[int], mode: str = "truth") -> list[Any]:
    """One TEN-line song per entry, `s0`, `s1`, ...: its first N lines published 3 s off, the rest exact."""
    rows = []
    for i, gross in enumerate(grosses):
        song = song_of(TEN, slug=f"s{i}")
        doc = [line(k, t.start + (3.0 if k < gross else 0.0)) for k, t in enumerate(song.truth)]
        rows.append(
            lib.row_of(
                song=song, mode=mode, variant=0, claims=claims(song, mode), outcome=lib.PUBLISHED, doc=doc
            )
        )
    return rows


def test_a_reduction_of_the_baseline_ranges_over_the_songs_the_run_measured() -> None:
    """Review r2 (correctness-2): the baseline's per-song values reduced over its OWN songs, so a run that
    measured fewer passed: base a (0 gross) and b (9), run a alone (3) read `3 <= 9`."""
    base, run = gross_rows([0, 9]), gross_rows([3])
    fewer = (gates.view_of(document(run)), gates.view_of(document(base)))
    for expr in (
        "sum(song.gross) <= sum(base.song.gross)",
        "mean(song.pm500) >= mean(base.song.pm500) - 1",
        "max(song.gross) <= max(base.song.gross)",
        "count(base.song.gross > 5) == 1",
    ):
        with pytest.raises(gates.GateError, match="did not measure"):
            gates.evaluate(expr, *fewer)
    more = (fewer[1], fewer[0])  # the run has b, the baseline does not
    with pytest.raises(gates.GateError, match=r"only in the run: s1 \(truth\)"):
        gates.evaluate("sum(song.gross) <= sum(base.song.gross)", *more)
    assert gates.evaluate("count(song.gross - base.song.gross < 0) == 1", *more)[0], "per song: b is skipped"
    same = (gates.view_of(document(base)), gates.view_of(document(base)))
    assert gates.evaluate("sum(song.gross) <= sum(base.song.gross) and max(base.song.gross) == 9", *same)[0]


def test_delta_of_a_per_song_reference_is_an_error_not_the_pooled_delta() -> None:
    """Review r2 (correctness-3): `delta(truth.song.gross)` silently read the POOLED number."""
    base, run = gross_rows([0, 9]), gross_rows([3, 5])
    views = (gates.view_of(document(run)), gates.view_of(document(base)))
    with pytest.raises(gates.GateError, match="min_song_delta"):
        gates.evaluate("delta(truth.song.gross) <= 0", *views)
    assert not gates.evaluate("count(truth.song.gross_up) == 0", *views)[0]
    assert gates.evaluate("delta(truth.gross) < 0", *views)[0]


def test_a_baseline_gate_across_another_measurement_setup_is_an_error(tmp_path: Path) -> None:
    """Review r2 (correctness-4, spec-7): `--compare` only WARNED on a level / tfr audio / seed mismatch and
    the gates went on. Measured on the committed results: the oracle-stem reference sweep against the youtube
    baseline passed `drop20.gross <= base.drop20.gross` as 41 <= 51, a gap the tfr audio alone made."""
    rows = spread_rows([0.1, 0.1])
    base = gates.view_of(document(rows, **SETUP))
    gated = [
        gates.Gate("relative", "truth.pm500 >= base.truth.pm500 - 1"),
        gates.Gate("per-song", "count(song.gross_up) == 0"),
        gates.Gate("absolute", "truth.gross <= 5"),
    ]

    def statuses(meta: dict[str, Any]) -> list[str]:
        return [r.status for r in gates.run_gates(gated, gates.view_of(document(rows, **meta)), base)]

    assert statuses(SETUP) == ["PASS", "PASS", "PASS", "PASS"]
    assert statuses({**SETUP, "model": "HUBERT", "align_config": {"x": 1}}) == ["PASS"] * 4, (
        "an arm's variables"
    )
    for changed in ({"tfr_audio": "reference"}, {"level": "run_align"}, {"seed": 1}, {"wrong_k": 3}):
        assert statuses({**SETUP, **changed}) == ["PASS", "ERROR", "ERROR", "PASS"], changed
    silent = {k: v for k, v in SETUP.items() if k != "tfr_audio"}
    results = gates.run_gates(gated, gates.view_of(document(rows, **silent)), base)
    assert results[1].status == "ERROR" and "tfr_audio not recorded by the run" in results[1].detail
    assert gates.setup_mismatch({**SETUP, "level": "run_align"}, {**SETUP, "level": "run_align"}) == [
        "asr not recorded by the run and the baseline"
    ]
    table = gates.format_compare(
        gates.View(modes={}, songs={}, meta={**SETUP, "model_identity": {"en": "a"}}),
        gates.View(
            modes={}, songs={}, meta={**SETUP, "tfr_audio": "reference", "model_identity": {"en": "b"}}
        ),
    )
    assert "WARNING: tfr_audio differs" in table and "every gate that reads the baseline is an ERROR" in table
    assert "WARNING: model_identity differs" in table


def test_an_uncalibrated_bundle_is_announced_recorded_and_ungatable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """W4b REVIEW R2 (spec-13): the harness swept an uncalibrated `--model` / `ENCORE_ALIGN_MODEL` in silence
    where production refuses to start on one, and with every emission-scale gate stood down the wrong-text
    verdict falls back to the sheet-span envelope gate — 125/320 wrongtext passes on this corpus — so a row
    reading `wrongtext_pass 0.00` under the new bundle's name would be the ENVELOPE gate's number. The run is
    still allowed (measure-then-paste-the-row needs it), but it is announced, marked, and unreadable by any
    gate that reads what stood down."""
    from encore_worker.host.config import Config

    assert e2e.uncalibrated_banner("WAV2VEC2_ASR_BASE_960H") is None, "the shipped bundle has a row"
    banner = e2e.uncalibrated_banner("WAV2VEC2_LARGE_XLSR_53_DE")
    assert banner is not None
    for phrase in ("WAV2VEC2_LARGE_XLSR_53_DE", "no lexical calibration for", "lift_gate.py --model"):
        assert phrase in banner, phrase

    monkeypatch.setattr(e2e.Config, "from_env", staticmethod(lambda env=None: Config()))
    monkeypatch.setattr(e2e.lib, "discover", lambda *_a, **_k: [])
    monkeypatch.setattr(e2e, "git_state", lambda: {"head": None, "dirty": None})
    argv = ["--device", "cpu", "--emissions-cache", "off"]
    named = tmp_path / "named"
    assert e2e.main([*argv, "--out", str(named), "--model", "WAV2VEC2_LARGE_XLSR_53_DE"]) == 3, "no cases ran"
    assert "HAS NO LEXICAL CALIBRATION ROW" in capsys.readouterr().err
    assert json.loads((named / "run.json").read_text())["uncalibrated"] is True
    shipped = tmp_path / "shipped"
    assert e2e.main([*argv, "--out", str(shipped), "--model", "WAV2VEC2_ASR_BASE_960H"]) == 3
    assert "CALIBRATION" not in capsys.readouterr().err
    assert "uncalibrated" not in json.loads((shipped / "run.json").read_text()), (
        "recorded only when true, so every calibrated run keeps the `run.json` shape a --resume compares"
    )

    jam, other = song_of(TEN, slug="j"), song_of(TEN, slug="o", group="youtube")
    rows = [
        lib.row_of(
            song=jam,
            mode="wrongtext",
            variant=0,
            claims=claims(jam, "wrongtext", [jam, other], variant=0, wrong_k=3),
            outcome=lib.REFUSED,
            doc=[],
        ),
        *spread_rows([0.1]),
    ]
    gated = [
        gates.Gate("wrong-texts", "wrongtext.wrongtext_pass == 0"),
        gates.Gate("gross", "truth.gross <= 5"),
    ]
    calibrated = gates.view_of(document(rows, **SETUP))
    assert [r.status for r in gates.run_gates(gated, calibrated, None)] == ["PASS"] * 3
    flagged = gates.view_of(document(rows, **{**SETUP, "model": "BOGUS", "uncalibrated": True}))
    results = gates.run_gates(gated, flagged, None)
    assert [(r.gate.name, r.status) for r in results] == [
        ("no-error-rows", "PASS"),
        ("wrong-texts", "ERROR"),
        ("gross", "PASS"),
    ], "the timings are that bundle's own measurement; the wrong-text verdict is not"
    assert "no lexical calibration row" in results[1].detail and "'BOGUS'" in results[1].detail
    assert "has NO lexical calibration row" in gates.format_compare(flagged, calibrated)


def test_summarize_and_a_rows_baseline_carry_the_setup_their_run_recorded(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """`--summarize` built its meta from `rows` and `row_codes` alone: offline gating could not even warn."""
    run_dir, base_dir = tmp_path / "run", tmp_path / "base"
    for directory, setup in ((run_dir, SETUP), (base_dir, {**SETUP, "tfr_audio": "reference"})):
        directory.mkdir()
        (directory / "rows.jsonl").write_text("".join(json.dumps(r) + "\n" for r in spread_rows([0.1])))
        (directory / "run.json").write_text(json.dumps({**setup, "code": "c1", "align_config": {}}))
    loaded = gates.load_document(base_dir)
    assert loaded["meta"]["tfr_audio"] == "reference" and loaded["meta"]["row_codes"] == ["?"]
    rules = tmp_path / "gates.yaml"
    rules.write_text("holds: truth.pm500 >= base.truth.pm500 - 1\n")
    args = ["--summarize", str(run_dir / "rows.jsonl"), "--compare", str(base_dir / "rows.jsonl")]
    assert e2e.main([*args, "--gates", str(rules)]) == 3
    out = capsys.readouterr().out
    assert "ERROR holds" in out and "tfr_audio differs" in out
    cases = tmp_path / "baseline.cases.jsonl"
    cases.write_text(json.dumps({"song": "s", "mode": "truth", "outcome": "published", "scored": 1}) + "\n")
    with pytest.raises(ValueError, match="no `line_errors`"):
        gates.load_document(cases)
    assert e2e.main(["--summarize", str(cases)]) == 2
    assert "compact .cases.jsonl" in capsys.readouterr().err


def test_the_emissions_key_moves_with_the_align_settings_and_the_code_ml_imports(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Review r2 (spec-9, tests-14): the key hashed `adapters/ml.py` alone and no worker setting. A
    default-off arm inside `emissions()` (W4 6a's frame grid behind ENCORE_ALIGN_EXPERIMENTS) would share
    its knob-off twin's matrices, and a frame-grid helper MODULE that ml.py calls would leave the key where
    it was."""
    from encore_worker.host.config import Config

    monkeypatch.setattr(e2e, "emitter_versions", lambda *_a: {"torch": "2.8.0"})

    @dataclass(frozen=True)
    class Arms:
        align_experiments: frozenset[str] = frozenset()
        core_url: str = "ws://x"

    off = e2e.emitter_fingerprint(Arms())
    assert off == e2e.emitter_fingerprint(Arms(core_url="ws://y")), "only the align_* settings count"
    assert off != e2e.emitter_fingerprint(Arms(frozenset({"frame-grid"})))
    assert e2e.emitter_fingerprint(Config()) == e2e.emitter_fingerprint(Config(worker_id="another"))

    package = tmp_path / "encore_worker"
    for name, text in {
        "__init__.py": "",
        "adapters/__init__.py": "",
        "adapters/ml.py": (
            "def emissions():\n    from encore_worker.domain.frames import grid\n    from . import util\n"
        ),
        "adapters/util.py": "x = 1\n",
        "domain/__init__.py": "from encore_worker.domain import pure\n",
        "domain/pure.py": "",
        "domain/frames.py": "grid = 320\n",
        "domain/unrelated.py": "",
    }.items():
        (package / name).parent.mkdir(parents=True, exist_ok=True)
        (package / name).write_text(text)
    closure = lib.module_closure(package / "adapters" / "ml.py", package)
    assert [p.relative_to(package.resolve()).as_posix() for p in closure] == [
        "__init__.py",
        "adapters/__init__.py",
        "adapters/ml.py",
        "adapters/util.py",
        "domain/__init__.py",
        "domain/frames.py",
        "domain/pure.py",
    ]
    before = lib.emitter_fingerprint(closure, {})
    (package / "domain" / "frames.py").write_text("grid = 400\n")
    assert lib.emitter_fingerprint(closure, {}) != before, "a helper ml.py calls moves the key"
    real = {p.name for p in e2e.emitter_sources()}
    assert {"ml.py", "wav.py", "document.py"} <= real, "lazy imports inside ml.py's functions count"


def test_the_bench_builds_its_aligner_as_the_host_does() -> None:
    """A factory argument that reaches production (a model knob, a frame-grid setting, the cache bound)
    must reach the bench too: this fails first.

    PINNED AS A SET AND FORWARDED, not as a literal list of one name (W4 review r1, which added `jobs` —
    the emission LRU's bound, derived from `Config.concurrency`). The list that must not GROW silently is
    the host factory's, and `BenchAligner` may have arguments of its own on top (its disk cache), so the
    relation is containment plus the value actually arriving: a forwarded argument dropped in
    `BenchAligner.__init__` would leave the harness measuring another adapter's behaviour.
    """
    import inspect

    from encore_worker.adapters import ml

    host = set(inspect.signature(ml.build_aligner).parameters)
    assert host == {"device", "jobs", "model"}, (
        "a new production factory argument: forward it to BenchAligner too"
    )
    assert set(inspect.signature(ml.WhisperXAligner.__init__).parameters) == {"self", *host}
    assert host <= set(inspect.signature(e2e.BenchAligner.__init__).parameters)
    built = e2e.BenchAligner(device="cpu", jobs=3)
    assert built._matrices == ml._emission_cache_size(3), "`jobs` reaches the LRU through the bench"
    # AND THE BUNDLE IS THE SHIPPED ONE (W4b 6b): an absent `--model` resolves through the same per-device
    # policy the factory uses, so a run with no bundle named measures what production loads rather than
    # whisperx's per-language table (the base model, on every box).
    assert built._model == ml.default_align_model("cpu") == e2e.default_model("en", "cpu")
    assert e2e.BenchAligner(device="cpu", model="HUBERT_ASR_XLARGE")._model == "HUBERT_ASR_XLARGE"


def test_every_retime_knob_is_a_metric_whether_or_not_it_was_used(
    rig: tuple[Any, Any], tmp_path: Path
) -> None:
    """Review r2 (spec-10): only the knobs that OCCURRED got a `retime_<knob>` key, so W1's H2 gate
    `truth.retime_align_on_mix == 0` was an unknown-metric ERROR exactly when the fix worked."""
    from encore_worker.domain.lyrics.policy import Knob

    assert lib.RETIME_KNOBS == tuple(k.value for k in Knob)
    driver, song = rig
    job = e2e.RunAlignDriver(aligner=driver.aligner, corpus=driver.corpus, media_root=tmp_path)
    clean = gates.view_of(document([job.run(e2e.Case(song, "truth", 0))], **SETUP))
    assert gates.evaluate("truth.retime_align_on_mix == 0 and truth.retime_line_sync == 0", clean, None)[0]
    below = gates.view_of(document([driver.run(e2e.Case(song, "truth", 0))], **SETUP))
    with pytest.raises(gates.GateError, match="no value"):
        gates.evaluate("truth.retime_align_on_mix == 0", below, None)


def test_the_canonical_no_new_gross_gate_sees_a_song_that_flipped_to_refused() -> None:
    """Review r2 (tests-12): `gross` counts published lines only, so a song with 2 gross lines that flips to
    refused — or drops one of them — reads FEWER, and `count(song.gross_up) == 0` passed on both. The
    documented form adds `missing` (text lines not scored), which rises with either."""
    song = song_of(TEN, slug="s0")
    got = claims(song, "truth")
    two_gross = [line(k, t.start + (3.0 if k < 2 else 0.0)) for k, t in enumerate(song.truth)]
    before = [
        lib.row_of(song=song, mode="truth", variant=0, claims=got, outcome=lib.PUBLISHED, doc=two_gross)
    ]
    refused = [lib.row_of(song=song, mode="truth", variant=0, claims=got, outcome=lib.REFUSED, doc=[])]
    dropped = [
        lib.row_of(song=song, mode="truth", variant=0, claims=got, outcome=lib.PUBLISHED, doc=two_gross[1:])
    ]
    base = gates.view_of(document(before))
    for run_rows in (refused, dropped):
        now = gates.view_of(document(run_rows))
        assert gates.evaluate("count(song.gross_up) == 0", now, base)[0], "the trap: gross alone passes"
        assert not gates.evaluate("count(song.gross_up + song.missing_up) == 0", now, base)[0]
    assert gates.evaluate("count(song.gross_up + song.missing_up) == 0", base, base)[0]


def test_the_highlight_port_lights_what_the_committed_parity_fixture_says() -> None:
    """Review r2 (spec-11, tests-13): the port's parity with `lyrics.ts` rested on an uncommitted one-off bun
    run. The fixture is written from the port (`scripts/tv_parity.py`) and core's
    `lyrics-bench-parity.test.ts` holds `lyrics.ts` to it; here the port and the generator are held to it."""
    tv_parity: Any = _load("tv_parity")
    committed = json.loads(tv_parity.FIXTURE.read_text(encoding="utf-8"))
    assert committed["constants"] == {
        "line_gap_sec": lib.TV_LINE_GAP_SEC,
        "line_max_chars": lib.TV_LINE_MAX_CHARS,
        "orphan_max_sec": lib.TV_ORPHAN_MAX_SEC,
        "lyrics_lead_sec": 0.0,
    }
    for case in committed["cases"]:
        lines = tv_parity.tv_document(case["doc"])
        assert [[ln.text, ln.start, ln.end] for ln in lines] == case["rows"], case["name"]
        assert [tv_parity.lit(lines, pos) for pos in case["positions"]] == case["lit"], case["name"]
    assert tv_parity.dump(tv_parity.build()) == tv_parity.FIXTURE.read_text(encoding="utf-8"), "regenerate it"


def test_an_orphan_folds_forward_even_with_a_row_before_it() -> None:
    """`coalesceOrphans` merges FORWARD whenever the next row is closer, previous row or not: "I" sits 0.9 s
    after "road" and 0.5 s before "want", both pauses (>= 0.45 s), so it is an orphan row of its own."""
    road = [(w, 0.4 * i, 0.4 * i + 0.3, i) for i, w in enumerate("we were singing on the long road".split())]
    body = [
        (w, 4.3 + 0.4 * i, 4.6 + 0.4 * i, 8 + i) for i, w in enumerate("want a perfect body tonight".split())
    ]
    rows = lib.tv_resegment(tv_line(*road, ("I", 3.6, 3.8, 7), *body))
    assert [row.text for row in rows] == ["we were singing on the long road", "I want a perfect body tonight"]


def test_a_line_its_words_do_not_cover_is_never_resegmented() -> None:
    """`resegmentLine` refuses when the timed words cover < 80% of the text: rebuilding from them would
    delete the untimed lyrics from the screen."""
    thin = tv_line(("fly", 0.0, 0.3, 0), ("away", 1.0, 1.3, 1), ("home", 2.0, 2.3, 2))
    long_text = lib.TvLine(
        0.0, 10.0, "fly away home, and all the words this sheet never timed at all", thin.words
    )
    assert lib.tv_resegment(long_text) == [long_text]


def test_where_truth_words_overlap_the_later_started_one_is_the_one_being_sung() -> None:
    """29 Jamendo word pairs overlap (6.3 s): the highlight credits the word that started LATER there."""
    lines = [tv_line(("hold", 0.0, 1.0, 0)), tv_line(("next", 1.0, 2.0, 1))]
    hit, sung = lib.highlight_seconds(lines, [(0.0, 1.5, 0), (0.8, 2.0, 1)])
    assert (hit, sung) == pytest.approx((1.8, 2.0)), "0.8-1.0 s is `next`'s, and `hold` is lit there"


def test_doc_changed_over_a_baseline_song_the_run_lacks_is_an_error() -> None:
    """Review r2 (tests-15, 1): W1's `count(song.doc_changed * (base.song.coverage >= 0.8)) == 0` must not
    pass vacuously on a `--songs` subset."""
    rows = spread_rows([0.1, 0.1])
    for row in rows:
        row.update(doc_sha256="d", onsets_sha256="o", first_coverage=0.9)
    views = (gates.view_of(document(rows[:1])), gates.view_of(document(rows)))
    with pytest.raises(gates.GateError, match="did not measure"):
        gates.evaluate("count(song.doc_changed) == 0", *views)
    with pytest.raises(gates.GateError, match="did not measure"):
        gates.evaluate("count(song.doc_changed * (base.song.coverage >= 0.8)) == 0", *views)


def test_main_refuses_to_resume_across_a_code_change(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Review r2 (tests-15, 2): `code` in `run_config` stops a resume from pooling two `time_text`s."""
    from encore_worker.host.config import Config

    monkeypatch.setattr(e2e.Config, "from_env", staticmethod(lambda env=None: Config()))
    monkeypatch.setattr(e2e.lib, "discover", lambda *_a, **_k: [])
    monkeypatch.setattr(e2e, "git_state", lambda: {"head": None, "dirty": None})
    argv = ["--out", str(tmp_path / "run"), "--device", "cpu", "--model", "M", "--emissions-cache", "off"]
    monkeypatch.setattr(e2e, "code_fingerprint", lambda: "c1")
    assert e2e.main(argv) == 3, "no case ran: the built-in no-error-rows gate has no mode to read"
    assert json.loads((tmp_path / "run" / "run.json").read_text())["code"] == "c1"
    assert e2e.main([*argv, "--resume"]) == 3, "the same code resumes"
    monkeypatch.setattr(e2e, "code_fingerprint", lambda: "c2")
    capsys.readouterr()
    assert e2e.main([*argv, "--resume"]) == 2
    assert "differs in: code" in capsys.readouterr().err


def test_the_default_cache_key_is_the_loaded_models_identity(monkeypatch: pytest.MonkeyPatch) -> None:
    """Review r2 (tests-15, 3): every test injected `identify=`, so the DEFAULT — `loaded_identity` — was
    unpinned; a constant there made the key the harness's label guess again."""
    torch = pytest.importorskip("torch")
    model = torch.nn.Linear(2, 3)
    monkeypatch.setattr(
        e2e.BenchAligner, "_aligner", lambda _self, _language: (model, {"dictionary": {"a": 1}})
    )
    store = lib.EmissionStore(Path("/nonexistent"), model="M", emitter="e")
    aligner = e2e.BenchAligner(device="cpu", store=store)
    identity = aligner.loaded_identity("en")
    assert len(identity) == 16 and aligner.store_for("en").model == f"M@{identity}"
    assert aligner.identities == {"en": identity}


# ── W3: the gates' readings on the rows, the lines sync mode, the compact digest ─────────────────────


def test_the_lexical_lift_is_on_the_row_at_full_precision(
    rig: tuple[Any, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    """The trail prints a lift to two decimals (+0.195 reads `+0.20` and is refused at 0.2), so the harness
    records the number the gate read, through a wrap that changes nothing it returns — and removes it."""
    from encore_worker.domain.lyrics import lexical

    driver, song = rig
    measured = lexical.Lift(value=0.8123456, letters=90, per_letter=-1.0)
    monkeypatch.setattr(lexical, "lift", lambda *_a, **_k: measured)
    row = driver.run(e2e.Case(song, "truth", 0))
    assert row["outcome"] == lib.PUBLISHED and row["lift"] == 0.8123456
    assert "lexical lift +0.81" in row["why"]
    assert lexical.lift(["x"], None, decoder=spreading_decoder) is measured, "the wrap is removed again"

    with e2e.capture_lifts() as lifts:
        assert lexical.lift(["x"], None, decoder=spreading_decoder) is measured
    assert lifts == [0.8123456]
    monkeypatch.setattr(lexical, "lift", lambda *_a, **_k: None)
    unmeasured = driver.run(e2e.Case(song, "truth", 0))
    assert unmeasured["lift"] is None and "no lexical check" in unmeasured["why"]


def test_a_lines_run_sends_the_sync_mode_and_keeps_the_rungs_own_note(
    rig: tuple[Any, Any], tmp_path: Path
) -> None:
    """`--sync-mode lines`: every text's only attempt is the gated LINE_SYNC rung, and that rung writes no
    `align-global` note — W1 review r2 read its sheet fit and lift through a scratch wrapper. The row and
    each attempt carry the rung's verdict and note now; a forced run sends no `syncMode` at all."""
    driver, song = rig
    lines = e2e.RunAlignDriver(
        aligner=driver.aligner, corpus=driver.corpus, media_root=tmp_path / "ra", sync_mode="lines"
    )
    row = lines.run(e2e.Case(song, "truth", 0))
    (only,) = row["attempts"]
    assert only["knobs"] == ["line-sync"] and only["verdict"] == "?", "no align-global note on this rung"
    assert only["line_sync_verdict"] in ("line-sync", "refused")
    assert "sheet-span envelope r=" in only["line_sync_why"] and "decode" in only["line_sync_why"]
    assert (row["line_sync_verdict"], row["line_sync_why"]) == (
        only["line_sync_verdict"],
        only["line_sync_why"],
    )
    assert only["lift"] is None and row["lift"] is None, "the rig takes the lift out"

    forced = e2e.RunAlignDriver(aligner=driver.aligner, corpus=driver.corpus, media_root=tmp_path / "rf")
    plain = forced.run(e2e.Case(song, "truth", 0))
    assert plain["attempts"][0]["knobs"] == [], "a word decode first: no syncMode was sent"
    assert "line_sync_verdict" not in plain and "line_sync_verdict" not in plain["attempts"][0]
    with pytest.raises(ValueError, match="sync mode"):
        e2e.RunAlignDriver(aligner=driver.aligner, corpus=driver.corpus, media_root=tmp_path, sync_mode="x")
    assert e2e.main(["--sync-mode", "lines"]) == 2, "a job parameter: run_align only"


# ── W4: the stemless dimension (`--no-stem`) ─────────────────────────────────────────────────────────


class PathAligner(VoicedAligner):
    """The rig's aligner, recording WHICH file each emission pass was asked for."""

    def __init__(self) -> None:
        self.asked: list[str] = []

    def emissions(self, path: str, language: str) -> VoicedEmissions:
        self.asked.append(path)
        return super().emissions(path, language)


@pytest.fixture()
def two_files(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Any:
    """A song whose MIX and vocals stem are different files, so which one was aligned on is observable."""
    spread_decodes(monkeypatch)
    mix = write_voiced(tmp_path / "mix.wav", DURATION)
    vocals = write_voiced(tmp_path / "vocals.wav", DURATION)
    return song_of(PHRASES, slug="synthetic", audio=vocals, mix=mix)


def test_a_stemless_case_aligns_on_the_mix_and_the_stem_file_is_never_read(
    two_files: Any, tmp_path: Path
) -> None:
    """`--no-stem` is the harness's whole stemless seam: the step is handed `vocals_path=None`, so the
    SHIPPED `align_target` resolves to the mix and every mix-only decision follows from it (the lexical
    gate's mix bands, no R4 witness, no ALIGN_ON_MIX knob). Nothing is stubbed to make that happen, which is
    why the test can check it on the files that were decoded."""
    stemless = e2e.TimeTextDriver(
        aligner=PathAligner(), corpus=[two_files], media_root=tmp_path / "mix", stem=False
    )
    row = stemless.run(e2e.Case(two_files, "truth", 0))
    assert row["outcome"] == lib.PUBLISHED
    assert stemless.aligner.asked == [str(two_files.mix)], "the stem was not decoded, or read at all"
    assert stemless.target_of(two_files) == str(two_files.mix)

    on_stem = e2e.TimeTextDriver(aligner=PathAligner(), corpus=[two_files], media_root=tmp_path / "stem")
    on_stem.run(e2e.Case(two_files, "truth", 0))
    assert on_stem.aligner.asked == [str(two_files.vocals)], "the default target is unchanged"
    assert on_stem.duration_of(two_files) == stemless.duration_of(two_files), (
        "both read the stem's duration, so a stemless row's CLAIMS are its stem row's"
    )


def test_the_stemless_generate_level_decodes_the_mix_too(two_files: Any, tmp_path: Path) -> None:
    """The raw decode is the same dimension: `--level generate --no-stem` is the mix's own matrix."""
    raw = e2e.GenerateDriver(
        aligner=PathAligner(), corpus=[two_files], media_root=tmp_path / "raw", stem=False
    )
    row = raw.run(e2e.Case(two_files, "blind", 0))
    assert row["outcome"] == lib.PUBLISHED and raw.aligner.asked == [str(two_files.mix)]


def test_a_stemless_run_align_job_finds_no_stem_where_a_stems_job_would_have_left_one(
    two_files: Any, tmp_path: Path
) -> None:
    """At `run_align` the stem reaches the step through the media dir, so stemless means the conventional key
    is EMPTY and `AlignStepsImpl._vocals_of` returns None on its own — the same path as a stems job that
    refused a silent instrumental. Nothing else about the job changes."""
    from encore_worker.artifacts import keys

    case = e2e.Case(two_files, "truth", 0)
    stemless = e2e.RunAlignDriver(
        aligner=PathAligner(), corpus=[two_files], media_root=tmp_path / "mix", stem=False
    )
    media_dir = stemless._media_dir(case)  # noqa: SLF001 - the seam under test
    key = keys.vocals_key(two_files.slug, "wav")
    assert media_dir.is_dir() and not (media_dir / key).exists()

    on_stem = e2e.RunAlignDriver(aligner=PathAligner(), corpus=[two_files], media_root=tmp_path / "stem")
    assert (on_stem._media_dir(case) / key).is_symlink(), "the default still stages the stem"  # noqa: SLF001


def test_a_stemless_run_is_its_own_setup_and_an_unrecorded_target_is_the_stem() -> None:
    """A stemless case decodes a different audio FILE against the same truth, so no metric of it is a delta
    on a stem baseline's: `target` is setup, like `sync_mode`, and every run before `--no-stem` was a stem
    run."""
    assert gates.setup_mismatch({**SETUP, "target": "stem"}, SETUP) == []
    assert gates.setup_mismatch({**SETUP, "target": "mix"}, SETUP) == [
        "target differs — run 'mix', base 'stem'"
    ]
    table = gates.format_compare(
        gates.View(modes={}, songs={}, meta={**SETUP, "target": "mix"}),
        gates.View(modes={}, songs={}, meta=SETUP),
    )
    assert "target=mix" in table and "WARNING: target differs" in table


def test_modes_all_expands_beside_other_modes_once_each() -> None:
    """`--modes all,wrongtext+ownclock` is W3's whole sweep in one run; `all` alone is unchanged."""
    assert e2e.parse_modes("all") == list(lib.ALL_MODES)
    assert e2e.parse_modes("all,wrongtext+ownclock") == [*lib.ALL_MODES, "wrongtext+ownclock"]
    assert e2e.parse_modes("jit, all ,truth") == ["jit", *(m for m in lib.ALL_MODES if m != "jit")]
    with pytest.raises(ValueError, match="unknown claim op"):
        e2e.parse_modes("all,translated")


def test_a_lines_run_is_its_own_setup_and_an_unrecorded_sync_mode_is_forced() -> None:
    """Every baseline before `--sync-mode` sent no `syncMode` (the worker reads `forced`): a forced run still
    compares with them, and a lines run against any forced one is a setup mismatch — an ERROR per gate."""
    run_align = {**SETUP, "level": "run_align", "asr": "off"}
    assert gates.setup_mismatch({**run_align, "sync_mode": "forced"}, run_align) == []
    assert gates.setup_mismatch({**run_align, "sync_mode": "lines"}, run_align) == [
        "sync_mode differs — run 'lines', base 'forced'"
    ]
    assert gates.setup_mismatch(SETUP, SETUP) == [], "time_text records no sync mode"
    table = gates.format_compare(
        gates.View(modes={}, songs={}, meta={**run_align, "sync_mode": "lines"}),
        gates.View(modes={}, songs={}, meta=run_align),
    )
    assert "syncMode=lines" in table and "WARNING: sync_mode differs" in table


def test_a_line_sync_check_that_raised_is_a_caught_fault_whatever_the_rung_decided() -> None:
    """W3: the rung's timing check (the text's blind decode) or its lexical check raising hands the text to
    another gate, which may publish OR refuse it: either way the row is an ERROR, not a verdict."""
    decode_raised = (
        "sheet-span envelope r=0.71 @ +0.00s, 8 lines; lexical lift +1.20; no decode check: it raised X"
    )
    lift_raised = "sheet-span envelope r=0.11 @ +3.00s, below the sheet gate; no lexical check: it raised Y"
    few = "sheet-span envelope r=0.71 @ +0.00s, 3 lines; no decode check: fewer than 3 lines both decoded"
    states = [
        ("j", "align-line-sync", 0, "line-sync", decode_raised, None),
        ("j", "align-line-sync", 0, "refused", lift_raised, None),
        ("j", "align-line-sync", 0, "line-sync", few, None),
    ]
    assert e2e.fault_declines(states) == [decode_raised, lift_raised]
    assert e2e.case_fault(states[2:], []) is None, "a decode that pairs too few lines is a verdict's fallback"


def test_the_compact_digest_keeps_the_gates_readings_and_drops_the_raw_errors(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """`results/*.cases.jsonl` came from a scratch script that kept only the `align-global` verdict. The
    committed one keeps the lift and the LINE_SYNC rung's note, per case and per attempt."""
    row = {
        **spread_rows([0.1, 3.0])[0],
        "verdict": "?",
        "lift": 0.123456789,
        "line_sync_verdict": "refused",
        "line_sync_why": "sheet-span envelope r=0.20 @ +0.00s; lexical lift +1.20",
        "repair_faults": ["one"],
        "confidence": None,
        "attempts": [
            {
                "n": 1,
                "knobs": ["line-sync"],
                "lift": 0.987654321,
                "line_sync_verdict": "refused",
                "why": "long",
            }
        ],
    }
    got = lib.compact_row(row)
    assert (got["lift"], got["line_sync_verdict"], got["repair_faults"]) == (0.1235, "refused", 1)
    assert "line_errors" not in got and "confidence" not in got, "raw errors and None values dropped"
    assert got["attempts"] == [
        {"n": 1, "knobs": ["line-sync"], "lift": 0.9877, "line_sync_verdict": "refused"}
    ]
    rows = tmp_path / "rows.jsonl"
    rows.write_text(json.dumps(row) + "\n")
    out = tmp_path / "w.cases.jsonl"
    assert e2e.main(["--compact", str(rows), str(out)]) == 0 and "1 cases" in capsys.readouterr().out
    assert [json.loads(line) for line in out.read_text().splitlines()] == [got]


def test_line_gate_rules_fall_back_as_the_shipped_rung_does() -> None:
    """`scripts/line_gate.py`'s rules over one case each: the decode gates timings where it paired 3+
    lines, the sheet gate where it did not, and an unmeasurable lift checks no words."""
    rules = line_gate.rules(0.2)
    base = {"sheet": False, "near": 0.9, "lift": 1.0}
    assert not rules["decode(0.5)"](base) and rules["sheet+lift"](base), (
        "the decode admits what the sheet refused"
    )
    assert rules["decode(0.5)"]({**base, "near": 0.4}) and not rules["either(0.5)"](
        {**base, "near": 0.4, "sheet": True}
    )
    assert rules["decode(0.5)"]({**base, "near": None}), "no decode: the sheet gate decides"
    assert rules["decode(0.5)"]({**base, "lift": 0.1}) and not rules["decode(0.5)"]({**base, "lift": None})
    assert not rules["lift alone"]({**base, "near": 0.0})


def test_the_line_gate_report_names_the_model_row_s_own_share() -> None:
    """W4b review r1. The share is per-model data now (`lexical.Bands.line_sync_min_agreement`) and
    `summarize` is handed it, but its refusal tables still iterated the literals `decode(0.5)` / `either(0.5)`
    — so `line_gate.py --model X` on a row whose share is 0.6 printed the right texts ANOTHER model's
    threshold refuses, directly above `-> line_sync_min_agreement=0.6`. That section is what a calibrator
    reads to decide whether a share's cost is acceptable, so it must be the row's own rule.

    ALSO PINNED: a share off the sweep's 0.1 grid gets a rule of its own rather than colliding with the step
    it rounds to, which is what `:.1f` keys would have done to a future 0.45.
    """
    body = json.loads((SCRIPTS.parent / "results" / "w4-line-gate.json").read_text(encoding="utf-8"))
    rows = body["rows"]
    said = "\n".join(line_gate.summarize(rows, 0.2, 0.6))
    assert "shipped agreement share 0.6" in said and "-- refused by decode(0.6)" in said
    assert "-- refused by either(0.6)" in said
    assert "-- refused by decode(0.5)" not in said, "another model's threshold must not be the report"
    # The tables are the row's rule and not a relabelling of one: 0.6 refuses strictly more right texts than
    # 0.5 on these rows (the docstring's 47 against 32), so the section moves with the share.
    at_six = [r for r in rows if not str(r["mode"]).startswith("wrongtext") and _refuses(r, 0.6)]
    at_five = [r for r in rows if not str(r["mode"]).startswith("wrongtext") and _refuses(r, 0.5)]
    assert len(at_six) > len(at_five), "the sweep's own reading of what a higher share costs"

    keys = line_gate.rules(0.2, 0.45)
    assert line_gate.share_rule("decode", 0.45) == "decode(0.45)" and "decode(0.45)" in keys
    assert "decode(0.5)" in keys, "and the swept grid keeps the names every recorded run printed"


def _refuses(row: dict[str, Any], theta: float) -> bool:
    """`line_gate`'s shipped rule at share `theta` — the rung's own fallbacks, as `rules` reads them."""
    return bool(line_gate.rules(0.2, theta)[line_gate.share_rule("decode", theta)](row))


def test_the_committed_calibration_rows_name_the_model_they_were_measured_on() -> None:
    """The other half of the same hole: every committed row set must name the bundle its numbers belong to, or
    W4b's second model leaves no way to tell which rows produced which thresholds. Deriving bands means
    writing rows, so this holds each file to the row it fits — and to a model the table actually has, since a
    row set naming a bundle `CALIBRATED` does not hold is a calibration nothing reads."""
    from encore_worker.domain.lyrics import lexical

    base = lexical.BANDS.model
    results = SCRIPTS.parent / "results"
    expected = {
        "w3-lift-stem.json": base,
        "w3-lift-mix.json": base,
        "w3-line-gate.json": base,
        "w2-line-gate.json": base,
        # W4's re-read of the same rung on the exact clock (review r2: it was committed and cited nowhere).
        "w4-line-gate.json": base,
        "w4-lift-stem.json": base,
        "w4-lift-mix.json": base,
        # W4b's never-sung calibration. Not a lift row set, but the same rule: its three literals are read on
        # one model's decode, so a row set that did not name it could be mistaken for another model's.
        "w4b-unsung-gate.json": base,
        # W4b 6b: the SHIPPED default's own recalibration, on the same texts and the same decoder, and the
        # two bundles reachable by name only (`ml.ALIGN_MODELS_BY_DEVICE` is empty — no CUDA sweep exists).
        "w4b-lift-stem-hubert-large.json": "HUBERT_ASR_LARGE",
        "w4b-lift-mix-hubert-large.json": "HUBERT_ASR_LARGE",
        "w4b-line-gate-hubert-large.json": "HUBERT_ASR_LARGE",
        "w4b-lift-stem-hubert-xlarge.json": "HUBERT_ASR_XLARGE",
        "w4b-lift-mix-hubert-xlarge.json": "HUBERT_ASR_XLARGE",
        "w4b-line-gate-hubert-xlarge.json": "HUBERT_ASR_XLARGE",
    }
    for name, model in expected.items():
        body = json.loads((results / name).read_text(encoding="utf-8"))
        assert body["model"] == model, name
        assert lexical.is_calibrated(str(body["model"])), f"{name} names a model with no row"


def test_both_hubert_mix_doubt_bands_sit_where_their_committed_rows_put_them() -> None:
    """W4b REVIEW R2 (correctness-7): `mix_ok_from` is the one band a person reads off the per-band timing
    table, and neither HuBERT row's reading was on the record. L's **0.40** appeared nowhere at all (0.30 and
    0.35 fit the module's stated rule equally), and XL's **0.30** was justified with the three exhibits that
    support it while a fourth text in the same population contradicts it. Both derivations are in `lexical`'s
    MIX paragraphs now, and this holds them to the rows they were read from — the check the module's own
    recipe ("where the truth texts' blind decodes stop being poor") cannot make in a docstring.
    """
    from encore_worker.domain.lyrics import lexical

    results = SCRIPTS.parent / "results"

    def truth_lifts(name: str) -> dict[str, tuple[float, float]]:
        body = json.loads((results / name).read_text(encoding="utf-8"))
        return {
            str(row["song"]): (float(row["lift"]), float(row["blind_pm1"]))
            for row in body["rows"]
            if row["mode"] == "truth" and row["lift"] is not None
        }

    large, step = truth_lifts("w4b-lift-mix-hubert-large.json"), 0.05
    ok_from = lexical.CALIBRATED["HUBERT_ASR_LARGE"].mix_ok_from
    poor, good = large["never-be-alone"], large["The_Rinn_-_Voices__2017_Version_"]
    assert poor == pytest.approx((0.2507, 0.1277), abs=5e-5), "the last poor blind decode above the mix floor"
    assert good == pytest.approx((0.4231, 0.7609), abs=5e-5), "and the first good one above it"
    assert sorted(v for v, _ in large.values() if poor[0] < v < good[0]) == [], "nothing lies between them"
    assert poor[0] < ok_from <= good[0], "the split is in the gap the two exhibits open"
    assert ok_from + step > good[0], f"and 0.40 is the LARGEST {step} step in it, which is what makes it 0.40"

    xlarge = truth_lifts("w4b-lift-mix-hubert-xlarge.json")
    xl_ok_from = lexical.CALIBRATED["HUBERT_ASR_XLARGE"].mix_ok_from
    admitted, below = xlarge["Pure_Mids_-_The_Leader"], xlarge["Slingshot_Miracle_-_Whistler"]
    assert admitted == pytest.approx((0.3109, 0.30), abs=5e-5)
    assert admitted[0] > xl_ok_from and admitted[1] < 0.35, "the ONE poor decode this row's band grades OK"
    assert below == pytest.approx((0.3033, 0.6129), abs=5e-5)
    assert below[0] < admitted[0] and admitted[0] - below[0] < step, (
        "and no grid step separates the two, which is why the exhibit is recorded and the band is not moved"
    )


def test_the_calibration_procedure_reproduces_the_shipped_row_from_the_committed_rows(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """W4b: the per-model table is only as good as the PROCEDURE that fills it, so both scripts now print the
    row they fit — and run over the committed W4 rows they must print the row this worker ships. That is what
    makes "add a row" a mechanical step for 6b rather than an exercise in reading a docstring, and it is the
    test that fails if the procedure and the shipped numbers ever drift apart.

    Every threshold of `lexical.BANDS` is covered: the two stem bands and the mix floor from
    `lift_gate.py --from` on `results/w4-lift-{stem,mix}.json`, and the agreement share from
    `line_gate.py --from` on `results/w4-line-gate.json`. `mix_ok_from` is deliberately NOT derived — it is
    read off the per-band timing table by a person, and the script says so.
    """
    from encore_worker.domain.lyrics import lexical

    results = SCRIPTS.parent / "results"
    assert lift_gate.main(["--from", str(results / "w4-lift-stem.json")]) == 0
    stem = capsys.readouterr().out
    assert f"-> refuse_below={lexical.BANDS.refuse_below:.2f}, ok_from={lexical.BANDS.ok_from:.2f}" in stem, (
        stem[-400:]
    )
    assert "Head-room over the wrong population: +0.0082" in stem, "the margin the docstring quotes"

    assert lift_gate.main(["--from", str(results / "w4-lift-mix.json")]) == 0
    mix = capsys.readouterr().out
    assert f"-> mix_floor={lexical.BANDS.mix_floor:.2f}" in mix, mix[-400:]
    assert "mix_ok_from from the per-band table above" in mix, "the one threshold a person must still read"
    # THE MIX MARGIN, printed since W4b review r1 and quoted by `mix_floor`'s block: the base row keeps
    # +0.0349 with NO wrong text in the half-step under the floor. It is the margin that decides a stemless
    # song terminally, and no row stated it until the XL row turned out to have +0.0021 of it.
    assert "Head-room over the wrong population: +0.0349   wrong texts at or above 0.1250: 0" in mix

    # AND THE COST THE SAME BLOCK QUOTES, counted off the same rows rather than off W3's (review r1: the
    # docstring, README and `align_steps` all still said W3's 48 while the row of record read 54).
    rows = json.loads((results / "w4-lift-mix.json").read_text(encoding="utf-8"))["rows"]
    right = [r for r in rows if r["mode"] in lift_gate.RIGHT_MODES]
    under = [r for r in right if r["lift"] < lexical.BANDS.mix_floor]
    assert (len(right), len(under)) == (192, 54), "the mix floor's cost on the base bundle's row of record"
    assert sum(1 for r in under if r["mode"] == "truth") == 7, "7 of the corpus's 32 truth texts"
    assert sum(1 for r in under if r["mode"] in lift_gate.PROTECTED) == 41, "41 of the 160 protected"
    assert sum(1 for r in right if r["lift"] < lexical.BANDS.mix_ok_from) == 108, "`mix_ok_from` holds 108"

    assert line_gate.main(["--from", str(results / "w4-line-gate.json")]) == 0
    share = capsys.readouterr().out
    assert f"-> line_sync_min_agreement={lexical.BANDS.line_sync_min_agreement}" in share, share[-400:]
    assert "share 0.5: right refused  32/416, shown gross   0" in share, "the sweep the block is argued from"


@pytest.mark.parametrize(
    ("model", "slug", "headroom", "share_line", "mix_margin"),
    [
        (
            "HUBERT_ASR_LARGE",
            "large",
            "+0.2306",
            "share 0.5: right refused  13/416, shown gross   0",
            "Head-room over the wrong population: +0.0343   wrong texts at or above 0.1250: 0",
        ),
        (
            "HUBERT_ASR_XLARGE",
            "xlarge",
            "+0.0722",
            "share 0.5: right refused  16/416, shown gross   0",
            "Head-room over the wrong population: +0.0021   wrong texts at or above 0.1250: 3",
        ),
    ],
)
def test_the_procedure_reproduces_the_hubert_rows_too(
    capsys: pytest.CaptureFixture[str],
    model: str,
    slug: str,
    headroom: str,
    share_line: str,
    mix_margin: str,
) -> None:
    """W4b 6b, and the reason the table is worth having: the SHIPPED bundle is HuBERT-Large now (XLarge on
    CUDA), so each row has to be derivable from its own committed rows by the same three commands — otherwise
    "recalibrate per model" is a sentence rather than a procedure.

    `ok_from` is the one field W4b restated (the old "higher split fit, rounded up" would have demoted five
    protected right texts of one song on HuBERT-L), so it is asserted BOTH ways: the number, and the property
    the rule exists for — the band holds a drop50 and no protected right text. The head-room is asserted per
    model because it is the difference between the two: L clears the wrong population by 28x the base row's
    margin, XL by 9x, which is why XL's caveats are written down where its row is.
    """
    from encore_worker.domain.lyrics import lexical

    row = lexical.CALIBRATED[model]
    results = SCRIPTS.parent / "results"
    assert lift_gate.main(["--from", str(results / f"w4b-lift-stem-hubert-{slug}.json")]) == 0
    stem = capsys.readouterr().out
    assert f"-> refuse_below={row.refuse_below:.2f}, ok_from={row.ok_from:.2f}" in stem, stem[-500:]
    assert f"Head-room over the wrong population: {headroom}" in stem, "against the base row's +0.0082"

    rows = json.loads((results / f"w4b-lift-stem-hubert-{slug}.json").read_text(encoding="utf-8"))["rows"]
    inside = [r for r in rows if r["lift"] is not None and row.refuse_below <= r["lift"] < row.ok_from]
    assert {r["mode"] for r in inside} == {"drop50"}, f"the doubt band holds only drop50: {inside}"

    assert lift_gate.main(["--from", str(results / f"w4b-lift-mix-hubert-{slug}.json")]) == 0
    mix = capsys.readouterr().out
    assert f"-> mix_floor={row.mix_floor:.2f}" in mix, mix[-400:]
    # THE MIX MARGIN PER ROW (W4b review r1). Both HuBERT rows fit the same 0.15 floor, and the margin is
    # where they diverge: L keeps the base row's +0.0343 with nothing in the half-step below, XL keeps
    # **+0.0021** with THREE wrong texts there — its third caveat, and the reason a CUDA sweep that re-fits
    # this row must re-read the mix half rather than assume the stem's 9x margin carries over.
    assert mix_margin in mix, mix[-400:]

    assert line_gate.main(["--from", str(results / f"w4b-line-gate-hubert-{slug}.json")]) == 0
    share = capsys.readouterr().out
    assert f"-> line_sync_min_agreement={row.line_sync_min_agreement}" in share, share[-400:]
    assert share_line in share, "the sweep the share is read off"


def test_the_fitted_row_refuses_to_pick_a_threshold_when_the_populations_overlap() -> None:
    """The other half of "fail loudly or refuse to gate", at calibration time: a model whose right and wrong
    texts OVERLAP has no threshold meeting review §3.4, and the procedure must say so rather than round the
    midpoint of a negative gap into a plausible-looking band. A wave that sees this ships the model with NO
    row, which makes the gates stand down instead of convicting right texts."""
    overlapping = [
        {"song": "s1", "group": lib.JAMENDO, "mode": "truth", "variant": 0, "lift": 0.10, "letters": 200},
        {"song": "s1", "group": lib.JAMENDO, "mode": "drop50", "variant": 0, "lift": 0.08, "letters": 200},
        {"song": "s1", "group": lib.JAMENDO, "mode": "wrongtext", "variant": 0, "lift": 0.30, "letters": 200},
    ]
    said = "\n".join(lift_gate.fitted(overlapping, "stem"))
    assert "NO THRESHOLD" in said and "OVERLAP" in said and "no row" in said
    assert "refuse_below=" not in said, "it must not print a band it cannot justify"

    apart = [{**row, "lift": 0.90} for row in overlapping if row["mode"] != "wrongtext"] + [
        row for row in overlapping if row["mode"] == "wrongtext"
    ]
    assert "refuse_below=0.60" in "\n".join(lift_gate.fitted(apart, "stem")), (
        "and with a gap it rounds the midpoint (0.60) DOWN onto the 0.05 grid"
    )


def test_the_committed_unsung_rows_hold_the_never_sung_floors_record() -> None:
    """W4b (b). `align_steps._NEVER_SUNG_ENV`'s block says the absolute 0.10 beats every per-song relative
    floor, and `results/w4b-unsung-gate.json` is the row set it says it on (`scripts/unsung_gate.py`, 192
    song-modes). This holds the record to the rows so neither can drift, and it is the test to re-read when a
    later wave (or a new model) re-runs the script.

    THE THREE CLAIMS, in the order the block makes them: the rule pays for itself against the floor at 0; a
    relative floor at the song's own median gap is a NO-OP because the level BETWEEN lines is at or above 0.10
    on nearly every song; and the lower quantiles that would spare `Pure_Mids_-_The_Leader`'s real line spare
    INJECTED lines too, which is an `unsung-not-up-*` rise.
    """
    from encore_worker.steps import align_steps

    body = json.loads((SCRIPTS.parent / "results" / "w4b-unsung-gate.json").read_text(encoding="utf-8"))
    assert body["floor"] == align_steps._NEVER_SUNG_ENV, "the rows were measured at the shipped floor"
    rows = body["rows"]
    assert len(rows) == 192, "32 songs x 6 text modes"

    def totals(rule: str) -> dict[str, int]:
        got = dict.fromkeys(("real", "fake", "w500", "gross", "moved"), 0)
        for row in rows:
            one, shipped = row["rules"][rule], row["rules"]["abs-0.10"]
            got["real"] += len(one["dropped_real"])
            got["fake"] += len(one["dropped_fake"])
            got["w500"] += int(one["w500"])
            got["gross"] += int(one["gross"])
            got["moved"] += int(one["dropped"] != shipped["dropped"])
        return got

    shipped, off = totals("abs-0.10"), totals("abs-0.00")
    assert (shipped["real"], shipped["fake"]) == (37, 21), "the rule's own cost, in lines not published"
    assert (off["real"], off["fake"]) == (0, 0), "abs-0.00 is the rule OFF: it drops nothing"
    assert shipped["w500"] > off["w500"] and shipped["gross"] < off["gross"], (
        "the rule pays for itself: more line starts within ±500 ms and fewer gross lines"
    )
    assert (shipped["w500"], shipped["gross"]) == (6576, 1138)
    assert (off["w500"], off["gross"]) == (6568, 1157)

    medians = [row["gap_median"] for row in rows if row["mode"] == "truth"]
    assert len(medians) == 32
    assert sum(1 for value in medians if value >= align_steps._NEVER_SUNG_ENV) == 29, (
        "the level BETWEEN lines is above the absolute floor on 29 of 32 stems (review L2's bleed)"
    )
    assert totals("gapq0.5-capped")["moved"] == 0, "so a capped median floor is a no-op on every song-mode"

    q10 = totals("gapq0.1-capped")
    assert q10["fake"] == 16 and q10["fake"] < shipped["fake"], "it spares injected lines: `unsung` rises"
    assert q10["w500"] < shipped["w500"] and q10["gross"] > shipped["gross"], "and it is worse on both"

    both = {
        (row["song"], line["index"]): line
        for row in rows
        if row["mode"] == "truth"
        for line in row["candidates"]
    }
    kept, dropped = both[("Pure_Mids_-_The_Leader", 0)], both[("tfr-chosen", 34)]
    assert round(kept["env"], 3) == round(dropped["env"], 3) == 0.089, (
        "the line the wave wants kept and the line its own song is better without read the SAME level"
    )
    assert kept["real"] and dropped["real"], "both are lines the truth file carries"
    levels = {
        real: [line["env"] for row in rows for line in row["candidates"] if bool(line["real"]) is real]
        for real in (True, False)
    }
    assert max(levels[False]) > min(levels[True]), "and the two populations overlap: no floor sorts them"

    # AND THE CONCLUSION IS A STEM CONCLUSION (W4b review r1). `measure` read `song.vocals` for all 192 rows,
    # while review L2's objection is about the MIX — where the band fills the gaps between lines, so 0.10 is
    # nowhere near them and the rule cannot fire at all. That target ships (a stemless song aligns on its
    # mix), so the record must say which target it priced and the harness must price the other one too.
    assert str(body.get("target") or lib.STEM_TARGET) == lib.STEM_TARGET
    said = unsung_gate.summarize(rows, 0.10, lib.STEM_TARGET)[0]
    assert "target stem" in said and "review L2" not in said
    on_mix = unsung_gate.summarize(rows, 0.10, lib.STEMLESS_TARGET)[0]
    assert "target mix" in on_mix and "review L2's case" in on_mix, "an unrun target must announce itself"
    with pytest.raises(SystemExit):
        unsung_gate.main(["--target", "stereo"])


def test_unsung_gate_floors_are_capped_and_never_turn_the_rule_off() -> None:
    """`unsung_gate.floors`: the relative rules are the song's own quantile, and the CAPPED family can only
    ever spare a line (it never exceeds the shipped floor), which is what makes them safe to sweep. A song
    whose decode leaves no readable gap keeps the shipped floor rather than a floor of 0 — which would turn
    the rule off silently on exactly the songs whose decode is one long smear."""
    every = unsung_gate.floors(0.10)
    gaps = [0.01, 0.02, 0.30, 0.40]
    assert every["abs-0.10"](gaps) == 0.10 and every["abs-0.00"](gaps) == 0.0
    assert every["gapq0.1-capped"](gaps) == 0.01, "the song's own q10, under the cap"
    assert every["gapq0.5-capped"](gaps) == 0.10, "its median is above the cap, so the cap binds"
    assert every["gapq0.5-raw"](gaps) == 0.30, "uncapped reads the quantile itself"
    for name, rule in every.items():
        assert rule([]) == 0.10 or name.startswith("abs-"), f"{name} must not read a floor off no gaps"


def test_the_committed_w2_rows_carry_both_placements_at_the_shipped_band() -> None:
    """W2 re-derived the rung's agreement share and `_LINE_SYNC_NEAR_SEC` on MAPPED claims, and the numbers in
    `align_steps`' docstrings are read off these rows — so the row set has to say which band it was measured
    in and carry BOTH placements, or the delta it is cited for (88 -> 33 refused) cannot be recomputed."""
    from encore_worker.domain.lyrics import lexical
    from encore_worker.steps import align_steps

    body = json.loads((SCRIPTS.parent / "results" / "w2-line-gate.json").read_text(encoding="utf-8"))
    assert body["near_sec"] == align_steps._LINE_SYNC_NEAR_SEC
    rows = body["rows"]
    assert len(rows) == 1056
    for key in ("near", "w3_near", "w3_w500", "w3_scored", "map", "map_applied", "held"):
        assert all(key in row for row in rows), key
    share = lexical.BANDS.line_sync_min_agreement

    def refused(row: dict[str, Any], key: str) -> bool:
        near = row[key]
        near_enough = bool(row["sheet"]) if near is None else near >= share
        return not ((row["lift"] is None or row["lift"] >= 0.2) and near_enough)

    right = [r for r in rows if not str(r["mode"]).startswith("wrongtext")]
    was = {(r["song"], r["mode"], r["variant"]) for r in right if refused(r, "w3_near")}
    now = {(r["song"], r["mode"], r["variant"]) for r in right if refused(r, "near")}
    assert (len(was), len(now)) == (88, 33), "the docstring's headline delta"
    assert now < was, "the clock refuses nothing W3's placement admitted"


def test_the_committed_w4_rows_re_read_the_line_sync_thresholds_on_the_exact_clock() -> None:
    """W4 6a moved every emission matrix, so the agreement share and `_LINE_SYNC_NEAR_SEC` were being
    read on a scale they were not fitted on. `results/w4-line-gate.json` is that re-read — and review r2
    found it committed and cited NOWHERE, with the constants' record still arguing from a W2 population that
    the exact clock had dissolved. This holds the docstring's re-read (and README's second share table) to
    the rows, so neither can drift from the other again.

    THE ARGUMENT THAT CHANGED: W2 defended 0.5 by the gap between the two documents more than 20% gross
    (shares 0.24 and 0.32) and the rest's p10 (0.54). On the exact clock NO right text is more than 20%
    gross, so the separation is re-read against the quality population the rows carry: the 2 documents under
    half their lines within 1 s of truth, and the 410 at 80% or more.

    AND WHAT THE TIMING HALF CANNOT DO ALONE: one wrong-text case reads ABOVE the share (`Kinematic_-_Peyote`
    under `wrongtext+ownclock`), and the LEXICAL LIFT is what refuses it — so the two gates are asserted
    together here, as the rung reads them.
    """
    import math
    import statistics

    from encore_worker.domain.lyrics import lexical
    from encore_worker.steps import align_steps

    share = lexical.BANDS.line_sync_min_agreement
    body = json.loads((SCRIPTS.parent / "results" / "w4-line-gate.json").read_text(encoding="utf-8"))
    assert body["near_sec"] == align_steps._LINE_SYNC_NEAR_SEC
    rows = body["rows"]
    assert len(rows) == 1056
    right = [r for r in rows if not str(r["mode"]).startswith("wrongtext")]
    wrong = [r for r in rows if str(r["mode"]).startswith("wrongtext")]
    assert (len(right), len(wrong)) == (416, 640)

    def refused(row: dict[str, Any]) -> bool:
        near = row["near"]
        near_enough = bool(row["sheet"]) if near is None else near >= share
        return not ((row["lift"] is None or row["lift"] >= lexical.BANDS.refuse_below) and near_enough)

    assert sum(1 for r in right if refused(r)) == 32, "the docstring's 32 of 416 refused at the shipped share"
    assert not any(r["scored"] and r["gross"] / r["scored"] > 0.20 for r in right), (
        "W2's >20%-gross population is what the old separation argument rested on: it is gone"
    )

    def p10(values: list[float]) -> float:
        ordered = sorted(values)
        index = (len(ordered) - 1) * 0.10
        low, high = math.floor(index), math.ceil(index)
        return ordered[low] + (ordered[high] - ordered[low]) * (index - low)

    scored = [r for r in right if r["scored"]]
    bad = [r for r in scored if r["w1000"] / r["scored"] < 0.5]
    good = [r for r in scored if r["w1000"] / r["scored"] >= 0.8]
    assert (len(bad), len(good)) == (2, 410), "the quality populations the re-read argues from"
    assert max(r["near"] for r in bad) < share <= p10([r["near"] for r in good]), (
        "the share must sit above every bad document and under the good population's p10"
    )
    assert round(max(r["near"] for r in bad), 4) == 0.3404
    assert round(p10([r["near"] for r in good]), 3) == 0.583
    assert round(statistics.median([r["near"] for r in good]), 4) == 0.8649
    over = [r for r in wrong if r["near"] is not None and r["near"] >= share]
    assert [r["song"] for r in over] == ["Kinematic_-_Peyote"], "the one wrong text the timing half admits"
    assert all(r["lift"] < lexical.BANDS.refuse_below for r in over), "and the lift is what refuses it"
    assert all(refused(r) for r in wrong), "0 of 640 wrong texts pass the rung's two gates together"


def test_a_committed_row_set_names_the_bundle_it_was_measured_on(monkeypatch: pytest.MonkeyPatch) -> None:
    """W3 review r1: both calibration scripts wrote `"model": "default"` into their `--out`, while
    `lexical.BANDS.model` names a bundle and the harness already resolves that name for the emission cache's
    key. Once W4b runs them with `--model <hubert>` and adds its row, an older row set reading "default"
    leaves nothing in the record to prove which model produced which thresholds.

    RESOLVED PER DEVICE since W4b 6b, because that is what an unnamed bundle MEANS now (`e2e.default_model`):
    the name a row set is filed under has to be the one the aligner loaded, and on a CUDA box that is a
    different bundle from an MPS box's."""
    monkeypatch.setattr(e2e, "default_model", lambda language, device: f"THE-{language.upper()}-{device}")
    for script in (lift_gate, line_gate, unsung_gate):
        assert script.model_name(None, "mps") == "THE-EN-mps", script.__name__
        assert script.model_name("hubert", "mps") == "hubert", script.__name__


def test_line_gate_scores_at_the_band_the_rung_applies(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """`--tau` defaults to `lexical.BANDS.refuse_below`, the number the rung itself gates on since W3 review
    r1 — not a literal of its own — so a recalibration re-scores this table on the shipped gate. Read through
    `--from`, which decodes nothing."""
    from encore_worker.domain.lyrics import lexical

    row = {
        "song": "s1",
        "group": "jamendo",
        "mode": "truth",
        "sheet": True,
        "sheet_r": 0.91,
        "lift": 0.5,
        "near": 0.9,
        "scored": 4,
        "gross": 0,
        "w500": 4,
        "w1000": 4,
        "in_text": 4,
    }
    stored = tmp_path / "rows.json"
    stored.write_text(json.dumps({"model": "X", "near_sec": 1.0, "rows": [row]}), encoding="utf-8")
    assert line_gate.main(["--from", str(stored)]) == 0
    printed = capsys.readouterr().out
    assert f"lexical gate at {lexical.BANDS.refuse_below}" in printed
    moved = lexical.Bands(
        model="hubert-like",
        refuse_below=0.55,
        ok_from=0.8,
        mix_floor=0.4,
        mix_ok_from=0.9,
        line_sync_min_agreement=0.5,
        margin_floor_nats=10.0,
    )
    monkeypatch.setattr(lexical, "BANDS", moved)
    assert line_gate.main(["--from", str(stored)]) == 0
    assert "lexical gate at 0.55" in capsys.readouterr().out


def test_line_gate_prints_both_placements_and_the_documents_no_line_lands_in(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """W2's `placements` block: the same rule read on W3's placement (`w3_near`) and on the mapped one
    (`near`), with the count `gates/w3-lines.yaml` holds — published documents with NO line within ±500 ms of
    truth. A row set from before the map (no `w3_near`) is skipped, not silently read as a comparison.

    THE SHARE IS PASSED IN since W4b (it lives in `lexical.CALIBRATED`'s row, per model), so this reads the
    shipped row's — the same number the rung applies.

    `gross` AND `w3_gross` DIFFER IN THIS FIXTURE ON PURPOSE (W2 review r2). They used to be equal, and the
    two columns' gross was one hardcoded `r['gross']`, so the W3 row printed the W2 placement's count over
    W3's documents — 0 where the committed rows' W3 placement is 47 — and no test could see it. Equal
    fixture values make a transposed column indistinguishable from a correct one."""
    mapped = {
        "song": "s1",
        "mode": "truth",
        "variant": 0,
        "sheet": True,
        "lift": 0.5,
        "near": 0.9,
        "w3_near": 0.2,
        "scored": 4,
        "gross": 0,
        "w500": 4,
        "w1000": 4,
        "in_text": 4,
        "w3_scored": 4,
        "w3_gross": 3,
        "w3_w500": 0,
        "w3_w1000": 4,
        "map": "decode-median",
        "map_applied": True,
        "held": 1,
    }
    from encore_worker.domain.lyrics import lexical

    share = lexical.BANDS.line_sync_min_agreement
    got = line_gate.placements([mapped], 0.2, ["truth"], share)
    assert len(got) == 2, "the mode and the ALL row"
    assert "W3 refused   1/  1" in got[0] and "W2 refused   0/  1" in got[0]
    assert "zero-±500 docs   0" in got[0] and "maps 1/1 (decode-median 1), held 1" in got[0]
    # The W3 column's own zero-±500 count is unreadable here (it refused the row), which is the point of the
    # gate's `refused == 0` factor: a refused song scores 0 and must not be counted as a misplaced document.
    shown_by_w3 = {**mapped, "w3_near": 0.9}
    both = line_gate.placements([shown_by_w3], 0.2, ["truth"], share)[0]
    assert "W3 refused   0/  1" in both
    assert "zero-±500 docs   1\n" in both
    w3_row, w2_row = both.split("\n")[:2]
    assert "gross    3" in w3_row, "the W3 column reads w3_gross, not the mapped placement's gross"
    assert "gross    0" in w2_row, "and the W2 column reads its own"
    del mapped["w3_near"]
    assert line_gate.placements([mapped], 0.2, ["truth"], share) == [], "a pre-W2 row set is not a comparison"
    capsys.readouterr()


def test_line_gate_reads_the_shipped_agreement() -> None:
    @dataclass(frozen=True)
    class L:
        index: int
        start: float

    decoded = [L(0, 1.0), L(1, 5.0), L(2, 9.5), L(4, 20.0)]
    got = line_gate.claim_agreement(decoded, {0: 1.5, 1: 5.5, 2: 12.0, 3: 15.0}, 1.0)
    # `pairs` is the share's DENOMINATOR, recorded since W3 review r2 so the rung's minimum decoded share can
    # be re-read from a stored run: line 4 decoded but is unclaimed, line 3 is claimed but never decoded.
    assert got == {"near": 2 / 3, "median_gap": 0.5, "offset": -0.5, "near_fit": 2 / 3, "pairs": 3.0}
    assert set(line_gate.claim_agreement(decoded[:2], {0: 1.0, 1: 5.0}, 1.0).values()) == {None}


#: Every claim mode `gates/w6-conf.yaml` names a gate for. A gate for a mode the run did not measure is an
#: ERROR by design, so this list and the file's must agree — which is what the test below proves.
W6_CLAIM_MODES = (
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
    "headers",
    "credit",
)


def conf_rows(
    *,
    high: Sequence[int],
    mode: str,
    moved_onset: bool = False,
    late: Mapping[str, float] | None = None,
) -> list[Any]:
    """Two songs a mode, SIX word-timed lines each, and the SAME timings whatever the grades are: line 0 is
    3 s off, line 1 is 0.9 s off, lines 2-5 are exact. `high` names which lines each song grades `high` —
    the only thing this wave changes, and the reason the alignment metrics must read identical on both sides
    of the comparison.

    Word truth matters: `highlight` and every `word_*` metric are None without it, and a gate reading None
    is an ERROR — so a fixture with no words would let a mistyped word metric pass as "not measured".

    `late` is `{slug: seconds}` and pushes THAT song's last line out by that much — the one knob that makes a
    single song in a single mode gain a gross line, which is what `gates/w6.yaml`'s per-song gate guards and
    which no grade-only perturbation of this fixture can produce.
    """
    base = (3.0, 0.9, 0.0, 0.0, 0.0, 0.0)
    rows = []
    for index in range(2):
        truth = [(f"one{i} two{i} three{i}", 10.0 * i, 10.0 * i + 2.6) for i in range(len(base))]
        words = [(10.0 * i + k, 10.0 * i + k + 0.5) for i in range(len(base)) for k in (0, 1, 2)]
        song = song_of(truth, slug=f"s{index}", words=words)
        offsets = [*base[:-1], base[-1] + (late or {}).get(f"s{index}", 0.0)]
        got = claims(song, "truth")
        doc = [
            line(
                i,
                words[3 * i][0] + offsets[i],
                confidence="high" if i in high else "low",
                words=tuple(
                    lib.DocWord(
                        start + offsets[i] + (0.05 if moved_onset and index == 0 and i == 5 else 0.0),
                        end + offsets[i],
                        True,
                    )
                    for start, end in words[3 * i : 3 * i + 3]
                ),
            )
            for i in range(len(offsets))
        ]
        rows.append(
            lib.row_of(
                song=song,
                mode=mode,
                variant=0,
                claims=got,
                outcome=lib.PUBLISHED,
                doc=doc,
                extra={"onsets_sha256": lib.onset_digest(doc)},
            )
        )
    return rows


def conf_document(
    *, blind_high: Sequence[int], claim_high: Sequence[int] = (1, 2, 3, 4, 5), moved_onset: bool = False
) -> dict[str, Any]:
    """`blind` plus every claim mode the gate file names. The two populations are graded SEPARATELY because
    that is what was measured: the demotion is read on the one branch whose grade rests on our own decode,
    so claim modes are grade-for-grade unchanged and `blind` is where the rule decides."""
    rows: list[Any] = []
    for mode in ("blind", *W6_CLAIM_MODES):
        rows += conf_rows(
            mode=mode,
            high=blind_high if mode == "blind" else claim_high,
            moved_onset=moved_onset,
        )
    return document(rows, **SETUP)


def test_the_confidence_reject_if_file_reads_precision_coverage_the_zero_and_a_moved_onset() -> None:
    """`gates/w6-conf.yaml` is review §3.7's encodable half, read hours after two sweeps start (the wave's
    rule is DEFAULT-ON, so its baseline is a `conf-legacy` run — see the file's header). Each condition is
    exercised in the direction it exists for, and every metric name it uses has to RESOLVE: an unknown
    metric is an ERROR by design, and a mistyped mode in a file read after a 2-hour sweep is the failure
    this test exists to prevent.
    """
    rules = gates.parse_gates((GATES_DIR / "w6-conf.yaml").read_text(encoding="utf-8"))
    names = {rule.name for rule in rules}
    assert {f"high-gross-zero-{mode}" for mode in W6_CLAIM_MODES} <= names
    # The control's `blind` grades ALL SIX lines `high`, the 3 s one included: review §3.7's opening shape.
    control = gates.view_of(conf_document(blind_high=(0, 1, 2, 3, 4, 5)))

    def statuses(**kw: Any) -> dict[str, str]:
        view = gates.view_of(conf_document(**kw))
        return {r.gate.name: r.status for r in gates.run_gates(rules, view, control)}

    # W6's measured shape: the two out-of-tolerance lines demoted on `blind`, claim modes untouched.
    ok = statuses(blind_high=(2, 3, 4, 5))
    assert {name: status for name, status in ok.items() if status != "PASS"} == {}
    # A run identical to its control gains nothing, so the halving gate must FAIL — the non-vacuity check
    # every gate file here owes — and the Jamendo zero fails on the control's own gross line.
    same = statuses(blind_high=(0, 1, 2, 3, 4, 5))
    assert same["bad-among-high-halved-blind"] == "FAIL"
    assert same["high-gross-zero-blind-jamendo"] == "FAIL"
    assert same["high-gross-zero-truth"] == "PASS", "claim-mode `high` lines are within tolerance already"
    assert same["coverage-held-blind"] == "PASS" and same["onsets-unchanged-truth"] == "PASS"
    # Demoting only the gross line halves nothing: 0.9 s is still bad, and 1 of 5 is not half of 2 of 6.
    partial = statuses(blind_high=(1, 2, 3, 4, 5))
    assert partial["high-gross-zero-blind-jamendo"] == "PASS"
    assert partial["bad-among-high-halved-blind"] == "FAIL"
    # Buying the precision with coverage: one `high` line reads 0 bad and fails the floor the consumer owns.
    starved = statuses(blind_high=(5,), claim_high=(5,))
    assert starved["bad-among-high-halved-blind"] == "PASS"
    assert starved["coverage-held-blind"] == "FAIL" and starved["coverage-held-truth"] == "FAIL"


def test_the_confidence_gates_reject_a_grading_change_that_moved_an_onset() -> None:
    """The cheapest proof that a grading change is a grading change: the document's bytes move on every case
    (the `confidence` field) and the ONSETS move on none. Isolated — the same grades on both sides, so the
    only difference is one word 50 ms late — and it fails the highlight identity with it, which is the belt
    to `onsets-unchanged`'s braces."""
    rules = gates.parse_gates((GATES_DIR / "w6-conf.yaml").read_text(encoding="utf-8"))
    control = gates.view_of(conf_document(blind_high=(0, 1, 2, 3, 4, 5)))

    def failures(**kw: Any) -> set[str]:
        view = gates.view_of(conf_document(**kw))
        return {r.gate.name for r in gates.run_gates(rules, view, control) if r.status != "PASS"}

    assert failures(blind_high=(2, 3, 4, 5)) == set(), "the shipped shape moves no onset"
    moved = failures(blind_high=(2, 3, 4, 5), moved_onset=True)
    assert {"onsets-unchanged-blind", "onsets-unchanged-truth"} <= moved
    assert "highlight-identical-blind" in moved, "a moved onset moves the lit word too"


def test_the_wave_level_reject_if_file_reads_the_four_recorded_verdicts() -> None:
    """`gates/w6.yaml` (32 gates + the built-in no-ERROR-rows) had NO hermetic test, which is the gap W6
    review r1-spec-14 names: every other wave's file has one, and this one plus `gates/w6-ladder.yaml` hold
    every clamp
    and flip claim of the wave — validated only by replaying rows offline, by hand, once.

    Scored on the COMMITTED summaries, like the two `w4b-linesep` tests and for the same reason: the readings
    the file's own NON-VACUITY block records ARE the wave's recorded verdicts, so an edit to the file or the
    rows that silently moves one must turn this red. Each of the four is a different claim:

      (1) the shipped default against the tree it replaces — sections 1 and 2 clean, section 3's four FAILing
          at the base bundle's own numbers, which is correct because section 3 is the CANDIDATE's bar;
      (2) W4b's own row as both sides, so every relative gate reads `=` against itself (a ratchet must) and
          the file is shown still to tell the two trees apart where it claims to;
      (3) the HuBERT candidate — all four absolute wins PASS and the ONE FAIL is 8 song-modes gaining a gross
          line, which is why the flip is still not the default;
      (4) the `m6-window-spare` arm, where exactly the two dilution literals trip and nothing else, which is
          this file's own evidence that section 1 is tight rather than decorative.
    """
    rules = gates.parse_gates((GATES_DIR / "w6.yaml").read_text(encoding="utf-8"))
    assert len(rules) == 32, "the 32 the file's header reports; `run_gates` adds the built-in no-error-rows"
    results = SCRIPTS.parent / "results"

    def failures(run: str, base: str) -> list[str]:
        got = gates.run_gates(
            rules,
            gates.view_of(gates.load_document(results / run)),
            gates.view_of(gates.load_document(results / base)),
        )
        assert "ERROR" not in {r.status for r in got}, [
            (r.gate.name, r.detail) for r in got if r.status == "ERROR"
        ]
        return sorted(r.gate.name for r in got if r.status == "FAIL")

    flip_bar = [
        "flip-jamendo-highlight-kept",
        "flip-jamendo-truth-gross-zero",
        "flip-jamendo-word-aae-kept",
        "flip-jamendo-word-pm100-kept",
    ]
    # (1) and (2): the candidate's bar is the only thing the base bundle fails, on either tree.
    assert failures("w6-base-time_text.json", "w4b-base-time_text.json") == flip_bar
    assert failures("w6-base-run_align.json", "w4b-base-run_align.json") == flip_bar
    assert failures("w4b-base-time_text.json", "w4b-base-time_text.json") == flip_bar
    # (3) THE FLIP: every win kept, and the one reason it is still off.
    assert failures("w6-hubert-time_text.json", "w6-base-time_text.json") == ["w6-no-song-gains-gross"]
    assert failures("w6-hubert-run_align.json", "w6-base-run_align.json") == ["w6-no-song-gains-gross"]
    # (4) `m6-window-spare`: the two ratchet literals a +1-line change dilutes, and no third.
    assert failures("w6-wspare-time_text.json", "w6-base-time_text.json") == [
        *flip_bar,
        "w6-jamendo-word-end-pm100",
        "w6-jamendo-word-pm300",
    ]


def test_the_wave_level_file_bites_on_a_gross_line_a_wipe_and_a_wrong_text() -> None:
    """The other half of the non-vacuity argument, which a recorded-row reading cannot give: that each gate
    FAILS when its own condition is violated. Built hermetically on top of the confidence fixture, because the
    thing the gates guard is per-song and per-mode and the committed rows cannot be perturbed."""
    rules = gates.parse_gates((GATES_DIR / "w6.yaml").read_text(encoding="utf-8"))
    by_name = {rule.name: rule for rule in rules}

    def statuses(run: dict[str, Any], base: dict[str, Any]) -> dict[str, str]:
        got = gates.run_gates(rules, gates.view_of(run), gates.view_of(base))
        return {r.gate.name: r.status for r in got}

    control = conf_document(blind_high=(2, 3, 4, 5))
    same = statuses(control, control)
    # The absolutes read on a fixture with no Jamendo word truth beyond the fixture's own are ERROR or FAIL by
    # construction; what this reads is the RELATIVE half, which is where a regression arrives.
    for name in ("w6-pooled-gross-not-up-truth", "w6-no-song-gains-gross", "w6-high-gross-zero-claim-modes"):
        assert same[name] == "PASS", name
    # ONE claim-mode `high` line more than 2 s off fails the wipe gate and nothing else relative.
    wiped = statuses(conf_document(blind_high=(2, 3, 4, 5), claim_high=(0, 1, 2, 3, 4, 5)), control)
    assert wiped["w6-high-gross-zero-claim-modes"] == "FAIL"
    assert wiped["w6-pooled-gross-not-up-truth"] == "PASS", "no timing moved: only a grade did"
    # ONE song gaining a gross line in ONE mode fails the per-song gate AND that mode's pooled gate — which is
    # the pair `gates/w4b.yaml` learned to write separately (a sum does not rise whenever a term does).
    worse = statuses(_w6_worse_truth(), control)
    assert worse["w6-no-song-gains-gross"] == "FAIL"
    assert worse["w6-pooled-gross-not-up-truth"] == "FAIL"
    assert worse["w6-pooled-gross-not-up-blind"] == "PASS", "one mode's regression is not another's"
    assert by_name["w6-wrongtext-at-most-one-of-320"].expr.endswith("<= 0.32"), (
        "the wrong-text cap is a percentage of 320 pairs, so 1/320 is 0.3125 — see the file"
    )


def _w6_worse_truth() -> dict[str, Any]:
    """The control with ONE `truth` song's LAST line pushed 3 s off: one song gains a gross line in one mode.

    Built from `conf_rows` so the two documents differ in exactly that, which is what makes the two gates it
    trips attributable (`w6-no-song-gains-gross` and `truth`'s own pooled gross gate, not `blind`'s).
    """
    rows: list[Any] = []
    for mode in ("blind", *W6_CLAIM_MODES):
        high = (2, 3, 4, 5) if mode == "blind" else (1, 2, 3, 4, 5)
        rows += conf_rows(mode=mode, high=high, late={"s0": 3.0} if mode == "truth" else None)
    return document(rows, **SETUP)


def test_the_clamp_reject_if_file_reads_its_recorded_verdict_and_bites_on_a_moved_onset() -> None:
    """`gates/w6-ladder.yaml` (31 gates), the file holding the clamp's bounded-left-floor claim, also had no
    hermetic test (W6 review r1-spec-14) — and that is how its `clamp-blind-documents-unchanged` MUST reached
    2-3 hour sweep in a form NO run of this tree could satisfy: the control is a pre-W6 row and the same wave
    rewrites the per-line `confidence` field, so every blind document's BYTES move while no onset does. A
    fixture-driven test had to build that control, which is why the defect is the finding's own exhibit. The
    gate now reads `onsets_changed`, and both halves are pinned here:

      * THE RECORDED VERDICT, on the committed summaries — 31/31 at both levels against `results/w4b-base-*`,
        and 28/31 against W4b's own row as both sides, FAILING exactly the three line-start claims the clamp
        fix makes (gross 3 > 1, ±500 96.42 < 96.9, zero-gross songs 18 < 19). That second reading is what
        shows the file is a ratchet on this wave's work and green nowhere by accident.
      * THAT IT STILL BITES ON A TIMING MOVE, hermetically: a blind document whose ONLY difference from its
        control is one word 50 ms late fails `clamp-blind-onsets-unchanged`, while a document that differs
        only in a per-line GRADE passes it — the exact pair the old gate got backwards.
    """
    rules = gates.parse_gates((GATES_DIR / "w6-ladder.yaml").read_text(encoding="utf-8"))
    assert len(rules) == 30, "the 31 the file's header reports, less the built-in no-ERROR-rows gate"
    results = SCRIPTS.parent / "results"

    def failures(run: str, base: str) -> list[str]:
        got = gates.run_gates(
            rules,
            gates.view_of(gates.load_document(results / run)),
            gates.view_of(gates.load_document(results / base)),
        )
        assert "ERROR" not in {r.status for r in got}, [
            (r.gate.name, r.detail) for r in got if r.status == "ERROR"
        ]
        return sorted(r.gate.name for r in got if r.status == "FAIL")

    assert failures("w6-base-time_text.json", "w4b-base-time_text.json") == []
    assert failures("w6-base-run_align.json", "w4b-base-run_align.json") == []
    assert failures("w4b-base-time_text.json", "w4b-base-time_text.json") == [
        "clamp-jamendo-gross-at-most-one",
        "clamp-jamendo-pm500-up",
        "clamp-jamendo-zero-gross-songs-up",
    ]

    # The hermetic half. A GRADE-ONLY change is what W6 actually shipped on the blind population.
    control = gates.view_of(conf_document(blind_high=(0, 1, 2, 3, 4, 5)))
    graded = gates.run_gates(rules, gates.view_of(conf_document(blind_high=(2, 3, 4, 5))), control)
    by_name = {r.gate.name: r for r in graded}
    assert by_name["clamp-blind-onsets-unchanged"].status == "PASS", (
        "a document whose only change is a per-line confidence moved no onset: the whole point of the fix"
    )
    moved = gates.run_gates(
        rules, gates.view_of(conf_document(blind_high=(2, 3, 4, 5), moved_onset=True)), control
    )
    assert {r.gate.name for r in moved if r.status == "FAIL"} >= {"clamp-blind-onsets-unchanged"}, (
        "one word 50 ms late is a timing change and this file must refuse it"
    )


def test_the_shipped_tvs_highlight_is_recorded_beside_the_alignment_one() -> None:
    """W6 review r1-tests-20. `tv_lit` gained `wipe_low` and the parity fixture is written with it True — the
    SHIPPED TV lights no word on a `low` row — but `score_highlight` calls it with the default, so the one
    metric with TV semantics measured a TV that no longer exists and the wave's product change had no number
    at all. The split is right (that metric gates review §3.5 and 6c, and folding a display policy into it
    would re-baseline every row since W0); the silence was not, because `high`/`high_bad`/`high_gross` are
    computed from LINE-START errors on `high` lines and never answer "when the TV lights a word, is it the
    right one".

    So both readings are on every row now. This fixture is the minimal statement of the difference: two runs
    whose documents differ ONLY in one line's `confidence`, where the alignment highlight must read identical
    to the digit and the shipped one must fall by that line's sung seconds."""
    wiped_all = lib.summarize(conf_rows(mode="blind", high=(0, 1, 2, 3, 4, 5)))["blind"]["jamendo"]
    # Line 5 is EXACT, so it is a correctly lit row: demoting it is where the room loses a karaoke ball.
    # (Demoting line 0 or 1 — the rows that are 3.0 s and 0.9 s out — would take away only WRONG lighting,
    # which neither metric counts in its numerator, and is why this test demotes a right one.)
    some_low = lib.summarize(conf_rows(mode="blind", high=(0, 1, 2, 3, 4)))["blind"]["jamendo"]
    assert wiped_all["highlight"]["pct"] == some_low["highlight"]["pct"], (
        "the ALIGNMENT metric reads one question and a grade is not part of it"
    )
    assert some_low["highlight_wiped"]["pct"] < wiped_all["highlight_wiped"]["pct"], (
        "the SHIPPED TV lights nothing on the two demoted rows, so its lit-word coverage falls"
    )
    assert wiped_all["highlight_wiped"]["pct"] == wiped_all["highlight"]["pct"], (
        "with every row wiping, the two metrics are the same measurement — which is the check that the "
        "second "
        "is the first plus the policy, and not a second implementation of the highlight"
    )
    # Flattened, so a later wave CAN gate on it (none does today: `score_highlight` says why).
    assert lib.flat_metrics(some_low)["highlight_wiped"] == some_low["highlight_wiped"]["pct"]
    # A run written before the metric existed carries None, which the gate evaluator refuses to compare
    # rather than reading as zero.
    before = conf_rows(mode="blind", high=())
    old = [{k: v for k, v in row.items() if k != "highlight_wiped"} for row in before]
    assert lib.summarize(old)["blind"]["jamendo"]["highlight_wiped"] is None
