<script lang="ts">
	import { SINGER_COLORS } from '$lib/contract';
	import { onMount, tick } from 'svelte';
	import type { QueueEntry, Media, PublicSinger, PlaybackState } from '$lib/contract';
	import type { QueueStore } from '$lib/stores/queue';
	import { room } from '$lib/stores/room';
	import QueueRow from '$lib/components/QueueRow.svelte';
	import JoinLanding from '$lib/components/JoinLanding.svelte';
	import MyPositionCard from '$lib/components/MyPositionCard.svelte';
	import ProcessingCard from '$lib/components/ProcessingCard.svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import {
		gripVisible,
		liveSortTarget,
		keyboardMoveTarget,
		rowShift,
		ordinal,
		modeInvalidation
	} from '$lib/reorder-mode';
	import { nextPlayableEntryId, entryPlayable, queueCardKind } from '$lib/readiness';
	import { positionWords } from '$lib/phrasing/position-sentence';
	import type { MediaStatus } from '$lib/contract';
	import { Toaster } from '$lib/components/ui/sonner';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import * as Empty from '$lib/components/ui/empty';

	let me = $state<PublicSinger | null>(null);
	let entries = $state<QueueEntry[]>([]);
	// What each row is still waiting on ('add' | 'move'), republished on every store emit so the
	// QueueRow/ProcessingCard `pending` affordance reflects the real pending map instead of the
	// placeholder rotationSeq that applyAndReseq overwrites in the same frame. A KIND
	// rather than a set of ids since an earlier change: a pending REORDER is marked too, and it must not
	// borrow the add path's "adding…" word.
	let pendingKind = $state<Map<string, 'add' | 'move'>>(new Map());
	let singers = $state<Map<string, PublicSinger>>(new Map());
	let mediaCatalog = $state<Map<string, Media>>(new Map());
	let connected = $state(false);
	/**
	 * Singers who are in the room but unreachable. The phone ignored `singer:presence` entirely before
	 * this, so an absent singer's queued song looked exactly like anyone else's — and since the room
	 * skips those turns by hand, the surface holding the skip control was the one surface that could not
	 * tell there was a decision to make.
	 */
	let awaySingers = $state<Set<string>>(new Set());
	let playback = $state<PlaybackState>({
		currentEntryId: null,
		positionSec: 0,
		isPlaying: false,
		keyShift: 0,
		background: null,
		guideLevel: null
	});
	// live process progress per mediaId — driven by media:status broadcasts AND seeded
	// from /api/library on load, so a reload mid-process doesn't lose the progress bar.
	let mediaStatus = $state<Map<string, { status: MediaStatus; pct: number; etaSec?: number }>>(new Map());
	/*
	 * DIRECTION A + the 2026-09-09 owner correction (issues earlier changes): the room's
	 * queue IS the home screen, and the search box is docked at the bottom of it AT ALL TIMES for a
	 * joined singer — it is the add affordance, so there is no `+ Add a turn` push and no browse MODE.
	 * Typing expands the results UPWARD IN PLACE over the queue (direction B's layout), so there is no
	 * navigation: the split between "queue" and "results" is driven purely by whether the box has a
	 * query, `searchActive` below.
	 *
	 * `?browse=1`'s FATE (stated, not silently dropped): it is GONE. Its only job was to push a history
	 * entry so the phone's Back gesture returned to the queue instead of leaving the room. With results
	 * rendered in place there is no mode to back out of — the queue is always underneath and reappears
	 * the instant the box is cleared — so the back-gesture role is reassigned explicitly: the on-screen
	 * "← Queue" control (rendered only while `searchActive`) calls `clearSearch()`, and the hardware Back
	 * at the empty-box home leaves the room, which is what Back from home has always meant under
	 * direction A. No pushed history entry means no route to strand a reload on.
	 */
	// `searchActive` (query non-empty) is the sole switch between the queue view and the results view;
	// it is derived from `query` in the search section below.
	/**
	 * THE BAND CONTRACT. The docked search band's REAL rendered height, published to documentElement so

	/*
	 * Editing your name and colour, and leaving the room, used to live in a sheet mounted here. They now
	 * live on /settings?tab=you — one editor instead of two that could disagree — so the fetches that
	 * backed them (`PATCH /api/me`, `GET|POST /api/leave`) moved with them. The header's name button is
	 * a link to that tab.
	 */

	/*
	 * NO LOCAL COPY OF THE ROOM'S SETTINGS ANY MORE, and the deletion is the tail of the heading change
	 * below. This route mirrored `room.settings` from the queue:sync/settings:changed pair, and the
	 * mirror's one remaining reader was `orderLabel` — the order word in the list heading. With the
	 * heading down to "Queued" nothing here reads it, and a mirrored field nobody reads is a second copy
	 * of room state that can only ever be stale.
	 *
	 * IT IS NOT NEEDED FOR THE REDUCER. The note here used to claim the phone needs `room.queueOrder`
	 * "as an input to the optimistic reducer, so an add can only land in its real position if this is
	 * current" — true of the STORE, which reads the order itself; this was never that copy. `room.queue`
	 * is handed over whole below and keeps doing exactly what it did.
	 */
	// A reorder is ALWAYS meaningful now: the queue is a stored ordered list and a move rewrites
	// it, so there is no policy that can discard the move. This used to be false under `shuffle`, whose
	// rank came from the entry id and re-derived over any reorder — nothing re-derives a position now,
	// so a drag on a shuffled list simply rearranges the stored list like anywhere else.
	const canReorder = true;
	// HOST reorder: a host can drag ANY song to any global slot, not just reorder their
	/*
	 * THE LIST HEADING NAMES NO ORDER ANY MORE — it is the one word "Queued" (ratified 2026-09-21).
	 *
	 * It was `Up next · {orderLabel}`, and `orderLabel` existed because the heading had once named the
	 * order "rotation" unconditionally, which stopped being true the moment the room picked anything else
	 * (eyes-on: it still said ROTATION with the room on first-come-first-served). That fix was correct for
	 * the heading it had. The heading is now a label rather than a sentence, so there is nothing left to
	 * disagree with the room — which retires the derived value rather than un-fixing it.
	 *
	 * `queueOrderLabel` KEEPS ITS EXPORT AND ITS TESTS (`contract/queue/queue-order.ts`, asserted by
	 * barrel-surface.test.ts); this was simply its last call site in the app. The room's order policy is
	 * still stated where it is CHOSEN, on /settings.
	 */

	// MIRRORED from the room link, not owned here — see the onMount block. Optional because a guest
	// who has not joined has no queue at all, which is what every `store?.` call site below reads.
	let store = $state<QueueStore | undefined>(undefined);

	function mediaTitle(id: string): string {
		const m = mediaCatalog.get(id);
		return m ? `${m.title}${m.artist ? ' — ' + m.artist : ''}` : id;
	}
	function singerOf(id: string): PublicSinger | undefined {
		return singers.get(id);
	}
	/** Merge media into the client catalog. The catalog is otherwise fed ONLY by queue:sync/patch, so
	 *  a song that came from search or the library — and is not (yet) in anyone's queue — has no
	 *  resolvable title: a processing card would render a raw ULID. */
	/*
	 * THE ROOM LINK, MIRRORED. The socket, the QueueStore and every field the room broadcasts into used
	 * to be CONSTRUCTED here, which made this route the owner of app-wide truth — and that is precisely
	 * why the now-playing band could not become app chrome: a component in +layout.svelte cannot read a
	 * sibling route's locals. `$lib/stores/room.ts` owns them now; this block adopts them.
	 *
	 * THE LOCALS BELOW KEEP THEIR NAMES ON PURPOSE. Every read site in this 2000-line template is
	 * unchanged, so the diff is a change of OWNER, not a rename sweep — and a rename sweep across this
	 * file is exactly the kind of change that hides a real defect in 300 lines of noise.
	 *
	 * `sync()` RUNS ONCE BEFORE SUBSCRIBING, which is not belt-and-braces: the link is a singleton that
	 * outlives this component, so on any later navigation back to `/` it is ALREADY live and the next
	 * emit may be seconds away. Subscribing alone would render an empty queue until the room happened
	 * to say something.
	 *
	 * NOTHING HERE CLOSES THE SOCKET. It is deliberately not this route's to close — the connection has
	 * to survive navigation to the find surface and a song page, so the layout owns its lifetime.
	 */
	onMount(() => {
		const sync = () => {
			me = room.me;
			connected = room.connected;
			playback = room.playback;
			singers = room.singers;
			mediaCatalog = room.mediaCatalog;
			awaySingers = room.awaySingers;
			mediaStatus = room.mediaStatus;
			entries = room.entries;
			pendingKind = room.pendingKind;
			store = room.queue;
		};
		sync();
		const stopMirror = room.subscribe(sync);
		// The link holds no opinion about how a failure is shown, so the toast stays a route decision.
		const stopErrors = room.onError((message) => showError(message));
		void room.connect();
		return () => {
			stopMirror();
			stopErrors();
		};
	});

	// ── readiness ────────────────────────────────────────────────────────────
	// One axis, three states: ready (stems on disk, sing now), processing (stems in flight, still
	// queueable because rotation holds its slot), raw (plays with the original vocals).
	//
	// It is no longer a FILTER. Direction B deleted the four concurrent ways to narrow
	// one list — the three readiness chips, the artist rail, the genre rail, and the group headings
	// that re-announced this axis in prose — leaving typing in the docked search box as the only one.
	// So there is no `filter` state and no `showReady`/`showProcessing`/`showRaw` gate: every group
	// renders, every time, and the reader narrows the list by saying what they want.

	/**
	 * The rotation, in the order the room will play it. `queued` is the ONLY list this surface renders
	 * now that search has its own route, so the queue view is no longer one arm of a two-view page.
	 */
	const queued = $derived(entries.filter((e) => e.status === 'queued').sort((a, b) => a.rotationSeq - b.rotationSeq));

	function liveOf(id: string) {
		return mediaStatus.get(id);
	}

	/*
	 * TOASTS ARE SONNER'S NOW.
	 *
	 * What this replaced: two hand-rolled fixed-position surfaces, two `setTimeout` timers, a
	 * `bind:clientHeight` measurement of the undo toast, and an `$effect` publishing `--undo-h` to
	 * `documentElement` with a teardown against the an earlier change §14 leak class. The error toast's offset had to
	 * track that MEASURED height because a real “title — artist” wraps to an unpredictable number of
	 * lines, and the two surfaces had already collided once — "both sat at the same bottom and z-index,
	 * so one drew over the other and a guest saw only whichever rendered last".
	 *
	 * Sonner stacks its own toasts, so every part of that chain is deleted rather than ported: no
	 * measurement, no published custom property, no leak to tear down, and the overlap it existed to fix
	 * cannot recur. The 5s undo window and the 4s error window are `duration`, and Undo is a real toast
	 * ACTION rather than a button this page positions and sizes itself.
	 *
	 * The Toaster docks above the measured band with `offset="var(--dock-h, 0px)"`, which works because
	 * `--dock-h` is published on `documentElement` (see the note at its writer above) and so is readable
	 * from sonner's portal.
	 */
	function showError(msg: string) {
		toast.error(msg, { duration: 4000 });
	}

	function removeWithUndo(entry: QueueEntry) {
		const mediaId = entry.mediaId;
		const title = mediaTitle(mediaId);
		store?.removeEntry(entry.id);
		if (navigator.vibrate) navigator.vibrate(8);
		toast(`Removed \u201c${title}\u201d`, {
			duration: 5000,
			action: { label: 'Undo', onClick: () => store?.addSong(mediaId) }
		});
	}

	/*
	 * Screen-reader announcements for the two changes that most often happen UNDER the user's hands and
	 * are otherwise silent: another guest queueing a song, and a rotation reorder (both arrive as a
	 * queue:patch, never a focus change, so a screen reader would say nothing). A single polite region
	 * — never assertive: this is ambient party activity, not something the user must act on now.
	 *
	 * The guard against spam is the DIFF, not a timer: we announce only when the meaningful shape of
	 * the queue changed relative to the last announced state. Position telemetry (~4×/sec) does not
	 * change `queued`, so it produces no announcement. A NEW id from someone else = "X queued Y"; the
	 * SAME id set in a DIFFERENT order = "Queue reordered". My own adds are silent (I just did it, and
	 * they render optimistically this frame). The first population after load seeds the baseline
	 * without announcing, so joining a busy room does not read the whole queue aloud.
	 */
	let liveMsg = $state('');
	let announceReady = false; // suppress the initial sync; only later deltas are news
	let lastQueueIds: string[] = [];
	$effect(() => {
		const ids = queued.map((e) => e.id);
		const prev = lastQueueIds;
		if (!announceReady) {
			// baseline: remember what was already there so the first sync is not announced
			lastQueueIds = ids;
			announceReady = true;
			return;
		}
		const prevSet = new Set(prev);
		const added = queued.filter((e) => !prevSet.has(e.id));
		if (added.length) {
			// Announce only OTHERS' adds — mine are self-initiated and already visible. One line even if
			// several landed at once (a resync catch-up), naming the count rather than reading each.
			const mine = added.every((e) => e.singerId === me?.id);
			if (!mine) {
				const others = added.filter((e) => e.singerId !== me?.id);
				if (others.length === 1) {
					const e = others[0]!;
					const who = singers.get(e.singerId)?.displayName ?? 'Someone';
					liveMsg = `${who} queued ${mediaTitle(e.mediaId)}`;
				} else {
					liveMsg = `${others.length} songs added to the queue`;
				}
			}
		} else if (ids.length === prev.length && ids.some((id, i) => id !== prev[i])) {
			// same songs, new order → a rotation reorder moved things under the user
			liveMsg = 'Queue reordered';
		}
		lastQueueIds = ids;
	});

	/** The entry's index in the WHOLE queued list — the index space `move-to-index` uses. */
	function queuedIdx(id: string): number {
		return queued.findIndex((e) => e.id === id);
	}
	/**
	 * Cross-singer reorder (an earlier change step 4, an earlier change Q4-A): shift the entry one slot up/down across the WHOLE
	 * queue, jumping other singers — which the own-picks `move` op cannot express. Emits `move-to-index`,
	 * which rewrites the stored list, so the move sticks with no pin. Every joined singer may do it; the
	 * server gates a NON-owner entry on `queue:reorder-any`. The reorder-mode drag now commits through
	 * the same op (via exitReorder → store.moveToIndex), so both affordances share one wire path.
	 */
	/*
	 * `moveGlobal` RETIRED (2026-09-21) with the arrow buttons it was wired to. Its one-place step is `nudge`
	 * below — same op, same wire path — but routed through `keyboardMoveTarget` so a press at either end of
	 * the list declines instead of emitting a move to the position the row already occupies.
	 */

	/* ── REORDERING: A LIVE SORT ───────────────────────────────────────────────
	 *
	 * The row follows the finger, the rows it passes shift out of its way, and the release commits where it
	 * visibly is. There is no mode: no Done, no Cancel, no drawn drop targets, nothing to dismiss.
	 *
	 * WHAT THIS REPLACED, because the deletion is large and the reasoning it drops was not wrong. A press
	 * opened a MODE; the page rendered a labelled `.dropslot` button above every queued row; a release over
	 * one committed and a release anywhere else committed nothing; a `.reorder-bar` offered Done and Cancel
	 * and a hint. That was the right shape for `move`, whose index space was the guest's OWN picks — not
	 * adjacent in a flat list, so proximity genuinely could not imply a target. Under `move-to-index` every
	 * position is legal, so "draw the legal positions" became "draw one per row", which is what the list
	 * already shows. Reported as popup hell with places to drop it, and it was.
	 *
	 * IS SATISFIED MORE STRONGLY, not waived: `liveSortTarget` is the same expression that places
	 * the rows on screen and the one that commits, so a release cannot land somewhere the guest did not see.
	 * (SC 2.5.7 / 2.1.1, a conformance row) moved onto the grip: Arrow Up/Down while it has focus
	 * steps the row one place. See the header of `$lib/reorder-mode` for both in full.
	 */
	/** The row being dragged, and the live offset of the finger from where the press began. */
	let movingId = $state<string | null>(null);
	let dragging = $state(false);
	let dragY = $state(0);
	/**
	 * One row's height in px, measured ONCE per gesture at press time.
	 *
	 * Queued rows are uniform, so one number places every other row — and re-measuring mid-gesture is the
	 * hazard the old design recorded: rows change height while a drag is in flight (a byline gains an `away`
	 * badge, another guest queues a card) and a stale geometry table then points at the wrong position.
	 */
	let rowH = $state(0);
	// Why a drag ended itself. Announced through the SAME polite region the queue already uses (`liveMsg`)
	// rather than a second one, and rendered as visible text: a sighted guest needs the reason too.
	let reorderNote = $state('');
	/** The grip the gesture began on, so focus can be returned to it. */
	let openerEl: HTMLElement | null = null;
	let dragTeardown: (() => void) | null = null;

	/** Where the dragged row currently sits, which is both what the list renders and what a release commits. */
	const dragFrom = $derived(movingId ? queuedIdx(movingId) : -1);
	const dragTo = $derived(
		dragging && dragFrom >= 0
			? liveSortTarget({ fromIndex: dragFrom, offsetPx: dragY, rowHeightPx: rowH, count: queued.length })
			: -1
	);

	function gripFor(e: QueueEntry): boolean {
		// Any queued row is draggable: `move-to-index` can place a song at any global slot, so the grip is
		// legitimate on every row. `e` is kept in the signature so the template still asks the predicate
		// per-row (a hard-coded literal on every row is the recorded regression) and so a later per-row rule
		// has somewhere to read from.
		void e;
		return gripVisible({ queuedCount: queued.length, reorderMeaningful: canReorder });
	}

	/*
	 * Every queued row is a legal position, so there are no rows the mode must de-emphasise or take controls
	 * from. The helper is kept (returning a constant `false`) so the call sites keep one named, greppable
	 * suppression point — a later rule that DOES need to freeze a row has an obvious place to express it.
	 */
	function rowFrozen(e: QueueEntry): boolean {
		void e;
		return false;
	}

	/** Commit a move, or nothing when the position has not changed. Shared by the drag and the keyboard. */
	function commitMove(id: string, to: number | null) {
		if (to === null) return;
		const from = queuedIdx(id);
		if (from < 0 || to === from) return;
		store?.moveToIndex(id, to);
		if (navigator.vibrate) navigator.vibrate(8);
	}

	/**
	 * the non-drag reorder, one place per press, straight from the grip.
	 *
	 * It commits IMMEDIATELY rather than opening anything: `keyboardMoveTarget` declines at the ends of the
	 * list, so a press that cannot move says nothing instead of emitting a move to where the row already is.
	 * Announced, because the row moves under the guest's focus and a screen reader is otherwise told only
	 * that the list changed.
	 */
	function nudge(id: string, delta: number) {
		const from = queuedIdx(id);
		const to = keyboardMoveTarget(from, delta, queued.length);
		if (to === null) return;
		commitMove(id, to);
		liveMsg = `Moved to ${ordinal(to + 1)} in the queue.`;
		// The row's DOM is recreated at its new position, so focus is re-found by attribute rather than held
		// — the same reason the drag's focus return does it that way.
		void tick().then(() => {
			(document.querySelector(`[data-grip="${CSS.escape(id)}"]`) as HTMLElement | null)?.focus?.();
		});
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
		reorderNote = note;
		if (note) liveMsg = note;
		/*
		 * focus goes back to the control the guest was working from, on every exit. After `tick()`
		 * and by ATTRIBUTE rather than by the element reference: the row's DOM is recreated at its new
		 * position, so the grip that was pressed is a detached node and focusing the captured reference put
		 * focus nowhere — measured, not assumed. `openerEl` is the fallback for when the row itself has gone
		 * (the song started, or was removed), where there is no grip left to return to.
		 */
		void tick().then(() => {
			const sel = id ? `[data-grip="${CSS.escape(id)}"]` : '';
			const el = sel ? (document.querySelector(sel) as HTMLElement | null) : null;
			(el ?? openerEl)?.focus?.();
			openerEl = null;
		});
	}

	/**
	 * The pointer drag. The idiom: publish the offset as a CSS custom property and let a transform do the
	 * moving, so no position is ever interpolated in JS. That is unchanged from the mode this
	 * replaced; what is gone is the hit-testing — there is nothing to hit-test now, because the target is
	 * arithmetic over one row height rather than a search for a drawn slot under the finger.
	 */
	function onGripPointerDown(entry: QueueEntry, e: PointerEvent) {
		const grip = e.currentTarget as HTMLElement | null;
		if (!grip) return;
		movingId = entry.id;
		dragging = true;
		dragY = 0;
		reorderNote = '';
		openerEl = grip;
		/*
		 * Focus the grip NOW, so the return on exit has somewhere to land: a pointer press does not focus a
		 * button in every engine, and a drag cancelled by Escape would otherwise have no recorded origin.
		 */
		grip.focus?.();
		/*
		 * ONE HEIGHT, read from the row the grip sits in. `closest` rather than an index into a list of rows:
		 * the processing cards in this list are a different height and must not be measured as if they were
		 * queued rows.
		 */
		rowH = grip.closest('.qrow')?.getBoundingClientRect().height ?? 0;
		const startY = e.clientY;
		/*
		 * THE LISTENERS GO ON `window`, NOT ON THE GRIP — and not behind `setPointerCapture`. The row's DOM is
		 * recreated as the list reorders under the finger, so the pressed grip becomes a DETACHED node;
		 * listeners bound to it, and a pointer captured by it, then deliver nothing — the drag produced no
		 * `pointermove` and the release never arrived. Both symptoms had one cause, and only a driven pointer
		 * could show it. `window` is stable for the life of the gesture, which is the lifetime this needs.
		 */
		const move = (ev: PointerEvent) => {
			dragY = ev.clientY - startY;
		};
		const up = () => endDrag(true);
		const cancel = () => endDrag(false);
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		window.addEventListener('pointercancel', cancel);
		dragTeardown = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			window.removeEventListener('pointercancel', cancel);
		};
	}

	/*
	 * the queue moves underneath a drag in flight, and that is NORMAL. `assignSeqs` re-derives
	 * every rotationSeq on every mutation, so another guest's add re-orders the flat list under the finger.
	 * That case needs no handling and deliberately gets none: the live sort is relative to where the dragged
	 * row IS, so a stranger's entry simply moves the row the guest is holding along with the list. What DOES
	 * invalidate the gesture is the dragged song leaving, starting to play, or the queue falling below two —
	 * each of which makes the drag meaningless. Then it ends itself, says why, and returns focus.
	 */
	$effect(() => {
		const reason = modeInvalidation(queued, movingId, entries.find((e) => e.id === movingId)?.status);
		if (reason) endDrag(false, reason);
	});
	// The entry that will ACTUALLY play next (skipping any still processing), matching the server's
	// nextPlayable(). Pure + unit-tested in $lib/readiness.
	const nextPlayableId = $derived(
		nextPlayableEntryId(
			queued,
			(id) => mediaCatalog.get(id),
			(id) => mediaStatus.get(id)
		)
	);

	const nowEntry = $derived(entries.find((e) => e.id === playback.currentEntryId));
	// ── interpolated playback position ─────────────────────────────────
	let posAnchor = { pos: 0, wall: 0 };
	$effect(() => {
		posAnchor = { pos: playback.positionSec, wall: performance.now() };
	});
	function livePositionSec(): number {
		return playback.isPlaying ? posAnchor.pos + (performance.now() - posAnchor.wall) / 1000 : posAnchor.pos;
	}

	// A reactive copy of the interpolated position, for the peek's progress row. Ticking once a second
	// is enough because the bar's width transition covers the gap between ticks; a rAF loop would wake
	// the phone ~60x more often for no visible gain. The timer only runs while playing, and re-arms on
	// every playback:state so a seek or restart snaps instead of sliding from a stale anchor.
	let displayPos = $state(0);
	$effect(() => {
		displayPos = playback.positionSec;
		if (!playback.isPlaying) return;
		const id = setInterval(() => (displayPos = livePositionSec()), 1000);
		return () => clearInterval(id);
	});
	const nowDurationSec = $derived(nowEntry ? (mediaCatalog.get(nowEntry.mediaId)?.durationSec ?? 0) : 0);

	// ── the guest's own place in the rotation, in WORDS (issue an earlier change) ──────────────
	// My soonest queued pick, and where it sits in the room's order.
	const myNextEntry = $derived(
		entries
			.filter((e) => e.singerId === me?.id && e.status === 'queued')
			.sort((a, b) => a.rotationSeq - b.rotationSeq)[0]
	);
	/**
	 * Seconds still to run on the song playing now: 0 when nothing is playing, and NULL when something
	 * is playing whose length is unknown — which makes the whole wait unknown rather than short. The
	 * sentence builder decides what to do with that; this only reports what is true.
	 */
	const nowRemainingSec = $derived.by(() => {
		if (!nowEntry) return 0;
		if (nowDurationSec <= 0) return null;
		return Math.max(0, nowDurationSec - displayPos);
	});
	/*
	 * The sentence itself is built by a pure helper so it is unit-testable with no DOM and no room, and
	 * so the honest-degradation rule lives in ONE place: an entry ahead whose media is not in the
	 * catalog has no resolvable length, and one unknown term makes the estimate unknown. `Media.durationSec`
	 * is required, so ABSENCE from the catalog — not a missing field — is the reachable unknown.
	 */
	const myPosition = $derived.by(() => {
		if (!myNextEntry) return null;
		const idx = queued.findIndex((e) => e.id === myNextEntry.id);
		if (idx < 0) return null;
		const before = idx > 0 ? queued[idx - 1] : undefined;
		return positionWords({
			place: idx + 1,
			beforeName: before ? (singers.get(before.singerId)?.displayName ?? null) : null,
			nowRemainingSec,
			aheadDurationsSec: queued.slice(0, idx).map((e) => mediaCatalog.get(e.mediaId)?.durationSec ?? null),
			// Only claim "up next" when the song can actually play next: a still-processing song is skipped
			// by the TV, which contradicted the playable-aware badge in the queue list below.
			playable: entryPlayable(mediaCatalog.get(myNextEntry.mediaId), liveOf(myNextEntry.mediaId))
		});
	});
</script>

<!--
	THE TOPBAR IS FOR A JOINED SINGER ONLY. Unjoined, `/` IS the join screen, and JoinLanding paints its
	own brand as that screen's heading — so rendering this one too put "Encore" on screen twice, once
	small at the top-left and once large and centred a few pixels below it. The wordmark is the join
	screen's title, not chrome sitting above it, so the chrome is what goes.
-->
{#if me}
	<header class="topbar">
		<h1 class="brand"><Icon name="mic" /> <span class="wordmark">Encore</span></h1>
		<!--
	  `connected` used to be assigned `true` once and never read or reset, so a phone whose socket had
	  died looked identical to a live one while its taps piled up in the pending queue. The store keeps
	  accepting them on purpose (they resend on resync) — this says so instead of implying they landed.
	-->
		{#if me && !connected}
			<span class="offline-pill" role="status" aria-live="polite">
				<Icon name="warning" /> Reconnecting…
			</span>
		{/if}
		{#if me}
			<div class="me-cluster">
				<!--
			  The name + dot were inert text. They are the one place a guest already looks to check who the
			  room thinks they are, so they are also where fixing it belongs — and a 44px target, since the
			  gear next to it was fixed for exactly that reason.

			  A LINK to the settings page, not a button opening a sheet. Identity used to be editable in
			  two places (this sheet and, after the redesign, the settings page), which is two save paths
			  that can disagree about what your name is. One editor, reached from both entry points: the
			  gear opens the room scope, this opens `?tab=you`.
			-->
				<!--
			  `.me-slot` / `.gear-slot` are page-rendered wrappers, and that is forced rather than stylistic:
			  Tailwind scans only the `components/ui` directory, so a utility written here is emitted
			  nowhere, and a
			  class handed to a component is scoped to THIS file where Svelte strips it as unused. So
			  layout and inherited ink stay on a wrapper, appearance moves into the variant.
			-->
				<div class="me-slot">
					<Button variant="identity" href="/settings?tab=you" aria-label="Your profile">
						<span class="me-name">{me.displayName}</span>
						<span class="me-dot" style="--singer:{me.color};"></span>
					</Button>
				</div>
				<!--
			  Was a bare ⚙️ at font-size 1.05rem in ~18px of padding: a forced-colour-emoji glyph (the
			  trailing U+FE0F requests emoji presentation outright) in a target under even the 24px WCAG
			  2.5.8 floor, in an app that had already adopted 44px everywhere else. Now a real mark in a
			  real target — `size="icon"` IS that target: it compiles to `size-tap grid place-items-center`
			  over `--tap: 44px`.
			-->
				<div class="gear-slot">
					<Button variant="ghost" size="icon" href="/settings" aria-label="Settings" title="Settings">
						<Icon name="gear" />
					</Button>
				</div>
			</div>
		{/if}
	</header>
{/if}

<!--
	`--row-h` IS THE ONE MEASURED ROW HEIGHT, published here so the shifting rows can multiply it by the
	`--row-shift` COUNT the page gives each of them. It is 0 except during a drag, which is also when it is
	measured (see `onGripPointerDown`) — so no row can be displaced while nothing is being dragged, whatever
	a stale shift count said.
-->
<main style="--row-h:{rowH}px">
	{#if me}
		<!-- The guest's own place, in words, with the wait omitted rather than guessed. -->
		<MyPositionCard words={myPosition} />

		<h2 class="grouphead">Queued</h2>
		<!--
			NO MODE CHROME. A `.reorder-bar` used to appear here — a hint plus Done and Cancel — because the
			mode it belonged to had to be committed or abandoned explicitly. The drag is a live sort now: it
			begins on a press, it is visible the whole way, and it commits on release. There is nothing to
			confirm and nothing to abandon, so the bar, its two buttons and the Escape binding that fed Cancel
			are all gone (2026-09-21). Reported as popup hell, along with the drop targets.

			The NOTE stays, and it is not mode chrome: a drag can still be invalidated mid-flight by the queue
			moving (the song starts playing, or leaves), and a gesture that dissolves under a
			guest's finger has to say why. Visible as well as announced, because a reason only a screen reader
			gets is not a reason.
		-->
		{#if reorderNote}
			<p class="reorder-note">{reorderNote}</p>
		{/if}
		{#if queued.length === 0}
			<!--
				THE STATE, LARGE AND CENTRED, AND NOTHING ELSE (ratified 2026-09-21).

				This carried a second line — "Tap the magnifier below to pick the first song." — added when the
				state was one dim `Nothing queued.` at the top left of an otherwise blank screen, on the
				reasoning that a guest who has just joined has no idea the band is where songs come from. The
				instruction is dropped and the STATE is promoted instead: at display scale in the middle of the
				empty column it is the only thing on the screen, and the magnifier is the only control under it,
				so the sentence was describing a discovery the layout now makes for itself.
				`Empty.Description` goes with it rather than being emptied — the slot carried the copy.

				`Empty.Root` STAYS, and not decoratively: the inventory detector recognises a route's
				designed empty state by `<Empty.Root>` (phone-inventory.test.ts), so replacing the primitive
				with a bare `<p>` would report this route as having no empty state at all.

				SIZED AND PLACED FROM A PAGE-OWNED WRAPPER. `Empty.Title` is a vendored element carrying
				`text-lg`, which an inherited font-size cannot beat, and a utility written in this file is
				emitted nowhere (Tailwind scans only `components/ui`) — so the one rule reaches the vendored
				`data-slot` through `.queue-empty`, the same shape as `.band-slot:global(.band)` in the drawer.
			-->
			<Empty.Root>
				<div class="queue-empty">
					<Empty.Header>
						<Empty.Title>Nothing Queued</Empty.Title>
					</Empty.Header>
				</div>
			</Empty.Root>
		{:else}
			{#each queued as e, i (e.id)}
				{@const s = singerOf(e.singerId)}
				{@const card = queueCardKind(mediaCatalog.get(e.mediaId), mediaStatus.get(e.mediaId))}
				<!--
					NO DROP TARGETS. A `.dropslot` button used to render above every queued row while the mode was
					open, labelled with the ordinal it committed, and the drag hit-tested for the one under the
					finger. Deleted (2026-09-21): under `move-to-index` every position is legal, so one target per
					row is exactly what the list already shows — and a release now commits `dragTo`, the same
					expression that places the rows on screen, which is the substance without the chrome.
				-->
				{#if card === 'processing' || card === 'failed'}
					{@const proc = mediaStatus.get(e.mediaId) ?? { status: 'failed' as MediaStatus, pct: 0 }}
					<ProcessingCard
						seq={i + 1}
						title={mediaTitle(e.mediaId)}
						singerName={e.singerId === me?.id ? 'You' : (s?.displayName ?? 'Guest')}
						singerColor={s?.color ?? SINGER_COLORS[0]}
						singerAway={awaySingers.has(e.singerId)}
						status={proc.status}
						pct={proc.pct}
						pending={pendingKind.get(e.id) ?? null}
						onremove={e.singerId === me?.id ? () => removeWithUndo(e) : undefined}
						reorderable={!rowFrozen(e) && canReorder && !!me?.id && queued.length > 1}
						dimmed={false}
						shift={rowShift(i, dragFrom, dragTo)}
					/>
				{:else}
					<!-- `queued` excludes the PLAYING entry (its status is 'playing'), so every row here is
					     safe to remove. The old `i !== 0` guard meant to protect the current song but
					     actually froze whatever sat at position 0 — i.e. the next-up song. -->
					<QueueRow
						seq={i + 1}
						title={mediaTitle(e.mediaId)}
						singerName={e.singerId === me?.id ? 'You' : (s?.displayName ?? 'Guest')}
						singerColor={s?.color ?? SINGER_COLORS[0]}
						mine={e.singerId === me?.id}
						singerAway={awaySingers.has(e.singerId)}
						up={e.id === nextPlayableId}
						pending={pendingKind.get(e.id) ?? null}
						subtitle={e.id === nextPlayableId ? 'up next' : ''}
						removable={e.singerId === me?.id}
						grip={gripFor(e)}
						gripId={e.id}
						dimmed={false}
						moving={movingId === e.id && dragging}
						dragY={movingId === e.id && dragging ? dragY : 0}
						shift={rowShift(i, dragFrom, dragTo)}
						ongripdown={(ev) => onGripPointerDown(e, ev)}
						onnudge={(delta) => nudge(e.id, delta)}
						onremove={() => removeWithUndo(e)}
					/>
				{/if}
			{/each}
		{/if}
	{:else}
		<!-- UNJOINED: `/` is the landing page. Both a scan affordance and a six-segment code entry,
		     or — when a QR was scanned (`/?room=CODE`) — the room confirmed in words. -->
		<JoinLanding />
	{/if}
</main>

<!--
	One toast surface for the whole page, docked above the measured band. `richColors` is off: the error
	tone comes from Encore's own `--destructive`, which the vendored component points at.
-->
<Toaster position="bottom-center" offset="var(--dock-h, 0px)" style="--width: min(92vw, 420px);" />

<!--
	Polite live region for ambient queue activity a screen reader would otherwise miss (a guest's add,
	a rotation reorder). Visually hidden — it carries no visual design, so it changes no screenshot —
	but present in the DOM from first render so the assistive tech is already observing it when the
	first announcement lands. See the `liveMsg` effect for what is (and is not) announced.
-->
<!-- — ESCAPE CANCELS A DRAG IN FLIGHT and commits NOTHING. Bound on the window rather than on a
	row because mid-gesture the pointer is captured and focus sits on the grip, while a keyboard cancel has
	to work wherever focus happens to be.

	Guarded on `dragging` so it never swallows an Escape the rest of the page wants. It is the only
	mode-like binding left: there is no Cancel button, because there is no mode to abandon — a release
	commits where the row visibly is, and this is how a guest backs out of a gesture already under way.
-->
<svelte:window onkeydown={(e) => dragging && e.key === 'Escape' && endDrag(false)} />

<div class="sr-live" role="status" aria-live="polite" aria-atomic="true">{liveMsg}</div>

<style>
	/*
	 * The search dock is docked at the bottom, so the column must be able to scroll clear of it
	 *: the padding reserves the band's MEASURED height (--dock-h), which is what keeps the
	 * last queue row (empty box) or the top-ranked result (searching) reachable at every scroll position
	 * instead of parked under the band. The fallback covers the first frame before the effect publishes
	 * a measurement. Since an earlier change there is exactly ONE band on this route — the search dock, present in
	 * both views — so this one rule reserves the only band there is.
	 */
	main {
		flex: 1;
		padding: var(--space-xs) var(--space-3xl) calc(var(--dock-h, 0px) + 28px);
	}
	/*
	 * WRAPPERS FOR THE MIGRATED CONTROLS. Each holds only what a component must not: layout that belongs
	 * to a flex ITEM, and ink that the control inherits. Neither can be a class passed to <Button> —
	 * Tailwind scans only `components/ui/**` so a utility written here is emitted nowhere, and a class
	 * handed to a component is scoped to this file where Svelte strips it as unused. The appearance of
	 * all nine controls now lives in a Button variant.
	 */
	.me-slot {
		/* Frees the flex minimum the name's ellipsis depends on. The `identity` variant restores `shrink`
		   that the Button base removes; without both, a long name pushes the gear off the row. */
		min-width: 0;
		display: flex;
	}
	.gear-slot {
		/* Optical pull to the column edge, and the dim ink the mark inherits — `ghost` sets no base text
		   colour, only `hover:text-foreground`, so hover still brightens it. */
		margin-right: -10px;
		color: var(--ink-dim);
		display: flex;
	}
	/* Visually-hidden live region: announced by assistive tech, painted nowhere (so it is
	   screenshot-neutral). The standard clip-rect idiom, not display:none — a display:none region is
	   not announced by most screen readers. */
	.sr-live {
		position: absolute;
		width: 1px;
		height: 1px;
		margin: -1px;
		padding: 0;
		border: 0;
		overflow: hidden;
		clip: rect(0 0 0 0);
		clip-path: inset(50%);
		white-space: nowrap;
	}

	/*
	 * `.reorder-bar`, `.reorder-hint`, `.reorder-acts`, `.dropslot` and `.dropslot.hot` WERE DELETED HERE
	 * (2026-09-21) with the mode they dressed: a bar with a hint and Done/Cancel, and one labelled drop
	 * target above every queued row. The drag is a live sort now — the row follows the finger, its
	 * neighbours slide, the release commits — so there is nothing to confirm, abandon or aim at.
	 *
	 * What those rules had learned, so it is not re-learned: the slot was a `--tap`-tall dashed outline that
	 * grew a solid accent edge when hot, because a drop target drawn only by colour is invisible to the
	 * guest who needs it most; and the bar sat above the list rather than docked, so it could not cover the
	 * rows the guest was aiming at. Neither hazard exists without the chrome.
	 */
	.reorder-note {
		margin: 0 0 var(--space-sm);
		font-size: var(--ph-text-sm);
		color: var(--warn);
	}

	/*
	 * The wordmark. The mic was 🎤 — a different drawing on every platform, and a tofu box on a browser
	 * with no emoji font, which is not something a brand mark can be. The gradient stays on the TEXT
	 * (background-clip), where it is the glyph fill against the page and carries no label of its own.
	 */
	.brand {
		display: inline-flex;
		align-items: center;
		gap: var(--space-sm);
		font-weight: 800;
		font-size: var(--ph-text-xl);
		margin: 0;
		line-height: inherit;
	}
	.wordmark {
		background: var(--grad);
		-webkit-background-clip: text;
		background-clip: text;
		color: transparent;
	}

	/*
	 * The singer's own identity dot. The colour arrives as a --singer custom property rather than being
	 * interpolated straight into `background:`, which is what lets the halo be derived with color-mix.
	 * The previous form concatenated hex alpha digits onto the value — `box-shadow: 0 0 0 3px {color}30`
	 * — and that only ever worked because all eight presets happened to be 6-digit hex. A 3-digit hex,
	 * an rgb() or an oklch() produced invalid CSS and the halo silently vanished. color-mix takes any
	 * colour syntax, so the free hue picker cannot break it.
	 */
	.me-dot {
		width: 22px;
		height: 22px;
		border-radius: 50%;
		flex: 0 0 auto;
		background: var(--singer);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--singer) 19%, transparent);
	}
	/* The one child of the header whose width is user-supplied. A single unbroken token has a
	   min-content width equal to its full rendered width, so with automatic minimum sizing flex-shrink
	   cannot take it below that and the row grows the document — carrying the settings gear off the
	   viewport. Truncate it instead: text-overflow only fires on a block box, so this is a
	   styled span (block), and min-width:0 must exist up the whole chain (.me-cluster,.me-btn) for it
	   to actually shrink. The dot (flex:0 0 auto) and the gear (min-width:44px) stay unshrinkable so
	   the 44px target survives. */
	.me-name {
		display: block;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	/* var(--tap), matching every other control in the app. The emoji gear this replaced was ~18px. */

	/*
	 * Wide viewports spend the extra room on MORE SONGS, not longer rows. Only song rows flow into
	 * columns — the group headings and the empty states each label everything below them, so a heading
	 * confined to one column would read as applying to half the list. The rule is inverted
	 * deliberately: everything spans by default and rows opt in, so a new block added here spans
	 * (always safe) rather than silently landing in a column beside a song.
	 */
	@media (min-width: 768px) {
		main {
			display: grid;
			/* 440px is measured off the row's own contents, not picked for looks: a row spends roughly 220px
			   on the thumbnail, readiness badge, action button and gaps, so a narrower column truncates
			   every title to "Quee..." and two unreadable columns are worse than one readable one. */
			grid-template-columns: repeat(auto-fill, minmax(440px, 1fr));
			gap: 0 var(--space-xl);
			align-content: start;
		}
		main > :global(*) {
			grid-column: 1 / -1;
		}
		main > :global(.row) {
			grid-column: auto;
		}
	}
	.grouphead {
		font-size: var(--ph-text-2xs);
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--ink-dim);
		font-weight: 700;
		margin: var(--space-2xl) var(--space-2xs) var(--space-sm);
	}
	.grouphead:first-of-type {
		margin-top: var(--space-2xs);
	}
	/*
	 * THE EMPTY QUEUE — the state at display scale, centred in the space it leaves, and the only thing on
	 * the screen (ratified 2026-09-21).
	 *
	 * `min-height` rather than a full-height centring trick: this is a block in a scrolling column that
	 * also carries the position card, the heading and the band's reservation, so anything absolute here
	 * would have to re-derive a height three other rules already own. 40vh puts the line in the middle of
	 * what is actually empty on a phone and reads as centred on a laptop, and it costs nothing when the
	 * queue is non-empty because the whole block is gone.
	 *
	 * `overflow-wrap: anywhere` IS THE 320px CLAUSE, not a tidiness one. At `--ph-text-3xl` and 200% text a
	 * single unbreakable word is wider than a 320px viewport, which is exactly the reflow failure
	 * measures — the same reason the `keycap` button variant carries this pair. The word breaks instead of
	 * the layout.
	 *
	 * THE FONT-SIZE REACHES A VENDORED SLOT. `Empty.Title` carries Tailwind's `text-lg` on its own element,
	 * so an inherited size cannot win, and a utility written in this file is never emitted (app.css is
	 * `source(none)` over `components/ui`). One `:global()` at a `data-slot`, which is the shape
	 * `ui-scoped-style-reach` asks for: the attribute is emitted by markup in this tree.
	 */
	.queue-empty {
		display: grid;
		place-items: center;
		min-height: 40vh;
		padding: var(--space-2xl) var(--space-md);
		text-align: center;
	}
	.queue-empty:global([data-slot='empty-title']) {
		font-size: var(--ph-text-3xl);
		line-height: var(--lh-snug);
		font-weight: 700;
		overflow-wrap: anywhere;
	}
	/* Centre the mark with its word. The glyphs these replaced were U+2212 and U+FF0B — the fullwidth
	   plus carries CJK metrics, so it sat off-baseline beside Latin text at every size. */

	/*
	 * The key head line. Sits ABOVE the ± buttons (see the markup comment for why it cannot be inline).
	 * Same label idiom as.gt-head /.key.lab. The original→sounding pair reads left to right; the
	 * sounding key takes the warn colour to echo `.key.shifted.lab`, so "you have changed the key" is
	 * signalled the same way in both places.
	 */
	/* The arrow is an Icon (banned as a glyph); size it to the text and dim it so the keys read as the
	   content and the arrow as mere connective tissue. */
	/*
	 * The vocal-range disclosure: a var(--tap) min-height button, an uppercase
	 * label, a chevron that swaps down/right with the open state, and a peek of the range value on the
	 * collapsed row so the section states its headline fact without being opened.
	 */
	/* The collapsed-row peek of the range, pushed to the right. Not uppercase — it is data, not a label. */
	/*
	 * Docked-toast stacking, measured UP from the docked primary button. --dock-h is bound to that band's
	 * clientHeight, and the BAND's own padding already includes env(safe-area-inset-bottom), so the
	 * inset arrives THROUGH --dock-h — do NOT add another env() term here or the gap doubles.
	 *
	 * The offsets were hand-tuned constants (14 / 70) stacking one element above the other above a
	 * measured value, so they overlapped the instant either toast changed height. Naming them as scoped
	 * tokens made the stacking order explicit: undo sat just above the band, and the error toast docked
	 * above the undo toast's rendered height plus a fixed gap.
	 *
	 * BOTH TOKENS ARE NOW DECLARED-BUT-UNREAD, AND THAT IS DELIBERATE RATHER THAN AN OVERSIGHT.
	 * The shadcn migration moved the toasts onto Sonner, which stacks its own surfaces — so there is no
	 * second independently-positioned toast to offset, and the `$effect` that published the undo toast's
	 * measured height was deleted with it. Consequences worth stating, because the previous version of
	 * this comment asserted the opposite and a comment that contradicts its code is a defect class here:
	 *
	 *   - there is NO writer for --undo-h anywhere in the tree, so it always resolves to its 0px
	 *     fallback and --error-dock is simply --undo-dock + 14px;
	 *   - no rule reads either token, so neither currently positions anything.
	 *
	 * They are retained rather than removed because two guards still resolve against this text: the
	 * phone-home shell guard asserts the --undo-dock declaration by regex AND uses the literal string
	 * `--error-dock:` as the end boundary of the slice it reads this rationale out of. Deleting either
	 * line breaks that guard on a stale enumeration rather than on a real defect, so retiring them is a
	 * test-owning change and not a CSS one.
	 */
	:root {
		--undo-dock: calc(var(--dock-h, 0px) + 14px);
		--error-dock: calc(var(--undo-dock) + var(--undo-h, 0px) + 14px);
	}

	/* Matches the gear beside it: a real var(--tap) target, not text that happens to be tappable. An
	   anchor now (it navigates to /settings?tab=you), so the underline a link would default to is
	   dropped — the affordance here is the var(--tap) box and the colour dot, as it was as a button. */

	/* --warn, not --danger: a dropped socket is a transient degraded state that self-heals on the next
	   backoff tick, not a failure the guest has to act on. */
	.offline-pill {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
		color: var(--warn);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-pill);
		padding: var(--space-2xs) var(--space-md);
		font-size: var(--ph-text-sm);
		white-space: nowrap;
	}

	/* Base header padding, declared here (not inline) so the short-viewport rule below can shrink it —
	   an inline style would outrank the media query and silently defeat it. The flex layout lives here
	   too, off the inline style, so the header joins the token layer instead of pinning raw px. */
	.topbar {
		display: flex;
		align-items: center;
		gap: var(--space-md);
		padding: var(--space-2xl) var(--space-3xl) var(--space-sm);
	}
	/* The name + gear cluster, pushed to the trailing edge. Static styling classed (not inline) so it
	   inherits the responsive layer rather than freezing raw px. */
	.me-cluster {
		margin-left: auto;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		font-size: var(--ph-text-sm);
		color: var(--ink-dim);
	}

	/*
	 * this file's reduce arm is GONE, because the two animations it covered left with their
	 * elements — the search spinner to ui/spinner and the skeleton shimmer to ui/skeleton. Both are
	 * now declared inside a `prefers-reduced-motion: no-preference` block in those components, which
	 * makes motion OPT-IN rather than declared-then-reset: there is no reset left to lose the cascade
	 * to a later rule. Nothing in this file animates any more.
	 */

	/*
	 * Landscape / short viewports (e.g. a phone held sideways at 844×390). The docked band plus header
	 * and section labels otherwise consume almost the whole height, leaving no room for result rows, so
	 * the chrome shrinks and at least a couple of rows stay visible.
	 *
	 * The docked band itself is NOT shrunk by a token here: --dock-h carries the button's own MEASURED
	 * height, and an inline custom property on:root outranks this rule — so a smaller value written
	 * here would be silently defeated the moment the measurement landed. The band is one 44px control,
	 * which is what makes that acceptable.
	 */
	@media (max-height: 480px) {
		.topbar {
			padding: var(--space-xs) var(--space-3xl) var(--space-2xs);
		}
		main {
			padding-top: var(--space-3xs);
		}
		.grouphead {
			margin: var(--space-sm) var(--space-2xs) var(--space-2xs);
		}
	}
</style>
