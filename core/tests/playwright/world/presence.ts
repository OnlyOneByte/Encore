// Seeding a room's ROSTER without driving the join screen once per guest.
//
// Over HTTP plus a held socket per singer, deliberately: presence is "has an open socket", so a joined singer
// with no socket is counted away and never reaches the lobby strip. Driving the real join UI n times also does
// not update Svelte 5's bound `$state` reliably in headless, which is the trap this replaces — the TV under
// test is still a real page, so the cascade being measured is the real one.
// `ws`, not the global WebSocket: presence needs a per-singer session COOKIE on the handshake, and Node 22's
// built-in WebSocket accepts no headers — it ignores the option silently, so every socket would arrive
// anonymous and the roster would stay empty with nothing to explain why. Bun's global does support headers,
// which is why the old .mjs driver got away with it.
import { WebSocket } from 'ws';

/** 32 characters is the ceiling `SingerRepository` admits (`displayName.trim().slice(0, 32)`). */
const MAX_DISPLAY_NAME = 32;

/** The eight singer hues, in palette order. */
const HUES = ['#8b5cf6', '#ec4899', '#22c55e', '#f59e0b', '#3b82f6', '#f43f5e', '#a855f7', '#10b981'];

/**
 * Long enough to wrap the roster onto several rows at 720p, and UNIQUE per caller: the singers table is
 * append-only, so a reused name is refused with 409 and the run aborts against a confusing symptom.
 */
export function longNames(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_, i) =>
		`Guest${i}${prefix}`.padEnd(MAX_DISPLAY_NAME, 'x').slice(0, MAX_DISPLAY_NAME)
	);
}

export interface Roster {
	/** Close every held socket, so the next case's presence starts from nothing. */
	release(): Promise<void>;
}

/** Join each name and hold a phone socket for it, so the room really has these people in it. */
export async function seedRoster(baseURL: string, names: string[]): Promise<Roster> {
	const sockets: WebSocket[] = [];
	const wsBase = baseURL.replace(/^http/, 'ws');

	for (const [i, displayName] of names.entries()) {
		const res = await fetch(`${baseURL}/api/join`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ displayName, color: HUES[i % HUES.length] })
		});
		if (!res.ok) {
			throw new Error(`join failed for ${displayName}: ${res.status} ${await res.text()}`);
		}
		const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
		const ws = new WebSocket(`${wsBase}/ws?role=phone`, { headers: { Cookie: cookie } });
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener('open', () => resolve(), { once: true });
			ws.addEventListener('error', () => reject(new Error(`socket refused for ${displayName}`)), { once: true });
		});
		sockets.push(ws);
	}

	return {
		release: async () => {
			for (const ws of sockets) {
				try {
					ws.close();
				} catch {
					// already closed
				}
			}
			// Presence is evaluated on socket edges, so give the close a moment to land before the next case.
			await new Promise((r) => setTimeout(r, 300));
		}
	};
}
