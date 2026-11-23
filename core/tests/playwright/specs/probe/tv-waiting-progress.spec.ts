// THE TV'S WAITING TAKEOVER DRAWS THE SONG'S REAL PROGRESS, OR NONE (F4). It used to draw a fixed 62% whatever the
// song was doing. The takeover is unreachable in a normal flow (the server skips unplayable turns), so the TV's
// socket is mocked: one queued, unplayable current song, then live `media:status` frames.
// Also pinned: the title holds still as the bar appears and goes, because the bar's slot is always laid out.
// `TIMELINE_SHOTS=<dir>` writes TV 1920 stills of each state.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { overallProcessPct } from '../../../../src/lib/process-progress';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const MEDIA = { id: 'm1', source: 'local', sourceRef: 'x', title: 'Caroline', durationSec: 200, stemStatus: 'queued' };
const ENTRY = { id: 'e1', mediaId: 'm1', singerId: 's1', status: 'queued', rotationSeq: 1, addedAt: 1 };

test('the waiting bar is the live figure, or hidden, and the title never moves', async ({ world }) => {
	const shots = process.env.TIMELINE_SHOTS;
	if (shots) mkdirSync(shots, { recursive: true });
	const tv = await world.openTv();
	const sockets: { send: (m: string) => void }[] = [];
	await tv.routeWebSocket(/\/ws/, (ws) => {
		sockets.push(ws);
		ws.onMessage((raw) => {
			const m = JSON.parse(String(raw)) as { type?: string };
			if (m.type !== 'hello') return;
			const singers = [{ id: 's1', displayName: 'Maya', color: '#ff5cae' }];
			ws.send(JSON.stringify({ type: 'tv:seat', mine: true, tvOnline: true }));
			ws.send(JSON.stringify({ type: 'queue:sync', rev: 5, entries: [ENTRY], media: [MEDIA], singers }));
			ws.send(JSON.stringify({ type: 'nowplaying:changed', current: ENTRY, upNext: null }));
		});
	});
	await tv.reload();
	const waiting = tv.locator(SEL.stateWaiting);
	await expect(waiting).toBeVisible();
	const bar = waiting.locator('.process-bar');
	const titleY = async () => (await waiting.locator('.up-song').boundingBox())!.y;
	const shot = async (name: string) => {
		if (shots) await tv.screenshot({ path: join(shots, `tv-1920-waiting-${name}.png`) });
	};

	// No live status: the slot is laid out but hidden, so nothing reads as a figure.
	await expect(bar).toBeHidden();
	const y0 = await titleY();
	await shot('no-status');

	const send = (o: object) => sockets.at(-1)!.send(JSON.stringify(o));
	for (const [status, pct] of [
		['separating', 40],
		['aligning', 50]
	] as const) {
		send({ type: 'media:status', mediaId: 'm1', status, pct });
		await expect(bar).toBeVisible();
		await expect
			.poll(() => bar.locator('i').evaluate((el) => (el as HTMLElement).style.width))
			.toBe(`${overallProcessPct(status, pct)}%`);
		expect(await titleY(), `the title moved when ${status} arrived`).toBe(y0);
		await shot(`${status}-${pct}`);
	}

	send({ type: 'media:status', mediaId: 'm1', status: 'canceled', pct: 0 });
	await expect(bar).toBeHidden();
	expect(await titleY(), 'the title moved when the bar went').toBe(y0);
	await shot('canceled');
});
