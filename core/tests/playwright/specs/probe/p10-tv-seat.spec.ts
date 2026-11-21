// Proposal 10's probe, flipped. On main a /ws?role=tv socket with no cookie was told the current entry id, forged
// that song's `ended` (the singer lost their turn) and a `positionSec: 180` (every fresh phone was handed it). With
// the real TV holding the room's seat, neither a cookieless "TV" nor a second screen with a cookie moves the room.
// A live core plus the fake stems worker, because a turn only exists once a song is ready to sing.
import { test, expect } from '@playwright/test';
import { WebSocket } from 'ws';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCore, type Core } from '../../world/core';
import { seedDemoLibrary } from '../../world/seed';
import { startFakeWorker, type FakeWorker } from '../../world/workers';
import { TV_SEAT_GRACE_MS } from '../../../../src/lib/server/rooms/tv-seat';

let core: Core;
let worker: FakeWorker;
let mediaDir: string;

test.beforeAll(async () => {
	mediaDir = mkdtempSync(join(tmpdir(), 'enc-media-'));
	seedDemoLibrary(mediaDir);
	core = await startCore({ mediaDir });
	worker = await startFakeWorker({ baseURL: core.baseURL, mediaDir, core });
});

test.afterAll(async () => {
	await worker?.stop();
	await core?.stop();
	rmSync(mediaDir, { recursive: true, force: true });
});

type F = { type: string; current?: { id: string } | null; state?: { positionSec: number }; mine?: boolean };
type Sock = { ws: WebSocket; frames: F[] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** What GET /tv hands a new screen: its `encore_tv` cookie, as the name=value pair a browser sends back. */
async function loadTv(): Promise<{ cookie: string; setCookie: string }> {
	const r = await fetch(`${core.baseURL}/tv`);
	const setCookie = r.headers.getSetCookie().find((c) => c.startsWith('encore_tv=')) ?? '';
	return { cookie: setCookie.split(';')[0]!, setCookie };
}

async function open(qs: string, cookie?: string): Promise<Sock> {
	const url = `${core.baseURL.replace(/^http/, 'ws')}/ws?${qs}`;
	// `ws`, not the global WebSocket, which ignores a headers option (see world/presence.ts).
	const ws = new WebSocket(url, cookie ? { headers: { cookie } } : {});
	const frames: F[] = [];
	ws.on('message', (m) => frames.push(JSON.parse(String(m))));
	await new Promise((res, rej) => (ws.once('open', res), ws.once('error', rej)));
	ws.send(JSON.stringify({ type: 'hello', lastRev: 0 }));
	await sleep(300);
	return { ws, frames };
}

async function join_(name: string): Promise<{ id: string; cookie: string }> {
	const r = await fetch(`${core.baseURL}/api/join`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ displayName: name, color: '#e5484d' })
	});
	const body = (await r.json()) as { singer: { id: string } };
	return { id: body.singer.id, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0]! };
}

async function readyLocal(q: string, cookie: string): Promise<string> {
	for (let i = 0; i < 120; i++) {
		const b = (await (await fetch(`${core.baseURL}/api/search?q=${q}`)).json()) as Record<
			string,
			{ id: string; source: string }[]
		>;
		const hit = [...(b.ready ?? []), ...(b.processing ?? []), ...(b.results ?? [])].find((m) => m.source === 'local');
		if (hit) {
			await fetch(`${core.baseURL}/api/process`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', cookie },
				body: JSON.stringify({ mediaId: hit.id })
			});
			return hit.id;
		}
		await sleep(250);
	}
	throw new Error(`no local track for ${q}`);
}

const lastNow = (fs: F[]) => [...fs].reverse().find((f) => f.type === 'nowplaying:changed')?.current?.id;

async function playhead(): Promise<number | undefined> {
	const s = await open('role=phone');
	s.ws.close();
	return s.frames.find((f) => f.type === 'playback:state')?.state?.positionSec;
}

test('with the real TV holding the seat, no other /tv can end the song or move the playhead', async () => {
	test.setTimeout(90_000);
	const real = await loadTv();
	// The cookie is a screen's identity: page script cannot read it, it rides same-site requests only, and it is
	// a fresh random value per screen.
	expect(real.setCookie).toMatch(/; HttpOnly/i);
	expect(real.setCookie).toMatch(/; SameSite=Lax/i);
	expect(real.setCookie).toMatch(/; Path=\//i);
	expect(real.cookie).toMatch(/^encore_tv=[A-Za-z0-9_-]{32}$/);
	const second = await loadTv();
	expect(second.cookie).not.toBe(real.cookie);

	const tv = await open('role=tv', real.cookie);
	expect(tv.frames.find((f) => f.type === 'tv:seat')?.mine).toBe(true);

	const maya = await join_('Maya');
	const theo = await join_('Theo');
	const mayaWs = await open('role=phone', maya.cookie);
	const theoWs = await open('role=phone', theo.cookie);
	const media = [await readyLocal('caroline', maya.cookie), await readyLocal('prayer', maya.cookie)];
	for (let i = 0; i < 240; i++) {
		const lib = (await (await fetch(`${core.baseURL}/api/library`)).json()) as {
			library: { id: string; instrumentalRef?: string }[];
		};
		if (media.every((id) => lib.library.some((x) => x.id === id && x.instrumentalRef))) break;
		await sleep(250);
	}
	const add = (from: Sock, singerId: string, mediaId: string, id: string) =>
		from.ws.send(
			JSON.stringify({
				type: 'queue:command',
				command: {
					clientOpId: `op-${id}`,
					op: { op: 'add', entry: { id, singerId, mediaId, addedAt: Date.now(), status: 'queued' } }
				}
			})
		);
	add(mayaWs, maya.id, media[0]!, 'e-maya');
	await sleep(400);
	add(theoWs, theo.id, media[1]!, 'e-theo');
	for (let i = 0; i < 60 && lastNow(mayaWs.frames) !== 'e-maya'; i++) await sleep(250);
	expect(lastNow(mayaWs.frames)).toBe('e-maya');

	// The p10 spy (no cookie) and a second screen that loaded /tv (a cookie of its own) both forge the TV's frames.
	const spy = await open('role=tv');
	const copy = await open('role=tv', second.cookie);
	expect(spy.frames.find((f) => f.type === 'tv:seat')?.mine).toBe(false);
	expect(copy.frames.find((f) => f.type === 'tv:seat')?.mine).toBe(false);
	for (const s of [spy, copy]) {
		s.ws.send(JSON.stringify({ type: 'tv:telemetry', status: 'ended', positionSec: 1, entryId: 'e-maya' }));
		s.ws.send(JSON.stringify({ type: 'tv:telemetry', status: 'playing', positionSec: 180, entryId: 'e-maya' }));
	}
	await sleep(500);
	expect(lastNow(mayaWs.frames)).toBe('e-maya');
	expect(await playhead()).not.toBe(180);

	// Non-vacuous: the real TV's `ended` does end Maya's song.
	tv.ws.send(JSON.stringify({ type: 'tv:telemetry', status: 'ended', positionSec: 1, entryId: 'e-maya' }));
	for (let i = 0; i < 20 && lastNow(mayaWs.frames) !== 'e-theo'; i++) await sleep(100);
	expect(lastNow(mayaWs.frames)).toBe('e-theo');
	for (const s of [tv, mayaWs, theoWs, spy, copy]) s.ws.close();
});

test('the real TV gets its seat back with zero steps: on a reload, and after its cookie is cleared', async () => {
	test.setTimeout(60_000);
	const mineOf = (s: Sock) => s.frames.filter((f) => f.type === 'tv:seat').at(-1)?.mine;
	const real = await loadTv();
	const tv = await open('role=tv', real.cookie);
	// Setup, not the subject: this file shares one core, so an earlier test's TV may still be inside its grace.
	tv.ws.send(JSON.stringify({ type: 'tv:claim' }));
	await sleep(300);
	const laptop = await open('role=tv', (await loadTv()).cookie);
	expect(mineOf(tv)).toBe(true);

	// Reload: the same cookie, so the same screen.
	tv.ws.close();
	const reloaded = await open('role=tv', real.cookie);
	expect(mineOf(reloaded)).toBe(true);

	// Cookie cleared: GET /tv mints a new one, so the TV comes back as a copy, and is the newest screen when the
	// holder's grace runs out. The forgotten laptop tab, older, stays a copy.
	reloaded.ws.close();
	const fresh = await open('role=tv', (await loadTv()).cookie);
	expect(mineOf(fresh)).toBe(false);
	await sleep(TV_SEAT_GRACE_MS + 1_000);
	expect(mineOf(fresh)).toBe(true);
	expect(mineOf(laptop)).toBe(false);
	for (const s of [fresh, laptop]) s.ws.close();
});

test('the real TV gets its seat back with zero steps after a core restart, even when a copy reconnects first', async () => {
	test.setTimeout(120_000);
	const dataDir = mkdtempSync(join(tmpdir(), 'enc-data-'));
	// A file-backed DB, the shipped default: the seat holder is kept in `rooms.tv_seat`.
	const env = { ENCORE_EPHEMERAL: '0' };
	const urlOf = (c: Core) => `${c.baseURL.replace(/^http/, 'ws')}/ws?role=tv`;
	const seatOf = async (c: Core, cookie: string) => {
		const ws = new WebSocket(urlOf(c), { headers: { cookie } });
		const mine = await new Promise<boolean>((res, rej) => {
			ws.on('message', (m) => {
				const f = JSON.parse(String(m)) as F;
				if (f.type === 'tv:seat') res(f.mine!);
			});
			ws.once('error', rej);
		});
		return { ws, mine };
	};
	try {
		const first = await startCore({ mediaDir, dataDir, env });
		const cookieOf = async (c: Core) =>
			(await fetch(`${c.baseURL}/tv`)).headers
				.getSetCookie()
				.find((x) => x.startsWith('encore_tv='))!
				.split(';')[0]!;
		const real = await cookieOf(first);
		const laptop = await cookieOf(first);
		const a = await seatOf(first, real);
		const b = await seatOf(first, laptop);
		expect([a.mine, b.mine]).toEqual([true, false]);
		await first.stop();

		const second = await startCore({ mediaDir, dataDir, env });
		try {
			const copyBack = await seatOf(second, laptop);
			expect(copyBack.mine).toBe(false);
			const tvBack = await seatOf(second, real);
			expect(tvBack.mine).toBe(true);
			for (const s of [copyBack, tvBack]) s.ws.close();
		} finally {
			await second.stop();
		}
	} finally {
		rmSync(dataDir, { recursive: true, force: true });
	}
});
