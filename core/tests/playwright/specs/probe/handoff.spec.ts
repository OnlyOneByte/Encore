// ONE HANDOFF MOMENT (UI-02, BE-04), in a real room. Maya is singing on the TV, Theo is next, Ana after him. Ana and
// Theo both tap skip at the same moment. The TV must put up the same "Now singing Theo" card a natural end gets,
// within half a second, and only ONE song may go: Theo's turn must survive the second tap.
//
// Before this change the TV dropped Theo straight into his lyrics with no card (the sweep's `flow-03` frame), and the
// second skip — aimed at Maya's song — advanced past Theo to Ana.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openBrowseFromHome } from '../../world/actors';
import { sendPlayerCommand, serverPlayback } from './audio-probe-support';
import type { Page } from '@playwright/test';
import type { World } from '../../world/fixtures';

async function readySong(world: World, phone: Page, query: string): Promise<void> {
	const track = await world.awaitDemoTrack(query);
	const res = await phone.request.post('/api/process', { data: { mediaId: track.id } });
	if (!res.ok()) throw new Error(`/api/process refused "${track.title}": ${res.status()}`);
	await expect
		.poll(
			async () => {
				const body = (await phone.request.get('/api/library').then((r) => r.json())) as {
					library: { id: string; instrumentalRef?: string | null }[];
				};
				return body.library.some((m) => m.id === track.id && !!m.instrumentalRef);
			},
			{ timeout: 60_000, message: `"${track.title}" never reached ready` }
		)
		.toBe(true);
}

async function queueReady(phone: Page, query: string): Promise<void> {
	await openBrowseFromHome(phone);
	await phone.locator(SEL.search).fill(query);
	await phone.locator(SEL.addTurn).first().click();
}

test('a double skip shows the handoff card for the next singer, and takes only one song', async ({ world }) => {
	const worker = await startFakeWorker(world);
	try {
		const maya = await world.openPhone('Maya');
		const theo = await world.openPhone('Theo');
		const ana = await world.openPhone('Ana');
		for (const q of ['caroline', 'believin', 'prayer']) await readySong(world, maya, q);

		const tv = await world.openTv();
		await queueReady(maya, 'caroline');
		// The evening's first song opens on its own card; wait until it has given way to the song.
		const intro = tv.locator(SEL.stateNext);
		await expect(intro).toBeVisible({ timeout: 30_000 });
		await expect(intro).toContainText('Maya');
		await expect(intro).toBeHidden({ timeout: 10_000 });
		await queueReady(theo, 'believin');
		await queueReady(ana, 'prayer');
		await expect(ana.locator(SEL.npStripTitle)).toContainText(/caroline/i);

		await expect(tv.locator('.upnext')).toContainText('Theo');
		const mayaEntry = (await serverPlayback(world.baseURL)).state.currentEntryId;
		expect(mayaEntry).not.toBeNull();
		// Ana's tap takes Maya's song. Theo's tap left his phone before the change reached it, so it still names Maya's
		// song, which has gone: it must do nothing. (Fired as a raw frame because a real second tap can land after
		// Theo's phone has already redrawn to his own song, and then it rightly skips HIS song.)
		await ana.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
		await sendPlayerCommand(theo, { cmd: 'skip', entryId: mayaEntry });

		// Within half a second of the taps, the same card a natural end gets.
		await expect(intro).toBeVisible({ timeout: 500 });
		await expect(intro).toContainText('Now singing');
		await expect(intro).toContainText('Theo');

		// One song went, not two: Theo is singing on every screen, and stays so past both round trips.
		await expect(ana.locator(SEL.npStripTitle)).toContainText(/believin/i);
		await tv.waitForTimeout(1_000);
		await expect(theo.locator(SEL.npStripTitle)).toContainText(/believin/i);
		await expect(intro).toContainText('Theo');
	} finally {
		await worker.stop();
	}
});

test('a stale tap through the strip changes nothing and tells THAT phone "That song already ended."', async ({
	world
}) => {
	const worker = await startFakeWorker(world);
	try {
		const maya = await world.openPhone('Maya');
		const theo = await world.openPhone('Theo');
		const ana = await world.openPhone('Ana');
		for (const q of ['caroline', 'believin']) await readySong(world, maya, q);
		await queueReady(maya, 'caroline');
		await queueReady(theo, 'believin');

		// Ana's socket is HELD from the moment Maya skips, so her strip still shows Maya's song when she taps.
		let hold = false;
		const held: (string | Buffer)[] = [];
		let toAna: ((m: string | Buffer) => void) | null = null;
		await ana.routeWebSocket(/\/ws/, (ws) => {
			const server = ws.connectToServer();
			toAna = (m) => ws.send(m);
			server.onMessage((m) => (hold ? held.push(m) : ws.send(m)));
			ws.onMessage((m) => server.send(m));
		});
		await ana.reload();
		await expect(ana.locator(SEL.npStripTitle)).toContainText(/caroline/i, { timeout: 15_000 });

		hold = true;
		await maya.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
		await expect(theo.locator(SEL.npStripTitle)).toContainText(/believin/i);
		await ana.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
		await ana.waitForTimeout(300);
		hold = false;
		for (const m of held.splice(0)) toAna!(m);

		await expect(ana.getByText('That song already ended.')).toBeVisible({ timeout: 3_000 });
		await expect(ana.locator(SEL.npStripTitle)).toContainText(/believin/i);
		// Only the sender is told, and Theo keeps his song.
		await expect(theo.getByText('That song already ended.')).toHaveCount(0);
		await theo.waitForTimeout(1_000);
		await expect(theo.locator(SEL.npStripTitle)).toContainText(/believin/i);
	} finally {
		await worker.stop();
	}
});
