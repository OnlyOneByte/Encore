#!/usr/bin/env python
"""How much offset can a lyrics sheet carry before forced alignment stops recovering it?

    uv run python docs/benchmarks/forced-alignment/scripts/bench.py --song tfr-flyaway

An LRC written for another master is *confidently wrong*: real, internally consistent line timings, offset
from the recording in hand. This measures what the worker does about it as a function of how big the offset
is — a SWEEP, because whisperx crops the audio to each segment's provisional span, so accuracy is a property
of the aligner AND the windows it was handed. Three conditions: `shifted` (truth plus a known offset, the
sweep), `exact` (truth unchanged, the STABILITY control a recovery-only benchmark cannot see) and `blind`
(no timings, spread evenly). `exact` scores a do-nothing aligner perfectly, so it is a control and the sweep
is the headline. README, "The harness scripts", has the two regimes' measured rows.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SONGS_DIR = os.path.normpath(os.path.join(HERE, "..", "..", "benchmark-songs"))

#: Offsets to sweep, in seconds. Chosen around the two thresholds the worker already encodes:
#: `MIN_SHIFT_SEC = 0.35` (below it a shift is refused as noise) and the ~2s point past which a line lands
#: in a different phrase entirely.
OFFSETS_SEC = (0.0, 0.15, 0.25, 0.35, 0.5, 1.0, 2.0, 5.0)

#: Tolerances reported. 250 ms is roughly a syllable at singing tempo; 500 ms is where a line highlighting
#: late becomes the complaint rather than a nuance.
TOLERANCES_SEC = (0.1, 0.25, 0.5, 1.0)


def truth_of(song: str, override: str | None = None) -> list[dict[str, float | str]]:
    path = override or os.path.join(SONGS_DIR, song, "truth-lines.json")
    if not os.path.isfile(path):
        raise SystemExit(f"no ground truth for {song}; run truth.py {song} first")
    return json.load(open(path, encoding="utf-8"))["lines"]


def score(aligned: list[dict], truth: list[dict]) -> dict[str, float]:
    """Line-onset error statistics.

    BIAS AND SPREAD ARE REPORTED SEPARATELY because they are differently fixable. A constant lag is
    correctable downstream — core has `lyricsLeadMs`, defaulting to 0 and clamped to 1500 — whereas jitter
    around that lag is not correctable by any single number. Collapsing them into one mean would hide which
    problem a song has.
    """
    errs = [
        float(a["start"]) - float(t["start"]) for a, t in zip(aligned, truth) if a.get("start") is not None
    ]
    if not errs:
        return {"lines": 0}
    bias = statistics.median(errs)
    dev = [e - bias for e in errs]
    out: dict[str, float] = {
        "lines": len(errs),
        "bias_ms": bias * 1000.0,
        "mad_ms": statistics.median([abs(d) for d in dev]) * 1000.0,
        "gross": sum(1 for e in errs if abs(e) > 2.0),
    }
    for tol in TOLERANCES_SEC:
        out[f"within_{int(tol * 1000)}"] = sum(1 for e in errs if abs(e) <= tol) / len(errs) * 100.0
        # Bias-corrected: what a single global lead (core's lyricsLeadMs) would leave. Separates "the
        # aligner disagrees with the captions by a constant" from "the aligner scatters".
        out[f"cwithin_{int(tol * 1000)}"] = sum(1 for d in dev if abs(d) <= tol) / len(dev) * 100.0
    out["errs"] = errs  # type: ignore[assignment]
    return out


def run(aligner, audio: str, segments: list[dict], language: str) -> tuple[list[dict], float]:
    started = time.time()
    out = list(aligner.align(segments, audio, language))
    return out, time.time() - started


def main() -> None:
    sys.stdout.reconfigure(line_buffering=True)
    ap = argparse.ArgumentParser()
    ap.add_argument("--song", default="tfr-flyaway")
    ap.add_argument("--audio", default=None, help="defaults to the song's youtube-mix.wav")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--language", default="en")
    ap.add_argument(
        "--global",
        dest="global_decode",
        action="store_true",
        help="alignment v2: one global CTC decode of the text over the whole song — no "
        "windows, no input timings. Sweeps nothing, because there is nothing to sweep: "
        "claimed timings never enter.",
    )
    ap.add_argument(
        "--repair",
        action="store_true",
        help="with --global: also apply R3 (anchored re-decode of repeated lines between "
        "unique neighbours) and report before/after — the shipped repair path.",
    )
    ap.add_argument(
        "--dump",
        action="store_true",
        help="with --global: per-line signed onset errors, worst first, to see WHERE the "
        "misses are (gross misassignment vs boundary jitter).",
    )
    ap.add_argument(
        "--claims",
        nargs="?",
        const=0.0,
        default=None,
        type=float,
        help="with --global: run the SHIPPED attempt (AlignStepsImpl.time_text: never-sung "
        "drop, R3/R4/R1/R2, adoption, clamping, the envelope gate, grading) with the "
        "truth (plus this offset in seconds) as the claims — the production case where "
        "an LRC/captions exist. Claims and truth share a source here, so this measures "
        "the REPAIR MACHINERY, not blind accuracy. For the corpus-wide claim-noise sweep "
        "(jitter, tempo, partial sheets, wrong text, run_align) use e2e.py.",
    )
    ap.add_argument(
        "--vocals",
        default=None,
        help="with --claims: the vocals stem time_text aligns on; --audio then serves as "
        "R4's mix witness, as a stems job leaves them. Default: align on --audio alone "
        "(the same target as the global row; R4 then has no second witness).",
    )
    ap.add_argument(
        "--snap",
        action="store_true",
        help="with --global: prototype onset refinement — snap each line start to the "
        "strongest local energy rise within ±0.35 s.",
    )
    ap.add_argument(
        "--evidence",
        action="store_true",
        help="with --global: per-line evidence table (decode score, envelope overlap, error) "
        "to calibrate the unheard/unsung thresholds.",
    )
    ap.add_argument(
        "--truth", default=None, help="path to a truth-lines.json outside benchmark-songs (temp songs)"
    )
    ap.add_argument(
        "--words",
        default=None,
        help="with --global: path to a truth-words.json ({words:[{start,end}],tokens:[...]}) "
        "— scores WORD onsets (the karaoke ball's unit) against measured truth. "
        "MIREX-style: AAE and %-within tolerances.",
    )
    ap.add_argument(
        "--rescue",
        action="store_true",
        help="with --global: prototype BLIND repair — lines the decode could not hear are "
        "re-spread proportionally inside the vocal-active gap between trusted anchors.",
    )
    args = ap.parse_args()

    from encore_worker.adapters.ml import WhisperXAligner
    from encore_worker.domain.lyrics import place

    if args.global_decode:
        return run_global(args)

    truth = truth_of(args.song, args.truth)
    audio = args.audio or os.path.join(SONGS_DIR, args.song, "youtube-mix.wav")
    if not os.path.isfile(audio):
        raise SystemExit(f"missing {audio} — run the stem benchmark's prepare.py {args.song} first")

    import soundfile as sf

    info = sf.info(audio)
    duration = info.frames / info.samplerate
    aligner = WhisperXAligner(device=args.device)

    print(f"song={args.song} audio={os.path.basename(audio)} {duration:.1f}s device={args.device}")
    print(f"ground truth: {len(truth)} AUTHORED lines, first at {truth[0]['start']:.2f}s\n")

    header = (
        f"{'condition':>14s} {'bias':>9s} {'MAD':>8s} "
        + " ".join(f"{'±' + str(int(t * 1000)):>7s}" for t in TOLERANCES_SEC)
        + f" {'>2s':>6s} {'sec':>6s}"
    )
    print(header)
    print("-" * len(header))

    # ── the sweep: an LRC offset by a known amount ──
    for offset in OFFSETS_SEC:
        segs = [
            {"text": t["text"], "start": float(t["start"]) + offset, "end": float(t["end"]) + offset}
            for t in truth
        ]
        aligned, secs = run(aligner, audio, segs, args.language)
        s = score(aligned, truth)
        label = "exact" if offset == 0.0 else f"shifted {offset:+.2f}s"
        if not s.get("lines"):
            print(f"{label:>14s}   no timed output")
            continue
        tols = " ".join(f"{s[f'within_{int(t * 1000)}']:6.1f}%" for t in TOLERANCES_SEC)
        print(
            f"{label:>14s} {s['bias_ms']:+8.0f}m {s['mad_ms']:7.0f}m {tols} "
            f"{int(s['gross']):3d}/{int(s['lines']):<3d} {secs:5.1f}"
        )

    # ── the blind condition: no timings at all ──
    segs = list(place.spread_over([{"text": t["text"]} for t in truth], duration))
    aligned, secs = run(aligner, audio, segs, args.language)
    s = score(aligned, truth)
    if s.get("lines"):
        tols = " ".join(f"{s[f'within_{int(t * 1000)}']:6.1f}%" for t in TOLERANCES_SEC)
        print(
            f"{'blind':>14s} {s['bias_ms']:+8.0f}m {s['mad_ms']:7.0f}m {tols} "
            f"{int(s['gross']):3d}/{int(s['lines']):<3d} {secs:5.1f}"
        )

    print("\nbias = median signed error (correctable with core's lyricsLeadMs, default 0, max 1500ms)")
    print("MAD  = median |error - bias| (jitter; NOT correctable by any single offset)")
    print(">2s  = lines landing in a different phrase entirely")


class _Published:
    """A published line as `run_global`'s report reads it: which TRUTH row it is, and where it starts."""

    def __init__(self, index: int, text: str, start: float, confidence: object) -> None:
        self.index, self.text, self.start, self.confidence = index, text, start, confidence


def time_text_claims(
    aligner,
    *,
    audio: str,
    vocals: str | None,
    truth: list[dict],
    offset: float,
    language: str,
    media_dir: str,
    config: object | None = None,
) -> dict:
    """ONE SHIPPED ATTEMPT with the truth (+ `offset`) as claims: `AlignStepsImpl.time_text`, unmodified.

    `--claims` used to re-run R2 and adoption by hand, had drifted from the shipped ladder (no never-sung
    drop, no R3/R4/R1, no clamping, no gate, no grading) and crashed before printing its adoption row; the
    ladder is now whatever `time_text` is. Only the job reporter is the harness's, and so is the `as_doc`
    capture that recovers which truth row each published line is. Returns the outcome, the document
    confidence, the verdict and its trail note, the repair faults, and the published lines. `config` None
    reads the environment as the worker does, or a bare `Config()` would ignore every ENCORE_ALIGN_* knob."""
    import asyncio

    import soundfile as sf

    if HERE not in sys.path:
        sys.path.insert(0, HERE)
    import e2e  # the harness seams: the trail recorder and the as_doc capture
    import e2e_lib as lib

    from encore_worker.domain.lyrics.policy import Tier
    from encore_worker.host.config import Config
    from encore_worker.steps.align_steps import Adapters, AlignStepsImpl
    from encore_worker.steps.records import TIMING_LINE, AudioRef, JobRef, TextRef, TimeRequest

    info = sf.info(vocals or audio)
    claims = lib.Claims(
        lines=tuple(
            lib.ClaimLine(
                str(t["text"]),
                max(0.0, float(t["start"]) + offset),
                max(0.0, float(t["end"]) + offset),
                truth=i,
            )
            for i, t in enumerate(truth)
        ),
        timed=True,
    )
    trail = e2e.Trail()
    settings = config if isinstance(config, Config) else Config.from_env()
    impl = AlignStepsImpl(config=settings, adapters=Adapters(aligner=aligner), reporter=trail)
    request = TimeRequest(
        job=JobRef(job_id="bench", media_id="bench", media_dir=media_dir, source_uri=None),
        text=TextRef(tier=Tier.CANDIDATE, label=claims.label, segments=claims.segments(), timing=TIMING_LINE),
        audio=AudioRef(path=audio, vocals_path=vocals, duration_sec=info.frames / info.samplerate),
        language=language,
    )
    with e2e.capture_generated() as captured:
        timed = asyncio.run(impl.time_text(request))
    verdict, why = trail.last_global()
    out: dict = {
        "outcome": "refused",
        "confidence": None,
        "verdict": verdict,
        "why": why,
        "high": 0,
        "lines": [],
        "faults": [note[4] for note in trail.states if note[3] == "repair-faults"],
    }
    if timed is None:
        return out
    with open(os.path.join(media_dir, timed.ref), encoding="utf-8") as handle:
        doc = json.load(handle)
    lines, _identity = e2e.doc_lines(doc, captured, claims)
    out["outcome"] = "line-sync" if timed.timing == TIMING_LINE else "published"
    out["confidence"] = timed.confidence
    out["lines"] = [
        _Published(ln.source, ln.text, ln.start, ln.confidence) for ln in lines if ln.source is not None
    ]
    out["high"] = sum(1 for ln in out["lines"] if ln.confidence == "high")
    return out


def run_global(args) -> None:
    """Alignment v2's accuracy on this song: text in, our own line onsets out, scored against truth.

    Uses the REAL modules (`adapters.ml` emissions + `domain.lyrics.generate`), not a reimplementation, so
    this number is the shipped code path's number.
    """
    import time

    from encore_worker.adapters.ml import WhisperXAligner
    from encore_worker.adapters.ml import forced_align_decoder
    from encore_worker.domain.lyrics.generate import generate

    truth = truth_of(args.song, args.truth)
    audio = args.audio or os.path.join(SONGS_DIR, args.song, "youtube-mix.wav")
    if not os.path.isfile(audio):
        raise SystemExit(f"missing {audio} — run the stem benchmark's prepare.py {args.song} first")

    aligner = WhisperXAligner(device=args.device)
    started = time.time()
    emissions = aligner.emissions(audio, args.language)
    emit_sec = time.time() - started

    line_texts = [str(t["text"]) for t in truth]
    started = time.time()
    doc = generate(line_texts, emissions, decoder=forced_align_decoder, language=args.language)
    decode_sec = time.time() - started

    print(f"song={args.song} audio={os.path.basename(audio)} device={args.device}  [GLOBAL DECODE]")
    print(
        f"  emissions {emit_sec:5.1f}s (once per song)   decode {decode_sec * 1000:6.0f} ms (per candidate)"
    )

    def report(label: str, lines) -> None:
        # MATCHED BY THE LINE'S OWN INDEX, never by position: a decorative caption ('♪') has no alignable
        # chars and is dropped by generate(), and index-matching after a drop scored every later line
        # against the wrong truth row — read as bias +5140 ms on tfr-chosen and entirely this harness.
        aligned = [{"start": line.start} for line in lines]
        matched_truth = [truth[line.index] for line in lines]
        stats = score(aligned, matched_truth)
        if not stats.get("lines"):
            print(f"  {label}: no timed output")
            return
        tols = "  ".join(
            f"±{int(t * 1000)}ms {stats[f'within_{int(t * 1000)}']:5.1f}%" for t in TOLERANCES_SEC
        )
        ctols = "  ".join(
            f"±{int(t * 1000)}ms {stats[f'cwithin_{int(t * 1000)}']:5.1f}%" for t in TOLERANCES_SEC
        )
        print(
            f"  {label}: lines {int(stats['lines'])}/{len(truth)}  bias {stats['bias_ms']:+5.0f}ms  "
            f"MAD {stats['mad_ms']:4.0f}ms  >2s {int(stats['gross'])}"
        )
        print(f"    raw            {tols}")
        print(f"    bias-corrected {ctols}")
        if args.dump:
            errs = stats["errs"]
            worst = sorted(zip(lines, errs), key=lambda p: -abs(p[1]))
            for line, err in worst[:15]:
                print(f"      {err:+7.2f}s  [{line.index:3d}] {line.text[:60]!r}")

    report("global", doc.lines)

    if args.repair:
        from encore_worker.domain.lyrics.generate import regenerate
        from encore_worker.steps.align_geometry import _anchored_runs, _with_lines

        duration = emissions.frames * emissions.frame_sec
        normalized = [" ".join(t.lower().split()) for t in line_texts]
        blind = {
            line.index
            for line in doc.lines
            if normalized[line.index] and normalized.count(normalized[line.index]) > 1
        }
        started = time.time()
        runs = _anchored_runs(doc.lines, blind, duration)
        repaired = regenerate(runs, emissions, decoder=forced_align_decoder, language=args.language)
        repair_sec = time.time() - started
        print(
            f"  R3: {len(blind)} repeated lines in {len(runs)} runs; {len(repaired)} re-decoded "
            f"({repair_sec * 1000:.0f} ms)"
        )
        report("global+R3", _with_lines(doc, repaired).lines)

    if args.words:
        word_truth = json.load(open(args.words, encoding="utf-8"))
        counts = [len(str(t["text"]).split()) for t in truth]
        if sum(counts) != len(word_truth["words"]):
            print(
                f"  words: SKIPPED — line texts carry {sum(counts)} tokens, "
                f"truth has {len(word_truth['words'])}"
            )
        else:
            by_index = {line.index: line for line in doc.lines}
            cursor, aligned_pairs, interpolated = 0, [], 0
            for i, t in enumerate(truth):
                line = by_index.get(i)
                if line is not None and len(line.words) == counts[i]:
                    for k, w in enumerate(line.words):
                        if w.provenance == "aligned":
                            aligned_pairs.append(w.start - float(word_truth["words"][cursor + k]["start"]))
                        else:
                            interpolated += 1
                cursor += counts[i]
            n = len(aligned_pairs)
            if n:
                aae = sum(abs(e) for e in aligned_pairs) / n
                med = statistics.median(abs(e) for e in aligned_pairs)
                bias = statistics.median(aligned_pairs)
                tols = "  ".join(
                    f"±{int(t * 1000)}ms {sum(1 for e in aligned_pairs if abs(e) <= t) / n * 100:5.1f}%"
                    for t in (0.1, 0.25, 0.3, 0.5)
                )
                print(
                    f"  words: {n}/{len(word_truth['words'])} aligned ({interpolated} interpolated)  "
                    f"AAE {aae * 1000:.0f}ms  median {med * 1000:.0f}ms  bias {bias * 1000:+.0f}ms"
                )
                print(f"    {tols}")

    if args.claims is not None:
        import tempfile

        with tempfile.TemporaryDirectory(prefix="bench-claims-") as media_dir:
            got = time_text_claims(
                aligner,
                audio=audio,
                vocals=args.vocals,
                truth=truth,
                offset=args.claims,
                language=args.language,
                media_dir=media_dir,
            )
        on = os.path.basename(args.vocals or audio)
        print(
            f"  time_text(claims offset {args.claims:+.2f}s, on {on}): {got['outcome']}"
            f" (doc confidence {got['confidence']}); verdict={got['verdict']};"
            f" {got['high']}/{len(got['lines'])} lines high; repair faults: {got['faults'] or 'none'}"
        )
        print(f"    trail: {got['why']}")
        if got["lines"]:
            report("time_text+claims", got["lines"])

    if args.snap:
        import soundfile as sf

        from encore_worker.domain.audio import activity

        signal, rate = sf.read(audio, dtype="float32", always_2d=False)
        if getattr(signal, "ndim", 1) > 1:
            signal = signal.mean(axis=1)
        env = activity.envelope(signal, rate)
        hop = activity.HOP_SEC
        reach = int(0.35 / hop)

        class _Snapped:
            def __init__(self, line, start):
                self.index, self.text, self.start = line.index, line.text, start

        snapped = []
        for line in doc.lines:
            center = int(line.start / hop)
            lo, hi = max(1, center - reach), min(len(env) - 1, center + reach)
            if hi - lo < 3:
                snapped.append(_Snapped(line, line.start))
                continue
            rises = [float(env[i]) - float(env[i - 1]) for i in range(lo, hi)]
            best = max(range(len(rises)), key=lambda i: rises[i])
            snapped.append(_Snapped(line, (lo + best) * hop))
        report("global+snap", snapped)

    if args.evidence or args.rescue:
        import soundfile as sf

        from encore_worker.domain.audio import activity

        signal, rate = sf.read(audio, dtype="float32", always_2d=False)
        if getattr(signal, "ndim", 1) > 1:
            signal = signal.mean(axis=1)
        env = activity.envelope(signal, rate)
        hop = activity.HOP_SEC
        med = statistics.median(line.score for line in doc.lines)

        def overlap(start: float, end: float) -> float:
            a, b = int(start / hop), max(int(end / hop), int(start / hop) + 1)
            window = env[max(0, a) : min(b, len(env))]
            return float(sum(window) / len(window)) if len(window) else 0.0

        truth_by_index = {i: float(t["start"]) for i, t in enumerate(truth)}

    if args.evidence:
        print(f"  evidence (song median score {med:+.2f}):")
        print(f"    {'idx':>4s} {'score':>7s} {'d-med':>6s} {'env':>5s} {'err':>7s}  text")
        for line in doc.lines:
            err = line.start - truth_by_index[line.index]
            print(
                f"    {line.index:4d} {line.score:+7.2f} {line.score - med:+6.2f} "
                f"{overlap(line.start, line.end):5.2f} {err:+7.2f}  {line.text[:48]!r}"
            )

    if args.rescue:
        # The SHIPPED never-sung rule (steps/align_unsung.py): score far below the song's norm AND span on
        # silence AND chars/sec far below singing tempo — all three, then RE-DECODE without the dropped
        # text, because a never-sung line forced through the emissions steals its neighbours' frames.
        active_texts = list(line_texts)
        fixed = doc
        all_dropped: list[int] = []
        for _round in range(2):
            round_med = statistics.median(line.score for line in fixed.lines)
            never = [
                line
                for line in fixed.lines
                if line.score < round_med - 2.0
                and overlap(line.start, line.end) < 0.10
                and len(line.text) / max(line.end - line.start, 1e-6) < 2.0
            ]
            if not never:
                break
            for line in never:
                active_texts[line.index] = ""
                all_dropped.append(line.index)
            fixed = generate(active_texts, emissions, decoder=forced_align_decoder, language=args.language)
        print(f"  never-sung dropped: {all_dropped or 'none'}")
        report("global+drop+redecode", fixed.lines)

    syl = sum(len(w.syllables) for line in doc.lines for w in line.words)
    print(f"  syllable spans emitted: {syl}")


if __name__ == "__main__":
    main()
