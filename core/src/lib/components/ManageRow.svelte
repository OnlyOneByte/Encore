<script lang="ts">
	/* A Library row in the host's Manage mode, with its song sheet. Host only; see docs/FRONTEND.md#the-library-page. */
	import { DELETE_UNDO_MS, songDisplay, type LibrarySizes, type Media } from '$lib/contract';
	import { formatBytes } from '$lib/library-browse';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Switch } from '$lib/components/ui/switch';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { toast } from 'svelte-sonner';

	let {
		media,
		info,
		open,
		queued,
		picked,
		ontoggle,
		onpick,
		onchanged
	}: {
		media: Media;
		info: LibrarySizes['songs'][string] | undefined;
		open: boolean;
		/** Playing or still to come tonight; the server refuses its delete. */
		queued: boolean;
		/** In the bulk selection. */
		picked: boolean;
		ontoggle: () => void;
		onpick: () => void;
		/** The library or the sizes changed; re-read both. */
		onchanged: () => void;
	} = $props();

	const shown = $derived(songDisplay(media));
	const artist = $derived(shown.artist ?? '');
	const kept = $derived(info?.kept === true);
	const byline = $derived([artist, kept ? 'Kept' : null].filter(Boolean).join(' · '));
	const facts = $derived(
		[
			artist,
			info ? formatBytes(info.bytes) : null,
			info ? `sung ${info.plays} ${info.plays === 1 ? 'time' : 'times'}` : null
		]
			.filter(Boolean)
			.join(' · ')
	);

	let naming = $state(false);
	let title = $state('');
	let by = $state('');
	let busy = $state(false);

	/** On a short phone a sheet opened low would sit under the dock; bring all of it into view. */
	function reveal(el: HTMLElement) {
		el.scrollIntoView({ block: 'nearest' });
	}

	async function post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
		busy = true;
		try {
			const res = await fetch(`/api/library/manage/${path}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ mediaId: media.id, ...body })
			});
			const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
			if (!res.ok) {
				toast.error(typeof out.error === 'string' ? out.error : "Couldn't change that song", { duration: 4000 });
				return null;
			}
			return out;
		} catch {
			toast.error("Couldn't reach the server", { duration: 4000 });
			return null;
		} finally {
			busy = false;
		}
	}

	function startNaming() {
		title = shown.title;
		by = artist;
		naming = true;
	}

	async function saveName() {
		if (await post('rename', { title, artist: by })) {
			naming = false;
			onchanged();
		}
	}

	async function setKeep(keep: boolean) {
		if (await post('keep', { keep })) onchanged();
	}

	async function remake(what: 'sound' | 'lyrics') {
		const out = await post('remake', { what });
		if (!out) return;
		onchanged(); // a last failure's line goes: this remake is now the latest
		toast(out.afterTurn ? `Making the ${what} again after its turn` : `Making the ${what} again`, {
			duration: 4000,
			description:
				what === 'sound'
					? 'The song stays ready. Its old sound plays until the new one is in.'
					: 'The song stays ready. Its old lyrics show until the new ones are in.'
		});
	}

	async function remove() {
		const out = await post('delete', {});
		if (!out) return;
		const name = shown.title;
		// Closed first, so an Undo brings the row back shut.
		if (open) ontoggle();
		onchanged();
		toast(`“${name}” deleted`, {
			duration: DELETE_UNDO_MS,
			description: out.libraryFile ? 'Your file stays in the library folder' : undefined,
			action: {
				label: 'Undo',
				onClick: async () => {
					if (await post('undo', {})) onchanged();
				}
			}
		});
	}
</script>

<div class="card list-row manage-row" data-testid="manage-row">
	<label class="pick">
		<Checkbox checked={picked} onCheckedChange={onpick} aria-label={`Pick ${shown.title}`} />
	</label>
	<button class="open" aria-expanded={open} onclick={ontoggle}>
		<span class="t">{shown.title}</span>
		{#if byline}<span class="by">{byline}</span>{/if}
	</button>
	{#if info}<span class="size" data-testid="song-size">{formatBytes(info.bytes)}</span>{/if}
</div>

{#if open}
	<section class="sheet" aria-label={`Manage ${shown.title}`} data-testid="song-sheet" use:reveal>
		<h2 class="sheet-t">{shown.title}</h2>
		<p class="sheet-facts">{facts}</p>

		{#if naming}
			<form
				class="naming"
				onsubmit={(e) => {
					e.preventDefault();
					void saveName();
				}}
			>
				<label>Title <Input bind:value={title} maxlength={200} required /></label>
				<label>Artist <Input bind:value={by} maxlength={200} /></label>
				<div class="naming-actions">
					<Button type="button" variant="ghost" size="tap" onclick={() => (naming = false)}>Cancel</Button>
					<Button type="submit" variant="secondary" size="tap" disabled={busy || !title.trim()}>Save</Button>
				</div>
			</form>
		{:else}
			<div class="line">
				<span>Name and artist</span>
				<Button variant="ghost" size="tap" onclick={startNaming}>Change</Button>
			</div>
		{/if}
		<div class="line">
			<span>Lyrics</span>
			<span class="acts">
				<Button variant="ghost" size="tap" disabled={busy || !media.vocalsRef} onclick={() => remake('lyrics')}
					>Lyrics again</Button
				>
				<Button variant="ghost" size="tap" href={`/song/${encodeURIComponent(media.id)}`}>Fix</Button>
			</span>
		</div>
		{#if info?.lyricsRemakeFailed}
			<p class="remake-failed" role="status" data-testid="lyrics-remake-failed">
				Lyrics again didn't work last time, so the old lyrics stay. Why: {info.lyricsRemakeFailed}
			</p>
		{/if}
		<div class="line">
			<span>Sound</span>
			<Button variant="ghost" size="tap" disabled={busy} onclick={() => remake('sound')}>Sound again</Button>
		</div>
		{#if info?.remakeFailed}
			<p class="remake-failed" role="status" data-testid="remake-failed">
				Sound again didn't work last time, so the old sound stays. Why: {info.remakeFailed}
			</p>
		{/if}
		<label class="line">
			<span>Keep on this machine</span>
			<Switch checked={kept} disabled={busy} onCheckedChange={(v) => void setKeep(v)} />
		</label>
		<div class="line">
			{#if queued}
				<span class="dim">In tonight's queue. Delete it after its turn.</span>
			{:else if kept}
				<span class="dim">Turn Keep off to delete this song.</span>
			{:else}
				<Button variant="ghost" size="tap" class="delete" disabled={busy} onclick={remove}>Delete</Button>
			{/if}
		</div>
	</section>
{/if}

<style>
	.manage-row {
		display: flex;
		align-items: center;
		gap: var(--space-md);
	}
	/* The label, not the 18px box, is the tap target. */
	.pick {
		display: flex;
		align-items: center;
		justify-content: center;
		min-width: var(--tap);
		min-height: var(--tap);
		margin-inline-start: calc(-1 * var(--space-sm));
		cursor: pointer;
	}
	.open {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		justify-content: center;
		min-height: var(--tap);
		padding: 0;
		background: none;
		border: 0;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.t {
		font-weight: 700;
		overflow-wrap: anywhere;
	}
	.by,
	.size,
	.sheet-facts,
	.dim {
		color: var(--ink-dim);
		font-size: var(--ph-text-sm);
	}
	.remake-failed {
		margin: 0 0 var(--space-xs);
		color: var(--warn);
		font-size: var(--ph-text-sm);
	}
	.size {
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.sheet {
		margin-bottom: var(--space-md);
		padding: var(--space-md);
		border-radius: var(--radius-sm);
		background: var(--card2);
		/* The dock covers the bottom of the viewport, so `reveal` stops above it. */
		scroll-margin-bottom: calc(var(--dock-h, 0px) + var(--space-md));
	}
	.sheet-t {
		margin: 0;
		font-size: var(--ph-text-lg);
		overflow-wrap: anywhere;
	}
	.sheet-facts {
		margin: var(--space-2xs) 0 var(--space-sm);
	}
	.line {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-md);
		min-height: var(--tap);
		border-top: 1px solid var(--role-rule);
	}
	.acts {
		display: flex;
		gap: var(--space-xs);
	}
	.line :global(.delete) {
		color: var(--danger-ink);
		padding-inline: 0;
	}
	.naming {
		display: grid;
		gap: var(--space-sm);
		padding-block: var(--space-sm);
		border-top: 1px solid var(--role-rule);
	}
	.naming label {
		display: grid;
		gap: var(--space-2xs);
		font-size: var(--ph-text-sm);
	}
	.naming-actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-sm);
	}
</style>
