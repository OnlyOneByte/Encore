# Guards

How this repo's test suite defends itself, and the traps it has learned. `bun run test` runs every
guard under `tests/guards/`; `bun run gates` runs the seven-leg release gate.

Rules of the road, and the reason each exists, live here rather than in the guard files so a guard
can be read as an assertion instead of an essay. Each section names the files that enforce it.

## Why guards are written this way

A guard here is usually an assertion that an `offenders` array is EMPTY. That shape is the source of
every trap below, because an empty array is what a working guard produces **and** what a guard
examining nothing produces. Most of these rules exist to tell those two apart.

### Non-vacuity floors

Two dozen guards derive their own scope at run time — they walk a tree, filter a file list, or count
the rules they matched. A scope regression (a moved directory, a renamed extension, a copy-in path
outside the walk, a component library that relocates markup) turns such a guard GREEN rather than red.
The answer is a **non-vacuity floor**: an assertion on the SIZE of what was actually examined, planted
beside the emptiness assertion it protects.

**A firing floor is a finding, never a number to adjust.** It does not mean the guard broke; it means
the guard can no longer see the surface it was enforcing on, and the number is the messenger. Three
resolutions are accepted:

1. **Restore the scope.** The walk lost sight of files it should still see. This is the common case,
   and a real defect the floor just caught.
2. **Re-anchor.** The surface genuinely moved and the guard should follow it. Point the scan at the new
   location and keep the floor at a value the new scope supports.
3. **Retire, on the record.** The invariant stopped applying. Move the entry from `FLOORS` into
   `RETIRED` in `tests/guards/meta/non-vacuity-floors.test.ts` with a reason naming the invariant whose
   scope shrank, the sites that left scope, and the guard that covers them now — or an explicit
   statement that none does. `RETIRED` is checked: the reason must be substantive and the assertion
   must be genuinely gone, so "retire" cannot launder a lowered number. Retiring to zero is the rule,
   never lowering to zero.

Editing a literal downward to match a shrunken scope is not on the list. A floor going DOWN is as much
a finding as one going up, and the population it tracks is the only thing that may move it.

Floors are **snapshotted, not extracted**. A regex that harvested every `toBeGreaterThan` in the suite
would also harvest 40-odd assertions that are not floors at all (`start >= 0`, `ratio >= 4.5`,
`w >= 44`), so its own contents would drift and it could not tell a deleted floor from an unrelated
refactor. The floors are LITERALS, which is what makes a checked-in snapshot decidable: each entry
names the file, the subject expression and the minimum, and the check is that an assertion at least
that strong is still there. The snapshot is keyed by subject TEXT, never by line number, so ordinary
edits above a floor do not churn the registry; `count` is a MINIMUM occurrence count, so adding a floor
to a listed file is fine and removing one is not.

Two mechanisms keep the registry itself honest. Each registered assertion carries a
`// @nvf-floor <subject>` tag **on the same line as its `expect(`**, and the scan is bidirectional: a
registration whose site has no tag reds, and a tagged floor that is unregistered reds — including in a
brand-new guard, because the tag sweep starts from the TREE rather than from the registry's own keys.
And the registry's own two floors (`located`, `taggedSitesSeen`) are **zero-slack**: each must equal the
exact sum of every `count`, because any slack is a laundering allowance — a floor deleted from its
source AND its entry deleted together still clears a number set below the sum. Measure those two rather
than counting by eye: raise the literal absurdly high, run the file alone, and read `Received: N`.

### Why guards strip comments, and the `/*` trap

A guard that scans source for an anchor reads what RENDERS, so it strips comments first. Otherwise a
selector, a class or a phrase that exists only in prose satisfies a presence check, and an absence
check reds on the guard's own explanation of the thing it bans. Strippers here BLANK comments in place
(replacing every non-newline character with a space) rather than deleting them, so line numbers in a
failure still point at the real file.

Strip both kinds. A `.svelte` file carries C-style comments in its `<style>` block and `<!-- -->`
comments in its markup, and a guard that handles one is blind through the other.

The trap: strippers remove C-style comments FIRST, and `/**` is `/*` plus a star. A markup comment that
spelled a glob — `<!-- … components/ui/** … -->` — opened a C comment inside an HTML comment, and the
stripper ran to the next `*/` anywhere in the file, blanking hundreds of lines of real markup on the
way. Four guards then failed with messages about markup that was still perfectly present. Nothing
errors: `svelte-check` is happy, the app renders, the build is fine, and only the guards see the mangled
text. So **no HTML comment may contain `/*`** anywhere under `src/`
(`tests/guards/meta/markup-comment-safety.test.ts`, which also asserts the premise — that guards really
do strip C-style comments first — so the ban would be retired rather than kept if nobody needed it).

### Accidental green, and its mirror

The worst failure mode is a guard that proves something about text which only exists in a comment. Two
hooks in `tests/guards/hygiene/contract.test.ts` once passed with their markup DELETED, because the
component's own prose named the element and the prop; a dead selector kept alive by a comment is
indistinguishable from a live one to an unstripped read. `<video` in this tree exists only in comments
— the rendered element is `<audio>` — which is why the comment-stripping regression arm has a real
subject to point at.

The mirror failure is a guard ANCHORED on prose, which reds when someone edits a sentence that changed
nothing it guards. Both are cured the same way: point the assertion at code or structure, and where the
subject is a pure function, point it at a synthetic fixture instead of at whichever file happens to
carry the shape today. `tests/guards/hygiene/browse-screen.test.ts` proves its stripper against a
fixture for exactly this reason, and only the safe direction — no comment syntax SURVIVES stripping —
is asserted against real files. A guard that requires a comment to exist somewhere else couples the
suite to prose and will red on a cleanup.

Related shapes worth knowing:

- **Slice guards need a non-vacuity check of their own.** An unmatchable selector slices to the empty
  string, and every `not.toContain` over nothing passes. Assert the slice's start index and length
  before asserting about its contents.
- **Anchor a slice on code, not on a heading.** Slicing "up to the `1b.` banner" made a prose edit in
  another file extend the slice to EOF and report a patch as relocated when nothing had moved; brace
  matching is the honest form.
- **Never key a registry on `path:line`.** A line number is a fact about everything ABOVE a site rather
  than about the site itself: a sibling edit two lines up silently unhooked two exemptions and pointed a
  third at ordinary prose within the hour. Key on CONTENT.
- **Compare counts, not formatted objects.** `expect(root.querySelector(sel)).toBeNull()` makes bun
  format a happy-dom element on failure, which walks the geometry accessors the mount rung replaced with
  a throw: 51 seconds to print one red, and a SIGABRTed runner in two mutation runs. A count formats as
  a number.
- **Every exemption is explicit and carries its reason at the site.** An unexplained exemption is a hole
  with a comment on it; a silent skip of whatever the guard failed to find is a hole with nothing on it.
  An unmodelled input is an OFFENDER, not a pass, so the model gets extended rather than the input going
  unchecked. Where an exemption map is empty, it stays declared with the sentinel that keeps each future
  entry honest.
- **Pin what a hand-kept list cannot.** Enumerate from the tree rather than listing by hand, and floor
  the enumeration — a hand-kept list of 2 drivers left the other 22 unwatched while the documentation
  said all of them were covered.
- **A task or ticket number never appears in source, a comment, a test or fixture data**
  (`tests/guards/meta/task-number-hygiene.test.ts`). Six months on nobody has the backlog in their head,
  and a ticket code says strictly less than the behavioural sentence it replaced. Change narration
  belongs in the commit; a rule belongs in the code; the reasoning behind a rule belongs here.

## The hygiene and meta guards

`tests/guards/meta/**` guards the suite; `tests/guards/hygiene/**` guards the tree the suite reads.

### The rungs, and what each can honestly decide

- **Rung M (mount)** is `bun test` with happy-dom plus compiled Svelte, wired by
  `tests/setup/svelte-dom-preload.ts` and driven through `tests/setup/svelte-client.ts`. It decides
  mounting, the cascade, DECLARED computed values, effects and event handling. SvelteKit's `$app/*` and
  `$env/*` are synthesised at build time, so the preload maps them to real stub modules under
  `tests/setup/kit/`; without that, every route component failed to load before a single effect ran.
- **Rung L (layout)** is a real headless Chromium driven through `tests/e2e/driver.mjs`. Box geometry,
  clipping, `env()`, `dvh`/`vh`, computed colour and computed font-size are decidable ONLY there.
- happy-dom has no layout engine, so it fabricates a zero for every geometry read — and both natural
  guard shapes go wrong with a zero: `expect(w).toBeGreaterThan(0)` is a permanent red nobody trusts and
  `if (w > 0) expect(w).toBeGreaterThanOrEqual(44)` is a permanent SILENT GREEN. So all six geometry APIs
  THROW on rung M, naming the rung and where the measurement can be taken. The patch covers
  `HTMLElement.prototype` as well as `Element.prototype`, which shadows it for every HTML element, and
  sits OUTSIDE the DOM-install branch because the aliasing plugins are unconditional.
- Making zeros loud is what keeps a component that MEASURES off rung M. `ResizeObserver` is therefore
  deliberately NOT installed (`tests/guards/meta/mount-rung.test.ts` holds it absent): happy-dom ships
  one whose `observe()` is a no-op, so installing it would turn a loud `ReferenceError` into a
  measurement of nothing. A test that needs a component to render at all may LEND one for the duration of
  a single mount — a `ResizeObserver` notifies, it does not measure, so the stub notifies nobody and every
  geometry accessor still throws — but it must assert the global was absent on entry and delete it in a
  `finally`. `tests/guards/hygiene/phone-home.test.ts` does this, and its last test BOUNDS the refused
  API names so a new measuring dependency reds instead of being absorbed by the same catch.
- Stubs are imported LAZILY inside the test that needs them and BY their `$app`/`$env` specifier, never
  at module scope: importing by specifier is what proves the mapping, and keeping the import inside the
  test means deleting a stub reds the tests that use THAT stub rather than failing the whole file to load.

### The e2e selector contract

`tests/guards/hygiene/contract.test.ts` keeps the driven flow aimed at the app it claims to test, with no
browser and no server — a browser test would skip on any machine missing either, and a permanently
skipped test is indistinguishable from the silent rot it was meant to prevent. The rot it was written for
was three selector families moving while `bun test` stayed green, because nothing in the suite ever
looked at the script.

- `HOOKS` (hand-kept file/anchor pairs) and `SEL` (what the drivers actually query the DOM with) are two
  copies of the same truth, and only `HOOKS` was ever checked. Every concrete `SEL` entry is now resolved
  against the whole `src` tree, comment-stripped.
- The resolver's model: a comma list is a UNION (one branch suffices — `video, audio` is deliberately
  both, because pinning the read to a bare `video` returned -1 forever); `^=` and `=` share the source
  anchor `name="value`; descendant whitespace, `>` and `+` all split identically, because a combinator
  changes only WHERE parts sit and no source scan can see that; `:not()` ARGUMENTS name nothing that has
  to exist, so the positive anchor is the base written before the chain; an unmodelled shape returns null
  and is reported as a hole in the guard rather than a pass.
- Resolution is necessary but not sufficient. `.hero` still resolves — against TV markup — so re-adding
  `hero: '.hero'` to `SEL` would pass the every-selector-resolves arm with the PHONE flow aimed at the
  TELEVISION. A selector resolving against the wrong surface is worse than one that reds, and only an
  absence assertion catches it, so retired names are pinned as retired.
- **No driver spells a selector out for itself.** The rule is a CALL-SITE rule (a selector-taking function
  invoked with a string literal) rather than a syntax rule, because a shape rule has to guess: the first
  version required a literal to start with `.` or `#`, which left `querySelectorAll('video, audio')`
  unguarded. `KNOWN_OFFENDERS` quarantines the existing debt as exact `(file, literal)` pairs, so a NEW
  literal in ANY driver reds; never add to that map to silence one. `tests/e2e/contract.ts` is where the
  selector goes instead.
- Literals inside a driver's `page.evaluate(\`…\`)`template never run under`bun test`, so
`tests/e2e/probes/p10-scaling.mjs`'s contrast targets are extracted and resolved here; five named
  classes no component declared, and the probe exited 0 every time.
- `classPresent` matches whole tokens. A `\b` match treats `-` as a boundary, so `class="badqr-b"`
  resolved the bare token `b` and `class="pill {a.outcome}"` resolved the variable `a`.

### Paths, walks and shared helpers

- A test under `tests/` names its subject **from the repo root** through `@encore/test-support`
  (`at`/`read`/`filesUnder`, or `srcDir`/`e2eDir`/`repoRoot`), or through `tests/e2e/lib/repo-root.mjs` in
  a driver that runs under bare `bun run` — never relative to where the test file itself sits. A relative
  anchor embeds a statement about where the TEST lives inside a statement about where the SOURCE lives, so
  it stops resolving the moment either moves, and 61 relocated guards once kept path arithmetic pointing
  at their old depth and reported green from the wrong tree. Absolute anchoring is also the only form in
  which a wrong path fails loudly: `read()` and `filesUnder()` throw on a miss by design, while a wrong
  walk root yields an empty list that reads exactly like a clean tree and flips an `existsSync` absence
  arm to passing for the wrong reason. `tests/guards/meta/no-self-anchored-paths.test.ts` covers `.ts` and
  `.mjs`, not just `.test.ts`, because the e2e drivers are neither and resolved one hop short for as long
  as the narrower walk was in force. Exactly three files may self-anchor, each because it DEFINES an
  anchor the rest import: `tests/support/src/tree.ts`, `tests/setup/svelte-dom-preload.ts` (it runs before
  any alias exists) and `tests/e2e/lib/repo-root.mjs`.
- A floor belongs INSIDE the shared walk that produces a file list, not in each consumer, so a new
  consumer inherits it.
- One recursive directory walker, in `tests/support/src/scan.ts`. `tests/guards/meta/test-helpers.test.ts`
  keys its single-definition arm on five helper NAMES, so a rival walker under a different name is not
  caught; three exist today (`tsSources` in `tests/guards/motion/motion.test.ts`, `tsFiles` in
  `tests/guards/hygiene/icons.test.ts`, `allDrivers` in `tests/guards/hygiene/contract.test.ts`) and the
  guard is green with all three. Closing that hole means banning any second recursive walk in a consumer,
  which cannot land until those three are consolidated.
- `tests/guards/meta/no-hand-rolled-cdp.test.ts` bans a private DevTools client: two probes each grew one
  because the shared driver lacked a verb, and the larger then rotted silently, dialling a debugging port
  after the Chromium spawn that opened it was removed, with no command running it to say so.
- `tests/guards/meta/e2e-reachability.test.ts` pins that every file under `tests/e2e` is reachable from a
  root, and `tests/guards/meta/test-tree-deps.test.ts` that every external import the test tree uses is
  declared. Both floor the enumeration AND the derived set, because the sharper failure is a filter that
  reports everything unreachable — at which point the recorded exception list looks complete for entirely
  the wrong reason.

### The isomorphic contract boundary

`tests/guards/meta/shared-contract-boundary.test.ts`. The contract replaced a package that could not
import the server half at all, so an empty walk reports the boundary intact while it is wide open —
hence the floor. `$lib/server` is deliberately absent from the forbidden-alias list as its own entry:
SvelteKit fails the BUILD, transitively, on any browser-reaching import of it, so naming it here would
duplicate a stronger check and rot quietly if the framework rule changed (and `$lib` matches it as a
prefix anyway). What no build step polices, and this does, is the contract depending on `$lib` (the UI
consuming it) or on `$app`/`$env` (a SvelteKit runtime the server half does not have). The
`$lib/contract/` carve-out requires the trailing SLASH, so the bare barrel `'$lib/contract'` still reds —
importing the index that re-exports you is a cycle, not a boundary crossing — and lookalikes
(`$lib/contract-helpers`) stay refused. Relative escapes (`../lib/`, `../../routes/`) are banned beside
the aliases because they resolve to the same modules.

### Deletion guards

A deletion is invisible to a behavioural suite: nothing imports a route, so a deleted mechanism can be
restored with the whole suite green. `tests/guards/hygiene/browse-screen.test.ts` is the shape — one test
per deleted mechanism, so a failure names which one came back, and the state behind the markup is banned
alongside the markup so it cannot be restored piecemeal. A ban is written in its GENERAL form where one
exists (no group is gated on a `show*` flag of any kind, so a fourth flag under a new name reds), and a
retired CSS selector is banned too, because dead CSS left behind is the residue the guard exists to red
on. Retired guard FILES are pinned absent, both at the address they occupied and as a sweep for the same
basename elsewhere, since a retired guard left in the suite is indistinguishable from one that works.

### Markup and wiring scans

- Slice from the OPENING tag (`<main`), not the literal `<main>`: an added attribute stops the bare-tag
  literal matching and every expectation is then compared against an empty string, silently.
- Count nesting when slicing a block. Stopping at the first `</div>` is correct only while the block has
  no nested element, which is a property of today's markup rather than of the claim.
- Find a gate BACKWARDS from its subject, not forwards from the top of the markup. A forward
  `indexOf('{#if hasSong}')` assumed the tools gate was the first such gate; a sibling gate appeared
  above it and the arm measured the wrong block.
- Assert ORDER by index rather than adjacency where a wrapper may sit between two elements, and assert
  position rather than mere presence where position is the claim: vaul sizes a snap-pointed sheet to its
  largest snap point and translates it DOWN, so what shows at the collapsed height is the TOP of the
  content and anything inserted above the band row silently becomes the collapsed face.
- A COUNT is the assertion where the failure mode is duplication. "The song is named" was never at risk;
  being named twice was, and a screen reader reads the whole dialog even when nothing on screen shows it
  twice. The same reasoning bans a second play/pause: two arrangements shipped a duplicate under two
  different labels, so a guard written against either literal would have passed through the other.
- Two mounts of an identical tree never produce equal markup (bits-ui and vaul mint per-instance ids), so
  compare an element COUNT plus rendered text, never `innerHTML`.
- A component's own measurement makes it a rung-L subject. `.band-slot` carries `bind:clientHeight`, so
  the sheet in `tests/guards/hygiene/hero-live-controls.test.ts` cannot be mounted at all — and the
  boundary is an ASSERTION rather than a paragraph, so a future Svelte or a drawer that stops measuring
  itself reds and sends the next reader to move the rendered claims home. The claim is that mounting is
  REFUSED and the refusal names the rung, not that it arrives through one particular API; a node count is
  NOT asserted, because a partial mount is what the rung produces and pinning a number pins the throw
  site rather than the boundary.
- A guard that reads production source for a literal-versus-token claim reads the COMMENT-STRIPPED text:
  a `44px` ban red on a rationale recording a measured symptom in an "844px viewport".

### Single-writer and single-source rules

- An inline custom property on `documentElement` outranks every stylesheet rule and outlives its writer,
  so a token like `--dock-h` has exactly one publisher, one measurement, and an `$effect` cleanup that
  removes it. A media query attempting to override it is silently defeated the moment the effect writes
  the real value — a rule that looks like it does something and does not. The measurement and the publish
  hop are counted separately, because a second of either forks the geometry the measurement keeps single.
- `?? null`, never `?? 0`, for a duration that may be unknown: zero silently understates a wait, which is
  the dishonest rendering the requirement exists to prevent.
- A restriction needs the thing it restricts TO. `data-vaul-no-drag` on the sheet body is only meaningful
  while a real vaul handle exists; asserting the restriction alone would assert nothing, and a vendored
  copy-in that renders a second decorative handle ships two stacked grab bars.
- Where a prop and an attribute express the same mechanism, BOTH directions are asserted — leaving the
  retired prop beside the live attribute makes one of them dead code that still reads as the mechanism.
- A fixture's absence is invisible to every runtime assertion in the suite, so the `/components` gallery
  is scanned as source: two `pending` rules shipped unreadable because nothing ever rendered them. Where
  a claim is about honest degradation, the gallery must carry the PAIR — "no minutes clause" is only
  judgeable against the clause it replaces.

## The design-system, a11y, motion and layout guards

### Motion

Enforced by `tests/guards/motion/motion.test.ts` over every `.svelte` and `.css` file under `src/`,
plus `tests/guards/motion/visualizer-motion.test.ts` for the canvas.

Only GPU-composited properties may animate. The allowlist is `COMPOSITED_PROPS`: `transform`,
`opacity`, `background`, `background-color`, `background-position`, `color`, `box-shadow`. It is an
allowlist, not a denylist, so `transition: all` and every layout-triggering property outside it
(`width`, `height`, `top`, `left`, `margin`, `max-height`, `inset`, `gap`, `flex-basis`, `font-size`)
reds without anyone having to enumerate it. Vendor prefixes are normalised in both directions:
`-webkit-transition: width` must red, `-webkit-transform` must not be condemned.

Every `animation:` declaration honours `prefers-reduced-motion`, one of two ways: declared inside
`@media (prefers-reduced-motion: no-preference)`, or paired with an **unconditional**
`@media (prefers-reduced-motion: reduce) { … animation: none }` reset. The reset must cover its own
selector (a reset for `.a` does not wave the file through) and must sit **later in source** than the
animation, because a media query adds no specificity and at equal specificity the later declaration
wins. A prelude carrying a `not`, or an extra `and (…)` term, is not coverage. A media query _list_
is an OR, so `(prefers-reduced-motion: no-preference), (min-width: 700px)` fires under Reduce Motion
on every TV. Under Reduce Motion a branch HALTS; it never merely shortens.

Inline motion can never honour the preference and is rejected outright — no `@media` wrapper or
reduce reset can reach it. That covers `style="animation: …"`, Svelte's `style:animation` /
`style:transition` directives in all four spellings, and the DOM style-object writes
`el.style.transition = …`, `el.style.webkitAnimation = …`, `el.style.setProperty('transition', …)`.

**Svelte's `transition:` / `in:` / `out:` / `animate:` directives are banned.** They compile to a
runtime-generated keyframes rule plus an inline `animation`, so the animated property list cannot be
recovered from the call site (`slide` animates height, padding, margin and border — none composited),
and the transition runtime never consults `prefers-reduced-motion`, so a directive runs at full
motion for a guest who asked for none. Toggle a class gated by the media query instead.

Utility classes are banned by NAME anywhere in `.svelte` or `.ts` source: `transition-all`, the
layout-hazard `transition-<key>` family, and `animate-*`. A class list puts no `transition:` anywhere
in source and is not a directive, so without the name ban the whole motion policy stops being
enforced rather than failing. An unresolvable `transition-*` key is an offender, not a skip. The
stock shadcn Button ships `transition-all`, which is what the name ban catches after any
`shadcn-svelte add --overwrite`.

Canvas motion is invisible to every CSS scan, so `VisualizerStage` is pinned separately: it must
consult `matchMedia('(prefers-reduced-motion: reduce)')` and render one still frame rather than
nothing — the room chose a background, and the preference is about movement.

### Tailwind v4 toolchain

`src/app.css` is the whole configuration (v4 CSS-first); there is no `tailwind.config.*`, and
`tests/guards/design-system/tailwind-toolchain.test.ts` walks the repo for one anyway so a
reintroduced v3-shape config is in scope rather than outside the guard's sight.

**Preflight stays out.** `src/app.css` imports `tailwindcss/theme.css layer(theme)` and
`tailwindcss/utilities.css layer(utilities)` only, and must not import `tailwindcss` or
`tailwindcss/preflight.css` — either brings the reset in. Cost of letting it in, measured by
`tests/e2e/probes/preflight-reset-audit.mjs`: 9,892 computed-value changes and 2,696 moved boxes
across 8 surfaces. Re-adding the import is a one-line change no other test would notice.

**Utilities are minted from one directory.** `utilities.css` carries `source(none)` and there is
exactly one `@source '../src/lib/components/ui/**/*.svelte'`. Auto-detection scanned the whole repo
and harvested 50 utilities from string literals in tests and markdown, two of which (`.underline`,
`.block`) collide with real `ball` marker classes; the first painted an underline on the lyrics ball.
The file-extension half of the glob matters as much as the directory half — scoped to the bare
directory, `.underline` was minted again out of `ui/README.md`, which names it in prose to warn about
it.

What that means for a component copied into `src/lib/components/ui/`: it is the only place a Tailwind
utility is emitted at all, so a utility written at a call site in a page is minted by nothing and
appears to do nothing. Appearance therefore moves INTO the vendored component rather than being
written where it is used. The corollary is enforced too: no class a copied-in component uses may also
be a semantic class the app applies to its own elements, since Tailwind would mint over it.

`@theme` registers **no player hue**. Registering a colour mints the whole utility family with no
per-family opt-out, so `--color-accent` hands out `text-accent` beside `bg-accent` — and ink and fill
differ for 13 of the 48 registry stops, so no single minted utility can respect the split. The ban is
by name (`--color-*` forwarding to a hue) and by value (a hex, `rgb()/hsl()/oklch()/lab()/color-mix()`,
a gradient, or a `var()` bridge to `--accent`, `--accent2`, `--grad`, any `--on-*` ink, `--fill-N`,
`--hue-N`, `--singer`). The _semantic_ layer (`--color-primary` and friends) is registered
deliberately so a vendored component works unedited; the ink direction is banned by class name
instead — `text-primary`, `text-secondary`, `text-destructive`, `text-muted`, `border-primary`,
`ring-primary`, `decoration-primary`, `caret-primary` in app source, with `lib/components/ui/**`
exempt by path (`tests/guards/design-system/shadcn-ink-ban.test.ts`). `--accent` as ink measures
3.85:1 on `--bg`, 3.38 on `--card`, 3.10 on `--card2` and 2.90 on `--card-tint2`: four AA failures.
`text-primary-foreground` is the legal pairing and must not be caught by a prefix match.

`@theme inline` is a **configuration input, not a place custom properties live**. Its keys are not
emitted into the stylesheet, so `var(--spacing-tap)` in a component resolves to nothing and paints
nothing. Bridge keys are deliberately near-homophones of the `:root` tokens they forward to
(`--spacing-sm` beside `--space-sm`, `--text-ph-sm` beside `--ph-text-sm`, `--duration-fast` beside
`--motion-fast`) because a bridge entry naming itself is a self-reference that resolves to nothing.
Each entry must forward to a real `:root` token and never to itself.

Inside `lib/components/ui/**`, a width/height/size utility must not use a **named scale key**.
Tailwind resolves `max-w-<key>` through the `--container-*` namespace, which this app does not bridge;
it then falls through to the SPACING namespace, which it does. `max-w-xs` emitted
`max-width: var(--space-xs)` — six pixels — and the alert dialog rendered as a strip with its text
overflowing both sides, past eslint, `svelte-check` and the whole suite. Arbitrary values
(`max-w-[26rem]`, `w-[calc(100vw-2*var(--space-4xl))]`), fractions and keywords resolve nothing
through a namespace and are always fine; numeric steps are judged by the tap floor instead. `tap` is
the one deliberately bridged key. `ui/README.md` is the committed file that keeps the directory alive
in a fresh clone — git does not track empty directories, and an empty `@source` scope emits no
utilities while looking exactly like a correct setup.

### Scoped-style reach

Svelte compiles `.x { }` in a component to `.x.svelte-<hash>` and puts that hash only on elements
**that file renders**. A class handed to a CHILD COMPONENT lands on an element the library renders,
which carries no hash, so the rule ships in the bundle and matches nothing:

    <SliderPrimitive.Root class={cn("encore-slider …")} />
    <style>.encore-slider { min-height: var(--tap); }</style>

Every settings slider lost its 44px tap floor that way. Nothing could see it: `svelte-check` does not
warn (the class IS used, inside a `cn()` string), and a guard reading rule TEXT finds the declaration
exactly where it expects it — a rule that exists and a rule that applies are different claims. Two
legitimate fixes: reach the element with `:global([data-slot='…'])`, shadcn's own contract and stable
across a re-vendor, or put the class on a plain element this file renders. `<svelte:element>` is an
element and does carry the hash, so a scoped rule on it is correct. The rule applies to app source as
well as the vendored tree — a page handing `class="name"` to `<Table.Cell>` has the same problem.

The reverse direction is guarded too, because the fix mechanism was itself unguarded: every
`data-slot` name styled via `:global` must be emitted by markup somewhere under `src/`. Deleting one
`data-slot="tabs-trigger"` attribute kills the tap floor, the active fill, the focus ring and the pill
radius at once, and every source scan stays green. Both directions live in
`tests/guards/design-system/ui-scoped-style-reach.test.ts`.

### Touch targets

`--tap` in `src/app.css` is the app's committed tap standard; `TAP` is parsed from it, and the guards
assert the token still sits at or above `TAP_FLOOR`. The number is WCAG 2.5.5 Target Size (Enhanced),
44×44 CSS px; SC 2.5.8 AA's 24×24 is the lower bar the settings gear failed at roughly 18px, with the
back link at ~26px and the readiness chips at ~30px.

- A phone control that sizes its own box must reach the floor, and must EXPRESS it as `var(--tap)`,
  never the number. Fifteen declarations across five files once spelled `44px` by hand, so raising the
  token would have moved the token and left every control behind, silently, with every guard green.
- Text-entry controls need an explicit floor: an `<input>` with no height sits at one text line (the
  search field measured 22px) and one sized by padding alone still lands short (`select` 41px). The
  floor goes on the INPUT, not the wrapper — the box around it is padding a finger near the edge
  misses. The checkbox/radio GLYPH and the range track are deliberately out of scope; their target is
  the wrapping `<label>` and the control's own box.
- Vendored controls are listed by hand. `markupControls` derives "is this a control?" from the file's
  own markup, and a shadcn component renders `<TabsPrimitive.Trigger>` — a component, so no `button`
  tag exists to find — while a `:global([data-slot='…'])` selector cleans down to nothing before the
  subject test looks at it. Moving the settings tabs' `min-height: var(--tap)` out of the page and
  into `ui/tabs` left a 38px pill passing the whole file.
- The registry's Button size axis is built for a 36px-default desktop UI: xs 24, sm 32, default 36,
  lg 40 — every stock size is under the floor, which is why `size="tap"` exists. No call site may ask
  for a size that PINS a fixed box under 44px, measured as `h-<n>` / `size-<n>` × 4px rather than by
  spelling. A size that pins no height (`blockLg`, padded with `--space-2xl`) grows with its content
  and is legal. `tests/guards/a11y/button-tap-floor.test.ts`.
- Form controls must not compute under 16px: iOS Safari zooms the page in when a focused input is
  smaller, and does not zoom back out. The check follows one `var()` hop to its `:root` declaration,
  so a ladder step retuned below 16px reds every control that names it.
- `/stats` makes every one of 31 trend days a real `<button>`, which at a phone's width sized each
  ~9px with five days under one fingertip. The column floors on `var(--tap)` with a grow-only flex
  basis and the chart scrolls horizontally rather than compressing; the card needs `min-width: 0` or
  the grid item sizes to the full scroll width and overflows the document instead.
- TV controls are outside the phone walk by design (a wall is not a phone in a hand), so `.fs-btn`
  floors its own clamp on `var(--tap)`: `clamp(var(--tap), 5.2vmin, 88px)` keeps the room's scaling
  and the binding.

### Contrast

`tests/guards/a11y/contrast.test.ts` computes ratios from the hex values in `src/app.css` using the
WCAG 2.x formula — sRGB channels linearised, luma-weighted, `(L1 + 0.05) / (L2 + 0.05)`. Floors:
**4.5:1** for body text (AA, normal size) and **3:1** for large text, icons, focus rings and other
non-text UI. It is a source scan because contrast is a property of the token values, so a browser
would add only flake.

- `--ink` and `--ink-dim` clear 4.5 on `bg`, `card`, `card2`, `card-tint`, `card-tint2`; `--ok`,
  `--warn`, `--danger` clear 4.5 as text on `card`; `--on-accent` clears 4.5 on `--accent`; `--focus`
  clears 3 on every surface a ring can land on; `--warn-bg` — the pending-card surface and the
  /metrics worker-down banner — carries `ink`, `ink-dim` and `warn` at 4.5 and every singer dot at 3.
- The accent fill is a **background** by design and nothing draws text in it. `color: var(--accent)`
  shipped on the /metrics "slowest processes" links at 3.38:1 on `--card`, because every other arm
  checked whether a pair was safe and none checked whether the pair was in USE.
- Every `outline` / `outline-color` that names a colour must name `var(--focus)`; a bare
  `outline: none|0|unset` draws no ring and is allowed. Rings once drawn in `--accent` (3.10:1 on
  `--card2`, against `--focus`'s 5.08:1) passed the token-pair arm untouched.
- `--grad` is decoration and never carries a label: white on its pink stop measures 2.84:1, under even
  the 3:1 non-text floor, and it shipped on every primary button for months. The wordmark's
  `-webkit-background-clip: text` + `color: transparent` is the one exemption — there the gradient IS
  the glyph fill. Per stop the registry certifies the two gradient ENDPOINTS only, and a label sits
  over the interpolated interior that nothing measures.
- These three scans read CSS REGIONS, not whole-file text. A vendored component puts Tailwind class
  names in a `<script>` string, where `outline-none select-none …` matched the declaration pattern and
  reported a whole variant map as a bad outline colour.
- **Ancestor opacity** is the case a token-pair comparison structurally cannot see. An `opacity` on a
  card ROOT flattens the entire subtree into one buffer and composites that buffer once against the
  page background, so the card surface underneath a glyph does not shield it: `--warn` on `--card` is
  9.99:1 as a pair and 3.77:1 through `opacity: 0.55`; `--ink-dim` 6.27 → 2.68; the singer identity
  dot 5.97 → 2.57, under the 3:1 floor the app itself refuses a stored singer colour for. The fix is
  not a bigger alpha: the minimum that rescues each pair is 0.619 / 0.807 / 0.620, visually
  indistinguishable from 1.0, so no alpha is both legible and a perceptible state signal. State goes
  on the SURFACE — background plus border — which composites nothing. Dimming a single leaf (an away
  dot, a disabled glyph) is the pattern this steers toward; a card root is not. The inline `style=`
  dimension is enforced in `tests/guards/layout/phone-inventory.test.ts`, since a CSS-rule scan cannot
  see an attribute.
- Singer dots are non-text UI: `isLegibleSingerColor` requires 3:1 against BOTH `--bg` and `--card`,
  and every wheel stop, every ring stop and every duet part colour has to clear it. Rejecting a colour
  on a lightness BAND instead would refuse the eight presets, which sit outside the wheel's band.

### Colour tokens and the 48-stop palette

- `src/lib/contract/presentation/player-palette-48.json` is generated, never hand-edited, and the
  generator READS `--bg` / `--card` / `--card2` out of `src/app.css`. Its figures were once generated
  against the mockup's surfaces, and six stops shipped `accent_ink` at 4.47–4.49 on the real `--card`.
  The guards recompute every ratio with production's own `contrastRatio` rather than trusting the
  recorded `r_*` fields, and one arm re-runs the generator and compares byte-for-byte.
- A fill and its ink are emitted as ONE pair. `--on-accent` is per stop — 36 dark, 12 white — so any
  site that assigns `--accent` must assign `--on-accent` in the same rule, inline `style="…"` or
  element. The `:root` seed must be one stop's `fill`/`on_fill`, not two independently chosen hexes.
- `--accent-ink` stays a distinct token: it differs from the fill for 13 stops, so collapsing the two
  downgrades those 13 to sub-AA text. It is deliberately NOT wired per stop yet — both read sites sit
  on `--card-tint2`, a surface the registry has never measured, where 16 of 48 stops fail AA.
- A colour reaches CSS as a custom property, never string-concatenated. `{me.color}30` appends hex
  alpha digits and works only because the eight presets happen to be 6-digit hex; a 3-digit hex, an
  `rgb()` or an `oklch()` makes the whole declaration invalid and the halo silently disappears. Pass
  the value as a property and derive with `color-mix()`, which accepts any colour syntax.
- No component hard-codes a value the palette already owns, in `#hex` or `rgb()/rgba()` form — the
  palette is rebuilt from `src/app.css` at run time, so adding a token starts enforcing it everywhere.
  Pure white and pure black are UNIVERSAL and exempt: `--on-accent` equals `#ffffff` only because the
  seeded stop's ink is white. A colour inside an SVG paint attribute is markup built as a `data:`
  string, where a custom property cannot resolve. The same duplication rule covers spacing, phone type
  sizes, line heights and motion durations; `z-index` is a total ban instead, because a bare integer
  is only meaningful relative to the other integers in its stacking context and the two ladders share
  values by design.

### Ten-foot stage scale

`tests/guards/layout/stage-scale.test.ts`. The TV is read from about three metres, not held at 40 cm.

- Type floor is 24px (1.5rem): no literal `rem`/`px` font-size below it under the TV tree, no px
  literal at all, and no per-token viewport term. The `.tv` root declaration
  `calc(max(2.7vh, 20px) * clamp(0.8, var(--ui-scale), 1.6))` is the single exemption — it IS the
  floor every `--tv-*` tier multiplies, and each tier is a bare rem multiple (smallest 0.93rem ≈ 27px
  at the 29.16px root). `em` is out of scope because it is relative to the parent, which is how the
  bouncing-ball dot is legitimately `0.5em` of the lyric it tracks.
- A phone token (`--ph-*`) on a TV surface is banned at ANY value, not thresholded. The phone ladder
  made `font-size: var(--ph-text-2xs)` an idiomatic, one-token, fully green way to write a 10.88px
  font on a wall, and the literal-scanning floor cannot see through a token. `--lh-*` is unitless and
  carries no distance, so it is surface-neutral and deliberately not banned — which is why the leading
  scale is not `--ph-`-prefixed.
- Overscan: many television sets still crop roughly 5% (≈54px vertically at 1080p), so nothing docks
  to an edge with a fixed pixel offset — use `var(--tv-safe-x|y)`. `0` is full-bleed and intentional,
  but a full-bleed container that paints a background must inset its content with the safe-area
  tokens, or the inset the content relies on is the padding nobody checked.
- The join QR grows with the panel: `--tv-qr` and `--tv-attract-qr` are vmin clamps, and a hero
  `<JoinBadge>` may not take a numeric `size`. Nothing constrained it before — a `size={320}` →
  `size={9999}` mutation survived the entire suite.
- `--tv-chrome-h` reserves a bottom band the lyrics reel yields to (`bottom: var(--tv-chrome-h)`,
  never `inset: 0` again), and the route overrides the token with the lower-third's MEASURED height
  through a ResizeObserver, because a static sum in `app.css` under-counted the card and re-broke on
  any added row.
- Reel colour states are one variable each, declared on `.lyrics` and read by the rules
  (`--reel-current`, `--reel-ahead`, `--reel-done`, `--reel-line`, `--reel-now`). The unverified
  provenance tint overrides VARIABLES only and never re-selects a word state: a descendant selector
  out-specified the word ladder and flattened sung and unsung words on every ASR song to one colour,
  while losing to the line treatments on source order in the other direction.
- Every `@media` width literal in source must be a declared `--bp-*` in `:root`; 320px (SC 1.4.10
  Reflow) is a declared member even though no rule branches at it.

### Phone inventories and reflow

`tests/guards/layout/phone-inventory.test.ts` and `tests/guards/layout/phone-reflow-rung-l.test.ts`.
The failure that ships is not a broken state — it is a state nobody designed, on a route nobody added
to a list. So the route set is derived from the filesystem and the exemptions are a closed, checked
list rather than an omission.

- Every non-exempt phone route renders a designed **empty, loading, error and offline** state.
  `/components`, `/admin`, `/metrics` and `/tv` are the only exemptions, and each must still resolve
  to a real route so a rename surfaces here instead of leaving the new surface unchecked. Absences are
  enumerated with a reason and a kind — `n/a` (the route structurally cannot reach the condition) or
  `gap` (it should and does not yet) — capped so the list can only shrink, and rot-checked: closing a
  gap REDS until its entry is deleted.
- Live regions are inventoried by file and purpose, and all are `polite` — an assertive queue
  announcement would talk over a guest mid-typing. An eighth region is as much a defect as a missing
  one, because the inventory IS the requirement. The first sync announces nothing.
- SC 1.4.4: no phone text is sized in an absolute unit, because `px` ignores the guest's text-size
  setting while `rem`/`em`/`%` scale with it. The two exemptions are icon GLYPH geometry inside a
  fixed `var(--tap)` box — a pointing-precision constant, not a reading measurement.
- SC 1.4.10 Reflow: no phone rule fixes a horizontal dimension above 320px. That arm is **necessary,
  not sufficient**, and measurably so: `/stats` overflowed a 320px viewport by 8px at 200% text while
  it was green, because the overflow was the SUM of two grid tracks plus two cards' padding against a
  word that cannot wrap. Addends that exist only after layout cannot be added up by a declaration
  scan. The real measurement is `tests/e2e/probes/p15-phone-reflow.mjs` — private Chromium, real
  server, 320 CSS px, root font-size 32px (200% of the 16px default, which is what a text-size
  setting scales; page zoom scales the viewport with it and cannot expose this class),
  `documentElement.scrollWidth` vs `clientWidth`, `exit 1` on a failure. A guard pins that the probe
  still exists, still drives the layout rung, still measures at those numbers, and still fails rather
  than reports.
- Grid tracks that must survive 200% text floor in a type-relative unit, never `px`, and use
  `repeat(auto-fit, …)` with a `min(100%, …)` bound — a px floor stops bounding anything once the word
  it holds doubles, and a fixed `1fr 1fr` cannot give way at all.
- A route page block mounts as a direct child of `.app-shell`, which is a centred
  `display: flex; flex-direction: column; margin: 0 auto` column. A flex item that sets a `max-width`
  with no inline auto margin is laid out at the cross-axis START, so the cap takes width off the right
  only and the block hangs left — `/stats` sat 187px left of centre at 1440px with a 360px void beside
  it. Cap the width if you like, but re-centre it with `margin-inline: auto`, plus `width: 100%`,
  because on a flex item a bare auto inline margin removes the stretch and collapses the block to
  content width.
- De-emphasis never uses subtree opacity, in a rule or in an inline `style=`. See
  [Contrast](#contrast) for the measurements.

### Vendored component seams

Each of these is a dependency that lives in a different file from the surface it holds up, which is
why it is pinned rather than commented.

- **`.card`** in `src/app.css` and its callers move together. Nine elements spelled `card` in the
  middle of a class list and lost their background, border and radius when the rule was deleted on the
  strength of a `class="card[ "]` grep. Callers are enumerated with why each is not a `<Card.Root>`,
  and the check reads the LAST declaration across every `.card` rule plus any higher-specificity or
  `!important` selector that could un-paint it.
- **`ui/field`**: the settings page renders `Field.Label` and `Field.Description` with no `Field` /
  `Field.Group` wrapper, and the registry's leaves carry no vertical margin — the wrapper owns the
  gap. Encore-added `:global([data-slot='field-label'])` margins inside the two leaf components are
  the only thing separating 50 controls, so deleting them (an obvious tidy-up, since a re-pull drops
  them) collapses the page with every gate green. Adopting the wrappers is the real fix.
- **`ui/drawer`**: the now-playing sheet is `modal={false}`, because its collapsed height is the
  docked band on every phone surface and a scrim plus focus trap would cover the page in use.
  `vaul-svelte` gates its overlay on exactly that flag, so the overlay can never mount — the render,
  its `fadeFromIndex`, and its fade CSS are all removed, and the sheet's own top border and surface
  are the only thing separating it from the page. Setting `modal={true}` later would ship a modal
  dialog with no scrim.
- **Drawer measure**: `.np-head` and `.np-body` are capped at the same `--max-w` and centred; the
  `.np-fit` wrapper carries no cap of its own. The head is rendered by a component, so its rule is
  `:global()` in a selector list — and a rule inserted between the two selectors silently took the
  head full-bleed above `--max-w`, invisible at every phone viewport the rendered gate drives.
- **The band's safe-area inset** stays inside the element `--dock-h` is measured from. Every other
  docked control offsets from `--dock-h` with no `env()` of its own, so moving the inset out of the
  measured box silently stops the toasts clearing the home indicator while the band still looks right.
- **`shadcn` Table** renders its own `overflow-x-auto` container at `w-full`, which absorbs the
  overflow the page's own `.scroller` is supposed to own — so the right-edge scroll shadow dies while
  the table still scrolls. The metrics page neutralises it with `overflow-x: visible; width: auto`,
  and a guard checks the vendored component still ships the wrapper so the neutralising rule is not
  guarding nothing.
- A `documentElement` custom-property write is app-global mutable state: an inline property on the
  root outranks every stylesheet rule, so each write needs exactly one writer and an `$effect`
  cleanup that `removeProperty`s it. `--dock-h` is written by the root layout, which wraps the TV too
  — and `/tv` mounts no band, so a stale value pads the stage by a phone band's height.

## The subsystem and wiring guards

These guards cover one subsystem each, plus a `wiring/` family whose whole subject is that two correct
halves are actually connected. Almost all of them are SOURCE SCANS: there is no jsdom or happy-dom under
`bun test`, so a Svelte effect's dependency set, a CSS custom-property indirection and a call-site census
are decidable from the component text and nowhere else. Every one blanks comments before scanning (blanking,
not deleting, so reported line numbers stay true) and names its subject from the repo root through
`@encore/test-support`, which throws naming the guard when a subject moves.

Two habits repeat and are worth stating once. A census or walk carries a non-vacuity floor, because an
empty offender list is what a working guard and a guard examining nothing both produce. And a census arm
carries a sentinel that reds if the protected construct is merely DELETED, because a census over zero sites
passes.

### Jobs

- `PIPELINE_JOB_TYPES` derives from an exhaustive `Record<JobType, true>`, never a `readonly JobType[]`
  literal: a job type missing from the list is a silently un-cancellable process.
  `tests/guards/subsystem-jobs/cancel-job-types-exhaustive.test.ts`.
- Attempt clocks are null, never 0, when the moment never happened. `audioSec` is stamped at assign but
  `startedAt` only at accept, so `realtimeFactor` returns null on a never-started attempt.
  `tests/guards/subsystem-jobs/attempts.test.ts`.
- Each retry is its own attempt row dated from the requeue, so a retry is not charged for the previous
  attempt's queue wait and every failure message survives.
- `stems-upgrade` does not inherit the triggering `processingId`, which keeps a long background upgrade out
  of a short process's end-to-end timing.
- A worker's reported facts overwrite what was dispatched; inapplicable fields stay null and sealed rows stay
  sealed. A repository with no ledger behaves identically.
- `AttemptLedger.allFinished` stays deleted in favour of `finishedSince` + `countFinished`: a public method on
  an exported class is invisible to the unused-export sweep, so the guard is what keeps it gone.

### Media

- A `MediaStore` member with no production caller is not a capability. `MediaStore.url()` was covered,
  exercised, green — and unreachable from the product, which a coverage number cannot distinguish. The guard
  reads CALL SITES driven off the interface declaration, and its ledger reds in both directions: a stale
  entry, and a name that was renamed away. `tests/guards/subsystem-media/store-members-have-production-callers.test.ts`.
- A media degrade boundary attributes its failure REASON, not just its value.
  `tests/guards/subsystem-media/media-degrade-attribution.test.ts`.
- `meta/<id>.json` is authoritative and the DB is a rebuildable index: the library must come back from the
  volume alone. `readSidecar` requires every section its consumers dereference, and a partial sidecar warns
  and returns null rather than throwing inside a boot pass. `tests/guards/subsystem-media/sidecar.test.ts`.
- Eviction only sticks via `clearArtifacts`: `sidecarFromMedia`'s `m.instrumentalRef ?? prev?.artifacts.instrumental`
  otherwise restores a just-deleted ref and re-derives `stemStatus: 'ready'`.
- A citation survives a sidecar round trip and a later re-parse through `keepCited`, and a low-confidence
  credit is gated out of the projected `Media` so an external lyrics lookup cannot tiebreak against a channel
  name.
- `guidePath` returns a mix or nothing. A `vocalsRef` alone is never a second audible path, because the
  two-decoder drift governor could only compare reported `currentTime` — which excludes each decoder's output
  latency — and converged on "aligned" while the room heard an offset. `tests/guards/subsystem-media/guide-mix.test.ts`.
- `GUIDE_MIX_EXT` is exactly `flac` and the key is `derived/stems/<id>-guidemix.flac`; a mismatch 404s on a
  file that exists.
- An absent guide-mix ref CLEARS the stored one, because a stems-upgrade overwrites both stem files in place
  and the backfill then marks the song settled. The hub reads `guideMix` off the declared `artifacts.stems`
  record, never a top-level `artifacts.guideMix`.
- Delete unlinks the sidecar FIRST, before audio and derived, because a rescan rebuilds the row from the
  sidecar. It removes queue entries for the media across all singers (there is no FK cascade), skips to the
  next entry when the playing song goes, re-broadcasts `nowplaying:changed` even for a non-playing delete, and
  publishes `queue:patch` only when entries were actually removed. `tests/guards/subsystem-media/delete.test.ts`.
- The raw original is unlinked at EVERY candidate extension, not just the `wav` default, because the worker
  globs for the real name. `derivedRefsFor` delegates stored-ref enumeration to retention's `derivedRefsOf`
  and keeps no rival copy.
- `safeMediaPath` rejects a leading `/`, traversal and NUL, and never serves `meta/` or the thumb cache; a
  worker-reported absolute path goes through `toRelativeKey`. `tests/guards/subsystem-media/layout.test.ts`.
- Worker-written directories (`audio`, `derived/stems`, `derived/lyrics`, `work`) are shared-write 0777 because
  core and worker run as different uids on one volume; `meta/` stays restrictive.
- The layout migration is idempotent, never clobbers a destination, skips one unmovable file rather than
  aborting, and COPIES when the source directory is read-only.
- Both sides of a tag filter narrow in SQL. `inArray(media.id, [])` compiles to `where false`, so "guarding"
  the empty case restores the whole-library read. `byTag` and `tagFacets` are `tag`-KIND only and READY-only,
  so a genre value never surfaces through them. `tests/guards/subsystem-media/library-tag-filter.test.ts`.

### Media retention

All in `tests/guards/subsystem-media/retention.test.ts`.

- Nothing unrecoverable is ever deleted: `audio/` and `meta/` are untouchable and only `derived/` is evictable.
- Pre-policy WAV stems are recompressed in place, never evicted, so the song stays singable. The encoder emits
  `-c:a flac` for a `.flac` destination and never AAC.
- A lossy stem is never "upgraded" to lossless — transcoding cannot recover what AAC discarded, so a codec
  upgrade means re-processing from raw audio.
- `planEviction` never evicts a protected id (the playing or queued song), and the exclusion lives inside
  `planEviction` so no caller can forget it.
- `derivedBytesOf` feeds `planEviction`'s cap comparison, so any undercount makes retention reclaim nothing on
  a volume genuinely over budget.
- The STORED `m.vocalsRef` is the only thing that counts an interim `.m4a` vocals stem, because both
  `vocalsKey` and the extension-blind `-instrumental.`-to-`-vocals.` swap derive `.flac`. That substitution
  exists exactly once in production source, in `src/lib/server/media/paths.ts`.
- `derivedRefsOf` enumerates every `m.lyricsCandidates` ref, not just `lyricsRef`, or the other N−1 JSONs are
  uncounted and orphaned forever. Raw caption tracks carry no ref on `Media`, so it enumerates the caption
  kinds against the known extensions instead.
- `evictDerived` counts bytes AFTER the unlink, and binds and logs the disposal error: `force` suppresses
  ENOENT only, so EACCES, EPERM, EROFS and EBUSY still throw.

### Shared

- `lyricsRank` convicts on `coverage`, never on `agreement`: a partial ASR baseline makes a correct authored
  lookup score low on the ranking axis by construction. `SUSPECT_COVERAGE` is 0.4, and `SUSPECT_AGREEMENT`
  stays deleted rather than re-valued because it measured a different axis.
  `tests/guards/subsystem-shared/lyrics.test.ts`.
- An unjudged candidate is never demoted, and a suspect text is still shown (rank 1, not 0) when it is the only
  one. `mergeLyricsCandidate` never worsens the pick and never lets a coarser later source displace existing
  word timings.
- `agreement` is count- and position-aware, NFKC-folds tokens, and abstains below `MIN_TOKENS_TO_COMPARE`. Its
  corpus is hand-computed and mirrors the worker's own, and keeps a multiplicity-only row that discriminates.
- `EntryStatus` is exactly `queued`/`playing`/`done` in both the union and the drizzle enum, and `isTerminal`
  is imported rather than re-declared. `tests/guards/subsystem-shared/entrystatus-members.test.ts`.
- `applyOp` and `applyAndReseq` are pure, which is what makes snapshot rollback total; `move` routes through
  `reorderWithinSinger`, which rewrites `addedAt`. `tests/guards/subsystem-shared/ops.test.ts`.
- The display-title rule `titleCanonical ?? title` lives only in `songDisplay`; the stats and metrics routes
  call it instead of re-implementing it, and the uploader is never shown as the artist.
  `tests/guards/subsystem-shared/song-display.test.ts`.

### Realtime

- `playback.currentEntryId` always resolves to a live queue entry or is null. Every auto-start gate is spelled
  `!currentEntryId`, so a dangling non-null id reads as "playing" and wedges the room.
  `tests/guards/subsystem-realtime/dangling-current-entry.test.ts`.
- The recovery predicate has exactly one home — `entryResolves(state.entries, state.playback.currentEntryId)`
  inside `reconcileOnReady` in `src/lib/server/realtime/player.ts`. The production entry `server.ts` must not
  re-derive it.
- `server.ts`'s `queue:command` arm calls `reconcileOnReady(deps)` unconditionally and strictly AFTER
  `handleQueueCommand`. Hoisted above it, the reconcile sees pre-mutation state and the defect reopens green.
- `reconcileOnReady` holds exactly one `emitNowPlaying(deps)`, outside its `if (!currentResolves)` block, so the
  unconditional call re-emits once and never double-broadcasts.
  `tests/guards/subsystem-realtime/nowplaying-after-queue-command.test.ts`.
- `nowplaying:changed` is the sole feed for the TV's up-next strip and the gapless preload slot, so every QUEUE
  mutation re-broadcasts it, not only a playback transition. A still-processing entry keeps its rotation slot but
  is never advertised as `upNext`.
- `reconcileOnReady` is called from exactly three non-boot sites; a boot reconcile is deliberately absent.
  `AuthoritativeState.hydrate()` self-heals a persisted dangling id to `currentEntryId: null, isPlaying: false`,
  which unjams the gates but starts nothing — recovery happens only at `queue:command`, `onMediaReady`, or a
  manual play.
- The play/pause gate is `!hasSong && !canStart`, derived from a `'queued'` entry existing. Narrowing it to
  `!hasSong` leaves a boot-healed room with no transport at all.
- `tv:telemetry` is a ~4 Hz hot path carrying only `positionSec`, `status` and an optional `entryId`;
  `durationSec` and `bufferedNextPct` exist nowhere in production. `TvTelemetry` carries only what
  `handleTelemetry` reads, and the wire `status` is reduced to `ended` at the forwarder.
  `tests/guards/subsystem-realtime/telemetry-frame-lean.test.ts`.
- The telemetry forwarder must stamp `entryId: evt.entryId`. `entryId` is optional, so an unstamped forward
  typechecks while silently making both stale-frame drops inert. The TV declares its own `TelemetryFrame` copy
  and stringifies the literal, so typecheck cannot see a field added to both — the producer is scanned directly.
- A telemetry frame whose `entryId` is not the current entry is dropped, position and `ended` alike; an id-less
  frame keeps legacy behaviour for an older TV. Ended telemetry marks the current entry done and prunes it, so a
  terminal entry does not linger. `tests/guards/subsystem-realtime/telemetry.test.ts`.
- Presence is three-state: losing the last socket makes a singer AWAY, never gone, and the expiry clock starts
  only once their last queued song drains. `connect()` cancels a running away clock outright, so a
  wake-and-relock inside one sweep interval gets a full fresh window.
  `tests/guards/subsystem-realtime/presence.test.ts`.
- `PresenceTracker`'s surface is exactly connect/disconnect/evaluate/forget/online/sockets/stateOf. Any
  `sockets > 0` membership predicate, under any name, is the locked-phone eviction bug. `syncEvent` carries both
  `online` and `away` when a membership dep is wired and omits both when it is not, so a mid-party client gets
  the roster from the handshake rather than an empty room.
- `queue_entries` enforces NOT NULL alone: `status` has no CHECK constraint (drizzle's `enum:` is compile-time
  only) and a non-finite `addedAt` persists, so the hub's add-arm guard is the only thing keeping the status
  value set honest. The allowed status set there is the bare literal `'queued'`; `enumValues` is read only to
  word the reject log. `tests/guards/subsystem-realtime/queue-column-enforcement.test.ts`.
- The server owns both `rotationSeq` and `addedAt` at the add seam. A client add frame mints all six
  `QueueEntry` fields and no non-schema fields.
  `tests/guards/subsystem-realtime/p5-process-lifecycle-add-fields.test.ts`.
- In the remove, move and move-to-index arms of `src/lib/server/realtime/hub.ts`, the `can('queue:*-any')` gate
  is enclosed by — or preceded by an early return from — the ownership comparison, so a future host-only
  capability can never refuse a singer their own song.
  `tests/guards/subsystem-realtime/queue-own-entry-ownership.test.ts`.
- Only a `page.mouse`-based gesture delivers a trusted event; a synthetic `el.click()` through `evaluate` grants
  no user activation and cannot unblock autoplay. `tests/guards/subsystem-realtime/e2e-real-gesture-verb.test.ts`.
- Processed-media count is not queued-turn count: a probe arm asserting "nothing playing" drains first — skip
  until `currentEntryId` is null — or it fires phantom failures.
  `tests/guards/subsystem-realtime/p4-transport-drain-last-song.test.ts`.

### TV

Transport, in `tests/guards/subsystem-tv/transport.test.ts`.

- The transport never plays an element that is not holding its own src: `play()` before the src assignment is
  undone by the media load algorithm, rejects with AbortError, and pins `currentTime` at 0 forever.
  `master.play().catch(() => {})` is banned, because swallowing that rejection hid the AbortError through two
  rounds of diagnosis.
- `hasSrc` compares an ENTRY-scoped `songToken` (`${entryId}|${src}`). `!!currentSrc` is stale-true across any
  change and a slot-holds-src comparison is stale-true across a same-song advance (the src is byte-identical),
  so only the token produces the idle-to-play value edge that re-runs a memoized `$derived`'s effect.
- `'idle'` is a distinct transport answer from `'pause'`: a src-less slot is left alone so it cannot fight the
  assign effect.
- The src decision reads `master.getAttribute('src')`, never a shadow copy, because assigning
  `HTMLMediaElement.src` reloads and resets `currentTime` to 0 even when byte-identical.
- `playable` is threaded into `nextVideoSrc`, and `currentSrc`/`currentEntryId` are written only inside
  `if (playable)` and in lockstep, so a `queue:sync` churn pass cannot clear a playing song's src or half-stale
  its token. Both shadows are also cleared in the element-unmount effect, which is a different clear from the
  not-playable churn pass — there the element is still bound.

Audio graph, in `tests/guards/subsystem-tv/guide-mix-graph.test.ts`,
`tests/guards/subsystem-tv/pitch-shift-graph-lifetime.test.ts`,
`tests/guards/subsystem-tv/master-level-normalization.test.ts` and
`tests/guards/subsystem-tv/guide-gain-after-transpose.test.ts`.

- `createMediaElementSource` is a PERMANENT capture that also bypasses the element's own `volume`, so at
  `keyShift === 0` there must be no AudioContext and no capture at all. The element is captured LAST, after
  every node that could throw, and a build interrupted by `detach()` closes its context rather than routing an
  orphan.
- Split mode routes channels 0/1 to the instrumental gain and 2/3 to the guide gain through two stereo
  ChannelMergers. One GainNode per pair sums to mono, and exchanging the mergers plays isolated vocals at full
  volume with no backing track.
- The chain is source, worklet, splitter. Bypassing the worklet silently kills the key control while leaving the
  guide audible, and nothing else in the suite moves.
- The guide gain defaults to 0 and the instrumental gain to 1, so a missed `setGuideGain` yields silence rather
  than vocals over the singer.
- `AudioWorklet` is secure-context only, so on a plain-HTTP LAN TV the graph still builds the splitter and
  reports `isShiftable: false` with `isDegraded: false`.
- `masterSrcPlan` withholds the four-channel mix src until the graph is routed AND split, because an un-routed
  element downmixes the mix to full-volume vocals. The attempt settles on failure too, and resets per song.
- Anything that builds a `PitchShiftGraph` must re-apply the level: `build()` writes the graph's own remembered
  gain into the GainNode and the level effect does not re-run on construction, so three sites carry it.
- The per-song reset uses `setShift(0)` and never `detach()`: detach cannot restore the native path, leaving a
  still-captured element feeding a disconnected node — a silent instrumental until someone transposes.
- The element-unmount effect both detaches the master graph and clears the reference. Keeping it leaves the
  build site's `!masterGraph` guard false forever and the next song is never captured.
- `effectiveMasterLevel` is `$derived` clamped to [0,1]: attenuate-only, never a boost.

Playhead, in `tests/guards/subsystem-tv/playhead-isolation.test.ts`,
`tests/guards/subsystem-tv/playhead-sync.test.ts` and `tests/guards/subsystem-tv/tv-reload-resume.test.ts`.

- The seek effect tracks only `seekSec` and `seekRev`; `media`, playability, the elements and `active` are read
  through `untrack`, because an input to the decision must never be a trigger for it. `applySeek` is a plain
  function, not a second `$effect`, so the dependency set belongs to the one calling effect.
- `seekRev` is a tracked revision counter because a restart writes 0 over 0, which `$state`'s strict `===` never
  notifies. `seekPlan` treats `target === 0` as a real rewind, and holds on any non-finite value because a NaN
  reaching `currentTime` throws.
- There is exactly one media element and one graph. The drift governor stays deleted because it compared
  reported `currentTime`, which excludes each decoder's output latency, so it read "aligned" while the ear heard
  an offset.
- `mergeCatalog` preserves object identity for unchanged songs and returns the same Map when nothing changed.
  The route has exactly one catalog writer, and the `media:status` handler writes no catalog and invents no
  `stemStatus`.
- `TvPlayer` takes a `PlaybackSnapshot` only. The live `Media` type must not re-enter the component in any
  import spelling — braced, aliased, default, namespace, local re-declaration or inline — because the braces in
  `import type { Media } from '…'` sit between the two words a naive ban would look for.
- The cold-mount resume is held only when there is no element, taken once on the master's `canplay`, then
  cleared: `canplay` fires on every readyState rise, so an unconditional hold survives a declined seek and
  rewinds the song. `applySeek`'s resume counterpart early-returns on the inactive or non-playable slot, or the
  hidden pre-warm element parks at the outgoing song's position and corrupts the room position on advance.

Screen, lyrics and overlays.

- `lyricsAdvancing` takes the master element's own play/pause as its fourth input: `isPlaying` is the server's
  intent, and passing it again would gate itself and sweep the reel over a silent stage.
  `tests/guards/subsystem-tv/screen.test.ts`.
- `applyNowPlaying` resets `positionSec`/`durationSec` only inside `if (entryChanged)`, compared on the ENTRY id
  before `current` is overwritten, because the server re-emits nowplaying at the tail of every player command.
  `tests/guards/subsystem-tv/lyrics-anchor-reset.test.ts`.
- The lyrics reel cap is exactly `calc(100vh - var(--tv-chrome-h))`. `--tv-chrome-h` already contains one
  `--tv-safe-y`, so a second subtraction clips a lookahead row mid-glyph.
  `tests/guards/subsystem-tv/lyrics-reel-cap.test.ts`.
- Both the reel and the lower third carry `-webkit-text-stroke` in `var(--scrim-strong)` with
  `paint-order: stroke fill`, and that stroke composited over white must clear 4.5:1.
  `tests/guards/subsystem-tv/lyrics-stroke.test.ts`, `tests/guards/subsystem-tv/lower-third-stroke.test.ts`.
- `resolveLyricsPresentation` is called with the chosen candidate's own `timing`, because its unknown case is
  permissive: a dropped argument silently restores the pre-fix behaviour without failing any other test.
  `tests/guards/subsystem-tv/lyrics-clamp.test.ts`.
- TV paint tiers are background 0, video 1, video-active 2, screen 5, reel 6, card 7, interstitial 8, status 9,
  affordance 10. `position: absolute` is load-bearing on every full-screen overlay, because `inset` and
  `z-index` are both inert on a statically-positioned box.
- The autoplay gesture listener is armed UNCONDITIONALLY. Gating it on the blocked latch means a TV whose
  autoplay succeeded never has a listener, so its AudioContext can never be resumed and every key press degrades
  silently. The `play()` nudge is latch-gated inside the handler instead, and the hint is gated on
  `autoplayBlocked && !isAttract` so it cannot outlive the room.
  `tests/guards/subsystem-tv/autoplay-recovery.test.ts`.
- `toggleFullscreen` gates on `document.fullscreenElement` so one control serves both directions, and every
  fullscreen path is anchored to a real gesture (transient user activation). The fullscreen button and the
  during-playback corner join badge share the card tier, so their resolved anchors must differ.
  `tests/guards/subsystem-tv/fullscreen-affordance.test.ts`.
- The unreachable-join notice never replaces the QR and carries no surface, border or width cap: a `ch` cap
  freezes against the `:root` 16px while the TV type scales. Its class names are contract for the e2e probes.
  `tests/guards/subsystem-tv/badqr-wrap.test.ts`.
- The wake lock requests `'screen'`, is feature-detect guarded (secure-context only, so inert on a plain-HTTP
  LAN), gated on playing and not attract, released in the effect cleanup, and re-acquired from a
  `visibilitychange` handler that both checks visibility and re-acquires.
  `tests/guards/subsystem-tv/wake-lock.test.ts`.
- The lobby's copy distinguishes "nothing picked" from "picked but still processing", because the lobby state
  covers both, and sources its wording from the shared `processStageLabel`.
  `tests/guards/subsystem-tv/lobby-copy.test.ts`. The ratified TV states themselves are pinned in
  `tests/guards/subsystem-tv/tv-ratified-states.test.ts`.
- The TV realtime channel goes through the shared `WsClient` — heartbeat, liveness watchdog, capped backoff,
  lifecycle rebinding — with no bespoke socket, and its URL forwards the encoded room code.
  `tests/guards/subsystem-tv/ws-through-wsclient.test.ts`, `tests/guards/subsystem-tv/tv-ws-room-binding.test.ts`.

### Wiring

- `src/lib/server/capabilities.ts` is the one place that answers "is this actor allowed to do that?", so gating
  a capability later is an edit there and nowhere else. The defect class is a MISSING CALL SITE, which is
  decidable from source. `tests/guards/wiring/capability-wiring.test.ts`.
- A capability gate is checked ARM-SCOPED: a whole-body match survives swapping capability strings between arms.
  The arm slicer fails loudly without a following `case`/`default` label, or the last arm degrades to a
  whole-body scan.
- A capability gate's consequent must return a STRING. `validateCommand` treats `return null` as "valid", so a
  `return null` gate approves on denial.
- Room isolation is only real once it is wired into the WS layer, across four seams that each alone reopen the
  gap: the upgrade captures the room scope onto the socket, `websocket.open` subscribes via
  `subscribeTopicFor`, the broadcast sink publishes via `broadcastTopicFor`, and the client message switch
  refuses a foreign-room socket before hello or mutate. `tests/guards/wiring/room-scope-wiring.test.ts`,
  `tests/guards/wiring/room-identity-wiring.test.ts`.
- That foreign-room refusal is an early `return` before `switch (evt.type)`; a `break` there is an illegal
  cross-function jump that stops the entry parsing at all. The guard therefore parse-checks the production entry
  from raw bytes, because nothing else in `bun test` or the SvelteKit build parses it.
- A legacy row with a lyrics artifact and no `lyricsStatus` IS ready. Narrowing the lyrics gate to
  `lyricsStatus === 'ready'` makes every pre-upgrade song unsingable forever.
  `tests/guards/wiring/gates.test.ts`.
- The stems and lyrics gates key on artifact PRESENCE, not data: an all-null song profile still finishes the
  gate, because the re-process check reads `hasInstrumental` and would never retry.
- `readyToSing` and `isPlayable` are different questions and stay apart; folding lyrics into the file-level
  check re-processes every song lacking them. `src/lib/contract/queue/gates.ts` holds no guest-facing process
  copy, because `src/lib/phrasing/process-phrasing.ts` is the one vocabulary.
- Gate settlement is one table, `GATE_SETTLEMENT`, never a per-job-type `if` chain in either reader. Boot
  housekeeping runs synchronously ahead of `bootTasks`, inside a try/catch.
  `tests/guards/wiring/gate-reconcile-boot-wiring.test.ts`.
- A multi-dependency wiring is pinned by ONE anchored regex over the whole call: an unanchored substring scan
  matches unrelated sites and passes on a type-valid partial.
  `tests/guards/wiring/reprioritize-process-wiring.test.ts`, `tests/guards/wiring/reaper-onfailed-wiring.test.ts`.
- The worker-frame validator is a reject gate whose NON-NULL result returns, and it precedes both the
  `'workerId' in msg` read and the hub handoff. `tests/guards/wiring/worker-frame-gate-wiring.test.ts`.
- `#onReject` passes `'REJECT'` explicitly, because `requeue` defaults to `'LEASE_EXPIRED'` and omission
  collapses the distinction green. `tests/guards/wiring/reject-event-wiring.test.ts`.
- `planEviction` receives a third `protectedIds` argument built from the queued media ids plus the playing
  entry's; the two-argument default protects nothing. `clearArtifacts` runs AFTER the upsert whose sink would
  otherwise restore evicted refs. `tests/guards/wiring/retention-protectedids-wiring.test.ts`.
- Failed-process scars are re-applied after `queue:sync` rebuilds the catalog, and `mergeMissingMedia` is
  gap-fill only. The held scar list is a FIELD outliving `connect()`, because the room link never remounts.
  `tests/guards/wiring/failed-process-scar-wiring.test.ts`.
- `Bun.spawn(` appears in exactly one production file, `src/lib/server/media/spawn-capture.ts`: `tsc` cannot see
  a bypass of a global. A bare `catch {` is banned at both external-fetcher exits — the error must be bound and
  warned. `tests/guards/wiring/ytdlp-spawn-boundary.test.ts`.
- Process bars scale by `overallProcessPct`, never the raw per-step `pct`, and the label rounds while the
  transform does not. Call-site populations are WALKED, not named, so the next route to grow the surface is
  covered; the component gallery is excluded as the fixture that deliberately demos the offender shape.
  `tests/guards/wiring/process-bar-wiring.test.ts`, `tests/guards/wiring/processing-group-query-scope-wiring.test.ts`.
- `/api/library` reads tags with kind `'tag'`, because `tagsOf` defaults to `'genre'` and an omitted kind returns
  nothing. The tag filter narrows through the indexed `byTag`, never a client-side filter over the payload.
  `tests/guards/wiring/library-tags-route-wiring.test.ts`, `tests/guards/wiring/library-tag-filter-wiring.test.ts`,
  `tests/guards/wiring/library-tags-page-wiring.test.ts`.
- Fuzz invariants skip on a gestureless autoplay refusal BEFORE computing the cue, keyed on the decoder's
  preload floor rather than `currentTime === 0`.
  `tests/guards/wiring/fuzz-i4-autoplay-refusal-skip.test.ts`,
  `tests/guards/wiring/fuzz-gestureless-tap-and-honest-i6.test.ts`.
- The measured-design gate has no `process.exit(2)` skip path: exit 2 read as a pass is how an unchecked claim
  reports as checked. Its quarantine and retirement entries need a substantive reason and at least two match
  fields, and the measurement must be below the floor. Control sets derive from roles and element types, never a
  class allowlist. `tests/guards/wiring/measured-design-gate.test.ts`,
  `tests/guards/wiring/e2e-probe-add-frame-fields.test.ts`.
- The `ProcessState` union member `'not-processable'` is pinned by scan because nothing forces it: there is no
  `Record<ProcessState, …>` and no exhaustive `switch`, so deleting it typechecks clean while every consumer
  falls through its `if (state === …)` chain. The source comparison it replaced is banned by SHAPE, under any
  variable name, because a rule enforced beside the code that acts on it is invisible to the layer deciding
  whether to act. `tests/guards/wiring/spotify-not-processable-wiring.test.ts`.
- The duet part colour LAYERS OVER the singer colour, which layers over the room accent: `--reel-part` defaults
  to `--reel-singer` and both highlight treatments read `--reel-part`. On an undiarized song no line carries a
  part, so `--reel-part` is never written and the fallback is reached by ABSENCE, mirroring the worker. The
  provenance override touches `--reel-line` only, so an auto-transcribed duet still carries the part colour on
  the word being sung. `tests/guards/wiring/lyrics-duet-part-wiring.test.ts`.
- `/components` is dev-gated with `$app/environment`'s `dev` plus `error(404)`, and stays on disk because
  several guards read it as a fixture source. `tests/guards/wiring/dev-only-routes.test.ts`.
- Joining is gated on settings; `tests/guards/wiring/settings-join-gate.test.ts` and
  `tests/guards/wiring/spotify-wiring.test.ts` pin the two seams that are otherwise type-valid when disconnected.

### Wiring single source

- Readiness is defined ONCE for the whole browse block. `byArtist`, `artistFacets` and `tagFacets` asked the SQL
  narrowing directly and so revealed and counted mid-align songs that `listReady` and `byTag` hid. A second
  `stemStatus`-versus-`'ready'` comparison and a second `readyToSing` call are both banned, and the ban's
  ceiling — a re-derivation naming only artifact columns — is asserted against fixtures, so raising the floor
  moves an assertion rather than leaving stale prose. Facet counts are never taken in SQL, because a SQL count
  cannot consult the gate. `tests/guards/wiring/browse-ready-parity.test.ts`.
- `src/lib/server/realtime/player.ts` solely owns the recovery predicate and the `nowplaying:changed` payload;
  the production entry must re-derive neither. The census counts owning FILES, not occurrences, because the
  owner names the literal twice legitimately. `ws.send(JSON.stringify(...))` accepts anything, so this seam is
  invisible to `tsc` when an event variant gains a field. `tests/guards/wiring/nowplaying-single-source.test.ts`.
- `orderingOf(deps)` in `src/lib/server/realtime/hub.ts` is the one place that decides what the server considers
  the current ordering; a second source is how the server picks a different next song than the queue every
  client is looking at. A hand-built `lastSungAt` literal and a `singHistoryFrom` call at the composition root
  are both banned. Do NOT relax this into "the two literals produce equal values", which pins the duplication
  instead of banning it. `tests/guards/wiring/ordering-single-source.test.ts`.
- The `/metrics` formatters are single-sourced in `src/lib/metrics-format.ts` and `src/lib/clock.ts`. Both drifts
  were template literals over a `number`, invisible to `tsc`.
  `tests/guards/wiring/metrics-format-single-source.test.ts`.
- The per-song ephemeral reset is named in one `EPHEMERAL_RESET` const and SPREAD at every song-start site.
  Re-typed per site, 7 of 16 field-by-site pairs dropped silently. The site set is DERIVED from the code — every
  `setPlayback` call that changes `currentEntryId` — because a floor on the spread count stays satisfied by the
  existing spreads while a newly-added site leaks. `tests/guards/wiring/ephemeral-reset-single-source.test.ts`.

### Wiring routes

- Every HTTP route's auth posture is recorded per METHOD in a CLOSED registry: a method with no entry fails, and
  a stale entry fails too. Deleting the gate on the hard-delete endpoint reddened nothing before this existed,
  and `tests/guards/wiring/capability-wiring.test.ts` reads like the guard for it and is not — that one scans the
  websocket seam, which holds no route path. `tests/guards/wiring/route-auth-posture.test.ts`.
- `postureOf` ranks a capability gate above a bare session check, so a capability gate cannot be quietly deleted
  under a `session` record.

### Docs prose

Six guards assert that PROSE elsewhere in the tree says something true. They are the most fragile guards in the
repo, so they are written to a shape: a BAN plus a short positive anchor, never a pinned sentence. A `not.toMatch`
survives any reword; a positive arm is a few words or a regex alternation, and sits beside a behavioural arm on
the same claim so the code half reds even when the wording changes. A prose guard that pins a whole sentence reds
on every reword and gets deleted within a week, which is worse than not having it.

- Every `src/`, `worker/` or `tests/` path in a document must be a file `git ls-files` tracks. A line may name a
  path that does not exist yet only if the line itself says so. The prefix list is the guard's whole reach: a
  tree rename that falls outside it turns the guard green while every citation rots, which has happened.
  `tests/guards/docs/cited-paths-resolve.test.ts`.
- Inside `src/lib/contract/`, a comment that writes an identifier followed by "in foo.ts" must name the file
  whose CODE holds it. Comment stripping is INVERTED: the source side is read as comment text and the target side
  is comment-stripped, so a target's own prose about a symbol it no longer owns cannot satisfy a claim about its
  code. A cited basename found anywhere else in the repo is a cross-tree reference and out of remit; one found
  nowhere fails. The basename index walks the whole repo root rather than a list of tree names, because a stale
  list makes the set empty and every cross-tree pointer read as stale.
  `tests/guards/docs/doc-pointer-accuracy.test.ts`.
- No comment may cite `src/lib/tv/pitch-shift.ts` by LINE NUMBER, and no comment may name a `PitchShiftGraph`
  member the class lacks. Members are read from `export class PitchShiftGraph` onwards so the worklet source
  string defined above it cannot contribute names. `tests/guards/docs/pitch-shift-doc-accuracy.test.ts`.
- `/api/leave` answers at the directory, never at a sub-route: the comments may not name a `preview` sub-route,
  and every `/api/leave` path they do name must have a `+server.ts` on disk.
  `tests/guards/docs/doc-accuracy.test.ts`.
- `fetcherFor('spotify')` returns the DEFAULT fetcher, `needsFetch('spotify')` is true, and a Spotify ref
  resolves to a YouTube watch URL. The refusal belongs to `isProcessableSource`. No comment may pair
  `fetcherFor` with a refusal verb inside an 80-character window unless that window denies the pairing or
  attributes it to `isProcessableSource` — banning the words outright would push the next author into vagueness,
  and vagueness is what let a reader believe the enforcement existed. No comment may claim a Spotify hit is not
  materialised into a queueable media, because `/api/search` materialises every hit.
  `tests/guards/docs/spotify-enforcement-prose.test.ts`.
- Lyrics agreement has two axes. `agreement` is a RANKING score with no threshold applied to it; `coverage` is
  BASELINE COVERAGE and is the only axis `isLikelyWrongSong` thresholds. Documenting it the other way round
  convicts a CORRECT candidate graded against a partial baseline as another song. The guard reads the doc block
  ATTACHED to each symbol — nothing but whitespace between block and declaration — so the same words elsewhere in
  the file cannot satisfy it. `tests/guards/docs/wrong-song-axis-prose.test.ts`.
- Byte-length floors in these guards are non-vacuity sentinels against an empty read, not measurements of how
  much prose a file ought to carry. They are lowered to whatever the current files support whenever the prose
  legitimately shrinks.

### Cross-language parity

All in `tests/guards/docs/vocabulary-parity.test.ts`, which reads the Python as TEXT so it needs no interpreter
and reds inside the ordinary `bun test` gate. The worker cannot import `$lib/contract`, so every shared enum,
artifact key, path builder and threshold exists twice, and the worker's pytest and the core's bun test each
assert only their own side.

- `JobType`, the ASR checkpoints, sync modes, separator engines, fetchers, lyrics text sources and timing tiers
  all equal their `worker/src/vocabulary.py` enum. A bare TS union has no runtime value to import, so the members
  are listed and an `_exhaustive` assignment makes TypeScript check the list IS the union.
- Every `JobType`'s `requiredCapability` must be advertisable. The last branch of that function is a bare
  `return jobType`, so `align` and `stems-upgrade` fall through it and appear in neither capability table:
  enumerating the tables misses them, and `src/lib/server/jobs/dispatch.ts` compares by raw
  `capabilities.includes`, so a typo parks the job forever rather than failing loudly.
- `worker/src/protocol.py` groups its frame-name constants under `# worker -> core` and `# core -> worker`
  COMMENTS. Those comments are load-bearing data, not prose — the parse uses them as section delimiters and
  throws without them. Reading the whole file instead would conflate the two unions and let a verb move sides
  unnoticed.
- Worker `Stage` values are a SUBSET of `MediaStatus`, not equal to it: `queued`, `ready`, `failed` and
  `canceled` are core-side states no worker emits.
- `songProfile` is a SIBLING of `stems` in the artifacts dict. Read one level deeper it arrives undefined, and
  because the stems gate requires the profile to be PRESENT every separated song then sits at "Separating
  vocals" forever with nothing retrying it. Its INNER fields are mirrored three ways — the Python dict, the
  erased TS interface declaration, and the runtime keys of `EMPTY_SONG_PROFILE` — because the dict and the
  literal can agree while the declaration disagrees, and `normalizeSongProfile` silently drops a field it does
  not know.
- An artifact key any `worker/src/steps` module writes must be declared in `JobArtifacts`
  (`src/lib/contract/core/events.ts`); written, undeclared and unread is the drift that stalled processes twice.
- The stem extensions and key builders agree byte-for-byte across
  `src/lib/server/media/paths.ts` and `worker/src/processor.py`. A mismatch is silent — the file exists and the
  player 404s — and worse than a 404, because retention then builds a key for a file that is not there and never
  reclaims the disk.
- `SILENCE_FLOOR_DB` is one physical constant declared on both sides. The comparison is NUMERIC, because the
  literals are spelled differently on purpose: the Python side keeps a float so its `<=` never mixes types, and a
  string compare would red on a correct tree. Both sides must still COMPARE against it, or the two numbers stay
  in agreement while the code stops reading them.
- The worker ML keepalive must sit under HALF the core progress lease, not merely under it, so one dropped
  keepalive cannot breach. The same half-lease bound applies to the `heartbeatIntervalSec` the core advertises in
  the welcome handshake, since a worker that honours it paces its progress by it. The advertised value is
  recomputed from the divisor literals the source applies rather than by re-evaluating its expression.
- `DEMUCS_MODELS` in `worker/src/separation/demucs.py` equals the demucs engine's offered model ids in BOTH
  directions: a model selectable in room settings that the worker rejects parks every process on a non-retryable
  error, and a worker checkpoint no UI offers is dead config. The roformer token-to-checkpoint mapping DIVERGES
  on purpose and is pinned as it is, so repointing it has to come here and say so.
- Every Python table is parsed COLUMN-0 ANCHORED. Unanchored, a `#`-commented copy of a correct table parked
  above a live wrong one is the first match and grants a false exemption on the exact drift being guarded. For
  the same reason a module-level constant is read from its LAST assignment: Python's effective value is the last
  one executed.
