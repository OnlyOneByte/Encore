/*
 * THE ROOM LINK — one socket, one room truth, for the whole app.
 *
 * WHY THIS EXISTS. Everything in here used to live in `routes/+page.svelte`'s `onMount`: the
 * `/api/me` probe, the `QueueStore`, the `WsClient`, and every field the room broadcasts into. That
 * placement made the ROUTE the owner of app-wide truth, which had one consequence that finally
 * forced this move: a component mounted in `+layout.svelte` — the persistent now-playing band — could
 * not read the playback state, because the only thing that knew it was a sibling route component.
 * The socket is not a property of a route. One phone joins one room once, and the connection must
 * outlive any navigation between the queue, the find surface and a song page.
 *
 * THE IDIOM IS THE REPO'S OWN, deliberately. This is a plain class with an explicit `subscribe`,
 * exactly like `QueueStore` beside it — NOT a rune-backed `.svelte.ts` store. Three reasons, in
 * order of weight:
 *   1. A module-level `$state` singleton is shared across SSR requests on the server, which is a
 *      cross-request state leak waiting to happen. Plain fields that only ever move in the browser
 *      cannot leak that way.
 *   2. `QueueStore` already established subscribe-and-mirror here, and it is tested that way.
 *      A second, different store idiom in the same directory is a thing every future reader has to
 *      learn twice.
 *   3. Components mirror only the fields they render, so the band does not re-render on a library
 *      merge it does not read.
 *
 * WHAT IT DOES NOT DO: no toasts, no navigation, no DOM. A failure that a human must see is handed
 * to whoever registered `onError`, because the surface that should say so is a UI decision and this
 * file has no business making it. The scar persistence IS here, though — that is state that must
 * survive a reload, not a way of telling someone something.
 */

import {
	DEFAULT_EFFECTIVE_SETTINGS,
	singHistoryFrom,
	type ServerEvent,
	type ClientCommand,
	type EffectiveSettings,
	type Media,
	type MediaStatus,
	type PlaybackState,
	type PlayerCommand,
	type PublicSinger,
	type QueueEntry
} from '$lib/contract';
import { QueueStore } from '$lib/stores/queue';
import { activeScars, clearScar, recordScar } from '$lib/stores/process-scars';
import { WsClient } from '$lib/ws/client';

/** Live process progress for one song, as the room broadcasts it. */
export interface LiveMediaStatus {
	status: MediaStatus;
	pct: number;
	etaSec?: number;
}

export class RoomLink {
	// ── the room's truth ────────────────────────────────────────────────
	/** The joined singer, or null for a guest who has not joined (no socket is opened for them). */
	me: PublicSinger | null = null;
	connected = false;
	playback: PlaybackState = {
		currentEntryId: null,
		positionSec: 0,
		isPlaying: false,
		keyShift: 0,
		background: null,
		guideLevel: null
	};
	singers = new Map<string, PublicSinger>();
	mediaCatalog = new Map<string, Media>();
	settings: EffectiveSettings = DEFAULT_EFFECTIVE_SETTINGS;
	/**
	 * Singers who are in the room but unreachable. An absent singer's queued song looks exactly like
	 * anyone else's without this, and the phone is the surface holding the skip control — so it is the
	 * one surface that must be able to tell there is a decision to make.
	 */
	awaySingers = new Set<string>();
	/** Live process progress per mediaId, from `media:status` and seeded from /api/library. */
	mediaStatus = new Map<string, LiveMediaStatus>();
	/** The room's standing guiding-track default — needed to LABEL a null (inherit) per-song override. */
	roomGuideDefault = 0;
	/**
	 * THE SAVED LIBRARY. Owned here rather than by the surface that lists it, because the fetch does
	 * two jobs for two different readers: it gives /find the rows to render, AND it seeds the media
	 * catalog and the live process statuses that HOME reads for its queue titles and its progress bars
	 * on a cold load. Those used to share one function body in the route, which meant the queue's
	 * titles depended on the search surface having run — invisible while they were the same file, a
	 * silent breakage the moment they were not.
	 */
	library: Media[] = [];
	libraryTags: Record<string, string[]> = {};
	/** The optimistic queue. Undefined until a joined singer connects. */
	queue: QueueStore | undefined;
	entries: QueueEntry[] = [];
	/** What each row is still waiting on, republished on every store emit. */
	pendingKind = new Map<string, 'add' | 'move'>();

	#ws: WsClient | undefined;
	#subs = new Set<() => void>();
	#errorHandlers = new Set<(message: string) => void>();
	/**
	 * Failed-process scars captured once on connect. HELD, because a `queue:sync` REPLACES the
	 * catalog and a failed song is not in the room's media (it settled to un-processed server-side) —
	 * so without re-merging these on every sync, the room's first sync wipes the scarred media and the
	 * row vanishes again on the very reload the scar exists to survive.
	 */
	#scarred: Media[] = [];
	#state: 'idle' | 'connecting' | 'live' | 'guest' | 'closed' = 'idle';

	/** Notified after every change to the fields above. Returns a disposer. */
	subscribe(fn: () => void): () => void {
		this.#subs.add(fn);
		return () => this.#subs.delete(fn);
	}
	/** A failure a human should see. Returns a disposer. No handler = the message is dropped. */
	onError(fn: (message: string) => void): () => void {
		this.#errorHandlers.add(fn);
		return () => this.#errorHandlers.delete(fn);
	}

	#emit(): void {
		for (const fn of this.#subs) fn();
	}
	#fail(message: string): void {
		for (const fn of this.#errorHandlers) fn(message);
	}

	/** A song's display title, for a message about it. The catalog is right here, so nothing else needs to pass it. */
	titleOf(mediaId: string): string {
		const m = this.mediaCatalog.get(mediaId);
		return m ? `${m.title}${m.artist ? ' — ' + m.artist : ''}` : mediaId;
	}

	/**
	 * Join the room's socket. IDEMPOTENT and browser-only: the layout calls it on mount, and calling
	 * it again (a second mount, a navigation) is a no-op rather than a second socket. A guest who has
	 * not joined settles at `guest` with no socket at all — and stays there, because joining navigates.
	 */
	async connect(): Promise<void> {
		if (typeof window === 'undefined') return; // SSR: this singleton must stay inert on the server
		if (this.#state !== 'idle') return;
		this.#state = 'connecting';

		const res = await fetch('/api/me');
		if (!res.ok) {
			// Unjoined. `/` is the landing page, so the route renders its JoinLanding state — no store
			// and no socket for a guest.
			this.#state = 'guest';
			this.#emit();
			return;
		}
		this.me = (await res.json()).singer;
		if (this.#state !== 'connecting' || !this.me) return;

		this.queue = new QueueStore({
			singerId: this.me.id,
			sendCommand: (cmd: ClientCommand) => this.#ws?.send({ type: 'queue:command', command: cmd }),
			onReject: (reason) => this.#fail(`Couldn't do that: ${reason}`),
			// Read at apply time, not captured: both the algorithm and the sing history change while the
			// party runs, and predicting with a stale ordering is what makes a row jump.
			ordering: () => ({
				order: this.settings.room.queueOrder,
				lastSungAt: singHistoryFrom(this.singers.values())
			})
		});
		this.queue.subscribe((entries) => {
			this.entries = entries;
			this.pendingKind = this.queue!.pendingKindById;
			this.#emit();
		});

		this.#ws = new WsClient({
			url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?role=phone`,
			getLastRev: () => this.queue?.rev ?? 0,
			onConnectionChange: (c) => {
				this.connected = c;
				this.#emit();
			},
			onEvent: (e: ServerEvent) => this.#onServerEvent(e)
		});

		// Re-surface failed processes that a reload would otherwise have erased: the live mediaStatus
		// map is in-memory only, so a persisted scar is seeded back as a synthetic `failed` status. It
		// flows through the same readiness path a live failure takes, with no extra UI.
		this.#scarred = activeScars();
		if (this.#scarred.length) {
			// GET /api/library returns only ready + processing media, so a failed song is not in the
			// catalog — merge the scar's snapshot in so its row can render, then mark it failed.
			this.mergeMissingMedia(this.#scarred);
			const withScars = new Map(this.mediaStatus);
			for (const m of this.#scarred) if (!withScars.has(m.id)) withScars.set(m.id, { status: 'failed', pct: 0 });
			this.mediaStatus = withScars;
		}

		this.#state = 'live';
		this.#ws.open();
		void this.refreshLibrary();
		this.#emit();
	}

	/** Drop the socket. The layout owns this, so it runs when the app unmounts — not on navigation. */
	close(): void {
		this.#state = 'closed';
		this.#ws?.close();
		this.#ws = undefined;
	}

	/**
	 * Re-pick a song's lyrics: choose a stored candidate by ref, or paste new words. The server pins the
	 * choice and re-times it, and the live `media:status` broadcasts drive the row.
	 *
	 * IT LIVES ON THE LINK because the control that calls it is app chrome now — the drawer, mounted by
	 * the layout — and the layout should not be making fetches. A human edit must produce a NEW `manual`
	 * candidate rather than mutate one, which is the server's rule; this only reports the choice.
	 */
	async reselectLyrics(mediaId: string, choice: { ref?: string; text?: string }): Promise<void> {
		try {
			const res = await fetch('/api/lyrics-reselect', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ mediaId, ...choice })
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) this.#fail(body.error ?? 'Could not re-time the lyrics');
		} catch {
			this.#fail('Could not re-time the lyrics — check your connection');
		}
	}

	/** Send a player command (play/pause/skip/key/guide/seek). No-op before the socket is up. */
	command(command: PlayerCommand): void {
		this.#ws?.send({ type: 'player:command', command });
	}

	#onServerEvent(e: ServerEvent): void {
		if (e.type === 'queue:sync') {
			if (e.settings) {
				this.settings = e.settings;
				// The room's guiding-track default — needed to LABEL the control, since a null per-song
				// override means "inherit" and the phone would otherwise show 0%.
				this.roomGuideDefault = e.settings.room.guideLevelDefault;
			}
			if (e.singers) this.singers = new Map(e.singers.map((s) => [s.id, s]));
			if (e.media) this.mediaCatalog = new Map(e.media.map((m) => [m.id, m]));
			// Re-apply failed-process scars: a sync REPLACES the catalog, so without this the scarred row
			// is wiped by the very first sync. A real entry for the id (already added above) wins.
			if (this.#scarred.length) this.mergeMissingMedia(this.#scarred);
			// An omitted list means "no info", not "nobody is away" — do not blank what we have.
			if (e.away) this.awaySingers = new Set(e.away);
			queueMicrotask(() => this.queue?.resendPending());
		}
		if (e.type === 'singer:presence') this.awaySingers = new Set(e.away);
		if (e.type === 'queue:patch' && e.patch.media) this.mergeMedia(e.patch.media);
		if (e.type === 'settings:changed') {
			this.settings = e.settings;
			// A room default changed mid-party: adopt it so the guiding-track control keeps reporting the
			// level the TV is actually mixing at.
			this.roomGuideDefault = e.settings.room.guideLevelDefault;
		}
		if (e.type === 'singer:joined') this.singers = new Map(this.singers).set(e.singer.id, e.singer);
		// A rename must land on every OTHER phone too, or their queue rows keep naming someone who no
		// longer goes by that.
		if (e.type === 'singer:updated') this.singers = new Map(this.singers).set(e.singer.id, e.singer);
		// Someone left on purpose. Their entries arrive as ordinary remove patches; this is what takes
		// them out of the away set, which no patch would have implied.
		if (e.type === 'singer:left') {
			const nextAway = new Set(this.awaySingers);
			nextAway.delete(e.singerId);
			this.awaySingers = nextAway;
			// Also drop them from the singers map. A singer who leaves with no queued songs produces no
			// queue:patch, so without this their name keeps rendering on every other phone until the next
			// full sync. joined/updated rebuild this map; left must too.
			const nextSingers = new Map(this.singers);
			nextSingers.delete(e.singerId);
			this.singers = nextSingers;
		}
		if (e.type === 'playback:state') this.playback = e.state;
		if (e.type === 'media:status') this.#onMediaStatus(e.mediaId, e.status, e.pct, e.etaSec);
		this.queue?.onServerEvent(e);
		this.#emit();
	}

	#onMediaStatus(mediaId: string, status: MediaStatus, pct: number, etaSec?: number): void {
		const next = new Map(this.mediaStatus);
		next.set(mediaId, { status, pct, etaSec });
		this.mediaStatus = next;
		// Reflect the flip on the catalog copy so readiness agrees without a full sync. A `failed` or
		// `canceled` process settles back to un-processed server-side (settleStemsGate), so the
		// optimistic copy follows it — preserving the mid-flight status is what kept a row reading as
		// processing after the job had already died.
		const m = this.mediaCatalog.get(mediaId);
		if (m) {
			const nm = new Map(this.mediaCatalog);
			nm.set(mediaId, {
				...m,
				stemStatus: status === 'ready' ? 'ready' : status === 'failed' || status === 'canceled' ? 'none' : 'queued'
			});
			this.mediaCatalog = nm;
		}
		// A song that just finished processing belongs in the saved library now, and a successful
		// re-process clears any failed-process scar so the row never lingers as failed while it is ready.
		if (status === 'ready') {
			clearScar(mediaId);
			this.#scarred = this.#scarred.filter((s) => s.id !== mediaId);
			void this.refreshLibrary();
		}
		// Surface a died process instead of leaving the row silently stuck, and persist a per-device
		// scar so the failure survives a reload (the live map does not).
		if (status === 'failed') {
			const failedMedia = this.mediaCatalog.get(mediaId);
			if (failedMedia) {
				recordScar(failedMedia);
				if (!this.#scarred.some((s) => s.id === mediaId)) this.#scarred = [...this.#scarred, failedMedia];
			}
			this.#fail(`Couldn't make karaoke for “${this.titleOf(mediaId)}” — try again.`);
		}
	}

	/**
	 * Merge media into the client catalog. The catalog is otherwise fed ONLY by queue:sync/patch, so a
	 * song that came from search or the library — and is not (yet) in anyone's queue — has no
	 * resolvable title: a processing card would render a raw ULID.
	 */
	mergeMedia(list: Media[]): void {
		if (!list.length) return;
		const next = new Map(this.mediaCatalog);
		for (const m of list) next.set(m.id, m);
		this.mediaCatalog = next;
		this.#emit();
	}
	/**
	 * Merge media but only for ids the catalog does NOT already hold — used to re-apply failed-process
	 * scars after a queue:sync without clobbering a fresher server copy of the same song.
	 */
	mergeMissingMedia(list: Media[]): void {
		if (!list.length) return;
		const next = new Map(this.mediaCatalog);
		let changed = false;
		for (const m of list)
			if (!next.has(m.id)) {
				next.set(m.id, m);
				changed = true;
			}
		if (changed) {
			this.mediaCatalog = next;
			this.#emit();
		}
	}

	/** Optimistically mark a song as processing, before the request lands. */
	setMediaStatus(mediaId: string, live: LiveMediaStatus): void {
		this.mediaStatus = new Map(this.mediaStatus).set(mediaId, live);
		this.#emit();
	}
	/** Roll an optimistic process mark back — the request never started. */
	clearMediaStatus(mediaId: string): void {
		this.mediaStatus = new Map([...this.mediaStatus].filter(([id]) => id !== mediaId));
		this.#emit();
	}
	/**
	 * Re-read the saved library. Called on connect and whenever a process goes ready, so no surface has
	 * to remember to ask — which is what the removed `onLibraryChanged` hook existed to arrange, one
	 * commit ago. Failure is deliberately silent: the library is an accelerator, never a blocker.
	 */
	async refreshLibrary(): Promise<void> {
		try {
			const j = await (await fetch('/api/library')).json();
			this.library = j.library ?? [];
			this.libraryTags = j.tags ?? {};
			this.mergeMedia(this.library);
			const processing: { media: Media; status: MediaStatus; pct: number; etaSec?: number }[] = j.processing ?? [];
			if (processing.length) {
				this.mergeMedia(processing.map((c) => c.media));
				this.seedMediaStatus(processing);
			}
			this.#emit();
		} catch {
			/* ignore — the library is an accelerator, never a blocker */
		}
	}

	/** Seed statuses from a /api/library snapshot. A live broadcast is fresher, so never overwrite one. */
	seedMediaStatus(list: { media: Media; status: MediaStatus; pct: number; etaSec?: number }[]): void {
		if (!list.length) return;
		const next = new Map(this.mediaStatus);
		for (const c of list)
			if (!next.has(c.media.id)) next.set(c.media.id, { status: c.status, pct: c.pct, etaSec: c.etaSec });
		this.mediaStatus = next;
		this.#emit();
	}
}

/**
 * THE app's link to its room. A singleton because there is one phone, one room and one socket; the
 * class is exported beside it so a test can build an isolated one.
 */
export const room = new RoomLink();
