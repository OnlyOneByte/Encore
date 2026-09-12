# 06 — Shared component layer requirements

Area prefix `XR-CMP`. Scope: `apps/core/src/lib/components` — **11 app-level components** at the
directory root and **19 vendored shadcn-svelte primitives** under `ui/`, 93 source files in all.
Surfaces column uses **Phone**, **TV**, **Ops**, **Build**.

These rows specify the **component contract**: which props exist and what shape they take, which
component owns a decision versus taking it from a caller, where a vendored primitive ends and an
app-level wrapper begins, what an accessible name is and who supplies it, and what a component must
not reach for. They do **not** re-open the library choice (copy-in shadcn-svelte over a headless
dependency, `docs/DECISIONS.md`) and they do not restate the colour rows — see *What these rows
deliberately do not cover* at the end, which names each `XR-COL` and `XR-PH` row this section stops
short of.

`ui/README.md` is the substrate. It is unusually good and it already states five constraints as
prose — the copy-in target's colour bridge, the scoped-style reach failure, the single Tailwind
`@source`, the motion ban, and Preflight staying off. **Where it states a rule, these rows make it
checkable rather than restating it**; where it states a rule that the app-level half of the same
directory then breaks, the row says so and cites both sides.

Three findings that came out of reading the code and are load-bearing for the rows below:

- **The premise "zero requirement coverage" is not quite right, and the way it is wrong matters.**
  The component files are already dense with `XR-PH` and `XR-COL` references — `QueueRow.svelte`
  alone cites `XR-PH-03`, `XR-PH-10`, `XR-PH-17`, `XR-PH-18`, `XR-PH-19` and `XR-PH-20` in its own
  prop documentation. What has no coverage is not the components; it is the **contract** — nothing
  anywhere says who may declare a variant, who owns an accessible name, or what a component may
  import. So the gap is real, but it is a gap in a layer that is otherwise heavily specified, and a
  row that reads as a near-duplicate of an `XR-PH` row is waste rather than coverage.

- **The vendored tree is already a clean leaf, and nothing holds it there.** No file under `ui/`
  imports an app module, a route, or `$shared` — verified by scan, zero hits. That is the
  precondition for `shadcn-svelte add <x> --overwrite` being safe, which `ui/README.md:119–121` names
  as the reason the deviation headers exist at all. It holds today by care alone.

- **`data-slot` is now three things at once, and one of them is app state.** It is shadcn's element
  identity, it is what nine of the vendored components' `:global()` rules key on, it is what
  `ui-scoped-style-reach-913.test.ts:367` enumerates — and at `apps/core/src/routes/+page.svelte:1407`
  the reorder mode writes a bare integer into the same attribute, which
  `apps/core/src/routes/+page.svelte:894` then reads back by `closest('[data-slot]')`. See
  `XR-CMP-09`; this is the sharpest thing in this section.

---

## Group 1 — The boundary between a vendored primitive and an app-level wrapper

### XR-CMP-01 — The vendored tree is a leaf, and imports only downward

| | |
|---|---|
| **Statement** | No file under `apps/core/src/lib/components/ui/` imports an app-level component, a route, a store, `$shared`, `$app/*` or `$env/*`. Its only permitted imports are `bits-ui` and other third-party packages, `svelte`/`svelte/elements`, `$lib/utils.js`, and other files under `ui/`. |
| **Surfaces** | Build |
| **Rationale** | `shadcn-svelte add <x> --overwrite` overwrites a file wholesale. A vendored component that imports app code cannot be re-vendored without re-deriving that import from a diff, which is exactly the review the deviation headers exist to make possible — and the moment one primitive reaches for `SINGER_COLORS`, the copy-in model stops being a copy-in model. |
| **Source** | State is a real citation and holds today: a scan of `ui/**` for `$lib/` imports returns `$lib/utils.js` and nothing else, and for `$shared` returns zero. The **rule** is `DERIVED` — model: the `--overwrite` reviewability contract stated at `apps/core/src/lib/components/ui/README.md:119–121` ("record **why** in an `ENCORE DEVIATIONS` HTML comment … They are what makes an `--overwrite` reviewable"), read as a constraint on the import graph rather than only on comments. |
| **Acceptance** | Given every `.svelte` and `.ts` file under `ui/`, When its import specifiers are collected, Then each is a bare third-party package, `svelte`/`svelte/elements`, `$lib/utils.js`, or a relative path that stays inside `ui/`. Falsified by one primitive importing `$shared`, a store, or a sibling app-level component. |
| **Check** | Source scan over import statements — the parser in `tests/guards/meta/test-tree-deps.test.ts:38–47` already extracts specifiers in exactly this shape and can be reused, but it is pointed at the test tree's external dependencies and does not check direction. **The guard does not exist yet**; it would be a new file, `tests/guards/design-system/ui-layer-imports.test.ts`. Needs a non-vacuity floor on the file count, per `XR-COL-19`. |
| **Priority** | Must. It is free today — the tree is already clean — and it stops being free the first time someone wants a player colour inside a vendored swatch. |

### XR-CMP-02 — Every vendored component declares its deviations in one findable form

| | |
|---|---|
| **Statement** | Every component under `ui/` carries a deviations block in **one** spelling, positioned so a single scan finds all of them, and each numbered item in it names the test that enforces it. A component with no deviations says so explicitly rather than carrying no block. |
| **Surfaces** | Build |
| **Rationale** | The block is the diff to re-apply after `add --overwrite`, so a block a scan cannot find is a block an upgrade silently reverts. Today there are **two** spellings: 18 components open with an `ENCORE DEVIATIONS` HTML comment, and `button/` uses `DEVIATIONS FROM REGISTRY OUTPUT` inside a `<script module>` block — so a grep for the mandated header misses precisely the component with the most thorough content. |
| **Source** | `apps/core/src/lib/components/ui/README.md:119–122` (the mandate, and its own record that `button/` is the exception a grep misses); the two spellings at `apps/core/src/lib/components/ui/button/button.svelte:3` and `apps/core/src/lib/components/ui/badge/badge.svelte:2`. |
| **Acceptance** | Given the 19 component directories under `ui/`, When each is scanned for a deviations block, Then exactly one spelling matches in every one of them, and the count of matches equals the count of components. Falsified today by `button/`, which is the one file the scan does not reach. |
| **Check** | Source scan asserting one header form per component directory, with the count pinned to the directory count so a 20th component with no block reds rather than being skipped. **Does not exist yet.** The `RETIRED` registry in `tests/guards/meta/non-vacuity-floors.test.ts` is the right neighbour for the "no deviations, deliberately" case. |
| **Priority** | Should. The content is right; only its findability is wrong, and the cost is paid on the next `--overwrite` rather than now. |

### XR-CMP-03 — Appearance is a variant; only page layout stays at the call site

| | |
|---|---|
| **Statement** | A call site outside `ui/` never passes `class` to a vendored component. A per-call-site difference in appearance is a **variant on the component**; a per-call-site difference in position is a **wrapper element the call site owns**. |
| **Surfaces** | Phone, TV, Ops, Build |
| **Rationale** | `app.css:40` sets `source(none)` with a single `@source` at `app.css:77` covering `ui/` only, so a utility written in a page is minted by nothing and emits no CSS; and a *scoped* class handed to a component is scoped to the caller, where Svelte strips it as unused. Both routes are silent: the attribute ships, the rule does not, and no test reads a `class` attribute for reachability. |
| **Source** | `apps/core/src/lib/components/ui/README.md:74`, `:83` and `:85` (the mechanism and both consequences); `apps/core/src/app.css:40` and `:77` (the `source(none)` + single `@source`). Falsified today at exactly one site: `apps/core/src/routes/metrics/+page.svelte:277` passes `class="name"` to `<Table.Cell>`, and `.name` is declared in neither that page's style block nor `app.css` — a dead attribute, and the only call-site `class` on a UI component in the tree. |
| **Acceptance** | Given every `.svelte` file outside `ui/`, When elements whose tag begins with a capital letter are collected, Then none carries a `class` attribute. Falsified by one, which is the current state. |
| **Check** | Extend `tests/guards/design-system/ui-scoped-style-reach-913.test.ts` — it already walks this surface and already reasons about a class handed to a child component (`no scoped rule styles a class it hands to a child component`, `:228`), so the new arm is the same walk with the reachability condition dropped: *any* class on a component element, resolved or not. |
| **Priority** | Must. One live instance, and it is dead rather than wrong — which is the shape that survives review. |

---

## Group 2 — Prop and variant discipline

### XR-CMP-04 — A variant is reachable, or it is recorded as deliberately unreachable

| | |
|---|---|
| **Statement** | Every value in a `tv()` variant axis is either reachable from a call site, or listed in the component's deviations block as retained-and-unreachable with the reason. The list is closed and enumerated, not open. |
| **Surfaces** | Build |
| **Rationale** | `ui/` is the only directory Tailwind scans, so every declared variant's utilities are **minted into the bundle** whether or not a call site can reach them — and an unreachable variant is a colour pair and a geometry that no measurement, no screenshot and no contrast arm has ever looked at. `Button` is the case: it declares 7 `variant` values and 10 `size` values; the tree's 12 `<Button>` call sites reach 3 variants (`outline` ×9, `iconPrimary` ×1, `default` ×2 implicitly) and 3 sizes (`icon` ×10, `block` ×1, `blockLg` ×1). Unreachable: variants `secondary`, `ghost`, `destructive`, `link`; sizes `default`, `xs`, `sm`, `lg`, `icon-xs`, `icon-sm`, `icon-lg`. |
| **Source** | `UNSOURCED` for the rule, and this is the honest answer rather than a gap I failed to close. The **counts** are a real citation — `apps/core/src/lib/components/ui/button/button.svelte:38–47` (the variant axis, including `destructive` at `:45`) and `:48–77` (the size axis), enumerated against every `<Button>` call site. But nothing establishes that an unreachable *variant* must go, and the repo's own nearest precedent argues the **other way**: `ui/README.md:17–19` decides that unused *parts* are kept on purpose, because "a part is the registry's unit, and deleting one makes the next `--overwrite` look like a regression". That argument transfers cleanly to `secondary`/`ghost`/`destructive`/`link`, which are the registry's values and not Encore's. It does **not** transfer to an Encore-authored axis, which has no upstream to diff against — and every Encore-authored value is currently reachable (`Button.press` all 4, `Badge.variant` all 6 including `accent` at `SongRow.svelte:323`, `Input.variant` all 4, `Slider.variant` both, `Progress.size` both). So the rule I would write is: **registry values are kept and recorded; Encore-authored values are reachable or deleted.** I looked for a standard or an in-repo ruling that says so and found neither. |
| **Acceptance** | Given every `tv()` axis under `ui/`, When each value is searched for as a call-site prop value plus the axis's `defaultVariants` entry, Then every unreached value appears in that component's deviations block. Falsified today by four `Button` variants and seven `Button` sizes, none of which the block mentions. |
| **Check** | Source scan pairing `tv()` axis values against call-site prop values. `tests/guards/design-system/ui-scoped-style-reach-913.test.ts:425` already parses a `tv()` call and survives hoisting the variants call, so the parsing half exists. **The reachability arm does not.** Note the blind spot honestly: a variant chosen by a ternary (`SongRow.svelte:316–317`, `:322–323`) is reachable only if the scan reads expression bodies, not just quoted literals. |
| **Priority** | Should, and its *value* is the owner's call before its guard is written — pinning the current set means the next `--overwrite` reds. |

> **Recommendation (not decided).** Split the rule by provenance rather than writing one rule for both:
> keep every registry value with a one-line "registry value, unreached, retained for `--overwrite`
> diffability" entry in the deviations block, and require an Encore-authored value to have a call site
> or be deleted. That costs four lines of prose in `button.svelte` and nothing else today, and it puts
> the burden on the axis where invention actually happens.

### XR-CMP-05 — Semantics are a variant; an appearance axis never carries meaning

| | |
|---|---|
| **Statement** | When a call site distinguishes a control by what it **means** — destructive, primary, cautionary — that distinction is expressed as a semantic variant on the component. An axis whose name describes an appearance or a feedback behaviour is never used to encode meaning. |
| **Surfaces** | Phone, Ops |
| **Rationale** | The app's one destructive control is written `variant="outline" press="accent2"` at `QueueRow.svelte:155` and `ProcessingCard.svelte:142`. `press` is a **press-feedback** axis — a `transform: scale()` and a colour on `:active` — so "this action destroys something" is currently spelled as "flash pink when tapped", while `Button` ships a `destructive` variant that no call site reaches. The two facts are the same fact: the semantic vocabulary went unused because an appearance vocabulary was close enough to hand. |
| **Source** | `apps/core/src/lib/components/ui/button/button.svelte:45` (the unreached `destructive` variant) against the two call sites above. The **rule** is `DERIVED` — model: the repo's own statement of it one layer over, at `apps/core/src/lib/components/SongRow.svelte:312–314`, where the readiness chip's comment reads "The readiness tone is chosen HERE and passed as a variant, because the tone IS the meaning: each one is a certified surface+border+ink triple in ui/badge, set together and never separately." `Badge` follows that rule completely; `Button` does not, and nothing records the difference as deliberate. |
| **Acceptance** | Given every call site of a vendored component, When a prop value is drawn from an axis whose documented purpose is appearance or feedback, Then the same call site does not rely on that value to convey the control's meaning — concretely: the remove control resolves to a variant named for destruction, and `press` carries only the tactile response. Falsified by a control whose only destructive signal is its `press` value. |
| **Check** | Not a scan — "does this axis carry meaning" is a reading, not a syntax property. `EXEMPT` for the general rule, with the judgment stated: the *specific* clause is checkable and should be, as a pinned assertion that the remove control's variant is the semantic one, in the shape of the existing by-name pins in `tests/guards/a11y/touch-targets.test.ts:174`. |
| **Priority** | Must for the remove control specifically; Should for the general rule. A destructive action whose only marker is a tap animation is invisible to anyone who has not yet tapped it. |

### XR-CMP-06 — A component's public surface is its props and its module exports, nothing else

| | |
|---|---|
| **Statement** | A component exports from `<script module>` only — variant recipes, types, constants. No component declares an instance-level `export`, so the only way to drive a component is its props. |
| **Surfaces** | Build |
| **Rationale** | An instance-level `export function` is reachable only through a bound component instance, so it is an API with no discoverable caller and no type-checked call site — and it invites a parent to reach *into* a component for a decision the component owns. `ColourPicker.svelte:102` exports `colorName(hex)`, the function that turns a preset hex into the name a swatch announces. Nothing imports it anywhere in the tree, and nothing binds a `ColourPicker` instance; it is used one line later by the component itself. So the export buys nothing and offers the naming decision outward. |
| **Source** | `apps/core/src/lib/components/ColourPicker.svelte:102` (the export) against a tree-wide search for `colorName` outside that file, which returns nothing. The **rule** is `DERIVED` — model: the repo's own consistent practice, which this is the single exception to. Six components export from a module block (`button.svelte:35`, `badge.svelte:19`, `item.svelte:19`, `item-media.svelte:4`, `field.svelte:4`, `empty-media.svelte:4`); this is the only instance-level export in the directory. |
| **Acceptance** | Given every `.svelte` file under `components/`, When `export` declarations in a non-`module` `<script>` block are collected, Then the set is empty. Falsified today by exactly one, and satisfied by deleting the keyword — the function's one caller is inside the file. |
| **Check** | Source scan distinguishing `<script module>` from `<script>` before matching `export`. **Does not exist yet.** Cheap, and the single current offender is the regression fixture. |
| **Priority** | Should. Nothing is broken; what is at stake is that the next component's "just export the helper" has a precedent to point at. |

---

## Group 3 — Which component owns the decision

### XR-CMP-07 — A component does not lay out its parent

| | |
|---|---|
| **Statement** | No rule targeting a component's own root element sets an outer `margin`. Space *between* a component and its siblings is the parent's decision, expressed on the parent's container or on a wrapper the call site owns. |
| **Surfaces** | Phone, TV, Ops |
| **Rationale** | A component that sets its own outer margin cannot be placed twice: the second placement inherits a gap chosen for the first, and the parent's only recourse is an override that fights it. This is **not** `XR-PH-04` restated — every value below is already a spacing token, so the token rule is satisfied. What is unowned is *who decides*. |
| **Source** | `DERIVED` — model: the rule as the vendored layer already states it for itself, at `apps/core/src/lib/components/ui/progress/progress.svelte:19` — "Spacing from the element ABOVE stays at the call site on a wrapper, since that is page layout rather than the bar's own metric" — generalised from that one component to the layer. Falsified in five app-level components today, each on its own root: `MyPositionCard.svelte:43` (`.mine`), `NowPlayingHero.svelte:189` (`.hero`), `GuidingTrack.svelte:58` (`.gt`), `LyricsReselect.svelte:120` (`.reselect`), `RangeBar.svelte:124` (`.rangebar`). |
| **Acceptance** | Given every component file, When the class on its root element is resolved and that class's own rule is read, Then the rule sets no `margin`, `margin-top` or `margin-bottom`. Falsified by any of the five above; satisfied by moving each value onto the parent's `gap` or a call-site wrapper. |
| **Check** | Source scan: resolve the root element's class from the markup, then read that selector's declarations — the same root-class resolution `tests/guards/a11y/contrast.test.ts` performs when it derives a row's classes by splitting the root `class` attribute. **Does not exist yet.** It must strip comments first, since three of the five carry prose about their own spacing. |
| **Priority** | Should. Nothing renders wrong today; the cost lands when one of the five is placed a second time. |

> **Recommendation (not decided).** Carve out one exemption and name it, rather than writing the rule
> without one: `ui/field/field-label.svelte:58` sets `margin: var(--space-lg) 0 var(--space-2xs)` on
> `[data-slot='field-label']`, and that is deliberate — its own header records that the settings page
> stacks 27 of these and that the registry's margin-free label collapsed every field against its
> neighbour. A label is the one component here whose *purpose* is the rhythm of a stack, so it is a
> real exemption and not a violation. Whether the honest form is "exempt `field-label` by name" or
> "the parent must own it, and settings gets a wrapper" is a judgment nobody has made, and the second
> costs 27 wrappers.

### XR-CMP-08 — A shared component reads no global state

| | |
|---|---|
| **Statement** | A component under `components/` takes everything it renders from props. It imports no `$app/*` module, no store, and no `$env/*`, and it performs no navigation. |
| **Surfaces** | Phone, TV, Build |
| **Rationale** | A component that reads the URL cannot be placed twice, and its states cannot be reached by passing props — a test or a second surface has to construct the world around it instead. The repo already paid for this once in the opposite direction: `ColourPicker.svelte:4` records that it was **extracted from `/join`** precisely so the profile sheet could offer the same picker rather than a second implementation, which was only possible because everything it needs arrives as a prop. `JoinLanding.svelte:27–28` imports `goto` and `page`, reads `page.url.searchParams` at `:45` and `:115`, and navigates at `:116` — so the join screen cannot be placed anywhere the query string differs, and it decides the next route itself rather than telling its parent it is done. |
| **Source** | `apps/core/src/lib/components/JoinLanding.svelte:27`, `:28`, `:45`, `:115`, `:116` (the violation). A scan of the remaining 10 app-level components and all 19 primitives for `$app`/`$env`/store imports returns zero — `JoinLanding` is the only one. The **rule** is `DERIVED` — model: the props-only shape stated as a reuse requirement at `apps/core/src/lib/components/ColourPicker.svelte:4`, generalised from that one extraction to the layer. |
| **Acceptance** | Given every file under `components/`, When its imports are collected, Then none resolves to `$app/*`, `$env/*` or `svelte/store`. Falsified by `JoinLanding` today; satisfied by lifting the query read and the navigation to `routes/join/+page.svelte` and passing `scannedCode` in as a prop with an `onjoined` callback out. |
| **Check** | The same import scan as `XR-CMP-01`, widened to the whole `components/` tree with a different permitted set. Source scan only — this is a syntax claim. |
| **Priority** | Should. Nothing is broken; what is unavailable is placing the join screen anywhere else, and reaching its states without building a URL. |

> **Correction to this row's expected premise — verified, and it changes the row.** I expected the
> justification to be *mountability*, because `NowPlayingHero.svelte:13–15` states exactly that: "it
> owns no state, reads no store and imports no `$app` module, **so** it MOUNTS under the repo's
> happy-dom harness". Its claim about itself is true and its causal claim is **stale**.
> `tests/setup/svelte-dom-preload.ts:125–128` aliases `$app/navigation`, `$app/state`,
> `$app/environment` and `$env/dynamic/public` to real stubs, and `:117` records the old state in the
> past tense — "which is why only leaf components with zero `$app` imports **could** mount".
> `docs/ux/04-verification.md:256` confirms it: rung M *is* the preload **plus** aliased `$app`/`$env`.
> What still blocks a route mount is a `data` prop from a server `load` and `offsetHeight` throwing
> under `XR-VER-03`, per `tests/guards/subsystem-tv/wake-lock.test.ts:22–26` — not the `$app` import.
> So this row stands on reuse and state-reachability, which is a weaker case than the one the code's
> own comment invites, and that is why its priority is Should rather than Must.


### XR-CMP-09 — `data-slot` belongs to the vendored layer, and app code does not write into it

| | |
|---|---|
| **Statement** | `data-slot` is the vendored layer's element-identity attribute. No app-level markup sets it, no caller overrides a component's value for it, and no app logic reads it as application state. Application state that needs a hit-testable attribute uses its own name. |
| **Surfaces** | Phone, Build |
| **Rationale** | The attribute now carries three jobs simultaneously, and only one of them is app state. It is shadcn's identity for an element; it is what nine vendored components' `:global()` rules key on precisely *because* it survives a re-vendor where an Encore class would not (`slider`, `progress`, `tabs-trigger`, `field-label`, `item`, `sonner`, `card`, `input`, `badge`); and it is enumerated as a contract by `ui-scoped-style-reach-913.test.ts:367`, "every data-slot styled via :global is emitted by markup in this tree". Writing app state into it means a page's own value is now inside the namespace a re-vendor rewrites and a guard enumerates. |
| **Source** | `apps/core/src/routes/+page.svelte:1407` sets `data-slot={slot.index}` — a bare integer — on the reorder mode's drop-slot button; `:894` reads it back with `under?.closest?.('[data-slot]')` and `:895` coerces `slotEl.dataset.slot` to a number. Since the migration, **every** vendored root carries a `data-slot`, so `closest('[data-slot]')` will resolve to a `QueueRow`'s `data-slot="item"` or a `Button`'s `data-slot="button"` before it ever reaches a drop slot. Separately, `apps/core/src/lib/components/ui/input/input.svelte:39` lets a caller override the value (`"data-slot": dataSlot = "input"`), which is the same hazard offered as an API. The rule is `DERIVED` — model: attribute-namespace ownership, where the owner is whoever a re-vendor overwrites. |
| **Acceptance** | Given the drag path, When the pointer is over a queue row rather than a drop slot, Then `hoverSlot` resolves from the drop-slot's own attribute rather than from whichever `[data-slot]` ancestor is nearest. **The current code does not fail visibly**, and that is the finding rather than a reprieve: `Number('item')` is `NaN`, `:896`'s `Number.isInteger` rejects it, and `hoverSlot` becomes `null` — so a hover over a row silently clears the highlight instead of resolving wrongly. It is correct by arithmetic accident, and it stops being correct the day any component's `data-slot` is numeric or a drop slot is nested inside one. Falsified by a rename of `slider` to `slider-1`, or by the `input` override being used with a digit. |
| **Check** | Two arms. (1) Source scan: no `data-slot` attribute in markup outside `ui/`, and no component prop destructures `"data-slot"`. (2) A driven-pointer arm on the existing reorder path, which is where the equivalent defects were found before — `tests/guards/hygiene/reorder-mode-source-836.test.ts` is the source-scan neighbour, and `routes/+page.svelte:882–889` records that the element-identity bugs in this exact gesture were invisible to unit tests and only a real pointer showed them. **Neither arm exists yet.** |
| **Priority** | Must, and first in this section. The mechanism that hides it — an accidental `NaN` — is the same silent-green class `XR-COL-18` exists for, arriving by a different route. |

---

## Group 4 — Accessible names and focus behaviour

### XR-CMP-10 — An icon-only control has a name, and the name says what the control does now

| | |
|---|---|
| **Statement** | Every control whose visible content is an icon has a programmatically determinable accessible name, and that name states the action the control will take **in its current state**. A control whose function alternates either renames itself or exposes its state through the appropriate ARIA property. |
| **Surfaces** | Phone, TV, Ops |
| **Rationale** | The hero's transport is three icon-only buttons; the middle one is labelled `play/pause` and its glyph swaps with `isPlaying`. So a screen-reader user is told both actions and which one is live is exactly the thing withheld — and the glyph that resolves it is the one signal they do not have. Every other icon-only control in the tree does carry a name, so this is one defect rather than a missing convention. |
| **Source** | [WCAG 2.2 SC 4.1.2 Name, Role, Value](https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html) (A) for the name and for state being programmatically determinable; the [ARIA APG Button pattern](https://www.w3.org/WAI/ARIA/apg/patterns/button/) for the two legal shapes — a toggle button carrying `aria-pressed`, or a button whose label changes with its action. Falsified at `apps/core/src/lib/components/NowPlayingHero.svelte:127` (`aria-label="play/pause"`, static) against `:131` (`<Icon name={isPlaying ? 'pause' : 'play'} />`, which does change). **A second clause is `UNSOURCED` and stays a finding rather than a rule:** the names in the tree mix registers — `"restart"`, `"skip"`, `"move up"`, `"remove from queue"` are lowercase fragments while `"Reorder your songs"`, `"Cook progress"` and `"Pick your own color by hue"` are sentence-case phrases. No WCAG criterion and no ARIA pattern sets a register for an accessible name; I looked for a citable rule and found none, so consistency here is a house-style decision nobody has made. |
| **Acceptance** | Given every control under `components/` whose only child is an `<Icon>` or a vendored icon, When its accessible name is computed, Then it is non-empty; **and given** the play/pause control, When `isPlaying` flips, Then either the name changes or `aria-pressed` changes. Falsified today by that one control, whose name is invariant across both states. |
| **Check** | Mount-rung assertion in the shape of `tests/unit/core/lib/components/tabs-keyboard-913.test.ts`, which already mounts a vendored control and reads its ARIA attributes. `NowPlayingHero` is mountable — it takes no server `load` payload and reads no geometry API, and the `{#if controlsOpen}` guard inside its disclosure keeps the Bits UI Slider from mounting while collapsed, which is the one thing in it that `XR-VER-03` would refuse. **The file does not exist yet**; `tests/guards/a11y/` currently holds only `contrast.test.ts`, `touch-targets.test.ts` and `trend-tap-target.test.ts`, so accessible names have no guard at all. |
| **Priority** | Must for the play/pause control. The transport is the only place on the phone where a guest commands the room, and it is the one control there whose name is wrong. |

### XR-CMP-11 — A default accessible name lives in the component, not at every call site

| | |
|---|---|
| **Statement** | When a component's accessible name is the same at every call site, the component declares it as a defaulted prop. A call site supplies a name only where it genuinely differs. |
| **Surfaces** | Phone, Ops, Build |
| **Rationale** | A name repeated at each call site is a name that can drift at one of them, and the drift is invisible: nothing renders differently and no guard reads it. `Progress` is the case — both callers pass the identical string `aria-label="Cook progress"`, so the name is stated twice and owned nowhere. `Spinner` is the counter-example in the same directory and shows the shape: it defaults its own name, so a caller that says nothing still announces something. |
| **Source** | `DERIVED` — model: the defaulted-name pattern already used at `apps/core/src/lib/components/ui/spinner/spinner.svelte:22` (`'aria-label': ariaLabel = 'Loading'`), with its header at `:12` stating the reason ("a spinner that announces nothing is invisible to a screen reader, which is the one thing it must not be"). The duplication is a real citation: `apps/core/src/lib/components/ProcessingCard.svelte:155` and `apps/core/src/lib/components/SongRow.svelte:339`, identical string. The obligation the default satisfies is [WCAG 2.2 SC 4.1.2](https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html). |
| **Acceptance** | Given every vendored component that a caller names, When the names passed by all of its call sites are collected, Then either they differ, or the component declares that name as a default. Falsified today by `Progress`: two call sites, one string, no default. |
| **Check** | Source scan collecting `aria-label` values per component per call site and comparing the set size against the presence of a defaulted prop. **Does not exist yet.** Note the blind spot: a name built from an expression cannot be compared this way and must be exempted by shape, not silently skipped — otherwise the scan reports agreement it never tested. |
| **Priority** | Should. The two strings agree today; what is unowned is which file is wrong when they stop agreeing. |

### XR-CMP-12 — A component that owns a keyboard interaction owns its focus target, by attribute

| | |
|---|---|
| **Statement** | A component that moves focus in response to a key resolves the destination from an attribute it publishes on the target, not from a node reference held across a render. A component that implements a composite widget implements the whole pattern — one tab stop, arrow-key movement, and selection following focus. |
| **Surfaces** | Phone, Ops |
| **Rationale** | Both halves are already settled in this directory, in opposite directions, and neither is written down. `ColourPicker` implements the radio-group pattern completely and resolves its focus target through `[data-swatch]`, an attribute it publishes itself. `QueueRow`'s grip cannot hold its own target — entering the reorder mode inserts drop slots into the list, Svelte recreates the row's DOM, and the pressed grip becomes a detached node — so it publishes `data-grip` and the page re-finds the grip by id. Its own prop documentation records that a handler holding the element left a keyboard guest's focus on `<body>` after Escape, and that only a real browser showed it. The rule is the same in both: **the attribute survives the re-render; the reference does not.** |
| **Source** | [ARIA APG Radio Group pattern](https://www.w3.org/WAI/ARIA/apg/patterns/radio/) for the composite-widget half — one tab stop, arrow movement, selection follows focus — and [WCAG 2.2 SC 2.4.3 Focus Order](https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html) (A) for focus landing somewhere meaningful. In-repo: `apps/core/src/lib/components/ColourPicker.svelte:141` (the group and its name), `:147` (the roving tabindex), `:148` (the published attribute) and `:129` (the focus call resolving through it); `apps/core/src/lib/components/QueueRow.svelte:52–62` (the detached-node failure, in the repo's own words) and `:178` (`data-grip={gripId}`). |
| **Acceptance** | Given the swatch group, When ArrowRight is pressed, Then exactly one swatch is in the tab order, focus lands on the next swatch, and `aria-checked` moves with it. **And given** any component that calls `.focus()`, When the call is read, Then its target is resolved by a query at call time rather than from a variable captured before a render. Falsified by a component that stores an element and focuses it later. |
| **Check** | Mount-rung assertion, exactly as `tests/unit/core/lib/components/tabs-keyboard-913.test.ts:67` and `:74` already do for the tabs pattern — one tab stop, and arrows moving selection and tab stop together. `ColourPicker` is already named as a rung-M mount target by `docs/ux/04-verification.md:279`, so no harness work is needed; the assertion itself **does not exist yet**. The second clause is a source scan over `.focus()` call sites. |
| **Priority** | Must. The reorder mode already shipped this defect once and it took a driven browser to find; the picker has the same shape with no test. |

---

## What these rows deliberately do not cover, and why

Each entry is a rule that already exists, or an answer nobody has given. The list is what stops the
next person re-deriving these gaps.

1. **Colour, tone triples and the fill/ink pairing inside vendored components.** `Badge`'s six
   certified surface+border+ink triples and `tabs-trigger`'s `--accent`/`--on-accent` pair are
   governed by `XR-COL-06`, `XR-COL-07` and `XR-COL-12`, which already require the fill and its ink to
   be set together and never separately. `XR-CMP-05` is about which *axis* carries a meaning, not
   about the values in it.
2. **The ink ban and the semantic bridge.** `text-primary` and its siblings are banned in app source
   and exempted inside `ui/` by path, held by
   `tests/guards/design-system/shadcn-ink-ban-913.test.ts`, and the reasoning is stated at length in
   `ui/README.md`. `XR-COL-14` covers the `@theme` registration that makes the hazard possible.
   Nothing here to add.
3. **The 44px tap floor, and expressing it as `var(--tap)`.** `XR-PH-01` owns the expression rule and
   `tests/guards/a11y/touch-targets.test.ts` enforces it; six vendored components already name the
   token in their deviation blocks. A component-layer restatement would be a duplicate of a working
   rule.
4. **Spacing, z-index, type and motion token values.** `XR-PH-04`, `XR-PH-05` and `XR-PH-06` own the
   dimensions; `motion.test.ts` bans the utility names tree-wide. `XR-CMP-07` deliberately asserts
   only *who decides* an outer margin, because every value it names is already a token.
5. **De-emphasis by subtree opacity.** `XR-PH-03` owns it, `contrast.test.ts` enforces it, and both
   `QueueRow` and `ProcessingCard` cite it in their own prop docs. Restating it as a component rule
   would bury the rows above that are genuinely unheld.
6. **The scoped-style reach failure.** `ui/README.md` §2 states it, and
   `ui-scoped-style-reach-913.test.ts` already fails on the broken form in two directions.
   `XR-CMP-03` covers only the part that guard does not read: a `class` attribute that resolves to
   nothing at all.
7. **Unused *parts* of vendored components.** Decided, with a reason, at `ui/README.md:17–19`: a part
   is the registry's unit and deleting one makes the next `--overwrite` look like a regression.
   `XR-CMP-04` is scoped to variant *values* and explicitly records that this precedent argues against
   it.
8. **A maximum prop count, or a rule that a component with many props should be split.** `SongRow`
   declares more than twenty props, most of them documented at paragraph length and several recording
   a defect that the prop's shape exists to prevent. Any threshold I wrote would be invented, and the
   file is the best-documented in the directory — the count is a symptom of a search result being
   genuinely high-dimensional, not of a component doing two jobs. If this is ever specified it needs a
   ruling first, not a number.
9. **Whether `GuidingTrack` should migrate onto the vendored `Slider`.** `slider.svelte`'s deviation 4
   already states the conflict precisely — Bits UI's Slider reads `offsetWidth`, the mount rung
   deliberately makes `offsetWidth` throw per `XR-VER-03`, so migrating means moving seven mounted
   renders to the layout rung, which skips where Chromium is absent. It records that as the owner's
   call. Specifying it here would decide it.
10. **A register or casing convention for accessible names.** No WCAG criterion and no ARIA pattern
    sets one, and the tree currently mixes lowercase fragments with sentence-case phrases. Recorded as
    `UNSOURCED` inside `XR-CMP-10` rather than answered: *"no published standard sets a register for an
    accessible name" is the finding.*
11. **Anti-vacuity floors for the new scans.** `XR-COL-19` already requires every source-scanning
    guard to assert it read a non-empty surface, and `XR-COL-18` already requires a guard whose premise
    dissolves to be retired on the record. Every `Check` above inherits both; none of them is restated
    as a component-layer row.

## Four places where reading the code contradicted what I expected

Recorded because each one changes what the right requirement is, and a reader working from the brief
alone will reach the wrong answer.

**1. The component layer is not at zero requirement coverage — it is at zero *contract* coverage.**
The files are saturated with existing rows: `QueueRow.svelte` cites six `XR-PH` numbers inside its own
prop documentation, `ColourPicker` is the subject of `XR-COL-03`, and six vendored components name
`XR-PH-01` in their deviation blocks. What nothing anywhere states is who may declare a variant, who
owns an accessible name, or what a component may import. That reframing is why `XR-CMP-07` asserts
ownership rather than token use, and why five of these twelve rows would otherwise have been
near-duplicates.

**2. The sharpest defect is a namespace collision that currently works by arithmetic accident.**
I expected the vendored/app boundary to fail on styling. It fails on an *attribute*: the reorder mode
writes an integer into `data-slot`, which since the migration is also shadcn's element identity, also
what nine `:global()` rules key on, and also what a guard enumerates. It does not misbehave today only
because `Number('item')` is `NaN` and a downstream `Number.isInteger` rejects it — so the wrong
element is found and then silently discarded. A correct-looking behaviour resting on a coincidence is
worse than a visible bug, and it is `XR-CMP-09`.

**3. `ui/README.md` states the rule that the app-level half of its own directory breaks.**
`progress.svelte` says spacing from the element above stays at the call site because that is page
layout rather than the component's own metric — and five app-level components set an outer margin on
their own root. Meanwhile `field-label.svelte` breaks the same rule *deliberately*, with a documented
reason (27 stacked settings fields whose entire vertical rhythm it carries), which means the rule
cannot be written without an exemption. That is why `XR-CMP-07` ships with a
`Recommendation (not decided)` rather than a clean prohibition: the honest version of this rule has a
carve-out in it, and pretending otherwise would produce a guard someone has to suppress in its first
week.

**4. The obvious argument for "a component reads no global state" is stale, and I had to weaken the
row.** `NowPlayingHero.svelte:13–15` says it imports no `$app` module **so that** it mounts, which
reads as a standing prerequisite and is the argument I set out to use. It is no longer true:
`tests/setup/svelte-dom-preload.ts:125–128` aliases the four `$app`/`$env` modules the app uses, `:117`
records the old constraint in the past tense, and `docs/ux/04-verification.md:256` defines rung M as
the preload *plus* that aliasing. A component that imports `$app` mounts fine today; what still blocks
a route is a server-`load` `data` prop and `offsetHeight` throwing under `XR-VER-03`. So `XR-CMP-08`
rests on reuse and state-reachability instead — the case `ColourPicker.svelte:4` actually makes — and
its priority dropped from Must to Should as a result. The wider lesson is the one `XR-COL-18` is about:
a comment stating a *reason* outlived the mechanism that made the reason true, and a reader who trusts
it writes a requirement on a premise that no longer holds.
