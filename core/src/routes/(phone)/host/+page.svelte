<!-- The host's door. The boot link opens here with the key in the fragment, which never reaches a server log or a
	Referer; this page swaps it for an `encore_host` session and moves on. docs/SERVER.md#the-host-key -->
<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Card from '$lib/components/ui/card';
	import * as Field from '$lib/components/ui/field';
	import { safeNextPath } from '$lib/next-path';
	import { forgetHost } from '$lib/stores/host';

	interface KeptPerson {
		id: string;
		displayName: string;
		color: string;
		phones: number;
	}
	let { data }: { data: { host: boolean; people: KeptPerson[] } } = $props();

	/* Reset phones: the row goes at once and comes back with one line if the server refuses (tenet 1). */
	let people = $state<KeptPerson[]>(untrack(() => data.people));
	let resetting = $state<KeptPerson | null>(null);
	let resetError = $state('');

	async function reset(person: KeptPerson): Promise<void> {
		resetting = null;
		resetError = '';
		const before = people;
		people = people.filter((p) => p.id !== person.id);
		const res = await fetch('/api/host/people/reset', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ personId: person.id })
		}).catch(() => null);
		if (res?.ok) return;
		people = before;
		resetError = `Could not reset ${person.displayName}'s phones — try again.`;
	}

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
		forgetHost();
		if (res?.ok) return goto(next, { replaceState: true, invalidateAll: true });
		error = res
			? 'That key did not work. Encore makes a new link each time it starts, so use the newest one.'
			: 'Could not reach Encore. Check the Wi-Fi and try again.';
	}

	async function signOutAll(): Promise<void> {
		busy = true;
		await fetch('/api/host', { method: 'DELETE' }).catch(() => null);
		busy = false;
		forgetHost();
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

		{#if people.length || resetError}
			<Card.Root id="kept-people">
				<Card.Header>
					<Card.Title role="heading" aria-level={2}>Kept phones</Card.Title>
					<Card.Description>
						If someone lost their phone, or can't get back in as themselves, reset their phones. Every phone kept as
						them is signed out and Encore forgets them, past nights included. They can tap Keep me again after their
						next song.
					</Card.Description>
				</Card.Header>
				<Card.Content>
					<ul>
						{#each people as person (person.id)}
							<li>
								<span class="who">
									<span class="dot" style:background={person.color} aria-hidden="true"></span>
									<span class="name">{person.displayName}</span>
									<span class="phones">{person.phones === 1 ? '1 phone' : `${person.phones} phones`}</span>
								</span>
								<Button variant="outline" size="tap" onclick={() => (resetting = person)}>
									Reset<span class="sr-only"> {person.displayName}'s</span> phones
								</Button>
							</li>
						{/each}
					</ul>
					{#if resetError}<p class="err" role="alert">{resetError}</p>{/if}
				</Card.Content>
			</Card.Root>
		{/if}

		<AlertDialog.Root open={resetting !== null} onOpenChange={(open) => !open && (resetting = null)}>
			<AlertDialog.Content>
				<AlertDialog.Header>
					<AlertDialog.Title>Reset {resetting?.displayName}'s phones?</AlertDialog.Title>
					<AlertDialog.Description>
						Every phone kept as {resetting?.displayName} is signed out, and Encore forgets their name, colour and past nights.
						They can tap Keep me again after their next song.
					</AlertDialog.Description>
				</AlertDialog.Header>
				<AlertDialog.Footer>
					<AlertDialog.Cancel variant="ghost">Don't reset</AlertDialog.Cancel>
					<AlertDialog.Action variant="destructive" onclick={() => resetting && reset(resetting)}>
						Yes, reset
					</AlertDialog.Action>
				</AlertDialog.Footer>
			</AlertDialog.Content>
		</AlertDialog.Root>
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
		display: flex;
		flex-direction: column;
		gap: var(--space-lg);
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
	ul {
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	/* Wraps the button under the name at 320 rather than breaking the name. */
	li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-sm);
	}
	.who {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-xs) var(--space-sm);
		min-width: 0;
	}
	/* A 32-character name with no space still fits 320. */
	.name {
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.dot {
		flex: none;
		width: 12px;
		height: 12px;
		border-radius: var(--radius-pill);
	}
	.phones {
		color: var(--ink-dim);
		font-size: var(--ph-text-xs);
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	.err {
		margin: 0;
		font-size: var(--ph-text-xs);
		color: var(--danger-ink);
	}
</style>
