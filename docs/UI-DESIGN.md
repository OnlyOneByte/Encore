# UI design rules

The visual-design rules the phone and TV surfaces are held to: control contrast, the spacing and type ladders,
one look per action, one label register, one commit control, and where the join gate sits. Most rules name
the test that holds them. Tokens are declared in `core/src/app.css`; [`FRONTEND.md`](FRONTEND.md) is the wider
frontend contract. The principles these rules serve, in priority order, are the [UI tenets](UI-TENETS.md).
Contrast figures are WCAG 2.2 ratios computed from the token values, and the tests bound most of them.

## 1. A control's boundary clears 3:1 (SC 1.4.11)

Every text entry and every control whose edge is what says "this is a control" draws that edge with
`--control-line` (`#76769e`), not `--line`:

| pair                                   | ratio      |
| -------------------------------------- | ---------- |
| `--control-line` on `--card2`          | **3.65:1** |
| `--control-line` on `--card`           | **3.97:1** |
| `--control-line` on `--bg`             | **4.53:1** |
| `--control-line` on `--track-bg`       | **3.13:1** |

The sites are `ui/input`, `ui/textarea`, `ui/native-select`, `FindField`'s `.findbox`, `CodeEntry`'s
`.segment` room-code boxes, `/settings`' colour input and `ui/slider`'s rail (a ring on `.encore-slider-track`).
`Button`'s `outline` variant takes `border-[var(--control-line)]`, and its `keycap` variant takes
`enabled:border-[var(--control-line)]` (its inert state is below).

**`--line` is NOT the control boundary, and must not be brightened into one.** `--line` (`#2a2a3e`) is the card
edge, the list-row rule, the table-head rule, the tab strip, the chip, the spinner and the skeleton shimmer; it
measures 1.13:1 on `--card2` and 1.23:1 on `--card`. Raising it to 3:1 would repaint all of those to fix a
handful of controls.

**`--track-bg` keeps its value** (1.27:1 on `--card`): it is a SURFACE (bars, progress hairlines, the artwork
placeholder), so the slider got a `--control-line` ring rather than a repainted rail. A rail FILL could not
serve anyway: on `--card`, 3:1 arrives between `#666666` (2.99:1) and `#6a6a6a` (3.18:1), a mid-grey bar.

**`--line-strong` bounds only INERT controls**, which 1.4.11 exempts: `Button`'s dashed `keycap` resting
state (upgraded by `enabled:`) and the slider thumb's `data-disabled:` arm. It measures 1.57:1 on `--card`.

**The vendored checkbox is the one documented exception** (`--line` on `--card`, 1.23:1).

**One site is open, pending a design ruling.** `NowPlayingStrip`'s `.btn` declares `border: 0` and
`background: none`, and all four transport buttons carry it. Restart and skip are identified by the glyph
alone (`--ink` on `--card`, 15.56:1); play/pause also has the `--accent` fill (3.38:1 on `--card`); the cheer
key (`btn cheer-key`) has a `--card2` disc, 1.09:1 on `--card`. Whether an icon button whose glyph carries the
identification owes a boundary is a design ruling for the strip, not yet taken; it is recorded as a note in the
`BOUNDARIES` list of `control-boundary-contrast.test.ts`, since `border: 0` offers nothing to assert.

The focus ring is fine: `--focus` is 6.31:1 on `--bg` and 5.53:1 on `--card`.

Held by `core/tests/unit/lib/control-boundary-contrast.test.ts`.

## 2. The spacing ladder steps by at least 1.20

`--space-*` is nine rungs: **2 / 4 / 6 / 8 / 10 / 12 / 16 / 20 / 24** px (`3xs`, `2xs`, `xs`, `sm`, `md`, `lg`,
`2xl`, `4xl`, `5xl`). The rule is a **1.20 minimum adjacent RATIO**, not "no 2px step": 2px is a perceptible
1.5× at the bottom and was an invisible 1.11× at the top of the old ladder (18 → 20). Two pairs sit on the floor, `md` → `lg` (10 → 12) and
`4xl` → `5xl` (20 → 24).

- The names are addresses, not indices. `--space-xl` (14px) and `--space-3xl` (18px) are retired and the
  holes stay; renumbering would silently change what `var(--space-2xl)` means at every site spelling it.
- `--space-5xl` (24px) is the one INTER-surface rung, the section break. Against `.list-row`'s 8px
  `margin-bottom` it gives a 3.0 ratio between sections, where 16 gave 2.0.
- There is no 32 or 48. A declared rung that nothing spells is a defect in its own right, so **the next rung is
  minted WITH its first caller.**
- Most gaps are small on purpose: at least three quarters of rung-spelling `gap` / `row-gap` / `column-gap`
  declarations land wholly in 4–12px, because this is a 480px-max phone column of 8px-spaced rows.

The values are flat px deliberately: `/tv` composes them against a vh-rooted root font size.

Held by `core/tests/unit/lib/space-ladder.test.ts` (rung list and values, the 1.20 floor and its two named
pairs, both retirements, the `@theme` bridge being 1:1, no dead and no undeclared rung, the 4–12px gap floor).

## 3. The type ladder

`--ph-text-*` is eight rungs, at a 16px root:

```
xs    sm    md   base lg   xl    2xl   ·····   3xl
0.75  0.82  0.9  1    1.1  1.25  1.5   ·····   2.6 rem
12    13.12 14.4 16   17.6 20    24            41.6 px
```

- **12px is the floor.** Nothing on the ladder goes under it; `--ph-text-2xs` is retired, with no declaration,
  no `@theme` alias and no caller.
- **No adjacent pair is closer than 1.09.** The closest is `xs` → `sm`, 1.0933; the three rungs under `base`
  sit inside 2.4px.
- `base` (16px, the form-control floor) and `2xl` (24px, the join wordmark, which `scale(0.667)` brings down
  to `base` in the brand bar) are fixed points.
- **The hole above `2xl` is open by ruling.** 24 → 41.6px is a single 1.7333 step, 1.44× the widest other step
  (1.2, `xl` → `2xl`). `--ph-text-3xl` has exactly one font-size site, `/stats`' `.primary .n`, sitting over that
  page's secondary tiles at `2xl`: it is a display size, not the ladder's next reading step. An intermediate rung
  would be declared and read by nothing, so **the next rung is minted WITH its first caller**, at which point the
  1.7333 ratio becomes a measurement worth taking.

Held by `core/tests/unit/lib/type-ladder.test.ts`, which reds if a rung is minted in the hole or `3xl` gets a
second caller — the point at which this section has to be revisited.

## 4. One action, one look

Putting a song in the queue is drawn one way: both branches of `SongRow`'s action are
`<Button variant="iconPrimary" size="icon">`, a single `--accent` fill. The mark differs on purpose — a sparkle
when the press also strips vocals, a bare `+` when it only takes a turn — because the two actions differ in
cost.

Readiness is stated once per row, by the worded pill. `SongRow.svelte` does not spell `var(--ok)`: a green ring
on the action would make the primary action read as a status badge, and the worded pill is readable by a guest
who cannot separate `--ok` from `--warn`.

The "already queued" state is an OUTLINE, not a dimmed fill: `opacity: 0.7` over `--card` would composite
`--accent` to `#5843ad`, 2.31:1, under the 3:1 a control's boundary owes, where the full fill is 3.38:1.

Held by `core/tests/unit/lib/song-row-action-identity.test.ts`.

## 5. One label register

A field label is `--ph-text-md`, weight 500, sentence case, `--ink-dim`: `<Field.Label>` and `app.css`'s
`.control-label` resolve to the same declarations. No class dressed with `text-transform: uppercase` may sit on
or inside a field label; the letterspaced uppercase eyebrow is a section register, not a label register.

Wording: a label takes the second person exactly when the value is the singer's OWN (`Your name`,
`Your color`), and stays a bare noun for anything the room or the box owns. The string is also the accessible
name, which is why the rule is possessive rather than bare for both.

Held by `core/tests/unit/lib/label-register.test.ts`.

## 6. One commit control, and only when there is something to commit

The back arrow is the exit on every settings scope. A commit control renders only when there is a draft to
commit, and its label says which job it is doing: `Saving…` in flight, `Save and close` while the form is dirty
(`core/src/routes/settings/you/+page.svelte`). It sits inside the card, because the refusals it produces name that
field.

## 7. The join gate sits in one place on both hosts

`JoinLanding` renders on `/` (inside the route's `main`) and on `/library` (as a direct child of `.app-shell`).
From `--bp-md` (768px) up it is vertically centred on both; below it the brand band sits at the shell's content
top and the CTA is docked by `.join-main`'s own bottom inset. The placement lives in `JoinLanding`'s own
stylesheet — the route may not state it — and `:global(.app-shell > main:has(.join-main))` outranks the route's
scoped `main` rule so the host cannot absorb the free space.

Held by CLAIM 7 in `core/tests/playwright/specs/gate/measured-join-gate.spec.ts`, which asserts the absolute
placement on each host as well as their agreement.

## 8. Desktop width

- A one-line text field is capped at `--measure-prose` (560px), with no `@media`: `.field-slot` on `/` and its
  twin on `/library`.
- `/library`'s head re-composes from `--bp-lg` (1200px): the `.lib-meta` wrapper puts the field on the row
  grid's first track and the count and refine disclosure on the second; below the arm it is `display: contents`.
  Held by `core/tests/unit/lib/library-wide-head.test.ts`.
- From `--bp-md` `/library`'s rows are an auto-fill grid of `minmax(440px, 1fr)` tracks inside `--max-w` (760px
  from 768, 1080px from 1200), so the library is one column until `--bp-lg` and two after. In the one-column
  stretch `SongRow`'s title box grows with its container, so the width goes to the text; narrower columns would
  truncate titles to buy density a party does not need.
- Three wide-viewport gaps are left as they are, each with its measurement and reasoning in
  [`FRONTEND.md`](FRONTEND.md) ("The Sing tab" and "The library page"): the residual void below a short catalog
  (a content bound, not a layout one), the topbar's gap between the wordmark and the identity cluster, and the
  dock's title-to-transport gap.

## Not covered

`/metrics`, `/stats`, `/admin` and `/song/[mediaId]` have had no page-level design pass beyond the cross-cutting
scale and contrast rules above. Motion is covered by [`UI-CHECKLIST.md`](UI-CHECKLIST.md); loading and error
states have no design rules here yet, beyond what [`UI-TENETS.md`](UI-TENETS.md) asks of them (no indicator that
flashes, and a next action on every failure).
