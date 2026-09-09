<!--
	JoinLanding — the UNJOINED state of `/` (XR-PH-14, issue #834). `/` is the landing page now; there is
	no separate `/join` route (#834 Q2-A retired it), and this component is what an unjoined visitor sees
	instead of the queue.

	TWO PATHS TO ONE ROOM, side by side (never one instead of the other): a SCAN affordance and a TYPED
	six-segment code. A typed code alone is a cognitive-function test under WCAG SC 3.3.8, so the scan
	path is what makes the screen conformant — it is an accessibility requirement, not a convenience.

	THREE SHAPES:
	  • no code yet          → the six boxes + name/colour, both paths offered.
	  • arrived WITH a code  → resolve it and confirm the room IN WORDS ("Maya and Dana are here"), never
	                           the code re-presented as an input the guest cannot act on. The QR hardcodes
	                           the room, so a scanned guest types nothing.
	  • code did not resolve → fall back to the typed path WITH a stated reason, not a blank form.

	The room has no NAME (schema is {id, code, createdAt}), so "confirmed in words" is who is here, from
	GET /api/room-preview (Q1-B). `roomPresenceSentence` is the pure builder, unit-tested without a DOM.
-->
<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { SINGER_COLORS } from '@encore/shared';
	import { normalizeRoomCodeInput, CODE_LENGTH } from '@encore/shared';
	import ColourPicker from '$lib/components/ColourPicker.svelte';
	import CodeEntry from '$lib/components/CodeEntry.svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { safeNextPath } from '$lib/next-path';
	import { roomPresenceSentence, type RoomPreview } from '$lib/room-presence-sentence';

	let name = $state('');
	let color = $state<string>(SINGER_COLORS[0]);
	// The code the guest is typing into the six boxes (empty until they start). Distinct from the
	// scanned code below: this is the TYPED path.
	let typedCode = $state('');
	let submitting = $state(false);
	let error = $state('');

	// A code carried in on the URL — `/?room=CODE`, what the TV QR now encodes (#834 Q2-A moved it off
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

	// The code that actually gets sent to /api/join: the scanned one if we arrived with a valid resolved
	// code, otherwise whatever was typed. A bare landing (no code either way) joins the core's single
	// active room, exactly as a bare `/join` did.
	const joinCode = $derived(arrivedWithCode && preview ? scannedCode : typedCode);
	// Continue is enabled when there is a name AND either we have a resolved scanned room, or the six
	// typed boxes are full. Its disabled REASON is stated in text below (SC 3.3.2), never by state alone.
	const canJoin = $derived(
		name.trim().length > 0 &&
			!submitting &&
			(arrivedWithCode ? preview !== null : typedCode.length === CODE_LENGTH || typedCode.length === 0)
	);

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
			// The join happens ON `/` now (#834), and the common destination is also `/`. A client-side
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

<header class="join-head">
	<h1 class="brand">
		<Icon name="mic" /> <span class="wordmark">Encore</span>
	</h1>
	<p class="lede">
		{#if arrivedWithCode && preview}
			You're joining this room.
		{:else}
			Pick a name and color to start singing.
		{/if}
	</p>
</header>

<main class="join-main">
	{#if arrivedWithCode}
		<!-- SCANNED PATH: the room is confirmed in words, and no code input is shown (the QR typed it). -->
		{#if previewLoading}
			<p class="confirm" role="status">Finding the room…</p>
		{:else if preview}
			<p class="confirm" role="status">{confirmSentence}</p>
		{:else}
			<!-- The scanned code did not resolve. Do NOT show a blank form: state the reason and drop to
			     the typed path so the guest can correct it. -->
			<div class="err" role="alert">{previewError}</div>
			<CodeEntry bind:value={typedCode} label="Room code" oncomplete={join} />
		{/if}
	{:else}
		<!-- UNTYPED / TYPED PATH: both scan and type are present. -->
		<div class="scan-row card">
			<Icon name="search" />
			<div class="scan-copy">
				<span class="scan-head">Scan the TV's code</span>
				<span class="scan-sub">Point your camera at the QR on the big screen to join in one tap.</span>
			</div>
		</div>
		<p class="or">or type the six-character code</p>
		<CodeEntry bind:value={typedCode} label="Room code" oncomplete={join} />
	{/if}

	<label class="name-field">
		<span class="name-label">Your name</span>
		<input
			class="card name-input"
			bind:value={name}
			placeholder="e.g. Maya"
			maxlength="32"
			autocomplete="nickname"
			enterkeyhint="go"
			onkeydown={(e) => e.key === 'Enter' && join()}
		/>
	</label>

	<ColourPicker bind:value={color} label="Your color" hint="How you'll spot yourself in the queue and on the TV." />

	{#if error}
		<div class="err" role="alert">{error}</div>
	{/if}

	<div class="submit-slot">
		<!-- Disabled REASON in text, not state alone (SC 3.3.2). -->
		{#if !canJoin && !submitting}
			<p class="cta-reason" role="status" aria-live="polite">
				{#if name.trim().length === 0}
					Enter your name to continue.
				{:else if arrivedWithCode && !preview}
					Waiting for the room to load.
				{:else if typedCode.length > 0 && typedCode.length < CODE_LENGTH}
					Enter all {CODE_LENGTH} characters of the code.
				{/if}
			</p>
		{/if}
		<Button size="blockLg" shape="lg" disabled={!canJoin} onclick={join}>
			{#if submitting}Joining…{:else}Start singing <Icon name="arrow-right" />{/if}
		</Button>
	</div>
</main>

<style>
	.join-head {
		padding: 26px var(--space-4xl) var(--space-sm);
		text-align: center;
	}
	.brand {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-md);
		font-weight: 800;
		font-size: 1.6rem;
		letter-spacing: 0.5px;
		margin: 0;
		line-height: inherit;
	}
	.wordmark {
		background: var(--grad);
		-webkit-background-clip: text;
		background-clip: text;
		color: transparent;
	}
	.lede {
		color: var(--ink-dim);
		margin: var(--space-xs) 0 0;
		font-size: var(--ph-text-md);
	}
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
	.scan-row {
		display: flex;
		align-items: center;
		gap: var(--space-md);
		padding: var(--space-lg);
		background: var(--card);
	}
	.scan-copy {
		display: flex;
		flex-direction: column;
		gap: var(--space-3xs);
	}
	.scan-head {
		font-weight: 700;
		color: var(--ink);
	}
	.scan-sub {
		color: var(--ink-dim);
		font-size: var(--ph-text-md);
	}
	.or {
		text-align: center;
		color: var(--ink-dim);
		font-size: var(--ph-text-md);
		margin: 0;
	}
	.name-field {
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
	}
	.name-label {
		font-size: 0.78rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--ink-dim);
	}
	.name-input {
		padding: var(--space-xl);
		font-size: var(--ph-text-lg);
		color: var(--ink);
		background: var(--card);
	}
	.join-main {
		flex: 1;
		padding: var(--space-3xl) var(--space-4xl);
		display: flex;
		flex-direction: column;
		gap: var(--space-4xl);
	}
	.cta-reason {
		margin: 0 0 var(--space-sm);
		color: var(--ink-dim);
		font-size: var(--ph-text-md);
		text-align: center;
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
