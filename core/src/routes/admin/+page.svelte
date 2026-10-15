<!-- Delete is irreversible and reclaims bytes: two-step, and on this operator surface. docs/FRONTEND.md#admin -->
<script lang="ts">
	import { onMount, tick } from 'svelte';
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
			const body = await res.json();
			// Narrowed to the three fields this screen renders, so a catalog field cannot leak onto an operator surface.
			songs = (body.library ?? []).map((media: LibrarySong) => ({
				id: media.id,
				title: media.title,
				artist: media.artist
			}));
		} catch {
			failed = true;
		} finally {
			loading = false;
		}
	}

	onMount(load);

	/* FOCUS IS PLACED, NOT LEFT TO FALL. Arming unmounts the focused Delete button and mounts three different nodes, so
	   focus dropped to `<body>` — on an unrecoverable action, meaning a keyboard operator pressed Enter and then had to
	   Tab from the top of the document to reach "Yes, delete". Cancelling did the same in reverse. `tick()` first,
	   because the node to focus does not exist until the keyed block has been patched. */
	/** The armed row's confirm button, so focus can be PLACED on it rather than left to fall to `<body>`. */
	let confirmEl = $state<HTMLElement | null>(null);
	/** Every row's own Delete button, by song id. A single captured node does NOT work here: arming DESTROYS the button
	    that was clicked, so `.focus()` on the captured reference ran against a detached element and focus fell to
	    `<body>`. The `{#each}` is keyed on `song.id`, so each entry nulls on unmount and re-populates with the FRESH
	    node when the row disarms — which is why the map must be read after the patch, never captured before it.
	    Bound through a GETTER/SETTER pair rather than `bind:ref={armRefs[song.id]}`: a plain member bind reads
	    `undefined` on the first render and `Button` declares `ref = $bindable(null)`, so Svelte threw
	    props_invalid_value and the page never got past "Loading library…". Measured. */
	let armRefs: Record<string, HTMLElement | null> = $state({});
	/** The live-region wrapper, as the focus target of last resort: deleting the only song leaves no row to return to. */
	let noticeEl = $state<HTMLElement | null>(null);

	async function askDelete(id: string) {
		notice = null;
		confirmingId = id;
		await tick();
		confirmEl?.focus();
	}

	async function cancelDelete() {
		const id = confirmingId;
		confirmingId = null;
		await tick();
		// Back to the control that opened the prompt — the row's own Delete button, freshly re-mounted by the line above.
		if (id) armRefs[id]?.focus();
	}

	async function confirmDelete(song: LibrarySong) {
		deletingId = song.id;
		// The row's place in the list, read BEFORE the delete: on a long library, dropping the operator at the top
		// costs them their position.
		const index = songs.findIndex((s) => s.id === song.id);
		let deleted = false;
		// NO early `return` and no `finally`: a `return` inside the try skips everything after the block, which is where
		// focus gets placed — measured, as focus falling to `<body>` on the failure path only.
		try {
			const res = await fetch('/api/delete-media', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ mediaId: song.id })
			});
			if (res.ok) {
				const result = await res.json();
				// Drop it locally at once; the broadcast reconciles every other surface.
				songs = songs.filter((s) => s.id !== song.id);
				deleted = true;
				notice = result.wasPlaying
					? `Deleted "${song.title}" and skipped to the next song.`
					: `Deleted "${song.title}".`;
			} else {
				const body = await res.json().catch(() => ({}));
				notice = body.error ? `Could not delete: ${body.error}` : 'Could not delete that song.';
			}
		} catch {
			notice = 'Could not delete that song.';
		}
		deletingId = null;
		// A FAILED DELETE STAYS ARMED. Disarming on both outcomes made a failure look like a cancellation, and the
		// retry then cost re-arming the row; the notice beside it says what went wrong.
		if (deleted) confirmingId = null;
		await tick();
		if (!deleted) {
			confirmEl?.focus();
			return;
		}
		// Whatever row took the deleted one's index, or the new last row if it was the last.
		const next = songs[index] ?? songs[index - 1];
		if (next) armRefs[next.id]?.focus();
		else noticeEl?.focus();
	}
</script>

<!-- Escape cancels the armed prompt: it is an ad-hoc modal-in-a-row rather than a bits-ui dialog, so it inherits no
	 dismissal behaviour, and /admin has no other Escape consumer for this to steal from. It must NOT fire once the
	 DELETE is in flight — that request cannot be called off, and both prompt buttons are already `disabled` in that
	 window, so cancelling there would be a lie. -->
<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape' && confirmingId && !deletingId) {
			e.preventDefault();
			void cancelDelete();
		}
	}}
/>

<svelte:head><title>Admin · Encore</title></svelte:head>

<!-- No inbound link anywhere in the app, so back goes to the remote at `/`, not to a referrer. -->
<div class="admin-page">
	<PageHeader title="Server admin" back={{ href: '/', label: 'Back to the remote' }} />

	<main class="admin">
		<p class="lede">Hard-delete a song from the library. This removes its files and cannot be undone.</p>

		<!-- THE REGION OUTLIVES THE MESSAGE. Mounted with its text already in place, a live region reports nothing — AT
			 announces a CHANGE inside one it was already observing. So the wrapper is unconditional and only the contents
			 swap; `/metrics`, `/metrics/[mediaId]` and `/stats` all state this same rule, and this page was the one that
			 broke it. `role="status"`, and `accent` not `destructive`: a completed action must not interrupt or alarm. -->
		<!-- `tabindex="-1"` so deleting the LAST song has somewhere to put focus: there is no next row to return to, and
			 this wrapper is unconditional, so it outlives the message it holds. -->
		<div bind:this={noticeEl} role="status" aria-live="polite" tabindex="-1">
			{#if notice}
				<Alert.Root variant="accent"><Alert.Title>{notice}</Alert.Title></Alert.Root>
			{/if}
		</div>

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
							<!-- Arming replaces the focused button, so the prompt is role="alert" and each control names its song. -->
							{#if confirmingId === song.id}
								<span class="confirm-q" role="alert">Delete for good?</span>
								<Button
									bind:ref={confirmEl}
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
									bind:ref={() => armRefs[song.id] ?? null, (node) => (armRefs[song.id] = node)}
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
		/* Cap the WRAPPER so header and content share one left edge, and keep width:100% — .app-shell is a centred flex
			   column, where a cap alone shrinks from the right instead of re-centring. */
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
		/* Dimmed INK is --ink-dim (7.16:1 on --bg). `--muted` is the shadcn SURFACE alias (--card2) and measures 1.24:1 as
			   text — invisible, and `var(--muted, …)` never falls back because it is set. */
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
