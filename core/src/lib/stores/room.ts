/*
 * THE ROOM LINK — one socket, one room truth, for the whole app. It must outlive every navigation, which is why a
 * component mounted by the LAYOUT can read the playback state at all. NO TOASTS, NO NAVIGATION, NO DOM: a failure a
 * human must see goes to whoever registered `onError`, because which surface says so is a UI decision. The scar
 * PERSISTENCE is here, though — that is state which must survive a reload.
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
	/** THE SERVER SAYING NOBODY CAN RUN THIS JOB: no connected worker advertises the capability it needs. It is on
	 * the wire already (`media:status` in contract/core/events.ts), `#sweepUnservable` in jobs/worker-hub.ts sets it
	 * only when the stall actually blocks singing (`if (media?.instrumentalRef) continue`), and the TV's
	 * `processIsTerminal` has read it all along — the PHONE was the surface throwing it away, so it drew
	 * "Making karaoke… 0%" with a live bar for the whole 120s TTL on a job the room had already given up on.
	 * Carrying it is plumbing, not protocol: `queueCardKind` turns it into a stalled card. */
	unservable?: boolean;
}

export class RoomLink {
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
	/** Singers in the room but unreachable. The phone holds the skip control, so it is the one surface that must be
	 * able to tell there is a decision to make. */
	awaySingers = new Set<string>();
	/** Live process progress per mediaId, from `media:status` and seeded from /api/library. */
	mediaStatus = new Map<string, LiveMediaStatus>();
	/** The room's standing guiding-track default — needed to LABEL a null (inherit) per-song override. */
	roomGuideDefault = 0;
	/** Owned here rather than by the surface that lists it, because the fetch does two jobs: it supplies the browse
	 * rows AND seeds the catalog and live statuses the queue needs for its titles and progress bars on a cold load. */
	library: Media[] = [];
	libraryTags: Record<string, string[]> = {};
	/** Whether the fetch has RETURNED, success or failure — not whether it found anything. /library needs the two apart:
	 * an empty `library` before the first response is a loading skeleton, and after it is "you own no karaoke tracks",
	 * and showing the second while the first is true accuses a full library of being empty for one frame. */
	libraryLoaded = false;
	/** Whether the last attempt DIED — a transport failure or a non-2xx status — against `libraryLoaded`'s "it
	 * RETURNED". The two are not the same question and /library needs both: loaded-and-empty is "you own no karaoke
	 * tracks", loaded-and-failed is "we could not ask", and rendering the first for the second accuses a full library
	 * of being empty with no way back short of a reload (nothing re-fetches on a client-side tab arrival). Named for
	 * `/`'s `searchFailed`, the same defect in the same shape one route over. */
	libraryFailed = false;
	/** The optimistic queue. Undefined until a joined singer connects. */
	queue: QueueStore | undefined;
	entries: QueueEntry[] = [];
	/** What each row is still waiting on, republished on every store emit. */
	pendingKind = new Map<string, 'add' | 'move'>();

	#ws: WsClient | undefined;
	#subs = new Set<() => void>();
	#errorHandlers = new Set<(message: string) => void>();
	/** Captured once on connect and HELD: a sync REPLACES the catalog and a failed song is not in the room's media,
	 * so without re-merging these on every sync the first sync wipes the scarred row. */
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

	/** IDEMPOTENT and browser-only: the layout calls it on mount, and calling it again (a second mount, a navigation)
	 * is a no-op rather than a second socket. A guest who has not joined settles at `guest` with no socket at all. */
	async connect(): Promise<void> {
		if (typeof window === 'undefined') return; // SSR: this singleton must stay inert on the server
		if (this.#state !== 'idle') return;
		this.#state = 'connecting';

		const res = await fetch('/api/me');
		if (!res.ok) {
			// Unjoined: `/` is the landing page, so the route renders its JoinLanding state — no store and no socket.
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
			// Read at apply time, not captured: both the algorithm and the sing history change while the party runs, and
			// predicting with a stale ordering is what makes a row jump.
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

		// The live status map is in-memory only, so a reload erases a failed process. A persisted scar is seeded back as a
		// synthetic `failed` status and flows through the same readiness path a live failure takes, with no extra UI.
		this.#scarred = activeScars();
		if (this.#scarred.length) {
			// The library endpoint returns only ready and processing media, so a failed song is not in the catalog.
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

	/** Re-pick a song's lyrics: choose a stored candidate by ref, or paste new words. It lives on the link because the
	 * control that calls it lives on /song/[mediaId], reached from the Queue tab's now-playing card (it was the
	 * drawer, mounted by the layout, until the sheet was deleted) — and the layout should not be making
	 * fetches. A human edit must produce a NEW candidate rather than mutate one; this only reports the choice.
	 * RESOLVES TRUE ONLY WHEN THE WRITE LANDED, because the caller has to tell a landed write from a refused one:
	 * a refusal's only trace is `#fail` on a channel this method cannot see, and the page has to re-read itself
	 * after a 200 and release its own pending flag after anything else. */
	async reselectLyrics(mediaId: string, choice: { ref?: string; text?: string }): Promise<boolean> {
		try {
			const res = await fetch('/api/lyrics-reselect', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ mediaId, ...choice })
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				this.#fail(body.error ?? 'Could not re-time the lyrics');
				return false;
			}
			return true;
		} catch {
			this.#fail('Could not re-time the lyrics — check your connection');
			return false;
		}
	}

	/** Send a player command (play/pause/skip/key/guide/seek). No-op before the socket is up. */
	/** Did the command actually reach the wire? `false` means the socket was absent or not open, so the server
	 *  never heard it — a PLAYER command is fire-and-forget and is NOT resent on resync the way a queue add is,
	 *  so a dropped one is simply lost. Callers that move something optimistically must check this, or they show
	 *  the guest a state the room does not have. `ws.send()` has always returned this; this method discarded it. */
	command(command: PlayerCommand): boolean {
		return this.#ws?.send({ type: 'player:command', command }) ?? false;
	}

	#onServerEvent(e: ServerEvent): void {
		if (e.type === 'queue:sync') {
			if (e.settings) {
				this.settings = e.settings;
				// A null per-song override means "inherit", so the control needs the room default to label itself.
				this.roomGuideDefault = e.settings.room.guideLevelDefault;
			}
			if (e.singers) this.singers = new Map(e.singers.map((s) => [s.id, s]));
			if (e.media) this.mediaCatalog = new Map(e.media.map((m) => [m.id, m]));
			// Re-apply failed-process scars: a sync REPLACES the catalog, so without this the first sync wipes the scarred row.
			if (this.#scarred.length) this.mergeMissingMedia(this.#scarred);
			// An omitted list means "no info", not "nobody is away" — do not blank what we have.
			if (e.away) this.awaySingers = new Set(e.away);
			queueMicrotask(() => this.queue?.resendPending());
		}
		if (e.type === 'singer:presence') this.awaySingers = new Set(e.away);
		if (e.type === 'queue:patch' && e.patch.media) this.mergeMedia(e.patch.media);
		if (e.type === 'settings:changed') {
			this.settings = e.settings;
			// A room default changed mid-party: adopt it so the control keeps reporting the level the TV is mixing at.
			this.roomGuideDefault = e.settings.room.guideLevelDefault;
		}
		if (e.type === 'singer:joined') this.singers = new Map(this.singers).set(e.singer.id, e.singer);
		// A rename must land on every OTHER phone too, or their queue rows keep naming someone who no longer goes by that.
		if (e.type === 'singer:updated') this.singers = new Map(this.singers).set(e.singer.id, e.singer);
		// Someone left on purpose. Their entries arrive as ordinary remove patches; this takes them out of the away set.
		if (e.type === 'singer:left') {
			const nextAway = new Set(this.awaySingers);
			nextAway.delete(e.singerId);
			this.awaySingers = nextAway;
			// A singer who leaves with no queued songs produces no queue:patch, so without this their name keeps rendering on
			// every other phone until the next full sync. joined/updated rebuild this map; left must too.
			const nextSingers = new Map(this.singers);
			nextSingers.delete(e.singerId);
			this.singers = nextSingers;
		}
		if (e.type === 'playback:state') this.playback = e.state;
		// The WHOLE event, not four unpacked fields: the failure arm needs `requestedBy` as well, and a fifth
		// positional argument on a five-line signature is how the next one gets dropped on the way in.
		if (e.type === 'media:status') this.#onMediaStatus(e);
		this.queue?.onServerEvent(e);
		this.#emit();
	}

	#onMediaStatus(e: Extract<ServerEvent, { type: 'media:status' }>): void {
		const { mediaId, status, pct, etaSec, unservable } = e;
		const next = new Map(this.mediaStatus);
		// `unservable` is carried verbatim, including the absent case: it is only ever SET by the unservable sweep,
		// and a later real progress report for the same job arrives without it, which must clear the stall.
		next.set(mediaId, { status, pct, etaSec, unservable });
		this.mediaStatus = next;
		// The catalog copy follows, so readiness agrees without a full sync: a failed or canceled process settles back to
		// un-processed server-side, and preserving the mid-flight status here leaves a row reading as processing.
		const m = this.mediaCatalog.get(mediaId);
		if (m) {
			const nextCatalog = new Map(this.mediaCatalog);
			nextCatalog.set(mediaId, {
				...m,
				stemStatus: status === 'ready' ? 'ready' : status === 'failed' || status === 'canceled' ? 'none' : 'queued'
			});
			this.mediaCatalog = nextCatalog;
		}
		// A successful re-process clears any failed-process scar, so the row never lingers as failed while it is ready.
		if (status === 'ready') {
			clearScar(mediaId);
			this.#scarred = this.#scarred.filter((s) => s.id !== mediaId);
			void this.refreshLibrary();
		}
		// Surface a died process instead of leaving the row stuck, and persist a per-device scar so it survives a reload.
		if (status === 'failed') {
			const failedMedia = this.mediaCatalog.get(mediaId);
			if (failedMedia) {
				/* THE SCAR STAYS ROOM-WIDE, deliberately, and it is NOT what made the reported defect. It renders on no
				   persistent surface — it only re-reads as failed-with-retry if THIS phone searches that exact song
				   again — its statement is room-TRUE (the process really did die in this room), and it expires in
				   PROCESS_SCAR_TTL_MS, 30 minutes. Scoping it to the requester as well is a taste call for the owner,
				   so it is reported rather than taken. */
				recordScar(failedMedia);
				if (!this.#scarred.some((s) => s.id === mediaId)) this.#scarred = [...this.#scarred, failedMedia];
			}
			/* THE NOTICE IS PERSONAL. `media:status` is a room-wide broadcast by design — worker-hub records why —
			   but this arm used to toast on EVERY connected phone, so one guest's dead job told seven other people
			   to "try again" for a song they had never heard of, and it spent the one channel a guest's OWN refusals
			   arrive on. The room is not left ignorant: every phone that RECEIVES this frame flips that entry's /queue
			   row to the failed card, and a phone that did not — one that was offline, or joined later, or simply
			   reloaded, since `mediaStatus` is in-memory only — reads the same turn off the catalog instead, where
			   `queueCardKind`'s unacquired arm draws the stalled card. Both say no karaoke is being made for that
			   turn and both carry the way out; neither depends on this toast. (What this comment used to claim — that
			   every phone's row "already reads 'Couldn't make karaoke'" — is false after any reload, i.e. false for
			   every phone that joins the party later, and it was the sentence carrying the argument.)
			   SERVER-SIDE ATTRIBUTION, not a client-side "did I tap this?" set: `me.id` comes from the session
			   cookie, so the notice still finds the requester after they reload mid-wait, which a local set would
			   not survive.
			   ABSENT `requestedBy` KEEPS TODAY'S BEHAVIOUR, which is the conservative direction — an internal or
			   admin-side process nobody asked for is news for whoever is looking.
			   THE ONE TRADE, recorded because it is real: `enqueue` dedupes, and a reused job keeps its ORIGINAL
			   requester, so a second singer who taps the same song gets no toast. Their search row still reads
			   failed-with-retry, and their /queue row still draws a non-plain card by the paragraph above. */
			if (!e.requestedBy || e.requestedBy === this.me?.id) {
				this.#fail(`Couldn't make karaoke for “${this.titleOf(mediaId)}” — try again.`);
			}
		}
	}

	/** The catalog is otherwise fed ONLY by queue:sync/patch, so a song that came from search or the library has no
	 * resolvable title and a processing card would render a raw ULID. */
	mergeMedia(list: Media[]): void {
		if (!list.length) return;
		const next = new Map(this.mediaCatalog);
		for (const m of list) next.set(m.id, m);
		this.mediaCatalog = next;
		this.#emit();
	}
	/** Only for ids the catalog does NOT already hold — used to re-apply failed-process scars after a queue:sync
	 * without clobbering a fresher server copy of the same song. */
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

	/** "MAKE KARAOKE" — ask the server to separate one song's stems, optimistically.
	 *
	 * HOISTED OFF THE SING TAB, where it was an inline `processMedia` and the ONLY client caller of /api/process.
	 * It has a second caller now: the retry on a STALLED queue card, which is the one affordance that can recover a
	 * turn whose process half never landed. Copying it would have copied the optimistic-set / rollback / notice
	 * triple, and those three are the whole correctness of the call.
	 *
	 * THE OPTIMISTIC SET HAPPENS BEFORE THE AWAIT, and that ordering is load-bearing in two places: the tapping
	 * phone's row reads as processing in the same tick as the tap rather than after a round trip, and on /queue it
	 * is what keeps the card off `queueCardKind`'s stalled arm during the window before the first broadcast.
	 *
	 * THE NOTICE GOES THROUGH `#fail`, not a toast — this class holds no opinion about how a failure is shown, and
	 * both surfaces that can reach this register a sink (`/` and `/queue` both route `onError` to `toast.error`). */
	async requestProcess(mediaId: string): Promise<void> {
		this.setMediaStatus(mediaId, { status: 'queued', pct: 0 });
		try {
			const res = await fetch('/api/process', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ mediaId })
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				/* THE ROLLBACK IS THE OPTIMISTIC MARK, NEVER THE TURN. A refusal here leaves the entry standing on
				   purpose: the add rides the offline-tolerant `QueueStore` and is resent on resync, so rolling the
				   turn back on a transient refusal would delete a turn the guest genuinely asked for. What the guest
				   is left holding is exactly the state the stalled card exists to name. */
				this.clearMediaStatus(mediaId);
				this.#fail(body.error ?? 'Could not start process');
				return;
			}
			// The stems were already on disk (processed on an earlier night) — nothing to wait for.
			if (body.alreadyReady) void this.refreshLibrary();
		} catch {
			this.clearMediaStatus(mediaId);
			this.#fail("Couldn't start that.");
		}
	}
	/** Re-read the saved library, on connect and whenever a process goes ready, so no surface has to remember to ask.
	 * Failure raises NO TOAST — the library is an accelerator, never a blocker, and this runs on connect where a
	 * guest has not asked for it. It is no longer silent to the SURFACE, though: it leaves `libraryFailed` set, so
	 * /library can say it could not ask instead of claiming the room owns nothing. */
	async refreshLibrary(): Promise<void> {
		try {
			// Reset wherever a new attempt BEGINS, the idiom `/`'s runSearch states: cleared on the retry rather than
			// only on the next success, so a retry that fails again is not read against the previous failure.
			this.libraryFailed = false;
			// SPLIT from one nested `await (await fetch(…)).json()` so the status is checkable at all. A 500 whose body
			// happens to parse — `{}`, an error envelope — otherwise became `library: []`, i.e. an empty library.
			const res = await fetch('/api/library');
			if (!res.ok) throw new Error(`library failed: ${res.status}`);
			const snapshot = await res.json();
			this.library = snapshot.library ?? [];
			this.libraryTags = snapshot.tags ?? {};
			this.mergeMedia(this.library);
			const processing: { media: Media; status: MediaStatus; pct: number; etaSec?: number }[] =
				snapshot.processing ?? [];
			if (processing.length) {
				this.mergeMedia(processing.map((c) => c.media));
				this.seedMediaStatus(processing);
			}
			this.#emit();
		} catch {
			/* No toast — see above. The flag is the record, and `library` is deliberately left ALONE: a refresh that
			   fails must not replace a shelf of working rows with nothing, so the surface reads the two together. */
			this.libraryFailed = true;
		} finally {
			// In `finally`, so a failed fetch still RESOLVES the loading state: left false, /library would spin forever
			// on a dropped request. What it must not then render is the EMPTY state — that is `libraryFailed`'s job.
			this.libraryLoaded = true;
			this.#emit();
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

/** THE app's link to its room. A singleton because there is one phone, one room and one socket; the class is exported
 * beside it so a test can build an isolated one. */
export const room = new RoomLink();
