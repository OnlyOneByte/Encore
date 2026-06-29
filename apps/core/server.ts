// Encore core — the one Bun process. HTTP (SvelteKit) + native WebSocket pub/sub hub.
// Locked in docs/MASTER-DESIGN.md §2/§2a: Bun.serve owns BOTH the SvelteKit request handler
// AND the realtime hub, so there is no network hop between layers and the in-memory
// authoritative state lives in this one process.
//
// Production entry (replaces the adapter's build/index.js):
//   build:  bun run build
//   start:  bun run server.ts

import {
	ROOM_TOPIC,
	type ClientEvent,
	type ServerEvent,
	type Media
} from '@encore/shared';
import { handleQueueCommand, syncEvent, type HubDeps } from './src/server/realtime/hub';
import { handlePlayerCommand } from './src/server/realtime/player';
import { getApp, setPublish } from './src/server/app';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

// shared singleton — the SAME authoritative state instance the SvelteKit /api routes use.
const app = getApp();
const state = app.state;

// MVP/harness media catalog. Real media is resolved via /api/search (M4) + persisted on demand.
// Seed a few youtube demos so the dev harness can add songs that validate even without yt-dlp.
const mediaById = app.mediaById;
for (const m of [
	{ id: 'demo-takeonme', source: 'youtube', sourceRef: 'djV11Xbc914', title: 'Take On Me', artist: 'a-ha', durationSec: 225, stemStatus: 'none', playMode: 'iframe' },
	{ id: 'demo-mrbrightside', source: 'youtube', sourceRef: 'gGdGFtwCNBE', title: 'Mr. Brightside', artist: 'The Killers', durationSec: 223, stemStatus: 'none', playMode: 'iframe' },
	{ id: 'demo-dancingqueen', source: 'youtube', sourceRef: 'xFrGuyw1V8s', title: 'Dancing Queen', artist: 'ABBA', durationSec: 231, stemStatus: 'none', playMode: 'iframe' }
] as Media[]) {
	mediaById.set(m.id, m);
}

// Seed the local library FTS index so the "Library" tab returns results in dev (and as a demo
// of local search). A real deployment would scan MEDIA_DIR here. The demo tracks are also added
// to mediaById so they're queue-able by id.
app.localLibrary.index([
	{ sourceRef: 'library/dont-stop-believin.mp4', title: "Don't Stop Believin'", artist: 'Journey', durationSec: 250 },
	{ sourceRef: 'library/sweet-caroline.mp4', title: 'Sweet Caroline', artist: 'Neil Diamond', durationSec: 201 },
	{ sourceRef: 'library/bohemian-rhapsody.mp4', title: 'Bohemian Rhapsody', artist: 'Queen', durationSec: 355 },
	{ sourceRef: 'library/livin-on-a-prayer.mp4', title: "Livin' on a Prayer", artist: 'Bon Jovi', durationSec: 249 }
]);

// SvelteKit handler from the Bun adapter's build output (guarded so WS still boots pre-build).
type SvelteHandler = (req: Request, server: import('bun').Server) => Response | Promise<Response>;
let svelteKitFetch: SvelteHandler | null = null;
try {
	const { getHandler } = (await import('./build/handler.js')) as { getHandler: () => { fetch: SvelteHandler } };
	svelteKitFetch = getHandler().fetch;
} catch {
	console.warn('[core] build/handler.js not found — run `bun run build`. Serving WS + /health + /harness only.');
}

const server = Bun.serve<{ role: string }>({
	port: PORT,
	hostname: HOST,
	idleTimeout: 30,

	async fetch(req, server) {
		const url = new URL(req.url);

		if (url.pathname === '/ws') {
			const role = url.searchParams.get('role') ?? 'phone';
			if (server.upgrade(req, { data: { role } })) return undefined as unknown as Response;
			return new Response('ws upgrade failed', { status: 400 });
		}
		if (url.pathname === '/health') {
			return Response.json({ ok: true, runtime: `bun ${Bun.version}`, room: ROOM_TOPIC, rev: state.rev });
		}
		// M1-C7 dev harness — two iframes + live queue JSON to eyeball cross-client sync.
		if (url.pathname === '/harness') return new Response(harnessHtml(), { headers: { 'content-type': 'text/html' } });
		if (url.pathname === '/harness/phone') return new Response(phoneHtml(), { headers: { 'content-type': 'text/html' } });

		if (svelteKitFetch) return svelteKitFetch(req, server);
		return new Response('Encore core up (WS + /health + /harness). Run `bun run build` for the UI.', {
			headers: { 'content-type': 'text/plain' }
		});
	},

	websocket: {
		open(ws) {
			ws.subscribe(ROOM_TOPIC);
			// route the shared app's broadcasts through Bun's native pub/sub (e.g. singer:joined
			// from the /api/join route reaches every socket).
			setPublish((e: ServerEvent) => server.publish(ROOM_TOPIC, JSON.stringify(e)));
		},
		message(ws, raw) {
			let evt: ClientEvent;
			try {
				evt = JSON.parse(String(raw));
			} catch {
				return;
			}
			const deps: HubDeps = {
				state,
				publish: (e: ServerEvent) => server.publish(ROOM_TOPIC, JSON.stringify(e)),
				mediaById,
				listSingers: () => app.singers.listPublic()
			};
			const sendToOrigin = (e: ServerEvent) => ws.send(JSON.stringify(e));

			switch (evt.type) {
				case 'hello':
					// resync handshake: reply with authoritative full state to this client only
					ws.send(JSON.stringify(syncEvent(state, deps)));
					break;
				case 'queue:command':
					handleQueueCommand(evt.command, deps, sendToOrigin);
					break;
				case 'player:command':
					handlePlayerCommand(evt.command, deps);
					break;
				// tv:telemetry lands in M5
			}
		},
		close() {}
	}
});

export function publishToRoom(payload: unknown): void {
	server.publish(ROOM_TOPIC, JSON.stringify(payload));
}

console.log(
	`🎤 Encore core on http://${HOST}:${PORT}  (ws:/ws · health:/health · harness:/harness · ui:${svelteKitFetch ? 'SvelteKit' : 'not built'})`
);

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
 ws.send(JSON.stringify({type:'queue:command',command:{clientOpId:ulid(),baseRev:rev,op:{op:'add',entry}}}));}
function render(){document.getElementById('q').innerHTML=entries.map(e=>'<li>#'+e.rotationSeq+' · '+e.mediaId+' <span class=who>('+e.singerId+')</span></li>').join('');
 document.getElementById('raw').textContent='rev='+rev+'  entries='+entries.length;}
</script>`;
}
