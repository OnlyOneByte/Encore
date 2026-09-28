# THE PLAN — Encore UI

> **STATUS — all 22 remaining items resolved on `ui/review`.** Each was implemented by a dedicated agent
> that read the cited code and ran the gates, then adversarially re-verified by a second agent against the
> tree. Every fix was re-measured where a measurement settles it.
>
> **Landed (first pass):** N1 search field 4px → 142px at 320px · N2 `min-h-tap` (verified 115 buttons,
> shortest 44px) · N3 phantom dock 100px → 28px · N4 overflow 334 → 320 · N5 service worker stops teeing
> media (+9 tests) · N7 search announces · N9 drawer handle 1.09:1 → 3.32:1 · N10 heading semantics ·
> N11 TV reel re-anchors on resume · W4 one card surface · the unlayered `font: inherit` → `@layer base`
> (`<button>` 14.4px → 14px) · the `/components` gallery rendering all 24 primitives in pairs.
>
> **Landed (second pass):** N6 · N8 · N12 · N13 · N14 · N15 · N16 · N17 · N18 · W1 (drawer out of the
> baseline: 54.6% raw / 51.2% gzip, 22 files → 11) · W2 · W3 · W5 · W6 (26 sites) · W7 · W8 · W9 (all but
> one hunk) · W11 · W12 (12/13 hunks) · W13 · W14 · plus the library-count unification.
>
> **NOT landed, deliberately — two, each with a reason:**
> * **W10 was rejected.** Its patch lowered the 440px column floor to `min(440px, (100% - gap)/2)`, giving
>   two 339px tracks at 768px, and its own comment admitted this "overturns DELIBERATE NO 9". That entry
>   exists because a reviewer already argued for it once: the 440 is measured and a narrower column
>   truncates every title. A 23% cut below a measured floor is not for one agent's argument to overturn,
>   and the verifier agreed the patch should be rejected if the floor stands. **The single-column stretch
>   at 768–1199px is therefore still open** — the honest options are to centre the single track rather than
>   stretch it (keeps the floor, keeps the margins) or to accept shorter titles. Owner's call.
> * **W9's last hunk** expects a `<div class="lib-empty tight">` wrapper inside /library's `Empty.Root`
>   that exists in neither direction of the tree; there is nothing to match and inventing it would be
>   writing markup no verifier saw.
>
> **Verified live** at 320/360/390px on `/`, `/library`, `/settings` and on `/tv` at 720p/1080p/1440p/4K:
> zero horizontal overflow, zero text-entry controls under the 16px iOS floor, no JS errors, TV root font
> scaling 20px → 58.32px with geometry tracking it. Gates: 2097 tests pass, 0 type errors, 0 lint errors
> (warnings 20 → 18, N18). The two 18.39px `/settings` switches are not defects — each sits in a 44px
> `<label>`, the sanctioned hit-area pattern already in the measured gate's waiver registry.

## Verdict (5 sentences)

The written layer of this codebase is better than the code in most shipped products: `app.css` argues for every token it declares, `docs/FRONTEND.md` names the defects the repo has already shipped and the rule each one produced, and the authored components genuinely hold that line — `ColourRing` derives every dimension from `--tap`, the focus-ring architecture beats Tailwind's `outline-none` with a plain unlayered selector list, 49 of 49 `{#each}` blocks are keyed, all 14 icon-only buttons carry `aria-label`, and every ink/surface pair I had measured comes in above AA. The TV is the most competently engineered surface: a `vh`-rooted rem ladder that doubles cleanly 720p→4K, one composited transform for the lyric reel, a pure `drawPosition` so a throttled rAF cannot decay the playhead. The single biggest weakness is that **the phone home's primary control is unusable on a real phone**: three unshrinkable siblings in `.find-row` leave the search input measured at 4–12px wide at 320–390px, with the clear `×` painting over the source picker — and that picker is the known-bad raw `<select>`, which is the *cause*, not a coincidence. Behind it sits one structural theme, repeated by four independent lenses: **a decision made once and never generalised** — `identity` got the tap floor and `default` didn't, `.card` got the lit edge and `Card.Root` didn't, `+layout.svelte` fixed the anchor-effect bug and `LyricsOverlay` didn't, `/library` wrote down the `$state.raw` rule and `/` ignored it. Nothing here is rotten; almost everything on this list is a five-line generalisation of a fix the repo has already made and documented.

**Review policed itself: 4 findings discarded as REFUTED.** Notably (a) "adopt `Empty.Media` on `/`" — refuted because FRONTEND.md explicitly sanctions route-local marks and the primitive is pure-Tailwind; (b) "the band should shrink to 64px on short viewports" — refuted because 88px *is* `--tap` + the drag stack + minimum strip padding, so 64 clips the app's only transport; (c) "the layout clones the queue array twice per emit" — refuted, `RoomLink.entries` is a plain field, not `QueueStore`'s cloning getter; (d) "the search-source vocabulary needs a registry / the picker omits `spotify`" — refuted, `spotify` is not a separate narrowing. A further ~8 findings survived as defects with their *stated fix rejected*; those are in WORTH DOING with the reason, not in FIX NOW.

---

## 1. FIX NOW

Ordered by user impact per unit of effort.

### N1 — The search field is 4px wide on a real phone
`core/src/routes/+page.svelte:945-955` + swap the raw select for the primitive. Independently found by the responsive lens and pre-identified as the known-bad example; the two are the same bug.

Measured at 320px: input content box 12px idle, **4px while searching**, findbox content overflowing its own border by 30–56px. At 390px (iPhone 12–15): 82 / 4 / 28. A guest types "bohemian rhapsody" and sees roughly one letter and no caret.

```diff
 	.find-row {
 		display: flex;
+		flex-wrap: wrap;
 		gap: var(--space-md);
 	}
+	/* THE PICKER YIELDS THE ROW, not the field. The comment on `.lib-slot`'s pin was written when there were
+	   two controls; with three pinned items the shrinking field has nothing left. 520px is --bp-sm, a media
+	   literal because a custom property cannot be a media condition. */
+	@media (max-width: 520px) {
+		.source-slot {
+			flex: 1 1 100%;
+		}
+	}
```
Then replace `<select class="source-select">` (markup ~591-602) with `core/src/lib/components/ui/native-select`, and delete the `.source-select` rule (`:951-960`) entirely. The primitive is `w-full`, has `text-overflow: ellipsis`, `appearance: none`, an **explicit** `font-size: var(--ph-text-base)` (the raw one only *inherits* 16px from `body`, so any ancestor font-size silently breaks the iOS zoom floor) and `min-height: var(--tap)`.

Re-measured after the wrap: 320px → 142 idle / 88 with results / 63 searching, zero overflow. 390px → 212 / 158 / 133.

### N2 — Every `<Button>` without `size` is 36px, under the repo's own 44px floor
`core/src/lib/components/ui/button/button.svelte:71`. **Found independently by design-system and a11y.** One line.

`default: 'h-9 …'` is the default of both `defaultVariants` and the prop. Live 36px controls: `/settings?tab=you`'s entire leave-the-room flow (`Leave the room`, `Stay`, `Yes, leave`), `/library`'s only refinement control (`Sort & filter · Queen`, `variant="eyebrow"` — which also declares no height), `Use these lyrics`/`Cancel` in `LyricsReselect`, and all four `/admin` delete controls. The primitive already knows the floor: `identity` carries `min-h-tap` with the comment *"it declares no height and would otherwise inherit the 36px default."*

```diff
-		base: "rounded-md border border-transparent bg-clip-padding text-sm font-medium …
+		base: "min-h-tap rounded-md border border-transparent bg-clip-padding text-sm font-medium …
```
`min-height` beats `h-9`; grep confirms no caller uses `xs`/`sm`/`lg`/`icon-*` (only `Progress size="sm"` matches), and `AlertDialog.Action`/`Cancel` inherit it free because they compose `buttonVariants`. Add `min-h-tap` to `eyebrow` too (`:36`) — it is a label-shaped control that will keep being called without a size.

**Part b, same change:** add `/settings?tab=you`, `/song/[mediaId]` and `/admin` to the `surface()` list in `tests/playwright/specs/gate/measured-hit-extents.spec.ts`. The measured gate visits `/`, `/library`, `/settings` (party + server), `/metrics`, `/stats` — it structurally cannot see five of the six defects above.

### N3 — The join screen reserves 72px for a band that is not there
`core/src/routes/+layout.svelte:120-126`. The `$effect` has no dependency on `showBand`, so `--dock-h: 72px` lands on `:root` for an unjoined guest, and on `/tv`, `/admin`, `/metrics`, `/components`. `main { padding-bottom: calc(var(--dock-h, 0px) + 28px) }` then reserves 100px of nothing and `.submit-slot`'s auto margin docks the app's *first* button 72px above where it belongs. With the room-code keyboard up on a 320×568 phone that is ~21% of the visible viewport.

```diff
 	let dockH = $state(72);
 	$effect(() => {
+		// Gated on the same derived value the band is gated on: an ungated write leaves 72px of phantom dock on
+		// the join screen and on /tv, where `var(--dock-h, 0px)`'s fallback is the correct answer.
+		if (!showBand) return;
 		document.documentElement.style.setProperty('--dock-h', `${dockH}px`);
 		return () => {
 			document.documentElement.style.removeProperty('--dock-h');
 		};
 	});
```

### N4 — A dropped socket pushes the settings gear off a 320px screen
`core/src/routes/+page.svelte:1024-1035`. `.offline-pill` is `white-space: nowrap` with no `min-width` and no `overflow`, so min-content == max-content == 133px and flexbox cannot shrink it. Measured at 320px with the pill showing: `document.scrollWidth` 334 against a 320 viewport (horizontal scrollbar on the home screen, SC 1.4.10), gear's right edge at 334, `.me-name` computed to **0px**. Fires precisely when the wifi is flaky at a party.

```diff
 	.offline-pill {
 		display: inline-flex;
+		min-width: 0;
+		overflow: hidden;
 		…
 	}
 	.me-name {
+		/* `text-overflow: ellipsis` needs a non-zero box to draw into; without a floor the singer's own name
+		   disappears entirely and the identity control reads as a bare colour dot. */
+		min-width: 4ch;
```

### N5 — The service worker tees every audio and video byte the TV streams
`core/src/service-worker.ts:35-48`. `/media/…` is neither `/ws` nor `/api`, so instrumentals and backing video fall through to the catch-all: `res.clone()` tees a streaming body on the machine with the least RAM in the room, `cache.put` on the endpoint's 206 rejects **with no `.catch()`** (one unhandled `TypeError` per range probe, in the one console an operator debugging a party looks at), and any full 200 is written whole to an SD card beside the precached app shell.

```diff
 	if (url.pathname.startsWith('/ws') || url.pathname.startsWith('/api')) return;
+	// Streams, not documents: a 206 cannot be cached (cache.put rejects) and a full instrumental must not be.
+	// `request.destination` leaves /media/<lyricsRef> (destination `empty`, small JSON) cached, which is the one
+	// thing under /media worth caching.
+	if (request.destination === 'audio' || request.destination === 'video' || request.headers.has('range')) return;
 	…
 			.then((res) => {
-				const copy = res.clone();
-				void caches.open(CACHE).then((c) => c.put(request, copy));
+				if (res.ok && res.status === 200) {
+					const copy = res.clone();
+					void caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
+				}
 				return res;
 			})
```

### N6 — Adding a song is single-use for anyone not holding a pointer
`core/src/lib/components/SongRow.svelte:266-277` + `core/src/routes/+page.svelte`. Press Enter on `+`: the optimistic add flips `disabled` true on the *focused* button, every browser blurs a focused element that becomes disabled, and nothing is announced — `queueAnnouncement` deliberately stays silent for your own adds because "the row appearing is its own confirmation", but in the search-results view `searchActive` has replaced the queue, so no row appears. Three adds from one search = three silent focus resets to `<body>`.

```diff
-					disabled={inQueue || !processable}
-					onclick={() => onadd?.()}
+					aria-disabled={inQueue || !processable || undefined}
+					onclick={() => {
+						if (inQueue || !processable) return;
+						onadd?.();
+					}}
```
`data-row-state` and `actionLabel` already carry the state visually, and an `aria-disabled` control stays in the tab order, so "Already in the queue" becomes reachable instead of being a name nobody can land on. In `+page.svelte`'s `addSong`, beside `store?.addSong(mediaId)`: `liveMsg = \`Added ${mediaTitle(mediaId)} to the queue\`;`

### N7 — Search results land in total silence
`core/src/routes/+page.svelte:177-215`. A screen-reader guest types, waits, and hears nothing: the `Searching…` skeleton's `role="status"` is conditionally *inserted* so it never announces, and the settled result writes to no live region. `/library` already does this right at `:192`. SC 4.1.3's own understanding doc uses "search returned N results" as the canonical example.

In `runSearch`, after the post-parse abort re-check (`:202`):
```diff
 			room.mergeMedia([...readyResults, ...rawResults, ...processingResults]);
+			const n = readyResults.length + rawResults.length + processingResults.length;
+			liveMsg =
+				n === 0
+					? `No songs found for ${q}`
+					: `${n} song${n === 1 ? '' : 's'} found — ${readyResults.length} ready to sing`;
 		} catch (e) {
 			if ((e as Error).name !== 'AbortError') {
 				clearResults();
 				showError('Search failed.');
+				liveMsg = 'Search failed.';
```
The existing `.sr-live` region is polite and `aria-atomic`, so a fast typist's superseded searches replace rather than queue.

### N8 — Arrow-key reorder works exactly once, then drops focus to `<body>`
`core/src/routes/+page.svelte:406-414` → `QueueRow.svelte:97`, `ProcessingCard.svelte:106`. `commitMove` sets `pending='move'`, `{#if grip && !pending}` goes false, the focused button is removed from the DOM, and `focusGrip(id)` queries a `[data-grip]` that no longer exists with no `fallback` argument. To move a song two places you Tab in from the top of the document again. The drag path has the same fault (`endDrag` passes `openerEl`, already detached).

```diff
-{#if grip && !pending}
+{#if grip}
 	<Button
 		…
+		aria-disabled={pending === 'move' || undefined}
```
and guard both handlers with `if (pending) return;` at the top of `onpointerdown` and of the arrow branch of `onkeydown`. Keep the real `disabled` attribute **off** — it blurs too. The documented reason for withholding the grip ("a second reorder against a position the server has not agreed to") is fully satisfied by the handler guard, and the row's existing `--warn-bg` tint plus `moving…` byline already explain why the press did nothing.

### N9 — The drawer's grab bar measures 1.09:1 against the sheet
`core/src/lib/components/ui/drawer/drawer-handle.svelte:14`. `--muted` aliases `--card2` (#212133) over a `--card`-derived `--chrome-fill` (#1a1a28). That 6px bar is the *only* visible affordance saying the band can be pulled up to reach the transport, the ± semitone caps and the guiding track; at party brightness it is not there. All the careful `--tap` hit-area arithmetic in this file is wasted on something invisible.

```diff
 	:global([data-slot='drawer-handle']) {
 		height: var(--space-xs);
+		/* `bg-muted` measures 1.09:1 on the sheet — the one signpost that the band is draggable, invisible in a
+		   dark room. ~3.3:1 clears the SC 1.4.11 non-text floor while staying quieter than --ink-dim (6.27:1),
+		   which would read as a control rather than a handle. Class left in place so the re-vendor diff stays visible. */
+		background: color-mix(in srgb, var(--ink) 38%, transparent);
 	}
```

### N10 — The first-run phone home has exactly one heading
`Empty.Title` renders a plain `<div>`, and the `nothingYet` branch replaces every `<h2 class="grouphead">` on the page — so on a first run the only heading in the document is the `h1` wordmark. A screen-reader guest cycling headings to orient learns nothing about what the app is. The repo already knows the fix: `settings/+page.svelte:453` writes `<Card.Title role="heading" aria-level={2}>` for exactly this reason. `empty-title.svelte` forwards `restProps`, so this needs no vendored diff.

`role="heading" aria-level={2}` on `+page.svelte:621`, `:647`, `:742`, and `library/+page.svelte:181`.

### N11 — The TV lyric reel flies forward on every resume
`core/src/lib/tv/LyricsOverlay.svelte:88-97`. This is the exact defect `docs/FRONTEND.md#a-dependency-set-is-not-a-value` says the tree has shipped twice; it was fixed at `+layout.svelte:103` and `+page.svelte:481` and never applied to the third site. `positionSec` only moves on `ontimeupdate`, which a paused `<audio>` never fires, so `anchoredAt` is frozen at the last pre-pause tick while the rAF clock restarts at the wall clock — for up to ~250ms after every resume the reel lurches toward the end of the song and every earlier line flips to the dimmed `.past` treatment, across the room, at ten feet.

```diff
 	$effect(() => {
 		// Re-anchor whenever the authoritative position ticks in, so the sweep never drifts far.
 		void positionSec;
+		// A resume re-delivers an EQUAL positionSec, so this is the only signal that can re-anchor it.
+		void playing;
 		anchoredAt = performance.now();
 		now = anchoredAt;
 	});
```
`drawPosition` ignores the anchor while paused, so re-anchoring on a pause is harmless.

### N12 — `/song/[mediaId]` shows the previous song under the new song's URL
`core/src/routes/song/[mediaId]/+page.svelte:29-39`. `mediaId` is `$derived(page.params.mediaId)` but `load()` is called only from `onMount`. The route is reached from the drawer's "···", which always targets the *current* song — so: read about song X, the song ends, Y starts, tap the link again. SvelteKit reuses the component, `onMount` never re-runs, and the page keeps X's title, key, range and lyrics candidates under Y's URL, with **Y's live `keyShift` applied to X's profile**. `+layout.svelte:85-92` documents this exact trap.

```diff
 		void room.connect();
-		void load();
 		return stop;
 	});
+
+	/* Keyed on the derived id, not onMount: this route is navigated to WITHOUT a remount (drawer "···" → the new
+	   current song), and onMount then runs exactly once. See docs/FRONTEND.md and +layout.svelte:85. */
+	let loadedId: string | undefined;
+	$effect(() => {
+		const id = mediaId;
+		if (id === loadedId) return;
+		loadedId = id;
+		void load(id);
+	});
```
Change `load()` to `load(id: string)` and use the parameter rather than re-reading the derived inside it, so the decision's input can never become its own trigger.

### N13 — Leaving the page fires a three-resolver search fan-out nobody will see
`core/src/routes/+page.svelte:101-105` is the file's only teardown (no `onDestroy` anywhere). Type "bohemian", tap the library door within 150ms — a normal impatient phone sequence — and the debounce still fires on the destroyed component, hitting `/api/search`, which fans out to YouTube Music, a disk scan and Spotify (median 459ms, ytsearch up to a 10s timeout), competing on a self-hosted Pi with the search the guest actually meant. If it fails, the guest gets a "Search failed." toast on `/library`, a page with no search box.

```diff
 		return () => {
 			stopMirror();
 			stopErrors();
+			clearTimeout(debounceTimer);
+			inflight?.abort();
 		};
```

### N14 — Overlapping TV skips wipe the second notice mid-read
`core/src/routes/tv/+page.svelte:188-192`. The handle is discarded, so the first flash's timer fires 4s after the *first* skip and clears the second notice a second after it appeared. Two unplayable files back to back is the realistic case (a batch of failed processes, a missing stems dir). `skipNotice` also gates `transient === 'error'`, so the takeover collapses with it and the room drops to a blank stage.

```diff
+let skipTimer: ReturnType<typeof setTimeout> | undefined;
 function flashSkipNotice(message: string) {
+	clearTimeout(skipTimer);
 	skipNotice = message;
-	setTimeout(() => (skipNotice = ''), SKIP_NOTICE_MS);
+	skipTimer = setTimeout(() => (skipNotice = ''), SKIP_NOTICE_MS);
 }
```
and at `:311`: `return () => { ws?.close(); clearTimeout(skipTimer); clearTimeout(interstitialTimer); };` — `interstitialTimer` is cleared on re-entry but never on teardown, so leaving `/tv` mid-intro leaves a pending `ctl.onInterstitialDone()`.

### N15 — One failed settings write reverts a concurrent successful one
`core/src/routes/settings/+page.svelte:205-225`. `const before = committed` is captured *before* the await. Flip a switch, drag a slider to its commit a second later, slider request fails on a flaky LAN → `settings = before` restores the snapshot taken before the switch was confirmed. The switch you just watched turn on turns itself back off, with the banner blaming the slider, and `/settings` has no socket so it stays wrong until the next write or a reload.

```diff
-		const before = committed;
 		settings = …
 		} catch {
-			settings = before;
+			// The LIVE confirmed value, not a pre-flight snapshot: `committed` is only ever assigned from an
+			// authoritative response, so it holds what the server holds at the moment this request failed.
+			settings = committed;
 			failed = true;
```

### N16 — The band's pull-up button never says whether the sheet is open
`core/src/lib/components/NowPlayingBand.svelte:100`. vaul's real handle is an `aria-hidden` div, so this button is the *entire* AT path into the transport, the ± caps, the guiding track and the only door to the song page. Its name is "Bohemian Rhapsody — now playing, button"; press it and a large region appears or disappears with nothing announced, and the body is `inert` when collapsed so it is not discoverable by exploring either.

The file argues a directional prop cannot work because a post-mount prop change re-runs the drawer's size bindings — true, and the sanctioned escape is an attribute written from an effect, exactly what `.np-fit`'s `inert` already is. Add `metaEl = $bindable<HTMLButtonElement | null>(null)` to the props + `bind:this={metaEl}` on the button (a `bind:this` write lands once, at mount); in `NowPlayingDrawer.svelte`, `bind:metaEl` and `$effect(() => { metaEl?.setAttribute('aria-expanded', String(!bodyHidden)); });`.

### N17 — Six small, unarguable corrections (batch them)

| # | File:line | Change |
|---|---|---|
| a | `core/src/app.css:391` | Drop `env(safe-area-inset-bottom)` from `.app-shell`'s padding shorthand → `0`. FRONTEND.md: *"Exactly one element adds `env(safe-area-inset-bottom)` — the band."* Today lists end with 62px of dead background above the band instead of 28px on a notched iPhone in standalone. The band's own inset covers the clearance; the verification found the finding's proposed `JoinLanding` compensation unnecessary. |
| b | `+page.svelte:992`, `library/+page.svelte:355` | `min-height: 32vh` → `32dvh`, `40vh` → `40dvh`. The only two phone-surface `vh` values left; `.app-shell` and the drawer are both `dvh`. `/`'s block is the one whose own button raises the keyboard. |
| c | `song/[mediaId]/+page.svelte:219` | `.val` `font-size: var(--ph-text-base)` → `var(--ph-text-sm)`, and drop `.oct`'s stray `font-weight: 500`. FRONTEND.md says the song page and the drawer *"state the same facts and must agree word for word"*; they share `songFacts()` and then render the same "C major" at 16px and 12.8px. Tap `···` and the numbers change size. |
| d | `core/src/lib/components/ColourRing.svelte:109` | `aria-valuetext={takenStops.has(stop.i) ? \`${stop.name} — already taken\` : stop.name}` with `const takenStops = $derived(new Set(taken.map((c) => nearestPaletteStop(c).i)));`. The pips are all `aria-hidden`, so "somebody is already Coral" is visual-only on the first screen a guest ever touches. `aria-valuetext` re-announces per arrow step, which is what the pip does visually. |
| e | `tv/+page.svelte:908` and `.fs-btn` | Move both `transition: opacity …` declarations into `@media (prefers-reduced-motion: no-preference) { … }` (the opt-in form the file already uses at `:964`). These are the only two animations in the tree in neither a `no-preference` block nor a `reduce` override. Under `reduce` today `.stage-bg` fades while the video layer above it — documented to move on the same curve — hard-cuts, so the handover visibly splits into two events. |
| f | `button.svelte:19` | `disabled:opacity-35` → `disabled:opacity-100`, matching `default`'s cancellation. `iconPrimary` does the disabled surface swap correctly (`--card2`/`--ink-dim`, 6.27:1) and then throws it away; the composited glyph lands at 1.94:1 and the fill at 1.03:1 against the row. No caller passes `disabled` today — this is a trap, not a live defect, and it is one word. |

### N18 — Two standing eslint warnings, one of them auto-fixable onto a load-bearing space
`+page.svelte:259` (`svelte/prefer-svelte-reactivity`) and `LyricsOverlay.svelte:239` (`svelte/no-useless-mustaches`). Both suppressions are *correct* — a `SvelteSet` buys nothing for a set rebuilt wholesale in a `$derived.by`, and `{' '}` at LyricsOverlay:239 is a load-bearing inter-word space Svelte collapses at that tag boundary. But `no-useless-mustaches` is **auto-fixable**, so one `eslint --fix` renders the current lyric line as `wordwordword` on the 10-foot display. Attach the reason to the line as `// eslint-disable-next-line <rule> -- <reason>` in both places, then add `--max-warnings=0` to the `lint` script so the next one is a gate failure rather than scrollback.

---

## 2. WORTH DOING

### W1 — Lazy-load `NowPlayingDrawer` out of the shared baseline (highest raw win on this list; needs a build re-measure)
`core/src/routes/+layout.svelte:15`. Measured from the real build: `/tv`'s total JS is 411.2 kB raw / 139.4 kB gz, and **201.9 kB raw / 63.6 kB gz of it is unreachable from node 9** — vaul-svelte (47.0/15.0, imported by exactly one component in the repo), bits-ui slider/switch/floating internals (60.8/16.9), tailwind-merge (70.1/21.6). That is ~49% of the television's JavaScript, downloaded and evaluated on the slowest browser in the room for a component the layout's own `NOT_PHONE` gate guarantees can never render. `/stats` pays 137.3 kB raw of the same tax; `/admin` and `/metrics` likewise. It is also the phone's slowest path to interactive, because the drawer's tree sits ahead of the home column's own chunk in the module graph.

Gate the import behind `showBand` and `$state` the component; the existing `dockH = 72` seed already covers the frame before the chunk lands, which is what the comment on `:120` was written for. Verify by the same closure arithmetic — node 9's closure must no longer contain those three chunks. (A `(phone)` route group is the more structural answer and would also let `/tv` skip the connect gate, but it moves six route folders.)

### W2 — `/library` renders every song, unbounded, with no debounce
`library/+page.svelte:264`. The home column is careful (`libraryShelf` caps at 4, the "See all N" door is gated on rows actually being hidden); `/library` has no equivalent. A `SongRow` is `Item.Root` + `Item.Media` + `Item.Content` + an `<img>` + up to four `<Badge>`s + a `<Button>` + a `role="status"` live region. `browseLibrary` is a `$derived` on `query` with no debounce, so the whole list re-keys per keystroke while the keyboard is up and the viewport is ~350px. The page's doc comment claims "filtering is instant"; at a few hundred songs it stops being. Also fold in `foldForMatch` hoisted out of the sort comparator (measured 12.4ms → 2.6ms at 2000 songs) and the two cheap `mergeCatalog` wins (double `JSON.stringify` of the whole catalog per sync: 3.69ms and ~2.8MB of throwaway strings at 2000 songs on the Pi; catalog Map cloned on every `media:status` tick even when `stemStatus` has not moved).

### W3 — In landscape, the pulled-up sheet hides the app's signature control and nothing scrolls
`core/src/lib/sheet-snap.ts:25,44`. Running the real `openSnapFraction`: snap 1 leaves for the tools body — viewport 320 → 88px, 375 → 111px, 393 → 129px, 430 → 166px. The body needs ~370px. `Drawer.Content` is `height: 100dvh` translated down, so the missing controls are *off the bottom of the screen*, not in a clipped scroller, and neither `drawer-content.svelte` nor `.np-body` declares `overflow-y`. A singer who turns the phone sideways mid-song cannot reach the ± semitone keycaps (FRONTEND.md: *"the app's signature control"*), the range bar, or the lyrics-source badge at all. At 568px portrait it is marginal — 304px against ~370px needed — so one extra line (a `guideNote`, a two-line `bandSentence`) pushes a control off in portrait too.

The finding's fix (a `0.2 * viewportH` headroom arm) was **rejected on verification**; treat this as needing a real decision. The unarguable half is the scroll floor: an `overflow-y: auto; overscroll-behavior: contain` wrapper *inside* `.np-fit` (not on `.np-fit`, whose `clientHeight` is snap 1's content cap), with `max-height` unset so `fitH` still measures full content. Do that first; decide the headroom constant separately with a measurement.

### W4 — Pick one card surface
`core/src/lib/components/ui/card/card.svelte:25`. `app.css`'s `.card` spends nine lines explaining that `--shadow-sm` + `inset 0 1px 0 var(--edge-hi)` is load-bearing — *"a border alone made every surface in the app read as an outline drawn on the page"* — and `Card.Root` has neither: `shadow-xs` is `rgb(0 0 0 / 0.05)`, invisible over `--bg` #0b0b12, and `ring-1 ring-foreground/10` is `--ink` at 10% as an **outer** ring that bleeds into the grid gap. So the phone's rows read as lit objects and all ~38 cards on `/settings`, `/stats`, `/metrics` read as flat outlines — the exact failure the token's own comment names. Move the surface into the existing `.encore-card` scoped rule (a class on a plain element this file renders — registry README §2's second sanctioned form): `box-shadow: var(--shadow-sm), inset 0 1px 0 var(--edge-hi); border: 1px solid var(--line);` and drop `shadow-xs ring-1 ring-foreground/10`. Shoot before/after; this is a visual decision across three routes, which is why it is here and not in FIX NOW.

### W5 — Decide the corner radius once
`core/src/app.css:67`. The ladder's comment says *"a sixth radius value is a bug"*; ten are rendered (4, 6, 8, 10, 12, 14, 16, 18, 22, pill). The user-visible one is the find row: the library door 16px, the search field 12px (`FindField:68`, `--radius-sm`), the picker 16px — three radii side by side at identical heights, and the door's corners *change* to 12px on keyboard focus. Meanwhile `--radius-btn` (10px, named for buttons) reaches no button, and `Card.Root`'s `rounded-xl` / `empty-media`'s `rounded-lg` fall through to Tailwind's scale because app.css declares no `--radius-xl`/`--radius-lg`. Three edits: (1) pick one control radius for door + field + picker; (2) declare `--radius-lg`/`--radius-xl` (or replace those two utilities with `var()` forms) so no vendored radius silently falls through; (3) replace the two token-duplicating literals FRONTEND.md calls violations — `badge.svelte:71` `999px` → `var(--radius-pill)`, `slider.svelte:82` `4px` → `var(--radius-xs)`. Give 6px and 14px a token or a written exemption.

### W6 — The vendored tree is on Tailwind's type scale; app source is on `--ph-text-*`
`core/src/app.css:267`. The bridge is prefixed (`--text-ph-*`) *by design*, so no vendored component can reach Encore's ladder — and 19 of them spell the unprefixed key instead, 21 uses of `text-sm` in `ui/`. A settings card's description sits at 14px, the route's own note beside it at 14.4px, `/library`'s count at 12.8px: three small-text sizes on one screen, none of them the same decision. Every Button label in the app is 14px, a size in neither ladder. **The finding's proposed fix — replacing Tailwind's `--text-*` keys wholesale in `@theme inline` — was verified as wrong and would make the app worse.** The right version is per-component: change `text-sm` → `text-ph-sm` at the 21 sites, which is mechanical, reviewable and cannot cascade. The user-visible delta is 0.4–1.2px per site, so this is hygiene with a real payoff in consistency, not an emergency.

### W7 — Three ways to say "that failed", two of them in the colour reserved for self-healing
`settings/+page.svelte:1055`, `:439`, `:890`, `song/[mediaId]/+page.svelte:184`. FRONTEND.md: *"`--danger`, not `--accent2`, means failure."* On one page a rejected settings patch is `Alert.Root variant="destructive"` while a rejected profile save and a rejected join address are amber `<p class="warn">` — and `.warn` is *also* carrying six pure advisories on that same page ("~45 minutes per song on CPU"), so a guest cannot tell a refusal from a hint. `/song`'s `.load-error` is amber three rules below `.offline-note`, which really is self-healing: one colour now means both "relax, reconnecting" and "this failed, act". Errors → `Alert.Root variant="destructive"` (or `Field.Error`, which already renders `role="alert"` with `text-destructive`); advisories → `Alert.Root variant="warn"`, which exists at `alert.svelte:15` with zero callers. Delete `.warn` and `.load-error`.

### W8 — `SkeletonRows` claims to match the row it stands in for and is 40px off
`core/src/lib/ui/SkeletonRows.svelte:44`. The comment says it matches `.card` + `.list-row` geometry. `.list-row` is `padding: 11px 12px`; this is `12px 14px`. `Skeleton variant="thumb"` is 44×44; `SongRow .thumb` is 84×47 (64×36 below 380px). So on every search on the app's most-used screen, each row's text column jumps 40px right and the list shifts 2px in as results land. Add a `row-thumb` variant at 84×47 / `--radius-btn` with the same 380px step-down, and compose `class="card list-row"` on `.skel-row` rather than re-declaring its surface.

### W9 — The hero empty state is written twice and has already drifted
`+page.svelte:983` / `library/+page.svelte:349`. Same six declarations, different values — 32vh vs 40vh of void, `--space-lg` vs `--space-md` gap, a mark on one and not the other — plus a **byte-identical seven-line `:global([data-slot='empty-title'])` override in both files**, whose comments call each other "the twin" and "/'s twin". A guest who opens an empty queue then an empty library sees two blocks trying to be the same thing. Give `empty.svelte` a `size?: 'line' | 'hero'` prop (registry README §3: a call-site difference must be a variant, because a class handed to a component is stripped at the caller), move the column, void, padding, centring and the title typography into `[data-size='hero']`, pick one void height, delete `.queue-empty`, `.lib-empty` and both `:global` blocks. Route-local `.tight` becomes `size="line"`.

### W10 — The ≥768px grid produces one 692px column until 1200px
`+page.svelte:898` (and `library:377`, `song:249`). Two 440px tracks + 14px gap need 894px; the container is `--max-w − 68px`, and `--max-w` is 760px from 768px up. So 768–1199px is exactly one 692px column: at 767px a row is 412px, at 768px it snaps to 692px — **68% longer at the breakpoint whose own comment says "Wide viewports spend the room on MORE SONGS, not longer rows."** On an iPad portrait, a small laptop, or a half-screen window, every row is a thumbnail and a short title with ~400px of empty card before the `+`. The finding's `minmax(440px, 520px)` fix was verified as breaking the two-column case; the right move is to cap the single-column track width (or raise `--max-w` at 768px), and it needs one measurement to settle. Same two lines then apply to `library:377`.

### W11 — Two spacing idioms split by route, and only one file says why
`stats/+page.svelte:161`. Counted: `/metrics` 11 rem literals + 1 token; `/metrics/[mediaId]` 17 + 0; `/stats` 6 + 0; `/`, `/library`, `/settings`, `/song` **0** literals and 19/11/9/10 token uses. The seam is visible — `gap: 1rem` is exactly `--space-2xl`, while `0.6rem`/`0.35rem`/`0.55rem`/`0.9rem` land nowhere on the ladder. `/stats` states a real reason (flat px do not grow under text zoom) and `/metrics` copies the literals with no note. Decide it in `app.css` and write the decision there: convert the three routes to tokens, **or** give `--space-*` rem values — but note the verification found the rem option would break `/tv`, so scope it (see W13). What must not survive is the split.

### W12 — Two reduced-motion idioms, and the docs say the minority form is the right one
`progress.svelte:56` and 8 others use declared-then-reset; 13 files use the opt-in `@media (prefers-reduced-motion: no-preference)` form that FRONTEND.md explicitly prefers (*"there is then no reset to lose the cascade to"*). The registry README even holds `progress`'s two directory siblings up as the example while `progress`, sitting between them, does the opposite. Nobody is affected today — every reset still wins its cascade — but a future rule landing after one of them silently re-enables motion for a guest who asked for none. Flip the eight non-exempt files; state in FRONTEND.md that `NowPlayingDrawer` is the sole exception and why (vaul's inline style). Separately: 0.16/0.18/0.2/0.22/0.3/0.42/0.5/0.6/0.8/1.3s are live against four `--motion-*` tokens, with no easing token despite `cubic-bezier(0.32, 0.72, 0, 1)` appearing twice — either add the rungs actually in use plus `--ease-out`, or drop the four tokens as decoration.

### W13 — The TV's geometry does not scale with its own type
`app.css:195` and `tv/+page.svelte:1166`. Measured: the TV root gives 20px at 720p, 29.16 at 1080p, 58.32 at 4K, and the rem type ladder doubles exactly as designed. The geometry beside it does not. `--tv-process-bar-w: min(760px, 42vw)` is the exact `min(px, vw)` shape the comment **three lines above it** forbids: it resolves to 760px at both 1080p and 4K, so the bar the whole room is waiting on goes from 40% of the screen to 20% under a headline that grew from 104px to 208px, at a 14px height that is 0.65% of a 4K screen. `--tv-takeover-border` (the colour stripe that identifies Next-up / Skipping) and `.status`'s 16px square are the same pin. And `--space-lg`'s flat 12px separates a `.hero-name` that renders 132px at 1080p and 264px at 4K, so the "Next up" card's three lines sit nearly flush. Put the geometry on `clamp(floor, Nvh, ceiling)` and add a `--tv-space-*` vh ladder beside the type ladder for `/tv` + `src/lib/tv/` (16 sites). Leave `--tv-safe-x/y`; they already clamp correctly. Note the extreme case (4K CSS pixels) needs a real HTPC to confirm — most 4K sets present 1920 CSS px.

### W14 — Smaller structural items, in rough priority order
- **`JoinLanding` has no short-viewport arm** (`:235`). It is the only surface without one (`/`, `/library`, `FindField` all have one) and it reserves 60px of top padding purely so the wordmark's flight has somewhere to land. In landscape the CTA is below the fold: a guest handed a phone sideways at a party scrolls a two-field form to find its only button. N3 removes 72px of it; a `@media (max-height: 480px)` arm collapsing the flight band (decoration; the button is the task) removes the rest.
- **`$state.raw` for the phone home's mirrored collections** (`+page.svelte:47,55,115,116,126-128,378`). `/library` states the rule in seven lines of prose and names the cost; `/` proxies the same seven collections deeply. The one a finger can feel is `rowBounds`: `dragTo` re-runs `liveSortTarget` per pointermove, which walks the array reading `.top`/`.height` per row — 40 proxy traps + 40 signal reads at 60Hz on the one interaction on that screen that must not drop frames. Leave the Maps and Sets alone (Svelte never proxies them), same distinction `/library` draws.
- **Extract `src/lib/tv/TvTakeover.svelte`** (`tv/+page.svelte:719`). The four takeovers are already unified behind one `transient` derived and share one style vocabulary that is currently interleaved with the attract screen and the lower-third in a 589-line route stylesheet. Moving them takes that style island along and makes all four renderable side by side in `/components` — the only way a change to `state-waiting`'s three-step bar gets seen before a party.
- **Badge chips carry whole sentences at 10.4px, dropping to 9.9px at ≤380px** (`badge.svelte:68`). Contrast is fine (5.7–9.5:1); this is size. `Name match only — search to sing it` is the sentence explaining why a row's only action is dead, and it is the least legible thing on screen precisely where the screen is smallest. Lift the base to `--ph-text-2xs` and drop the `font-size` override from the 380px arm, keeping only the padding claw-back.
- **`--shadow-md` has zero callers while three ad-hoc shadows live outside the ladder** (`app.css:74`; `slider.svelte:62-63`, `RangeBar.svelte:156`, `card.svelte:25`) — the rule's own comment says a fourth rung is a bug. Hygiene only; see the DELIBERATE NO on the proposed fix.
- **The five-way label/value fact row** — `FactList.svelte` already owns the semantics and the emptiness check; giving it an `eyebrow` variant and routing the song page, the drawer and `GuidingTrack` through it collapses five implementations to one and puts `dl` semantics on facts that have none. N17c fixes the visible half; this is the consolidation.
- **`CodeEntry`'s `$bindable` syncs through an `$effect`** (`:29-32`), so `bind:value` lands one tick late and three separate sites have to remember the `oncomplete(code)` workaround. `setChar` already computes the string synchronously and returns it — write `value` where `chars` is written and delete the effect, and the three comments explaining the lag go with it.
- **The two `TvPlayer` slots are 38 lines pasted twice**, differing in four tokens, with `// See slot A` as the admission. The comment above slot A records a measured ~740ms of dead air from getting `slotEntryId.A` vs `slotMedia.A.id` wrong; an edit landing on one slot reproduces that **on alternate songs only**, which reads as flakiness. `{#each SLOTS as slot (slot)}` over a compile-time constant of two makes divergence unrepresentable and preserves DOM order.

---

## 3. DELIBERATE NO

These were raised by a reviewer and should **not** change.

1. **Do not extract a `<QueueList>` from `+page.svelte`.** It would need ~20 props of pure drilling (`singers`, `mediaCatalog`, `mediaStatus`, `awaySingers`, `pendingKind`, `me`, `nextPlayableId`, `myNextEntry`, `gripsVisible`, `dragFrom`, `dragTo`, `dragY`, `movingId`, `rowH`, five callbacks) and would cut two seams the file spends paragraphs defending: `measureRowBoxes()` reads the DOM across both row kinds *as one list*, and the group headings gate on each other's emptiness (`{:else if processingRows.length === 0}`, whose comment records the bug caused by using the wrong set). The 1069 lines are 522 script / 305 markup / 242 style — the markup is not the problem. Record this reason beside the block so it is not re-litigated.
2. **Do not adopt `Empty.Media` on `/`.** REFUTED. The primitive is unwired and pure-Tailwind (`mb-2 flex shrink-0 …`), the written convention explicitly sanctions a route-local mark, and the hand-rolled span is four lines with a comment. Adopting it would mean editing a vendored file to carry Encore typography in order to replace something smaller than the adapter.
3. **Do not shrink the band below 88px on short viewports.** REFUTED. 88px is `--tap` (44) plus the drag-bar stack plus minimum strip padding = 86 inside a slot clipped at 88. The proposed 64px clips the app's only transport, and the finding's headline arithmetic double-counted the band (`--dock-h` reserves in flow what the fixed band covers).
4. **Do not give `--space-*` rem values globally.** Verified to break `/tv`, which composes those tokens against a `vh`-rooted root font-size. If the zoom argument in `stats/+page.svelte:161` wins, it wins for the phone surfaces only, with a separate TV ladder (W13).
5. **Do not replace Tailwind's `--text-*` keys in `@theme inline`.** Verified to make the app worse. The prefix on `--text-ph-*` is deliberate and the comment is right; fix the 21 call sites instead (W6).
6. **Do not put `--shadow-sm` on the slider thumbs / `RangeBar` marker.** The heavier, tighter shadow is a real affordance — those are draggable objects that must read as *above* the sheet, and the finding's "the thumb reads as nearer than the sheet containing it" is the intent, not the bug. The genuine item is the dead `--shadow-md` rung: give it its first caller (the drawer's sheet at snap 1 is the honest candidate) or delete it and say the ladder has two rungs.
7. **Do not build a `SEARCH_SOURCES` registry on the stated grounds.** REFUTED: `spotify` is not a source the picker is wrongly omitting, and the cited `$lib/contract.ts` is a directory barrel. The `<select>` → `native-select` swap in N1 stands on its own (tap floor, font floor, shrinkability); the four `<option>`s can stay literal until there is a second consumer.
8. **Do not collapse the two `room.entries` reads in `+layout.svelte`'s `sync()`.** REFUTED. `RoomLink.entries` is a plain field holding an already-materialised snapshot, written once per `QueueStore` emit — not the cloning getter the finding assumed. Nothing is allocated.
9. **Do not lower the 440px column floor.** The 440 is measured; a narrower column truncates every title. The problem is the single column *stretching* to 692px, not the floor (W10).
10. **Do not "fix" the two eslint warnings by following the rules.** Both suppressions are correct; one is auto-fixable onto a load-bearing space in the TV lyric reel. Encode the reasons as inline disables (N18) rather than letting the next `--fix` run break the 10-foot display.
11. **Do not touch `identity`'s `min-w-0 shrink`, or `.lib-slot :global([data-slot='button']) { height: 100% }`.** Both look like violations of the base's `shrink-0` / `size-tap` and both are documented, deliberate and load-bearing (the name's ellipsis depends on the first; the door pairing with the field on the second, with the tap floor held on both axes by construction).
12. **No stylistic modernisation for its own sake** — no CSS nesting migration, no `:has()` rewrites, no swapping the five sanctioned shared idioms (`.card`, `.list-row`, `.grouphead`, `.eyebrow`, `.grad-text`, `.vh`) for utilities. Each one records the drift that forced it. The registry's `:global([data-slot])` reach is the sanctioned form, not a smell.

---

## The three things that would most change a guest's experience at an actual party

1. **They could see what they typed.** N1. A 4px search field at 390px means the primary interaction of the primary surface does not work on the most common phone in the room. This is one `flex-wrap`, one media query, and swapping a hand-rolled `<select>` for the primitive that already exists — and it fixes the known-bad example as a side effect.
2. **The first button a new guest ever presses would be on the screen.** N3, then W14's `JoinLanding` arm. Right now the join CTA floats 72px above the bottom of a padded box reserved for a band that is not rendered, and with the room-code keyboard up on a small phone, or the phone held sideways, it is below the fold. A guest handed a phone at a party scrolls to find the only button.
3. **Taps would land in the dark.** N2 (one line, eight controls back over the 44px floor, including the whole leave-the-room flow and `/library`'s only refinement control) plus N9 (the pull-up handle at 1.09:1 — the only signpost that the band opens into the transport, invisible at party brightness) plus N4 (flaky wifi currently pushes the settings gear off a 320px screen and erases the singer's own name). Three small changes on the exact axis the brief names: one-handed, at a party, in the dark.## NEW FINDINGS — what the eight lenses missed

### A. The calibration surface itself

**[high/M] `/components` renders none of the 24 vendored primitives, which is why every design-system finding in this digest survived so long** — `core/src/routes/components/+page.svelte:68`

The route's imports (lines 4–16) are `SongRow`, `QueueRow`, `ProcessingCard`, `GuidingTrack`, `RangeBar`, `NowPlayingBand`, `NowPlayingDrawer` and five TV components. `docs/FRONTEND.md#the-components-gallery` says it "renders every shared component in every state it must survive, side by side, so a state that deliberately renders NOTHING can be judged as intentional". It renders **zero** of `alert alert-dialog badge button card checkbox collapsible empty field input item label native-select progress skeleton slider sonner spinner switch table tabs textarea`, and zero of the authored `FindField`, `PageHeader`, `SkeletonRows`, `FieldSlider`, `CodeEntry`, `ColourRing`, `JoinLanding`, `LyricsReselect`, `FactList`, `Bars`, `Trend`.

**Impact:** `core/src/lib/components/ui/README.md` closes with "6. Look at it. The four worst defects of the migration were all correct in source and wrong on screen, and every one was found by comparing before/after screenshots." There is nowhere to look. Every single design-system finding above is a *pairwise comparison* defect — `Card.Root` against `.card`, Button's 36px `default` against `size="tap"`, three radii in one row, `Empty.Root`'s line against the hero block, `SkeletonRows` against the row it stands in for — and not one of those pairs can be put side by side on any surface in this app. The gallery covers exactly the components that *do* hold the line (`ColourRing` is not even in it, but `SongRow`/`QueueRow`/`ProcessingCard` are, and those are the three the review found clean). It is a gallery of the healthy half.

**Fix:** add a `Primitives` section before `SongRow`: (1) a Button matrix — every `variant` × every `size`, plus `href` and non-`href` forms of the same variant, plus `disabled`; (2) `<Card.Root>` immediately beside `<div class="card">` with identical content, and `<Empty.Root>`'s bare line beside `/`'s hero block; (3) one row each of `Alert` (all 4 variants), `Badge` (all tones, plus the ≤380px arm), `Input`/`native-select`/`Textarea`/`FieldSlider`/`Switch`/`Checkbox` in a 320px-wide track, `SkeletonRows` stacked directly above three real `SongRow`s so the hand-off is visible. Then re-shoot the `shot` project. This is the highest-leverage change in the review because it is the only one that makes the other twelve findable next time.

---

### B. A cascade fact that makes a whole component's type ladder inert

**[high/S] `button { font: inherit }` is unlayered, so every `font-size` in `button.svelte` is dead on a `<button>` — and live on an `<a>`** — `core/src/app.css:310`

```css
button,
input,
select,
textarea {
	font: inherit;
}
```

I verified this in the built stylesheet rather than by reasoning. In `.svelte-kit/adapter-bun/_app/immutable/assets/_layout.kWG8AFYI.css`, `@layer utilities{` opens at byte 2649 and closes with the `}}` immediately before `:root{--bg:` at byte 45527; `.text-sm{font-size:var(--text-sm)…}` is at 12228 (inside), and `button,input,select,textarea{font:inherit}` is at 48746 (**outside every layer**). Unlayered author declarations outrank all layered ones regardless of specificity, so `font: inherit` beats every Tailwind size utility on those four tags.

**Impact, in order of visibility:**

1. **`/library`'s `Sort & filter` trigger renders at 16px instead of 10.88px.** `core/src/routes/library/+page.svelte:200-207` is `<Button variant="eyebrow">` with no `size`. The variant declares `text-[length:var(--ph-text-2xs)]` (`button.svelte:37`) — inert. `font-bold`, `uppercase` and `tracking-[0.14em]` all still apply. So the page's own eyebrow reads as 16px bold uppercase wide-tracked, directly above `<h2 class="grouphead">Sort</h2>` (`app.css:437`, `--ph-text-2xs` = 10.88px) which it was written to match. It is 47% larger than every other eyebrow on the screen. This is the single most-visible unreported defect I found.
2. **The join CTA is 16px, not 17.6px.** `size="blockLg"`'s `text-[length:var(--ph-text-lg)]` (`button.svelte:70`) is inert. `JoinLanding.svelte:218` is the app's primary first-run control.
3. **`<a>`-rendered Buttons are 14px while their `<button>` siblings are 16px.** 9 live call sites take `href` and render the anchor branch (`button.svelte:117`), where `font: inherit` does not apply and the base's `text-sm` wins: `+page.svelte:537,544,573,729`, `library/+page.svelte:184`, `settings/+page.svelte:785,959`, `PageHeader.svelte:36`, `NowPlayingDrawer.svelte:292`. On `/library`, `<Button variant="secondary" size="tap" href="/">Find a song</Button>` (line 184) sits in the empty state at 14px, while `<Button variant="secondary" size="tap" onclick={clearFilters}>Clear the filter</Button>` (line 283) — the same variant, same size, same purpose, in the *other* empty state of the same page — is 16px.
4. `xs`'s `text-xs` is inert too, so if anyone ever uses it, 16px text lands in an `h-6` (24px) box.

**Fix:** move the two resets into a layer that utilities can beat but stylesheets can lose to — `@layer base { button, input, select, textarea { font: inherit } ul, ol { margin: 0; padding: 0 } }` (the layer is already declared at `app.css:3` and currently has no contents). Utilities then win over `font: inherit`, which is what the vendored tree assumes. Check the fallout deliberately: `.source-select` (`+page.svelte:591`) and any other bare control relying on `font: inherit` for the iOS 16px floor must then state `font-size: var(--ph-text-base)` themselves — which is exactly what replacing it with `native-select` (already the known-bad item) does for free. Alternatively keep the reset unlayered and delete every font-size from `button.svelte`'s variants, since none of them can fire — but then `eyebrow` and `blockLg` need their sizes as scoped CSS on `[data-slot='button'][class*='eyebrow']`, which is worse. The layer move is correct.

---

### C. Offline UX — nobody was assigned this, and it is a WebSocket app at a party

**[high/S] Every transport and tuning control silently does nothing when the socket is down, and one of them visibly springs backwards** — `core/src/routes/+layout.svelte:165-169`

```svelte
onrestart={() => room.command({ cmd: 'restart' })}
ontoggleplay={() => room.command({ cmd: isPlaying ? 'pause' : 'play' })}
onskip={() => room.command({ cmd: 'skip' })}
onkey={(semitones) => room.command({ cmd: 'key', semitones })}
onguide={(level) => room.command({ cmd: 'guide', level })}
```

`room.command` is `this.#ws?.send({ type: 'player:command', command })` (`core/src/lib/stores/room.ts:187`). `WsClient.send` returns a boolean and its own doc comment (`core/src/lib/ws/client.ts:92-95`) says: *"DELIBERATELY NOT A RETRY QUEUE … the honest failure is to drop it and say so"*. Nothing says so. The boolean is discarded at all five call sites and the only report is a `console.warn` (`client.ts:98`).

**Impact:** `keyShift` is a server-derived prop (`+layout.svelte:70` → `NowPlayingDrawer.svelte:332-344` → `RangeBar`), so with the socket down a singer presses the `−` keycap — "the app's signature control" — and the readout, the semitone label and the range block do not move at all. No error, no disabled state, no cue. They press it four more times. Worse for the guiding track: `guidePct = guideDragging ? guideDraft : guideServerPct` (`NowPlayingDrawer.svelte:186`), so the thumb follows the finger during the drag and then **springs back to its old position on release** when the commit is dropped. That reads as the app being broken, not as the network being down. And the queue path is fine here precisely by contrast — `QueueStore.resendPending()` (`queue.ts:145`) is wired to every `queue:sync` (`room.ts:203`), so adds and moves really do survive a reconnect; the player commands are the half with no recovery and no disclosure.

Compounding it, the connection cue exists on only two of the six phone surfaces. `/` has the pill (`+page.svelte:529`) and `/song/[mediaId]` has the note (line 82). `/library`, `/settings`, `/stats` have none — and `/library` has the same `+` add button `/` has.

**Fix:** `command(command: PlayerCommand): boolean { return this.#ws?.send({ type: 'player:command', command }) ?? false; }` in `room.ts:186`, and in `+layout.svelte` wrap each: `if (!room.command(...)) toast.error("Not connected — the TV didn't hear that")`. The `Toaster` is already mounted on three routes with `offset="var(--dock-h, 0px)"`; mount one in the layout instead so the band's own failures have somewhere to land on every surface. Then hoist the offline cue out of `/` into the band itself (it is the one element on every phone surface), which also fixes the `/library`/`/settings` gap without duplicating the pill a third time.

**[medium/S] `/song/[mediaId]` shows an unjoined guest a "Reconnecting…" warning that can never resolve, and offers them a control that cannot work** — `core/src/routes/song/[mediaId]/+page.svelte:82`

```svelte
{#if !connected}
    <p class="offline-note" role="status" aria-live="polite">
        <Icon name="warning" /> Reconnecting…
```

Unlike `/` (`+page.svelte:814`) and `/library` (`library/+page.svelte:~290`), this route has no `JoinLanding` fallback — it renders its content for anyone, which is deliberate and documented ("Reachable for ANY song id"). But `room.connect()` returns early at `#state = 'guest'` with no socket for an unjoined visitor (`room.ts:107-112`), so `room.connected` is `false` forever.

**Impact:** a guest who follows a shared `/song/<id>` link — the only shareable deep link in the app — gets a permanent amber warning claiming the app is reconnecting, announced politely to a screen reader, on a page that is working perfectly. Below it, `LyricsReselect` is rendered unconditionally (line 144) and its two callbacks POST to `/api/lyrics-reselect` (lines 149-150), which for a sessionless visitor fails into `#fail('Could not re-time the lyrics')`. And `PageHeader back={{ href: '/' }}` (line 78) drops them on the join screen with no `?next=`, so joining lands them on `/` and the song is lost — even though the `?next=` machinery exists and `settings/+page.server.ts:21` already uses it.

**Fix:** three lines. Gate the note on having a session: `{#if me && !connected}`, mirroring `+page.svelte:529`'s own `{#if me && !connected}`. Gate `LyricsReselect` on `me` too (an unjoined visitor is a viewer, not an operator). And make the back link carry the return: `back={{ href: \`/?next=${encodeURIComponent(page.url.pathname)}\`, label: 'Back to the queue' }}` — `safeNextPath` already guards it.

---

### D. The join screen's two controls

**[medium/S] The leave confirmation announces "You have no songs queued" to a guest who has three** — `core/src/routes/settings/+page.svelte:331`

```js
async function askLeave() {
    confirmingLeave = true;
    try {
        const res = await fetch('/api/leave');
        leaveCost = res.ok ? await res.json() : null;
```

The comment above it (line 330) states the intent: *"Fetched on OPEN so the number is current when read out"*. The ordering defeats it. `confirmingLeave = true` mounts the `AlertDialog` **before** the `await`, and the file's own markup comment (line 466) says why that matters: *"`role="alertdialog"` announces the description on open"*. At that instant `leaveCost` is `null`, so `leaveWarning` (`:350-359`) resolves `n = 0` and the dialog announces *"You have no songs queued, and you'll need to rejoin to sing again."* The real number lands an HTTP round-trip later into `AlertDialog.Description` — which is not a live region — so it is never re-announced.

**Impact:** on the only irreversible action a guest can take, the screen-reader path is told the opposite of the truth, and the sighted path sees the sentence rewrite itself under their eyes while they are reading it. Second-open is worse: `leaveCost` is never reset, so re-opening the dialog announces the count from the *previous* open — before the two songs just added.

**Fix:** `await` first, then open — the `catch` already makes it best-effort, so a slow or failed fetch costs a beat, not the dialog: `leaveCost = null; try { const res = await fetch('/api/leave'); leaveCost = res.ok ? await res.json() : null; } catch { leaveCost = null; } confirmingLeave = true;`. If the beat is unacceptable, open immediately but render `{leaveCost ? leaveWarning : 'Checking what this will remove…'}` and keep `AlertDialog.Action` `disabled` until `leaveCost !== null` — a destructive confirm must not be pressable before it has stated its price. Separately, `leaveRoom` (`:341`) never checks `res.ok` and navigates regardless, so a failed POST lands a still-joined guest on `/` having been told they left; and `leaveWarning`'s hand-rolled 0/1/n pluralisation duplicates `count()` from `$lib/metrics-format`, which `/stats` and `/metrics` already use for exactly this.

**[medium/S] `CodeEntry` lets uncontrolled text into a box and then cannot get it out** — `core/src/lib/components/CodeEntry.svelte:103`

```js
const cleaned = normalizeRoomCodeInput(raw);
if (!cleaned) return; // nothing usable — let the native paste no-op
```

The native paste is not a no-op. With `onPaste` returning without `preventDefault`, the subsequent `beforeinput` also bails — `if (e.inputType === 'insertFromPaste') return;` (line 48) — so the browser inserts the first character of the unusable string into the box. `chars[i]` stays `''`, so `value` stays short. And `value={ch}` (line 133) is one-way: Svelte's `set_value` early-returns when the bound value is unchanged, so it never washes the stray glyph back out.

**Impact:** paste anything the alphabet rejects — a code copied with a stray `#`, an `O`/`0`, a URL — into the join screen's code boxes and one character appears on screen that is not in the code, with **no rejection message** (`rejection` is only set on the keystroke path, line 60). `CODE_EXCLUDED_NOTE` — the component's whole SC 3.3.1 duty — never fires on the paste path. Backspace cannot clear it either: `chars[i]` is falsy, so line 79 clears box *i−1* and moves focus backwards, leaving the stray glyph sitting there. The guest sees six boxes that look full and a `Continue` button that is disabled for no stated reason. `insertCompositionText` (Android autocorrect, voice dictation) is the same hole from the other side: `beforeinput` is non-cancelable for that input type, so `preventDefault()` at line 59 does nothing and the divergence is identical.

**Fix:** make the DOM re-reconcilable instead of trusting `preventDefault`. Add `oninput={(e) => { const el = e.currentTarget; if (el.value !== chars[i]) { el.value = chars[i] ?? ''; rejection = CODE_EXCLUDED_NOTE; } }}` on the segment (line 141). That is one handler covering the unusable paste, the drop, and composition at once, and it re-states the reason in words each time. Then change line 103 to `if (!cleaned) { e.preventDefault(); rejection = CODE_EXCLUDED_NOTE; return; }` so the paste path stops relying on the reconciler.

---

### E. The find row again — two things the responsive lens's measurement passed over

**[medium/S] `FindField`'s `min-height: 52px` is a dead declaration; the real resting height is 70px, and the short-viewport arm yields 62px not 44px** — `core/src/lib/ui/FindField.svelte:73`

```css
.findbox { … padding: var(--space-lg) var(--space-xl); min-height: 52px; … }
.findbox input { … min-height: var(--tap); }
```

Box-sizing is `border-box` globally (`app.css:304`). Content floor is the input's `var(--tap)` = 44px; padding is `12px` × 2; border is `1px` × 2. Total = **70px**, so `min-height: 52px` can never bind. The `@media (max-height: 480px)` arm (line 104) sets `min-height: var(--tap)` and `padding: var(--space-sm)` = 8px, giving 44 + 16 + 2 = **62px** — so that declaration is inert too.

**Impact:** a raw `52px` literal with no exemption comment, in a file whose siblings all express geometry as tokens, asserting a height the box has never had. The consequence for the reader is worse than the pixels: the responsive lens's own short-viewport finding states "`FindField` drops from 52px to 44px, worth about…" and budgets its landscape arithmetic on that. It drops 70 → 62, an 8px saving not a 28px one, which changes that finding's conclusion. And 70px is 22% of a 320px landscape viewport for a single text field.

**Fix:** delete both `min-height` declarations from `.findbox` — the input's `var(--tap)` plus the padding is the real definition and the only one that can bind — and if a taller resting field is wanted, say it once as `padding: var(--space-lg) var(--space-xl)` vs `var(--space-3xs) var(--space-xl)` in the two arms, so the number a reader sees is the number that applies.

**[medium/S] The source picker's "Library" option searches the one thing that is not your library — 8px from a control labelled "Your library"** — `core/src/routes/+page.svelte:601`

```svelte
<option value="local">Library</option>
```

`?source=local` routes to `app.localLibrary` (`api/search/+server.ts:91`), which is `core/src/lib/server/media/local.ts` — *"Local library resolver — scans a media directory and serves FTS-ranked matches"* over `LIBRARY_EXTS` files under `MEDIA_DIR/library`. `docs/FRONTEND.md#the-library-page` spends a paragraph on exactly this trap: *"It is NOT the `local` resolver, which searches audio FILES in the media directory: a processed YouTube song is in the library and absent from that list, so `/api/search?source=local` answers a different question and must not back this page."*

**Impact:** the two controls are adjacent children of `.find-row`. `.lib-slot` (line 573) is `aria-label="Your library" title="Your library"` and opens `/library`, which shows the ready catalog. `.source-slot`'s fourth option is labelled `Library` and searches a disjoint set — for a typical install where every song arrived from YouTube, `MEDIA_DIR/library` is **empty**. So a guest who owns nine processed songs picks "Library", types one of their own titles, and gets "Nothing matched". Two controls, one word, two non-overlapping meanings, on the row every guest touches first. The written convention names this hazard and the label walks into it.

**Fix:** rename the option to what the resolver is — `<option value="local">Files on this box</option>` — and while the picker is being rebuilt on `core/src/lib/components/ui/native-select` (the known-bad item), give the group an `<optgroup label="Search">`/`<optgroup label="Or just">` split so "Music / Everything / YouTube" read as fan-out breadth and "Files on this box" reads as a different index. Also consider dropping the option entirely: `local` is already inside `DEFAULT_SOURCES` (`api/search/+server.ts:39`), so "Music" already searches it, and the narrowed option exists only to *exclude* the two sources that actually find songs.

---

### F. Two things that are information only if you can see them

**[medium/S] `ColourRing`'s taken-colour pips are `aria-hidden`, so which colours are already in use is available to sighted guests only** — `core/src/lib/components/ColourRing.svelte:118`

```svelte
{#each pips as pip (pip)}
    <span class="cr-pip" style="--cr-a:{paletteRingAngle(pip)}deg" aria-hidden="true"></span>
{/each}
```

The file's own header calls this out as substance, not decoration: *"PIPS ARE PEOPLE, and INFORMATION never a block — two singers sharing a colour is legal."* The slider exposes `aria-valuetext={stop.name}` (line 109) and nothing else, and `taken` (fed real occupancy from the room preview at `JoinLanding.svelte:192`) reaches the accessibility tree nowhere.

**Impact:** on the join screen a blind or low-vision guest picks a colour with no way to learn that Maya already has it. The whole point of the pips — that clashing is legal but worth knowing about — is a visual-only fact (SC 1.3.1). It also costs the same guest the pips' secondary read: on a nine-person party, half the ring is spoken for and they cannot tell.

**Fix:** fold it into the readout that already exists. `const taken Set = $derived(new Set(pips))`, then `aria-valuetext={takenSet.has(index) ? \`${stop.name}, already chosen by someone\` : stop.name}` — one expression, no new element, and it rides the announcement the arrow keys already produce. The hub's `.cr-name` (line 125) can gain the same qualifier visibly, which would also help a sighted guest who is looking at the centre rather than at the band.

**[low/S] `RangeBar`'s axis labels escape its own `aria-hidden`, so a screen reader reads "C2 C6" out of nowhere** — `core/src/lib/components/RangeBar.svelte:82`

```svelte
	<!-- Axis end labels, so the shading is not a mystery gradient. C2 and C6 are the fixed ends. -->
	<div class="axis-ends"><span>C2</span><span>C6</span></div>
{/if}
```

`.rangebar` carries `aria-hidden="true"` (line 57) with a correct justification — *"decorative REINFORCEMENT of the readout beside it"*. `.axis-ends` is its **sibling**, not its child, and carries nothing.

**Impact:** the drawer's tools body and the song page both read, in sequence: the range sentence in words, then a bare "C2 C6" with no label, role or context. It is the one fragment of the chart that leaks, and it is the fragment that means least on its own.

**Fix:** `aria-hidden="true"` on the `.axis-ends` div, or move it inside `.rangebar` and let the existing attribute cover it (the CSS positions everything absolutely off `.rangebar`, so the div would need to stay outside the `overflow: hidden` box — the attribute is the one-character fix).

---

### G. Smaller, but concrete

**[low/S] `--dock-h`'s teardown is described as protecting `/tv` and cannot fire on the navigation it was written for** — `core/src/routes/+layout.svelte:123`

The effect's only dependency is `dockH`, so the cleanup runs when the *height* changes and on destroy. This is the root layout; it is never destroyed by a client-side navigation. So navigating `/` → `/tv` in one document leaves `--dock-h: 88px` inline on `:root`, which is precisely the state the comment (lines 116-119) and `docs/FRONTEND.md#the-band-and---dock-h` claim the teardown prevents — *"a stale `--dock-h` would pad the television's stage by a band it has not got, and no media query could override it."* No consumer on `/tv` spells the token today, so nothing is visibly wrong; the guarantee is simply absent. Gating the write on `showBand` (the fix the responsive lens already proposes for the 72px phantom on the join screen) makes the effect re-run on the navigation and fixes both at once — worth noting because the two findings share one edit and the second reason is the stronger one.

**[low/S] `CodeEntry`'s tap floor is emergent from `aspect-ratio` and clears 44px by 2px** — `core/src/lib/components/CodeEntry.svelte:173`

`.segment` is `flex: 1 1 0` with `aspect-ratio: 3 / 4` and no `min-height`. At the 320px floor: content 320 − 32 (shell) − 40 (`.join-main` padding) = 248px, minus 5 × 8px gap = 208px / 6 = 34.7px wide → 46.2px tall. It passes, by 2.2px, as a side effect of a width. Change `--space-sm`, add a seventh character, or hold a notched phone sideways (where `max(var(--space-2xl), env(safe-area-inset-left))` resolves to 44px per side and the boxes fall to ~34px tall) and the app's first input drops under the floor with nothing declaring it. Add `min-height: var(--tap)` beside the aspect ratio — the token the measured gate reads, and the one number `tests/helpers.ts` parses out of the stylesheet.

**[low/M] `/components`' inline styles duplicate five token values exactly, in the file several guards read as a fixture** — `core/src/routes/components/+page.svelte:425, 437, 449, 465, 486, 502, 518, 537, 554, 569, 581, 606, 624`

`border-radius:16px` (= `--radius-md`) appears at thirteen sites, plus `gap:20px` (`--space-4xl`, line 335), `gap:14px` (`--space-xl`, 387), `gap:16px` (`--space-2xl`, 397), `gap:12px`/`gap:10px` (`--space-lg`/`--space-md`, 592/616), `margin-bottom:4px` (`--space-2xs`, 596), and `.caption { font-size: 0.7rem }` (line 649) plus `font-size:.7rem`/`.8rem` inline. `docs/FRONTEND.md#tokens-and-which-may-never-carry-text` states the rule the 16px ones break: *"The rule is broken by a literal that duplicates a token's value."* The one literal that *is* exempted carries its exemption in prose (`rgba(255,255,255,.22)`, line 584: "no token matches a faint decorative wash"); the radii carry none. This costs no user anything directly — but it means the frames are painted with a radius that will not move when `--radius-md` does, on the surface whose whole job is to be a faithful picture, and it is the file whose `13 × 16px` drift is the same class of defect as the "ten rendered radii" finding above it.

**[low/S] `SkeletonRows` also drops the lit edge, not just the padding and the thumb** — `core/src/lib/ui/SkeletonRows.svelte:46-55`

Adding to the confirmed finding: `.skel-row` declares `background: var(--card); border: 1px solid var(--line)` and **no `box-shadow`**. `.card` (`app.css:406-408`) is `var(--shadow-sm), inset 0 1px 0 var(--edge-hi)`, whose comment calls the pair load-bearing. So the search placeholder reads as a flat outline and the arriving rows read as lit objects — the *third* axis on which the placeholder fails to preview its row, and the one the `.card` comment predicts. If the fix is "compose `class="card list-row"` and delete the surface declarations" (which the confirmed finding already proposes), this is fixed by the same edit; if the fix is "correct the padding", it is not.

---

## SPOT-CHECKS OF THREE `CONFIRMED` FINDINGS

**1. design-system #4 (21 `text-sm` sites render 14px) — the button limb is WRONG.** Marked PLAUSIBLE, and the arithmetic on `--text-sm` (0.875rem) vs `--ph-text-sm` (0.8rem) is right. But its closing claim — *"Every Button label in the app is 14px, a size that exists in neither ladder"* — is false for the `<button>` branch, by the cascade fact in finding B: `app.css:310`'s unlayered `font: inherit` beats `.text-sm` in `@layer utilities`, verified byte-offset in the built CSS. Button labels are **16px** on `<button>` and 14px only on the 9 `href` call sites. That does not save the finding's premise — it makes it worse, because the split is now *within one primitive* — but the fix it proposes (registering `--text-sm: var(--ph-text-sm)` in `@theme inline`) would move the anchors from 14px to 12.8px and leave the buttons at 16px, widening the gap it set out to close. Fix B first, then re-measure; the "21 sites" count becomes meaningful only after the layer move.

**2. a11y #1 (arrow-key reorder loses focus) — CONFIRMED, verified independently.** `core/src/lib/components/QueueRow.svelte:97` is `{#if grip && !pending}` verbatim, and the props doc at lines 30-33 confirms the focus-return-by-attribute mechanism the unmount defeats: *"a stable attribute survives the re-render, so the page re-finds the grip by id."* The row survives the re-render; the grip does not. The finding and its fix stand as written.

**3. responsive #2 (`--dock-h` published unconditionally) — CONFIRMED, and the corrected 72px number is right.** `+layout.svelte:120-126` reads only `dockH`, never `showBand`. `+page.svelte:832` is `padding: var(--space-xs) var(--space-3xl) calc(var(--dock-h, 0px) + 28px)` and `<JoinLanding />` at line 814 is inside that `main` (closes at 816), so the join screen really does reserve 72px of nothing plus the intended 28px. The verifier's correction of 100 → 72 is the right one. Add the reason in finding G: the same one-line gate also restores the teardown guarantee the doc claims.

---

## AREAS I CHECKED AND FOUND GENUINELY FINE

- **Text truncation and long strings.** This is the strongest area in the codebase and I could not find a hole. Every nowrap child in a flex parent that needs it carries `min-width: 0`; `SongRow` clamps its title at 2 lines with the `-webkit` box display beside it; `overflow-wrap: anywhere` is applied at the 320px reflow sites and deliberately withheld from the TV's join address with the shrink-beats-break reason written down; `item-title.svelte:17` carries a comment explaining why `line-clamp-1` is *absent*; the gallery has real 32-character-name fixtures at lines 257-264 and 310-319 that exist to make the singer-dot's 0px collapse visible. I tried to construct an overflow case and failed.
- **Reconnect and queue reconciliation.** `WsClient`'s liveness watchdog, the `#discard`-before-overwrite ordering, the `pageshow`/`online`/`resume`/`visibilitychange` wake set, and `QueueStore.resendPending()` wired to every `queue:sync` (`room.ts:203`) are all correct, and the frozen-socket-is-indistinguishable-from-live comment (`client.ts:102-104`) is the right diagnosis. The *queue* half of offline UX is sound; only the player-command half (finding C) is not.
- **Multi-user races on one queue.** `QueueStore`'s pending-snapshot invariant with one writer (`#rebasePending`), the `seq`-ordered rollback that keeps a concurrent in-flight op alive, advance-only `#noteRev`, and monotonic `#nextAddedAt` for the round-robin tiebreaker are careful work with the failure modes written down. I found nothing to add.
- **Light mode / theme.** `color-scheme: dark` at `app.css:228` with no `prefers-color-scheme` branch is the right call for a dark-room party app, and the manifest's `background_color`/`theme_color` agree with `--bg`. A light mode would be a product decision, not a defect. (The genuinely absent branch is `@media (forced-colors: active)` — zero occurrences tree-wide — which would flatten the `ColourRing` conic band and strip `--singer` from the identity dots on a Windows high-contrast desktop reading `/settings` or `/metrics`. Real, but the smallest audience of anything in this report.)
- **PWA.** `static/manifest.webmanifest` is complete and correct (maskable icons at both sizes, matching colours), `app.html` carries both `mobile-web-app-capable` spellings with the deprecation-warning reason written down, and `interactive-widget=resizes-content` is load-bearing and argued. One calibration note for the responsive lens: `"orientation": "portrait"` means the landscape findings above apply to in-browser and iOS use, not to an installed Android PWA.
- **Internationalisation.** `<html lang="en">`, `Intl.DateTimeFormat('en-US')` used only as a *parts* source (`metrics-format.ts:81`, reassembled into a fixed sortable layout), and `Intl.Collator('en', {numeric:true, sensitivity:'base'})` for library sort. The locale literals are deliberate and the date is not ambiguous. A self-hosted single-language app; nothing to fix.
- **`/stats` and `/admin`.** Both clean. `/admin`'s focus placement across the arm/confirm/cancel re-render (lines 45-68) is the best-handled instance of that hazard in the tree — and is exactly the pattern the queue grip (a11y #1) needs. `/stats`' `em`-floored tile grid with the two-up-written-as-a-floor comment (lines 192-196) is the most careful reflow reasoning in the repo.
- **TV wake lock, pitch-shift graph lifetime, reel offset arithmetic.** Documented to a level I could not improve on and pinned by named unit tests. Not re-reviewed beyond confirming the docs match the file list.