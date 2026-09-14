# 08 — Migrating the app onto the vendored component layer

> **This section is about the MIGRATION, not the contract.** Area prefix `XR-LIB`.
>
> [`06-components.md`](06-components.md) (`XR-CMP`) already owns the **component contract** — which
> props exist, which side of the vendored/app boundary owns a decision, who supplies an accessible
> name, what a component must not reach for. This section does not re-open any of that and does not
> restate its rows. It answers a different question: **what migrates, what stays hand-rolled, and how
> a step proves it did not break anything.**
>
> Where the two touch, `06` wins on contract and this section wins on sequencing. `07-tv-module.md`
> owns the TV, which is exempt here by name.
>
> **The rows are `LIB-NN`, not `XR-LIB-NN`, and that is deliberate.** This tree registers a requirement
> as a `### XR-<AREA>-NN` heading with seven fields, and `register-index-matches.test.ts` checks that
> every `XR-` citation resolves to such a row. These 25 rules are compact table rows, so claiming the
> `XR-` prefix would assert a coverage this file does not yet provide. Promoting them — one `###`
> heading and seven fields each, then a numbered filename and an index row — is the remaining step.

> **Purpose.** Make **shadcn-svelte the canonical primitive layer** and hand-rolled UI the
> *documented exception*. Ratified decisions and their reasoning are in
> [`../DECISIONS.md`](../DECISIONS.md); the migration state of every surface is
> [`component-migration-inventory.md`](component-migration-inventory.md).

Written 2026-09-14, revised after the first four migration steps. **25 requirements** (`LIB-01` … `LIB-25`). Scope ratified by the owner on
2026-09-14: **push the boundary — composites migrate onto primitives; only the TV tree stays
hand-rolled.** That widens
`DECISIONS.md`'s shadcn-composition ruling, which had also fenced off `NowPlayingHero` / `ProcessingCard` /
`QueueRow` / `SongRow` / `RangeBar` as "not ever, unless something changes". This document is the
"something changed", and it says so on the record rather than quietly contradicting the older text.

## The one-sentence intent

A primitive that lives in `$lib/components/ui/` is **read by the design guards, versioned by the
registry, and styled in exactly one place** — so the default answer to "how do I build this control"
is a vendored component, and every hand-rolled element must name both the reason it exists and the
guard that pins it.

## What this document assumes you already know

Three facts about the installed toolchain drive most of the rules below, and a reader who does not
have them will write requirements that cannot hold.

1. **Tailwind scans exactly one directory.** `app.css` sets `source(none)` with a single
   `@source '../src/lib/components/ui/**/*.svelte'`. A utility written at a call site is emitted
   **nowhere**. Verified by building with a `w-full` on a call site and finding no `.w-full`
   rule in any of the 16 built CSS assets.
2. **Svelte's scoped CSS cannot reach into a child component.** `.foo { … }` compiles to
   `.foo.svelte-<hash>`, and the hash lands only on elements *this* file renders. `slider.svelte`
   shipped a dead `min-height: var(--tap)` this way and `touch-targets.test.ts` passed the whole
   time, because the test reads the rule's **text**.
3. **Preflight is OFF** (measured at 2,696 moved boxes when it was trialled). A vendored component cannot assume
   the reset ran.

Together these mean the migration is **not** shadcn's usual utility-soup-at-the-call-site. It is
stricter, and the strictness is the point.

---

## Group 1 — The boundary

| ID | Requirement | Surfaces | Source | Acceptance | Check |
|---|---|---|---|---|---|
| **LIB-01** | Every interactive control resolves to a component in `$lib/components/ui/`, unless it appears in the exception register (LIB-04). | phone, desktop pages | Owner ruling 2026-09-09 on shadcn composition, widened 2026-09-14 | Given any `<button>`, `<input>`, `<select>` or `<textarea>` in app source outside `ui/` and outside the TV tree, When the exception register is consulted, Then it appears there with a reason, or the requirement fails. | rung M source scan |
| **LIB-02** | **The TV tree is exempt by name**, not by omission: `src/routes/tv/**`, `src/lib/tv/**`. | TV | `DECISIONS.md` §Component library | Given a file under the TV tree, When it hand-rolls a control, Then no requirement in this document applies to it. | path allowlist in the guard |
| **LIB-03** | A **composite keeps its shell and migrates its interior.** The outer element stays hand-rolled where it carries state classes or a test-attributed surface; every interior control migrates. | phone | Owner ruling 2026-09-14 | Given `SongRow`, `QueueRow`, `ProcessingCard`, `NowPlayingHero`, `MyPositionCard`, `JoinLanding`, When audited, Then each interior control is a primitive or a registered exception, and the shell's `class` attribute is unchanged. | inventory row per composite |
| **LIB-04** | The **exception register is a file, not folklore.** Every hand-rolled element carries (a) a one-line reason and (b) the guard or requirement that pins it. An exception with no named pin is a defect. | all | This document | Given the inventory, When a row's Target reads `EXCEPTION`, Then its Reason and Pinned-by cells are both non-empty. | inventory lint |
| **LIB-05** | An exception is **reviewable, not permanent.** A row whose reason is "no registry target exists" is re-checked whenever the registry gains that component (LIB-19). | all | This document | Given a registry gap listed in LIB-19, When that component is vendored, Then every exception citing it is re-adjudicated in the same change. | manual, on vendoring |

### Why the TV stays out

Not sentiment. A ten-foot surface runs its own type ladder off a **separately scoped root**
(`calc(max(2.7vh, 20px) * --ui-scale)` ≈ 29.16px at 1080p), where the phone's ladder is `rem` off a
`100%` body with no viewport term. A primitive sized for one is wrong on the other, and shadcn ships
`h-9`/`px-3`/`text-base` — phone numbers. `LyricsOverlay`, `TvPlayer`, `VisualizerStage` and
`RangeBar` additionally have **no registry target at all**.

---

## Group 2 — The mechanics that bite

These are the five constraints that broke something real during the composition-model adoption. Each is a hard rule, not advice.

| ID | Requirement | Source | Acceptance | Check |
|---|---|---|---|---|
| **LIB-06** | **Every call-site difference is a named variant.** No appearance utility, and no appearance class, is written at a call site; page-level *layout* stays on a wrapper element the page renders. | measured during composition adoption | Given a call site passing a class to a `ui/` component, When the built CSS is searched, Then a rule for that class exists — or the class is layout-only on a page-rendered wrapper. | build-output scan |
| **LIB-07** | A rule targeting an element a **child** component renders uses `:global([data-slot='…'])`; otherwise the class goes on an element **this** file renders. | `slider.svelte` defect, found during composition adoption | Given a scoped rule whose selector matches no element this file renders, Then the requirement fails. | `ui-scoped-style-reach-913.test.ts` |
| **LIB-08** | **State classes stay on a real element.** `class:` directives are invalid on a component, so a shell carrying state (`mine`, `up`, `pending`, `dimmed`, `moving`) is not replaced by `Card.Root`. | Svelte semantics | Given `QueueRow`'s five state classes, When migration is proposed, Then the shell remains a `<div>`. | inventory + compile |
| **LIB-09** | A shell's `class` attribute stays **static and un-interpolated**, and `.card` is emitted verbatim where it is used today. | `contrast.test.ts` splits on whitespace | Given a shell `class`, When it contains `{` , Then the requirement fails. | `contrast.test.ts`, `ui-card-surface-913.test.ts` |
| **LIB-10** | A migration **preserves the selectors the E2E contract addresses.** `.sing`, `.add`, `.seq`, `.who i` keep their class names through any component swap. | `tests/e2e/contract.ts` + selector-rot guard | Given a swap on a contract-addressed element, When `contract.test.ts` runs, Then it passes without editing the contract. | `contract.test.ts` |

### The `.card` trap, stated once

`.card` in `app.css` is **not dead** and must stay. Nine elements take the shared surface rather than
a `<Card.Root>`: three queue/list rows, the hero, the TV progress track, a code-entry segment, the
reorder bar, `MyPositionCard`, `JoinLanding`. the composition-model change deleted the global rule, those nine silently
lost their surface, and it was restored with a guard. The authoritative enumeration lives in
`ui-card-surface-913.test.ts` — **if that test and this document disagree, the test is right.**

---

## Group 3 — Colour, motion, reset

| ID | Requirement | Source | Acceptance | Check |
|---|---|---|---|---|
| **LIB-11** | **Colour is never registered in `@theme`.** Registering mints the whole utility family with no per-family opt-out, so `--color-accent` would hand out `text-accent` beside `bg-accent`. Colour arrives as arbitrary values over `:root` tokens. | `--accent` as ink: 3.85:1 on `--bg`, 3.38 on `--card`, 3.10 on `--card2`, 2.90 on `--card-tint2` — four AA failures | Given `@theme`, When a colour entry is added, Then the guard reds. | `tailwind-toolchain.test.ts` |
| **LIB-12** | The **ink direction is banned by name** in app source: `text-primary`, `text-destructive` and siblings. `ui/` is exempt by path, because a vendored component pairing `bg-primary` with `text-primary-foreground` is correct (white on `#7254e6` = 5.09:1). | XR-COL-11 | Given app source outside `ui/`, When it uses a banned ink class, Then the guard reds. | `shadcn-ink-ban-913.test.ts` |
| **LIB-13** | **Player hues are never minted as utilities.** The 48-stop registry splits `ink` from `fill` per stop (13 of 48 differ); no single utility can respect that. | the palette split, XR-COL-10/12 | Given the palette, When any stop reaches `@theme`, Then the guard reds. | `tailwind-toolchain.test.ts` |
| **LIB-14** | **No motion utilities.** `transition-*`, `animate-*`, `duration-*`, `ease-*` are rejected as utility names tree-wide, because a keyframes utility cannot honour Reduce Motion. Live motion is declared CSS on a composited property (`transform`/`opacity`), and a component's own animation is declared **inside** `@media (prefers-reduced-motion: no-preference)`. | the composition change stripped `transition-all` from nine components | Given a `ui/` component, When it animates, Then the animation is opt-in via that media query and touches only transform/opacity. | `motion.test.ts` |
| **LIB-15** | **De-emphasis never uses subtree `opacity`** — surface and border tokens instead. | XR-PH-03; `opacity:.55` measured text at 3.77:1, byline 2.68:1, dot 2.57:1 | Given a dimmed row, When measured, Then title ≥ 4.5:1 and dot ≥ 3:1. | rung L |
| **LIB-16** | A vendored component **supplies its own reset needs**. Preflight stays off; the global import is not re-added to obtain it. | measured at 2,696 moved boxes | Given `app.css`, When the Preflight import returns, Then the guard reds. | `tailwind-toolchain.test.ts` |

---

## Group 4 — Overlays, and the CSS-in-`node_modules` hole

The copy-in rationale is that component CSS lands in `src/` where a source scan can read it. **For a
whole class of components that rationale does not hold**, and the project has already been bitten
once: `DECISIONS.md` records that shadcn's drawer copies 12 files with **zero `<style>` blocks**,
while the real CSS is a 291-line `<style global>` inside `vaul-svelte`, and the sheet's geometry is
not CSS at all — vaul computes snap offsets in JS and writes an inline `transform` that outranks any
stylesheet rule.

That is not one unlucky component. **Every floating overlay** positions itself the same way, via
Bits UI → Floating UI, as a JS-computed inline transform: `popover`, `tooltip`, `dropdown-menu`,
`select`, `combobox`, `hover-card`, `menubar`, `context-menu`, `navigation-menu`. Several other
registry items delegate geometry or ship their own stylesheet: `carousel` (embla), `resizable`
(paneforge), `sonner` (svelte-sonner), `chart` (LayerChart/d3).

| ID | Requirement | Source | Acceptance | Check |
|---|---|---|---|---|
| **LIB-17** | A component whose **geometry is computed in JS** or whose **CSS ships outside `src/`** is admissible only with (a) the hole recorded in `DECISIONS.md`, and (b) the assertions it will red pre-registered in `non-vacuity-floors.test.ts`'s `PENDING_RULING`. | the accessibility-floor spike, on the record | Given adoption of such a component, When the change lands, Then both artefacts exist. | manual, at review |
| **LIB-18** | **Prefer the non-floating primitive** when one expresses the same intent. `alert-dialog` and `dialog` are centred and CSS-positioned; `popover`/`tooltip`/`dropdown-menu` are not. Encore's phone surface has **no** surviving overlay, so this rule governs new work rather than a migration. | this audit: 0 overlays in `routes/+page.svelte` | Given a new overlay need, When a centred primitive suffices, Then the floating one is not used. | manual, at review |

### Consequence for `Tooltip`

`Trend.svelte`'s readout bubble fires on plain `:focus` **as well as** `:focus-visible`, precisely
because a touch tap does not match `:focus-visible` — that is why the count left `title=` in the
first place. Bits UI's Tooltip is pointer/keyboard-oriented and would regress the phone path. So
`Tooltip` is a **registry gap that stays open**: the primitive exists upstream, and adopting it here
is a behaviour change requiring its own decision. `SongRow`'s native `title=` attributes have the
same problem and the same status.

---

## Group 5 — Required set, and the gaps

The registry carries 62 components ([shadcn-svelte.com/docs/components](https://shadcn-svelte.com/docs/components),
read 2026-09-14). **22 are vendored**: alert, alert-dialog, badge, button, card, chart, checkbox,
collapsible, empty, field, input, item, label, native-select, progress, skeleton, slider, sonner,
spinner, switch, table, tabs.

`alert`, `alert-dialog` and `switch` were added by this migration; each is wired to a real call site,
because "vendored but unwired reads as migrated when it is not".

| ID | Requirement | Rationale | Acceptance | Check |
|---|---|---|---|---|
| **LIB-19** | These are **required and not yet vendored**, each with a named call site: `separator` (metrics worker divider · `JoinLanding`'s labelled "or" rule), `textarea` (`LyricsReselect`'s paste path), `radio-group` (`ColourPicker`'s swatch grid), `button-group` (the hero transport · the ∓semitone pair · `/admin`'s confirm cluster), `input-group` (the search dock's leading icon), `input-otp` (`CodeEntry`'s six segments). `toggle-group` and `tooltip` are deliberately **not** required — see the notes below. | this audit | Given the required list, When a component is vendored, Then it is wired to the named call site in the same change. | inventory |
| **LIB-20** | A vendored component carries an **`ENCORE DEVIATIONS`** HTML comment at the top naming each divergence from registry output and the test that enforces it. 18 of 19 comply; `button/` uses an older marker inside `<script module>` and is the known exception. | `ui/README.md` | Given a file in `ui/`, When it lacks the header, Then the requirement fails. | source scan |
| **LIB-21** | **A guard follows what it watches.** A migration that ends a guard's premise re-anchors it in the same change, or retires it on the record with its successors named. A guard left passing vacuously is a defect, not a pass. | `non-vacuity-floors.test.ts` `RETIRED` registry | Given a retired premise, When the suite runs, Then no assertion passes vacuously. | `non-vacuity-floors.test.ts` |
| **LIB-22** | **No call site may ask for a Button size pinned under `--tap`.** Every stock registry size is: `xs` 24px, `sm` 32px, `default` 36px, `lg` 40px. A size complies by deferring to the tap token or by pinning no height at all. | measured; four controls regressed 44px→32px during this migration | Given a `<Button size="…">`, When the size pins a height under 44px, Then the guard reds. | `button-tap-floor.test.ts` |
| **LIB-23** | **A vendored component may not size itself through a named scale key.** `max-w-*`, `w-*`, `min-w-*`, `h-*`, `size-*` with a word key resolve through a namespace, and this app bridges t-shirt SPACING keys while NOT bridging the container scale. Arbitrary values resolve nothing and cannot land in the wrong namespace. | `max-w-xs`→6px, `max-w-sm`→8px, both live, both under a green suite | Given a `ui/**` component, When a dimension utility uses a word key, Then the guard reds. | `vendored-dimension-keys.test.ts` |
| **LIB-24** | **No HTML comment may contain `/*`.** Guards that strip C-style comments do so first, so `/**` in markup opens a comment that swallows real markup and makes those guards report failures about code that is present. | four guards mis-reported during this migration | Given any `.svelte` file, When an HTML comment contains `/*`, Then the guard reds. | `markup-comment-safety.test.ts` |

### Naming note

`tags-input` and `pin-input` **do not exist** in shadcn-svelte — `CodeEntry`'s six-segment room code
maps to `input-otp`. There is no `form` component either; forms are a docs pattern over `field`.
`combobox` exists as a registry item (unlike shadcn/ui React, where it is a docs-only composition).

---

## What was violated, and what closed it

Every row this document opened with has since closed. The section is kept rather than deleted because
the *reasons* are the reusable part, and because a reader who trusts the first draft would otherwise
believe the migration had not started.

| # | Finding | Closed by |
|---|---|---|
| 1 | `/admin` painted four text colours with `var(--muted, …)` — a **surface** token, measuring ~1.3:1. The `#8a8a8a` fallback never fired because `--muted` *is* defined. | Fixed on trunk by the `/admin` primitive-adoption pass, before this branch existed. |
| 2 | `/admin` was the least-migrated file and carried the only off-token palette (seven literals). | Same pass — `Item` + `Button` deleted thirteen rules and every literal with them. |
| 3 | The destructive leave-the-room confirm had no `role="dialog"`, no focus trap, no Escape. | `alert-dialog` vendored and the flow ported. |
| 4 | Every settings tab exposed **two nested tabpanels** — the page re-declared the contract `Tabs.Content` already provides. | Attributes dropped from the inner wrapper; the guard that watched it re-anchored to catch the nesting instead of the spelling. |
| 5 | `.done` was a half-finished migration its own CSS comment claimed was complete. | Three call sites moved to `Button size="block"`. |
| 6 | `routes/+page.svelte` did not import `Button` at all — 8 raw buttons and 2 anchors-as-buttons. | All nine migrated; only the drop *zone* remains, which is not a control. |
| 7 | Token drift the guards could not see: off-scale radii and 46 raw `font-size` literals. | Radii on tokens or documented as chart geometry; 41 literals snapped to `--ph-text-*`, one display step added, three kept with reasons. |

## What the migration itself found

These are the findings that did not exist when the document was written, and they are the reason
Group 4's admissibility rule and the three new guards exist. Each was invisible to every gate except
one, which is the pattern worth internalising.

**1. A named scale key resolved through the wrong namespace, twice, and produced a real number.**
`max-w-xs` on `alert-dialog` emitted `max-width: var(--space-xs)` — **6px** — and the dialog rendered
as a narrow strip with its text overflowing. Tailwind resolves `max-w-<key>` against `--container-*`,
which this app does not bridge; it fell through to the spacing namespace, which it does. It passed
eslint, `svelte-check` 0/0 and the whole suite. **Only a screenshot found it.**

Then the guard written for that defect immediately found a *live* second instance: `max-w-sm` in
`ui/empty/empty-content.svelte`, emitting `max-width: var(--space-sm)` — **8px**. Every empty state in
the app had its content column capped at 8px, in shipped code, under a green suite.

**2. Every registry size is under the tap floor.** `xs` 24px, `sm` 32px, `default` 36px, `lg` 40px,
against `--tap: 44px`. Only `icon` and `block` complied, and both force a shape — so an inline control
had no compliant size to migrate onto, and `sm` is the obvious-looking choice. Migrating four 44px
hand-rolled controls that way silently dropped them to 32px. A `tap` size now exists for this.

**3. A glob in a markup comment made four guards lie.** Half the guards strip C-style comments before
scanning, and they strip them first. `` `components/ui/**` `` inside an HTML comment opens a comment at
`/**` that runs to the next terminator, blanking hundreds of lines. The guards then reported failures
about markup that was still perfectly present. Nothing errors; only the guards see the mangled text.

**4. A re-anchored guard went green against JavaScript.** `contract.test.ts`'s Group C was re-pointed
at `.row button.add`, with a note to re-anchor when `SongRow` migrated. On migration it did not fail —
it matched `ids.add(m.id)`, a `Set` method call, because the resolver looks for `.add` as text. A
re-anchor is itself a change that can introduce vacuity, so the arm now tests the resolver against
synthetic sources rather than asserting about an app that no longer has the shape.

---

## Verification

The two rungs from [`04-verification.md`](04-verification.md) apply unchanged, and the split matters
more here than anywhere else in the document set.

- **Rung M (mount)** can prove a class is *written*. It cannot prove it *paints*.
- **Rung L (layout, real headless Chromium via `tests/e2e/cdp.mjs`)** is the only rung that can
  falsify a size, a hit box, a clip or a contrast ratio.

**No source scan may make a measurement claim.** `slider.svelte`'s dead `min-height: var(--tap)` is
the standing proof: the rule text was correct, the guard read the text, the build dropped the rule,
and a **screenshot** found it. Accordingly:

| ID | Rule |
|---|---|
| **LIB-25** | Every migration step ships a before/after frame pair from a driven room. `tests/e2e/shoot-913.mjs` is the capture script and runs against either tree. the composition change's four worst defects were all correct in source and wrong on screen. |

`LIB-25` governs *how* the other twenty-four are checked rather than what they assert, which is why
it sits here rather than in a group.

---

## What is deliberately not here

- **A visual redesign.** This document changes *what builds a control*, never *what it looks like*.
  Where a primitive's appearance differs from Encore's, the primitive is given Encore's appearance
  and the divergence is recorded (LIB-20). The northstar layouts in
  [`01-tv.md`](01-tv.md) / [`02-phone.md`](02-phone.md) are untouched by it.
- **An aesthetic brief.** Still absent, still deliberately — see
  [`03-colour-tokens.md`](03-colour-tokens.md). Migrating to a component library does not supply one,
  and pretending it does is how a library ends up blamed for a flat-looking product.
- **A `Tooltip` adoption**, for the `:focus-visible` reason in Group 4.
- **A rule for `ColourPicker`'s hue slider.** Three independent reasons keep it native: the track
  **is** an `oklch` colour space painted on per-browser pseudo-elements, the thumb shows the picked
  colour via `var(--singer)`, and `touch-action: none` stops the profile sheet stealing the drag.
  `ui/slider` renders div-based track/range/thumb and has no path to any of the three.
- **A rule for `RangeBar`.** Four superimposed layers, `aria-hidden="true"`, no series to plot —
  `Progress` is single-value and `Chart` would add nothing.
- **Whether the three settings booleans should read as `Switch` rather than `Checkbox`.** That is a
  design judgment nobody has made, and inventing it here would be the same error
  `03-colour-tokens.md` warns about.
