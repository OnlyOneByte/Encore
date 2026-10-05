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

The fourth case is the one that reads like a dump and is not. The pure
client-only modules that sit directly in `src/lib/` are the residue after the
other three homes take their share. They are all DOM-free and all unit-tested
without a browser. **That is a category, and this row is its name.** A file
there is correctly placed; it is not waiting to be filed.

The population is `ls core/src/lib/*.ts | wc -l`, which reads **15** today, or
14 once `utils.ts` is set aside — §3 pins that one for a different reason and it
is not residue. A count was written here as "ten" and rotted both ways: the
category grew, then `sheet-snap.ts` left it when the now-playing sheet was
deleted. Re-derive it rather than reading it here; the claim this row makes is
the CATEGORY, and a tally of it was never load-bearing.

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
and it is deliberately left alone: the component half is the most path-pinned
set of files in the repo, so mirroring `tv/` would be the most expensive change
available. The pinning is re-derivable rather than tallied here — count every
`$lib/components/` import specifier plus every `src/lib/components/`
repo-relative literal, across the `.ts`, `.js` and `.svelte` files of `core/src`
and `core/tests`, and compare the same count for a rival tree. (A path named
inside a comment counts: it rots the same way an import does, which is the thing
this figure is measuring.) Today that reads 129 literals over 31 files for
`lib/components` against 109 over 51 for `lib/server/media`, 70 over 32 for
`lib/tv`, 43 over 27 for `lib/ui` and 36 over 22 for `lib/contract`. 129 over 31
is 4.2 literals per file against the 2.2 of the densest rival, `lib/tv`, so the
superlative is about literal DENSITY and survives the comparison; a figure of
"83 across 36 files" stood here under a definition this document never recorded,
which is why the definition is now spelled out and the rival readings with it.

Run the same recipe against `HEAD` and the dock rebuild's shape falls out:
`lib/components` was 139 over 32 and FELL a net ten — sixteen literals went,
seven of them inside `NowPlayingDrawer.svelte` itself and nine from files that
survived it, and the new `/queue` route brought six back;
`lib/ui` was 35 over 24 and ROSE, because `TabBar`, `NowPlayingStrip`, the
`/queue` route that imports both and the guards that pin their paths all name it; and
`lib/server/media`, `lib/tv` and `lib/contract` did not move at all. The
asymmetry the ruling is about therefore narrowed slightly and the ruling is
unchanged. Do not requote these five pairs as facts about the tree you are
reading — they are a snapshot of the tree the paragraph was written on, and the
recipe above is the durable half.

### The revisit condition fired, and the ruling held

**It fired.** The phone surface was reworked for another reason entirely: the
now-playing sheet was replaced by a fixed bottom dock holding a strip and a tab
bar, which is as squarely "the phone surface is being reworked" as the condition
can get. So the asymmetry was reconsidered on its merits rather than inherited.

**And the ruling held, because the rework did not change the trade.** The two
new chrome components went to `src/lib/ui/` — `NowPlayingStrip.svelte` and
`TabBar.svelte`, authored primitives, which is the home §1's third row already
gives them — and the new tab went to `src/routes/queue/`. No `src/lib/phone/`
was created. Two reasons, both of which are about these files specifically:

1. The path-literal cost mirroring `tv/` would pay is still the highest in the
   repo. The rework DID retire some of it — deleting the sheet stack took
   `NowPlayingDrawer.svelte`, `NowPlayingBand.svelte` and the thirteen-file
   vendored `ui/drawer/` directory out of the tree, and every literal naming
   them with it — but the remaining count is the one measured above and it is
   still first on literal count, 129 against `lib/server/media`'s 109. A cost
   that shrank and stayed the largest is not a reason to pay it.
2. There is no logic half to colocate. `tv/` earns its folder because its
   components sit beside modules only they use. The strip and the tab bar are
   chrome: they render props and raise events, and what logic they reach for
   (`clock.ts`'s `progressFraction`, `icons.ts`) is shared with surfaces that
   are not the phone. A `phone/` folder would hold two components and nothing
   else, which is a rename rather than a colocation.

The honest reading is that the asymmetry is now smaller than this section
described it: the phone's newest components are NOT under
`src/lib/components/`, so the surface is split three ways rather than two. That
is a cost of the rule in §1 winning over the rule in §2, and it is the right
cost — `src/lib/ui/` vs `src/lib/components/` is a vendored-vs-authored
distinction (§1's `ui` note), which is a stronger boundary than surface
membership.

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
- **Surface subfolders for the root components.** The most path-pinned tree in
  the repo, most of it serving the same route — the count and its definition are
  in §2, which is also where the rival trees are measured so the superlative can
  be checked rather than taken.
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
3. **Do not anchor a path off the importing file's own location.** Derive it from a repo-root anchor
   (`tests/helpers.ts`, or `repoRoot` from `tests/playwright/world/core.ts` for the specs).
   Hop-counting is what let six probes anchor one hop short for as long as they did.

### Then, in the same commit as the move

`tests/helpers.ts` throws on import if its repo-root marker is missing, which
kills the suite loudly rather than silently — the best safety property in the
codebase, and the reason a contract move must update the anchor with it.

Update together: the anchors in `tests/helpers.ts` → the test tsconfig alias
block → the e2e
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

One trap specific to this document, **and the guard behind it runs in only one
direction, which was looked for rather than assumed.** §4 names target
_directories_ rather than target files so that a proposed path cannot be read as
a claim that the file exists. Keep doing that. But the enforcement is asymmetric:

- **Code → docs is GUARDED, on the Python side only.** `worker/tests/test_docs_pointers.py`
  collects every `docs/…` path cited by the worker package, both bench harnesses
  and the worker's own tests, and fails when one does not resolve. It also checks
  that a cited `path §N` names a heading that exists. Its roots are Python
  directories, so it sees no `core/` source at all.
- **Docs → code is a CONVENTION on the core side, not a guard.** No test walks
  `docs/` extracting `src`/`tests` paths and resolving them. Every core test that
  opens a document — `comment-pointers.test.ts`, `library-wide-head.test.ts`,
  `type-ladder.test.ts` — reads it for PINNED SUBSTRINGS, and
  `comment-pointers.test.ts` scans `src/` for line-number pointers rather than
  `docs/` for paths. So a `src/…` path in a core-side document can rot silently,
  and deleting a source file does not red anything that cites it in prose.

That asymmetry is why a source deletion has to sweep the docs by hand, and why
the convention is worth more than it looks: it is the only thing holding those
citations up. The gap is a known one, not a finding — a walk over `docs/` for
`core/src/…` and `core/tests/…` paths would close it and would be cheap, and the
Python guard is the working model to copy.

---

## 6. Open posture decisions

Two auth-posture questions are open by decision rather than oversight, and both are recorded as
requirement rows in [`arch/02-api.md`](arch/02-api.md) with their call sites:

- `GET` on the settings endpoint is ungated while `PUT` is capability-gated.
- The worker WebSocket role accepts unauthenticated upgrades when no token is set. The app warns
  loudly at boot, which is the right default for a self-hosted box, but it is worth an explicit
  decision rather than a warning.
