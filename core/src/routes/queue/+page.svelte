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
		songDisplay,
		isPlayable,
		hasGuidingTrack,
		effectiveGuideLevel,
		soundingKeyLabel,
		type QueueEntry,
		type Media,
		type PublicSinger,
		type PlaybackState,
		type MediaStatus,
		type SongProfile
	} from '$lib/contract';
	import { room } from '$lib/stores/room';
	import type { RoomStatus } from '$lib/stores/room';
	import { queueCardKind, nextPlayableEntryId, entryPlayable } from '$lib/readiness';
	import { createGuideSend } from '$lib/guide-send';
	import type { QueueStore } from '$lib/stores/queue';
	import { tick, untrack } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
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
	import JoinLanding from '$lib/components/JoinLanding.svelte';
	import RoomPending from '$lib/components/RoomPending.svelte';
	import SkeletonRows from '$lib/ui/SkeletonRows.svelte';
	import QueueRow from '$lib/components/QueueRow.svelte';
	import ProcessingCard from '$lib/components/ProcessingCard.svelte';
	import GuidingTrack from '$lib/components/GuidingTrack.svelte';
	import RangeBar from '$lib/components/RangeBar.svelte';
	import OnDeckCard from '$lib/components/OnDeckCard.svelte';
	import { deckEntryOf, notYetTarget, minutesLeft, buzzOnce, HEADS_UP_SEC } from '$lib/on-deck';
	import { cardScrollTarget, firstTimeFor, guestIsDriving } from '$lib/card-to-you';
	import { rememberKey } from '$lib/stores/remembered-key';
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import { NOW_SINGING, onDeckHeldNote } from '$lib/phrasing/turn-phrasing';
	import Icon from '$lib/ui/Icon.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Empty from '$lib/components/ui/empty';

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
	let mediaStatus = $state<Map<string, { status: MediaStatus; pct: number; etaSec?: number }>>(new Map());
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
	/* AN OPTIMISTIC KEY, for the same reason the guiding-track slider below holds `guideDraft`: a control that
	   computes its next value from the last SERVER ECHO loses every tap made before the echo arrives. Both keycaps
	   sent `keyShift ± 1` read off `playback.keyShift`, so five fast taps all computed from the same stale 0 and
	   sent 1, 1, 1, 1, 1 — the key moved one semitone instead of five, and on party latency that is the normal
	   result rather than the unlucky one. Nothing was disabled and nothing was said, so the guest simply mashed.
	   THE WIRE VALUE STAYS ABSOLUTE. The `key` command is idempotent by design — it carries the target, not a
	   delta — and that must not change: a delta protocol would turn a dropped or duplicated message into a key
	   that is permanently wrong, where a repeated absolute is a no-op. So the draft moves the LOCAL view and the
	   command still names where to land.
	   `null` means "no local opinion", which is what lets a key change from the TV or another phone take over
	   immediately rather than being pinned behind this phone's last tap. */
	let keyDraft = $state<number | null>(null);
	/* The draft is dropped the moment the server agrees with it, and when the song on the card changes: the reset
	   effect below, keyed on the entry ID. It can't key on `nowEntry` going null: a skip goes straight from one entry
	   to the next, so it never is, and the next singer's card would show the previous song's "+1" and the next tap
	   would send +2 over their On deck preset. */
	$effect(() => {
		if (keyDraft !== null && playback.keyShift === keyDraft) keyDraft = null;
	});
	const keyShift = $derived(keyDraft ?? playback.keyShift);

	/* ±7 is the range both keycaps already bound themselves to; named once here so the step, the two `disabled`
	   tests and the clamp cannot drift apart. */
	const KEY_LIMIT = 7;
	function stepKey(delta: number): void {
		const next = Math.max(-KEY_LIMIT, Math.min(KEY_LIMIT, keyShift + delta));
		if (next === keyShift) return;
		/* THE DRAFT ONLY MOVES IF THE COMMAND LEFT. Setting it unconditionally was a regression this very wave
		   introduced: with no socket, `command()` silently no-ops, so the keycap showed a shift the server had
		   never heard — and the clearing effect below only fires when the server AGREES with the draft, which
		   offline it never does, so the wrong value stuck indefinitely. Before the draft existed the control was
		   honest by accident (it read the server value and so simply did not move).
		   A player command is fire-and-forget and is NOT resent on resync the way a queue add is, so "dropped"
		   really does mean lost — there is nothing to be optimistic about. */
		// The key is per-song, so it names the song: a tap that lands after a skip must not re-pitch the next one.
		if (!nowEntry) return;
		if (!room.command({ cmd: 'key', semitones: next, entryId: nowEntry.id })) return;
		keyDraft = next;
		// Your own song: this phone remembers the key for the next time you queue it.
		if (nowEntry && nowEntry.singerId === me?.id) rememberKey(nowEntry.mediaId, next);
	}
	// Two different stem requirements, so a song can offer ±key without offering a guiding track.
	const keyShiftEnabled = $derived(!!nowMedia && isPlayable(nowMedia));
	const guideEnabled = $derived(!!nowMedia && hasGuidingTrack(nowMedia));
	const guideServerPct = $derived(
		Math.round(effectiveGuideLevel({ guideLevel: playback.guideLevel }, roomGuideDefault) * 100)
	);

	const facts = $derived(songFacts(profile, keyShift));

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

	/* THE GUIDE'S LOCAL OPINION, and it is `keyDraft`'s shape rather than the `guideDragging` boolean plus a
	   number it replaces. While a finger is on the slider the LOCAL value wins, or the thumb fights the throttled
	   websocket echo — but a drag-scoped flag made the control tell two different lies either side of the release.
	   DURING the drag it showed a level the room had never heard, because the draft moved whether or not the
	   command reached the wire. AT the release it sprang back: `guideDragging = false` fell straight through to
	   the server echo, so even a command that DID land showed the old level for one round trip (docs/UI-REVIEW.md
	   finding C reports the dropped half of that as "reads as the app being broken").
	   One nullable draft fixes both. `null` means "no local opinion", so a guide change from another phone or the
	   TV takes over immediately rather than being pinned behind this phone's last drag, and the draft outlives
	   the release until the room AGREES with it — which is the only event that proves the command landed.
	   The throttle, the trailing send and the drop-on-refusal rule are `$lib/guide-send`, where a bun test can
	   reach them; what stays here is the reactive half. */
	let guideDraft = $state<number | null>(null);
	/* THE ENTRY THE GESTURE BEGAN ON, captured at its first input and held until it commits. Every send of the gesture
	   names it — the throttled ones, the trailing one and the release — so a drag that is still going when the song
	   changes keeps naming the song it started on, and the server drops it as stale instead of moving the next
	   singer's guide over their On deck preset. Reading `nowEntry` at SEND time named the new song. */
	let guideGestureFor = $state<string | null>(null);
	const guidePct = $derived(guideDraft ?? guideServerPct);
	// Dropped the moment the room agrees; the song changing is the reset effect below.
	$effect(() => {
		if (guideDraft !== null && guideServerPct === guideDraft) guideDraft = null;
	});
	const guideSend = createGuideSend({
		send: (pct) => {
			if (!guideGestureFor) return false;
			return room.command({ cmd: 'guide', level: pct / 100, entryId: guideGestureFor });
		},
		// The rest of a drag begun on the last song may not move the new song's readout: it is sent, as stale, and
		// dropped, so it never earns a draft. A drop (`null`) always clears.
		onDraft: (pct) => {
			if (pct === null || guideGestureFor === nowEntry?.id) guideDraft = pct;
		}
	});
	function guideInput(pct: number): void {
		guideGestureFor ??= nowEntry?.id ?? null;
		guideSend.input(pct);
	}
	function guideCommit(pct: number): void {
		guideGestureFor ??= nowEntry?.id ?? null;
		guideSend.commit(pct);
		guideGestureFor = null;
	}

	/* THE SONG CHANGED: both drafts belonged to the last one, and so does a trailing guide send still waiting on the
	   throttle. Keyed on the entry ID, not on `nowEntry` going null, which a skip never passes through. A gesture
	   still in progress keeps its `guideGestureFor`, so the rest of it is sent as stale and dropped. */
	let draftsFor: string | undefined;
	$effect(() => {
		const id = nowEntry?.id;
		if (id === draftsFor) return;
		draftsFor = id;
		keyDraft = null;
		guideDraft = null;
		guideSend.cancel();
	});

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
		commitMove(id, to);
		liveMsg = `Moved to ${ordinal(to + 1)} in the queue.`;
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

	/** THE RETRY ON A STALLED CARD: the turn is already in the rotation, so this asks for the PROCESS alone.
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
	const deckMedia = $derived(deckEntry ? mediaCatalog.get(deckEntry.mediaId) : undefined);
	const deckDisplay = $derived(songDisplay(deckMedia));
	const deckKey = $derived(deckEntry?.keyShift ?? 0);
	const deckRemain = $derived(nowDurationSec > 0 ? Math.max(0, nowDurationSec - drawnPos) : null);
	const deckHeadsUp = $derived(!!deckEntry && deckRemain !== null && deckRemain <= HEADS_UP_SEC);
	$effect(() => {
		if (deckHeadsUp && deckEntry) buzzOnce(deckEntry.id, navigator.vibrate?.bind(navigator));
	});

	/* YOUR CARD COMES TO YOU (proposal 13). When your On deck card turns heads-up, or your queued song's card turns
	   failed, and its first control sits under the dock (at 320x568 the heads-up card starts below the dock's top
	   edge whatever the dock's height), the page scrolls that card up to just below the sticky header. Once per
	   entry, only your own card, smooth or instant under reduced motion, and never within CARD_SCROLL_QUIET_MS of
	   the guest's own touch, wheel or key: a scroll is not a layout shift, but it must not fight a thumb. The failed
	   card is found by its index among `.qrow`, which renders `queued` in order (see the list below). */
	const myFailedIdx = $derived(
		queued.findIndex(
			(e) =>
				e.singerId === me?.id && queueCardKind(mediaCatalog.get(e.mediaId), mediaStatus.get(e.mediaId)) === 'failed'
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
		const wants: { id: string; find: () => Element | null | undefined }[] = [];
		if (deckHeadsUp && deckEntry)
			wants.push({ id: deckEntry.id, find: () => document.querySelector('.deck.heads-up') });
		const failed = queued[myFailedIdx];
		if (failed) wants.push({ id: failed.id, find: () => document.querySelectorAll('.qrow')[myFailedIdx] });
		for (const w of wants) if (firstTimeFor(w.id)) void tick().then(() => bringUp(w.find()));
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
	/* The slider's drag-time value; nothing is sent until release, because nothing is playing it yet. Dropped once
	   the entry agrees, or when the card is for a different entry. */
	let deckGuideDraft = $state<number | null>(null);
	let deckGuideFor: string | undefined;
	const deckGuideServerPct = $derived(
		Math.round(effectiveGuideLevel({ guideLevel: deckEntry?.guideLevel ?? null }, roomGuideDefault) * 100)
	);
	$effect(() => {
		if (deckGuideFor !== deckEntry?.id || deckGuideServerPct === deckGuideDraft) deckGuideDraft = null;
		deckGuideFor = deckEntry?.id;
	});
	function setDeckKey(next: number) {
		if (!deckEntry) return;
		store?.setEntryPrefs(deckEntry.id, next, deckEntry.guideLevel ?? null);
		rememberKey(deckEntry.mediaId, next);
	}
	function setDeckGuide(pct: number) {
		if (!deckEntry) return;
		deckGuideDraft = pct;
		store?.setEntryPrefs(deckEntry.id, deckKey, pct / 100);
	}
	function notYet() {
		if (!deckEntry || !deckNotYet) return;
		store?.notYet(deckEntry.id, deckNotYet.toIdx);
		if (navigator.vibrate) navigator.vibrate(8);
	}

	/* THE PAGE HOLDS STILL WHEN THE CARD COMES OR GOES. The card is the top of the column, so the room's first song
	   pushed everything under it down by the card's height in one frame, and the last one leaving pulled it all back
	   up: CLS about 0.3 each way, with nobody on this phone touching anything. Reserving the slot would leave an empty
	   card on an idle queue, so `.below` is moved in LAYOUT at once and held where it was by a transform in the same
	   frame, which a layout shift does not count, then eased home on --motion-base (`data-settle`).
	   ARRIVING, THE SLOT OPENS FIRST AND THE CARD FADES INTO IT. The content eases down through the card's box, so the
	   card stays at opacity 0 for that --motion-base and fades in on the next one (`.arrive`): fading both at once drew
	   two legible layers of text for about 130 ms. LEAVING IS A CUT ON PURPOSE: the card goes with its entry, and an
	   exit fade would need the card kept in the DOM after its song ended, so the content simply eases up into the gap.
	   This is the one motion here that has to read geometry: the distance is the card's own height, which no token
	   names. Keyed on the entry rather than on "is there a card", so a new song's taller or shorter card eases too.
	   Under reduced motion the CSS does nothing and it is a cut, as every other entrance in the tree is. `nowArrived`
	   says the card's fade is running: never set under reduced motion, where no `animationend` would clear it, and
	   cleared by the fade's own end (not a child's, which bubbles), so a later remount starts from false. */
	let below = $state<HTMLElement | undefined>(undefined);
	// A primitive, so an emit that re-mints the same entry re-runs neither effect (and forces no layout read).
	const nowId = $derived(nowEntry?.id ?? null);
	let belowTopWas: number | undefined;
	$effect.pre(() => {
		void nowId;
		belowTopWas = below?.getBoundingClientRect().top;
	});
	/* Rendered by Svelte rather than written onto the node: a selector on an attribute the template never sets is
	   pruned from the stylesheet as unused. The turn alternates so a second ease restarts without replacing the
	   subtree, which would drop focus and a drag. */
	let settle = $state<{ dy: number; turn: 'a' | 'b' } | null>(null);
	let nowArrived = $state(false);
	const reducedMotion = new MediaQuery('prefers-reduced-motion: reduce', false);
	let settleFor: string | null | undefined;
	$effect(() => {
		const id = nowId;
		/* NOT ARMED UNTIL THE PAGE HAS BEEN TOLD. The card is keyed on `playback`, whose first `playback:state` lands a
		   beat after the first `queue:sync` on a hard load (a reload, a tab the phone discarded). A card that turns up
		   then came WITH the page, not with a song starting, and easing it in held the list where "your card comes to
		   you" read it as already in reach. A reconnect clears `playbackSynced` until its own hello lands, so a song that
		   changed while the phone was away is a fresh baseline too, not a leave and then a first song. */
		if (!queueSynced || !playbackSynced || settleFor === undefined || !below || belowTopWas === undefined) {
			settleFor = queueSynced && playbackSynced ? id : undefined;
			return;
		}
		if (id === settleFor) return;
		if (settleFor === null) nowArrived = !untrack(() => reducedMotion.current);
		settleFor = id;
		const dy = belowTopWas - below.getBoundingClientRect().top;
		if (dy !== 0) settle = { dy, turn: untrack(() => settle)?.turn === 'a' ? 'b' : 'a' };
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
	<main style="--row-h:{rowH}px">
		{#if nowEntry}
			<!-- THE NOW-PLAYING CARD. Not a `<section aria-label>` duplicating the strip's: the strip above is the
			persistent one, this is the detailed one, and two landmarks with the same name is worse than one. -->
			<div
				class="now"
				class:arrive={nowArrived}
				onanimationend={(ev) => {
					if (ev.target === ev.currentTarget) nowArrived = false;
				}}
			>
				<p class="now-eyebrow">{NOW_SINGING}</p>
				<h2 class="now-title">{nowDisplay.title || nowMedia?.title || 'Untitled'}</h2>
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
							disabled={!keyShiftEnabled || keyShift <= -KEY_LIMIT}
							aria-label="Lower by one semitone"
							onclick={() => stepKey(-1)}><Icon name="minus" /></Button
						>
						<Button
							size="tap"
							variant="keycap"
							disabled={!keyShiftEnabled || keyShift >= KEY_LIMIT}
							aria-label="Raise by one semitone"
							onclick={() => stepKey(1)}><Icon name="plus" /></Button
						>
					</div>
				</div>

				<GuidingTrack pct={guidePct} available={guideEnabled} oninput={guideInput} oncommit={guideCommit} />

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

		<div
			class="below"
			bind:this={below}
			data-settle={settle?.turn}
			style:--settle-from={settle ? `${settle.dy}px` : undefined}
		>
			{#if deckEntry}
				<OnDeckCard
					title={deckDisplay.title || deckMedia?.title || 'Untitled'}
					artist={deckDisplay.artist}
					profile={deckMedia?.songProfile ?? null}
					keyShift={deckKey}
					guidePct={deckGuideDraft ?? deckGuideServerPct}
					guideAvailable={!!deckMedia && hasGuidingTrack(deckMedia)}
					timeLeft={minutesLeft(deckRemain)}
					headsUp={deckHeadsUp}
					singerColor={me.color}
					notYetName={deckNotYet ? (singers.get(deckNotYet.singerId)?.displayName ?? 'the next singer') : null}
					onkey={setDeckKey}
					onguideinput={(pct) => (deckGuideDraft = pct)}
					onguidecommit={setDeckGuide}
					onnotyet={notYet}
				/>
			{/if}

			{#if queued.length}
				<h2 class="grouphead">Queued</h2>
				<!-- Not mode chrome: a drag invalidated mid-flight has to say why, visibly as well as announced. -->
				{#if reorderNote}
					<p class={['reorder-note', { held: noteIsHold }]}>{reorderNote}</p>
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
					{@const card = queueCardKind(media, live)}
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
							seq={liveSeq(i, dragFrom, dragTo)}
							title={mediaTitleOf(e.mediaId)}
							singerName={e.singerId === me?.id ? 'You' : (s?.displayName ?? 'Guest')}
							singerColor={s?.color ?? SINGER_COLORS[0]}
							singerAway={awaySingers.has(e.singerId)}
							status={live?.status}
							pct={live?.pct ?? 0}
							etaSec={live?.etaSec}
							pending={pendingKind.get(e.id) ?? null}
							onretry={card === 'stalled' ? () => retryKaraoke(e.mediaId) : undefined}
							onremove={e.singerId === me?.id ? () => store?.removeEntry(e.id) : undefined}
							grip={gripsVisible && e.id !== pinnedId}
							gripId={e.id}
							moving={movingId === e.id && dragging}
							dragY={movingId === e.id && dragging ? dragY : 0}
							reorderable={gripsVisible}
							shift={rowShift(i, dragFrom, dragTo)}
							ongripdown={(ev) => onGripPointerDown(e, ev)}
							onnudge={(delta) => nudge(e.id, delta)}
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
							subtitle={e.id === deckEntry?.id
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
							ongripdown={(ev) => onGripPointerDown(e, ev)}
							onnudge={(delta) => nudge(e.id, delta)}
							onremove={() => store?.removeEntry(e.id)}
						/>
					{/if}
				{/each}
			{:else if !queueSynced}
				<!-- NOT EMPTY, NOT YET SYNCED: `me` lands before the socket's first `queue:sync`, and the empty state below
			said "Nothing queued yet" over a full queue for that whole window on every cold load. -->
				<SkeletonRows count={4} label="Loading the queue…" />
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
		</div>
	</main>

	<!-- ONE polite region for both the queue's own announcements and the reorder results, `aria-atomic` so a fast
	sequence of moves replaces rather than queues. Visually hidden; `reorder-note` above is the sighted half. Inside
	the gate with the list it describes: an unjoined visitor has no queue to announce. -->
	<div class="sr-live" role="status" aria-live="polite" aria-atomic="true">{liveMsg}</div>
{:else if status === 'not-joined'}
	<JoinLanding />
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

	/* Everything under the card, in one box so one transform can hold it still. Same column rhythm as `main`. */
	.below {
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
	}

	/* Two identical names, so writing the other one restarts the ease. See `settleFor` in the script. */
	@media (prefers-reduced-motion: no-preference) {
		.below[data-settle='a'] {
			animation: settle-a var(--motion-base) ease-out;
		}
		.below[data-settle='b'] {
			animation: settle-b var(--motion-base) ease-out;
		}
		/* Two --motion-base long, held at 0 for the first (the settle's), so the card is invisible while the content
		   passes through its box. A hold inside the keyframes rather than an `animation-delay`: one animation that
		   starts with the settle, rather than one whose start event fires a --motion-base later. */
		.now.arrive {
			animation: arrive calc(var(--motion-base) * 2) ease-out;
		}
	}
	@keyframes settle-a {
		from {
			transform: translateY(var(--settle-from));
		}
	}
	@keyframes settle-b {
		from {
			transform: translateY(var(--settle-from));
		}
	}
	@keyframes arrive {
		from,
		50% {
			opacity: 0;
		}
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
