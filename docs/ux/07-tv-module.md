# 07 — TV module contract

IDs `XR-TVM-nn`. Surface under specification: **`apps/core/src/lib/tv` — the module layer beneath the
TV's visuals.** 15 `.ts` modules and the six components that consume them. Where
[`01-tv.md`](01-tv.md) specifies what the wall *looks like* (type floors, safe areas, which frame each
state gets, the phrase system), this section specifies what has to be *true underneath*: the player's
lifecycle and its transitions, what happens when media fails or a file is missing, how the room's clock
is kept, where lyric and pitch data may be read from, and what the TV must never depend on.

The distinction is not cosmetic. Every defect this section is derived from was **invisible to a green
suite and invisible on screen** — an element at `readyState 4` with correct duration and no error, sitting
paused at 0; a playhead yanked back by a cook for an unrelated song; a reel scrolling over a silent room.
None of those are appearance bugs, and none of them can be caught by a rule about type size.

**Provenance notes that apply to every row below.**

- **The unit of specification is the module boundary, not the file.** A row says where a decision must
  live and what may reach it, because every recurring defect in this tree was a decision that lived in
  the wrong place — inside a component where nothing could test it, or reachable from a caller that had
  no business waking it.
- **`DERIVED` rows state their model.** Two models are used. The **decision-locality** model: a claim is
  checkable iff the decision it constrains is reachable without the DOM, so a decision inside a
  `.svelte` file is unfalsifiable by construction. The **rung** model, inherited from
  [`04-verification.md`](04-verification.md): a claim is decidable on a rung iff the rung implements the
  API the claim reads.
- **The mount rung deliberately has no geometry, and that constrains what these rows may promise.**
  All six geometry APIs — `getBoundingClientRect`, `getClientRects`, `offsetWidth/Height`,
  `clientWidth/Height`, `scrollWidth/Height` — **throw** on rung M with a message naming the rung and
  `apps/core/e2e/cdp.mjs`, and `ResizeObserver` is **not installed**, with a live guard asserting its
  absence (`tests/unit/core/lib/mount-rung.test.ts`, tests 5 and 6). That is a design decision: a zero
  is a silent green, so a component that measures is kept off this rung by making the measurement loud.
  Consequently **any row whose observation is a measured pixel is `EXEMPT` on rung M and belongs to rung
  L**, and each such row says so rather than naming a unit test it cannot have.
- **What was looked for and not found.** No published contract governs the lifecycle of a two-element
  gapless web player, so **every threshold in this tree is a design constant, not a standard**: the
  guide's deadband, its reseek band, its rate-trim ceiling, the jump threshold, the pre-roll tolerance
  and the guide-ready timeout are all repo-local values with recorded reasoning and no external source.
  `UNSOURCED` below always means *no evidence was found*, never *no evidence was sought*.
- **These rows do not restate `01-tv.md`.** The section that overlaps most is XR-TV-12 (the state
  enumeration) and XR-TV-15 (the cook-step mapping); XR-TVM-04 and XR-TVM-05 constrain the *mechanism*
  those two rows assume rather than the frames they specify, and each says which half is already covered.

---

## Group 1 — Where a decision may live

### XR-TVM-01 — Every playback decision is a pure module, and the component only applies it

| Field | Content |
|---|---|
| **Statement** | Any decision that gates audio, transport, position or screen state is an exported pure function in a `.ts` module under `apps/core/src/lib/tv`, taking plain values and returning a plain value. A `.svelte` file may read inputs, call the function, and write the result to an element — it may not contain the branch. |
| **Surfaces** | TV (the module layer); the TV route and the six TV components as consumers |
| **Rationale** | A branch inside a `.svelte` file is not reachable without a browser, so it cannot be falsified by a unit test — and every one of this tree's recurring defects was a wrong branch, not a wrong pixel. Lifting the branch out is what turns "the wiring looks right" into "the decision is asserted". |
| **Source** | `DERIVED` — the decision-locality model above, plus the tree's own record: **all 15 modules name purity or unit-testability in their own prose**, and eight state it as the *reason* for the split in their file header (`transport.ts`, `video-src.ts`, `guide-sync.ts`, `screen.ts`, `lyrics-position.ts`, `reel-offset.ts`, `background.ts`, `visualizer-loop.ts` — each of the form "pure … so the decision is unit-testable without a real element"). `telemetry.ts`'s header states the failure mode explicitly for the case that was still inline: a source scan "reddens on a harmless rename and stays green on a subtle logic change; it never runs the code". |
| **Acceptance** | *Given* the TV tree, *when* every conditional expression in a `.svelte` file's `<script>` is collected, *then* each one is either a presence guard (`if (!el) return`), an application of a value returned by an imported module function, or a rendering condition — and **none** computes a transport, screen, seek, correction, offset or admission decision inline. Falsified by a single new `if` in a component that decides one of those. |
| **Check** | A source scan over `apps/core/src/lib/tv/*.svelte` plus `apps/core/src/routes/tv/+page.svelte`, asserting the decision-bearing identifiers (`transportFor`, `tvScreen`, `seekPlan`, `guideCorrection`, `nextVideoSrc`, `reelOffset`, `drawPosition`, `frameClock`, `cookStep`, `telemetryFrame`, `stageBackgroundCss`) are each *imported and called* rather than reimplemented. **This test does not exist yet.** The closest existing guards are per-decision wiring scans (`tests/guards/subsystem-tv/transport.test.ts` lines 62–198, `tests/guards/subsystem-tv/guide-sync.test.ts`), which pin one decision each and cannot see a *new* decision added inline. |
| **Priority** | **Must.** It is the rule the other nine rows are checkable *because of*. |

### XR-TVM-02 — Geometry is read only in a component, and never crosses back into a module

| Field | Content |
|---|---|
| **Statement** | No `.ts` module under `apps/core/src/lib/tv` reads a geometry API. Every measured value enters the module layer as a plain number in a named input field, and the component that took the measurement owns it. A module that would need to measure is a defect, not a case for an exception. |
| **Surfaces** | TV (the module layer); the verification suite |
| **Rationale** | The mount rung makes every geometry read throw, so a module that measures is a module no unit test can execute at all — the separation is what keeps the *decision* checkable on rung M even though the *measurement* is only checkable on rung L. |
| **Source** | Repo, verified: **zero** geometry reads exist in any of the 15 modules. Two components do measure — `apps/core/src/lib/tv/LyricsOverlay.svelte:213-218` (`getComputedStyle(row).lineHeight`, `viewportEl.clientHeight`, `row.offsetTop`, `row.offsetHeight`) and `apps/core/src/lib/tv/VisualizerStage.svelte:82` (`el.getBoundingClientRect()`) — and both hand plain numbers across the boundary: `reel-offset.ts:43,45,47` declares `rowTop`, `rowHeight` and `band` as measured inputs and reads nothing itself. `LyricsOverlay.svelte:240` holds the only `ResizeObserver` in the module tree. The rung facts are `tests/unit/core/lib/mount-rung.test.ts` (all six APIs throw; `ResizeObserver` asserted absent). |
| **Acceptance** | *Given* the 15 modules, *when* each is scanned for `getBoundingClientRect`, `getClientRects`, `offsetWidth`, `offsetHeight`, `clientWidth`, `clientHeight`, `scrollWidth`, `scrollHeight`, `getComputedStyle` and `ResizeObserver`, *then* the match count is **zero**; *and given* each component that does measure, *when* its call into the module layer is read, *then* every measured value is passed as a named argument. Falsified by one `el.clientHeight` inside a `.ts` module. |
| **Check** | Source scan over `apps/core/src/lib/tv/*.ts` — countable, needs no rendering. **This test does not exist yet**; `tests/unit/core/lib/mount-rung.test.ts` pins the harness side of the same contract (the APIs throw) but asserts nothing about which files may call them. Note the two halves land on different rungs by construction: `tests/guards/layout/reel-offset.test.ts` can assert the clamp arithmetic on rung M for any numbers, and **cannot** assert that the numbers passed in are the ones the browser would produce — that half is rung L only. |
| **Priority** | **Must** for the module ban (it is one scan and it protects the whole rung split); **Should** for the named-argument clause. |

> **Consequence, stated rather than defaulted:** this row is *why* `TvPlayer.svelte` is the one TV
> component that can be mounted and driven (`tests/unit/core/lib/tv/playback-common-actions.test.ts:163`)
> and `LyricsOverlay.svelte` / `VisualizerStage.svelte` cannot. That is not an accident of history — it
> follows from which components measure. A future component that starts measuring leaves the mount rung
> on the day it does, and the guard above is the only warning anyone will get.

### XR-TVM-03 — Every threshold in the module layer is declared once, and shared by every path that needs it

| Field | Content |
|---|---|
| **Statement** | Each timing, tolerance or admission threshold in the TV module layer is an exported named constant declared in exactly one module, and every path that needs that answer imports it. No component declares a numeric threshold of its own, and no two constants express the same tolerance. |
| **Surfaces** | TV (the module layer) |
| **Rationale** | Two copies of one tolerance can only agree by luck, and when they diverge the symptom is not a wrong number but a *contradictory policy* — one path treating the guide as aligned while another treats it as lost. |
| **Source** | Stated at its own definition site: `apps/core/src/lib/tv/guide-sync.ts:39` declares `GUIDE_PREROLL_ALIGN_SEC` in that module precisely because **three** paths need the same answer (pre-roll alignment, post-jump re-alignment, and the drift governor's reseek band), and records that "copies of one tolerance is this repo's oldest habit and the reason the guide's transport once drifted from the master's". The threshold values themselves are `UNSOURCED` — see the provenance note: they are repo-local design constants with recorded reasoning and no external standard. |
| **Acceptance** | *Given* the module layer, *when* every numeric literal that expresses a threshold is collected, *then* each is a single `export const` and appears exactly once outside comments; *and given* the components, *when* their `<script>` blocks are read, *then* every local numeric constant is either a component-lifetime value no module needs, or is **passed into** the module that decides with it. The four that exist today are the closed exemption list: `GUIDE_READY_TIMEOUT_MS = 4000` (`TvPlayer.svelte:153`, a per-slot give-up timer), `SCALE = 0.5` (`VisualizerStage.svelte:39`, a canvas backing-store ratio), `FRAME_MS = 33` (`VisualizerStage.svelte:41`, which is passed as an argument to `frameDue` at `:115` — the shape this row wants), and `CHIP_STEPDOWN = 12` (`TvLobby.svelte:56`). Falsified by a fifth literal, or by any of the four being duplicated in a module. |
| **Check** | Source scan collecting `export const` threshold declarations and asserting no bare literal duplicates one. Extends `tests/guards/subsystem-tv/guide-sync.test.ts`, which today asserts the *behaviour* at each threshold and not the singleness of its declaration. **The duplication half does not exist yet.** |
| **Priority** | **Should.** The duplication has not recurred since the constants were centralised, so this row exists to stop it recurring, not to fix a present defect. The exemption a reader may reasonably dispute is `CHIP_STEPDOWN`: XR-TV-14 requires the lobby step-down threshold to be "declared in one place", and it is — inside a component, where no module can read it. That satisfies XR-TV-14 and sits at the edge of this row. Distinct from XR-TV-09, which is the same discipline for **CSS** tokens; this is the TypeScript-constant half and neither guard sees the other's layer. |

---

## Group 2 — Player lifecycle and transitions

### XR-TVM-04 — No slot may play an element that is not holding the current *entry's* src

| Field | Content |
|---|---|
| **Statement** | The transport decision is three-valued — `play`, `pause`, `idle` — and returns `idle` whenever the element is not holding the src for the **current queue entry**. Entry identity, not song identity and not the src string, is what re-arms the transport. No combination of slot inputs may produce `play` on an element whose src has not landed. |
| **Surfaces** | TV (both player slots) |
| **Rationale** | Assigning `HTMLMediaElement.src` invokes the media load algorithm, which sets `paused` back to true and rejects a pending `play()`. So `play()` before the src lands is not merely early — it is *undone*, and the element then sits fully buffered, correct duration, no error, permanently paused at 0. Folding `idle` into `pause` invites a caller to treat the two as interchangeable and reopens the race from the other side. |
| **Source** | Repo, verified: `apps/core/src/lib/tv/transport.ts:67` is `if (!playable \|\| !hasSrc) return 'idle';`, and `transport.ts:135` defines the entry-scoped token `` `${entryId}\|${src}` ``. The measurement is recorded in that module's own header, taken both in the running app and on an isolated element in the same browser: play-then-src leaves `paused=true, currentTime=0, webkitAudioDecodedByteCount=8641` (the preload buffer only); src-then-play reaches `currentTime=3.91, decodedByteCount=216798`. |
| **Acceptance** | *Given* `hasSrc: false`, *when* all 16 combinations of `playable`/`active`/`visible`/`playing` are enumerated, *then* **none** returns `play`; *and given* two consecutive turns of the **same song** (two entry ids, one byte-identical src), *when* the advance happens, *then* the transport value takes a genuine `idle → play` edge. The second clause is the falsifiable one: a transport keyed on the src string alone stays `play` across that advance with an unchanged value, no effect re-runs, and the room goes silent at 0 with every surface reporting playback. |
| **Check** | `tests/guards/subsystem-tv/transport.test.ts` — exists, and covers both halves: the exhaustive 16-combination arm asserts no input plays a src-less element, and the wiring arms (lines 62–198) pin that `TvPlayer.svelte` passes the entry-scoped token rather than a bare src truthiness check. Audible confirmation is rung L. |
| **Priority** | **Must.** The failure mode is total silence that every other surface reports as normal playback. |

### XR-TVM-05 — Catalog churn cannot reach a playing slot, and an input is never a trigger

| Field | Content |
|---|---|
| **Statement** | Server catalog truth enters through exactly one writer; what a slot is handed is an immutable branded snapshot taken at an explicit playback transition, never a live catalog record; and no effect that repositions or reloads a playing element may take that snapshot as a *tracked dependency*. All three hold independently. |
| **Surfaces** | TV (the route as catalog owner, both player slots as consumers) |
| **Rationale** | The reported defect — an unrelated song finishing its cook yanks the playing song's playhead back to an earlier part — was fixed four times and returned four times, because each fix hardened one consumer against one churn path while the invariant stayed prose. Redundancy is the point: two independent reasons the class stays shut, so the *next* consumer wired into the player cannot reopen it. |
| **Source** | Repo, verified: `apps/core/src/lib/tv/catalog.ts:38` (`mergeCatalog`, the sole writer, taking a full server list so it cannot express a partial local edit), `catalog.ts:61` (the branded `PlaybackSnapshot` — a compiler boundary, so a live record is not assignable to a slot), `catalog.ts:73` (`snapshot`, frozen top-level copy). The single call site is `apps/core/src/routes/tv/+page.svelte:198-199`, inside `syncSlots`. The consumer half is the seek effect in `TvPlayer.svelte`, whose whole body is a named function so its tracked reads are two visible lines and everything else is read through `untrack`. |
| **Acceptance** | *Given* a `media:status` tick for a song **other** than the one playing, *when* it is delivered, *then* the playing element's `currentTime` is unchanged and its `src` is not reassigned; *and given* the tree, *when* every write to the catalog is collected, *then* there is exactly one and it goes through `mergeCatalog`; *and given* the seek effect, *when* its tracked reads are collected, *then* they are the seek target and the server revision, and **not** the media snapshot. The single falsifying observation is a `currentTime` that moves on a foreign cook tick. |
| **Check** | `tests/guards/subsystem-tv/playhead-isolation.test.ts` — exists, and drives `mergeCatalog`/`snapshot`/`cookIsTerminal` directly plus a source scan of the effect's dependency set. The type boundary needs no test: it is a compile error. |
| **Priority** | **Must.** Four regressions is the evidence that a single mechanism here is not enough. |

### XR-TVM-06 — The `waiting` hold has a bounded exit that does not depend on one wire frame arriving

| Field | Content |
|---|---|
| **Statement** | Entering `waiting` for media that is still cooking arms a client-side ceiling. The room leaves `waiting` on whichever comes first: the server's explicit playback event, a terminal cook signal, or that ceiling elapsing — and the ceiling's expiry renders a stated frame rather than falling back to a blank or a stale one. |
| **Surfaces** | TV (the gapless controller and the route's cook handler) |
| **Rationale** | A hold with no timer has exactly as many exits as it has *delivered messages*, so a single dropped frame is indistinguishable from a cook that is still running — and the observable result is a party staring at "Making the karaoke" for the rest of the evening with no way to tell whether waiting is the right thing to do. |
| **Source** | Repo, verified — this is a present gap, not a hardening: `apps/core/src/lib/tv/gapless.ts:134-136` is the whole of `enterWaiting()`, a single state assignment with no timer, and its own callers say so (`catalog.ts:89`'s docstring: "`enterWaiting()` sets no timer — so without this the party stares at 'Making the karaoke' forever"). The two exits that exist are the server's `queue:sync` + `nowplaying:changed` pair, and `apps/core/src/routes/tv/+page.svelte:391`, which fires only when `cookIsTerminal(e)` **and** the frame's `mediaId` equals the held entry's. The **ceiling's value** is `UNSOURCED`: no measurement of real cook duration was taken in this session, so the number is a decision nobody has made, not a figure to copy from here. |
| **Acceptance** | *Given* the room in `waiting`, *when* no further `media:status` for the held entry is delivered (a reconnect that drops the terminal frame), *then* the room leaves `waiting` within the stated ceiling and renders the stated frame; *and given* a cook that completes normally inside the ceiling, *then* the ceiling never fires. Falsified by a `waiting` state that persists indefinitely with no inbound frame — which is what happens today. |
| **Check** | A unit test on `GaplessController` driving the clock: enter `waiting`, advance past the ceiling with no event, assert the state left. `tests/unit/core/lib/tv/gapless.test.ts` exists and is the right home; **the timeout arm does not exist yet, because the timeout does not exist yet.** The controller is pure and clock-free today, so the ceiling must be injected as an input rather than read from a global — otherwise the test needs fake timers and the module stops satisfying XR-TVM-01. |
| **Priority** | **Must.** It is the only enumerated TV state (XR-TV-12) whose exit depends on a message that can be lost, and the failure is silent and permanent. |

> **Recommendation (not decided).** Put the ceiling on `GaplessController` as an injected deadline
> rather than a `setTimeout` in the route, and have expiry route to the **existing** error treatment
> (the `danger` family XR-TV-11 already assigns to skipping) with wording that says the wait was
> abandoned rather than that the cook failed — the TV does not know which. Two things that argue
> against a route-level timer: the route already owns the interstitial timer, and a second timer there
> would put the exit condition for a controller state outside the controller that owns it.

### XR-TVM-07 — A failed or missing file degrades to a *stated* state, never to a stall

| Field | Content |
|---|---|
| **Statement** | Every way the audio path can fail to produce sound is classified at the one place that resolves the `play()` promise, and each class routes to a distinct outcome: a gesture-liftable refusal arms recovery and says a tap is needed; a non-liftable failure raises an operator-facing reason; a real interruption is left for the next pass. No failure class is swallowed, and none leaves the room believing it is playing while it is silent. |
| **Surfaces** | TV (both slots; only the active, visible slot may report) |
| **Rationale** | Silence with every surface reporting playback is the worst available outcome, because nobody in the room can tell it from a quiet song — and a blanket `catch` makes the three classes indistinguishable, which is how a self-inflicted `AbortError` went unseen through two rounds of diagnosis. |
| **Source** | Repo, verified: the classification lives in `tryPlayMaster` in `apps/core/src/lib/tv/TvPlayer.svelte`, branching on `name === 'NotAllowedError'` first, then on whether a non-`NotAllowedError` rejection **left the element paused** (recoverable — arm the same gesture path) versus not (report `onplaybackfailed`). Reporting is gated on `active && visible` at all three sites. The route's consumer is `+page.svelte:1272-1277` (the silent-room panel) and `:923`/`:956` (the reason capture). The **three-class taxonomy** is `DERIVED` — model: a rejection is recoverable iff a user gesture can change its outcome, which is observable as whether the element is still paused after the rejection. |
| **Acceptance** | *Given* each of the three rejection classes on the active visible slot, *when* it occurs, *then* exactly one of {autoplay hint armed, silent-room panel with a reason, no user-visible change} is produced, and the mapping is total over the classes; *and given* the **hidden** pre-warming slot, *when* any of them occurs, *then* no room-facing state changes at all. Falsified by a rejection that produces no on-screen consequence and no armed recovery while the server still reports the room as playing. |
| **Check** | `tests/guards/subsystem-tv/autoplay-recovery.test.ts` — exists, and pins the `NotAllowedError`-specific branch, the armed listener pair, the latch clear, and the route's two takeover slots. It is a **source scan**, so it cannot observe the three classes actually being produced; the behavioural half needs a mount that stubs `play()` to reject with each class in turn, which `tests/unit/core/lib/tv/playback-common-actions.test.ts:163` establishes is possible for this component (it reads no geometry, so it is on the mount rung). **That behavioural arm does not exist yet.** |
| **Priority** | **Must** for the taxonomy being total; **Should** for promoting the check from a scan to a mount. |

---

## Group 3 — Timing, data flow, and what the TV must not depend on

### XR-TVM-08 — No TV state transition depends on a phone holding a socket

| Field | Content |
|---|---|
| **Statement** | The TV's screen selection and its lyric advance are functions of room membership and of the TV's own element, never of live socket count. A singer who is *away* — in the room with an unreachable phone — counts as present, and a queue that exists with nobody connected keeps the lobby rather than reverting to attract. |
| **Surfaces** | TV; contrast with the phone, which is the surface a socket loss legitimately blanks |
| **Rationale** | A shared display's whole value is that it keeps telling the room what is happening when nobody is looking at a phone — so treating a pocketed handset as an absent guest wipes the screen at exactly the moment the room stopped holding their phones, and a rehydrated queue with no phone yet connected reads as a lost queue. |
| **Source** | Repo, verified: `apps/core/src/lib/tv/screen.ts:39` names the input `inRoomCount` and its docstring states the rule — "holding a socket *or* away with one still counted. Not the socket count… treating it as empty is what used to send the TV back to the attract screen mid-party". `screen.ts:57` is `if (inRoomCount > 0 \|\| entries.length > 0) return 'lobby';`, so a non-empty queue alone holds the lobby. The route supplies `online.length + away.length` at `apps/core/src/routes/tv/+page.svelte:505`. The advance rule is `screen.ts:88`, which requires the room's `isPlaying` **and** `elementAdvancing` — the honest signal from the master element's own `play`/`pause` — so a refused autoplay freezes the reel instead of sweeping over a silent room. |
| **Acceptance** | *Given* a room whose entire roster is `away` and whose queue is non-empty, *when* the screen is derived, *then* it is `lobby`, not `attract`; *and given* every socket closed with entries still present, *then* it is still `lobby`; *and given* the server reporting `isPlaying: true` while the master element is paused, *then* the lyric reel does **not** advance. Each clause names one falsifying observation. |
| **Check** | `tests/guards/subsystem-tv/screen.test.ts` — exists, and drives `tvScreen` and `lyricsAdvancing` directly with these inputs. The wiring half (that the route passes `online + away` rather than `online`) is a source scan and is the arm most likely to rot, since a caller can quietly narrow the argument without touching the module. |
| **Priority** | **Must.** The failure is a wall that goes blank mid-party, and it is one argument away at all times. |

### XR-TVM-09 — No drawn value lives in an accumulator a stopped frame loop can lose

| Field | Content |
|---|---|
| **Statement** | Anything the TV draws from time is a pure function of an authoritative anchor plus, only while advancing, a clock reading passed in. No drawn value is accumulated frame to frame, and any baseline a loop needs is owned by the caller so it survives the loop being torn down and rebuilt. |
| **Surfaces** | TV (the lyrics reel, the visualizer) |
| **Rationale** | A backgrounded tab has its animation frames throttled or stopped, so a loop that is the *sole keeper* of a drawn value does not compute a wrong result — it computes nothing, and the value decays toward its initial. Nothing is mis-derived and no test can see it, which is why the remedy is purity rather than a wake-up handler: re-deriving on a visibility event papers over the accumulator while leaving it in place. |
| **Source** | Repo, verified, and this is the same rule extracted from **two** separate defects. `apps/core/src/lib/tv/lyrics-position.ts:50-53`: the paused branch returns `positionSec` exactly, with no clock term at all — reaching a position by playing there, seeking there, or backgrounding and returning must all draw the identical offset. `apps/core/src/lib/tv/visualizer-loop.ts:34`: `frameClock(now, start)` takes the baseline **in** and hands it **back**, because it previously lived in a per-effect-run local, so every effect re-run reset it and pinned the elapsed time near zero — every frame drew the same picture, which reads as a static background. `DERIVED` for the generalisation from those two to a rule. |
| **Acceptance** | *Given* a paused reel at a known position, *when* the frame loop is stopped entirely, *then* the drawn position is unchanged and equals the anchor; *and given* a loop rebuilt mid-song with the caller's baseline threaded through, *when* the elapsed time is read, *then* it continues to climb rather than restarting at zero. Falsified by a drawn value that differs depending on *how* the current position was reached. |
| **Check** | `tests/guards/layout/lyrics-position.test.ts` and `tests/unit/core/lib/tv/visualizer-loop.test.ts` — both exist, and both simulate a stopped or re-run loop by threading values through rather than by driving real frames. The **visual** confirmation that a backgrounded reel holds its place is rung L; there is no rung-M form of it, so that half is `EXEMPT` here and the pure path-independence property stands in for it. |
| **Priority** | **Must** for the paused branch (the symptom is the reel snapping to the first line, which strands a singer mid-song); **Should** for the loop baseline. |

### XR-TVM-10 — The unshifted audio path constructs nothing, and a graph that cannot run degrades audible

| Field | Content |
|---|---|
| **Statement** | At key shift zero the TV builds no `AudioContext` and no `MediaElementAudioSourceNode`, so the audio path is byte-for-byte the plain-element path. The graph is built lazily on the first real shift, and the element is committed to it **only** after a context is confirmed running. A build that cannot run a context leaves the element on its native output — audible and unshifted — and stays retryable. |
| **Surfaces** | TV (the active slot only; the hidden pre-warming slot never shifts) |
| **Rationale** | A `MediaElementAudioSourceNode` is a **permanent** capture: once created, the element's audio reaches the speakers only through the graph, and detaching frees the context without restoring the native path. A TV wall may never receive a user gesture, so a context created there starts suspended — and capturing an element into a suspended graph is not a degraded shift, it is total silence for the whole room. A broken transpose is bad; killing all room audio is categorically worse. |
| **Source** | Repo, verified: `apps/core/src/lib/tv/pitch-shift.ts:393` returns early at ratio 1 with no graph built; `:440` refuses to proceed when `ctx.state !== 'running'`, closes the context and marks degraded; `:453` is the `createMediaElementSource` call, reached only past that check; `:460` sets `routed`. `needsShift` (`pitch-shift.ts:58`) is bit-exact at zero by construction, since `semitonesToRatio` returns exactly `1` rather than a `0.9999…`. The worklet's own `MAX_RATIO = 1.5` (`pitch-shift.ts:127`) is sized from the UI's ±7-semitone clamp with an assertion rather than a round number, so widening the clamp trips the assertion instead of aliasing silently. |
| **Acceptance** | *Given* a room at key shift 0 for a whole song, *when* the audio path is inspected, *then* no `AudioContext` was constructed; *and given* a first non-zero shift in a document with no user gesture, *then* no `MediaElementAudioSourceNode` exists, the element is still audible, and a later shift after a gesture succeeds; *and given* a return to 0 on a built graph, *then* the graph is left in place at ratio 1 rather than torn down. The falsifying observation for the second clause is a silent room after a pre-gesture key press. |
| **Check** | `tests/unit/core/lib/tv/pitch-shift.test.ts` and `tests/guards/subsystem-tv/pitch-shift-graph-lifetime.test.ts` — both exist; the first covers the pure ratio and framing maths and the concurrent-build coalescing, the second the per-element lifetime and the release sites. **`EXEMPT` on rung M for the audible half**, and the exemption is worth stating plainly: whether the shifted output actually *sounds* right needs real audio hardware, the graph controller's own header says it is not unit-tested for that reason, and a headless Chromium's codec support is not the room's — so "audible and unshifted" is verified as *not silent by construction* (no capture was made), not as measured sound. |
| **Priority** | **Must.** This is the one row in this section whose failure mode takes down every other row's subject at once. |

---

## Requirements deliberately NOT written, and why

1. **Which frame each TV state renders.** XR-TV-12 enumerates all ten and XR-TV-13/14 specify the
   chrome and the lobby. XR-TVM-06 constrains only the *exit mechanism* for one of them, and XR-TVM-08
   only which inputs may select one.
2. **The three-step cook mapping's totality.** XR-TV-15 already requires it and
   `tests/guards/subsystem-tv/screen.test.ts:193-219` already enforces it across all seven statuses. Not
   restated — but see the finding immediately below, which is about the *caller*, not the mapping.
3. **The gapless A/B swap itself.** `tests/unit/core/lib/tv/gapless.test.ts` covers the controller's
   transitions, and the swap has not regressed. A requirement would restate a passing test.
4. **The phrase set's admission rule and its bag ordering.** XR-TV-16 and XR-TV-17 own both, and
   `tests/unit/core/lib/tv/phrases.test.ts` enforces them against the data. `phrases.ts` is in this
   section's subject tree but its contract is already specified elsewhere.
5. **Reduced-motion behaviour.** XR-TV-05 owns it for every animated TV surface;
   `visualizer-loop.ts`'s `shouldAnimate` is the module-layer half and needs no separate rule.
6. **The stage background's colour bound.** Retired deliberately — the defence moved onto the lyric
   reel's own text stroke, which is strictly stronger, and both halves are already enforced. XR-TV-04
   and XR-TV-11 cover the colour rules.
7. **Numeric values for the guide thresholds.** XR-TVM-03 requires each to be declared once and shared;
   it does **not** ratify a value. Every one is a repo-local design constant with recorded reasoning and
   no external source, so specifying a number here would dress a judgment as a finding.
8. **A ceiling value for the `waiting` hold.** XR-TVM-06 requires the ceiling to exist; the duration is
   left open because no measurement of real cook duration was taken in this session. Inventing one would
   be exactly the plausible-unmarked-number this document exists to refuse.
9. **Whether the still-cooking takeover should show real per-media progress.** The route feeds a
   **constant** representative stage (`apps/core/src/routes/tv/+page.svelte:1173` is
   `cookStep('separating')`), and its own comment records why: per-media cook tracking was deliberately
   stripped from the TV because a cook for one song was reaching another's playhead. So the bounded
   3-step indicator is honest about *what* the room is waiting for and **static** about how far along it
   is — the bar is always 62 %. Reinstating real progress means reintroducing the coupling that
   XR-TVM-05 exists to forbid, and that trade is a ruling nobody has made. A requirement either way
   would be inventing it. What is *not* open is the labelling question: an indicator that cannot advance
   should not read as though it can.
10. **Anything about how the TV looks.** Type, colour, safe areas, paint order, target sizes and frame
    verification all belong to `01-tv.md`, `03-colour-tokens.md` and `04-verification.md`. This section
    specifies only what has to be true beneath them.
