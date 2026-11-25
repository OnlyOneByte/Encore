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
	import { afterNavigate } from '$app/navigation';
	import { navigating } from '$app/state';
	import {
		SINGER_COLORS,
		canRetryPlay,
		songDisplay,
		isPlayable,
		hasGuidingTrack,
		effectiveGuideLevel,
		soundingKeyLabel,
		type QueueEntry,
		type Media,
		type PublicSinger,
		type PlaybackState,
		type MediaStatus
	} from '$lib/contract';
	import { room } from '$lib/stores/room';
	import type { RoomStatus } from '$lib/stores/room';
	import { queueCardKind, nextPlayableEntryId, entryPlayable, waitingTurns, type MakerVerdicts } from '$lib/readiness';
	import { resolve } from '$app/paths';
	import { pickAnotherHref } from '$lib/process-and-queue';
	import type { QueueStore } from '$lib/stores/queue';
	import { getContext, tick, untrack } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import {
		gripVisible,
		liveSortTarget,
		keyboardMoveTarget,
		ordinal,
		modeInvalidation,
		rowShift,
		orderKept,
		rowNumbers
	} from '$lib/reorder-mode';
	import { focusGrip, measureCarriedRowHeight, measureRowBoxes, trackDragPointer } from '$lib/queue-drag';
	import { queueAnnouncement } from '$lib/phrasing/queue-announcement';
	import { tuneLine } from '$lib/song-facts';
	import { drawPosition, secondTicker } from '$lib/playhead';
	import { formatClock, formatRemaining } from '$lib/clock';
	import RoomPending from '$lib/components/RoomPending.svelte';
	import SkeletonRows from '$lib/ui/SkeletonRows.svelte';
	import QueueRow from '$lib/components/QueueRow.svelte';
	import ProcessingCard from '$lib/components/ProcessingCard.svelte';
	import OnDeckCard from '$lib/components/OnDeckCard.svelte';
	import { deckEntryOf, notYetTarget, minutesLeft, buzzOnce, HEADS_UP_SEC } from '$lib/on-deck';
	import { cardScrollTarget, firstTimeFor, guestIsDriving } from '$lib/card-to-you';
	import { rememberKey } from '$lib/stores/remembered-key';
	import { liveTune } from '$lib/live-tune.svelte';
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import { DIDNT_PLAY, onDeckHeldNote } from '$lib/phrasing/turn-phrasing';
	import Icon from '$lib/ui/Icon.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Empty from '$lib/components/ui/empty';
	import { toast } from 'svelte-sonner';
	import { isHostPhone } from '$lib/stores/host';
	import type { TransportControls } from '$lib/transport-controls';

	/* Mirrored from the link, and ONLY the fields this page renders — the documented rule, because a component that
	   mirrors more than it renders re-runs on changes that cannot affect it. The root layout mirrors a strictly
	   narrower set (the strip's nine), so neither borrows the other's shape. */
	let me = $state<PublicSinger | null>(null);
	let status = $state<RoomStatus>('checking');
	let entries = $state<QueueEntry[]>([]);
	let singers = $state<Map<string, PublicSinger>>(new Map());
	let mediaCatalog = $state<Map<string, Media>>(new Map());
	let awaySingers = $state<Set<string>>(new Set());
	/** The entry the On deck hold protects (`room.heldId`), or null. */
	let heldId = $state<string | null>(null);
	/** The room's maker verdicts (`queue:sync`): with no maker, no card says "Making karaoke…" (#1255 review). */
	let verdicts = $state<MakerVerdicts>({ canMake: true, canFetch: true });
	let mediaStatus = $state<Map<string, { status: MediaStatus; pct: number; etaSec?: number; unservable?: boolean }>>(
		new Map()
	);
	let playback = $state<PlaybackState>({
		currentEntryId: null,
		isPlaying: false,
		positionSec: 0,
		keyShift: 0,
		guideLevel: null,
		background: null
	});
	/* TWO OF `playback`'s FIELDS ARE ALSO MIRRORED AS SCALARS, and that is not redundancy — it is the fix for a clock
	   that jumped backwards every 15 seconds. `room.playback` is a plain object on a plain class, and Svelte's
	   `proxy()` has no identity cache, so `playback = room.playback` mints a NEW proxy on every room emit: the
	   assignment is ALWAYS a change even when every field is identical. The client heartbeat is 15s and the server
	   answers every `hello` with `playback:state`, so an idle phone re-ran the anchor effect — and re-anchored its own
	   clock to the same stale position — four times a minute. An equal PRIMITIVE notifies nothing, which is why the
	   root layout's scalar mirror never had this problem and why these two must not be "simplified" back into the
	   object read. The object mirror stays for `currentEntryId`, `keyShift` and `guideLevel`, which no effect anchors. */
	let positionSec = $state(0);
	let isPlaying = $state(false);
	let roomGuideDefault = $state(0);
	let pendingKind = $state<Map<string, 'add' | 'move'>>(new Map());
	/* THE SERVER HAS HANDED US A FULL LIST — not "the store exists", which is true before the socket opens. The
	   polite region below diffs successive lists, and an empty pre-socket list looks exactly like an empty queue, so
	   without this the first real sync read as N additions. See `QueueStore.synced`. */
	let queueSynced = $state(false);
	let playbackSynced = $state(false);
	/* Removal goes through the QueueStore, NOT `room.command`: the player commands are the transport, and the queue
	   owns its own optimistic add/remove/move bookkeeping (`pendingKind` above is the store's). */
	let store = $state<QueueStore | undefined>(undefined);

	/** The host's "Show the night", offered only once nothing is on or queued. The server checks both again. */
	let host = $state(false);
	let showingNight = $state(false);
	onMount(() => void isHostPhone().then((yes) => (host = yes)));
	async function showNight() {
		showingNight = true;
		try {
			const res = await fetch('/api/host/tonight', { method: 'POST' });
			if (res.ok) toast.success('The night is on the TV');
			else
				toast.error(
					((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "Couldn't show the night"
				);
		} catch {
			toast.error("Couldn't reach Encore. Try again.");
		} finally {
			showingNight = false;
		}
	}

	onMount(() => {
		const sync = () => {
			me = room.me ?? null;
			status = room.status;
			entries = room.entries;
			singers = room.singers;
			mediaCatalog = room.mediaCatalog;
			awaySingers = room.awaySingers;
			heldId = room.heldId;
			mediaStatus = room.mediaStatus;
			verdicts = room.verdicts;
			playback = room.playback;
			positionSec = room.playback.positionSec;
			isPlaying = room.playback.isPlaying;
			roomGuideDefault = room.roomGuideDefault;
			pendingKind = room.pendingKind;
			store = room.queue;
			queueSynced = room.queue?.synced ?? false;
			playbackSynced = room.playbackSynced;
		};
		sync();
		// A queue op's refusal reaches the guest through the root layout's one `room.onError` sink.
		return room.subscribe(sync);
	});

	const queued = $derived(entries.filter((e) => e.status === 'queued').sort((a, b) => a.rotationSeq - b.rotationSeq));
	// The room's maker verdict, from the fold the TV lobby and the strip read, so a stalled card agrees with both.
	const noMaker = $derived(
		waitingTurns(
			queued,
			(id) => mediaCatalog.get(id),
			(id) => mediaStatus.get(id),
			verdicts.canMake
		).noMaker
	);
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
	// Pause, restart and skip live on the Now card, not the dock (redesign step 4, an owner ruling).
	const tp = getContext<TransportControls>('transport');
	// One filled next step per screen: while the sheet is up for a held turn, that row's own pair goes quiet.
	const didntPlayFor = getContext<(() => string | null) | undefined>('didntPlayFor');
	const nowMedia = $derived(nowEntry ? mediaCatalog.get(nowEntry.mediaId) : undefined);
	const nowDisplay = $derived(songDisplay(nowMedia));
	const nowTitle = $derived(nowDisplay.title || nowMedia?.title || 'Untitled');
	const nowDurationSec = $derived(nowMedia?.durationSec ?? 0);
	const nowSinger = $derived(nowEntry ? singers.get(nowEntry.singerId) : undefined);

	/* The live key and guide on the playing song, shared with the You're up flood ($lib/live-tune): an optimistic key
	   draft that only moves when the command left, cleared when the room agrees or the song changes. */
	const tune = liveTune(() => ({
		entryId: nowEntry?.id ?? null,
		mediaId: nowEntry?.mediaId ?? null,
		mine: !!nowEntry && nowEntry.singerId === me?.id,
		serverKey: playback.keyShift
	}));
	const keyShift = $derived(tune.keyShift);
	const stepKey = tune.stepKey;
	// Two different stem requirements, so a song can offer ±key without offering a guiding track.
	const keyShiftEnabled = $derived(!!nowMedia && isPlayable(nowMedia));
	const guideEnabled = $derived(!!nowMedia && hasGuidingTrack(nowMedia));
	const guideServerPct = $derived(
		Math.round(effectiveGuideLevel({ guideLevel: playback.guideLevel }, roomGuideDefault) * 100)
	);

	// Only the singer's phone tunes the playing song; every other phone reads it as one line.
	const nowMine = $derived(!!nowEntry && nowEntry.singerId === me?.id);
	const nowTune = $derived(tuneLine(playback.keyShift, guideServerPct, guideEnabled));

	/* Once a second, not a frame. BOTH READS STAY INSIDE THE EFFECT: a resume re-delivers an equal `positionSec`,
	   and writing an equal primitive notifies nothing, so a separate anchor effect would never re-run — the
	   documented hazard this tree has shipped twice.
	   THE TWO READS ARE THE SCALAR MIRRORS, never `playback.positionSec`/`playback.isPlaying`. Reading them off the
	   mirrored OBJECT made this effect re-run on every room emit, because the object mirror mints a fresh proxy per
	   assignment — see the note on the mirrors above. The hazard the one-effect shape defends is untouched: a real
	   position change still re-runs it and re-arms the ticker. */
	let displayPos = $state(0);
	$effect(() => {
		const anchor = positionSec;
		const anchoredAtMs = performance.now();
		const playing = isPlaying;
		displayPos = anchor;
		return secondTicker(playing, () => {
			displayPos = drawPosition({ positionSec: anchor, playing, anchoredAtMs, nowMs: performance.now() });
		});
	});
	/* NEITHER HALF OF THE CLOCK MAY PASS THE END OF THE SONG. `drawPosition` extrapolates from the last anchor with no
	   duration term, so once nothing re-anchors (the display stopped reporting, or the socket died) the elapsed figure
	   ran on past the song's length while `formatRemaining` pinned at −0:00, and the two halves of one readout
	   disagreed. Clamped HERE rather than inside `drawPosition`: that function also feeds the TV lyrics reel and the
	   layout's transport ring, which have the same unbounded term but are other surfaces' business. An unknown length
	   is 0, and clamping to 0 would freeze the clock, so the cap only applies when there is a length to cap to. */
	const drawnPos = $derived(nowDurationSec > 0 ? Math.min(displayPos, nowDurationSec) : displayPos);

	// THE GUIDE is Off / Low / Full (GuideSegments): one pick, one command naming the song (`tune.guidePick`).
	const guidePick = tune.guidePick;

	/* REORDERING, MOVED VERBATIM FROM THE HOME PAGE rather than re-derived. It is a live sort with no mode:
	   `liveSortTarget` both places the rows and decides the commit, so a release cannot land somewhere the guest did
	   not see, and the single-pointer alternative (SC 2.5.7 / 2.1.1) is Arrow Up/Down on the grip. See
	   $lib/reorder-mode. The queue is this page's subject now, so the machinery lives where its rows do — leaving it
	   on a page that no longer renders a queue is how a reorder quietly stops working. */
	let liveMsg = $state('');
	let announcedIds: string[] | null = null;
	$effect(() => {
		/* NOTHING IS A BASELINE UNTIL THE SERVER HAS SENT A LIST, and this guard is ahead of every read and write of
		   `announcedIds` for that reason. `queueAnnouncement` is silent with a null baseline precisely so that joining
		   a busy room does not read the whole queue aloud — and this caller used to defeat it: the effect ran before
		   the socket's first `queue:sync` with `queued` empty, announced nothing (correctly), and then SEEDED the
		   baseline as `[]`. The first real sync then diffed the whole room against `[]`, which `queueAnnouncement`
		   quite correctly reports as N additions — measured against a 267-entry room, `.sr-live` read "267 songs
		   added to the queue" at 0.4s, 1.2s and 2.4s after every cold load, which is a mutation into an
		   already-registered polite region and so really is spoken. Gating on the store merely EXISTING would not help: `room.queue` is
		   constructed before the socket opens, which is the window that seeded the empty baseline. And the first
		   synced list is the baseline even when it is empty — seeding from the first NON-empty list instead would
		   swallow the first add in a room that really was empty. */
		if (!queueSynced) return;
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
	/** The note is the hold's sentence, which is nobody's fault, rather than a "nothing was moved". */
	let noteIsHold = $state(false);
	/** The grip the gesture began on, so focus can be returned to it. */
	let openerEl: HTMLElement | null = null;
	let dragTeardown: (() => void) | null = null;

	/** Where the dragged row currently sits, which is both what the list renders and what a release commits. */
	const dragFrom = $derived(movingId ? queuedIdx(movingId) : -1);
	/* ON DECK IS HELD (proposal 14): while its On deck card shows, the server refuses anyone but its owner a reorder that
	   moves that entry or lands a row in front of it (hub.ts `entryOpRefusal`). Which entry is held is the link's
	   `heldId`, the shared rule the server uses. So that row has no handle here unless it is mine, and a row behind it
	   stops one below it — the drop lands where the guest saw it. */
	const pinnedId = $derived(heldId && queued.find((x) => x.id === heldId)?.singerId !== me?.id ? heldId : null);
	const pinnedIdx = $derived(pinnedId ? queuedIdx(pinnedId) : -1);
	/** The highest slot the row at `from` may take. A row in front of the held one may still go anywhere. */
	function floorFor(from: number): number {
		return pinnedIdx >= 0 && from > pinnedIdx ? pinnedIdx + 1 : 0;
	}
	/** "Theo's on deck. Ana goes right after." — said when the hold is what stopped this move. */
	function heldNoteFor(movedId: string): string {
		const name = (id: string | undefined) => (id && singers.get(id)?.displayName) || 'Someone';
		const moved = queued.find((e) => e.id === movedId);
		return onDeckHeldNote(name(queued[pinnedIdx]?.singerId), moved?.singerId === me?.id ? null : name(moved?.singerId));
	}
	const dragGeometry = $derived({ fromIndex: dragFrom, offsetPx: dragY, rowBoundsPx: rowBounds, count: queued.length });
	const dragTo = $derived(
		dragging && dragFrom >= 0 ? liveSortTarget({ ...dragGeometry, minIndex: floorFor(dragFrom) }) : -1
	);
	/** One numbering for every row kind: a held turn takes no number, and the rest are numbered as the TV will play them. */
	const seqs = $derived(
		rowNumbers(
			queued.map((e) => !!e.playFailed),
			dragFrom,
			dragTo
		)
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
		const floor = floorFor(from);
		const to = keyboardMoveTarget(from, delta, queued.length, floor);
		if (to === null) {
			// Stopped by the hold rather than by the top of the list: say why, as a release there does.
			if (from + delta >= 0 && from + delta < floor) {
				reorderNote = liveMsg = heldNoteFor(id);
				noteIsHold = true;
			}
			return;
		}
		// The number the row will SHOW, from the same source as the screen: a held turn above takes none, so the raw
		// index said "2nd" over a row numbered 1. Read before the commit, while `queued` is still in the old order.
		const shown = rowNumbers(
			queued.map((e) => !!e.playFailed),
			from,
			to
		)[from]!;
		commitMove(id, to);
		liveMsg = `Moved to ${ordinal(shown)} in the queue.`;
		// After the patch lands, because the row's DOM is recreated at its new position.
		void tick().then(() => focusGrip(id));
	}

	/** End the gesture. `commit` false for a cancel or an invalidation — those commit NOTHING. */
	function endDrag(commit: boolean, note = '') {
		const id = movingId;
		const to = dragTo;
		// Where the guest reached for, with no hold: further up than `to` means the hold stopped the drop.
		const reached = to >= 0 ? liveSortTarget(dragGeometry) : -1;
		const held = commit && id !== null && !note && reached < to;
		if (held) note = heldNoteFor(id);
		noteIsHold = held;
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
			// A held drop DID commit, and the queue's own "Queue reordered" for it lands first: the reason says more.
			if (note) liveMsg = note;
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
		// `rowBounds.length` only while dragging: it is the count the boxes were measured at, and it is empty
		// except during a gesture, so passing it outside one would invalidate nothing and read as a bug.
		const reason = modeInvalidation(
			queued,
			movingId,
			entries.find((e) => e.id === movingId)?.status,
			dragging ? rowBounds.length : null
		);
		if (reason) endDrag(false, reason);
	});

	/** THE RETRY ON A STALLED OR FAILED CARD — every card nothing is making karaoke for. A failed one is the case the
	 * "try again" notice names, so leaving it without the control sent the guest looking for a button. The turn is already in the rotation, so this asks for the PROCESS alone.
	 *
	 * NOT THROUGH `processAndQueue`, and that is the one place this could have looked tidier and been worse. That
	 * function pairs an ADD with a process; here the turn exists by construction — this is only reachable from a
	 * card inside `{#each queued}` — which is exactly its `hasQueuedTurn` branch, i.e. the process alone. Calling
	 * it with a no-op queue step would add a dead argument and a reader's doubt about whether a second turn lands.
	 *
	 * THE TURN IS NEVER ROLLED BACK by what follows: `requestProcess` clears only its own optimistic status mark on
	 * a refusal. A refused retry leaves the guest exactly where they were, holding a turn and a stalled card. */
	function retryKaraoke(mediaId: string) {
		// Same 12ms as the Sing tab's own process action — this is the same expensive action, so it answers the
		// same way. The DOM read stays here; `RoomLink` holds no DOM.
		if (navigator.vibrate) navigator.vibrate(12);
		void room.requestProcess(mediaId);
	}

	/* ON DECK: MY entry is what plays next, while someone else's song is on (`deckEntryOf`). The key and guide go onto
	   the ENTRY (`set-entry-prefs`), which the server applies when the song starts — through the queue store, so the
	   change is optimistic and survives a dropped socket like any other queue op. */
	const deckEntry = $derived(deckEntryOf(queued, nextPlayableId, nowEntry?.singerId, me?.id));
	const deckRemain = $derived(nowDurationSec > 0 ? Math.max(0, nowDurationSec - drawnPos) : null);
	const deckHeadsUp = $derived(!!deckEntry && deckRemain !== null && deckRemain <= HEADS_UP_SEC);
	$effect(() => {
		if (deckHeadsUp && deckEntry) buzzOnce(deckEntry.id, navigator.vibrate?.bind(navigator));
	});

	/* YOUR CARD COMES TO YOU (proposal 13). When your queued song's card turns failed and its first control sits under
	   the dock, the page scrolls that card up to just below the sticky header. (Your On deck card needs none of this
	   since redesign step 5b: it is the first thing on the page.) Once per
	   entry, only your own card, smooth or instant under reduced motion, and never within CARD_SCROLL_QUIET_MS of
	   the guest's own touch, wheel or key: a scroll is not a layout shift, but it must not fight a thumb. The failed
	   card is found by its index among `.qrow`, which renders `queued` in order (see the list below). */
	const myFailedIdx = $derived(
		queued.findIndex(
			(e) =>
				e.singerId === me?.id &&
				queueCardKind(mediaCatalog.get(e.mediaId), mediaStatus.get(e.mediaId), verdicts.canMake) === 'failed'
		)
	);
	let lastInputMs: number | null = null;
	$effect(() => {
		const mark = () => (lastInputMs = performance.now());
		const kinds = ['pointerdown', 'touchstart', 'wheel', 'keydown'] as const;
		for (const k of kinds) window.addEventListener(k, mark, { capture: true, passive: true });
		return () => {
			for (const k of kinds) window.removeEventListener(k, mark, { capture: true });
		};
	});
	/* NOT BEFORE THE ARRIVAL HAS SETTLED: on a client-side navigation to /queue, SvelteKit resets the scroll to the
	   top after this page mounts, which cancels a smooth scroll started at mount (measured: target computed, page
	   left at 0). `afterNavigate` runs once that is done.
	   AND NOT ONLY THEN: since #996 the root layout renders this page only once /api/me answers, so on a hard load
	   (a reload, or a phone tab the browser discarded while it slept) the page mounts after SvelteKit's first
	   navigation has finished and its scroll reset has run, and `afterNavigate` never fires for it. A mount with no
	   navigation in flight has already arrived. */
	let arrived = $state(false);
	afterNavigate(() => (arrived = true));
	onMount(() => {
		if (!navigating.to) arrived = true;
	});
	$effect(() => {
		if (!arrived) return;
		const failed = queued[myFailedIdx];
		if (failed && firstTimeFor(failed.id))
			void tick().then(() => bringUp(document.querySelectorAll('.qrow')[myFailedIdx]));
	});
	async function bringUp(card: Element | null | undefined): Promise<void> {
		const control = card?.querySelector('button');
		if (!card || !control) return;
		/* GEOMETRY AFTER ANY SETTLE. A card that needs you can turn up in the frame the Now card changes, while the list
		   under it is still held by a transform easing home; a rect read then is off by the hold's distance. So wait for
		   every animation on the card or anything holding it, then read. Under reduced motion there is none to wait for. */
		const holding = document
			.getAnimations()
			.filter((a) => a.effect instanceof KeyframeEffect && !!a.effect.target?.contains(card))
			// An endless one (a pulse) never finishes and moves nothing the target depends on.
			.filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
		await Promise.allSettled(holding.map((a) => a.finished));
		if (!card.isConnected || guestIsDriving(lastInputMs, performance.now())) return;
		const root = getComputedStyle(document.documentElement);
		const top = cardScrollTarget({
			cardTop: card.getBoundingClientRect().top,
			controlBottom: control.getBoundingClientRect().bottom,
			headerBottom: document.querySelector('.page-header')?.getBoundingClientRect().bottom ?? 0,
			dockTop: document.querySelector('.dock')?.getBoundingClientRect().top ?? window.innerHeight,
			scrollY: window.scrollY,
			gap: parseFloat(root.getPropertyValue('--space-sm')) || 0
		});
		if (top === null) return;
		const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
		window.scrollTo({ top, behavior: still ? 'instant' : 'smooth' });
	}
	const deckNotYet = $derived(
		deckEntry
			? notYetTarget(queued, deckEntry.id, (e) =>
					entryPlayable(mediaCatalog.get(e.mediaId), mediaStatus.get(e.mediaId))
				)
			: null
	);
	function notYet() {
		if (!deckEntry || !deckNotYet) return;
		store?.notYet(deckEntry.id, deckNotYet.toIdx);
		if (navigator.vibrate) navigator.vibrate(8);
	}

	/* YOUR CARD, ONE BOX (redesign step 5, #1154): On deck becomes You're up in the same card instance. The queue patch
	   that starts your song lands a frame before playback names it, so an entry of yours already `playing` is up too:
	   for that frame the card shows its preset rather than leaving and jumping the list under it. */
	const upEntry = $derived(nowMine ? nowEntry : entries.find((e) => e.status === 'playing' && e.singerId === me?.id));
	const spotEntry = $derived(upEntry ?? deckEntry);
	const spotMedia = $derived(spotEntry ? mediaCatalog.get(spotEntry.mediaId) : undefined);
	const spotDisplay = $derived(songDisplay(spotMedia));
	/* Live only once playback names your song. Until then (On deck, and the bridging frame) the keys and guide set the
	   entry's own preset, so they stay enabled through the handoff. */
	const spotLive = $derived(!!upEntry && nowMine);
	const spotKey = $derived(spotLive ? keyShift : (spotEntry?.keyShift ?? 0));
	const spotGuideLevel = $derived(
		effectiveGuideLevel(
			{ guideLevel: spotLive ? playback.guideLevel : (spotEntry?.guideLevel ?? null) },
			roomGuideDefault
		)
	);
	function spotKeyTo(next: number) {
		if (spotLive) return stepKey(next - keyShift);
		if (!spotEntry) return;
		store?.setEntryPrefs(spotEntry.id, next, spotEntry.guideLevel ?? null);
		rememberKey(spotEntry.mediaId, next);
	}
	function spotGuide(level: number): boolean {
		if (spotLive) return guidePick(level);
		if (!spotEntry || !store) return false;
		store.setEntryPrefs(spotEntry.id, spotKey, level);
		return true;
	}

	/* THE PAGE HOLDS STILL WHEN A SONG STARTS OR ENDS. Your card, the Now row and the list are all blocks of `.below`,
	   so the holds below keep each where it was drawn and ease it home. The Now row ARRIVING fades in once the rows
	   under it have passed through its box (`.arrive`): fading while they pass drew two legible layers of text. Never
	   set under reduced motion, where no `animationend` would clear it. NOT ARMED UNTIL THE PAGE HAS BEEN TOLD: a row
	   that turns up with the first `playback:state` of a hard load came with the page, not with a song starting. */
	let below = $state<HTMLElement | undefined>(undefined);
	// A primitive, so an emit that re-mints the same entry re-runs neither effect (and forces no layout read).
	const nowId = $derived(nowEntry?.id ?? null);
	let nowArrived = $state(false);
	const reducedMotion = new MediaQuery('prefers-reduced-motion: reduce', false);
	let arriveFor: string | null | undefined;
	$effect(() => {
		const id = nowId;
		if (!queueSynced || !playbackSynced || arriveFor === undefined) {
			arriveFor = queueSynced && playbackSynced ? id : undefined;
			return;
		}
		if (id === arriveFor) return;
		// The last Skip takes the row and its keys away, and focus with them: it goes to the dock's now-line, not <body>.
		if (!id && document.activeElement === document.body) document.querySelector<HTMLElement>('.dock .meta')?.focus();
		if (arriveFor === null) nowArrived = !untrack(() => reducedMotion.current);
		arriveFor = id;
	});

	/* AND THE BLOCKS INSIDE `.below` HOLD STILL TOO (docs/FRONTEND.md § The Queued list holds still). `$effect.pre`,
	   never a ResizeObserver: one fired a frame after the jump had painted. */
	const rowKinds = $derived(
		queued.map((e) => queueCardKind(mediaCatalog.get(e.mediaId), mediaStatus.get(e.mediaId), verdicts.canMake))
	);
	const rowKey = (id: string, kind: string | undefined) => `${id}:${kind === 'plain' ? 'row' : 'card'}`;
	// Everything that can change a block's height or the list's membership, as one primitive: an equal emit runs nothing.
	const holdKey = $derived(
		[deckEntry?.id, upEntry?.id, deckHeadsUp, noMaker]
			.concat(
				queued.map((e, i) => `${e.id}:${rowKinds[i]}:${mediaStatus.get(e.mediaId)?.status}:${pendingKind.get(e.id)}`)
			)
			.join('|')
	);
	type Hold = { top: number; from: number; turn: 'a' | 'b' | 'done' };
	let holds = $state<Record<string, Hold>>({});
	// Each block's drawn top `t` and layout top `l` (its slot, held or not) before the patch.
	let topsWas: Record<string, { t: number; l: number } | undefined> | null = null;
	let scrollWas = 0;
	// The keys of the rows in the DOM, in order: `queued` is already the next list when the pre effect reads.
	let rowKeys: string[] = [];
	let holdArmed = false;
	// Plain pairs, read and dropped within one patch: nothing here is reactive.
	function blocksOf(box: HTMLElement): [string, Element][] {
		const els: [string, Element][] = [];
		for (const k of ['now', 'grouphead', 'reorder-note', 'empty-slot']) {
			const el = box.querySelector(`:scope > .${k}`);
			if (el) els.push([k, el]);
		}
		box.querySelectorAll('.qrow').forEach((el, i) => rowKeys[i] && els.push([rowKeys[i], el]));
		return els;
	}
	const topIn = (box: HTMLElement, el: Element) => el.getBoundingClientRect().top - box.getBoundingClientRect().top;
	// How far the block's own transform (a hold, a pop) draws its top edge off its layout top.
	const liftOf = (el: Element) => {
		const t = getComputedStyle(el).transform;
		return t === 'none' ? 0 : new DOMMatrix(t).m42;
	};
	$effect.pre(() => {
		void nowId;
		void holdKey;
		scrollWas = window.scrollY;
		const box = untrack(() => below);
		topsWas = box
			? Object.fromEntries(
					blocksOf(box).map(([k, el]) => {
						const t = topIn(box, el);
						return [k, { t, l: t - liftOf(el) }];
					})
				)
			: null;
	});
	$effect(() => {
		void nowId;
		void holdKey;
		const ready = queueSynced && playbackSynced;
		untrack(() => {
			const was = topsWas;
			topsWas = null;
			const prev = rowKeys;
			rowKeys = queued.map((e, i) => rowKey(e.id, rowKinds[i]));
			if (!was) return;
			keepPage(scrollWas);
			const box = below;
			if (!box) return;
			if (!holdArmed || !ready || dragging || reducedMotion.current || !orderKept(idsOf(prev), idsOf(rowKeys))) {
				for (const k in holds) if (holds[k]!.turn !== 'done') holds[k] = HOLD_DONE;
				return;
			}
			const next: typeof holds = {};
			for (const [k, el] of blocksOf(box)) {
				// The list's head is the heading or the empty state, one slot: a swap between them holds like a move.
				const old = was[k] ?? (k === 'empty-slot' ? was.grouphead : k === 'grouphead' ? was['empty-slot'] : undefined);
				if (old === undefined) continue;
				for (const a of el.getAnimations())
					if (a instanceof CSSAnimation && a.animationName.startsWith('hold-')) a.cancel();
				// Its slot now, with no hold: the read still carries the old `top`, which is not rendered away yet.
				const slot = topIn(box, el) - liftOf(el) - (holds[k]?.top ?? 0);
				const hold: Hold = { top: old.l - slot, from: old.t - old.l, turn: holds[k]?.turn === 'a' ? 'b' : 'a' };
				if (Math.abs(hold.top) >= 0.5 || Math.abs(hold.from) >= 0.5) next[k] = hold;
				else if (holds[k]) next[k] = HOLD_DONE;
			}
			holds = next;
		});
		holdArmed = ready;
	});
	const idsOf = (keys: string[]) => keys.map((k) => k.slice(0, k.lastIndexOf(':')));
	// The glide is over: the old slot and the hold's animation go in one frame, which counts no shift. `done`, not
	// deleted: dropping `data-hold` hands the row's `animation` back to `.pop-in`, which would replay its entrance.
	const HOLD_DONE: Hold = { top: 0, from: 0, turn: 'done' };
	function endHold(ev: AnimationEvent): void {
		if (!below || !ev.animationName.startsWith('hold-')) return;
		for (const [k, el] of blocksOf(below)) if (el === ev.target && holds[k]) holds[k] = HOLD_DONE;
	}

	/* A PAGE THAT GOT SHORTER AT THE BOTTOM KEEPS ITS HEIGHT. A guest scrolled to the bottom when a card got shorter
	   (failed 137 → making 109 → ready 69 px) saw the whole column slide down twice, because the browser clamps the
	   scroll to the shorter page, and CLS never counted it. So when a patch would clamp, `main` keeps a `min-height`
	   that leaves the scroll where it was, and it drops once the guest scrolls up past the extra space (`keptMax`, the
	   page's own maximum then) or the next patch no longer needs it. Not motion, so reduced motion keeps it too.
	   Written onto the node, not rendered: it has to be measured and the scroll put back in this same frame. `main`'s
	   other inline property is a `style:` directive for that reason, which Svelte writes one property at a time. */
	let page = $state<HTMLElement | undefined>(undefined);
	let keptMax: number | null = null;
	function keepPage(y: number): void {
		if (!page) return;
		page.style.minHeight = '';
		const max = document.documentElement.scrollHeight - window.innerHeight;
		keptMax = y > max + 1 ? max : null;
		if (keptMax === null) return;
		page.style.minHeight = `${page.offsetHeight + y - max}px`;
		if (window.scrollY !== y) window.scrollTo({ top: y, behavior: 'instant' });
	}
	$effect(() => {
		const release = () => {
			if (keptMax === null || window.scrollY > keptMax) return;
			keptMax = null;
			if (page) page.style.minHeight = '';
		};
		window.addEventListener('scroll', release, { passive: true });
		return () => window.removeEventListener('scroll', release);
	});

	const mediaTitleOf = (id: string) => songDisplay(mediaCatalog.get(id)).title || 'Untitled';
	// The moved block calls this name; home spelled it `mediaTitle`.
	const mediaTitle = mediaTitleOf;
</script>

<svelte:head><title>Queue · Encore</title></svelte:head>

<!-- THE JOIN GATE, the idiom `/` and `/library` already use — this was the one tab route rendering its body
	unconditionally. An unjoined visitor (a shared or bookmarked /queue link, a second device, private browsing, a
	guest who tapped Leave) got `/api/me` 401, a room store settled at `guest` with no socket, and an empty entry
	list — which this route's own `{:else}` arm then reported as an empty QUEUE: "Nothing queued yet. Find a song on
	the Sing tab" over a room with hundreds of songs in it, pointing at a tab bar that is not rendered, because the
	dock belongs to a joined singer. `JoinLanding` reads `?room=` itself, so a guest who arrived holding the code
	lands on the identity pane instead of being asked to retype it.
	THE LANDING IS FOR `not-joined` ONLY, the settled read on the shared link that all three tabs gate on. Keyed on
	`me`, it flashed on every cold load and stayed for good when /api/me failed for any reason; until the link has an
	answer the tab shows its own grey rows (`RoomPending`). -->
{#if me}
	<PageHeader title="Queue" icon="clock" />

	<!-- `--row-h` is the dragged row's measured height, published for the neighbours' transform to read: a
	shifted row slides by exactly one row rather than by a guess. Measured once at press time and 0 otherwise. -->
	<main bind:this={page} style:--row-h="{rowH}px">
		<div class="below" bind:this={below} onanimationend={endHold}>
			<!-- YOUR CARD FIRST, the screen's one lit surface (#1154). ONE {#if}, so On deck turning into You're up is the
			same card with new props, never a remount. -->
			{#if spotEntry}
				<OnDeckCard
					moment={upEntry ? 'up' : 'on-deck'}
					entryId={spotEntry.id}
					title={spotDisplay.title || spotMedia?.title || 'Untitled'}
					artist={spotDisplay.artist}
					profile={spotMedia?.songProfile ?? null}
					keyShift={spotKey}
					guideLevel={spotGuideLevel}
					guideAvailable={spotLive ? guideEnabled : !!spotMedia && hasGuidingTrack(spotMedia)}
					keyAvailable={!spotLive || keyShiftEnabled}
					detailsId={spotMedia?.id ?? null}
					afterName={nowSinger?.displayName}
					timeLeft={minutesLeft(deckRemain)}
					headsUp={deckHeadsUp}
					singerColor={me.color}
					notYetName={deckNotYet ? (singers.get(deckNotYet.singerId)?.displayName ?? 'the next singer') : null}
					onkey={spotKeyTo}
					onguide={spotGuide}
					onnotyet={notYet}
				/>
			{/if}

			{#if nowEntry}
				<!-- THE NOW ROW. Not a `<section aria-label>` duplicating the strip's: the strip above is the persistent
				one, this is the detailed one, and two landmarks with the same name is worse than one. -->
				<div
					class="now"
					class:arrive={nowArrived}
					data-hold={holds.now?.turn}
					style:--hold-top={holds.now ? `${holds.now.top}px` : undefined}
					style:--hold-from={holds.now ? `${holds.now.from}px` : undefined}
					onanimationend={(ev) => {
						if (ev.target === ev.currentTarget && ev.animationName.includes('arrive')) nowArrived = false;
					}}
				>
					<p class="sect">Now</p>
					<!-- THE DOOR TO /song/[mediaId]: the title, underlined as a link, so the row stays one row. -->
					<h2 class="now-title">
						{#if nowMedia?.id}<a href={resolve('/song/[mediaId]', { mediaId: nowMedia.id })}>{nowTitle}</a
							>{:else}{nowTitle}{/if}
					</h2>
					<p class="now-by">
						<span class="dot" style:background={nowSinger?.color ?? SINGER_COLORS[0]}></span>
						{nowSinger?.displayName ?? 'Someone'}
						{#if nowDisplay.artist}<span class="artist"> · {nowDisplay.artist}</span>{/if}
					</p>

					<!-- THE ONE PLACE THE PHONE SPELLS THE CLOCK. The strip above carries only a hairline, because a
				once-a-second percentage announced over a title is noise; here there is room for the real numbers, and
				`drawnPos` is the extrapolated position rather than the last broadcast one so it does not sit still
				between websocket frames, capped at the song's length so it cannot print a time past the end.
				`formatRemaining` omits the estimate rather than zeroing it when the length is unknown. -->
					{#if nowDurationSec > 0}
						<p class="clock">
							<span class="elapsed">{formatClock(drawnPos)}</span>
							<span class="remain">{formatRemaining(drawnPos, nowDurationSec)}</span>
						</p>
					{/if}

					<div class="now-tp" role="group" aria-label="Playback">
						<button class="tp-btn" onclick={tp.restart} aria-label="Restart"><Icon name="restart" /></button>
						<button class="tp-btn primary" onclick={tp.togglePlay} aria-label={isPlaying ? 'Pause' : 'Play'}>
							<Icon name={isPlaying ? 'pause' : 'play'} />
						</button>
						<button class="tp-btn" onclick={tp.skip} aria-label="Skip"><Icon name="next" /></button>
					</div>

					<!-- The song's key and guide as one line, the same for every phone: the singer tunes it on their own card
					above (docs/FRONTEND.md § The Now card). Kept while the song can be tuned, so a tap moves nothing. -->
					{#if keyShiftEnabled || guideEnabled}
						<p class="facts" data-now-tune>
							{#if nowTune}{nowTune}{:else}&nbsp;{/if}
						</p>
					{/if}
				</div>
			{/if}

			{#if queued.length}
				<h2
					class="grouphead"
					data-hold={holds.grouphead?.turn}
					style:--hold-top={holds.grouphead ? `${holds.grouphead.top}px` : undefined}
					style:--hold-from={holds.grouphead ? `${holds.grouphead.from}px` : undefined}
				>
					Later
				</h2>
				<!-- Not mode chrome: a drag invalidated mid-flight has to say why, visibly as well as announced. -->
				{#if reorderNote}
					<p
						class={['reorder-note', { held: noteIsHold }]}
						data-hold={holds['reorder-note']?.turn}
						style:--hold-top={holds['reorder-note'] ? `${holds['reorder-note'].top}px` : undefined}
						style:--hold-from={holds['reorder-note'] ? `${holds['reorder-note'].from}px` : undefined}
					>
						{reorderNote}
					</p>
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
					{@const live = mediaStatus.get(e.mediaId)}
					{@const card = queueCardKind(media, live, verdicts.canMake)}
					<!-- THE GATE IS "NOT PLAIN", NEVER AN ENUMERATION OF KINDS. It read `card === 'processing' || card ===
				'failed'` while those were the only two, and a FIFTH kind added later would fall through this `{:else}` to
				a plain QueueRow — i.e. the bug would survive its own fix while a Playwright assertion on `.proc` kept
				passing. `plain` is the only kind QueueRow owns, so that is the term to test. -->
					{#if card !== 'plain'}
						<!-- THE SAME SIX REORDER PROPS THE ROW BELOW GETS, and they are six rather than one because this route
					used to pass `reorderable` ALONE — a prop ProcessingCard reads only as an extra term in its
					actions-cluster gate, never as the handle's gate, which is `grip`. So the card rendered no handle and
					wired no `ongripdown`/`onnudge`, and a cooking song could not be moved by drag or by arrow key while
					every ready row beside it could. The server imposes no readiness condition on a move (`entryOpRefusal`
					gates `move-to-index` on the entry existing, an integer index and ownership), so a processing entry is
					just a queued entry, which is what both this list's comment above and the card's own "THE GRIP LEADS
					THE ROW" note already assumed. `moving`/`dragY` are not optional extras: `.moving` is the only rule
					that reads `--drag-y`, so without them the picked-up card would not follow the finger.
					`reorderable` IS KEPT, not dropped: it only widens the actions gate, and dropping it would take the
					right-hand cluster off a card that is not the guest's to remove, where QueueRow renders an (empty)
					`Item.Actions` whenever it is not pending. Keeping it means the handle is the only visible change.
					KNOWN COSMETIC COST, so it is not reported as new: `--row-h` is the CARRIED row's one measured
					height, so dragging a tall cooking card shifts its shorter neighbours by a cooking-card height. The
					committed target is unaffected — `liveSortTarget` counts measured row CENTRES — so this is in-gesture
					appearance only. The reverse case already shipped, since `shift` was always passed here. -->
						<!-- `status`/`pct` ARE HANDED OVER AS THEY ARE, with no invented default. This block used to open with
					`{@const proc = mediaStatus.get(e.mediaId) ?? { status: 'failed', pct: 0 }}`, which was dead code only
					because every non-plain kind then required a live status — the moment one of them stopped requiring
					one, that fallback would have silently handed every stranded turn the ran-and-failed copy. The card
					reads these two on its processing kind alone and documents what an absent status means there. -->
						<ProcessingCard
							kind={card}
							seq={seqs[i]!}
							title={mediaTitleOf(e.mediaId)}
							singerName={e.singerId === me?.id ? 'You' : (s?.displayName ?? 'Guest')}
							singerColor={s?.color ?? SINGER_COLORS[0]}
							singerAway={awaySingers.has(e.singerId)}
							status={live?.status}
							pct={live?.pct ?? 0}
							etaSec={live?.etaSec}
							noMaker={noMaker}
							pending={pendingKind.get(e.id) ?? null}
							onretry={card !== 'processing' ? () => retryKaraoke(e.mediaId) : undefined}
							pickAnotherHref={card !== 'processing' && e.singerId === me?.id
								? pickAnotherHref(resolve('/'), e.id)
								: undefined}
							onremove={e.singerId === me?.id ? () => store?.removeEntry(e.id) : undefined}
							grip={gripsVisible && e.id !== pinnedId}
							gripId={e.id}
							moving={movingId === e.id && dragging}
							dragY={movingId === e.id && dragging ? dragY : 0}
							reorderable={gripsVisible}
							shift={rowShift(i, dragFrom, dragTo)}
							hold={holds[rowKey(e.id, card)]}
							ongripdown={(ev) => onGripPointerDown(e, ev)}
							onnudge={(delta) => nudge(e.id, delta)}
						/>
					{:else}
						<!-- `seq` is the LIVE position, never the source index: `rowNumbers` reads the same shift arithmetic that
					places the row, so a number never corrects itself when the patch lands. -->
						<QueueRow
							seq={seqs[i]!}
							held={!!e.playFailed}
							onretry={e.singerId === me?.id && canRetryPlay(e) ? () => store?.retryPlay(e.id) : undefined}
							pickAnotherHref={e.playFailed && e.singerId === me?.id ? pickAnotherHref(resolve('/'), e.id) : undefined}
							quietNext={didntPlayFor?.() === e.id}
							title={mediaTitleOf(e.mediaId)}
							singerName={e.singerId === me?.id ? 'You' : (s?.displayName ?? 'Guest')}
							singerColor={s?.color ?? SINGER_COLORS[0]}
							mine={e.singerId === me?.id}
							singerAway={awaySingers.has(e.singerId)}
							up={e.id === nextPlayableId}
							subtitle={e.playFailed
								? DIDNT_PLAY
								: e.id === deckEntry?.id
									? ''
									: (soundingKeyLabel(media?.songProfile ?? null, e.keyShift ?? 0) ?? '')}
							pending={pendingKind.get(e.id) ?? null}
							removable={e.singerId === me?.id}
							grip={gripsVisible && e.id !== pinnedId}
							gripSlot={gripsVisible && e.id === pinnedId}
							gripId={e.id}
							moving={movingId === e.id && dragging}
							dragY={movingId === e.id && dragging ? dragY : 0}
							shift={rowShift(i, dragFrom, dragTo)}
							hold={holds[rowKey(e.id, card)]}
							ongripdown={(ev) => onGripPointerDown(e, ev)}
							onnudge={(delta) => nudge(e.id, delta)}
							onremove={() => store?.removeEntry(e.id)}
						/>
					{/if}
				{/each}
			{:else if !queueSynced}
				<!-- NOT EMPTY, NOT YET SYNCED: `me` lands before the socket's first `queue:sync`, and the empty state below
			said "Nothing queued yet" over a full queue for that whole window on every cold load. Its box is there from
			the first frame, so nothing shifts; it is only seen past the grace. -->
				<div class="skels-wait"><SkeletonRows count={4} label="Loading the queue…" /></div>
			{:else}
				<!-- TWO EMPTY STATES, not one, because the two situations need different words and the first draft of this
			page gated this on `{:else if !nowEntry}` — which rendered NOTHING in the commonest case of the party
			actually running: a song playing and nobody queued behind it. That is the moment the page most needs to
			ask for a song. Gated on `queued` alone now, because a cooking song IS a queued entry and renders above. -->
				<div
					class="empty-slot"
					data-hold={holds['empty-slot']?.turn}
					style:--hold-top={holds['empty-slot'] ? `${holds['empty-slot'].top}px` : undefined}
					style:--hold-from={holds['empty-slot'] ? `${holds['empty-slot'].from}px` : undefined}
				>
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
							{#if host && !nowEntry}
								<Button
									variant="secondary"
									size="block"
									data-testid="show-night"
									disabled={showingNight}
									onclick={showNight}>Show the night</Button
								>
							{/if}
						</Empty.Content>
					</Empty.Root>
				</div>
			{/if}
		</div>
	</main>

	<!-- ONE polite region for both the queue's own announcements and the reorder results, `aria-atomic` so a fast
	sequence of moves replaces rather than queues. Visually hidden; `reorder-note` above is the sighted half. Inside
	the gate with the list it describes: an unjoined visitor has no queue to announce. -->
	<div class="sr-live" role="status" aria-live="polite" aria-atomic="true">{liveMsg}</div>
{:else if status === 'not-joined'}
	<!-- Loaded on demand, as `/` does: a joined phone never needs the join screen's ~4.6 KB gz of JS. -->
	{#await import('$lib/components/JoinLanding.svelte') then { default: JoinLanding }}
		<JoinLanding />
	{:catch}
		<!-- The chunk can fail on bad wifi or after an update renamed it: never a blank screen. -->
		<main>
			<p>Couldn't load the join screen.</p>
			<Button variant="secondary" size="tap" onclick={() => location.reload()}>Try again</Button>
		</main>
	{/await}
{:else}
	<PageHeader title="Queue" icon="clock" />
	<main><RoomPending unreachable={status === 'unreachable'} /></main>
{/if}

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

	/* A COMPACT NOW ROW, ink on the ground, under your card: the card is the screen's one lit surface. */
	.now {
		display: flex;
		flex-direction: column;
		gap: var(--step-4);
		padding-block: var(--step-8);
	}

	/* Your card, the Now row and the list, one box whose blocks the holds keep still. Same column rhythm as `main`. */
	.below {
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
	}

	/* Held at 0 for one --motion-base (the holds'), so the row is invisible while the rows under it pass through its
	   box, then a --motion-fast fade: 370 ms in all, inside CLAIM 14's 400 (#1092). */
	@media (prefers-reduced-motion: no-preference) {
		.now.arrive {
			animation: arrive var(--motion-fast) ease-out var(--motion-base) backwards;
		}
	}
	@keyframes arrive {
		from {
			opacity: 0;
		}
	}

	/* Tenet 2 (#1090): hidden for PENDING_GRACE_MS (300 ms) from the frame it mounts, so a quick sync never shows it;
	   the list replacing it later is content, never held (#1171). No motion, so not behind reduced motion. */
	.skels-wait {
		animation: skels-wait 0s 0.3s backwards;
	}
	@keyframes skels-wait {
		from {
			visibility: hidden;
		}
	}

	/* A quiet section label in sentence case (the redesign drops the uppercase eyebrows); `.grouphead` matches it. */
	.sect,
	.grouphead {
		margin: 0;
		font-size: var(--ph-text-xs);
		font-weight: 600;
		color: var(--ink-dim);
	}
	/* Over app.css's `.grouphead` eyebrow, which the other tabs still wear. */
	.grouphead {
		margin-top: var(--space-2xl);
		letter-spacing: normal;
		text-transform: none;
	}

	.now-title {
		margin: 0;
		font-size: var(--ph-text-lg);
		font-weight: 700;
		line-height: var(--lh-tight);
		color: var(--ink);
	}
	/* Underlined: for anyone not singing, the only door to the song's page and its lyrics. */
	.now-title a {
		color: inherit;
		text-decoration: underline;
		text-decoration-thickness: 1px;
		text-underline-offset: 3px;
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

	/* THE TRANSPORT: three 44 px keys, and play/pause is the only fill because it is the only one with a state. */
	.now-tp {
		display: flex;
		justify-content: center;
		gap: var(--step-16);
	}
	.tp-btn {
		width: var(--tap);
		height: var(--tap);
		display: grid;
		place-items: center;
		padding: 0;
		border: 0;
		border-radius: var(--round-pill);
		background: none;
		color: var(--role-ink);
	}
	/* --on-accent: the one ink certified on --accent (5.09:1). */
	.tp-btn.primary {
		background: var(--role-accent);
		color: var(--role-on-accent);
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

	.reorder-note {
		margin: 0;
		font-size: var(--ph-text-sm);
		color: var(--warn);
	}
	/* The hold's sentence is nobody's mistake, so it is not dressed as a warning. */
	.reorder-note.held {
		color: var(--ink-dim);
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
</style>
