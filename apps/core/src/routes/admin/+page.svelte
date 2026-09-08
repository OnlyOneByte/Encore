<!--
  /admin — the server-level admin dashboard (issue #639). Its first action: HARD-DELETE a song from
  the library entirely, reclaiming its bytes. This is the first IRREVERSIBLE action in the product, so
  every delete goes through a two-step confirm (click Delete -> confirm the named song -> it is gone).

  Deliberately NOT on SongRow.svelte (a phone control any guest fat-fingers): a destructive, byte-
  reclaiming delete lives on its own admin surface, reached on purpose. No auth gate on the PAGE yet —
  every guest is host today (owner ruling #2) — but the endpoint it calls is the seam a host gate slots
  into later, and this page will sit behind the same gate then.
-->
<script lang="ts">
	import { onMount } from 'svelte';

	interface LibrarySong {
		id: string;
		title: string;
		artist?: string;
	}

	let songs = $state<LibrarySong[]>([]);
	let loading = $state(true);
	let failed = $state(false);
	// The id awaiting its SECOND click — the confirm step. null = nothing pending.
	let confirmingId = $state<string | null>(null);
	// The id whose delete request is in flight, so its button disables and cannot double-fire.
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
			// Drop it from the list immediately — the broadcast will reconcile every other surface.
			songs = songs.filter((s) => s.id !== song.id);
			notice = data.wasPlaying
				? `Deleted "${song.title}" and skipped to the next song.`
				: `Deleted "${song.title}".`;
		} catch {
			notice = 'Could not delete that song.';
		} finally {
			deletingId = null;
			confirmingId = null;
		}
	}
</script>

<svelte:head><title>Admin · Encore</title></svelte:head>

<main class="admin">
	<h1>Server admin</h1>
	<p class="lede">Hard-delete a song from the library. This removes its files and cannot be undone.</p>

	{#if notice}
		<p class="notice" role="status">{notice}</p>
	{/if}

	{#if loading}
		<p class="muted">Loading library…</p>
	{:else if failed}
		<p class="muted">Could not load the library. <button class="link" onclick={load}>Retry</button></p>
	{:else if songs.length === 0}
		<p class="muted">No cooked songs in the library.</p>
	{:else}
		<ul class="songlist">
			{#each songs as song (song.id)}
				<li class="song-row">
					<span class="meta">
						<span class="title">{song.title}</span>
						{#if song.artist}<span class="artist">{song.artist}</span>{/if}
					</span>
					{#if confirmingId === song.id}
						<span class="confirm">
							<span class="confirm-q">Delete for good?</span>
							<button
								class="danger"
								disabled={deletingId === song.id}
								onclick={() => confirmDelete(song)}
							>{deletingId === song.id ? "Deleting…" : "Yes, delete"}</button>
							<button class="ghost" disabled={deletingId === song.id} onclick={cancelDelete}>Cancel</button>
						</span>
					{:else}
						<button class="delete" onclick={() => askDelete(song.id)}>Delete</button>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</main>

<style>
	.admin {
		max-width: 44rem;
		margin: 0 auto;
		padding: 2rem 1.25rem 4rem;
	}
	h1 {
		font-size: 1.5rem;
		margin: 0 0 0.25rem;
	}
	.lede {
		color: var(--muted, #8a8a8a);
		margin: 0 0 1.5rem;
	}
	.muted {
		color: var(--muted, #8a8a8a);
	}
	.notice {
		background: color-mix(in srgb, var(--accent2) 12%, transparent);
		border: 1px solid color-mix(in srgb, var(--accent2) 40%, transparent);
		border-radius: 0.5rem;
		padding: 0.6rem 0.9rem;
		margin: 0 0 1rem;
	}
	.songlist {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.song-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.75rem 1rem;
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 0.6rem;
	}
	.meta {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.title {
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.artist {
		color: var(--muted, #8a8a8a);
		font-size: 0.85rem;
	}
	button {
		font: inherit;
		cursor: pointer;
		border-radius: 0.5rem;
		border: 1px solid transparent;
		padding: 0.45rem 0.8rem;
	}
	.delete {
		background: transparent;
		border-color: rgba(255, 92, 92, 0.5);
		color: #ff7676;
	}
	.confirm {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.confirm-q {
		font-size: 0.85rem;
		color: var(--muted, #8a8a8a);
	}
	.danger {
		background: #ff5c5c;
		color: #180000;
		font-weight: 600;
	}
	.danger:disabled {
		opacity: 0.6;
		cursor: default;
	}
	.ghost {
		background: transparent;
		border-color: rgba(255, 255, 255, 0.2);
		color: inherit;
	}
	.link {
		background: none;
		border: none;
		color: #6db3ff;
		text-decoration: underline;
		padding: 0;
	}
</style>
