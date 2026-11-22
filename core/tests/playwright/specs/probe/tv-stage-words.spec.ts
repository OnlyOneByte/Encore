// THE STAGE IS FOR THE ROOM (proposal 09). A join address no phone can open is the HOST's problem, so the TV says so
// on the empty-room screens where the host is setting up — attract and the lobby — and never over a song, where the
// room is watching. The world binds core to 127.0.0.1 with no party address set, so the advertised address is
// loopback by default: the precondition is the fixture's own, and the first claim asserts it rather than assumes it.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openBrowseFromHome } from '../../world/actors';

const NOTICE = "Phones can't open this address";
const FIX = 'Fix it in Settings -> This machine';

test('the unreachable-address notice shows on attract and the lobby, and never on the stage', async ({ world }) => {
	const tv = await world.openTv();
	await tv.locator(SEL.tvConnected).waitFor({ state: 'attached', timeout: 20_000 });

	// ATTRACT: nobody here yet. This is also the premise — without the notice here, the address was routable and
	// the stage's silence below would prove nothing.
	await expect(tv.locator(SEL.attract)).toBeVisible({ timeout: 20_000 });
	await expect(tv.locator(SEL.badQrTitle), 'attract does not tell the host phones cannot join').toHaveText(NOTICE);
	await expect(tv.locator(SEL.badQrFix)).toHaveText(FIX);

	// LOBBY: someone joined, nothing queued — still the empty room, still the host's screen.
	const worker = await startFakeWorker(world);
	try {
		const phone = await world.openPhone('StageWords');
		await expect(tv.locator(SEL.lobby)).toBeVisible({ timeout: 20_000 });
		await expect(tv.locator(SEL.badQrTitle), 'the lobby lost the host notice').toHaveText(NOTICE);

		// THE STAGE: a song plays. The corner join card is there (non-vacuity), the notice is not.
		const track = await world.awaitDemoTrack('caroline');
		const res = await phone.request.post('/api/process', { data: { mediaId: track.id } });
		expect(res.ok(), `/api/process refused: ${res.status()}`).toBe(true);
		await openBrowseFromHome(phone);
		await phone.locator(SEL.search).fill('caroline');
		await phone.locator(SEL.addTurn).first().click({ timeout: 60_000 });
		await expect(tv.locator(SEL.lowerThird)).toBeVisible({ timeout: 30_000 });
		await expect(tv.locator('.corner').first(), 'no corner join card on the stage').toBeVisible();
		await expect(tv.locator(SEL.badQr), 'the stage shows the host notice over a song').toHaveCount(0);
		await expect(tv.locator('.tv'), 'the stage shows the host notice text').not.toContainText(NOTICE);
		// The fake worker's lyrics are ASR, so the reel wears the amber tint (non-vacuity) and nothing names the source.
		await expect(tv.locator(SEL.lyricsUnverified), 'guessed lyrics lost their amber tint').toBeAttached({
			timeout: 25_000
		});
		await expect(tv.locator(SEL.lowerThird), 'the stage names its lyric source').not.toContainText('Auto-transcribed');

		// TIME LEFT IN THE NOW-SINGING CARD is ASCII too: `-0:02`, never the phone's typographic `−0:02`.
		const set = await phone.request.put('/api/settings/room', { data: { tvProgressStyle: 'card' } });
		expect(set.ok(), `PUT /api/settings/room -> ${set.status()}`).toBe(true);
		const left = tv.locator(`${SEL.lowerThird} .card-row .t`).last();
		await expect(left, 'time left in the card is not an ASCII -m:ss').toHaveText(/^-\d+:\d\d$/, { timeout: 20_000 });

		// BACK TO THE LOBBY: the room drained, so the host's notice returns.
		await phone.getByRole(SEL.skip.role, { name: SEL.skip.name }).click();
		await expect(tv.locator(SEL.lobby)).toBeVisible({ timeout: 20_000 });
		await expect(tv.locator(SEL.badQrTitle), 'the drained lobby did not bring the notice back').toHaveText(NOTICE);

		// SETTINGS says it too: a party that starts with a song queued never shows the lobby, so this is where the
		// host learns it. Same address in effect (nothing set, a loopback host), same words.
		await phone.goto('/settings/server');
		await expect(phone.locator('#joining'), 'the Joining card does not warn about the address').toContainText(NOTICE);
	} finally {
		await worker.stop();
	}
});
