// Encore core — the one Bun process. HTTP (SvelteKit) + native WebSocket pub/sub hub.
// Locked in docs/MASTER-DESIGN.md §2/§2a: Bun.serve owns BOTH the SvelteKit request handler
// AND the realtime hub, so there is no network hop between layers and the in-memory
// authoritative state lives in this one process.
//
// This is the PRODUCTION entry (replaces the adapter's generated build/index.js).
//   build:  bun run build      # vite build -> emits build/handler.js
//   start:  bun run server.ts  # this file, importing that handler
// In dev, `vite dev` serves the UI (HMR) but NOT this WS hub; realtime dev uses the built
// server or the M1-C7 harness. See ROADMAP M1.

import { ROOM_TOPIC, type ClientEvent } from '@encore/shared';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

// SvelteKit's request handler from the Bun adapter's build output. Guarded so the WS hub
// can still boot before a build exists (prints a hint instead of crashing).
type SvelteHandler = (req: Request, server: import('bun').Server) => Response | Promise<Response>;
let svelteKitFetch: SvelteHandler | null = null;
try {
  const { getHandler } = (await import('./build/handler.js')) as {
    getHandler: () => { fetch: SvelteHandler };
  };
  svelteKitFetch = getHandler().fetch;
} catch {
  console.warn('[core] build/handler.js not found — run `bun run build` first. Serving WS + /health only.');
}

const server = Bun.serve<{ role: string }>({
  port: PORT,
  hostname: HOST,
  idleTimeout: 30, // seconds; our WS heartbeat is well under this

  async fetch(req, server) {
    const url = new URL(req.url);

    // 1. WebSocket upgrade — phones, TV, and (later) the loopback worker connect here.
    if (url.pathname === '/ws') {
      const role = url.searchParams.get('role') ?? 'phone';
      if (server.upgrade(req, { data: { role } })) return undefined as unknown as Response;
      return new Response('ws upgrade failed', { status: 400 });
    }

    // 2. Health/liveness.
    if (url.pathname === '/health') {
      return Response.json({ ok: true, runtime: `bun ${Bun.version}`, room: ROOM_TOPIC });
    }

    // 3. Everything else -> SvelteKit (the phone remote, /join, /tv, /api/*).
    if (svelteKitFetch) return svelteKitFetch(req, server);
    return new Response('Encore core up (WS + /health). Run `bun run build` to serve the UI.', {
      headers: { 'content-type': 'text/plain' }
    });
  },

  websocket: {
    open(ws) {
      ws.subscribe(ROOM_TOPIC); // native C++ fan-out topic
      console.log(`[ws] open role=${ws.data.role}`);
    },
    message(ws, raw) {
      let evt: ClientEvent;
      try {
        evt = JSON.parse(String(raw));
      } catch {
        return;
      }
      // SCAFFOLD: real handlers (queue:command, player:command, tv:telemetry, hello/resync)
      // land in M1 with the in-memory state + rotation modules.
      console.log(`[ws] ${ws.data.role} -> ${evt.type}`);
    },
    close(ws) {
      console.log(`[ws] close role=${ws.data.role}`);
    }
  }
});

/** Broadcast helper used by the realtime hub — one native publish to the whole room. */
export function publishToRoom(payload: unknown): void {
  server.publish(ROOM_TOPIC, JSON.stringify(payload));
}

console.log(
  `🎤 Encore core on http://${HOST}:${PORT}  (ws:/ws · health:/health · ui:${svelteKitFetch ? 'SvelteKit' : 'not built'})`
);
