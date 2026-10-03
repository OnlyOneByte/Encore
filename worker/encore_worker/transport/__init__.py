"""The conversation with the core: dial home, announce capabilities, forward progress.

Also the progress keepalive and the reconciliation of OWNERSHIP after recovery, the core's `workerId` being
the authority. Why publication is guarded at two points rather than one: docs/arch/05-worker.md §7 and §7.1.
"""
