# In-flight specs

Working specs for features currently being built. One file per feature,
`SPEC-<feature>.md`.

- `docs/` root holds exactly three files — `ARCHITECTURE.md`, `ROADMAP.md`,
  `HANDOFF.md`. Everything else lives in a subfolder, so a spec lives here while
  the work is open.
- On merge, move the spec to [`../archive/specs/`](../archive/specs/). A spec
  still sitting here means the feature has not landed.
- A spec is a decision record, not a design essay: what was chosen, what was
  rejected, and why. Its last task is always to fold the shipped outcome into
  `ARCHITECTURE.md` / `ROADMAP.md` / `HANDOFF.md` — subtracting delivered work
  from the roadmap rather than appending a changelog.

Empty is the correct state when nothing is in flight.
