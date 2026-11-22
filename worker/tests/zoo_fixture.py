"""The zoo catalogue for tests, with "it could not be read here" told apart from "it is wrong".

`zoo.catalogue()` returns `()` for two unrelated reasons, and the catalogue tests could not tell them apart:
the `audiosep` extra is absent, or `audio-separator`'s model listing could not be read — it is FETCHED over
the network and cached under `/tmp`, which macOS wipes and which `conftest.py` blocks the socket for. Four
tests failed on that second case as if the filter had broken and three more passed over an empty tuple.
`catalogue_or_skip` skips it, naming the command that warms the cache, and keeps a catalogue that WAS read
and is wrong failing. docs/arch/05-worker.md §2.3.
"""

from __future__ import annotations

import functools
import importlib.util

import pytest

from encore_worker.adapters import zoo

ZOO_INSTALLED = importlib.util.find_spec("audio_separator") is not None

needs_zoo = pytest.mark.skipif(not ZOO_INSTALLED, reason="the `audiosep` extra is not installed here")

#: Reads the listing once into the directory `audio-separator` looks in, which is all the catalogue needs.
WARM_THE_CACHE = ".venv/bin/python -c 'from encore_worker.adapters import zoo; zoo.catalogue()'"


@functools.cache
def upstream_listing_is_readable() -> bool:
    """Can `audio-separator`'s own model listing be read on this box at all?

    Asked separately because `catalogue()` answers with `()` whether the listing was unreachable or our
    filter rejected every entry in it, and only the first of those is an environment fact. CACHED for
    `zoo.catalogue`'s own reason — it builds a `Separator`, which probes torch, ONNX and the accelerator —
    and a per-process environment fact is what it answers.
    """
    try:
        from audio_separator.separator import Separator  # noqa: PLC0415 - an extra, absent by default

        return bool(Separator(log_level=50).list_supported_model_files())
    except Exception:  # noqa: BLE001 - any failure to read it means it cannot be read here
        return False


def catalogue_or_skip() -> tuple[zoo.ZooModel, ...]:
    """Every model the zoo offers, or a skip when upstream's listing cannot be read on this box.

    An empty catalogue built from a listing that WAS read is returned rather than skipped: that is the
    filter having rejected every entry, which is the defect the callers exist to catch.
    """
    models = zoo.catalogue()
    if models or upstream_listing_is_readable():
        return models
    pytest.skip(
        "audio-separator's model listing cannot be read here: it is fetched over the network and cached "
        f"under /tmp, and this suite blocks the socket (conftest.py). Warm it once with: {WARM_THE_CACHE}"
    )
