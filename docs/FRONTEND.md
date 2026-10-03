# Frontend constraints

The rules a change to the phone or television UI has to respect, and what breaks when it does not.
Kept here so the components stay readable; each rule names the files it governs and the guard that
enforces it.

## Styling and the design system

`src/app.css` is the whole design system: the Tailwind v4 entry, the `:root` token layer, the `@theme` bridge
that mints utilities from it, the app's own resets, the focus ring, the `.app-shell` column, and the three
shared primitives (`.card`, `.list-row`, `.singer-dot`). Nothing else in the tree may declare a token.

### Tailwind v4, with Preflight off

Tailwind is imported in THREE PARTS, never as the one-line `@import 'tailwindcss'`, because that pulls
`preflight.css` and the reset restyles a tree that predates it. The toolchain rule
reds if the one-liner returns. Utilities are imported with `source(none)` plus a single `@source` over
`src/lib/components/ui/` — auto-detection mints a utility from any bare token anywhere in the project, and the
lyrics `ball` setting's values became real utilities on the television that way.

Two consequences a change has to respect:

- **A utility written outside the vendored directory is scanned by nothing and emitted nowhere.** A width or a
  tap floor a page needs has to be a component variant (`src/lib/components/ui/button/button.svelte`'s `block`
  and `tap` sizes exist for this) or scoped CSS, never a class in a route.
- **A copied-in component must supply what Preflight would have.** `src/app.css` supplies three resets
  globally — `box-sizing`, `font: inherit` on form controls (body's font-family does not reach one, so a
  vendored field renders in the UA's UI font), and zeroed `ul`/`ol` margins (`Field.Error` is a list whose
  indent utility otherwise stacks on the UA's). Everything else is the component's own job: without an
  explicit `background`, a `<button>` paints the UA's mid-grey `buttonface`; without `p-0`, the UA's padding
  eats a switch's track and leaves its thumb two pixels of travel; without `no-underline`, an anchor-shaped
  button paints underlined in the browser's link colour.

The `@theme` bridge has its own two rules. **Every bridge key must be spelled differently from the `:root`
token it forwards** (`--spacing-sm: var(--space-sm)`), because an entry that names itself resolves to nothing
and paints nothing, silently — that is why `--radius-*` is absent. The radius namespace is owned from `:root`
instead: all eight of Tailwind's `--radius-*` keys are declared there, unlayered and therefore ahead of
`layer(theme)`, so a vendored `rounded-xl` paints Encore's 12px. Owning only some of them is the trap — five
leaked Tailwind's own values until `rounded-t-xl` on `Card.Header` was found agreeing with the card's
`--radius-sm` purely because 0.75rem is also 12px. And **no player hue may be registered
there**: minting is all-or-nothing per namespace, so a colour hands out `text-<hue>` alongside `bg-<hue>`, and
the ink-versus-fill split is per-stop across the palette registry. The shadcn semantic layer IS registered, so
a vendored component works unedited, and the ink direction is banned by name in app source instead.

Naming traps that have all bitten at least once:

| Shape                                                             | What happens                                                                               |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| a named t-shirt width (`max-w-sm`, `w-xs`)                        | resolves through the bridged SPACING namespace and collapses to a few pixels               |
| a numeric spacing utility (`p-2`, `gap-6`)                        | resolves against Tailwind's own multiplier, off this app's scale                           |
| a named leading key (`leading-snug`)                              | resolves against Tailwind's default scale, not the app's                                   |
| an app class named after a utility (`block`, `underline`, `ring`) | inherits the utility's declarations wherever a vendored component caused one to be emitted |

Every width in a vendored component is therefore an arbitrary value, which resolves through no namespace;
The named form is the one that bites.

### Tokens, and which may never carry text

A component reads `var(--…)` and never a literal. The rule is broken by a
literal that duplicates a token's value, and on an `@media` width that is not a member of the `--bp-*` list.
Off-scale values (7px, 9px, 0.78rem) deliberately have no token, so a near-miss is invisible to that guard.

Five tokens carry a hard rule:

- **`--grad` is decoration only.** Progress fills and the wordmark through `background-clip`. No ink clears AA
  at both endpoints across the palette registry, and nothing measures the interpolated interior.
- **`--accent` is a FILL, and `--accent-ink` exists because it is not readable as text.** A fill and its ink
  are emitted as one certified pair or neither; the rule fails at a site
  that sets one without the other.
- **`--danger`, not `--accent2`, means failure.** Pink is a valid singer colour, so an error drawn in it reads
  as decoration.
- **`--line` is a DECORATIVE hairline; a control boundary takes `--control-line`.** SC 1.4.11 wants 3:1 for the
  visual information that identifies a control, and a text field's border is the only thing that says "type
  here". `--line` is 1.13:1 on the `--card2` field fill and exempt as decoration on the card, row, table,
  spinner and skeleton edges of the 17 files that keep it; `--control-line` is 3.65:1 on `--card2`, 3.97:1 on
  `--card`, 4.53:1 on `--bg`, and clears 3:1 on every surface token `app.css` declares (the floor is
  `--track-bg` at 3.13, then `--ok-bg` at 3.20). Raising `--line` instead would brighten every card in the app.
  **A SLIDER'S RAIL is that boundary too, and it is where the floor above stops being hypothetical.** Only the
  filled half of `ui/slider`'s rail ever identified the control — the `--accent` range is 3.376:1 on `--card`,
  while the unfilled `--track-bg` remainder, which is most of the rail at a low value and all of it at zero,
  measures 1.269:1 — so the rail takes a 1px `--control-line` ring, 3.972:1 on the `--card` outside it and
  3.131:1 on the `--track-bg` inside. Brightening `--track-bg` instead is the `--line` shortcut in miniature: it
  is the ground under five OUTPUT sites (`Bars`, `TvProgress`, `/tv`'s process bar, the band's progress arc,
  `SongRow`'s artwork placeholder) that 1.4.11 asks nothing of, and no rail FILL can reach 3:1 on `--card` at any
  hue without a mid-grey's LUMINANCE — on the neutral axis 3:1 lands between `#666` (2.99:1) and `#6a6a6a`
  (3.18:1), and contrast reads luminance only, so a tinted rail buys nothing. Both rails grew 2px with the ring
  rather than thinning the fill, because `*` carries `box-sizing: border-box`.
  **A BUTTON is a control too**, and two variants are bounded rather than filled, so both spell
  `--control-line`: `keycap`, which is `bg-transparent`, and `outline`, whose only fill is `bg-background`
  (1.14:1 on the `--card` surfaces it ships on, so the fill identifies nothing). `outline`'s retarget replaces
  the registry's `border-border` **and** its `dark:border-input` — `dark:` here is the bare
  prefers-color-scheme query, so leaving the second would restore `--line` for the users who asked for a dark
  UI. Every other variant paints an identifying fill (`--accent`, `--primary`, `--card2`, `--destructive/10`)
  and needs no boundary. `--input` itself stays aliased to `--line`: it feeds `bg-input/30` **fills** as well as
  `border-input`, so moving the token would be an app-wide fill change, not a boundary fix. Two boundaries stay
  on the `--line` family, and both are named rather than implicit: the vendored checkbox's `border-input`, still
  1.23:1 and a separate item; and `--line-strong` (1.57:1) on the dashed `keycap` and the slider thumb's
  `data-disabled:`, which are INERT — 1.4.11's exception list opens with inactive components. Enforced by
  `tests/unit/lib/control-boundary-contrast.test.ts`, which pins the count, the floor surface, the checkbox
  exception, the rail's four ratios and the `#666`/`#6a6a6a` bracket under them, the ring rule and the two
  heights it cost, the absence of any surviving `border-border`/`dark:border-input` in `button.svelte`, and the
  tailwind-merge eviction the bordered variants depend on.
- **`--ok` states a STATE, never an action, and states it once.** A song row used to spend it three ways at
  once — an `--ok` card border, the "Karaoke ready" pill, and an `iconReady` green ring on the add button — so
  the screen's primary action wore a status colour and read as a badge, while `/library` (every row
  `readiness="ready"`) lit all three in 100% of rows and discriminated nothing. The row now reaches `--ok`
  through exactly one path, `encore-chip-ok` in the worded pill; the one queueing verb is one `--accent` fill in
  `iconPrimary`, and the cost difference rides on the mark and the `aria-label`. A kind chip is toned only when
  the kind is exceptional (`live`, `suspect`, `lyric`) — "Official video" is neutral, because a second green
  pill beside "Karaoke ready" defeats the pill that is now the row's only readiness statement.

`--tap` is the one number the guards read out of the stylesheet rather than restating: `tests/helpers.ts`
parses that declaration, so a control must express the token and never 44. Type is rem on every phone surface,
because `body` declares `font-size: 100%` and the inventory rule bans an absolute
size there; form controls take a 16px floor of their own, because iOS zooms a focused sub-16px field and never
zooms back. The two `--max-w` preludes keep px literals, since a media query is evaluated before the cascade
and cannot read a custom property.

**The phone type ladder opens at `--ph-text-xs` / 12px, and that is a floor, not a starting point.** The rung
below it — `--ph-text-2xs`, `0.68rem` / 10.88px — was DELETED rather than nudged, and the reason matters: six
of its nine callers were uppercase letterspaced eyebrows, five of those on `--ink-dim`, which measures 7.16:1
on `--bg`; the other three were a tabular clock and a prose note in the drawer and `Trend`'s readout at full
`--ink` on `--card2`. Not one of the nine was failing on contrast, so no colour change was ever going to rescue
the size. A rule may go under 12px only as an off-ladder exception that says why IN PLACE, and there is
exactly ONE sanctioned: `src/lib/components/SongRow.svelte`'s duration badge, a photo overlay where a ladder
step outgrows the 84×47 frame it labels. There is also exactly one UNRESOLVED breach, and it is recorded here
rather than licensed — `src/lib/components/RangeBar.svelte`'s `.axis-ends` at 9.6px. It is chart furniture, but
the `aria-hidden` argument does not cover it: `.axis-ends` is a SIBLING of the `aria-hidden` `.rangebar`, so
"C2"/"C6" are announced, and the text beside the chart states the song's own range and octave count, never the
axis bounds — so those facts are restated nowhere. A ladder step widens the end labels past the track they
bracket, which is why it has not simply been raised; whoever next touches that component owes it a real answer.
**Both of those counts are over the app's own stylesheets, and one further sub-12px declaration exists in the
tree** — `src/lib/server/dev-harness.ts`'s `pre`, the raw-frame dump in the `/harness/phone` panes, at `10px`.
It is named here so the two counts read as exhaustive rather than as a grep that missed something: that page is
hand-written HTML in a template string, spelling every colour as a literal and reaching no token at all, and
`server.ts` mounts it only behind `ENCORE_DEV_HARNESS=1` — off by default on every box including a dev one,
because it is an unauthenticated page that mints queue commands. So it is neither sanctioned nor a breach; it is
not a shipped surface, and the type ladder does not reach it. Restyling it to 12px would be the wrong fix, since
that would imply the rest of the file is governed too.
A third former breach — the badge chip, at 10.4px and 9.92px on the narrowest phone, carrying whole sentences —
was lifted onto the floor, and the `≤380px` arm keeps its padding claw-back and no longer shrinks type.
`--ph-text-base` and `--ph-text-2xl` are FIXED POINTS: base because of the 16px control floor above, and 2xl
because the join wordmark's flight scales by base ÷ 2xl written as the literal `scale(0.667)` (CSS cannot
divide one length by another), so moving either lands the mark between rungs with nothing to catch it.
**Above 2xl the ladder ends 24 → 41.6px, and that gap is deliberately left open.** `--ph-text-3xl` is the
`2.6rem` DISPLAY size and its one caller is `/stats`' primary tile; the step from that page's secondary tiles
at 2xl to its single hero number is the hierarchy, not a hole. An intermediate `2rem` rung was tried and
removed because nothing spelled it, and a rung declared and read by nothing is the defect `--shadow-md` and the
refused 32px `--space` rung already name. The next rung here is minted WITH its first caller, and the 1.733
ratio is a measurement to take at that point, not before.
**Left open is not the same as done, and the review's type-scale finding is therefore HALF addressed.** That
finding named two defects — the crowded bottom and this hole — and only the bottom one landed: the 10.88px rung is
deleted, its nine rule sites moved up onto the 12px floor (one of them, `GuidingTrack`'s `.lab`, has since gone
altogether) and `sm` renumbered, while 24 → 41.6px is untouched. The
ratio is 1.7333, which is 1.44× the ladder's widest other step (1.2, at `xl` → `2xl`), and 17.6px in absolute
terms — wider than the whole 12px that the seven rungs from `xs` to `2xl` share. So this is a ruling with a reason,
not a closed item, and `docs/UI-DESIGN-REVIEW.md` finding 3 carries it as PARTIAL. The rung values, the ratios and
the retirement quoted here are re-derived from `app.css` by `core/tests/unit/lib/type-ladder.test.ts`.

The `--space-*` ladder is flat px and therefore does NOT track that rem type, which is why the three data
pages — `/stats`, `/metrics`, `/metrics/[mediaId]` — keep their gaps in rem. At the default root the two
spellings are indistinguishable (`0.75rem` and `var(--space-lg)` both measure 12px), and that is exactly what
makes the rem one read as sloppiness: at the browser's 200% text-only zoom the type doubles 24px → 48px and a
rem gap tracks it to 24px, while a tokenised gap is frozen at 12px — gap-to-type falls from 0.50 to 0.25 and
the tiles crowd. Only `/stats` wrote that reason down, so a pass over the two silent files tokenised it; all
three carry it now. Giving `--space-*` rem values globally is NOT the fix, because /tv composes those tokens
against a vh-rooted root font-size, where a rem ladder would scale every gap with the viewport.

**The ladder is NINE rungs and its minimum adjacent ratio is 1.20, which is a rule and not an observation.** It ran
eleven — 2/4/6/8/10/12/14/16/18/20/24 — where the closest pair was 18 → 20 at 1.111 and the five rungs from 12 to 20
all stepped by 2px. The floor is a RATIO and not a pixel count on purpose: 2px is a perceptible 1.5× at the bottom of
the ladder and an invisible 1.111× at the top, so a rung under the floor is one nobody chooses on purpose or sees
afterwards, and a site spending it is spending an accident, and a table of registers that SANCTIONS four rungs for one job is not a fix for that. `--space-xl`
(14px, 14 rule sites) and `--space-3xl` (18px, 8 rule sites) are therefore RETIRED, each site moved to the neighbour
that gave it a stated job, with the reason in place at the site and the summary in `app.css` beside the two holes the
retirement leaves in the t-shirt sequence. The names are not renumbered: sliding `2xl` → `xl` would silently change
what `var(--space-2xl)` MEANS at the 33 sites already spelling it. The worst pair is now 1.20, at `md` → `lg` and
`4xl` → `5xl`, and the next rung minted here owes that floor a check in both directions.

That ladder carries four REGISTERS, and a site picks a REGISTER rather than a number:

| Register    | Rungs               | What it separates                                                   |
| ----------- | ------------------- | ------------------------------------------------------------------- |
| intra       | `3xs`–`xs` (2–6)    | parts of one control: a glyph from its label, a chip from its count |
| group       | `sm`–`lg` (8–12)    | siblings in one list or one field group (`.list-row`'s 8px)         |
| inter-group | `2xl`–`4xl` (16–20) | two groups inside one surface (a card's `field-label` margin)       |
| section     | `5xl` (24)          | two sibling SECTIONS of a surface (`.grouphead`'s top margin)       |

A DELTA SITE SPELLS THE RUNG THAT MAKES THE RENDERED BOUNDARY LAND IN ITS REGISTER, not the register's own rung, so
checking a declared token against this table is the wrong check. The app has three such rules, all on `/settings`,
all margins on a `card-content` child: they spell `lg` (a GROUP rung) and render 8 + 12 = 20px, which is inter-group.
The standing rule below says the compared boundary is the rendered one; this is that rule reaching the table.

And one standing rule: **a boundary must out-rank every boundary nested inside it — and the boundary that gets
compared is the RENDERED one, not the declared margin.** Those two are different numbers whenever a margin lands
inside a flex or grid parent, because neither collapses margins, so the parent's `gap` ADDS to the child's margin.
Both violations found were inversions rather than near-misses. `/settings` separated CARDS by 12px while a group
boundary inside one card rendered at 28px — card-content is a flex column with an 8px `gap` and the
`field-label` margin was 20px, and 8 + 20 is what the guest sees, so the ratio was 0.43×, not the 0.60× the
declared margin alone suggests. Fixing it took BOTH ends: the card-to-card row gap up to the section rung (24px)
and the intra-card margin down to `lg`, which renders 8 + 12 = 20px — so 24 / 20 = 1.20×, with the card's
own 8px sibling gap 2.5× below that. (That margin went `4xl` → `xl` when the inversion was found and `xl` → `lg`
when `xl` was retired; at `xl` the boundary was 22px and the container ratio 1.09×.) The other inversion was `/`'s
controls→content break at 12px against the 16px then separating two sections of the same kind.

A register is a claim about NESTING DEPTH, not about the class name: `/library`'s groupheads sit inside the
`.refine` disclosure and therefore take the inter-group rung, pinned in that file, while the shared base rule
carries the section one. `.grouphead`'s margin is deliberately asymmetric for the same reason — section rung
above, group rung below, so a 12px dim label is 3× closer to the list it owns than to the section above it.

**The section rung is a PORTRAIT ruling, and every surface that spends it owes a `@media (max-height: 480px)` arm.**
A phone held sideways has ~390px of height and spends most of it on chrome, so the rung is pure cost there. Three
rules spend the rung — `.grouphead`'s top margin in `app.css`, `/`'s `.find-row` bottom margin, and `/settings`'
`.panel` row gap — and each renders on a surface that now carries the arm at the same 480px threshold: `/` (both of
its two), the song page's Lyrics eyebrow, and `/settings`. `/library` is the exception that proves the register rule
rather than a fourth spend site: every one of its groupheads sits inside the `.refine` disclosure and is pinned back
to the inter-group rung, so it never renders the section rung at all — it carries the arm anyway, naming
`.refine .grouphead` explicitly, because at 0,3,0 that pin would otherwise out-cascade the 0,2,0 claw-back.
`/settings`' arm has to move BOTH ends again — row gap back to 12px and the intra-card margin to `3xs`, rendering
8 + 2 = 10px — because clawing only the container back would re-invert the surface; it reclaims a measured 72px on
the Party panel at 844×390, 60px on Server and 12px on You. A new spend site without that arm is an unconditional
height charge on the smallest viewport the app ships to.

The rendered figure also depends on the HOST'S DISPLAY, which is the trap a shared `.grouphead` sets: on a block
parent the eyebrow's top margin collapses against the preceding sibling's bottom margin, on a grid parent it sums.
`/` collapses to 24px below `--bp-md` and sums to 28px at and above it; the song page collapses to 24px and sums to
**34px**, the largest boundary this rung produces anywhere, because its `main` becomes a grid at 768px and `.facts`
carries a 10px bottom margin. That is accepted at width and clawed back on height, and it is written down in that
file — a new host owes the sum a measurement before it inherits the base rule.

There is no 32px or 48px rung on purpose — the widest phone column is `--max-w` 480px, and an unread rung is the
defect this ladder already had at its top end (`--space-3xl` was spelled as a `gap:` nowhere and is now retired
outright; `--space-4xl` is one `gap:`, `--space-2xl` six), so the next one is minted WITH its first caller. That
refusal is also why the `/settings` inversion was fixed by lowering the nested boundary rather than raising the
container: 28px nested would have needed a 32px container.

**What retiring two rungs did NOT fix, recorded so the rung count is not read as the measure.** Of the 63
`gap`/`row-gap`/`column-gap` declarations in `core/src` that spell a rung (a Tailwind `gap-[var(--space-*)]` under
`components/ui` counts, since it compiles to a real gap), 54 — 85.7% — land wholly in 4–12px; before the retirement it
was 53 of the same 63, 84.1%. The band did not thin and was never going to: this is a 480px-max phone column of
8px-spaced `.list-row`s, so most gaps in it are SUPPOSED to be small. **And one crowded pair is left OPEN, not
sanctioned:** `md` → `lg` (10 → 12) is still 1.20, and `md` is the ladder's second-busiest rung at 40 sites — mostly
the cluster gap inside a control row (`/`'s `.topbar` and `.find-row`, `PageHeader`'s `.inner`, the band's `.tp`).
Collapsing it into `lg` would put every one of those rows on the same 12px `.list-row` already hard-codes, which may
well be right, but it is a visual ruling over 40 sites and it wants a live before/after that a static pass cannot
take. It is an open item, not a register.

Dimming is a SURFACE or INK change, never an opacity on a subtree: an ancestor alpha flattens text and the
surface behind it into one buffer, so a token-level contrast check keeps passing while the guest sees
worse. A leaf that carries no text may use opacity. Because that guard reasons about a row by reading the rules
in the ROW'S OWN FILE, any rule declaring a colour has to stay there — `src/lib/components/ui/item/item.svelte`
carries the row grammar's layout and none of its colour for exactly this reason.

### Specificity and reach traps

- **`:focus-visible` is a plain selector list, never `:where()`.** At specificity 0,0,0 the ring loses to any
  single class rule carrying `outline: none`. A control with a non-rectangular shape must raise its own
  specificity rather than hope for stylesheet order — `src/lib/components/ColourRing.svelte` names the role
  attribute alongside its class, because the global rule also sets a small radius and would draw a rounded
  square around a circular control.
- **Scoped CSS cannot reach an element a child component renders.** A plain class rule compiles to a hash that
  lands on nothing, ships in the bundle, and matches nothing — a dead `min-height` shipped on
  `src/lib/components/ui/slider/slider.svelte` that way while the tap-target guard read the rule and passed.
  The sanctioned form is `:global()` on the primitive's own `data-slot`, and
  Reach is the thing to check. A `:global()` that keys on a shared
  attribute must be ANCHORED under a scoped class, or it matches every such element in the app.
- **A class handed to a component is stripped at the caller.** State that a component cannot carry on a variant
  travels as a `data-*` attribute the component forwards (`src/lib/components/SongRow.svelte` does this for its
  three row states).
- **A check's own reach is part of the trap.** A tap-target check that reads CSS RULES means a
  tap floor written as a utility in a class attribute is invisible to it; its control scan reads only
  `class="…"`, so a `class:` directive removes a control from the population. A vendored component renders no
  bare `button` tag for that scan at all, which is why `src/lib/components/ui/sonner/sonner.svelte` carries its
  own floor and a route-level guard holds it.
- **One rule, two selectors, stays one rule.** Inserting anything between the two selectors sharing the page
  measure in `src/lib/components/NowPlayingDrawer.svelte` silently drops the first out of the list and hands it
  whatever follows.
- **Source order settles equal specificity.** The single-class row states (`.mine`, then `.pending`, then
  `.dimmed`) are ordered deliberately in `src/lib/components/QueueRow.svelte` and
  `src/lib/components/ProcessingCard.svelte`.
- **A Button variant's border wins by EVICTION, not by rank.** Tailwind emits `.border-transparent` — which
  `button.svelte`'s base carries so a fill-only variant has no edge — _after_ the arbitrary
  `.border-[var(--control-line)]`, and both are one class. The variant paints only because `cn()`'s
  tailwind-merge drops the base class from the list, so a variant must state its boundary UNPREFIXED: an
  `enabled:`-only border does not conflict with the base and leaves a transparent edge at rest.
  `control-boundary-contrast.test.ts` pins that eviction, because no source read shows it.
- **`min-width: 0` is load-bearing wherever a nowrap child sits in a flex or grid parent.** An item's automatic
  minimum is its min-content width, so without it an unbreakable title sizes the box instead of ellipsising
  inside it, and an empty flex item (the singer dot) is what gives up width first and collapses to 0px.

### Motion, in component CSS

Svelte `transition:` / `in:` / `out:` / `animate:` directives are banned tree-wide: the transition runtime writes its own inline keyframes and never
consults the media query. Tailwind's motion utility NAMES are banned for the same reason. So motion is
authored CSS, and the rules are:

- It lives inside `@media (prefers-reduced-motion: no-preference)`. Opt-in is preferred over
  declared-then-reset, because there is then no reset to lose the cascade to. `reduce` therefore survives in
  exactly ONE stylesheet in the tree — `NowPlayingDrawer`, for the inline-style reason in the last bullet — so a
  second CSS `reduce` block is a defect and not a style choice. A JS read of `reduce` (`MediaQuery`/`matchMedia` in
  `VisualizerStage`, `tv/+page.svelte`, `tv/phrases.ts`) is a different mechanism and stays: those cancel a frame
  loop or pick a still, which no declaration can express.
- Only `transform`, `opacity`, `background`, `color` and `box-shadow` may be animated. Revealing a control is a
  LAYOUT change and is not transitionable, so a reveal has to be stated in `transform` alone, with distances as
  token arithmetic — nothing may read geometry.
- A duration token is NOT a reduced-motion mechanism. Nothing about `var(--motion-fast)` respects a preference,
  and a reduced-motion branch HALTS an animation rather than substituting a shorter one.
- `--motion-tick` is a PERIOD, not a transition: it tracks the once-a-second progress update interval and must
  not be tuned.
- A 1:1 response to a pointer needs no gate and must not have one — nothing is interpolated, so there is no
  duration to zero out. The live-sort SHIFT does have a duration and is gated;
  `src/lib/components/QueueRow.svelte` holds both cases side by side.
- A dependency that writes `transition` as an INLINE style is invisible to the motion guard and unreachable by
  an author rule, so the reduced-motion override needs `!important`. `NowPlayingDrawer`'s sheet slide is the
  one instance, and it sets `transition-duration: 0s` rather than `transition: none`, so the library's own
  bookkeeping still sees a transition it can complete instantly.

## Svelte 5 and reactivity

The app is runes-only. `bun run check` is held at **0 errors and 0 warnings**, so a Svelte warning is a
build failure here, not advice — `state_referenced_locally` is the one that comes up most and the
workaround it forces is described below.

### A dependency set is not a value

The hazard behind the only reactivity defect this tree has shipped twice: an effect's correctness can
depend on WHICH signals re-run it, and that is not something a pure function can be handed or a unit test
can check. Two rules follow.

**Writing an equal primitive into a `$state` scalar notifies nothing.** Comparison is strict `===`, so an
effect tracking only that scalar does not re-run. `play` and `pause` write `isPlaying` and never touch
`positionSec`, so a resume re-delivers the same number.

**So capture an anchor in the effect that reads every signal it depends on.** The band extrapolates the
progress ring between broadcasts from `positionSec` plus a wall clock. With the anchor in its own effect
tracking `positionSec` alone, a resume did not re-run the capture while the interval effect did, and the
ring extrapolated from the clock recorded at PAUSE time — one second after every resume it leapt forward
by the whole pause and clamped full on a song still playing. Both reads now live in one effect in
`src/routes/+layout.svelte`, which makes a stale anchor unrepresentable, and
That shape is load-bearing.

Note that the same two-effect arrangement is fine in `src/routes/+page.svelte`, because it reads
`playback.positionSec` off an object `src/lib/stores/room.ts` REPLACES on every broadcast, so any playback
change re-runs it. Mirroring those fields as scalars is what makes the band cheap and is also exactly what
narrows the dependency set — a component that mirrors cannot borrow the route's shape.

### The room link is a plain class, not a rune store

`src/lib/stores/room.ts` and `src/lib/stores/queue.ts` expose an explicit `subscribe` and plain fields. A
module-level `$state` singleton is shared across SSR requests on the server, which is a cross-request state
leak; plain fields that only move in the browser cannot leak that way. Mutations replace the container
(`this.singers = new Map(this.singers).set(…)`) so a mirror sees the change, and a component mirrors only
the fields it renders.

### Re-triggering an animation with `{#key}`

An animation reads its keyframes when it starts, and a declaration written later cannot retune one already
running. That is why the rolling position digit in `src/lib/components/QueueRow.svelte` and
`src/lib/components/ProcessingCard.svelte` wraps the digit in `{#key seq}`: replacing the node restarts the
CSS animation, which is how motion is re-triggered without a `transition:` directive (those are banned —
see [Motion](#motion-in-component-css)).

Its direction flag comes with three constraints, and all three are load-bearing:

- **`$effect.pre`, not `$effect`** — the direction must be on the element BEFORE the keyed block swaps the
  digit.
- **the previous value is a plain `let`, never `$state`** — it records what was rendered rather than being
  a dependency, and as state it would put the effect in a loop with itself.
- **it is seeded INSIDE the effect as `T | undefined`**, because `let prev = value` at the declaration is a
  `state_referenced_locally` warning and this repo treats that as a failure. The seeded form also means the
  first run writes no state, so the mount rung sees no extra pass.

### Mounting a component under `bun test`

There is no layout engine and geometry reads throw, which puts real rules on any component that binds a
size. See [The mount rung](#the-mount-rung-and-the-rule-it-puts-on-size-bindings) for what those are, and
[`docs/TESTS.md`](TESTS.md) for the two rungs the suite is split into.

## Shared components

`src/lib/components/ui/` is the VENDORED tree — `shadcn-svelte add` writes there and may overwrite it, so every
edit in it is a diff to re-apply and each one is pinned by a guard. `src/lib/ui/` and `src/lib/components/*.svelte`
are authored. The rules below are the ones an innocent edit breaks.

### The now-playing drawer: one surface at two heights

The band IS snap point 0 of `src/lib/components/NowPlayingDrawer.svelte`, not a separate fixed element. A
separate band cannot be dragged open: an outside element can START a pointer gesture but cannot hand the
in-flight pointer to vaul, so the sheet jumps to its open height instead of tracking the thumb.
`src/lib/components/NowPlayingBand.svelte` is COMPOSED inside it rather than absorbed, so it keeps its own file
and surface and the gallery can still render several side by side.

**The snap array is only ever replaced while nothing points into it.** Two mechanisms in this version of vaul
make that a correctness requirement, and both fail silently:

1. the active snap point is looked up by STRICT EQUALITY on its value, so replacing the array under a live
   pointer yields index -1, no snap, and a dead handle;
2. the seating watch writes a transform with no null guard, so seating before the content has bound its ref
   lands the write on `null`, permanently.

So snap 0 is a CONSTANT in `src/lib/sheet-snap.ts` rather than the band's measured height, and it reaches the
stylesheet as `--snap-band` so the rendered strip and the snap point cannot drift. Snap 1 is derived, and every
write to it goes `null` → tick → new value. Seating happens once in `onMount` plus a tick — never an `$effect` —
because the write must land after the ref exists and must be a CHANGE for the lazy watch to see it. A resize
must re-lay the sheet out by hand (nothing in vaul does it, so the sheet keeps the pixel translate it was given
at the old height), debounced, and restoring by WHICH snap point was active rather than by its value.

`src/lib/sheet-snap.ts` holds the arithmetic because it is the half that can be wrong and the drawer cannot be
mounted to check it: snap 1 is the minimum of a viewport ceiling, a top-headroom clearance and the sheet's own
measured content height, floored, with the floor applied AFTER the cap — two snap points resolving to one
offset makes vaul's index lookup ambiguous. The content cap exists because a sheet that opens to several times
its content is what an idle room sees first.

**Drag exclusion is an exclusion, not a whitelist.** `handleOnly` is all-or-nothing: with it off the body's
sliders become drag surfaces and the guiding-track thumb and the dismiss are one gesture, the drawer winning as
the ancestor. So the band row drags and `.np-fit` carries `data-vaul-no-drag`, which vaul resolves with a
`closest()` walk — one attribute covers every control ever added below the band row. The band's transport group
carries its own, because vaul sets pointer CAPTURE on press, so a drag begun on the disc retargets its
`pointerup` back to the button and fires a click. And a drag must not also count as a tap: the band's metadata
block records where a press started and disarms its toggle past vaul's own swipe threshold, or dragging the
sheet down ends in a click that reopens it.

Three more drawer facts that look optional and are not. `modal={false}` is a necessity — a permanently-mounted
sheet whose collapsed height is the docked band cannot put a scrim and a focus trap over the page in use — and
because vaul gates the overlay on modality, `src/lib/components/ui/drawer/drawer-overlay.svelte` renders nowhere
and carries no fade; those two facts belong together.
`trapFocus={false}` is why you can type in the search box: the trap is a layer below vaul, in the dialog
primitive, and its scope installs a document-level `focusin` capture listener for as long as it is enabled —
enabled is `open`, permanently true here. And the GRAB BAR is composed at the call site, not by
`src/lib/components/ui/drawer/drawer-content.svelte`: a real handle must exist somewhere in the tree or
`handleOnly` has nothing to restrict dragging to, but the vendored position is the top of the content box
rather than the row a thumb pulls, and a consumer cannot move a child a component renders for it.
`src/lib/components/ui/drawer/drawer-handle.svelte` sizes the hit area vaul ships undimensioned, from `--tap`
arithmetic on both sides, so the bar's height must stay a token rather than a Tailwind class.

### The mount rung, and the rule it puts on size bindings

happy-dom has no layout engine, so the mount harness replaces every geometry read with a THROW rather than
letting a fabricated zero pass. A zero is not a measurement, and the
two natural guard shapes around one are a permanent red nobody trusts or a permanent silent green.

The consequence is a rule about markup, not about tests. `.band-slot` and `.np-fit` carry `bind:clientHeight`,
so ANY reactive update in that part of the template re-runs its size binding — and on this rung that throws.
So:

> **A size binding must never be driven by a reactive prop or a `class:` directive.** No prop carrying SHEET STATE
> into `NowPlayingBand` is a value: every handler is a callback, and `expanded` is a GETTER rather than the boolean
> it reads, so neither ever changes value. State that needs to reach that subtree arrives as an ATTRIBUTE, because
> an attribute write re-renders nothing and cannot change the measured height — `.np-fit`'s `inert` and the band
> button's `aria-expanded` are both that shape. The band's `title` and `progress` DO change value; they are safe
> only because neither can change its height, `.meta` being pinned at `min-height: var(--tap)` and `.title` nowrap.

The same rung is why `src/lib/components/GuidingTrack.svelte` does not use the vendored Slider (the primitive
reads `offsetWidth` to place its thumb, so it cannot be mounted at all), why
`src/lib/components/LyricsReselect.svelte` hand-rolls its disclosure (the vendored Collapsible reads geometry in
a watcher that fires the moment its element gets a ref, and the deferred read then fails whatever mounted it),
and why `src/lib/components/QueueRow.svelte`'s digit roll is a keyed block plus a keyframe rather than a
class-toggle restarted by an `offsetWidth` read.

Two smaller rung-adjacent rules. A `$effect.pre` that records a previous value seeds it INSIDE the effect
rather than from the prop at its declaration: `let prev = value` is a `state_referenced_locally` warning, and
`bun run check` is held at 0 errors and 0 warnings. And pointer-event properties are not geometry — `pageY` is
a property of the event, so the band's drag-cancel logic is safe on this rung.

### The list rows

`SongRow`, `QueueRow` and `ProcessingCard` share `.card` and `.list-row` from `src/app.css`, and the row grammar
in `src/lib/components/ui/item/item.svelte` through Item's `child` snippet — the row ELEMENT stays in each file,
because a `class:` directive is not valid on a component. Their common contracts:

- **The root's `class` attribute stays STATIC.** Any contrast check derives a row's classes by
  splitting that attribute on whitespace, so an interpolation hands it a token it then applies as a regex and
  reports a nonsense defect about an unrelated rule.
- **A processing mark is a SIBLING of the title, never a child.** The title is a clamp with `overflow: hidden`,
  which makes it a scroll container: a mark inside is clipped off-box exactly when the title is long enough to
  need the ellipsis, which is the state the mark exists to announce. The title's `flex-grow` must stay 0, or the
  clamp box fills the line and pushes the mark to the column's far edge.
- **`ProcessingCard` and `QueueRow` are deliberately byte-identical** on the drag transform, the digit roll and
  the dimmed treatment, because the two kinds sit in ONE list dragged by one gesture, and a difference reads as
  one of them being broken. A long-name fixture additionally
  pins the singer-dot comment in `ProcessingCard` and the gallery fixture that makes its 0px collapse visible.
- **A dragged row is transparent to hit-testing.** It is translated to sit under the finger, so as the topmost
  element at the pointer it is what `elementFromPoint` returns instead of the drop slot beneath, and a release
  on a legal target commits nothing.
- **`SongRow` offers ONE primary action.** A turn with no process is held and skipped by the rotation forever; a
  process with no turn gives the singer nothing. `src/lib/process-and-queue.ts` runs both, in that order,
  because the job's priority is derived from the rotation position of the turns pointing at that media.

### Charts, fields and the rest

`src/lib/charts/Trend.svelte` and `src/lib/charts/Bars.svelte` are marks made of real focusable, labelled
elements rather than plotted paths, which is the whole reason `src/lib/components/ui/chart/chart-container.svelte`
is used for its CONFIG CONTRACT alone: adopting the library's marks would delete the charts' keyboard and
screen-reader surface. A series colour is read as `var(--color-<series>, <token>)`, and the fallback is
deliberate — the custom property is emitted at RUNTIME, so no static scan can see it. Each Trend column claims a
full tap target, so a long window overflows and scrolls rather than shrinking days below a tappable size, and
its readout is revealed on `:focus` as well as `:focus-visible`, because the latter is keyboard-driven and does
not match a touch tap. A `title` attribute is desktop-only and can never be the sole carrier of a value.

`src/lib/components/ui/input/input.svelte` and its sibling select share the `.encore-field` look and three hard
floors: `min-height: var(--tap)`, a 16px font-size on every variant, and `border: 1px solid var(--control-line)`
for the boundary that identifies the control. Two composed fields carry that boundary without the class:
`src/lib/ui/FindField.svelte`'s `.findbox`, where the WRAPPER is the boundary because the inner input is
`border: 0`, and `src/lib/components/CodeEntry.svelte`'s `.segment`, which must override the `.card` it also
composes. That last file also
makes the boxes the source of truth and derives `value` from them, and its completion callback CARRIES the code
— the binding reaches a parent an effect later, so a parent reading its own binding sees the code one character
short and returns silently, which is how the last keystroke and a whole-code paste both do nothing.

`src/lib/components/ColourRing.svelte` is one `role="slider"` on the whole disc: a single tab stop with
`aria-valuetext` over the stop's NAME, arrow steps that WRAP because hue is cyclical, and a diameter derived
from `--tap` — a percentage height resolves against an auto-height parent and computes to zero. Its `taken` pips
are information, never a block, because two singers sharing a colour is legal. The palette's measured contrast
is checked in `tests/unit/lib/palette-registry.test.ts` and deliberately not shown to the person
picking.

There are TWO label REGISTERS, and which one a label wears is decided by what it labels, not by which component
renders it. A FIELD label is `app.css`'s `.control-label` or ui/field's `[data-slot='field-label']` — the same
dress (`--ph-text-md`, weight 500, sentence case, `--ink-dim`). The CLASS is for a label that has to be a plain
`<span>`, so it carries the dress the primitive would have rendered: either nothing a real `<label>` can point at
exists (`ColourRing`'s `role="slider"` disc and `CodeEntry`'s `role="group"` of boxes are named by their own ARIA),
or the label already sits inside a wrapping `<label>` and a `[data-slot='field-label']` would nest one label in
another (the join screen's name field wraps its `Input`, so the association is implicit). A SECTION label is the
uppercase letterspaced one: `.grouphead` above a list of rows, and the `eyebrow` button variant above a
disclosure. They must not be swapped: `.control-label` WAS `.eyebrow`, dressed in the section register, and
settings' You card ended up holding both — a sentence-case `Name` (it reads `Your name` now, see the wording rule
below) over an uppercase `YOUR COLOR`, meeting across
one 8px card gap. Exactly two `--ph-text-xs`/0.1em rows are neither register, and they are neither because they
label no control: the song page's `.fact` list, and the drawer's `.key` row, which names two keycap buttons and
keeps its bold reading in the `.key-head` row above. `GuidingTrack` was a third until its eyebrow was retired — it
labels a slider AND it rendered that eyebrow inside a real `[data-slot='field-label']`, which is the whole evidence:
no screen ever put the two dresses side by side the way the You card did, because `GuidingTrack`'s only hosts are the
drawer and `/components` and neither renders a second field label (the gallery imports no `Field.*`, no `ColourRing`,
no `CodeEntry`) — so this drift had nothing on screen to give it away. Its label text is the primitive's now; the row
kept the value's rank by moving `.gt-val` UP to `--ph-text-md` rather than holding the label down, and `/settings`
already labels the same knob at room scope as `Guiding track · <n>%` in that dress.

ONE MORE LABEL DECISION, about the WORDS rather than the dress. A field label takes the second person exactly when
the value is the singer's OWN — `Your name`, `Your color` — and stays a bare noun for anything the room or the box
owns: `Guiding track`, `Font`, `Join address`, `Room code`. Of the 33 field labels in the tree, 4 are those two
personal values on the two surfaces that edit them (`/settings`' You card and the join screen's identity pane) and
29 are bare. The possessive is not decoration: the string is also the accessible NAME — `ColourRing` hands one
`label` to both its heading and its disc's `aria-label` — so it has to say whose colour it is out of visual
context, where the `You` card title is not read with it. It is the app's voice elsewhere (`Your library`,
`Your lyrics`, `Your pick`, `Your profile`) and `ColourRing`'s own default prop, which `/settings` was the single
site to override away — leaving one control under two names on two screens, `Color` here and `Your color` there.
`tests/unit/lib/label-register.test.ts` pins both halves, the dress and the wording.

`src/lib/ui/icons.ts` ships path data and no codepoints: several transport codepoints default to colour emoji,
the text-presentation selector is honoured unreliably on exactly those, and an emoji is a different drawing on
every platform. `src/lib/ui/Icon.svelte` renders at `1em` in `currentColor` and is `aria-hidden` by default, so
one path serves a phone button and the stage, and an icon-only control's name lives on the BUTTON. The tap
target belongs to the button too — shrinking the hit area to the glyph is how a control ends up present and
unhittable.

`src/lib/ui/PageHeader.svelte` is a detached pill: a surface capped at the page measure while painting to its
own boundary ends in a hard vertical edge with page either side of it. Its inline gutter is measured against
`100dvw` and not `100%` (against the shell the term binds on every desktop page), its `width` is a definite
100% and not `auto` (the shell does not stretch its children, so `auto` shrink-wraps it into a centred title
chip), and its sticky offset carries `env(safe-area-inset-top)` because a sticky offset is measured from the
scrollport rather than from the shell's padding.

## Routes and screens

### Phones versus the television

`NOT_PHONE` in `src/routes/+layout.svelte` is the single list of surfaces that are not a phone, matched on
the route or any descendant of it. It is the same set the phone inventory exempts
from the phone route walk; do not fork a second opinion about what a phone is. The list gates two things
that must agree: whether the layout opens a `role=phone` socket, and whether the band renders. An ungated
`room.connect()` in the root layout would give `/tv` a second socket and register the television as a
singer present in the room.

### The band and `--dock-h`

`src/routes/+layout.svelte` is the only writer of `--dock-h`, the band's measured (never guessed) height,
published on `documentElement` so every scrolling column can reserve it in normal flow. Rules:

- Exactly one element adds `env(safe-area-inset-bottom)` — the band. That inset reaches everything stacked
  above it through `--dock-h`, so a second `env()` term anywhere else doubles the gap.
- The effect's teardown is contractual. An inline custom property on `:root` outlives its writer and
  outranks any stylesheet rule, so a stale `--dock-h` would pad the television's stage by a band it has not
  got, and no media query could override it.
- No media query may set `--dock-h`; the measurement outranks it, so such a rule is silently dead.
- `dockH` seeds at a plausible height, not 0: it is bound to the drawer's snap point 0, which a pushed-down
  0 collapses for a frame.
- The progress ring extrapolates between broadcasts, and its anchor is captured inside the effect that also
  reads `isPlaying`. A resume re-delivers an equal `positionSec`, and writing an equal primitive into a
  `$state` scalar notifies nothing, so a separate anchor effect never re-runs and the interval keeps
  extrapolating from the pause-time wall clock.

### The home column

`/` is one scrolling column, and unjoined it is the join screen instead (`JoinLanding`, which paints its
own wordmark — the topbar is for joined singers only). Joined, it renders in this order:

1. the search field, first on the screen and in normal flow — nothing here is stuck to an edge, because the
   band owns the bottom one and nothing else declares `position` either (the topbar is NOT sticky, despite an
   earlier note in this file and in the route saying so);
2. `Queued`, the rotation in play order, drawn as `QueueRow` or `ProcessingCard` per entry;
3. `Making karaoke…`, which renders in BOTH views;
4. with an empty field, `Your library` — a SHELF of four rows, not the library; at `--bp-lg`, where the row grid
   is two tracks wide, eight. Neither number is `LIBRARY_SHELF` changing value: `LIBRARY_SHELF` is 4 at every
   width and `LIBRARY_SHELF_WIDE` is 8, and the ROUTE picks between them off a `matchMedia('(min-width: 1200px)')`
   read. With a query, `Ready to sing` then `Needs karaoke`.

`searchActive` (a non-empty query) is the sole switch between the queue view and the results view. There is
no browse mode on this column, no `?browse=1`, and no history entry for a search — clearing the field restores
the queue, so Back always means leave the room. Browsing is a separate route (`/library`, below) precisely so
that stays true; the column reaches it from a door BESIDE THE SEARCH FIELD and from the shelf's `See all N songs`.
The door sits on the field's LEADING edge: the trailing edge already carries a spinner while a search runs and the
clear `×` whenever one is active, so a control after the box would be third in a cluster that changes size. It uses
the `secondary` variant rather than `ghost` or `outline` — `outline` fills with `bg-background`, the page colour, so
beside a `--card` field it reads as a hole rather than a control.

The shelf caps at `LIBRARY_SHELF` (4) via `libraryShelf` in `src/lib/library-browse.ts`, which also reports how
many it hid — 0 hides the `See all` door, because a control promising more than it has is worse than none. The
whole library used to render here, under an unbounded queue, so a busy rotation put the songs you already own
metres down the scroll. The cap lives in that module rather than inline because the Playwright fixture seeds
exactly four demo tracks and so can never truncate it; the number is proved in the unit suite instead.
At `--bp-lg` the cap is `LIBRARY_SHELF_WIDE` (8) — the SAME height budget the 4 was measured for, spent two
tracks across, because the row grid is two columns wide from 1200px up. Measured at 900px tall **with ten ready
songs**, the whole column ends at y=770.75 at BOTH 768 and 1440 — identical height, four songs against eight —
so before the wide cap the desktop was spending half the phone's shelf budget to show the phone's shelf, and on
that corpus the space between the last content and the dock at 1440×900 falls from ~246px to ~41px. The route
picks the cap from a `matchMedia` read rather than from CSS: the extra rows do not exist in the DOM for a
stylesheet to reveal, and rendering all eight and hiding four would leave them in the accessibility tree.
`See all N songs` needs no special case — `hidden` follows whichever cap is live.

**Both of those readings are claims about a ten-ready library, and that is not the corpus this tree runs on.**
`data/encore.sqlite` holds 123 media rows, of which 2 are `stem_status='ready'` (the other 121 are `none`), and
`/api/library` serves `listReady()` only — so the shelf holds two rows, under the PHONE cap of four, let alone
the wide eight. Re-measured in headless Chromium against that catalog at 1440×900, joined, queue empty and no
query: the column's last content ends at y=403.4 and the band's top edge is 835, so 431.6px separate them — 496.6
to the viewport floor, and the review's ~460px sits between the two. The wide cap moved none of it, because a cap
cannot bind on two rows: `libraryShelf(rows, 8)` and `libraryShelf(rows, 4)` both return two shown and none
hidden. The review's figure therefore stands in the state a real user of this tree is in. What the wide cap buys
is real but CONDITIONAL: it is worth a screenful once the library has eight ready songs, and nothing before that.

That residue is a CONTENT bound rather than a layout one, and the arithmetic is written down because it is what
decides nothing further is owed: at 1440×900 the page has 762px between the topbar's bottom edge (73) and the
band's top (835), and the entire joined column in this state is 324.4px tall (y=79 to y=403.4) — a find row, an
empty rotation, two song rows. There is nothing to place in the remaining 437.6px. The queue is empty, nothing is
processing, and the other 121 media rows are unprocessed search results this column shows only under a query. The
one candidate was built and measured before being rejected: handing the empty rotation the leftover height
(`min-height: 30vh` on `.queue-empty.tight` at `--bp-lg`) MOVED the void instead of removing it — the rotation's
own block grew from 62px to 270px of centred emptiness and 223.6px still sat below the shelf, two voids where
there had been one. `.queue-empty.tight` keeps `min-height: 0`, for the reason its own comment already gives.

Two rulings make the wide column a layout rather than a stretched phone. The search field carries
`max-width: var(--measure-prose)` on both `/` and `/library` — unconditionally, because a `max-width` only
ever takes space back, and measurement confirms it: the findbox is 230px at a 767px viewport, 510px at 768, and
reaches exactly 560 only once the row passes 746px, which is the cluster's own arithmetic (44px door + 560 +
122px picker + two `--space-md` gaps). At 1440 the input had been ~770px, about 1.4 measures; it is now 508
inside a 560px findbox. `/library`'s twin is capped the same way at 768 (696 → 560) but from `--bp-lg` up it is
bounded by the ROW GRID instead — see the library page's wide head. And from
`--bp-md` the topbar carries a `--line` bottom rule with `padding-bottom: var(--space-lg)`: the bounded-band
form of the header surface every `PageHeader` route already wears, without the pill's fill and blur, which are
earned by being sticky. The rule deliberately spans the shell's content box rather than the rows' column, so it
reads as page structure and not as a row boundary. The wide gap between the wordmark and the identity cluster is
NOT closed: leading brand / trailing account is a desktop header form, the cluster on the far edge leaves the way
into `/settings` in the same corner every other route puts it, and the hairline is what makes that split read as
the two ends of one surface rather than as two things floating in page. `PageHeader` is not the precedent for it —
that component left-packs `.back-slot` then `h1` with `gap: var(--space-md)` and has no trailing slot. Nor is the
gap a constant: `.me-cluster` is `margin-left: auto`, so its size is a function of the singer's display name —
measured 91px at 390x844 and 781px at 1440x900 with an eight-character name.

Left alone, on arithmetic rather than taste: the dock's title-to-transport gap, which the design review put at
~1000px. `.meta` measures 884px at 1440x900 and it is the `nowrap`/`ellipsis` title's OWN box, so a long title
uses it — the same refutation that file applies to tablet rows.

Left alone for a harder reason, with the alternative built first: what the measure cap does NOT do is make the
find row spend the column. At 1440×900 `.find-row` is 1016px and its three controls occupy 212→958, so 270px of
row trails the picker empty, under a hairline that spans the whole content box. Moving `.source-slot` to the
trailing edge (`margin-left: auto` at `--bp-lg`) was tried and measured: it puts the scope picker at 1106→1228,
280px from the field whose scope it sets, and reads as an orphaned control rather than as two ends of one
surface. The topbar's split works because each end carries a whole thing — a wordmark, an identity cluster — and
a `<select>` divorced from its field is not one. So the row stays a LEADING-ANCHORED CLUSTER of three, which is a
composition and not stretched space: the field's leading edge sits on 212, where every row, eyebrow and empty
state below it starts, and the door and the picker stay within a gap of it. `/library`'s head could do better
than that because it has a second thing to put in the width; this row does not.

The processing group is deliberately ungated: its membership is
query-scoped in `src/lib/readiness.ts` row by row, and it subtracts anything the queue above already draws
a bar for so one job never gets two progress bars. A group heading is a claim about what follows it, so
each is gated on having rows.

Reordering is a live sort with no mode, split in two: `liveSortTarget` in `src/lib/reorder-mode.ts` is the
arithmetic — it both places the rows and decides what a release commits, so a drop cannot land somewhere the
guest did not see — and `src/lib/queue-drag.ts` is the browser wiring. Geometry is measured once per gesture
at press time (rows change height mid-flight), pointer listeners go on `window` because the pressed grip
becomes a detached node as the list reorders, and focus is returned by attribute for the same reason; all
three of those rules live in `queue-drag.ts`, and the route keeps only the reactive state they drive. Arrow
Up/Down on the grip is the single-pointer alternative. Queue changes the guest did not cause are announced
through `queueAnnouncement` in `src/lib/phrasing/queue-announcement.ts`, which is silent with no baseline so
joining a busy room does not read the whole queue aloud. The wait on a singer's own row comes from
`waitShort` in `src/lib/phrasing/position-sentence.ts`, which omits an unknown estimate rather than zeroing
it.

### The library page

`/library` is browsing, and it exists because the home column could not be it: the shelf above sat under an
unbounded queue, and the home field cannot stand in for a library because it FETCHES from three resolvers and
needs a name you already know. Browsing is for when you do not.

**What "your library" is.** The READY catalog — `MediaRepository.listReady()`, served by `/api/library` and
mirrored whole in `room.library`. It is NOT the `local` resolver, which searches audio FILES in the media
directory: a processed YouTube song is in the library and absent from that list, so `/api/search?source=local`
answers a different question and must not back this page.

**The filter is a filter, not a search.** `browseLibrary` in `src/lib/library-browse.ts` narrows rows already in
memory, with no request — the whole ready list is there, because the shelf and this page both read it. That is
also the one thing keeping the two fields distinguishable, so the page STATES it: the `N of M songs` count line
is the only element that says this box hides rows rather than fetching them. Two fields that looked alike and did
opposite things would be a worse problem than the reachability one this page fixes.

**Costing nothing is not the same as costing nothing to render.** The filter is debounced 150ms — the home field's
number exactly — and the list renders `LIBRARY_PAGE` (60) rows at a time behind a `Show N more` control. Measured at
390×844 under a 4× CPU throttle with 2000 ready songs: the full list was 40,125 DOM nodes and 4.6s before the first
row was usable, the first two letters of a query blocked the main thread for 634ms and 427ms, and the backspace that
widened the list again blocked it for 3.4s; one page is 1,328 nodes and 0.9s, with keystrokes at 85ms then ~31ms. The
debounce holds `appliedQuery`, never `query`, so the box still echoes instantly and only the rows wait, and
`clearFilters` cancels the pending timer or a cleared filter re-applies itself 150ms later. The window is a DOOR
and never a cap — `/library` is where the shelf's `See all` leads, so a row it would not show is a song you own
with nowhere left to reach it — and it resets to one page WITH THE ROWS rather than with the keystroke, so a
revealed list is not truncated under a filter that has not landed yet.

Matching folds through `foldForMatch` — NFD, marks stripped, punctuation collapsed to a space, so "beyonce"
reaches "Beyoncé" and "dc" still reaches "AC/DC" (deleting punctuation instead would weld that to "acdc").
Terms match as substrings, not prefixes: this narrows a shelf you already own, where half-remembering a word in
the middle of a title is normal, and the cost of hiding a song you own is the point of the page.

**Facets describe the whole library, never the filtered rows** — the rule `/api/library` states for its own
`facets`, because facets derived from the current filter collapse to the value you just picked and strand you
there. Artist facets count `artistCanonical` only, as on the server: `artist` is the uploader a source reported,
so a channel name would otherwise pose as an artist. Artist and tag are mutually exclusive, artist winning, so
the two can never intersect into an unexplained empty page.

**From `--bp-lg` the head adopts the row grid.** `main` is two 500px tracks at and above 1200px (`--max-w` 1080,
less the shell's two 16px gutters and this page's own two, is a 1016px column, and 1016 = 500 + `--space-2xl` +
500), and the head used to ignore them: measured at 1440×900 on this tree's 2-ready catalog, the filter field
painted 560px at x=212 inside a column ending at 1228 — 456px of trailing void — with the count and the
`Sort & filter` disclosure stacked beneath it in their own full-width rows and the first song row at y=250. The
field now takes track one and a `.lib-meta` wrapper takes track two, carrying the count, the disclosure and the
panel, so both halves of the head land on the songs they describe: field 212→712 over the first row's 212→712,
the disclosure at 728 on the second row's leading edge (the count 4px inboard at 732, keeping the `--space-2xs`
inline margin every eyebrow on the page uses), and the first song row at y=180. Expanded, the panel fills that
track (728→1228, 500px wide) instead of a full-width row of its own, so the first song row sits at 354 where it
used to sit at 432. The TAP is not what got cheaper — opening still pushes the rows 174px against the old 182px —
the head did: 70 of that 78px is the collapsed lift and 8 is the panel's placement. Below 1200px `.lib-meta` is
`display: contents` and generates no box, and the
collapsed head reads out identically at 390×844 and 768×900 to what it measured before the wrapper existed —
field 102→172, count 180→196, disclosure 206→250, first row 250.

Two consequences are stated rather than hidden. The field's `--measure-prose` cap goes INERT at these widths,
because track one is 500px against a 560px cap — the grid bounds the field, and 500 is the song row's own width,
so the field's two edges land on the first row's two edges (212→712) instead of overhanging its trailing edge by
60px on one side and stopping 456px short of the column on the other. And lifting the head pushes the trailing
space DOWN rather than away: re-measured in a browser on the 2-ready catalog at 1440×900, the last `.row` ends at
274.4 and `.band-slot` starts at 813, so the gap is **538.6px** while the first row sits at y=180 — against y=309
for the same two songs on `/`. That is the improvement and the residue in one reading: the songs moved 129px
closer to the top, and the space they vacated reappeared underneath them.

An earlier revision of this paragraph put that gap at 560.6px, derived as a 70px lift on a 490.6px base. The
tree measures 538.6, so the two figures could not both be right; the y=180 reading they were quoted beside is
correct. Recorded rather than silently corrected, because the lesson generalises: a number in prose is only as
good as its last re-measurement, and this page's own numbers are pinned in tests wherever a test can hold them.

NOT FIXABLE BY LAYOUT, and stated so nobody tries again: two rows cannot fill the 717px between this page's
`main` at y=96 and the band at 813, however they are placed. The residual desktop void at low content is a
CONTENT bound, not a composition one — it closes when the page has more to show (this catalog carries 123 media
rows of which 121 are `stem_status='none'`, i.e. invisible here), and no `max-width`, `margin` or grid change
touches it.

**Sort & filter is collapsed by default, and that is the page's main design decision.** Expanded, the chip rows
are ~420px of chrome on a nine-song library and put the first song row near y=650 on a 390×844 phone — the exact
fault this route exists to fix, relocated. Scrolling songs is the default state. Opening it by default at
`--bp-lg`, where the panel has its own track and the page has unused height, was considered and rejected on
arithmetic: this tree's two-song library opens to 174px (172→346), but `FACET_CHIP_LIMIT` allows twelve artist
chips and twelve tag chips in one 500px track, so a full library's panel can exceed the 739px the page has and
would put the first row back under the band — the same fault at a different width. The trigger names the active
facet (`Sort & filter · Queen`) because the panel showing the pressed chip may be shut, and without it a guest
reads `2 of 9 songs` as the page having lost their songs. It is the first caller of the `eyebrow` button variant,
which was missing `bg-transparent` and so rendered as a grey `buttonface` slab — see the note on that variant.

`newest` sorts on `id` descending, which is genuinely time descending because a media id is a ULID whose first
ten characters are a base32 millisecond clock; it is the time the row was MATERIALISED by a search, not the time
its stems finished. Ordering is applied explicitly rather than trusting `listReady()`'s own
`orderBy(desc(media.id))`, so this page's order is not an undocumented side effect of a server query.

Adding a song does NOT navigate: you came here to pick, and picking two is normal. The toast carries the way
back (`View queue`) instead, so nothing strands you on a leaf route. Unjoined, the route renders `JoinLanding`
exactly as `/` does — `refreshLibrary` never runs for a guest, so there would be nothing to browse. `libraryLoaded`
on the room link is what separates "not fetched yet" from "you own nothing", so a full library is never accused of
being empty for one frame.

### The join screen

`src/lib/components/JoinLanding.svelte` is the UNJOINED state of `/`, not a route of its own. It has TWO PANES,
and which one is on screen is DERIVED from the resolved room preview rather than from a hand-advanced counter, so
no state can show an identity pane for a room that was never confirmed. Step 1 is the CODE pane, a FALLBACK
reached only by a guest with no code in the URL or whose scanned code did not resolve. Step 2 is the IDENTITY
pane — the room confirmed IN WORDS, the name field, the colour ring, the CTA — and the only pane a guest who
scanned the television's QR ever sees. The room has no NAME in the schema, so "confirmed in words" is who is
here, from the room-preview endpoint.

**Both paths must stay offered, never one instead of the other.** A typed code alone is a cognitive-function test
under SC 3.3.8, and the scan path is what makes this screen conformant. There is nonetheless NO scan affordance
on the code pane, deliberately: that pane is unreachable for anyone who scanned, since a scanned QR resolves and
opens the identity pane directly, and a camera row would be inoperable anyway — the app is served from a
plain-http LAN origin and `navigator.mediaDevices` is secure-context gated. What that costs is the NARRATION: the
SC 3.3.8 argument still rests on the QR existing on the television, but it is no longer stated on this screen. A
deliberate ruling; revisit it here if the conformance claim needs re-making.

What the two panes put on state and markup:

- **The code the join carries is the one the PREVIEW resolved from**, never `scannedCode`. The two differ in
  exactly one case — a scan that failed, dropped to step 1, and was corrected by hand — and reading the scanned
  value there joins the wrong room.
- **`continueToIdentity` takes the code as an ARGUMENT, and the argument wins.** `CodeEntry` fires `oncomplete`
  synchronously from inside its own input handler while its `value` binding arrives an `$effect` later, so
  reading the local copy sees one character too few, fails the length check and returns silently — which is how
  the last character of a typed code and a whole pasted code both do nothing.
- **The step dots are gated on having SEEN step 1**, set from the pane and not from the code path, because "step
  2 of 2" otherwise reports a step the scanning guest never skipped as skipped.
- **ONE reason string and ONE live region for both panes.** The inventory rule
  enumerates every phone live region with its purpose, and the disabled reason is a single duty however many
  panes state it (SC 3.3.2). It is ANNOUNCED, not printed: shown, it is a third sentence telling a guest who can
  see six empty boxes to fill them in, above a button that is already visibly disabled.
- **One `h1` that changes shape, never two that swap**, and it must stay hoisted out of the branch. Inside an
  `{#if}` it unmounts on every flip, leaving nothing for the browser to interpolate, which forces a JS crossfade
  — and that both generates keyframes no media query can reach and reads geometry, which the mount rung throws
  on. Hoisted, only its class changes and the transform interpolates natively.
- **A `div`, never a second `<main>`.** On `/` this renders inside the home route's own `main`, so a `main` here
  is invalid HTML and two landmarks to choose between on the first screen of the app. `/library` renders the gate
  as a direct child of `.app-shell` with NO `main` at all, so the gate has two hosts and neither of them may
  state its placement — see the placement rule below.

The wordmark's flight is `transform` ALONE, because the repo animates transform and opacity and nothing else: the
shrink cannot be a `font-size` and the move cannot be a margin. Both states write the same two functions in the
same order, or the browser interpolates matrices instead of per-function, and `transform-origin: left top` pulls
the shrink toward the corner the mark is heading for — a centre origin drifts the top-left corner off the gutter.
The header is a grid with two NAMED ROWS whose brand band is RESERVED, so its height does not depend on which
pane is open and nothing below it moves as the mark flies; a per-pane padding would move the mark by changing
LAYOUT instead. `container-type: inline-size` is there for the centring, which needs the CONTAINER's width,
because a percentage inside a `transform` resolves against the transformed element itself. Step 2's scale factor
is `--ph-text-base` over `--ph-text-2xl` written as a RATIO, because CSS cannot divide one length by another.

THE GATE'S PLACEMENT IS ONE DECISION IN ONE PLACE, and that place is this component's stylesheet: below
`--bp-md` the gate fills its host and the CTA docks to the bottom; from 768 up `.app-shell:has(.join-main)`
centres a 420px column. Because the gate has two hosts, the host is NEUTRALISED rather than trusted —
`:global(.app-shell > main:has(.join-main))` makes it a flex column, zeroes its route padding, and at 768 up
takes away its `flex: 1` so the centring has free space to distribute. Without that last declaration the same
gate measured y=6 on `/` and y=263 on `/library` at 1024x900, because `main { flex: 1 }` grew to the whole shell
and left nothing to centre. The `.app-shell >` anchor is for SPECIFICITY, not reach: the route's scoped `main`
rule ties a bare `main:has(.join-main)` at 0,1,1 and its chunk loads later, so the route would win. The CTA then
docks to the bottom of `.join-main` by an auto margin, which only works because the host is that flex column — a
block child shrinks to its content and an auto margin has no free space to consume. No route may state the
gate's alignment, padding or measure. The dock is load-bearing
beyond tidiness: `app.html` sets the interactive-widget mode that shrinks the LAYOUT viewport when the on-screen
keyboard opens, so bottom-anchored content rides above the keyboard instead of under it. Headless Chromium has no
soft keyboard, so no measured gate can verify that placement.

THE RESTING PLACEMENT, THOUGH, IS A GATE — `tests/playwright/specs/gate/measured-join-gate.spec.ts`, CLAIM 7, leg
7 of `bun run gates`. It drives both hosts at five widths and holds the brand band's top, the gutter and the CTA's
bottom edge identical between them; from `--bp-md` up it also holds the free space above the gate equal to the free
space below it ON EACH HOST, and below `--bp-md` it holds the band at the shell's content top and the CTA docked by
`.join-main`'s own bottom inset. The absolute half is there because equality is blind to a break both hosts share:
with `justify-content: center` deleted the two routes agree perfectly on a top-aligned gate and all three deltas
stay at zero. Two of its five widths are 767 and 768, and it reads `--bp-md` off `:root`, which makes it the one
place in this tree where a media literal is checked against the token it is supposed to be. It reads the host's
resolved `display`, `padding` and `flex-grow` back as well, because a specificity argument that is only asserted is
not checked — with the neutralising rule deleted the host resolves `display: block` below `--bp-md` and `grid`
above it, with `padding: 6px 16px 28px` back. Measured while it ran: `.join-head` at y=262.58 at 768 and at 1024
wide, y=352.58 at 1920x1080, and the CTA's bottom edge at y=828 of 844 at 390x844 — digits the arms DERIVE rather
than pin, so a spacing rung can still move them with nothing red. What cannot happen again is the two hosts
drifting apart.

Finally `.confirm`, `.err` and `.cta-reason` stay
ordinary elements rather than Field primitives: `tests/playwright/world/selectors.ts` addresses `.err` as a class on the
alerting element and a class handed to a component carries no scoped rule; `.confirm` is the scanned path's
headline and the primitive would dim and shrink it; `.cta-reason` needs its gap BELOW and centred text, and the
only way to override the primitive reaches settings' own descriptions too.

### Settings

`/settings` is three scopes in a real tablist — You (one person), Party (this room), Server (this machine
and its worker fleet). The scope list has ONE home, `src/lib/settings-tabs.ts`, because both halves read it:
`src/routes/settings/+page.server.ts` narrows `?tab=` through it so the first paint is already on the right
tab, and the page renders a trigger and a panel per id. `party` is the default — server-wide settings are set
once and left alone, while the rotation is changed mid-song. Tab switches use `replaceState`, so Back leaves
the page instead of walking tabs. There is no socket: every write is a per-field patch the server re-normalizes over
current values, applied optimistically and rolled back to `committed` (the last server-confirmed snapshot)
if refused — never to an intermediate drag frame.

The reactive grid, and its three measure tokens:

| Level       | Token            | Value here       | What it bounds                                              |
| ----------- | ---------------- | ---------------- | ----------------------------------------------------------- |
| page        | `--page-measure` | `--measure-grid` | the header and `main` share one width, so they align        |
| card column | `--settings-col` | `420px`          | the `minmax()` floor `.panel` pairs cards at                |
| row         | —                | none             | controls fill their card; no cap, or each card shows a void |

`.panel` is a grid, not a flex column: `repeat(auto-fit, minmax(min(100%, var(--settings-col)), 1fr))`
spends extra width on a SECOND COLUMN OF CARDS rather than on wider controls, and `auto-fit` collapses the
empty track so one column is the plain stack. `align-items: start` is required — `stretch` pads the shorter
card out to its neighbour. `--settings-col` is 420 and not `--measure-prose` (560) because two prose columns
plus the gap need 1132, more than the widest shell, so a prose threshold would never pair anything; at 420
the panel pairs from 852 up. Anything in a panel that is not a `[data-slot='card']` spans the full row.
Card rhythm is fixed in the cascade, not by restructuring rows into `Field.Root` wrappers: the card gap is
the intra-group distance, and a label that FOLLOWS a control takes the inter-group distance back as a
margin, so a card's first label is untouched. A composed control whose label is `.control-label` rather than a
`[data-slot='field-label']` takes that margin on its WRAPPER instead — `ColourRing`'s `.ring-field` — or the card
draws one boundary two ways: 20px above a second `Field.Label` — `card-content`'s 8px flex gap plus a `lg`
margin — against 8px above the ring. The third margin on that card, `.save-slot`'s, is the same rung for the same
reason: a commit control is an inter-group boundary, not a section one.

Other rules a change here must respect: a slider's range must match the server clamp exactly, or the UI
silently refuses values the server accepts; `id="tab-<scope>"` and `id="max-processes"` are spelled
explicitly because `tests/playwright/world/selectors.ts` and the shot specs resolve those literals; `.panel` carries
no `role="tabpanel"` of its own, because `Tabs.Content` already renders one and a second nests two; the
identity ring gets `taken={[]}` because this page's load carries no room occupancy, and inventing one would
draw pips at colours nobody holds. `PROCESSES_UNCAPPED` is `0` and means uncapped, so it must be tested
before any count comparison and is rendered in words. The You scope has exactly ONE commit control and it lives
INSIDE the You card, because the save's refusals name the name field; it reads `Save and close` with an edit
pending and `Done` without one, and that tab carries no second panel-level `Done` the way Party and Server do —
a `Done` that did not save silently discarded a typed name.

That in-card placement has a consequence that is KEPT ON PURPOSE: the You panel's last control is `Leave the room`
in the Leaving card below, where Party and Server both end on their panel-level `Done`. The destructive action is
last because last is the end of the scope, after everything a guest came to this tab for; it is the only BUTTON in
the panel that is not an `--accent` fill, and the only control anywhere in settings behind an `alertdialog` confirm,
so arriving at it by reaching for the bottom of the other two tabs costs a dismissal rather than a room. Both alternatives are worse.
Restoring a panel-level exit for position parity re-mints the pair this scope was fixed to remove — two identical
`--accent` block buttons, one of which did not save. Lifting Leaving above the You card moves the destructive card
into the panel's FIRST position — top-left of the paired grid from 852 up — to protect its last. A refusal on this
pane is also keyed to the draft it refused (`{ name, colour, message }`, read back through a `$derived`) rather
than held as a bare string: a stated reason must not outlive an edit to the field it names, or an empty-name
refusal goes on sitting under a button that has gone back to reading `Done`.

### The song page

`/song/[mediaId]` answers "can I sing this, and are the words right" for ANY song id, including one no
longer in the room's catalog, so it fetches the row from `/api/audit/<mediaId>` — the same endpoint the
audit screen reads — rather than reading the room. It still subscribes to the link for the live key shift,
which is the one fact the stored row cannot know, so the range readout agrees with what the television is
sounding. A singable song may have no measured range (that needs a vocals stem); the page says so rather
than drawing an empty strip. Lyrics here are quick-select among the ranker's candidates only.

### Stats

`/stats` is the guest-facing party page and the one dashboard safe to reach from any phone's surface. It
promises aggregates only — no singer names anywhere, because the play log has no singer column. It leads
with three glanceable figures and puts the trend below them. Honesty rules it must keep: the catalog count
is a footnote, never the headline (it counts every search result ever seen); songs the normalizer could not
attribute are excluded from artists and said to be; and a gap in the per-day trend means "nothing sung OR
the server was off", which the page states rather than resolving.

### Metrics

`/metrics` is the internal processing dashboard. It is ungated, so it is linked ONLY from the Server tab of
settings — from the remote or the television it would advertise worker ids, model names, host details and
error strings to every device in the room. What it promises: durations reported as rates wherever a rate is
meaningful (raw seconds do not compare across songs of different lengths), a sample size beside every
average with small ones labelled, worker state first (with none connected, every timing below is history
rather than live state), and failed runs excluded from the averages.

`/metrics/<mediaId>` is the per-song audit log, grouped by `processingId` rather than flattened: one media
id can carry several runs, and a flat attempt list blends them. It states why the published lyric won, and
distinguishes "a baseline judged it" from "no baseline could, so metadata ordering stood" — the second is
the case a better similarity metric does not fix. Both screens render every label through
`src/lib/metrics-format.ts`, so a new job type cannot show its raw database name on one page and a word on
the other, and every instant through `localStamp` in the viewer's own zone.

### The metrics table scroller

Wide numeric tables scroll rather than squash or reflow into cards, because a shared right edge is what
makes them readable. `.scroller`'s background is a pair of gradients and both halves are load-bearing: a
`local` cover rides with the content and hides the `scroll` shadow at each end, so a table that fits shows
no fade at all. Keep them LINEAR — `radial-gradient(farthest-side …)` resolves to the vertical half-height
and is invisible across a band a few pixels wide. Right side only: the sticky first column paints
`var(--card)` at `left: 0`, exactly where a left shadow would go. The shadow is `--bg`, not a glow token,
because it has to read as depth against `--card`.

### Admin

`/admin` is an operator surface with no inbound link anywhere in the app, so its back target is the remote
at `/`. Its one action hard-deletes a song and reclaims its bytes, which is the only irreversible action in
the product: it is two-step (arm, then confirm the named song), it lives here rather than on a phone row
any guest can fat-finger, and every repeated control carries the song title in its accessible name because
arming a row replaces the focused button. Dimmed copy on this page uses `--ink-dim`; `--muted` is the
shadcn SURFACE alias and measures 1.24:1 as text.

### The /components gallery

`/components` renders every shared component in every state it must survive, side by side, so a state that
deliberately renders NOTHING can be judged as intentional — which is what its captions are for. It is
dev-only, gated in `src/routes/components/+page.server.ts` so the 404 is decided before any gallery HTML
exists, and that gate is the whole protection. It is also load-bearing test
infrastructure: several guards read its source as a fixture, so it is gated rather than deleted, and a
fixture removed from it takes a guard's subject with it. Frames that exist to be compared are pinned
(`playing={false}`, an explicit position) because a running demo clock makes two frames incomparable, and
colour props in it are fixture DATA — a person's chosen accent — never theme tokens.

## The television surface

The TV is a ten-foot, gesture-poor, unattended surface. It is not a wide phone, and the rules below are
the ones an innocent edit breaks.

### The stage and its stacking order

`src/routes/tv/+page.svelte` owns one monotonic z-scale, higher = closer to the viewer. Two unrelated
layers sharing a tier leaves paint order to DOM order, so a reorder silently pushes a transient behind
the chrome.

| tier  | layer                                                                                             |
| ----- | ------------------------------------------------------------------------------------------------- |
| 0     | stage background and visualizer                                                                   |
| 1 / 2 | hidden / visible player slot                                                                      |
| 5     | idle full-screen: attract, lobby                                                                  |
| 6     | lyrics reel — owned by the sibling `src/lib/tv/LyricsOverlay.svelte`, not editable from the route |
| 7     | persistent chrome above the reel: lower-third, progress bar, join corner, fullscreen button       |
| 8     | transient full-screen overlays, which must cover all chrome                                       |
| 9     | connection status dot                                                                             |
| 10    | autoplay-blocked affordance, which must be tappable above everything                              |

Only `src/lib/tv/TvPlayer.svelte` may host a renderer, and it renders an `<audio>` — never a `<video>`.
`playbackRef` resolves to the separated instrumental, which has no video track, and `<audio>` is the more
permissive element for codec support. `display: none` on an `<audio>` does not stop it playing; on a
`<video>` it would. `src/lib/tv/VisualizerStage.svelte` mounts INSIDE the stage-background layer rather
than beside it, so it inherits the one visibility gate and the one crossfade already proven for
backgrounds; `src/lib/tv/background.ts` returns opaque black as its floor so an unpainted first frame
shows the stage, not whatever is beneath.

Visibility for the player slots, the stage background and the wake lock is the single `!isAttract` band,
never `screen === 'playing'`: a literal playing check drops the background during the interstitial (a
black flash between every song) and on `waiting`, where a song IS on stage.

Two bands are MEASURED with a ResizeObserver rather than predicted, because both grow with their content:
`--tv-chrome-h` (the bottom chrome the reel must clear) and `--tv-upnext-h` (which the fullscreen button
offsets below). The static `src/app.css` values are the pre-measurement fallback.

Transient full-screen states are selected by ONE derived value. As independent `{#if}` blocks at one tier
with `inset: 0` and non-exclusive conditions, two panels paint over each other. Precedence: error,
waiting, next, loading.

### The lyrics reel

The reel is one persistent keyed column; only its transform changes, so the browser animates the scroll
and the singer keeps the line they just sang. Offsets are MEASURED from the DOM, never computed as
rows × height, because a long lyric wraps to two rows and fixed-height maths drifts.

`src/lib/tv/reel-offset.ts` places the current row by an asymmetric bias,
`((linesBefore - linesAfter) / 2) * rowHeight`, then clamps it into the UNMASKED window
`[fadeTop, band - fadeBot]` — not the band. Each edge that has context rows fades one row to transparent,
so clamping to the band parks the sung row congruent with a ramp, fainter than the line after it and with
the ball in the lowest-alpha slice. `band` must be the CLIPPED `clientHeight`. The ramp depth is capped by
`min(row-h, (band - row-h) / 2)` in both CSS and JS, so the window always holds one opaque row; the two
must agree. An edge with NO context rows is not faded at all — with `linesBefore: 0` the current line IS
the top row.

The reel's `max-height` is EXACTLY `calc(100vh - var(--tv-chrome-h))` and must not subtract a further
`--tv-safe-y`: the box is centred, so charging one against its height buys half of it as top inset while
removing a full one of reel, and `--tv-chrome-h` already contains one. It does bite at the default five
rows on short panels; seating all five needs the type budget to change.
`tests/unit/lib/tv/reel-offset.test.ts` pins the arithmetic, and
`tests/unit/lib/tv/reel-offset.test.ts` pins that the clamp stays on the render path.

Legibility is a STROKE, not a bound on the background. A blurred shadow dissolves against a mid-tone
stage colour of similar luminance — exactly the field a hue-only background paints — so the reel strokes
`-webkit-text-stroke` with `paint-order: stroke fill`. The reversed paint order is load-bearing: the
default paints the stroke on top of the fill and eats the thin parts of each glyph. Width is in `em`,
because a px stroke reads heavy at 720p and hairline at 4K. There is exactly one stroke declaration, and it is why no visualizer or stage colour needs a
brightness bound of its own.

Highlight colour is a CHAIN of custom properties, not competing selectors: provenance and highlight are
independent axes, and rules of equal specificity broke both ways at once. `--reel-part` falls back to
`--reel-singer`, which falls back to `--accent2`; both treatments read `--reel-part`, so `word` and `line`
cannot disagree about whose colour is showing. Each property is appended to the inline style only when it
applies, so the stylesheet default is the single place a fallback is named. The amber provenance override
takes `--reel-line` and deliberately leaves `--reel-now` alone: where the singer is, is a different
question from whether the text is trustworthy.

Pure white and the 0.66 "not yet" alpha stay literal. `--ink` is deliberately not pure white, so
tokenising them would REDUCE contrast at three metres.

**The word wipe is a PER-LINE decision, not a per-song one.** A line the worker graded `low` renders as one
text node with no ball and no per-word colours, exactly as the `line` highlight setting renders every line
(`wipesWords` in `src/lib/tv/lyrics.ts`, read by the overlay's word branch). A wipe claims to know where
INSIDE the line the singer is, and a `low` grade says nothing could vouch for where the line itself sits —
most often a repeated chorus the decode could have bound to either occurrence. Such a row gets no accent:
`--reel-now` answers "where is the singer", which is the question this row cannot answer. A line with NO
grade keeps the wipe (v1 artifacts and any worker that did not grade), and so does `medium`, which is a
DOCUMENT grade and never a line's. Measured on the alignment bench (worker review §3.7, W6): over 20
Jamendo songs' untimed-text path the grade now covers 33% of lines with 2.8% of them more than 0.5 s out
and NONE more than 2 s, where the rule it replaced covered 51.5% at 11.9% and twenty-three — which was at
chance, since 12.9% of the lines it called `low` were bad too. Fewer wipes, and the ones left are right.
`tests/unit/lib/tv/bench-highlight-parity.json` holds the TV and the bench's port of it to the same rule.

The drawn position is a pure function (`src/lib/tv/lyrics-position.ts`): paused, it is exactly
`positionSec`. A rAF-driven accumulator is the sole keeper of its own value and a backgrounded tab
throttles rAF, so the reel decays to line 0. While playing it extrapolates from the anchor, floored at the
anchor. Advancing needs all three of `screen === 'playing'`, the server's `isPlaying` intent, and the
master element actually running (`src/lib/tv/screen.ts`, `lyricsAdvancing`) — the first two stay true
through an autoplay refusal, and the words would sweep over a silent room.

### The pitch-shift graph

A `MediaElementAudioSourceNode` is a PERMANENT, one-per-element capture. Once created, the element's audio
reaches the speakers only through the graph, and `detach()` frees the context without restoring the native
path. Everything in `src/lib/tv/pitch-shift.ts` follows from that:

- keyShift 0 builds NOTHING — no context, no source node. The audio path is byte-for-byte the plain
  element, and this must never regress: a broken shift is bad, killing all room audio is catastrophic.
- Build lazily on the first non-zero shift, and capture ONLY after `resume()` has confirmed
  `state === 'running'`. A context built without user activation stays suspended, and a TV wall may never
  be clicked; capturing into a dead graph is permanent silence.
- Build every node that CAN THROW before the capture. `outputChannelCount: [4]` is a real
  NotSupportedError candidate, and a throw after the capture leaves the element owned by a source node
  whose context the `catch` then closes.
- A throw or teardown BEFORE the capture closes the context; AFTER the capture it must not — reconnect
  the captured source straight to the destination instead.
- Returning to keyShift 0 sets ratio 1 and LEAVES the graph. At ratio 1 the worklet is a bit-exact
  passthrough, so there is nothing to tear down.
- `detach()` belongs to the ELEMENT's death (component destroy, or the effect that sees the element
  unmounted), never to a song change — the master outlives a song, and detaching leaves it feeding a
  disconnected node. It must also drop the reference, or the `!masterGraph` build guard never fires again.
- `degraded` is NOT terminal. A failed pre-gesture attempt must stay retryable, and the always-armed
  gesture listener in `src/lib/tv/TvPlayer.svelte` is what re-drives it.
- `canShift` is separate from `degraded`. `AudioWorklet` is secure-context-only, so on the documented
  plain-HTTP LAN deployment it is absent and a graph still splits the mix and owns both gain stages —
  only ±key is unavailable. Conflating them hides a working guide or advertises an impossible transpose.
- `HTMLMediaElement.volume` is BYPASSED by the capture, so every level must be applied at both the native
  and the graph site, and re-asserted whenever a graph is (re)built — a fresh graph defaults its gain to
  1. The guide gain defaults to 0 on purpose: the worst case of a missed call must be a guide nobody
     hears, never isolated vocals over the backing track.

The graph lifetime is the subtle part, and
`tests/unit/lib/tv/guide-mix-graph.test.ts` the split chain.

The guide mix is one 4-channel file with the isolated vocals at FULL SCALE on channels 2/3. Played
natively the browser downmixes and sums them into the instrumental at full volume, so
`src/lib/tv/guide-mix-src.ts` withholds the mix src until the gate reports BOTH `isRouted` and `isSplit`:
a non-split graph left behind by an earlier transpose satisfies `isRouted` alone. The gate's third state,
`pending`, exists so the src is decided ONCE — rewriting `src` on a playing element runs the load
algorithm, which resets `paused` and `currentTime`, while the memoized transport keeps its `'play'` value
and never re-fires. Each channel pair is re-MERGED to stereo before its gain; feeding a pair's outputs
into one GainNode sums them to mono, and exchanging the two mergers puts full-volume vocals on the gain
that defaults to 1.

Inside the worklet there is ONE read pointer, ONE write head and ONE grain schedule for all channels,
with the SOLA correlation summed across them. Per-channel search offsets drift the guide off the
instrumental by up to ±256 samples, which is the single-playhead guarantee the mix exists for. Per-channel
state holds content only — the history ring and the output accumulator — because sharing those is
cross-talk. The analysis hop EQUALS the synthesis hop; the pitch change lives entirely in the intra-grain
stride, and scaling the hop too makes the read pointer diverge without bound.

### Wake lock and reload resume

`keepScreenAwake()` (`src/lib/tv/wake-lock.ts`) takes the lock and returns the teardown that releases it;
`/tv` calls it from an `$effect` gated on the on-stage screens, so the effect cleanup IS the release.
`navigator.wakeLock` is SECURE-CONTEXT ONLY, so on a plain-HTTP LAN room it is `undefined` and the
feature-detect makes the whole thing inert. The platform DROPS the lock whenever the document hides and
never restores it, so it must be re-acquired on `visibilitychange` or it works once and quietly stops. A
request in flight leaves the sentinel null, so a `visibilitychange` arriving mid-flight needs its own guard
or it issues a second request and leaks the first held lock past the song's end — and a sentinel that
resolves AFTER the teardown has to be released on arrival rather than stored.
`tests/unit/lib/tv/wake-lock.test.ts` pins all of it, behaviourally.

On a reload mid-song the room's position arrives BEFORE the `<audio>` exists: the element is gated on
`nowplaying:changed`, which the server sends after `playback:state`, and position telemetry does not bump
`rev`, so the seek effect is never re-woken. The target is HELD and applied on the master's `canplay`
through `resumeSeekTarget` (`src/lib/tv/playhead-sync.ts`), not `seekPlan`: a cold-mounted element has no
playhead to protect, so anything past the alignment tolerance is a resume rather than a scrub, and routing
it through the jump threshold would drop a resume under 1.5s.

The resume is applied ONCE per element-and-src load and the held target is then CLEARED — that is a
contract, not tidiness, because `canplay` fires again on every warm re-buffer and a retained target gets
re-applied by the next decode hiccup, resuming seconds earlier. It is also guarded to the ACTIVE slot
without consuming the target: the hidden pre-warming slot reaches `canplay` too, and would otherwise park
the next song's element at the outgoing song's position. What keeps a stale target off the next song is
the server publishing `positionSec: 0` with a fresh `rev` on advance.
`tests/unit/lib/tv/tv-reload-resume.test.ts` pins it.

`seekPlan` admits a target of exactly 0 as a rewind when the master is past the alignment tolerance,
because `restart` writes the integer literal 0 while the song plays on and would otherwise read as
sub-threshold telemetry. The equality is load-bearing: a future writer COMPUTING a near-zero restart
target falls outside the clause and needs its own reason to seek.

### The TV socket

The TV opens `role=tv` and is bound to a room, so it is never a phone surface and never an unscoped
spectator. `src/routes/tv/+page.server.ts` resolves which room the display shows — an explicit
`?room=<code>` validated against the room repo, else the room this box serves — and that one resolved code
is both what the QR advertises and what the client passes on its WS URL, so the socket binds to the same
party. An unknown code falls through to the served room, so a stale code never dark-screens the display.
The binding is load-bearing.

The TV holds NO queue rev of its own: it never handles `queue:patch` and adopts server truth wholesale
from each `queue:sync`, so the hello handshake always sends `lastRev 0`. It writes only `tv:telemetry`,
dropped SILENTLY when the socket is not open — a ~4Hz ephemeral stream whose next frame is 250ms away,
where warning per drop floods the console on every reconnect. Every frame carries the ENTRY id, because
the server's stale-frame guard is conditional on it being present: without the stamp a duplicate `ended`
double-advances and an outgoing song's late position frame overwrites the incoming singer's playhead.

The catalog is the other half of the same boundary. `mergeCatalog` in `src/lib/tv/catalog.ts` is the only
writer, it takes a FULL server list so no partial local edit is expressible, and it preserves object
identity for structurally unchanged records. What reaches a player slot is a branded `PlaybackSnapshot`
taken at an explicit playback transition, so handing a slot a live catalog record is a compile error. A
process event decides exactly one thing, `processIsTerminal` — the lifecycle exit from `waiting` — because
writing the catalog from the progress path is how a process for one song reached the playhead of another.

Because the TV registers no gesture on its own, every gesture-gated capability is re-driven from ONE
always-armed document-wide listener: autoplay recovery, the WebAudio resume a pending transpose needs, and
fullscreen (which requires transient activation in the TV's own document, so a realtime message from a
phone cannot grant it). Gating that listener on a latch is what left a correctly-autoplaying TV with ±key
permanently dead and nothing on screen explaining why. Every degradation that a tap can lift gets an
on-screen say; a failure no tap can lift gets a non-interactive one instead.

Motion on this surface lives inside `@media (prefers-reduced-motion: no-preference)` or is gated in JS.
Svelte `transition:`/`in:`/`out:`/`animate:` directives are banned tree-wide because the transition runtime never consults the media query.

### The TV type floor

`src/routes/tv/+page.svelte` declares `font-size` on `:global(:root)`, and both halves of that are
load-bearing. It must be `:root`, because every `--tv-*` tier in `src/app.css` is a `rem` multiple of it and
a `font-size` on `.tv` would not re-root its descendants. It must come from inside THIS component rather
than `app.css`, because a Svelte stylesheet is injected only while its component is mounted, so the floor
reaches the `/tv` document alone — a global `:root` re-roots the phone's `--ph-*` ladder to ~19px and
regresses SC 1.4.4.

The value is `max(2.7vh, 20px) * clamp(0.8, var(--ui-scale), 1.6)`: the `vh` term scales with the panel and
the `20px` term is the windowed legibility floor. `--ui-scale` is declared with `@property` as a
`<number>`, so a non-numeric write falls back to 1 instead of poisoning the `clamp()` and dropping the whole
declaration — which would silently remove the floor. The stage-scale rule holds the
ten-foot floor this roots.

### The attract and lobby idles

Both idles are the same screen at two scales, so a change to one belongs in the other. Attract is TWO
COLUMNS rather than a centred stack: the phrase can be a large left-aligned statement while the join block
stays a self-contained panel a guest scans or transcribes from. The fixed `Karaoke` label never rotates,
because it is the only thing telling a stranger what they are looking at, and `.phrase-box` is a FIXED
height computed as `--tv-phrase * 1.03 * --tv-phrase-lines` — the `1.03` is `.phrase-line`'s own
`line-height`, and the two must agree or the box no longer holds whole lines. A one-line and a two-line
phrase must not move the label above them.

The phrase set is a shuffled bag (`src/lib/tv/phrases.ts`) seeded from the room code, so a room's rotation
is deterministic and no phrase repeats until the set has shown; the only place a repeat could appear is the
SEAM between two passes, which `refill` re-draws against. `MAX_PHRASE_CHARS` is 24, measured in-browser at
84px/900 in the 820px panel, where 23 chars fits two lines and 30 spills to three. Reduced motion stops the
rotation TWO independent ways, either sufficient: the JS clock never starts, and the crossfade is a CSS
animation gated on `no-preference` replayed by a `{#key}` remount.

A typed address is ONE unbreakable token, so SHRINKING beats breaking: neither `.jt-url` nor the lobby's
`.url` carries `overflow-wrap`, and what makes them FIT is `--tv-attract-right`, sized from a measured
23-character address plus the overscan padding. `.asplit-r` charges `--tv-safe-x` on its right edge only,
because its left edge is the interior 2px border and not a screen edge. Wherever a value is tracked out
(`.jt-code`, the lobby's `.code-l`/`.code-v`) the `padding-left` must EQUAL that element's own
`letter-spacing`: tracking adds its space after the last glyph too, and a centred shrink-to-fit box includes
it, so the glyphs otherwise sit left of true centre by half the tracking.

The lobby is a flex COLUMN whose roster strip is IN FLOW, not `position: absolute`: centred across the full
`inset: 0` box with the strip pinned to the bottom, the two intersected on short panels and DOM order
painted the chips over the typed join address. The strip's own height is what reserves its band at every
resolution. Its horizontal padding is `--tv-strip-corner-clear` on BOTH sides, which carries the overscan
inset AND reserves the bottom-right corner controls, which paint above it — without it a wrapped roster's
last chip landed under the fullscreen button. There is no `overflow: hidden`: a hard clip silently ate
roster members, so the `.dense` step-down shrinks the chips instead. Density keys on total CHARACTERS, not a
count: `displayName` admits 32, so nine long names already overflow the two rows `max-height: 26vh` allows
while a count rule sits quiet until 13. `CHAR_BUDGET` is `CHIP_STEPDOWN` times a typical name, and both are
read off the DATA rather than a measurement of the rendered strip. The lobby copy
pins the two situations the lobby's wording must keep apart.

`src/lib/tv/JoinBadge.svelte` renders its QR in EVERY state, reachable or not, and appends a one-line notice
rather than replacing the panel — replacing it took the typed path with it, leaving the one screen that
could still be joined by hand offering neither address nor code. The STATED TRADE is that a guest can scan a
code that will not resolve; that is accepted, because the address is only unroutable when nobody has set a
party address, which in practice means a laptop showing this to itself. The `.badqr` family names are kept
deliberately even though nothing about it is a card any more: they are how the e2e contract, the party flow
and the scaling probe recognise the state. The corner treatment hides the fix clause rather than restating
it, so the one string cannot drift, and `.corner` is scoped `:not(.badqr)` so the QR's flex row does not
reach the notice, whose block children would otherwise become side-by-side columns.

### The full-screen takeovers

Each takeover carries its own colour family AND its own eyebrow AND (for error/processing) its own mark, so
colour is never the only carrier. `--accent` appears only as a non-text border or fill, which is what it is
certified for; takeover text is `--ink` or `--accent2`. The backdrop is a radial SCRIM, not an opaque wash:
a wash blanks the room's chosen backdrop for every song change, which is the exact black flash the
background layer's visibility band exists to avoid, undone one layer up — and it would hide the join block
that must stay visible through it. "Next up" is untrue for the first song of the evening, so the label reads
"Now singing" until `openedOnce`. The processing takeover's words come from `processStageLabel`, the one
guest-facing process vocabulary shared with the phone, and the TV holds only a COARSE "processing" state, so
it feeds the total `processStep` mapping a representative mid-process value rather than inventing the
per-media tracking it was purpose-built not to hold.

The lower-third is plain TEXT, not a card, because a filled panel over the room's chosen background amputates
the feature they picked; legibility comes from a blurred `text-shadow` AND a `-webkit-text-stroke` with
`paint-order: stroke fill`. A shadow tuned against
black disappears against a bright field of similar luminance — the singer name measured 1.10:1 on white.
`.ls-song` clamps to two lines with `-webkit-line-clamp`, which needs the `-webkit` box display and hidden
overflow beside it to take effect at all, and `.ls-artist` must NOT carry `white-space`/`overflow` of its
own: the overflow pair is inert on an inline element while `nowrap` DOES apply and hard-clips a long credit
mid-word.

### The visualizer stage

`src/lib/tv/VisualizerStage.svelte` owns only the loop; the renderers in `src/lib/tv/visualizers.ts` are
pure functions of `t`. This is the SECOND rAF loop on the TV, so three costs are managed: the draw is capped
at ~30fps (`FRAME_MS = 33`) because the lyric ball keeps the stronger claim on the frame budget; the backing
store is reduced to `SCALE = 0.5` and stretched by CSS, which cuts fill cost roughly fourfold; and `playing`
going false CANCELS the frame rather than merely hiding the canvas. Under `prefers-reduced-motion: reduce`
it draws ONE frame and stops — a still plasma is a legitimate background — enforced by
a rendered probe, because a CSS-parsing check cannot see a canvas.

The clock baseline lives at COMPONENT scope, not inside the effect: as a per-effect-run local it is reset by
every `playing` toggle, `variant`/`hue` change or remount, which pins `t` near zero and draws one frame
forever. Every reactive input is read SYNCHRONOUSLY in the effect body, because a value read only inside the
rAF callback is read outside the effect's synchronous pass and the effect subscribes to nothing, dropping a
room's hue change until a remount. Every renderer's colour comes from `stageHueToHex`, which is the
brightness bound: a raw `hsl()`/`rgb()` value is how a stage visualizer becomes the brightest thing behind
the reel. Spectrum bars and oscilloscopes are deliberately ABSENT — both claim to draw the audio signal and
nothing here reads it.

### Reading a lyrics artifact

`src/lib/tv/lyrics.ts` treats model output as UNTRUSTED: every accessor is defensive, and a missing or NaN
bound reads as "not yet sung" rather than throwing. Whisper returns VAD/decoder SEGMENTS of up to ~30s
rather than lyric lines, and after forced alignment every word has timings, so the PAUSES are where lines
break. That resegmentation lives in the DISPLAY layer rather than the worker, so it fixes artifacts already
on disk with no re-process.

Two refusals in it are load-bearing. It only splits a line that is ALREADY too long, because applied
unconditionally a pause splits on any held note and turns a correct short line into two rows that flash
past. And it REFUSES to split at all when the timed words do not cover the line's text (`COVERAGE_MIN`),
because `normalize_lyrics` drops un-timed words and rebuilding from `words` would silently DELETE lyrics
from the screen — one badly-wrapped line beats a line with words missing. An orphan merges into whichever
neighbour it is closer to IN TIME, because both directions occur in real lyrics and always appending
backwards produces "I want to have control. I". A duet `part` is carried onto every row a source line splits
into, or a long duet line loses its colour; `romanization` needs no carry, since it appears only on
line-synced docs, which are never resegmented.

**TWO LEADS, TWO JOBS, AND BOTH ARE APPLIED AT DISPLAY TIME** so the artifact stays a faithful record of
where the words are.

`LYRICS_LEAD_SEC` (`lib/tv/lyrics.ts`) is 0 and stays 0: it is the overlay's default when NO room settings
reach it, and the bench's TV port reads that constant, so every recorded `highlight` number measures the
artifact's own accuracy rather than a room's display compensation.

`DEFAULT_LYRICS_LEAD_MS` — the ROOM setting's default, which is what a real TV runs with — is **40 ms**
since W5 (PLAN-alignment-v3). ITU-R BT.1359's lip-sync tolerance is ASYMMETRIC (video late of audio is
noticed at about −45 ms, early at about +125 ms), a karaoke highlight has the same asymmetry — a word that
lights after it is sung reads as broken, one that lights a hair early reads as correct — and over the 5693
hand-timed word onsets of the bench corpus a +40 ms display lead moves the share inside that band from
**73.2% to 78.6%**, which is also the swept ARGMAX (5 ms steps, same peak on a claim-anchored document, on a
blind decode and on a jittered claim; the review's 66.0% → 75.0% is the same measurement on the pre-W4 clock
and the base bundle and still reproduces there — W4's clock and W5's bundle flip moved the distribution, not
the physics). **EXISTING ROOMS WERE BACKFILLED TO IT**, because a changed column default reaches none of them
— `setRoom` writes every column and `getRoom` returns the stored value, so nothing reads a default at runtime
— and the 5.4 points would otherwise have gone to rooms created after the upgrade only
(`drizzle/0001_lyrics_lead_default.sql`, which states why that is honest once: the knob shipped at 0, so a
stored 0 and the old default cannot be told apart, and this is the pre-release window). It is a DISPLAY
compensation, not a timing correction: the worker's acoustic
`generate.ONSET_LEAD_SEC` (30 ms, re-fitted on the exact frame grid) did not move and must not, or the
published artifact lies to every consumer. The exact value is still owed a measurement of the TV's own
video latency (compositor + HDMI + panel processing, commonly 20–100 ms on a consumer TV outside game
mode), which eats into the same budget; `lyricsLeadMs` is the per-room knob until then.
