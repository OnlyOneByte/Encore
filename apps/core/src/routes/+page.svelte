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
		voiceBandSentence
	} from '@encore/shared';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
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
	import QueueSheet from '$lib/components/QueueSheet.svelte';
	import ProcessingCard from '$lib/components/ProcessingCard.svelte';
	import GuidingTrack from '$lib/components/GuidingTrack.svelte';
	import RangeBar from '$lib/components/RangeBar.svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import { cookAndQueue } from '$lib/cook-and-queue';
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
	import type { MediaStatus } from '@encore/shared';
	import { isPlayable, hasGuidingTrack, effectiveGuideLevel, isCookableSource } from '@encore/shared';

	let me = $state<PublicSinger | null>(null);
	let entries = $state<QueueEntry[]>([]);
	// Entry ids of not-yet-confirmed optimistic adds, republished on every store emit so the
	// QueueRow/ProcessingCard `pending` affordance reflects the real pending map instead of the
	// placeholder rotationSeq that applyAndReseq overwrites in the same frame (issue #304).
	let unconfirmed = $state<Set<string>>(new Set());
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
	let sheetOpen = $state(false);

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

	// derived: my position in the rotation + who's right before me
	const myNextEntry = $derived(
		entries
			.filter((e) => e.singerId === me?.id && e.status === 'queued')
			.sort((a, b) => a.rotationSeq - b.rotationSeq)[0]
	);
	const myPositionLabel = $derived.by(() => {
		if (!myNextEntry) return '';
		const q = entries.filter((e) => e.status === 'queued').sort((a, b) => a.rotationSeq - b.rotationSeq);
		const idx = q.findIndex((e) => e.id === myNextEntry.id);
		if (idx < 0) return '';
		// Only claim "up next" when the song can actually play next. Ranking by raw rotationSeq said
		// "You're up next!" for a still-cooking song that the TV skips straight past, contradicting the
		// playable-aware badge in the queue list below.
		if (idx === 0) {
			const playable = entryPlayable(mediaCatalog.get(myNextEntry.mediaId), liveOf(myNextEntry.mediaId));
			return playable ? "You're up next!" : "You're next once it's ready";
		}
		const before = q[idx - 1];
		const beforeName = before ? (singers.get(before.singerId)?.displayName ?? 'someone') : 'someone';
		return `You're #${idx + 1} · after ${beforeName}`;
	});

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
				unconfirmed = store.unconfirmedAddIds;
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
	type Filter = 'all' | 'ready' | 'cooking';
	let filter = $state<Filter>('all');

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

	const showReady = $derived(filter === 'all' || filter === 'ready');
	const showCooking = $derived(filter === 'all' || filter === 'cooking');
	const showRaw = $derived(filter === 'all');
	/*
	 * The readiness group headings only earn their space when more than one group is on screen. With a
	 * chip selected, "Ready to sing · no wait" restates the chip directly above it — the fourth of the
	 * four overlapping filter mechanisms, and the one that was pure duplication. A browse facet keeps
	 * its heading either way, because there the heading carries the count and the facet name.
	 */
	const showGroupHeads = $derived(filter === 'all');

	/**
	 * The songs the readiness groups above already account for. The whole point of the readiness axis
	 * is that a song appears EXACTLY ONCE, so the zero-query shortcut lists (popular / recently
	 * queued) must subtract it — otherwise a cooked song shows up three times on one screen, once per
	 * list, which is precisely the confusion the source tabs used to cause.
	 */
	const accountedFor = $derived.by(() => {
		const ids = new Set<string>();
		if (showReady) for (const m of searchActive ? readyResults : library) ids.add(m.id);
		if (showCooking) for (const c of cookingRows) ids.add(c.id);
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
	// Browse: facets describe the WHOLE ready library (never the current filter), so picking an
	// artist cannot collapse the rail to that one artist and strand you with no way back.
	let facets = $state<{
		artists: { artist: string; count: number }[];
		tags: { tag: string; count: number }[];
	}>({
		artists: [],
		tags: []
	});
	// One active browse facet at a time — an artist OR a tag (#690), never both. A tag chip narrows
	// the library to songs carrying that descriptive tag ("duet", "80s"), reusing the media_tags
	// byKindValue index server-side (?tag=) rather than filtering the payload client-side.
	let browseFilter = $state<{ artist?: string; tag?: string } | null>(null);
	/*
	 * Browse starts collapsed so the readiness spine is the only filter on screen at rest. It opens
	 * itself when a facet is active, because a filter narrowing the list while its control is hidden
	 * reads as an empty library rather than an applied filter.
	 */
	let browseOpen = $state(false);
	$effect(() => {
		if (browseFilter) browseOpen = true;
	});

	function setBrowse(kind: 'artist' | 'tag' | null, value: string) {
		// tapping the active chip again clears it — a filter you cannot undo is a trap. Artist and tag
		// are mutually exclusive: selecting one replaces the other (#690), matching the single ?artist=
		// OR ?tag= the endpoint accepts.
		const same =
			kind === 'artist' ? browseFilter?.artist === value : kind === 'tag' ? browseFilter?.tag === value : false;
		browseFilter = kind === null || same ? null : kind === 'artist' ? { artist: value } : { tag: value };
		if (navigator.vibrate) navigator.vibrate(8);
		loadLibrary();
	}

	async function loadLibrary() {
		try {
			const qs = browseFilter?.artist
				? `?artist=${encodeURIComponent(browseFilter.artist)}`
				: browseFilter?.tag
					? `?tag=${encodeURIComponent(browseFilter.tag)}`
					: '';
			const j = await (await fetch(`/api/library${qs}`)).json();
			if (j.facets) facets = j.facets;
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
	// the Ready chip's count reflects what that chip would actually show for the current query
	const libraryCount = $derived(searchActive ? readyResults.length : library.length);

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
	<!-- ONE box across every source: a singer picks by readiness ("can I sing this now?"), never by
	     which index the song came from — so there is no source switch. -->
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

	<div class="chips" role="group" aria-label="Filter by readiness">
		<button class="chip" class:active={filter === 'all'} onclick={() => (filter = 'all')}>All</button>
		<button class="chip ok" class:active={filter === 'ready'} onclick={() => (filter = 'ready')}>
			<Icon name="mic" /> Ready{#if libraryCount}&nbsp;{libraryCount}{/if}
		</button>
		<button class="chip warn" class:active={filter === 'cooking'} onclick={() => (filter = 'cooking')}>
			<Icon name="sparkle" /> Cooking{#if cookingRows.length}&nbsp;{cookingRows.length}{/if}
		</button>
	</div>

	{#if showReady}
		{@const readyList = searchActive ? readyResults : library}
		<!--
		  Browse lives behind ONE disclosure. Previously the two facet rails rendered inline whenever the
		  library had enough variety, so the top of the screen could stack four independent ways to narrow
		  the same list — three readiness chips, an artist rail, a genre rail, and group headings that
		  re-announced the readiness axis in prose. Worse, the rails appeared and vanished as you typed,
		  so the control row changed shape while you were using it. One collapsed row keeps the readiness
		  spine primary and the control set stable.
		-->
		{#if !searchActive && (facets.artists.length > 1 || facets.tags.length > 1)}
			<div class="browse">
				<button class="browse-toggle" aria-expanded={browseOpen} onclick={() => (browseOpen = !browseOpen)}>
					<Icon name={browseOpen ? 'chevron-down' : 'chevron-right'} />
					Browse
					{#if browseFilter}<span class="browse-active">{browseFilter.artist ?? browseFilter.tag}</span>{/if}
				</button>
				<!-- Clearing stays reachable while collapsed: a filter you cannot see is a filter you
				     cannot undo, and an empty-looking list with no visible cause is the result. -->
				{#if browseFilter}
					<button class="chip chip-icon" onclick={() => setBrowse(null, '')}><Icon name="close" /> Clear</button>
				{/if}
			</div>
			{#if browseOpen}
				{#if facets.artists.length > 1}
					<div class="facets" role="group" aria-label="Browse by artist">
						<span class="facet-label">Artist</span>
						{#each facets.artists as f (f.artist)}
							<button
								class="chip"
								class:active={browseFilter?.artist === f.artist}
								onclick={() => setBrowse('artist', f.artist)}
							>
								{f.artist}&nbsp;<span class="facet-count">{f.count}</span>
							</button>
						{/each}
					</div>
				{/if}
				<!-- Browse by descriptive tag (#690): the same rail idiom as the artist rail, reading
				     facets.tags (a tagFacets() count over the WHOLE ready library) and narrowing via
				     ?tag= on the server. Capitalised for display; the value sent is the stored lower-case
				     tag, so the round-trip matches what byTag indexes on. -->
				{#if facets.tags.length > 1}
					<div class="facets" role="group" aria-label="Browse by tag">
						<span class="facet-label">Tag</span>
						{#each facets.tags as f (f.tag)}
							<button
								class="chip tag"
								class:active={browseFilter?.tag === f.tag}
								onclick={() => setBrowse('tag', f.tag)}
							>
								{f.tag}&nbsp;<span class="facet-count">{f.count}</span>
							</button>
						{/each}
					</div>
				{/if}
			{/if}
		{/if}
		{#if readyList.length}
			{@const facetHead = browseFilter && !searchActive}
			{#if showGroupHeads || facetHead}
				<h2 class="grouphead ok">
					{facetHead
						? `${browseFilter?.artist ?? browseFilter?.tag} · ${readyList.length} ${readyList.length === 1 ? 'song' : 'songs'}`
						: 'Ready to sing · no wait'}
				</h2>
			{/if}
			{#each readyList as m (m.id)}
				<SongRow {...rowMeta(m)} readiness="ready" inQueue={inMyQueue(m.id)} onadd={() => addSong(m.id)} />
			{/each}
		{/if}
	{/if}

	{#if showCooking && cookingRows.length}
		<!-- Queue it anyway: rotation HOLDS a cooking song's slot, so it keeps its fair
		     position and plays when the stems land. Cooking is not a blocked state. -->
		{#if showGroupHeads}
			<!-- "Queue it anyway" is true of a cooking song — rotation HOLDS its slot, so it keeps its fair
			     position and plays when the stems land. It is NOT true of a failed one, so the head stops
			     saying it as soon as the group contains a dead cook rather than inviting a guest to queue
			     a song that will never play. -->
			<h2 class="grouphead warn">
				{cookingRows.some((c) => liveOf(c.id)?.status === 'failed')
					? 'Cooking · one didn’t work — tap Sing to try again'
					: 'Cooking · queue it anyway'}
			</h2>
		{/if}
		{#each cookingRows as c (c.id)}
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

	{#if showRaw}
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
			{@const rawRows = unaccounted(rawResults)}
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
			{#if !searching && rawResults.length === 0 && readyResults.length === 0}
				<p class="empty">No results. YouTube search needs yt-dlp installed on the server.</p>
			{/if}
		{:else}
			{@const popularRows = unaccounted(popular)}
			{@const recentRows = unaccounted(recent)}
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
			{#if !popularRows.length && !recentRows.length && !library.length}
				<p class="empty">Search for a song above, or be the first to queue one.</p>
			{/if}
		{/if}
	{/if}

	{#if filter !== 'all' && ((filter === 'ready' && !(searchActive ? readyResults : library).length) || (filter === 'cooking' && !cookingRows.length))}
		{#if filter === 'ready'}
			{@const empty = readyEmptyState({ searchActive, libraryCount: library.length, query })}
			<p class="empty">{empty.message}</p>
			{#if empty.showAllCount !== null}
				<!-- the way back: the library is one tap away, not gone -->
				<div class="showall-row">
					<button class="chip ok chip-icon" onclick={clearSearch}
						><Icon name="mic" /> Show all {empty.showAllCount}</button
					>
				</div>
			{/if}
		{:else}
			<p class="empty">Nothing cooking right now.</p>
		{/if}
	{/if}
</main>

<!-- The rotation lives in a pull-up sheet: at a party you are either browsing or checking the queue,
     so the two should not fight over one scroll. The peek carries "when am I up?" — the question
     that used to sit in a card above the search box and scroll out of sight.

     The "queue a song" prompt is conditional on the queue ACTUALLY being empty. It used to be the
     else-branch of a plain `nowEntry` ternary, so a room with a song queued-but-still-cooking was
     told to go and queue a song — an instruction to do the thing the singer had just done, printed
     directly above their own song. The queued case adds no line on purpose: the title already says
     "Nothing playing", the position line says when you are up, and the peek's hint renders
     "N waiting", so a fourth line would only repeat one of them. -->
<QueueSheet
	open={sheetOpen}
	title={nowEntry ? mediaTitle(nowEntry.mediaId) : 'Nothing playing'}
	sub={nowEntry
		? `${singerOf(nowEntry.singerId)?.displayName ?? 'Someone'} is singing`
		: queued.length === 0
			? 'Queue a song to start the party'
			: undefined}
	position={myPositionLabel}
	queueCount={queued.length}
	elapsedSec={displayPos}
	durationSec={nowDurationSec}
	ontoggle={(v) => (sheetOpen = v)}
>
	{#snippet controls()}
		<!--
			The transport is disabled when there is nothing for it to act on. It used to be
			unconditionally enabled, so an empty room showed a full-weight primary play button plus
			restart and skip, all three dispatching commands the server could only ignore -- the same
			shape of defect as the old cook/queue button pair, where primary weight sat on an action
			that led nowhere. Restart and skip need a song that is PLAYING; play additionally accepts a
			queue that has something in it, because "start when it is ready" is a real intent and the
			server, not the phone, decides when that is.
		-->
		<button class="ic no-drag" aria-label="restart" disabled={!nowEntry} onclick={() => sendPlayer({ cmd: 'restart' })}
			><Icon name="prev" /></button
		>
		<button
			class="ic play no-drag"
			aria-label="play/pause"
			disabled={!nowEntry && queued.length === 0}
			onclick={() => sendPlayer({ cmd: playback.isPlaying ? 'pause' : 'play' })}
		>
			<Icon name={playback.isPlaying ? 'pause' : 'play'} />
		</button>
		<button class="ic no-drag" aria-label="skip" disabled={!nowEntry} onclick={() => sendPlayer({ cmd: 'skip' })}
			><Icon name="next" /></button
		>
	{/snippet}

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

	<h2 class="grouphead">Up next · {orderLabel}</h2>
	{#if queued.length === 0}
		<p class="empty">Queue's empty — add a song to start the party.</p>
	{:else}
		{#each queued as e, i (e.id)}
			{@const s = singerOf(e.singerId)}
			{@const card = queueCardKind(mediaCatalog.get(e.mediaId), mediaStatus.get(e.mediaId))}
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
					pending={unconfirmed.has(e.id)}
					onremove={e.singerId === me?.id ? () => removeWithUndo(e) : undefined}
					reorderable={canHostReorder ? queued.length > 1 : canReorder && e.singerId === me?.id && myPicks.length > 1}
					canUp={canHostReorder ? globalIdx(e.id) > 0 : myIdx(e.id) > 0}
					canDown={canHostReorder
						? globalIdx(e.id) >= 0 && globalIdx(e.id) < queued.length - 1
						: myIdx(e.id) >= 0 && myIdx(e.id) < myPicks.length - 1}
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
					pending={unconfirmed.has(e.id)}
					subtitle={e.id === nextPlayableId ? 'up next' : ''}
					removable={e.singerId === me?.id}
					reorderable={canHostReorder ? queued.length > 1 : canReorder && e.singerId === me?.id && myPicks.length > 1}
					canUp={canHostReorder ? globalIdx(e.id) > 0 : myIdx(e.id) > 0}
					canDown={canHostReorder
						? globalIdx(e.id) >= 0 && globalIdx(e.id) < queued.length - 1
						: myIdx(e.id) >= 0 && myIdx(e.id) < myPicks.length - 1}
					onremove={() => removeWithUndo(e)}
					onup={() => (canHostReorder ? moveGlobal(e.id, -1) : moveMine(e.id, -1))}
					ondown={() => (canHostReorder ? moveGlobal(e.id, 1) : moveMine(e.id, 1))}
				/>
			{/if}
		{/each}
	{/if}
</QueueSheet>

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
<div class="sr-live" role="status" aria-live="polite" aria-atomic="true">{liveMsg}</div>

<style>
	/* the sheet's peek is docked, so the page must be able to scroll clear of it */
	main {
		flex: 1;
		padding: 6px 18px calc(var(--peek-h) + 28px);
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
	 * The wordmark. The mic was 🎤 — a different drawing on every platform, and a tofu box on a browser
	 * with no emoji font, which is not something a brand mark can be. The gradient stays on the TEXT
	 * (background-clip), where it is the glyph fill against the page and carries no label of its own.
	 */
	.brand {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		font-weight: 800;
		font-size: 1.25rem;
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
	/* 44px, matching every other control in the app. The emoji gear this replaced was ~18px. */
	.gear {
		display: grid;
		place-items: center;
		min-width: 44px;
		min-height: 44px;
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
	 * columns — the search box, chips, facet rails and group headings each label everything below
	 * them, so a heading confined to one column would read as applying to half the list. The rule is
	 * inverted deliberately: everything spans by default and rows opt in, so a new block added here
	 * spans (always safe) rather than silently landing in a column beside a song.
	 */
	@media (min-width: 768px) {
		main {
			display: grid;
			/* 440px is measured off the row's own contents, not picked for looks: a row spends roughly 220px
			   on the thumbnail, readiness badge, action button and gaps, so a narrower column truncates
			   every title to "Quee..." and two unreadable columns are worse than one readable one. */
			grid-template-columns: repeat(auto-fill, minmax(440px, 1fr));
			gap: 0 14px;
			align-content: start;
		}
		main > :global(*) {
			grid-column: 1 / -1;
		}
		main > :global(.row) {
			grid-column: auto;
		}
	}
	.searchbox {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px 14px;
		margin-bottom: 10px;
		min-height: 52px;
	}
	.searchbox input {
		border: 0;
		background: transparent;
		color: var(--ink);
		font-size: 1rem;
		width: 100%;
	}
	.chips {
		display: flex;
		gap: 7px;
		margin-bottom: 14px;
	}
	/* One collapsed row where two facet rails used to render inline and reshuffle as you typed. */
	.browse {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 8px;
	}
	.browse-toggle {
		min-height: 44px;
		display: inline-flex;
		align-items: center;
		gap: 7px;
		background: none;
		border: 0;
		padding: 0 2px;
		cursor: pointer;
		color: var(--ink-dim);
		font-size: 0.68rem;
		font-weight: 700;
		letter-spacing: 0.14em;
		text-transform: uppercase;
	}
	.browse-toggle:hover {
		color: var(--ink);
	}
	/* Names the active facet on the collapsed row, so a narrowed list always shows its cause. */
	.browse-active {
		color: var(--accent2);
		text-transform: none;
		letter-spacing: 0;
		font-size: 0.8rem;
	}
	/* browse facet rails: horizontally scrollable so a 20-artist library cannot push the
	   song list off the screen on a phone. */
	.facets {
		display: flex;
		align-items: center;
		gap: 7px;
		margin-bottom: 8px;
		overflow-x: auto;
		scrollbar-width: none;
		-webkit-overflow-scrolling: touch;
	}
	.facets::-webkit-scrollbar {
		display: none;
	}
	.facets .chip {
		flex: none;
	}
	.facet-label {
		flex: none;
		font-size: 0.68rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--ink-dim);
		padding-right: 2px;
	}
	.facet-count {
		opacity: 0.55;
		font-variant-numeric: tabular-nums;
	}
	.chip {
		/* 44px, matching the queue actions and the row buttons. These were ~30px: above the 24px WCAG
		   floor, but below the threshold this app had already set for itself everywhere else — and the
		   readiness chips are the most-tapped controls on the screen. */
		min-height: 44px;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 7px 14px;
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
	.chip.warn {
		color: var(--warn);
	}
	.chip.active {
		background: var(--accent-strong);
		border-color: transparent;
		color: var(--on-accent);
	}
	/* any label that leads with a mark rather than a word */
	.chip-icon {
		display: inline-flex;
		align-items: center;
		gap: 6px;
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
		font-size: 0.68rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--ink-dim);
		font-weight: 700;
		margin: 16px 4px 8px;
	}
	.grouphead:first-of-type {
		margin-top: 4px;
	}
	.grouphead.ok {
		color: var(--ok);
	}
	.grouphead.warn {
		color: var(--warn);
	}
	.empty {
		color: var(--ink-dim);
		padding: 0 4px;
		font-size: 0.9rem;
	}

	/* playback controls, rendered into the sheet's peek */
	.ic {
		width: 44px;
		height: 44px;
		border-radius: 50%;
		display: grid;
		place-items: center;
		border: 1px solid var(--line);
		background: var(--card);
		color: var(--ink);
		font-size: 1rem;
		cursor: pointer;
	}
	/* The one filled transport control. Solid accent + paired ink, because in stage 1 the glyph became
	   an SVG drawn with currentColor — on --grad that mark sat at 2.84:1, under the 3:1 non-text floor. */
	.ic.play {
		background: var(--accent-strong);
		color: var(--on-accent);
		border-color: transparent;
		width: 44px;
		height: 44px;
	}
	.ic:active {
		transform: scale(0.92);
	}
	/* Reads as unavailable rather than merely dim: a 44px target that still looks pressable but does
	   nothing is worse than one that plainly cannot be pressed. The cursor changes too, since this
	   surface is also opened on a laptop. */
	.ic:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.ic:disabled:active {
		transform: none;
	}

	.key {
		display: flex;
		gap: 6px;
		margin: 6px 0 2px;
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
		padding: 6px;
		font-size: 0.8rem;
		cursor: pointer;
		min-height: 44px;
	}
	/* Centre the mark with its word. The glyphs these replaced were U+2212 and U+FF0B — the fullwidth
	   plus carries CJK metrics, so it sat off-baseline beside Latin text at every size. */
	.key-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
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
		gap: 8px;
		margin: 8px 0 0;
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
		font-size: 0.8rem;
	}
	.key-sound {
		font-size: 0.85rem;
		font-weight: 700;
		color: var(--warn);
	}

	/*
	 * The vocal-range disclosure. Mirrors the .browse toggle: a 44px min-height button, an uppercase
	 * label, a chevron that swaps down/right with the open state, and a peek of the range value on the
	 * collapsed row so the section states its headline fact without being opened.
	 */
	.range {
		margin: 8px 0 2px;
	}
	.range-toggle {
		width: 100%;
		min-height: 44px;
		display: inline-flex;
		align-items: center;
		gap: 7px;
		background: none;
		border: 0;
		padding: 0 2px;
		cursor: pointer;
		color: var(--ink-dim);
		font-size: 0.68rem;
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
		font-size: 0.8rem;
		font-variant-numeric: tabular-nums;
	}
	.range-body {
		padding: 2px 2px 4px;
	}
	.range-facts {
		display: flex;
		align-items: baseline;
		gap: 10px;
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
		margin: 4px 0 0;
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
		gap: 12px;
		padding: 12px 14px;
		margin-bottom: 8px;
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
		gap: 8px;
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
	 * Docked-toast stacking, measured UP from the queue sheet's peek. --peek-h is bound to the peek's
	 * clientHeight, and the peek's own padding already includes env(safe-area-inset-bottom), so the
	 * inset arrives THROUGH --peek-h — do NOT add another env() term here or the gap doubles.
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
		--undo-dock: calc(var(--peek-h) + 14px);
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
		gap: 14px;
		z-index: 30;
		background: var(--card2);
		border: 1px solid var(--line);
		border-radius: 14px;
		padding: 12px 16px;
		box-shadow: var(--shadow);
		font-size: 0.9rem;
		max-width: 90vw;
	}
	.undo-toast button {
		/* The only interactive control on the phone that fell under the app's own 44px floor — and the
		   one on a 5-second timer, so the hardest to hit in time. Raised to 44px via min-height (the
		   row is align-items:center, so it grows to fit and nothing else shifts); the padding-only box
		   it had (6px 12px) slipped past the generic touch-target guard, which only flags an explicit
		   height. touch-targets.test.ts now covers padding-only controls too. */
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 44px;
		border: 0;
		background: var(--accent-strong);
		color: var(--on-accent);
		font-weight: 700;
		border-radius: 8px;
		padding: 6px 14px;
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
		z-index: 30;
		background: var(--danger-bg);
		color: var(--danger-ink);
		border: 1px solid var(--danger-line);
		padding: 11px 16px;
		border-radius: var(--radius-sm);
		font-size: 0.88rem;
		max-width: 90vw;
	}

	/* Matches the gear beside it: a real 44px target, not text that happens to be tappable. An anchor
	   now (it navigates to /settings?tab=you), so the underline a link would default to is dropped —
	   the tappable affordance here is the 44px box and the colour dot, as it was as a button. */
	.me-btn {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		min-height: 44px;
		padding: 0 6px;
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
		gap: 6px;
		color: var(--warn);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-pill);
		padding: 4px 10px;
		font-size: 0.78rem;
		white-space: nowrap;
	}

	/* Base header padding, declared here (not inline) so the short-viewport rule below can shrink it —
	   an inline style would outrank the media query and silently defeat it. The flex layout lives here
	   too, off the inline style, so the header joins the token layer instead of pinning raw px. */
	.topbar {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 16px 18px 8px;
	}
	/* The name + gear cluster, pushed to the trailing edge. Static styling classed (not inline) so it
	   inherits the responsive layer rather than freezing raw px. */
	.me-cluster {
		margin-left: auto;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.85rem;
		color: var(--ink-dim);
	}
	/* Centres the "Show all" way-back button under an empty Ready filter. Classed, not inline, so the
	   one-off row is not stranded outside the responsive rules with hard px. */
	.showall-row {
		display: flex;
		justify-content: center;
		padding: 0 0 8px;
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
	 * Landscape / short viewports (e.g. a phone held sideways at 844×390). The docked now-playing peek
	 * plus header, search box, chip row and section labels otherwise consume almost the whole height,
	 * leaving no room for result rows. Shrink the peek token and the top chrome so at least a couple of
	 * rows stay visible. --peek-h is the fallback the sheet overwrites with its measured peek height on
	 * mount, but on a short screen a smaller fallback still buys rows before that measurement lands.
	 */
	@media (max-height: 480px) {
		:root {
			--peek-h: 84px;
		}
		.topbar {
			padding: 6px 18px 4px;
		}
		main {
			padding-top: 2px;
		}
		.searchbox {
			min-height: 42px;
			padding: 8px 14px;
			margin-bottom: 6px;
		}
		.chips {
			margin-bottom: 8px;
		}
		.browse,
		.facets {
			margin-bottom: 4px;
		}
		.grouphead {
			margin: 8px 4px 4px;
		}
	}
</style>
