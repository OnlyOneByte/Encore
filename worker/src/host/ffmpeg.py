"""The shared ffmpeg command shape.

Folds the `[bin, -hide_banner, ...]` preamble used by every argv builder (decode, encode, guide mix,
volumedetect) into one place. Pure argv assembly, stdlib only, so it sits at the root beside
`retry_policy` rather than inside a domain.

ONE deliberate asymmetry: the WRITING calls run quiet (`-loglevel error -y`), but `volumedetect` must
NOT be: it prints its `max_volume:` summary to stderr at ffmpeg's INFO level, which `-loglevel error`
would suppress, making `parse_max_volume_db` read nothing and every stem measure UNMEASURABLE
(treated as not-silent). `quiet=False` selects the `-nostats` preamble instead.
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
        # An empty sequence would assemble an argv with NO `-i` at all — ffmpeg would then die on an
        # unrelated stderr line about the filter/output, naming nothing about the real cause.
        raise ValueError("ffmpeg_argv: at least one input is required")
    argv = list(preamble)
    for path in inputs:
        argv += ["-i", path]
    return [*argv, *middle, *output]
