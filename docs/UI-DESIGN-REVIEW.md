# UI design review

A second review pass, disjoint from [`UI-REVIEW.md`](UI-REVIEW.md). That one audited the UI as
**engineering** — responsiveness, tap floors, reactivity, dead CSS, cascade order. It never asked whether the
result is *good visual design*. This one does: hierarchy, typographic scale, spacing rhythm, non-text
contrast, and whether the app reads as one designed product.

Evidence: the 19 frames the `shot` project captures, plus a width sweep (320/390/520/768/900/1200/1440) driven
against a real 104-song library, plus measured geometry and computed WCAG ratios. Nothing below is an
impression that wasn't checked against a number or a frame.

> **STATUS — all 8 findings are answered on `ui/review`: four closed outright, four closed in part with the
> remainder DECLINED on measurement rather than missed.** Each was implemented by a dedicated agent and
> re-verified against the tree. Every figure in the notes below was derived from the tree as it stands — a token
> value, a census, or arithmetic on one — and where a note leans on a browser reading it says so and names the
> file that holds the reading, rather than reprinting a px number this document cannot re-derive.
>
> **Closed:** **4** one action, two identities — both branches of `SongRow` are `variant="iconPrimary"`, and
> `var(--ok)` appears nowhere in that file · **6** join gate placement — centred on both hosts from `--bp-md` up,
> pinned by CLAIM 7 in `core/tests/playwright/specs/gate/measured-join-gate.spec.ts` · **7** two label styles —
> both You-card labels now render `--ph-text-md`, weight 500, sentence case, `--ink-dim` · **8** dual commit —
> one control, whose label says which of its two jobs it is doing.
>
> **Closed in part, remainder declined or open:** **1** form-control contrast — the headline is closed (all three
> text primitives take `--control-line`, 3.65:1 on their own `--card2` fill), and one live boundary in this
> finding's trailing clause is left OPEN and named · **2** the spacing ladder — a 1.20 ratio FLOOR replaced the
> flat 2px run and the section rung exists, but there is no 32 or 48, and the histogram half did not move ·
> **3** the type scale — crowding closed, the top hole open by ruling · **5** desktop composition — the prose
> measure and `/library`'s wide head landed and the wide SHELF has since been deleted with the home column it sat
> in; the four remaining stretches were re-measured and argued, two of them with the alternative built and
> rejected, and the void was re-measured a second time after the phone rebuild and is still open. Each carries its
> own note below, and each says which half did not land.
>
> **The evidence base is dated, and this block is the only place that says so — and there are TWO databases, which
> is the part that kept getting miscopied.** The owner's live catalog, `data/encore.sqlite`, holds **384** media
> rows, **379** `stem_status='none'` and **5** `ready`. The desktop px readings in finding 5 and in
> `docs/FRONTEND.md` were NOT taken against it: they were taken against the measurement copy at
> `../Encore-ui/data/encore.sqlite`, which holds **180** / **178** / **2**. **Quote neither number as durable —
> quote the SHAPE.** An earlier version of this block said to quote the ratio because it was the only durable half,
> and that is backwards: the stem-less rows accumulate every time somebody searches while `ready` barely moves, so
> the total is the fast-moving term and the ratio inherits all of its motion. The ratio has in fact already moved
> twice. 5 of 384 is 1.3%, about one song in seventy-seven; 2 of 180 is 1.1%, about one in ninety — and that same
> 2 of 180 was 2 of 135, about one in seventy, when this block was first written. What is durable is the shape: the
> READY count is single digits and stays there, the stem-less count grows without bound, and no px reading in either
> file depends on anything but the ready count — a cap of 4 or 8 cannot bind on two rows. The "104-song library"
> above and the "102 rows"
> in the refuted bullet describe the catalog as reviewed. The owner confirmed (2026-10-03) those stem-less rows are
> **benchmarking junk rather than a processing backlog**, so every "only N of M are ready" reading in this file is
> about a corpus that is mostly noise: the real ready library is small, and that is its
> steady state, not a stage it grows out of. Finding 1's ratio table is a different
> case: its tokens have not changed, so it should still reproduce, and two of its three rows do not. That
> finding says which.

## The thesis

**The television was art-directed. The phone was assembled.** `/tv` has a real type hierarchy — a `0.93rem`
letterspaced eyebrow over a `3.567rem` hero, a ~3.8× ratio, with the QR panel given its own optical column.
It looks like a product. The phone surfaces use a compressed scale where four of the nine type rungs sit
inside 3.5px of each other, and a spacing ladder whose largest rung is 20px. Nothing on a phone screen is
emphatic, so nothing recedes either. That single difference explains most of what follows.

*The TV half of that comparison is unchanged and re-derived true: `--tv-eyebrow` is `0.93rem` over
`--tv-hero`'s `3.567rem`, a 3.84× ratio. The phone half is the part findings 2 and 3 moved. Today the type
ladder is EIGHT rungs whose tightest cluster is three inside 2.4px (12 / 13.12 / 14.4px), and the spacing
ladder's largest rung is `--space-5xl` at **24px** — the section rung finding 2 asked for. The thesis still
holds as the reason the phone reads flatter than the TV; the two numbers in it are the pre-fix tree.*

## Confirmed findings

### 1. Form controls fail WCAG 2.2 SC 1.4.11 (non-text contrast)

The only thing that says "this is a text field" is a `1px solid var(--line)` border, and it does not reach the
required 3:1 against its own fill — by any accounting:

| pair | ratio | needs |
| --- | --- | --- |
| `--line` border on `--card2` fill | **1.23:1** | 3:1 |
| `--line` border on `--bg` page | **1.40:1** | 3:1 |
| `--card2` fill against `--bg` page | **1.09:1** | 3:1 |

Crediting the fill instead of the border does not rescue it; the fill is *lower*. Affects
`ui/input`, `ui/textarea` and `ui/native-select` — every text entry in the app.

This is visible, not theoretical: on the join screen the six room-code boxes read as featureless grey slabs.
It is the first thing a new guest sees and there is no visual cue that they are inputs.

`--line-strong` (1.57:1) and `--track-bg` (1.27:1) are also below 3:1 where they bound a control.

**Not a finding:** the focus ring is fine — `--focus` is 6.31:1 on `--bg`, 5.53:1 on `--card`.

**As FIXED — the headline is closed, and one live boundary is left over.**

*The three text primitives.* `ui/input`, `ui/textarea` and `ui/native-select` each declare
`border: 1px solid var(--control-line)` — a NEW token, `#76769e`, rather than a brighter `--line`. Re-derived
against the tree: **3.65:1** on the `--card2` fill all three declare, **3.97:1** on the `--card` that `input`'s
`join` variant swaps in, and **4.53:1** on the `--bg` page. The join screen's six room-code boxes were the
review's named symptom and they are not form primitives at all — they are `class="segment card"`, so
`CodeEntry.segment` had to outrank `app.css`'s unlayered `.card` hairline to get the boundary.
`core/tests/unit/lib/control-boundary-contrast.test.ts` holds all of it, including the ranking across every
surface `app.css` declares.

*Why `--line` was NOT brightened, which is what this review's own cost line prescribes.* `var(--line)` is the card
edge, the list-row rule, the table-head rule, the tab strip, the chip, the spinner and the skeleton shimmer across
the app; raising it to clear 3:1 repaints all of that to fix six borders. The file count this sentence used to
print is gone: it disagreed with the one `docs/FRONTEND.md` printed for the same set, and the guard now holds the
premise as a floor rather than as a tally. That guard now asserts `--line` is still `#2a2a3e` and still under
3:1 on `--card2`, so **the fix this document recommends would red a test.** See the Ranked table below, where
that cell is corrected in place.

*The two trailing tokens, separately.* `--track-bg` keeps its value and its **1.27:1** on `--card`, because it
is a SURFACE at five output sites (`Bars`' bar, `TvProgress`' bar, `/tv`'s process bar, `NowPlayingStrip`'s progress
hairline, `SongRow`'s artwork-placeholder gradient)
and repainting it would recolour all five to bound one control. The one control it did bound — `ui/slider`'s
rail — took a `--control-line` RING instead, which clears 3:1 against both neighbours: **3.97:1** on the `--card`
outside and **3.13:1** on the `--track-bg` inside. A rail FILL could not have served: on `--card`, 3:1 arrives
between `#666` (2.99:1) and `#6a6a6a` (3.18:1), i.e. a mid-grey bar in a dark app. `--line-strong` also keeps
its value (**1.57:1** on `--card`, **1.44:1** on `--card2`) and now bounds only INERT controls, which 1.4.11
exempts by name — `Button`'s dashed `keycap` resting state, upgraded by `enabled:border-[var(--control-line)]`,
and the slider thumb's `data-disabled:` arm.

*THE RESIDUE, recorded rather than claimed closed — and it CHANGED SHAPE when the transport did, rather than
closing.* As reviewed, the open site was `NowPlayingBand`'s `.btn`: two live transport buttons declaring
`border: 1px solid var(--line-strong)` over `background: var(--card2)`, which is **1.44:1** and not a disabled
state, so the inert exemption above did not reach it. That file is deleted. Its successor,
`src/lib/ui/NowPlayingStrip.svelte`, declares `border: 0` and `background: none` on `.btn`, so the under-strength
boundary is gone — **by having no boundary at all.** The three strip buttons sit on the strip's `--card` fill, and
what is left to identify them is:

- the glyph, at `--ink` on `--card` — **15.56:1**, and `--ink-dim` on `--card` when disabled, **6.27:1**;
- for play/pause ONLY, the `--accent` fill, which is **3.38:1** on `--card` and therefore clears 1.4.11's 3:1 on
  its own.

So the strongest form of the open question is now about the two FLANKING buttons, restart and skip, which carry
shape and nothing else. The argument available for them is the same one as before — an icon button whose glyph
carries the identification is not a text field, whose border is the only thing saying "type here" — and it is a
better argument here than it was against the band, because there is no weak border inviting the reader to measure
it. **Still open, and for the same reason: no file in the tree states that ruling for this site.** It is a design
ruling for the strip's owner, and it must not be settled by a test picking whichever assertion passes — against
`border: 0` there is nothing to assert. Recorded where the row used to sit, in the `BOUNDARIES` list inside
`core/tests/unit/lib/control-boundary-contrast.test.ts` — as a note and not as a row, since every row in that list is a
NEEDLE to find in a source file and `border: 0` offers none. The seven tests that follow the list still hold the rule
everywhere else, and the three above it — the per-surface contrast sweep, the hsl rounding of `--control-line`, and
`--line` still failing 3:1 — are arithmetic on the tokens and are unaffected either way. Note also that `.btn.primary` stacks `--accent-ink` on `--accent` for the play glyph, which is **2.54:1** —
below 3:1 — but that pair is certified as a pair by the design system's own token rule, so it is a palette
question and not this finding's.

*One correction to the table above, which should still reproduce and does not.* `--bg`, `--card`, `--card2` and
`--line` are unchanged since the review, so the three rows were re-derived rather than re-measured:
`--line` on `--card2` is **1.13:1**, not 1.23 — 1.23:1 is `--line` on `--card`, which is a real pair (it is the
vendored checkbox's, the one documented exception) but not this one; and `--card2` on `--bg` is **1.24:1**, not
1.09. Both corrections keep the finding — nothing here is near 3:1 — but they invert one sentence: the fill is
*higher* than the border-on-fill, not lower, so "crediting the fill does not rescue it" is true because 1.24:1
is nowhere near 3:1, not because the fill is the dimmer of the two.

### 2. The spacing ladder is not a scale

Ten rungs, linear, 2px apart from `sm` up, topping out at 20px:

```
2  4  6  8  10  12  14  16  18  20
```

Two consequences, both measured:

- **Adjacent rungs are indistinguishable.** 12 vs 14 vs 16 is not a decision anyone can make on purpose or
  perceive afterwards, so the choice is arbitrary at every site.
- **There is no large rung at all.** Across every `gap:` in routes and components, **93% (42 of 45) land
  between 4px and 12px**, and the three largest rungs are used **twice in the whole codebase**. Sections
  therefore cannot separate from each other — which is why the phone screens read as one undifferentiated
  column of boxes.

A usable ladder is geometric and reaches a real section rung (4, 8, 12, 16, 24, 32, 48). The `--space-*`
values are flat px deliberately (documented: /tv composes them against a vh-rooted root font size), and that
reason is unaffected by respacing the rungs.

**As FIXED — PARTIAL. Both consequences were acted on; the second is closed as a STEP problem and explicitly
not closed as a histogram.**

*The indistinguishable-rungs half is closed, and as a RULE rather than as a one-off respacing.* `--space-xl`
(14px, 14 rule sites) and `--space-3xl` (18px, 8 sites) are retired, each site moved into a neighbour with the
reason stated at the site. The ladder is nine rungs — **2 / 4 / 6 / 8 / 10 / 12 / 16 / 20 / 24** — and the rule
now written beside the declarations in `core/src/app.css` and in `docs/FRONTEND.md` is a **1.20 minimum adjacent
RATIO**, not "no 2px step": 2px is a perceptible 1.5× at the bottom of this ladder and an invisible 1.111× at
the top, so 8 → 10 stays. Re-derived, exactly two pairs sit on that floor (`md` → `lg`, 10 → 12, and `4xl` →
`5xl`, 20 → 24), and `md` → `lg` is recorded in `docs/FRONTEND.md` as an OPEN item rather than as doctrine —
`md` is the second-busiest rung, mostly the cluster gap inside a control row, so collapsing
it is a visual ruling and not a cleanup. The names are addresses, not indices: the two holes stay rather than
renumbering, because sliding `2xl` → `xl` would silently change what `var(--space-2xl)` means at every site
already spelling it.

*The section rung exists, and it is 24 rather than 32 or 48.* `--space-5xl`/24px is the ladder's one
INTER-surface rung; everything above it is an intra-surface register. `.list-row`'s own `margin-bottom` is 8px,
so a sibling-section boundary spending 16 gave a 2.0 ratio against the row-to-row gap, which is the arithmetic
behind "one undifferentiated column of boxes"; at 24 that ratio is 3.0. **No 32 and no 48**, and the ground is
this repo's standing rule rather than taste: the widest phone column is `--max-w` 480px, and a declared rung
that nothing spells is a defect in its own right (`--shadow-md`; the 2rem type rung that was written and
removed). The next rung is minted WITH its first caller.

*The histogram did NOT thin, and the reason is on the record so the rung count is not read as the measure.* At the
time of the retirement, **54 of 63 (85.7%)** rung-spelling `gap` / `row-gap` / `column-gap` declarations landed
wholly in 4–12px, against **53 of the same 63 (84.1%)** before it — so the band moved 1.6 points the WRONG way,
because one 14px gap came down to 12. That pair is a reading taken on THAT tree and is not recomputable on this one:
the phone-shell rebuild changed the denominator, and deleting the now-playing sheet changed it again.
`core/tests/unit/lib/space-ladder.test.ts` therefore holds a FLOOR instead — at least three quarters of those
declarations land wholly in 4–12px, under the method it states (comments stripped first, plus Tailwind
`gap-[var(--space-*)]` under `src/lib/components/ui/` since that tree is scanned and compiles to a real gap). It
cannot thin: this is a 480px-max phone column of 8px-spaced rows, and most gaps in it are supposed to be small.
What DID move is the other clause of this finding — "the three largest rungs are used **twice** in the whole
codebase" is long dead; the three largest now carry a substantial share of the ladder's spends. No tally is printed
for that any more, because the tally was the thing that rotted: the guard asserts no declared rung goes unread, and
no spelled rung is undeclared, which is what the sentence was reaching for.

Pinned by `core/tests/unit/lib/space-ladder.test.ts`: the rung list and values, the 1.20 floor plus the two NAMED
pairs that sit on it (`md` → `lg` and `4xl` → `5xl`), both retirements having no declaration / no caller / no
`@theme` alias, the bridge being 1:1, that nothing spells a rung the ladder does not declare and no declared rung
goes unread, that `md` stays among the busiest rungs by spend, and the 4–12px gap floor.

### 3. The type scale is crowded at the bottom and has a hole at the top

```
0.68  0.75  0.8  0.9  1  1.1  1.25  1.5   ·····   2.6 rem
10.9  12    12.8 14.4 16 17.6 20    24            41.6 px
```

Four rungs inside 3.5px, then a 17.6px jump from 1.5 to 2.6 with nothing in it. And `--ph-text-2xs` is
**10.9px**, which is carrying dim secondary ink (`NEEDS KARAOKE`, section eyebrows) at a size below any
reasonable legibility floor — the app's own form-control floor is 16px for a documented reason.

**As FIXED — PARTIAL. This finding named two defects; one is closed and the other was DECLINED, not missed.**
(This note was written when it was the only status note in the file and said so; every finding carries one now,
and the STATUS block at the top is the file's register.)

*The crowding is closed.* The ladder quoted above is the pre-fix tree. It now reads:

```
0.75  0.82  0.9  1  1.1  1.25  1.5   ·····   2.6 rem
12    13.12 14.4 16 17.6 20    24            41.6 px
```

`--ph-text-2xs` is DELETED — no declaration, no `--text-ph-2xs` bridge alias, and no caller: the only three
mentions left in `src` are comment prose in `app.css` recording that the rung existed. All **nine** of its rule
sites moved up onto the 12px floor (one of the nine, `GuidingTrack`'s `.lab`, has since been deleted outright
rather than resized, for a separate reason that file gives). `sm` moved `0.8` → `0.82rem` in the same pass, so
the three rungs under `base` step 1.093 / 1.098 where they used to step 1.067 / 1.125. Re-derived against the
current tree at a 16px root: this finding's four-rungs-inside-3.5px cluster is now three rungs inside 2.4px,
and the closest adjacent pair anywhere on the ladder is 1.0933 (`xs` → `sm`).

*The hole at the top is unchanged, and it is open BY RULING.* 24 → 41.6px is still a single 1.7333 step, which
is 1.44× the widest other step on the ladder (1.2, at `xl` → `2xl`), and its 17.6px in absolute terms is wider
than the whole 12px span that the seven rungs from `xs` to `2xl` share. The reason it was declined: `--ph-text-3xl`
has exactly ONE font-size site in the app — `/stats`' `.primary .n`, sitting over that same page's secondary
tiles at `2xl` — so it reads as a display size rather than as the ladder's next reading step, and an intermediate
`2rem` rung was in fact written and then removed for having no caller at all. This repo treats a declared-and-unread
token as a defect in its own right (`--shadow-md`, the refused 32px `--space` rung), so closing the ratio would
have traded a defect that can be measured for a ratio that nothing currently traverses. What stays open is
therefore the RATIO, and the standing ruling is that the next rung here is minted WITH its first caller, at which
point 1.7333 becomes a measurement worth taking. Consistent with that, the *cost* line this review gives finding
3 below prices only the bottom end — "respace the bottom four rungs, raise the 10.9px floor" — so what landed is
the whole of what was costed and half of what was named. Recorded in `core/src/app.css` beside the declarations
and in `docs/FRONTEND.md`, and pinned by `core/tests/unit/lib/type-ladder.test.ts` — so re-minting the rung reds a
test and brings this note back up for review rather than silently making it stale.

### 4. One action, two visual identities

The same verb — *put this song in the queue* — is drawn two different ways:

- search results: a **solid `--accent` purple circle** with a sparkle glyph
- library / ready rows: a **green `--ok` outlined circle** with a `+`

A guest has to learn twice. Worse, the green outline makes the screen's **primary action look like a status
badge**, since `--ok` green is simultaneously doing "Karaoke ready" duty on the same row — the ready state is
stated three times per card (card border, pill, and the button's ring).

**As FIXED — closed on both halves, and `SongRow.svelte` no longer spells `var(--ok)` at all.**

*One treatment.* Both branches of the action render `<Button variant="iconPrimary" size="icon">`, which is a
single `bg-[var(--accent)]` fill. The MARK still differs — a sparkle when the press also strips vocals, a bare
`+` when it only takes a turn — and the file argues that as deliberate rather than as the residue: the two
actions differ on three axes, so one glyph for both would dress an expensive action as a free one. The green
outlined circle is gone, so the primary action can no longer read as a status badge.

*One statement of readiness.* All three `--ok` signals this finding counted are down to the pill: the ready
row's own border is deleted (`.row.processing` keeps a border, because processing is transient and its tint is
the only pre-attentive mark of a row changing under the guest), and the button's ring went with the fill
unification. The reason the WORDED pill is the survivor is legibility rather than area — it is readable by a
guest who cannot separate `--ok` `#33d6a6` from `--warn` `#ffb84d`. The finding's own arithmetic is why this
mattered more than it looks: `/library` renders every row with `readiness="ready"`, so all three signals were on
in all of them and none discriminated anything.

*A consequence worth recording, because it is a 1.4.11 result and not a style choice.* The "already queued"
confirmation is an OUTLINE, not a dimmed fill: `opacity: 0.7` over the `--card` row would composite `--accent`
to `#5843ad`, **2.31:1**, under the 3:1 a control's boundary owes — where the fill at full strength measures
**3.38:1**. So the dim is a surface-and-ink swap inside the accent family's own certified pair, which is also
the right grammar (filled means press me, outlined means done), and it deliberately does not borrow `--ok`.

### 5. Desktop is a stretched phone, not a desktop layout

Measured at 1440×900, home:

| what | measured |
| --- | --- |
| vertical void below content | **~460px** (over half the viewport) |
| header: wordmark → identity gap | **777px** of nothing |
| dock: title → transport gap | ~1000px of nothing |
| search input width | **770px** |

Nothing re-composes as width grows; elements just get further apart. A 770px single-line text input is far
past any sane measure — and `--measure-prose: 560px` already exists as a token and is not applied to it.

**As FIXED — PARTIAL, and this is the finding where the split matters most. The headline charge — "nothing
re-composes as width grows" — is answered: one rule now re-composes at `--bp-lg`, where it was two. Of the four
table rows, ONE closed with a rule (the search input) and three were re-measured and LEFT with the reason written
down; a fifth stretch not in the table (`/`'s find row) was left the same way. Two of those four leave-it rulings
had the alternative BUILT and measured before being rejected. The readings live in `docs/FRONTEND.md` under "The
Sing tab" and "The library page" — this note quotes token arithmetic and names that file for anything in px,
rather than reprinting a browser reading it cannot re-derive.**

> **READ THIS FINDING AGAINST THE REBUILD, which landed after the fixes below.** The single-column home this
> finding measured is gone: `/` is now the Sing tab of three, and the bottom chrome is a fixed `.dock` holding a
> strip and a tab bar where it was an 87px `.band-slot`. Three consequences, and only one of them is good news:
>
> 1. **The chrome went from ONE height to TWO, which is the whole of the geometric change — and the direction
>    depends on which.** The band rendered for anyone who had joined, at an 87px `.band-slot` whose top edge was
>    813 at 1440×900. The strip renders only when there is something to act on, so the dock is 91px with its top
>    edge at **809** in a room with a song playing or queued, and 46px with its top edge at **854** in an idle
>    one — both measured, and both asserted by `measured-dock.spec.ts`. So a gap to the chrome shrank 4px in a
>    live room and GREW 41px in an idle one. No content moved for this reason in either: the floor moved, twice.
> 2. **One of the two `--bp-lg` re-compositions was deleted with the shelf it served.** See the re-composition
>    note below, which now describes one rule rather than two.
> 3. **The void did not close by a pixel.** See the void note, re-measured on the rebuilt tab.
>
> What the rebuild did NOT touch is the desktop charge itself. A tab bar is phone chrome: it adds no desktop
> track, re-composes nothing as width grows, and at 1440×900 the dock is 1440px wide with 1080px rows
> (`--max-w`) — so it inherits the same centred cap the shell already had. Nothing in this finding is answered by
> the rebuild and nothing in it is made worse.

*The search input closed, and unconditionally.* `--measure-prose` now has its first caller: `.field-slot` on `/`
and its twin on `/library` both carry `max-width: var(--measure-prose)`, with **no** `@media` — a `max-width`
can only ever take space back, so every width the app was designed on sees byte-identical geometry and there is
no breakpoint to get wrong. The cap cannot bind until the row passes the cluster's own arithmetic, re-added here
from three tokens and one reading: `--tap` 44 door + `--measure-prose` 560 findbox + the picker's measured 122 +
two `--space-md` gaps = **746px**.

*Something does re-compose now, which is the finding's actual charge — ONE rule, where this note used to claim
two.* `/library`'s head adopts the row grid from `--bp-lg` through a `.lib-meta` wrapper: the field lands on track
one, the count and the refine disclosure on track two, so both halves sit over the songs they describe. Below the
arm the wrapper is `display: contents` and charges nothing. That rule is live and pinned.

*The second rule is GONE, and this is the one place that says so rather than leaving a fixed claim standing over a
deleted feature.* The home column's library shelf took `LIBRARY_SHELF_WIDE` (= `LIBRARY_SHELF * 2` = 8) in place of
the phone's 4 at `--bp-lg`, spending the same height budget two tracks across, picked from a `matchMedia` read
rather than from CSS because the extra rows did not exist in the DOM for a stylesheet to reveal. The rebuild
deleted the shelf: browsing is the Library tab's job, the Sing tab reads no viewport width in JS at all, and the
`matchMedia` call went with the shelf. So **this finding's wide-shelf fix no longer exists**, and the honest
accounting is that it was obsoleted rather than reverted — the charge it answered ("nothing re-composes") is now
answered by one rule instead of two, and the same width it was spending is spent by `/library`'s two-column row
grid, which is where eight ready rows actually land now. The loose end this note recorded — `libraryShelf`,
`LIBRARY_SHELF` and `LIBRARY_SHELF_WIDE` surviving in `core/src/lib/library-browse.ts` with unit tests and **no
production consumer** — has since been **closed by deleting all three**, along with the four tests that had become
assertions about `slice` alone. `libraryWindow` is the survivor in that module and has a real caller.

*The header gap was argued and LEFT, on a reason this document will recognise.* Leading brand / trailing account
is a desktop header form, and from `--bp-md` the topbar carries a `--line` bottom rule so the split reads as the
two ends of one surface rather than as two things floating in page. Nor is the gap a constant: `.me-cluster` is
`margin-left: auto`, so its width is a function of the singer's display name — which is the same refutation this
review applies to itself in the tablet section below.

*The dock gap was LEFT on the same arithmetic this review used to refute its own dead-space error, and the
refutation got STRONGER when the band became the strip.* `.meta` is still `flex: 1 1 auto; min-width: 0` holding a
`nowrap`/ellipsis title, so the width is the title's OWN box: re-measured at 1440×900 it is **906px**, well under
the ~1000px stated here, and a long title uses all of it. There is no structural gap to close — exactly the
refutation the "401px of dead space" bullet below makes against itself. `min-width: 0` is the load-bearing half:
without it the nowrap title refuses to shrink below its content, which is how the dock overflowed its own 320px
box before the grid track was fixed.

*The void was re-measured TWICE — once against the fix, once against the rebuild — and NOT reduced either time,
because it is CONTENT-bound.* As fixed, against the measurement copy's catalog (then 123 media rows, 2 `ready`, and
`/api/library` serving `listReady()` only): the shelf held two rows, under the PHONE cap of four, so
`libraryShelf(rows, 8)` and `libraryShelf(rows, 4)` both returned two shown and none hidden and the wide cap
provably moved none of it. The one candidate — handing the empty rotation the leftover height at `--bp-lg` — was
BUILT and measured and made it worse: two voids where there had been one.

**And after the rebuild, re-measured in a browser at 1440×900 on the Sing tab, joined, no query: NOT ONE PIXEL
CLOSED.** The shelf and the empty rotation are both gone; what is left above the fold is a find row and one idle
block, which is `min-height: 32vh` (**288px** at this height), starts at y=173 and ends at **y=461**. The gap above
the chrome now has TWO readings, because the dock does: with a song playing or queued the dock is 91px, its top
edge **809**, and **348px** separate the last content from it; in an idle ROOM the strip does not render, the dock
is 46px, its top edge **854**, and the gap is **393px**. The earlier version of this paragraph said "queue empty"
and quoted 348, which is the strip-PRESENT figure — the two states differ by exactly the strip's 45px and the doc
has to name which. Compare the fixed reading, which was 403.4 to a band top of 835 — 431.6px. (835 and the 813 in
the blockquote above are two readings of the same chrome taken on different trees, the band having changed height
between them; neither is re-derivable now, because `NowPlayingBand` is deleted. They are kept as the history they
are, not as a live measurement.) The shape of the
answer is unchanged: a void of a few hundred pixels, measured against a floor that moved and content that moved
because the page was rebuilt, not because the void was addressed. **The ~460px headline is now an OVERSTATEMENT and
this is the correction:** the three bounds it has to sit between are the gap to a 91px dock, **348px**, the gap to a
46px one, **393px**, and the gap to the viewport floor, **439px** (900 − 461) — which is the only one of the three
the dock's state does not move. 460 is above all three. It was a fair reading of the page it was taken on — 431.6px
to the band, with a viewport-floor gap larger still — and it is 21px past the loosest bound on the page that exists
now. Read the finding as "a void of 350–440px depending on which floor you measure to"; the charge is unaffected,
because nothing in that range is defensible as composition, but the specific number should not be requoted.

**The void is a CONTENT bound and it does not close on its own, which the rebuild makes harder to wish away rather
than easier.** The owner confirmed (2026-10-03) that the stem-less rows are benchmarking junk, so a small ready
library is the STEADY STATE and not a backlog that drains: the low-content composition is the case to design for,
not an edge case to wait out. The Sing tab also makes the gap honest in a way the home column did not — its whole
job is "type a name", so there is nothing being withheld from the space. That is a defensible answer to this
finding, and it is a different answer from the one the fix gave; what is NOT defensible is calling the void closed.

*And one thing the measure cap does NOT do, recorded because the alternative was built:* `/`'s find row does not
spend the column — a stretch of it trails the picker empty under a hairline that spans the whole content box.
Pushing `.source-slot` to the trailing edge at `--bp-lg` was tried and measured, and it reads as an orphaned
control: the topbar's split works because each end carries a whole thing, and a `<select>` divorced from the
field whose scope it sets is not one. So the row stays a LEADING-ANCHORED CLUSTER of three — a composition, with
the field's leading edge on the same line every row, eyebrow and empty state below it starts from. `/library`'s
head could do better because it has a second thing to put in the width; this row does not.

Pinned by `core/tests/unit/lib/library-wide-head.test.ts` (the arm being a `--bp-*` member, both halves placed
explicitly, `.lib-meta` staying `display: contents` outside the arm, the panel staying collapsed by default).

### 6. The join gate sits in two different places

The identical gate is **top-aligned on `/`** and **vertically centred on `/library`**. Same component, two
placements, depending only on which route you land on.

**As FIXED — and this one is GATED, which the fix needed more than most.** The cause was the host, not the
component: `/` renders `<JoinLanding />` inside the home route's `main`, `/library` renders it as a direct child
of `.app-shell` with no `main` at all, and the route's own `main { flex: 1 }` absorbed the free space that
`.app-shell:has(.join-main) { justify-content: center }` wanted to distribute. So the ≥768 centring worked on
`/library` and silently did nothing on `/`. The fix is in JoinLanding's own stylesheet — the route may not state
the gate's placement — and it rests on `:global(.app-shell > main:has(.join-main))` scoring 0,2,1 so it beats the
route's scoped `main` rule at 0,1,1, whose chunk loads LATER and would otherwise win the tie. `padding: 0` is
part of the same declaration and not tidiness: the route's padding is a placement the gate did not choose and the
other host does not get.

`core/tests/playwright/specs/gate/measured-join-gate.spec.ts` holds it as CLAIM 7, in the `gate` project so it
runs in `bun run gates`. It asserts more than the placement being EQUAL across hosts, and the reason is a
mutation run: deleting `justify-content: center` leaves both hosts agreeing perfectly on a top-aligned gate, so
an equality-only check passes on a broken tree. The absolute half is therefore asserted too — from `--bp-md` up
the free space above the gate equals the free space below it ON EACH HOST and is non-zero; below it the brand
band sits at the shell's content top and the CTA is docked by `.join-main`'s own bottom inset, read off the DOM.
Two premises are asserted rather than assumed: that the hosts are still different, and that the host `main` is
really neutralised. And the arm widths straddle 767/768 while reading `--bp-md` off `:root`, which ties
JoinLanding's `@media (min-width: 768px)` to the token in both directions. **What it holds is the RELATIONS, not
the digits:** change a spacing rung and the recorded y-positions move again with nothing red; what cannot happen
again is the two hosts drifting apart, the centring switching at the wrong width, or the route winning the
cascade back.

Still un-gated, deliberately: `.submit-slot`'s sticky offset only matters when a soft keyboard shrinks the
layout viewport, and headless Chromium has no soft keyboard to drive `interactive-widget=resizes-content` with.
Recorded in `docs/FRONTEND.md` and in the rule's own comment instead of proxied weakly.

### 7. Two label styles inside one card

In settings → You, two adjacent fields: **"Name"** is sentence case, regular weight, `--ink-dim`. **"YOUR
COLOR"** is uppercase, letterspaced, a rung smaller. Neither is wrong; having both eight pixels apart is.

**As FIXED — on the DRESS and on the WORDING, which turned out to be two rules and not one.**

*One dress.* Both labels in that card now resolve to the same declarations. `Your name` goes through
`<Field.Label>`, i.e. `label.svelte`'s `text-[length:var(--ph-text-md)] font-medium`; the colour disc's heading
is `app.css`'s `.control-label`, which is `--ph-text-md` / weight 500 / `--ink-dim`. Re-derived: that is 0.9rem =
**14.4px** at a 16px root on both, with no `text-transform` and no `letter-spacing` on either. The uppercase
letterspaced eyebrow is not restyled but DELETED as a register inside a field label — the one other place it
survived inside a real `[data-slot='field-label']` was `GuidingTrack`'s rail label, and its `<span class="lab">`
is gone with it. That row kept its rank by moving the VALUE up a rung instead, so weight and ink carry the
hierarchy and the two tiers never meet inside one label.

*One wording rule, which is the half this finding did not name.* A field label takes the second person exactly
when the value is the singer's OWN, and stays a bare noun for anything the room or the box owns. /settings was
the single divergent surface on both strings: `Name` → `Your name`, and `label="Color"` → `label="Your color"` —
where `ColourRing`'s own DEFAULT prop was already `'Your color'`, so the route was overriding the rule away. The
string is also the accessible NAME (one `label` prop feeds both the visible heading and the disc's `aria-label`),
which is why the direction was possessive rather than stripping both to bare nouns.

Pinned by `core/tests/unit/lib/label-register.test.ts`: the dress, the absence of `text-transform` /
`letter-spacing` / `class="lab"` in that file, the rule that no class dressed with `text-transform: uppercase` may
sit on or inside a `<Field.Label>` or a `.control-label` anywhere in the tree — checked per ELEMENT, in markup and
inline styles, with this defect's own shape as a fixture so the check cannot go vacuous — and "nothing the room owns
takes `Your`". It no longer enumerates the register's surviving rows: that list reddened whenever the app grew a
section heading, and it had already gone false.

### 8. Dual commit with no stated difference

The same pane offers **"Save"** (secondary, rendered dim enough to read as disabled) and **"Done"** (full
`--accent` primary). Nothing says whether Done also saves, so the safe reading is "press both" — and that is
the reading a guest will take at a party.

**As FIXED — one commit control for the pane, whose LABEL says which of its two jobs it is doing:** `Saving…`
while in flight, `Save and close` while the form is dirty, `Done` when it is not. The second control is deleted,
not restyled. The reason it was worse than a style problem is the one this finding could not see from outside:
the panel-level `Done` was a bare `goto('/')`, so pressing it DISCARDED the typed name and the picked colour with
nothing on screen saying so. The survivor stays INSIDE the card, because the refusals it produces name that field
("That name is taken — try another.") and a reason belongs beside what has to be corrected. The cost kept
deliberately is that the panel now ends on the destructive Leaving card rather than on its own exit.

## Checked and refuted

Recorded because the reasons are load-bearing, and two of them were my own errors.

- **7 token pairs "fail" AA for text — all are `--accent`.** `FRONTEND.md` already forbids `--accent` as ink
  and ships `--accent-ink` as its text pair *precisely because* it fails. My check re-derived the existing
  rule. The text palette is genuinely clean: **56 of 63 pairs pass AA**.
- **"401px of dead space inside tablet rows" — wrong, my error.** I measured from the end of the *glyphs*.
  The title **box** does grow with the container. Re-measured in a browser on `/library` after the rebuild, the
  `.title-line` box is **148px** at 390 → **518px** at 768/900 → **322px** at 1200 and at 1440 (two columns). Long
  titles use that width. There is no structural dead space. The reading that produced the error is the one to keep
  hold of: the glyph run itself (`.t`) is **124.97px** at every one of those widths, because the seeded title is the
  same string and `white-space: normal` lets it wrap rather than ellipsise. Box grows, glyphs do not — measuring the
  second and reporting it as the first is the whole of the mistake. (These are 4px above the figures first published
  here, which were 144 / 514 / 321; `SongRow` took a padding change in the rebuild wave. The shape of the curve is
  what the refutation rests on and the shape is identical.)
- **"Only 2 of 104 songs in the library" — correct behaviour.** 102 rows have `stem_status=none`; no worker
  has processed them. `/library` honestly reports "2 songs". (As re-derived: the catalog has grown and the ratio
  has not grown with it. The owner's `data/encore.sqlite` holds **384** media rows, **379** `none` and **5**
  `ready`; the measurement copy every px reading was taken against holds **180** / **178** / **2**. The refutation
  is unaffected — `/api/library` serves `listReady()` only — but "2 of 104" is now 5 of 384 on the live box, and
  finding 5's void reading above depends only on the READY half, since a cap of 4 or 8 cannot bind on two rows.
  The ready counts are the stable term; both totals and therefore both ratios are snapshots, as the status block
  at the top of this file says at length.)

## The tablet question, revised

`UI-REVIEW.md` left the 768–1199px single-column stretch open, and I had put the choice as *centre the 440px
track* vs *accept ~339px columns*. **Both were premised on my dead-space error.** With the title box
measured growing to 518px, the stretch costs nothing structural — the width goes to the text, which long
titles need and which the 440px floor exists to protect.

**Recommendation: leave it.** Squeezing to two ~339px columns would truncate titles to buy density the room
doesn't need, and it would overturn a measured decision. The only residual cost is that a *short* title
leaves a wide gap before its `+` button — an argument for moving the action nearer the content, not for
reflowing the grid.

**THE REBUILD DOES NOT REACH THIS RULING, stated explicitly because the rebuild touched almost everything else.**
This section's premise is `SongRow`'s title box growing with its container, and that premise was re-derived above
on the post-rebuild tree: 148 → 518 → 322 across 390 / 768 / 1200, with the row itself going 326 → 696 → 500 as the
`--bp-lg` two-column grid arrives and NARROWS each track. The three tabs are phone chrome and add no track at this
width; `SongRow` itself was not restructured. So "leave it" holds on its original reasoning, unamended. The one
thing worth re-reading when somebody next opens this question is the narrowing at 1200: a reader who measures only
768 sees a box that grows monotonically, and the actual curve peaks at tablet and falls.

## Ranked, with cost

This table is the review's own estimate at the time of writing, kept as such. One cell is not just a stale
estimate but an active mis-prescription and is corrected in place; the rest are annotated where what landed
differed from what was costed.

| # | finding | cost |
| --- | --- | --- |
| 1 | form-control contrast (1.4.11) | ~~one token, `--line` → ≥3:1 on `--card2`~~ — **WRONG, and now a red test.** `--line` is the card edge, list-row rule, table-head rule, tab strip, chip, spinner and skeleton across the app; brightening it repaints all of that to fix six borders, and `control-boundary-contrast.test.ts` asserts `--line` stays `#2a2a3e` and stays under 3:1. It was one token, but a NEW one: `--control-line`. See finding 1. |
| 4 | one action, two identities | pick one treatment; delete the duplicate ready signals |
| 2 | spacing ladder | respace rungs, add a section rung; mechanical but touches many files — *landed as a 1.20 ratio FLOOR plus `--space-5xl`/24 as the one section rung; the 32 and 48 this finding names were refused, and the "many files" was 22 rule sites* |
| 5 | desktop composition | real design work — the only item here that is not a small diff — *and correctly priced: one of its four rows closed with a rule, three were re-measured and left, and the re-composition it asked for arrived as `--bp-lg` rules rather than as a respacing. Since re-priced by events: the phone rebuild deleted one of those two rules along with the home shelf it served, so the landed answer is now one rule. The desktop charge itself is untouched — see the note under the finding* |
| 3 | type scale | respace the bottom four rungs, raise the 10.9px floor — *this line prices only the bottom end, which is why what landed is the whole of what was costed and half of what was named* |
| 6 | join gate placement | one alignment rule — *plus the `:has()`/specificity stack that stops the host absorbing what it distributes, and a gate, because the equality alone could not fail* |
| 7 | two label styles | pick one — *it was two rules: one dress and one wording register* |
| 8 | dual commit | delete "Save", or say what each does — *both: one control, three labels* |

## Not covered

`/metrics`, `/stats`, `/admin` and `/song/[mediaId]` were captured but reviewed only for the cross-cutting
scale and contrast items; they have not had a page-level design pass. Motion, loading/skeleton states and
error states were not reviewed — the frame table drives every frame into a settled state by design, so
transient states are invisible to this evidence base.
