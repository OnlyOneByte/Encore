<!-- The UNJOINED state of `/` — two panes, and both the typed and the scanned path must stay offered.
	See docs/FRONTEND.md#the-join-screen. -->
<script lang="ts">
	import { onMount } from 'svelte';
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

	/* Gated on having SEEN step 1: a guest who scans lands on step 2 without step 1 ever rendering, and "step 2
	   of 2" then reports a step they never skipped as skipped.
	   SEEDED FROM THE OPENING PANE rather than from `false`, because `false` was a LAYOUT SHIFT on the first screen
	   every guest opens. A bare `/` or `/library` resolves `pane === 'code'` in its very first render, so the latch
	   below was always going to be true — but an `$effect` runs AFTER that render, so `.steps` mounted a frame late
	   and grew `.join-main` by 30px (the row's own 10px plus this column's 20px `gap`). On the centred layout from
	   --bp-md up that moved the whole gate 15px: measured at 768x900, `.join-head` painted at y=277.58 and then
	   jumped to its resting y=262.58, with the CTA's bottom edge going the other way, 622.41 -> 637.41.
	   WRITTEN AS `!arrivedWithCode` AND NOT AS `pane === 'code'`, which is the same boolean here and the better
	   spelling: `pane` is a `$derived`, and capturing one in a `$state` initialiser is exactly what
	   `state_referenced_locally` warns about — the capture is intended, but the warning is indistinguishable from
	   the bug it exists to catch. At this point `preview` is null and `previewError` is empty, so `pane` can only be
	   'resolving' or 'code' and the arm that decides between them is `arrivedWithCode` alone, which is a plain const
	   read once off the landing URL.
	   The `$effect` STAYS, and is not redundant: it carries the case this seed cannot see, a guest who arrives with
	   a scanned code on `pane === 'resolving'` and drops back to step 1 when the preview fails. Such a guest must
	   still START with `sawCodeStep` false, which is what seeding from the opening pane gives.
	   The shift was caught by tests/playwright/specs/gate/measured-join-gate.spec.ts, whose two equality arms read
	   the two hosts at different points in this one-frame window and so disagreed by exactly that 15px. */
	let sawCodeStep = $state(!arrivedWithCode);
	$effect(() => {
		if (pane === 'code') sawCodeStep = true;
	});

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
			<!-- The idle Spotlight's look, inline rather than the component: this screen also renders on /queue, which
					does not ship Spotlight's stylesheet, and CLAIM 13 has no room for it there (#1198). -->
			<section
				style:padding="var(--step-4)"
				style:border-radius="var(--round-spot)"
				style:background="var(--role-raise)"
				style:box-shadow="inset 0 0 0 2px {nearestPaletteStop(returning.color).fill}"
			>
				<h2
					style:margin="0"
					style:font-size="var(--type-lead)"
					style:font-weight="800"
					style:line-height="var(--lh-tight)"
				>
					Welcome back, {returning.displayName}
				</h2>
			</section>
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

			<!-- `taken` is REAL OCCUPANCY, from the same room-preview response the sentence above is built from. An empty
					room is an empty list, which needs no special case. -->
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
		{/if}

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
		<!-- Always mounted (it is never painted), and filled only once `settled`: see that flag. -->
		<p class="cta-reason" role="status" aria-live="polite">{settled && !submitting ? ctaReason : ''}</p>
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
	/* THE COLUMN THE CTA DOCKS AGAINST, AND THE HOST THE GATE NEUTRALISES. `.submit-slot`'s auto margin can only
	   push the CTA to the bottom if this element HAS a bottom to reach: the host `main` is `flex: 1` without
	   `display: flex`, so `.join-main` otherwise shrinks to its content. `:has()`, because the joined queue view is
	   the other thing inside it.
	   ANCHORED ON `.app-shell >` FOR THE SPECIFICITY, NOT FOR THE REACH. The gate has TWO hosts — `/` renders it
	   inside the home route's `main`, `/library` renders it as a direct child of `.app-shell` — and the route's own
	   `main { flex: 1; padding: … }` is scoped, so it TIES a bare `main:has(.join-main)` at 0,1,1 and its chunk
	   loads after this component's (`2.*.css` after `library-browse.*.css` in node 2's css list), which wins the
	   tie. At 0,2,1 this rule wins on specificity instead of on bundle order.
	   `padding: 0` IS PART OF THE SAME DECISION: the host's route padding is a placement the gate did not choose
	   and the other route does not get — 6px at the top, 28px at the bottom, and 16px of a SECOND inline gutter
	   that `.app-shell` already owns as the app's one gutter.
	   THE RESOLVED END OF THIS RULE IS READ BACK, which is the only way a specificity argument can be checked rather
	   than asserted: CLAIM 7's mechanism arm reads the host's computed `display`, `padding` and `flex-grow` off the
	   live page, so a route chunk winning the cascade back reports itself by name — measured with this rule deleted,
	   the host resolves `display: block` below --bp-md, `grid` above it, and `padding: 6px 16px 28px` at every width
	   — instead of only moving the gate by a few pixels. */
	:global(.app-shell > main:has(.join-main)) {
		display: flex;
		flex-direction: column;
		padding: 0;
	}
	.join-main {
		flex: 1;
		/* TWO RUNGS, and the vertical one is the app's gutter rung rather than a rung of its own: this was `3xl 4xl`
		   (18/20), a 2px asymmetry nobody chose, and 3xl is retired. 16 top and bottom also pays for the join field
		   growing 14 -> 16 inline and block inside it (ui/input's `join` variant), so this screen's total height at
		   the keyboard-up case is unchanged. The inline 20 stays the widest inset in the app — this is the one screen
		   that is nothing but one hero column.
		   WHAT THAT DID TO THE READINGS FURTHER DOWN THIS FILE, now RE-READ rather than derived — a note here used to
		   predict `.join-head`'s y=263 / y=353 were 2px high, and they are not. Measured by the gate below on the CODE
		   pane, which is what a bare `/` or `/library` opens: the brand band's top is y=262.58 at 768 and at 1024 wide
		   and y=352.58 at 1920x1080, so both written figures are those values rounded. The CTA's docked bottom edge on
		   the phone arm DID move with this rung, 826 -> 828 at 390x844 (844 less this column's bottom inset, which the
		   arm below zeroes from 768 up), and the `@media` comment there is corrected to the re-read value.
		   WHAT THE GATE DOES AND DOES NOT HOLD, so nobody trusts these digits further than they go:
		   tests/playwright/specs/gate/measured-join-gate.spec.ts asserts the RELATIONS these four numbers came out of
		   — centred on both hosts from --bp-md up, filled and docked by this column's own bottom inset below it — and
		   not the digits themselves. Change a rung here and y=262.58 moves again with nothing red; what cannot happen
		   any more is the two hosts drifting apart. */
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
		/* AND THE HOST MUST STOP ABSORBING THE FREE SPACE the rule above distributes. `main { flex: 1 }` grows to the
		   full shell height, so on `/` there was nothing left to centre and the gate sat at the top while `/library`,
		   where the gate is the shell's own child, centred — the same component in two places, decided by the landing
		   route. Measured at 1024x900: `.join-head` at y=6 on `/` against y=263 on `/library`, a 257px divergence for
		   identical markup; with this rule both read y=263 (and y=353 at 1920x1080).
		   IT CANNOT BE UNCONDITIONAL — the host MUST keep `flex: 1` below 768, or it shrinks to its content and
		   `.join-main`'s own `flex: 1` has no free space to grow into, so the CTA undocks: re-measured at 390x844 by
		   making this declaration unconditional and rebuilding, the button's bottom edge lands at y=353.05 instead of
		   y=828 (it read 826 while this column's bottom inset was 18px). Both halves are gate arms now — see
		   tests/playwright/specs/gate/measured-join-gate.spec.ts, whose phone arms red on exactly that revert. */
		:global(.app-shell > main:has(.join-main)) {
			flex: 0 0 auto;
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
