<!-- Delete is irreversible and reclaims bytes: two-step, and on this operator surface. docs/FRONTEND.md#admin -->
<script lang="ts">
	import { onMount } from 'svelte';
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import * as Item from '$lib/components/ui/item';
	import * as Alert from '$lib/components/ui/alert';
	import * as Empty from '$lib/components/ui/empty';
	import { Button } from '$lib/components/ui/button';

	interface LibrarySong {
		id: string;
		title: string;
		artist?: string;
	}

	let songs = $state<LibrarySong[]>([]);
	let loading = $state(true);
	let failed = $state(false);
	let confirmingId = $state<string | null>(null);
	let deletingId = $state<string | null>(null);
	let notice = $state<string | null>(null);

	async function load() {
		loading = true;
		failed = false;
		try {
			const res = await fetch('/api/library');
			if (!res.ok) throw new Error('load failed');
			const data = await res.json();
			songs = (data.library ?? []).map((m: LibrarySong) => ({ id: m.id, title: m.title, artist: m.artist }));
		} catch {
			failed = true;
		} finally {
			loading = false;
		}
	}

	onMount(load);

	function askDelete(id: string) {
		notice = null;
		confirmingId = id;
	}

	function cancelDelete() {
		confirmingId = null;
	}

	async function confirmDelete(song: LibrarySong) {
		deletingId = song.id;
		try {
			const res = await fetch('/api/delete-media', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ mediaId: song.id })
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				notice = err.error ? `Could not delete: ${err.error}` : 'Could not delete that song.';
				return;
			}
			const data = await res.json();
			// Drop it locally at once; the broadcast reconciles every other surface.
			songs = songs.filter((s) => s.id !== song.id);
			notice = data.wasPlaying ? `Deleted "${song.title}" and skipped to the next song.` : `Deleted "${song.title}".`;
		} catch {
			notice = 'Could not delete that song.';
		} finally {
			deletingId = null;
			confirmingId = null;
		}
	}
</script>

<svelte:head><title>Admin · Encore</title></svelte:head>

<!-- No inbound link anywhere in the app, so back goes to the remote at `/`, not to a referrer. -->
<div class="admin-page">
	<PageHeader title="Server admin" back={{ href: '/', label: 'Back to the remote' }} />

	<main class="admin">
		<p class="lede">Hard-delete a song from the library. This removes its files and cannot be undone.</p>

		{#if notice}
			<!-- `role="status"`, and `accent` not `destructive`: a completed action must not interrupt or alarm. -->
			<Alert.Root variant="accent" role="status"><Alert.Title>{notice}</Alert.Title></Alert.Root>
		{/if}

		<!-- Arming replaces the focused button, so the prompt is role="alert" and each control names its song. -->
		{#if loading}
			<p class="muted" role="status">Loading library…</p>
		{:else if failed}
			<!-- role="alert" sits on Empty.Root because it renders a bare div with no role of its own. -->
			<Empty.Root role="alert">
				<Empty.Header>
					<Empty.Description>Could not load the library.</Empty.Description>
				</Empty.Header>
				<Empty.Content>
					<Button variant="link" onclick={load}>Retry</Button>
				</Empty.Content>
			</Empty.Root>
		{:else if songs.length === 0}
			<Empty.Root>
				<Empty.Header>
					<Empty.Description>No processed songs in the library.</Empty.Description>
				</Empty.Header>
			</Empty.Root>
		{:else}
			<Item.Group>
				{#each songs as song (song.id)}
					<Item.Root variant="outline">
						<Item.Content>
							<Item.Title>{song.title}</Item.Title>
							{#if song.artist}<Item.Description>{song.artist}</Item.Description>{/if}
						</Item.Content>
						<Item.Actions>
							{#if confirmingId === song.id}
								<span class="confirm-q" role="alert">Delete for good?</span>
								<Button
									data-act="confirm-delete"
									variant="destructive"
									disabled={deletingId === song.id}
									aria-label={`Confirm delete ${song.title}`}
									onclick={() => confirmDelete(song)}>{deletingId === song.id ? 'Deleting…' : 'Yes, delete'}</Button
								>
								<Button
									variant="ghost"
									disabled={deletingId === song.id}
									aria-label={`Cancel deleting ${song.title}`}
									onclick={cancelDelete}>Cancel</Button
								>
							{:else}
								<Button
									data-act="arm-delete"
									variant="outline"
									aria-label={`Delete ${song.title}`}
									onclick={() => askDelete(song.id)}>Delete</Button
								>
							{/if}
						</Item.Actions>
					</Item.Root>
				{/each}
			</Item.Group>
		{/if}
	</main>
</div>

<style>
	.admin-page {
		/* Cap the WRAPPER so header and content share one left edge, and keep width:100% — .app-shell is
		   a centred flex column, where a cap alone shrinks from the right instead of re-centring. */
		max-width: var(--measure-grid);
		margin: 0 auto;
		--page-measure: var(--measure-grid);
		width: 100%;
	}
	.admin {
		padding: var(--space-4xl) var(--space-4xl) 4rem;
	}
	.lede {
		color: var(--ink-dim);
		margin: 0 0 var(--space-2xl);
	}
	.muted {
		/* Dimmed INK is --ink-dim (7.16:1 on --bg). `--muted` is the shadcn SURFACE alias (--card2) and
		   measures 1.24:1 as text — invisible, and `var(--muted, …)` never falls back because it is set. */
		color: var(--ink-dim);
		display: flex;
		align-items: center;
		gap: var(--space-sm);
	}
	.confirm-q {
		font-size: var(--ph-text-sm);
		color: var(--ink-dim);
	}
</style>
