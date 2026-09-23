<!--
	JoinLanding — the UNJOINED state of `/`. There is no separate join route; this is what an unjoined visitor sees
	instead of the queue.

	TWO PANES: step 1 is the CODE pane, a FALLBACK reached only by a guest with no code in the URL or whose scanned
	code did not resolve; step 2 is the IDENTITY pane — the room confirmed IN WORDS, the name field, the colour
	ring, the CTA — and the only pane a guest who scanned the QR ever sees.

	BOTH PATHS MUST STAY OFFERED, never one instead of the other: a typed code alone is a cognitive-function test
	under SC 3.3.8, and the scan path is what makes this conformant.

	The room has no NAME in the schema, so "confirmed in words" is who is here, from the room-preview endpoint.
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
	 * The default colour is SNAPPED to a ring stop, because the ring can only return one of its own fills:
	 * seeded with a raw preset the knob would sit on the nearest stop while the value said something the
	 * control never offered, and a guest who never touched the picker would join on it.
	 */
	let color = $state<string>(nearestPaletteStop(SINGER_COLORS[0]).fill);
	/** The TYPED path's code, distinct from `scannedCode` below. */
	let typedCode = $state('');
	let submitting = $state(false);
	let error = $state('');

	// A code carried in on the URL, which is what the TV's QR encodes. Read ONCE and not derived: the
	// landing URL is fixed for the life of the page, because a scan is a fresh navigation.
	const scannedCode = normalizeRoomCodeInput(page.url.searchParams.get('room') ?? '');
	const arrivedWithCode = scannedCode.length === CODE_LENGTH;

	let preview = $state<RoomPreview | null>(null);
	let previewError = $state('');
	let previewLoading = $state(false);
	// The code the current `preview` resolved FROM, which is the one the join must carry: reading
	// `scannedCode` instead sends the WRONG room in the one case both codes exist — a scan that failed,
	// dropped to step 1, and was corrected by hand.
	let previewCode = $state('');

	/*
	 * WHICH PANE IS ON SCREEN, derived from `preview` rather than a hand-advanced counter, so no state can
	 * show an identity pane for a room that was never confirmed. `resolving` exists so a guest who scanned
	 * is not shown six empty boxes for the length of one fetch.
	 */
	const pane = $derived<'resolving' | 'code' | 'identity'>(
		preview ? 'identity' : arrivedWithCode && !previewError ? 'resolving' : 'code'
	);

	/*
	 * The step dots are gated on having SEEN step 1: a guest who scans lands on step 2 without step 1 ever
	 * rendering, and "step 2 of 2" then reports a step they never skipped as skipped. Set from the pane
	 * rather than from the code path, so the failed-scan guest who corrects by hand keeps the dots.
	 */
	let sawCodeStep = $state(false);
	$effect(() => {
		if (pane === 'code') sawCodeStep = true;
	});

	const joinCode = $derived(preview ? previewCode : typedCode);
	const canContinue = $derived(typedCode.length === CODE_LENGTH && !previewLoading);
	const canJoin = $derived(pane === 'identity' && name.trim().length > 0 && !submitting);
	const onCodeStep = $derived(pane === 'code');
	const ctaEnabled = $derived(onCodeStep ? canContinue : canJoin);
	/*
	 * ONE reason string for BOTH panes, because there is one live region for it below and
	 * `phone-inventory.test.ts` enumerates every phone live region with its purpose — a second one fails
	 * there, correctly, since the disabled reason is a single duty however many panes state it (SC 3.3.2).
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

	// An `$effect` rather than `onMount` so the fetch runs under the mount-rung harness, which drives
	// effects. `requested` guards against a re-run firing a second fetch.
	let requested = false;
	$effect(() => {
		if (arrivedWithCode && !requested) {
			requested = true;
			void loadPreview(scannedCode);
		}
	});

	/*
	 * STEP 1 to STEP 2. The typed path resolves through the SAME endpoint the scanned path uses, because the
	 * confirmation sentence is the whole content of step 2 — a merely well-formed code is not enough to
	 * advance on. A code that does not resolve leaves the guest on step 1 with the reason stated.
	 */
	async function continueToIdentity(code?: string) {
		/*
		 * THE ARGUMENT WINS OVER `typedCode`: CodeEntry fires `oncomplete` synchronously from inside its own
		 * input handler, while its `value` binding reaches this component an `$effect` later. Reading
		 * `typedCode` here sees one character too few, fails the length check and returns silently, so the
		 * last character of a typed code and a whole pasted code both do nothing.
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
			// `safeNextPath` is what keeps `?next=` from becoming an open redirect.
			const dest = safeNextPath(page.url.searchParams.get('next'));
			await goto(dest);
			// A client-side goto to the CURRENT path is a no-op, so the route never remounts and the guest
			// stays on the join form they just completed. A reload is what re-runs it with the new session
			// cookie; a different `next` already navigated above.
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
	ONE h1 THAT CHANGES SHAPE, never two that swap — the same mark travelling between the panes is what tells the
	guest they are one flow. It MUST stay hoisted out of the branch: inside an `{#if}` it unmounts on every flip,
	leaving nothing for the browser to interpolate, which forces a JS crossfade — and that both generates keyframes
	no media query can reach and reads geometry, which the mount rung replaces with a throw. Hoisted, only its CLASS
	changes and the transform interpolates natively. See `.brand`.
-->
<header class="join-head" class:head-bar={!onCodeStep}>
	<h1 class="brand" class:brand-bar={!onCodeStep}>
		<Icon name="mic" /> <span class="wordmark">Encore</span>
	</h1>
	<!--
		THE LEDE BELONGS TO THE CODE PANE ONLY: on the identity pane the room sentence is the opening line, and a
		lede above it would say the same thing with none of the facts in it.
	-->
	{#if onCodeStep}
		<p class="lede">Join the room on the TV to start singing.</p>
	{/if}
</header>

<!--
	A div, NEVER a second `<main>`: this renders inside the layout's own main, so a main here is invalid HTML and
	two landmarks for a screen reader to choose between on the first screen of the app. The `.join-main` class is
	what every rule below — and the `:has()` selectors — key on.
-->
<div class="join-main">
	{#if sawCodeStep}
		<!-- No transition between the two dot states: the active dot changes WIDTH, which is a layout property
		     this codebase does not animate, so the step change is instant rather than reduced-motion gated. -->
		<p class="steps">
			<!-- The same fact for a guest who cannot see the dots. NOT a live region: the pane change is a
			     navigation the CTA press caused, not an ambient event. -->
			<span class="step-count">Step {pane === 'identity' ? 2 : 1} of 2</span>
			<span class="dot" class:on={onCodeStep} aria-hidden="true"></span>
			<span class="dot" class:on={pane === 'identity'} aria-hidden="true"></span>
		</p>
	{/if}

	{#if pane === 'resolving'}
		<!--
			The spinner is aria-hidden DECORATION; the SENTENCE is the announcement, because this status region is
			what a screen-reader guest hears while the room resolves. A skeleton cannot replace it — it says
			nothing, so the region would announce nothing at all.
		-->
		<p class="confirm" role="status"><Spinner aria-hidden="true" /> Finding the room…</p>
	{:else if pane === 'identity'}
		<!-- STEP 2 — IDENTITY. No code input here: both paths have already taken the code, so re-presenting it
		     would be the code shown back as an input the guest has no reason to touch. -->
		<p class="confirm" role="status">{confirmSentence}</p>

		<label class="name-field">
			<span class="name-label">Your name</span>
			<!-- `maxlength` must be a NUMBER: the DOM coerces a string, but a typed component prop does not. -->
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
			`taken` is REAL OCCUPANCY, from the same room-preview response the sentence above is built from, so the
			pips mark colours actually in the room. An empty room is an empty list, which needs no special case.
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
		     STEP 1 — CODE, the fallback pane.

		     NO SCAN AFFORDANCE HERE, deliberately: this pane is unreachable for anyone who scanned, since a scanned
		     QR resolves and opens the identity pane directly. A camera row would also be inoperable — the app is
		     served from a plain-http LAN origin and `navigator.mediaDevices` is secure-context gated.

		     WHAT THAT COSTS: the SC 3.3.8 argument rests on the scan path existing, which it does (the TV shows the
		     QR), but it is no longer narrated on this screen. A deliberate ruling; revisit it here if the
		     conformance claim needs re-making.
		-->
		<div class="code-pane">
			{#if previewError}
				<!-- A code that did not resolve must NOT leave a blank form: the reason goes directly above the
				     boxes the guest can correct, for both a failed scan and a failed typed code. -->
				<div class="err" role="alert">{previewError}</div>
			{/if}
			<CodeEntry bind:value={typedCode} label="Room code" oncomplete={continueToIdentity} />
		</div>
	{/if}

	<!--
		ONE CTA slot for both panes, docked to the BOTTOM by `.submit-slot`'s auto margin. It can sit there because
		`app.html` sets the interactive-widget mode that shrinks the LAYOUT viewport when the on-screen keyboard
		opens, so bottom-anchored content rides above the keyboard instead of under it — that meta is load-bearing
		for this placement, and headless Chromium has no soft keyboard, so no measured gate can verify it.

		Shared rather than one per pane, so this file keeps exactly ONE live region for the disabled reason.
	-->
	<div class="submit-slot">
		<!--
			The disabled reason exists in text for assistive tech (SC 3.3.2) but is ANNOUNCED, not printed: shown, it
			is a third sentence telling a guest who can see six empty boxes to fill them in, above a button that is
			visibly disabled. The element and its live region stay; only the painting stops.
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
	 * A GRID WITH TWO NAMED ROWS, for the FLIGHT rather than the layout: the brand row is a RESERVED band whose
	 * height does not depend on which pane is open, so nothing below the header moves when the mark flies. The
	 * top band is unconditional — the home route hides its topbar for an unjoined visitor, and it is also the
	 * band the wordmark flies into; a per-pane padding would move the mark by changing LAYOUT instead.
	 *
	 * `container-type: inline-size` exists for the centring in `.brand`, which needs the CONTAINER's width: a
	 * percentage inside a `transform` resolves against the transformed element itself.
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
	 * THE WORDMARK'S FLIGHT, in `transform` ALONE. Both the move and the shrink must be that one transform — the
	 * repo animates transform and opacity and nothing else — so the shrink cannot be a font-size and the move
	 * cannot be a margin. Written as the same two functions in the same order in both states, or the browser
	 * interpolates matrices instead of per-function. `transform-origin: left top` pulls the shrink toward the
	 * corner the mark is heading for; a centre origin drifts the top-left corner off the gutter.
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
	 * STEP 2's HEADER: flush on the gutter, up into the reserved band by exactly `--tap`, its own height. The
	 * scale factor is --ph-text-base over --ph-text-2xl written as a RATIO, because CSS cannot divide one length
	 * by another — the effective type is still a ladder step.
	 */
	.brand-bar {
		transform: translate(0, calc(-1 * var(--tap))) scale(0.667);
	}
	/* Reduce Motion: the mark is already in its end position on the flip. This is the point of expressing the
	   flight as an authored declaration — a media query has something to override. */
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
	 * `.confirm`, `.err` and `.cta-reason` must stay ordinary elements rather than Field primitives.
	 * `.err` because `tests/e2e/contract.ts` addresses it as a class on the alerting element, and a class handed
	 * to a component carries no scoped rule; `.confirm` because it is the scanned path's headline and the
	 * primitive would dim and shrink it; `.cta-reason` because it needs its gap BELOW and centred text, and the
	 * only way to override the primitive reaches settings' own descriptions too.
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
	/* The active dot is a WIDER pill, not just a brighter one: at 10px a colour-only difference sits close to the
	   3:1 non-text floor, and length reads at a glance where a shade does not. */
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
	/* Visually hidden but announced: the clip idiom, never `display: none`, which most screen readers skip. */
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
	 * THE COLUMN THE CTA DOCKS AGAINST. `.submit-slot`'s auto margin can only push the CTA to the bottom if this
	 * element HAS a bottom to reach: the layout's `main` is `flex: 1` without `display: flex`, so without this
	 * `.join-main` is a block child that shrinks to its content and the auto margin has no free space to consume.
	 * Reached with `:has()` rather than by making that main a column for every route, because the joined queue
	 * view is the other thing inside it. Load-bearing beyond tidiness: bottom-anchoring is what lifts the CTA
	 * above the on-screen keyboard.
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
	/* Announced, never painted: the clip idiom rather than `display: none`, which would take it out of the
	   accessibility tree and lose SC 3.3.2 with it. */
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
	 * UNDER THE HEADER, AT CONTENT HEIGHT. `flex: 1` with centring splits the free space into two gaps — above and
	 * below the boxes — which reads as a layout that failed; at content height the whole void lands in ONE place,
	 * above the docked CTA, where a form with a bottom-docked button is supposed to have it. The `gap` rather than
	 * a margin on the error keeps the group's spacing known when a rejected code pushes the boxes down.
	 */
	.code-pane {
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
		.submit-slot {
			margin-top: var(--space-sm);
		}
	}
</style>
