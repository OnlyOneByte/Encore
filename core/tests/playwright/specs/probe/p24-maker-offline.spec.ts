// PROPOSAL 24, PR 1: WITH NO KARAOKE MAKER, THE ROOM KNOWS BEFORE ANYONE PICKS. The phones and the TV learned "no maker"
// only from a turn that had already died, so the first pick of an offline night always failed. `queue:sync` now
// carries `canMake`, one boolean, and the TV lobby says "Can't make new karaoke right now" from it with nothing
// queued. Two nights: the worker never connects (said once the 10 s boot grace runs out), and the worker drops
// mid-night (said after the same grace from the loss).
// `MAKER_SHOTS=<dir>` also writes TV 1920 and phone 390 and 320 stills.
import type { Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openBrowseFromHome } from '../../world/actors';

const NO_MAKER = "Can't make new karaoke right now";
const NO_MAKER_NEXT = 'Pick a ready song on your phone';
const WAITING = 'Waiting for someone to pick a song';
/** The hub's MAKER_GRACE_MS, plus one broadcast and a loaded host. */
const AFTER_GRACE_MS = 20_000;
/** One broadcast: a worker's hello turns it straight back on. */
const ONE_BROADCAST_MS = 5_000;

const shotsDir = process.env.MAKER_SHOTS;
if (shotsDir) mkdirSync(shotsDir, { recursive: true });
async function shoot(page: Page, name: string): Promise<void> {
	if (shotsDir) await page.screenshot({ path: join(shotsDir, `${name}.png`) });
}
/** The phone's Sing tab at 390 and at 320, unchanged by this PR (its copy moves in PR 2). */
async function shootPhone(phone: Page, name: string): Promise<void> {
	if (!shotsDir) return;
	await openBrowseFromHome(phone);
	await shoot(phone, `phone-390-${name}`);
	await phone.setViewportSize({ width: 320, height: 568 });
	await shoot(phone, `phone-320-${name}`);
	await phone.setViewportSize({ width: 390, height: 844 });
}

/** The first `queue:sync` a fresh socket is sent, as a guest's phone receives it. */
async function firstSync(phone: Page): Promise<Record<string, unknown>> {
	return phone.evaluate(
		() =>
			new Promise<Record<string, unknown>>((resolve) => {
				const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?role=phone`);
				ws.onopen = () => ws.send(JSON.stringify({ type: 'hello' }));
				ws.onmessage = (ev: MessageEvent<string>) => {
					const m = JSON.parse(ev.data) as Record<string, unknown>;
					if (m.type === 'queue:sync') {
						ws.close();
						resolve(m);
					}
				};
			})
	);
}

test('with no worker ever connected, the TV lobby says so before anyone picks, and a worker turns it off', async ({
	world
}) => {
	test.setTimeout(120_000);
	const tv = await world.openTv();
	const maya = await world.openPhone('Maya');
	const lobby = tv.locator(SEL.lobby);
	// Boot counts as a loss, so it says so once the boot grace has run out: a core restart is not a "can't make".
	await expect(lobby, 'nothing is queued, so only the room verdict can say this').toContainText(NO_MAKER, {
		timeout: AFTER_GRACE_MS
	});
	await expect(lobby).toContainText(NO_MAKER_NEXT);

	// The verdict rides the sync as one boolean, and nothing about the workers rides with it.
	const sync = await firstSync(maya);
	expect(sync.canMake).toBe(false);
	expect(Object.keys(sync).filter((k) => /worker|host/i.test(k))).toEqual([]);
	await shoot(tv, 'tv-1920-no-maker-from-start');
	await shootPhone(maya, 'sing-no-maker-from-start');

	const worker = await startFakeWorker(world);
	try {
		await expect(lobby).toContainText(WAITING, { timeout: ONE_BROADCAST_MS });
		await expect(lobby).not.toContainText(NO_MAKER);
		expect((await firstSync(maya)).canMake).toBe(true);
		await shoot(tv, 'tv-1920-maker-joined');
	} finally {
		await worker.stop();
	}
});

test('a worker that drops mid-night: nothing changes inside the grace, then the TV lobby says so, and back', async ({
	world
}) => {
	test.setTimeout(150_000);
	let worker = await startFakeWorker(world);
	const tv = await world.openTv();
	const maya = await world.openPhone('Maya');
	const lobby = tv.locator(SEL.lobby);
	try {
		await expect(lobby).toContainText(WAITING);
		await shoot(tv, 'tv-1920-maker-online');
		await shootPhone(maya, 'sing-maker-online');

		// A blip: the worker is back inside the grace, so no screen ever said "can't make".
		await worker.stop();
		worker = await startFakeWorker(world);
		const blipEnd = Date.now() + 12_000;
		while (Date.now() < blipEnd) {
			expect(await lobby.innerText(), 'a reconnect inside the grace must change nothing on screen').not.toContain(
				NO_MAKER
			);
			await tv.waitForTimeout(500);
		}

		// Gone for good: the lobby holds still through the grace, then says it, before anyone has picked.
		await worker.stop();
		const lost = Date.now();
		await expect(lobby).toContainText(NO_MAKER, { timeout: AFTER_GRACE_MS });
		expect(Date.now() - lost, 'not before the 10 s grace').toBeGreaterThanOrEqual(9_000);
		await expect(lobby).toContainText(NO_MAKER_NEXT);
		expect((await firstSync(maya)).canMake).toBe(false);
		await shoot(tv, 'tv-1920-maker-dropped');
		await shootPhone(maya, 'sing-maker-dropped');

		worker = await startFakeWorker(world);
		await expect(lobby).toContainText(WAITING, { timeout: ONE_BROADCAST_MS });
	} finally {
		await worker.stop();
	}
});
