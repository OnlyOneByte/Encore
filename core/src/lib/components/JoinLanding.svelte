<!-- The UNJOINED state of `/` — two panes, and both the typed and the scanned path must stay offered.
	See docs/FRONTEND.md#the-join-screen. -->
<script lang="ts">
	import { flushSync, onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { SINGER_COLORS, freeSingerColor, nearestPaletteStop } from '$lib/contract';
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
	import { room } from '$lib/stores/room';

	/* A phone the room STOPPED knowing mid-party (Leave on another tab, cookies cleared, a reset room): it says why it
	   is here and keeps the name, so the name step is already filled in. The room code is still asked for: the phone
	   never holds it (`/api/me` does not send it), and after a reset room it would be the wrong one anyway. Read once:
	   the link only ever sets it on the way to this screen. */
	const lostName = room.lostName;
	const lostColor = room.lostColor;
	let name = $state(lostName ?? '');
	/* THIS SCREEN'S LIVE REGIONS MOUNT EMPTY and their words arrive a frame later: a screen reader often stays silent for
	   a region inserted with its text already in it, and the `$effect` that used to fill the lost line ran in the same
	   flush as the mount (filled in the frame it appeared, 12 runs of 12). Two frames, so the empty region is painted
	   — and in the accessibility tree — before anything is written into it. */
	let settled = $state(false);
	onMount(() => {
		let id = requestAnimationFrame(() => (id = requestAnimationFrame(() => (settled = true))));
		return () => cancelAnimationFrame(id);
	});
	/* SNAPPED to a ring stop, because the ring can only return one of its own fills: seeded with a raw preset the
	   knob would sit on the nearest stop while the value said something the control never offered. A singer the room
	   lost comes back in their own colour, so their songs on the TV keep it: it is sent as chosen, and the server keeps
	   a legible colour as asked even if someone else now holds it (`resolveSingerColor`), as for any ring pick. */
	let color = $state<string>(nearestPaletteStop(lostColor ?? SINGER_COLORS[0]).fill);
	/* Whether the GUEST moved the ring, set only by the ring's own write-back. Until then `color` is a suggestion from
	   the preview and is never sent: the server picks a free one, because phones that scanned together read the same
	   preview. Tracked as a touch, not by comparing against the suggestion, so choosing the start colour on purpose
	   (away and back) is kept. A lost singer's own colour counts as chosen. */
	let colorPicked = $state(lostColor !== null);
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

	/* A kept phone joins as its person in one tap; "I'm someone else" is the borrowed-phone way out. `renaming` is a
	   kept phone whose name someone in the room already holds. See docs/FRONTEND.md#the-join-screen. */
	let someoneElse = $state(false);
	let renaming = $state(false);
	const returning = $derived(someoneElse ? null : (preview?.returning ?? null));

	/* DERIVED from `preview`, so no state can show an identity pane for a room that was never confirmed. */
	const pane = $derived<'resolving' | 'code' | 'identity'>(
		preview ? 'identity' : arrivedWithCode && !previewError ? 'resolving' : 'code'
	);

	/* The colour sits behind "change" (redesign step 7, #1157): the ring opens in a modal dialog over the card, so
	   picking moves nothing on the page. */
	const stopName = $derived(nearestPaletteStop(color).name);
	// The card's ring and the CTA's fill: the colour you will sing in, once the room is known.
	const cardStop = $derived(pane !== 'identity' ? null : nearestPaletteStop(returning ? returning.color : color));
	let ringDialog = $state<HTMLDialogElement>();
	// The ring mounts on the first "change", not with the card, so the QR's first render does not pay for it (#1320).
	let ringMounted = $state(false);

	const joinCode = $derived(preview ? previewCode : typedCode);
	const canContinue = $derived(typedCode.length === CODE_LENGTH && !previewLoading);
	/* A kept phone needs no name unless it is renaming. */
	const needsName = $derived(!returning || renaming);
	const canJoin = $derived(pane === 'identity' && (!needsName || name.trim().length > 0) && !submitting);
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
		if (needsName && name.trim().length === 0) return 'Enter your name to continue.';
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
				if (!colorPicked) color = freeSingerColor(preview.colors ?? []);
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
		const asKept = returning !== null;
		try {
			const res = await fetch('/api/join', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(
					asKept
						? { returning: true, displayName: renaming ? name.trim() : undefined, code: joinCode || undefined }
						: { displayName: name.trim(), color: colorPicked ? color : undefined, code: joinCode || undefined }
				)
			});
			if (!res.ok) {
				error = (await res.json()).error ?? 'Could not join';
				// Someone here holds the kept name: ask for another, still as this person.
				if (asKept && res.status === 409 && !renaming) {
					renaming = true;
					name = returning?.displayName ?? '';
				}
				// The phone is no longer kept: it joins like anyone else.
				if (asKept && res.status === 401) someoneElse = true;
				submitting = false;
				return;
			}
			// The cookie is this browser's, so its other tabs are this singer now too.
			room.sessionChanged((await res.json().catch(() => null))?.singer?.id);
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

<!-- A div, NEVER a second `<main>`: on `/` this renders inside the home route's main (on `/library` there is no main
	at all, which is why the CSS neutralises the host rather than trusting it). The `.join-main` class is what every
	rule below — and the `:has()` selectors — key on. -->
<div class="join-main">
	{#if lostName !== null}
		<p class="lost" role="status">{settled ? "You're not in the room any more. Join again to sing." : ''}</p>
	{/if}
	<!-- ONE CARD FOR THE CODE AND THE NAME (redesign step 7, #1157): the idle Spotlight's look, inline rather than the
		component, because this screen also renders on /queue, which does not ship Spotlight's stylesheet (#1198). The
		code, then the name, fill the same card, and its button sits right under the field it acts on. -->
	<section
		class="join-card"
		aria-label={onCodeStep ? 'Room code' : 'Join'}
		style:display="flex"
		style:flex-direction="column"
		style:gap="var(--step-12)"
		style:padding="var(--step-16) var(--step-16) var(--step-12)"
		style:border-radius="var(--round-spot)"
		style:background="var(--role-raise)"
		style:box-shadow="inset 0 0 0 2px {cardStop?.fill ?? 'var(--role-accent)'}"
	>
		{#if pane === 'resolving'}
			<!-- The spinner is aria-hidden DECORATION; the SENTENCE is the announcement. A skeleton cannot replace it —
				it says nothing, so the region would announce nothing at all. -->
			<!-- Its box from the first frame, so the sentence that replaces it moves nothing; seen only past the grace. -->
			<p class="confirm finding" role="status"><Spinner aria-hidden="true" /> Finding the room…</p>
		{:else if pane === 'identity'}
			<!-- IDENTITY. No code input here: both paths have already taken the code. -->
			<p class="confirm" role="status">{confirmSentence}</p>

			{#snippet nameField()}
				<label class="name-field">
					<span class="control-label">Your name</span>
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
			{/snippet}

			{#if returning}
				<h2
					style:margin="0"
					style:font-size="var(--type-lead)"
					style:font-weight="800"
					style:line-height="var(--lh-tight)"
				>
					Welcome back, {returning.displayName}
				</h2>
				{#if renaming}{@render nameField()}{/if}
				<Button
					variant="ghost"
					size="tap"
					onclick={() => {
						someoneElse = true;
						renaming = false;
						error = '';
						name = '';
					}}>I'm someone else</Button
				>
			{:else}
				{@render nameField()}

				<!-- The colour is a suggestion until touched, so it waits behind "change". -->
				<button
					type="button"
					class="colour"
					aria-haspopup="dialog"
					onclick={() => {
						ringMounted = true;
						flushSync();
						ringDialog?.showModal();
					}}
				>
					<span
						style:flex="none"
						style:width="28px"
						style:height="28px"
						style:border-radius="50%"
						style:background={color}
						aria-hidden="true"
					></span>
					<span>Your color <b>{stopName}</b> · change</span>
				</button>
			{/if}

			{#if error}
				<div class="err" role="alert">{error}</div>
			{/if}
		{:else}
			<!-- CODE, the fallback pane. NO SCAN AFFORDANCE HERE, deliberately, and the SC 3.3.8 cost of that ruling is
				recorded at docs/FRONTEND.md#the-join-screen. -->
			{#if previewError}
				<!-- A rejected code must NOT leave a blank form: the reason goes directly above the boxes to correct. -->
				<div class="err" role="alert">{previewError}</div>
			{/if}
			<CodeEntry bind:value={typedCode} label="Room code" oncomplete={continueToIdentity} />
		{/if}

		<!-- ONE CTA for both panes, in the card under the field it acts on; sticky, so with the keyboard up it rides just
			above it (see `.submit-slot`). None while the room resolves: the card grows when it does, and a button already
			there would be pushed down. -->
		{#if pane !== 'resolving'}
			<div class="submit-slot">
				<!-- Start singing is filled in the colour you will sing in, inked in that stop's certified on_fill. -->
				<Button
					size="blockLg"
					disabled={!ctaEnabled}
					style={ctaEnabled && cardStop ? `background:${cardStop.fill};color:${cardStop.on_fill}` : undefined}
					onclick={onCodeStep ? () => continueToIdentity() : join}
				>
					{#if onCodeStep}
						{#if previewLoading}Checking the code…{:else}Continue <Icon name="arrow-right" />{/if}
					{:else if submitting}Joining…{:else}Start singing <Icon name="arrow-right" />{/if}
				</Button>
			</div>
		{/if}
	</section>
	<!-- The disabled reason is ANNOUNCED for assistive tech (SC 3.3.2), never painted; filled only once `settled`. -->
	<p class="cta-reason" role="status" aria-live="polite">{settled && !submitting ? ctaReason : ''}</p>

	{#if ringMounted && pane === 'identity' && !returning}
		<!-- `taken` is REAL OCCUPANCY, from the same room-preview response the sentence is built from. -->
		<!-- Its own surface: one step above the card (--card2), over a strong scrim. -->
		<dialog
			class="ring-dialog"
			bind:this={ringDialog}
			aria-label="Your color"
			style:max-width="min(360px, calc(100vw - 2 * var(--space-4xl)))"
			style:padding="var(--step-16)"
			style:border="0"
			style:border-radius="var(--round-spot)"
			style:background="var(--card2)"
			style:color="var(--role-ink)"
		>
			<ColourRing
				label="Your color"
				hint="How you'll spot yourself in the queue and on the TV."
				taken={preview?.colors ?? []}
				bind:value={
					() => color,
					(v) => {
						color = v;
						colorPicked = true;
					}
				}
			/>
			<Button size="blockLg" onclick={() => ringDialog?.close()}>Done</Button>
		</dialog>
	{/if}
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
	/* Tenet 2 (#1089): hidden for PENDING_GRACE_MS (300 ms) from the frame it mounts, so a quick room never shows it;
	   the sentence replacing it later is content, never held (#1171). No motion, so not behind reduced motion. */
	.finding {
		animation: finding 0s 0.3s backwards;
	}
	@keyframes finding {
		from {
			visibility: hidden;
		}
	}
	/* --warn, not --danger-ink: nothing failed, the room simply does not know this phone any more. */
	.lost {
		margin: 0;
		min-height: 2lh;
		color: var(--warn);
		font-size: var(--ph-text-md);
	}
	.err {
		color: var(--danger-ink);
		font-size: var(--ph-text-md);
	}
	/* The card, its heading, the swatch and the ring's dialog are styled inline: CLAIM 13 has little CSS room on /queue. */
	/* STICKY: with the keyboard up, `interactive-widget=resizes-content` shrinks the layout viewport and the CTA rides
	   just above the keyboard (at 320x568 it sat 60-118 px under it). The card's fill, and a band of it above, keep the
	   rows it passes over from showing through. Inert at rest, where the CTA is already on screen. */
	.submit-slot {
		position: sticky;
		bottom: 0;
		background: var(--role-raise);
		box-shadow: 0 calc(-1 * var(--step-12)) 0 var(--role-raise);
	}
	.ring-dialog::backdrop {
		background: var(--scrim-strong);
	}
	.colour {
		display: flex;
		align-items: center;
		gap: var(--step-12);
		min-height: var(--tap);
		padding: 0;
		border: 0;
		background: none;
		color: var(--ink-dim);
		font: inherit;
		font-size: var(--type-meta);
		text-align: start;
		cursor: pointer;
	}
	.colour b {
		color: var(--ink);
	}
	.name-field {
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
	}
	/* THE HOST THE GATE NEUTRALISES, so `/` and `/library` place it the same (CLAIM 7 reads this back). `.app-shell >`
	   is for specificity: at 0,2,1 it beats the route's own scoped `main` rule, which otherwise wins on bundle order. */
	:global(.app-shell > main:has(.join-main)) {
		display: flex;
		flex-direction: column;
		padding: 0;
	}
	.join-main {
		flex: 1;
		padding: var(--space-2xl) var(--space-4xl);
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
	}
	@media (min-width: 768px) {
		:global(.app-shell:has(.join-main)) {
			justify-content: center;
		}
		/* The host stops absorbing the free space, or on `/` the gate sat at the top while `/library` centred it. */
		:global(.app-shell > main:has(.join-main)) {
			flex: 0 0 auto;
		}
		.join-main {
			max-width: 420px;
			margin: 0 auto;
			flex: 0 0 auto;
			padding-bottom: 0;
		}
	}
</style>
