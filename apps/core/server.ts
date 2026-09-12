// Encore core — the one Bun process. HTTP (SvelteKit) + native WebSocket pub/sub hub.
// Locked in docs/ARCHITECTURE.md: Bun.serve owns BOTH the SvelteKit request handler AND the
// realtime hub, so there is no network hop between layers and the authoritative in-memory state
// lives in this one process. Prod entry (replaces the adapter's build/index.js): bun run server.ts

import {
	graceMsOf,
	type ClientEvent,
	type ServerEvent,
	type Media,
	type WorkerMessage,
	type WorkerCommand
} from '$shared';
import { handleQueueCommand, syncEvent, type HubDeps } from './src/lib/server/realtime/hub';
import { handlePlayerCommand, handleTelemetry, reconcileOnReady, nowPlayingEvent } from './src/lib/server/realtime/player';
import { validateWorkerMessage } from './src/lib/server/jobs/worker-hub';
import { getApp, setPublish, buildHubDeps } from './src/lib/server/app';
import { readSessionToken } from './src/lib/server/singers/repository';
import { can } from './src/lib/server/auth/capabilities';
import { isForeignRoom, subscribeTopicFor, broadcastTopicFor } from './src/lib/server/realtime/room-scope';
import { tvRoomId } from './src/lib/server/rooms/tv-room';
import { presentTracks, type LocalTrack } from './src/lib/server/media/local';
import { safeMediaPath } from './src/lib/server/media/local-files';
import { existsSync } from 'node:fs';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

// Optional shared secret gating role=worker WS upgrades. CONTRACT (a worker-side sibling implements
// the other half): when ENCORE_WORKER_TOKEN is SET, a role=worker upgrade MUST present a matching
// `token` query parameter or be refused with 401 — an unauthenticated LAN device must not be able to
// register as a worker, soak up dispatch, and report fabricated completions. When UNSET, worker
// upgrades are allowed as before, but we print ONE loud startup warning so an open box is never
// silent. Other roles (phone/TV) are unaffected — they carry no dispatch authority.
const WORKER_TOKEN = process.env.ENCORE_WORKER_TOKEN?.trim() || null;

// shared singleton — the SAME authoritative state instance the SvelteKit /api routes use.
const app = getApp();
const state = app.state;

// Live worker WS sockets keyed by workerId — the dial-home registry's transport half (the registry
// itself holds liveness/slots). In-memory, process-lifetime, never persisted (§10).
// `singerId` is resolved at upgrade from the session cookie; absent for the TV and a not-yet-joined phone.
// `roomId` is the party this socket is SCOPED to, resolved from the session token at upgrade —
// the isolation key. `singerId` is the same singer's id (presence/auth). A worker, a TV before it is
// bound, and a not-yet-joined phone carry neither and are foreign to every room's mutable state.
type SocketData = { role: string; workerId?: string; singerId?: string; roomId?: string };
type WorkerSocket = import('bun').ServerWebSocket<SocketData>;
const workerSockets = new Map<string, WorkerSocket>();
// server.ts owns the transport: the WorkerHub calls app.toWorker(id, cmd) → look up the socket.
app.toWorker = (workerId: string, cmd: WorkerCommand) => {
	workerSockets.get(workerId)?.send(JSON.stringify(cmd));
};

// Start the job reaper's periodic tick (~3s): enforces ack/progress leases, requeueing or failing
// jobs whose owning worker went silent. On any requeue/fail it redispatches (onReaped,
// wired in app.ts). Boot recovery already ran in getApp().
app.reaper.start();

// bounded idempotency ledger of applied clientOpIds: dedupes resent commands across
// reconnects so a retry never double-applies. In-memory (process-lifetime), insertion-ordered.
const seenOps = new Set<string>();

// MVP/harness media catalog. Real media is resolved via /api/search + persisted on demand.
// Seed a few youtube demos so the dev harness can add songs that validate even without yt-dlp.
// IMPORTANT: seed only what is MISSING. getApp() has already hydrated the durable catalog, so
// an unconditional set would overwrite a demo song that was cooked on a previous night with this
// pristine iframe stub — the DB would still say "stems ready" while the runtime said "plain iframe",
// which re-cooks the song and plays the vocal YouTube embed instead of the instrumental.
const mediaById = app.mediaById;
for (const m of [
	{
		id: 'demo-takeonme',
		source: 'youtube',
		sourceRef: 'djV11Xbc914',
		title: 'Take On Me',
		artist: 'a-ha',
		durationSec: 225,
		stemStatus: 'none'
	},
	{
		id: 'demo-mrbrightside',
		source: 'youtube',
		sourceRef: 'gGdGFtwCNBE',
		title: 'Mr. Brightside',
		artist: 'The Killers',
		durationSec: 223,
		stemStatus: 'none'
	},
	{
		id: 'demo-dancingqueen',
		source: 'youtube',
		sourceRef: 'xFrGuyw1V8s',
		title: 'Dancing Queen',
		artist: 'ABBA',
		durationSec: 231,
		stemStatus: 'none'
	}
] as Media[]) {
	if (!mediaById.has(m.id)) mediaById.set(m.id, m);
}

// Seed the local library FTS index so the "Library" tab returns results in dev (and as a demo
// of local search). A real deployment would scan MEDIA_DIR here. The demo tracks are also added
// to mediaById so they're queue-able by id.
// Only index what is REALLY THERE (checked against the same path resolution the /media route uses).
// These four are aspirational placeholders — drop an actual file at MEDIA_DIR/library/<name>.mp4 and
// it appears in the Library tab. Without the filter they were searchable, queueable songs that could
// never play: cooking one burned three attempts on `ffmpeg exited 254: No such file or directory` and
// then left the song stuck in the phone's "cooking" list for the rest of the night.
const seededLibrary: LocalTrack[] = [
	{ sourceRef: 'library/dont-stop-believin.mp4', title: "Don't Stop Believin'", artist: 'Journey', durationSec: 250 },
	{ sourceRef: 'library/sweet-caroline.mp4', title: 'Sweet Caroline', artist: 'Neil Diamond', durationSec: 201 },
	{ sourceRef: 'library/bohemian-rhapsody.mp4', title: 'Bohemian Rhapsody', artist: 'Queen', durationSec: 355 },
	{ sourceRef: 'library/livin-on-a-prayer.mp4', title: "Livin' on a Prayer", artist: 'Bon Jovi', durationSec: 249 }
];
const presentLibrary = presentTracks(seededLibrary, (ref) => {
	const abs = safeMediaPath(ref);
	return !!abs && existsSync(abs);
});
app.localLibrary.index(presentLibrary);
if (presentLibrary.length < seededLibrary.length) {
	const missing = seededLibrary.length - presentLibrary.length;
	console.log(
		`[core] library: ${presentLibrary.length}/${seededLibrary.length} demo tracks indexed — skipped ${missing} with no file under ${process.env.MEDIA_DIR ?? './media'}/library/`
	);
}

// SvelteKit handler from the Bun adapter's build output (guarded so WS still boots pre-build).
type SvelteHandler = (req: Request, server: import('bun').Server<SocketData>) => Response | Promise<Response>;
let svelteKitFetch: SvelteHandler | null = null;
try {
	// build/handler.js is svelte-adapter-bun's GENERATED output (apps/core/build/ is gitignored, so
	// it ships no declarations). The cast fixes its shape; @ts-expect-error covers the resolver's
	// implicit-any on the untyped generated module — expect-error (not ignore) so it self-clears the
	// day the adapter emits types.
	// @ts-expect-error — generated, untyped adapter output; shape asserted by the cast below
	const { getHandler } = (await import('./build/handler.js')) as { getHandler: () => { fetch: SvelteHandler } };
	svelteKitFetch = getHandler().fetch;
} catch {
	console.warn('[core] build/handler.js not found — run `bun run build`. Serving WS + /health + /harness only.');
}

// The room's membership, as the TV renders it. `here` holds a socket; `away` is in the room but
// unreachable (a locked phone, a pocket) and is still counted.
let membership = { here: [] as string[], away: [] as string[] };

/** A singer holds a stake in the room while any entry of theirs is still waiting to be sung. */
function hasPendingSongs(singerId: string): boolean {
	return state.entries.some((e) => e.singerId === singerId && (e.status === 'queued' || e.status === 'playing'));
}

/**
 * Advance membership and broadcast it if it moved.
 *
 * Driven both by socket edges and by a timer, because `gone` is a property of elapsed time: no socket
 * event can announce it. Compared against the last broadcast rather than published unconditionally, so
 * a 20-second sweep over a quiet room is silent instead of a heartbeat every client must parse.
 */
function refreshMembership(): void {
	const next = app.presence.evaluate({
		now: app.now(),
		graceMs: graceMsOf(app.settings.getRoom(app.activeRoomId).presenceGraceMinutes),
		hasPendingSongs
	});
	const same = next.here.join() === membership.here.join() && next.away.join() === membership.away.join();
	membership = { here: next.here, away: next.away };
	if (!same) {
		// the presence roster is a per-room broadcast like any other — publish it to the served
		// room's topic so another party never sees this room's roster.
		server.publish(
			broadcastTopicFor(app.activeRoomId),
			JSON.stringify({ type: 'singer:presence', online: next.here, away: next.away } satisfies ServerEvent)
		);
	}
}

// A singer's grace clock starts when their last pending song leaves the queue, so the queue changing
// can move membership as surely as a socket closing. 20s is far finer than any sane grace window while
// staying cheap: one pass over the entries per tick.
const MEMBERSHIP_SWEEP_MS = 20_000;

const server = Bun.serve<SocketData>({
	port: PORT,
	hostname: HOST,
	idleTimeout: 30,

	async fetch(req, server) {
		const url = new URL(req.url);

		if (url.pathname === '/ws') {
			const role = url.searchParams.get('role') ?? 'phone';
			// A role=worker socket carries dispatch authority (it registers via worker-hub #onHello,
			// receives job assignments, and reports completions). When a shared secret is configured,
			// require it here and refuse an unauthenticated worker with 401 rather than upgrading it.
			if (role === 'worker' && WORKER_TOKEN && url.searchParams.get('token') !== WORKER_TOKEN) {
				return new Response('unauthorized worker', { status: 401 });
			}
			// Resolve WHICH singer this socket belongs to, at upgrade, from the session cookie
			// the browser sends on the WS handshake (same-origin, so it is there). Without this the
			// socket is anonymous and presence is impossible. A TV or a not-yet-joined phone simply
			// has no singerId and is tracked as a spectator.
			// resolve the WHOLE singer, not just the id — its `roomId` (NOT NULL since the room-scoping
			// change) is the
			// scope this socket is bound to. The session token is the scope token: it maps to exactly one
			// room, so a socket cannot present a token for room A and then act on room B.
			const me = app.singers.bySessionToken(readSessionToken(req.headers.get('cookie')));
			// one-TV-per-room: a TV carries no cookie/singer, so it cannot get a room from the
			// session token like a phone does. It carries the join CODE instead (?room=<code>, the same
			// handle the QR encodes) — tvRoomId turns that into the room id the TV binds to, falling back
			// to the served room for a bare or unknown code. A bound TV is then IN-ROOM via
			// subscribeTopicFor instead of an unscoped spectator, so a TV resolves WHICH room it
			// shows. A phone's scope still comes from its token (a TV cannot spoof a room it never joined,
			// because a code only ever RESOLVES a room to VIEW — mutations stay gated by join/player).
			const roomId =
				role === 'tv'
					? tvRoomId(url.searchParams.get('room'), (code) => app.rooms.byCode(code), app.activeRoomId)
					: me?.roomId;
			if (server.upgrade(req, { data: { role, singerId: me?.id, roomId } })) return undefined as unknown as Response;
			return new Response('ws upgrade failed', { status: 400 });
		}
		if (url.pathname === '/health') {
			return Response.json({
				ok: true,
				runtime: `bun ${Bun.version}`,
				room: broadcastTopicFor(app.activeRoomId),
				rev: state.rev
			});
		}
		// Dev harness — two iframes + live queue JSON to eyeball cross-client sync.
		if (url.pathname === '/harness') return new Response(harnessHtml(), { headers: { 'content-type': 'text/html' } });
		if (url.pathname === '/harness/phone')
			return new Response(phoneHtml(), { headers: { 'content-type': 'text/html' } });

		if (svelteKitFetch) return svelteKitFetch(req, server);
		return new Response('Encore core up (WS + /health + /harness). Run `bun run build` for the UI.', {
			headers: { 'content-type': 'text/plain' }
		});
	},

	websocket: {
		open(ws) {
			// Workers are NOT room subscribers — they speak the dial-home protocol, not queue events.
			if (ws.data.role === 'worker') return;
			// subscribe to the socket's OWN room topic, not one shared topic. A socket only ever
			// receives events for the party it is scoped to, so a broadcast in room A never reaches room B.
			// A foreign socket lands on its OWN room's topic, never the served room's. An unscoped
			// spectator (a TV, a not-yet-joined phone) defaults to the served room, so it still sees the
			// one room this box is serving — isolation is between rooms, not against a viewer of this one.
			ws.subscribe(subscribeTopicFor(ws.data.roomId, app.activeRoomId));
			// The app's broadcast sink is routed through Bun's native pub/sub ONCE at boot (see the
			// setPublish(broadcast) call below Bun.serve) — not per open. Every socket subscribes to its
			// own room's topic, so one publish to that topic reaches exactly that room's clients;
			// reassigning the sink on every connect wrote the identical closure N times for no effect.
			// Announce only on the 0→1 transition so a second tab doesn't spam an unchanged roster.
			if (ws.data.singerId && app.presence.connect(ws.data.singerId)) refreshMembership();
		},
		message(ws, raw) {
			// Dial-home worker protocol (§5) — a separate message family on role=worker sockets.
			if (ws.data.role === 'worker') {
				let parsed: unknown;
				try {
					parsed = JSON.parse(String(raw));
				} catch {
					return;
				}
				// A role=worker socket carries DISPATCH AUTHORITY and — when ENCORE_WORKER_TOKEN is unset
				// (see :36 / the boot warning) — is reachable UNAUTHENTICATED. Everything below reads fields
				// straight off the frame: `'workerId' in msg` throws on a `null` body, and the worker hub
				// spreads/joins `capabilities`, so a wrong-typed field used to throw out of this handler.
				// Validate the frame's SHAPE before any of those reads, exactly as validateCommand guards
				// the client family. A malformed frame is dropped, not executed.
				if (validateWorkerMessage(parsed) !== null) return;
				const msg = parsed as WorkerMessage;
				// remember this socket's workerId so disconnect can deregister + free its slots
				if ('workerId' in msg && msg.workerId) {
					ws.data.workerId = msg.workerId;
					workerSockets.set(msg.workerId, ws);
				}
				app.workerHub.handle(msg);
				return;
			}

			let evt: ClientEvent;
			try {
				evt = JSON.parse(String(raw));
			} catch {
				return;
			}
			// The hub bag is assembled by app.ts's buildHubDeps factory: every app-derived hook
			// (listSingers, getSettings, onNowPlaying, onSang, recordAdd, onEntryRemoved -> cancelJobsForMedia,
			// onEntryAdded -> reprioritizeCookForMedia) is wired there in ONE place. Only what genuinely
			// varies per socket/frame is passed here — the broadcast sink, the authenticated singer on this
			// socket, the live membership snapshot, and the idempotency ledger.
			const deps: HubDeps = buildHubDeps(app, {
				broadcast,
				actorSingerId: ws.data.singerId,
				listOnline: () => membership.here,
				listAway: () => membership.away,
				seenOp: (id) => {
					if (seenOps.has(id)) return true;
					seenOps.add(id);
					if (seenOps.size > 4096) seenOps.delete(seenOps.values().next().value!);
					return false;
				},
				// non-recording peek at the same ledger, for the validation-failure re-ack path.
				// Never inserts — a rejected op must not enter the ledger, or its resend would falsely re-ack.
				hasOp: (id) => seenOps.has(id)
			});
			const sendToOrigin = (e: ServerEvent) => ws.send(JSON.stringify(e));

			// ROOM ISOLATION. Every frame below reads or mutates the room this core is serving
			// (app.activeRoomId): `hello` replies with this room's whole state, and queue/player/telemetry
			// mutate it. Isolation is BETWEEN rooms: a socket bound to a DIFFERENT party (its session token
			// scoped it to another room) is refused the whole family, so a room-B phone can neither resync
			// room A's queue nor pause room A's song. A spectator with NO room — a TV watching the one room
			// this box serves, a phone that has not joined — is NOT foreign and passes this gate; its
			// MUTATIONS are still refused by the per-command `join the room first` / `player:control` checks
			// below, exactly as before the session-token scoping landed, while its `hello` read of the served room stays allowed.
			// binds a TV to a specific room later.
			if (isForeignRoom(ws.data.roomId, app.activeRoomId)) return; // drop the frame, reply nothing

			switch (evt.type) {
				case 'hello': {
					// resync: reply with authoritative full state to this client only (queue + playback +
					// nowplaying), so a reconnecting TV/phone resumes exactly where the room is.
					ws.send(JSON.stringify(syncEvent(state, deps)));
					ws.send(JSON.stringify({ type: 'playback:state', state: state.playback, rev: state.rev }));
					// the frame comes from player.ts's builder, the same single source of truth the
					// broadcast path uses, so a change to what nowplaying:changed carries (or to how
					// upNext is projected) reaches the reconnecting client and the live room together.
					// Hand-deriving it here was invisible to tsc — `ws.send(JSON.stringify(...))` accepts
					// anything, so only the publish-typed site was named. `syncEvent` one line above is
					// the same pattern.
					ws.send(JSON.stringify(nowPlayingEvent(deps)));
					break;
				}
				case 'queue:command':
					handleQueueCommand(evt.command, deps, sendToOrigin);
					// Reconcile after EVERY queue mutation. reconcileOnReady owns the whole decision and
					// there is nothing left to decide here — the gate this line used to
					// carry was deleted, because it was a second hand-written copy of the recovery predicate that
					// reconcileOnReady already evaluates at player.ts.
					//
					// What it does, per case:
					//  • Room IDLE and a song was just queued → auto-start it. Without this a plain
					//    (non-make-karaoke) add never triggers play: the TV sits on the attract screen
					//    forever and the phone shows no play control (no "current" entry to hang one on).
					//  • currentEntryId DANGLING → recover. A client `remove`/`status` on the PLAYING
					//    entry prunes it here and leaves the id pointing at nothing, which
					//    reads as busy to every `!currentEntryId` gate while nothing plays.
					//    reconcileOnReady advances to the next singer, or settles the room to genuinely
					//    idle if none is ready.
					//  • Current entry RESOLVES → a song is playing and no recovery is due, but the queue
					//    just changed and "who plays next" is derived from the queue. handleQueueCommand
					//    publishes `queue:patch` alone (hub.ts), and nowplaying:changed's only other
					//    producers are playback transitions — so an add/remove/move mid-song used to leave
					//    the TV holding the LAST broadcast upNext: a song since removed, or one that
					//    reordering pushed behind another singer, with `syncSlots` pre-warming the gapless
					//    slot from that same stale entry (routes/tv/+page.svelte). reconcileOnReady's
					//    recovery block is skipped and its tail emitNowPlaying re-derives both values
					//    (`upNextAfter` applies the held-slot rule, so a still-cooking entry is never
					//    advertised).
					//
					// EXACTLY ONE nowplaying:changed per command, on all three paths: the single
					// emitNowPlaying sits OUTSIDE reconcileOnReady's `if (!currentResolves)` block
					// (player.ts), which is why an unconditional call cannot double-broadcast. An
					// unconditional `emitNowPlaying` here WOULD, which is the shape an earlier fix
					// correctly rejected — a different call, not this one.
					reconcileOnReady(deps);
					// A grace clock starts when someone's last pending song leaves the queue and clears when
					// they queue another, so a queue change can move membership exactly as a socket can.
					refreshMembership();
					break;
				case 'player:command':
					// Pausing or skipping is an act on the whole room's music, so it needs an actor. Every
					// joined singer is a host today; the gate here is only that you are IN the room, which a
					// socket that never joined is not. See src/server/auth/capabilities.ts.
					if (!can({ singerId: ws.data.singerId }, 'player:control')) break;
					handlePlayerCommand(evt.command, deps);
					break;
				case 'tv:telemetry':
					handleTelemetry({ positionSec: evt.positionSec, ended: evt.status === 'ended', entryId: evt.entryId }, deps);
					break;
			}
		},
		close(ws) {
			// Worker disconnect: drop it from the registry + socket map. Its in-flight jobs keep their
			// lease and are reclaimed by the reaper on expiry (§9) — same path as a worker that died.
			if (ws.data.role === 'worker' && ws.data.workerId) {
				app.workers.remove(ws.data.workerId);
				workerSockets.delete(ws.data.workerId);
				return;
			}
			// Their last socket closing takes them out of the roster (1→0 only).
			// Their last socket closing makes them AWAY, not gone — they keep their chip, their place and
			// their songs. Expiry to `gone` is the sweep's job, once their queue is empty and the room's
			// grace window has run out.
			if (ws.data.singerId && app.presence.disconnect(ws.data.singerId, app.now())) refreshMembership();
		}
	}
});

// The room broadcast sink: publish one ServerEvent to every subscribed socket over Bun's native
// pub/sub. Defined ONCE here (server is in scope) and wired into the shared app a single time at
// boot, rather than reassigned inside websocket.open on every connect. handleQueueCommand and the
// cook-cancel path reuse this same reference through `deps`.
// publish a served-room event ONLY to that room's topic, which only that room's sockets
// subscribed to (see websocket.open) — the delivery half of isolation. The single AuthoritativeState
// this core holds is bound to app.activeRoomId, so that is the room every broadcast names.
const broadcast = (e: ServerEvent) => server.publish(broadcastTopicFor(app.activeRoomId), JSON.stringify(e));
// Route the shared app's broadcasts (e.g. singer:joined from the /api/join route) through pub/sub.
setPublish(broadcast);

// Expiry to `gone` is elapsed time, so nothing else in the process can announce it.
setInterval(refreshMembership, MEMBERSHIP_SWEEP_MS).unref?.();

console.log(
	`🎤 Encore core on http://${HOST}:${PORT}  (ws:/ws · health:/health · harness:/harness · ui:${svelteKitFetch ? 'SvelteKit' : 'not built'})`
);

// FIX 3: shout once at boot when worker upgrades are unauthenticated, so an open box is loud, not
// silent. When ENCORE_WORKER_TOKEN is set the gate is on and no warning is needed.
if (!WORKER_TOKEN) {
	console.warn(
		'[core] ENCORE_WORKER_TOKEN is not set — role=worker WS upgrades are UNAUTHENTICATED. Any device ' +
			'that can reach this port can register as a worker and receive job assignments. Set ' +
			'ENCORE_WORKER_TOKEN to require a matching `token` on the worker handshake.'
	);
}

// FIX 4: graceful shutdown. The authoritative state write-behinds on a 250ms debounce, so a
// `docker stop` landing inside that window drops the pending queue/playback write unless we flush.
// flushNow() exists precisely for this and nothing called it. Flush state, stop the reaper's timer,
// then exit cleanly. Guarded so a second signal during shutdown can't re-enter.
let shuttingDown = false;
function gracefulShutdown(signal: string): void {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(`[core] ${signal} received — flushing state and shutting down.`);
	// A failed flush is exactly the case a supervisor needs to hear about: pending queue/playback state
	// was lost. exit(0) here would tell Docker/systemd the stop was clean and falsify that signal, so the
	// catch records failure and we exit non-zero — the log line alone is invisible to an out-of-band probe.
	let ok = true;
	try {
		state.flushNow();
		app.reaper.stop();
		server.stop();
	} catch (err) {
		ok = false;
		console.error('[core] error during graceful shutdown:', err);
	}
	process.exit(ok ? 0 : 1);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ── dev harness markup (inline; not part of the SvelteKit app) ─────────────────
function harnessHtml(): string {
	return `<!doctype html><meta charset=utf-8><title>Encore — sync harness</title>
<style>body{margin:0;font-family:system-ui;background:#0b0b12;color:#f3f3fb}
h1{font-size:15px;padding:10px 14px;margin:0;background:#12121d;border-bottom:1px solid #2a2a3e}
.row{display:flex;gap:0;height:calc(100vh - 38px)}
iframe{flex:1;border:0;border-right:1px solid #2a2a3e;height:100%}</style>
<h1>🎤 Encore sync harness — add a song in either pane; it must appear in BOTH over WS</h1>
<div class=row><iframe src="/harness/phone?who=Maya"></iframe><iframe src="/harness/phone?who=Sam"></iframe></div>`;
}

function phoneHtml(): string {
	return `<!doctype html><meta charset=utf-8><title>phone</title>
<style>body{margin:0;font-family:system-ui;background:#0b0b12;color:#f3f3fb;padding:12px}
button{background:linear-gradient(135deg,#7c5cff,#ff5cae);color:#fff;border:0;border-radius:10px;padding:8px 10px;margin:2px;font-weight:700}
li{padding:6px 8px;background:#1a1a28;border:1px solid #2a2a3e;border-radius:8px;margin:4px 0;list-style:none}
.who{font-size:12px;color:#9a9ab5}pre{font-size:10px;color:#9a9ab5;white-space:pre-wrap}</style>
<div class=who id=who></div>
<div>
 <button onclick="add('demo-takeonme')">＋ Take On Me</button>
 <button onclick="add('demo-mrbrightside')">＋ Mr. Brightside</button>
 <button onclick="add('demo-dancingqueen')">＋ Dancing Queen</button>
</div>
<ul id=q></ul><pre id=raw></pre>
<script type=module>
const who = new URLSearchParams(location.search).get('who')||'me';
document.getElementById('who').textContent = 'Connected as '+who;
// minimal client-minted ULID
const ulid=()=>{const E='0123456789ABCDEFGHJKMNPQRSTVWXYZ';let t=Date.now(),s='';for(let i=9;i>=0;i--){s=E[t%32]+s;t=Math.floor(t/32)}for(let i=0;i<16;i++)s+=E[Math.floor(Math.random()*32)];return s};
let entries=[],rev=0;
const ws=new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/ws?role=phone');
ws.onopen=()=>ws.send(JSON.stringify({type:'hello',lastRev:0}));
ws.onmessage=ev=>{const e=JSON.parse(ev.data);
 if(e.type==='queue:sync'){entries=e.entries;rev=e.rev}
 if(e.type==='queue:patch'){rev=e.patch.rev}
 render()};
function add(mediaId){const id=ulid();const entry={id,mediaId,singerId:who,status:'queued',rotationSeq:9e15,addedAt:Date.now()};
 // optimistic
 entries=[...entries,entry];render();
 ws.send(JSON.stringify({type:'queue:command',command:{clientOpId:ulid(),op:{op:'add',entry}}}));}
function render(){document.getElementById('q').innerHTML=entries.map(e=>'<li>#'+e.rotationSeq+' · '+e.mediaId+' <span class=who>('+e.singerId+')</span></li>').join('');
 document.getElementById('raw').textContent='rev='+rev+'  entries='+entries.length;}
</script>`;
}
