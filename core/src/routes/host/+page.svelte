<!-- The host's door. The boot link opens here with the key in the fragment, which never reaches a server log or a
	Referer; this page swaps it for an `encore_host` session and moves on. docs/SERVER.md#the-host-key -->
<script lang="ts">
	import { onMount } from 'svelte';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Card from '$lib/components/ui/card';
	import * as Field from '$lib/components/ui/field';
	import { safeNextPath } from '$lib/next-path';

	let { data }: { data: { host: boolean } } = $props();

	const next = $derived(safeNextPath(page.url.searchParams.get('next'), '/settings'));
	let key = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	async function unlock(presented: string): Promise<void> {
		busy = true;
		error = null;
		const res = await fetch('/api/host', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ key: presented.trim() })
		}).catch(() => null);
		busy = false;
		if (res?.ok) return goto(next, { replaceState: true, invalidateAll: true });
		error = res
			? 'That key did not work. Encore makes a new link each time it starts, so use the newest one.'
			: 'Could not reach Encore. Check the Wi-Fi and try again.';
	}

	async function signOutAll(): Promise<void> {
		busy = true;
		await fetch('/api/host', { method: 'DELETE' }).catch(() => null);
		busy = false;
		await invalidateAll();
	}

	onMount(() => {
		const fromLink = new URLSearchParams(location.hash.slice(1)).get('k');
		if (!fromLink) return;
		// Off the address bar and out of history before anything else, so the key is not left on screen or in a share.
		history.replaceState(history.state, '', location.pathname + location.search);
		void unlock(fromLink);
	});
</script>

<svelte:head><title>Host · Encore</title></svelte:head>

<PageHeader title="Host" icon="gear" back={{ href: '/', label: 'Back to the remote' }} />

<main>
	{#if data.host}
		<Card.Root id="host-on">
			<Card.Header>
				<Card.Title role="heading" aria-level={2}>This phone is the host</Card.Title>
				<Card.Description>It can change settings, see the metrics and delete songs for 30 days.</Card.Description>
			</Card.Header>
			<Card.Content>
				<Button size="block" href={next}>Open settings</Button>
				<Button variant="outline" size="block" disabled={busy} onclick={signOutAll}>Sign out every host phone</Button>
			</Card.Content>
		</Card.Root>
	{:else}
		<Card.Root id="host-off" class="host-off">
			<Card.Header>
				<Card.Title role="heading" aria-level={2}>Only the host can open this</Card.Title>
				<Card.Description>
					Host: open the link Encore showed when it started, on this phone. With Docker, it is in
					<code>docker compose logs core</code>.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<form
					onsubmit={(e) => {
						e.preventDefault();
						void unlock(key);
					}}
				>
					<Field.Label for="host-key">Or paste the host key</Field.Label>
					<Input id="host-key" type="password" autocomplete="off" bind:value={key} />
					{#if error}<p class="err" role="alert">{error}</p>{/if}
					<Button type="submit" size="block" disabled={busy || !key.trim()}>
						{#if busy}Unlocking…{:else}Unlock{/if}
					</Button>
				</form>
			</Card.Content>
		</Card.Root>
	{/if}
</main>

<style>
	/* `width`, so the column and not the copy sets the card's width and the two states line up. */
	main {
		box-sizing: border-box;
		width: 100%;
		max-width: var(--measure-prose);
		margin: 0 auto;
		padding: var(--space-md) var(--space-2xl) calc(var(--dock-h, 0px) + 28px);
	}
	main :global([data-slot='card-content']),
	form {
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
	}
	main :global(.host-off) {
		box-shadow: inset 0 0 0 2px var(--accent);
	}
	code {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		overflow-wrap: anywhere;
	}
	.err {
		margin: 0;
		font-size: var(--ph-text-xs);
		color: var(--danger-ink);
	}
</style>
