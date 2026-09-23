// Encore core: one Bun process serves both SvelteKit and the realtime WS hub — no network hop,
// one in-process authoritative state. See docs/SERVER.md#authority-and-the-hub. Prod entry: bun run server.ts

// Imports below MUST stay relative: `$lib` resolves only via the gitignored .svelte-kit/tsconfig.json,
// which the runtime image never copies — an alias here type-checks locally but fails in the container.
import {
	graceMsOf,
	type ClientEvent,
	type ServerEvent,
	type Media,
	type WorkerMessage,
	type WorkerCommand
} from './src/lib/contract';
import { handleQueueCommand, syncEvent, type HubDeps } from './src/lib/server/realtime/hub';
import { handlePlayerCommand, handleTelemetry, reconcileOnReady, nowPlayingEvent } from './src/lib/server/realtime/player';
import { validateWorkerMessage } from './src/lib/server/jobs/worker-hub';
import { getApp, setPublish, buildHubDeps } from './src/lib/server/app';
import { readSessionToken } from './src/lib/server/singers/repository';
import { can } from './src/lib/server/capabilities';
import { isForeignRoom, subscribeTopicFor, broadcastTopicFor } from './src/lib/server/realtime/room-scope';
import { tvRoomId } from './src/lib/server/rooms/tv-room';
import { presentTracks, type LocalTrack } from './src/lib/server/media/local';
import { safeMediaPath } from './src/lib/server/media/local-files';
import { existsSync } from 'node:fs';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

// Shared secret gating role=worker WS upgrades: when set, a role=worker upgrade must present a
// matching `token` query param or get 401 — otherwise any LAN device could register as a worker and
// fabricate job completions. Unset means unauthenticated upgrades (boot warning below); phone/TV are unaffected.
const WORKER_TOKEN = process.env.ENCORE_WORKER_TOKEN?.trim() || null;

// Shared singleton — the SAME authoritative state instance the SvelteKit /api routes use.
const app = getApp();
const state = app.state;

// Live worker sockets keyed by workerId (in-memory, process-lifetime — workers dial home, see
// docs/ARCHITECTURE.md §10). SocketData.roomId/singerId resolve at WS upgrade from the session
// cookie, never a client claim; a worker, an unbound TV, and a not-yet-joined phone carry neither.
type SocketData = { role: string; workerId?: string; singerId?: string; roomId?: string };
type WorkerSocket = import('bun').ServerWebSocket<SocketData>;
const workerSockets = new Map<string, WorkerSocket>();
// server.ts owns the transport: the WorkerHub calls app.toWorker(id, cmd) → look up the socket.
app.toWorker = (workerId: string, cmd: WorkerCommand) => {
	workerSockets.get(workerId)?.send(JSON.stringify(cmd));
};

// Starts the job reaper's ~3s lease-expiry tick; requeues/fails jobs whose worker went silent and
// redispatches (onReaped, wired in app.ts). Runs after getApp()'s boot recovery already reconciled.
app.reaper.start();

// Dedupes resent client ops across reconnects (bounded, insertion-ordered, in-memory) so a retry
// never double-applies.
const seenOps = new Set<string>();

// Demo/harness catalog; real media is resolved via /api/search and persisted on demand. Seed only
// IDs not already present — getApp() already hydrated the durable catalog, so an unconditional set
// would stomp a previously-processed song's real stem status with this stub, forcing a reprocess.
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

// Seeds the local FTS library index in dev (a real deployment scans MEDIA_DIR instead), indexing
// only files that actually resolve on disk — unfiltered, these four were queueable but unplayable,
// burning job attempts on ffmpeg's ENOENT.
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
	// build/handler.js is svelte-adapter-bun's generated (gitignored) output — untyped, hence the cast
	// and the @ts-expect-error (not @ts-ignore, so it self-clears once the adapter ships types).
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
 * Advance membership and broadcast only if it changed. Driven by socket edges AND a timer — "gone"
 * is a function of elapsed time, so no socket event announces it; comparing against the last
 * broadcast keeps a quiet room's periodic sweep silent instead of a heartbeat every client parses.
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
		// A per-room broadcast like any other — published only to the served room's topic, so
		// another party never sees this room's roster.
		server.publish(
			broadcastTopicFor(app.activeRoomId),
			JSON.stringify({ type: 'singer:presence', online: next.here, away: next.away } satisfies ServerEvent)
		);
	}
}

// A singer's grace clock starts when their last pending song leaves the queue, so queue changes can
// move membership as surely as a socket closing. 20s balances timeliness against a per-tick scan.
const MEMBERSHIP_SWEEP_MS = 20_000;

const server = Bun.serve<SocketData>({
	port: PORT,
	hostname: HOST,
	idleTimeout: 30,

	async fetch(req, server) {
		const url = new URL(req.url);

		if (url.pathname === '/ws') {
			const role = url.searchParams.get('role') ?? 'phone';
			// A role=worker socket carries dispatch authority. Require the shared token when configured
			// and refuse an unauthenticated worker with 401 rather than upgrading it (see WORKER_TOKEN above).
			if (role === 'worker' && WORKER_TOKEN && url.searchParams.get('token') !== WORKER_TOKEN) {
				return new Response('unauthorized worker', { status: 401 });
			}
			// Resolve which singer (and room) this socket belongs to, at upgrade, from the session
			// cookie — never a client claim. No singerId means an anonymous spectator. A TV instead binds
			// via its join code (?room=<code>, same as the QR) through tvRoomId; mutations stay gated by
			// the per-command checks below regardless of how a socket resolved its room. See docs/SERVER.md#sessions-and-cookies.
			const me = app.singers.bySessionToken(readSessionToken(req.headers.get('cookie')));
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
			// Subscribe to the socket's own room topic only — isolation is between rooms, not against a
			// viewer of the one room this box serves; an unscoped spectator defaults to the served room.
			ws.subscribe(subscribeTopicFor(ws.data.roomId, app.activeRoomId));
			// Broadcast sink wired once at boot via setPublish (below), not per-connection.
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
				// role=worker carries dispatch authority and, when ENCORE_WORKER_TOKEN is unset, is
				// reachable unauthenticated. validateWorkerMessage must run before any field access below
				// — a malformed frame would otherwise throw out of this handler instead of being dropped.
				if (validateWorkerMessage(parsed) !== null) return;
				const msg = parsed as WorkerMessage;
				// Remember this socket's workerId so disconnect can deregister + free its slots.
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
			// buildHubDeps (app.ts) wires every app-derived hook in one place; only what varies per
			// socket/frame is supplied here.
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
				// Non-recording peek at the same ledger, for the validation-failure re-ack path. Never
				// inserts — a rejected op must not enter the ledger, or its resend would falsely re-ack.
				hasOp: (id) => seenOps.has(id)
			});
			const sendToOrigin = (e: ServerEvent) => ws.send(JSON.stringify(e));

			// Room isolation: every frame mutates app.activeRoomId. A socket scoped to a different room
			// is dropped outright; an unscoped spectator passes this gate but mutations stay refused below.
			if (isForeignRoom(ws.data.roomId, app.activeRoomId)) return; // drop the frame, reply nothing

			switch (evt.type) {
				case 'hello': {
					// Resync: reply with full authoritative state (queue + playback + nowplaying) to this
					// client only, so a reconnecting TV/phone resumes exactly where the room is.
					ws.send(JSON.stringify(syncEvent(state, deps)));
					ws.send(JSON.stringify({ type: 'playback:state', state: state.playback, rev: state.rev }));
					// nowPlayingEvent is the same builder the broadcast path uses, so a change to what
					// nowplaying:changed carries reaches the reconnecting client and the live room together.
					ws.send(JSON.stringify(nowPlayingEvent(deps)));
					break;
				}
				case 'queue:command':
					handleQueueCommand(evt.command, deps, sendToOrigin);
					// Reconcile after every queue mutation — reconcileOnReady (player.ts) owns the decision:
					// auto-start on idle+queued, self-heal a DANGLING currentEntryId, or just re-derive
					// upNext. Its tail emitNowPlaying fires exactly once per command outside that branch,
					// so this call site must never also emit one.
					reconcileOnReady(deps);
					// A grace clock starts when someone's last pending song leaves the queue and clears when
					// they queue another, so a queue change can move membership exactly as a socket can.
					refreshMembership();
					break;
				case 'player:command':
					// player:control requires only being IN the room — every joined singer is a host today.
					// See docs/ARCHITECTURE.md §10 and src/lib/server/capabilities.ts.
					if (!can({ singerId: ws.data.singerId }, 'player:control')) break;
					handlePlayerCommand(evt.command, deps);
					break;
				case 'tv:telemetry':
					handleTelemetry({ positionSec: evt.positionSec, ended: evt.status === 'ended', entryId: evt.entryId }, deps);
					break;
			}
		},
		close(ws) {
			// Worker disconnect: deregister + drop the socket; in-flight jobs keep their lease and are
			// reclaimed by the reaper at expiry, same as any worker that silently died.
			if (ws.data.role === 'worker' && ws.data.workerId) {
				app.workers.remove(ws.data.workerId);
				workerSockets.delete(ws.data.workerId);
				return;
			}
			// Last socket closing marks AWAY, not gone — chip, place, and songs are kept. Expiry to
			// `gone` is the sweep's job, once the queue is empty and the room's grace window has run out.
			if (ws.data.singerId && app.presence.disconnect(ws.data.singerId, app.now())) refreshMembership();
		}
	}
});

// The room broadcast sink, wired into the shared app via setPublish so /api/join's singer:joined
// (and other app-driven publishes) route through the same instance handleQueueCommand uses via `deps`.
const broadcast = (e: ServerEvent) => server.publish(broadcastTopicFor(app.activeRoomId), JSON.stringify(e));
setPublish(broadcast);

setInterval(refreshMembership, MEMBERSHIP_SWEEP_MS).unref?.();

console.log(
	`🎤 Encore core on http://${HOST}:${PORT}  (ws:/ws · health:/health · harness:/harness · ui:${svelteKitFetch ? 'SvelteKit' : 'not built'})`
);

// Loud boot warning when worker upgrades are unauthenticated, so an open box isn't silently exposed.
if (!WORKER_TOKEN) {
	console.warn(
		'[core] ENCORE_WORKER_TOKEN is not set — role=worker WS upgrades are UNAUTHENTICATED. Any device ' +
			'that can reach this port can register as a worker and receive job assignments. Set ' +
			'ENCORE_WORKER_TOKEN to require a matching `token` on the worker handshake.'
	);
}

// Graceful shutdown: state write-behinds on a 250ms debounce, so a `docker stop` landing inside that
// window would drop the pending write unless flushed here. Guarded against re-entry from a second signal.
let shuttingDown = false;
function gracefulShutdown(signal: string): void {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(`[core] ${signal} received — flushing state and shutting down.`);
	// Exit non-zero on a failed flush — exit(0) would tell the supervisor the stop was clean when
	// queue/playback state was actually lost; the log line alone isn't visible to an out-of-band probe.
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

// Dev harness markup — inline, not part of the SvelteKit app.
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
