<script lang="ts">
	import { SINGER_COLORS } from '@encore/shared';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { safeNextPath } from '$lib/next-path';

	/** Arrow keys move within the group, which is what a radiogroup is expected to do. */
	function onSwatchKey(e: KeyboardEvent) {
		const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'];
		if (!keys.includes(e.key)) return;
		e.preventDefault();
		const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
		const i = (SINGER_COLORS as readonly string[]).indexOf(color);
		const next = (i + step + SINGER_COLORS.length) % SINGER_COLORS.length;
		color = SINGER_COLORS[next]!;
		(e.currentTarget as HTMLElement)
			?.querySelector<HTMLElement>(`[data-swatch="${next}"]`)
			?.focus();
	}

	/** A name, because "color #7c5cff" tells a screen-reader user nothing they can act on. */
	function colorName(hex: string): string {
		const names = ['violet', 'pink', 'green', 'amber', 'blue', 'coral', 'purple', 'mint'];
		return `${names[(SINGER_COLORS as readonly string[]).indexOf(hex)] ?? 'color'} swatch`;
	}

	let name = $state('');
	let color = $state<string>(SINGER_COLORS[0]);
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
				body: JSON.stringify({ displayName: name.trim(), color })
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

<header style="padding:26px 20px 8px;text-align:center;">
	<div style="font-weight:800;font-size:1.6rem;letter-spacing:.5px;">
		🎤 <span style="background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent;">Encore</span>
	</div>
	<p style="color:var(--ink-dim);margin:6px 0 0;font-size:.9rem;">Pick a name and color to start singing.</p>
</header>

<main class="join-main" style="padding:18px 20px;display:flex;flex-direction:column;gap:20px;">
	<label style="display:flex;flex-direction:column;gap:8px;">
		<span style="font-size:.78rem;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-dim);">Your name</span>
		<input
			class="card"
			bind:value={name}
			placeholder="e.g. Maya"
			maxlength="32"
			style="padding:14px;font-size:1.1rem;color:var(--ink);background:var(--card);outline:none;"
			onkeydown={(e) => e.key === 'Enter' && join()}
		/>
	</label>

	<div style="display:flex;flex-direction:column;gap:10px;">
		<span style="font-size:.78rem;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-dim);">Your color</span>
		<div class="swatches" role="radiogroup" aria-label="Your color" tabindex="-1" onkeydown={onSwatchKey}>
			{#each SINGER_COLORS as c, i}
				<button
					role="radio"
					aria-checked={color === c}
					aria-label={colorName(c)}
					tabindex={color === c ? 0 : -1}
					data-swatch={i}
					onclick={() => (color = c)}
					class="swatch"
					class:sel={color === c}
					style="background:{c};"
				>
					<!-- A tick, not just the ring: selection conveyed by colour alone is invisible to a
					     colour-blind guest choosing between the two violets or the two pinks. -->
					{#if color === c}<span class="tick" aria-hidden="true">✓</span>{/if}
				</button>
			{/each}
		</div>
	</div>

	{#if error}
		<div class="err" role="alert">{error}</div>
	{/if}

	<button
		class="btn-accent submit"
		disabled={!canJoin}
		onclick={join}
		style="padding:16px;font-size:1.1rem;border-radius:16px;opacity:{canJoin ? 1 : 0.5};"
	>
		{submitting ? 'Joining…' : 'Start singing →'}
	</button>
</main>

<style>
	.swatches { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
	.swatch {
		height: 54px; border-radius: var(--radius-sm); border: 3px solid transparent;
		cursor: pointer; transition: transform 0.12s;
		display: grid; place-items: center;
	}
	.swatch.sel { border-color: var(--ink); }
	.tick { color: #0b0b12; font-size: 1.3rem; font-weight: 900; text-shadow: 0 1px 2px rgba(255, 255, 255, 0.5); }
	.err { color: var(--danger); font-size: 0.9rem; }

	/*
	 * Join stays narrow while the shell widens: it is four short controls, so stretching the name
	 * field and colour swatches across a desktop column would make them harder to use, not easier.
	 */
	/* Declared here rather than inline: an inline style outranks every stylesheet rule, so a `flex:1`
	   attribute would make the desktop override below silently do nothing. */
	.join-main {
		flex: 1;
	}
	.submit {
		/* On a phone the button sits at the bottom of the viewport, where a thumb already is. */
		margin-top: auto;
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
