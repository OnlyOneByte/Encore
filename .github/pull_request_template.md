Closes #

## What changed and why

## Self-review

Areas this PR touches (server and routes, phone UI, TV, worker, security, tests, process):

- [ ] Self-review: [docs/PR-CHECKLIST.md](https://github.com/OnlyOneByte/Encore/blob/main/docs/PR-CHECKLIST.md) done for those areas

## Gates

On the head commit, with no new failures against `main` (see the README's
[Testing and CI](https://github.com/OnlyOneByte/Encore/blob/main/README.md#testing-and-ci)):

- [ ] `bun run test`
- [ ] `bun run typecheck`, `bun run lint`, `bun run format:check`
- [ ] `bun run build`, `bun run gate:measured`
- [ ] Probes that touch the changed code
- [ ] Worker: `uv run pytest -q -m "not ml"`, `uv run ruff check .`, `uv run ruff format --check .`, `uv run mypy`
      (if `worker/` changed)
- [ ] UI: phone 390 and 320 and TV frames, `bun run ui:review` GIFs for motion, and the
      [UI checklist](https://github.com/OnlyOneByte/Encore/blob/main/docs/UI-CHECKLIST.md) lines it touches (if the
      UI changed)

## Docs and comments

- [ ] Docs updated, or not needed because:
- [ ] No new long comments (a comment is a one- or two-line _why_; see
      [CONTRIBUTING](https://github.com/OnlyOneByte/Encore/blob/main/docs/CONTRIBUTING.md))
