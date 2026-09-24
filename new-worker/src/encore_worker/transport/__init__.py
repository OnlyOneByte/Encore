"""The conversation with the core: dial home, announce capabilities, forward progress.

Also owns the two things that are about OWNERSHIP rather than work:

  * the progress keepalive, so the core's lease does not expire on a quiet long-running step
  * reconciliation after recovery. A workflow DBOS resumed may no longer own its job, because the
    core's reaper requeued it on LEASE_EXPIRED and another worker may already be running it. The
    core's `workerId` is the authority; an orphaned workflow is cancelled BEFORE it can publish.
    See README.md, "Durability and ownership".
"""
