"""One canonical fake CLI runner for the worker suite.

The ``ffmpeg ... volumedetect`` branch is a MEASURING call (ends in ``-f null -``, writes no file) and
is the only thing that makes ``ProbeSilence`` real: treating it like an encode would write to
``dirname("-") == ""``, raise, and get silently swallowed by ``ProbeSilence``'s try/except, so the
probe is never actually exercised. Kept as a single source of truth so every consumer sees the same
branch, rather than each test file carrying its own drifting copy.

The separation binary itself (``demucs`` vs ``bs-roformer-infer``) differs per engine, so each site
passes its own ``handlers`` while sharing the acquisition/volumedetect/encode branches that do not.
"""

import os
from collections.abc import AsyncIterator, Callable
from pathlib import Path

# A handler runs the per-binary side effects (writing the files that CLI would produce) and MAY yield
# canned stdout lines. It receives the argv so it can read -o/--store_dir targets.
Handler = Callable[[list[str]], AsyncIterator[str]]


def fake_cli_runner(
    *,
    scripted: dict[str, list[str]] | None = None,
    fail_on: str | None = None,
    exit_text: str = "",
    handlers: dict[str, Handler] | None = None,
    record: list[list[str]] | None = None,
):
    """Build an async runner that fakes the CLI seam of a real process.

    Shared branches (single source of truth):

    * ``yt-dlp`` -- writes the native-audio file the ``-o %(ext)s`` template names.
    * ``ffmpeg ... volumedetect`` -- a measuring call: emits a ``max_volume:`` line and writes NOTHING.
      This is the branch whose triplication cost the silence probe its coverage; it lives here now.
    * ``ffmpeg`` (any other) -- an encode: writes the file named by the last argv element.

    Per-engine branches come from ``handlers``: a mapping of ``argv[0]`` -> an async generator that does
    the writes that binary would and optionally yields stdout lines. A handler is consulted only for a
    binary not handled by the shared branches above (i.e. the separation binary).

    ``scripted`` appends extra canned stdout lines keyed by binary (after any handler output).
    ``fail_on``/``exit_text`` raise a ProcessError for one binary after its output.
    ``record``, if given, receives a copy of every argv (for tests that assert the CLI seam).
    """
    scripted = scripted or {}
    handlers = handlers or {}

    # Imported lazily so the module has no import-time dependency on src (conftest arms the env first).
    from src.separation import demucs

    async def run(argv):
        if record is not None:
            record.append(list(argv))
        binary = argv[0]
        if binary == "yt-dlp":
            # the -o target is a %(ext)s template (no wav transcode), so pick a concrete extension
            out = argv[argv.index("-o") + 1].replace("%(ext)s", "webm")
            os.makedirs(os.path.dirname(out), exist_ok=True)
            Path(out).write_bytes(b"FAKE_NATIVE_AUDIO")
        elif binary == "ffmpeg" and "volumedetect" in argv:
            # A measuring call, not a writing one: ends in `-f null -`, so there is NO output file.
            # Reports NOT-silent (a healthy -1.2 dB reading).
            yield "[Parsed_volumedetect_0 @ 0x1] max_volume: -1.2 dB"
            return
        elif binary == "ffmpeg":
            out = argv[-1]
            os.makedirs(os.path.dirname(out), exist_ok=True)
            Path(out).write_bytes(b"FAKE_ENCODED")
        elif binary in handlers:
            async for line in handlers[binary](argv):
                yield line
        for line in scripted.get(binary, []):
            yield line
        if fail_on == binary:
            raise demucs.ProcessError(argv, 1, exit_text)

    return run
