"""Encore worker - durable audio/lyrics processing as DBOS workflows.

Seven layers, dependencies pointing DOWN only: `transport/`, `workflows/`, `steps/`, `domain/`, `adapters/`,
`host/`, `protocol/`. What each may import, and the guard test that holds them to it:
docs/arch/05-worker.md §1 (XW-01), with the state machine in README.md.
"""
