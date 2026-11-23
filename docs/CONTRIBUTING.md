# Contributing

Work is tracked in [GitHub issues](https://github.com/OnlyOneByte/Encore/issues). Every proposal, follow-up and
bug gets an issue first, and every pull request names the issue it closes with `Closes #N` in its description.
The issue templates and the pull request template in [`.github/`](../.github/) carry the fields a reviewer
reads.

## Where things are written down

Docs are where design, behaviour, protocols and rationale live, because a doc is one place to update and
review. Code comments are not documentation.

| Area                                                 | Doc                                                                                                              |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| How the whole system works                           | [`ARCHITECTURE.md`](ARCHITECTURE.md)                                                                             |
| Subsystem contracts: media, HTTP API, jobs           | [`arch/01-media.md`](arch/01-media.md), [`arch/02-api.md`](arch/02-api.md), [`arch/03-jobs.md`](arch/03-jobs.md) |
| Server, job pipeline and the shared contract's rules | [`SERVER.md`](SERVER.md)                                                                                         |
| The worker: separation, publishing, transport        | [`arch/05-worker.md`](arch/05-worker.md), [`../worker/README.md`](../worker/README.md)                           |
| Lyrics timing                                        | [`arch/04-alignment.md`](arch/04-alignment.md)                                                                   |
| Phone and TV UI rules                                | [`FRONTEND.md`](FRONTEND.md), [`UI-DESIGN.md`](UI-DESIGN.md), [`UI-TENETS.md`](UI-TENETS.md)                     |
| Where a file goes                                    | [`LAYOUT.md`](LAYOUT.md)                                                                                         |
| Tests and the Chromium suite                         | [`TESTS.md`](TESTS.md), [`E2E.md`](E2E.md)                                                                       |
| Running and deploying                                | [`../README.md`](../README.md), [`deploy/README.md`](deploy/README.md), [`deploy/WSL2.md`](deploy/WSL2.md)       |

## Comments

- A comment explains a non-obvious _why_ in one or two lines. If it needs more, the explanation belongs in the
  doc for that area, and the comment can name the doc's section.
- No history or changelog in comments: no "was X before", PR numbers, review rounds or dates. Git keeps that.
- Name the thing a comment refers to (a function, a selector, a token), never a line number in another file.

## Every pull request

- Says `Closes #N` for its issue.
- Updates the docs it makes stale, or says why none are.
- Adds no new long comment blocks.
- Passes the gates in the [README](../README.md#testing-and-ci) with no new failures against `main`. A UI change also
  carries phone and TV frames and the [UI checklist](UI-CHECKLIST.md).

Reviewers check the docs and comment lines on every pull request, and the docs get a sweep once a week for
anything that has drifted from the code.
