"""Encore worker - durable audio/lyrics processing as DBOS workflows.

Eight layers, dependencies pointing DOWN only: `protocol/`, `transport/`, `host/`, `adapters/`, `steps/`,
`workflows/`, `domain/`, `artifacts/`. What each may import, and the guard test that holds them to it:
docs/arch/05-worker.md §1 (XA-15), with the state machine in README.md.
"""
