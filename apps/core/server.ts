// Encore core — the one Bun process. HTTP + native WebSocket pub/sub hub.
// This is the entry point locked in docs/MASTER-DESIGN.md §2/§2a: Bun.serve owns both
// the SvelteKit request handler AND the realtime hub, so there is no network hop between
// layers and the in-memory authoritative state lives in this process.
//
// SCAFFOLD STAGE: this stands up the WS pub/sub skeleton + a health route. The SvelteKit
// handler is wired in once `svelte-adapter-bun` is smoke-tested (see README "step one").

import { ROOM_TOPIC, type ClientEvent } from '@encore/shared';

const PORT = Number(process.env.PORT ?? 3000);

const server = Bun.serve<{ role: string }>({
  port: PORT,

  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade — phones, TV, and (later) the loopback worker all connect here.
    if (url.pathname === '/ws') {
      const role = url.searchParams.get('role') ?? 'phone';
      if (server.upgrade(req, { data: { role } })) return; // upgraded
      return new Response('ws upgrade failed', { status: 400 });
    }

    if (url.pathname === '/health') {
      return Response.json({ ok: true, runtime: `bun ${Bun.version}`, room: ROOM_TOPIC });
    }

    // TODO: hand off to SvelteKit's handler once the Bun adapter is verified.
    return new Response('Encore core is up. SvelteKit handler not yet wired.', {
      headers: { 'content-type': 'text/plain' },
    });
  },

  websocket: {
    open(ws) {
      // every client subscribes to the single room topic — native C++ fan-out.
      ws.subscribe(ROOM_TOPIC);
      console.log(`[ws] open role=${ws.data.role}`);
    },
    message(ws, raw) {
      let evt: ClientEvent;
      try {
        evt = JSON.parse(String(raw));
      } catch {
        return;
      }
      // SCAFFOLD: echo a stub ack. Real handlers (queue:command, player:command,
      // tv:telemetry, hello/resync) land with the state + rotation modules.
      console.log(`[ws] ${ws.data.role} -> ${evt.type}`);
    },
    close(ws) {
      console.log(`[ws] close role=${ws.data.role}`);
    },
  },
});

/** Broadcast helper used by the realtime hub — one native publish to the whole room. */
export function publishToRoom(payload: unknown): void {
  server.publish(ROOM_TOPIC, JSON.stringify(payload));
}

console.log(`🎤 Encore core listening on http://localhost:${PORT}  (ws: /ws, health: /health)`);
