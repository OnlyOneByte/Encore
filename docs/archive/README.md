# Encore documentation archive

Nothing in this directory is an instruction to the auto-pilot. The three live documents are:

- [`../ROADMAP.md`](../ROADMAP.md) — what to build next.
- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — how the system works.
- [`../HANDOFF.md`](../HANDOFF.md) — how to operate it safely.

## Historical plans

- [`milestones-m0-m8.md`](milestones-m0-m8.md) — closed milestone-by-milestone build record.
- [`backlog-shipped.md`](backlog-shipped.md) — shipped backlog detail and rationale.
- [`AUDIT-worker-autodetect.md`](AUDIT-worker-autodetect.md) — the worker hardware/capability
  autodetect audit, whose findings have since landed.

## Shipped feature specs

[`specs/`](specs/) holds the working spec for each feature that has since shipped and merged. They
record the design decisions and the rejected alternatives behind a feature, which the canonical docs
deliberately do not carry — `ARCHITECTURE.md` says how the system works now, not which three options
were weighed to get there.

A spec lands here when its feature merges. The root `docs/` directory holds exactly three files —
`ARCHITECTURE.md`, `ROADMAP.md`, `HANDOFF.md` — and everything else lives in a subdirectory, so an
in-flight spec belongs in `docs/specs/` and moves here on merge.

## Superseded source specs

[`reference/`](reference/) contains the seven standalone design documents that were consolidated
into `ARCHITECTURE.md`: original master design, reconciliation contract, job lifecycle, TV preload,
performance, media storage, and the deferred vocal-guide proposal.

They are preserved for design archaeology and may contain dated paths, milestone language, open
decisions that were later settled, or implementation details superseded by the canonical docs.
When they disagree with a live document or the code, the live document/code wins.
