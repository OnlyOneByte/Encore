<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import type { ServerEvent, QueueEntry, Media, PublicSinger } from '@encore/shared';
	import { QueueStore } from '$lib/stores/queue';
	import { WsClient } from '$lib/ws/client';
	import QueueRow from '$lib/components/QueueRow.svelte';
	import SongCard from '$lib/components/SongCard.svelte';

	let me = $state<PublicSinger | null>(null);
	let entries = $state<QueueEntry[]>([]);
	let singers = $state<Map<string, PublicSinger>>(new Map());
	let mediaCatalog = $state<Map<string, Media>>(new Map());
	let connected = $state(false);

	let store: QueueStore;
	let ws: WsClient;

	// derived: my position in the rotation + who's right before me
	const myNextEntry = $derived(
		entries.filter((e) => e.singerId === me?.id && e.status === 'queued').sort((a, b) => a.rotationSeq - b.rotationSeq)[0]
	);
	const myPositionLabel = $derived.by(() => {
		if (!myNextEntry) return '';
		const queued = entries.filter((e) => e.status === 'queued').sort((a, b) => a.rotationSeq - b.rotationSeq);
		const idx = queued.findIndex((e) => e.id === myNextEntry.id);
		if (idx < 0) return '';
		if (idx === 0) return "You're up next! 🎤";
		const before = queued[idx - 1];
		const beforeName = before ? singers.get(before.singerId)?.displayName ?? 'someone' : 'someone';
		return `You're #${idx + 1} · after ${beforeName}`;
	});

	function mediaTitle(id: string): string {
		const m = mediaCatalog.get(id);
		return m ? `${m.title}${m.artist ? ' — ' + m.artist : ''}` : id;
	}
	function singerOf(id: string): PublicSinger | undefined {
		return singers.get(id);
	}

	onMount(() => {
		let disposed = false;
		(async () => {
			// who am I? (redirect to join if not)
			const res = await fetch('/api/me');
			if (!res.ok) {
				await goto('/join');
				return;
			}
			me = (await res.json()).singer;
			if (disposed || !me) return;

			store = new QueueStore({
				singerId: me.id,
				sendCommand: (cmd) => ws.send({ type: 'queue:command', command: cmd })
			});
			store.subscribe((e) => (entries = e));

			ws = new WsClient({
				url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?role=phone`,
				getLastRev: () => store.rev,
				onEvent: (e: ServerEvent) => {
					if (e.type === 'queue:sync') {
						if (e.singers) singers = new Map(e.singers.map((s) => [s.id, s]));
						if (e.media) mediaCatalog = new Map(e.media.map((m) => [m.id, m]));
					}
					if (e.type === 'singer:joined') {
						singers = new Map(singers).set(e.singer.id, e.singer);
					}
					store.onServerEvent(e);
				}
			});
			ws.open();
			connected = true;
		})();
		return () => {
			disposed = true;
			ws?.close();
		};
	});

	function addSong(mediaId: string) {
		store?.addSong(mediaId);
		if (navigator.vibrate) navigator.vibrate(8); // haptic tick
	}

	// remove + undo toast
	let undo = $state<{ mediaId: string; title: string } | null>(null);
	let undoTimer: ReturnType<typeof setTimeout> | undefined;
	function removeWithUndo(entry: QueueEntry) {
		store?.removeEntry(entry.id);
		if (navigator.vibrate) navigator.vibrate(8);
		undo = { mediaId: entry.mediaId, title: mediaTitle(entry.mediaId) };
		clearTimeout(undoTimer);
		undoTimer = setTimeout(() => (undo = null), 5000);
	}
	function doUndo() {
		if (!undo) return;
		store?.addSong(undo.mediaId);
		undo = null;
		clearTimeout(undoTimer);
	}

	const queued = $derived(entries.filter((e) => e.status === 'queued').sort((a, b) => a.rotationSeq - b.rotationSeq));
</script>

<header style="padding:16px 18px 8px;display:flex;align-items:center;gap:10px;">
	<div style="font-weight:800;font-size:1.25rem;">🎤 <span style="background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent;">Encore</span></div>
	{#if me}
		<div style="margin-left:auto;display:flex;align-items:center;gap:8px;font-size:.85rem;color:var(--ink-dim);">
			<span>{me.displayName}</span>
			<span style="width:22px;height:22px;border-radius:50%;background:{me.color};box-shadow:0 0 0 3px {me.color}30;"></span>
		</div>
	{/if}
</header>

<main style="flex:1;padding:6px 18px 120px;">
	{#if myPositionLabel}
		<div class="card" style="padding:12px 14px;margin-bottom:14px;background:linear-gradient(var(--card),#1d1830);border-color:#3a3155;">
			<strong>{myPositionLabel}</strong>
		</div>
	{/if}

	<!-- quick-add demo catalog (real search lands in M4) -->
	<div style="font-size:.78rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-dim);margin:6px 4px 10px;">Add a song</div>
	{#each [...mediaCatalog.values()] as m (m.id)}
		<SongCard title={m.title} sub={`${m.artist ?? ''} · tap to queue`} onadd={() => addSong(m.id)} />
	{/each}

	<div style="font-size:.78rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-dim);margin:18px 4px 10px;">Up next · rotation</div>
	{#if queued.length === 0}
		<p style="color:var(--ink-dim);padding:0 4px;">Queue's empty — add a song to start the party ✨</p>
	{:else}
		{#each queued as e, i (e.id)}
			{@const s = singerOf(e.singerId)}
			<QueueRow
				seq={i + 1}
				title={mediaTitle(e.mediaId)}
				singerName={e.singerId === me?.id ? 'You' : s?.displayName ?? 'Guest'}
				singerColor={s?.color ?? '#7c5cff'}
				mine={e.singerId === me?.id}
				up={i === 0}
				pending={e.rotationSeq === Number.MAX_SAFE_INTEGER}
				subtitle={i === 0 ? 'up next' : ''}
				removable={e.singerId === me?.id && i !== 0}
				onremove={() => removeWithUndo(e)}
			/>
		{/each}
	{/if}
</main>

{#if undo}
	<div class="undo-toast">
		<span>Removed “{undo.title}”</span>
		<button onclick={doUndo}>Undo</button>
	</div>
{/if}

<style>
	.undo-toast {
		position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%);
		display: flex; align-items: center; gap: 14px; z-index: 30;
		background: var(--card2); border: 1px solid var(--line); border-radius: 14px;
		padding: 12px 16px; box-shadow: var(--shadow); font-size: 0.9rem; max-width: 90vw;
	}
	.undo-toast button {
		border: 0; background: var(--grad); color: #fff; font-weight: 700;
		border-radius: 8px; padding: 6px 12px; cursor: pointer;
	}
</style>
