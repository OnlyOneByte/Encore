<!-- THE SCREENS PAGE (proposal 34): every /tv open in this room, the TV first. The host names a screen, makes one the
	TV, or removes one. Its door is on the room scope. docs/FRONTEND.md#the-screens-page -->
<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import SettingsScope from '$lib/ui/SettingsScope.svelte';
	import Spotlight from '$lib/ui/Spotlight.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { SETTINGS_SCOPES } from '$lib/settings-scopes';
	import { screenTag, type ScreenRow } from '$lib/screens';

	let { data }: { data: { screens: ScreenRow[]; midSong: boolean; tvAddress: string } } = $props();

	const scope = { label: 'Screens', blastRadius: 'Every screen open in this room', href: '/settings/screens' };
	// Seeded from the load, so the first paint already has the list and nothing below it moves.
	let screens = $state<ScreenRow[]>(untrack(() => data.screens));
	let midSong = $state(untrack(() => data.midSong));
	let renaming = $state<string | null>(null);
	let draft = $state('');
	let note = $state('');
	/** The screen an action is in flight for: its buttons wait, so a double tap sends one request. */
	let busy = $state<string | null>(null);

	// Polled rather than pushed: a socket never carries the host (docs/SERVER.md#the-host-key), and drift is a few
	// seconds old at best anyway.
	const POLL_MS = 2_000;
	async function refresh() {
		const r = await fetch('/api/screens').catch(() => null);
		if (!r?.ok) return;
		const body = (await r.json()) as { screens: ScreenRow[]; midSong: boolean };
		screens = body.screens;
		midSong = body.midSong;
	}
	onMount(() => {
		const timer = setInterval(() => document.visibilityState === 'visible' && void refresh(), POLL_MS);
		return () => clearInterval(timer);
	});

	async function act(action: 'rename' | 'remove' | 'tv', screen: ScreenRow, name?: string) {
		if (busy) return;
		busy = screen.id;
		note = '';
		const r = await fetch('/api/screens', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action, id: screen.id, name })
		}).catch(() => null);
		// A remove that finds the screen gone has still done what was asked.
		const done = r?.ok || (action === 'remove' && r?.status === 404);
		if (!done) {
			const reason = r ? ((await r.json().catch(() => ({}))) as { reason?: string }).reason : undefined;
			note =
				reason === 'mid-song'
					? `A song is on. To make ${screen.name} the TV now, tap Make this the TV on that screen.`
					: `That didn't work. ${screen.name} may have closed.`;
		} else if (action === 'remove') note = `${screen.name} was removed. Open the TV address on it to bring it back.`;
		if (action === 'rename') renaming = null;
		await refresh();
		busy = null;
	}
	function startRename(s: ScreenRow) {
		renaming = s.id;
		draft = s.name;
	}
</script>

{#snippet actions(s: ScreenRow)}
	{#if renaming === s.id}
		<form
			class="rename"
			onsubmit={(e) => {
				e.preventDefault();
				void act('rename', s, draft);
			}}
		>
			<Input
				aria-label="Name for {s.name}"
				bind:value={draft}
				maxlength={32}
				onkeydown={(e: KeyboardEvent) => e.key === 'Escape' && (renaming = null)}
			/>
			<Button type="submit" size="tap" disabled={!draft.trim() || busy === s.id}>Save</Button>
			<Button type="button" variant="ghost" size="tap" onclick={() => (renaming = null)}>Cancel</Button>
		</form>
	{:else}
		<div class="links">
			{#if !s.isTv && s.canBeTv}
				<Button variant="ghost" size="tap" disabled={midSong || busy === s.id} onclick={() => act('tv', s)}>
					Make this the TV
				</Button>
			{/if}
			<Button variant="ghost" size="tap" disabled={busy === s.id} onclick={() => startRename(s)}>Rename</Button>
			{#if !s.isTv}
				<Button variant="ghost" size="tap" disabled={busy === s.id} onclick={() => act('remove', s)}>Remove</Button>
			{/if}
		</div>
	{/if}
{/snippet}

<SettingsScope scope={scope} back={{ href: SETTINGS_SCOPES.room.href, label: 'Back to the party settings' }}>
	<p class="sub">The TV plays the sound. The others follow it, quietly.</p>

	{#each screens as s (s.id)}
		{#if s.isNew}
			<Spotlight title={s.name} meta="Just opened">{@render actions(s)}</Spotlight>
		{:else}
			<section class="row" aria-label={s.name}>
				<div class="top">
					<h2 class="name">{s.name}</h2>
					<span class="tag">{screenTag(s)}</span>
				</div>
				{@render actions(s)}
			</section>
		{/if}
	{/each}

	{#if !screens.length}
		<p class="empty">No screen is open. Open the TV address below on one.</p>
	{/if}
	{#if midSong && screens.some((s) => !s.isTv && s.canBeTv)}
		<p class="hint">While a song is on, a screen becomes the TV only when someone taps it there.</p>
	{/if}
	<!-- In the DOM while empty, so a screen reader is already listening when its first message arrives. -->
	<p class="note" role="status">{note}</p>
	<p class="add">To add a screen, open <b>{data.tvAddress}</b> on it.</p>
</SettingsScope>

<style>
	.sub,
	.hint,
	.add,
	.empty {
		color: var(--role-ink-dim);
		font-size: var(--type-body);
	}
	.add b {
		color: var(--role-ink);
	}
	.row {
		padding: var(--step-12) 0;
		border-top: 1px solid var(--role-rule);
	}
	.top {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: var(--step-8);
	}
	.name {
		font-size: var(--type-title);
		font-weight: 700;
		overflow-wrap: anywhere;
	}
	.tag {
		color: var(--role-ink-dim);
		font-size: var(--type-meta);
		white-space: nowrap;
	}
	.links,
	.rename {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--step-4);
		margin-top: var(--step-4);
	}
	/* Less side padding than `size="tap"`, so three actions fit one line at 390, inside the Spotlight too. The height
	   stays 44 px, and every label is wider than 44 px. */
	.links :global(button) {
		padding-inline: var(--step-4);
	}
	.rename :global(input) {
		flex: 1 1 10rem;
		min-width: 0;
	}
	.note:empty {
		margin: 0;
	}
</style>
