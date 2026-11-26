# Layout

Where a file goes in `core/`, and why. Paths below are relative to `core/` unless they start with another
top-level directory (`worker/`, `docs/`, `docker/`).

---

## 1. The placement rule

Four homes, in the order you should test a new file against:

| Ask                                                                    | Home                                       | Enforced by                                                         |
| ---------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------- |
| Does it touch a DB, a secret, the filesystem, or authoritative state?  | `src/lib/server/`                          | SvelteKit refuses to bundle it clientward — `bun run build` exits 1 |
| Do **both** the browser and the server (or the Python worker) need it? | `src/lib/contract/`                        | convention; `tests/unit/contract/barrel-surface.test.ts` freezes the barrel's exported names |
| Is it a Svelte component?                                              | `src/lib/components/`, `src/lib/ui/`, or a surface folder | —                                                    |
| Otherwise: pure, client-only, non-component logic                      | `src/lib/` root                            | —                                                                   |

The fourth case is the one that reads like a dump and is not. The pure client-only modules that sit directly
in `src/lib/` are the residue after the other three homes take their share, and they are DOM-free. **That is a
category, and this row is its name.** A file there is correctly placed; it is not waiting to be filed.
`src/lib/utils.ts` sits there too, but for a different reason (§3).

### The rule that governs `ui`

Two directories are named `ui`. This is deliberate and it is the single most confusing thing in the tree, so
state it before anything else:

- `src/lib/components/ui/` — **vendored.** The `shadcn-svelte` copy-in target. Reorganising this directory is
  forbidden (§3). Its own [README](../core/src/lib/components/ui/README.md) carries the rules for editing it.
- `src/lib/ui/` — **authored.** Encore's own primitives, including the phone chrome (`NowPlayingStrip.svelte`,
  `TabBar.svelte`).

Read it as _vendored_ vs _ours_, never as _the ui library_ vs _our ui_. Neither name predicts its contents,
which is why the rule has to be written here rather than inferred.

---

## 2. Surface folders

A surface that owns both components and logic gets one folder holding both. `src/lib/tv/` is the reference
implementation: its components sit beside the modules only they use.

The phone surface does not have one. Its components are split between `src/lib/components/` and `src/lib/ui/`,
its tabs are routes (`src/routes/(phone)/+page.svelte`, `src/routes/(phone)/queue/`, `src/routes/(phone)/library/`), and its logic sits
in the `src/lib/` root. That asymmetry is deliberate:

1. `src/lib/components/` is among the most path-pinned trees in `core/`, so mirroring `tv/` would be an
   expensive move. Re-derive the cost rather than trusting a tally: count every `$lib/components/` import
   specifier plus every `src/lib/components/` literal across the `.ts`, `.js` and `.svelte` files of `src` and
   `tests`, and compare the same count for a rival tree.
2. There is no logic half to colocate. The strip and the tab bar are chrome: they render props and raise
   events, and what logic they reach for (`clock.ts`, `icons.ts`) is shared with surfaces that are not the
   phone. A `phone/` folder would be a rename rather than a colocation.

`src/lib/ui/` vs `src/lib/components/` is a vendored-vs-authored distinction (§1), which is a stronger boundary
than surface membership, so it wins where the two disagree.

---

## 3. Off-limits

**`src/lib/components/ui/` cannot move or be renamed.** Two independent locks, either one sufficient:

1. `components.json` points the generator at it. Moving it breaks every future `shadcn-svelte add`.
2. `src/app.css` carries exactly one `@source` glob, and it names this directory. Tailwind emits utilities
   from that glob and nowhere else — move the directory and every stock class in the vendored tree stops
   being emitted. **This fails silently at the CSS layer**, not loudly at the CLI: the app renders unstyled
   with a green test suite.

`src/lib/utils.ts` is pinned by the same generator config (`components.json` aliases `utils` to
`$lib/utils`) and imported throughout the vendored tree. It stays where it is regardless of what else moves.

**"Generator-owned" does not mean "safe to re-pull."** Vendored files carry local edits, each explained in a
comment at the top of the edited file. A `--overwrite` reverts them, and whatever no test pins goes back with a
green suite.

---

## 4. Do not do these

Each is a net loss.

- **Grouping the `src/lib/` root modules by filename prefix.** `process-progress.ts` and
  `process-and-queue.ts` are two concerns, not one: the first is presentation, the second is action
  composition that orders two mutations so a job inherits queue priority. A `process/` folder would misfile
  one of them.
- **Surface subfolders for the root components.** See §2 for the cost and how to measure it.
- **Splitting `src/lib/server/media/`.** It is the one directory whose name does not predict all its
  contents, and splitting it is still a bad trade: a high file count, many doc citations naming its paths,
  and a purely navigational payoff. No boundary is violated and no duplication is removed.
- **Moving the TV components** into the shared components directory. Colocation with their logic is
  _correct_ per §2.

---

## 5. Moving anything safely

The test tree derives almost every path from the `core/` root, found by walking up for `bunfig.toml`
(`tests/helpers.ts`), so **moving a test file is nearly free.** Moving a _source_ file is not: tests and
docs name source paths as literals.

`core/bunfig.toml` must stay at the `core/` root: `tests/helpers.ts` throws on import without it, which kills
the suite loudly rather than silently.

### Before any move

1. **Fix any already-stale path in a standalone commit** so the move's diff contains only the move.
2. **Reach for an alias, never a `..` hop count.** `$test`, `$lib` and `$routes` are declared in
   `tests/tsconfig.json`, the tests-only context, so production source cannot reach them.
3. **Do not anchor a path off the importing file's own location.** Derive it from a root anchor
   (`tests/helpers.ts`, or `repoRoot` from `tests/playwright/world/core.ts` for the specs).

### Then, in the same commit as the move

Update together: the anchors in `tests/helpers.ts`, the alias block in `tests/tsconfig.json`, and every
citation of the moved path in `docs/` and in source comments (`git grep` the old path).

Use `git mv`, so the index and the worktree agree on where the file is.

### Who checks doc pointers

The enforcement is asymmetric:

- **Code → docs is checked on the Python side only.** `worker/tests/test_docs_pointers.py` collects every
  `docs/…` path cited by the worker package, both bench harnesses and the worker's own tests, and fails when
  one does not resolve. It also checks that a cited `path §N` names a heading that exists. Its roots are
  Python directories, so it sees no `core/` source at all.
- **Docs → code is a convention on the core side.** No test walks `docs/` extracting `src`/`tests` paths and
  resolving them. The core tests that open a document (`comment-pointers.test.ts`,
  `library-wide-head.test.ts`, `type-ladder.test.ts`) read it for pinned substrings. So a `src/…` path in a
  document can rot silently, and deleting a source file does not red anything that cites it in prose. A
  source deletion has to sweep the docs by hand.

---

## 6. Open posture decisions

Two auth-posture questions are open by decision rather than oversight, and both are recorded as requirement
rows in [`arch/02-api.md`](arch/02-api.md):

- `GET` on the settings endpoint is ungated while `PUT` is capability-gated.
- The worker WebSocket role needs core's token even when `ENCORE_WORKER_TOKEN` is unset: core makes one on first
  boot (#1196, [SERVER.md](SERVER.md#the-worker-token)).
