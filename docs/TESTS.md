# Tests

Two rungs, and the split is about what each can honestly decide.

| Rung         | Runner                  | Lives in            | Decides                                                                  |
| ------------ | ----------------------- | ------------------- | ------------------------------------------------------------------------ |
| **Logic**    | `bun test`              | `tests/unit/`       | pure functions, server modules, DB + migrations, contract shapes, stores |
| **Rendered** | Chromium via Playwright | `tests/playwright/` | anything painted or measured: geometry, clipping, `env()`, `dvh`, colour |

`bun run test` is the gate, not a bare `bun test`: `vaul-svelte` declares only a `svelte` export
condition, so bun's test resolver needs `--conditions=svelte`, which lives in the `test` script.

## What lives where

- `tests/unit/` — 162 files. Run with `bun run test` (~16s, no browser, no DOM by default).
- `tests/playwright/` — the Playwright suite: four projects (`gate`, `flow`, `probe`, `shot`) over one
  `world` fixture. See [`E2E.md`](E2E.md).
- `tests/helpers.ts` — the shared path anchors and source-text helpers, reached as `$test`.
- `tests/tsconfig.json` — the tests tree's resolution context. Gated by `bun run typecheck:tests`.

There is no DOM installed globally. A test that needs one builds its own — see
`tests/unit/lib/tv/wake-lock.test.ts`, which installs a happy-dom `Window` for the two globals the
module under test actually touches. This replaced a repo-wide `[test] preload` that installed
happy-dom, a Svelte compile hook and SvelteKit `$app/*` stubs for all 300+ files to serve the
handful that needed them.

## The one rule worth keeping

**A missing path throws. It is never a skip.**

`read()` and the anchors in `tests/helpers.ts` throw when their subject is absent, and deliberately
offer no `readIfExists`. A test that tolerates an absent subject asserts nothing: anything gating on
`existsSync` reads no file, finds no violations, and reports **green**. A wrong path is a path
failure, not a satisfied invariant, and it has to be loud.

The anchors also walk UP to a repo-root marker (`bunfig.toml`) rather than counting `../` down from
the caller. A path that encodes the _test's_ location inside a claim about the _source's_ is wrong
the moment either end moves.

## What was removed, and why

A 169-file, 27,500-line `tests/guards/` suite was deleted, along with the
`tests/setup/` mount harness and the `tests/support/` helper tree.

The guards were static text analysis: they read app source **as text** and asserted patterns over
it. That buys very little and costs a lot. A source scan proves a _line is present_, never that
behaviour is correct — and it convicts correct code whenever prose happens to mention a banned
token, which is why the suite needed its own comment-stripping layer, its own non-vacuity floors,
and ten `meta/` guards policing the other guards.

What survived the cut is the part that was never really a guard: **37 files of ordinary behavioural
testing** that happened to live in that tree — `db.test.ts` (real SQLite + migrations),
`sidecar.test.ts` and `layout.test.ts` (real media paths in temp dirs), `colors.test.ts`
(`parseHex`, `contrastRatio`), `transport.test.ts` (`transportFor`), and the rest. Those moved into
`tests/unit/` under the subsystem they test.

Also removed: 13 component-mount tests. Component behaviour — keyboard, paste, disabled states —
belongs on the Chromium rung, where it can actually be observed, rather than against a DOM
implementation with no layout engine.

### The trap that suite existed to avoid, and the cheaper way to avoid it

The guards were built around one real failure mode: **accidental green**. A test that silently
measures nothing passes, and passing is indistinguishable from correct.

That risk is real, but the answer is not a parallel suite that scans source text. It is:

1. Throw on a missing subject (above) rather than skipping.
2. Keep the assertion on the _behaviour_, not on the source line that implements it.
3. Let the type checker and the build carry the "is it wired" questions — `bun run typecheck` now
   covers `tests/**`, which is how four genuine type errors surfaced the day the gate was added,
   including a duplicated mid-file import block in `dispatch.test.ts`.

## Gates

`bun run gates` runs the full chain. `bun run typecheck` covers app, server, **tests** and e2e —
the tests tree was previously checked by nothing, since `typecheck:app` excludes `tests/**`.

`tests/tsconfig.json` opts out of `noUncheckedIndexedAccess`, the same documented debt
`tests/tsconfig.e2e.json` carries: 284 pre-existing `arr[0]` violations accumulated while the tree
was ungated. Gating it at all is the win; turning that flag on is a separate pass.
