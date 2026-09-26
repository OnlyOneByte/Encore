"""Artifact publication: the keys core will look under, and how bytes get there.

`keys` is pure and mirrors core's `paths.ts`. `ports` is the store seam. `local` is the shared-filesystem
implementation; an `object` one goes beside it when a worker stops sharing a disk with core.
"""
