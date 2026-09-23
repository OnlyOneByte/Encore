<script lang="ts">
	import { SINGER_COLORS } from '$lib/contract';
	import { onMount, tick } from 'svelte';
	import type { QueueEntry, Media, PublicSinger, PlaybackState } from '$lib/contract';
	import type { QueueStore } from '$lib/stores/queue';
	import { room } from '$lib/stores/room';
	import QueueRow from '$lib/components/QueueRow.svelte';
	import JoinLanding from '$lib/components/JoinLanding.svelte';
	import ProcessingCard from '$lib/components/ProcessingCard.svelte';
	import SongRow from '$lib/components/SongRow.svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import {
		gripVisible,
		liveSortTarget,
		keyboardMoveTarget,
		rowShift,
		liveSeq,
		ordinal,
		modeInvalidation
	} from '$lib/reorder-mode';
	import {
		nextPlayableEntryId,
		queueCardKind,
		displayReadiness,
		canProcess,
		readyEmptyState,
		processingGroupIds,
		type Readiness
	} from '$lib/readiness';
	import { waitShort } from '$lib/phrasing/position-sentence';
	import { processAndQueue } from '$lib/process-and-queue';
	import { originalKeyLabel, isProcessableSource } from '$lib/contract';
	import type { MediaStatus } from '$lib/contract';
	import { Toaster } from '$lib/components/ui/sonner';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { Spinner } from '$lib/components/ui/spinner';
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
	 * THE ROOM'S QUEUE IS THE HOME SCREEN, and so are the search box and the library — one surface read top to
	 * bottom: the field, what is queued, what is being made, what is ready to sing. `searchActive` (a non-empty
	 * query) is the sole switch between the queue view and the results view; there is no browse MODE and no
	 * `?browse=1`. See the search section's own note for why the box is here rather than docked or on a route.
	 *
	 * BACK MEANS LEAVE THE ROOM at every point on this screen, because there is never anything to back out of:
	 * results render in place and clearing the box restores the queue. No history entry is pushed for a search.
	 */

	/*
	 * Editing your name and colour, and leaving the room, used to live in a sheet mounted here. They now
	 * live on /settings?tab=you — one editor instead of two that could disagree — so the fetches that
	 * backed them (`PATCH /api/me`, `GET|POST /api/leave`) moved with them. The header's name button is
	 * a link to that tab.
	 */

	/*
	 * NO LOCAL COPY OF THE ROOM'S SETTINGS: this route mirrored `room.settings` for one reader, the order word in
	 * the list heading, and the heading is one word now. A mirrored field nobody reads can only go stale. The
	 * STORE reads the order itself for the optimistic reducer, which is a different copy.
	 */
	// A reorder is ALWAYS meaningful now: the queue is a stored ordered list and a move rewrites
	// it, so there is no policy that can discard the move. This used to be false under `shuffle`, whose
	// rank came from the entry id and re-derived over any reorder — nothing re-derives a position now,
	// so a drag on a shuffled list simply rearranges the stored list like anywhere else.
	const canReorder = true;
	// HOST reorder: a host can drag ANY song to any global slot, not just reorder their
	/*
	 * THE LIST HEADING NAMES NO ORDER — it is the one word "Queued". It was `Up next · {orderLabel}`, which said
	 * ROTATION while the room was on first-come-first-served; a label cannot disagree with the room. The order
	 * policy is stated where it is CHOSEN, on /settings.
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
	 * THE ROOM LINK, MIRRORED. The socket, the QueueStore and every broadcast field used to be CONSTRUCTED here,
	 * which made this route the owner of app-wide truth — and is why the band could not become app chrome: a
	 * component in +layout.svelte cannot read a sibling route's locals. `$lib/stores/room.ts` owns them now.
	 *
	 * `sync()` RUNS ONCE BEFORE SUBSCRIBING, which is not belt-and-braces: the link is a singleton that outlives
	 * this component, so on a later navigation back to `/` it is already live and the next emit may be seconds
	 * away. Subscribing alone would render an empty queue until the room happened to say something.
	 *
	 * NOTHING HERE CLOSES THE SOCKET — the connection has to survive navigation, so the layout owns its lifetime.
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
			library = room.library;
			libraryTags = room.libraryTags;
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
	 * The rotation, in the order the room will play it — the queue view's only list, and one of the four
	 * groups this page now renders (see the search note below for the other three).
	 */
	const queued = $derived(entries.filter((e) => e.status === 'queued').sort((a, b) => a.rotationSeq - b.rotationSeq));

	function liveOf(id: string) {
		return mediaStatus.get(id);
	}

	/*
	 * SEARCH AND THE LIBRARY, ON HOME. Third placement of one surface, and the previous two were each right about
	 * something: a box docked to the bottom of this page (typing expanded results upward in place), then its own
	 * route `/find` reached from the band's magnifier ("once it is somewhere you go, a route is what makes the
	 * phone's own back gesture work"). Both readings survive here — the surface is on home, so there is no
	 * navigation and no mode, and it is at the TOP rather than docked, so it never fights the band for the bottom
	 * edge.
	 *
	 * WHAT THE MERGE IS FOR: two screens were answering one question, and the songs already on disk — the whole
	 * point of persisting the catalog — were invisible from the screen a guest sits on.
	 *
	 * THE ZERO-QUERY STATE IS THE LIBRARY, which is the idea the find route contributed: an empty box shows what
	 * can be sung right now, so typing FILTERS the world instead of revealing it.
	 *
	 * A QUERY REPLACES THE QUEUE. It has to replace rather than stack, because the keyboard leaves ~350px: a
	 * field, a heading and two queue rows above the results would push the first match off a phone screen.
	 *
	 * THE RESULTS READ DOWNWARD, best match FIRST. The docked version stacked them upward, best match last,
	 * because the box was at the bottom; with the field at the top, DOM order is visual order again.
	 */
	let library = $state<Media[]>([]);
	let libraryTags = $state<Record<string, string[]>>({});
	let queryEl = $state<HTMLInputElement | null>(null);
	let query = $state('');
	let readyResults = $state<Media[]>([]);
	let rawResults = $state<Media[]>([]);
	let processingResults = $state<Media[]>([]);
	let searching = $state(false);
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	let inflight: AbortController | undefined;
	/** The sole switch between the queue view and the results view. */
	const searchActive = $derived(query.trim().length > 0);

	function onQueryInput() {
		clearTimeout(debounceTimer);
		const q = query.trim();
		if (!q) {
			readyResults = [];
			rawResults = [];
			processingResults = [];
			searching = false;
			inflight?.abort();
			return;
		}
		debounceTimer = setTimeout(() => runSearch(q), 150);
	}

	function clearSearch() {
		query = '';
		onQueryInput();
		queryEl?.focus();
		if (navigator.vibrate) navigator.vibrate(8);
	}

	async function runSearch(q: string) {
		inflight?.abort();
		const ctrl = new AbortController();
		inflight = ctrl;
		searching = true;
		try {
			const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal });
			if (ctrl.signal.aborted) return;
			const j = await res.json();
			readyResults = j.ready ?? [];
			rawResults = j.results ?? [];
			processingResults = j.processing ?? [];
			room.mergeMedia([...readyResults, ...rawResults, ...processingResults]);
		} catch (e) {
			if ((e as Error).name !== 'AbortError') {
				readyResults = [];
				rawResults = [];
				processingResults = [];
				showError('Search failed.');
			}
		} finally {
			if (inflight === ctrl) searching = false;
		}
	}

	// ── readiness and row shaping, for the song rows (not the queue rows) ────
	function readinessFor(m: Media): Readiness {
		return displayReadiness(m, liveOf(m.id));
	}
	const rowMeta = (m: Media) => ({
		title: m.title,
		artist: m.artist,
		artistCanonical: m.artistCanonical,
		thumbnail: m.thumbnail,
		durationSec: m.durationSec,
		viewCount: m.viewCount,
		keyName: originalKeyLabel(m.songProfile) ?? undefined,
		tags: libraryTags[m.id]
	});
	/** Is this song already in MY part of the rotation? Drives the row's "queued" state. */
	function inMyQueue(mediaId: string): boolean {
		return queued.some((e) => e.mediaId === mediaId && e.singerId === me?.id);
	}

	const processingRows = $derived.by(() => {
		const ids = processingGroupIds({
			searchActive,
			processingResults,
			mediaStatus,
			mediaCatalog,
			readiness: readinessFor
		});
		return [...ids]
			.map((id) => ({ id, media: mediaCatalog.get(id), live: liveOf(id) }))
			.filter((r) => r.media)
			.map((r) => ({
				id: r.id,
				media: r.media!,
				pct: r.live?.pct ?? 0,
				etaSec: r.live?.etaSec,
				status: r.live?.status
			}));
	});

	/**
	 * Ids already shown by another group, so no song appears twice in one list.
	 *
	 * THE QUEUE IS ONE OF THOSE GROUPS NOW, which it was not on the find route: a song that is queued AND
	 * processing already has a row on this screen with a live progress bar on it (`ProcessingCard`), so
	 * listing it again under "Making karaoke…" would draw two bars for one job. Only the QUEUED view
	 * accounts that way — while a query is up the queue is not rendered, so it cannot be hiding anything.
	 */
	const accountedFor = $derived.by(() => {
		const ids = new Set<string>();
		for (const m of searchActive ? readyResults : library) ids.add(m.id);
		for (const c of processingRows) ids.add(c.id);
		return ids;
	});
	function unaccounted(list: Media[]): Media[] {
		return list.filter((m) => !accountedFor.has(m.id));
	}
	const queuedMediaIds = $derived(new Set(queued.map((e) => e.mediaId)));
	/** The processing group, minus whatever the queue is already showing a bar for. */
	const processingGroup = $derived(
		searchActive ? processingRows : processingRows.filter((c) => !queuedMediaIds.has(c.id))
	);

	// ── the two queueing actions ────────────────────────────────────────
	function addSong(mediaId: string) {
		store?.addSong(mediaId);
		if (navigator.vibrate) navigator.vibrate(8);
	}
	function singThis(mediaId: string) {
		processAndQueue({
			queue: () => addSong(mediaId),
			process: () => void processMedia(mediaId),
			hasQueuedTurn: inMyQueue(mediaId)
		});
	}
	/** Request stem-separation ("make karaoke"). The live media:status broadcasts drive the row's bar. */
	async function processMedia(mediaId: string) {
		if (navigator.vibrate) navigator.vibrate(12);
		// optimistic: the row reads as processing before the request lands
		room.setMediaStatus(mediaId, { status: 'queued', pct: 0 });
		try {
			const res = await fetch('/api/process', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ mediaId })
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				room.clearMediaStatus(mediaId);
				showError(body.error ?? 'Could not start process');
				return;
			}
			// the stems were already on disk (processed on an earlier night) — nothing to wait for
			if (body.alreadyReady) void room.refreshLibrary();
		} catch {
			room.clearMediaStatus(mediaId);
			showError("Couldn't start that.");
		}
	}

	/*
	 * The library rows: everything ready to sing, minus whatever the processing group above is showing.
	 *
	 * NOT `unaccounted(library)`, which is self-cancelling: with no query `accountedFor` is seeded with every id
	 * in `library` so the secondary lists can subtract the primary one, and `unaccounted` then removes exactly
	 * those ids from the primary list itself. The result was always empty, so "Your library" NEVER RENDERED —
	 * the zero-query state showed "No karaoke tracks yet." over a library of three songs. Two guards assert this
	 * group and both are text scans, so both stayed green; it was found by looking at the screen.
	 *
	 * The QUEUE is deliberately not subtracted. A queued song is still in the library and its row says so
	 * (`inQueue` disables the add) — hiding it would make the library look like it lost a song.
	 */
	const processingIds = $derived(new Set(processingRows.map((c) => c.id)));
	const libraryRows = $derived(library.filter((m) => !processingIds.has(m.id)));

	// ── readiness ────────────────────────────────────────────────────────────
	// One axis, three states: ready (stems on disk, sing now), processing (stems in flight, still queueable
	// because rotation holds its slot), raw (plays with the original vocals). It is not a FILTER: every group
	// renders every time, and the reader narrows the list by typing.

	/*
	 * TOASTS ARE SONNER'S. What that replaced: two hand-rolled fixed surfaces, two timers, a `bind:clientHeight`
	 * on the undo toast and an `$effect` publishing `--undo-h` — because the error toast's offset had to track
	 * that measured height, and the two had already collided once at the same bottom and z-index. Sonner stacks
	 * its own, so every part of that chain is deleted rather than ported.
	 *
	 * The Toaster docks above the measured band with `offset="var(--dock-h, 0px)"`, which works because the token
	 * is published on documentElement and so is readable from sonner's portal.
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

	/* ── REORDERING: A LIVE SORT ───────────────────────────────────────────────
	 *
	 * The row follows the finger, the rows it passes shift out of its way, and the release commits where it
	 * visibly is. No mode: no Done, no Cancel, no drawn drop targets.
	 *
	 * What that replaced was right for `move`, whose index space was the guest's OWN picks — not adjacent in a
	 * flat list, so proximity could not imply a target and the mode had to draw them. Under `move-to-index` every
	 * position is legal, so "draw the legal positions" became one target per row, which is what the list already
	 * shows.
	 *
	 * The requirement is satisfied more strongly, not waived: `liveSortTarget` is the same expression that places
	 * the rows and the one that commits, so a release cannot land somewhere the guest did not see. The
	 * single-pointer alternative (SC 2.5.7 / 2.1.1) moved onto the grip — Arrow Up/Down steps one place. See
	 * `$lib/reorder-mode`.
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
	/**
	 * Every queued row's box, measured ONCE per gesture at press time — what the live sort compares the
	 * dragged row's leading edge against. Empty except during a drag, exactly like `rowH`, so no stale
	 * geometry can place a row while nothing is being dragged.
	 */
	let rowBounds = $state<{ top: number; height: number }[]>([]);
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
			? liveSortTarget({ fromIndex: dragFrom, offsetPx: dragY, rowBoundsPx: rowBounds, count: queued.length })
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
	 * The non-drag reorder, one place per press, straight from the grip. It commits IMMEDIATELY rather than
	 * opening anything, and `keyboardMoveTarget` declines at the ends so a press that cannot move says nothing.
	 * Announced, because the row moves under the guest's focus.
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
		rowBounds = [];
		reorderNote = note;
		if (note) liveMsg = note;
		/*
		 * Focus goes back to the control the guest was working from, after `tick()` and by ATTRIBUTE rather than by
		 * the element reference: the row's DOM is recreated at its new position, so the pressed grip is a detached
		 * node and focusing the captured reference put focus nowhere. `openerEl` is the fallback for when the row
		 * itself has gone.
		 */
		void tick().then(() => {
			const sel = id ? `[data-grip="${CSS.escape(id)}"]` : '';
			const el = sel ? (document.querySelector(sel) as HTMLElement | null) : null;
			(el ?? openerEl)?.focus?.();
			openerEl = null;
		});
	}

	/**
	 * The pointer drag. The idiom: publish the offset as a CSS custom property and let a transform do the moving,
	 * so no position is interpolated in JS. There is no hit-testing — the target is arithmetic, not a search for a
	 * drawn slot under the finger.
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
		 * TWO READS, BOTH AT PRESS TIME AND BOTH ONCE. Nothing is measured again for the life of the gesture — that
		 * was the recorded hazard (rows change height mid-drag: a byline gains an `away` badge, another guest queues
		 * a card).
		 *
		 *   `rowH`       the DRAGGED row's own height — how far its neighbours must slide to open a gap the right
		 *                size for it. `closest`, not an index, because the gap belongs to the row being carried.
		 *   `rowBounds`  every row's box, which is what `liveSortTarget` compares the dragged row's leading edge
		 *                against. A single height cannot answer that in a list of mixed heights — see its note.
		 *
		 * `.qrow` matches BOTH row kinds and the query returns them in DOM order, which is the queued order.
		 */
		rowH = grip.closest('.qrow')?.getBoundingClientRect().height ?? 0;
		rowBounds = [...document.querySelectorAll('.qrow')].map((el) => {
			const b = el.getBoundingClientRect();
			return { top: b.top, height: b.height };
		});
		const startY = e.clientY;
		/*
		 * THE LISTENERS GO ON `window`, not on the grip and not behind `setPointerCapture`. The row's DOM is
		 * recreated as the list reorders under the finger, so the pressed grip becomes a DETACHED node: listeners
		 * bound to it deliver nothing, the drag produces no `pointermove` and the release never arrives. Only a
		 * driven pointer could show it.
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
	 * The queue moving underneath a drag in flight is NORMAL and deliberately gets no handling: the live sort is
	 * relative to where the dragged row IS, so another guest's add simply moves the held row along with the list.
	 * What DOES invalidate the gesture is the dragged song leaving, starting to play, or the queue falling below
	 * two — then it ends itself, says why, and returns focus.
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

	/*
	 * HOW LONG UNTIL MY TURN, ON MY OWN ROW. `MyPositionCard` used to say "1st · You're up next. · Roughly 3
	 * minutes." above a row already reading "1 · You · up next" — the ordinal twice, the claim twice, and one
	 * piece of information of its own. The wait moved onto the row it was describing.
	 *
	 * The honest-degradation rule lives in one place (`waitShort`, sharing its arithmetic with the sentence form):
	 * one entry ahead with no resolvable length makes the whole estimate unknown, and an unknown estimate is
	 * OMITTED rather than zeroed. `Media.durationSec` is required, so ABSENCE from the catalog is the reachable
	 * unknown.
	 */
	/** My soonest queued pick: the row the wait is about. */
	const myNextEntry = $derived(
		entries
			.filter((e) => e.singerId === me?.id && e.status === 'queued')
			.sort((a, b) => a.rotationSeq - b.rotationSeq)[0]
	);
	/**
	 * Seconds still to run on the song playing now: 0 when nothing is playing, and NULL when something
	 * is playing whose length is unknown — which makes the whole wait unknown rather than short. The
	 * formatter decides what to do with that; this only reports what is true.
	 */
	const nowRemainingSec = $derived.by(() => {
		if (!nowEntry) return 0;
		if (nowDurationSec <= 0) return null;
		return Math.max(0, nowDurationSec - displayPos);
	});
	/**
	 * The byline clause after the singer's name: "up next", "~3 min", both, or nothing. Built by joining the parts
	 * that are TRUE rather than branching, so a row can never render a stray separator.
	 */
	function queueSubtitle(e: QueueEntry): string {
		return [e.id === nextPlayableId ? 'up next' : '', e.id === myNextEntry?.id ? myWait : null]
			.filter(Boolean)
			.join(' · ');
	}

	/** "~3 min" for MY next row, or null when any length ahead is unknown (and then no clause renders). */
	const myWait = $derived.by(() => {
		if (!myNextEntry) return null;
		const idx = queued.findIndex((e) => e.id === myNextEntry.id);
		if (idx < 0) return null;
		return waitShort(
			nowRemainingSec,
			queued.slice(0, idx).map((e) => mediaCatalog.get(e.mediaId)?.durationSec ?? null)
		);
	});
</script>

<!-- THE TOPBAR IS FOR A JOINED SINGER ONLY: unjoined, `/` IS the join screen, and JoinLanding paints its own
	brand as that screen's heading — rendering this one too put "Encore" on screen twice. -->
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
				<!-- A LINK to /settings?tab=you, not a button opening a sheet: identity was editable in two places, which
				  is two save paths that can disagree about your name. The name and dot were inert text, and they are the
				  one place a guest looks to check who the room thinks they are — so they are a 44px target too. -->
				<!-- `.me-slot` / `.gear-slot` are page-rendered wrappers, and that is forced: Tailwind scans only the
				  `components/ui` directory so a utility written here is emitted nowhere, and a class handed to a component
				  is scoped to THIS file where Svelte strips it as unused. Layout and inherited ink stay on the wrapper. -->
				<div class="me-slot">
					<Button variant="identity" href="/settings?tab=you" aria-label="Your profile">
						<span class="me-name">{me.displayName}</span>
						<span class="me-dot" style="--singer:{me.color};"></span>
					</Button>
				</div>
				<!-- `size="icon"` IS the 44px target (`size-tap grid place-items-center`). This was a bare ⚙️ at 1.05rem
				  in ~18px of padding: a forced-colour-emoji glyph in a target under even the 24px WCAG 2.5.8 floor. -->
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
	`--row-shift` COUNT each is given. It is 0 except during a drag, which is also when it is measured, so no row
	can be displaced while nothing is being dragged whatever a stale shift count said.
-->
<main style="--row-h:{rowH}px">
	{#if me}
		<!-- THE FIELD IS THE FIRST THING ON THE SCREEN, and a field rather than a link because search is no longer a
			place you go. Not sticky — see the `.findbox` rule for why. -->
		<div class="findbox">
			<span class="find-mark"><Icon name="search" /></span>
			<input
				bind:this={queryEl}
				bind:value={query}
				oninput={onQueryInput}
				aria-label="Search a song or artist"
				placeholder="Search a song or artist…"
			/>
			{#if searching}<Spinner aria-label="Searching" />{/if}
			{#if searchActive}
				<Button variant="ghost" size="icon" aria-label="Clear the search" onclick={clearSearch}>
					<Icon name="close" />
				</Button>
			{/if}
		</div>

		{#if searching && rawResults.length === 0 && readyResults.length === 0}
			<div aria-busy="true" aria-label="Searching…">
				{#each [0, 1, 2] as i (i)}
					<div class="skel-row">
						<Skeleton variant="thumb" />
						<div class="skel-text">
							<Skeleton />
							<Skeleton variant="line-short" />
						</div>
					</div>
				{/each}
			</div>
		{/if}

		<!--
			ONE SCROLL, TWO VIEWS. Everything from here to the library is gated on `searchActive`: no query and the page
			is the room (what is queued, what is being made, what is ready), a query and it is the search.
		-->
		{#if !searchActive}
			<h2 class="grouphead">Queued</h2>
			<!--
				NO MODE CHROME. A `.reorder-bar` with a hint and Done/Cancel used to appear here, because the mode it
				belonged to had to be committed or abandoned. A live sort begins on a press, is visible the whole way and
				commits on release, so there is nothing to confirm.

				The NOTE stays, and it is not mode chrome: a drag can still be invalidated mid-flight by the queue moving
				under it, and a gesture that dissolves under a finger has to say why — visibly as well as announced.
			-->
			{#if reorderNote}
				<p class="reorder-note">{reorderNote}</p>
			{/if}
			{#if queued.length === 0}
				<!--
				THE STATE, LARGE AND CENTRED, AND NOTHING ELSE. It carried a second line telling a guest where songs
				come from; the STATE is promoted instead, and at display scale in an empty column it is the only thing
				on screen.

				`Empty.Root` stays for a reason: the inventory detector recognises a designed empty state by that
				primitive (`phone-inventory.test.ts`), so a bare `<p>` would report this route as having none. It is
				sized from a page-owned wrapper because `Empty.Title` carries Tailwind's `text-lg`, which an inherited
				font-size cannot beat, and a utility written in this file is emitted nowhere.
			-->
				<!-- `tight` DROPS THE 40vh, and only when something follows. "Large and centred, the only thing on the
				screen" was right when the queue WAS the whole page; the library renders below it now, so that 40vh is dead
				space between the two things a guest came for. The state stays large. -->
				<Empty.Root>
					<div class="queue-empty" class:tight={libraryRows.length > 0 || processingGroup.length > 0}>
						<Empty.Header>
							<Empty.Title>Nothing Queued</Empty.Title>
						</Empty.Header>
					</div>
				</Empty.Root>
			{:else}
				{#each queued as e, i (e.id)}
					{@const s = singerOf(e.singerId)}
					{@const card = queueCardKind(mediaCatalog.get(e.mediaId), mediaStatus.get(e.mediaId))}
					<!-- NO DROP TARGETS. A labelled `.dropslot` used to render above every queued row and the drag hit-tested
					for the one under the finger. Under `move-to-index` every position is legal, so one target per row is
					what the list already shows — and a release commits `dragTo`, the expression that places the rows. -->
					{#if card === 'processing' || card === 'failed'}
						{@const proc = mediaStatus.get(e.mediaId) ?? { status: 'failed' as MediaStatus, pct: 0 }}
						<ProcessingCard
							seq={liveSeq(i, dragFrom, dragTo)}
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
						<!--
						`seq` IS THE LIVE POSITION, not the source index. `liveSeq` reads the same shift arithmetic
						that places the row, so the number a row shows is the number it is sitting on THROUGHOUT the
						drag — dragging 2 above 1 relabels both as it happens. It used to be `i + 1`, the last order
						the server sent, so every number in the list corrected itself in one jump when the patch
						landed (the "flash" that was reported).
					-->
						<QueueRow
							seq={liveSeq(i, dragFrom, dragTo)}
							title={mediaTitle(e.mediaId)}
							singerName={e.singerId === me?.id ? 'You' : (s?.displayName ?? 'Guest')}
							singerColor={s?.color ?? SINGER_COLORS[0]}
							mine={e.singerId === me?.id}
							singerAway={awaySingers.has(e.singerId)}
							up={e.id === nextPlayableId}
							pending={pendingKind.get(e.id) ?? null}
							subtitle={queueSubtitle(e)}
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
		{/if}

		<!--
			WHATEVER IS BEING MADE RIGHT NOW, in BOTH views: it is the thing most likely to be asked about, and
			it is the one group that answers the same question whether or not a query is up. `processingGroup`
			drops anything the queue above is already drawing a bar for — see its derivation.
		-->
		{#if processingGroup.length}
			<h2 class="grouphead">Making karaoke…</h2>
			{#each processingGroup as c (c.id)}
				{@const r = displayReadiness(c.media, liveOf(c.id))}
				<SongRow
					{...rowMeta(c.media)}
					readiness={r}
					pct={c.pct}
					status={c.status}
					inQueue={inMyQueue(c.id)}
					processable={isProcessableSource(c.media.source)}
					onadd={() => addSong(c.id)}
					onmake={canProcess(c.media, r) ? () => singThis(c.id) : undefined}
				/>
			{/each}
		{/if}

		{#if !searchActive}
			<!--
				ZERO QUERY = THE LIBRARY, under the queue: the songs that can be sung right now as default content, so the
				catalog we persist is visible from the screen a guest sits on. Typing FILTERS this world.

				THE HEADING IS GATED ON HAVING ROWS — a group heading is a claim about what follows it, so it must not
				outlive its rows.
			-->
			{#if libraryRows.length}
				<h2 class="grouphead">Your library</h2>
				{#each libraryRows as m (m.id)}
					<SongRow {...rowMeta(m)} readiness="ready" inQueue={inMyQueue(m.id)} onadd={() => addSong(m.id)} />
				{/each}
			{:else if processingGroup.length === 0}
				<!-- Nothing ready AND nothing on the way: the only state where the library is genuinely empty.
				     The state, then the next step — and the field above is what the description names, because
				     it is now on this screen rather than one navigation away. -->
				<Empty.Root>
					<Empty.Header>
						<Empty.Title>No karaoke tracks yet.</Empty.Title>
						<Empty.Description>Search above for a song and we'll make one.</Empty.Description>
					</Empty.Header>
				</Empty.Root>
			{/if}
		{/if}

		{#if searchActive}
			{@const readyStack = readyResults}
			{#if readyStack.length}
				<h2 class="grouphead">Ready to sing</h2>
				{#each readyStack as m (m.id)}
					<SongRow {...rowMeta(m)} readiness="ready" inQueue={inMyQueue(m.id)} onadd={() => addSong(m.id)} />
				{/each}
			{/if}

			{@const rawRows = unaccounted(rawResults)}
			{#if rawRows.length}
				<h2 class="grouphead">Needs karaoke</h2>
				{#each rawRows as m (m.id)}
					{@const r = readinessFor(m)}
					<SongRow
						{...rowMeta(m)}
						readiness={r}
						pct={liveOf(m.id)?.pct ?? 0}
						status={liveOf(m.id)?.status}
						inQueue={inMyQueue(m.id)}
						processable={isProcessableSource(m.source)}
						onadd={() => addSong(m.id)}
						onmake={canProcess(m, r) ? () => singThis(m.id) : undefined}
					/>
				{/each}
			{/if}

			{#if !searching && rawResults.length === 0 && readyResults.length === 0}
				<Empty.Root>
					<Empty.Header>
						<Empty.Description>No results. YouTube search needs yt-dlp on the server.</Empty.Description>
					</Empty.Header>
				</Empty.Root>
			{/if}

			<!-- Nothing SINGABLE matched, but the library has songs — offer the way back to all of them, which
			     is also the way back to the queue: clearing the box restores both. -->
			{#if !readyStack.length && library.length}
				{@const empty = readyEmptyState({ searchActive, libraryCount: library.length, query })}
				<Empty.Root>
					<Empty.Header>
						<Empty.Description>{empty.message}</Empty.Description>
					</Empty.Header>
				</Empty.Root>
				{#if empty.showAllCount !== null}
					<div class="showall-row">
						<Button variant="secondary" size="tap" onclick={clearSearch}>
							<Icon name="mic" /> Show all {empty.showAllCount}
						</Button>
					</div>
				{/if}
			{/if}
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

<!-- Polite live region for ambient queue activity a screen reader would otherwise miss (another guest's add, a
	rotation reorder). Visually hidden, but present from first render so assistive tech is already observing it
	when the first announcement lands. -->
<!-- ESCAPE CANCELS A DRAG IN FLIGHT and commits nothing. On the window rather than a row because mid-gesture the
	pointer is captured and focus sits on the grip, while a keyboard cancel has to work wherever focus is. Guarded
	on `dragging` so it never swallows an Escape the rest of the page wants. -->
<svelte:window onkeydown={(e) => dragging && e.key === 'Escape' && endDrag(false)} />

<div class="sr-live" role="status" aria-live="polite" aria-atomic="true">{liveMsg}</div>

<style>
	/*
	 * The band is docked at the bottom, so this column must scroll clear of it: the padding reserves the band's
	 * MEASURED height (--dock-h), which keeps the last row reachable at every scroll position instead of parked
	 * under the band. The fallback covers the first frame before the measurement lands.
	 */
	main {
		flex: 1;
		padding: var(--space-xs) var(--space-3xl) calc(var(--dock-h, 0px) + 28px);
	}
	/*
	 * WRAPPERS FOR THE MIGRATED CONTROLS, each holding only what a component must not: layout that belongs to a
	 * flex ITEM, and ink the control inherits. Neither can be a class passed to <Button> — Tailwind scans only
	 * `components/ui/**`, and a class handed to a component is scoped to this file where Svelte strips it.
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
	 * `.reorder-bar`, `.reorder-hint`, `.reorder-acts`, `.dropslot` and `.dropslot.hot` WERE DELETED HERE with the
	 * mode they dressed. What those rules had learned, so it is not re-learned: a drop target drawn only in colour
	 * is invisible to the guest who needs it most, and a mode bar must sit above the list rather than docked, or
	 * it covers the rows the guest is aiming at.
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
	 * The singer's own identity dot. The colour arrives as a `--singer` custom property rather than interpolated
	 * into `background:`, which is what lets the halo be derived with color-mix. The previous form concatenated
	 * hex alpha digits onto the value and only worked because every preset was 6-digit hex; a 3-digit hex, an
	 * rgb() or an oklch() produced invalid CSS and the halo silently vanished.
	 */
	.me-dot {
		width: 22px;
		height: 22px;
		border-radius: 50%;
		flex: 0 0 auto;
		background: var(--singer);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--singer) 19%, transparent);
	}
	/* The one child of the header whose width is user-supplied. A single unbroken token's min-content width is its
	   full rendered width, so flex-shrink cannot take it below that and the row grows the document — carrying the
	   gear off the viewport. Truncate instead: text-overflow needs a block box, and min-width:0 must exist up the
	   whole chain for it to shrink. The dot and the gear stay unshrinkable so the 44px target survives. */
	.me-name {
		display: block;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	/* var(--tap), matching every other control in the app. The emoji gear this replaced was ~18px. */

	/*
	 * Wide viewports spend the extra room on MORE SONGS, not longer rows. Only song rows flow into columns: a
	 * heading or an empty state labels everything below it, so confining one to a column would read as applying
	 * to half the list. Inverted deliberately — everything spans by default and rows opt in, so a new block added
	 * here spans (always safe) rather than silently landing beside a song.
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
	 * ── THE SEARCH FIELD ──────────────────────────────────────────────────────
	 *
	 * NOT STICKY. This page's `.topbar` is already sticky, so a second sticky element would need that header's
	 * RENDERED height as its offset — not a token. Inventing a spacing step past `--space-4xl` puts an undefined
	 * custom property inside a calc(), which invalidates the whole declaration silently, and measuring the header
	 * to publish a second property is a band contract's worth of machinery for a search box.
	 *
	 * THE FOCUS RING BELONGS TO THE WHOLE FIELD, not the bare input: `.findbox` is a bordered, filled box holding
	 * a magnifier, an input, a spinner and a clear control, so it IS the field to anyone looking at it. app.css's
	 * global `input:focus-visible` drew a violet rect nested inside a grey one with the magnifier stranded
	 * outside it. `:focus-within` on the wrapper (a wrapper is never itself focused) and the inner rule
	 * suppresses the global, so only one ring is drawn — same token, same width, so the measured ≥2px floor holds.
	 */
	.findbox {
		background: var(--card);
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		display: flex;
		align-items: center;
		gap: var(--space-md);
		padding: var(--space-lg) var(--space-xl);
		min-height: 52px;
		width: 100%;
		margin-bottom: var(--space-lg);
	}
	.findbox input {
		border: 0;
		background: transparent;
		color: var(--ink);
		font-size: var(--ph-text-base);
		/* flex + min-width:0, never width:100% — the box must be able to shrink under SC 1.4.10 reflow. */
		flex: 1;
		min-width: 0;
		/* The input, not the wrapper, is the tap target. */
		min-height: var(--tap);
	}
	.findbox:has(input:focus-visible) {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.findbox input:focus-visible {
		outline: none;
	}
	.find-mark {
		display: grid;
		place-items: center;
		color: var(--ink-dim);
	}

	.skel-row {
		display: flex;
		align-items: center;
		gap: var(--space-lg);
		padding: var(--space-lg) var(--space-xl);
		margin-bottom: var(--space-sm);
		border-radius: var(--radius-sm);
		background: var(--card);
		border: 1px solid var(--line);
	}
	.skel-text {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
	}

	.showall-row {
		display: flex;
		justify-content: center;
		padding: 0 0 var(--space-sm);
	}

	@media (max-height: 480px) {
		.findbox {
			min-height: var(--tap);
			padding: var(--space-sm) var(--space-xl);
		}
	}
	/*
	 * THE EMPTY QUEUE — the state at display scale, centred in the space it leaves.
	 *
	 * `min-height` rather than a full-height centring trick: this is a block in a scrolling column that also
	 * carries the heading and the band's reservation, so anything absolute would re-derive a height three other
	 * rules own. It costs nothing when the queue is non-empty, because the whole block is gone.
	 *
	 * `overflow-wrap: anywhere` is the 320px clause, not tidiness: at `--ph-text-3xl` and 200% text a single
	 * unbreakable word is wider than a 320px viewport, which is the reflow failure. The word breaks instead of
	 * the layout. The font-size reaches a vendored slot through one `:global()` at a `data-slot`, because
	 * `Empty.Title` carries `text-lg` on its own element and an inherited size cannot win.
	 */
	.queue-empty {
		display: grid;
		place-items: center;
		min-height: 40vh;
		padding: var(--space-2xl) var(--space-md);
		text-align: center;
	}
	/* See the markup note: the void is only right when nothing follows the state. */
	.queue-empty.tight {
		min-height: 0;
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
	 * Docked-toast stacking, measured UP from the band. --dock-h is bound to the band's clientHeight and the band's
	 * own padding already includes env(safe-area-inset-bottom), so the inset arrives THROUGH --dock-h — do NOT add
	 * another env() term here or the gap doubles.
	 *
	 * BOTH TOKENS ARE DECLARED-BUT-UNREAD, deliberately: the toasts moved onto Sonner, which stacks its own
	 * surfaces, so there is no second independently-positioned toast to offset and nothing writes --undo-h. They
	 * are retained because two guards resolve against this text — one asserts the --undo-dock declaration and uses
	 * the literal `--error-dock:` as a slice boundary — so retiring them is a test-owning change, not a CSS one.
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

	/* No reduce arm in this file: the two animations it covered left with their elements (the spinner and the
	   skeleton shimmer), and both are now declared inside a `prefers-reduced-motion: no-preference` block in those
	   components — motion OPT-IN rather than declared-then-reset. Nothing here animates. */

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
