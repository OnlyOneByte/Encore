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

STILL BYPASSED, recorded rather than fixed here: `resolve_source_audio` is meant to be the single answer,
and only `FetchProcessor` calls it. `separation/demucs`, `separation/roformer` and `../whisperx` each
import `job_fetcher` + `local_source_path` and re-derive the branch — three copies. See
`docs/specs/SPEC-worker-pipeline.md` §1.2 and E6; S3 consolidates them.
"""
from __future__ import annotations

from .fetch import job_fetcher, local_source_path, resolve_source_audio

__all__ = ["job_fetcher", "local_source_path", "resolve_source_audio"]
