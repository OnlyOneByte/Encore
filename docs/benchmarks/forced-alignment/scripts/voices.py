#!/usr/bin/env python
"""Who sings which line: a labelled multi-voice bench, and the voice models scored on it (#1166).

    cd worker && uv run python ../docs/benchmarks/forced-alignment/scripts/voices.py --out <results.json>

THE SET IS BUILT, NOT COLLECTED: whole sung lines spliced from the repo's three TheFatRat vocal stems (three
singers), so every line's voice is known without listening. Each model gets the truth line spans, so this
scores the voice call alone; every `--sweep` distance is scored from one set of embeddings. How the set is
made, what it cannot show, and the numbers: LOG.md, "Voices: who sings which line".
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from collections import Counter
from collections.abc import Sequence
from itertools import permutations

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SONGS_DIR = os.path.normpath(os.path.join(HERE, "..", "..", "benchmark-songs"))
RATE = 16000
GAP_SEC = 0.4

#: Each singer's dry vocal stem. Three different singers, one per song.
SINGERS = {
    "C": ("tfr-chosen", "01 Chosen Vox.wav"),
    "F": ("tfr-flyaway", "Fly Away - Stems 05 Vocals Dry.wav"),
    "M": ("tfr-mayday", "MAYDAY - ACCAPELLA REFERENCE.wav"),
}

#: How each multi-voice item takes turns: one voice per line, cycling.
PATTERNS = {
    "alternate": lambda voices: [voices[i % len(voices)] for i in range(24)],
    "verses": lambda voices: [voices[(i // 4) % len(voices)] for i in range(24)],
    "lead-and-answer": lambda voices: [
        voices[0] if i % 3 != 2 else voices[1 + (i // 3) % (len(voices) - 1)] for i in range(24)
    ],
}

#: Solo variants: (name, filter for every other line or None, filter for every line or None).
SOLO_VARIANTS = ("straight", "later-lines", "two-registers", "echo-double")


def bench_root() -> str:
    return os.environ.get("ENCORE_BENCH_ROOT", os.path.expanduser("~/encore-bench"))


def decode(path: str, filters: str | None = None) -> np.ndarray:
    """The file as mono float32 at 16 kHz, through ffmpeg, with an optional filter graph."""
    cmd = ["ffmpeg", "-nostdin", "-v", "error", "-i", path]
    if filters:
        cmd += ["-af", filters]
    cmd += ["-ac", "1", "-ar", str(RATE), "-f", "f32le", "-"]
    return np.frombuffer(subprocess.run(cmd, check=True, capture_output=True).stdout, dtype=np.float32)


def sung_lines(song: str) -> list[tuple[float, float]]:
    with open(os.path.join(SONGS_DIR, song, "truth-lines.json"), encoding="utf-8") as handle:
        lines = json.load(handle)["lines"]
    return [(float(x["start"]), float(x["end"])) for x in lines if str(x.get("text", "")).strip("♪ ")]


def assemble(clips: Sequence[tuple[np.ndarray, str]]) -> tuple[np.ndarray, list[dict[str, object]]]:
    """Clips laid end to end with a short gap; the truth line spans and voices of the result."""
    out: list[np.ndarray] = []
    truth: list[dict[str, object]] = []
    at = 0.0
    gap = np.zeros(int(GAP_SEC * RATE), dtype=np.float32)
    for clip, voice in clips:
        truth.append({"start": round(at, 3), "end": round(at + clip.size / RATE, 3), "voice": voice})
        out += [clip, gap]
        at += clip.size / RATE + GAP_SEC
    return np.concatenate(out), truth


def cut(signal: np.ndarray, span: tuple[float, float]) -> np.ndarray:
    return signal[int(span[0] * RATE) : int(span[1] * RATE)]


def build_items() -> list[dict[str, object]]:
    """The labelled set: 12 solos and 12 multi-voice items, as signals with their truth."""
    stems: dict[str, dict[str, np.ndarray]] = {}
    lines: dict[str, list[tuple[float, float]]] = {}
    for voice, (song, name) in SINGERS.items():
        path = os.path.join(SONGS_DIR, song, name)
        stems[voice] = {
            "plain": decode(path),
            # Up 3 semitones at the same tempo, so the line spans still hold.
            "high": decode(path, f"asetrate={RATE}*1.1892,aresample={RATE},atempo=1/1.1892"),
            "echo": decode(path, "aecho=0.8:0.7:45:0.5"),
        }
        lines[voice] = sung_lines(song)
    items: list[dict[str, object]] = []
    for voice in SINGERS:
        sung = lines[voice]
        for variant in SOLO_VARIANTS:
            chosen = sung[-24:] if variant == "later-lines" else sung[:24]
            clips = []
            for i, span in enumerate(chosen):
                take = {"two-registers": "high", "echo-double": "echo"}.get(variant) if i % 2 else None
                clips.append((cut(stems[voice][take or "plain"], span), voice))
            signal, truth = assemble(clips)
            items.append({"id": f"solo-{voice}-{variant}", "kind": "solo", "signal": signal, "truth": truth})
    groups = [("C", "F"), ("F", "M"), ("M", "C"), ("C", "F", "M")]
    for group in groups:
        for name, pattern in PATTERNS.items():
            turn = Counter[str]()
            clips = []
            for voice in pattern(list(group)):
                span = lines[voice][turn[voice] % len(lines[voice])]
                clips.append((cut(stems[voice]["plain"], span), voice))
                turn[voice] += 1
            signal, truth = assemble(clips)
            items.append(
                {"id": f"multi-{''.join(group)}-{name}", "kind": "multi", "signal": signal, "truth": truth}
            )
    return items


def best_accuracy(truth: Sequence[str], parts: Sequence[str | None]) -> float:
    """Line accuracy under the best mapping of parts to voices; an unlabelled line counts as wrong."""
    voices = sorted(set(truth))
    labels = sorted({p for p in parts if p is not None})
    best = 0
    for mapping in permutations(voices, len(labels)) if len(labels) <= len(voices) else []:
        to = dict(zip(labels, mapping, strict=True))
        best = max(best, sum(1 for t, p in zip(truth, parts, strict=True) if p is not None and to[p] == t))
    return best / len(truth)


def score(
    items: list[dict[str, object]], embeddings: dict[str, list[object]], distance: float
) -> dict[str, object]:
    from encore_worker.domain.lyrics import attribute, voices

    rows = []
    for item in items:
        truth = item["truth"]
        assert isinstance(truth, list)
        spans = [(float(t["start"]), float(t["end"])) for t in truth]
        found = embeddings[str(item["id"])]
        judged = [e for e in found if e is not None]
        labels_judged = iter(voices.cluster(judged, distance=distance))  # type: ignore[arg-type]
        labels = [next(labels_judged) if e is not None else None for e in found]
        turns = voices.line_turns(spans, labels)
        doc = {"lines": [{"start": s, "end": e} for s, e in spans]}
        annotated = attribute.attribute(doc, turns)
        parts = [line.get("part") for line in annotated["lines"]]
        true_voices = [str(t["voice"]) for t in truth]
        rows.append(
            {
                "id": item["id"],
                "kind": item["kind"],
                "true_voices": len(set(true_voices)),
                "found_voices": attribute.speaker_count(turns),
                "coloured": annotated is not doc,
                "line_accuracy": (
                    round(best_accuracy(true_voices, parts), 3) if annotated is not doc else None
                ),
            }
        )
    solos = [r for r in rows if r["kind"] == "solo"]
    multis = [r for r in rows if r["kind"] == "multi"]
    coloured = [r for r in multis if r["coloured"]]
    return {
        "distance": distance,
        "false_multi_on_solos": f"{sum(1 for r in solos if r['coloured'])}/{len(solos)}",
        "multi_coloured": f"{len(coloured)}/{len(multis)}",
        "voice_count_right_on_multi": (
            f"{sum(r['found_voices'] == r['true_voices'] for r in multis)}/{len(multis)}"
        ),
        "min_line_accuracy_coloured": min((float(r["line_accuracy"]) for r in coloured), default=None),
        "rows": rows,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--out", required=True)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--sweep", default="0.3,0.35,0.4,0.45,0.5,0.55,0.6,0.65,0.7")
    args = parser.parse_args()

    from encore_worker.adapters import ml

    items = build_items()
    root = os.path.join(bench_root(), "voices")
    os.makedirs(root, exist_ok=True)
    embedder = ml.LineVoiceEmbedder(device=args.device)
    embeddings: dict[str, list[object]] = {}
    timing = []
    reused = 0
    for item in items:
        signal = item["signal"]
        assert isinstance(signal, np.ndarray)
        wav_path = os.path.join(root, f"{item['id']}.wav")
        subprocess.run(
            ["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "f32le", "-ar", str(RATE), "-ac", "1"]
            + ["-i", "-", wav_path],
            input=signal.tobytes(),
            check=True,
        )
        truth = item["truth"]
        assert isinstance(truth, list)
        with open(wav_path.replace(".wav", ".truth.json"), "w", encoding="utf-8") as handle:
            json.dump({"kind": item["kind"], "lines": truth}, handle)
        cached = wav_path.replace(".wav", f".{args.device}.npy")
        began = time.monotonic()
        if os.path.exists(cached):
            stored = np.load(cached)
            embeddings[str(item["id"])] = [None if np.isnan(row).all() else row for row in stored]
            reused += 1
        else:
            found = embedder.embed(wav_path, [(t["start"], t["end"]) for t in truth])
            embeddings[str(item["id"])] = found
            width = next((np.asarray(e).size for e in found if e is not None), 1)
            np.save(cached, np.stack([np.full(width, np.nan) if e is None else np.asarray(e) for e in found]))
        timing.append((time.monotonic() - began, signal.size / RATE))
        print(f"{item['id']}: {len(truth)} lines, {timing[-1][0]:.1f} s", flush=True)

    sweep = [score(items, embeddings, float(d)) for d in args.sweep.split(",")]
    spent = sum(t for t, _ in timing)
    audio = sum(a for _, a in timing)
    result = {
        "models": {
            "line-voices": {
                "checkpoint": ml.LINE_VOICE_CHECKPOINT,
                "licence": ml.VOICE_MODELS["line-voices"].licence,
                "device": args.device,
                # Embeddings reused from a cached run were not timed, so a reused run states no cost.
                "seconds_per_audio_second": None if reused else round(spent / audio, 4),
                "sweep": sweep,
            },
            "pyannote-3.1": {"skipped": ml.diarizer_blocked() or "not run in this lane"},
        },
        "items": len(items),
    }
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=1)
    for row in sweep:
        print(
            f"distance {row['distance']}: false multi on solos {row['false_multi_on_solos']}, "
            f"coloured {row['multi_coloured']}, voice count right {row['voice_count_right_on_multi']}, "
            f"min line accuracy {row['min_line_accuracy_coloured']}"
        )
    if not reused:
        print(f"line-voices: {spent:.1f} s for {audio:.0f} s of audio ({spent / audio:.3f}x)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
