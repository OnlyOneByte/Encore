// server.ts's tv:telemetry arm, driven over a real core: server.ts is the Bun.serve entry with no unit harness,
// so the only honest test of who may send a frame is a live socket. No build needed: hello is answered by the
// WS hub itself, not a SvelteKit route.
//   BE-07 (partial): a phone-app socket, even an un-joined one, could drive the playhead and (with `ended`)
//   skip the singer. The gate is on the self-declared `role`, so /ws?role=tv still passes; that stays open.
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

type Frame = { type: string; state?: { positionSec: number } };

async function open(role: string): Promise<{ ws: WebSocket; frames: Frame[] }> {
	const ws = new WebSocket(`${core.baseURL.replace(/^http/, 'ws')}/ws?role=${role}`);
	const frames: Frame[] = [];
	ws.onmessage = (m) => frames.push(JSON.parse(String(m.data)));
	await new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = reject;
	});
	return { ws, frames };
}

const settle = () => new Promise((r) => setTimeout(r, 200));

async function sendFrom(role: string, frame: object): Promise<void> {
	const { ws } = await open(role);
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

test('tv:telemetry from a phone-app socket is dropped; a role=tv socket is honoured (BE-07)', async () => {
	const frame = { type: 'tv:telemetry', status: 'playing', positionSec: 42 };
	await sendFrom('phone', frame);
	expect(await syncedPosition()).toBe(0);

	// Non-vacuous: the same frame from a TV socket does move the playhead.
	await sendFrom('tv', frame);
	expect(await syncedPosition()).toBe(42);
}, 20_000);
