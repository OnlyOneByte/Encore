<script lang="ts">
	import { SINGER_COLORS } from '@encore/shared';
	import ColourPicker from '$lib/components/ColourPicker.svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { safeNextPath } from '$lib/next-path';
	import Icon from '$lib/ui/Icon.svelte';

	let name = $state('');
	let color = $state<string>(SINGER_COLORS[0]);
	// The room code the QR encoded (`/join?room=CODE`), forwarded to /api/join so this phone joins THAT
	// party (#654). A bare /join has no code and lands in the core's single active room.
	const roomCode = $derived(page.url.searchParams.get('room')?.trim() ?? '');
	let submitting = $state(false);
	let error = $state('');

	const canJoin = $derived(name.trim().length > 0 && !submitting);

	async function join() {
		if (!canJoin) return;
		submitting = true;
		error = '';
		try {
			const res = await fetch('/api/join', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ displayName: name.trim(), color, code: roomCode || undefined })
			});
			if (!res.ok) {
				error = (await res.json()).error ?? 'Could not join';
				submitting = false;
				return;
			}
			// session cookie is set; head where the join was for — the remote unless something sent us
			// here to reach a specific screen (the settings route redirects unjoined visitors).
			await goto(safeNextPath(page.url.searchParams.get('next')));
		} catch {
			error = 'Network error — try again';
			submitting = false;
		}
	}
</script>

<header class="join-head">
	<h1 class="brand">
		<Icon name="mic" /> <span class="wordmark">Encore</span>
	</h1>
	<p class="lede">Pick a name and color to start singing.</p>
</header>

<main class="join-main">
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

	<!-- The picker itself lives in ColourPicker so the profile sheet offers exactly the same control. -->
	<ColourPicker bind:value={color} label="Your color" hint="How you'll spot yourself in the queue and on the TV." />

	{#if error}
		<div class="err" role="alert">{error}</div>
	{/if}

	<button class="btn-accent submit" class:disabled={!canJoin} disabled={!canJoin} onclick={join}>
		{#if submitting}Joining…{:else}Start singing <Icon name="arrow-right" />{/if}
	</button>
</main>

<style>
	/* Was inline on <header>; moved here so the page's spacing lives in one place, not split between
	   attributes and this block. */
	.join-head {
		padding: 26px 20px 8px;
		text-align: center;
	}
	/* The mic was 🎤 — platform-dependent art, and a tofu box with no emoji font. */
	.brand {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 10px;
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
		margin: 6px 0 0;
		font-size: 0.9rem;
	}
	/* --danger-ink (text-on-dark ink), NOT --danger (the semantic failure FILL): using the fill token
	   as text put join's error one tap away from ProfileSheet's error in a different, wrong red. */
	.err {
		color: var(--danger-ink);
		font-size: 0.9rem;
	}

	.name-field {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	/* Eyebrow label: this exact idiom (0.78rem / 0.12em / uppercase / --ink-dim) is a THIRD copy of one
	   in ProfileSheet (.field) and ColourPicker (.field-label). Kept local since this file owns only
	   this copy; flagged for a later shared primitive rather than reaching into siblings. */
	.name-label {
		font-size: 0.78rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--ink-dim);
	}
	.name-input {
		padding: 14px;
		font-size: 1.1rem;
		color: var(--ink);
		background: var(--card);
	}

	/*
	 * Join stays narrow while the shell widens: it is four short controls, so stretching the name
	 * field and colour swatches across a desktop column would make them harder to use, not easier.
	 */
	/* Declared here rather than inline: an inline style outranks every stylesheet rule, so a `flex:1`
	   attribute would make the desktop override below silently do nothing. */
	.join-main {
		flex: 1;
		padding: 18px 20px;
		display: flex;
		flex-direction: column;
		gap: 20px;
	}
	.submit {
		/* On a phone the button sits at the bottom of the viewport, where a thumb already is. */
		margin-top: auto;
		/* --radius (18px), the card/sheet radius, for this full-width primary button; the inline 16px it
		   replaced matched neither token. Padding + type keep it well over the 44px tap target. */
		padding: 16px;
		font-size: 1.1rem;
		border-radius: var(--radius);
		/* Centres the trailing mark with the label instead of letting it sit on the text baseline. */
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
	}
	/* Was an inline opacity bound to canJoin; the disabled attribute already carries the state. */
	.submit.disabled {
		opacity: 0.5;
	}
	@media (min-width: 768px) {
		/*
		 * Centre the wordmark and the form TOGETHER. Centring only the form leaves the header pinned to
		 * the top of the window with a void between them, which reads as a layout accident rather than a
		 * sign-in card. This needs the shell because the header is main's sibling, not its child.
		 */
		:global(.app-shell:has(.join-main)) {
			justify-content: center;
		}
		.join-main {
			max-width: 420px;
			margin: 0 auto;
			/* Without this the flex:1 inline style eats the shell's free space and defeats the centring. */
			flex: 0 0 auto;
			padding-bottom: 0;
		}
		.submit {
			/* Pinned to the viewport bottom, the button is stranded far below the form on a tall desktop
			   window, so it follows the fields it submits instead. */
			margin-top: 8px;
		}
	}
</style>
