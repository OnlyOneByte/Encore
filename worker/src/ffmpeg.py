"""The shared ffmpeg command shape.

Three builders — `decode_argv` (separation/demucs.py), `encode_flac_argv` (separation/demucs.py) and
`volumedetect_argv` (processor.py) — hand-repeated the same `[bin, -hide_banner, ...]` preamble, and the
steps that run them each hand-rolled the same drain loop. `ffmpeg_argv` folds the preamble into one place;
`run_quiet` / `run_capture` in runtime/runner.py fold the drain loops. Pure argv assembly, stdlib only, so
it sits at the root beside `retry_policy` rather than inside a domain.

ONE deliberate asymmetry: the WRITING calls (decode, encode, the guide mix) run quiet —
`-loglevel error -y` — while
`volumedetect` must NOT be quiet. volumedetect prints its `max_volume:` summary to stderr at ffmpeg's
INFO level, which `-loglevel error` would suppress, so `parse_max_volume_db` would read nothing and every
stem would measure UNMEASURABLE (treated as not-silent). `quiet=False` selects the `-nostats` preamble it
needs — the flag split that the collapse has to preserve, not erase.
"""

from __future__ import annotations

from collections.abc import Sequence


def ffmpeg_argv(
    ffmpeg_bin: str,
    input_path: str | Sequence[str],
    middle: Sequence[str],
    output: Sequence[str],
    *,
    quiet: bool = True,
    overwrite: bool = True,
) -> list[str]:
    """Assemble an ffmpeg argv: preamble, one or more inputs, filter/codec `middle`, then `output`.

    * ``quiet=True``  -> ``-loglevel error`` (a writing call: suppress everything but real errors).
      ``quiet=False`` -> ``-nostats`` and NO ``-loglevel error`` (a measuring call whose summary must
      survive on stderr — see the module docstring).
    * ``overwrite=True`` adds ``-y`` (a writing call clobbers its scratch output); the measuring call,
      which writes nothing, passes ``overwrite=False``.

    ``input_path`` accepts a SEQUENCE because the guide mix (`encode_guide_mix_argv`) reads the two
    stems as two inputs and joins them into one multichannel stream. Each is emitted as its own
    ``-i``, IN THE ORDER GIVEN — that order is the filter's ``[0:a]``/``[1:a]`` numbering, so it is a
    contract of this function and not an incidental detail. A bare ``str`` stays a single input, so
    every existing caller is byte-for-byte unchanged.
    """
    preamble = [ffmpeg_bin, "-hide_banner"]
    preamble += ["-loglevel", "error"] if quiet else ["-nostats"]
    if overwrite:
        preamble.append("-y")
    inputs = [input_path] if isinstance(input_path, str) else list(input_path)
    if not inputs:
        # An empty sequence would assemble an argv with NO `-i` at all — silently malformed, and ffmpeg
        # then dies with an error about the filter or the output that names nothing about the real cause.
        # The contract is "one or more inputs"; say so here rather than letting a caller discover it from
        # an unrelated stderr line.
        raise ValueError("ffmpeg_argv: at least one input is required")
    argv = list(preamble)
    for path in inputs:
        argv += ["-i", path]
    return [*argv, *middle, *output]
