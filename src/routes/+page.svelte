<script lang="ts">
	import {
		SINGER_COLORS,
		DEFAULT_EFFECTIVE_SETTINGS,
		queueOrderLabel,
		originalKeyLabel,
		soundingKeyLabel,
		rangeLabel,
		rangeOctaves,
		voiceBandSentence,
		songDisplay,
		chosenCandidate,
		hasNewerCandidateThanOverride
	} from '$lib/contract';
	import { onMount, tick } from 'svelte';
	import type {
		QueueEntry,
		Media,
		PublicSinger,
		PlaybackState,
		PlayerCommand,
		EffectiveSettings
	} from '$lib/contract';
	import type { QueueStore } from '$lib/stores/queue';
	import { room } from '$lib/stores/room';
	import QueueRow from '$lib/components/QueueRow.svelte';
	import JoinLanding from '$lib/components/JoinLanding.svelte';
	import NowPlayingHero from '$lib/components/NowPlayingHero.svelte';
	import MyPositionCard from '$lib/components/MyPositionCard.svelte';
	import ProcessingCard from '$lib/components/ProcessingCard.svelte';
	import GuidingTrack from '$lib/components/GuidingTrack.svelte';
	import RangeBar from '$lib/components/RangeBar.svelte';
	import LyricsReselect from '$lib/components/LyricsReselect.svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import { gripVisible, queueSlots, dropTarget, modeInvalidation } from '$lib/reorder-mode';
	import { nextPlayableEntryId, entryPlayable, queueCardKind } from '$lib/readiness';
	import { positionWords } from '$lib/phrasing/position-sentence';
	import type { MediaStatus } from '$lib/contract';
	import { isPlayable, hasGuidingTrack, effectiveGuideLevel } from '$lib/contract';
	import { Toaster } from '$lib/components/ui/sonner';
	import { toast } from 'svelte-sonner';
	import * as Collapsible from '$lib/components/ui/collapsible';
	import { Button } from '$lib/components/ui/button';
	import * as Empty from '$lib/components/ui/empty';

	let me = $state<PublicSinger | null>(null);
	let entries = $state<QueueEntry[]>([]);
	// What each row is still waiting on ('add' | 'move'), republished on every store emit so the
	// QueueRow/ProcessingCard `pending` affordance reflects the real pending map instead of the
	// placeholder rotationSeq that applyAndReseq overwrites in the same frame. A KIND
	// rather than a set of ids since an earlier change: a pending REORDER is marked too (XR-PH-10), and it must not
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
	 * DIRECTION A + the 2026-09-09 owner correction (docs/DECISIONS.md, issues earlier changes): the room's
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

	// The room's settings, seeded from queue:sync and kept live by settings:changed — the SAME two
	// events /tv listens to. The phone needs them for one reason beyond display: `room.queueOrder` is
	// an input to the optimistic reducer, so an add can only land in its real position if this is
	// current. Defaults until the first sync, which is fair rotation — the pre-setting behaviour.
	let settings = $state<EffectiveSettings>(DEFAULT_EFFECTIVE_SETTINGS);
	// A reorder is ALWAYS meaningful now: the queue is a stored ordered list and a move rewrites
	// it, so there is no policy that can discard the move. This used to be false under `shuffle`, whose
	// rank came from the entry id and re-derived over any reorder — nothing re-derives a position now,
	// so a drag on a shuffled list simply rearranges the stored list like anywhere else.
	const canReorder = true;
	// HOST reorder: a host can drag ANY song to any global slot, not just reorder their
	// The list heading named the order "rotation" unconditionally, which stops being true the moment
	// the room picks anything else. Eyes-on: it still said ROTATION with the room on first-come-first-served.
	const orderLabel = $derived(queueOrderLabel(settings.room.queueOrder));

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
			settings = room.settings;
			awaySingers = room.awaySingers;
			mediaStatus = room.mediaStatus;
			roomGuideDefault = room.roomGuideDefault;
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


	/**

	 *  proc, the network call lives here and the LyricsReselect control just reports the choice. */
	async function reselectLyrics(mediaId: string, choice: { ref?: string; text?: string }) {
		if (navigator.vibrate) navigator.vibrate(12);
		try {
			const res = await fetch('/api/lyrics-reselect', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ mediaId, ...choice })
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				showError(body.error ?? 'Could not re-time the lyrics');
			}
		} catch {
			showError('Could not re-time the lyrics — check your connection');
		}
	}

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
	function moveGlobal(id: string, delta: number) {
		const i = queuedIdx(id);
		if (i < 0) return;
		store?.moveToIndex(id, i + delta);
		if (navigator.vibrate) navigator.vibrate(8);
	}

	/* ── THE OWN-PICKS REORDER MODE (XR-PH-17 … XR-PH-20, issue an earlier change) ──────────────────────────────
	 *
	 * A drag, not a list sort. Under `move-to-index` the drop commits a GLOBAL queued index, so a
	 * drag can place a song above ANY other — but the guest's picks are not adjacent in this flat list,
	 * and neither is any target position implied by proximity. So the mode DRAWS its legal positions (one
	 * per queued row) instead of letting the list imply them, and declines a release anywhere else. Every
	 * predicate is in $lib/reorder-mode so it is unit-testable without mounting this route (XR-PH-21).
	 */
	/**
	 * Travel below which a press-and-release is a TAP rather than a drop, in px. 6px is the reorder
	 * mode's OWN threshold and this is now its only definition — it was shared with the queue sheet's
	 * pull until that surface was deleted, so the value is inherited, not arbitrary: it is the
	 * travel a thumb produces incidentally while pressing, below which treating the release as a drop
	 * dissolves the mode the guest was trying to open. Raising it makes short deliberate drags read as
	 * taps; lowering it makes a steady press read as a drop. `reorder-mode-source-836.test.ts` pins the
	 * name and the comparison, not this number.
	 */
	const TAP_SLOP_PX = 6;
	const slots = $derived(queueSlots(queued.length));
	// The row being dragged, the slot currently under the pointer, and the live pointer offset.
	let movingId = $state<string | null>(null);
	/**
	 * True only BETWEEN a press on the grip and its release — not for the life of the mode.
	 *
	 * The distinction is load-bearing, not bookkeeping. The dragged row is `pointer-events: none` so it
	 * cannot intercept the hit-test for its own drop slot; if that state persisted for the whole mode,
	 * the row's own grip would stay untouchable after the first tap and a second press could never start
	 * a drag. Measured: with the two conflated, a tap opened the mode and every later drag did nothing.
	 */
	let dragging = $state(false);
	let hoverSlot = $state<number | null>(null);
	let dragY = $state(0);
	// Why the mode closed itself. Announced through the SAME polite region the queue already uses
	// (`liveMsg`) rather than a second one: two competing live regions is how one of them stops being
	// read. Also rendered as visible text, because a sighted guest needs the reason just as much.
	let reorderNote = $state('');
	const reorderOpen = $derived(movingId !== null);
	// The grip that opened the mode, so focus can be returned to it on every exit (XR-PH-19).
	let openerEl: HTMLElement | null = null;
	// The listeners added for the life of one drag, torn down together so a cancelled pointer cannot
	// leave the page tracking a finger that is gone.
	let dragTeardown: (() => void) | null = null;

	function gripFor(e: QueueEntry): boolean {
		// Any queued row is draggable now: `move-to-index` can place a song at any global slot, so
		// the grip is legitimate on every row, not just the actor's own. `e` is kept in the signature so
		// the template still asks the predicate per-row (a hard-coded literal on every row is the recorded
		// regression) and so a later per-row rule has somewhere to read from.
		void e;
		return gripVisible({
			queuedCount: queued.length,
			reorderMeaningful: canReorder
		});
	}

	/*
	 * an earlier change widened every queued row into a legal drop target, so there are no longer rows the mode must
	 * de-emphasise or take controls from: the single-pointer alternative (up/down) stays live on EVERY
	 * row, which is XR-PH-20 satisfied for the whole list rather than just the actor's own row. Under the
	 * old own-picks `move`, another guest's row could not accept a drop, so the mode froze its controls
	 * and dimmed it; that reasoning is gone now that any row is droppable.
	 *
	 * The helper is kept (returning a constant `false`) so the two call sites keep one named, greppable
	 * suppression point — a later mode that DOES need to freeze a row (a host-only drag, say) has an
	 * obvious place to express it, and the source guard has a stable symbol to scan.
	 */
	function rowFrozen(e: QueueEntry): boolean {
		void e;
		return false;
	}

	function enterReorder(id: string, opener: HTMLElement | null) {
		if (movingId === id) return;
		movingId = id;
		hoverSlot = queuedIdx(id) >= 0 ? queuedIdx(id) : null;
		dragY = 0;
		reorderNote = '';
		openerEl = opener;
		// Focus the grip NOW, so the return on exit has somewhere to land. A pointer press does not focus
		// a button in every engine, and a mode entered by touch that then exits by Escape would otherwise
		// have no recorded origin to go back to — measured by driving a real pointer, where `activeElement` was
		// still <body> after the grip was clicked.
		opener?.focus?.();
	}

	/** Leave the mode. `commitSlot` is null for Cancel/Escape/an illegal release — which commit NOTHING. */
	function exitReorder(commitSlot: number | null, note = '') {
		const id = movingId;
		dragTeardown?.();
		dragTeardown = null;
		const target = dropTarget(commitSlot, queued.length);
		if (id && target !== null && target !== queuedIdx(id)) {
			store?.moveToIndex(id, target);
			if (navigator.vibrate) navigator.vibrate(8);
		}
		movingId = null;
		dragging = false;
		hoverSlot = null;
		dragY = 0;
		reorderNote = note;
		if (note) liveMsg = note;
		// XR-PH-19: focus goes back to the control the guest was working from, on EVERY exit — Done,
		// Cancel, Escape and a self-close alike. A mode that dissolves and drops focus to <body> leaves
		// a keyboard user at the top of the document with no idea the list moved.
		//
		// After `tick()`, and by ATTRIBUTE rather than by the element reference: closing the mode removes
		// the drop-slot buttons from this list, so Svelte recreates the row's DOM and the grip that was
		// pressed is a detached node. Focusing the captured reference put focus nowhere — measured, not
		// assumed. `openerEl` stays as the fallback for the case where the row itself has gone (the song
		// started, or was removed), where there is no grip left to return to.
		tick().then(() => {
			const sel = id ? `[data-grip="${CSS.escape(id)}"]` : '';
			const el = sel ? (document.querySelector(sel) as HTMLElement | null) : null;
			(el ?? openerEl)?.focus?.();
			openerEl = null;
		});
	}

	/**
	 * The pointer drag. The idiom: capture the pointer on the control that was pressed, publish the
	 * offset as a CSS custom property, and let a CSS transform do the moving — so no position is ever
	 * interpolated in JS (XR-PH-06). The queue sheet's pull used the same idiom before it was deleted
	 *; this is the only drag on the phone now.
	 *
	 * The slot under the finger is read by hit-testing rather than computed from row heights: rows can
	 * change height while the mode is open (a byline gains an `away` badge, another guest queues a
	 * processing card), and a cached geometry table would then point at the wrong slot — the precise class
	 * of "commits somewhere the guest did not choose" that XR-PH-18 exists to prevent.
	 */
	function onGripPointerDown(entry: QueueEntry, e: PointerEvent) {
		const grip = e.currentTarget as HTMLElement | null;
		if (!grip) return;
		enterReorder(entry.id, grip);
		dragging = true;
		const startY = e.clientY;
		/*
		 * THE LISTENERS GO ON `window`, NOT ON THE GRIP — and not behind `setPointerCapture`.
		 *
		 * Entering the mode inserts the drop-slot buttons into this list, so Svelte re-renders the rows
		 * and the grip that was pressed becomes a DETACHED node. Listeners bound to it, and a pointer
		 * captured by it, then deliver nothing: the drag produced no `pointermove` and the release never
		 * arrived, so a real drag moved no row and never closed the mode. Both symptoms had one cause,
		 * and only a driven pointer could show it — the element identity is invisible to a unit test.
		 * `window` is stable for the life of the gesture, which is exactly the lifetime this needs.
		 */
		const move = (ev: PointerEvent) => {
			dragY = ev.clientY - startY;
			const under = document.elementFromPoint(ev.clientX, ev.clientY);
			const slotEl = under?.closest?.('[data-slot]') as HTMLElement | null;
			const idx = slotEl ? Number(slotEl.dataset.slot) : null;
			hoverSlot = idx !== null && Number.isInteger(idx) ? idx : null;
		};
		const up = () => {
			/*
			 * TAP vs DRAG. A press and release without travel is a TAP: it should OPEN the mode and leave
			 * it open, so the guest can then use a slot or the move buttons. Treating every release as a
			 * drop made a tap open and immediately close the mode — `hoverSlot` starts at the row's own
			 * index, so the release resolved to "move to where you already are" and dissolved the mode in
			 * one frame. Found by driving it with a real trusted pointer; no unit test could have seen it.
			 *
			 * Above the threshold the release IS a drop, and a drop outside a legal slot commits nothing
			 * (XR-PH-18) — `exitReorder` routes it through `dropTarget`, which declines rather than clamps.
			 */
			const travelled = Math.abs(dragY);
			if (travelled <= TAP_SLOP_PX) {
				dragTeardown?.();
				dragTeardown = null;
				dragging = false;
				dragY = 0;
				return; // the mode stays open, and the row becomes touchable again
			}
			exitReorder(hoverSlot);
		};
		const cancel = () => exitReorder(null);
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
	 * XR-PH-19 — the queue moves underneath the mode, and that is NORMAL. `assignSeqs` re-derives every
	 * rotationSeq on every mutation, so another guest's add re-orders the flat list under an open drag.
	 * That case needs no handling at all and deliberately gets none: the slots are indexed over MY
	 * picks, so a stranger's entry cannot shift them. What DOES invalidate the mode is my own picks
	 * falling below two, my song starting, or my song leaving — each of which makes the drawn slots a
	 * lie. Then the mode closes itself, says why, and returns focus.
	 */
	$effect(() => {
		const reason = modeInvalidation(queued, movingId, entries.find((e) => e.id === movingId)?.status);
		if (reason) exitReorder(null, reason);
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

	function sendPlayer(command: PlayerCommand) {
		room.command(command);
	}
	const nowEntry = $derived(entries.find((e) => e.id === playback.currentEntryId));
	const nowMedia = $derived(nowEntry ? mediaCatalog.get(nowEntry.mediaId) : undefined);
	// key-shift is available only once a song's stems are separated — there is nothing to re-pitch before
	const keyShiftEnabled = $derived(!!nowMedia && isPlayable(nowMedia));
	const keyLabel = $derived(
		playback.keyShift === 0 ? 'Key' : `Key · ${playback.keyShift > 0 ? '+' : '−'}${Math.abs(playback.keyShift)}`
	);

	// ── key line + vocal range readout ──────────────────────────────────
	// The now-playing song's musical profile, derived once. All the music judgement lives in the shared
	// pure helpers; this file only decides WHEN to show each string. Everything that takes keyShift is
	// re-read reactively, so tapping ±semitone slides the sounding key, the range label, the band
	// sentence AND the bar in lockstep.
	const profile = $derived(nowMedia?.songProfile ?? null);
	/*
	 * The key line: ORIGINAL → SOUNDING, collapsing to just the original at shift 0. Both helpers
	 * return null below the confidence floor / with no detected key, so `keyOriginal` being null is the
	 * single gate that hides the whole line — a wrong key is worse than no key (see song-profile.ts).
	 * The arrow MUST be <Icon name="arrow-right" />, never a U+2192 glyph: icons.test.ts bans that
	 * codepoint from every client surface. The keys themselves are ASCII 'G#'/'Ab' from the helper.
	 */
	const keyOriginal = $derived(originalKeyLabel(profile));
	const keySounding = $derived(soundingKeyLabel(profile, playback.keyShift));
	// Show the arrow + sounding key only when a shift actually changed the sounding key from the
	// original — at shift 0 they are equal and the arrow would be noise.
	const keyShifted = $derived(playback.keyShift !== 0 && keySounding !== null && keySounding !== keyOriginal);

	// The range readout, gated on a usable measured range (null helpers = nothing to show).
	const rangeText = $derived(rangeLabel(profile, playback.keyShift));
	const octaves = $derived(rangeOctaves(profile));
	const bandSentence = $derived(voiceBandSentence(profile, playback.keyShift));
	// Is there anything at all to disclose? The section header only renders when at least one fact exists.
	const hasRange = $derived(rangeText !== null);
	/*
	 * Plain $state disclosure, mirroring the 'Browse' toggle idiom in this same file (a bare boolean +
	 * aria-expanded + {#if} + a chevron-down/right Icon swap). There is no generic Disclosure component
	 * and the task forbids inventing one, so this is intentionally the same three-line pattern.
	 */
	let rangeOpen = $state(false);

	// ── guiding track ──────────────────────────────────────────────────
	// How loud the original vocals sit under the instrumental. Available only for a song that actually
	// HAS an isolated vocals stem — the same shape as the key control being gated on separation.
	const guideEnabled = $derived(!!nowMedia && hasGuidingTrack(nowMedia));
	/** The room's standing default, adopted from queue:sync / settings:changed. */
	let roomGuideDefault = $state(0);
	/**
	 * While a finger is on the slider we show the LOCAL value, not the server's. Without this the
	 * thumb fights the ~throttled echo coming back over the websocket and jumps under the finger.
	 */
	let guideDragging = $state(false);
	let guideDraft = $state(0);
	const guideServerPct = $derived(
		Math.round(effectiveGuideLevel({ guideLevel: playback.guideLevel }, roomGuideDefault) * 100)
	);
	const guidePct = $derived(guideDragging ? guideDraft : guideServerPct);

	/**
	 * Send at most this often while dragging. Every accepted level is authoritative playback state, so
	 * it bumps `rev` and broadcasts to every client — an unthrottled `oninput` would emit one of those
	 * per animation frame and churn rev hard enough to trip other clients' resync path. The `onchange`
	 * on release always sends the final value, so throttling can never lose where the finger stopped.
	 */
	const GUIDE_SEND_THROTTLE_MS = 120;
	let guideLastSent = 0;
	let guidePending: ReturnType<typeof setTimeout> | null = null;

	function sendGuide(pct: number): void {
		guideLastSent = Date.now();
		sendPlayer({ cmd: 'guide', level: pct / 100 });
	}

	function onGuideInput(pct: number): void {
		guideDragging = true;
		guideDraft = pct;
		const since = Date.now() - guideLastSent;
		if (since >= GUIDE_SEND_THROTTLE_MS) {
			sendGuide(pct);
			return;
		}
		// Trailing send so a slow drag that never crosses the threshold still moves the TV.
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

	// ── the guest's own place in the rotation, in WORDS (XR-PH-09, issue an earlier change) ──────────────
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

	/*
	 * The hero shows the song and the artist on SEPARATE lines, so it needs them apart — `mediaTitle`
	 * welds them into one string for the queue rows. songDisplay is the shared helper that prefers the
	 * canonical pair (a full YouTube title with the uploader as the "artist" is what the cards used to
	 * show); the key is appended because "G major" belongs with the artist, not with the controls.
	 */
	const nowDisplay = $derived(songDisplay(nowMedia));
	const heroByline = $derived.by(() => {
		if (!nowEntry) return null;
		const parts: string[] = [];
		/*
		 * `?? nowMedia?.artist` is deliberate and it is the PHONE's rule, not a weakening of songDisplay.
		 * songDisplay is written for the TV, where the uploader must never appear as the artist; SongRow
		 * (:143) draws a READY row as `artistCanonical ?? artist` because by then the uploader IS the
		 * useful fact. The hero renders a PLAYING song — necessarily ready — and a hero that drops the
		 * artist the row two taps earlier displayed is the two-surfaces-disagreeing shape this codebase
		 * has already hit twice. Measured on a driven frame: the browse row said "Bon Jovi" and the hero
		 * said nothing, because these demo tracks carry `artist` and no `artistCanonical`.
		 */
		const artist = nowDisplay.artist ?? nowMedia?.artist ?? null;
		if (artist) parts.push(artist);
		if (keyOriginal) parts.push(keyOriginal);
		return parts.length ? parts.join(' · ') : null;
	});

	/**
	 * The collapsed live-controls summary on the hero — the current values, so the disclosure still says
	 * where the controls stand while shut (XR-PH-15). Built from the same derivations the controls
	 * themselves render, so the two cannot disagree.
	 */
	const controlsSummary = $derived.by(() => {
		const parts: string[] = [];
		if (guideEnabled) parts.push(`Guide vocals ${guidePct}%`);
		if (keyShiftEnabled && playback.keyShift !== 0) parts.push(keyLabel);
		if (rangeText) parts.push(`Range ${rangeText}`);
		return parts.length ? parts.join(' · ') : null;
	});

	/**
	 * XR-PH-15's honest degradation, as ruled on an earlier change Q1-D: when the playing song has no isolated
	 * vocals stem the guide control renders DISABLED rather than vanishing, and this sentence — on the
	 * hero, beside the control group — says why and what still works. an earlier change deleted the equivalent line
	 * from inside `GuidingTrack.svelte` and `drawer-ui-cleanup-253.test.ts` pins its absence there, so
	 * arm D is what satisfies both rulings: the component and its guard stay untouched.
	 *
	 * `nowMedia && !guideEnabled` is the precise condition, not `!guideEnabled` alone. `guideEnabled`
	 * is also false for a playing entry whose media row has not reached this client's catalog, and
	 * there the honest answer is that we do not know yet — asserting a missing stem would be a guess.
	 * With a media row in hand the reading is exact: a song that is PLAYING is already `isPlayable`,
	 * so the only remaining term in `hasGuidingTrack` is `vocalsRef`, and the stem is what is absent.
	 *
	 * The second clause is measured, not reassurance: pitch and range are gated on `isPlayable`, which
	 * that same playing song satisfies, so they really are still live while the guide is not.
	 */
	const controlsNote = $derived(
		nowMedia && !guideEnabled
			? 'No isolated vocals for this song, so the guiding track stays off. Key and vocal range still work.'
			: null
	);
</script>

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

<main>
	{#if me}
			<!--
			HOME IS THE QUEUE (direction A, issue an earlier change). The playing song is the one thing on this screen
			that is not a list item, so it gets a HERO rather than the docked peek row it used to share with
			the rotation; the bottom of the screen belongs to the one primary button instead.

			The live singing controls come with it, in the hero's disclosure BODY (XR-PH-15) — they are
			controls for the song playing NOW, and the sheet that used to hold them is gone from this route.
			A song with no isolated vocals stem keeps the guide row, disabled, and gets `controlsNote`
			beside the group saying why and what still works (Q1-D). Who may operate the controls
			mid-song is a separate, still-open policy row (XR-PH-16); nothing about that changes here.
		-->
			<NowPlayingHero
				title={nowEntry ? nowDisplay.title || mediaTitle(nowEntry.mediaId) : 'Nothing playing'}
				singerName={nowEntry ? (singerOf(nowEntry.singerId)?.displayName ?? 'Someone') : null}
				singerColor={nowEntry ? (singerOf(nowEntry.singerId)?.color ?? SINGER_COLORS[0]) : null}
				byline={heroByline}
				hint={nowEntry ? null : queued.length === 0 ? 'Queue a song to start the party' : 'Starting the next song…'}
				elapsedSec={displayPos}
				durationSec={nowDurationSec}
				isPlaying={playback.isPlaying}
				hasSong={!!nowEntry}
				canStart={queued.length > 0}
				onrestart={() => sendPlayer({ cmd: 'restart' })}
				ontoggleplay={() => sendPlayer({ cmd: playback.isPlaying ? 'pause' : 'play' })}
				onskip={() => sendPlayer({ cmd: 'skip' })}
				controlsSummary={controlsSummary}
				controlsNote={controlsNote}
			>
				{#snippet controls()}
					<!-- Guiding track: how loud the ORIGINAL vocals sit under the instrumental. Above the Key control,
				     sharing its labelled-row idiom; both are per-song adjustments to the same playing song. -->
					<GuidingTrack pct={guidePct} available={guideEnabled} oninput={onGuideInput} oncommit={onGuideCommit} />

					<!--
					KEY LINE. A value row ABOVE the ± buttons, NOT inline in `.key`: `.key` is a no-wrap flex with two
					flex:1 buttons, so a third inline element crushes both below their 44px target at 480px. It
					carries NO label of its own — `.key` already says "Key" beside the buttons it belongs to, and two
					"KEY" labels stacked two rows apart read as two different controls. So this row is the value
					only, right-aligned to sit over the buttons. Shows the ORIGINAL key, then an arrow, then the
					SOUNDING key; collapses to just the original at shift 0. Renders nothing when the key is
					undetected / low-confidence (keyOriginal === null) — a wrong key is worse than none. The arrow is
					an Icon, not a U+2192 glyph (icons.test.ts bans that codepoint); the key names are ASCII from the
					helper.
				-->
					{#if keyOriginal}
						<div class="key-head" class:shifted={keyShifted}>
							<span class="key-vals">
								<span class="key-orig">{keyOriginal}</span>
								{#if keyShifted}
									<span class="key-arrow"><Icon name="arrow-right" /></span>
									<span class="key-sound">{keySounding}</span>
								{/if}
							</span>
						</div>
					{/if}

					<div class="key" class:disabled={!keyShiftEnabled} class:shifted={playback.keyShift !== 0}>
						<span class="lab">{keyLabel}</span>
						<!--
							`.key-cell` carries the flex behaviour, which cannot move into the component: `flex: 1 1 40%`
							and `min-width: 0` belong to the FLEX ITEM, and the item is now an element Button renders.
							The basis lets the pair sit two-up when they fit and wrap to their own rows when they cannot;
							`min-width: 0` frees the flex minimum so the shrink is allowed at all, and the variant's
							`overflow-wrap` breaks "semitone" if even a full-width button is too narrow for it.
						-->
						<div class="key-cell">
							<Button
								variant="keycap"
								size="block"
								disabled={!keyShiftEnabled || playback.keyShift <= -7}
								onclick={() => sendPlayer({ cmd: 'key', semitones: playback.keyShift - 1 })}
							>
								<Icon name="minus" /> semitone
							</Button>
						</div>
						<div class="key-cell">
							<Button
								variant="keycap"
								size="block"
								disabled={!keyShiftEnabled || playback.keyShift >= 7}
								onclick={() => sendPlayer({ cmd: 'key', semitones: playback.keyShift + 1 })}
							>
								<Icon name="plus" /> semitone
							</Button>
						</div>
					</div>

					<!--
					VOCAL RANGE, behind a disclosure. Same idiom as the 'Browse' toggle above: a plain $state
					boolean, a real <button> carrying aria-expanded, a chevron-down/right Icon swap, and a 44px
					target. Only rendered when there is a measured range to show (hasRange). Everything inside reacts
					to playback.keyShift through the shared helpers, so the ± buttons slide the bar and can flip the
					band sentence — which is what makes transposing feel like it means something.
				-->
					{#if hasRange}
						<div class="range">
							<!-- an earlier change: Collapsible owns `aria-expanded`, `aria-controls` and the toggle. The <button> stays
							here via Bits UI's `child` snippet, so its scoped class in this file still applies. -->
							<Collapsible.Root bind:open={rangeOpen}>
								<Collapsible.Trigger>
									{#snippet child({ props })}
										<Button variant="eyebrow" size="block" {...props}>
											<Icon name={rangeOpen ? 'chevron-down' : 'chevron-right'} />
											Vocal range
											<span class="range-peek">{rangeText}</span>
										</Button>
									{/snippet}
								</Collapsible.Trigger>
								<Collapsible.Content>
									{#snippet child({ props })}
										<div class="range-body" {...props}>
											<div class="range-facts">
												<span class="range-label">{rangeText}</span>
												{#if octaves !== null}<span class="range-oct">{octaves} oct</span>{/if}
											</div>
											{#if bandSentence}<p class="range-band">{bandSentence}</p>{/if}
											<RangeBar profile={profile} keyShift={playback.keyShift} />
										</div>
									{/snippet}
								</Collapsible.Content>
							</Collapsible.Root>
						</div>
					{/if}

					<!--
					The TV stage look lives ONLY in room settings now. The per-song override that used to sit here
					(a phone repainting the stage for the current song via sendPlayer 'background') was removed: the
					stage is a room-wide decision, not a per-singer one, so a single writer in Settings is correct.
					The server command, PlaybackState.background field and the TV resolver are deliberately kept —
					with no writer the field simply stays null and the resolver already falls back to the room style.
				-->

					<!--
					Lyrics re-select: the per-song fallback for wrong / wrongly-chosen lyrics. Any joined
					singer may re-pick (Q1=A). Only shown once the song has candidates on disk; the control itself
					hides when there is nothing to choose. The pick is re-timed server-side from the retained vocals.
				-->
					{#if nowMedia && nowMedia.lyricsCandidates?.length}
						<LyricsReselect
							candidates={nowMedia.lyricsCandidates}
							chosenRef={chosenCandidate(nowMedia)?.ref}
							overrideRef={nowMedia.lyricsOverrideRef}
							newerExists={hasNewerCandidateThanOverride(nowMedia.lyricsCandidates, nowMedia.lyricsOverrideRef)}
							onpick={(ref) => reselectLyrics(nowMedia.id, { ref })}
							onpaste={(text) => reselectLyrics(nowMedia.id, { text })}
						/>
					{/if}
				{/snippet}
			</NowPlayingHero>

			<!-- The guest's own place, in words, with the wait omitted rather than guessed (XR-PH-09). -->
			<MyPositionCard words={myPosition} />

			<h2 class="grouphead">Up next · {orderLabel}</h2>
			<!--
			XR-PH-19 — the mode's own chrome. Done and Cancel are REAL buttons rather than a tap-anywhere
			dismissal, because "commit" and "abandon" are different outcomes and a mode that exits one way
			cannot express the other. Escape is bound on <svelte:window> below and takes the Cancel path.
			The note is a polite live region: a mode that closes ITSELF (my pick started playing, my second
			pick was removed elsewhere) has to say why, or the list simply changes shape under the guest.
		-->
			{#if reorderOpen}
				<div class="reorder-bar card" role="group" aria-label="Reordering your songs">
					<p class="reorder-hint">Drag to any position in the queue.</p>
					<div class="reorder-acts">
						<Button variant="secondary" size="tap" onclick={() => exitReorder(hoverSlot)}>Done</Button>
						<Button variant="ghost" size="tap" onclick={() => exitReorder(null)}>Cancel</Button>
					</div>
				</div>
			{/if}
			{#if !reorderOpen && reorderNote}
				<!-- The mode closed ITSELF (XR-PH-19). Visible as well as announced: the list has just changed
			     shape under the guest's hand, and a reason only a screen reader gets is not a reason. -->
				<p class="reorder-note">{reorderNote}</p>
			{/if}
			{#if queued.length === 0}
				<Empty.Root>
					<Empty.Header>
						<Empty.Description>Queue's empty — add a song to start the party.</Empty.Description>
					</Empty.Header>
				</Empty.Root>
			{:else}
				{#each queued as e, i (e.id)}
					{@const s = singerOf(e.singerId)}
					{@const card = queueCardKind(mediaCatalog.get(e.mediaId), mediaStatus.get(e.mediaId))}
					<!--
					XR-PH-18 — ONE legal drop target per queued row, drawn immediately above the row whose
					position it represents, and rendered ONLY while the mode is open. The count equals
					`queued.length` by construction — `slots` is derived from the queued list — so the slot at
					index `i` commits the global queued index `i`, which is the `toIdx` `move-to-index` uses.

					`data-slot` carries the index the release commits. The pointer path reads it by hit-testing
					(see onGripPointerDown) instead of from a geometry table, and the same index is what the
					button's own click commits — so the keyboard path and the pointer path cannot drift apart.
				-->
					{#if reorderOpen && slots[i]}
						{@const slot = slots[i]}
						<button
							class="dropslot"
							class:hot={hoverSlot === slot.index}
							data-slot={slot.index}
							aria-label={slot.label}
							onclick={() => exitReorder(slot.index)}>{slot.ordinal}</button
						>
					{/if}
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
							canUp={queuedIdx(e.id) > 0}
							canDown={queuedIdx(e.id) >= 0 && queuedIdx(e.id) < queued.length - 1}
							dimmed={false}
							onup={() => moveGlobal(e.id, -1)}
							ondown={() => moveGlobal(e.id, 1)}
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
							reorderable={!rowFrozen(e) && canReorder && !!me?.id && queued.length > 1}
							canUp={queuedIdx(e.id) > 0}
							canDown={queuedIdx(e.id) >= 0 && queuedIdx(e.id) < queued.length - 1}
							grip={gripFor(e)}
							gripId={e.id}
							dimmed={false}
							moving={movingId === e.id && dragging}
							dragY={movingId === e.id && dragging ? dragY : 0}
							ongripdown={(ev) => onGripPointerDown(e, ev)}
							ongrip={(el) => enterReorder(e.id, el)}
							onremove={() => removeWithUndo(e)}
							onup={() => moveGlobal(e.id, -1)}
							ondown={() => moveGlobal(e.id, 1)}
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
<!--
	XR-PH-19 — Escape leaves the mode and commits NOTHING. Bound here rather than on the bar so it
	works while the pointer is captured by the grip and while focus sits anywhere on the page, which is
	where focus actually is mid-drag. Guarded on `reorderOpen` so it never swallows an Escape the rest
	of the page wants.
-->
<svelte:window onkeydown={(e) => reorderOpen && e.key === 'Escape' && exitReorder(null)} />

<div class="sr-live" role="status" aria-live="polite" aria-atomic="true">{liveMsg}</div>

<style>
	/*
	 * The search dock is docked at the bottom, so the column must be able to scroll clear of it
	 * (XR-PH-12): the padding reserves the band's MEASURED height (--dock-h), which is what keeps the
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
	.key-cell {
		/*
		 * `1 1 40%`, not `1`: at 200% text a nowrap `flex: 1` pair could not shrink below the min-content
		 * width of "semitone" (~172px each), so the two buttons plus the label forced the row — and the
		 * sheet around it — past 320px. A 40% basis lets both sit two-up when they fit and wrap to their
		 * own rows when they cannot; `min-width: 0` frees the flex minimum so the shrink is allowed at
		 * all, and the `keycap` variant's `overflow-wrap` breaks the single word if even a full-width
		 * button is too narrow for it. The row's own `flex-wrap` is what catches them.
		 */
		flex: 1 1 40%;
		min-width: 0;
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
	 * THE REORDER MODE's own chrome.
	 *
	 * No transition and no keyframe anywhere in this block. The mode appears and disappears on a state
	 * change, and the dragged row's movement is a CSS transform reading a var the pointer writes (see
	 * QueueRow's `.moving`) — so nothing here interpolates over time and XR-PH-06 has nothing to gate.
	 * That is a deliberate alternative to pulling in a drag library, whose JS-written settle animation
	 * would be invisible to `motion.test.ts` by construction.
	 */
	.reorder-bar {
		display: flex;
		align-items: center;
		gap: var(--space-md);
		flex-wrap: wrap;
		padding: var(--space-md) var(--space-lg);
		margin-bottom: var(--space-sm);
		border-color: var(--line-tint);
		background: var(--card-tint);
	}
	.reorder-hint {
		flex: 1 1 auto;
		min-width: 0;
		margin: 0;
		font-size: var(--ph-text-sm);
		color: var(--ink-dim);
	}
	.reorder-acts {
		display: flex;
		gap: var(--space-sm);
		flex: 0 0 auto;
	}
	.reorder-note {
		margin: 0 0 var(--space-sm);
		font-size: var(--ph-text-sm);
		color: var(--warn);
	}
	/*
	 * A legal drop position (XR-PH-18). A real <button>, so the position is committable without a
	 * pointer at all — the drag and the keyboard commit the SAME index through the same handler, which
	 * is what keeps them from drifting apart. 44px tall, matching every other control on this screen,
	 * so the target the finger has to find is not smaller than the finger.
	 *
	 * `--line-strong` dashed reads as "a place something goes" rather than as a control that does
	 * something on its own, and `.hot` swaps the SURFACE (not opacity) when the finger is over it.
	 */
	.dropslot {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		/*
		 * The TOKEN, not the number. `--tap` is the standard; a bare `44px` merely agrees with it
		 * today, so raising the standard in `app.css` would leave this control behind while every touch
		 * guard stayed green. `expressesTap` in `test-helpers.ts` asks for the token for that reason.
		 */
		min-height: var(--tap);
		margin-bottom: var(--space-xs);
		border: 2px dashed var(--line-strong);
		border-radius: var(--radius-sm);
		background: var(--bg2);
		color: var(--ink-dim);
		font-size: var(--ph-text-sm);
		font-weight: 600;
		cursor: pointer;
	}
	.dropslot.hot {
		/* var(--accent), not the retired --accent-strong (XR-COL-11) — a non-text border. */
		border-color: var(--accent);
		background: var(--card-tint2);
		color: var(--ink);
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
	.empty {
		color: var(--ink-dim);
		padding: 0 var(--space-2xs);
		font-size: var(--ph-text-md);
	}
	.key {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xs);
		margin: var(--space-xs) 0 var(--space-3xs);
		align-items: center;
	}
	.key.disabled {
		opacity: 0.5;
	}
	.key .lab {
		font-size: var(--ph-text-2xs);
		color: var(--ink-dim);
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}
	.key.shifted .lab {
		color: var(--warn);
	}
	/* Centre the mark with its word. The glyphs these replaced were U+2212 and U+FF0B — the fullwidth
	   plus carries CJK metrics, so it sat off-baseline beside Latin text at every size. */

	/*
	 * The key head line. Sits ABOVE the ± buttons (see the markup comment for why it cannot be inline).
	 * Same label idiom as.gt-head /.key.lab. The original→sounding pair reads left to right; the
	 * sounding key takes the warn colour to echo `.key.shifted .lab`, so "you have changed the key" is
	 * signalled the same way in both places.
	 */
	.key-head {
		display: flex;
		align-items: baseline;
		/* flex-end, not space-between: with the row's own label removed there is a single child, and
		   space-between would push it to the START. The value belongs over the buttons on the right. */
		justify-content: flex-end;
		gap: var(--space-sm);
		margin: var(--space-sm) 0 0;
	}
	.key-vals {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		font-variant-numeric: tabular-nums;
	}
	.key-orig {
		font-size: var(--ph-text-sm);
		font-weight: 700;
		color: var(--ink);
	}
	/* The arrow is an Icon (banned as a glyph); size it to the text and dim it so the keys read as the
	   content and the arrow as mere connective tissue. */
	.key-arrow {
		display: inline-grid;
		place-items: center;
		color: var(--ink-dim);
		font-size: var(--ph-text-sm);
	}
	.key-sound {
		font-size: var(--ph-text-sm);
		font-weight: 700;
		color: var(--warn);
	}

	/*
	 * The vocal-range disclosure: a var(--tap) min-height button, an uppercase
	 * label, a chevron that swaps down/right with the open state, and a peek of the range value on the
	 * collapsed row so the section states its headline fact without being opened.
	 */
	.range {
		margin: var(--space-sm) 0 var(--space-3xs);
	}
	/* The collapsed-row peek of the range, pushed to the right. Not uppercase — it is data, not a label. */
	.range-peek {
		margin-left: auto;
		color: var(--accent2);
		text-transform: none;
		letter-spacing: 0;
		font-size: var(--ph-text-sm);
		font-variant-numeric: tabular-nums;
	}
	.range-body {
		padding: var(--space-3xs) var(--space-3xs) var(--space-2xs);
	}
	.range-facts {
		display: flex;
		align-items: baseline;
		gap: var(--space-md);
	}
	.range-label {
		font-size: var(--ph-text-base);
		font-weight: 700;
		color: var(--ink);
		font-variant-numeric: tabular-nums;
	}
	.range-oct {
		font-size: var(--ph-text-xs);
		color: var(--ink-dim);
		font-variant-numeric: tabular-nums;
	}
	.range-band {
		font-size: var(--ph-text-xs);
		color: var(--ink-dim);
		margin: var(--space-2xs) 0 0;
	}
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
	 * height, and an inline custom property on :root outranks this rule — so a smaller value written
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
