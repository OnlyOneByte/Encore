"""The wire contract with the core. ZERO dependencies; nothing here imports a sibling layer.

Frames are frozen dataclasses mirroring the TypeScript contract. This layer is deliberately inert: it
describes the conversation and performs none of it, so a protocol change is reviewable as a diff of
shapes rather than read out of transport code.
"""
