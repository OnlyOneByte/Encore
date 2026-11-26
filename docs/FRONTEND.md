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
  here". `--line` is 1.13:1 on the `--card2` field fill and exempt as decoration on the card, list-row, table-head,
  tab-strip, chip, spinner and skeleton edges it keeps across the app; `--control-line` is 3.65:1 on `--card2`, 3.97:1 on
  `--card`, 4.53:1 on `--bg`, and clears 3:1 on every surface token `app.css` declares (the floor is
  `--track-bg` at 3.13, then `--ok-bg` at 3.20). Raising `--line` instead would brighten every card in the app.
  **A SLIDER'S RAIL is that boundary too, and it is where the floor above stops being hypothetical.** Only the
  filled half of `ui/slider`'s rail ever identified the control — the `--accent` range is 3.376:1 on `--card`,
  while the unfilled `--track-bg` remainder, which is most of the rail at a low value and all of it at zero,
  measures 1.269:1 — so the rail takes a 1px `--control-line` ring, 3.972:1 on the `--card` outside it and
  3.131:1 on the `--track-bg` inside. Brightening `--track-bg` instead is the `--line` shortcut in miniature: it
  is the ground under five OUTPUT sites (`Bars`, `TvProgress`, `/tv`'s process bar, `NowPlayingStrip`'s progress
  hairline, `SongRow`'s artwork placeholder) that 1.4.11 asks nothing of, and no rail FILL can reach 3:1 on `--card` at any
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
  `tests/unit/lib/control-boundary-contrast.test.ts`, which pins the floor surface, the checkbox
  exception, the rail's four ratios and the `#666`/`#6a6a6a` bracket under them, the ring rule and the two
  heights it cost, the absence of any surviving `border-border`/`dark:border-input` in `button.svelte`, and the
  tailwind-merge eviction the bordered variants depend on — and asserts that the `--line`-family border
  UTILITIES (`border-border`, `border-input`, `border-[var(--line)]`) appear only in the vendored registry files
  named there, each with the reason it is not a control boundary. It also pins the `var(--line)` FILE COUNT exactly,
  because what that count proxies is the premise of the whole ruling: `--line` is app-wide decoration, so brightening
  it repaints everything. The figure is NOT repeated here — this document and that test each used to carry it in prose,
  the two disagreed with each other and with the tree, and a number no test reads is a number nothing keeps true.
  Read it off the assertion.
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
removed because nothing spelled it, and a rung declared and read by nothing is the defect the deleted
`--shadow-md` and the refused 32px `--space` rung already name. The next rung here is minted WITH its first caller, and the 1.733
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
what `var(--space-2xl)` MEANS at every site already spelling it. The worst pair is now 1.20, at `md` → `lg` and
`4xl` → `5xl`, and the next rung minted here owes that floor a check in both directions.

That ladder carries four REGISTERS, and a site picks a REGISTER rather than a number:

| Register    | Rungs               | What it separates                                                   |
| ----------- | ------------------- | ------------------------------------------------------------------- |
| intra       | `3xs`–`xs` (2–6)    | parts of one control: a glyph from its label, a chip from its count |
| group       | `sm`–`lg` (8–12)    | siblings in one list or one field group (`.list-row`'s 8px)         |
| inter-group | `2xl`–`4xl` (16–20) | two groups inside one surface (a card's `field-label` margin)       |
| section     | `5xl` (24)          | two sibling SECTIONS of a surface (`.grouphead`'s top margin)       |

A DELTA SITE SPELLS THE RUNG THAT MAKES THE RENDERED BOUNDARY LAND IN ITS REGISTER, not the register's own rung, so
checking a declared token against this table is the wrong check. The app has three such rules, all on the settings
surface — two in its shell, one on the You scope — all margins on a `card-content` child: they spell `lg` (a GROUP rung) and render 8 + 12 = 20px, which is inter-group.
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
rules spend the rung — `.grouphead`'s top margin in `app.css`, `/`'s `.find-row` bottom margin, and the settings
shell's `.panel` row gap — and each renders on a surface that now carries the arm at the same 480px threshold: `/`
(both of its two), the song page's Lyrics eyebrow, and all three settings scopes, whose arm is declared once in
`src/lib/ui/SettingsScope.svelte` because the grid is. `/library` is the exception that proves the register rule
rather than a fourth spend site: every one of its groupheads sits inside the `.refine` disclosure and is pinned back
to the inter-group rung, so it never renders the section rung at all — it carries the arm anyway, naming
`.refine .grouphead` explicitly, because at 0,3,0 that pin would otherwise out-cascade the 0,2,0 claw-back.
The settings arm has to move BOTH ends again — row gap back to 12px and the intra-card margin to `3xs`, rendering
8 + 2 = 10px — because clawing only the container back would re-invert the surface; RE-DERIVED on the three scope
routes at 844×390, with both portrait rungs forced back on, it reclaims 112px on the room scope's panel, 88px on the
machine scope and 22px on You — 28.7% of that viewport's height on the worst one. A new spend site without that arm is an unconditional
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

**What retiring two rungs did NOT fix, recorded so the rung count is not read as the measure.** At least three
quarters of the `gap`/`row-gap`/`column-gap` declarations in `core/src` that spell a rung (a Tailwind
`gap-[var(--space-*)]` under `components/ui` counts, since it compiles to a real gap) land wholly in 4–12px, and
`space-ladder.test.ts` holds that as a FLOOR rather than as a pair of tallies — the exact pair it used to hold
reddened on every feature that added a gap rule, and had already gone stale here while the test stayed green,
because each pinned its own private copy of the figure. READINGS TAKEN ALONG THE WAY, as history and not as a live
claim: 85.1% once the now-playing sheet was deleted, 86.5% with it still in the tree, 85.7% before the phone shell
grew a tab bar, a strip and a `/queue`, and 84.1% before the two rungs were retired. Deleting the drawer stack
removed seven gap declarations and all seven were in-band, which is the whole of that last move.
The in-band SHARE did not thin and was never going to — "the band" in this paragraph is the ratio band, never the
deleted transport: this is a 480px-max phone column of
8px-spaced `.list-row`s, so most gaps in it are SUPPOSED to be small. **And one crowded pair is left OPEN, not
sanctioned:** `md` → `lg` (10 → 12) is still 1.20, and `md` is the ladder's second-busiest rung — mostly
the cluster gap inside a control row (`/`'s `.topbar` and `.find-row`, `PageHeader`'s `.inner`, the strip's own).
Collapsing it into `lg` would put every one of those rows on the same 12px `.list-row` already hard-codes, which may
well be right, but it is a visual ruling over most of the control rows in the app and it wants a live before/after
that a static pass cannot take. It is an open item, not a register. The guard behind the clause is a RANK — `md`
stays among the three busiest rungs by spend — because that is the claim, and it does not move when a component
takes a padding.

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
- **One rule, two selectors, stays one rule.** Inserting anything between two selectors that share one
  declaration list silently drops the first out of the list and hands it whatever follows. The instance this was
  written against was in the now-deleted now-playing sheet; the trap is a CSS one and survives the file.
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
  declared-then-reset, because there is then no reset to lose the cascade to. `reduce` therefore survives in NO
  stylesheet in the tree at all now: the single exception was the now-playing sheet, for the inline-style reason in
  the last bullet, and it went with the sheet. So a CSS `reduce` block is a defect and not a style choice. A JS read of `reduce` (`MediaQuery`/`matchMedia` in
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
- A dependency that writes `transition` as an INLINE style is invisible to the motion guard and unreachable by an
  author rule, so the reduced-motion override needs `!important`. **There is no such dependency left** — the one
  instance was vaul, writing the sheet's slide inline, and the override that reached it set `transition-duration: 0s`
  rather than `transition: none` so the library's own bookkeeping still saw a transition it could complete instantly.
  Kept as the shape to recognise, because the next vendored component that animates inline will need exactly it.

### Spotlight tokens

The redesign's tokens (step 2 of the Spotlight rollout, #1106) live in `core/src/tokens.css`, which `app.css`
imports. Sing (step 3) is the first screen on them; the others move one step at a time, and an old name goes once
nothing spells it.

**Colour roles.** In the dark theme every role but `--role-raise` aliases a name `app.css` already declares, so
moving a rule onto its role changes no pixel. That way round, not the other: the palette generator and the
contrast guards read `app.css`'s literal hexes. The light theme is opt-in through `data-theme="light"`, and only
the dev story sets it. Its block lives in `src/lib/ui/tokens-light.css`, which only that story imports, so the root
stylesheet doesn't carry it; the step that ships light moves it into `tokens.css`. `spotlight-tokens.test.ts` holds
every pair below at WCAG AA in both themes.

| Role                    | Dark aliases     | Light     | Use it for                                                                                                             |
| ----------------------- | ---------------- | --------- | ---------------------------------------------------------------------------------------------------------------------- |
| `--role-ground`         | `--bg`           | `#f7f7fb` | The page. Everything that is not the Spotlight sits on it                                                              |
| `--role-raise`          | `#161622` (new)  | `#ffffff` | The Spotlight when it is idle: lit by its ring, not by a fill                                                          |
| `--role-rule`           | `--line`         | `#e1e1ea` | A decorative hairline between rows. Never a control's boundary                                                         |
| `--role-ink`            | `--ink`          | `#15151f` | Text                                                                                                                   |
| `--role-ink-dim`        | `--ink-dim`      | `#5a5a72` | Secondary text (AA on ground and raise)                                                                                |
| `--role-control`        | `--control-line` | `#7a7a96` | A control's boundary (3:1, SC 1.4.11)                                                                                  |
| `--role-accent`         | `--accent`       | `#6446de` | The one accent fill on a screen with no owner (Sing's search)                                                          |
| `--role-on-accent`      | `--on-accent`    | `#ffffff` | Ink on `--role-accent`, and nothing else                                                                               |
| `--role-accent-ink`     | `--accent-ink`   | `#5536cf` | Accent as text                                                                                                         |
| `--role-focus`          | `--focus`        | `#6a4bdb` | The focus ring                                                                                                         |
| `--role-danger`         | `--danger-ink`   | `#b42318` | Failure text                                                                                                           |
| `--role-danger-surface` | `--danger-bg`    | `#fdecea` | The error Spotlight's surface                                                                                          |
| `--role-danger-line`    | `--danger-line`  | `#f1b5ae` | The error Spotlight's ring                                                                                             |
| `--role-ok`             | `--ok`           | `#0e7a5a` | Success marks (3:1 on ground)                                                                                          |
| `--role-warn`           | `--warn`         | `#9a5b00` | Warning marks (3:1 on ground)                                                                                          |
| `--spot` / `--on-spot`  | the accent pair  | the same  | The moment's owner. `<Spotlight colour>` sets both from the singer's registry stop: its `fill` and certified `on_fill` |

**Type.** A reading ladder of 13 / 15 / 17 / 22 px plus two display sizes, each minted with its caller. It is a
separate ladder from `--ph-text-*`, which step 3 retires screen by screen.

| Token            | rem    | px  | Use it for                                         |
| ---------------- | ------ | --- | -------------------------------------------------- |
| `--type-meta`    | 0.8125 | 13  | A meta line, a segment label                       |
| `--type-body`    | 0.9375 | 15  | Body copy inside a Spotlight                       |
| `--type-title`   | 1.0625 | 17  | A row or song title                                |
| `--type-lead`    | 1.375  | 22  | The Spotlight's headline at rest                   |
| `--type-display` | 2.125  | 34  | The On deck headline ("You're next")               |
| `--type-hero`    | 3.5    | 56  | The You're up headline: the phone's biggest moment |

**Space and radius.** Each step is named by its px value, so a rung added between two renames nothing. Each one
retires the old name it aliases once no rule spells that name:

| Step        | px  | Retires       |
| ----------- | --- | ------------- |
| `--step-4`  | 4   | `--space-2xs` |
| `--step-8`  | 8   | `--space-sm`  |
| `--step-12` | 12  | `--space-lg`  |
| `--step-16` | 16  | `--space-2xl` |
| `--step-24` | 24  | `--space-5xl` |
| `--step-32` | 32  | nothing (new) |
| `--step-48` | 48  | nothing (new) |

`--space-3xs` (2), `--space-xs` (6), `--space-md` (10) and `--space-4xl` (20) have no step: a screen moving onto the
steps rounds those to a neighbour. `--step-32` and `--step-48` are new, and their first caller is You're up's padding. `--round-spot`
is `--radius` (18 px; the prototype drew 20, and a seventh radius value is the bug `app.css` names), and
`--round-pill` is `--radius-pill`. Each `--type-*` and `--step-*` rung must have a reader, and the guard checks it.

**Motion.** The three durations stay `--motion-fast` / `base` / `slow` (120, 250 and 400 ms). Three tokens hold
the queue's existing timings at their old values, so the rows are frame-identical today: `--motion-pop` (0.22 s,
`.pop-in`), `--motion-slide` (160 ms, the live sort) and `--motion-roll` (180 ms, the number roll). They are off the
120/250/400 ladder in tenet 3, and step 3 snaps them (#1069, #1076). Easings: `--ease-out` is the Spotlight's
entrance, `--ease-pop` is `.pop-in` and `.rise-in`, and `--ease-slide` is the slide and the roll.

**Flat surfaces.** Step 3 retired the chrome blur (`--chrome-blur`, `--chrome-fill`), the lit edge (`--edge-hi`)
and the shadow ladder (`--shadow-sm`, `-md`, `-lg`): every phone surface is a flat fill, and the sticky header and
the dock are opaque. `--shadow` stays for two floating callers: the TV's join badge over a music video, and the
alert dialog over the page.

**The TV safe area** stays `--tv-safe-x` / `--tv-safe-y` in `app.css` (48 px or 5vw, 40 px or 6vh). The redesign
reuses it unchanged.

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

**So capture an anchor in the effect that reads every signal it depends on.** `src/routes/+layout.svelte`
extrapolates the strip's progress rail between broadcasts from `positionSec` plus a wall clock, once a second
rather than once a frame. With the anchor in its own effect tracking `positionSec` alone, a resume did not re-run
the capture while the interval effect did, and the readout extrapolated from the clock recorded at PAUSE time —
one second after every resume it leapt forward by the whole pause and clamped full on a song still playing. Both
reads now live in ONE effect, which makes a stale anchor unrepresentable. That shape is load-bearing, and it is
load-bearing TWICE: `src/routes/queue/+page.svelte` runs a second anchor of the same shape for its elapsed clock,
and it too keeps both reads inside the effect.

**The site that used to demonstrate the safe two-effect case is gone, so the principle is stated instead of
pointed at.** Reading `playback.positionSec` off an object `src/lib/stores/room.ts` REPLACES wholesale on every
broadcast makes the two-effect arrangement safe, because the replacement is a fresh identity and any playback
change re-runs the dependent effect. The one-effect shape is written anyway, because an arrangement whose safety
rests on a store's identity discipline breaks silently the day that store mutates in place instead. The root
layout takes the opposite trade and mirrors NINE scalars, which is what narrows its dependency set: a library
merge or a queue reorder touches none of them, and a component that mirrors cannot borrow the route's shape.

**A FRESH IDENTITY FOR AN UNCHANGED VALUE IS A CHANGE, which is the cost the paragraph above only states the
benefit of.** `/queue` used to anchor its elapsed clock off its mirrored `room.playback` OBJECT, and `proxy()`
has no identity cache — so `playback = room.playback` minted a new proxy on every room emit and the assignment
was always a change, even when every field was identical. The client heartbeat is 15s and the server answers
every `hello` with a `playback:state`, so an idle phone re-anchored its own clock to the same stale position four
times a minute: with no display reporting, the readout sawtoothed BACKWARDS once per heartbeat — a measured series
over an idle phone read 0:00…0:12, then 0:00 again, then climbed once more.
So the rule has a second half. **Anchor an effect on SCALARS, inside the effect.** `/queue` now mirrors
`positionSec` and `isPlaying` as scalars beside the object (which it still keeps for the fields no effect
anchors) and the anchor effect reads those; writing an equal primitive notifies nothing, so an identical
rebroadcast is silent while a real change still re-arms the ticker. The root layout never had this defect for
exactly that reason, and the two surfaces no longer disagree by construction.

**An extrapolated position is capped where it is DRAWN, not where it is computed.** `drawPosition` in
`src/lib/playhead.ts` has no duration term, so once nothing re-anchors, an elapsed readout runs on past the end
of the song while `formatRemaining` clamps its remainder at zero — one readout, two halves, disagreeing.
`/queue`'s clock takes `Math.min(displayPos, nowDurationSec)` at its own call site rather than capping the shared
helper, because that helper also feeds the TV lyrics reel and the layout's transport ring. An unknown length is
0, so the cap applies only when there is a length to cap to. NOTE FOR WHOEVER OWNS THOSE TWO SURFACES: they
carry the same unbounded term and want the same one-line clamp. What none of this fixes is the product gap
underneath it — the app has no concept of "the display is not reporting" (there is no `tvConnected`, and no
presence for `role=tv`), so `is_playing` stays asserted forever after a television vanishes. A clock that stops
at the end of the song is an honest-shaped lie, not the truth.

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

### The now-playing strip, and the sheet it replaced

`src/lib/ui/NowPlayingStrip.svelte` is a fixed-height strip with **no open state at all**: no snap array, no
drag, no geometry read. **Since redesign step 4 it is a now-line, not a remote** (an owner ruling): it says who is
singing what, or what the queue waits on, and keeps the Cheer key, while pause, restart and skip are on the Queue
tab's Now card. Its one transport key is Play, in the Cheer key's slot, only with nothing playing and a song that
can start: the server starts the next song itself on any queue change or finished karaoke, but a room left idle
with a ready queue (a restart) waits for that tap. When the song starts, focus on Play moves to the Cheer key (or to
the link, on your own song) rather than falling to `<body>`. It is Spotlight chrome: ink on `--role-ground` under
one `--role-rule`, with the tab bar on the same ground and no fill of its own. Everything the old sheet's expanded
body held (the guiding track, the vocal range, key shift, the clock) is the now-playing card at the top of `/queue`,
because that is the screen you are already on to see whose turn is next.

**The heart (proposal 36)** sits at the end of the line, before the Cheer key, while someone else sings: one tap
saves the song to Your songs (`PUT /api/me/songs/:mediaId`), a second takes it out (`DELETE`). `$lib/now-line-saves.ts`
holds the saved set: read once per singer from `GET /api/me/songs`, emptied first on any change of singer so a Leave
never hands one guest's saves to the next, and flipped on the tap, so the mark fills in the same frame. Each song's
requests go out one at a time in tap order, so a double tap during a slow save ends where the guest left it. Only the
last tap rolls back and toasts if the server refuses, and a `DELETE` answered 404 counts as already out. A save swaps
the line's words (and hides the singer's dot) for `<song> is in your songs` for 2 s, in place, keyed on the entry like
the title; a rollback ends it at once. An unsave says nothing, and `aria-pressed` carries the state for a screen
reader. The heart's few rules are in the root stylesheet, so `/tv` carries them too: a lazily imported component's CSS
is still listed on the importing node, and as its own file it cost more than it saved (measured, +239 B gz a route). On your own song, or offline, the heart rests hidden and inert in its slot, as the Cheer key does, so
nothing moves at the handoff (`now-line-heart` probe; `phone-heart-save` in `ui:review`, a cut, CLS 0).

**What was deleted, and why the account is kept.** `NowPlayingDrawer.svelte` (618 lines), `NowPlayingBand.svelte`
(398) and `sheet-snap.ts` (57) are gone, with `src/lib/components/ui/drawer/` (263 lines across 13 files) and the
`vaul-svelte` dependency. The thesis is a product fact rather than a simplification: Encore's now-playing surface
is the TELEVISION, and the phone is a remote and a queue — a multi-snap sheet gave the phone a now-playing view
it never needed. The owner reported the sheet expanding on its own and covering the page, and that class of
defect was structural to the arrangement. The costs it imposed, recorded because each one is a shape to
recognise rather than a line count:

- **The snap array could only be replaced while nothing pointed into it.** vaul looked the active snap point up
  by STRICT EQUALITY on its value, so replacing the array under a live pointer yielded index −1, no snap and a
  dead handle; and the seating watch wrote a transform with no null guard, so seating before the content had
  bound its ref landed the write on `null`, permanently. Both failed silently. Snap 0 therefore had to be a
  CONSTANT reaching the stylesheet as `--snap-band`, snap 1 a derived value written `null` → tick → value, and a
  resize had to re-lay the sheet out by hand because nothing in vaul did.
- **Drag exclusion had to be an exclusion, not an allowlist.** `handleOnly` was all-or-nothing, so with it off the
  body's sliders became drag surfaces and the guiding-track thumb and the dismiss were one gesture with the
  drawer winning as ancestor. So the body carried `data-vaul-no-drag`, the transport group carried its own
  (vaul set pointer CAPTURE on press, so a drag begun on the disc retargeted its `pointerup` to the button and
  fired a click), and the metadata block had to record where a press started and disarm its own toggle past
  vaul's swipe threshold.
- **Three "optional" props were necessities.** `modal={false}`, because a permanently-mounted sheet whose
  collapsed height is the docked band cannot put a scrim and a focus trap over the page in use;
  `trapFocus={false}`, because the trap installs a document-level `focusin` capture listener for as long as it is
  enabled and enabled was `open`, permanently true; and a hand-composed grab bar, because the vendored position
  was the top of the content box rather than the row a thumb pulls.

None of that applies to a strip. The replacement's own constraints are two lines of CSS: `.meta` keeps
`min-width: 0` so the nowrap title ellipsises inside the flex item instead of sizing it (without it the Cheer key
is pushed off a 320px screen), and the TITLE is what gives up width rather than the singer's name — a truncated
name reads as the wrong person where a truncated title still reads as the right song.

### The mount rung, and the rule it puts on size bindings

happy-dom has no layout engine, so the mount harness replaces every geometry read with a THROW rather than
letting a fabricated zero pass. A zero is not a measurement, and the
two natural guard shapes around one are a permanent red nobody trusts or a permanent silent green.

The consequence is a rule about markup, not about tests. `.dock` in `src/routes/+layout.svelte` carries
`bind:clientHeight`, so ANY reactive update in that part of the template re-runs its size binding — and on this
rung that throws. So:

> **A size binding must never be driven by a reactive prop or a `class:` directive.** State that needs to reach a
> measured subtree arrives as an ATTRIBUTE, because an attribute write re-renders nothing and cannot change the
> measured height. The deleted sheet had two such boxes (`.band-slot` and `.np-fit`) and passed every piece of
> sheet state as a callback or a getter to satisfy this; the dock has one, and the rule it has to satisfy is
> harder rather than easier. **`.dock`'s own CONTENT is conditional** — the strip swaps its title, Cheer key, cheer
> tray and offline cue as the room changes — so the binding genuinely re-runs, which is exactly the shape this
> rung objects to. No unit test mounts the root layout today; one that does will need a layout engine, and that is
> the constraint to honour rather than to work around. The layout's own comment says so at the binding.

The same rung is why `src/lib/components/GuidingTrack.svelte` does not use the vendored Slider (the primitive
reads `offsetWidth` to place its thumb, so it cannot be mounted at all), why
`src/lib/components/LyricsReselect.svelte` hand-rolls its disclosure (the vendored Collapsible reads geometry in
a watcher that fires the moment its element gets a ref, and the deferred read then fails whatever mounted it),
and why `src/lib/components/QueueRow.svelte`'s digit roll is a keyed block plus a keyframe rather than a
class-toggle restarted by an `offsetWidth` read.

Two smaller rung-adjacent rules. A `$effect.pre` that records a previous value seeds it INSIDE the effect
rather than from the prop at its declaration: `let prev = value` is a `state_referenced_locally` warning, and
`bun run check` is held at 0 errors and 0 warnings. And pointer-event properties are not geometry — `pageY` is
a property of the event, so the delta arithmetic in `src/lib/queue-drag.ts` (`ev.clientY - startY`) is safe on this
rung where the same module's press-time `getBoundingClientRect` reads are not.

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
- **A row announces the stage it CHANGED INTO, never the stage it was BORN in.** Both `SongRow` and
  `ProcessingCard` capture `bornStage` once with `untrack` and gate their `role="status"` region on a difference
  from it. Without it a list mounts one polite region per row, all reading one sentence: measured on /library at 63
  `role=status` insertions against 3 removals, and the same wall was latent on /queue for every stranded turn the
  moment a card kind stopped requiring a live status. Driven with the guard in place, a /queue arrival rendering 99
  stalled cards inserts 3 regions and removes 3, leaving the route's own announcer. What it gives up deliberately
  is a card that mounts already settled (failed or stalled) announcing nothing; the visible line still says so, and
  a retry that moves a card to "Making karaoke…" is a real transition and does speak.
- **`ProcessingCard` and `QueueRow` are deliberately byte-identical** on the drag transform, the digit roll and
  the dimmed treatment, because the two kinds sit in ONE list dragged by one gesture, and a difference reads as
  one of them being broken. A long-name fixture additionally
  pins the singer-dot comment in `ProcessingCard` and the gallery fixture that makes its 0px collapse visible.
- **A dragged row is transparent to hit-testing.** It is translated to sit under the finger, so as the topmost
  element at the pointer it is what `elementFromPoint` returns instead of the drop slot beneath, and a release
  on a legal target commits nothing.
- **`SongRow` offers ONE primary action.** A turn with no process is held and skipped by the rotation forever; a
  process with no turn gives the singer nothing. `src/lib/process-and-queue.ts` runs both: the process first,
  then the add, and the add only if the process started. The POST marks the song `queued` before it answers, so
  every other phone reads the new turn as "Making karaoke…" from its first frame. The job's priority comes from
  the hub's `onEntryAdded` reprioritise when the add lands.

### The Spotlight and the Guide segments

`src/lib/ui/Spotlight.svelte` is the redesign's one lit surface. A screen has at most one, and it holds the next
thing to do. Sing is its first screen (the search box). Its story is `/components/spotlight` (dev-only), filmed by
the `spotlight-*` rows of `bun run ui:review` on `vite dev` (`tests/playwright/world/gallery.ts`). Five things
keep it steady, each found as a flake:

- **No file watching.** The gallery sets `ENCORE_VITE_NO_WATCH`, and `vite.config.ts` then ignores every path
  (`server.watch.ignored: ['**/*']`; `watch: null` does not survive config resolution and left the watcher on). A
  watcher per instance ran the box out of file handles (`EMFILE`), and a trace written under `.artifacts` reloaded
  open pages; the `spotlight` probe writes one and asserts no reload.
- **One server, serially.** The story rows share one `vite dev` and run serially, and so does the probe file.
  Parallel instances share `.svelte-kit/` and reload each other's pages.
- **A cache per instance.** Each instance gets its own cache dir (`ENCORE_VITE_CACHE_DIR`, unset in normal use), so
  two cold optimisers never collide (`ENOTEMPTY`).
- **The artifacts are ignored.** `vite.config.ts` ignores `tests/playwright/.artifacts/`, where a trace `.html`
  reloaded every open page.
- **Every route is scanned at startup** (`optimizeDeps.entries`), so no late re-bundle breaks an open page.

The `spotlight` probe holds these on the same story:

- only transform and opacity move;
- the spinner obeys the grace;
- a Guide tap checks in the next frame;
- the radio group's keyboard;
- a pick the room ignores drops back;
- the focus ring on a lit card;
- every card's ink clears AA.

- **`moment`**:
  - `idle`: the raise surface, ringed in `--spot`.
  - `on-deck`: filled in the owner's colour, with a `--type-display` headline.
  - `your-turn`: the same fill, a `--type-hero` headline and more room.
  - `error`: the danger surface and ring, with no fill.
- **`colour`** is the owner's singer colour, snapped to its registry stop. Ink is that stop's certified `on_fill`,
  never a guess. The dimmed meta line is 80% of it, the lowest that clears 4.5:1 on all 48 stops.
- **Motion** is transform and opacity only. The fill is a `.fill` layer that lights by opacity, never a background
  animation. On mount the card fades in from `scale(.98)` over `--motion-base`. On deck to You're up animates only
  the headline, which pops from `scale(.92)` over `--motion-slow`. The fill is already lit, and a flood restarting
  from 0 blinked the card dark (seen in the ui:review filmstrip). Reduced motion cuts.
- **Names.** The region is `aria-labelledby` its own heading, so its name is said once.
- **`busy`** shows a spinner only through `src/lib/ui/grace.ts`: nothing for a wait under `PENDING_GRACE_MS`, and
  once shown it stays at least that long (tenet 2). `aria-busy` follows the same grace, and the ring is
  `aria-hidden`: the region's busy state is what a screen reader hears. The ring is its own, not `ui/spinner`. Importing that one from
  here moved `cn()` into a chunk of its own and cost every shipped route about 6 KB of gzipped JS (CLAIM 13).

`src/lib/ui/GuideSegments.svelte` is Guide as Off / Low / Full (an owner ruling; the song page keeps the slider for
fine control).

- **Levels** are in `src/lib/guide-preset.ts`. Low is 0.3, the owner's accepted default, and it is tunable there:
  change `GUIDE_PRESETS` and `guide-preset.test.ts` together. A level between presets (a room default of 0.2, or one
  the song page's slider set) shows the NEAREST segment checked (`nearestGuidePreset`, a tie to the quieter one), so
  the control never reads as unset (#1295 review). `guidePresetOf`, which says whether a level IS a preset, keeps
  returning null there for the song list.
- **No `<style>` block:** its look is inline, because the You're up flood renders it too and SvelteKit would link a
  stylesheet of its into every route (CLAIM 13). The group sets the global ring's `--focus` to `--seg-focus`, so a
  lit card still names its own ring.
- **It is an APG radio group:** `role="radiogroup"`, `role="radio"` with `aria-checked`, and one tab stop (the
  checked segment, or the first when none is). The arrow keys move and select, wrapping, and Home and End jump to the
  ends. Each segment is a 44 px target.
- **A pick shows in the same frame.** The room's answer replaces it. If `onpick` returns false (the command never
  reached the wire), the pick drops at once. If the room keeps its level and so sends no change, the pick drops after
  `PRESS_HOLD_MS` (3 s). A change of `scope` (the song it belongs to) drops it too, so a pick never carries onto the
  next song even when that song's level is the same.
- **Paint.** A checked segment is filled in `currentColor` and its label inked in `--seg-ink`, which the Spotlight
  sets to its own surface. The focus ring keeps the pill's radius and takes `--seg-focus`. A lit card sets that to
  `--on-spot`, which is certified on the fill, so the ring clears 3:1 on all 48 singer colours. Elsewhere it is
  `--role-focus`.

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
one 8px card gap. The rule is stated as ITSELF, not only as a list of the register's own rows: the register may
dress a heading over a list or an eyebrow over a block as often as it likes, but it may never sit on or inside a
field label. The row list is kept as well, as a second and narrower guard — it is the only thing that notices the
register SPREADING, and it reddens when a surface legitimately grows a section heading, which for a tripwire is the
point rather than the flaw. Keep it in the test, not in prose: the copy this paragraph used to carry went false twice
over — it named a `.fact` row where the dressed class is `.lab`, and a now-playing sheet that no longer exists. One
`--ph-text-xs`/0.1em row is neither register, and it is
neither because it labels no control: the song page's `.lab`, the Key and Range labels in its `.facts` card.
`GuidingTrack` was a second until its eyebrow was retired — it
labels a slider AND it rendered that eyebrow inside a real `[data-slot='field-label']`, which was the whole evidence at
the time: the row's hosts were then the now-playing sheet and `/components`, and no screen put the two dresses side by
side the way the You card did. `/queue` replaced the sheet and DOES, so the comparison exists now — its now-playing card
renders the key row's `.control-label` 8px above `GuidingTrack`'s box (the card's own `row-gap`) and 20px above
`GuidingTrack`'s field label, which adds the Field primitive's 12px `margin-top`; measured at 390x844 — and the two
labels agree, which is why the key row carries the shared class rather than re-declaring
three of its four properties locally. (`/components` still renders no second field label: the gallery imports no
`Field.*`, no `ColourRing`, no `CodeEntry`.) Its label text is the primitive's now; the row
kept the value's rank by moving `.gt-val` UP to `--ph-text-md` rather than holding the label down, and `/settings`
already labels the same knob at room scope as `Guide · <n>%` in that dress.

ONE MORE LABEL DECISION, about the WORDS rather than the dress. A field label takes the second person exactly when
the value is the singer's OWN — `Your name`, `Your color` — and stays a bare noun for anything the room or the box
owns: `Guide`, `Font`, `Join address`, `Room code`. Every field label in the tree is a bare noun except
those two personal values, each of which appears on both surfaces that edit them (`/settings`' You card and the
join screen's identity pane) — four labels, and `label-register.test.ts` holds that set exactly, in both
directions, beside the census it sits in: 33 field labels, 4 possessive and 29 bare. The possessive set is the rule;
the total is the proof the filter behind it found anything. The possessive is not decoration: the string is also the accessible NAME — `ColourRing` hands one
`label` to both its heading and its disc's `aria-label` — so it has to say whose colour it is out of visual
context, where the `You` card title is not read with it. It is the app's voice elsewhere (`Your library`,
`Your lyrics`, `Your pick`, `Your profile`) and `ColourRing`'s own default prop, which `/settings` was the single
site to override away — leaving one control under two names on two screens, `Color` here and `Your color` there.
`tests/unit/lib/label-register.test.ts` pins both halves, the dress and the wording. The dress half is checked per
ELEMENT — no class dressed with `text-transform: uppercase` may sit on or inside a `<Field.Label>` or a
`.control-label`, in markup or as an inline style — which is what makes it indifferent to the register growing, since
the register is entitled to grow. Keying on the transform rather than on a tracking value is what reaches `app.css`'s
own `.grouphead` at 0.14em, the television's rows at 0.16–0.2em and `/components`' inline `.1em` sites, none of
which the old `0.1em` scan could see. It carries the retired defect's own shape as a FIXTURE, so the zero cannot go
vacuous if the markup idiom changes.

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
that must agree: whether the layout opens a `role=phone` socket, and whether the dock renders. An ungated
`room.connect()` in the root layout would give `/tv` a second socket and register the television as a
singer present in the room.

### The dock and `--dock-h`

**ONE FIXED CONTAINER HOLDS BOTH ROWS.** `.dock` in `src/routes/+layout.svelte` stacks `NowPlayingStrip` on
`TabBar` in normal flow; they are not two separately-fixed elements, because the tab bar composes the
home-indicator inset and the strip composes none — two fixed siblings would each need their own inset arithmetic
and would disagree the moment one of them changed height. The dock is NOT inside `.app-shell`: the shell is
centred and width-capped, so on a tablet a dock inside it would float in the middle of the screen.

**THE DOCK HAS ONE HEIGHT (proposal 13).** It is always the strip on the tab bar, **92px** at 390x844 and 320 (the
ui:review dock rows), whether the room is idle, queued, playing, cheering or offline. Every strip state is one
`var(--tap)` row — the four reactions sit behind a Cheer key and swap in for the now-line, "Reconnecting…" takes the
title slot, and an idle room reads "Nothing playing". The dock carries no pause, restart or skip in any state
(redesign step 4), only the idle Play in the Cheer key's slot; `measured-dock` and `dock-cls` assert that too, and
`dock-idle-play` reaches the idle room through a reboot and taps that Play. Before, the dock had three heights (48,
93 and 164 with a reaction row), and each step moved its top edge on every phone in the room.
`measured-dock.spec.ts` asserts the one height across states and surfaces; `dock-cls.spec.ts` asserts no layout
shift from the dock across seven room transitions at 390x844 and 320x568.
Readings below that quote a 46px dock or a top edge of 854 (1440x900) / 798 (390x844) predate it.

`src/routes/+layout.svelte` is the only writer of `--dock-h`, the dock's measured (never guessed) height,
published on `documentElement` so every scrolling column can reserve it in normal flow. Rules:

- Exactly one element adds `env(safe-area-inset-bottom)` — the TAB BAR, because it is the app's bottom-most
  element. That inset reaches everything stacked above it through `--dock-h`, so a second `env()` term anywhere
  else doubles the gap. Measured: `padding-bottom` is 0px on `.dock` and on the strip at inset 0, which is why
  `tests/playwright/specs/gate/measured-dock.spec.ts` reads the tab bar for that arm and nothing else.
- The effect's teardown is contractual. An inline custom property on `:root` outlives its writer and
  outranks any stylesheet rule, so a stale `--dock-h` would pad the television's stage by a dock it has not
  got, and no media query could override it.
- No media query may set `--dock-h`; the measurement outranks it, so such a rule is silently dead.
- **The height is MEASURED, and a token-arithmetic version was tried and failed.** A tab renders 45px against a
  declared 44, because its icon, gap and label outgrow the 32px that `min-height: var(--tap)` leaves inside
  `padding-block` under border-box — the declared total came to 102px against a rendered 91. The content-driven
  height is also the CORRECT one: the chrome holds text, and a frozen height would clip the label at the
  browser's 200% text-only zoom. Do not re-attempt it; `src/app.css` records the same finding.
- `dockH` seeds at a plausible height, not 0, so a column reserves roughly the right space on the frame before
  the bind lands rather than jumping.
- The strip's progress hairline extrapolates between broadcasts, and its anchor is captured inside the effect
  that also reads `isPlaying`. A resume re-delivers an equal `positionSec`, and writing an equal primitive into a
  `$state` scalar notifies nothing, so a separate anchor effect never re-runs and the interval keeps
  extrapolating from the pause-time wall clock.

### Offline, and which taps survive it

**THE REMOTE MAKES TWO DIFFERENT PROMISES AND NO SURFACE MAY BLUR THEM.** A QUEUE op — add, move, remove — rides
`QueueStore`, which keeps accepting taps with the socket down and replays the pending one on the next
`queue:sync` through `resendPending()`. A PLAYER command — play, pause, skip, restart, ±key, the guiding track —
goes through `RoomLink.command`, which is one `WsClient.send` with no pending ledger behind it: **dropped means
lost.** The strip's offline cue says only "Reconnecting…" because that is the one sentence true of both, and
`--warn` rather than `--danger` because a dropped socket self-heals on the next backoff tick.

`RoomLink.command` returns the boolean `WsClient.send` has always returned. `false` means the socket was absent
or its `readyState` was not OPEN, so the server never heard it. **Every call site reads it** — three today, all on
/queue and the layout — and `tests/unit/lib/player-command-drop.test.ts` is the guard. It allow-lists the consuming
shapes rather than banning the bare statement, because `onskip={() => room.command(…)}` discards the result just as
thoroughly while looking like it uses it, and it requires the receiver to be the `room` singleton so an aliased one
has to be argued rather than smuggled past. **Its scan is the whole of `src/`**, which is what the word exhaustive
has to mean here and for one revision did not: it read the two files the call sites happened to live in, so a bare
`room.command(…)` pasted into `src/routes/+page.svelte` — one of five files importing the singleton — left the
suite green. The file now derives that importer list and asserts the scan reaches all of it, ahead of the arm that
relies on it. (The one deliberate silent drop in the tree is the TV's `tv:telemetry`; the TV socket section says
why.)

A call site can owe one of two things, and which one depends on whether it holds an optimistic value:

- **An optimistic value may not move on a drop.** Two controls hold one, on /queue's card and the You're up flood: the
  ± keycaps (`keyDraft`, in `$lib/live-tune.svelte.ts`, which both share) and the Guide segments (their own pick,
  `GuideSegments`). Both are "no local opinion" drafts —
  cleared when the room answers and on a song change, set only by a command that reached the wire.
  **A DRAFT IS ONLY HALF OF IT WHERE THE CONTROL IS A THIRD-PARTY WIDGET**, and the slider (`GuidingTrack`, which
  /queue drove until redesign step 5b) shipped on that half
  alone for a revision. bits-ui keeps its own copy of a slider's `value` and reads the thumb position, the filled
  range and `aria-valuenow` out of it, so holding the draft back left all three advancing on a refused command:
  measured offline against a room at 0%, `aria-valuenow` reached 95 and the thumb 92% of the track while the
  readout still said "Off", and it survived the reconnect. The phantom then ARMED THE NEXT INPUT, because the
  keyboard path steps from that same copy: one arrow key sent a step off 95 rather than off the room's 0. The
  repaired control was driven on the same scenario — offline drag to the far rail moved nothing, and one
  ArrowRight after the reconnect put a single step off the room's own level on the wire.
  The fix is a CONTROLLED value — `GuidingTrack` passes `bind:value={getter, setter}` where the getter
  is the room's level, so a move is a request and there is no second copy to diverge. A `bind:` cannot travel
  through a spread, which is why `FieldSlider` has to declare `value` instead of letting it ride `...rest`. Not
  `{#key}` on a refusal: re-creating the control drops focus, so a keyboard guest would be thrown out of it on
  every dropped keypress.
- **A say is owed where failure is indistinguishable from success.** Restart, play/pause and skip (on /queue's Now
  card, sent through the layout's `'transport'` context, typed in `src/lib/transport-controls.ts`) hold no optimistic
  value, so there is nothing to roll back — but on SUCCESS they change nothing locally either, since the next
  broadcast is what redraws them. Silence therefore cannot be read at all, and the
  guest's only remaining move is to tap again. `transport()` in `src/routes/+layout.svelte` answers with one
  `toast.error` carrying `id: 'transport-dropped'`: sonner keys toasts by id, so a mash updates the single
  notice and resets its timer instead of stacking a tower of them over the dock.

**THE BAR IS NOT A SUBSTITUTE FOR THE NOTICE.** It answers "is the link up?", is up for the whole outage, and
deliberately declines to say which taps survive; the notice answers "did the command I just issued land?". Nor is
the bar reliably up when a send fails — `connected` flips in the socket's `onclose`/`#presumeDead`, while a send
reports `false` the moment `readyState` leaves OPEN, so a tap in the window before `close` is dispatched is lost
under a bar that is not showing yet.

**THE LIMIT NEITHER CUE COVERS, recorded because it is real:** a FROZEN socket still reads OPEN, so the send
returns `true` and the command is lost with no signal anywhere. Nothing at a call site can see that. What bounds
it is `WsClient`'s liveness watchdog and its `offline` listener — without them, detection waits out
`heartbeatMs` + `livenessTimeoutMs`, 15s + 10s, and client.ts holds the measured readings from a real cut.

### The three tabs

The phone has one navigation and it is a tab bar: **Sing** (`/`), **Queue** (`/queue`), **Library** (`/library`),
rendered by `src/lib/ui/TabBar.svelte`. Before it, every trip between surfaces went through the home page: the library
behind an unlabelled icon door beside the search field, settings behind a gear, and every way back a `goto('/')`.
The three settings scopes, `/stats`, `/metrics` and `/admin` are deliberately NOT tabs: they are not party-time
surfaces, and a tab a guest never presses during the thing the app is for costs the same thumb-width as one they do.
(`/stats` still has exactly one link into it, from the ROOM scope — `/settings` — and `/metrics` exactly one, from
the machine scope; that is a property of those two pages, not a gap in this bar. Settings' own three scopes are
three routes precisely so that this bar is the phone's only tablist.)

Three tabs because the home column already WAS three pages. It rendered six sections and branched all of them on
`searchActive` — not searching gave `Queued` / `Making karaoke…` / `Your library`, searching gave `Ready to sing` /
`Needs karaoke`. That branch was this split, wearing one URL.

**The thesis the split rests on: Encore's now-playing surface is the TELEVISION.** The phone is a remote and a queue,
so it never needed a multi-snap now-playing sheet. `src/lib/ui/NowPlayingStrip.svelte` is a fixed-height strip with no
snap array, no drag and no geometry read, and since redesign step 4 it is a now-line with no transport but the idle
Play. Everything the sheet's body held, and now pause, restart and skip, — ± key, the guiding track, the range bar,
a clock readout — is on the Queue tab, above the list it acts on, because those controls act on what is PLAYING and the
playing song is not in the queued list. `vaul-svelte` is GONE: the `/components` gallery was its last importer, and
once that section was replaced by the strip and the tab bar the dependency and the 13-file `components/ui/drawer/`
wrapper were deleted with it. Measured on the build afterwards — `vaul` appears in no client artifact at all, and
deleting the wrapper took 5,152 bytes out of the root stylesheet every surface downloads, /tv included (55,927 →
50,775), 3,211 of them being 24 rules whose selector spelled `data-[vaul-drawer-direction=…]`.

The strip and the tab bar sit inside ONE fixed `.dock` in `src/routes/+layout.svelte`, which is also the single writer
of `--dock-h` (the section above holds that contract). The height is MEASURED, by `bind:clientHeight` on `.dock`. A
token-arithmetic `--dock-h` was tried and failed, and app.css's `NO BOTTOM-DOCK TOKEN HERE` note is the record of why:
a tab renders 45px against a declared 44, the declared total came to 102px against a rendered 91, and a frozen height
would clip the labels at the browser's 200% text-only zoom — so the content-driven height is also the CORRECT one.
Measured at 390×844: `--dock-h` is 91px, the rendered dock is 91px, each of the three tabs is 45px, and `/`'s `main`
reserves 119px (91 + 28).

The current tab is an INK change plus a second, non-colour channel, because colour alone may not be the only means of
conveying it (SC 1.4.1). `/song/[mediaId]` lights NONE of the three: it is reached from the Queue tab's now-playing card — the only door
to it in the tree, and the one the deleted sheet used to hold — and has its own back
affordance, and lighting a tab the guest did not press is a lie about where they are.

Reordering the queue lives with the rows it moves, on the Queue tab. It is a live sort with no mode, split in two:
`liveSortTarget` in `src/lib/reorder-mode.ts` is the arithmetic — it both places the rows and decides what a release
commits, so a drop cannot land somewhere the guest did not see — and `src/lib/queue-drag.ts` is the browser wiring.
Geometry is measured once per gesture at press time (rows change height mid-flight), pointer listeners go on `window`
because the pressed grip becomes a detached node as the list reorders, and focus is returned by attribute for the same
reason; all three of those rules live in `queue-drag.ts`, and the route keeps only the reactive state they drive.
Arrow Up/Down on the grip is the single-pointer alternative (SC 2.5.7 / 2.1.1).

**BOTH ROW KINDS TAKE THE GRIP, and the cooking one is the row a guest most wants to move.** A song that is still
processing holds its turn, so it is a queued entry like any other: the server's `move-to-index` gate consults
identity, an integer index and ownership, never readiness. The handle is gated on `ProcessingCard`'s `grip` prop —
not on `reorderable`, which only widens the actions cluster — and a route that passes one where the component
reads the other leaves the cooking card with no handle and no keyboard path beside neighbours that have both,
which reads as broken rather than as a rule. One known cosmetic cost: `--row-h` is the CARRIED row's single
measured height, so dragging a tall cooking card shifts its shorter neighbours by a cooking-card height. The
committed target is unaffected, because `liveSortTarget` counts measured row CENTRES.

**WHICH CARD A QUEUED ROW GETS IS A READINESS MAPPING, NEVER AN "IS IT IN FLIGHT" TEST.** `queueCardKind` in
`src/lib/readiness.ts` is one expression over `displayReadiness`, and the Queue tab's gate on it is
`{#if card !== 'plain'}` — a list of kinds there means a kind added later falls through to a plain `QueueRow`,
which is the bug surviving its own fix while every `.proc` assertion keeps passing. A card kind is **a claim about
whether the rotation can ever play the entry**, the same question `nextPlayableEntryId` and the server's
`nextPlayable` act on, so there are four:

- `plain` — the turn will play (or the live status says it is about to). `QueueRow`.
- `processing` — something is making its karaoke. The only kind that draws a bar, and the only one that reads
  `status`/`pct`; an ABSENT live status is a real case there (the catalog says cooking, this phone holds no
  broadcast, reachable whenever `refreshLibrary()` throws) and `queued` is the least-committal honest stage for it.
- `failed` — a process RAN AND DIED, from a live `media:status`. This is the only kind on this surface that earns
  the **danger** family.
- `stalled` — **a dead turn**: a queued entry whose stems gate is open with nothing in flight that could close it,
  or one the server has already called `unservable`. It takes **warn**, and the token rule is what decides that
  rather than taste: the client cannot tell a turn whose process half never landed (permanent) from the
  one-round-trip window on another guest's phone between the add and the `media:status` that follows it
  (transient), so it is not entitled to --danger — which also settles the grace question with no clock at all. A
  warn card saying no karaoke is being made for this turn is TRUE in both readings. A client-side `addedAt` age
  gate is NOT available as an alternative: that field is a server stamp, so comparing it against the device's
  `Date.now()` is cross-clock.

The stalled card carries the only **retry** in the tree that can recover a stranded turn without searching for the
song again (SongRow's `data-retry` is reachable only from a search result). It is **ungated by ownership**, unlike
remove: a retry destroys nothing, /api/process is already callable by any joined singer for any song, and every
stranded turn in a real room tends to belong to a singer who is `· away`. It runs the process ALONE —
`processAndQueue`'s `hasQueuedTurn` branch — and a refusal rolls back the optimistic status mark and NOTHING else,
because the turn rides `QueueStore` and is resent on resync, so rolling it back would delete a turn the guest
asked for. The request itself is `RoomLink.requestProcess`, hoisted off the Sing tab once it had two callers.

**Queue news needs a pure function AND a caller that seeds it honestly.** `queueAnnouncement` in
`src/lib/phrasing/queue-announcement.ts` is silent with a NULL baseline, so joining a busy room does not read the
whole queue aloud — and that guard is defeated by a caller that seeds the baseline before the socket has spoken.
`room.queue` is constructed before the socket opens, and an empty list in that window is indistinguishable from
an empty queue, so `QueueStore.synced` (set only by the `queue:sync` handler) is what the Queue tab gates its
announcement effect on. The first SYNCED list is the baseline even when it is empty: seeding from the first
non-empty list instead would swallow the first add in a room that really was empty.

**Every phone TAB has a join gate, including the Queue tab.** `/`, `/queue` and `/library` all render
`JoinLanding` when `me` is null, which is what stops an unjoined visitor — a shared or bookmarked link, a second
device, a guest who tapped Leave — being shown a route's own empty store as a fact about the room. /queue was the
holdout, and its empty-queue copy ("Find a song on the Sing tab") pointed at a dock that only a joined singer
has. `JoinLanding` reads `?room=` itself, so the gate also keeps a scanned or shared code instead of asking for
it again. The cost is shared by all three: `me` is mirrored from the link, so the landing can paint for at most
one frame on a cold load even for a joined guest, which is what the two older tabs have always done.
Beating that wants a settled-state read on the link, applied to all three at once.

### The Now card

`/queue`'s row for the playing song, under your card when you have one (redesign step 5b). It is a **compact Now
row**, ink on the ground with no surface of its own, under a quiet sentence-case "Now": the song (its title,
underlined, is the door to `/song/[mediaId]` for everyone who is not singing), the singer, the clock and the transport.
The row arriving with the room's first song fades in (`.arrive`) once the blocks under it have glided past its box:
held at 0 for `--motion-base`, then a `--motion-fast` fade, 370 ms in all (#1092). On a cold load the list's skeleton
holds its place from the first frame but is seen only past `PENDING_GRACE_MS` (300 ms), so a quick sync never shows
it, and the list that replaces it later is never held back for it (#1090, #1171). Past the grace, "Loading the
queue…" is written into the page's polite `.sr-live` region as text, and cleared when the sync lands, so a screen
reader hears it (#1328). An unjoined visitor's join screen is loaded on demand, as on `/`, so a joined phone never
downloads it; if its chunk fails, both tabs show the same `.join-lost` line (app.css) with Try again.
**It holds the transport** (redesign step 4, an owner ruling, moved off the dock): restart, play/pause and skip,
three 44 px keys under the clock in one `Playback` group, for every phone, as the strip had them. Play/pause is the
row's one accent fill. They go through the root layout's `transport()` and tap
target (the context in `src/lib/transport-controls.ts`), so the dropped-command notice and the settle window are
unchanged. When the last Skip takes the card away, focus that fell to `<body>` goes to the dock's now-line link.
With nothing playing but a song ready, the only Play is the strip's, beside `Ready when you are`: a row here instead
flashed for the frames between the queue patch and `playback:state` as every first song started, and shifted the
list under it.

The playing song's key and guide belong to its singer (ARCHITECTURE.md §10), so the keycaps and the Guide segments
are on the singer's own card, never on the Now row. The row reads the same facts as one line from
`tuneLine` in `src/lib/song-facts.ts`: `Key +2 · Guide 40%`, the TV's wording in the phone's dress. The key part
shows only while shifted, and a song with no guiding track names no guide. The line's slot is kept, blank, whenever
the song can be tuned, so the singer's first tap fills it without moving anything on the other phones.

A tap that the server refuses because the song is someone else's (an old tab still showing the keycaps) gets the stale
notice "Only Maya can change their key." The phone knows names, not pronouns, so it says "their".

### Your card: On deck, then You're up

`OnDeckCard` is the Spotlight on `/queue` (redesign steps 5 and 5b, #1154): the screen's one lit surface and the
first thing on it, above the Now row. It is `ui/Spotlight` filled in your colour, its ink the stop's certified
`on_fill` (the dim lines and the keycaps' boundary are that ink at 80%, which clears 4.5:1 on all 48 stops), so it
reads on all eight singer colours. **On deck** while the song before yours plays: "After Maya" with the time left at
the line's trailing edge, the `--type-display` headline "You're next", your song, then the Key row (its words are
the key and range, always a line, so a key tap changes words and adds no row) and Guide as Off / Low / Full
(`GuideSegments`). They set the key and guide your song will start in (the entry's preset), and "Not yet" is offered
once. In the last 30 s the meta line says "Grab the mic", a cut. **You're up** once your song plays: the same rows
drive the live song (`stepKey`, and a Guide pick is one `guide` command naming the song), and the details link takes
the slot "Not yet" held. If "Not yet" had focus as it leaves, focus goes to the card's first enabled key.

It is **one box for both moments**. The route renders it in one `{#if}`, so the handoff gives the same instance new
props rather than a remount. Both moments draw the same rows at the same headline size, and the card keeps the height
it had on deck as a `min-height` once it is up, so a wrapped "Not yet" at 320 cannot make it shorter. The queue patch
that starts your song lands a frame before `playback:state` names it, so an entry of yours already `playing` is up
too: for that frame the card shows its preset, and its keys stay enabled and set the entry's preset as on deck. A
Guide pick never carries onto the next turn (`GuideSegments`' `scope` is the entry). `queue-spotlight` drives the
handoff at 390 and 320: the card above the Now row, the key between the header and the dock (G1), the same element,
the same height, no layout shift inside `main`, and the same card after a reload. Being first, it needs no
"your card comes to you" scroll; only a failed queued card does.

### You're up on every other tab: the flood

On any tab but Queue, your turn starting floods the whole phone in your colour (redesign step 6, #1156,
`YoureUpFlood.svelte`). It says "Theo, grab the mic", **You're up** at `--type-hero` and the song. Below that are the
card's two rows in the card's order, Key (its words and the ± keycaps) then Guide (Off / Low / Full), both driving the
live song through `$lib/live-tune.svelte.ts` as /queue's card does, and then Restart. On Queue nothing pops over the
card, because the card already says it (an owner ruling).
- **The colour** is your stop at 85% of its lightness (`floodColors`, `$lib/youre-up`): one step darker than the fill,
  so a lit phone in a dark room glares less. The ink is whichever of the dark ground and white reads better on it, and
  it is also the focus ring. `youre-up.test.ts` holds every one of the 48 stops to 4.5:1. Today every stop takes the
  dark ink, at 4.66:1 to 5.63:1.
- **It is its own chunk, with no stylesheet.** SvelteKit links even a lazily imported component's stylesheet into the
  importing route, so the flood's look is inline and its motion is the Web Animations API; GuideSegments is inline for
  the same reason. The layout imports it with `import()`, once this phone has a queued or playing turn. By the time a skip makes it yours it is already parsed. A failed fetch
  is tried again on the next room update; meanwhile the live region still says it and the TV shows the card.
  `youre-up-flood.spec.ts` times skip to the first painted frame against the 300 ms handoff budget, on a page that
  has never shown it and on one that has, and checks the chunk was fetched before the turn.
- **It goes** on the `youreUpMs` timer, or on a tap anywhere but a control, so the first touch after the moment never
  lands on the page under it. There is no OK button. A key or guide tap leaves it up.
- **What the layout reads for it** (the playing media, key and guide) is read only while it is up, so every other
  surface, `/tv` included, reads nothing more.
- **Restart** is the transport's own `restart`, which every guest may send; the flood adds no permission.
- **It is said once**, from the layout's region that was mounted empty (`data-youre-up-live`). The flood's words are
  hidden from assistive tech, so its accessibility tree is its controls: the keycaps, the Guide radio group and Restart. On Queue that region stays empty: the
  card's own status line is the announcement.
- **Motion:** opacity in over `--motion-slow`, the headline popping from `scale(0.92)`; under reduced motion it simply
  appears.

### The Queued list holds still

Inside `.below`, the Now row, the "Later" heading (dim sentence case), the reorder note, the empty state and every row
hold still when the page moves them in layout. That happens when a song starts or ends, when your card comes or goes
above them, when your own song starts (your card stays, and your row leaves the list) and when a cooking card
changes height. The heading and the empty state share one slot, so one replacing the other holds like a move. Each block's drawn top and layout top are read before the patch
(`$effect.pre`). After it, every block that survived and moved is held in its OLD layout slot by `position: relative`
and `top: --hold-top`, so its box never moves and no layout shift is counted. It glides by transform alone, from where
it was drawn (`--hold-from`) to its new slot, on `--motion-base`, with `forwards` so it stays there. On
`animationend` the hold turns `done`: `top` goes to 0 and `animation: none` removes the glide in the same frame, so the
drawn position does not move and Chromium counts no shift. Two other ways to end it fail. Zeroing `--hold-top` and
`--hold-from` while the finished `forwards` animation stays on moves the layout box under a live animation, and
Chromium counts that as a layout shift. Removing `data-hold` gives the row's `animation` back to `.pop-in`, which
replays its entrance: the row jumps 6 px up and eases back. A block that left is a cut, and one that arrived just
appears.

A second patch mid-glide, such as another row changing right after yours leaves, re-reads both tops and restarts the glide
from where the block is drawn, still in its old layout slot. The older design held blocks with a transform alone
over a layout move. Chromium counted that move once a running transform was restarted in the same frame: about 0.0117
at 390x844 and 390x1200 (#1081).

There is no hold during a drag (the live sort owns those rows), for a reorder (the rows would cross each other), at
the first sync or a reconnect, or under reduced motion. Those cases are cuts, and any hold still running turns `done`.

### The Sing tab

`/` is one scrolling column, and unjoined it is the join screen instead (`JoinLanding`, which paints its
own wordmark — the topbar is for joined singers only). `JoinLanding` is imported on demand there, so a joined phone
never downloads the join screen's CSS (about 1.8 KB gz, CLAIM 13). Joined, it is the Spotlight, with Your songs under it
while the box is empty and the result groups once it is not. The rotation and the library rows it used to carry are the other two tabs now.

**A search survives a trip to another tab (#1245).** Since Queue holds pause and skip, a host often leaves Sing
halfway through a search. On unmount the page keeps its text, its three result groups, the widen and a failure in
module scope (`$lib/sing-search-keep.ts`), and the next mount starts from them, so the same rows show with no new
`/api/search`. A search still in the air (or inside its 150 ms debounce) when the tab was left starts as searching
and is asked again once on the way back, because no answer was kept. Only the same singer, under the same
`?source=`, gets it back; with no one joined nothing is kept, so a shared phone never hands one singer's search to
the next. A reload starts clean. Rows the room deleted meanwhile drop out through the same catalog check as a live answer.

**The Spotlight is Sing's one lit surface (redesign step 3), and it is the field alone**, as in the owner-picked
prototype: `<Spotlight>` at `idle` around the search field, about 60 px tall. Its title, `What do you want to sing?`,
names the region but is not drawn, so the results start right under it (about five rows above the dock at 320). Its
accent ring is the field's boundary, and on focus that ring becomes the focus ring: one ring, not two. The promise line
sits under it only with an empty box. The old idle block (a mark, a title, a promise and a second `Search for a song`
button) said the same thing three ways. The rows under it are `SongRow flat`:

- no card and no thumbnail (an owner ruling: fewer bytes and decodes per keystroke); the duration joins the byline;
- one title line and one meta line (64 px): the chips are toned words on the byline's own line, not pills;
- a hairline between rows, and title and byline wrap instead of ellipsising, so nothing is cut at 320 (G2);
- the action is an outlined circle, so the Spotlight's accent ring is the screen's one accent; queued is the accent
  outline with a check.

The group headings are dim sentence case, not uppercase eyebrows. While a search is out, nothing shows for
`PENDING_GRACE_MS`; past it, flat skeleton rows stand in, and the rows replace them the moment the answer lands: there
is no minimum hold, because holding content behind an indicator is a new wait (#1091, `sing-slow-search`). The field
has no spinner of its own (#1126). The zero-state speaks only for the text a search has answered (`answeredFor`), so
text still waiting on the 150 ms debounce never reads "Nothing matches" (#1192).

**Your songs (proposal 36) sit under the empty box**: up to `YOUR_SONGS_SHOWN` (12) `SongRow flat` rows under one
`Your songs` heading, from `GET /api/me/songs` (`$lib/your-songs.ts`). Each row's byline says what is not zero:
`2 keys down · guide low · sung 3 times`, or `saved`. Its `+` queues the song in the key and guide of your last
finished turn of it, ahead of this phone's remembered key; a song not made yet carries the usual ✦. A guest Keep me is
offered to gets one dim line under the list: `On this phone only. Keep <name> to have them on any phone.` Someone with
nothing yet sees the box exactly as before, with no heading and no explainer. The list is fetched once you have joined
and cached for the tab under that singer's id (like the kept search), so a return paints it at once and a Leave
followed by someone else's join never shows them the last singer's list; it is the last thing on the idle screen, so arriving after first
paint moves nothing (`your-songs` probe, CLS 0 at 390 and 320). A search kept across a trip to Queue (#1259) comes back
with its results, so Your songs waits until the box is cleared. Rows are drawn from the room's catalog only, so a song
the room refuses as deleted (`#songGone`) leaves the list with its one notice. A save whose song left the library is not
listed yet ("needs making" is PR 3).

`searchActive` (a non-empty query) is still the SOLE switch, between the empty box (with Your songs) and the results. There is
still no browse mode on this column, no `?browse=1` and no history entry for a search, so Back always means leave the
room — and clearing the field lands on the empty box rather than restoring a second view.

With a query, in order: `Making karaoke…`, `Ready to sing`, `Needs karaoke`, `Can't make this one right now` /
`Can't make these right now`, the widen escape hatch, then at most one zero-state. Every heading is gated on having
rows, because a group heading is a claim about what follows it.

**What can be made now decides the last two groups (proposal 24).** An unmade or failed row whose song nothing
connected can make goes to `Can't make…`, with no button: `makeableNow` reads the room's `canMake` and `canFetch`
(`queue:sync`) and asks `needsFetch` per source, so a library upload needs only a maker and a search result also
needs a fetcher. The row keeps the button's empty box, so a maker dropping mid-search shifts nothing. With no ready
match, `See all ready songs` (a link to `/library`) comes LAST, after the `Can't make…` rows and the widen: arriving
mid-search it must push nothing from under a thumb on its way to Sing. The idle line `Find any song and we'll make
the karaoke track for it.` needs both verdicts, because it promises search results; an uploads-only box reads `Only
ready songs can play right now.` although its unready uploads still offer Sing, which is rare and intended. That line
sits in the Spotlight under the field, so it stays true while you search. The
escape hatch (`Not it? Search everything`) is deliberately NOT gated on an empty result: YouTube Music's `songs`
filter never returns nothing, so a widen offered only inside the zero-state would be unreachable exactly when it is
needed. The zero-state's way out is a LINK to `/library` printing the library count, not a `clearSearch()` — clearing
would land on the Spotlight alone, which shows no songs, so the old label promised what the tap no longer delivers. **Any
surface that prints a count prints its noun in agreement**: this label shipped as `Show my 1 songs` on a one-ready
library — the ordinary state the first time a song finishes processing — while `/library`'s own count line, one tap
away, read `1 song`. `showAllCount` carries a bare number, so agreement is the caller's to supply.

**EACH RESULT GROUP IS WINDOWED, and the window is a DOOR rather than a cap.** `/` imports `LIBRARY_PAGE` (60) and
`libraryWindow` from `library-browse.ts` — the same arithmetic and the same `Show N more` + `N left` control
`/library` ships — and gives each of the four groups its OWN counter, because one shared counter would let a long
`Needs karaoke` tail decide how many ready songs a guest can see. Nothing is unreachable: /api/search still answers
with every hit, every row it sent is behind a tap, and the group headings, the widen gate and the zero-state keep
reading the FULL lists. That last clause is the trap, not a detail — `accountedFor`/`unaccounted` decide which group
OWNS a song and `showsNoRows` decides whether the search found anything at all, so pointing either at `.shown` would
make a 200-row answer whose first sixty happened to be ready print `Nothing matches “…”` under sixty visible rows.
The windows reset in `clearResults()` and only there, which is the seam where all four groups are already dropped:
reset on the keystroke instead and a guest watches revealed rows collapse before the next answer exists. WHY: only
the resolvers are bounded (`PER_SOURCE_LIMIT = 12`); `partitionSearch`'s catalog arm walks the whole persisted
catalog, and /api/search materialises AND persists every hit, so this column was sized by the install's LIFETIME
catalog rather than by the query. Measured at 390×844 against one server, windowed and not, on a copy past 3,700
media — and every reading drifts a little between runs, which is the same defect talking: `q=a` went from
3,412 rows / 56,260 DOM nodes / 320,120px — with the widen hatch at y=319,949, 379 viewports down — and 1,235ms for
the first `+` to read `queued`, to 120 rows / ~2,030 nodes / ~12,500px / 53ms with the hatch at y≈12,350. A 68-row
query (`wonderwall`) is unchanged at 1,230 nodes and 7,280px, confirms its tap in 47ms on the same server, and
paints no door at all, which is what makes that 1,235ms the column rather than the queue round-trip. The payload is
NOT touched and is a separate decision for the owner: `q=a` is still a 1,058,948-byte body for one debounced
keystroke, and it grows with the catalog it persists.

The Spotlight's title names this tab's job (`What do you want to sing?`), and it is deliberately not `Nothing queued
yet`: that is false on the Sing tab and is word for word `/queue`'s own idle headline. No `/library` link with an empty
box: the Library tab is in the dock at the foot of the screen already.

**The processing group is SEARCH-SCOPED, and that is the one behavioural ruling in the rebuild.** With a query, the
server has already scoped `j.processing` to it, so each row is a RESULT — the row that tells a guest "this one is
already being made" and stops a second tap on the app's one compound action. Without a query there is no group at
all: `processingRows` returns `[]` before it calls anything, because the alternative is a statement about the LIBRARY,
and `/queue` now draws every queued song still cooking; since `processAndQueue` always adds the turn alongside the
process, a processing song is in practice always a queued song. `processingGroupIds` in `src/lib/readiness.ts` USED TO
take the live status map, the whole catalog and a classifier and union them in that no-query case; with its only
caller short-circuiting first, that branch was unreachable and those three arguments unreadable, so the branch, the
arguments and the two unit tests that pinned it are **gone** — the function now takes the wire's `processing` list
alone, which makes the search-scoping a property of its signature rather than of a branch. Deleting the group
outright was rejected because two
consumers would break silently: `showsNoRows` takes `processingCount`, so a query returning twelve cooking hits would
print "Nothing matches"; and `unaccounted()` subtracts the processing ids, so a mid-process hit the server returned in
its separate `processing` list would be subtracted and rendered nowhere at all. What the scoping trades away, recorded
because it is real: a media processing with NO queue entry (an admin-side process, or an entry removed mid-cook) is
visible only while a query matches it, because `/library` serves `listReady()` and paints every row ready. That is a
`/library` gap, not a Sing-tab one.

Two rulings make the wide column a layout rather than a stretched phone. **The field carries
`max-width: var(--measure-prose)`** on both `/` and `/library` — unconditionally, because a `max-width` only ever
takes space back. At 1440×900 the uncapped slot would be ~884px of caret to chase, well over a measure,
with the placeholder adrift from the mark that labels it. `/library`'s twin is capped the same way at 768 (696 → 560)
but from `--bp-lg` up it is bounded by the ROW GRID instead — see the library page's wide head.

**And from `--bp-md` the topbar carries a `--line` bottom rule** with `padding-bottom: var(--space-lg)`: the
bounded-band form of the header surface every `PageHeader` route already wears, without the pill's fill,
which are earned by being sticky. The rule deliberately spans the shell's content box rather than the rows' column,
so it reads as page structure and not as a row boundary. The wide gap between the wordmark and the identity cluster
is NOT closed: leading brand / trailing account is a desktop header form, the cluster on the far edge leaves the way
into `/settings` in the same corner every other route puts it, and the hairline is what makes that split read as the
two ends of one surface rather than as two things floating in page. `PageHeader` is not the precedent for it — that
component left-packs `.back-slot` then `h1` with `gap: var(--space-md)` and has no trailing slot. Nor is the gap a
constant: `.me-cluster` packs to the far edge, so its size is a function of the singer's display name — measured
80px at 390×844 and 770px at 1440×900 with the eight-character name `Theodora`. The name is part of the reading: a
narrower eight characters opens the gap further, so a figure quoted without its name cannot be reproduced.

**The find row is the field alone.** It used to share the row with a scope picker (Music / Everything / YouTube /
Library), which proposal 21 removed: its choices returned the same rows, "Library" meant everything anyone had
searched for, and it had no label on screen. `Not it? Search everything` under the results is the one way wider, and
it lasts for the query it was tapped on — the next keystroke or a clear goes back to the default. The narrowing
filter is still reachable off-screen as `/?source=<source>`, which the page passes through to `/api/search`; the gate
specs load `/?source=local` so their first row is the seeded fixture. The field's leading edge sits on 212 at
1440×900, where every row, eyebrow and empty state below it starts, and the measure cap keeps it at 560.

**The wide-viewport void, re-measured on the corpus this tree runs on.** A desktop pixel reading of this page is
worthless without the catalog it was taken against, and a READY row is the rare thing in every catalog here:
`/library` serves `listReady()` only, `data/encore.sqlite` holds 384 media rows of which 5 are
`stem_status='ready'`, and the `Encore-ui` copy the readings below were taken against holds 180 of which 2 are. (The
figure in this paragraph was 123 rows and 2 ready when the shelf measurements were taken; it moves every time
somebody uses the app, which is the reason the claim is dated to a catalog rather than stated flat.) The SUPERSEDED
reading, kept so the before and after are both checkable: with a library shelf and an empty rotation on this page and
two ready songs behind them, the column's last content ended at y=403.4 against a band top of 835 — **431.6px** of
void — and the design review's ~460px sat just above that. That band top is a reading from the tree it was taken
on and is no longer re-derivable: `NowPlayingBand` is deleted, and a later reading of the same chrome put its top
at 813. Both blocks are gone. At 1440×900 with no query the Sing tab is a find row and the idle block: the block is
`min-height: 32vh` (288px), starts at y=173 and ends at y=461, and what separates it from the chrome depends on
which dock is up. With something playing or queued the dock is 91px, its top edge 809, and **348px** separate them;
in an idle ROOM the strip does not render, the dock is 46px, its top edge 854, and the gap is **393px** — the
larger of the two, and the one to quote for a room nobody has used yet. That residue is a CONTENT bound and
nothing further is owed, which is the conclusion the old arithmetic reached for the old layout too: this is a tab
whose whole job is "type a name", and there is nothing to place in the gap. The one candidate was built and measured
before being rejected — handing the old empty rotation the leftover height (`min-height: 30vh` at `--bp-lg`) MOVED the
void instead of removing it, growing one block to 270px of centred emptiness with 223.6px still below it.

Left alone, on arithmetic rather than taste: the dock's title-to-transport gap, which the design review put at
~1000px. The strip's `.meta` measures 906px at 1440×900 and it is the `nowrap`/`ellipsis` title's OWN box, so a long
title uses it — the same refutation that file applies to tablet rows.

### The library page

`/library` is browsing, and it exists because the home column could not be it: the shelf above sat under an
unbounded queue, and the home field cannot stand in for a library because it FETCHES from three resolvers and
needs a name you already know. Browsing is for when you do not.

**It is the LIBRARY TAB, and it carries NO back arrow.** The arrow it used to carry named the queue in its
accessible label while its href pointed at `/`, which is the Sing tab — and a back arrow on a tab ROOT is wrong
in kind regardless of destination, because tabs are siblings and the dock is the way between them. `PageHeader`'s
own case for `back` is that a home-screen install with no back gesture still has an in-app exit; the tab bar
supplies three. Measured at 390×844 on the 2-ready catalog: the `PageHeader` pill goes 64px to 41px — the 44px
icon box was setting its height — and the whole head rises a uniform 23px, field 102→172 becoming 79→149, the
count 180→196 becoming 157→173, the disclosure 206→250 becoming 183→227 and the first song row 250 becoming 227,
identically at 768×900. Two counter-numbers are recorded rather than buried: 23px is not a row (the pitch is
102.4px, a 94.4px row plus the 8px gap), and on a 2-song catalog nothing scrolls, so the void between the last
row and the dock GROWS 306.1 → 329.1px. What the removal buys is the deletion of a false affordance, plus the
title's leading edge, which moves x=86 → x=32 where `.field-slot` and every `.row` already start — with the
arrow, the h1 was the only thing on the page beginning anywhere else. THE HEADER ITSELF STAYS: measured, it costs
73px of 844 without the arrow against 96 with it and 0 with no header at all, and it holds the route's only h1 on
a sticky surface, so deleting it would leave the page named only by a 0.75rem tab label 46px tall at the far end
of the screen.

**What "your library" is.** The READY catalog — `MediaRepository.listReady()`, served by `/api/library` and
mirrored whole in `room.library`. It is NOT the `local` resolver, which searches audio FILES in the media
directory: a processed YouTube song is in the library and absent from that list, so `/api/search?source=local`
answers a different question and must not back this page.

**The filter is a filter, not a search.** `browseLibrary` in `src/lib/library-browse.ts` narrows rows already in
memory, with no request — `room.library` mirrors the whole ready list to every surface. That is
also the one thing keeping the two fields distinguishable, so the page STATES it: the `N of M songs` count line
is the only element that says this box hides rows rather than fetching them. Two fields that looked alike and did
opposite things would be a worse problem than the reachability one this page fixes.

**Costing nothing is not the same as costing nothing to render.** The filter is debounced 150ms — the home field's
number exactly — and the list renders `LIBRARY_PAGE` (60) rows at a time behind a `Show N more` control. Measured at
390×844 under a 4× CPU throttle with 2000 ready songs: the full list was 40,125 DOM nodes and 4.6s before the first
row was usable, the first two letters of a query blocked the main thread for 634ms and 427ms, and the backspace that
widened the list again blocked it for 3.4s; one page is 1,328 nodes and 0.9s, with keystrokes at 85ms then ~31ms. The
debounce holds `appliedQuery`, never `query`, so the box still echoes instantly and only the rows wait, and
both clear handlers cancel the pending timer first or a cleared filter re-applies itself 150ms later. There are TWO
of them, on two scopes, and that is the fix for an X that reached outside its own field: `clearQuery` is the field's,
and it clears the TEXT only, while `clearFilters` is the filtered-to-nothing state's and clears the text and the
facet chips (not `sort`, which is why that control is not labelled "Clear filters"). The field's X is gated on
`boxHasText` — the live `query` alone, so it still appears on keystroke 1 rather than 150ms after the last one, and
no longer appears over a visibly EMPTY box whenever a chip is picked. Wired to `clearFilters` with the facets in its
gate, one tap to undo a typo took the picked artist with it — the count going from "1 of 135 songs" back to the whole
"135 songs" — and the only cue was the eyebrow falling back from "Sort & filter · <artist>" to "Sort & filter", which
is a line of chrome under the field and may be scrolled past. `/`'s twin field has always passed its
query alone (`clearable={searchActive}`), so this is the two callers agreeing again rather than a new idiom. The window is a DOOR
and never a cap — this page is the only place every ready song is reachable now that the home shelf is gone, so a row
it would not show is a song you own with nowhere left to reach it — and it resets to one page WITH THE ROWS rather than with the keystroke, so a
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
collapsed head reads out identically at 390×844 and 768×900 — field 79→149, count 157→173, disclosure 183→227,
first row 227.

EVERY 1440×900 y IN THE PARAGRAPH ABOVE IS AN ARROW-ERA READING, kept because the pre-arm layout is no longer
reproducible and that before/after pair is the only statement of what the arm did. Dropping the header's back
arrow then lifted the whole column 23px, so today the same drive reads `main` 73, field 79→149 at 212→712, the
count at x=732 and y 79→95, the disclosure at x=728 and y 105→149, the two rows 157→251.4 side by side at 212→712
and 728→1228, the panel 149→323, and the first expanded row 331. Nothing the arm is ABOUT moved: the field is
still 500 wide over the first row's own 212→712, the disclosure still on the second row's leading edge at 728,
the count still 4px inboard at 732, the panel still 500 wide at 728→1228 and still 174px tall.

Two consequences are stated rather than hidden. The field's `--measure-prose` cap goes INERT at these widths,
because track one is 500px against a 560px cap — the grid bounds the field, and 500 is the song row's own width,
so the field's two edges land on the first row's two edges (212→712) instead of overhanging its trailing edge by
60px on one side and stopping 456px short of the column on the other. And lifting the head pushes the trailing
space DOWN rather than away: re-measured in a browser on the 2-ready catalog at 1440×900 with the strip up, the
last `.row` ended at 274.4 and `.dock` starts at 809, so the gap was **534.6px** while the first row sat at y=180
— against y=309 for the same two songs on `/`. That is the improvement and the residue in one reading: the songs
moved 129px closer to the top, and the space they vacated reappeared underneath them. After the back arrow went,
both numbers moved by the same 23px and the gap is **557.6px** (809 − 251.4) with the strip up, **602.6px**
(854 − 251.4) in an idle room, which is the same residue read one lift higher.

That gap figure has now been wrong three times, in three different ways, and all three are recorded because the
lesson is the point. An early revision put it at 560.6px, derived as a 70px lift on a 490.6px base rather than
measured; the tree read 538.6, so the two could not both be right. Then the chrome changed under the corrected
number: 813 was `.band-slot`'s top and the dock's with the strip up is 809, so the same 274.4 row bottom gives
534.6 and not 538.6. Then the chrome acquired a SECOND height and the number was published without its room
state, which is the ambiguity the dock section now names: the band rendered for anyone who had joined, the strip
renders only for a room with something to act on, so the one figure the band needed became two. Arithmetic
standing in for a measurement, a measurement outliving the thing it was taken against, and a measurement that
never said which state it was taken in. A number in prose is only as good as its last re-measurement, which is
why this page's numbers are pinned in tests wherever a test can hold them.

NOT FIXABLE BY LAYOUT, and stated so nobody tries again: two rows cannot fill the 736px between this page's
`main` at y=73 and a dock whose strip is up at 809 — 781px when the room is idle and the dock is 46px — however
they are placed. The residual desktop void at low content is a CONTENT bound, not a composition one, and no
`max-width`, `margin` or grid change touches it.

Do NOT read the catalog's size as reassurance that the void closes on its own. What stands against those 2 `ready`
rows is a far larger body of STEM-LESS ones, and their total is deliberately not quoted here — the same choice the
route comment makes, for the same reason it gives: the total accumulates every search result ever materialised and
drifts whenever a benchmark runs. An earlier draft of this paragraph did quote a flat figure, and it was stale
before the ink dried: it disagreed with the dated reading in this page's own home-page section above, which is why
that section states a catalog and a date rather than a bare number. The owner confirmed (2026-10-03) that the
stem-less rows are **benchmarking junk, not a processing backlog** — so they will never become library members and
the gap they appear to promise does not exist. A SMALL READY LIBRARY IS THE REAL STEADY STATE for this page, not a
transitional one, which makes the low-content composition the case to design for rather than the case to wait out.

**Sort & filter is collapsed by default, and that is the page's main design decision.** Expanded, the chip rows
are ~420px of chrome on a nine-song library and put the first song row near y=650 on a 390×844 phone — the exact
fault this route exists to fix, relocated. Scrolling songs is the default state. Opening it by default at
`--bp-lg`, where the panel has its own track and the page has unused height, was considered and rejected on
arithmetic: this tree's two-song library opens to 174px (149→323) in that track, but `FACET_CHIP_LIMIT` allows
twelve artist chips and twelve tag chips in one 500px track, so a full library's panel can exceed the 736px the
page has with the strip up — the tighter of the dock's two budgets, which is the one a worst case has to clear —
and would put the first row back under the dock, the same fault at a different width. 174px is the WIDE
reading only: the SAME panel at 390×844 measures 202px (243→445) and puts the first song row at y=453, because the
phone's narrower track wraps the chips further, and the phone is the case the collapse is for. The trigger names the active
facet (`Sort & filter · Queen`) because the panel showing the pressed chip may be shut, and without it a guest
reads `2 of 9 songs` as the page having lost their songs. It is the first caller of the `eyebrow` button variant,
which was missing `bg-transparent` and so rendered as a grey `buttonface` slab — see the note on that variant.

`newest` sorts on `id` descending, which is genuinely time descending because a media id is a ULID whose first
ten characters are a base32 millisecond clock; it is the time the row was MATERIALISED by a search, not the time
its stems finished. Ordering is applied explicitly rather than trusting `listReady()`'s own
`orderBy(desc(media.id))`, so this page's order is not an undocumented side effect of a server query.

**The empty library hides the filter field.** A filter over zero rows is dead chrome: measured on a 0-ready
catalog at 390×844, `.field-slot` painted 102→172 directly above "No karaoke tracks yet", offering to narrow a
list with nothing in it. The field is kept mounted while `libraryLoaded` is false, so in the common case it is
there from the first frame rather than appearing late. The description names the SING tab — it used to say
"Search from the queue screen", which named a surface that no longer exists under that name, since `/` is the Sing
tab and the queue is its own route. The `Find a song` button STAYS, because `/queue`'s twin empty state carries one
too and two sibling tabs disagreeing about whether an empty state offers an action is exactly the incoherence the
tab rebuild is removing; it is also free either way, `min-height: 40vh` measuring `.lib-empty` at 337.6px on an
844px viewport with the button and 337.6px with it taken out of the live DOM. This is the state where the dock is
THINNEST: with no ready song nothing can be playing, so the strip's `hasSong || canStart` gate keeps it off the
page and `--dock-h` measures 46px — the tab bar alone. That is why the description has to name the tab in words.

Adding a song does NOT navigate: you came here to pick, and picking two is normal. The toast no longer offers
`View queue` either. That action was labelled for the queue and landed on `/`, the Sing tab, and it was the app's
one direct `window.location` write — every other programmatic navigation under `src/` goes through `goto`, and the
rest are real anchors. Driven in a browser, clicking it recorded two main-frame navigations and
wiped a sentinel set on `window`, so it was a full document replacement: the socket closed, `/api/library`
re-fetched and the shell re-parsed to cross one tab. The dock carries a Queue tab on every surface now, so the
toast names the destination in its text instead. Unjoined, the route renders `JoinLanding`
exactly as `/` does — `refreshLibrary` never runs for a guest, so there would be nothing to browse.

**It takes TWO flags on the room link to keep a full library from being called empty, not one.** `libraryLoaded`
separates "not fetched yet" from "the fetch returned", which is what stops the empty copy painting for one frame
before the first response. `libraryFailed` separates "you own nothing" from "we could not ask", and it is the one
that was missing: `refreshLibrary` swallowed its error, never checked `res.ok`, and set `libraryLoaded` in
`finally` regardless, so `library: []` + loaded was the tuple a DEAD request produced too. Driven at 390×844 over
a 135-song library with `**/api/library*` aborted once, that rendered "No karaoke tracks yet", zero rows, no
filter field and no disclosure — while the dock was simultaneously playing "Gucci Flip Flops", a track from the
library the page called empty — with no error word anywhere and no toast. And it was permanent for the session:
the only fetch is `connect()`'s, which is guarded idempotent, so a tab tap re-attempted nothing and only a reload
cleared it. /library now carries a third arm ABOVE the empty one, gated on `libraryFailed && library.length === 0`
— description plus a `Try again`, the register `/`'s own search-failure arm uses — and its `onMount` re-attempts
when it arrives with the flag already set, so a later tab tap repairs a blip that happened at join. The
`library.length === 0` term is load-bearing: `refreshLibrary` also runs on every `media:status` ready event, and
one of those failing must never replace a shelf of working rows with an apology.

**A song row announces the stage it CHANGED INTO, never the stage it was born in.** SongRow's clipped
`role="status"` exists so a row that finishes processing says so once, and it was gated on the stage merely
existing. Every /library row is handed `readiness="ready"` and can never transition, so the route mounted one
polite region per rendered row, all reading "Karaoke ready" — and every one of them was a DYNAMIC insertion,
which is the condition under which AT may speak: measured on a 135-song library at 390×844 with 60 rows on
arrival, a `MutationObserver` armed before the tab tap counted 63 `role=status` insertions against 3 removals
(the same drive now counts 3 and 3). Because `.vh` is clip-based rather than `display: none`, each region also
stayed in the accessibility tree beside the visible pill, so the string was in the tree twice per row. The region
is now gated on the current stage differing from a non-reactive `bornStage` captured at init with `untrack`:
/library arrives with zero regions reading "Karaoke ready" at either row count, Chrome's full AX tree names it
270 times with all 135 rows revealed (two nodes per row — the pill's container and its text — where the duplicate
doubled that), `innerText` holds it 135 times rather than twice per row, and the visible pill is still on every
row. The announcement it was written for
is unaffected — driven on `/`, a "Needs karaoke" row carries no region and one tap on its sing action inserts one
reading "Making karaoke…" — and the one case deliberately given up is a row that mounts already failed, whose
visible chip still says so.

**Manage is the host's, and a guest sees none of it.** The page asks `/api/host` once per page load
(`src/lib/stores/host.ts`, which `/host` clears on unlock and sign-out); only a host gets the quiet `Manage`
control beside the count. Manage swaps each `SongRow` for a `ManageRow`
(`src/lib/components/ManageRow.svelte`): title, artist (and `Kept`) and the song's size, with no `+`. The count
line becomes the storage line, "214 songs · 12.4 GB of 20 GB" ("…, over the 20 GB cap" past it), with a thin bar
when a cap is set and "Kept songs use X of Y GB" past 90% of it. Sort gains `Biggest` and `Least sung`, which
leave with Manage. Tapping a row opens its sheet in place: Name and artist (Change), Lyrics (Fix, the song page),
Sound (Make again), Keep on this machine, and Delete. Make again says "Making the sound again" ("… after its turn"
for a song in tonight's queue), and that the old sound plays until the new one is in. While the song's last
remake has failed, a warn line under Sound says so, with the reason. A song in tonight's queue says "In tonight's queue. Delete it after its turn."
instead, and a kept one says to turn Keep off. Delete has no dialog: the row goes, and a 10 s toast offers Undo.
Deleting the last song shows the empty Library; the toast's Undo still brings it back.
**Bulk (PR 2):** each row has a checkbox, and `Select all` beside `Done` picks the whole filtered match list, not
only the rows rendered so far. While songs are picked, an action bar above the dock is the screen's one fill:
"N picked", `Keep` (`Keep off` when every pick is kept) and `Delete`. The bar sits one layer under "You're up"
and "Your song didn't play", at their offset above the dock, so a turn covers it with no edge showing. A filter
change drops the picks, so a Delete never reaches a song out of view. Keep gives no toast, because one would cover
the bar; its "N songs kept" goes to the live region, which stays mounted for all of Manage. Delete clears the picks
so its "N songs deleted · Undo" toast is the only thing in that spot, and says how many stayed (kept, or in
tonight's queue) and how many were already gone. After Delete and after Undo, once the rows are re-read, focus
moves to `Select all`; to `Done` when no rows are left to select; and to the empty screen's `Find a song` when the
whole library is gone, because the control that had it is gone. A burst of `media:status ready` (a bulk Undo)
costs each phone at most two Library reads, not one per song (`#rereadLibrary` in `room.ts`). Bulk Remake waits
for PR 3's Make it again. The sizes,
plays and Keep come from `GET /api/library/sizes`, fetched only when Manage opens. The server side is
`docs/SERVER.md#managing-the-library`. This is PR 1 of proposal 33. The proposal's own screens wait for the
Spotlight Library step (#1159), so this UI stays minimal.

### The join screen

`src/lib/components/JoinLanding.svelte` is the UNJOINED state of all three phone TABS, not a route of its own. It has TWO PANES,
and which one is on screen is DERIVED from the resolved room preview rather than from a hand-advanced counter, so
no state can show an identity pane for a room that was never confirmed. Step 1 is the CODE pane, a FALLBACK
reached only by a guest with no code in the URL or whose scanned code did not resolve. Step 2 is the IDENTITY
pane — the room confirmed IN WORDS, the name field, the colour, the CTA — and the only pane a guest who
scanned the television's QR ever sees. The room has no NAME in the schema, so "confirmed in words" is who is
here, from the room-preview endpoint. While that lookup is out, its `role="status"` line is in the accessibility tree
from the first frame, holding the sentence's box with an unseen spinner, and "Finding the room…" is written into it
only past `PENDING_GRACE_MS` (300 ms). So a quick room never flickers it, a slow one still says so, and a screen
reader hears the words as an addition to a region it already knows (#1089, #1328). The sentence that replaces it is
never held back for it (#1171).

**Both panes are one Spotlight card** (redesign step 7, #1157): the idle look (the raise surface ringed in the
accent, then in the colour you will sing in), drawn inline rather than with `<Spotlight>` for the CSS reason under
"A kept phone" below. The code, then the name, fill the same card, and the CTA is the card's last row, right under
the field it acts on. It is `position: sticky; bottom: 0` on the card's own fill, so with the keyboard up (which
`app.html`'s `interactive-widget=resizes-content` turns into a shorter layout viewport) it rides just above the
keyboard: at 320x568 the keyboard leaves 308 px, and without the rule the button sat 60-118 px below it.
`join-keyboard-reach` holds it fully on screen at 320x308. Start singing is filled in your colour, inked in
that stop's certified `on_fill`. **The colour waits behind "change"**: a row reads "Your color Aqua · change" and
opens the ring in a modal `<dialog>` with a Done button, on its own surface (`--card2`, one step above the card) over
a `--scrim-strong` backdrop, so picking moves nothing on the page and the ring no longer
outsizes the name field. The dialog and its ring mount on the first "change", not with the card, so the QR's first
render to the name field pays nothing for them (#1320; `join-ring-lazy` holds it). The colour is a suggestion until the ring is touched, and an untouched one is never sent.

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
`--bp-md` the gate fills its host; from 768 up `.app-shell:has(.join-main)` centres a 420px column. Because the gate has two hosts, the host is NEUTRALISED rather than trusted —
`:global(.app-shell > main:has(.join-main))` makes it a flex column, zeroes its route padding, and at 768 up
takes away its `flex: 1` so the centring has free space to distribute. Without that last declaration the same
gate measured y=6 on `/` and y=263 on `/library` at 1024x900, because `main { flex: 1 }` grew to the whole shell
and left nothing to centre. The `.app-shell >` anchor is for SPECIFICITY, not reach: the route's scoped `main`
rule ties a bare `main:has(.join-main)` at 0,1,1 and its chunk loads later, so the route would win. No route may
state the gate's alignment, padding or measure. (Until redesign step 7 the CTA docked to the screen's bottom edge,
far from the boxes it acts on; it is in the card now.)

THE RESTING PLACEMENT, THOUGH, IS A GATE — `tests/playwright/specs/gate/measured-join-gate.spec.ts`, CLAIM 7, leg
7 of `bun run gates`. It drives both hosts at five widths and holds the brand band's top, the gutter and the CTA's
bottom edge identical between them; from `--bp-md` up it also holds the free space above the gate equal to the free
space below it ON EACH HOST, below `--bp-md` it holds the band at the shell's content top, and at every width it
holds the CTA as the join card's last row (its own bottom inset off the card's bottom) and on screen. The absolute half is there because equality is blind to a break both hosts share:
with `justify-content: center` deleted the two routes agree perfectly on a top-aligned gate and all three deltas
stay at zero. Two of its five widths are 767 and 768, and it reads `--bp-md` off `:root`, which makes it the one
place in this tree where a media literal is checked against the token it is supposed to be. It reads the host's
resolved `display`, `padding` and `flex-grow` back as well, because a specificity argument that is only asserted is
not checked — with the neutralising rule deleted the host resolves `display: block` below `--bp-md` and `grid`
above it, with `padding: 6px 16px 28px` back. Measured while it ran: `.join-head` at y=262.58 at 768 and at 1024
wide, y=352.58 at 1920x1080 — digits the arms DERIVE rather
than pin, so a spacing rung can still move them with nothing red. What cannot happen again is the two hosts
drifting apart.

**A kept phone is welcomed back** (proposal 30, PR 2). When the room preview carries `returning`, the identity
card swaps the name field and the colour row for its one heading "Welcome back, Theo" at the Spotlight title size,
ringed in the person's colour, so it cannot read as a field to type in. The card is drawn inline rather than with
`<Spotlight>`: this screen also renders on `/queue`, which does not otherwise ship Spotlight's
stylesheet, and importing it there costs about 750 B gz of CSS against 170 B of headroom (#1198). The one CTA,
Start singing, joins with `returning: true`. Arriving there costs no extra request: the
preview already answers it, so nothing flashes a name field first. "I'm someone else" (a borrowed phone) drops to
the normal pane for this visit and leaves the phone's device cookie alone. A 409 (someone here holds the kept name)
shows the name field, still as the same person; a 401 (the phone is no longer kept) falls back to the normal
pane with the reason. See docs/SERVER.md#kept-people.

Finally `.confirm`, `.err` and `.cta-reason` stay
ordinary elements rather than Field primitives: `tests/playwright/world/selectors.ts` addresses `.err` as a class on the
alerting element and a class handed to a component carries no scoped rule; `.confirm` is the scanned path's
headline and the primitive would dim and shrink it; `.cta-reason` is never painted, only announced, and sits
outside the card so the card growing as the room resolves moves nothing that was already there.

### Settings

Settings is THREE SCOPES AND THREE ROUTES — You (one person, `/settings/you`), The party (this room, `/settings`)
and This machine (this server and its worker fleet, `/settings/server`). The in-page tablist is gone, and that is
the point: the phone has a persistent tab bar at the bottom of every surface, so a second row of tabs inside a page
is a navigation that is not one. The scope is now a property of the ADDRESS, of the page's heading, and of every
card header.

`/settings` IS the room scope, not an index over the three. The gear in the Sing tab's topbar is the door a host
reaches for mid-party, so it stays ONE tap; an index would spend that tap teaching a model each destination states
in its own heading on arrival. It is also the parent `/settings/server`'s back arrow names, and the path five unit
guards resolve by name.

The scope list has ONE home, `src/lib/settings-scopes.ts` — `{ label, blastRadius, href }` per scope, KEYED rather
than ordered, because nothing renders the three in a row any more. `blastRadius` carries no terminal stop: the same
string is a sentence under the page heading ("Everyone in this room.") and an uppercase eyebrow on the You
scope's cards ("ONLY YOU SEE THIS"), and a stop reads as a typo in the second register. `?tab=`, `settingsTabFromParam`,
`DEFAULT_SETTINGS_TAB` and `replaceState` all retired with the tablist. Back walks scopes now, which is what Back
is for once a scope is a page.

Each scope route loads FOR ITSELF, through `settingsSinger` in `src/lib/server/settings-gate.ts`, and there is
deliberately no `settings/+layout.server.ts`: a layout load does not re-run when a client-side navigation moves
between its children, so a hop from the room scope to the machine scope and back would re-mount against the
layout's stale snapshot and show a value the server no longer holds. A page load re-runs on every navigation and
costs one SQLite read on the same box. Each route then loads only what its own controls read — `me` for You,
`settings` for the room, `settings` plus the join-address fallback, the request scheme and the worker catalogue for
the machine — so the You scope no longer serialises a settings object and a model catalogue it never reads. The
gate builds its `?next=` from `url.pathname` + `url.search`, so a guest bounced to the join screen comes back to
the scope they asked for; `safeNextPath` on `/` is what keeps that from becoming an open redirect.

There is no socket here: every write is a per-field patch the server re-normalizes over current values, applied
optimistically and rolled back to `committed` (the last server-confirmed snapshot) if refused — never to an
intermediate drag frame, and only the fields THAT write sent, because restoring a whole pre-request snapshot
silently undid a concurrent success. That model lives in `src/lib/settings-writes.svelte.ts`, once, because two
scopes perform it; each route aliases `settings` off it so every control reads the name it always read.

`src/lib/ui/SettingsScope.svelte` is the shell all three wear: the heading and its scope line, the one destructive
Alert a refused write raises, the card grid, and the whole card-rhythm cascade. Those are properties of the
SURFACE rather than of a scope, and three copies of that cascade would be three places for it to drift.

The reactive grid, and its three measure tokens:

| Level       | Token            | Value here       | What it bounds                                              |
| ----------- | ---------------- | ---------------- | ----------------------------------------------------------- |
| page        | `--page-measure` | `--measure-grid` | the header and `main` share one width, so they align        |
| card column | `--settings-col` | `420px`          | the `minmax()` floor `.panel` pairs cards at                |
| row         | —                | none             | controls fill their card; no cap, or each card shows a void |

`.panel` is a grid, not a flex column: `repeat(auto-fit, minmax(min(100%, var(--settings-col)), 1fr))` spends extra
width on a SECOND COLUMN OF CARDS rather than on wider controls, and `auto-fit` collapses the empty track so one
column is the plain stack. `align-items: start` is required — `stretch` pads the shorter card out to its neighbour.
`--settings-col` is 420 and not `--measure-prose` (560) because two prose columns plus the gap need 1132, more than
the widest shell, so a prose threshold would never pair anything.

**852 IS A PANEL WIDTH, AND IT WAS READ HERE AS A VIEWPORT ONE.** At 420 plus the 12px column gap the panel pairs
from 852px OF PANEL, and a panel is `--max-w` less 64px (the shell's gutter plus this column's own inset, at every
width) — so pairing needs `--max-w` ≥ 916, which only the `--bp-lg` step to 1080 delivers. Measured on the live
panel, one track at a time: 256px at 320, 316 at 380 and 326 at 390 (viewport-bound, under the cap), then **416px
from 520 through 767**, 696px from 768 through 1199, and `502px 502px` from 1200. The step is at `--bp-md` and not at
`--bp-sm`: 416 at 520 is the same `--max-w` 480 → 760 rung this document records for the findbox above, and an
earlier revision of this line claimed 696 at 520, which contradicted it. **No phone and no tablet in portrait ever
pairs**; the second column is desktop-only relief. Anything in a panel that is not a `[data-slot='card']` spans the
full row.

Card rhythm is fixed in the cascade, not by restructuring rows into `Field.Root` wrappers: the card gap is the
intra-group distance, and a label that FOLLOWS a control takes the inter-group distance back as a margin. A composed
control whose label is `.control-label` rather than a `[data-slot='field-label']` takes that margin on its WRAPPER
instead — `ColourRing`'s `.ring-field` — or the card draws one boundary two ways: 20px above a second `Field.Label` —
`card-content`'s 8px flex gap plus a `lg` margin — against 8px above the ring. The third margin, `.save-slot`'s on the
You scope, is the same rung for the same reason: a commit control is an inter-group boundary, not a section one.

**BOTH BASE RULES NAME TWO HOSTS**, `[data-slot='card-content']` and `[data-slot='collapsible-content']`, because the
machine scope's Collapsible spreads its own slot over the nested `Card.Content`'s literal — the same spread documented
below for the `hidden` attribute. Keyed on card-content alone, the whole cascade missed the three controls behind the
disclosure: measured, that column kept `Card.Content`'s vendored 24px `gap-6` against 8 everywhere else, rendering
36px between groups and 28px inside one. Naming both hosts took the open disclosure from 318.2px of content to 254.2.

**THE LADDER, RE-DERIVED AS RENDERED SIBLING DISTANCES** at 390x844 rather than as declared values, because an
earlier revision stated it as "8 inside a group, 20 between groups, 24 between cards" and the surface does not draw
that. `field-label.svelte` declares `margin: var(--space-lg) 0 var(--space-2xs)` on every field label in the app, so
the portrait `* + [data-slot='field-label']` rule re-declares a 12px that is already there — a no-op whose only job
is to buy the specificity the landscape claw-back needs — and a card's first label is NOT untouched: it carries that
same 12px, measured on all seven cards whose first child is a label. What renders is **12px inside a group** (the 8px
gap plus the label's own 4px `margin-bottom`), **14px** from a control to a `Field.Description` (8 plus its own 6),
**20px between groups** that lead with a label, `.ring-field` or `.save-slot`, and **24px card to card**. Sideways,
where the claw-back reaches `margin-top` only, it is 12 / 10 / 12 — so the landscape ladder is NOT monotone, a group
reading looser than the boundary between two groups. The one rung that would fix that is the 4px `margin-bottom`
inside `field-label.svelte`, which every surface in the app renders, so it is not a settings decision.

**AND AN INVERSION, RECORDED NOT FIXED.** Where the next group leads with a wrapper carrying no label of its own —
`.pair` or `.check` — nothing adds a margin and the boundary renders at the bare 8px gap, tighter than the 12px
inside a group. Four measured sites: `#sound` slider → `.check`, `#tv` `.pair` → `.check`, `#lyrics` `.pair` →
`.pair` and slider → `.pair`. It is the same defect the `.ring-field` arm exists to fix and wants the same shape of
fix — adding those wrappers to that arm — but it moves four rendered boundaries by 12px each and with them every card
height, scrollHeight, reach and co-visibility figure recorded below, so it wants its own measured pass.

**THE SCOPE MARK.** The You scope's cards carry `Card.Scope` inside their header, above the title: one line
naming who a change in that card reaches. The room and machine scopes DROPPED it (proposal 09): `SettingsScope`'s
sticky header states the same line on every scroll position, so five cards each repeating "EVERYONE IN THIS ROOM"
under it was the same words six times. The measurements below are the case that introduced the mark, under the
tablist, before the scope header was sticky. It is the SECTION register — `--ph-text-xs`, 0.14em, uppercase, weight
700, `--ink-dim` — which app.css reserves for a heading over a list or an eyebrow over a BLOCK, and a card is a
block; it is a sibling of `Card.Title` and never sits on or inside a `<Field.Label>` or a `.control-label`, which
was finding F7. It lives in `src/lib/components/ui/card/card-scope.svelte` because it is one dress read by three
routes, and because a utility class is only emitted for sources under `src/lib/components/ui/`.

It is there because of a measurement, not for decoration. Under the tablist, 0 of 17 field labels on the room panel
named their scope, and at the bottom of that panel the strip that named it was 1157px off-screen, the sticky header
read "Settings", the bottom TabBar lit no tab, and the one card title on screen read "Sound" — the distance from
the scope strip to `#guide-default` was 1614.8px. The mark makes the answer a property of the card the control is
in: measured at 390x844, the worst distance from a card's mark to the deepest control inside that card is 493px on
the room scope, 421.2px on the machine scope and 528.2px on You. That is a CEILING for every control rather than a
figure for the deepest one, and it is sufficient because co-visibility is provable: the tallest card is Making
karaoke at 640.2px against the 753px above the dock, so for every card there EXISTS a scroll position holding its
mark and all of its controls at once. The one exception, measured and recorded rather than hidden: at 320px the
Lyrics card is 857.6px, over that budget, so on the narrowest phone that card's mark can leave the screen before
its last slider arrives.

Every card also carries an `id`, so all ten are addressable. There is deliberately NO `scroll-margin-block-start`
yet: nothing in the tree links to a card fragment, and the offset needed is the sticky header's rendered bottom at
rest, which is content-driven rather than a rung — the first real fragment link should bring that number, measured,
with it.

CARD ORDER, and the one move that is not alphabetical. The room scope runs Turns, Sound, The TV, Lyrics on the
TV. Turns is first because it holds the one room setting changed mid-song (four code sites say
so). **Sound is second, up from last**, because `GuidingTrack.svelte` records that this room DEFAULT and `/queue`'s
per-turn override wear the same label in the same register, which makes it the control most likely to be
mis-scoped — and it was the deepest control on the deepest panel. Measured: `#guide-default` moves from an absolute
top of 1734.8 to 575.2, and from 1025.8px of scrolling to **zero**, at the same one tap from the Sing tab. **Quality
is Sound's last row**, not a card of its own: it was a separate "Sound quality" card above the door into the machine
scope, and two cards on one page cannot both be headed "Sound". That gives up the adjacency to what it caps
(`capAboveDefault` compares the room's `maxQualityRank` against the machine's `defaultEngine`/`defaultModel`), so the
`At or above the server default` line under the field is now the one place that relation is read. The machine scope runs Making karaoke, Lyrics engine, Joining, Re-processing. The
You scope runs Keep me (the offer, or the kept card), You, then Leaving.

**KEEP ME IS OFFERED, NEVER ASKED.** After a guest's first song (and never before), the You scope opens on one
ringed Spotlight in their colour, "Keep Ana for next time", with one Keep me button. It comes first so it sits above
the fold at 320x568, and it is never a modal and never interrupts. Once kept, the same slot holds a plain card, so
the tap's answer lands where the tap was: "Ana is kept on this phone", with "Sign out the other phone(s)"
when there are any and "Delete me" behind an `alertdialog`, which says what goes (name, colour, past nights, on
every phone) and that the guest stays in the room tonight. Each tap shows its outcome at once and rolls back with
one line on a refusal. A phone kept for someone else (borrowed) offers nothing. The now-line nudge the proposal
also names waits for the Spotlight now-line (#1171). Server rules: docs/SERVER.md#kept-people.

**THE TENTH CARD IS TITLED AND ITS DOOR IS REAL.** The Advanced disclosure wrapper used to be the one untitled
card, and a scope page cannot mark a card that has no heading to mark — it is `Re-processing` now, with
`role="heading" aria-level={2}` like the other ten. The disclosure itself did not work: measured closed, it
reported `aria-expanded="false"` and carried the `hidden` attribute while computing `display: flex` over 318.2px of
content (that figure is the 24px-gap column; the same state measures 254.2 now that the gap rule names both hosts)
with `#upgrade-model` a live 228x44 box, and `document.scrollHeight` was identical in both states — a door
reading "Re-process off" directly above the three controls it claimed to hide, announced as collapsed to a screen
reader. THE CAUSE, because an earlier diagnosis named the wrong rule: `Collapsible.Content`'s `{...props}` spread
lands on the nested `Card.Content` AFTER that component's own literal, so the element carrying `hidden` reports
`data-slot="collapsible-content"`; app.css imports `tailwindcss/theme.css` and `tailwindcss/utilities.css` only, so
Preflight — where Tailwind's own `[hidden]` reset lives — is never loaded; and `Card.Content`'s `flex` utility is
AUTHOR origin, which out-ranks the UA sheet's `[hidden] { display: none }`. One rule in the shell,
`main :global([data-slot='collapsible-content'][hidden]) { display: none }`, closes it, and closing it reclaims
**255px** of the machine scope (measured: `scrollHeight` 1720 closed, 1975 open). It was 319px against an open 2039
until the gap rule above learned the second host name: tightening that column from 24px to 8 is 64px of the height
the door used to be hiding, so the door now hides less because the room behind it is no longer over-spaced.

THE EXIT MODEL IS ONE THING IN ONE PLACE. There is exactly ONE commit control in all of settings — the You card's,
inside the card, because the save's refusals name the name field — and it reads `Saving…` / `Save and close`.
There are ZERO exit buttons on any scope: the room and machine panels' `Done` buttons, and the two `goto('/')`
calls inside them, are DELETED.

That sentence was FALSE for one revision and the correction is the interesting part. The You commit control used to
render unconditionally and read `Done` whenever the draft was clean — an `--accent` block button whose only action
was a navigation, which is exactly the thing the paragraph above calls "a worse copy of the dock". So the rebuild
deleted two instances of the pattern and left a third, in the state a guest ARRIVES in, while the doc claimed zero.
It now renders only while `profileDirty || saving`, so the rule actually holds across all three scopes: the back
arrow is the exit everywhere, and a commit control appears only where there is a draft to commit. A `Done` whose whole job is a navigation is a worse copy of the dock,
which is `position: fixed` and therefore on screen at every scroll position on every settings route, and which
offers three real destinations where `Done` offered one; forcing every exit through the Sing tab is the regression
the TabBar was built to end. The asymmetry the old pair created is resolved by SUBTRACTION rather than by minting a
third instance: restoring a panel-level exit for position parity would re-mint the two identical `--accent` block
buttons this scope was fixed to remove, one of which did not save.

Three `goto` sites survive, and each is a destination rather than an exit affordance. `leaveRoom`'s is `/` AND
NEVER `closeTo`, whatever `?next=` says: the cookie is gone, so the landing page is the only honest destination and
anywhere else 401s. It is the DESTINATION that is unconditional, not the navigation: the `goto` runs only once
`POST /api/leave` has actually answered ok, because a leave that did not happen must not land a still-joined guest
on the landing page as though it had. The commit's two are resolved through `safeNextPath(page.url.searchParams.get('next'), '/')` — the same
hardened allowlist `/` uses — and the You scope's back anchor reads the SAME expression, so the arrow and the
button cannot disagree about where "done" is, which is the class of defect the dual-commit fix was about one level
up. `/` is today's only answer (the identity chip is that route's one door), so the `?next=` exists to keep a second
door from needing a second rule.

THE GAP THIS CREATES, named rather than hidden: the dock is gated on `showChrome` (`isPhoneSurface && me !== null`,
with `me` arriving from the socket), so on a COLD load of a settings route there is a frame with no dock. PageHeader's
back anchor covers it — a real `<a>`, so it works before any JS state lands, and it is also the keyboard-reachable
exit — and every back target names a single real door: You → `/` (or its `?next=`), the room scope → `/`, the
machine scope → `/settings`. `/metrics` and `/stats` name doors too: `/metrics` goes back to `/settings/server` and
`/stats` to `/settings`, where both used to go to a bare `/settings` that resolved through the default tab — so
leaving from the machine scope and tapping back landed on the room scope.

That in-card commit has a consequence that is KEPT ON PURPOSE: the You scope's last control is `Leave the room` in
the Leaving card below it. The destructive action is last because last is the end of the scope, after everything a
guest came for; it is one of two controls here behind an `alertdialog` confirm (Delete me is the other), so arriving at it by reaching for the bottom costs a dismissal rather than a room.
Lifting Leaving above the You card would move the destructive card into the panel's FIRST position — top-left of
the paired grid, which is desktop-only but real — to protect its last. **A refusal is keyed to whatever it is a
statement ABOUT**, which is a rule and not one shape. The profile refusal is keyed to the draft it refused
(`{ name, colour, message }`, read back through a `$derived`) rather than held as a bare string: a stated reason
must not outlive an edit to the field it names, or an empty-name refusal goes on sitting under a button that has
gone back to reading `Done`. The leave refusal IS a bare string, and correctly: a leave has no draft, its subject
is the open dialog, and `askLeave` clears it on every open — so the same rule is satisfied by a different mechanism.
Copying the keying here would key a statement to nothing.

**THE CONFIRM STATES A PRICE, so it may not state one it has not been told.** `Leave the room` is the one guest
action with no undo, and its dialog carries two separate statements. The first is the cost, built by
`leaveCostSentence` in `$lib/phrasing` from `GET /api/leave`: a KNOWN count is named ("Your 3 queued songs will be
removed"), and a count that has not arrived — in flight, or dead — gets the number-free sentence instead, because
`null` is unknown and not zero. A `?? 0` there asserted the cheapest possible price for the irreversible action,
permanently when the GET failed; and since `role="alertdialog"` announces its description AT MOUNT and that
description is not a live region, the screen-reader path heard the zero on every open at any latency and never
heard the correction. Neutral copy is what makes that fix latency-independent — the alternative, holding the
confirm disabled until the cost lands, would trap a guest inside the room they are trying to leave, which is the
same "a failure cannot block" constraint the fetch is already written to. The second statement is the refusal, and
it is the one place on this pane where a second `role="alert"` beside an alertdialog description is right: it can
only arrive AFTER the open announcement, so it duplicates nothing, and the alternative is a destructive action that
failed in silence while its button quietly went back to reading `Yes, leave`.

Other rules a change here must respect. IDS ARE A CONTRACT: all ten `SEL.SETTING_IDS` plus `id="max-processes"` are
spelled explicitly because `tests/playwright/world/selectors.ts` and the probe and shot specs resolve those
literals; `#tab-<scope>` is gone with the tablist and `SEL.settingsTab` retired with it, so a spec navigates to a
scope route and waits on a control. A slider's range must match the server clamp exactly, or the UI silently
refuses values the server accepts. The fourteen registry-backed selects all render through
`src/lib/ui/SelectField.svelte`, which renders a label and a select as SIBLINGS with no wrapper, because the card
rhythm above keys on the label being a direct child of `card-content`. Every form control keeps a 16px minimum
font-size, because iOS zooms a focused sub-16px field and never zooms back and this surface is almost entirely form
controls — measured on all three scopes: ZERO sub-16px form controls, the selects at 16px, `#join-origin` at 16px
and `#profile-name` at 16.8px. The
identity ring gets `taken={[]}` because these loads carry no room occupancy, and inventing one would draw pips at
colours nobody holds. `PROCESSES_UNCAPPED` is `0` and means uncapped, so it must be tested before any count
comparison and is rendered in words. `--control-line` and not `--line` identifies the colour input and the field
boxes; `.err` on `--danger-ink` is a refusal and `.warn` on `--warn` is an advisory, and the six advisories here
are the reason a refusal may not wear amber.

WHY SETTINGS IS NOT TREATED AS A PARTY-TIME SURFACE, from this install's own database rather than from taste:
`room_settings` has ZERO rows — a room write upserts, so no room-scope setting has ever been written here — and
`global_settings` differs from the defaults in exactly one field. A first screen assembled from inferred frequency
would be a guess in a measurement's voice; what the three scopes optimise instead is that a guest can always tell
whose setting they are about to change.

WHAT THE SPLIT COST, measured at 390x844 with `--dock-h` at 91px (its strip-present value; it is 46px on an idle
room). `document.scrollHeight`: the room scope 2111 → 2150 (+39, five scope marks at 23.4px each against the 78px
the tablist and its offset gave back), You 1041 → 1010 (−31, two marks cannot spend the same 78), the machine scope
2043 → 1720 (−323: the disclosure now closes, and the panel-level `Done` and its row gap are gone). The first
control on every scope rises from y=300.8 to y=246.2 — 35.6% of the viewport spent before the first control, down to
29.2% — and the panel top from 184 to 106. Controls fully above the dock on arrival: the room scope 3 of 19 → 4 of
19, the machine scope 4 of 13 → 4 of 9 (the closed door accounts for three of those four fewer, the deleted `Done`
for the last), You 3 of 4 unchanged. Taps from the Sing tab are unchanged for all three: the room scope 1, You 1,
the machine scope 2. The scope line in the sticky header costs ZERO height, measured: the header's box is 64px with
and without it, because the 44px back button already sets that row's height.

### Your night

Proposal 29, PR 3. The phone's half of [Your night](SERVER.md#your-night), and only ever the caller's own.

- **Where.** The You scope has a "Your nights" card: each night, newest first, as "Wednesday, Nov 25 · 2 songs",
  the **Keep my nights** switch (`PATCH /api/me/nights`), and **Delete my history** behind one confirm
  (`DELETE /api/me/nights`). Each tap shows its outcome at once and rolls back with one line on a refusal, as Keep
  me does. A night opens `/settings/you/nights/:id`. The switch sends one PATCH at a time; a second tap while one
  is out is sent once it answers, so the last tap wins. After Delete my history, focus moves to the switch.
- **Your year.** Above the list, once a night is in it: "Your 2026", "12 nights · 30 songs", and "Most sung: Mayday,
  4 times" from two times up (`year` from [GET /api/me/nights](SERVER.md#your-night)). "This year" is the phone's:
  the load counts it in the core's zone and the page asks again with `?tz=` only when the phone's zone differs.
  Delete my history zeroes it with the list. Your own counts only, never beside anyone else's.
- **The story.** A few slides in your colour, one fact each (`$lib/night-story.ts` decides which are true): the
  cover ("2 songs", when, and "3rd night in a row" from two nights in a row up, from `streak`), your loudest song when anyone cheered, and the setlist with each song's cheers and
  key, plus "You like it 2 keys down" when more than half the songs were shifted. A turn that would not play is not
  a song sung, here or in the list's count. Nothing compares you with another singer.
- **Moving through it.** The right half of the slide is Next, the left half Back: two real buttons, so a keyboard
  and a screen reader get them, and the arrow keys do the same while focus is on the story or nowhere, as just
  after opening it (never from the dock).
  At either end the button is `aria-disabled`, not `disabled`, so focus stays on it. A status line says "Slide 2 of
  3". No timer. Save is sticky above the dock, so a long setlist scrolls under it.
- **The flood.** A fixed layer in the singer's registry fill, with its `on_fill` ink, faded in by opacity, and
  each slide's big number pops by transform: the Spotlight rule, transform and opacity only, and both cut under
  reduced motion. The dock stays, so the room's now-line and "You're up" are never under the story.
- **Save picture.** The slide on screen, drawn to a 1080×1350 canvas (`$lib/night-picture.ts`), shared through
  `navigator.share` in a secure context and downloaded as `my-night.png` otherwise: a LAN `http://` page is never
  one. Closing the share sheet is not an error. The loudest song's title wraps to two lines before it is cut; every
  other line is cut to its width with an ellipsis, a setlist title to the width its detail leaves, and a setlist of
  more than seven songs shows six and "+N more".
- **Not yet.** "Your night is ready" in the now-line.

### The song page

`/song/[mediaId]` answers "can I sing this, and are the words right" for ANY song id, including one no
longer in the room's catalog, so it fetches the row from `/api/audit/<mediaId>` — the same endpoint the
audit screen reads — rather than reading the room. It still subscribes to the link for the live key shift,
which is the one fact the stored row cannot know, so the range readout agrees with what the television is
sounding. A singable song may have no measured range (that needs a vocals stem); the page says so rather
than drawing an empty strip. Lyrics here are quick-select among the ranker's candidates, a paste, **Undo** and
**Back to automatic lyrics**, and only for the host: a re-pick changes the song for every room, so a guest is not
offered it ([the host key](SERVER.md#the-host-key), [lyrics fixes](SERVER.md#lyrics-fixes)). Only the fix on screen
is listed; Undo walks back through the rest.

Under it, for the host and a song with timed words, **Timing** (`LyricsNudge.svelte`) moves every line at once:
"Words 0.2 s early" with **Earlier** and **Later**, 50 ms a tap, meant to be tapped while the song plays on the TV.
Each tap shows at once and sends the whole value, one request at a time, so a fast run of taps lands on the last
one; a refusal puts back the value last stored. There is no save button and no re-time. At ±3 s the button at the
limit is `aria-disabled` and drawn inert, not `disabled`, so it keeps the keyboard focus a press just gave it.

### Stats

`/stats` is the guest-facing party page and the one dashboard safe to reach from any phone's surface. It
promises aggregates only — no singer names anywhere, because the play log has no singer column. It leads
with three glanceable figures and puts the trend below them. Honesty rules it must keep: the catalog count
is a footnote, never the headline (it counts every search result ever seen); songs the normalizer could not
attribute are excluded from artists and said to be; and a gap in the per-day trend means "nothing sung OR
the server was off", which the page states rather than resolving.

### Metrics

`/metrics` is the internal processing dashboard, and the host's: anyone else is sent to `/host`
([the host key](SERVER.md#the-host-key)). It is linked ONLY from the Server tab of settings, so the remote
and the television never advertise a door most of the room cannot open. What it promises: durations reported as rates wherever a rate is
meaningful (raw seconds do not compare across songs of different lengths), a sample size beside every
average with small ones labelled, worker state first (with none connected, every timing below is history
rather than live state), and failed runs excluded from the averages.

It opens with the host speed page ([SERVER.md](SERVER.md#the-host-speed-page)). The headline is the page's one
lit surface: pick to ready as a multiple of song length ("0.62x"), the one place the page says a multiple,
because that is how goal 2 states it. Then come three cards: by machine, where each machine's time goes,
and what went wrong with the CSV link. The by-machine table puts "runs on" and the few-runs badge under the
worker name and has no scroller, so its multiples fit at 320 without sideways scrolling. Each bar segment
also prints its time, so colour is never the only signal.

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
the chrome. The route keeps the socket, the gapless control and the screen choice; its layers are drawn by
`src/lib/tv/TvAttract.svelte` (attract), `TvNowBar.svelte` (lower-third, progress, up next, and the two
measured heights behind `--tv-chrome-h` and `--tv-upnext-h`), `TvTakeover.svelte` (the transient overlays) and
`TvAudioNotice.svelte` (the autoplay and key taps), mounted in the same DOM order as before.

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

**The viewport's height is `--lyrics-rows` x a ROW BUDGET, and a romanised row is taller than its
leading.** The budget is `--lyrics-row-h` (the text line's leading, which `.row` reads too) plus
`--lyrics-row-extra`, which is `0em` until `.lyrics` carries the `romanized` class — set when any line of
the doc has a `romanization`, because EVERY row of the reel renders its own second script and not just the
current one. The extra is computed from the three tokens `.romanization` itself renders at
(`--romanization-size` x (`--romanization-leading` + `--romanization-gap`), 0.62em x (1.25 + 0.15) =
0.868em), so the rendered height and the height the viewport reserves cannot drift. Without it a zh/ja/ko
song on a worker with the `romanize` extra fitted 3.4 rows into a 5-row box with `overflow: hidden` and
lost a context row per edge (worker review r2-correctness-1). The edge-fade cap stays off
`--lyrics-row-h` alone — it is the ramp the fade was tuned to, and `measureReel` mirrors that exact number
in px. `tests/unit/lib/tv/reel-offset.test.ts` recomputes the budget from the component's own declarations.

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

### Lyrics fixes

A host's fix reaches the TV through the next `queue:sync`, as a new `lyricsRef` on the playing song
([SERVER.md#lyrics-fixes](SERVER.md#lyrics-fixes)). The overlay shows nothing new: no banner and no toast. For
the turn already on stage (`songKey`), a new ref is fetched behind the words on screen and held.

- **The current row never steps back.** On every path the held words go in only on a frame where the new
  document's current line stands for the old current line or a later one. `rowsOf` maps each new row to the
  old row it stands for (equal texts in order, a rewritten run by position, an added row just after the row
  before it), so a fix that drops or adds a row above the one being sung is not a step back and can land.
  A held version that has already ended at the playhead is never a step back either (`fixStepsBack`, #1299): its
  last line is past, not a row sung again. So an Undo to automatic words that stop early lands at the next gap,
  with that last line held as the current row, instead of waiting for the next song.
  Every swap cuts the reel to the current slot, with its transition off for two frames. The new rows sit at other
  heights, and an ended version's last row can sit far up the reel, so a slide would carry the words backwards.
- **The swap waits for a gap.** The held words go in at the first frame where neither the old reading nor the new
  one is inside a line (`betweenLines`), so no word is cut off. Paused, or with nothing on screen, only the rule
  above applies, so a fix lands at once. If that rule holds it (the fix put an earlier row under the paused
  playhead), it waits for play to resume and lands under the rules here. After 10 s with no shared gap, the old reading being between lines, or a new line starting, is
  enough: a screen painting a few frames a second steps right over a short gap. That fallback can land a fix
  with the first word of the new line already lit.
- **Only opacity moves.** A row the fix rewrote is keyed by its text too, so it is a new node rather than a
  centred line whose text slides sideways (which the layout-shift API counts); every other row keeps its index
  key. Those rows (`changedRows`) fade in over 250 ms; the rest stay put and the reel does not scroll. Under
  Reduce Motion they appear at once.
- **A fix that fails to load changes nothing**: the old words stay, rather than the "No lyrics" notice.
- **The host's nudge** (`lyricsOffsetMs`) arrives the same way and changes only the lead (`nudgedLeadSec`), so the
  highlight and the current row move at once, with no fetch and no swap.

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
- Both awaits in a build are bounded, 10 s each: `resume()` (`RESUME_SETTLE_MS`) and the worklet's `addModule`
  (`WORKLET_LOAD_MS`, #1293). A load that never settles is treated as a rejection: the graph builds without
  shifting, so a guide-mix song still gets its split and its src. As with a rejection, that slot's graph is never
  rebuilt, so the slot has no ±key for the rest of the night, even if the load lands later.
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
the server's advance frame, `positionSec: 0` with a fresh `rev`, re-running the seek effect.
`tests/unit/lib/tv/tv-reload-resume.test.ts` pins it.

After a natural end the TV has usually started the next song itself, one server frame early, so that
advance lands as the server catching up (`GaplessController.isCatchingUp`). An exact 0 there would be a
restart and replay a round trip of the song, so the `playback:state` handler in `src/routes/tv/+page.svelte`
passes `NaN` for that `rev` and any repeat of it. The seek effect still runs, which clears the held target,
and `seekPlan` and `resumeSeekTarget` refuse a non-finite target, so nothing seeks. A later restart has a
new `rev` and seeks to 0 as before.

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
from each `queue:sync`, so the hello handshake always sends `lastRev 0`. It writes `tv:telemetry` only
while the server says it holds the room's seat (`tv:seat`, see `docs/SERVER.md#the-tv-seat`), and a copy writes
`tv:ping` (see "A copy on the TV's clock"). A COPY, or a screen still
waiting for that answer, plays `muted` at volume 0 and makes no AudioContext (`TvPlayer`'s `silent`), with every frame
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
on-screen say; a failure no tap can lift moves the room on instead (see "A song that won't play").

Motion on this surface lives inside `@media (prefers-reduced-motion: no-preference)` or is gated in JS.
Svelte `transition:`/`in:`/`out:`/`animate:` directives are banned tree-wide because the transition runtime never consults the media query.

### A copy is a room screen

A copy (`docs/SERVER.md#the-tv-seat`) shows the TV's stage, and nothing on it asks to be pressed all song (tenet 6).

- **The join QR** is in its corner mid-song, as on the TV: every screen in the room is a place to scan from. A
  phone-shaped copy (a guest reading along) leaves it out: that guest has joined, and the card does not fit beside
  the lower third there.
- **The chip**, "This screen is quiet" and **Make this the TV**, shows for 20 s after the screen opens and for 10 s
  after any tap or key on it (`CHIP_OPEN_MS`, `CHIP_WAKE_MS` in `routes/tv/+page.svelte`). On a TV it stands
  top-right in "Up next"'s place, and "Up next" steps aside (a cut, like the lower third's). On a phone it stays
  top-left, and "Up next" steps aside there too, because the two meet across a 320 screen.
- **On a phone the lyrics start below the chip** (`--tv-top-reserve`, the chip slot's measured height plus a gap),
  so it never covers a line (#1205). The reserve holds all song, asleep or awake, so the reel never jumps when a
  tap wakes the chip. Mid-song on a phone the chip's line is as tall as the longest line it can show ("The TV is
  reconnecting...", laid under it unseen, the shown one right-aligned against the button; "TV again after this
  song" is kept shorter than it), so the reel stays put when the line changes too. Every line fits one row at 390, so the line is one row
  tall there; only at 320 does it take two. `p34-room-screen.spec.ts` reads the lyric box asleep, awake and after the
  line changes, and `p34-screens.spec.ts` does the same in the "TV again" state. A TV-shaped copy keeps the reel at
  full height, with the chip where "Up next" stands on the TV.
- **Asleep** it is `visibility: hidden` and takes no pointer. Hiding alone does not make the waking press harmless:
  a touch tap's click is hit-tested after the touch ends, when the chip is back, and a double click's second half
  lands on it. So a claim within 500 ms of the chip waking is dropped (`CLAIM_AFTER_WAKE_MS`). The first tap only
  wakes it, and a tap once it is up claims. It fades in and out over `--motion-base`, and cuts under reduced motion.
- **It stays up** in the lobby (where it stands in the QR's place), in attract, while the TV is gone ("The TV
  is reconnecting..."), and on the room's TV back mid-song while another screen stands in ("TV again after this
  song", `tv:seat`'s `next`). A tap there still makes it the TV at once.

`p34-room-screen.spec.ts` holds each of these.

### A copy on the TV's clock

A copy plays the song on its own muted element, which drifts from the TV's. So it follows the TV's clock as core
relays it (`tv:clock`, `docs/SERVER.md#the-tv-clock-relay`). The rules are in `src/lib/tv/copy-clock.ts`.

1. **Offset to core.** The copy sends a short burst of `tv:ping`s on connect and then one every 30 s. It keeps the
   minimum-RTT sample of the last 8 (NTP's rule): offset = `serverAt - (t0 + rtt / 2)`.
2. **Target.** The TV is at `positionSec + (now + offset - serverAt)`, re-read on each `tv:clock` frame.
3. **Correction**, on the active slot only, while it plays the frame's entry:
   - under 20 ms off, it is left alone;
   - from 20 ms to 100 ms, `playbackRate` is trimmed by up to 3% (`1 ± min(0.03, error / 2 s)`), with
     `preservesPitch` off because the element is muted;
   - over 100 ms, it seeks. A seek needs two frames in a row to agree, so one stale frame from before a room seek
     cannot hop the words back. It aims ahead by the lag the last seek landed with (`nextSeekLead`, at most 300 ms);
   - a trim lasts only while frames keep coming: with no frame for 1 s (`CLOCK_STALE_MS`, the seat's socket dropped),
     or as soon as the copy stops following (another entry, paused, seeking), the rate goes back to 1, so a stale
     trim cannot drift the copy 30 ms a second.

   The proposal said 250 ms for the seek line. At 250 ms, a copy that started 150 ms late on a 4x-CPU device took
   5 s of trimming to catch up, and that start alone put p95 at 103 ms.

4. **The seat never follows.** Only a copy is handed `follow` (`isCopy` on the page). A slot without it goes back
   to rate 1 with pitch preserved, so a copy promoted mid-song becomes the room's clock exactly as it plays.
   `p34-copy-drift.spec.ts` checks that the TV's element never sees a `ratechange`.

Song changes and the "Now singing" card still come from the copy's own playback. Because the copy now ends
within its drift of the TV, its card goes up within ~30 ms of the TV's (the probe's `cardGapMs`).

**Measured** by `p34-copy-drift.spec.ts`, which runs a 60 s song with a pause, a resume, a seek and a natural end,
and the copy at 1x and 4x CPU. It reports the p95 |copy - TV|, the card gap and the share of time both screens light
the same line. Headless Chromium on a shared host paints both screens at only 7-12 fps, so two screens on one clock
still light a new line up to a frame apart. That is why the probe's floor for the same line is 98%, not the
proposal's 99.5%. Judge the 99.5% on real devices.

### The Screens page

`/settings/screens` is host only. Its door, **Screens**, is on the room scope and is shown to the host alone. It
lists every `/tv` open in the room, the TV first (`docs/SERVER.md#screens`).

- **Each row** has the screen's name and one tag: "The TV · sound", or for a copy "Quiet · 12 ms behind", "ahead",
  "in step", or "Quiet" with no fresh report (`screenTag`, `$lib/screens`).
- **A screen opened in the last minute that nobody has named** is a `Spotlight` headed "Just opened", so the host
  can tell which one they just switched on.
- **The actions** are **Make this the TV**, **Rename** (inline, 32 characters at most) and **Remove**. Copies only
  get Make this the TV, and every screen but the room's TV gets Remove (`canRemove`), so a screen standing in for the
  TV while it is off can go. While a song is on, Make this the TV is disabled and one
  line says why: a screen becomes the TV mid-song only when someone taps it there.
- **The first list comes with the page** from its host-gated load, so the page paints whole (CLS 0). After that it
  is polled every 2 s while the page is visible, not pushed, because a socket never carries the host.
- **The status line** (`role="status"`) is in the DOM from the start, empty, so a screen reader catches its first
  message. A refused action says what to do instead there.
- A row's buttons wait while its action is in flight, so a double tap sends one request. A Remove that finds the
  screen already gone counts as done. Escape cancels a rename.
- The page ends with where to add a screen: the join address with `/tv`.

The layouts per screen (Everything, Words only, Up next) come with proposal 34's PR 4.
`p34-screens.spec.ts` covers the page, the API, the removed screen, the cookieless cap and a script minting cookies.

### A song that won't play

ONE rule, in `src/lib/tv/stall-watchdog.ts`: **the song isn't moving.** A media error fails it at once. Otherwise,
while the slot's transport is `play` (active, on screen, holding this entry's src, not paused from a phone), a
playhead that has not moved for `STALL_RETRY_MS` (4 s) is reloaded once, quietly, and resumed where it stuck; still
not moving at `STALL_FAIL_MS` (8 s), the song has failed. That one timer covers a `play()` that rejects and leaves
the element paused, a stall mid-file and a file that never arrives. It never runs while the TV waits for a tap
(`NotAllowedError`): that is the whole TV's problem, and skipping there would burn every turn in the queue.

Three readings the watchdog does NOT count. The time inside a gap of more than 1 s between its own ticks (a frozen
tab, a TV out of standby) is forgiven, less one normal tick, so a single sleep does not fail a song on wake while
throttled 1 Hz ticks still add up to a failure. A first load still downloading, or with its fetch open and nothing
arrived yet, is not reloaded until it has been still for 4 s after that too, because the reload restarts it from zero:
a file that lands after 4 s gets until the 8 s failure to start, rather than being thrown away the moment it lands. And a
`play()` still unanswered after 4 s on a TV nobody has touched, for media that has been READY to play for 1 s, is treated
as an autoplay refusal (some TV browsers leave a refused play() pending rather than rejecting it). The 1 s lets a
`play()` that answers just after a slow file lands do so without a flash of the tap screen, and is short enough that a
refused one on a file landing before about 7 s still reaches the tap screen before the 8 s failure: the tap screen shows and
nothing is skipped. Media that never loaded is the song's stall, not the tap screen's, and a media error is the song's
whatever its play() is doing (`unansweredPlayIsAutoplay`). The slot's watchdog resets when its ENTRY changes, and only
then: the slot outlives its songs, and a room update for the same entry must not restart the count.

A guide-mix song has no src until its mix settles, so the watchdog above never sees it. `MixPendingWatch` covers that
wait instead (#1293): on screen, with the room playing and no src yet, past `MIX_PENDING_FAIL_MS` (25 s, beyond both of
the graph's own 10 s bounds), the song fails through the same `onfailed`. A slow mix that settles inside that time
plays as usual.

A `play()` rejection decides nothing by itself. Only `NotAllowedError` arms "Tap anywhere"; any other rejection is
left to the watchdog, because a set-and-forget TV never gets the tap, and an element that still advances is playing.
A rejection for a src the slot has since left is ignored outright (#974: the outgoing song's AbortError). The
element's `error` event asks the watchdog at once rather than at the next tick, so a dead file's card paints at most
one frame.

TvPlayer has ONE way out, `onfailed`, once per entry. The page sends `tv:telemetry` `failed` (never `ended`, which
would mark the turn sung), stamped with the entry the failing SLOT holds, and raises the Skipped takeover naming whose
song it was — "Theo's song wouldn't play", never the browser's reason — and who replaces it, captured at the failure
because the advance moves `upNext` on. In the missed preload window the failing slot holds `upNext`, so the notice
names that entry's singer and leaves "Up next" off until its replacement is known. A stale pair that re-sends a lost
end (#1001) re-sends it as the TV sent it: the controller keeps the status beside `#endedFrom`.
The next singer's song WAITS for the notice: the server starts it paused, and the TV pauses it locally at the failure,
because #988's swap would otherwise start the warmed song a round trip before the server's paused frame lands. When
the notice clears the TV sends `tv:telemetry` `resume`, stamped with the held song, and the card and the song start
together, so "Up next" stays true and no opening is lost
under a takeover. It is a real pause, so phones show it and the watchdog does not count it; the phone's "You're up"
fires on the turn's first PLAYING frame, which puts it beside the TV's card. A tap on "Tap anywhere" that still
cannot start the song spends the latch: the song is then the problem, and the watchdog fails it. There is no "won't play"
overlay: a failure the room can do nothing about is moved past, not displayed.

**The failed singer's phone, and only theirs, says so.** The root layout shows `SongDidntPlay` ("Your song didn't play",
the title, Try again and Pick another, "You keep your spot.") in the "You're up" slot, on any tab, and it replaces
"You're up" when both would show. `didntPlayTurn` (`$lib/song-didnt-play`) picks MY earliest held turn whose failure
this page has not closed; it is not edge-triggered, so a phone that slept through the failure, or reloads, still
hears about a turn that is waiting on it. A second failure of the same song is a new key and brings the sheet back,
with Pick another alone (`canRetryPlay`). One button is filled, the next step to take: Try again while it is
offered, and Pick another (quiet beside it) once it is the only one (redesign step 6, #1156; `wont-play.spec.ts`
checks the painted fills on the whole page). While it is up, the held /queue row's own pair goes quiet (`quietNext`,
from the layout's `didntPlayFor` context), so the screen still has one filled next step. It has no timer: it stays until the singer acts or closes it, and toasts
stack above it for as long as it is up. The held /queue row carries the same two buttons on the owner's phone; other
phones see "Didn't play" with no buttons, and nothing else.

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

### Tonight on the TV

The host taps **Show the night** on the Queue tab. It is offered only to the host, only when nothing is playing
or queued, and the server checks both again (docs/SERVER.md#tonight). The TV then plays `TvTonight.svelte` in
place of the lobby or attract screen: up to four slides, 6 s each, then the lobby again. A song starting ends it.

| Slide | Shows | Only when |
| --- | --- | --- |
| Totals | "2 songs · 2 singers · 5 cheers", or songs alone | always; songs alone when anyone in the night opted out |
| First song | its title and singer, in the singer's Spotlight band | its singer may be named |
| Who sang tonight | each named singer with their colour dot, in the order they first sang | anyone may be named |
| Last song | its title and singer, in their band | more than one song, and its singer may be named |

Nothing ranks anyone: there is no "song of the night", no counts per person or per song. The band takes the
singer's palette stop and its certified `on_fill` ink, as the Spotlight does. Every size is a `--tv-*` tier, so
the type floor holds (the probe checks every text box is 20 px or more and inside the safe area at 1920 and
1280). The pager sits beside the title, because the connection dot owns the top-right corner. The slides enter
with `--motion-slow`, transform and opacity only, and not at all under reduced motion.

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
and the scaling probe recognise the state. The notice is HERO-ONLY — attract and the lobby, the empty room where
the host is setting up — and reads "Phones can't open this address" / "Fix it in Settings -> This machine" (ASCII `->` and `'`: the TV draws
nothing outside plain ASCII, see `song-facts.ts` and `stage-words.test.ts`). The
corner card on the stage and over the takeovers never shows it: the room is watching, and nobody fixes an
address from the sofa. `/settings/server`'s Joining card says the same first line, from the same constant in
`src/lib/tv/join-address.ts`, when the address in effect fails `isUnreachableJoinOrigin`.

### The full-screen takeovers

Each takeover carries its own colour family AND its own words AND (for error/processing) its own mark, so
colour is never the only carrier; the words are sentence case, never an uppercase eyebrow (redesign step 8). **The
Now singing card is one BAND in the singer's colour** across the middle of the stage (30vh down, 40vh tall), from the
singer's palette stop with its certified `on_fill` as the ink, so the card is in the singer's colour on every one of
the 48 stops. The error and processing takeovers keep `--danger` / `--warn` as a non-text border and wash. Behind them
the backdrop is a radial SCRIM, not an opaque wash:
a wash blanks the room's chosen backdrop for every song change, which is the exact black flash the
background layer's visibility band exists to avoid, undone one layer up — and it would hide the join block
that must stay visible through it. "Next up" is untrue for the first song of the evening, so the label reads
"Now singing" until `openedOnce`. The processing takeover's words come from `processStageLabel`, the one
guest-facing process vocabulary shared with the phone. Its bar and current step are the song's `liveStatus`
through `waitingProgress`, the phone's own `overallProcessPct` figure, and with no live status held for the song
it draws neither: a fixed "representative" bar contradicted the phone's real %.

The takeovers share ONE `.takeover-layer` that stays mounted, so a card can fade out as well as in (an `{#if}`
unmount cannot animate, and `transition:` is banned): it fades in over `--motion-slow` while the lines rise one
`--tv-space-4xl`, fades out over `--motion-base` `ease` with the player slots' crossfade, and a change of words while
it is up re-rises only the lines. The lyric reel stays unmounted until the card has gone, then fades in over
`--motion-fast` (`lyrics-arrive`): a real lyric line is as wide as the card's, so the two never share a frame. So the
first line is up when the song starts, the intro card's exit starts `--motion-base` + `--motion-fast` before its hold
ends (when the hold's end would start the song; over a still-loading slot the card stays), and the reel comes up in the
hold's last moment without advancing. A hold too short to fit the fade-in, a 600 ms readable beat and the lead
(the room allows 500 ms) is not led: its card leaves at the hold's end. Under `prefers-reduced-motion: reduce` both cut
at the hold's end.

While the layer is up, the card is the whole stage. The scrim is transparent past 62% of its radius, so the stage
chrome in the corners shows through it: the lower third and the progress line are hidden (`underCard`, from
`layerShown`), or "Now singing Maya" is on screen twice, and the stage's own corner QR is hidden while `transient`
holds the dimmed `.takeover-join` copy, or the two stack at full brightness in one box. Both hide by `visibility`,
so `--tv-chrome-h` and the reaction lane's measured corner do not move. "Up next" stays: it is a different fact. Both
cut out as the card comes up. The `corner` progress style fades back in on `--motion-base` from the layer's exit START
(a cut under reduce); the default `edge` line and `card` row are the singer pill's own and come back with it. The lower
third CUTS back in only once the card's exit fade has ENDED (`cardPainted`), or for the fade's first frames it repeats
the name the card is still showing.

The QR's 1.0 to 0.72 step is a CUT, at both ends of the card, on purpose. A fade needs both copies painted at once
(the stage's under the takeover, the dimmed one above it), and that is two QRs in one box for the fade's length, the
bug this rule removes. Dimming the stage's own copy in place does not work either: it sits under the takeover layer,
and the scrim is still about half up at that corner. The step is the same white tile at 72%, in a slot that does not
move.

**The lower-third is the singer's PILL** (redesign step 8): name, song and key on one opaque fill in the singer's
palette stop, inked in its certified `on_fill`, so it reads on any backdrop with no shadow or stroke, and the singer is
named once, in their own colour. Its underline is the progress: the default `edge` style draws a line along the
pill's bottom edge, inside the safe area, where it used to run along the screen's bottom edge in overscan; `card`
puts the bar and countdown in the pill; `corner` and `off` are unchanged. "Up next" reads "Theo is next" (`IS_NEXT`)
with the song under it, and the join corner drops its "Scan to join" eyebrow: the QR, the address and the code say it.
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
