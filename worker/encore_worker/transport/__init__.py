"""The conversation with the core: dial home, announce capabilities, forward progress.

Also owns the two things that are about OWNERSHIP rather than work:

  * the progress keepalive, so the core's lease does not expire on a quiet long-running step
  * reconciliation after recovery. A workflow DBOS resumed may no longer own its job, because the
    core's reaper requeued it on LEASE_EXPIRED and another worker may already be running it. The
    core's `workerId` is the authority.

DECIDED: publication is guarded at TWO points, and both are load-bearing. The transport re-claims every
recovered workflow on reconnect, AND `publish` re-asserts ownership as its first act — a lease can
expire DURING a long alignment, so a workflow that was legitimately ours at reconnect can be reassigned
before it reaches publication. Checking only at reconnect leaves exactly the window where two workers
publish different lyrics for one song. See README.md, "Durability and ownership".
"""
