<!--
	JoinLanding — the UNJOINED state of `/`. `/` is the landing page now; there is
	no separate `/join` route (Q2-A retired it), and this component is what an unjoined visitor sees
	instead of the queue.

	TWO PANES, NOT ONE SCREEN. This surface used to do four jobs at once — resolve the room, prove you
	are in it, pick a name, pick a colour — stacked into a single scroll. The two halves have different
	audiences: the ROOM half is only ever needed by a guest who could not scan, and the IDENTITY half is
	needed by everyone. Merging them charged the 90% case (scan the TV's QR) for the 10% case's controls:
	a scanned guest was shown a six-box code entry they had no code to type into, above the two fields
	they actually came for.

	  • STEP 1 — the CODE pane. The FALLBACK, not the default: scan affordance, "or type the six-character
	    code", the six boxes, and a Continue that resolves the code. No name field and no colour picker —
	    identity is step 2's job, and asking for it here is what made the merged screen long.
	  • STEP 2 — the IDENTITY pane. The room confirmed IN WORDS ("Maya and Dana are here"), the name
	    field, the colour ring, "Start singing". The ONLY pane a guest who scanned the QR ever sees.

	TWO PATHS TO ONE ROOM, side by side (never one instead of the other): a SCAN affordance and a TYPED
	six-segment code. A typed code alone is a cognitive-function test under WCAG SC 3.3.8, so the scan
	path is what makes this conformant — an accessibility requirement, not a convenience. Splitting the
	panes PRESERVES that property rather than weakening it: the scan affordance now leads step 1 with
	nothing competing for the space, and the typed path stays offered rather than required, because the
	guest who scanned reaches step 2 without passing through step 1 at all.

	THREE SHAPES, unchanged in substance and now expressed as which pane opens:
	  • no code yet          → STEP 1, then STEP 2 once the typed code resolves. Both paths offered.
	  • arrived WITH a code  → resolve it and open STEP 2 directly, the room confirmed IN WORDS, never the
	                           code re-presented as an input the guest cannot act on. The QR hardcodes the
	                           room, so a scanned guest types nothing and skips step 1 entirely.
	  • code did not resolve → STEP 1 WITH a stated reason, not a blank form.

	The room has no NAME (schema is {id, code, createdAt}), so "confirmed in words" is who is here, from
	GET /api/room-preview (Q1-B). `roomPresenceSentence` is the pure builder, unit-tested without a DOM.
-->
<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { SINGER_COLORS, nearestPaletteStop } from '$lib/contract';
	import { normalizeRoomCodeInput, CODE_LENGTH } from '$lib/contract';
	import ColourRing from '$lib/components/ColourRing.svelte';
	import CodeEntry from '$lib/components/CodeEntry.svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { safeNextPath } from '$lib/next-path';
	import { roomPresenceSentence, type RoomPreview } from '$lib/phrasing/room-presence-sentence';
	import { Input } from '$lib/components/ui/input';
	import { Spinner } from '$lib/components/ui/spinner';

	let name = $state('');
	/*
	 * The colour a guest arrives holding, as a RING STOP rather than as a preset.
	 *
	 * The picker on this pane is the 48-stop ring, and the ring can only return one of its own fills — so
	 * seeding this with `SINGER_COLORS[0]` (violet, at OKLCH L≈0.56, deliberately outside the ring's
	 * L≈0.72 band) would put the knob and the hub on the nearest stop while the value said something the
	 * ring cannot produce, and a guest who never touched the picker would join on a colour the control
	 * never offered. Snapping the default through `nearestPaletteStop` keeps the continuity — it is still
	 * the violet the join screen has always opened on, to within a stop — while making the first paint
	 * honest about what is selected.
	 */
	let color = $state<string>(nearestPaletteStop(SINGER_COLORS[0]).fill);
	// The code the guest is typing into the six boxes (empty until they start). Distinct from the
	// scanned code below: this is the TYPED path.
	let typedCode = $state('');
	let submitting = $state(false);
	let error = $state('');

	// A code carried in on the URL — `/?room=CODE`, what the TV QR now encodes (Q2-A moved it off
	// `/join?room=`). Normalised through the shared filter so a QR's raw value and a hand-typed `?room`
	// both resolve. Read ONCE: the landing URL is fixed for the life of the page (a scan is a fresh
	// navigation, not an in-page param change), so this is a plain read, not a reactive derivation.
	const scannedCode = normalizeRoomCodeInput(page.url.searchParams.get('room') ?? '');
	const arrivedWithCode = scannedCode.length === CODE_LENGTH;

	// The scanned-room confirmation, or the reason it did not resolve. Fetched on mount / when the
	// scanned code changes.
	let preview = $state<RoomPreview | null>(null);
	let previewError = $state('');
	let previewLoading = $state(false);
	// The code the current `preview` resolved FROM. Both paths reach step 2 through the same fetch — the
	// scanned code on the QR path, the typed code on the fallback path — so the room the guest was shown
	// is whichever code produced the sentence they read, and that is the one the join must carry. Reading
	// `scannedCode` here instead would send the WRONG room in the one case both codes exist: a scan that
	// failed, dropped to step 1, and was corrected by hand.
	let previewCode = $state('');

	/*
	 * WHICH PANE IS ON SCREEN. A resolved room is exactly what step 2 needs and exactly what step 1
	 * exists to obtain, so the pane follows `preview` rather than a hand-advanced counter — there is no
	 * state in which the two could disagree and show an identity pane for a room we never confirmed.
	 *
	 *   identity  — a room resolved (scanned, or typed and accepted).
	 *   resolving — arrived with a code, no answer yet. NOT step 1: flashing six empty boxes at a guest
	 *               who scanned, for the length of one fetch, is the merged screen's failure in
	 *               miniature.
	 *   code      — everything else: no code at all, or a code that came back unresolved.
	 */
	const pane = $derived<'resolving' | 'code' | 'identity'>(
		preview ? 'identity' : arrivedWithCode && !previewError ? 'resolving' : 'code'
	);

	/*
	 * THE STEP DOTS ARE GATED ON HAVING SEEN STEP 1, and this is the reason the flag exists rather than
	 * the dots simply reading `pane`. A guest who scans the QR lands on step 2 without step 1 ever
	 * rendering; showing them "step 2 of 2" would report a step they never skipped as skipped, which
	 * reads as a broken or half-completed form on the first screen of the app. So the dots are not
	 * "where am I in a two-step form" — they are "you are on the second of the two panes you have seen".
	 *
	 * Set from the pane rather than from the code path, so the failed-scan case is covered by
	 * construction: that guest IS shown step 1, corrects the code by hand, and must keep the dots.
	 */
	let sawCodeStep = $state(false);
	$effect(() => {
		if (pane === 'code') sawCodeStep = true;
	});

	// The code that actually gets sent to /api/join: the one the confirmed room resolved from.
	const joinCode = $derived(preview ? previewCode : typedCode);
	// STEP 1's CTA: the six boxes are full and no lookup is in flight. Its disabled REASON is stated in
	// text below (SC 3.3.2), never by state alone.
	const canContinue = $derived(typedCode.length === CODE_LENGTH && !previewLoading);
	// STEP 2's CTA: a room is confirmed (guaranteed by the pane) and a name is entered.
	const canJoin = $derived(pane === 'identity' && name.trim().length > 0 && !submitting);
	const onCodeStep = $derived(pane === 'code');
	const ctaEnabled = $derived(onCodeStep ? canContinue : canJoin);
	/*
	 * ONE reason string for BOTH panes, and one live region for it in the markup below. Two regions —
	 * one per pane — would put a second `aria-live` in this file, and `phone-inventory.test.ts` holds an
	 * enumeration of every phone live region with its purpose: an extra one fails there, correctly, since
	 * "the reason the CTA is disabled" is a single duty however many panes state it.
	 */
	const ctaReason = $derived.by(() => {
		if (onCodeStep) {
			if (previewLoading) return '';
			if (typedCode.length === 0) return `Enter the ${CODE_LENGTH}-character code, or scan the TV's QR.`;
			if (typedCode.length < CODE_LENGTH) return `Enter all ${CODE_LENGTH} characters of the code.`;
			return '';
		}
		if (pane === 'resolving') return 'Waiting for the room to load.';
		if (name.trim().length === 0) return 'Enter your name to continue.';
		return '';
	});

	async function loadPreview(code: string) {
		previewLoading = true;
		previewError = '';
		preview = null;
		try {
			const res = await fetch(`/api/room-preview?code=${encodeURIComponent(code)}`);
			const body = await res.json();
			if (!res.ok) {
				previewError = body.error ?? 'That room could not be found.';
			} else {
				preview = body as RoomPreview;
				previewCode = code;
			}
		} catch {
			previewError = 'Network error — try again.';
		} finally {
			previewLoading = false;
		}
	}

	// Load the scanned-room confirmation when we arrived with a valid code. A `$effect` rather than
	// `onMount` so the fetch is driven by the same reactive graph the rest of the component uses (and so
	// it runs under the mount-rung harness, which drives effects). `arrivedWithCode` is a const, so this
	// fires at most once; `requested` guards against a re-run firing a second fetch.
	let requested = false;
	$effect(() => {
		if (arrivedWithCode && !requested) {
			requested = true;
			void loadPreview(scannedCode);
		}
	});

	/*
	 * STEP 1 → STEP 2. The typed path resolves the code through the SAME /api/room-preview the scanned
	 * path uses, which is what lets step 2 confirm the room in words for a guest who typed rather than
	 * scanned — that sentence is the whole content of the pane, so a typed code that was merely
	 * well-formed (six legal characters) is not enough to advance on. A code that does not resolve leaves
	 * the guest on step 1 with `previewError` stating why, the same treatment a failed scan gets.
	 *
	 * The pane flips on `preview` landing; nothing here advances it by hand.
	 */
	async function continueToIdentity(code?: string) {
		/*
		 * `code` IS THE ONE CodeEntry JUST ASSEMBLED, and taking it is what makes the auto-advance work.
		 *
		 * CodeEntry fires `oncomplete` synchronously from inside its `beforeinput` / `paste` / `keydown`
		 * handler, while the `value` binding reaches this component through an `$effect` — next tick. So
		 * this used to check `typedCode`, see five characters, fail `canContinue` and return without a
		 * word: typing the sixth character did nothing, and pasting a whole code did nothing. Both were
		 * measured in a browser. The button worked, which is why it went unnoticed.
		 *
		 * The argument is absent when the CTA is what called this, and then `typedCode` is authoritative
		 * (the binding has long since settled), so the fallback is not a guess.
		 */
		const candidate = code ?? typedCode;
		if (candidate.length !== CODE_LENGTH || previewLoading) return;
		await loadPreview(candidate);
	}

	async function join() {
		if (!canJoin) return;
		submitting = true;
		error = '';
		try {
			const res = await fetch('/api/join', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ displayName: name.trim(), color, code: joinCode || undefined })
			});
			if (!res.ok) {
				error = (await res.json()).error ?? 'Could not join';
				submitting = false;
				return;
			}
			// Head where the join was for — the room (`/`) unless something sent us here to reach a
			// specific screen (Settings behind the join gate carries `?next=`). safeNextPath keeps that
			// from becoming an open redirect, the same guard the old /join route held.
			const dest = safeNextPath(page.url.searchParams.get('next'));
			await goto(dest);
			// The join happens ON `/` now, and the common destination is also `/`. A client-side
			// `goto('/')` from `/` is a no-op — same route, so the home component never remounts and never
			// re-fetches /api/me, leaving the guest on the join form they just completed. When the
			// destination IS the current path, reload so the route re-runs with the new session cookie and
			// renders the queue. A different `next` (e.g. /settings) already navigated above.
			if (new URL(dest, location.origin).pathname === location.pathname) {
				location.reload();
			}
		} catch {
			error = 'Network error — try again';
			submitting = false;
		}
	}

	const confirmSentence = $derived(preview ? roomPresenceSentence(preview) : '');
</script>

<!--
	THE HEADER IS TWO SHAPES OF ONE THING — and it is ONE <h1> that changes shape, not two that swap.
	On step 1 the wordmark is the screen's title: large, centred, sitting under the band the missing
	topbar would occupy. On step 2 it IS the screen's header: small, top-left, out of the way of the
	room sentence and the name field. Step 1 shows it large because it is the only "Encore" on screen
	now that the home route drops its topbar for an unjoined visitor; step 2 needs it small because
	that pane's content starts immediately below it. The SAME mark travelling between those two
	positions is what tells the guest the two panes are one flow rather than two pages.

	ONE PERSISTENT ELEMENT, and that is the whole mechanism. Written as an `{#if}` — a centred h1 in
	one branch, a header-bar h1 in the other — the element UNMOUNTS and a different one mounts on every
	flip, so nothing is left for the browser to interpolate and a JS runtime (`crossfade`, keyed to pair
	the two boxes) had to measure both and animate the difference by hand. That runtime is what this
	markup exists to avoid: a Svelte `transition:`/`in:`/`out:` directive generates its keyframes at run
	time and never consults `prefers-reduced-motion` (`tests/guards/motion/motion.test.ts` rejects all
	four directives for exactly that reason, and `routes/tv/+page.svelte` states the rule), and
	`crossfade` additionally calls `getBoundingClientRect()` unconditionally, which the mount-rung
	harness replaces with a throw by design.

	So the h1 is hoisted OUT of the branch and only its CLASS changes. A mounted element whose
	`transform` changes is interpolated by the browser natively, from a rule a media query can actually
	reach — see `.brand` in the style block for the flight itself and its Reduce Motion gate. Exactly
	one <h1> exists at all times, on either pane.
-->
<header class="join-head" class:head-bar={!onCodeStep}>
	<h1 class="brand" class:brand-bar={!onCodeStep}>
		<Icon name="mic" /> <span class="wordmark">Encore</span>
	</h1>
	<!--
		THE LEDE BELONGS TO THE CODE PANE ONLY. It used to switch to "You're joining this room." on the
		identity pane, directly above `roomPresenceSentence` — which says the same thing with the facts
		in it ("Maya and Dana are here."). Two sentences, one message, and the vaguer one first.

		The identity pane needs no lede at all: the room sentence IS its opening line, and the wordmark
		has become a header bar rather than a title needing a subtitle under it.
	-->
	{#if onCodeStep}
		<p class="lede">Join the room on the TV to start singing.</p>
	{/if}
</header>

<!--
	A `<div>`, NOT a second `<main>`. This element was `<main class="join-main">` and it renders INSIDE
	`routes/+layout.svelte`'s own `<main>`, so the join screen shipped nested main elements — invalid HTML,
	and two "main" landmarks for a screen reader to choose between on the first screen of the app. Chrome's
	own a11y tree showed both. The landmark belongs to the layout, which mounts it on every route; this is
	the pane inside it, and `.join-main` stays the class every rule here (and the `:has()` selectors below)
	already keys on.
-->
<div class="join-main">
	{#if sawCodeStep}
		<!-- Two dots, the second wider when active — the small-indicator shape the band already uses
		     (`.dot`, sized off the spacing scale with a pill radius). Rendered ONLY once step 1 has been
		     seen; see `sawCodeStep` for why a scanned guest must not get "step 2 of 2". No transition
		     between the two states: the active dot changes WIDTH, and width is a layout property this
		     codebase does not animate, so the step change is instant rather than gated. -->
		<p class="steps">
			<!-- The dots are the visual; this is the same fact for a guest who cannot see them. Not a live
			     region — the pane change is a navigation the CTA press caused, not an ambient event. -->
			<span class="step-count">Step {pane === 'identity' ? 2 : 1} of 2</span>
			<span class="dot" class:on={onCodeStep} aria-hidden="true"></span>
			<span class="dot" class:on={pane === 'identity'} aria-hidden="true"></span>
		</p>
	{/if}

	{#if pane === 'resolving'}
		<!--
			The shadcn migration: <Spinner>, whose ring honours Reduce Motion in its own file. It is `aria-hidden`
			DECORATION, not the announcement: the sentence stays, because this `role="status"` region
			is what a screen-reader guest hears while the room resolves.

			NOT <Skeleton>, which is what it looks like it is for. A skeleton stands in for content of
			known shape and says nothing; swapping the sentence for a silent grey bar would leave the
			status region empty and announce nothing at all. So ui/skeleton still has no consumer —
			reported rather than forced.
		-->
		<p class="confirm" role="status"><Spinner aria-hidden="true" /> Finding the room…</p>
	{:else if pane === 'identity'}
		<!-- STEP 2 — IDENTITY. The room is confirmed in words and no code input is shown: on the scanned
		     path the QR typed it, and on the typed path step 1 already took it, so re-presenting it here
		     would be the code shown back as an input the guest has no reason to touch. -->
		<p class="confirm" role="status">{confirmSentence}</p>

		<label class="name-field">
			<span class="name-label">Your name</span>
			<!--
				The `join` variant reproduces this field's box exactly — the sheet's largest comfortable
				padding and type, on `--card`. `maxlength` is a NUMBER here: the DOM coerced the string, but a
				component prop is typed and would not.
			-->
			<Input
				variant="join"
				bind:value={name}
				placeholder="e.g. Maya"
				maxlength={32}
				autocomplete="nickname"
				enterkeyhint="go"
				onkeydown={(e) => e.key === 'Enter' && join()}
			/>
		</label>

		<!--
			THE COLOUR PICKER IS THE RING (see ColourRing.svelte). It replaced the eight preset swatches plus
			the hue slider that used to stand here: one control instead of two for one choice, the full
			48-stop palette instead of eight named colours and a continuous rail, and the hue circle closed
			rather than cut open at an arbitrary stop.

			`taken` is REAL OCCUPANCY, from the same /api/room-preview the sentence above is built from —
			the endpoint now returns the present singers' colours alongside their names, so the pips mark
			colours actually in the room rather than a plausible-looking sample. An empty room is an empty
			list, which is a legitimate state and needs no special case.
		-->
		<ColourRing
			bind:value={color}
			label="Your color"
			hint="How you'll spot yourself in the queue and on the TV."
			taken={preview?.colors ?? []}
		/>

		{#if error}
			<div class="err" role="alert">{error}</div>
		{/if}
	{:else}
		<!--
		     STEP 1 — CODE. The FALLBACK pane: reached by a guest who has no code in the URL, or whose
		     scanned code did not resolve.

		     NO SCAN CARD, and the reason is that this pane is UNREACHABLE for anyone who scanned. It used
		     to lead with a "Scan the TV's code" row explaining how to point a camera at the QR, which was
		     wrong twice over. It was information wearing a card's surface — tappable-looking, doing
		     nothing — and a web page served from a plain `http://<LAN-IP>` origin has no camera it could
		     open even if it tried: `navigator.mediaDevices` is secure-context gated, the same trap
		     docs/deploy/README.md:53 records for the TV's AudioWorklet. More basically, a scanned QR
		     carries `?room=CODE`, resolves, and opens the IDENTITY pane directly — so this row explained
		     the one path that guarantees you never see it. Instructions for the road not taken.

		     WHAT THAT COSTS, stated plainly: the SC 3.3.8 argument this file used to make rested on the
		     scan affordance LEADING and the typed boxes being its alternative. The alternative still
		     exists — scanning is the primary path and the TV shows the QR — but it is no longer narrated
		     on this screen, so a guest who arrives here is not told about it. That is a deliberate
		     ruling, not an oversight; revisit it here if the conformance claim needs to be re-made.
		-->
		<!--
			CENTRED IN THE FREE SPACE, not stacked under the header.

			This pane is the shortest in the app — two step dots, a label and six boxes, about 120px — and
			the CTA is docked to the bottom of the column by `.submit-slot`'s auto margin. Top-aligning the
			boxes therefore put every remaining pixel in ONE gap: measured at 390x844, roughly 430px of empty
			background between the last box and the Continue button, which is most of the screen. It read as
			a page whose content had failed to load, and it is the FIRST screen of the app for anyone who
			could not scan.

			CODE PANE ONLY, deliberately. The identity pane is taller and is the one a soft keyboard opens
			over — `app.html` sets `interactive-widget=resizes-content`, so the layout viewport SHRINKS — and
			centring content that can exceed its box clips it at BOTH ends, which would put the name field's
			label out of reach rather than merely low. This pane's content cannot overflow any real viewport,
			so it gets the centring and that one does not.
		-->
		<div class="code-pane">
			{#if previewError}
				<!-- The code did not resolve. Do NOT leave a blank form: state the reason, in place, directly
				     above the boxes the guest can now correct. Covers both arrivals here — a scanned code that
				     failed, and a typed one. -->
				<div class="err" role="alert">{previewError}</div>
			{/if}
			<CodeEntry bind:value={typedCode} label="Room code" oncomplete={continueToIdentity} />
		</div>
	{/if}

	<!--
		ONE CTA slot for both panes, docked to the BOTTOM of the pane by `.submit-slot`'s `margin-top:
		auto`. It can sit there because `app.html` sets `interactive-widget=resizes-content`: the LAYOUT
		viewport shrinks when the on-screen keyboard opens, so bottom-anchored content rides above the
		keyboard instead of under it. That meta is load-bearing for this placement — read its comment
		before changing either. Not verifiable by the measured gate: headless Chromium has no soft
		keyboard to raise.

		Shared rather than one per pane so this file keeps exactly ONE live region for the disabled
		reason (see `ctaReason`).
	-->
	<div class="submit-slot">
		<!--
			Disabled REASON in text, not state alone (SC 3.3.2) — but ANNOUNCED, not printed. Visibly this
			was a third sentence telling the guest to enter the code they can see six empty boxes for,
			directly above a button that is visibly disabled. The duty is that the reason exist in text for
			assistive tech; it is not that the reason be shown to someone who can already see the form. So
			the element and its live region stay exactly as they were and only the painting stops.
		-->
		{#if ctaReason && !submitting}
			<p class="cta-reason" role="status" aria-live="polite">{ctaReason}</p>
		{/if}
		<Button size="blockLg" disabled={!ctaEnabled} onclick={onCodeStep ? () => continueToIdentity() : join}>
			{#if onCodeStep}
				{#if previewLoading}Checking the code…{:else}Continue <Icon name="arrow-right" />{/if}
			{:else if submitting}Joining…{:else}Start singing <Icon name="arrow-right" />{/if}
		</Button>
	</div>
</div>

<style>
	/*
	 * A GRID WITH TWO NAMED ROWS, and the reason is the FLIGHT rather than the layout: the brand row is
	 * a RESERVED band whose height does not depend on which pane is open. The wordmark keeps its
	 * font-size on both panes (it shrinks by `transform`, not by type — see `.brand`), so its box is
	 * the same size in the same row either way, and the lede and everything under it sit at the same y
	 * on both panes. Nothing below the header moves when the mark flies, and nothing moves when the
	 * pane flips either.
	 *
	 * THE TOP BAND IS UNCONDITIONAL, which is the other half of that. The home route hides its topbar
	 * for an unjoined visitor, which left step 1 starting hard against the physical top edge — a page
	 * whose chrome had failed to load rather than a screen. So the band the topbar occupied is
	 * RESERVED: `--tap` is that bar's height (it is exactly one tap target tall, which is what sizes it
	 * in the first place) and `--space-2xl` is the padding the real topbar carries above its own brand.
	 * Composed from those two rather than measured off a screenshot into a literal, so if either token
	 * moves this follows.
	 *
	 * It stays reserved on step 2 as well, where it is not empty: that is the band the wordmark flies
	 * INTO to become the header. Making it a per-pane padding instead would move the mark vertically by
	 * changing layout — instant, unanimatable, and it would drag the whole pane up by `--tap` on the
	 * flip. A reserved band plus a `translate` is the same picture with neither cost.
	 *
	 * `container-type: inline-size` exists for the centring in `.brand`, which needs the CONTAINER's
	 * width (`cqw`) — a percentage inside a `transform` resolves against the transformed element
	 * itself, so the free space either side of the mark cannot be expressed without it.
	 */
	.join-head {
		display: grid;
		grid-template-areas: 'brand' 'lede';
		justify-items: center;
		container-type: inline-size;
		padding: calc(var(--tap) + var(--space-2xl)) var(--space-4xl) var(--space-sm);
		text-align: center;
	}
	/*
	 * THE WORDMARK'S FLIGHT, in `transform` alone.
	 *
	 * Its LAYOUT is pane-independent by construction: `justify-self: start` pins the box at the pane's
	 * `--space-4xl` gutter on both panes (the `justify-items: center` above governs the lede, not this),
	 * and the font-size is `--ph-text-2xl` on both. So the only declaration that differs between the
	 * two states is `transform`, which is what makes this interpolable at all — and which keeps the
	 * flight off the layout, since a mid-flight reflow is exactly the seam the JS attempt produced.
	 *
	 * BOTH the move and the shrink are that one `transform`. The repo animates `transform` and
	 * `opacity` and nothing else (`tests/guards/motion/motion.test.ts` enumerates the allowed set), so
	 * the shrink cannot be a `font-size` and the move cannot be a `padding`, a `top` or a `margin` —
	 * every one of those is a layout property. Written as the same two functions in the same order in
	 * both states, so the browser interpolates them per-function rather than falling back to matrices.
	 *
	 *   • `translate(calc(50cqw - 50%), 0)` — centres it horizontally: `50cqw` is half the header's
	 *     content box, `50%` is half the mark's own width, so the difference is the free space to its
	 *     left. Vertically it stays where the reserved band puts it.
	 *   • `scale(1)` — full size, and the anchor the shrunk state interpolates from.
	 *
	 * `transform-origin: left top` pulls the shrink toward the corner the mark is heading FOR. The
	 * default centre origin would scale it about its middle and the top-left corner would drift, so the
	 * header state would not sit flush on the gutter without a second correction.
	 */
	.brand {
		grid-area: brand;
		justify-self: start;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-md);
		font-weight: 800;
		font-size: var(--ph-text-2xl);
		letter-spacing: 0.5px;
		margin: 0;
		line-height: inherit;
		transform-origin: left top;
		transform: translate(calc(50cqw - 50%), 0) scale(1);
		transition: transform var(--motion-base);
	}
	/*
	 * STEP 2's HEADER: flush on the gutter (the translate goes to 0, and `left top` origin keeps the
	 * corner there through the scale) and up into the reserved band by exactly `--tap`, the band's own
	 * height. `0.667` is `--ph-text-base` over `--ph-text-2xl` — 16px of effective text out of the 24px
	 * the element still declares — expressed as a ratio because CSS cannot divide one length by
	 * another. A ratio large enough that the shrink reads as motion rather than as a reflow.
	 *
	 * The <Icon> is `1em`, so it tracks the declared font-size with no second declaration and scales
	 * with the text rather than against it.
	 */
	.brand-bar {
		transform: translate(0, calc(-1 * var(--tap))) scale(0.667);
	}
	/*
	 * REDUCE MOTION, and this is the point of expressing the flight in CSS. The mark is simply already
	 * in its header position on the flip — same end state, no travel. A media query genuinely governs
	 * this rule, which is what it could not do for a Svelte transition directive: that runtime writes
	 * its own inline keyframes and there is no authored declaration for the query to override.
	 */
	@media (prefers-reduced-motion: reduce) {
		.brand {
			transition: none;
		}
	}
	/* STEP 2's header column left-aligns the LEDE under the wordmark; the mark itself is already on the
	   gutter in both states (see `.brand`). */
	.head-bar {
		justify-items: start;
		text-align: left;
	}
	.wordmark {
		background: var(--grad);
		-webkit-background-clip: text;
		background-clip: text;
		color: transparent;
	}
	.lede {
		grid-area: lede;
		color: var(--ink-dim);
		margin: var(--space-xs) 0 0;
		font-size: var(--ph-text-md);
	}
	/*
	 * `.confirm`, `.err` and `.cta-reason` deliberately stay ordinary elements rather than becoming
	 * <Field.Description> / <Field.Error>. Each has a specific reason, none of them preference:
	 *
	 *   `.err`   — `e2e/contract.ts` addresses it as `.err[role=alert]`, so the class has to sit on the
	 *              alerting element itself. <Field.Error> emits the role, but a class handed to it could
	 *              not carry a scoped rule (ui-scoped-style-reach.test.ts), and contract.ts is not
	 *              editable from here.
	 *   `.confirm` — this is the scanned path's HEADLINE ("Maya and Dana are here"), the one sentence
	 *              that surface exists to state: --ink, --ph-text-lg, 600. <Field.Description> is
	 *              `text-sm text-muted-foreground`, which would dim and shrink exactly that.
	 *   `.cta-reason` — <Field.Description> carries `margin: var(--space-xs) 0 0` in the primitive, and
	 *              this sits ABOVE the Continue button needing the gap BELOW it (`0 0 var(--space-sm)`)
	 *              plus `text-align: center` against the primitive's `text-left`. Overriding all three
	 *              needs either a class on the component (unreachable) or an app-side
	 *              `:global([data-slot='field-description'])`, which would land on settings' own
	 *              descriptions too.
	 */
	.confirm {
		margin: 0;
		font-size: var(--ph-text-lg);
		color: var(--ink);
		font-weight: 600;
	}
	.err {
		color: var(--danger-ink);
		font-size: var(--ph-text-md);
	}
	/*
	 * THE STEP DOTS. Geometry off the spacing scale and a pill radius, the same small-indicator shape
	 * NowPlayingBand's `.dot` uses, so a second idiom for "a small round marker" is not invented here.
	 * The active state is a WIDER pill in `--accent` rather than a brighter dot: at 10px a colour-only
	 * difference is close to the 3:1 non-text floor to begin with, and length reads at a glance where a
	 * shade does not. No transition — see the markup note.
	 */
	.steps {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-sm);
		margin: 0;
	}
	.dot {
		flex: 0 0 auto;
		width: var(--space-md);
		height: var(--space-md);
		border-radius: var(--radius-pill);
		background: var(--line-strong);
	}
	.dot.on {
		width: var(--space-4xl);
		background: var(--accent);
	}
	/* Visually hidden, announced: the clip-rect idiom (as `routes/+page.svelte`'s `.sr-live`), not
	   `display: none`, which most screen readers skip entirely. Screenshot-neutral. */
	.step-count {
		position: absolute;
		width: 1px;
		height: 1px;
		margin: -1px;
		padding: 0;
		border: 0;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	.name-field {
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
	}
	.name-label {
		font-size: var(--ph-text-sm);
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--ink-dim);
	}
	/*
	 * `.name-input` moved into ui/input as its `join` variant. The declarations are unchanged;
	 * scoped CSS here cannot reach the element the component renders.
	 */
	/*
	 * THE COLUMN THIS PANE DOCKS AGAINST. `.submit-slot`'s `margin-top: auto` can only push the CTA to
	 * the bottom if this element actually HAS a bottom to reach — and it did not: `routes/+page.svelte`
	 * gives its `main` `flex: 1` but never `display: flex`, so `.join-main` was a block child of a block
	 * container, shrank to its content, and the auto margin had no free space to consume. Measured: the
	 * CTA sat mid-screen with ~470px of dead viewport under it.
	 *
	 * Reached with `:has()` from here rather than by making that `main` a column for every route,
	 * because the JOINED queue view is the other thing inside it and does not want to be a flex column.
	 * The same idiom is already used a few rules down for `.app-shell:has(.join-main)`.
	 *
	 * This matters beyond tidiness: bottom-anchoring is what makes the CTA ride ABOVE the on-screen
	 * keyboard, since `app.html` sets `interactive-widget=resizes-content` and the layout viewport
	 * shrinks. Un-docked, the keyboard pushes the button around instead of lifting it.
	 */
	:global(main:has(.join-main)) {
		display: flex;
		flex-direction: column;
	}
	.join-main {
		flex: 1;
		padding: var(--space-3xl) var(--space-4xl);
		display: flex;
		flex-direction: column;
		gap: var(--space-4xl);
	}
	/* Announced, never painted — see the markup comment. The clip-rect idiom rather than
	   `display: none`, which would take it out of the accessibility tree and lose SC 3.3.2 with it. */
	.cta-reason {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
		margin: 0 0 var(--space-sm);
		color: var(--ink-dim);
		font-size: var(--ph-text-md);
		text-align: center;
	}
	/*
	 * The code pane's own column, which exists to ABSORB the free space rather than leave it in one gap
	 * below the boxes — see the markup note. `flex: 1` takes what the header and the CTA do not, and
	 * `justify-content: center` puts the boxes in the middle of it.
	 *
	 * `gap` rather than a margin on the error, so a rejected code pushes the boxes down by a known amount
	 * and the group stays centred on the pair.
	 */
	.code-pane {
		/*
		 * UNDER THE HEADER, at content height — which is the third arrangement this pane has had, so the two
		 * it is not are worth naming.
		 *
		 * `flex: 1` + `justify-content: center` centred the group in ALL the free space: ~190px above the
		 * boxes and ~190px below, content floating in the middle of nothing. Measured. Auto margins competing
		 * with `.submit-slot`'s own put it a third of the way down, which was the same problem with a worse
		 * distribution — the gap BELOW grew to two thirds.
		 *
		 * So it sits at content height directly under the step dots, `--space-4xl` away (the column's own
		 * gap), and the whole remaining void lands in ONE place: above the docked CTA, where a form with a
		 * bottom-docked button is supposed to have it. That is the arrangement iOS and Android both use, and
		 * one gap at the bottom reads as spacing where two gaps read as a layout that failed.
		 *
		 * The pane is genuinely sparse — two dots, a label, six boxes — and none of this pretends otherwise.
		 * The real answer is more on the screen, and the scan affordance that used to provide it was removed
		 * by a recorded ruling, so that stays the owner's call rather than something a layout tweak reverses.
		 */
		flex: 0 0 auto;
		display: flex;
		flex-direction: column;
		gap: var(--space-2xl);
	}
	.submit-slot {
		margin-top: auto;
		display: flex;
		flex-direction: column;
	}
	@media (min-width: 768px) {
		:global(.app-shell:has(.join-main)) {
			justify-content: center;
		}
		.join-main {
			max-width: 420px;
			margin: 0 auto;
			flex: 0 0 auto;
			padding-bottom: 0;
		}
		/* Content height already, on every width — nothing to override here now that the phone case does
		   not stretch or float it either. Kept as a marker of where the desktop branch would go if the two
		   ever need to differ again. */
		.submit-slot {
			margin-top: var(--space-sm);
		}
	}
</style>
