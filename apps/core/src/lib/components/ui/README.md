# `src/lib/components/ui/` — the design-library copy-in target

shadcn-svelte components land **here**, as real files in `src/`. That is the whole reason
shadcn-svelte was chosen over a headless dependency (`docs/DECISIONS.md`): copy-in keeps component
CSS somewhere the source-scanning design guards can still read and edit it. A headless library moves
that CSS into `node_modules`, where a 38 px button, a 14 px input, a `vh` sheet cap and a
`content: '✕'` all become **invisible rather than illegal**.

This directory is empty on purpose. #853 installed the toolchain and deliberately ported **no**
component: #827 decides whether the `vaul-svelte` drawer is viable for `QueueSheet`, and porting
before that answer is work that may be thrown away.

## Two things to know before you copy a component in here

**1. Preflight is OFF, so a component cannot assume the reset ran.** #853 measured the cost of
enabling it at **2,696 moved boxes** across 8 surfaces and left it out (the issue's option A). A
shadcn component is written expecting `box-sizing: border-box`, zeroed margins and
`list-style: none`. The app already sets `box-sizing: border-box` on `*` itself in `app.css`, which
is the largest single piece, but **margins and list styles are not zeroed** — supply what the
component needs in its own classes, and do not re-add the global import to get it.
`tailwind-toolchain.test.ts` reds if that import comes back without the frames and fallout being
dealt with.

**2. This is the only directory Tailwind scans for utilities.** `app.css` uses `source(none)` plus a
single `@source` pointing here, because whole-repo auto-detection minted 50 utilities out of string
literals in tests and markdown — two of which (`.underline`, `.block`) collided with `ball` marker
class names the app really applies, and the first painted a real underline on the lyrics ball. So a
utility class works in **this** directory and is not minted from app source elsewhere. If you need
that to change, change it deliberately: the guard pins the source list.

## Colour, and why there are no colour utilities

`@theme` in `app.css` registers **non-colour tokens only** — spacing and the TV type ladder. Colour
is not registered and will not be, because registering one mints the whole family with no
per-family opt-out: `--color-accent` would hand out `text-accent` right beside `bg-accent`, and
`--accent` as ink measures 3.63:1 on `--card2` — below AA. That is why `--accent-ink` exists as a
separate token, and #840's 48-stop palette makes the `ink`-vs-`fill` split load-bearing for all 48
stops.

Consequence for a copied component: its `bg-primary` / `text-muted-foreground` class names resolve
to **nothing**. Map them onto Encore's existing `:root` tokens in the component's own CSS
(`var(--card)`, `var(--ink-dim)`, `var(--accent-ink)`, …) rather than registering shadcn's semantic
colour names in `@theme`.
