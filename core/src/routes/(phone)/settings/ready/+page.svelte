<!-- READY FOR TONIGHT (proposal 39): six rows the host checks before guests arrive. Each is green, or red with one
	line saying what to do. Host only; its door is the first row of the room scope. docs/FRONTEND.md#ready-for-tonight -->
<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import SettingsScope from '$lib/ui/SettingsScope.svelte';
	import { Button } from '$lib/components/ui/button';
	import { SETTINGS_SCOPES } from '$lib/settings-scopes';
	import { READY_TIMEOUT_MS, type ReadyRow } from '$lib/ready';

	let { data }: { data: { rows: ReadyRow[]; tvAddress: string } } = $props();

	const scope = { label: 'Ready for tonight', blastRadius: 'This box and its TV', href: '/settings/ready' };
	// Seeded from the load, so the first paint already has every row and nothing below it moves.
	let rows = $state<ReadyRow[]>(untrack(() => data.rows));
	let checking = $state(false);
	let note = $state('');
	let showTvLink = $state(false);

	const POLL_MS = 400;
	async function read(): Promise<boolean> {
		const r = await fetch('/api/host/ready').catch(() => null);
		if (!r?.ok) return false;
		rows = ((await r.json()) as { rows: ReadyRow[] }).rows;
		return true;
	}
	/** Reads until no row is waiting, or a little past the checks' own timeout, so the page never hangs. */
	async function settle() {
		const until = Date.now() + READY_TIMEOUT_MS + 1_000;
		while (Date.now() < until) {
			await new Promise((r) => setTimeout(r, POLL_MS));
			if ((await read()) && !rows.some((row) => row.state === 'wait')) return;
		}
	}
	async function checkAgain() {
		if (checking) return;
		checking = true;
		note = '';
		// A 429 means a check ran a moment ago: its answers are still worth reading.
		await fetch('/api/host/ready/recheck', { method: 'POST' }).catch(() => null);
		await settle();
		checking = false;
	}
	async function testSound() {
		note = '';
		const r = await fetch('/api/host/ready/chime', { method: 'POST' }).catch(() => null);
		if (!r?.ok) {
			const reason = r ? ((await r.json().catch(() => ({}))) as { reason?: string }).reason : undefined;
			note =
				reason === 'mid-song'
					? 'A song is on. Play the test sound between songs.'
					: reason === 'no-tv'
						? 'No TV is open to play it.'
						: "That didn't reach the TV. Try again.";
			return;
		}
		note = 'Playing a chime on the TV.';
		await settle();
		// The Sound row now says how it went, so the note has nothing left to say.
		note = '';
	}
	onMount(() => void checkAgain());
</script>

<SettingsScope scope={scope} back={{ href: SETTINGS_SCOPES.room.href, label: 'Back to the party settings' }}>
	<p class="sub">Check the box before guests arrive. Fix anything red, then check again.</p>
	<ul class="rows" aria-busy={checking}>
		{#each rows as row (row.id)}
			<li class="row" data-row={row.id} data-state={row.state}>
				<span class="dot" aria-hidden="true"></span>
				<div class="body">
					<h2 class="label">{row.label}</h2>
					<p class="status">{row.status}</p>
					<!-- The TV link, once shown, IS the fix, so the general line steps aside. -->
					{#if row.fix && row.state !== 'green' && !(row.id === 'tv' && showTvLink)}<p class="fix">{row.fix}</p>{/if}
					{#if row.action === 'test-sound'}
						<Button variant="outline" size="tap" onclick={testSound}>Play a test sound on the TV</Button>
					{:else if row.action === 'tv-link' && row.id === 'tv'}
						{#if showTvLink}
							<p class="fix">Open <b>{data.tvAddress}</b> on the big screen.</p>
						{:else}
							<Button variant="outline" size="tap" onclick={() => (showTvLink = true)}>Show the TV link</Button>
						{/if}
					{:else if row.action === 'library'}
						<Button variant="outline" size="tap" href="/library">Open Library</Button>
					{/if}
					{#if row.detail && row.state === 'red'}
						<details class="detail">
							<summary>Details</summary>
							<code>{row.detail}</code>
						</details>
					{/if}
				</div>
			</li>
		{/each}
	</ul>
	<p class="note" role="status">{note}</p>
	<Button size="block" disabled={checking} onclick={checkAgain}>{checking ? 'Checking…' : 'Check again'}</Button>
</SettingsScope>

<style>
	.sub {
		color: var(--role-ink-dim);
		font-size: var(--type-body);
	}
	.rows {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.row {
		display: flex;
		gap: var(--step-12);
		padding: var(--step-12) 0;
		border-top: 1px solid var(--role-rule);
	}
	.dot {
		flex: none;
		width: 12px;
		height: 12px;
		margin-top: 0.4em;
		border-radius: 50%;
		border: 2px solid var(--role-ink-dim);
	}
	[data-state='green'] .dot {
		background: var(--ok);
		border-color: var(--ok);
	}
	[data-state='amber'] .dot {
		background: var(--warn);
		border-color: var(--warn);
	}
	[data-state='red'] .dot {
		background: var(--danger);
		border-color: var(--danger);
	}
	.body {
		min-width: 0;
		display: grid;
		gap: var(--step-4);
		justify-items: start;
	}
	.body p,
	.label {
		margin: 0;
	}
	.label {
		font-size: var(--type-title);
		font-weight: 700;
	}
	.status {
		font-size: var(--type-body);
		overflow-wrap: anywhere;
	}
	.fix {
		color: var(--role-ink-dim);
		font-size: var(--type-body);
		overflow-wrap: anywhere;
	}
	.fix b {
		color: var(--role-ink);
	}
	[data-state='red'] .fix {
		color: var(--danger-ink);
	}
	.detail {
		font-size: var(--type-meta);
		color: var(--role-ink-dim);
	}
	.detail code {
		overflow-wrap: anywhere;
	}
	.note:empty {
		margin: 0;
	}
</style>
