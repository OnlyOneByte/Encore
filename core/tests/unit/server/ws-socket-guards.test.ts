// server.ts's tv:telemetry arm, driven over a real core: server.ts is the Bun.serve entry with no unit harness,
// so the only honest test of who may send a frame is a live socket. No build needed: hello is answered by the
// WS hub itself, not a SvelteKit route.
//   BE-07: a phone-app socket, even an un-joined one, could drive the playhead and (with `ended`) skip the singer.
//   Proposal 10: so could ANY /ws?role=tv. Only the room's TV seat (a screen with an `encore_tv` cookie) is honoured.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCore, type Core } from '../../playwright/world/core';

let core: Core;
let mediaDir: string;

beforeAll(async () => {
	mediaDir = mkdtempSync(join(tmpdir(), 'enc-media-'));
	core = await startCore({ mediaDir });
}, 60_000);

afterAll(async () => {
	await core?.stop();
	rmSync(mediaDir, { recursive: true, force: true });
});

type Frame = { type: string; state?: { positionSec: number }; mine?: boolean; tvOnline?: boolean; next?: boolean };

/** A cookie in the shape GET /tv mints; the socket test needs no build, so it does not fetch the page. */
const screen = (c: string) => `encore_tv=${c.repeat(32)}`;

async function open(role: string, cookie?: string): Promise<{ ws: WebSocket; frames: Frame[] }> {
	const url = `${core.baseURL.replace(/^http/, 'ws')}/ws?role=${role}`;
	// Bun's WebSocket takes request headers; the DOM type does not know it.
	const ws = new WebSocket(url, cookie ? ({ headers: { cookie } } as unknown as string[]) : undefined);
	const frames: Frame[] = [];
	ws.onmessage = (m) => frames.push(JSON.parse(String(m.data)));
	await new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = reject;
	});
	return { ws, frames };
}

const settle = () => new Promise((r) => setTimeout(r, 200));

async function sendFrom(role: string, frame: object, cookie?: string): Promise<void> {
	const { ws } = await open(role, cookie);
	ws.send(JSON.stringify(frame));
	await settle();
	ws.close();
}

/** The playhead a fresh client is handed on hello. */
async function syncedPosition(): Promise<number> {
	const { ws, frames } = await open('phone');
	ws.send(JSON.stringify({ type: 'hello' }));
	await settle();
	ws.close();
	const pb = frames.find((f) => f.type === 'playback:state');
	if (!pb?.state) throw new Error(`no playback:state on hello; got ${frames.map((f) => f.type).join(',')}`);
	return pb.state.positionSec;
}

test('tv:telemetry is honoured only from the TV seat: not a phone, not a cookieless TV, not a copy', async () => {
	const seat = await open('tv', screen('A'));
	await settle();
	const frame = { type: 'tv:telemetry', status: 'playing', positionSec: 42 };
	await sendFrom('phone', frame);
	await sendFrom('tv', frame);
	await sendFrom('tv', frame, screen('B'));
	expect(await syncedPosition()).toBe(0);

	// Non-vacuous: the same frame from the seat does move the playhead.
	seat.ws.send(JSON.stringify(frame));
	await settle();
	expect(await syncedPosition()).toBe(42);
	expect(seat.frames.filter((f) => f.type === 'tv:seat')).toEqual([
		{ type: 'tv:seat', mine: true, tvOnline: true, next: false }
	]);

	// "Make this the TV": the copy takes the seat, the old holder is told, and only the new seat is honoured.
	const copy = await open('tv', screen('B'));
	copy.ws.send(JSON.stringify({ type: 'tv:claim' }));
	await settle();
	expect(copy.frames.filter((f) => f.type === 'tv:seat')).toEqual([
		{ type: 'tv:seat', mine: false, tvOnline: true, next: false },
		{ type: 'tv:seat', mine: true, tvOnline: true, next: false }
	]);
	expect(seat.frames.at(-1)).toEqual({ type: 'tv:seat', mine: false, tvOnline: true, next: false });
	seat.ws.send(JSON.stringify({ ...frame, positionSec: 7 }));
	await settle();
	expect(await syncedPosition()).toBe(42);
	copy.ws.send(JSON.stringify({ ...frame, positionSec: 9 }));
	await settle();
	expect(await syncedPosition()).toBe(9);
	// The TV's tab closes: the copy is told no TV is live, on the wire, as exactly these four fields.
	copy.ws.close();
	await settle();
	expect(seat.frames.at(-1)).toEqual({ type: 'tv:seat', mine: false, tvOnline: false, next: false });
	seat.ws.close();
}, 20_000);
