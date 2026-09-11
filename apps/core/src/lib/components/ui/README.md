# `src/lib/components/ui/` — the design-library copy-in target

shadcn-svelte components land **here**, as real files in `src/`. That is the whole reason
shadcn-svelte was chosen over a headless dependency (`docs/DECISIONS.md`): copy-in keeps component
CSS somewhere the source-scanning design guards can still read and edit it. A headless library moves
that CSS into `node_modules`, where a 38 px button, a 14 px input, a `vh` sheet cap and a
`content: '✕'` all become **invisible rather than illegal**.

**#913 filled this directory.** It holds 19 components, every one wired to a real call site: Button,
Input, NativeSelect, Label, Field, Checkbox, Slider, Tabs, Collapsible, Card, Badge, Progress, Table,
Item, Empty, Skeleton, Spinner, Sonner and Chart. `Label` is reached through `Field.Label` rather than
directly; it is the only indirect one.

`Switch`, `Textarea` and `Separator` were vendored during the migration and deleted again before review
closed, because nothing used them — "vendored but unwired" reads as migrated when it is not. Unused
*parts* of components we DO use are kept on purpose: a part is the registry's unit, and deleting one
makes the next `--overwrite` look like a regression. If you are adding number 20, the five sections below
are the constraints that will bite you, in the order they bit #913.

---

## 1. Colour IS registered now, and a stock class resolves

This reverses what this file used to say, so if you remember the old rule, read this.

`app.css` defines a **semantic layer** in `:root` — `--primary: var(--accent)`, `--muted: var(--card2)`,
`--ring: var(--focus)`, `--card-foreground: var(--ink)` and the rest — and bridges those into `@theme`
as `--color-primary`, `--color-muted`, … So a vendored component's `bg-primary`, `border-input` and
`text-card-foreground` **work untouched**. That is the point: `shadcn-svelte add <x> --overwrite` stays
safe, and a component does not need hand-mapping to render.

Those are aliases, not new colours. Each points at the token that already decided the question, so
there is still exactly one place any colour is chosen.

**What is banned is the INK direction, by name.** `--accent` as ink measures **3.85:1** on `--bg`,
**3.38:1** on `--card`, **3.10:1** on `--card2` and **2.90:1** on `--card-tint2` — four AA failures.
Registering `--color-primary` hands out `text-primary` in the same breath as `bg-primary`, and there
is no per-family opt-out. So the hazard is handled where it actually lives:
`shadcn-ink-ban-913.test.ts` bans `text-primary`, `text-destructive` and their siblings **in app
source**, and exempts this directory by path. A vendored component pairing `bg-primary` with
`text-primary-foreground` is correct — white on `#7254e6` is 5.09:1.

Still not registered, and not negotiable: the **player hues**. #840's 48-stop palette splits `ink`
from `fill` per stop (13 of 48 differ), which no single minted utility can respect.
`tailwind-toolchain.test.ts` pins that.

## 2. A scoped rule cannot reach an element a child component renders

This is the one that shipped a real bug in #913, so it is first among the mechanics.

Svelte compiles `.foo { … }` to `.foo.svelte-<hash>` and puts that hash on elements **this file**
renders. Hand the class to a child component — `<SliderPrimitive.Root class="foo">` — and the element
that finally carries it belongs to Bits UI and carries no hash. The rule ships in the bundle and
matches nothing.

`slider.svelte` did exactly that. `min-height: var(--tap)` was dead in the build, the 28 px thumb
overflowed into the label above every settings slider, and **`touch-targets.test.ts` passed the whole
time** — it reads the rule's TEXT, and the text was correct. A screenshot found it.

Two correct forms:

- `:global([data-slot='…'])` — shadcn's own attribute for the element, stable across a re-vendor in a
  way one of our class names is not. This is what `slider`, `progress`, `tabs-*`, `field-*`, `item`
  and `sonner` use.
- put the class on a plain element **this** file renders. `card`, `input`, `native-select`, `badge`,
  `skeleton`, `spinner` and `table` can do this because their root is a real tag.

`ui-scoped-style-reach-913.test.ts` fails on the broken form.

## 3. This is the only directory Tailwind scans

`app.css` uses `source(none)` plus a single `@source` pointing here, because whole-repo auto-detection
minted 50 utilities out of string literals in tests and markdown — two of which (`.underline`,
`.block`) collided with `ball` marker class names the app really applies, and the first painted a real
underline on the lyrics ball.

Two consequences, and #913 hit both:

- A utility written in a **page** is emitted nowhere. `class="w-full"` on a call site does nothing, so
  every call-site difference has to be a **variant** on the component.
- A class handed to a component is scoped to the **caller**, where Svelte strips it as unused. So
  appearance moves into the component, and only page **layout** stays behind — on a wrapper element
  when it must apply to a grid or flex item.

## 4. Motion is banned by name, and transitions are transform/opacity only

`motion.test.ts` rejects `transition-*`, `animate-*`, `duration-*` and `ease-*` as utility names
tree-wide, because a keyframes utility cannot honour Reduce Motion. Nine of #913's components shipped
`transition-all`; all of it was stripped.

Live motion is allowed when it is declared CSS on a composited property. `progress.svelte` transitions
`transform` only — never `width` — which is why both cook bars drove a `scaleX`/`translateX` rather
than resizing. `skeleton` and `spinner` declare their animation **inside**
`@media (prefers-reduced-motion: no-preference)`, so motion is opt-in and there is no reset that can
lose the cascade.

## 5. Preflight is OFF, so a component cannot assume the reset ran

#853 measured the cost of enabling it at **2,696 moved boxes** across 8 surfaces and left it out. A
shadcn component is written expecting `box-sizing: border-box`, zeroed margins and `list-style: none`.
`app.css` sets `box-sizing: border-box` on `*` itself, which is the largest single piece, but
**margins and list styles are not zeroed** — supply what the component needs in its own classes, and
do not re-add the global import to get it. `tailwind-toolchain.test.ts` reds if that import comes back.

---

## Adding component 23

1. `cd apps/core && ./node_modules/.bin/shadcn-svelte add <name> --yes` (`bunx` fails — CodeArtifact
   401). Run `bun test` from the **repo root** afterwards; `bunfig.toml` and its preload live there,
   and running from `apps/core` reports phantom failures.
2. Strip every motion utility (§4) and check `var()` references resolve — a name that exists only in
   the `@theme` bridge mints a utility but emits **no** custom property, so reading it as
   `var(--color-popover)` paints nothing. `design-system.test.ts` catches that.
3. Give it Encore's appearance where the registry's differs, and record **why** in an `ENCORE
   DEVIATIONS` HTML comment at the top of the file, naming the test that enforces each item. Every
   deviating component here carries one; they are what makes an `--overwrite` reviewable.
4. Watch §2 when you write the CSS.
5. If it replaces something guarded, the guard **follows what it watches** — re-anchor it in the same
   change, or retire it on the record with its successors named (`non-vacuity-floors.test.ts` has a
   `RETIRED` registry for that). A guard whose premise a change ends must not be left passing
   vacuously.
6. Look at it. #913's four worst defects were all correct in source and wrong on screen, and every one
   was found by comparing before/after screenshots — `apps/core/e2e/shoot-913.mjs` is the capture
   script, and it runs against either tree.

## What is deliberately NOT here

- `.card` in `app.css` is **not** dead and must stay. Nine elements take the shared surface rather than
  a `<Card.Root>` — three list rows, the hero, the TV progress track, a code-entry segment, the
  reorder bar. `ui-card-surface-913.test.ts` keeps the rule and its callers together in both
  directions.
- `ColourPicker`'s hue slider stays a native range: its track **is** an oklch colour space and its
  thumb shows the picked colour.
- The search dock's input stays native — a bare text node inside a composed container that wants none
  of what `Input` provides.
- `TvPlayer`, `LyricsOverlay`, `VisualizerStage` and `RangeBar` have no registry target at all.
