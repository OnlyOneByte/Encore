# 02 — Phone / guest surface requirements

Area prefix `XR-PH`. Scope: the phone remote — `/` (landing, unjoined + joined), the browse push,
`/settings`, `/stats`, and the join path. Surfaces column uses **Phone**, **TV**, **Ops**.

Direction is **A + B**, and drag reorder, landing/join, and live singing controls are DECIDED
(`encore-design-handoff.md` §1). These rows specify against those decisions; they do not re-open them.

Two repo facts these rows lean on, verified in this pass and worth stating once:

- **`move` is not the only way an entry crosses singers.** `apps/core/src/shared/core/ops.ts:12` scopes
  `move`'s `toSeq` to the singer's own QUEUED picks. Crossing singers is now a **direct rewrite of the
  stored ordered list** — the list is the source of truth, so a placement is durable by construction and
  there is no pin: pinning (`move-global`/`unpin`, `pinnedSeq`, `placePins`, and the client's
  `pinEntry`/`unpinEntry`/`moveGlobal`/`canHostReorder`) was DELETED in the stored-list migration's step 3. `queue:reorder-any`
  survives and gates `move` on an entry the actor does not own. Wiring the arrows and the drag to a
  single "move to index" op is that migration's **step 4** and is not yet shipped, so "the operation cannot express
  crossing singers" still describes today's **guest** path. Every drag row below is written for the
  guest path and says so.
- **`move` is a legal no-op under one ordering.** `queue-order.ts` marks `shuffle` as
  `respectsAddedAt: false` with the note "Reordering your own picks does nothing here", and
  `+page.svelte:97` already gates the up/down buttons on `reorderIsMeaningful(...)`. The **grip is new**,
  so it has to inherit that gate or it promises a reorder the reducer discards.

---

## 1 · Per-surface property floors — phone at arm's length

### XR-PH-01 — Every phone control expresses the 44px hit floor as the token, not the number

| | |
|---|---|
| **Statement** | Every interactive control on a phone surface derives its minimum hit box from `var(--tap)`; no phone rule states `44px` as a literal. |
| **Surfaces** | Phone |
| **Rationale** | The *number* is already unbreakable (`charts/trend-tap-target.test.ts:32` bridges `--tap` into the guard); what is unenforced is the expression, so a future change to the standard would apply to 5 files and silently skip 11 literals. |
| **Source** | [SC 2.5.8 Target Size (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) (AA, 24px) and [SC 2.5.5 Target Size (Enhanced)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html) (AAA, 44px). Both are pointing-precision criteria stated in CSS px — they do **not** scale with viewing distance, so arm's length changes nothing here. |
| **Acceptance** | Given the phone source tree, When it is scanned for `44px` outside `:root`, Then zero occurrences remain under `apps/core/src/routes/**` and `apps/core/src/lib/**`, and the 11 known literals (`lib/ui/PageHeader.svelte` ×2, `routes/+page.svelte` ×9) are gone. |
| **Check** | Extend `src/lib/touch-targets.test.ts` (already a full `svelteFiles(SRC)` tree-walk, so there is no file list to maintain) with a literal-expression assertion. A source scan suffices — this is a syntax claim, not a measurement. |
| **Priority** | Should — behaviour is correct today; this protects the next change to the standard. |

### XR-PH-02 — Text and controls survive 200% text scaling and a 320px viewport

| | |
|---|---|
| **Statement** | At 200% text size and at a 320 CSS px viewport width, every phone surface reflows without clipping, overlap, loss of content, or a horizontal scrollbar. |
| **Surfaces** | Phone |
| **Rationale** | The phone is a fixed-width column (`--max-w: 480px`) with two bottom-docked bands (queue peek, browse search dock) plus a docked CTA — the exact shape where scaled text overlaps rather than reflows. |
| **Source** | [SC 1.4.4 Resize Text](https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html) (AA) and [SC 1.4.10 Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html) (AA, 320 CSS px). |
| **Acceptance** | Given `/`, `/join`, `/settings`, `/stats` and the browse screen at 320×480 with root font-size ×2, When each is rendered, Then `scrollWidth <= clientWidth` on the scrolling element, and no docked band's rect intersects a queue row's rect. |
| **Check** | Rendered-DOM or driven-browser measurement. **Not a source scan** — both halves are geometry. Depends on XR-PH-21. A residual 5px overflow at 280px is known pre-existing on `main` and out of scope: 320px is the criterion's width. |
| **Priority** | Must. |

### XR-PH-03 — De-emphasis never uses subtree opacity

| | |
|---|---|
| **Statement** | A phone row that is de-emphasised — the dimmed non-draggable rows of the reorder mode, a pending row, an unavailable control — signals that state with a surface/border token change, and never by applying `opacity` to a subtree containing text or an identity dot. |
| **Surfaces** | Phone |
| **Rationale** | This substitution has already been made once: `QueueRow.svelte`'s `.pending` comment records that `opacity: 0.55` dropped its own explanatory text to 3.77:1, the byline to 2.68:1 and the singer dot to 2.57:1 — and the reorder mockup currently dims with inline `opacity:.45`. |
| **Source** | [SC 1.4.3 Contrast (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) (AA, 4.5:1) and [SC 1.4.11 Non-text Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html) (AA, 3:1). The dimmed rows stay *informational* during the mode — they are who you are being ordered around — so the inactive-component exemption does not apply. |
| **Acceptance** | Given the reorder mode with 4 other guests' rows on screen, When each dimmed row's computed text and dot colours are measured, Then title ≥ 4.5:1 and dot ≥ 3:1 against the painted backdrop; and When the source is scanned, Then no card-root rule sets `opacity` on a subtree containing text. |
| **Check** | `contrast.test.ts`'s existing "no card root dims its own subtree with opacity" covers the scan half; the computed half needs the rendered rung (XR-PH-21). |
| **Priority** | Must — the reorder mode's whole visual language is de-emphasis, so this decides it. |

---

## 2 · Token dimensions that must exist

When these rows were written, six dimensions had **zero** tokens and ~391 literals lived in them, so
`design-system.test.ts` passed *correctly* and reported nothing — a "no literal that duplicates a token"
guard cannot compare against a token that does not exist. The four rows below cover all six dimensions
and close the hole each one leaves.

**Status:** five of the six shipped (breakpoints arriving separately) — `--space-*` ×10, `--lh-*`
×5, `--z-*` ×14, `--duration-*` ×4, `--bp-*` ×5. Still open: **`font-family`** (never tokenised; raw
literal at `app.css:782`) and **easing** (motion shipped duration only). The literal counts below are
the pre-migration figures and are kept as the rationale that justified the work, not as current state.

### XR-PH-04 — The layout axes exist: a spacing scale and a z-index scale

| | |
|---|---|
| **Statement** | `:root` declares a named spacing scale and a named z-index scale. Every `gap`/`margin`/`padding` in a phone surface resolves to a spacing step; every overlapping phone surface — queue rows, the lifted drag row, the docked CTA, the browse search dock, the queue sheet, the undo toast, the reconnecting pill — names a z-index step. The design guard fails on a new literal in either dimension. |
| **Surfaces** | Phone (TV and Ops inherit the scales; their migration is not this section's) |
| **Rationale** | 228 of the ~391 untokenised literals are spacing, the dimension the A+B redesign touches most; and the reorder mode adds a *lifted* row that must paint above sibling rows and below the docked controls — an ordering nobody can currently state, let alone check, across 22 bare z-index values. |
| **Source** | `DERIVED` — model: the guard compares a literal against the token set, so enforceable coverage of a dimension is exactly the existence of tokens in it; 228 literals against 0 tokens is 0% enforceable. Counts from the shared brief. |
| **Acceptance** | Given the phone tree, When spacing and z-index declarations are enumerated, Then each is `var(--space-*)` / `var(--z-*)`, a `calc()` over one, or an env/safe-area expression; When a bare `padding: 13px` is introduced, Then the guard reds; and When the lifted row is rendered, Then it paints above unlifted rows and below the docked CTA band. |
| **Check** | Extend `design-system.test.ts` with a rule per dimension, plus a **non-vacuity floor** asserting each token set is non-empty — if that floor ever fires it is a finding, not a number to lower. The paint-order clause needs the rendered rung. |
| **Priority** | Must — the highest-leverage single row in this section. |

### XR-PH-05 — The type axes exist, with a documented minimum, and no angular correction

| | |
|---|---|
| **Statement** | `:root` declares the phone type ladder (size + line-height pairs) and one font-family token, expressed in `rem` off a root that carries **no** viewport-relative term. Phone components reference those tokens and declare no raw `font-size`, `line-height` or font stack. The product also has a **stated** minimum rendered text size for phone surfaces, documented beside those tokens, with named exemptions. |
| **Surfaces** | Phone, Ops |
| **Rationale** | 113 font-size, 14 line-height and every font-family literal are unenforceable today, which is also what makes the minimum uncheckable; and the phone needs no distance multiplier — the CSS reference pixel is *defined* at arm's length, so the TV's 1.8× coefficient exists only because a 10-ft panel falls outside that definition and must not be copied here. |
| **Source** | [CSS Values 4 § reference pixel](https://www.w3.org/TR/css-values-4/#reference-pixel) — "the visual angle of one pixel on a device with a pixel density of 96dpi and a distance from the reader of an arm's length (approximately 28 inches …), about 0.0213 degrees" — for the no-correction half. The **minimum is `UNSOURCED`**: WCAG 2.2 has no minimum font-size criterion (it governs contrast, resize and reflow instead), and platform guidance is guidance, not a testable standard. *"No published standard sets a minimum font size" is the finding.* The separate 16px form-control floor is real and already guarded at `design-system.test.ts:287`. |
| **Acceptance** | Given `app.css`, When the root `font-size` is read, Then it contains no `vh`/`vw` term. Given the phone tree, When type declarations are enumerated, Then zero raw values remain outside `:root`. Given the documented minimum, When every phone type token is enumerated, Then each is ≥ it or named in the exemption list. |
| **Check** | Source scan for all three clauses — the minimum becomes decidable by reading the token set alone once the ladder exists. |
| **Priority** | Must for the tokens; the minimum's *value* is Should. `Recommendation (not decided)`: `0.75rem` / 12px, with `RangeBar.svelte`'s legend and axis-end labels as candidate exemptions since both restate text shown elsewhere at full size. Current drift reaches `0.7rem` shipped and 10.5px in the mockups. |

### XR-PH-06 — A motion scale exists, and the drag library's motion is CSS-gated

| | |
|---|---|
| **Statement** | `:root` declares motion duration and easing tokens; every phone animation is CSS-driven and inside `@media (prefers-reduced-motion: …)`; and any drag library's own JS-driven movement animation resolves to zero duration when the user prefers reduced motion. |
| **Surfaces** | Phone |
| **Rationale** | `motion.test.ts` already bans Svelte's `transition:`/`animate:` directives because the Svelte runtime never consults the media query — a JS-animated drag library reintroduces the identical defect by a route the ban does not name, and `svelte-dnd-action` is back in scope. |
| **Source** | [SC 2.3.3 Animation from Interactions](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html) (AAA) for the user control. The enforcement gap is `DERIVED` — model: the guard matches Svelte directive syntax, so motion expressed as a library's inline style writes is outside its matcher by construction. 14 transition-duration literals per the shared brief. |
| **Acceptance** | Given reduced motion is preferred, When a row is dragged, Then no element's position is interpolated over time (flip/settle duration resolves to 0) and the committed position updates without a tween; and When the source is scanned, Then no phone rule states a raw duration. |
| **Check** | Source scan for duration literals and for a reduced-motion branch at the drag call site; the behavioural half needs the rendered rung or a driven check, since no scan can prove a library honoured the flag. If Tailwind utilities enter, the scan must also cover class attributes — `class="transition-all"` is invisible to `motion.test.ts` today. |
| **Priority** | Must — this is the one collision the library's copy-in model does not fix. |

### XR-PH-07 — Breakpoints are tokenised, and the documented set matches the implemented set

| | |
|---|---|
| **Statement** | The product declares one canonical breakpoint set, and every `@media` width literal in source is a **member** of it. The reviewer checklist's widths (390 / 820 / 1440 px) are a separate, eyeballing list and are deliberately not required to match — the two are different things (owner ruling Q1-C). |
| **Surfaces** | Phone, Ops, TV |
| **Rationale** | `REVIEW.md` tells reviewers to check 390 / 820 / 1440px; the only widths in source are 380 / 520 / 768 / 1200px. The two lists mean different things — widths eyeballed vs widths switched at — but until a declaration existed, **nothing** pinned the switch widths, so a new `@media` could branch at a width no token and no reviewer knew about. |
| **Source** | `DERIVED` — model: membership of every source `@media` width literal in the declared `--bp-*` set, read from `app.css`. The reviewer list is left as-is and not compared for equality. |
| **Acceptance** | Given the declared breakpoint set, When every `@media (min-width\|max-width)` width literal in source is collected, Then each is a member of the set. Falsified by one `@media` width that is not declared. 320 px (WCAG 2.2 SC 1.4.10 Reflow) is a declared member even though no rule branches at it. |
| **Check** | Source scan collecting `@media` width literals across `apps/*/src` + `packages/*/src` and asserting each is a declared `--bp-*` member, with a non-vacuity floor on the count found. |
| **Priority** | Must — cheap, and it repairs the review process rather than a pixel. |

---

## 3 · States, flows, focus and announcements

### XR-PH-08 — INVENTORY: every phone route has a designed empty, loading, error and offline state

| | |
|---|---|
| **Statement** | Every phone route renders a designed state for empty, loading, error and disconnected, each stating what happened and what the guest can do next. **Named exemptions:** `/components` (a gallery — its states *are* its content), `/admin` and `/metrics` (operator surfaces, covered by the Ops section), and `/tv` (not a phone surface). No other route is exempt. |
| **Surfaces** | Phone |
| **Rationale** | An inventory catches the route nobody thought about, which is the one that ships as a blank column; an unbounded escape hatch would enforce nothing, so the exemptions are named here rather than left to judgement. |
| **Source** | `UNSOURCED` as a conformance rule — no standard requires an empty state; this is a completeness rule, and the enumerable form is what makes it checkable. Narrower and adjacent: [SC 3.3.1 Error Identification](https://www.w3.org/WAI/WCAG22/Understanding/error-identification.html) (A) governs the error case's text. |
| **Acceptance** | Given the route list minus the four named exemptions, When each route is forced into each of the four conditions, Then a designed state renders with a heading and at least one next action. Falsified by any route × condition pair rendering an empty region or a raw error string. |
| **Check** | Enumeration over `src/routes/**/+page.svelte` for the presence of each branch, plus captured frames per pair. The presence half is a scan; the rendering half needs the driven app. |
| **Priority** | Must. |

### XR-PH-09 — The guest's position is stated in words, and degrades honestly when the wait is unknown

| | |
|---|---|
| **Statement** | The joined home screen states the guest's own position as a sentence naming the ordinal and the singer immediately before them. The time estimate is included only when every entry ahead has a known duration, and is omitted — not zeroed, not guessed — otherwise. |
| **Surfaces** | Phone |
| **Rationale** | "3rd — you're up after Sam, roughly 11 minutes" is the direction's core promise, and durations are genuinely absent for some rows: the phone's own progress row already returns `null` rather than 0 for unknown duration, precisely because a bar pinned at 0 reads as a stalled song. |
| **Source** | `DERIVED` — model: the estimate is a sum over the entries ahead, and a sum with an unknown term is unknown, so the only honest renderings are "omit the clause" or "state it as approximate with the unknown named". Which of the two is `UNSOURCED`, hence the omit rule here. |
| **Acceptance** | Given the guest is 3rd with all durations known, When home renders, Then the sentence names the ordinal and the preceding singer's display name. Given any entry ahead lacks a duration, Then no minutes clause renders and the string never contains "roughly 0". |
| **Check** | Unit test over the sentence builder (a pure function, no DOM needed) plus one captured frame per branch. |
| **Priority** | Must. |

### XR-PH-10 — A queue mutation awaiting confirmation is marked, including a reorder

| | |
|---|---|
| **Statement** | Every optimistic queue mutation carries a visible unconfirmed marker until the server acknowledges it — an add, a removal, **and a reorder** — using the same surface-signal idiom, not opacity. |
| **Surfaces** | Phone |
| **Rationale** | The add path already has this (`QueueRow.svelte`'s `.pending` warn surface; the reconnecting pill at `+page.svelte:852` states that commands are still accepted while offline because they resend on resync), but a reorder has no marker at all — so a drag committed on a flaky socket looks identical to one that landed. |
| **Source** | `DERIVED` — model: the mutation set is `ops.ts`'s `QueueOp` union; the marker exists for `add` and is absent for `move`, so the gap is the difference between them. |
| **Acceptance** | Given a reorder issued while the socket is down, When the row re-renders, Then it carries the unconfirmed surface and its reorder controls are inert; When the ack arrives, Then the marker clears within one render. |
| **Check** | Source scan that every branch of the op union has a marker binding, plus a driven check with the socket interrupted. |
| **Priority** | Must. |

### XR-PH-11 — A stated policy for a lost optimistic race

| | |
|---|---|
| **Statement** | The product has a **stated** policy for what a guest sees when their optimistic mutation is rejected or superseded — disclosed, or silently reverted — documented at `docs/ARCHITECTURE.md`, and the phone implements it identically for add, remove and reorder. |
| **Surfaces** | Phone (the TV shows authoritative state only and is unaffected) |
| **Rationale** | This is recorded as genuinely open (handoff §4.3), and a drag makes it visible for the first time: a reorder that quietly snaps back is the exact failure the scoped-drag constraint exists to prevent, so the phone cannot keep deferring the question. |
| **Source** | Named-decision requirement — acceptance is the **existence and consistency** of the policy, not its content. |
| **Acceptance** | Given the documented policy, When each of the three mutation types is rejected by the server, Then all three produce the behaviour the document names. Falsified by any two of the three differing. |
| **Check** | `EXEMPT` on the content — the judgement is the owner's. Consistency is checkable by a driven test per mutation type once the policy is written. |
| **Priority** | Must decide before drag ships; the *choice* itself is not blocking. |

### XR-PH-12 — Focus order follows visual order, and a docked band reserves its space in flow

| | |
|---|---|
| **Statement** | On every phone route, DOM order matches visual order, and any bottom-docked control (CTA, search dock, queue peek) reserves its band in normal flow rather than overlapping scrollable content. |
| **Surfaces** | Phone |
| **Rationale** | The mockup's own home frame demonstrates the failure — the docked CTA occludes queue row 5 because a disclosure grew inside a fixed shell — and an absolutely-positioned CTA that visually sits last while appearing first in the DOM also breaks the tab sequence. |
| **Source** | [SC 2.4.3 Focus Order](https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html) (A) for the sequence. The reserve-in-flow half is `DERIVED` — model: content occluded by a fixed band cannot be reached by scrolling, so it is content loss under [SC 1.4.10 Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html) regardless of the focus question. |
| **Acceptance** | Given home with enough rows to scroll, When the list is scrolled to its end, Then the last row's rect does not intersect the docked band's rect; and When Tab is pressed from the header, Then focus visits controls in top-to-bottom visual order. |
| **Check** | Driven browser: `getBoundingClientRect` intersection plus real `Tab` key events reading `document.activeElement`. The `--dock-h` custom-property idiom is the working precedent for reserving a docked band's height (it succeeded `--peek-h`, retired with the drawer surface). |
| **Priority** | Must. |

### XR-PH-13 — Announcement inventory: what is announced, and when

| | |
|---|---|
| **Statement** | The phone's polite live region announces exactly: another guest's add, a rotation reorder that moved rows under the guest, a change to the guest's own position, entering and leaving the reorder mode, each committed slot change during it, and connection loss/restore. It announces **nothing** on first sync, and nothing for a mutation the guest initiated and can already see. |
| **Surfaces** | Phone |
| **Rationale** | The region and its suppression discipline already exist (`+page.svelte:1303`, with `announceReady` suppressing the initial sync and self-adds deliberately silent); what is missing is the reorder mode and the guest's own position — the two things this redesign adds and the two a non-sighted guest cannot otherwise perceive. |
| **Source** | [SC 4.1.3 Status Messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html) (AA). Politeness is `DERIVED` — model: none of these interrupt a task, so all are `polite`; an assertive queue announcement would talk over a guest mid-typing in search. |
| **Acceptance** | Given each of the seven events, When it occurs, Then the live region's text changes exactly once and names the event in guest vocabulary. Given the first `queue:sync`, Then the region stays empty. Falsified by an eighth announcement, or by a silent one of the seven. |
| **Check** | Unit test over the announcement reducer (already a `$effect` over derived state, extractable as a pure function), plus one driven pass reading the region's text per event. |
| **Priority** | Must. |

### XR-PH-14 — Join offers scan **and** type, over six segments and the restricted alphabet

| | |
|---|---|
| **Statement** | The unjoined landing state offers both a scan path and a typed path to the same room. The typed path is six segmented single-character inputs; input is normalised to upper case; characters outside `ABCDEFGHJKMNPQRSTUVWXYZ23456789` are rejected at the keystroke with a stated reason; a 6-character paste fills all six; and Continue stays disabled until six are present, with the reason stated in text rather than by disabled state alone. A guest arriving with the code already resolved is shown the room **confirmed in words** — how many people are present, and a couple of their names — and never the code as an input they cannot act on. (Rooms carry no name in the data model, so the owner's Q1-B ruling confirms by presence, not a room name; there is no expiry column either, so a code either resolves or does not.) |
| **Surfaces** | Phone |
| **Rationale** | A typed code alone is a cognitive-function test, so the scan route is what makes the screen conformant; the segment count teaches the format without an instruction; the alphabet already excludes O/I/L/0/1 server-side, so accepting an `O` and failing later discards the whole point of the restriction; and once transcription has happened the code has no remaining function, so what remains is confirmation. |
| **Source** | [SC 3.3.8 Accessible Authentication (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/accessible-authentication-minimum.html) (AA) for scan-alongside-type; [SC 3.3.2 Labels or Instructions](https://www.w3.org/WAI/WCAG22/Understanding/labels-or-instructions.html) (A) and [SC 3.3.1 Error Identification](https://www.w3.org/WAI/WCAG22/Understanding/error-identification.html) (A) for the disabled-Continue reason. Alphabet from `mintRoomCode()` in `apps/core/src/server/rooms/repository.ts`, whose comment frames the code as what a phone enters **or a QR encodes**; the resolved-code path already exists at `routes/join/+page.svelte:11` (`/join?room=CODE`). |
| **Acceptance** | Given the unjoined state, When it renders, Then both a scan affordance and six inputs are present, the group has one accessible name, and the six are one tab stop with arrow/backspace movement between them. When `o1l` is typed, Then nothing is entered and a message names the excluded characters. When a 6-char code is pasted into the first box, Then all six fill and Continue enables. Given `/?room=<valid code>`, Then the six inputs are absent and a sentence names how many people are present (and a couple by name); given an invalid code, Then the typed path renders **with** a stated reason rather than a blank form. |
| **Check** | Driven browser with real key and paste events. Encode the known hazard: Svelte 5 `bind:value` on a rune does **not** pick up synthetic CDP input, so a probe must dispatch real key events or the field reads as empty and Continue as correctly-disabled. |
| **Priority** | Must. |

### XR-PH-15 — Live singing controls belong to the playing song, and degrade with a reason

| | |
|---|---|
| **Statement** | The guide-vocal level, pitch shift and vocal-range bar are controls for the song playing **now**, rendered in the now-playing hero's disclosure **body** — never on a pointer-drag surface — and each states what it does. When a song has no isolated vocals stem, the guide-vocal control renders disabled with the reason plus a statement that pitch and range still work; it does not vanish. |
| **Surfaces** | Phone |
| **Rationale** | All three components already carry these constraints in their own headers — `GuidingTrack.svelte` is a 0–100 level that "lives in the sheet BODY not the peek … a range input there fights that gesture", and `RangeBar.svelte` says "the phone renders it inside a disclosure" — and relocating them onto the hero is exactly the change that could lose them. |
| **Source** | `DERIVED` — model: both constraints are stated in the components' own source, and this row is what carries them across the relocation. Preservation, not invention. |
| **Acceptance** | Given the hero, When the disclosure is expanded, Then no range input is a descendant of a drag-gesture surface, and the collapsed summary carries the current values. Given `available === false`, Then the guide-vocal row renders a disabled control, a stated reason, and text naming what still works. |
| **Check** | Source scan for the drag-surface ancestry (`GuidingTrack` must not sit inside the sheet-peek subtree), plus captured frames for the available/unavailable pair. `RangeBar` is `aria-hidden` by design with a text readout beside it — assert that pairing, since otherwise the graphic is the only carrier. |
| **Priority** | Must. |

### XR-PH-16 — A stated policy for who may operate the live controls mid-song

| | |
|---|---|
| **Statement** | The product has a **stated** policy for who may change guide vocals, pitch and range while a song is playing — the singer only, or the host too — documented alongside the capability list in `hub.ts`, and enforced server-side rather than by hiding the control. |
| **Surfaces** | Phone |
| **Rationale** | Nobody has decided this, and the failure is asymmetric: a wrong answer either strands a singer who cannot reach their own key change, or lets any guest transpose someone else's performance. Adjacent to the other open gate — any joined singer can currently `PUT /api/settings`. |
| **Source** | Named-decision requirement — acceptance is the existence and consistency of the policy, not its content. |
| **Acceptance** | Given the documented policy, When a non-permitted actor sends each of the three commands, Then the server refuses all three identically and the phone reflects the refusal. Falsified by a control hidden on the phone but unguarded on the server. |
| **Check** | `EXEMPT` on the content. Server-side enforcement is unit-testable against `validateCommand` once the capability exists. |
| **Priority** | Must decide before the hero controls ship. |

---

## 4 · The drag mode

### XR-PH-17 — Entering the mode: the grip appears only where a reorder is real

| | |
|---|---|
| **Statement** | A drag grip renders only on a row that is the guest's own, when the guest has more than one queued pick, **and** the room's ordering honours a per-singer reorder. It never renders on another guest's row, and no row without a reorder path carries `cursor: grab`. |
| **Surfaces** | Phone |
| **Rationale** | `QueueRow.svelte`'s comment records that a grip previously rendered *only* on rows that were neither removable nor reorderable — another guest's song — where it was the sole affordance, promising a drag that does not exist; and under `shuffle` (`respectsAddedAt: false`) a `move` is a legal no-op, so a grip there promises a reorder the reducer discards. |
| **Source** | Repo: `apps/core/src/lib/components/QueueRow.svelte` (the removed-grip comment and the `reorderable` prop), `apps/core/src/shared/queue/queue-order.ts` (`respectsAddedAt`, `reorderIsMeaningful`), already consumed at `routes/+page.svelte:97`. |
| **Acceptance** | Given a room ordered by `shuffle` and a guest with three of their own picks, When home renders, Then no grip renders on any row. Given `fair` ordering with exactly one of the guest's picks queued, Then no grip renders. Given `fair` with two, Then a grip renders on both of the guest's rows and on no other row. |
| **Check** | Unit test over the grip-visibility predicate (pure), plus captured frames for the three arms. |
| **Priority** | Must. |

### XR-PH-18 — Legal slots: only the guest's own positions accept a drop

| | |
|---|---|
| **Statement** | In the reorder mode, the number of drop targets equals the guest's own queued pick count, each target is labelled with the ordinal it represents among the guest's picks, other guests' rows are non-interactive and de-emphasised, and a release outside a legal target commits nothing. |
| **Surfaces** | Phone |
| **Rationale** | `move`'s `toSeq` is an index into the singer's own queued picks, so a drop that appears to cross singers cannot be expressed and would snap back — which reads as a bug rather than as a rule. The guest's picks are **not adjacent** in a flat list, which is why the mode must draw the slots rather than let the list imply them. |
| **Source** | Repo: `apps/core/src/shared/core/ops.ts:12`; `reorderWithinSinger` at `apps/core/src/shared/queue/rotation.ts:127`, which indexes queued picks only and clamps an out-of-range target. |
| **Acceptance** | Given 6 queued entries of which 2 are the guest's, When the mode is entered, Then exactly 2 drop targets render and the other 4 rows expose no pointer or keyboard interaction; When a row is released over a non-target, Then no `move` op is emitted. |
| **Check** | Driven browser for the target count and release behaviour; a unit test asserts the count derives from the guest's queued picks, not from the visible list length. Cross-singer placement is now a **direct rewrite of the stored ordered list** (no pin — pinning was deleted in the stored-list migration's step 3), wired to the arrows and the drag in its step 4, and is out of scope for this within-singer row. |
| **Priority** | Must. |

### XR-PH-19 — Exiting the mode, and what happens when the queue moves underneath it

| | |
|---|---|
| **Statement** | The mode is exited by an explicit Done, by Cancel, and by `Escape`; Cancel and `Escape` commit nothing. If a concurrent change invalidates the mode — the guest's queued picks fall below two, or their pick begins playing — the mode closes itself, states why, and returns focus to the row the guest was moving. |
| **Surfaces** | Phone |
| **Rationale** | `assignSeqs` re-derives `rotationSeq` on **every** mutation, so any other guest's add re-orders the list under an open drag; a mode whose slots silently stop matching the list is how a drop lands somewhere the guest did not choose. |
| **Source** | Repo: `apps/core/src/shared/queue/rotation.ts` — `assignSeqs` re-derivation, and `reorderWithinSinger` returning a no-op for a playing entry. |
| **Acceptance** | Given the mode is open, When `Escape` is pressed, Then no op is emitted and focus returns to the grip that opened it. Given the mode is open and the guest's second pick is removed elsewhere, Then the mode closes with a stated reason within one render and no op is emitted. |
| **Check** | Driven browser for `Escape` and focus return; a harness test drives real ops through `handleQueueCommand` to produce the invalidating states (the `AuthoritativeState` + `HubDeps` idiom used by `autostart.test.ts` is the working template). |
| **Priority** | Must. |

### XR-PH-20 — The single-pointer alternative stays, and stays reachable

| | |
|---|---|
| **Statement** | Every reorder achievable by dragging is achievable with the existing move-up / move-down buttons, which remain present and operable **while the mode is open**, are keyboard-operable, and are never hidden or disabled by the mode itself. |
| **Surfaces** | Phone |
| **Rationale** | Drag is additive by decision; a mode that hides the buttons removes the single-pointer path at exactly the moment a guest is trying to reorder, which is the criterion's whole subject. |
| **Source** | [SC 2.5.7 Dragging Movements](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html) (AA) — a single-pointer alternative is required for any dragging action; [SC 2.1.1 Keyboard](https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html) (A) for operability without a pointer. Existing gate: `QueueRow.svelte`'s `reorderable` / `canUp` / `canDown` props. |
| **Acceptance** | Given the mode is open on a row, When that row's controls are enumerated, Then both move buttons are present and enabled per `canUp`/`canDown`; When only the keyboard is used, Then every ordering of the guest's picks reachable by drag is reachable through them. Falsified by the mode rendering a grip without the buttons. |
| **Check** | Source scan that the mode's row template includes the button pair unconditionally, plus a driven keyboard pass. |
| **Priority** | Must — a conformance requirement, not a preference. |

---

## 5 · Verification

### XR-PH-21 — No phone measurement claim is asserted by source scan alone

| | |
|---|---|
| **Statement** | Every requirement in this section whose acceptance is a computed value — geometry, contrast, paint order, focus location — names a rendered-DOM or driven-browser check, or is marked `EXEMPT`. None is satisfied by a source scan. |
| **Surfaces** | Phone |
| **Rationale** | No source scan can make a measurement claim, and the repo's own record is that every real defect found lately was invisible to a passing suite and surfaced only by driving the app; 4 of the 19 at-risk guards are measurement claims for this reason. |
| **Source** | Repo: `tests/guards/subsystem-tv/wake-lock.test.ts:18-27` states the blocker — `bunfig.toml` preloads the happy-dom + Svelte harness but does not alias the `$app` / `$env` virtual modules, so only components with zero `$app` imports can mount. |
| **Acceptance** | Given this section, When each row's Check field is read, Then every measurement row names a rendered/driven mechanism or `EXEMPT`. Falsified by one measurement row whose only check is a scan. |
| **Check** | Review of this document. Mechanically the prerequisite is aliasing those two modules, which converts XR-PH-02, -03, -04, -12 and -18 from honour-system to checkable. |
| **Priority** | Must — it is the gate on five other rows here. |

### XR-PH-22 — Phone frames are captured at the canonical widths, from a driven room

| | |
|---|---|
| **Statement** | Phone verification frames are captured from a running instance with real room state, at each width in XR-PH-07's canonical list, under 2000px on both axes, and every state named in XR-PH-08 has a frame. |
| **Surfaces** | Phone |
| **Rationale** | A frame over 2000px on either axis is silently unreadable to the tooling that reviews it — costing the review rather than erroring — and a frame taken against an unseeded room shows the pre-sync default for every room regardless of who is present. |
| **Source** | `DERIVED` — model: the 2000px ceiling is a tooling limit recorded in the shared brief; 390×844 at DPR 2 is 780×1688 and fits. Seeding via `POST /api/join` per singer plus one held `ws://…?role=phone` socket each is the production path, because roster presence is per-socket and a bare fetch is not enough. |
| **Acceptance** | Given the frame set, When each image is measured, Then both axes are < 2000px; When the widths are compared against XR-PH-07's canonical list, Then every width has a frame; and each frame shows non-empty room state rather than the pre-sync default. |
| **Check** | A capture script plus an image-dimension assertion. Encode the practical traps: a duplicate display name 409s and rooms persist between runs, so seed unique names; `/api/library` lists only ready songs, so a seeded-but-uncooked catalogue correctly returns empty and is not a seeding bug. |
| **Priority** | Should — the frames *are* the review, so the ceiling matters more than the count. |

---

## Deliberately not written

- **A 44px *number* requirement.** Already unbreakable: `charts/trend-tap-target.test.ts:32` bridges
  `--tap` into the guard, and `touch-targets.test.ts` is a full `svelteFiles(SRC)` tree-walk that derives
  its control set from markup rather than an allowlist. Only the expression was at risk (XR-PH-01).
- **A 16px form-control floor.** Stated *and* enforced at `design-system.test.ts:287`.
- **`dvh` sheet caps, safe-area insets, home-indicator clearance, custom-property teardown.** All four
  are already guarded (`design-system.test.ts:236/314/323/339`).
- **A visible focus indicator.** `app.css:234-244` carries a global `:focus-visible` ring, deliberately
  written as a plain selector list rather than `:where()` so it out-specifies `outline: none`. Focus
  *order* and the mode's focus *management* were the gaps (XR-PH-12, XR-PH-19).
- **A ban on Svelte transition directives.** `motion.test.ts` already rejects them. The new exposure is a
  drag library's JS-driven motion and Tailwind's `transition-*` utilities, both outside that matcher —
  which is XR-PH-06.
- **A cross-singer drag requirement.** `move` expresses a within-singer reorder only; a cross-singer drag
  rewrites the stored ordered list through the "move to index" op that the migration's step 4 introduces, so
  specifying a guest-facing version here would front-run that step.
- **Search and filter behaviour on the browse screen beyond the deletion.** The direction deletes the four
  filter mechanisms and leaves typing as the only filter; ranking, debounce and result-set semantics are a
  search-quality question nobody has framed, and inventing thresholds here would be exactly the
  plausible-number-without-a-marker failure.
- **Whether global settings are host-gated.** Recorded as open (handoff §4.4) and broader than the phone;
  XR-PH-16 covers only the mid-song control subset the hero introduces.
- **A per-stop accent decision for row-level `+` buttons.** The handoff offers the neutral-ink mitigation
  explicitly as a build-time judgement to raise with the owner, not to apply unilaterally.
