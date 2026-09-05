"""Acquisition: where a job's bytes are, and whether we have to go and get them.

  * `fetch` — the fetcher vocabulary parsed at the boundary, `resolve_source_audio`, and
    `FetchProcessor`, which makes acquisition a JOB rather than a stage.
  * `stream_quality` — which of YouTube's audio streams to ask for, ranked by codec generation rather
    than by nominal bitrate.

WHY ACQUISITION IS ITS OWN ACTION, not a stage inside separation. A box that can download and a box that
can separate need not be the same machine: a fetch routes on `fetch:<fetcher>` while a cook routes on
`stems`, so neither capability implies the other. It is also why the retained original is a first-class
artifact — it is the one storage class that cannot be regenerated, because re-acquiring it needs the
network and the upload may be gone.

The core DECLARES the fetcher in job params rather than leaving it to be inferred from the URI's shape.
That mattered: both separation and alignment used to recover the intent by testing for an `http(s)`
prefix, so any other scheme was silently classified as a local path and died several stages later inside
ffmpeg with "No such file" — reporting the symptom and hiding the cause.

ONE PATH, enforced. `resolve_source_audio` used to be documented here as "the one place" that answers
where a job's bytes are — while three of its four callers re-derived the answer, and got it wrong
(downloading to a literal `.wav` when yt-dlp needs a `%(ext)s` template). That function is gone: the
`AcquireAudio` step is now the single answer, and this module keeps only the primitives it uses.
`tests/test_worker_layers.py` E6 fails if anything else starts deciding for itself.
"""
from __future__ import annotations

from .fetch import find_downloaded, job_fetcher, local_source_path

__all__ = ["find_downloaded", "job_fetcher", "local_source_path"]
