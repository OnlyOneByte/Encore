"""Encore worker - durable audio/lyrics processing as DBOS workflows.

Layers, and dependencies point DOWN ONLY:

    transport/  websocket to the core; knows protocol/, knows nothing about audio
    workflows/  @DBOS.workflow - orchestration only, deterministic, no I/O
    steps/      @DBOS.step - thin I/O shells; serialized in, serialized out
    domain/     pure functions over data; imports no dbos, no asyncio, no torch
    adapters/   the heavy seams behind Protocols; the ONLY home for torch imports
    host/       hardware and backend detection, config, model cache directories
    protocol/   the wire frames; zero dependencies, imported by transport/ and workflows/

See README.md for the state machine and why this replaces worker/'s linear plan.
"""
