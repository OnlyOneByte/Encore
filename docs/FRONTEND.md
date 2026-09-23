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
`preflight.css` and the reset restyles a tree that predates it. `tests/guards/design-system/tailwind-toolchain.test.ts`
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
and paints nothing, silently — that is why `--radius-*` is absent. And **no player hue may be registered
there**: minting is all-or-nothing per namespace, so a colour hands out `text-<hue>` alongside `bg-<hue>`, and
the ink-versus-fill split is per-stop across the palette registry. The shadcn semantic layer IS registered, so
a vendored component works unedited, and the ink direction is banned by name in app source instead
(`tests/guards/design-system/shadcn-ink-ban.test.ts`).

Naming traps that have all bitten at least once:

| Shape                                                             | What happens                                                                               |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| a named t-shirt width (`max-w-sm`, `w-xs`)                        | resolves through the bridged SPACING namespace and collapses to a few pixels               |
| a numeric spacing utility (`p-2`, `gap-6`)                        | resolves against Tailwind's own multiplier, off this app's scale                           |
| a named radius or leading key                                     | resolves against Tailwind's default scale, not the app's                                   |
| an app class named after a utility (`block`, `underline`, `ring`) | inherits the utility's declarations wherever a vendored component caused one to be emitted |

Every width in a vendored component is therefore an arbitrary value, which resolves through no namespace;
`tests/guards/design-system/vendored-dimension-keys.test.ts` catches the named form.

### Tokens, and which may never carry text

A component reads `var(--…)` and never a literal. `tests/guards/design-system/design-system.test.ts` reds on a
literal that duplicates a token's value, and on an `@media` width that is not a member of the `--bp-*` list.
Off-scale values (7px, 9px, 0.78rem) deliberately have no token, so a near-miss is invisible to that guard.

Three tokens carry a hard rule:

- **`--grad` is decoration only.** Progress fills and the wordmark through `background-clip`. No ink clears AA
  at both endpoints across the palette registry, and nothing measures the interpolated interior.
- **`--accent` is a FILL, and `--accent-ink` exists because it is not readable as text.** A fill and its ink
  are emitted as one certified pair or neither; `tests/guards/design-system/colour-tokens.test.ts` fails a site
  that sets one without the other.
- **`--danger`, not `--accent2`, means failure.** Pink is a valid singer colour, so an error drawn in it reads
  as decoration.

`--tap` is the one number the guards read out of the stylesheet rather than restating: `tests/support/src/scan.ts`
parses that declaration, so a control must express the token and never 44. Type is rem on every phone surface,
because `body` declares `font-size: 100%` and `tests/guards/layout/phone-inventory.test.ts` bans an absolute
size there; form controls take a 16px floor of their own, because iOS zooms a focused sub-16px field and never
zooms back. The two `--max-w` preludes keep px literals, since a media query is evaluated before the cascade
and cannot read a custom property.

Dimming is a SURFACE or INK change, never an opacity on a subtree: an ancestor alpha flattens text and the
surface behind it into one buffer, so `tests/guards/a11y/contrast.test.ts` keeps passing while the guest sees
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
  `tests/guards/design-system/ui-scoped-style-reach.test.ts` checks reach. A `:global()` that keys on a shared
  attribute must be ANCHORED under a scoped class, or it matches every such element in the app.
- **A class handed to a component is stripped at the caller.** State that a component cannot carry on a variant
  travels as a `data-*` attribute the component forwards (`src/lib/components/SongRow.svelte` does this for its
  three row states).
- **A guard's own reach is part of the trap.** `tests/guards/a11y/touch-targets.test.ts` reads CSS RULES, so a
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
- **`min-width: 0` is load-bearing wherever a nowrap child sits in a flex or grid parent.** An item's automatic
  minimum is its min-content width, so without it an unbreakable title sizes the box instead of ellipsising
  inside it, and an empty flex item (the singer dot) is what gives up width first and collapses to 0px.

### Motion, in component CSS

Svelte `transition:` / `in:` / `out:` / `animate:` directives are banned tree-wide
(`tests/guards/motion/motion.test.ts`): the transition runtime writes its own inline keyframes and never
consults the media query. Tailwind's motion utility NAMES are banned for the same reason. So motion is
authored CSS, and the rules are:

- It lives inside `@media (prefers-reduced-motion: no-preference)`. Opt-in is preferred over
  declared-then-reset, because there is then no reset to lose the cascade to.
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
`tests/guards/hygiene/band-clock-reanchors.test.ts` pins that shape.

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
[`docs/GUARDS.md`](GUARDS.md) for the two rungs the suite is split into.

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
and carries no fade; `tests/guards/design-system/drawer-overlay-modality.test.ts` ties those facts together.
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
letting a fabricated zero pass (`tests/guards/meta/mount-rung.test.ts`). A zero is not a measurement, and the
two natural guard shapes around one are a permanent red nobody trusts or a permanent silent green.

The consequence is a rule about markup, not about tests. `.band-slot` and `.np-fit` carry `bind:clientHeight`,
so ANY reactive update in that part of the template re-runs its size binding — and on this rung that throws.
So:

> **A size binding must never be driven by a reactive prop or a `class:` directive.** `NowPlayingBand` takes no
> `expanded` prop and every handler it takes is a callback, stable for the life of the mount. State that needs
> to reach that subtree arrives as an ATTRIBUTE written from an effect, because an attribute write re-renders
> nothing.

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

- **The root's `class` attribute stays STATIC.** `tests/guards/a11y/contrast.test.ts` derives a row's classes by
  splitting that attribute on whitespace, so an interpolation hands it a token it then applies as a regex and
  reports a nonsense defect about an unrelated rule.
- **A processing mark is a SIBLING of the title, never a child.** The title is a clamp with `overflow: hidden`,
  which makes it a scroll container: a mark inside is clipped off-box exactly when the title is long enough to
  need the ellipsis, which is the state the mark exists to announce. The title's `flex-grow` must stay 0, or the
  clamp box fills the line and pushes the mark to the column's far edge.
- **`ProcessingCard` and `QueueRow` are deliberately byte-identical** on the drag transform, the digit roll and
  the dimmed treatment, because the two kinds sit in ONE list dragged by one gesture, and a difference reads as
  one of them being broken. `tests/guards/design-system/processing-card-longname-fixture.test.ts` additionally
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

`src/lib/components/ui/input/input.svelte` and its sibling select share the `.encore-field` look and two hard
floors: `min-height: var(--tap)` and a 16px font-size on every variant. `src/lib/components/CodeEntry.svelte`
makes the boxes the source of truth and derives `value` from them, and its completion callback CARRIES the code
— the binding reaches a parent an effect later, so a parent reading its own binding sees the code one character
short and returns silently, which is how the last keystroke and a whole-code paste both do nothing.

`src/lib/components/ColourRing.svelte` is one `role="slider"` on the whole disc: a single tab stop with
`aria-valuetext` over the stop's NAME, arrow steps that WRAP because hue is cyclical, and a diameter derived
from `--tap` — a percentage height resolves against an auto-height parent and computes to zero. Its `taken` pips
are information, never a block, because two singers sharing a colour is legal. The palette's measured contrast
is checked in `tests/guards/design-system/palette-registry.test.ts` and deliberately not shown to the person
picking.

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
the route or any descendant of it. It is the same set `tests/guards/layout/phone-inventory.test.ts` exempts
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
   band owns the bottom one and the topbar is already sticky;
2. `Queued`, the rotation in play order, drawn as `QueueRow` or `ProcessingCard` per entry;
3. `Making karaoke…`, which renders in BOTH views;
4. with an empty field, `Your library`; with a query, `Ready to sing` then `Needs karaoke`.

`searchActive` (a non-empty query) is the sole switch between the queue view and the results view. There is
no browse mode, no `?browse=1`, and no history entry for a search — clearing the field restores the queue,
so Back always means leave the room. The processing group is deliberately ungated: its membership is
query-scoped in `src/lib/readiness.ts` row by row, and it subtracts anything the queue above already draws
a bar for so one job never gets two progress bars. A group heading is a claim about what follows it, so
each is gated on having rows.

Reordering is a live sort with no mode: `liveSortTarget` in `src/lib/reorder-mode.ts` both places the rows
and decides what a release commits, so a drop cannot land somewhere the guest did not see. Geometry is
measured once per gesture at press time (rows change height mid-flight), pointer listeners go on `window`
because the pressed grip becomes a detached node as the list reorders, and focus is returned by attribute
for the same reason. Arrow Up/Down on the grip is the single-pointer alternative. The wait on a singer's
own row comes from `waitShort` in `src/lib/phrasing/position-sentence.ts`, which omits an unknown estimate
rather than zeroing it.

### Settings

`/settings` is three scopes in a real tablist — You (one person), Party (this room), Server (this machine
and its worker fleet) — resolved server-side in `src/routes/settings/+page.server.ts` so the first paint is
already on the right tab. `party` is the default. Tab switches use `replaceState`, so Back leaves the page
instead of walking tabs. There is no socket: every write is a per-field patch the server re-normalizes over
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
margin, so a card's first label is untouched.

Other rules a change here must respect: a slider's range must match the server clamp exactly, or the UI
silently refuses values the server accepts; `id="tab-<scope>"` and `id="max-processes"` are spelled
explicitly because `tests/e2e/contract.ts` and the capture script resolve those literals; `.panel` carries
no `role="tabpanel"` of its own, because `Tabs.Content` already renders one and a second nests two; the
identity ring gets `taken={[]}` because this page's load carries no room occupancy, and inventing one would
draw pips at colours nobody holds. `PROCESSES_UNCAPPED` is `0` and means uncapped, so it must be tested
before any count comparison and is rendered in words.

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
exists, and `tests/guards/wiring/dev-only-routes.test.ts` pins that gate. It is also load-bearing test
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
`tests/guards/subsystem-tv/lyrics-reel-cap.test.ts` pins the arithmetic, and
`tests/guards/layout/reel-offset.test.ts` pins that the clamp stays on the render path.

Legibility is a STROKE, not a bound on the background. A blurred shadow dissolves against a mid-tone
stage colour of similar luminance — exactly the field a hue-only background paints — so the reel strokes
`-webkit-text-stroke` with `paint-order: stroke fill`. The reversed paint order is load-bearing: the
default paints the stroke on top of the fill and eats the thin parts of each glyph. Width is in `em`,
because a px stroke reads heavy at 720p and hairline at 4K. There is exactly one stroke declaration
(`tests/guards/subsystem-tv/lyrics-stroke.test.ts`), and it is why no visualizer or stage colour needs a
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

`tests/guards/subsystem-tv/pitch-shift-graph-lifetime.test.ts` pins the lifetime, and
`tests/guards/subsystem-tv/guide-mix-graph.test.ts` the split chain.

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

`navigator.wakeLock` is SECURE-CONTEXT ONLY, so on a plain-HTTP LAN room it is `undefined` and the
feature-detect makes the effect inert. The platform DROPS the lock whenever the document hides and never
restores it, so it must be re-acquired on `visibilitychange` or it works once and quietly stops. A request
in flight leaves the sentinel null, so a `visibilitychange` arriving mid-flight needs its own guard or it
issues a second request and leaks the first held lock past the song's end.
`tests/guards/subsystem-tv/wake-lock.test.ts` pins it.

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
`tests/guards/subsystem-tv/tv-reload-resume.test.ts` pins it.

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
`tests/guards/subsystem-tv/tv-ws-room-binding.test.ts` pins the binding.

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
Svelte `transition:`/`in:`/`out:`/`animate:` directives are banned tree-wide
(`tests/guards/motion/motion.test.ts`) because the transition runtime never consults the media query.
