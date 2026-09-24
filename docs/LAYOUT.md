# Layout

Where a file goes, and why. Written after a five-part read-only review of every
tree in the repo (see the closing section for what that review measured).

The short version: **this layout is sound and under-documented.** The review
found no directory that needs to be reorganised for correctness. It found one
naming collision, two misplaced files, and a set of rules that were being
followed without ever being written down. This document writes them down.

---

## 1. The placement rule

Four homes, in the order you should test a new file against:

| Ask                                                                    | Home                                       | Enforced by                                                         |
| ---------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------- |
| Does it touch a DB, a secret, the filesystem, or authoritative state?  | `src/lib/server/`                          | SvelteKit refuses to bundle it clientward — `bun run build` exits 1 |
| Do **both** the browser and the server (or the Python worker) need it? | `src/lib/contract/`                        | a boundary guard, in both directions                                |
| Is it a Svelte component?                                              | `src/lib/components/`, or a surface folder | —                                                                   |
| Otherwise: pure, client-only, non-component logic                      | `src/lib/` root                            | —                                                                   |

The fourth case is the one that reads like a dump and is not. Ten pure
client-only modules sit directly in `src/lib/` because they are the residue
after the other three homes take their share. They are all DOM-free and all
unit-tested without a browser. **That is a category, and this row is its
name.** A file there is correctly placed; it is not waiting to be filed.

### The rule that governs `ui`

Two directories are named `ui`. This is deliberate and it is the single most
confusing thing in the tree, so state it before anything else:

- `src/lib/components/ui/` — **vendored.** The `shadcn-svelte` copy-in target.
  Reorganising this directory is forbidden (§3).
- `src/lib/ui/` — **authored.** Encore's own primitives.

Read it as _vendored_ vs _ours_, never as _the ui library_ vs _our ui_. Neither
name predicts its contents, which is why the rule has to be written here rather
than inferred.

---

## 2. Surface folders

A surface that owns both components and logic gets one folder holding both.
`src/lib/tv/` is the reference implementation and the best-organised tree in
the repo: 23 files, two consumers outside itself, nothing else reaching in.

The phone surface does the opposite — its components live under
`src/lib/components/` while its logic sits in the `src/lib/` root. **That
asymmetry is the largest genuine structural inconsistency in the codebase**,
and it is deliberately left alone: the component half is the most
path-pinned set of files in the repo (83 hard path literals across 36 files),
so mirroring `tv/` would be the most expensive change available. Revisit only
if the phone surface is being reworked for another reason.

---

## 3. Off-limits

**`src/lib/components/ui/` cannot move or be renamed.** Three independent locks,
any one of which is sufficient:

1. `components.json` points the generator at it. Moving it breaks every future
   `shadcn-svelte add`.
2. `src/app.css` carries exactly one `@source` glob, and it names this
   directory. Tailwind emits utilities from that glob and nowhere else — move
   the directory and every stock class in the vendored tree stops being
   emitted. **This fails silently at the CSS layer**, not loudly at the CLI:
   the app renders unstyled with a green test suite.
3. Ten guards name it by path, mostly as exemptions.

`src/lib/utils.ts` is pinned by the same generator config and imported by ~56
vendored files. It stays where it is regardless of what else moves.

**"Generator-owned" does not mean "safe to re-pull."** A majority of the
vendored files already differ from the registry, and only about half of those
carry a deviation header. A `--overwrite` reverts the undocumented ones with a
green suite. Landing a guard that requires a header on every edited vendored
file is worth more than any move in §4.

---

## 4. Do not do these

Each was proposed during the review and each is a net loss.

- **Grouping the `src/lib/` root modules by filename prefix.** The three
  `process-*` modules are two concerns, not one: two are presentation, one is
  action composition that orders two mutations so a job inherits queue
  priority. A `process/` folder would misfile it. One of the three is
  additionally pinned _outside_ `contract/` by a guard whose mutation arm
  asserts that its alias is forbidden, annotated in three places against
  exactly this re-litigation.
- **Surface subfolders for the root components.** 83 hard path literals across
  36 files, most serving the same route.
- **Splitting the 25-file media directory** under `src/lib/server/`. It is the
  one directory whose name does not predict its contents, and splitting it is
  still the worst trade in the report: highest file count, a large share of the
  doc citations, many guards naming its paths, and a purely navigational
  payoff. No boundary is violated and no duplication is removed. If it truly
  impedes work, move out the one generic process utility that has no media
  semantics and leave the rest.
- **Moving the TV components** into the shared components directory. It would
  close a guard blind spot, but colocation with their logic is _correct_ per
  §2. Widen the guard instead — it is a one-line change to the walk root.

---

## 5. Moving anything safely

The test tree derives almost every path from a repo root found by walking up
for `bunfig.toml`, so **moving a test file is nearly free.** Moving a _source_
file is not: several hundred quoted repo-relative literals across 168 guard files name
source paths.

`bunfig.toml` must stay at the repo root. Both languages find the root by
walking up to it — if it moves, every guard and the worker's Python tests
break at once.

### Before any move

1. **Fix any already-stale path in a standalone commit** so the move's diff contains only the move.
2. **Reach for an alias, never a `..` hop count.** Routes, the test setup and the e2e tree each have
   one, declared in the tests-only context so production source cannot reach them. A new alias must
   also be added to the test-tree dependency guard's allowlist, or it reports an undeclared package.
3. **Know that `tests/guards/meta/no-self-anchored-paths.test.ts` walks `.ts` AND `.mjs`.** Three
   files are exempted, each because it DEFINES an anchor and so cannot use one, and each is asserted
   to still need its exemption. A narrowing of that extension list is what let six probes anchor one
   hop short for as long as they did.

### Then, in the same commit as the move

The test-support tree's landmark check throws on import if the contract
directory is missing, which kills the entire suite loudly rather than
silently — the best safety property in the codebase, and the reason a contract
move must update the landmark list and the derived anchor together.

Update together: the test-support anchors → the test tsconfig alias block →
three path-keyed registries in the non-vacuity floor guard **plus its two
coupled literals, currently 71** → the task-number exemption list → the e2e
unrun list → the test-helper consumer list → the doc-citation prefix allowlist
if a new top-level tree appears → four hand-listed file arrays that a walk
cannot discover → the doc citations themselves, across 18 documents.

### Verifying

A green suite after a move proves nothing about _where_ the guards looked.
Prove non-vacuity by measurement: raise a floor absurdly high, run that file
alone, read the received count. **A floor firing is a finding, never a number
to adjust.** Adding files to a walked tree is safe; a floor proves the walk
found files, not that it found the right ones.

Every move uses `git mv` — guards enumerate via `git ls-files`, and an
index/worktree disagreement surfaces as a missing file.

One trap specific to this document: the doc-citation guard checks every
`src`/`worker`/`tests` path in `docs/` that ends in a file extension. Proposed
paths that do not exist yet would fail it, which is why §4 names target
_directories_ rather than target files.

---

## 6. Open posture decisions

Two auth-posture questions are open by decision rather than oversight, and both are recorded as
requirement rows in [`arch/02-api.md`](arch/02-api.md) with their call sites:

- `GET` on the settings endpoint is ungated while `PUT` is capability-gated.
- The worker WebSocket role accepts unauthenticated upgrades when no token is set. The app warns
  loudly at boot, which is the right default for a self-hosted box, but it is worth an explicit
  decision rather than a warning.
