# Tests

Two rungs, and the split is about what each can honestly decide. Paths below are relative to `core/`.

| Rung         | Runner                  | Lives in            | Decides                                                                  |
| ------------ | ----------------------- | ------------------- | ------------------------------------------------------------------------ |
| **Logic**    | `bun test`              | `tests/unit/`       | pure functions, server modules, DB + migrations, contract shapes, stores |
| **Rendered** | Chromium via Playwright | `tests/playwright/` | anything painted or measured: geometry, clipping, `env()`, `dvh`, colour |

The gate is `bun run test`, the `test` script in `package.json` (`bun test --conditions=svelte`). The
`--conditions=svelte` flag is no longer needed: every installed package that declares a `svelte` export
condition also declares a `default` or `import` one, and a bare `bun test` passes the same suite. Removing it is
the dead-code cleanup's job. `bunfig.toml` sets `[test] root = "tests/unit"`, so bun never opens the Playwright
`*.spec.ts` files.

## What lives where

- `tests/unit/` — run with `bun run test` (no browser, no DOM by default).
- `tests/playwright/` — the Playwright suite: four projects (`gate`, `flow`, `probe`, `shot`) over one
  `world` fixture. See [`E2E.md`](E2E.md).
- `tests/helpers.ts` — the shared path anchors and source-text helpers, reached as `$test`.
- `tests/tsconfig.json` — the tests tree's resolution context (`$test`, `$lib`, `$routes`). Gated by
  `bun run typecheck:tests`.

There is no DOM installed globally. A test that needs one builds its own — see
`tests/unit/lib/tv/wake-lock.test.ts`, which installs a happy-dom `Window` for the two globals the
module under test actually touches. Component behaviour (keyboard, paste, disabled states) is tested on the
Chromium rung, where it can be observed with a real layout engine.

## The one rule worth keeping

**A missing path throws. It is never a skip.**

`read()` and the anchors in `tests/helpers.ts` throw when their subject is absent, and deliberately
offer no `readIfExists`. A test that tolerates an absent subject asserts nothing: anything gating on
`existsSync` reads no file, finds no violations, and reports **green**. A wrong path is a path
failure, not a satisfied invariant, and it has to be loud.

The anchors also walk UP to the `core/` root marker (`bunfig.toml`) rather than counting `../` down from
the caller. A path that encodes the _test's_ location inside a claim about the _source's_ is wrong
the moment either end moves.

The same failure mode, **accidental green**, has two more answers:

1. Keep the assertion on the _behaviour_, not on the source line that implements it.
2. Let the type checker and the build carry the "is it wired" questions — `bun run typecheck` covers
   `tests/**` as well as the app and the server.

## Gates

`bun run gates` runs the full chain. `bun run typecheck` runs `typecheck:app` (svelte-check), `typecheck:root`
(`tsconfig.server.json`) and `typecheck:tests` (`tests/tsconfig.json`, which includes every `.ts` under `tests/`,
Playwright specs too). `typecheck:app` excludes `tests/**`, which is why the third leg exists.

`tests/tsconfig.json` opts out of `noUncheckedIndexedAccess`; production code does not. Turning it on for the
tests tree is a separate pass.
