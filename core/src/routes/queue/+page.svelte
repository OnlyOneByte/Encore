<script lang="ts">
	/* THE QUEUE TAB, and the home for everything the now-playing sheet held before it was deleted.
	   See docs/FRONTEND.md#the-three-tabs for the architecture. The short version: Encore's now-playing surface is
	   the TELEVISION, so the phone never needed a multi-snap sheet — it needed a queue with the live controls on top
	   of it. This is the screen you are already on to see whose turn is next, which is where a guest reaching for
	   "turn the guide vocal down" actually is.

	   WHY THE CONTROLS SIT ABOVE THE LIST rather than below it: they act on what is PLAYING, and the playing song is
	   not in the queued list, so putting them under the list would separate a control from its subject by the whole
	   scroll height of a party's queue. */
	import { onMount } from 'svelte';
	import {
		SINGER_COLORS,
		songDisplay,
		isPlayable,
		hasGuidingTrack,
		effectiveGuideLevel,
		originalKeyLabel,
		type QueueEntry,
		type Media,
		type PublicSinger,
		type PlaybackState,
		type MediaStatus,
		type SongProfile
	} from '$lib/contract';
	import { room } from '$lib/stores/room';
	import { queueCardKind, nextPlayableEntryId } from '$lib/readiness';
	import type { QueueStore } from '$lib/stores/queue';
	import { tick } from 'svelte';
	import {
		gripVisible,
		liveSortTarget,
		keyboardMoveTarget,
		ordinal,
		modeInvalidation,
		rowShift,
		liveSeq
	} from '$lib/reorder-mode';
	import { focusGrip, measureCarriedRowHeight, measureRowBoxes, trackDragPointer } from '$lib/queue-drag';
	import { queueAnnouncement } from '$lib/phrasing/queue-announcement';
	import { songFacts } from '$lib/song-facts';
	import { drawPosition, secondTicker } from '$lib/playhead';
	import { formatClock, formatRemaining } from '$lib/clock';
	import QueueRow from '$lib/components/QueueRow.svelte';
	import ProcessingCard from '$lib/components/ProcessingCard.svelte';
	import GuidingTrack from '$lib/components/GuidingTrack.svelte';
	import RangeBar from '$lib/components/RangeBar.svelte';
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Empty from '$lib/components/ui/empty';

	/* Mirrored from the link, and ONLY the fields this page renders — the documented rule, because a component that
	   mirrors more than it renders re-runs on changes that cannot affect it. The root layout mirrors a strictly
	   narrower set (the strip's nine), so neither borrows the other's shape. */
	let me = $state<PublicSinger | null>(null);
	let entries = $state<QueueEntry[]>([]);
	let singers = $state<Map<string, PublicSinger>>(new Map());
	let mediaCatalog = $state<Map<string, Media>>(new Map());
	let awaySingers = $state<Set<string>>(new Set());
	let mediaStatus = $state<Map<string, { status: MediaStatus; pct: number; etaSec?: number }>>(new Map());
	let playback = $state<PlaybackState>({
		currentEntryId: null,
		isPlaying: false,
		positionSec: 0,
		keyShift: 0,
		guideLevel: null,
		background: null
	});
	let roomGuideDefault = $state(0);
	let pendingKind = $state<Map<string, 'add' | 'move'>>(new Map());
	/* Removal goes through the QueueStore, NOT `room.command`: the player commands are the transport, and the queue
	   owns its own optimistic add/remove/move bookkeeping (`pendingKind` above is the store's). */
	let store = $state<QueueStore | undefined>(undefined);

	onMount(() => {
		const sync = () => {
			me = room.me ?? null;
			entries = room.entries;
			singers = room.singers;
			mediaCatalog = room.mediaCatalog;
			awaySingers = room.awaySingers;
			mediaStatus = room.mediaStatus;
			playback = room.playback;
			roomGuideDefault = room.roomGuideDefault;
			pendingKind = room.pendingKind;
			store = room.queue;
		};
		sync();
		return room.subscribe(sync);
	});

	const queued = $derived(entries.filter((e) => e.status === 'queued').sort((a, b) => a.rotationSeq - b.rotationSeq));
	/* WHAT WILL ACTUALLY PLAY NEXT, skipping anything still processing, matching the server's own `nextPlayable`.
	   This is why `up` is keyed on an id rather than on `i === 0`: the first row in rotation order may be cooking,
	   and crowning it would promise a turn the server will skip. `nextPlayableEntryId` lost its only production
	   caller when home's queue was deleted; this is it. */
	const nextPlayableId = $derived(
		nextPlayableEntryId(
			queued,
			(id) => mediaCatalog.get(id),
			(id) => mediaStatus.get(id)
		)
	);

	const nowEntry = $derived(entries.find((e) => e.id === playback.currentEntryId));
	const nowMedia = $derived(nowEntry ? mediaCatalog.get(nowEntry.mediaId) : undefined);
	const nowDisplay = $derived(songDisplay(nowMedia));
	const nowDurationSec = $derived(nowMedia?.durationSec ?? 0);
	const nowSinger = $derived(nowEntry ? singers.get(nowEntry.singerId) : undefined);

	const profile = $derived<SongProfile | null>(nowMedia?.songProfile ?? null);
	const keyShift = $derived(playback.keyShift);
	// Two different stem requirements, so a song can offer ±key without offering a guiding track.
	const keyShiftEnabled = $derived(!!nowMedia && isPlayable(nowMedia));
	const guideEnabled = $derived(!!nowMedia && hasGuidingTrack(nowMedia));
	const guideServerPct = $derived(
		Math.round(effectiveGuideLevel({ guideLevel: playback.guideLevel }, roomGuideDefault) * 100)
	);

	const facts = $derived(songFacts(profile, keyShift));

	/* Once a second, not a frame. BOTH READS STAY INSIDE THE EFFECT: a resume re-delivers an equal `positionSec`,
	   and writing an equal primitive notifies nothing, so a separate anchor effect would never re-run — the
	   documented hazard this tree has shipped twice. */
	let displayPos = $state(0);
	$effect(() => {
		const positionSec = playback.positionSec;
		const anchoredAtMs = performance.now();
		const playing = playback.isPlaying;
		displayPos = positionSec;
		return secondTicker(playing, () => {
			displayPos = drawPosition({ positionSec, playing, anchoredAtMs, nowMs: performance.now() });
		});
	});

	/* While a finger is on the slider the LOCAL value wins, or the thumb fights the throttled websocket echo.
	   Carried over verbatim from the deleted sheet, including the trailing send: without it the last position of a fast
	   drag is the one that gets dropped, which leaves the guide at a level the guest did not choose. */
	let guideDragging = $state(false);
	let guideDraft = $state(0);
	const guidePct = $derived(guideDragging ? guideDraft : guideServerPct);

	const GUIDE_SEND_THROTTLE_MS = 120;
	let guideLastSent = 0;
	let guidePending: ReturnType<typeof setTimeout> | null = null;

	function sendGuide(pct: number): void {
		guideLastSent = Date.now();
		room.command({ cmd: 'guide', level: pct / 100 });
	}
	function onGuideInput(pct: number): void {
		guideDragging = true;
		guideDraft = pct;
		const since = Date.now() - guideLastSent;
		if (since >= GUIDE_SEND_THROTTLE_MS) {
			sendGuide(pct);
			return;
		}
		if (guidePending) clearTimeout(guidePending);
		guidePending = setTimeout(() => {
			guidePending = null;
			sendGuide(guideDraft);
		}, GUIDE_SEND_THROTTLE_MS - since);
	}
	function onGuideCommit(pct: number): void {
		if (guidePending) {
			clearTimeout(guidePending);
			guidePending = null;
		}
		guideDraft = pct;
		sendGuide(pct);
		guideDragging = false;
	}

	/* REORDERING, MOVED VERBATIM FROM THE HOME PAGE rather than re-derived. It is a live sort with no mode:
	   `liveSortTarget` both places the rows and decides the commit, so a release cannot land somewhere the guest did
	   not see, and the single-pointer alternative (SC 2.5.7 / 2.1.1) is Arrow Up/Down on the grip. See
	   $lib/reorder-mode. The queue is this page's subject now, so the machinery lives where its rows do — leaving it
	   on a page that no longer renders a queue is how a reorder quietly stops working. */
	let liveMsg = $state('');
	let announcedIds: string[] | null = null;
	$effect(() => {
		const announcement = queueAnnouncement({
			previousIds: announcedIds,
			queued,
			meId: me?.id,
			singerName: (id) => singers.get(id)?.displayName ?? 'Someone',
			songTitle: mediaTitle
		});
		announcedIds = queued.map((e) => e.id);
		if (announcement) liveMsg = announcement;
	});

	/** The entry's index in the WHOLE queued list — the index space `move-to-index` uses. */
	function queuedIdx(id: string): number {
		return queued.findIndex((e) => e.id === id);
	}
	/* Reordering is a LIVE SORT with no mode: `liveSortTarget` both places the rows and decides the commit, so a
	   release cannot land somewhere the guest did not see. The single-pointer alternative (SC 2.5.7 / 2.1.1) is
	   Arrow Up/Down on the grip. See $lib/reorder-mode and docs/FRONTEND.md#the-three-tabs. */
	let movingId = $state<string | null>(null);
	let dragging = $state(false);
	let dragY = $state(0);
	/** The dragged row's height, measured once at press time — how far its neighbours slide. */
	let rowH = $state(0);
	/**
	 * Measured once at press time, and empty except during a drag, so no stale geometry can place a row: rows
	 * change height mid-flight (a byline gains an `away` badge, another guest queues a card).
	 */
	let rowBounds = $state<{ top: number; height: number }[]>([]);
	// Announced through the SAME polite region the queue uses, and rendered visibly: a sighted guest needs it.
	let reorderNote = $state('');
	/** The grip the gesture began on, so focus can be returned to it. */
	let openerEl: HTMLElement | null = null;
	let dragTeardown: (() => void) | null = null;

	/** Where the dragged row currently sits, which is both what the list renders and what a release commits. */
	const dragFrom = $derived(movingId ? queuedIdx(movingId) : -1);
	const dragTo = $derived(
		dragging && dragFrom >= 0
			? liveSortTarget({ fromIndex: dragFrom, offsetPx: dragY, rowBoundsPx: rowBounds, count: queued.length })
			: -1
	);

	/* Every position is legal under `move-to-index`, so no ordering policy can discard a move: the only condition
	   on the grip is that a second position exists. Both row kinds take THIS value, never a literal. */
	const gripsVisible = $derived(gripVisible({ queuedCount: queued.length, reorderMeaningful: true }));

	function commitMove(id: string, to: number | null) {
		if (to === null) return;
		const from = queuedIdx(id);
		if (from < 0 || to === from) return;
		store?.moveToIndex(id, to);
		if (navigator.vibrate) navigator.vibrate(8);
	}

	/** One place per press, committed immediately; `keyboardMoveTarget` declines at the ends. */
	function nudge(id: string, delta: number) {
		const from = queuedIdx(id);
		const to = keyboardMoveTarget(from, delta, queued.length);
		if (to === null) return;
		commitMove(id, to);
		liveMsg = `Moved to ${ordinal(to + 1)} in the queue.`;
		// After the patch lands, because the row's DOM is recreated at its new position.
		void tick().then(() => focusGrip(id));
	}

	/** End the gesture. `commit` false for a cancel or an invalidation — those commit NOTHING. */
	function endDrag(commit: boolean, note = '') {
		const id = movingId;
		const to = dragTo;
		dragTeardown?.();
		dragTeardown = null;
		if (commit && id) commitMove(id, to >= 0 ? to : null);
		movingId = null;
		dragging = false;
		dragY = 0;
		rowH = 0;
		rowBounds = [];
		reorderNote = note;
		if (note) liveMsg = note;
		// After the patch lands; `openerEl` is the fallback for a row that has gone entirely.
		void tick().then(() => {
			focusGrip(id, openerEl);
			openerEl = null;
		});
	}

	/** Publishes the offset as a custom property for a transform to read; the target is arithmetic, not a hit-test. */
	function onGripPointerDown(entry: QueueEntry, e: PointerEvent) {
		const grip = e.currentTarget as HTMLElement | null;
		if (!grip) return;
		movingId = entry.id;
		dragging = true;
		dragY = 0;
		reorderNote = '';
		openerEl = grip;
		// A pointer press does not focus a button in every engine, so an Escape cancel would have no origin.
		grip.focus?.();
		// Both reads happen ONCE, here, and nothing is measured again for the life of the gesture.
		rowH = measureCarriedRowHeight(grip);
		rowBounds = measureRowBoxes();
		dragTeardown = trackDragPointer(e, {
			onMove: (offsetY) => (dragY = offsetY),
			onEnd: () => endDrag(true),
			onCancel: () => endDrag(false)
		});
	}

	// The queue moving under a drag needs no handling — the live sort is relative to where the row IS. Only the
	// dragged song leaving, starting to play, or the queue falling below two invalidates the gesture.
	$effect(() => {
		const reason = modeInvalidation(queued, movingId, entries.find((e) => e.id === movingId)?.status);
		if (reason) endDrag(false, reason);
	});

	const mediaTitleOf = (id: string) => songDisplay(mediaCatalog.get(id)).title || 'Untitled';
	// The moved block calls this name; home spelled it `mediaTitle`.
	const mediaTitle = mediaTitleOf;
</script>

<svelte:head><title>Queue · Encore</title></svelte:head>

<PageHeader title="Up next" icon="clock" />

<!-- `--row-h` is the dragged row's measured height, published for the neighbours' transform to read: a
	shifted row slides by exactly one row rather than by a guess. Measured once at press time and 0 otherwise. -->
<main style="--row-h:{rowH}px">
	{#if nowEntry}
		<!-- THE NOW-PLAYING CARD. Not a `<section aria-label>` duplicating the strip's: the strip above is the
			persistent one, this is the detailed one, and two landmarks with the same name is worse than one. -->
		<div class="now">
			<p class="now-eyebrow">Singing now</p>
			<h2 class="now-title">{nowDisplay.title || nowMedia?.title || 'Untitled'}</h2>
			<p class="now-by">
				<span class="dot" style:background={nowSinger?.color ?? SINGER_COLORS[0]}></span>
				{nowSinger?.displayName ?? 'Someone'}
				{#if nowDisplay.artist}<span class="artist"> · {nowDisplay.artist}</span>{/if}
			</p>

			<!-- THE ONE PLACE THE PHONE SPELLS THE CLOCK. The strip above carries only a hairline, because a
				once-a-second percentage announced over a title is noise; here there is room for the real numbers, and
				`displayPos` is the extrapolated position rather than the last broadcast one so it does not sit still
				between websocket frames. `formatRemaining` omits the estimate rather than zeroing it when the length
				is unknown. -->
			{#if nowDurationSec > 0}
				<p class="clock">
					<span class="elapsed">{formatClock(displayPos)}</span>
					<span class="remain">{formatRemaining(displayPos, nowDurationSec)}</span>
				</p>
			{/if}

			{#if facts.keyOriginal}
				<p class="facts">
					<span class="k-orig">{facts.keyOriginal}</span>
					{#if facts.keyShifted}
						<span class="k-arrow"><Icon name="arrow-right" /></span>
						<span class="k-sound">{facts.keySounding}</span>
					{/if}
					{#if facts.rangeText}<span class="k-range"> · {facts.rangeText}</span>{/if}
				</p>
			{/if}

			<!-- KEY SHIFT. The accessible names carry the DIRECTION: `Icon` is aria-hidden, so both keycaps otherwise
				compute to the bare word "semitone" and a screen-reader user cannot tell which one lowers the key — on
				the app's signature control.
				THE LABEL IS app.css's `.control-label`, NOT a local class, and this card is why that matters: the
				GuidingTrack row below renders a real `[data-slot='field-label']`, so two field labels sit on one
				surface here and a drift between them is visible the way settings' You card made one visible. This span
				used to be `.ctl-lab`, re-declaring three of the shared rule's four properties and dropping the fourth
				(`line-height`), which is precisely the drift `.control-label` was factored to stop. A plain `<span>`
				rather than the primitive because the row labels TWO keycaps, and `<label for>` points at one. -->
			<div class="ctl">
				<span class="control-label">{facts.keyLabel}</span>
				<div class="keys">
					<Button
						size="tap"
						variant="keycap"
						disabled={!keyShiftEnabled || keyShift <= -7}
						aria-label="Lower by one semitone"
						onclick={() => room.command({ cmd: 'key', semitones: keyShift - 1 })}><Icon name="minus" /></Button
					>
					<Button
						size="tap"
						variant="keycap"
						disabled={!keyShiftEnabled || keyShift >= 7}
						aria-label="Raise by one semitone"
						onclick={() => room.command({ cmd: 'key', semitones: keyShift + 1 })}><Icon name="plus" /></Button
					>
				</div>
			</div>

			<GuidingTrack pct={guidePct} available={guideEnabled} oninput={onGuideInput} oncommit={onGuideCommit} />

			<RangeBar profile={profile} keyShift={keyShift} />

			<!-- THE DOOR TO /song/[mediaId], AND CURRENTLY THE ONLY ONE. The deleted drawer held the only `href` to that
				route in the tree, so removing it orphaned the page: `LyricsReselect` has one importer, `room.reselectLyrics`
				two call sites, and `/api/lyrics-reselect` had no reachable UI at all. "Are the words right" is one of the
				live controls the architecture names, so it needs a door, and the playing song is the one it belongs to —
				which is the same reachability the drawer gave it, not a wider one. -->
			{#if nowMedia?.id}
				<a class="more" href={`/song/${nowMedia.id}`}>
					Song details and lyrics
					<Icon name="chevron-right" />
				</a>
			{/if}
		</div>
	{/if}

	{#if queued.length}
		<h2 class="grouphead">Queued</h2>
		<!-- Not mode chrome: a drag invalidated mid-flight has to say why, visibly as well as announced. -->
		{#if reorderNote}
			<p class="reorder-note">{reorderNote}</p>
		{/if}
		<!-- ONE LIST OVER `queued`, SWITCHING CARD KIND PER ROW — never two sections split by readiness, which is
			what this page shipped first and what broke reordering. The reorder arithmetic is ONE INDEX SPACE: `i`,
			`dragFrom`, `dragTo` and `count: queued.length` all index `queued`, and `measureRowBoxes()` reads `.qrow`
			in DOM ORDER — a class BOTH card kinds carry. Rendering ready rows in one section and cooking rows in a
			later one left the two in exact complement, so `rowBounds.length === count` and `liveSortTarget`'s length
			guard never fired, while the order was permuted: with `[A cooking, B ready, C ready]` the DOM read
			`[B, C, A]`, so dragging B took C's box and committed a move the guest never saw. The guard checks length,
			never order, and it was only ever sufficient because this was one list.
			A COOKING SONG STILL HOLDS ITS TURN, which is the product reason the same arithmetic is also the right
			shape: rotation order is one order, so `seq` must number every row in it. Splitting the list made the
			cooking card show a sparkle while the ready rows numbered 1..n, and the printed order then contradicted
			the rotation the server keeps. -->
		{#each queued as e, i (e.id)}
			{@const s = singers.get(e.singerId)}
			{@const media = mediaCatalog.get(e.mediaId)}
			{@const card = queueCardKind(media, mediaStatus.get(e.mediaId))}
			{#if card === 'processing' || card === 'failed'}
				{@const proc = mediaStatus.get(e.mediaId) ?? { status: 'failed' as MediaStatus, pct: 0 }}
				<ProcessingCard
					seq={liveSeq(i, dragFrom, dragTo)}
					title={mediaTitleOf(e.mediaId)}
					singerName={e.singerId === me?.id ? 'You' : (s?.displayName ?? 'Guest')}
					singerColor={s?.color ?? SINGER_COLORS[0]}
					singerAway={awaySingers.has(e.singerId)}
					status={proc.status}
					pct={proc.pct}
					pending={pendingKind.get(e.id) ?? null}
					onremove={e.singerId === me?.id ? () => store?.removeEntry(e.id) : undefined}
					reorderable={gripsVisible}
					shift={rowShift(i, dragFrom, dragTo)}
				/>
			{:else}
				<!-- `seq` is the LIVE position, never the source index: `liveSeq` reads the same shift arithmetic that
					places the row, so a number never corrects itself when the patch lands. -->
				<QueueRow
					seq={liveSeq(i, dragFrom, dragTo)}
					title={mediaTitleOf(e.mediaId)}
					singerName={e.singerId === me?.id ? 'You' : (s?.displayName ?? 'Guest')}
					singerColor={s?.color ?? SINGER_COLORS[0]}
					mine={e.singerId === me?.id}
					singerAway={awaySingers.has(e.singerId)}
					up={e.id === nextPlayableId}
					subtitle={originalKeyLabel(media?.songProfile ?? null) ?? ''}
					pending={pendingKind.get(e.id) ?? null}
					removable={e.singerId === me?.id}
					grip={gripsVisible}
					gripId={e.id}
					moving={movingId === e.id && dragging}
					dragY={movingId === e.id && dragging ? dragY : 0}
					shift={rowShift(i, dragFrom, dragTo)}
					ongripdown={(ev) => onGripPointerDown(e, ev)}
					onnudge={(delta) => nudge(e.id, delta)}
					onremove={() => store?.removeEntry(e.id)}
				/>
			{/if}
		{/each}
	{:else}
		<!-- TWO EMPTY STATES, not one, because the two situations need different words and the first draft of this
			page gated this on `{:else if !nowEntry}` — which rendered NOTHING in the commonest case of the party
			actually running: a song playing and nobody queued behind it. That is the moment the page most needs to
			ask for a song. Gated on `queued` alone now, because a cooking song IS a queued entry and renders above. -->
		<Empty.Root>
			<Empty.Content>
				<Empty.Media variant="icon"><Icon name="mic" /></Empty.Media>
				{#if nowEntry}
					<Empty.Title>Nobody's up next</Empty.Title>
					<Empty.Description>
						{nowSinger?.displayName ?? 'Someone'} is finishing up. Add a song and you are next.
					</Empty.Description>
				{:else}
					<Empty.Title>Nothing queued yet</Empty.Title>
					<Empty.Description>Find a song on the Sing tab and it lands here.</Empty.Description>
				{/if}
				<Button href="/" size="block">Find a song</Button>
			</Empty.Content>
		</Empty.Root>
	{/if}
</main>

<!-- ONE polite region for both the queue's own announcements and the reorder results, `aria-atomic` so a fast
	sequence of moves replaces rather than queues. Visually hidden; `reorder-note` above is the sighted half. -->
<div class="sr-live" role="status" aria-live="polite" aria-atomic="true">{liveMsg}</div>

<style>
	main {
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
		/* The dock is fixed, so this column reserves it in normal flow. --dock-h is the root layout's MEASURED height
		   of `.dock`, published as ONE inline custom property on :root; a surface with no chrome falls back to 0,
		   because the layout's teardown removes it. Not token arithmetic — app.css records that attempt failing. */
		padding-block-end: calc(var(--dock-h, 0px) + var(--space-4xl));
	}

	.now {
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
		padding: var(--space-2xl);
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--card-tint);
		box-shadow:
			var(--shadow-sm),
			inset 0 1px 0 var(--edge-hi);
	}

	/* The SECTION register, matching `.grouphead` — this is a label over a block, not a field label. */
	.now-eyebrow {
		margin: 0;
		font-size: var(--ph-text-xs);
		font-weight: 600;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--accent-ink);
	}

	.now-title {
		margin: 0;
		font-size: var(--ph-text-xl);
		font-weight: 700;
		line-height: var(--lh-tight);
		color: var(--ink);
	}

	.now-by {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		margin: 0;
		min-width: 0;
		font-size: var(--ph-text-md);
		color: var(--ink);
	}

	.artist {
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		color: var(--ink-dim);
	}

	.dot {
		flex: 0 0 var(--space-md);
		width: var(--space-md);
		height: var(--space-md);
		border-radius: var(--radius-pill);
	}

	.facts {
		display: flex;
		align-items: center;
		gap: var(--space-2xs);
		margin: 0;
		font-size: var(--ph-text-sm);
		color: var(--ink-dim);
	}

	.clock {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-md);
		margin: 0;
		font-size: var(--ph-text-sm);
		/* Tabular figures, or the elapsed readout reflows every second as digit widths change. */
		font-variant-numeric: tabular-nums;
		color: var(--ink-dim);
	}

	.elapsed {
		font-weight: 700;
		color: var(--ink);
	}

	.k-sound {
		font-weight: 700;
		color: var(--ink);
	}

	.ctl {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-md);
	}

	/* No `.ctl-lab` rule any more: the key row's label wears app.css's `.control-label`, which declares this dress
	   once for the whole app. See the note in the markup. */

	.keys {
		display: flex;
		gap: var(--space-xs);
	}

	.reorder-note {
		margin: 0;
		font-size: var(--ph-text-sm);
		color: var(--warn);
	}

	/* Visually hidden but still in the a11y tree: `display: none` and `visibility: hidden` both remove it from the
	   tree entirely, so the announcement would never be made. */
	.sr-live {
		position: absolute;
		width: 1px;
		height: 1px;
		margin: -1px;
		padding: 0;
		border: 0;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}

	/* A quiet trailing link, deliberately not a Button: it leaves the card rather than acting on it, and an
	   --accent fill here would compete with the transport in the strip a few pixels below. */
	.more {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-xs);
		min-height: var(--tap);
		font-size: var(--ph-text-md);
		font-weight: 500;
		color: var(--accent-ink);
		text-decoration: none;
	}

	.grouphead {
		margin: var(--space-2xl) 0 0;
		font-size: var(--ph-text-xs);
		font-weight: 600;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--ink-dim);
	}
</style>
