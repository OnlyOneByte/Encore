"""@DBOS.workflow definitions: the state machine, expressed as ordinary control flow.

MUST BE DETERMINISTIC. No wall clock, no random, no I/O, no direct filesystem access - DBOS replays a
workflow body on recovery, so anything non-deterministic makes a resumed job diverge from the one that
started. Every side effect belongs in a step.

The payoff over worker/'s LinearPlan: candidate fallback and retry-with-different-parameters are a
`for` loop, and every `await` is a durable checkpoint.
"""
