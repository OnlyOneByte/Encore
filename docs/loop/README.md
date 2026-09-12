# The Encore autonomous loop

Encore is maintained partly by a fleet of agents. They read the codebase and file issues, triage them,
fix them, review the pull requests, and drive them to a merge.

**This directory is the steering those agents read.** It is not documentation *about* the loop — it is
the loop's operating instructions, and editing a file here changes what the agents do.

## Why it lives here

The briefs used to live in `.kiro/autoloop/`, which is gitignored. That had two costs. The design of
the thing writing most of the commits was never reviewable — no diffs, no comments, no bisect — and the
briefs drifted against each other and against the live configuration with nothing to catch it. Several
rules in this directory exist because two copies disagreed and the wrong one was followed.

## One brief per reader

The split is **by reader, not by topic**, and that is load-bearing. Each file is loaded into one kind
of agent's context, so a rule in the wrong file is a rule some agent will act on when it must not.

| File | Read by |
|---|---|
| [`COMMON.md`](COMMON.md) | **every lane** — the shared rules the others point at |
| [`TRIAGE-ORCHESTRATOR.md`](TRIAGE-ORCHESTRATOR.md) | the triage orchestrator — one supervisor session |
| [`TRIAGE.md`](TRIAGE.md) | each triage worker — up to 5 sessions, one issue each |
| [`CONDUCTOR.md`](CONDUCTOR.md) | the dev conductor — one supervisor session |
| [`CODING-BOT.md`](CODING-BOT.md) | each coding worker — up to 5 sessions, seeded verbatim |
| [`REVIEW-ORCHESTRATOR.md`](REVIEW-ORCHESTRATOR.md) | the review orchestrator — one supervisor session |
| [`PR-BOT.md`](PR-BOT.md) | each PR reviewer — up to 5 sessions, seeded verbatim |
| [`REVIEW-PASSES.md`](REVIEW-PASSES.md) | the 5 scheduled `ISSUEGEN-*` passes that file issues |

**An orchestrator's brief is separate from its worker's, and that separation is load-bearing.** A worker
is seeded with its brief *verbatim*, so a dispatch rule folded into the worker's file hands every worker
the authority to dispatch. Each supervisor file sits directly above the worker file it dispatches.

Two files are easy to confuse: `PR-BOT.md` reviews **one open pull request** and posts a verdict.
`REVIEW-PASSES.md` reads **one slice of the codebase** and files new issues. It never touches a PR.

Reference, not read by a lane:

| File | Contents |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | how the lanes connect, and how work reaches each one |
| [`LABELS.md`](LABELS.md) | the label taxonomy — the loop's coordination state |
| [`pipeline.json`](pipeline.json) | the governance spec — caps, gates, work source |

## Two rules about editing these files

**An edit is not a deployment.** A long-lived worker or reviewer session reads its brief **once, at
creation**, and works from that copy forever. Measured 2026-09-06: an edit to the reviewer brief left
four live slots emitting the old verdict template across seven consecutive verdicts. So
either order a re-read at the start of the next work item, or retire the slot. A cron lane is
different — each run is a fresh session, so a cron brief edit takes effect on the next fire.

**Runtime state is not steering and does not belong here.** The append-only run logs and the live fleet
state live outside the repo, under
`/local/home/angryang/workspace/encore-loop-state/`. Nothing in this directory should point into
`.kiro/`; the one remaining exception is the `prove_per_hunk.py` proof harness, flagged for a
follow-up.
