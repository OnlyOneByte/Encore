"""What THIS box can do: hardware and backend detection, config, model cache dirs, ffmpeg.

A Mac announcing `mlx` must not run torch demucs while reporting `torch`, so the resolved backend is
threaded from here into the engine that actually runs, and recorded on the completion facts.
"""
