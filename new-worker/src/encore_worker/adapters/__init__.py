"""The heavy seams, each behind a Protocol declared in `ports.py`.

THE ONLY LAYER THAT MAY IMPORT torch, whisperx, demucs or pyannote, and every such import is lazy -
resolved when an adapter is first built, never at module import, so `uv sync --only-group dev` yields a
tree the whole suite can import.

Model handles are cached at module level, keyed by (device, model). A fresh instance per job would
re-read multi-GB weights every job; that cache is why this worker is a resident process rather than a
subprocess per step.
"""
