<!-- The UNJOINED state of `/` — two panes, and both the typed and the scanned path must stay offered.
	See docs/FRONTEND.md#the-join-screen. -->
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
	/* SNAPPED to a ring stop, because the ring can only return one of its own fills: seeded with a raw preset the
	   knob would sit on the nearest stop while the value said something the control never offered. */
	let color = $state<string>(nearestPaletteStop(SINGER_COLORS[0]).fill);
	/** The TYPED path's code, distinct from `scannedCode` below. */
	let typedCode = $state('');
	let submitting = $state(false);
	let error = $state('');

	// Read ONCE and not derived: the landing URL is fixed for the life of the page, a scan being a fresh navigation.
	const scannedCode = normalizeRoomCodeInput(page.url.searchParams.get('room') ?? '');
	const arrivedWithCode = scannedCode.length === CODE_LENGTH;

	let preview = $state<RoomPreview | null>(null);
	let previewError = $state('');
	let previewLoading = $state(false);
	// The code the current `preview` resolved FROM, which is the one the join must carry: `scannedCode` sends the
	// WRONG room in the one case both exist — a scan that failed, dropped to step 1, and was corrected by hand.
	let previewCode = $state('');

	/* DERIVED from `preview`, so no state can show an identity pane for a room that was never confirmed. */
	const pane = $derived<'resolving' | 'code' | 'identity'>(
		preview ? 'identity' : arrivedWithCode && !previewError ? 'resolving' : 'code'
	);

	/* Gated on having SEEN step 1: a guest who scans lands on step 2 without step 1 ever rendering, and "step 2
	   of 2" then reports a step they never skipped as skipped. */
	let sawCodeStep = $state(false);
	$effect(() => {
		if (pane === 'code') sawCodeStep = true;
	});

	const joinCode = $derived(preview ? previewCode : typedCode);
	const canContinue = $derived(typedCode.length === CODE_LENGTH && !previewLoading);
	const canJoin = $derived(pane === 'identity' && name.trim().length > 0 && !submitting);
	const onCodeStep = $derived(pane === 'code');
	const ctaEnabled = $derived(onCodeStep ? canContinue : canJoin);
	/* ONE reason string for BOTH panes, because there is one live region for it below and a second would compete with
	   it for the same announcement (SC 3.3.2). */
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

	// An `$effect`, not `onMount`, so the fetch runs under the mount-rung harness; `requested` stops a refetch.
	let requested = false;
	$effect(() => {
		if (arrivedWithCode && !requested) {
			requested = true;
			void loadPreview(scannedCode);
		}
	});

	/* The typed path resolves through the SAME endpoint the scanned path uses, because the confirmation sentence is
	   the whole content of step 2 — a merely well-formed code is not enough to advance on. */
	async function continueToIdentity(code?: string) {
		/* THE ARGUMENT WINS OVER `typedCode`: CodeEntry fires `oncomplete` synchronously from inside its own input
		   handler, while its `value` binding reaches this component an `$effect` later — one character too few. */
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
			// A client-side goto to the CURRENT path is a no-op, so the route never remounts. A reload is what re-runs it
			// with the new session cookie; a different `next` already navigated above.
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

<!-- ONE h1 THAT CHANGES SHAPE, and it MUST stay hoisted out of the branch: inside an `{#if}` it unmounts on every
	flip, which forces a JS crossfade. See docs/FRONTEND.md#the-join-screen. -->
<header class={['join-head', { 'head-bar': !onCodeStep }]}>
	<h1 class={['brand', { 'brand-bar': !onCodeStep }]}>
		<Icon name="mic" /> <span class="grad-text">Encore</span>
	</h1>
	<!-- THE LEDE BELONGS TO THE CODE PANE ONLY: on the identity pane the room sentence is the opening line. -->
	{#if onCodeStep}
		<p class="lede">Join the room on the TV to start singing.</p>
	{/if}
</header>

<!-- A div, NEVER a second `<main>`: this renders inside the layout's own main. The `.join-main` class is what every
	rule below — and the `:has()` selectors — key on. -->
<div class="join-main">
	{#if sawCodeStep}
		<!-- No transition: the active dot changes WIDTH, a layout property this codebase does not animate. -->
		<p class="steps">
			<!-- NOT a live region: the pane change is a navigation the CTA press caused, not an ambient event. -->
			<span class="step-count">Step {pane === 'identity' ? 2 : 1} of 2</span>
			<span class={['dot', { on: onCodeStep }]} aria-hidden="true"></span>
			<span class={['dot', { on: pane === 'identity' }]} aria-hidden="true"></span>
		</p>
	{/if}

	{#if pane === 'resolving'}
		<!-- The spinner is aria-hidden DECORATION; the SENTENCE is the announcement. A skeleton cannot replace it —
				it says nothing, so the region would announce nothing at all. -->
		<p class="confirm" role="status"><Spinner aria-hidden="true" /> Finding the room…</p>
	{:else if pane === 'identity'}
		<!-- STEP 2 — IDENTITY. No code input here: both paths have already taken the code. -->
		<p class="confirm" role="status">{confirmSentence}</p>

		<label class="name-field">
			<span class="eyebrow">Your name</span>
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

		<!-- `taken` is REAL OCCUPANCY, from the same room-preview response the sentence above is built from. An empty
				room is an empty list, which needs no special case. -->
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
		<!-- STEP 1 — CODE, the fallback pane. NO SCAN AFFORDANCE HERE, deliberately, and the SC 3.3.8 cost of that
				ruling is recorded at docs/FRONTEND.md#the-join-screen. -->
		<div class="code-pane">
			{#if previewError}
				<!-- A rejected code must NOT leave a blank form: the reason goes directly above the boxes to correct. -->
				<div class="err" role="alert">{previewError}</div>
			{/if}
			<CodeEntry bind:value={typedCode} label="Room code" oncomplete={continueToIdentity} />
		</div>
	{/if}

	<!-- ONE CTA slot for both panes, docked to the bottom by an auto margin AND by `position: sticky` — see the rule.
		The auto margin alone is inert in exactly the case it used to be credited with: measured at 320 wide this column
		is 573px against a 308px viewport (568 less a 260px keyboard), so there is no free space left for a margin to
		consume and the button's static position lands at y=598, 290px below the fold. `app.html`'s interactive-widget
		mode shrinks the layout viewport, which is what the sticky offset then measures against. -->
	<div class="submit-slot">
		<!-- The disabled reason exists in text for assistive tech (SC 3.3.2) but is ANNOUNCED, not printed. The element
			and its live region stay; only the painting stops. -->
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
	/* TWO NAMED ROWS, for the FLIGHT rather than the layout: the brand row is a RESERVED band whose height does not
	   depend on which pane is open, so nothing below the header moves when the mark flies. `container-type:
	   inline-size` is for the centring in `.brand`, which needs the CONTAINER's width. */
	.join-head {
		display: grid;
		grid-template-areas: 'brand' 'lede';
		justify-items: center;
		container-type: inline-size;
		padding: calc(var(--tap) + var(--space-2xl)) var(--space-4xl) var(--space-sm);
		text-align: center;
	}
	/* THE WORDMARK'S FLIGHT, in `transform` ALONE — the repo animates transform and opacity and nothing else, so the
	   shrink cannot be a font-size and the move cannot be a margin. The same two functions in the same order in both
	   states, or the browser interpolates matrices instead of per-function. See docs/FRONTEND.md#the-join-screen. */
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
	}
	/* Flush on the gutter, up into the reserved band by exactly `--tap`, its own height. The scale factor is a
	   RATIO, because CSS cannot divide one length by another — the effective type is still a ladder step. */
	.brand-bar {
		transform: translate(0, calc(-1 * var(--tap))) scale(0.667);
	}
	/* THE FLIGHT ITSELF, opt-in rather than declared-then-reset: under Reduce Motion the mark is already in its end
	   position, which is what an authored declaration buys — and with nothing declared there is no reset for a later
	   rule to out-cascade and fly the wordmark at someone who asked for no motion. */
	@media (prefers-reduced-motion: no-preference) {
		.brand {
			transition: transform var(--motion-base);
		}
	}
	/* Left-aligns the LEDE under the wordmark; the mark itself is already on the gutter in both states. */
	.head-bar {
		justify-items: start;
		text-align: left;
	}
	.lede {
		grid-area: lede;
		color: var(--ink-dim);
		margin: var(--space-xs) 0 0;
		font-size: var(--ph-text-md);
	}
	/* `.confirm`, `.err` and `.cta-reason` must stay ordinary elements rather than Field primitives: the e2e selector
	   contract addresses `.err` as a class on the alerting element and a class handed to a component carries no
	   scoped rule, and the primitive would dim and shrink the other two. */
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
	/* THE COLUMN THE CTA DOCKS AGAINST. `.submit-slot`'s auto margin can only push the CTA to the bottom if this
	   element HAS a bottom to reach: the layout's `main` is `flex: 1` without `display: flex`, so `.join-main`
	   otherwise shrinks to its content. `:has()`, because the joined queue view is the other thing inside it. */
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
	/* Announced, never painted: the clip idiom rather than `display: none`, which would lose SC 3.3.2 with it. */
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
	/* AT CONTENT HEIGHT, not `flex: 1`: centring splits the free space into two gaps, above and below the boxes,
	   which reads as a layout that failed. The `gap` keeps the group's spacing known when an error pushes down. */
	.code-pane {
		flex: 0 0 auto;
		display: flex;
		flex-direction: column;
		gap: var(--space-2xl);
	}
	/* STICKY AS WELL AS AUTO-MARGINED, because the auto margin is inert in exactly the case that needs it: with the
	   keyboard up this column is TALLER than the viewport, so there is no free space left for an auto margin to
	   consume and the CTA docks to the bottom of the DOCUMENT instead. Measured on the identity pane at 320 wide:
	   the column is 573px against a 308px viewport (568 less a 260px keyboard, which is what
	   `interactive-widget=resizes-content` shrinks it to), and the button's static position lands at y=598 — 290px
	   below the fold, so the app's one button is off screen while the guest types into the field that opened the
	   keyboard. Sticky pins it just above the keyboard instead.
	   It costs NOTHING where the column fits: a bottom inset only ever pulls a sticky box back toward the
	   scrollport, never past its static position, and the button measured to the same pixel at 390x844, 360x740,
	   430x932 and 1024x768 with this rule on and off.
	   No `env(safe-area-inset-bottom)` term. `.app-shell` already carries that as padding for the resting case,
	   which is the case where this rule does nothing, and iOS reports the bottom inset as 0 while the keyboard —
	   the thing being cleared here — is up, so a second term would only double the gap.
	   THE FILL IS REQUIRED, not decoration: with nothing behind it the colour ring scrolls straight through a
	   sticky surface, the defect `PageHeader` records at the other edge. The band above it is a box-shadow rather
	   than padding because padding is LAYOUT — 8px of it moved the button 8px down on the >=768 column, whose
	   `margin-top` is a fixed length with no auto margin to absorb it. */
	.submit-slot {
		margin-top: auto;
		display: flex;
		flex-direction: column;
		position: sticky;
		bottom: 0;
		background: var(--bg);
		box-shadow: 0 calc(-1 * var(--space-sm)) 0 var(--bg);
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
