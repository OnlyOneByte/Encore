# `src/lib/components/ui/` — the design-library copy-in target

shadcn-svelte components land **here**, as real files in `src/`. That is the whole reason
shadcn-svelte was chosen over a headless dependency: copy-in keeps component
CSS somewhere the source-scanning design guards can still read and edit it. A headless library moves
that CSS into `node_modules`, where a 38 px button, a 14 px input, a `vh` sheet cap and a
`content: '✕'` all become **invisible rather than illegal**.

**The shadcn migration filled this directory**, and every component in it is wired to a real call site.
`Label` is reached through `Field.Label` rather than directly; it is the only indirect one.

NO COUNT IS WRITTEN HERE ANY MORE, deliberately. This paragraph used to open "It holds 19 components" and
name all nineteen — and it was wrong within two changes, because a number in prose is a fact nothing
checks. `ls src/lib/components/ui/` is the count, and it is always right. What this file is FOR is the five
constraints below, which a directory listing cannot tell you.

The same rot hit the sentence that followed: "`Switch`, `Textarea` and `Separator` were vendored during the
migration and deleted again, because nothing used them." `Separator` is still gone. `Switch` and `Textarea`
came BACK and are wired — Switch at three call sites on `/settings`, Textarea in `LyricsReselect` — so the
sentence was describing a tree two changes old while sounding like a rule. The rule it was reaching for is
worth keeping, and it is the reason those two were deleted the first time: **"vendored but unwired" reads as
migrated when it is not**, so vendor a component in the change that USES it, never ahead of one.

Unused _parts_ of components we DO use are kept on purpose: a part is the registry's unit, and deleting
one makes the next `--overwrite` look like a regression. `Card.Action`, `Table.Caption`, `Field.Set` and
about twenty others are unrendered and staying. **The one exception is a part whose own dependency goes**:
`Field.Separator` and `Item.Separator` were deleted with `Separator` itself, because a part that imports a
component we no longer vendor cannot compile. If you re-add `Separator`, re-add them with it.

A SECOND exception has since appeared, and it is the reverse shape — a part whose own RENDER goes.
`drawer-overlay.svelte` is vendored, wired to nothing, and staying: `vaul-svelte` gates the overlay on
`modal`, Encore's only drawer is necessarily `modal={false}`, so it could never mount. It keeps its
component and lost its dead fade CSS. THE PAIR MUST NOT DRIFT: "not rendered" and "not modal" are one
decision, so re-mounting the overlay means revisiting `modal`. See its deviation header.

If you are adding the next one, the five sections below are the constraints that will bite you, in the
order they bit that migration.

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
the ink direction — `text-primary`, `text-destructive` and their siblings — is banned **in app
source**, while this directory is exempt. A vendored component pairing `bg-primary` with
`text-primary-foreground` is correct — white on `#7254e6` is 5.09:1.

Still not registered, and not negotiable: the **player hues**. The 48-stop palette splits `ink`
from `fill` per stop (13 of 48 differ), which no single minted utility can respect.
Do not register one.

## 2. A scoped rule cannot reach an element a child component renders

This is the one that shipped a real bug, so it is first among the mechanics.

Svelte compiles `.foo { … }` to `.foo.svelte-<hash>` and puts that hash on elements **this file**
renders. Hand the class to a child component — `<SliderPrimitive.Root class="foo">` — and the element
that finally carries it belongs to Bits UI and carries no hash. The rule ships in the bundle and
matches nothing.

`slider.svelte` did exactly that. `min-height: var(--tap)` was dead in the build, the 28 px thumb
overflowed into the label above every settings slider, and **a source-reading check passed the whole
time** — it read the rule's TEXT, and the text was correct. A screenshot found it. This is why the live gate
measures RENDERED geometry (`tests/playwright/specs/gate/measured-hit-extents.spec.ts`) instead.

Two correct forms:

- `:global([data-slot='…'])` — shadcn's own attribute for the element, stable across a re-vendor in a
  way one of our class names is not. This is what `slider`, `progress`, `tabs-*`, `field-*`, `item`
  and `sonner` use.
- put the class on a plain element **this** file renders. `card`, `input`, `native-select`, `badge`,
  `skeleton`, `spinner` and `table` can do this because their root is a real tag.

Nothing checks this automatically any more: the broken form ships silently, so check reach by hand.

## 3. This is the only directory Tailwind scans

`app.css` uses `source(none)` plus a single `@source` pointing here, because whole-repo auto-detection
minted 50 utilities out of string literals in tests and markdown — two of which (`.underline`,
`.block`) collided with `ball` marker class names the app really applies, and the first painted a real
underline on the lyrics ball.

Two consequences, and the migration hit both:

- A utility written in a **page** is emitted nowhere. `class="w-full"` on a call site does nothing, so
  every call-site difference has to be a **variant** on the component.
- A class handed to a component is scoped to the **caller**, where Svelte strips it as unused. So
  appearance moves into the component, and only page **layout** stays behind — on a wrapper element
  when it must apply to a grid or flex item.

## 4. Motion is banned by name, and transitions are transform/opacity only

`transition-*`, `animate-*`, `duration-*` and `ease-*` are banned as utility NAMES tree-wide, because a
keyframes utility cannot honour Reduce Motion. Nine of the migrated components shipped
`transition-all`; all of it was stripped.

Live motion is allowed when it is declared CSS on a composited property. `progress.svelte` transitions
`transform` only — never `width` — which is why both process bars drove a `scaleX`/`translateX` rather
than resizing. `progress`, `skeleton` and `spinner` all declare their motion **inside**
`@media (prefers-reduced-motion: no-preference)`, so motion is opt-in and there is no reset that can
lose the cascade. `progress` was the odd one out — it reset with `transition: none` under `reduce`, one
declaration a later rule could out-cascade while its two directory siblings had nothing to out-cascade.

## 5. Preflight is OFF, so a component cannot assume the reset ran

An earlier measurement put the cost of enabling it at **2,696 moved boxes** across 8 surfaces and left it out. A
shadcn component is written expecting `box-sizing: border-box`, zeroed margins and `list-style: none`.
`app.css` sets `box-sizing: border-box` on `*` itself, which is the largest single piece, but
**margins and list styles are not zeroed** — supply what the component needs in its own classes, and
do not re-add the global import to get it — that import is the one-liner §3 bans.

## 6. The type scale here is the app's, written the long way

Every font-size in this directory reads a `--ph-text-*` rung as `text-[length:var(--ph-text-md)]`.
**28** Tailwind size utilities used to live here — 21 of them `text-sm`, whose `0.875rem` is on neither
app ladder. The `font: inherit` move into `@layer base` is what made them start mattering: unlayered,
that reset beat every font-size Tailwind emits on `button`/`input`/`select`/`textarea`, so `<Button>`'s
`text-sm` was dead on a `<button>` and live on an `<a>`. Measured on a `<button>` in `/components`
after the move: **14px**, so this is newly visible. The map is
`text-xs`→`--ph-text-xs` and `text-base`→`--ph-text-base` **exactly**, `text-sm`→`--ph-text-md`
(14 → 14.4px) and `text-lg`→`--ph-text-lg` (18 → 17.6px). `--ph-text-md` is the rung `.encore-empty`
already declares for itself, so the vendored body size and the app's now agree.

**It must be `text-[length:…]`, never the `text-ph-md` utility `@theme inline` mints.** `cn()` is a
stock `twMerge`, whose font-size group recognises only t-shirt sizes and arbitrary values, so
`text-ph-md` lands in the text-**COLOUR** group instead — and the collision is silent and total:
`twMerge('mt-4 text-ph-md text-muted-foreground')` returns `mt-4 text-muted-foreground`. The size is
**deleted**, on the nine files here that pair a size with a colour. The same misclassification stops a
caller's `text-lg` from overriding it. The arbitrary form is grouped correctly in both directions.
This is why `--text-ph-*` in `@theme` emits nothing and has no call site — leave it as the ladder's
record, but do not "tidy" a class string into it.

The `leading-app-*` beside each size is not decoration. Tailwind's `text-sm` sets a line-height too,
and nothing sets one on `body` — it computes to `normal`. Swapping the size alone would retighten every
wrapped description here from a 20px line box to 17px. The rung is the nearest app one to what
Tailwind emitted: `leading-app-normal` (1.45) for the 1.4286 that rode `text-sm`, `leading-app-loose`
(1.6) for `text-lg`'s 1.5556 — that one reproduces the old 28px line box to within **0.16px** and is a
line-box match, not a typographic opinion. The six sites that already declared a `leading-*` keep it
and take the bare size. `button` and `chart-container` take none: the former is `whitespace-nowrap`
inside a fixed height, the latter's text is SVG.

This is the one deviation **not** recorded per file, because it is identical in all 22.

---

## Adding the next component

1. `cd. &&./node_modules/.bin/shadcn-svelte add <name> --yes` (`bunx` fails — CodeArtifact
   401). Run `bun test` from the **repo root** afterwards; `bunfig.toml` and its preload live there,
   and running from `.` reports phantom failures.
2. Strip every motion utility (§4) and check `var()` references resolve — a name that exists only in
   the `@theme` bridge mints a utility but emits **no** custom property, so reading it as
   `var(--color-popover)` paints nothing. Check each `var()` by hand.
3. Give it Encore's appearance where the registry's differs, and record **why** in an `ENCORE
DEVIATIONS` HTML comment at the top of the file, naming the test that enforces each item. They are what
   makes an `--overwrite` reviewable. Every component here carries one in that exact form bar one; `button/` is
   the odd one out, using `DEVIATIONS FROM REGISTRY OUTPUT` inside a `<script module>` block because it
   predates the convention. Its content is the most thorough here — only the marker differs, so a grep for
   the mandated header misses it.
4. Watch §2 when you write the CSS.
5. If it replaces something guarded, the guard **follows what it watches** — re-anchor it in the same
   change, or retire it on the record with its successors named (the retired list at the top of
   `tests/playwright/world/selectors.ts` is the surviving example of that form). A guard whose premise a change ends must not be left passing
   vacuously.
6. Look at it. The four worst defects of the migration were all correct in source and wrong on screen, and every one
   was found by comparing before/after screenshots — the `shot` Playwright project is the capture
   script, and it runs against either tree.

## What is deliberately NOT here

- `.card` in `app.css` is **not** dead and must stay. **Nine** elements take the shared surface rather
  than a `<Card.Root>`: three queue/list rows, the hero, the TV progress track, a code-entry segment, the
  reorder bar, `MyPositionCard` and `JoinLanding`. That enumeration is no longer enforced in either
  direction, so it is authoritative only as far as it is kept true — count the callers before trusting it.
- The search dock's input stays native — a bare text node inside a composed container that wants none
  of what `Input` provides.
- `TvPlayer`, `LyricsOverlay`, `VisualizerStage` and `RangeBar` have no registry target at all.
