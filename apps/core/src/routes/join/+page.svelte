<script lang="ts">
	import { SINGER_COLORS } from '@encore/shared';
	import { goto } from '$app/navigation';

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
			// session cookie is set; head to the phone remote
			await goto('/');
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

<main style="flex:1;padding:18px 20px;display:flex;flex-direction:column;gap:20px;">
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
		<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;">
			{#each SINGER_COLORS as c}
				<button
					aria-label={`color ${c}`}
					onclick={() => (color = c)}
					style="height:54px;border-radius:14px;border:3px solid {color === c ? 'var(--ink)' : 'transparent'};background:{c};cursor:pointer;transition:transform .12s;"
				></button>
			{/each}
		</div>
	</div>

	{#if error}
		<div style="color:var(--accent2);font-size:.9rem;">{error}</div>
	{/if}

	<button
		class="btn-accent"
		disabled={!canJoin}
		onclick={join}
		style="margin-top:auto;padding:16px;font-size:1.1rem;border-radius:16px;opacity:{canJoin ? 1 : 0.5};"
	>
		{submitting ? 'Joining…' : 'Start singing →'}
	</button>
</main>
