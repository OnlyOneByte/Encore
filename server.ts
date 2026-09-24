// One Bun process serves both SvelteKit and the realtime WS hub — no network hop, one in-process
// authoritative state. See docs/SERVER.md#authority-and-the-hub.

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

// When set, a role=worker upgrade must present a matching `token` query param or get 401 — otherwise any
// LAN device could register as a worker and fabricate job completions. Unset means unauthenticated.
const WORKER_TOKEN = process.env.ENCORE_WORKER_TOKEN?.trim() || null;

// The SAME authoritative state instance the SvelteKit /api routes use.
const app = getApp();
const state = app.state;

// SocketData.roomId/singerId resolve at WS upgrade from the session cookie, NEVER a client claim; a
// worker, an unbound TV and a not-yet-joined phone carry neither.
type SocketData = { role: string; workerId?: string; singerId?: string; roomId?: string };
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

// Seed only IDs not already present: getApp() has hydrated the durable catalog, so an unconditional set
// would stomp a processed song's real stem status with this stub and force a reprocess.
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

// Dev only (a real deployment scans MEDIA_DIR). Indexes only files that RESOLVE on disk — unfiltered,
// a seed row is queueable but unplayable and burns job attempts on ffmpeg's ENOENT.
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
	console.warn('[core] build/handler.js not found — run `bun run build`. Serving WS + /health + /harness only.');
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

// The grace clock starts when a singer's last pending song leaves the queue, so a queue change moves
// membership as surely as a socket closing. 20s balances timeliness against a per-tick scan.
const MEMBERSHIP_SWEEP_MS = 20_000;

const server = Bun.serve<SocketData>({
	port: PORT,
	hostname: HOST,
	idleTimeout: 30,

	async fetch(req, server) {
		const url = new URL(req.url);

		if (url.pathname === '/ws') {
			const role = url.searchParams.get('role') ?? 'phone';
			// role=worker carries dispatch authority: refuse with 401 rather than upgrading it.
			if (role === 'worker' && WORKER_TOKEN && url.searchParams.get('token') !== WORKER_TOKEN) {
				return new Response('unauthorized worker', { status: 401 });
			}
			// Resolved from the session cookie at upgrade, NEVER a client claim; no singerId is an anonymous
			// spectator. A TV binds via its join code instead. Mutations stay gated per command either way.
			// See docs/SERVER.md#sessions-and-cookies.
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
		// Dev harness: two iframes + live queue JSON to eyeball cross-client sync.
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
			// Workers are NOT room subscribers: they speak the dial-home protocol, not queue events.
			if (ws.data.role === 'worker') return;
			// Own room topic only: isolation is between rooms, not against a viewer of the room this box
			// serves. An unscoped spectator defaults to the served room.
			ws.subscribe(subscribeTopicFor(ws.data.roomId, app.activeRoomId));
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
				hasOp: (id) => seenOps.has(id)
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
					handlePlayerCommand(evt.command, deps);
					break;
				case 'tv:telemetry':
					handleTelemetry({ positionSec: evt.positionSec, ended: evt.status === 'ended', entryId: evt.entryId }, deps);
					break;
			}
		},
		close(ws) {
			// In-flight jobs keep their lease and are reclaimed by the reaper at expiry, as for any worker
			// that silently died.
			if (ws.data.role === 'worker' && ws.data.workerId) {
				app.workers.remove(ws.data.workerId);
				workerSockets.delete(ws.data.workerId);
				return;
			}
			// The last socket closing marks AWAY, not gone: chip, place and songs are kept. Expiry to
			// `gone` is the sweep's job.
			if (ws.data.singerId && app.presence.disconnect(ws.data.singerId, app.now())) refreshMembership();
		}
	}
});

// Wired via setPublish so app-driven publishes route through the same instance `deps` uses.
const broadcast = (e: ServerEvent) => server.publish(broadcastTopicFor(app.activeRoomId), JSON.stringify(e));
setPublish(broadcast);

setInterval(refreshMembership, MEMBERSHIP_SWEEP_MS).unref?.();

console.log(
	`🎤 Encore core on http://${HOST}:${PORT}  (ws:/ws · health:/health · harness:/harness · ui:${svelteKitFetch ? 'SvelteKit' : 'not built'})`
);

// Loud, so an open box is not silently exposed.
if (!WORKER_TOKEN) {
	console.warn(
		'[core] ENCORE_WORKER_TOKEN is not set — role=worker WS upgrades are UNAUTHENTICATED. Any device ' +
			'that can reach this port can register as a worker and receive job assignments. Set ' +
			'ENCORE_WORKER_TOKEN to require a matching `token` on the worker handshake.'
	);
}

// State write-behinds on a 250ms debounce, so a `docker stop` inside that window drops the pending write
// unless flushed here. Guarded against re-entry from a second signal.
let shuttingDown = false;
function gracefulShutdown(signal: string): void {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(`[core] ${signal} received — flushing state and shutting down.`);
	// Non-zero on a failed flush: exit(0) would tell the supervisor the stop was clean when state was
	// actually lost, and a log line is not visible to an out-of-band probe.
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
