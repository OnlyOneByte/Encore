// The /harness pages: two iframes and a bare WS client, for eyeballing cross-client queue sync without
// standing up the SvelteKit app. Hand-written markup rather than Svelte components ON PURPOSE — the point is
// to exercise the wire protocol with nothing of the real client in the way, so a bug here cannot be the
// client's. Kept out of server.ts because the Bun entry's job is transport, not markup.
//
// OUTSIDE THE DESIGN SYSTEM ON PURPOSE, and docs/FRONTEND.md names this file for it: every colour here is a hex
// literal, no `var(--token)` is reachable from a string the Bun entry writes, and the raw-frame `pre` below is
// 10px — under the 12px phone floor the app's own stylesheets hold. That is not a licensed exception, it is a
// page that does not ship: `server.ts` mounts /harness and /harness/phone only behind ENCORE_DEV_HARNESS=1, off
// by default on every box including a dev one. Raising the 10px would imply the rest of this file is governed.

export function harnessHtml(): string {
	return `<!doctype html><meta charset=utf-8><title>Encore — sync harness</title>
<style>body{margin:0;font-family:system-ui;background:#0b0b12;color:#f3f3fb}
h1{font-size:15px;padding:10px 14px;margin:0;background:#12121d;border-bottom:1px solid #2a2a3e}
.row{display:flex;gap:0;height:calc(100vh - 38px)}
iframe{flex:1;border:0;border-right:1px solid #2a2a3e;height:100%}</style>
<h1>🎤 Encore sync harness — add a song in either pane; it must appear in BOTH over WS</h1>
<div class=row><iframe src="/harness/phone?who=Maya"></iframe><iframe src="/harness/phone?who=Sam"></iframe></div>`;
}

export function phoneHtml(): string {
	return `<!doctype html><meta charset=utf-8><title>phone</title>
<style>body{margin:0;font-family:system-ui;background:#0b0b12;color:#f3f3fb;padding:12px}
button{background:linear-gradient(135deg,#7c5cff,#ff5cae);color:#fff;border:0;border-radius:10px;padding:8px 10px;margin:2px;font-weight:700}
li{padding:6px 8px;background:#1a1a28;border:1px solid #2a2a3e;border-radius:8px;margin:4px 0;list-style:none}
.who{font-size:12px;color:#9a9ab5}pre{font-size:10px;color:#9a9ab5;white-space:pre-wrap}</style>
<div class=who id=who></div>
<div id=add></div>
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
// One button per song this box can actually queue. These were three hardcoded ids that server.ts seeded into
// every catalog on boot; with that seed gone a fixed id would add an entry the hub refuses as unknown media.
// Built with createElement rather than innerHTML because a title is third-party text, and wired through a
// closure rather than an onclick ATTRIBUTE: this is a module script, so add() is not on window and the old
// inline onclick="add(...)" could only ever have thrown ReferenceError.
// (No backticks in here — this whole page is a TS template literal, so one would end the string.)
const host=document.getElementById('add');
fetch('/api/library').then(r=>r.json()).then(d=>{
 const songs=(d.library??[]).slice(0,6);
 if(!songs.length){host.textContent='No ready songs in the catalog. Process one, or drop files in MEDIA_DIR/library.';return}
 for(const m of songs){const b=document.createElement('button');b.textContent='＋ '+m.title;b.onclick=()=>add(m.id);host.append(b)}
}).catch(e=>{host.textContent='Could not read /api/library: '+e.message});
</script>`;
}
