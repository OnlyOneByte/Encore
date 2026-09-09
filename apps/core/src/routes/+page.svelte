<script lang="ts">
	import {
		SINGER_COLORS,
		DEFAULT_EFFECTIVE_SETTINGS,
		queueOrderLabel,
		reorderIsMeaningful,
		singHistoryFrom,
		originalKeyLabel,
		soundingKeyLabel,
		rangeLabel,
		rangeOctaves,
		voiceBandSentence,
		songDisplay
	} from '@encore/shared';
	import { onMount, tick } from 'svelte';
	import { goto } from '$app/navigation';
	// The browse push is a real navigation (`?browse=1`), so the phone's own Back gesture dismisses it.
	import { page } from '$app/state';
	import type {
		ServerEvent,
		QueueEntry,
		Media,
		PublicSinger,
		PlaybackState,
		PlayerCommand,
		EffectiveSettings
	} from '@encore/shared';
	import { QueueStore } from '$lib/stores/queue';
	import { WsClient } from '$lib/ws/client';
	import QueueRow from '$lib/components/QueueRow.svelte';
	import SongRow from '$lib/components/SongRow.svelte';
	import NowPlayingHero from '$lib/components/NowPlayingHero.svelte';
	import MyPositionCard from '$lib/components/MyPositionCard.svelte';
	import ProcessingCard from '$lib/components/ProcessingCard.svelte';
	import GuidingTrack from '$lib/components/GuidingTrack.svelte';
	import RangeBar from '$lib/components/RangeBar.svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import { cookAndQueue } from '$lib/cook-and-queue';
	import { gripVisible, ownPicksPinned, ownSlots, dropTarget, modeInvalidation } from '$lib/reorder-mode';
	import {
		displayReadiness,
		canCook,
		readyEmptyState,
		nextPlayableEntryId,
		entryPlayable,
		cookingGroupIds,
		queueCardKind,
		type Readiness
	} from '$lib/readiness';
	import { activeScars, recordScar, clearScar } from '$lib/stores/cook-scars';
	import { positionWords } from '$lib/position-sentence';
	import type { MediaStatus } from '@encore/shared';
	import { isPlayable, hasGuidingTrack, effectiveGuideLevel, isCookableSource } from '@encore/shared';

	let me = $state<PublicSinger | null>(null);
	let entries = $state<QueueEntry[]>([]);
	// What each row is still waiting on ('add' | 'move'), republished on every store emit so the
	// QueueRow/ProcessingCard `pending` affordance reflects the real pending map instead of the
	// placeholder rotationSeq that applyAndReseq overwrites in the same frame (issue #304). A KIND
	// rather than a set of ids since #832: a pending REORDER is marked too (XR-PH-10), and it must not
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
	// live make-karaoke progress per mediaId — driven by media:status broadcasts AND seeded
	// from /api/library on load, so a reload mid-cook doesn't lose the progress bar.
	let mediaStatus = $state<Map<string, { status: MediaStatus; pct: number; etaSec?: number }>>(new Map());
	// Failed-cook scars (#68) captured once on mount from localStorage. Held so they can be re-merged
	// into the catalog after a queue:sync REPLACES it — otherwise the room's first sync wipes the
	// scarred (failed, so server-unknown) media and its row vanishes again on the very reload the
	// scar exists to survive.
	let scarredMedia: Media[] = [];
	/*
	 * DIRECTION A (docs/DECISIONS.md, issue #832): the room's queue IS the home screen, and browsing is
	 * a deliberate push behind one primary button — the inverse of the browse-first screen that kept the
	 * queue in a pull-up sheet. The push is a real navigation rather than a local boolean so the phone's
	 * own Back gesture dismisses it; it is the SAME route, so the search query and the library both
	 * survive the trip in both directions.
	 */
	const browsing = $derived(page.url.searchParams.get('browse') === '1');
	function openBrowse() {
		void goto('/?browse=1', { keepFocus: true, noScroll: false });
	}
	function closeBrowse() {
		void goto('/', { keepFocus: true, noScroll: false });
	}
	/**
	 * The docked primary button's REAL rendered height, published so the scrolling column can reserve
	 * its band in normal flow (XR-PH-12) instead of having the button float over the last queue row.
	 * Measured, not a constant, for the reason --peek-h was: a guessed value leaves the last row
	 * bleeding under the band the moment the copy or the safe-area inset changes.
	 */
	let dockH = $state(0);
	$effect(() => {
		document.documentElement.style.setProperty('--dock-h', `${dockH}px`);
		// Tear the inline property down on unmount, or it OUTLIVES the route on documentElement and a
		// stale --dock-h keeps padding every later page — the leak class #598 §14 fixed for --peek-h.
		return () => {
			document.documentElement.style.removeProperty('--dock-h');
		};
	});

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
	// Reordering your own picks is meaningless under `shuffle` (rank comes from the entry id), so the
	// arrows are hidden rather than offered as a control that silently does nothing.
	const canReorder = $derived(reorderIsMeaningful(settings.room.queueOrder));
	// HOST reorder (issue #638): a host can drag ANY song to any global slot, not just reorder their
	// own picks. Every joined singer is a host today (mirrors player:control — see capabilities.ts),
	// so this is "am I in the room"; narrowing to a real host role is one edit here + in capabilities.
	// Still gated on the policy respecting order, since a pin under shuffle would fight the hash rank.
	const canHostReorder = $derived(canReorder && !!me?.id);
	// The list heading named the order "rotation" unconditionally, which stops being true the moment
	// the room picks anything else. Eyes-on: it still said ROTATION with the room on first-come-first-served.
	const orderLabel = $derived(queueOrderLabel(settings.room.queueOrder));

	let store: QueueStore;
	let ws: WsClient;

	function mediaTitle(id: string): string {
		const m = mediaCatalog.get(id);
		return m ? `${m.title}${m.artist ? ' — ' + m.artist : ''}` : id;
	}
	function singerOf(id: string): PublicSinger | undefined {
		return singers.get(id);
	}
	/** Merge media into the client catalog. The catalog is otherwise fed ONLY by queue:sync/patch, so
	 *  a song that came from search or the library — and is not (yet) in anyone's queue — has no
	 *  resolvable title: a cooking card would render a raw ULID. */
	function mergeMedia(list: Media[]) {
		if (!list.length) return;
		const next = new Map(mediaCatalog);
		for (const m of list) next.set(m.id, m);
		mediaCatalog = next;
	}
	/** Merge media but only for ids the catalog does NOT already hold — used to re-apply failed-cook
	 *  scars after a queue:sync without clobbering a fresher server copy of the same song. */
	function mergeMissingMedia(list: Media[]) {
		if (!list.length) return;
		const next = new Map(mediaCatalog);
		let changed = false;
		for (const m of list)
			if (!next.has(m.id)) {
				next.set(m.id, m);
				changed = true;
			}
		if (changed) mediaCatalog = next;
	}

	onMount(() => {
		let disposed = false;
		(async () => {
			const res = await fetch('/api/me');
			if (!res.ok) {
				await goto('/join');
				return;
			}
			me = (await res.json()).singer;
			if (disposed || !me) return;

			store = new QueueStore({
				singerId: me.id,
				sendCommand: (cmd) => ws.send({ type: 'queue:command', command: cmd }),
				onReject: (reason) => showError(`Couldn't do that: ${reason}`),
				// Read at apply time, not captured: both the algorithm and the sing history change while
				// the party runs, and predicting with a stale ordering is what makes a row jump.
				ordering: () => ({ order: settings.room.queueOrder, lastSungAt: singHistoryFrom(singers.values()) })
			});
			store.subscribe((e) => {
				entries = e;
				pendingKind = store.pendingKindById;
			});

			ws = new WsClient({
				url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?role=phone`,
				getLastRev: () => store.rev,
				onConnectionChange: (c) => (connected = c),
				onEvent: (e: ServerEvent) => {
					if (e.type === 'queue:sync') {
						if (e.settings) settings = e.settings;
						if (e.singers) singers = new Map(e.singers.map((s) => [s.id, s]));
						if (e.media) mediaCatalog = new Map(e.media.map((m) => [m.id, m]));
						// Re-apply failed-cook scars: a queue:sync REPLACES the catalog, and a failed song is
						// not in the room's media (it settled to un-cooked server-side), so without this the
						// scarred row is wiped by the very first sync. A real entry for the id (already added
						// above) wins; this only fills a gap. (#68)
						if (scarredMedia.length) mergeMissingMedia(scarredMedia);
						// The room's guiding-track default — needed to LABEL the control, since a null
						// per-song override means "inherit" and the phone would otherwise show 0%.
						if (e.settings) roomGuideDefault = e.settings.room.guideLevelDefault;
						// An omitted list means "no info", not "nobody is away" — do not blank what we have.
						if (e.away) awaySingers = new Set(e.away);
						queueMicrotask(() => store.resendPending());
					}
					if (e.type === 'singer:presence') awaySingers = new Set(e.away);
					if (e.type === 'queue:patch' && e.patch.media) mergeMedia(e.patch.media);
					if (e.type === 'settings:changed') settings = e.settings;
					if (e.type === 'singer:joined') singers = new Map(singers).set(e.singer.id, e.singer);
					// A rename must land on every OTHER phone too, or their queue rows keep naming someone
					// who no longer goes by that.
					if (e.type === 'singer:updated') singers = new Map(singers).set(e.singer.id, e.singer);
					// Someone left on purpose. Their entries arrive as ordinary remove patches; this is what
					// takes them out of the away set, which no patch would have implied.
					if (e.type === 'singer:left') {
						const next = new Set(awaySingers);
						next.delete(e.singerId);
						awaySingers = next;
						// Also drop them from the singers map. A singer who leaves with no queued songs
						// produces no queue:patch, so without this their name keeps rendering on every other
						// phone until the next full sync. joined/updated rebuild this map; left must too.
						const nextSingers = new Map(singers);
						nextSingers.delete(e.singerId);
						singers = nextSingers;
					}
					if (e.type === 'playback:state') playback = e.state;
					// A room default changed mid-party: adopt it so the guiding-track control keeps
					// reporting the level the TV is actually mixing at.
					if (e.type === 'settings:changed') roomGuideDefault = e.settings.room.guideLevelDefault;
					if (e.type === 'media:status') {
						const next = new Map(mediaStatus);
						next.set(e.mediaId, { status: e.status, pct: e.pct, etaSec: e.etaSec });
						mediaStatus = next;
						// reflect the flip on the catalog copy so readiness agrees without a full sync.
						// A `failed` cook must NOT be written back as 'queued' — that pins the row in the
						// Cooking group at 0% forever with no failure signal (the singer never learns the
						// cook died). Preserve the existing stemStatus on failure, matching the TV route.
						const m = mediaCatalog.get(e.mediaId);
						if (m) {
							const nm = new Map(mediaCatalog);
							nm.set(e.mediaId, {
								...m,
								stemStatus:
									// A failed OR canceled cook settles back to un-cooked server-side (settleStemsGate),
									// so the optimistic copy follows it. This used to preserve the mid-flight status,
									// which is what kept the row reading as cooking after the job had already died.
									e.status === 'ready' ? 'ready' : e.status === 'failed' || e.status === 'canceled' ? 'none' : 'queued'
							});
							mediaCatalog = nm;
						}
						// a song that just finished cooking belongs in the saved library now, and a successful
						// re-cook clears any failed-cook scar so the row never lingers as failed while it is ready.
						if (e.status === 'ready') {
							clearScar(e.mediaId);
							loadLibrary();
						}
						// Surface a died cook to the singer instead of leaving the row silently stuck, and
						// persist a per-device scar so the failure survives a reload (the live map does not).
						if (e.status === 'failed') {
							const failedMedia = mediaCatalog.get(e.mediaId);
							if (failedMedia) recordScar(failedMedia);
							showError(`Couldn't make karaoke for “${mediaTitle(e.mediaId)}” — try again.`);
						}
					}
					store.onServerEvent(e);
				}
			});
			// Re-surface failed cooks that a reload would otherwise have erased: the live `mediaStatus`
			// map is in-memory only, so a persisted scar (Encore #68) is seeded back as a synthetic
			// `failed` live status. This flows through liveOf -> displayReadiness -> cookingRows to the
			// same red-chip + Sing row a live failure renders, with no extra UI. A fresher live broadcast
			// always wins (checked below), and any scar cleared by a later `ready` is already gone.
			scarredMedia = activeScars();
			if (scarredMedia.length) {
				// GET /api/library returns only ready + cooking media, so a failed song is not in the
				// catalog — merge the scar's snapshot in so its row can render, then mark it failed. The
				// captured list is re-applied on every queue:sync (which replaces the catalog), so the
				// row survives the room's first sync.
				mergeMissingMedia(scarredMedia);
				const withScars = new Map(mediaStatus);
				for (const m of scarredMedia) if (!withScars.has(m.id)) withScars.set(m.id, { status: 'failed', pct: 0 });
				mediaStatus = withScars;
			}
			ws.open();
			loadShortcuts();
			loadLibrary();
		})();
		return () => {
			disposed = true;
			ws?.close();
		};
	});

	function addSong(mediaId: string) {
		store?.addSong(mediaId);
		if (navigator.vibrate) navigator.vibrate(8);
		setTimeout(loadShortcuts, 300); // refresh popular/recent after the add lands
	}

	/**
	 * "✨ Sing" — the raw row's ONE action: take the turn, then start the cook.
	 *
	 * Order is load-bearing, not stylistic: the core derives the cook's job priority from the rotation
	 * position of the turns pointing at that media, so cooking first files the job at
	 * NO_QUEUE_PRIORITY — behind the lyrics backfill — while a singer stands there waiting. See
	 * $lib/cook-and-queue.ts for the full reasoning and its test.
	 *
	 * `hasQueuedTurn` is the RETRY case (#741) and it is not an optimisation: a dead cook keeps
	 * offering Sing (the group header literally says "tap Sing to try again"), so without it the second
	 * tap booked the singer a second turn of the same song and the room played it twice in a row. The
	 * cook step still runs — the retry must stay reachable, per readiness.ts's `canCook('failed')`.
	 */
	function singThis(mediaId: string) {
		cookAndQueue({
			queue: () => addSong(mediaId),
			cook: () => void makeKaraoke(mediaId),
			hasQueuedTurn: inMyQueue(mediaId)
		});
	}

	/** Request stem-separation ("make karaoke") — flips the song to a cooking file server-side; the
	 *  live media:status broadcasts then drive the row's progress bar. */
	async function makeKaraoke(mediaId: string) {
		if (navigator.vibrate) navigator.vibrate(12);
		// optimistic: the row reads as cooking immediately, before the request lands
		mediaStatus = new Map(mediaStatus).set(mediaId, { status: 'queued', pct: 0 });
		try {
			const res = await fetch('/api/make-karaoke', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ mediaId })
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				mediaStatus = new Map([...mediaStatus].filter(([id]) => id !== mediaId));
				showError(body.error ?? 'Could not start make-karaoke');
				return;
			}
			// the stems were already on disk (cooked on an earlier night) — nothing to wait for
			if (body.alreadyReady) loadLibrary();
		} catch {
			mediaStatus = new Map([...mediaStatus].filter(([id]) => id !== mediaId));
			showError('Could not start make-karaoke — check your connection');
		}
	}

	// ── readiness ────────────────────────────────────────────────────────────
	// One axis, three states: ready (stems on disk, sing now), cooking (stems in flight, still
	// queueable because rotation holds its slot), raw (plays with the original vocals).
	//
	// It is no longer a FILTER. Direction B (issue #833) deleted the four concurrent ways to narrow
	// one list — the three readiness chips, the artist rail, the genre rail, and the group headings
	// that re-announced this axis in prose — leaving typing in the docked search box as the only one.
	// So there is no `filter` state and no `showReady`/`showCooking`/`showRaw` gate: every group
	// renders, every time, and the reader narrows the list by saying what they want.

	function liveOf(id: string) {
		return mediaStatus.get(id);
	}
	function readinessFor(m: Media): Readiness {
		return displayReadiness(m, liveOf(m.id));
	}
	/**
	 * Everything a SongRow displays about a song, in ONE place.
	 *
	 * Spread rather than written out at each call site because there are five of them (ready, cooking,
	 * raw, popular, recently-queued) and they had already drifted: the ready group read
	 * `artistCanonical ?? artist` while the other four read the raw `artist`, so one song showed a
	 * different name depending on which group it happened to be in. Both canonical fields are passed
	 * through and SongRow decides how to combine them, so that judgement lives in one component instead
	 * of being re-made at five tag sites.
	 */
	const rowMeta = (m: Media) => ({
		title: m.title,
		artist: m.artist,
		artistCanonical: m.artistCanonical,
		thumbnail: m.thumbnail,
		durationSec: m.durationSec,
		viewCount: m.viewCount,
		// The original detected key, spelled and confidence-gated by the shared helper (null below the
		// floor). Added to the FIXED rowMeta shape so it reaches every SongRow call site — SongRow itself
		// only paints the chip on a ready row, so a null here (raw/cooking song, or no key) is harmless.
		keyName: originalKeyLabel(m.songProfile) ?? undefined,
		// The song's descriptive tags, threaded through the ONE shared row shape so every call site
		// gets them; SongRow paints them on a READY row only, so a raw/cooking row's undefined is
		// harmless. Reads the map by id — a song with no tags is simply absent from it.
		tags: libraryTags[m.id]
	});
	/** Is this song already in MY part of the rotation? Turns ＋ Turn into a ✓ Queued confirmation. */
	function inMyQueue(mediaId: string): boolean {
		return queued.some((e) => e.mediaId === mediaId && e.singerId === me?.id);
	}

	/**
	 * Every song cooking right now. WHEN NOT SEARCHING this is the full union — the live status map
	 * plus anything the catalog says is cooking — because this is the one place a cook you started is
	 * guaranteed to be visible, so a song you kicked off then went idle from must not disappear while
	 * it works. WHEN SEARCHING it is scoped to the query via `cookingResults`, the server's
	 * query-matched cooking group: a song someone else is cooking that does not match your search must
	 * NOT appear under it (#252). The id-selection lives in the pure `cookingGroupIds` helper so it is
	 * unit-testable; `failed` is included and `ready`/`canceled` excluded, all inside that helper.
	 */
	const cookingRows = $derived.by(() => {
		const ids = cookingGroupIds({
			searchActive,
			cookingResults,
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
	 * The songs the readiness groups above already account for. The whole point of the readiness axis
	 * is that a song appears EXACTLY ONCE, so the zero-query shortcut lists (popular / recently
	 * queued) must subtract it — otherwise a cooked song shows up three times on one screen, once per
	 * list, which is precisely the confusion the source tabs used to cause.
	 *
	 * Unconditional since #833: with the readiness chips gone, the ready and cooking groups always
	 * render, so they always account for their songs.
	 */
	const accountedFor = $derived.by(() => {
		const ids = new Set<string>();
		for (const m of searchActive ? readyResults : library) ids.add(m.id);
		for (const c of cookingRows) ids.add(c.id);
		return ids;
	});
	function unaccounted(list: Media[]): Media[] {
		return list.filter((m) => !accountedFor.has(m.id));
	}

	// ── search (debounced + cancel-in-flight) ────────────────────────────────
	let query = $state('');
	let readyResults = $state<Media[]>([]);
	let rawResults = $state<Media[]>([]);
	// The server's query-matched cooking group. Held so `cookingRows` can scope to the query while a
	// search is active instead of re-deriving from the whole catalog (#252). Cleared with the box.
	let cookingResults = $state<Media[]>([]);
	let searching = $state(false);
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	let inflight: AbortController | undefined;
	const searchActive = $derived(query.trim().length > 0);

	function onQueryInput() {
		clearTimeout(debounceTimer);
		const q = query.trim();
		if (!q) {
			readyResults = [];
			rawResults = [];
			cookingResults = [];
			searching = false;
			inflight?.abort();
			loadShortcuts();
			return;
		}
		debounceTimer = setTimeout(() => runSearch(q), 150);
	}

	/** Drop the search and go back to the full library. Same teardown as clearing the box by hand. */
	function clearSearch() {
		query = '';
		onQueryInput();
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
			cookingResults = j.cooking ?? [];
			mergeMedia([...readyResults, ...rawResults, ...cookingResults]);
		} catch (e) {
			if ((e as Error).name !== 'AbortError') {
				readyResults = [];
				rawResults = [];
				cookingResults = [];
				showError('Search failed — check your connection');
			}
		} finally {
			if (inflight === ctrl) searching = false;
		}
	}

	// transient error toast
	let errorMsg = $state('');
	let errorTimer: ReturnType<typeof setTimeout> | undefined;
	function showError(msg: string) {
		errorMsg = msg;
		clearTimeout(errorTimer);
		errorTimer = setTimeout(() => (errorMsg = ''), 4000);
	}

	// remove + undo toast
	let undo = $state<{ mediaId: string; title: string } | null>(null);
	let undoTimer: ReturnType<typeof setTimeout> | undefined;
	// The undo toast's real rendered height, bound to its clientHeight in the markup. The error toast
	// docks ABOVE it, and the toast wraps to as many lines as a real “title — artist” needs, so the
	// error toast's offset must track this MEASURED value, not a constant (the same reason --peek-h is
	// measured). Published as 0 when no undo toast is up, so the error toast then docks above the peek.
	let undoH = $state(0);
	$effect(() => {
		document.documentElement.style.setProperty('--undo-h', `${undo ? undoH : 0}px`);
		// Tear the inline property down on unmount. Without this it OUTLIVES the page on documentElement,
		// so a stale --undo-h keeps skewing the --error-dock stack (calc(... + var(--undo-h) ...)) after
		// this route is gone — the same leak class #598 §14 fixed for --peek-h in QueueSheet. This effect
		// always writes (0 when no toast), so it always owns the property and clears it unconditionally.
		return () => {
			document.documentElement.style.removeProperty('--undo-h');
		};
	});
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

	// zero-keystroke shortcuts (shown when the search box is empty)
	let recent = $state<Media[]>([]);
	let popular = $state<Media[]>([]);
	async function loadShortcuts() {
		try {
			const j = await (await fetch('/api/search?q=')).json();
			recent = j.recent ?? [];
			popular = j.popular ?? [];
			mergeMedia([...recent, ...popular]);
		} catch {
			/* ignore */
		}
	}

	// the saved-karaoke library + whatever is cooking, for a client that just loaded
	let library = $state<Media[]>([]);
	// A song's descriptive tags, mediaId → its 'tag'-kind values, arriving beside `library` from
	// /api/library (#689). A parallel map rather than a field on Media because tags live in their own
	// table and Media is the origin identity; the row reads its own song's entry, absent = no chips.
	let libraryTags = $state<Record<string, string[]>>({});
	/*
	 * DELETED HERE (#833, direction B): the browse disclosure and the two facet rails it hid — the
	 * `facets` state, the `browseFilter` that held one artist OR one tag, `browseOpen`, `setBrowse`,
	 * and the `?artist=`/`?tag=` query this page sent. They were mechanisms 2 and 3 of the four
	 * concurrent ways to narrow one list, and the ruling was to delete them rather than tidy them.
	 *
	 * The SERVER half stays: /api/library still computes the facets and still honours ?artist= and
	 * ?tag= (`server/media/repository.ts`, guarded by browse-ready-parity.test.ts and
	 * library-tag-filter.test.ts). Nothing on the phone asks for them any more, which is the point;
	 * removing a working, tested endpoint capability is a separate decision nobody has made.
	 */

	async function loadLibrary() {
		try {
			const j = await (await fetch('/api/library')).json();
			library = j.library ?? [];
			libraryTags = j.tags ?? {};
			mergeMedia(library);
			const cooking: { media: Media; status: MediaStatus; pct: number; etaSec?: number }[] = j.cooking ?? [];
			if (cooking.length) {
				mergeMedia(cooking.map((c) => c.media));
				const next = new Map(mediaStatus);
				// a live broadcast is fresher than this snapshot — never overwrite one
				for (const c of cooking)
					if (!next.has(c.media.id)) next.set(c.media.id, { status: c.status, pct: c.pct, etaSec: c.etaSec });
				mediaStatus = next;
			}
		} catch {
			/* ignore — the library is an accelerator, never a blocker */
		}
	}

	const queued = $derived(entries.filter((e) => e.status === 'queued').sort((a, b) => a.rotationSeq - b.rotationSeq));
	const myPicks = $derived(queued.filter((e) => e.singerId === me?.id));

	/*
	 * DIRECTION B (docs/DECISIONS.md, issue #833): on the browse screen the search box is docked in the
	 * thumb zone and the results stack UPWARD from it, so the highest-ranked row is the one nearest the
	 * thumb — which is the whole reason to dock the box at the bottom rather than the top. Every list
	 * below is therefore emitted in reverse, and the column is bottom-anchored in CSS.
	 *
	 * A stack that grows upward has to be scrolled to. Bottom-anchored content longer than the viewport
	 * starts at its TOP, which is the far end of the ranking: without this the best match renders below
	 * the fold while the worst one is what you see. Keyed on the shape of the rendered set rather than
	 * running every frame, so scrolling up to read further is not fought by the effect; instant, never
	 * smoothed, because a scroll animation is not something a reduced-motion guest asked for.
	 */
	const resultShape = $derived(
		!browsing
			? ''
			: [query.trim(), readyResults.length, cookingRows.length, rawResults.length, library.length, popular.length, recent.length].join(
					'|'
				)
	);
	$effect(() => {
		if (!resultShape) return;
		window.scrollTo({ top: document.documentElement.scrollHeight });
	});

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

	function myIdx(id: string): number {
		return myPicks.findIndex((e) => e.id === id);
	}
	function moveMine(id: string, delta: number) {
		const i = myIdx(id);
		if (i < 0) return;
		store?.moveEntry(id, i + delta);
		if (navigator.vibrate) navigator.vibrate(8);
	}

	/* ── THE OWN-PICKS REORDER MODE (XR-PH-17 … XR-PH-20, issue #836) ──────────────────────────────
	 *
	 * A drag, not a list sort. `move`'s toSeq indexes the singer's OWN queued picks, so the op cannot
	 * express "above someone else's song" — and the guest's picks are not adjacent in this flat list.
	 * So the mode DRAWS its legal positions (one per own pick) instead of letting the list imply them,
	 * dims the rows that cannot accept a drop, and declines a release anywhere else. Every predicate is
	 * in $lib/reorder-mode so it is unit-testable without mounting this route (XR-PH-21).
	 */
	/**
	 * Travel below which a press-and-release is a TAP rather than a drop, in px. 6 is QueueSheet's own
	 * threshold for the same judgement on its pull, kept identical so the two gestures on this screen do
	 * not disagree about what counts as a deliberate drag.
	 */
	const TAP_SLOP_PX = 6;
	const ownPinned = $derived(ownPicksPinned(myPicks));	const mySlots = $derived(ownSlots(myPicks.length));
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
		return gripVisible({
			mine: e.singerId === me?.id,
			ownQueuedCount: myPicks.length,
			reorderMeaningful: canReorder,
			ownPicksPinned: ownPinned
		});
	}

	/*
	 * XR-PH-18's second half: while the mode is open, another guest's row must expose NO pointer or
	 * keyboard interaction — it is not a legal drop target, and today every joined singer gets the host
	 * arrows on every row (`canHostReorder`), so without this the mode would offer a cross-singer
	 * control on exactly the rows it has just dimmed. The row's controls are dropped for the life of the
	 * mode, rather than the row being marked `inert`: `inert` also takes the row out of the
	 * accessibility tree, and XR-PH-03 turns on those rows staying INFORMATIONAL while dimmed — they
	 * are who the guest is being ordered around.
	 *
	 * It never matches the guest's OWN rows, which is what keeps XR-PH-20 true: the single-pointer
	 * alternative stays present and operable on the row being dragged, while the mode is open.
	 *
	 * Applied as an added clause on the EXISTING `reorderable` expression at both row call sites rather
	 * than by extracting that expression into a helper. The extraction was written first and reverted:
	 * `global-reorder-client-638.test.ts:32` counts the inline ternary twice on purpose, so that
	 * reverting either row kind's wiring reds it, and collapsing the two into one helper silently
	 * removed a guard belonging to another issue. A duplicated expression is the cheaper cost.
	 */
	function rowFrozen(e: QueueEntry): boolean {
		return reorderOpen && e.singerId !== me?.id;
	}

	function enterReorder(id: string, opener: HTMLElement | null) {
		if (movingId === id) return;
		movingId = id;
		hoverSlot = myIdx(id) >= 0 ? myIdx(id) : null;
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
		const target = dropTarget(commitSlot, myPicks.length);
		if (id && target !== null && target !== myIdx(id)) {
			store?.moveEntry(id, target);
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
	 * The pointer drag. Same idiom as QueueSheet's sheet pull: capture the pointer on the control that
	 * was pressed, publish the offset as a CSS custom property, and let a CSS transform do the moving —
	 * so no position is ever interpolated in JS (XR-PH-06).
	 *
	 * The slot under the finger is read by hit-testing rather than computed from row heights: rows can
	 * change height while the mode is open (a byline gains an `away` badge, another guest queues a
	 * cooking card), and a cached geometry table would then point at the wrong slot — the precise class
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
			 * TAP vs DRAG, the same distinction QueueSheet's pull makes and for the same reason. A press
			 * and release without travel is a TAP: it should OPEN the mode and leave it open, so the
			 * guest can then use a slot or the move buttons. Treating every release as a drop made a tap
			 * open and immediately close the mode — `hoverSlot` starts at the row's own index, so the
			 * release resolved to "move to where you already are" and dissolved the mode in one frame.
			 * Found by driving it with a real trusted pointer; no unit test could have seen it.
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
		const reason = modeInvalidation(myPicks, movingId, entries.find((e) => e.id === movingId)?.status);
		if (reason) exitReorder(null, reason);
	});
	/**
	 * The entry's index in the WHOLE queued list — `queued` above, so the PLAYING entry is not counted.
	 * That is exactly what a host pin's toSeq means: placePins indexes the queued entries only and
	 * leaves a playing entry in its policy slot (see rotation.ts, issue #790).
	 */
	function globalIdx(id: string): number {
		return queued.findIndex((e) => e.id === id);
	}
	/**
	 * HOST global reorder (issue #638): pin the entry one slot up/down across the WHOLE queue, crossing
	 * singers — the power `move`/moveMine deliberately cannot express. Clamped to the queue bounds so the
	 * top row cannot move up and the bottom row cannot move down (mirrors moveMine's canUp/canDown).
	 */
	function moveGlobal(id: string, delta: number) {
		const i = globalIdx(id);
		if (i < 0) return;
		const to = Math.max(0, Math.min(i + delta, queued.length - 1));
		if (to === i) return;
		store?.pinEntry(id, to);
		if (navigator.vibrate) navigator.vibrate(8);
	}
	// The entry that will ACTUALLY play next (skipping any still cooking), matching the server's
	// nextPlayable(). Pure + unit-tested in $lib/readiness.
	const nextPlayableId = $derived(
		nextPlayableEntryId(
			queued,
			(id) => mediaCatalog.get(id),
			(id) => mediaStatus.get(id)
		)
	);

	function sendPlayer(command: PlayerCommand) {
		ws?.send({ type: 'player:command', command });
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

	// ── the guest's own place in the rotation, in WORDS (XR-PH-09, issue #832) ──────────────
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
			// Only claim "up next" when the song can actually play next: a still-cooking song is skipped
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
	 * XR-PH-15's honest degradation, as ruled on #835 Q1-D: when the playing song has no isolated
	 * vocals stem the guide control renders DISABLED rather than vanishing, and this sentence — on the
	 * hero, beside the control group — says why and what still works. #253 deleted the equivalent line
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
			<a class="me-btn" href="/settings?tab=you" aria-label="Your profile">
				<span class="me-name">{me.displayName}</span>
				<span class="me-dot" style="--singer:{me.color};"></span>
			</a>
			<!--
			  Was a bare ⚙️ at font-size 1.05rem in ~18px of padding: a forced-colour-emoji glyph (the
			  trailing U+FE0F requests emoji presentation outright) in a target under even the 24px WCAG
			  2.5.8 floor, in an app that had already adopted 44px everywhere else. Now a real mark in a
			  real target.
			-->
			<a class="gear" href="/settings" aria-label="Settings" title="Settings"><Icon name="gear" /></a>
		</div>
	{/if}
</header>

<main>
	{#if !browsing}
		<!--
			HOME IS THE QUEUE (direction A, issue #832). The playing song is the one thing on this screen
			that is not a list item, so it gets a HERO rather than the docked peek row it used to share with
			the rotation; the bottom of the screen belongs to the one primary button instead.

			The live singing controls come with it, in the hero's disclosure BODY (XR-PH-15) — they are
			controls for the song playing NOW, and the sheet that used to hold them is gone from this route.
			A song with no isolated vocals stem keeps the guide row, disabled, and gets `controlsNote`
			beside the group saying why and what still works (#835 Q1-D). Who may operate the controls
			mid-song is a separate, still-open policy row (XR-PH-16); nothing about that changes here.
		-->
		<NowPlayingHero
			title={nowEntry ? (nowDisplay.title || mediaTitle(nowEntry.mediaId)) : 'Nothing playing'}
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
			{controlsSummary}
			{controlsNote}
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
					<button
						class="key-btn"
						disabled={!keyShiftEnabled || playback.keyShift <= -7}
						onclick={() => sendPlayer({ cmd: 'key', semitones: playback.keyShift - 1 })}
						><Icon name="minus" /> semitone</button
					>
					<button
						class="key-btn"
						disabled={!keyShiftEnabled || playback.keyShift >= 7}
						onclick={() => sendPlayer({ cmd: 'key', semitones: playback.keyShift + 1 })}><Icon name="plus" /> semitone</button
					>
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
						<button class="range-toggle" aria-expanded={rangeOpen} onclick={() => (rangeOpen = !rangeOpen)}>
							<Icon name={rangeOpen ? 'chevron-down' : 'chevron-right'} />
							Vocal range
							<span class="range-peek">{rangeText}</span>
						</button>
						{#if rangeOpen}
							<div class="range-body">
								<div class="range-facts">
									<span class="range-label">{rangeText}</span>
									{#if octaves !== null}<span class="range-oct">{octaves} oct</span>{/if}
								</div>
								{#if bandSentence}<p class="range-band">{bandSentence}</p>{/if}
								<RangeBar profile={profile} keyShift={playback.keyShift} />
							</div>
						{/if}
					</div>
				{/if}

				<!--
					The TV stage look lives ONLY in room settings now. The per-song override that used to sit here
					(a phone repainting the stage for the current song via sendPlayer 'background') was removed: the
					stage is a room-wide decision, not a per-singer one, so a single writer in Settings is correct.
					The server command, PlaybackState.background field and the TV resolver are deliberately kept —
					with no writer the field simply stays null and the resolver already falls back to the room style.
				-->

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
				<p class="reorder-hint">Drag to one of your own positions. Other guests' songs stay put.</p>
				<div class="reorder-acts">
					<button class="chip" onclick={() => exitReorder(hoverSlot)}>Done</button>
					<button class="chip" onclick={() => exitReorder(null)}>Cancel</button>
				</div>
			</div>
		{/if}
		{#if !reorderOpen && reorderNote}
			<!-- The mode closed ITSELF (XR-PH-19). Visible as well as announced: the list has just changed
			     shape under the guest's hand, and a reason only a screen reader gets is not a reason. -->
			<p class="reorder-note">{reorderNote}</p>
		{/if}
		{#if queued.length === 0}
			<p class="empty">Queue's empty — add a song to start the party.</p>
		{:else}
			{#each queued as e, i (e.id)}
				{@const s = singerOf(e.singerId)}
				{@const card = queueCardKind(mediaCatalog.get(e.mediaId), mediaStatus.get(e.mediaId))}
				{@const isMine = e.singerId === me?.id}
				{@const ownIdx = myIdx(e.id)}
				<!--
					XR-PH-18 — ONE legal drop target per own queued pick, drawn immediately above the pick whose
					position it represents, and rendered ONLY while the mode is open. The count therefore equals
					`myPicks.length` by construction and can never equal the visible list length: `mySlots` is
					derived from my own picks, so another guest queueing a song mid-drag changes the flat list
					around these and changes neither their number nor what each one commits.

					`data-slot` carries the index the release commits. The pointer path reads it by hit-testing
					(see onGripPointerDown) instead of from a geometry table, and the same index is what the
					button's own click commits — so the keyboard path and the pointer path cannot drift apart.
				-->
				{#if reorderOpen && isMine && ownIdx >= 0 && mySlots[ownIdx]}
					{@const slot = mySlots[ownIdx]}
					<button
						class="dropslot"
						class:hot={hoverSlot === slot.index}
						data-slot={slot.index}
						aria-label={slot.label}
						onclick={() => exitReorder(slot.index)}>{slot.ordinal}</button
					>
				{/if}
				{#if card === 'cooking' || card === 'failed'}
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
						reorderable={!rowFrozen(e) &&
							(canHostReorder ? queued.length > 1 : canReorder && e.singerId === me?.id && myPicks.length > 1)}
						canUp={canHostReorder ? globalIdx(e.id) > 0 : myIdx(e.id) > 0}
						canDown={canHostReorder
							? globalIdx(e.id) >= 0 && globalIdx(e.id) < queued.length - 1
							: myIdx(e.id) >= 0 && myIdx(e.id) < myPicks.length - 1}
						dimmed={reorderOpen && !isMine}
						onup={() => (canHostReorder ? moveGlobal(e.id, -1) : moveMine(e.id, -1))}
						ondown={() => (canHostReorder ? moveGlobal(e.id, 1) : moveMine(e.id, 1))}
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
						reorderable={!rowFrozen(e) &&
							(canHostReorder ? queued.length > 1 : canReorder && e.singerId === me?.id && myPicks.length > 1)}
						canUp={canHostReorder ? globalIdx(e.id) > 0 : myIdx(e.id) > 0}
						canDown={canHostReorder
							? globalIdx(e.id) >= 0 && globalIdx(e.id) < queued.length - 1
							: myIdx(e.id) >= 0 && myIdx(e.id) < myPicks.length - 1}
						grip={gripFor(e)}
						gripId={e.id}
						dimmed={reorderOpen && !isMine}
						moving={movingId === e.id && dragging}
						dragY={movingId === e.id && dragging ? dragY : 0}
						ongripdown={(ev) => onGripPointerDown(e, ev)}
						ongrip={(el) => enterReorder(e.id, el)}
						onremove={() => removeWithUndo(e)}
						onup={() => (canHostReorder ? moveGlobal(e.id, -1) : moveMine(e.id, -1))}
						ondown={() => (canHostReorder ? moveGlobal(e.id, 1) : moveMine(e.id, 1))}
					/>
				{/if}
			{/each}
		{/if}
	{/if}

	<!--
		THE BROWSE SCREEN — direction A's push (issue #832), direction B's layout (issue #833).

		The search box is NOT in here. It is docked in the thumb zone below this column, and the results
		STACK UPWARD from it: the top-ranked row is the LAST one in this block, so it is the row nearest
		the thumb. That is the whole reason to dock the box at the bottom rather than the top, and it is
		why every list below is emitted with its ranking REVERSED and the sections run least-relevant
		first. DOM order still matches visual order (XR-PH-12) — what is reversed is the order of the
		list, not the direction the column paints in, which is what a `column-reverse` container would
		have done instead and it would have inverted the focus sequence with it.

		The four concurrent filter mechanisms that used to sit at the top of this block are GONE: the
		three readiness chips, the artist rail, the genre rail, and the group headings that re-announced
		the readiness axis in prose. Typing in the docked box is the only way to narrow the list. Four
		ways to narrow one list was the defect; a tidier four would still have been the defect.

		The back control is first in the DOM because it is first visually (XR-PH-12); the phone's own
		Back gesture also works, because the push is a real navigation.
	-->
	{#if browsing}
		<div class="backrow">
			<button class="back-btn" onclick={closeBrowse}><Icon name="arrow-left" /> Queue</button>
		</div>
	{/if}

	<!--
		FURTHEST FROM THE THUMB: songs that still need karaoke made, or — with an empty box — the
		zero-keystroke shortcuts. Recently queued sits above Popular tonight so that the more useful of
		the two is the closer one to the search box.
	-->
	{#if browsing}
		{#if searchActive}
			{#if searching && rawResults.length === 0 && readyResults.length === 0}
				<div aria-busy="true" aria-label="Searching…">
					{#each [0, 1, 2] as i (i)}
						<div class="skel-row">
							<div class="skel-thumb"></div>
							<div class="skel-text">
								<div class="skel-line"></div>
								<div class="skel-line short"></div>
							</div>
						</div>
					{/each}
				</div>
			{/if}
			{#if !searching && rawResults.length === 0 && readyResults.length === 0}
				<p class="empty">No results. YouTube search needs yt-dlp installed on the server.</p>
			{/if}
			{@const rawRows = unaccounted(rawResults).reverse()}
			{#if rawRows.length}
				<h2 class="grouphead">Needs karaoke · has vocals</h2>
				{#each rawRows as m (m.id)}
					{@const r = readinessFor(m)}
					<SongRow
						{...rowMeta(m)}
						readiness={r}
						pct={liveOf(m.id)?.pct ?? 0}
						status={liveOf(m.id)?.status}
						inQueue={inMyQueue(m.id)}
						cookable={isCookableSource(m.source)}
						onadd={() => addSong(m.id)}
						onmake={canCook(m, r) ? () => singThis(m.id) : undefined}
					/>
				{/each}
			{/if}
		{:else}
			{@const popularRows = unaccounted(popular).reverse()}
			{@const recentRows = unaccounted(recent).reverse()}
			{#if !popularRows.length && !recentRows.length && !library.length}
				<p class="empty">Search for a song in the box below, or be the first to queue one.</p>
			{/if}
			{#if recentRows.length}
				<h2 class="grouphead grouphead-mark"><Icon name="clock" /> Recently queued</h2>
				{#each recentRows as m (m.id)}
					{@const r = readinessFor(m)}
					<SongRow
						{...rowMeta(m)}
						readiness={r}
						pct={liveOf(m.id)?.pct ?? 0}
						status={liveOf(m.id)?.status}
						inQueue={inMyQueue(m.id)}
						cookable={isCookableSource(m.source)}
						onadd={() => addSong(m.id)}
						onmake={canCook(m, r) ? () => singThis(m.id) : undefined}
					/>
				{/each}
			{/if}
			{#if popularRows.length}
				<h2 class="grouphead grouphead-mark"><Icon name="flame" /> Popular tonight</h2>
				{#each popularRows as m (m.id)}
					{@const r = readinessFor(m)}
					<SongRow
						{...rowMeta(m)}
						readiness={r}
						pct={liveOf(m.id)?.pct ?? 0}
						status={liveOf(m.id)?.status}
						inQueue={inMyQueue(m.id)}
						cookable={isCookableSource(m.source)}
						onadd={() => addSong(m.id)}
						onmake={canCook(m, r) ? () => singThis(m.id) : undefined}
					/>
				{/each}
			{/if}
		{/if}
	{/if}

	<!--
		Cooking, immediately above the ready rows: rotation HOLDS a cooking song's slot, so it keeps its
		fair position and plays when the stems land. Cooking is not a blocked state, which is why these
		rows sit with the singable ones rather than behind a chip. The heading that said so in prose was
		mechanism 4 and is deleted — SongRow's own readiness chip already says it per row, and a failed
		cook says so on its own row rather than in a heading covering the whole group.
	-->
	{#if browsing && cookingRows.length}
		{@const cookingStack = [...cookingRows].reverse()}
		{#each cookingStack as c (c.id)}
			{@const r = displayReadiness(c.media, liveOf(c.id))}
			<SongRow
				{...rowMeta(c.media)}
				readiness={r}
				pct={c.pct}
				status={c.status}
				inQueue={inMyQueue(c.id)}
				cookable={isCookableSource(c.media.source)}
				onadd={() => addSong(c.id)}
				onmake={canCook(c.media, r) ? () => singThis(c.id) : undefined}
			/>
		{/each}
	{/if}

	<!--
		NEAREST THE THUMB: the songs that can be sung right now, best match last. The "Ready to sing ·
		no wait" heading that used to sit above them was mechanism 4 — it restated the readiness chip
		directly above it — and it is deleted with the chips.
	-->
	{#if browsing}
		{@const readyStack = [...(searchActive ? readyResults : library)].reverse()}
		{#each readyStack as m (m.id)}
			<SongRow {...rowMeta(m)} readiness="ready" inQueue={inMyQueue(m.id)} onadd={() => addSong(m.id)} />
		{/each}
		<!--
			The library HAS karaoke songs, they just do not match what is in the box. Saying so — and
			naming the way back — is what stops a non-matching query reading as "the app threw my
			downloads away". This used to be the Ready CHIP's empty state; the chip is gone, and the
			condition it was really about (a query the ready library cannot answer) is stated directly.
		-->
		{#if searchActive && !readyStack.length && library.length}
			{@const empty = readyEmptyState({ searchActive, libraryCount: library.length, query })}
			<p class="empty">{empty.message}</p>
			{#if empty.showAllCount !== null}
				<div class="showall-row">
					<button class="chip ok chip-icon" onclick={clearSearch}
						><Icon name="mic" /> Show all {empty.showAllCount}</button
					>
				</div>
			{/if}
		{/if}
	{/if}
</main>

<!--
	The ONE primary action, docked in the thumb zone. It RESERVES its band in normal flow rather than
	overlapping the list (XR-PH-12): --dock-h carries this element's measured height and `main` pads by
	it, so the last queue row is reachable at every scroll position. It is also LAST in the DOM, after
	the content it sits below, so the tab sequence follows the visual order.
-->
{#if me && !browsing}
	<div class="cta-dock" bind:clientHeight={dockH}>
		<button class="cta" onclick={openBrowse}><Icon name="plus" /> Add a turn</button>
	</div>
{/if}

<!--
	THE SEARCH DOCK (direction B, issue #833). ONE box across every source: a singer picks by readiness
	("can I sing this now?"), never by which index the song came from — so there is no source switch,
	and since this issue, no readiness chips, no artist rail and no genre rail either. Typing is the
	only filter.

	It is bottom-anchored in the THUMB ZONE, and the results stack upward from it, which is what makes
	the nearest row the best answer. It is the browse screen's one docked band, so it publishes the same
	--dock-h the primary button publishes on home: `main` already pads by that token, so the top-ranked
	row cannot end up under the band (XR-PH-12). LAST in the DOM, after the content it sits above.

	The `aria-label` is a driven-flow anchor (`SEL.search`), not decoration: every phone probe reaches
	the library by waiting on it, so renaming it hangs them on a timeout rather than failing an
	assertion. Moving the box is safe; renaming the label is not.
-->
{#if browsing}
	<div class="search-dock" bind:clientHeight={dockH}>
		<div class="card searchbox">
			<span class="search-mark"><Icon name="search" /></span>
			<input
				bind:value={query}
				oninput={onQueryInput}
				aria-label="Search a song or artist"
				placeholder="Search a song or artist…"
			/>
			{#if searching}<span class="search-spinner" aria-label="Searching"></span>{/if}
		</div>
	</div>
{/if}

{#if undo}
	<div class="undo-toast" role="status" bind:clientHeight={undoH}>
		<span>Removed “{undo.title}”</span>
		<button onclick={doUndo}>Undo</button>
	</div>
{/if}

{#if errorMsg}
	<div class="error-toast" role="alert">{errorMsg}</div>
{/if}

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
	of the page wants (the sheet binds its own).
-->
<svelte:window onkeydown={(e) => reorderOpen && e.key === 'Escape' && exitReorder(null)} />

<div class="sr-live" role="status" aria-live="polite" aria-atomic="true">{liveMsg}</div>

<style>
	/*
	 * The primary button is docked, so the column must be able to scroll clear of it (XR-PH-12): the
	 * padding reserves the band's MEASURED height, which is what keeps the last queue row reachable at
	 * every scroll position instead of parked under the button. The fallback covers the first frame
	 * before the effect publishes a measurement. Both bands publish the SAME token — the browse
	 * screen's search dock and home's primary button — so this one rule reserves whichever is present.
	 */
	main {
		flex: 1;
		padding: var(--space-xs) var(--space-3xl) calc(var(--dock-h, 0px) + 28px);
	}
	/*
	 * THE BOTTOM-ANCHORED BROWSE STACK (direction B, issue #833). Results grow UPWARD from the docked
	 * search box, so the column's content sits at its bottom edge rather than its top: with one line of
	 * content, that line is beside the thumb instead of stranded at the top of an empty screen.
	 *
	 * Selected by `:has(> .backrow)` rather than by a class on `<main>` because the back control IS the
	 * browse screen — it renders on `{#if browsing}` and nowhere else — and because `<main>` carries no
	 * attributes today, which three separate driven-flow anchors read as the literal string `<main>`.
	 *
	 * TWO declarations, and the SECOND is the one doing the work. The auto bottom margin on the back
	 * control both keeps it at the top of the column and pushes every later sibling to the bottom, which
	 * is the whole anchoring. A `justify-content: flex-end` beside it was measured to change nothing —
	 * the two always co-occur, because the selector only matches when the back control is present — so
	 * it is not written here rather than left as a declaration no revert can falsify.
	 */
	main:has(> .backrow) {
		display: flex;
		flex-direction: column;
	}
	main:has(> .backrow) > .backrow {
		margin-bottom: auto;
	}
	/*
	 * The docked primary action. `position: fixed` is what makes it reachable with one thumb wherever
	 * the list is scrolled to; it does not overlap content, because `main` pads by this element's own
	 * measured height (--dock-h) rather than by a guess. The safe-area inset lives HERE, on the band
	 * that actually sits at the bottom of the screen, and reaches the toasts THROUGH --dock-h — the
	 * same contract the sheet's peek carried, so do not add a second env() term to anything above.
	 */
	.cta-dock {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: var(--z-dock);
		display: flex;
		justify-content: center;
		padding: var(--space-md) var(--space-3xl) calc(var(--space-md) + env(safe-area-inset-bottom));
		background: linear-gradient(to top, var(--bg), color-mix(in srgb, var(--bg) 88%, transparent));
		border-top: 1px solid var(--line);
	}
	.cta {
		width: 100%;
		max-width: var(--max-w);
		min-height: var(--tap);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-sm);
		border: 0;
		border-radius: var(--radius);
		/* --accent + --on-accent, never --grad: this button carries a LABEL, and no stop's gradient is
		   certified to carry one (#840, XR-COL-13). app.css states that rule at the token itself. */
		background: var(--accent);
		color: var(--on-accent);
		font-size: 0.95rem;
		font-weight: 700;
		cursor: pointer;
	}
	.cta:active {
		transform: scale(0.99);
	}
	/* The way back off the browse screen. First in the DOM because it is first visually (XR-PH-12). */
	.backrow {
		display: flex;
		margin: 0 0 var(--space-sm);
	}
	.back-btn {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
		min-height: var(--tap);
		padding: 0 var(--space-md) 0 0;
		background: none;
		border: 0;
		color: var(--ink-dim);
		font: inherit;
		font-size: 0.85rem;
		font-weight: 600;
		cursor: pointer;
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
	 * THE REORDER MODE's own chrome (issue #836).
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
		font-size: 0.78rem;
		color: var(--ink-dim);
	}
	.reorder-acts {
		display: flex;
		gap: var(--space-sm);
		flex: 0 0 auto;
	}
	.reorder-note {
		margin: 0 0 var(--space-sm);
		font-size: 0.78rem;
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
		 * The TOKEN, not the number (#831). `--tap` is the standard; a bare `44px` merely agrees with it
		 * today, so raising the standard in `app.css` would leave this control behind while every touch
		 * guard stayed green. `expressesTap` in `test-helpers.ts` asks for the token for that reason.
		 */
		min-height: var(--tap);
		margin-bottom: var(--space-xs);
		border: 2px dashed var(--line-strong);
		border-radius: var(--radius-sm);
		background: var(--bg2);
		color: var(--ink-dim);
		font-size: 0.78rem;
		font-weight: 600;
		cursor: pointer;
	}
	.dropslot.hot {
		/* var(--accent), not the retired --accent-strong (#840, XR-COL-11) — a non-text border. */
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
	   viewport (#109). Truncate it instead: text-overflow only fires on a block box, so this is a
	   styled span (block), and min-width:0 must exist up the whole chain (.me-cluster, .me-btn) for it
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
	.gear {
		display: grid;
		place-items: center;
		min-width: var(--tap);
		min-height: var(--tap);
		margin-right: -10px;
		font-size: 1.15rem;
		color: var(--ink-dim);
		text-decoration: none;
	}
	.gear:hover {
		color: var(--ink);
	}

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
		/*
		 * The wide layout keeps its columns on the browse screen; only the anchoring changes. It needs its
		 * OWN declaration: an auto margin on a grid item aligns that item inside its own area and does not
		 * push its siblings, so the flex mechanism above does not carry over.
		 */
		main:has(> .backrow) {
			display: grid;
			align-content: end;
		}
		main > :global(*) {
			grid-column: 1 / -1;
		}
		main > :global(.row) {
			grid-column: auto;
		}
	}
	/*
	 * THE SEARCH DOCK (direction B, issue #833). Same band contract as .cta-dock, for the same reason:
	 * `position: fixed` is what keeps the box reachable with one thumb wherever the stack is scrolled
	 * to, and it does not overlap content because `main` pads by this element's own measured height
	 * (--dock-h) rather than by a guess. The safe-area inset lives HERE, on the band that actually sits
	 * at the bottom of the screen, and reaches the toasts THROUGH --dock-h — so do not add a second
	 * env() term to anything above.
	 */
	.search-dock {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: var(--z-dock);
		display: flex;
		justify-content: center;
		padding: var(--space-md) var(--space-3xl) calc(var(--space-md) + env(safe-area-inset-bottom));
		background: linear-gradient(to top, var(--bg), color-mix(in srgb, var(--bg) 88%, transparent));
		border-top: 1px solid var(--line);
	}
	.searchbox {
		display: flex;
		align-items: center;
		gap: var(--space-md);
		padding: var(--space-lg) var(--space-xl);
		min-height: 52px;
		width: 100%;
		max-width: var(--max-w);
	}
	.searchbox input {
		border: 0;
		background: transparent;
		color: var(--ink);
		font-size: var(--ph-text-base);
		/*
		 * `flex: 1` with `min-width: 0`, never `width: 100%`. An <input>'s intrinsic minimum width comes
		 * from its character size, so as a flex item with the default `min-width: auto` it refuses to
		 * shrink below roughly 20 characters — which at 200% text on a 320px viewport pushes the row
		 * wider than the screen and forces horizontal scrolling (SC 1.4.10). That is the exact shape
		 * #857 measured at 436px against 320px on the chip row this dock replaces.
		 */
		flex: 1;
		min-width: 0;
		/*
		 * The input, not the wrapper, is the tap target: `.searchbox` is a div, so tapping its padding
		 * focuses nothing (#863). Give the input the full tap floor so the hit extent at its centre is
		 * var(--tap), not the bare 22px text line. The wrapper's own min-height (52px here, raised from
		 * 42px at the narrow breakpoint below) already absorbs it.
		 */
		min-height: var(--tap);
	}
	.chip {
		/* var(--tap), matching the queue actions and the row buttons. The readiness chips this was
		   written for were ~30px — above the 24px WCAG floor, but below the threshold this app had
		   already set for itself everywhere else. Those chips are deleted (#833); the rule stays because
		   the way back out of a non-matching search ("Show all N") is a `chip ok chip-icon` and is just
		   as tappable. The TOKEN, never the number (#831): the control has to move with `--tap`. */
		min-height: var(--tap);
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
		padding: 7px var(--space-xl);
		border-radius: 22px;
		font-size: 0.82rem;
		font-weight: 600;
		cursor: pointer;
		background: var(--card);
		border: 1px solid var(--line);
		color: var(--ink-dim);
	}
	.chip.ok {
		color: var(--ok);
	}
	/* any label that leads with a mark rather than a word */
	.chip-icon {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
	}
	.search-mark {
		display: grid;
		place-items: center;
		color: var(--ink-dim);
	}
	.grouphead-mark {
		display: flex;
		align-items: center;
		gap: 7px;
	}
	.chip:active {
		transform: scale(0.95);
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
		gap: var(--space-xs);
		margin: var(--space-xs) 0 var(--space-3xs);
		align-items: center;
	}
	.key.disabled {
		opacity: 0.5;
	}
	.key .lab {
		font-size: 0.7rem;
		color: var(--ink-dim);
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}
	.key.shifted .lab {
		color: var(--warn);
	}
	.key button {
		flex: 1;
		border: 1px dashed var(--line-strong);
		background: transparent;
		color: var(--ink-dim);
		border-radius: var(--radius-btn);
		padding: var(--space-xs);
		font-size: var(--ph-text-sm);
		cursor: pointer;
		min-height: var(--tap);
	}
	/* Centre the mark with its word. The glyphs these replaced were U+2212 and U+FF0B — the fullwidth
	   plus carries CJK metrics, so it sat off-baseline beside Latin text at every size. */
	.key-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-xs);
	}
	.key:not(.disabled) button:not(:disabled) {
		border-style: solid;
		border-color: var(--line);
		color: var(--ink);
	}
	.key:not(.disabled) button:not(:disabled):active {
		transform: scale(0.95);
	}
	.key button:disabled {
		cursor: default;
	}

	/*
	 * The key head line. Sits ABOVE the ± buttons (see the markup comment for why it cannot be inline).
	 * Same label idiom as .gt-head / .key .lab. The original→sounding pair reads left to right; the
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
		font-size: 0.85rem;
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
		font-size: 0.85rem;
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
	.range-toggle {
		width: 100%;
		min-height: var(--tap);
		display: inline-flex;
		align-items: center;
		gap: 7px;
		background: none;
		border: 0;
		padding: 0 var(--space-3xs);
		cursor: pointer;
		color: var(--ink-dim);
		font-size: var(--ph-text-2xs);
		font-weight: 700;
		letter-spacing: 0.14em;
		text-transform: uppercase;
	}
	.range-toggle:hover {
		color: var(--ink);
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
		font-size: 0.95rem;
		font-weight: 700;
		color: var(--ink);
		font-variant-numeric: tabular-nums;
	}
	.range-oct {
		font-size: 0.72rem;
		color: var(--ink-dim);
		font-variant-numeric: tabular-nums;
	}
	.range-band {
		font-size: 0.72rem;
		color: var(--ink-dim);
		margin: var(--space-2xs) 0 0;
	}

	.search-spinner {
		width: 15px;
		height: 15px;
		flex: none;
		border-radius: 50%;
		border: 2px solid var(--line);
		border-top-color: var(--accent2);
		animation: spin 0.7s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	.skel-row {
		display: flex;
		align-items: center;
		gap: var(--space-lg);
		padding: var(--space-lg) var(--space-xl);
		margin-bottom: var(--space-sm);
		border-radius: 14px;
		background: var(--card);
		border: 1px solid var(--line);
	}
	.skel-thumb {
		width: 44px;
		height: 44px;
		flex: none;
		border-radius: var(--radius-btn);
	}
	.skel-text {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
	}
	.skel-line {
		height: 12px;
		border-radius: 6px;
	}
	.skel-line.short {
		width: 55%;
	}
	.skel-thumb,
	.skel-line {
		background: linear-gradient(90deg, var(--card2) 25%, var(--line) 37%, var(--card2) 63%);
		background-size: 400% 100%;
		animation: shimmer 1.3s ease-in-out infinite;
	}
	@keyframes shimmer {
		0% {
			background-position: 100% 0;
		}
		100% {
			background-position: -100% 0;
		}
	}
	/*
	 * Docked-toast stacking, measured UP from the docked primary button. --dock-h is bound to that band's
	 * clientHeight, and the peek's own padding already includes env(safe-area-inset-bottom), so the
	 * inset arrives THROUGH --dock-h — do NOT add another env() term here or the gap doubles.
	 *
	 * The offsets were hand-tuned constants (14 / 70) stacking one element above the other above a
	 * measured value, so they overlapped the instant either toast changed height. Named as scoped
	 * tokens the stacking order is explicit: undo sits just above the peek; the error toast docks above
	 * the undo toast's REAL rendered height (--undo-h, bound to its clientHeight in script; 0 when it
	 * is absent) plus a fixed gap, so the two never draw over each other however many lines the undo
	 * toast wraps to. The height is content-dependent and unbounded, so it MUST be measured, not a
	 * constant. Adjust the gaps, not the measurement.
	 */
	:root {
		--undo-dock: calc(var(--dock-h, 0px) + 14px);
		--error-dock: calc(var(--undo-dock) + var(--undo-h, 0px) + 14px);
	}
	.undo-toast {
		position: fixed;
		left: 0;
		right: 0;
		bottom: var(--undo-dock);
		margin-inline: auto;
		width: fit-content;
		display: flex;
		align-items: center;
		gap: var(--space-xl);
		z-index: var(--z-dock);
		background: var(--card2);
		border: 1px solid var(--line);
		border-radius: 14px;
		padding: var(--space-lg) var(--space-2xl);
		box-shadow: var(--shadow);
		font-size: var(--ph-text-md);
		max-width: 90vw;
	}
	.undo-toast button {
		/* The only interactive control on the phone that fell under the app's own tap floor — and the
		   one on a 5-second timer, so the hardest to hit in time. Raised to var(--tap) via min-height (the
		   row is align-items:center, so it grows to fit and nothing else shifts); the padding-only box
		   it had (6px 12px) slipped past the generic touch-target guard, which only flags an explicit
		   height. touch-targets.test.ts now covers padding-only controls too. */
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: var(--tap);
		border: 0;
		background: var(--accent);
		color: var(--on-accent);
		font-weight: 700;
		border-radius: 8px;
		padding: var(--space-xs) var(--space-xl);
		cursor: pointer;
	}
	.error-toast {
		/* Offset above the undo toast: both sat at the same bottom and z-index, so one drew over the
		   other and a guest saw only whichever rendered last. */
		position: fixed;
		left: 0;
		right: 0;
		bottom: var(--error-dock);
		margin-inline: auto;
		width: fit-content;
		z-index: var(--z-dock);
		background: var(--danger-bg);
		color: var(--danger-ink);
		border: 1px solid var(--danger-line);
		padding: 11px var(--space-2xl);
		border-radius: var(--radius-sm);
		font-size: 0.88rem;
		max-width: 90vw;
	}

	/* Matches the gear beside it: a real var(--tap) target, not text that happens to be tappable. An
	   anchor now (it navigates to /settings?tab=you), so the underline a link would default to is
	   dropped — the affordance here is the var(--tap) box and the colour dot, as it was as a button. */
	.me-btn {
		display: inline-flex;
		align-items: center;
		gap: var(--space-sm);
		min-width: 0;
		min-height: var(--tap);
		padding: 0 var(--space-xs);
		background: none;
		border: 0;
		cursor: pointer;
		color: inherit;
		font: inherit;
		text-decoration: none;
	}
	.me-btn:active {
		opacity: 0.7;
	}

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
		font-size: 0.78rem;
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
		font-size: 0.85rem;
		color: var(--ink-dim);
	}
	/* Centres the "Show all" way-back button under an empty Ready filter. Classed, not inline, so the
	   one-off row is not stranded outside the responsive rules with hard px. */
	.showall-row {
		display: flex;
		justify-content: center;
		padding: 0 0 var(--space-sm);
	}

	/*
	 * Respect a reduced-motion preference. Both remaining animations otherwise run unguarded and
	 * indefinitely: the search spinner and the skeleton shimmer. Disable them; a static spinner is a
	 * fine resting state. (The mic pulse this block also covered went away with live scoring.)
	 */
	@media (prefers-reduced-motion: reduce) {
		.search-spinner,
		.skel-thumb,
		.skel-line {
			animation: none;
		}
	}

	/*
	 * Landscape / short viewports (e.g. a phone held sideways at 844×390). The docked band plus header
	 * and section labels otherwise consume almost the whole height, leaving no room for result rows, so
	 * the chrome shrinks and at least a couple of rows stay visible.
	 *
	 * The docked band itself is NOT shrunk by a token here any more: --dock-h now carries the button's
	 * own MEASURED height, and an inline custom property on :root outranks this rule — so a smaller
	 * value written here would have been silently defeated the moment the measurement landed. The band
	 * is one 44px control instead of a multi-line peek, which is what makes that acceptable.
	 */
	@media (max-height: 480px) {
		.topbar {
			padding: var(--space-xs) var(--space-3xl) var(--space-2xs);
		}
		main {
			padding-top: var(--space-3xs);
		}
		.searchbox {
			/* rise to hold the 44px input added in #863 — 42px would clip its tap target */
			min-height: var(--tap);
			padding: var(--space-sm) var(--space-xl);
		}
		.grouphead {
			margin: var(--space-sm) var(--space-2xs) var(--space-2xs);
		}
	}
</style>
