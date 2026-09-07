"""The shared ffmpeg command shape.

Three builders — `decode_argv` (separation/demucs.py), `encode_flac_argv` (separation/demucs.py) and
`volumedetect_argv` (processor.py) — hand-repeated the same `[bin, -hide_banner, ...]` preamble, and the
steps that run them each hand-rolled the same drain loop. `ffmpeg_argv` folds the preamble into one place;
`run_quiet` / `run_capture` in runtime/runner.py fold the drain loops. Pure argv assembly, stdlib only, so
it sits at the root beside `retry_policy` rather than inside a domain.

ONE deliberate asymmetry: the two WRITING calls (decode, encode) run quiet — `-loglevel error -y` — while
`volumedetect` must NOT be quiet. volumedetect prints its `max_volume:` summary to stderr at ffmpeg's
INFO level, which `-loglevel error` would suppress, so `parse_max_volume_db` would read nothing and every
stem would measure UNMEASURABLE (treated as not-silent). `quiet=False` selects the `-nostats` preamble it
needs — the flag split that the collapse has to preserve, not erase.
"""

from __future__ import annotations

from collections.abc import Sequence


def ffmpeg_argv(
    ffmpeg_bin: str,
    input_path: str,
    middle: Sequence[str],
    output: Sequence[str],
    *,
    quiet: bool = True,
    overwrite: bool = True,
) -> list[str]:
    """Assemble an ffmpeg argv: preamble, one input, filter/codec `middle`, then `output` tokens.

    * ``quiet=True``  -> ``-loglevel error`` (a writing call: suppress everything but real errors).
      ``quiet=False`` -> ``-nostats`` and NO ``-loglevel error`` (a measuring call whose summary must
      survive on stderr — see the module docstring).
    * ``overwrite=True`` adds ``-y`` (a writing call clobbers its scratch output); the measuring call,
      which writes nothing, passes ``overwrite=False``.
    """
    preamble = [ffmpeg_bin, "-hide_banner"]
    preamble += ["-loglevel", "error"] if quiet else ["-nostats"]
    if overwrite:
        preamble.append("-y")
    return [*preamble, "-i", input_path, *middle, *output]
