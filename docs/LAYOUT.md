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

Ranked by value per file moved. Everything here is small on purpose.

**Zero moves, highest value — write the rules down.** The complaint that
started this review was that the layout made no sense. §1 is the fix. Add a
README to the authored `ui` directory, since the vendored one has an excellent
one and the authored one has none.

**Test infrastructure out of the production tree.** One module under `src/lib/`
is test-only: it imports `node:fs`, has zero production importers, and all 16
of its importers are guards. It sits inside the browser-bundled zone and
survives only because nothing happens to import it. A test-support package
already exists under `tests/support/`, so there are two test-helper homes and
the wrong one ships inside the app. Moving it also unblocks reconciling four
competing directory walkers.

**Collapse the readiness duplicate.** A pure function is maintained by hand in
two places, one client-side and one under `src/lib/server/media/`, held in
agreement by a parity test asserting the two copies match across six inputs.
A function whose two copies must agree is the definition of an isomorphic
module: it belongs in `src/lib/contract/`, and the parity test then retires.
Its stated justification — that this is "a derived view concern" and so not
contract — is contradicted by the contract tree, which already holds three
derived view concerns.

**Flatten two one-file directories** under `src/lib/server/`, one of which uses
an `index.ts` where every sibling module is a named file. Cheap; do it only
when already touching those files.

**Optional, one honest axis:** three pure guest-facing phrase builders in the
`src/lib/` root form a real group. A `phrasing/` folder would state something
true. It must **not** absorb the operator-facing formatters — the operator and
guest vocabularies are kept separate deliberately.

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

### Before any move

1. **Fix the already-stale paths in a standalone commit** so the move's diff
   contains only the move. Several are broken right now (§7).
2. **Widen the self-anchored-path guard** to `.ts` and `.mjs`, with a named
   exemption list for the legitimate root-walkers. It currently scans only
   `*.test.ts`, which is precisely why the live breakage in §7 went unseen.
3. **Add the missing aliases.** Thirty files navigate by counting `..` hops in
   an import specifier, because only `src/lib` has an alias — routes and the
   test kit have none. Adding those two aliases deletes all thirty hop counts
   and removes the most fragile spelling in the repo. Note that the test-tree
   dependency guard keeps an alias allowlist; a new alias must be added there
   too or it reports an undeclared package.

### Then, in the same commit as the move

The test-support tree's landmark check throws on import if the contract
directory is missing, which kills the entire suite loudly rather than
silently — the best safety property in the codebase, and the reason a contract
move must update the landmark list and the derived anchor together.

Update together: the test-support anchors → the test tsconfig alias block →
three path-keyed registries in the non-vacuity floor guard **plus its two
coupled literals, currently 66** → the task-number exemption list → the e2e
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

## 7. Broken right now, independent of any move

Found during the review, all verified, none caused by it.

- **The container image cannot build.** Two `COPY` directives name directories
  that no longer exist, and one is a single-argument `COPY`, which is a parse
  error. Nothing downstream of it has ever executed.
- **The browser tab shows the Svelte logo.** The imported favicon is the stock
  SvelteKit template file. Encore's own app mark sits under `static/`
  referenced by nothing — and precached by the service worker on every client.
- **The Bun entry point mixes alias and relative imports.** One import uses the
  `$lib` alias while the rest are relative. That alias resolves only through a
  generated, gitignored config that the container never copies. There is no
  committed Svelte config in the repo at all, so this is the only definition
  that exists.
- **Six e2e probes resolve their repo-root anchor one hop short**, landing in
  `tests/` instead of the repo root. One then checks for a build directory that
  can never exist under that anchor, so it always bails. All six are on the
  unrun list, so nothing executes them and no guard reads them — the repo's
  documented failure mode, live.
- **The screenshot script's driver import** resolves outside the test tree, to
  a path that does not exist.
- **An e2e gate spawns a seed script** at a path that does not exist.
- **The dev script cites the pre-flatten `apps/` tree** on 14 lines.
- **`scripts/` is outside every gate** — not linted, not formatted, and its
  entries in the e2e tsconfig are resolved relative to the tests directory, so
  they match nothing and check nothing.
- **A dev-only route has no dev gate.** It says it is not a product surface,
  and it builds and serves in production. It is also load-bearing test
  infrastructure for five guards, so it cannot simply be removed.
- **Worker prose cites a pre-flatten shared path** in three modules. The
  citation guard walks only `docs/`, so worker comments are unchecked.

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
