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
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import * as Item from '$lib/components/ui/item';
	import { Button } from '$lib/components/ui/button';

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

<!--
	Wrapper + PageHeader, the shape /settings uses (#644/#749): the header spans the shell and the
	reading-width <main> carries the content. /admin has no inbound link anywhere in the app — it is
	reached by typing the URL — so its back target is the remote at `/`, the top of navigation, not a
	referring page. Without it this page was a dead end on a phone with no browser chrome.
-->
<div class="admin-page">
	<PageHeader title="Server admin" back={{ href: '/', label: 'Back to the remote' }} />

	<main class="admin">
		<p class="lede">Hard-delete a song from the library. This removes its files and cannot be undone.</p>

		{#if notice}
			<p class="notice" role="status">{notice}</p>
		{/if}

		<!--
			The confirm step used to swap the focused Delete button out of the DOM for a `{:else}` branch,
			so keyboard focus fell to <body> and a screen-reader user heard nothing — for the product's
			only irreversible action. Now the row's confirm prompt is a live region (role="alert", which
			announces on insertion) and every repeated control carries the song title in its accessible
			name, so "Delete" is no longer announced N times with nothing to tell the rows apart.
		-->
		{#if loading}
			<p class="muted" role="status">Loading library…</p>
		{:else if failed}
			<p class="muted" role="alert">
				Could not load the library.
				<Button variant="link" onclick={load}>Retry</Button>
			</p>
		{:else if songs.length === 0}
			<p class="muted">No processed songs in the library.</p>
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
		/* The cap lives on the WRAPPER, not just the content: with it only on <main>, the header spanned
		   the full app-shell while the body sat in a centred 44rem column, so on desktop the title and
		   the text it introduces had different left edges. Capping here puts both in one column, and the
		   sticky header's background then covers the whole column width as content scrolls under it. */
		max-width: 44rem;
		margin: 0 auto;
		/* Header and content share this measure via the PageHeader --page-measure cap. */
		--page-measure: 44rem;
		/* .app-shell is a centred flex column, so a cap alone takes width off the right only; width:100%
		   keeps the stretch so margin:auto re-centres the capped block. Same reason as /stats. */
		width: 100%;
	}
	.admin {
		/* Top padding trimmed from 2rem: PageHeader now supplies the space above the lede with its own
		   padding + rule, so the old value left the content floating away from its heading. */
		padding: var(--space-4xl) var(--space-4xl) 4rem;
	}
	/* The h1 rule that lived here is gone with the hand-rolled heading — PageHeader owns the h1 now, so
	   a local `h1 {}` would be an unused selector (a svelte warning, and typecheck must be 0/0). */
	.lede {
		color: var(--ink-dim);
		margin: 0 0 var(--space-2xl);
	}
	.muted {
		/* --ink-dim (7.16:1 on --bg), NOT var(--muted). `--muted` is the shadcn SURFACE alias and resolves
		   to var(--card2) #212133, which measured 1.24:1 as ink — this page's four dimmed-copy sites were
		   effectively invisible, including the "cannot be undone" warning and the load-failure message.
		   The `var(--muted, #8a8a8a)` form hid it: the fallback never fired because --muted IS defined. */
		color: var(--ink-dim);
		display: flex;
		align-items: center;
		gap: var(--space-sm);
	}
	.notice {
		background: color-mix(in srgb, var(--accent2) 12%, transparent);
		border: 1px solid color-mix(in srgb, var(--accent2) 40%, transparent);
		border-radius: var(--radius-sm);
		padding: var(--space-md) var(--space-lg);
		margin: 0 0 var(--space-2xl);
	}
	/*
	 * #913 Phase 2: `.songlist`, `.song-row`, `.meta`, `.title`, `.artist`, the bare `button` rule,
	 * `.delete`, `.confirm`, `.danger`, `.danger:disabled`, `.ghost` and `.link` are all GONE — the row
	 * is Item.Group / Item.Root / Item.Content / Item.Title / Item.Description / Item.Actions and every
	 * control is a Button variant (outline / destructive / ghost / link). That deleted 13 rules and, with
	 * them, all seven hardcoded colours this file used to carry (rgba(255,255,255,0.1),
	 * rgba(255,92,92,0.5), #ff7676, #ff5c5c, #180000, rgba(255,255,255,0.2), #6db3ff) — none of which
	 * were theme-aware — plus the bare `button { padding: 0.45rem 0.8rem }` with NO min-height that made
	 * every control on this page 35.4px, and the `.link` Retry 19px tall, under the 44px --tap floor.
	 * Button's own sizes clear that floor.
	 */
	.confirm-q {
		font-size: var(--ph-text-sm);
		color: var(--ink-dim);
	}
</style>
