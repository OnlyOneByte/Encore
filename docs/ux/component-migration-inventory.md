# 08 — Component migration inventory

> The per-surface state behind [`component-migration.md`](component-migration.md). Every
> hand-rolled element in the non-TV tree appears here exactly once, mapped to a **Target** or an
> **EXCEPTION** with its reason and the guard that pins it (LIB-04).
>
> Audited against the working tree on **2026-09-14**. Line numbers are from that tree; treat them as
> a starting point, not a contract. The TV tree (`src/routes/tv/**`, `src/lib/tv/**`) is exempt by name
> (LIB-02) and is not listed.

## Legend

| Mark | Meaning |
|---|---|
| ✅ | Already on a primitive. No action. |
| ▶ | Migrate. Target named. |
| ⚠ | Migrate, but a named blocker must be cleared first. |
| 🔒 | **EXCEPTION** — stays hand-rolled. Reason + pin required. |
| 🐞 | Defect, independent of migration. |

> **Which status wins.** The ✅/▶/⚠/🔒 marks in sections 1–5 record the state at the **audit**
> (2026-09-14, before any migration). They are kept because the *reasoning* in each row — why a target
> fits, why an exception holds — is what a future step needs, and that has not changed. For **current**
> status, [`## Done, and what is left`](#done-and-what-is-left) at the foot of this file is
> authoritative. Where the two disagree, the foot of the file is right.
>
> **The line numbers are from the audit tree and are approximate.** They were taken before trunk
> flattened `apps/core/src/` to `src/`, and spot-checking found two that now point at unrelated code.
> Treat them as "roughly here", and search for the class instead.

## Vendored today (23)

alert · alert-dialog · badge · button · card · chart · checkbox · collapsible · empty · field · input ·
item · label · native-select · progress · skeleton · slider · sonner · spinner · switch · table · tabs ·
textarea

`alert`, `alert-dialog`, `switch` and `textarea` were added by the migration and each is wired to a real
call site.

## Required, not yet vendored (LIB-19)

| Component | Call sites waiting on it |
|---|---|
| `radio-group` | `ColourPicker`'s swatch grid |
| `button-group` | hero transport · ∓semitone pair · `/admin`'s confirm cluster |
| `input-group` | the search dock's leading icon |
| `input-otp` | `CodeEntry`'s six segments |

Vendored since the first draft: `alert-dialog` (the leave-the-room confirm), `alert` (six banners),
`switch` (the three room booleans), `textarea` (`LyricsReselect`'s paste path).

**`separator` was on this list and should not have been.** Both call sites the draft named are fictional,
and I carried them into the reconciliation without checking — the correction is recorded here rather than
quietly dropped. `/metrics` has no divider at all: no `<hr>`, no `role="separator"`, and no `border-top`
or `border-bottom` anywhere in the route. `JoinLanding`'s `.or` is centred dim text with no rule drawn —
making it a labelled rule would ADD two lines to the join screen, which is a design change, not a
migration. Vendoring it today would leave a primitive wired to nothing, which LIB-19 exists to prevent.

> **Note on `toggle-group`.** The readiness chips and facet rails that would have used it were
> **deleted when the chip family was consolidated**; every surviving `.chip` in `routes/+page.svelte` is a button. Vendor it only
> when a real segmented control appears, per "vendored but unwired reads as migrated when it is not".

---

## P0 — all four closed

| # | Where | What it was | Closed by |
|---|---|---|---|
| 1 | `src/routes/admin/+page.svelte` | `color: var(--muted, #8a8a8a)` ×4 — a **surface** token as ink, ~1.3:1. The fallback never fired because `--muted` is defined. | trunk's `/admin` primitive pass |
| 2 | `src/routes/settings/+page.svelte` | each `Tabs.Content` wrapped in a second `role="tabpanel"` — two panels per tab | attributes dropped; the guard re-anchored to catch the nesting |
| 3 | `src/routes/settings/+page.svelte` | destructive confirm with no `role="dialog"`, focus trap or Escape | `alert-dialog` vendored, flow ported |
| 4 | `src/routes/admin/+page.svelte` | bare `button {}` element rule → unused selector once migrated | deleted with the `/admin` pass |

## 1. Composites

### `lib/components/NowPlayingHero.svelte`

| Mark | Element | Line | Target / reason |
|---|---|---|---|
| ✅ | Transport buttons | 122, 125, 133 | `Button` (`outline` / `iconPrimary`, `size="icon"`) |
| ✅ | Disclosure | 150, 160 | `Collapsible.Root` / `.Content` |
| ⚠ | **Progress track + fill** `.track` + `<i>` | 109 | `Progress`. **Blocker:** needs the `--motion-tick` transition and the reduced-motion override (CSS 272–276) that `motion.test.ts` enforces. Third copy of an idiom already consolidated twice. |
| ▶ | Disclosure trigger `.tools-toggle` | 153 | `Button variant="ghost"` inside the existing `Collapsible.Trigger` `child` snippet |
| ▶ | Collapsed peek `.tools-peek` | 156 | `Badge variant="tag"` — verify truncation survives; it is a summary string, not a token |
| 🔒 | Identity dot `.dot` | 93 | Custom-prop colour + a `flex:0 0 auto` collapse guard (added after the dot collapsed in a narrow row) a primitive would drop. Pinned by `design-system.test.ts`. |
| 🔒 | `.time` / `.time.r` | 108, 110 | `tabular-nums` + reserved `min-width:30px` so the row does not jitter. No target. |
| 🔒 | `.song` (h1), `.byline` | 97, 99 | Document semantics; `Card.Title` is not an `h1`. |
| 🔒 | `.tools-note` | 173 | Sibling-not-child on purpose: the parent dims and this must not. Pinned by XR-PH-03. |
| 🔒 | Transport cluster `.transport` | 121 | Three independent commands, not a selection set — `ToggleGroup` would be wrong. |
| 🔒 | Shell `.hero card` | 87 | Test-attributed surface. Pinned by `ui-card-surface-913.test.ts` (LIB-09). |

### `lib/components/ProcessingCard.svelte`

| Mark | Element | Line | Target / reason |
|---|---|---|---|
| ✅ | Reorder / remove buttons | 134, 137, 142 | `Button` |
| ✅ | Progress bar | 155 | `Progress` |
| ✅ | Row grammar | 98, 132 | `Item.Root` / `.Actions` |
| 🔒 | `.seq` colours | 107 | Box moved to `Item.Media`; colours stay because `contrast.test.ts` attributes them to this file. |
| 🔒 | Identity dot `.who i` | 124 | As hero. Pinned by `design-system.test.ts`. |
| 🔒 | `.away`, `.adding` | 125 | Inline `·`-prefixed text, deliberately **not** pills — `Badge` would change appearance. |
| 🔒 | `.stage`, `.stage bad` | 153, 156 | Full-bleed tinted line with `aria-live="polite"`; `Badge` would shrink it. |
| 🔒 | `pending` / `failed` / `dimmed` | 100–106 | Must be surface tints, never `opacity` (LIB-15). `class:` invalid on a component (LIB-08). |

### `lib/components/QueueRow.svelte` — furthest along; no raw `<button>` remains

| Mark | Element | Line | Target / reason |
|---|---|---|---|
| ✅ | Reorder / remove / **drag grip** | 147, 150, 155, 174 | `Button`. Grip must stay a **sibling** of the reorder pair, never a wrapper, never in an `{:else}` (XR-PH-17). |
| ✅ | Row grammar | 119, 145 | `Item.*` |
| 🔒 | Five state classes `mine` `up` `pending` `dimmed` `moving` | 124–128 | LIB-08; drag offset arrives as a custom property with no primitive equivalent. |
| 🔒 | `.pop-in` | 123 | Shares a global `@keyframes pop`; re-declaring it locally is forbidden, because two copies drift. |
| 🔒 | `.seq` colours, `.who i`, `.away`, `.adding` | 131, 139–141 | As `ProcessingCard`. |

### `lib/components/SongRow.svelte` — largest, least migrated

| Mark | Element | Line | Target / reason |
|---|---|---|---|
| ✅ | Six chip families | 316–334 | `Badge` (incl. the `variant="bad" wrap` pairing) |
| ✅ | Progress bar | 339 | `Progress size="sm"` |
| ⚠ | **Primary `.sing`** | 359–367 | `Button`. **Blocker:** `.sing` is addressed by `tests/e2e/contract.ts`; the class name must survive the swap (LIB-10). Drops `border-radius:12px` + `font-size:20px` + `scale(.94)`. |
| ⚠ | **Secondary `.add`** | 369–382 | `Button variant="outline"`, disabled state. Same guard. Three visual states; `unavailable` must not wear "go" clothes. |
| ⚠ | Thumbnail `.thumb` | 279 | `AspectRatio ratio={16/9}` (84×47, must match `mqdefault` 320×180). **Blocker:** `contrast.test.ts` attributes `.thumb`'s background to this file. |
| 🔒 | Duration overlay `.dur` | 292 | Absolutely positioned over a photo with `--scrim-strong`; `Badge` is not positionable, and the `#fff` is a documented photo-overlay exception. |
| 🔒 | Thumb placeholder `.ph` | 289 | A **permanent** no-artwork state, not a loading shimmer — `Skeleton` would be semantically wrong. |
| 🔒 | `.title-line` / `.t` | 303, 304 | Two-line clamp geometry fixed by an earlier defect: the mark must be a **sibling** of `.t`, not a descendant. |
| 🔒 | Native `title=` tooltips | 363–365, 374–378 | Never fires on touch. `Tooltip` is a behaviour change needing its own decision (LIB-18). |

### `lib/components/MyPositionCard.svelte` — zero primitives

| Mark | Element | Line | Target / reason |
|---|---|---|---|
| ▶ | Whole card as a row | 24 | `Item` — `.mine` is already flex/center/gap, which is Item's grammar. Best fit in the file. |
| 🔒 | `.big` ordinal | 25 | 2xl display numeral in `--accent2` carrying a measured contrast rationale (6.05:1 / 5.92:1) a primitive would not preserve. |
| 🔒 | `.wait` clause | 30 | Its **absence must be the absence of a line** — no zero, no "calculating…". |
| 🔒 | Gradient tint | CSS 44–45 | Paired with `QueueRow`'s `.mine` by design. |

### `lib/components/JoinLanding.svelte`

| Mark | Element | Line | Target / reason |
|---|---|---|---|
| ✅ | Name input | 180 | `Input variant="join"` |
| ✅ | Primary CTA | 210 | `Button size="blockLg"` |
| ▶ | **Scan-hint card** `.scan-row card` | 162–168 | `Card.Root` + `Item.Media` / `.Content` / `.Title` / `.Description`. Cleanest greenfield Item adoption in the app. |
| ⚠ | Error block `.err` | 157, 194 | `alert` — **not vendored** (LIB-19). Two call sites. |
| 🔒 | "or" rule `.or` | — | **Not a rule.** Centred dim text, no lines drawn. `separator` would ADD two, which is a design change rather than a migration. |
| 🔒 | `.cta-reason` | 200 | `role="status"` + `aria-live`, SC 3.3.2. |
| 🔒 | `.submit-slot` | 197 | Reserves height so the reason line cannot shift the CTA. |

---

## 2. Big routes

### `routes/+page.svelte` — **does not import `Button`**

| Mark | Element | Line | Target |
|---|---|---|---|
| ✅ | 3 `Empty`, 3 `Skeleton`, 1 `Spinner`, `Toaster` | 1380, 1520, 1587, 1510–1513, 1634, 1643 | already primitives |
| ✅ | `.range-toggle` disclosure semantics | 1300 | `Collapsible` owns `aria-expanded` |
| ▶ | `.key-btn` ∓semitone steppers | 1276, 1282 | `Button variant="outline" size="icon"` (+ `button-group` for the pair) |
| ▶ | `.range-toggle` trigger | 1303 | `Button variant="ghost"` via the `child` snippet |
| ▶ | `.chip` Done / Cancel | 1369, 1370 | `Button variant="secondary"` / `"ghost"`, `size="sm"` — kills the **22px** radius |
| ▶ | `.back-btn` | 1496 | `Button variant="ghost" size="sm"` |
| ▶ | `.chip ok chip-icon` "Show all" | 1594 | `Button variant="secondary" size="sm"`, moved into `Empty.Content` |
| ▶ | `.me-btn`, `.gear` anchors | 1199, 1209 | `Button variant="ghost"` / `size="icon"` with `href` |
| ▶ | `.offline-pill` | 1183 | `Badge variant="secondary"`, keep `role="status"` |
| ⚠ | Search `<input>` | 1628 | `Input` (+ `input-group` for the leading icon). **Blocker:** the documented `flex:1; min-width:0` and 44px tap rules must survive. |
| 🔒 | `.dropslot` | 1404 | A drop **zone**, not a button; deliberately bespoke (documented 1776–1781). |
| 🔒 | `.search-dock` `border-top` | 1927 | Dock chrome, not a semantic rule — `Separator` would be wrong. |
| 🐞 | `.skel-row` radius `14px` | 2194 | Off-scale; tokenise. |

> No overlay of any kind survives in this file: `role="dialog"` count is **0**. The profile sheet,
> queue sheet and drawer have since been deleted. The `.reorder-bar` mode (1366) is the nearest thing
> and has **no Escape route** — if it should be dismissible, that is a separate defect.

### `routes/settings/+page.svelte` — 9 primitives imported, 1 `<Button>` used

| Mark | Element | Line | Target |
|---|---|---|---|
| ✅ | 13 `NativeSelect`, 8 `Slider`, 3 `Checkbox`, 2 `Input`, `Tabs` | — | already primitives |
| ▶ | `.done` ×3 | 544, 937, 1146 | `Button size="block"` — **finish** the migration the CSS comment at 1376 says already happened |
| ▶ | `.leave`, `.leave.confirm` | 525, 531 | `Button variant="destructive"` inside `AlertDialog.Action` — kills a **14px** radius |
| ▶ | `.stay` | 530 | `Button variant="secondary"` in `AlertDialog.Cancel` — kills a **14px** radius |
| ▶ | `.disclose` | 1079 | `Button variant="ghost"` via the `child` snippet |
| ▶ | `.dash` anchors + `.dash-note` | 932, 1141 | `Button variant="outline"` with `href`; note → `Badge variant="secondary"` |
| ▶ | `<label class="check">` ×3 | 722, 913, 1092 | `Field.Label` / `Label` — the CSS comment at 1322 already says so |
| ⚠ | 4 prose `role="alert"` banners | 450, 501, 528, 1062 | `alert` / `Field.Error` — **not vendored** |
| ⚠ | `<input type="color">` | 690 | No colour primitive exists. Either wrap in `Input type="color"` for the focus contract, or reuse the already-imported `ColourPicker`. Preserve the deliberate split `oninput`/`onchange`. |
| ▶ | Missing loading affordance | — | `Skeleton` — the page renders server settings on load with none |

---

## 3. Small components

| Mark | File · element | Line | Target / reason |
|---|---|---|---|
| ✅ | `GuidingTrack` slider | 37–48 | `Slider variant="guiding"` — the **reference** migrated control |
| ▶ | `LyricsReselect` disclosure | 67–71 | `Collapsible.Root` / `.Trigger` — hand-rolled `aria-expanded` + manual chevron is exactly what it owns |
| ▶ | `LyricsReselect` candidate rows | 75–90 | `Item.Group` + `Item.*`; `.opt-badge` → `Badge variant="accent"` |
| ▶ | `LyricsReselect` `.chip` ×2, `.reselect-paste-open` | 102, 103, 107 | `Button` / `variant="ghost"`. Note these are **already half-styled from `app.css`'s global `.chip`** — no base rule exists locally. |
| ⚠ | `LyricsReselect` textarea | 94–100 | `textarea` — **not vendored**; `ui/input` is `<input>` only |
| ▶ | `PageHeader` `.back` | 35 | `Button variant="ghost" size="icon" href=…` — `size="icon"` is byte-for-byte `size-tap grid place-items-center`, which is what the class already does. **Lowest-risk, highest-reach change in the audit.** Keep `margin-left:-10px` local; verify the ring stays `--focus`, not `--accent`. |
| ▶ | `Bars` `.track` / `.fill` | 51–53 | `Progress`. **Blocker:** `.fill` paints the ChartStyle series colour `var(--color-plays, var(--grad))`; shadcn Progress hardcodes `bg-primary` on its indicator. |
| 🔒 | `ColourPicker` hue range | 166–178 | Three load-bearing reasons: the track **is** a 9-stop `oklch` gradient on `::-webkit-slider-runnable-track` / `::-moz-range-track`; the thumb shows the picked colour via `var(--singer)`; `touch-action:none` stops the profile sheet stealing the drag. `ui/slider` is div-based. |
| 🔒 | `ColourPicker` swatch radiogroup | 141–157 | `radio-group` not vendored; each swatch is a colour surface with inline `background`, which `Button` would fight. |
| 🔒 | `ColourPicker` `.field-label` / `.field-hint` | 135, 139 | Label a `role="radiogroup"` with its own `aria-label` — a `<label>` with no control would be wrong (documented 199–205). |
| 🔒 | `CodeEntry` `.code-note` | 164–170 | **One** `role="status" aria-live` region alternating SC 3.3.1 rejection and SC 3.3.2 progress. `Field.Description` + `Field.Error` are two slots and would break the single-region contract. |
| ⚠ | `CodeEntry` six `.segment card` | 141–154 | `input-otp` — **not vendored**. Not a drop-in for `Input`: shadcn's `h-9 px-3 text-base` collides with `aspect-ratio:3/4`, `padding:0` and `--ph-text-xl`, and `card` would double the surface. |
| 🔒 | `RangeBar` — **entire component** | all | Four superimposed layers (zones, axis, histogram, whiskers, lives-here), `aria-hidden="true"`, no series to plot. `Progress` is single-value; `Chart` would add nothing. |
| 🔒 | `Trend` `.bar` | 72 | Vertical, and `.missing .bar` needs `height:2px !important` to beat an inline `style:height` — a component's internals cannot host that. |
| 🔒 | `Trend` `.readout` | 75 | Fires on plain `:focus` **as well as** `:focus-visible`, because a touch tap does not match the latter. Bits UI Tooltip would regress the phone path (LIB-18). |
| 🔒 | `Trend` `.col` | 65–76 | Full-height `align-items:flex-end` container; 109–116 already strips native button chrome that `Button` would re-add. |

---

## 4. Secondary routes

| Mark | File · element | Line | Target / reason |
|---|---|---|---|
| ✅ | `stats`, `metrics`, `[mediaId]` cards / tables / chips | — | `Card.*`, `Table.*`, `Badge`, `Bars`, `Trend` |
| ▶ | 11 hand-rolled empty / loading states | stats 58, 60 · metrics 115, 117, 157, 207, 258, 342 · `[mediaId]` 132, 134, 161 · admin 101, 103, 105 | `Empty` / `Skeleton`, preserving each `role="alert"` / `role="status"` |
| ▶ | `.flag` "few runs" ×3 | metrics 177, 224, 275 | `Badge variant="warn"` — exact match |
| ▶ | `.retry`, `.suspect` | `[mediaId]` 196, 238 | `Badge variant="warn"` — expect a small deliberate visual change (today bare text, no border) |
| ▶ | 3 card footnotes `.note` | stats 122, 140, 151 | `Card.Footer` |
| ▶ | Second `<header>` in `Card.Content` | `[mediaId]` 181–184 | `Card.Action`; also removes a fragile bare `header {}` element selector |
| ▶ | Slowest-songs list `.processes` | metrics 321–329 | `Item.Group` + `Item`. Preserve the deliberate `min-height: var(--tap)` and the underline-not-accent decision (XR-COL-11). |
| ▶ | **`/admin` song list + rows** | 107–127 | `Item.Group` + `Item` outline variant — the border+radius at 179–180 is exactly what Item's outline provides. Best Item fit in the app. |
| ▶ | `/admin` `.danger`, `.ghost`, `.delete`, `.link` | 117, 120, 123, 103 | `Button variant="destructive"` ×2, `"ghost"`, `"link"` |
| ⚠ | `.banner` / `.notice` / `.err` panels | metrics 125 · admin 97 · `[mediaId]` 243 | `alert` — **not vendored**; `Badge` is the wrong scale for a full-width tinted panel |
| — | Worker divider | — | **Does not exist.** No `<hr>`, no `role="separator"`, no `border-top`/`border-bottom` anywhere in `/metrics`. The row was fictional. |
| 🔒 | `.facts` definition lists | metrics 351–358 · `[mediaId]` 206–213 | A `<dl>` of key/value pairs has no registry primitive. |
| 🔒 | `.scroller` | metrics 159, 209, 260 | This page's layout, which `ui/table`'s own rules key off as an **ancestor** (documented 400–405). |
| 🔒 | `.slower` / `.faster` | metrics 231–232, 243–244 | Inline semantic colour on a number; `Badge` would add chrome inside a numeric column and break the shared right edge. |
| 🔒 | `.steps li` state tints | `[mediaId]` 191–246 | Danger/warn tinted background + 2px left border expressing one level of nesting; `Item` carries no tone. Migratable only if `Item` gains a tone prop. |
| 🔒 | `.tile` / `.kv` stat pairs | stats 62–98 · metrics 140–145 | Number-then-label is the **inverse** of `Item.Title`→`Description` weighting; `.tile-slot { display:grid }` exists specifically to make `Card.Root` fill the row. |

---

## 5. Token drift — closed, with three documented exceptions

**Radii.** The off-scale values are on tokens where a token existed at the same value (`4px` →
`--radius-xs`, `12px` → `--radius-sm`) or where the snap was justified (`SongRow`'s thumb `8px` →
`--radius-btn`; the skeleton row's `14px` → `--radius-sm`, so a placeholder matches the `.card` it
stands in for). The `22px` and `14px` button radii disappeared with their controls.

`RangeBar`'s `2px`/`3px`/`6px`/`8px` and `Trend`'s bar cap **stay literals**, documented in place:
they are drawing geometry inside `aria-hidden` visualizations, below `--radius-xs` (4px), and snapping
a 2px hairline to 4px rounds it into a lozenge and changes what the strip depicts. **The scale governs
surfaces; those components are charts.**

**Type.** 41 of 46 raw `font-size` literals are now `--ph-text-*`. Most were within ~2–4% of a step and
moved imperceptibly, including all thirteen `0.78rem` sites. Four moved further and are recorded so they
can be judged: `0.85rem` → `sm` (−6%, four secondary-text sites), `0.86rem` → `md` (+5%), the hero title
`1.35rem` → `xl` (−7%), and `JoinLanding`'s wordmark `1.6rem` → `2xl` (−6%).

One step was **added**: `--ph-text-3xl: 2.6rem`, the ladder's only genuine gap — `/stats`'s headline
figure is not a heading, it is the number the page exists to show. It carries the incumbent value
exactly, so nothing moved.

Three literals **kept**, on the same principle as the radii: `RangeBar`'s `0.6rem` axis labels (an
`aria-hidden` chart that must fit C2–C6 across a phone), `SongRow`'s `0.62rem` duration badge (inside an
84×47 thumbnail, over an arbitrary video frame, paired with the deliberate `#fff`), and `SongRow`'s
`20px` icon size.

---

## Done, and what is left

Landed on `fix/p0-ui-defects`, in order:

| # | Step | Note |
|---|---|---|
| 1 | P0 defects 2 + 3 | 1 and 4 were already fixed on trunk |
| 2 | `PageHeader.back` → `Button ghost/icon` | one edit, four routes |
| 3 | `alert` vendored, six banners moved | tone variants added; `role` made a prop for the two polite sites |
| 4 | the page header's abrupt seam | it painted flat `--bg` over the page's radial glow, cutting a darker rectangle out of it |
| 5 | the phone home's nine controls | three role-named variants, plus the `tap` size |
| 6 | mechanical wins + **three guards** | one guard found a live 8px bug on its first run |
| 7 | `switch`, six empty states, the type ladder | 41 of 46 literals tokenised, one display step added |
| 8 | `SongRow`'s two row actions | the last raw controls on the phone surface |

**What is left, in rough value order.** Each is an `⚠` or a decision in the tables above rather than
a mechanical swap:

1. **`textarea` is done** — `LyricsReselect`'s paste field now renders it. `separator` was the other
   half of this step and was withdrawn: see the note under the required set. The next smallest real gap
   is `input-otp`, for `CodeEntry`'s six segments.
2. **`LyricsReselect` → `Collapsible`.** Attempted and reverted: Bits UI reads
   `getBoundingClientRect`, which happy-dom stubs, so mounting it broke three behaviour tests. The
   claims have to move to the layout rung first — the same route the hero's disclosure took.
3. **`NowPlayingHero`'s `.track` → `Progress`**, once `ui/progress` carries the `--motion-tick`
   transition and its reduced-motion arm.
4. **`MyPositionCard` → `Item`** and **`JoinLanding`'s `.scan-row` → `Card` + `Item`**, the two
   cleanest remaining greenfield adoptions.
5. **`SongRow`'s `.thumb` → `AspectRatio`**, blocked only by `contrast.test.ts` attributing the
   thumb's background to that file.
6. **The stage-colour control.** Left native on purpose: adopting `ColourPicker` would trade the whole
   colour space, the eyedropper and the OS palette for consistency with a control that answers a
   different question. Needs an owner ruling, not an implementation.
7. **`Tooltip`.** Still deliberately unrequired — `Trend`'s readout fires on plain `:focus` because a
   touch tap does not match `:focus-visible`, and Bits UI's Tooltip would regress that path.
