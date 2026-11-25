// One Bun process serves both SvelteKit and the realtime WS hub — no network hop, one in-process
// authoritative state. See docs/SERVER.md#authority-and-the-hub.

// Imports below MUST stay relative: `$lib` resolves only via the gitignored .svelte-kit/tsconfig.json,
// which the runtime image never copies — an alias here type-checks locally but fails in the container.
import {
	graceMsOf,
	roomTvTopic,
	type ClientEvent,
	type ServerEvent,
	type WorkerMessage,
	type WorkerCommand
} from './src/lib/contract';
import { handleQueueCommand, syncEvent, type HubDeps } from './src/lib/server/realtime/hub';
import {
	handlePlayerCommand,
	handleTelemetry,
	onTvHello,
	reconcileOnReady,
	nowPlayingEvent
} from './src/lib/server/realtime/player';
import { validateWorkerMessage } from './src/lib/server/jobs/worker-hub';
import { releaseWorkerSocket } from './src/lib/server/jobs/worker-sockets';
import {
	resolveWorkerToken,
	workerTokenFile,
	workerTokenMatches,
	workerTokenProblem
} from './src/lib/server/jobs/worker-token';
import { IN_CONTAINER } from './src/lib/server/in-container';
import { getApp, setPublish, buildHubDeps } from './src/lib/server/app';
import { readSessionToken } from './src/lib/server/singers/repository';
import { can } from './src/lib/server/capabilities';
import { isForeignRoom, subscribeTopicFor, broadcastTopicFor, tvTopicFor } from './src/lib/server/realtime/room-scope';
import { createReactionLimiter, handleReaction } from './src/lib/server/realtime/reactions';
import { clockFrame, pongFrame, serverNow } from './src/lib/server/realtime/tv-clock';
import { tvRoomId } from './src/lib/server/rooms/tv-room';
import { TvSeats, tvIdOf, type SeatNotice } from './src/lib/server/rooms/tv-seat';
import { SingerSockets } from './src/lib/server/realtime/singer-sockets';
import { harnessHtml, phoneHtml } from './src/lib/server/dev-harness';
import { refreshDefaultRoute, startupAddress } from './src/lib/server/public-origin';
import { fromOurOrigin } from './src/lib/server/http/same-origin';
import { refuseForeignHost, requestUrl, unreadableHost } from './src/lib/server/http/allowed-host';
import { adminTokenProblem } from './src/lib/server/host-key';

/** The /harness pages are a manual debugging tool, not a feature. Read once so the routes below cannot
 *  disagree with the banner about whether they are mounted. */
const DEV_HARNESS = process.env.ENCORE_DEV_HARNESS === '1';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

// A role=worker upgrade must present a matching `token` query param or get 401 — otherwise any LAN device
// could register as a worker and fabricate job completions. Unset, core makes one in a file the worker reads.
const workerToken = resolveWorkerToken(process.env.ENCORE_WORKER_TOKEN, workerTokenFile(), IN_CONTAINER);
const WORKER_TOKEN = workerToken.token;

// Refused before anything boots: a short fixed key or worker token is one a LAN device could guess.
const refusals = [
	adminTokenProblem(process.env.ENCORE_ADMIN_TOKEN),
	workerTokenProblem(process.env.ENCORE_WORKER_TOKEN),
	workerToken.refusal
].filter(Boolean);
for (const refusal of refusals) console.error(`[core] ${refusal}`);
if (refusals.length) process.exit(1);

// The SAME authoritative state instance the SvelteKit /api routes use.
const app = getApp();
const state = app.state;

// SocketData.roomId/singerId resolve at WS upgrade from the session cookie, NEVER a client claim; a
// worker, an unbound TV and a not-yet-joined phone carry neither.
// A TV also carries `tvId` (its screen, from the `encore_tv` cookie) and `tvKey` (this socket, for the seat).
type SocketData = {
	role: string;
	workerId?: string;
	singerId?: string;
	/** The cookie's token, re-checked at open: a Leave can land between the upgrade and the open. */
	sessionToken?: string;
	roomId?: string;
	tvId?: string;
	tvKey?: number;
};
type WorkerSocket = import('bun').ServerWebSocket<SocketData>;
const workerSockets = new Map<string, WorkerSocket>();
// server.ts owns the transport: the WorkerHub calls app.toWorker(id, cmd).
app.toWorker = (workerId: string, cmd: WorkerCommand) => {
	workerSockets.get(workerId)?.send(JSON.stringify(cmd));
};

// Runs AFTER getApp()'s boot recovery has already reconciled. See docs/SERVER.md#the-attempt-ledger.
app.reaper.start();

// Dedupes resent client ops across reconnects, so a retry never double-applies.
const seenOps = new Set<string>();

// One bucket per singer for `room:react`, shared across that singer's sockets so a second tab buys no extra taps.
const reactionLimiter = createReactionLimiter(() => app.now());

// One TV per room: only the seat's socket may end the song or move the playhead. See src/lib/server/rooms/tv-seat.ts.
const tvSeats = new TvSeats({
	load: (roomId) => app.rooms.tvSeat(roomId),
	save: (roomId, holder) => app.rooms.setTvSeat(roomId, holder),
	now: () => app.now(),
	schedule: (ms, run) => setTimeout(run, ms).unref?.(),
	announce: (notices) => announceSeat(notices)
});
const tvSockets = new Map<number, import('bun').ServerWebSocket<SocketData>>();
let nextTvKey = 0;
function announceSeat(notices: SeatNotice[]): void {
	for (const n of notices) {
		const e = { type: 'tv:seat', mine: n.mine, tvOnline: n.tvOnline } satisfies ServerEvent;
		tvSockets.get(n.key)?.send(JSON.stringify(e));
	}
}
// A Leave reaches every socket of the leaver, not just the tab that asked (src/lib/server/realtime/singer-sockets.ts).
const singerSockets = new SingerSockets<import('bun').ServerWebSocket<SocketData>>();
app.releaseSinger = (singerId) => singerSockets.release(singerId);

/** Is this socket THE room's TV (it holds the seat)? A copy is not, and nothing it sends moves the room. */
function seated(ws: import('bun').ServerWebSocket<SocketData>): boolean {
	return ws.data.tvKey !== undefined && tvSeats.holds(ws.data.roomId!, ws.data.tvKey);
}

// Guarded so WS still boots pre-build.
type SvelteHandler = (req: Request, server: import('bun').Server<SocketData>) => Response | Promise<Response>;
let svelteKitFetch: SvelteHandler | null = null;
try {
	// Generated, gitignored, untyped adapter output. @ts-expect-error not @ts-ignore, so it self-clears
	// once the adapter ships types.
	// @ts-expect-error — generated, untyped adapter output; shape asserted by the cast below
	const { getHandler } = (await import('./build/handler.js')) as { getHandler: () => { fetch: SvelteHandler } };
	svelteKitFetch = getHandler().fetch;
} catch {
	console.warn('[core] build/handler.js not found — run `bun run build`. Serving WS + /health only.');
}

// `here` holds a socket; `away` is in the room but unreachable, and is still counted.
let membership = { here: [] as string[], away: [] as string[] };

/** A singer holds a stake in the room while any entry of theirs is still waiting to be sung. */
function hasPendingSongs(singerId: string): boolean {
	return state.entries.some((e) => e.singerId === singerId && (e.status === 'queued' || e.status === 'playing'));
}

/** Driven by socket edges AND a timer, because "gone" is a function of elapsed time and no socket event
 *  announces it. Comparing against the last broadcast keeps a quiet room's sweep silent. */
function refreshMembership(): void {
	const next = app.presence.evaluate({
		now: app.now(),
		graceMs: graceMsOf(app.settings.getRoom(app.activeRoomId).presenceGraceMinutes),
		hasPendingSongs
	});
	const same = next.here.join() === membership.here.join() && next.away.join() === membership.away.join();
	membership = { here: next.here, away: next.away };
	if (!same) {
		// Published only to the served room's topic, so another party never sees this roster.
		server.publish(
			broadcastTopicFor(app.activeRoomId),
			JSON.stringify({ type: 'singer:presence', online: next.here, away: next.away } satisfies ServerEvent)
		);
	}
}

// A hook for the same reason app.toWorker is one: the SvelteKit route bundle shares the app INSTANCE via
// the Symbol.for('encore.app') global but not this module's scope, so a route (/api/leave) cannot reach
// `membership` or the function above. Anything that changes who is in the room without a socket edge has to
// say so, or the next hello reply is built from a cache that still lists them.
app.refreshMembership = refreshMembership;

// The grace clock starts when a singer's last pending song leaves the queue, so a queue change moves
// membership as surely as a socket closing. 20s balances timeliness against a per-tick scan.
const MEMBERSHIP_SWEEP_MS = 20_000;

const server = Bun.serve<SocketData>({
	port: PORT,
	hostname: HOST,
	idleTimeout: 30,

	async fetch(req, server) {
		const url = requestUrl(req);
		if (!url) return unreadableHost();
		// Before every route, SvelteKit's included, so a DNS-rebinding page reaches nothing.
		const foreign = refuseForeignHost(req, url);
		if (foreign) return foreign;

		if (url.pathname === '/ws') {
			const role = url.searchParams.get('role') ?? 'phone';
			// CORS does not cover a WebSocket, so a page on another site could otherwise open one with this phone's cookie.
			if (!fromOurOrigin(req, url)) return new Response('websocket from another site refused', { status: 403 });
			// role=worker carries dispatch authority: refuse with 401 rather than upgrading it.
			if (role === 'worker' && WORKER_TOKEN && !workerTokenMatches(url.searchParams.get('token'), WORKER_TOKEN)) {
				return new Response('unauthorized worker', { status: 401 });
			}
			// Resolved from the session cookie at upgrade, NEVER a client claim; no singerId is an anonymous
			// spectator. A TV binds via its join code instead. Mutations stay gated per command either way.
			// See docs/SERVER.md#sessions-and-cookies.
			const sessionToken = readSessionToken(req.headers.get('cookie'));
			app.people.seenOnSocket(req.headers.get('cookie'), app.now());
			const me = app.singers.bySessionToken(sessionToken);
			const roomId =
				role === 'tv'
					? tvRoomId(url.searchParams.get('room'), (code) => app.rooms.byCode(code), app.activeRoomId)
					: me?.roomId;
			const tvId = role === 'tv' ? tvIdOf(req.headers.get('cookie')) : undefined;
			if (server.upgrade(req, { data: { role, singerId: me?.id, sessionToken, roomId, tvId } }))
				return undefined as unknown as Response;
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
		// Two iframes + live queue JSON, to eyeball cross-client sync. OPT-IN, and off by default on every box
		// including a dev one: it is an unauthenticated page that mints queue commands, so it is a tool you ask
		// for rather than a surface that happens to be there. `ENCORE_DEV_HARNESS=1 bun run start`.
		if (DEV_HARNESS) {
			if (url.pathname === '/harness') return new Response(harnessHtml(), { headers: { 'content-type': 'text/html' } });
			if (url.pathname === '/harness/phone')
				return new Response(phoneHtml(), { headers: { 'content-type': 'text/html' } });
		}

		if (svelteKitFetch) return svelteKitFetch(req, server);
		return new Response('Encore core up (WS + /health). Run `bun run build` for the UI.', {
			headers: { 'content-type': 'text/plain' }
		});
	},

	websocket: {
		open(ws) {
			// Workers are NOT room subscribers: they speak the dial-home protocol, not queue events.
			if (ws.data.role === 'worker') return;
			// A Leave that landed after the upgrade ended this token, so the socket opens as a spectator.
			singerSockets.bindAtOpen(ws, (token) => app.singers.bySessionToken(token));
			// Own room topic only: isolation is between rooms, not against a viewer of the room this box
			// serves. An unscoped spectator defaults to the served room.
			ws.subscribe(subscribeTopicFor(ws.data.roomId, app.activeRoomId));
			// TVs ALSO hear the TV-only topic; a phone never subscribes to it, so it cannot receive `room:reacted`.
			const tvTopic = tvTopicFor(ws.data.role, ws.data.roomId, app.activeRoomId);
			if (tvTopic) ws.subscribe(tvTopic);
			if (ws.data.role === 'tv' && ws.data.roomId) {
				ws.data.tvKey = ++nextTvKey;
				tvSockets.set(ws.data.tvKey, ws);
				announceSeat(tvSeats.connect(ws.data.roomId, ws.data.tvKey, ws.data.tvId));
			}
			// Announce only on the 0→1 transition, so a second tab does not spam an unchanged roster.
			if (ws.data.singerId && app.presence.connect(ws.data.singerId)) refreshMembership();
		},
		message(ws, raw) {
			// A separate message family, on role=worker sockets only.
			if (ws.data.role === 'worker') {
				let parsed: unknown;
				try {
					parsed = JSON.parse(String(raw));
				} catch {
					return;
				}
				// validateWorkerMessage MUST run before any field access: this family carries dispatch
				// authority and is reachable unauthenticated, so a malformed frame would throw out of here.
				if (validateWorkerMessage(parsed) !== null) return;
				const msg = parsed as WorkerMessage;
				// Remembered so disconnect can deregister and free its slots.
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
			// buildHubDeps (app.ts) wires every app-derived hook; only per-socket values are supplied here.
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
				// NON-recording, for the validation-failure re-ack path: a rejected op must not enter the
				// ledger, or its own resend would falsely re-ack.
				hasOp: (id) => seenOps.has(id),
				// THE TV, not any copy: a copy's frames are dropped, so it could neither fail a song nor release a hold.
				tvConnected: () => tvSeats.hasLiveHolder(app.activeRoomId)
			});
			const sendToOrigin = (e: ServerEvent) => ws.send(JSON.stringify(e));

			// Every frame mutates app.activeRoomId, so a socket scoped to a different room is dropped
			// outright. An unscoped spectator passes this gate but stays refused below.
			if (isForeignRoom(ws.data.roomId, app.activeRoomId)) return; // drop the frame, reply nothing

			switch (evt.type) {
				case 'hello': {
					// Full authoritative state, to THIS client only.
					ws.send(JSON.stringify(syncEvent(state, deps)));
					ws.send(JSON.stringify({ type: 'playback:state', state: state.playback, rev: state.rev }));
					// The same builder the broadcast path uses, so a resync and the live room cannot differ.
					ws.send(JSON.stringify(nowPlayingEvent(deps)));
					// A hold whose fallback came with no TV to play it starts with this TV, from 0 (see player.ts). The seat
					// only: a copy's hello must not start a song it cannot report on.
					if (seated(ws)) onTvHello(deps);
					break;
				}
				case 'queue:command':
					handleQueueCommand(evt.command, deps, sendToOrigin);
					// reconcileOnReady owns the decision. Its tail emitNowPlaying fires exactly once per
					// command, so this call site must never also emit one.
					reconcileOnReady(deps);
					// A queue change can move membership exactly as a socket can (see AWAY_GRACE).
					refreshMembership();
					break;
				case 'player:command':
					// player:control requires only being IN the room; see src/lib/server/capabilities.ts.
					if (!can({ singerId: ws.data.singerId }, 'player:control')) break;
					handlePlayerCommand(evt.command, deps, sendToOrigin);
					break;
				case 'tv:telemetry': {
					// Only from the room's TV seat: a phone-app socket's `ended` was a free skip and its position a free seek, and
					// a second /tv (a guest reading along, a forgotten tab) is a copy whose frames would fight the real TV's.
					// The same holds for `failed` and `resume`: only the seated TV can fail a song or release its hold.
					if (!seated(ws)) break;
					const clock = clockFrame(evt, state.playback, serverNow());
					handleTelemetry(
						{
							positionSec: evt.positionSec,
							ended: evt.status === 'ended',
							failed: evt.status === 'failed',
							resume: evt.status === 'resume',
							entryId: evt.entryId
						},
						deps
					);
					// `ws.publish` skips the sender, so only the copies hear the seat's clock.
					if (clock) ws.publish(roomTvTopic(app.activeRoomId), JSON.stringify(clock));
					break;
				}
				case 'tv:ping': {
					// Any TV screen may time its offset; the answer goes to it alone and moves nothing.
					if (ws.data.role !== 'tv') break;
					const pong = pongFrame(evt.t0, serverNow());
					if (pong) ws.send(JSON.stringify(pong));
					break;
				}
				case 'tv:claim':
					if (ws.data.tvKey !== undefined) announceSeat(tvSeats.claim(ws.data.roomId!, ws.data.tvKey));
					// The new seat is the TV now: a hold left waiting for one starts here, as on the seat's hello.
					if (seated(ws)) onTvHello(deps);
					break;
				case 'room:react': {
					const current = state.entries.find((e) => e.id === state.playback.currentEntryId);
					const sent = handleReaction(evt.kind, {
						actorSingerId: ws.data.singerId,
						currentSingerId: current?.singerId ?? null,
						isEnabled: () => app.settings.getRoom(app.activeRoomId).tvReactions,
						colorOf: (id) => app.singers.byId(id)?.color ?? null,
						limiter: reactionLimiter,
						// The TV topic, NEVER `broadcast`: phones are not subscribed to it.
						publishToTv: (e) => server.publish(roomTvTopic(app.activeRoomId), JSON.stringify(e))
					});
					// A count for the singer's night, never who cheered.
					if (sent && current) app.nights.cheered(current.id);
					break;
				}
			}
		},
		close(ws) {
			// In-flight jobs keep their lease and are reclaimed by the reaper at expiry, as for any worker
			// that silently died.
			// Only the CURRENT socket deregisters: a reconnect's hello can land before the old socket's close, and
			// that stale close must not forget the live worker (its heartbeats cannot bring it back).
			if (ws.data.role === 'worker' && ws.data.workerId) {
				// Through the hub, so a worker taking the last copy of a capability with it re-tells "no maker".
				const workerId = ws.data.workerId;
				app.workerHub.workerLeft(() => releaseWorkerSocket(workerSockets, app.workers, workerId, ws));
				return;
			}
			if (ws.data.tvKey !== undefined) {
				tvSockets.delete(ws.data.tvKey);
				announceSeat(tvSeats.disconnect(ws.data.roomId!, ws.data.tvKey));
			}
			singerSockets.remove(ws);
			// The last socket closing marks AWAY, not gone: chip, place and songs are kept. Expiry to
			// `gone` is the sweep's job. A socket released by a Leave has no singer by now, so it marks nothing.
			if (ws.data.singerId && app.presence.disconnect(ws.data.singerId, app.now())) refreshMembership();
		}
	}
});

// Wired via setPublish so app-driven publishes route through the same instance `deps` uses.
const broadcast = (e: ServerEvent) => server.publish(broadcastTopicFor(app.activeRoomId), JSON.stringify(e));
setPublish(broadcast);

setInterval(refreshMembership, MEMBERSHIP_SWEEP_MS).unref?.();

// State write-behinds on a 250ms debounce, so a `docker stop` inside that window drops the pending write
// unless flushed here. A second signal exits at once.
const SHUTDOWN_DELETE_WAIT_MS = 5_000;
let shuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
	if (shuttingDown) {
		console.warn(`[core] second ${signal}: exiting without waiting.`);
		process.exit(1);
	}
	shuttingDown = true;
	console.log(`[core] ${signal} received — flushing state and shutting down.`);
	// Non-zero on a failed flush: exit(0) would tell the supervisor the stop was clean when state was
	// actually lost, and a log line is not visible to an out-of-band probe.
	let ok = true;
	try {
		// Before the state flush, since a delete also removes its queue entries. Awaited, but capped: each
		// re-reads Keep behind the song's writes, and a stalled disk must not hold the state flush.
		const unfinished = await app.pendingDeletes.flush(SHUTDOWN_DELETE_WAIT_MS);
		if (unfinished.length) console.warn(`[core] deletes not finished at shutdown: ${unfinished.join(', ')}`);
		state.flushNow();
		app.reaper.stop();
		server.stop();
	} catch (err) {
		ok = false;
		console.error('[core] error during graceful shutdown:', err);
	}
	process.exit(ok ? 0 : 1);
}
// Registered before the awaited route read below, so a stop during startup still flushes state.
process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => void gracefulShutdown('SIGINT'));

// The address phones should open, from the same pick as the TV's QR. `0.0.0.0` is not one, so it is only the fallback.
// The route is read first so the line ranks the home network over a VM bridge.
await refreshDefaultRoute();
console.log(
	`🎤 Encore on ${startupAddress() ?? `http://${HOST}:${PORT}`} (open /tv on the TV)  (ws:/ws · health:/health${DEV_HARNESS ? ' · harness:/harness' : ''} · ui:${svelteKitFetch ? 'SvelteKit' : 'not built'})`
);

// The only place the minted host key is ever written. It rides in the fragment, which no browser sends to a server.
// A specific bind is the only address that answers, unless a join address is declared (a proxy in front).
const boundOrigin = ['0.0.0.0', '::', ''].includes(HOST)
	? null
	: `http://${HOST.includes(':') ? `[${HOST}]` : HOST}:${PORT}`;
const declaredOrigin = app.settings.getGlobal().joinOrigin || process.env.ENCORE_PUBLIC_ORIGIN?.trim();
const hostLink = `${(boundOrigin && !declaredOrigin ? boundOrigin : startupAddress()) ?? boundOrigin ?? `http://localhost:${PORT}`}/host#k=`;
const bootKey = app.hostKey.takeBootKey();
console.log(
	bootKey
		? `[core] Host link: ${hostLink}${bootKey}  (open it on the host's phone to unlock Settings; a new one is made at every start)`
		: `[core] Host link: ${hostLink}<your ENCORE_ADMIN_TOKEN>`
);

if (workerToken.note) console.log(`[core] ${workerToken.note}`);
// Loud, so an open box is not silently exposed.
if (!WORKER_TOKEN) {
	console.warn(
		'[core] No worker token — role=worker WS upgrades are UNAUTHENTICATED. Any device that can reach this ' +
			'port can register as a worker and receive job assignments. Set ENCORE_WORKER_TOKEN, or make ' +
			"core's worker token file writable (its path is in the worker token line)."
	);
}
