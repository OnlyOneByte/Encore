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

| Ask | Home | Enforced by |
|---|---|---|
| Does it touch a DB, a secret, the filesystem, or authoritative state? | `src/lib/server/` | SvelteKit refuses to bundle it clientward — `bun run build` exits 1 |
| Do **both** the browser and the server (or the Python worker) need it? | `src/lib/contract/` | a boundary guard, in both directions |
| Is it a Svelte component? | `src/lib/components/`, or a surface folder | — |
| Otherwise: pure, client-only, non-component logic | `src/lib/` root | — |

The fourth case is the one that reads like a dump and is not. Twelve pure
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

Read it as *vendored* vs *ours*, never as *the ui library* vs *our ui*. Neither
name predicts its contents, which is why the rule has to be written here rather
than inferred.

---

## 2. Surface folders

A surface that owns both components and logic gets one folder holding both.
`src/lib/tv/` is the reference implementation and the best-organised tree in
the repo: 22 files, two consumers outside itself, nothing else reaching in.

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

## 4. Justified moves

Ranked by value per file moved. Everything here is small on purpose. The first
three are **done**; the last is still optional.

**Zero moves, highest value — write the rules down. DONE.** The complaint that
started this review was that the layout made no sense. §1 is the fix. Still
outstanding: a README in the authored `ui` directory, since the vendored one has
an excellent one and the authored one has none.

**Test infrastructure out of the production tree. DONE.** One module under
`src/lib/` was test-only: it imported `node:fs`, had zero production importers,
and all 16 of its importers were guards. It sat inside the browser-bundled zone
and survived only because nothing happened to import it. It now lives in the
test-support package beside the other scanning helpers, reached by alias.

Its `app.css` read was anchored one hop above its own location, so the move would
have silently re-pointed it — it now reads from the repo root, which throws on a
miss.

Still open, deliberately: that module keeps its own directory walker alongside the
test-support package's. Reconciling two walkers with different skip semantics
changes what every consuming guard can SEE, and a guard that silently narrows its
population still passes. That is its own measured change, not a rider on a move.

**Collapse the readiness duplicate. DONE.** A pure function was maintained by
hand on both sides, held in agreement by a parity test across six media shapes.
It now lives in the contract's process folder, and both sides import it. The two
readiness unions were never identical and that is now explicit rather than
coincidental: the contract names the three members a catalog can describe, and
the client widens it with the one member only a live event can produce. The
parity test is retired — with one implementation it could only compare a value
with itself.

**Flatten two one-file directories** under `src/lib/server/`, one of which uses
an `index.ts` where every sibling module is a named file. Cheap; do it when
already touching those files. NOT done.

**Optional, one honest axis:** three pure guest-facing phrase builders in the
`src/lib/` root form a real group. A `phrasing/` folder would state something
true. It must **not** absorb the operator-facing formatters — the operator and
guest vocabularies are kept separate deliberately. NOT done.

---

## 5. Do not do these

Each was proposed during the review and each is a net loss.

- **Grouping the `src/lib/` root modules by filename prefix.** The three
  `process-*` modules are two concerns, not one: two are presentation, one is
  action composition that orders two mutations so a job inherits queue
  priority. A `process/` folder would misfile it. One of the three is
  additionally pinned *outside* `contract/` by a guard whose mutation arm
  asserts that its alias is forbidden, annotated in three places against
  exactly this re-litigation.
- **Surface subfolders for the root components.** 83 hard path literals across
  36 files; eleven of the twelve serve the same route.
- **Splitting the 25-file media directory** under `src/lib/server/`. It is the
  one directory whose name does not predict its contents, and splitting it is
  still the worst trade in the report: highest file count, a large share of the
  doc citations, many guards naming its paths, and a purely navigational
  payoff. No boundary is violated and no duplication is removed. If it truly
  impedes work, move out the one generic process utility that has no media
  semantics and leave the rest.
- **Moving the TV components** into the shared components directory. It would
  close a guard blind spot, but colocation with their logic is *correct* per
  §2. Widen the guard instead — it is a one-line change to the walk root.

---

## 6. Moving anything safely

The test tree derives almost every path from a repo root found by walking up
for `bunfig.toml`, so **moving a test file is nearly free.** Moving a *source*
file is not: 353 quoted repo-relative literals across 124 guard files name
source paths.

`bunfig.toml` must stay at the repo root. Both languages find the root by
walking up to it — if it moves, every guard and the worker's Python tests
break at once.

### Before any move — all three now done

1. **Fix the already-stale paths in a standalone commit** so the move's diff
   contains only the move. Done; see §7.
2. **Widen the self-anchored-path guard** to `.ts` and `.mjs`, with a named
   exemption list for the legitimate root-walkers. Done. It read only
   `*.test.ts`, which is exactly why the six probes in §7 went unseen. Three
   files are exempted, each because it defines an anchor and so cannot use one,
   and each is asserted to still need its exemption. `createRequire` of a module
   URL is excluded as module resolution rather than path arithmetic.
3. **Add the missing aliases.** Done: 36 specifiers across 30 files navigated by
   counting `..` hops, because only `src/lib` had an alias. Routes, the test
   setup and the e2e tree now have their own, declared in the tests-only context
   so production source cannot reach them. Note that the test-tree dependency
   guard keeps an alias allowlist; a new alias must be added there too or it
   reports an undeclared package.

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
cannot discover → the doc citations themselves (328 across 21 documents).

### Verifying

A green suite after a move proves nothing about *where* the guards looked.
Prove non-vacuity by measurement: raise a floor absurdly high, run that file
alone, read the received count. **A floor firing is a finding, never a number
to adjust.** Adding files to a walked tree is safe; a floor proves the walk
found files, not that it found the right ones.

Every move uses `git mv` — guards enumerate via `git ls-files`, and an
index/worktree disagreement surfaces as a missing file.

One trap specific to this document: the doc-citation guard checks every
`src`/`worker`/`tests` path in `docs/` that ends in a file extension. Proposed
paths that do not exist yet would fail it, which is why §4 names target
*directories* rather than target files.

---

## 7. What the review found broken, and what is left

All of these were verified, and none was caused by the review. **Fixed:**

- **The container image could not build.** Two `COPY` directives named
  directories that no longer exist, and one was a single-argument `COPY`, a parse
  error — so nothing downstream of it had ever run. With that fixed the image
  booted and immediately died on an unresolvable alias: the runtime-loaded server
  tree used `$lib`, which is declared only in a generated, gitignored config the
  image never copies. That was 51 specifiers across 38 files, now relative. The
  fix is verified by building and running the container, not by reading the file.
- **The browser tab showed the Svelte logo.** The imported favicon was the stock
  SvelteKit template file, while Encore's own mark sat unreferenced under
  `static/` and precached by the service worker. The icon family now has one home.
- **Six e2e probes resolved their repo-root anchor one hop short**, and the fault
  was paired: their spawn arguments were cwd-relative in a way that only worked
  *because* the anchor was wrong, so fixing either alone would have broken them.
  Both moved together. The hop-count spelling is gone from the e2e tree — one
  shared module walks up for the root marker, replacing six inlined copies.
- **A helper called in two drivers was defined in neither**, lost with a batch of
  removed spawn blocks; they would have thrown on first boot. Extracted to a
  shared module.
- **The lint gate was hiding 36 real errors.** Not a broken cache — the mechanism
  works — but the default cache strategy keys on modification time and size,
  which a checkout or stash can defeat. It now keys on content, which was
  demonstrated to catch a same-size edit with the timestamp restored. Cold and
  warm run times are unchanged.
- **`scripts/` was outside every gate** — not linted, not formatted, and its
  entries in the e2e type config resolved relative to the wrong directory, so
  they matched nothing. Its one live file moved beside the driver it imports; its
  companion type stub declared a module nothing imports any more and is deleted.
- **The dev script, `.gitignore`, `.dockerignore`, the base type config and four
  worker modules** all still described the pre-flatten layout. The `.gitignore`
  case had teeth: it ignored a wheelhouse path under the old tree, so the real
  one had no rule at all.
- **25 usage strings** named a script path that has not existed since the
  flatten, several of them printed to the operator as help text.

**Still open, each needing a decision rather than a fix:**

- ~~A dev-only route has no dev gate.~~ **Fixed.** All five guards read it as
  SOURCE rather than serving it, so the gate cost them nothing; it 404s in a
  production build and a guard pins both the gate and the five fixture readers.
- `GET` on the settings endpoint is ungated while `PUT` is capability-gated.
- The worker WebSocket role accepts unauthenticated upgrades when no token is
  set. The app warns loudly at boot, which is the right behaviour for a
  self-hosted default, but it is worth an explicit decision rather than a warning.
- ~~19 of 38 e2e drivers remain reachable from no command.~~ **Fixed.** All of
  them are reachable via `bun run e2e:probes`, which boots and seeds the shared
  environment they need. Running them for the first time is what surfaced the
  remaining item below. Their individual state is recorded in
  `tests/e2e/HARNESS.md`; several are stale in named, specific ways, and repairing
  a probe by weakening its assertion would be worse than leaving it red.
- **A floor-level silent instrumental is published as READY with no
  defence-in-depth in the core** — reported at `[HIGH]` by
  `p5-process-lifecycle`, which had never been executed. This is a product defect,
  not a broken probe, and it is the most substantive thing this whole review
  turned up.

---

## What the review measured

Five parallel read-only reviewers, one per tree, none of which ran a gate:
the components tree; the server and contract trees; the rest of `src/`; the
repo root and the worker; and a constraints pass over every guard that asserts
on a path. Findings were verified by reading files, `git log`, and `grep` — and
the load-bearing ones re-verified directly before being recorded here.

The reviewers corrected the premises they were given four times: the two `ui`
directories are deliberate rather than accidental; the stylesheet does not
import the test helper, it only mentions it in prose; the vocabulary-parity
guard reads only worker sources and so constrains no TypeScript move; and the
two icon files are different images rather than duplicates, which made that
finding worse rather than better.
