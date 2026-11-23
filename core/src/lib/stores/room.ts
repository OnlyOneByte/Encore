/*
 * THE ROOM LINK — one socket, one room truth, for the whole app. It must outlive every navigation, which is why a
 * component mounted by the LAYOUT can read the playback state at all. NO TOASTS, NO NAVIGATION, NO DOM: a failure a
 * human must see goes to whoever registered `onError`, because which surface says so is a UI decision. The scar
 * PERSISTENCE is here, though — that is state which must survive a reload.
 */

import {
	DEFAULT_EFFECTIVE_SETTINGS,
	LEFT_CLOSE_CODE,
	heldEntryId,
	mediaStagePosition,
	singHistoryFrom,
	songDisplay,
	type ServerEvent,
	type ClientCommand,
	type EffectiveSettings,
	type Media,
	type MediaStatus,
	type PlaybackState,
	type PlayerCommand,
	type ReactionKind,
	type PublicSinger,
	type QueueEntry,
	type TargetedCommand
} from '$lib/contract';
import { QueueStore } from '$lib/stores/queue';
import { onDeckHeldNote } from '$lib/phrasing/turn-phrasing';
import { nextPlayableEntryId, waitingTurns } from '$lib/readiness';
import { activeScars, clearScar, recordScar } from '$lib/stores/process-scars';
import { RECONNECT_BACKOFF_MS, WsClient } from '$lib/ws/client';

/** The channel this browser's tabs tell each other on when a join or a leave lands. */
const SESSION_CHANNEL = 'encore-session';

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

/** The id of the "couldn't make karaoke … try again" notice for one song, so Pick another can dismiss THAT notice —
 * the song it names has just left the queue — and nothing else on screen. */
export function failureNoticeId(mediaId: string): string {
	return `fail:${mediaId}`;
}

export class RoomLink {
	/** The joined singer, or null for a guest who has not joined (no socket is opened for them). */
	me: PublicSinger | null = null;
	connected = false;
	/** Whether this phone is in the room, as only `/api/me` can say. ONLY A 401 IS `not-joined`: a 5xx, a timeout or a
	 * network error is the party being out of reach, not the guest being out, and reading it as out sent a joined phone
	 * to the join screen, where a second join minted "Maya 2". `checking` until the first real answer, `unreachable`
	 * once that has taken UNREACHABLE_AFTER_MS — still retrying, and straight to `joined` when it answers. */
	status: RoomStatus = 'checking';
	/** Whether the tabs should show their placeholder: still asking, and past PENDING_GRACE_MS. Before that the phone
	 * paints nothing, so a guest's first screen is never a joined shell pulled out from under them (CLS). */
	placeholder = false;
	/** The dock's "Reconnecting…" cue: joined, no socket, and EITHER the socket was up once (a real drop) OR it has not
	 * come up within UNREACHABLE_AFTER_MS (a network that blocks it). Not the handshake every cold load waits on. */
	offline = false;
	/** The name this phone was in the room under when the room stopped knowing it, so the join screen can fill it in.
	 * Null on a phone that was never joined in this page's life. */
	lostName: string | null = null;
	/** Their colour then, so joining again keeps it and their songs on the TV do not change colour. */
	lostColor: string | null = null;
	/** Another tab of this browser joined as someone new, so this phone is THEM now. The layout reloads, since every
	 * store on the page is keyed to `me` and a reload is the one tested path to a page that is. */
	replacedBy: PublicSinger | null = null;
	/** False until the first `playback:state`, which `hello` sends right after `queue:sync`: until then `playback`
	 *  is this default, not the room's, so a reader cannot tell "nothing playing" from "not told yet". False again
	 *  from each socket open until that hello's `playback:state`: in between, `entries` can already be the new list
	 *  while `playback` is still the old one. Joining again after a Leave reloads the page, so a new link starts here. */
	playbackSynced = false;
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

	/** The room's queue is stuck because no worker can make anything: the verdict the TV and the strip say as
	 *  "Can't make new karaoke right now", for a surface that must then not promise to make one. */
	get noMaker(): boolean {
		return waitingTurns(
			this.entries.filter((e) => e.status === 'queued'),
			(id) => this.mediaCatalog.get(id),
			(id) => this.mediaStatus.get(id)
		).noMaker;
	}

	#ws: WsClient | undefined;
	#unreachableTimer: ReturnType<typeof setTimeout> | undefined;
	#subs = new Set<() => void>();
	#errorHandlers = new Set<(message: string, kind: 'error' | 'info', id?: string) => void>();
	#staleHandlers = new Set<(cmd: TargetedCommand['cmd']) => void>();
	/** Ids whose live status is only a scar's stand-in, with nothing heard from the server since. The server's own
	 * word (a live event, or /api/library's seed) replaces it: a scar is this device's memory of an attempt, and
	 * a Try again after the TTL left it saying "failed" over a job the server calls in flight and unservable. */
	#fromScar = new Set<string>();
	/** During a re-connect's library re-read: the songs a frame (or this phone's own act) has spoken for since the
	 *  socket came back. The snapshot is older than those, so the seed leaves them alone. */
	#heardSinceReconnect: Set<string> | null = null;
	#state: 'idle' | 'connecting' | 'live' | 'guest' | 'closed' = 'idle';
	/** The socket has been up once, so the next `connected` edge is a RE-connect that may have missed frames. */
	#wasConnected = false;
	/** This browser's other tabs. They share one session cookie, so a join or a leave in one changes who all of them are. */
	#session: BroadcastChannel | undefined;
	/** Unbinds the channel and the visibility listener; set while they are bound. */
	#unlisten: (() => void) | undefined;
	/** A re-check is out; a reason to ask that arrives meanwhile asks once more after it, never alongside it. */
	#rechecking = false;
	#recheckAgain = false;
	/** Set between `beginLeave()` and `left()`: this tab's own Leave is in flight. */
	#leaving = false;
	/** Who this tab just joined as, while `me` is still unset (see `sessionChanged`). */
	#joinedAs: string | undefined;
	/** A tab coming back to the front asks too: a browser that froze it in the background never delivered the message. */
	#onVisible = () => {
		if (document.visibilityState === 'visible') void this.#recheckMe();
	};

	/** Notified after every change to the fields above. Returns a disposer. */
	subscribe(fn: () => void): () => void {
		this.#subs.add(fn);
		return () => this.#subs.delete(fn);
	}
	/** A failure a human should see. Returns a disposer. No handler = the message is dropped; `+layout.svelte` holds the one.
	 *  `info` is a refusal that is nobody's mistake (the On deck hold), said without the error dress. */
	onError(fn: (message: string, kind: 'error' | 'info', id?: string) => void): () => void {
		this.#errorHandlers.add(fn);
		return () => this.#errorHandlers.delete(fn);
	}
	/** THIS phone's skip, restart, seek, key or guide named a song that had already ended, so the server did nothing.
	 *  Hands over WHICH command, because what to say differs (`$lib/phrasing/stale-phrasing`). Returns a disposer. */
	onStaleTransport(fn: (cmd: TargetedCommand['cmd']) => void): () => void {
		this.#staleHandlers.add(fn);
		return () => this.#staleHandlers.delete(fn);
	}

	#emit(): void {
		for (const fn of this.#subs) fn();
	}
	/** `id` names a notice a later action may take back (`failureNoticeId`). */
	#fail(message: string, kind: 'error' | 'info' = 'error', id?: string): void {
		for (const fn of this.#errorHandlers) fn(message, kind, id);
	}
	/** The entry the On deck hold protects, by the shared `heldEntryId` rule over the shared `nextPlayableEntryId`:
	 *  what the queue tab pins, and what an optimistic add lands behind, as the server does (proposal 14). */
	get heldId(): string | null {
		return this.#heldIdOf(this.entries);
	}
	/** The held entry in `list`, which for a pending add being rebased is the NEW server list, not `this.entries`. */
	#heldIdOf(list: readonly QueueEntry[]): string | null {
		const queued = list.filter((e) => e.status === 'queued').sort((a, b) => a.rotationSeq - b.rotationSeq);
		const nextId = nextPlayableEntryId(
			queued,
			(id) => this.mediaCatalog.get(id),
			(id) => this.mediaStatus.get(id)
		);
		// The PLAYING row of `list`, as the server's `heldOnDeck` reads it: a patch can land before its playback:state.
		const nowSingerId = list.find((e) => e.status === 'playing')?.singerId;
		return heldEntryId(
			queued.find((e) => e.id === nextId),
			nowSingerId,
			(id) => this.awaySingers.has(id)
		);
	}
	/** The queue tab's own line for a reorder the hold stopped (`onDeckHeldNote`), from the entries the link holds. */
	#heldNote(heldId: string, movedId: string): string {
		const singerOf = (id: string) => this.entries.find((e) => e.id === id)?.singerId;
		const name = (id: string | undefined) => (id && this.singers.get(id)?.displayName) || 'Someone';
		const moved = singerOf(movedId);
		return onDeckHeldNote(name(singerOf(heldId)), moved === this.me?.id ? null : name(moved));
	}

	/** A song's display title, for a message about it. The catalog is right here, so nothing else needs to pass it. */
	titleOf(mediaId: string): string {
		const m = this.mediaCatalog.get(mediaId);
		if (!m) return mediaId;
		// `songDisplay`, as the TV and /queue read it: the raw title and the uploader are not what a guest saw.
		const d = songDisplay(m);
		return d.artist ? `${d.title} — ${d.artist}` : d.title;
	}

	/** IDEMPOTENT and browser-only: the layout calls it on mount, and calling it again (a second mount, a navigation)
	 * is a no-op rather than a second socket. A guest who has not joined settles at `guest` with no socket at all. */
	async connect(): Promise<void> {
		if (typeof window === 'undefined') return; // SSR: this singleton must stay inert on the server
		if (this.#state !== 'idle') return;
		this.#state = 'connecting';

		const me = await this.#askMe();
		if (!me) return; // closed while asking
		this.placeholder = false;
		// Bound once there is an answer to compare with: while still asking, the ask itself wakes on the page coming back.
		const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel(SESSION_CHANNEL);
		if (channel) channel.onmessage = () => void this.#recheckMe();
		this.#session = channel;
		const doc = typeof document === 'undefined' ? undefined : document;
		doc?.addEventListener('visibilitychange', this.#onVisible);
		this.#unlisten = () => {
			channel?.close();
			this.#session = undefined;
			doc?.removeEventListener('visibilitychange', this.#onVisible);
		};
		if (me === 'not-joined') {
			// Unjoined: `/` is the landing page, so the route renders its JoinLanding state — no store and no socket.
			this.#state = 'guest';
			this.status = 'not-joined';
			this.#emit();
			return;
		}
		this.me = me;
		this.status = 'joined';

		this.queue = new QueueStore({
			singerId: this.me.id,
			sendCommand: (cmd: ClientCommand) => this.#ws?.send({ type: 'queue:command', command: cmd }),
			onReject: (reason, op) => {
				// The hub's own wording for an add of a song it no longer holds (hub.ts `validateCommand`).
				const gone = /^unknown media: (.+)$/.exec(reason);
				// hub.ts `ON_DECK_HELD`: two phones raced, and someone else's On deck kept its turn. Not an error.
				const held = /^on deck is held: (.+)$/.exec(reason);
				if (held) this.#fail(this.#heldNote(held[1]!, 'id' in op ? op.id : ''), 'info');
				else if (gone) {
					this.#songGone(gone[1]!);
					// Said for this tap: its process refusal, if still in flight, stays silent.
					if (this.#processInFlight.has(gone[1]!)) this.#toldWhileProcessing.add(gone[1]!);
				} else this.#fail(`Couldn't do that: ${reason}`);
			},
			// Read at apply time, not captured: both the algorithm and the sing history change while the party runs, and
			// predicting with a stale ordering is what makes a row jump.
			ordering: (list) => ({
				order: this.settings.room.queueOrder,
				lastSungAt: singHistoryFrom(this.singers.values()),
				heldId: this.#heldIdOf(list)
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
			onConnectionChange: (c, closeCode) => {
				// The server closed it because this singer left from another tab: not a dropped link, so no
				// "Reconnecting…", and the ask goes out now rather than after the reconnect. A tab frozen in the
				// background gets the close when it thaws, and lands on the join screen the same way.
				const left = closeCode === LEFT_CLOSE_CODE;
				if (left) void this.#recheckMe();
				if (c && this.#wasConnected) {
					// A socket that comes BACK is when a lost session shows: the server upgrades a phone with no valid
					// session to an anonymous spectator, so the dot goes green and every tap is refused. One /api/me asks.
					void this.#recheckMe();
					// And it re-reads the library: frames sent while the socket was down (a core restart, a worker that
					// came or went meanwhile) are lost, and the seed is what a reload would say. The first connect has its own.
					this.#heardSinceReconnect = new Set();
					void this.refreshLibrary(true);
				}
				if (c) this.#wasConnected = true;
				// The socket says it is open BEFORE it sends `hello`, so the reply's `queue:sync` and `playback:state` both land
				// after this: a reader sees one resync, not a song that left and then a first song.
				if (c) this.playbackSynced = false;
				this.connected = c;
				// The socket reports no drop before its first connect, so this is a real drop, never the handshake.
				this.offline = !c && !left;
				this.#emit();
			},
			onEvent: (e: ServerEvent) => this.#onServerEvent(e)
		});

		// The live status map is in-memory only, so a reload erases a failed process. A persisted scar is seeded back as a
		// synthetic `failed` status and flows through the same readiness path a live failure takes, with no extra UI.
		// Merged ONCE: a sync adds to the catalog rather than replacing it, so nothing has to put these back later.
		this.seedScars(activeScars());

		this.#state = 'live';
		this.#ws.open();
		// A socket that never comes up (a proxy that blocks it) still gets the cue, just not on a normal handshake.
		this.#unreachableTimer = setTimeout(() => {
			if (this.#state !== 'live' || this.connected || this.offline) return;
			this.offline = true;
			this.#emit();
		}, UNREACHABLE_AFTER_MS);
		void this.refreshLibrary();
		this.#emit();
	}

	/** Ask `/api/me` until it gives an ANSWER: a singer or a 401. Anything else — a 5xx from a restarting server, a hung
	 * request, a network error, a captive portal's login page — is asked again on the socket's own backoff, and after
	 * UNREACHABLE_AFTER_MS the status says so. The loop lives inside the one `connect()`, so there is never a second
	 * socket. Null when the link was closed while asking. */
	async #askMe(): Promise<PublicSinger | 'not-joined' | null> {
		// Both cleared the moment the asking ends, so they only ever fire on a phone that is still asking.
		const grace = setTimeout(() => {
			this.placeholder = true;
			this.#emit();
		}, PENDING_GRACE_MS);
		const unreachable = () => {
			if (this.status !== 'checking') return;
			this.status = 'unreachable';
			this.placeholder = true;
			this.#emit();
		};
		// At the 3 s mark an ask still in flight gets to finish first, for up to IN_FLIGHT_GRACE_MS: a blip that ended
		// just before it is then caught with no message at all, however slow the round trip.
		let asking = false;
		const late = setTimeout(() => {
			if (!asking) unreachable();
		}, UNREACHABLE_AFTER_MS);
		const latest = setTimeout(unreachable, UNREACHABLE_AFTER_MS + IN_FLIGHT_GRACE_MS);
		const started = Date.now();
		try {
			for (let attempt = 0; ; attempt++) {
				asking = true;
				const answer = await this.#me();
				asking = false;
				if (this.#state !== 'connecting') return null;
				if (answer) return answer;
				const before = Date.now() - started < UNREACHABLE_AFTER_MS;
				if (!before) unreachable();
				// Never more than a second apart before the message, so the last ask before it goes out at about 2.75 s;
				// every 1.5 s after it, so a party that comes back is noticed within about 1.5 s rather than the backoff's
				// 5 s step — one small request per phone on a LAN. The browser saying the network is back (`online`) is
				// asked at once, not waited out, and so is the page coming back into view: a guest who signs in to a
				// captive portal does it in the OS sheet or another app and returns, and a portal never fires `online`.
				const delay = Math.min(
					RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)]!,
					before ? 1000 : 1500
				);
				await new Promise<void>((resolve) => {
					// Held, not re-read: the sleep can outlive the page that started it (an unmount mid-retry).
					const win = window;
					const doc = typeof document === 'undefined' ? undefined : document;
					const wake = () => {
						clearTimeout(timer);
						win.removeEventListener('online', wake);
						doc?.removeEventListener('visibilitychange', onVisible);
						resolve();
					};
					const onVisible = () => {
						if (doc?.visibilityState === 'visible') wake();
					};
					const timer = setTimeout(wake, delay);
					win.addEventListener('online', wake);
					doc?.addEventListener('visibilitychange', onVisible);
				});
				if (this.#state !== 'connecting') return null;
			}
		} finally {
			clearTimeout(grace);
			clearTimeout(late);
			clearTimeout(latest);
		}
	}

	/** One ask of `/api/me`. The singer, `not-joined` for a 401 (the ONE answer that means it), or null for anything
	 * that is not an answer — including a 2xx whose body is not a singer, which is what a captive portal or a hotel
	 * login page sends for every URL. */
	async #me(): Promise<PublicSinger | 'not-joined' | null> {
		try {
			const res = await fetch('/api/me', { signal: AbortSignal.timeout(ME_TIMEOUT_MS) });
			if (res.status === 401) return 'not-joined';
			if (!res.ok) return null;
			const singer = (await res.json())?.singer;
			return typeof singer?.id === 'string' ? singer : null;
		} catch {
			return null;
		}
	}

	/** After a reconnect, a word from another tab, or the tab coming back to the front: who is this phone now? A 401
	 * settles a joined phone as `not-joined` and drops the socket, so the tabs show the join screen with the name filled
	 * in. Never a silent rejoin: a session only goes when someone left on purpose or the room was reset, and rejoining
	 * would undo a Leave. A DIFFERENT singer means another tab joined as someone new, and the cookie is theirs now: that
	 * is `replacedBy`, and the layout reloads. Anything else proves nothing. */
	async #recheckMe(): Promise<void> {
		if (this.#rechecking) return void (this.#recheckAgain = true);
		this.#rechecking = true;
		const answer = await this.#me();
		this.#rechecking = false;
		if (this.#recheckAgain) {
			this.#recheckAgain = false;
			return this.#recheckMe();
		}
		if (answer === 'not-joined') {
			if (this.#state !== 'live') return;
			// This tab's own leave is not a lost session: no name to offer back, and no line saying they were removed.
			this.lostName = this.#leaving ? null : (this.me?.displayName ?? null);
			this.lostColor = this.#leaving ? null : (this.me?.color ?? null);
			this.me = null;
			this.status = 'not-joined';
			// `guest`, not `closed`: still listening, so this tab follows when another one joins.
			this.#state = 'guest';
			this.#dropSocket();
			this.#emit();
			return;
		}
		const following = this.#state === 'live' || this.#state === 'guest';
		const self = this.me?.id ?? this.#joinedAs;
		if (answer && answer.id !== self && following && !this.replacedBy) {
			this.replacedBy = answer;
			this.#emit();
		}
	}

	/** Tell this browser's other tabs that a join or a leave just landed here, so they ask who they are now. `joinedAs`
	 *  is who THIS tab just joined as, so its own re-check does not read that singer as someone new (a join that
	 *  navigates to `?next=` without a reload leaves `me` unset). */
	sessionChanged(joinedAs?: string): void {
		if (joinedAs) this.#joinedAs = joinedAs;
		this.#session?.postMessage('changed');
	}

	/** This tab is leaving on purpose. The server closes this tab's socket too (4001), possibly before the Leave's own
	 *  response lands, so until `left()` or the returned undo, a session that ends is this tab's own leave, not news.
	 *  The undo is for a leave that failed. */
	beginLeave(): () => void {
		this.#leaving = true;
		return () => void (this.#leaving = false);
	}

	/** The Leave landed. This tab goes to the plain join screen: no "You're not in the room any more", which is for a tab
	 *  that did not choose it. The socket goes now, so the server's close finds nothing to answer, and the other tabs are told. */
	left(): void {
		this.#leaving = false;
		this.me = null;
		this.lostName = null;
		this.lostColor = null;
		this.status = 'not-joined';
		if (this.#state === 'live') this.#state = 'guest';
		this.#dropSocket();
		this.sessionChanged();
		this.#emit();
	}

	#dropSocket(): void {
		clearTimeout(this.#unreachableTimer);
		this.#ws?.close();
		this.#ws = undefined;
	}

	/** Drop the socket. The layout owns this, so it runs when the app unmounts — not on navigation. */
	close(): void {
		this.#state = 'closed';
		this.#dropSocket();
		this.#unlisten?.();
		this.#unlisten = undefined;
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

	/** A cheer for whoever is singing. Fire-and-forget like a player command; the server rate-limits it silently. */
	react(kind: ReactionKind): void {
		this.#ws?.send({ type: 'room:react', kind });
	}

	#onServerEvent(e: ServerEvent): void {
		if (e.type === 'queue:sync') {
			if (e.settings) {
				this.settings = e.settings;
				// A null per-song override means "inherit", so the control needs the room default to label itself.
				this.roomGuideDefault = e.settings.room.guideLevelDefault;
			}
			if (e.singers) this.singers = new Map(e.singers.map((s) => [s.id, s]));
			// ADDS rather than replaces: a sync carries only the queued songs, so replacing would erase every row search and
			// the library merged in, and a title would fall back to its id. The catalog is only read by id, so a stale extra
			// row is harmless.
			if (e.media) this.mediaCatalog = new Map([...this.mediaCatalog, ...e.media.map((m) => [m.id, m] as const)]);
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
		if (e.type === 'playback:state') {
			this.playback = e.state;
			this.playbackSynced = true;
		}
		if (e.type === 'player:stale') for (const fn of this.#staleHandlers) fn(e.cmd);
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
		this.#fromScar.delete(mediaId); // the server's own word now; a later seed must not overwrite it
		this.#heardSinceReconnect?.add(mediaId);

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
			void this.refreshLibrary();
		}
		// Surface a died process instead of leaving the row stuck, and persist a per-device scar so it survives a reload.
		if (status === 'failed') {
			// A failure carries its row, so a phone that never fetched the song (an admin-started process) names it.
			if (e.media) this.mergeMissingMedia([e.media]);
			const failedMedia = this.mediaCatalog.get(mediaId);
			// Not for a `restated` failure: it died once, and re-recording on every re-tell restarts the scar's 30 minutes,
			// so a flapping worker would keep it alive for ever.
			if (failedMedia && !e.restated) {
				/* THE SCAR STAYS ROOM-WIDE, deliberately, and it is NOT what made the reported defect. It renders on no
				   persistent surface — it only re-reads as failed-with-retry if THIS phone searches that exact song
				   again — its statement is room-TRUE (the process really did die in this room), and it expires in
				   PROCESS_SCAR_TTL_MS, 30 minutes. Scoping it to the requester as well is a taste call for the owner,
				   so it is reported rather than taken. */
				recordScar(failedMedia);
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
			   failed-with-retry, and their /queue row still draws a non-plain card by the paragraph above.
			   A `restated` failure was announced when it happened; it is re-sent only because its cause changed. */
			if (!e.restated && (!e.requestedBy || e.requestedBy === this.me?.id)) {
				this.#fail(
					`Couldn't make karaoke for “${this.titleOf(mediaId)}” — try again.`,
					'error',
					failureNoticeId(mediaId)
				);
			}
		}
	}

	/** A song deleted since this phone fetched it: a sync carries only queued songs, so nothing else drops its row, and
	 * the shelf and an open search keep offering it. Drops it from both, and says so on EVERY refused tap: a tap that
	 * is refused in silence is a dead end. `tell` is false only for the second refusal of one tap (see requestProcess). */
	#songGone(mediaId: string, tell = true): void {
		const next = new Map(this.mediaCatalog);
		next.delete(mediaId);
		this.mediaCatalog = next;
		this.library = this.library.filter((m) => m.id !== mediaId);
		// A failed song carries a stored scar, which the next connect would seed back into the catalog: drop it too.
		clearScar(mediaId);
		// And its live status, whichever refusal brought us here: a `failed` left behind would show a re-added copy
		// of the song as failed until a new status arrived.
		this.clearMediaStatus(mediaId);
		this.#emit();
		if (tell) this.#fail("That song isn't in the library any more.");
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
	/** Only for ids the catalog does NOT already hold, so a scar seeded on connect or a failure's own row never
	 * clobbers a fresher server copy. */
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
		this.#fromScar.delete(mediaId); // this phone's own act is fresher than its scar
		this.#heardSinceReconnect?.add(mediaId);
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
	 * the root layout routes `onError` to `toast.error` on every surface.
	 *
	 * RESOLVES TRUE ONLY WHEN THE PROCESS STARTED (or the stems were already on disk): Sing adds its turn on true
	 * alone, so a refused tap books no turn nothing is working on. */
	async requestProcess(mediaId: string): Promise<boolean> {
		this.setMediaStatus(mediaId, { status: 'queued', pct: 0 });
		this.#processInFlight.add(mediaId);
		try {
			const res = await fetch('/api/process', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ mediaId })
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				/* THE ROLLBACK IS THE OPTIMISTIC MARK, NEVER THE TURN. A first Sing has no turn yet (it adds one only
				   on true); a retry off a stalled card keeps the turn it already holds, which is exactly the state the
				   stalled card exists to name. */
				this.clearMediaStatus(mediaId);
				if (res.status === 409 && body.error === 'unknown media') {
					// ONE notice per tap. Sing adds no turn until this POST answers, so this is usually the tap's only
					// refusal; stay silent only when an add of this song is still pending (a socket refusal will say it)
					// or one was refused while this POST was out.
					const tappedAdd = this.entries.some(
						(e) => e.mediaId === mediaId && this.queue?.pendingKindById.get(e.id) === 'add'
					);
					this.#songGone(mediaId, !this.#toldWhileProcessing.has(mediaId) && !tappedAdd);
				} else this.#fail(body.error ?? 'Could not start process');
				return false;
			}
			// The stems were already on disk (processed on an earlier night) — nothing to wait for.
			if (body.alreadyReady) void this.refreshLibrary();
			return true;
		} catch {
			this.clearMediaStatus(mediaId);
			this.#fail("Couldn't start that.");
			return false;
		} finally {
			this.#processInFlight.delete(mediaId);
			this.#toldWhileProcessing.delete(mediaId);
		}
	}
	#processInFlight = new Set<string>();
	#toldWhileProcessing = new Set<string>();
	/** Re-read the saved library, on connect and whenever a process goes ready, so no surface has to remember to ask.
	 * Failure raises NO TOAST — the library is an accelerator, never a blocker, and this runs on connect where a
	 * guest has not asked for it. It is no longer silent to the SURFACE, though: it leaves `libraryFailed` set, so
	 * /library can say it could not ask instead of claiming the room owns nothing. */
	async refreshLibrary(reconnect = false): Promise<void> {
		// A flapping socket can start a second re-connect read before this one returns. That read owns a fresh heard-set,
		// so this older one neither seeds over it nor clears it.
		const heard = this.#heardSinceReconnect;
		const superseded = () => reconnect && this.#heardSinceReconnect !== heard;
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
			const processing: { media: Media; status: MediaStatus; pct: number; etaSec?: number; unservable?: boolean }[] =
				snapshot.processing ?? [];
			if (processing.length) this.mergeMedia(processing.map((c) => c.media));
			if (!superseded()) {
				this.seedMediaStatus(processing, reconnect);
				this.seedNoMakerFailures(snapshot.noMakerFailed ?? []);
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
			if (reconnect && !superseded()) this.#heardSinceReconnect = null;
			this.#emit();
		}
	}

	/** Seed statuses from a /api/library snapshot.
	 *  - On a first load, a live broadcast is fresher, so it is never overwritten.
	 *  - On a RE-connect the rule is the other way round: everything held is from before the drop, which is why this
	 *    re-read exists (a core restart re-says `unservable` before any socket is back). The server's row replaces the
	 *    held status, and a held in-flight status the server no longer lists goes (the job died, or finished, unheard).
	 *    A frame heard SINCE the re-connect still wins: it is newer than the snapshot. */
	seedMediaStatus(
		list: { media: Media; status: MediaStatus; pct: number; etaSec?: number; unservable?: boolean }[],
		reconnect = false
	): void {
		if (!list.length && !reconnect) return;
		const listed = new Set(list.map((c) => c.media.id));
		const stale = (id: string) => reconnect && !this.#heardSinceReconnect?.has(id);
		const next = new Map(this.mediaStatus);
		for (const c of list)
			if (!next.has(c.media.id) || this.#fromScar.delete(c.media.id) || stale(c.media.id))
				next.set(c.media.id, { status: c.status, pct: c.pct, etaSec: c.etaSec, unservable: c.unservable });
		for (const [id, s] of next)
			if (!listed.has(id) && stale(id) && mediaStagePosition(s.status) >= 0 && s.status !== 'ready') next.delete(id);
		this.mediaStatus = next;
		this.#emit();
	}

	/** This device's failed-process scars, seeded as stand-in `failed` statuses until the server says otherwise. */
	seedScars(scars: Media[]): void {
		if (!scars.length) return;
		// The library endpoint returns only ready and processing media, so a failed song is not in the catalog.
		this.mergeMissingMedia(scars);
		const withScars = new Map(this.mediaStatus);
		for (const m of scars)
			if (!withScars.has(m.id)) {
				withScars.set(m.id, { status: 'failed', pct: 0 });
				this.#fromScar.add(m.id);
			}
		this.mediaStatus = withScars;
	}

	/** Queued turns the server says died because no worker could run them (/api/library's `noMakerFailed`): the
	 * server's CURRENT cause of every failure this phone holds. A live in-flight status is kept and a scar's stand-in is
	 * replaced, as in `seedMediaStatus`; a held `failed` takes the cause either way, because a failure's cause is about
	 * now — the fleet may have come or gone while this phone's socket was down (a core restart), and no frame said so. */
	seedNoMakerFailures(mediaIds: string[]): void {
		const listed = new Set(mediaIds);
		const next = new Map(this.mediaStatus);
		for (const id of listed)
			if (!next.has(id) || this.#fromScar.delete(id) || next.get(id)!.status === 'failed')
				next.set(id, { status: 'failed', pct: 0, unservable: true });
		for (const [id, s] of next)
			if (s.status === 'failed' && s.unservable && !listed.has(id)) next.set(id, { ...s, unservable: undefined });
		this.mediaStatus = next;
		this.#emit();
	}
}

/** Where the phone stands with the room. Only `joined` gets the room; only `not-joined` gets the join screen. */
export type RoomStatus = 'checking' | 'joined' | 'not-joined' | 'unreachable';
/** How long `/api/me` may go unanswered before the phone says it can't reach the party. The owner's call: shorter
 * and a normal slow load flashes the message, longer and a guest stares at grey rows. */
export const UNREACHABLE_AFTER_MS = 3000;
/** How long a cold load paints nothing before the placeholder: on a LAN `/api/me` answers well inside it, so a joined
 * phone goes straight to its tab and a new guest straight to the join screen, with no shell in between to shift. */
export const PENDING_GRACE_MS = 300;
/** How long past UNREACHABLE_AFTER_MS an ask already in flight may take before the message shows anyway. */
const IN_FLIGHT_GRACE_MS = 1000;
/** A request that never returns is a failure like any other, so it is cut off and asked again, not waited on. */
const ME_TIMEOUT_MS = 5000;

/** THE app's link to its room. A singleton because there is one phone, one room and one socket; the class is exported
 * beside it so a test can build an isolated one. */
export const room = new RoomLink();
