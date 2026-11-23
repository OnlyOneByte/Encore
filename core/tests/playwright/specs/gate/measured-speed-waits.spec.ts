// CLAIM 12 (waits) under 300 ms shows nothing; a lost party is not called lost before 3 s. Method:
// docs/E2E.md#speed-gate. The 4 s upper bound races room.ts's timer against the request timeout: #1093.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { flashes, instrument, readState } from './speed-measure';

const WORDS_NOT_BEFORE_MS = 3000;

test('CLAIM 12 a lost party is not called lost before 3 s', async ({ world }) => {
	const phone = await world.openPhone('Maya');
	await instrument(phone);
	await phone.route('**/api/me', () => {});
	await phone.reload({ waitUntil: 'commit' });
	const words = phone.getByText(SEL.unreachable);
	await expect(words).toBeVisible({ timeout: 10_000 });
	const at = await words.evaluate(() => performance.now());
	console.log(`CLAIM 12 "Can't reach the party" at ${Math.round(at)} ms, not before ${WORDS_NOT_BEFORE_MS} ms`);
	expect(at, `CLAIM 12 "Can't reach the party" at ${Math.round(at)} ms from navigation`).toBeGreaterThanOrEqual(
		WORDS_NOT_BEFORE_MS
	);
});

test('CLAIM 12 a short wait shows nothing: no indicator, no words', async ({ world }) => {
	const phone = await world.openPhone('Ben');
	await instrument(phone);
	// Well inside the 300 ms grace, with room for a loaded box to be late.
	await phone.route('**/api/me', async (route) => {
		await new Promise((r) => setTimeout(r, 100));
		await route.continue();
	});
	for (let i = 0; i < 3; i++) {
		await phone.reload({ waitUntil: 'commit' });
		await expect(phone.locator(SEL.search)).toBeVisible({ timeout: 10_000 });
		await phone.waitForTimeout(400);
		const s = await readState(phone);
		expect.soft(flashes(s.indicators), 'CLAIM 12 an indicator flashed during a 100 ms wait').toEqual([]);
		expect.soft(await phone.getByText(SEL.unreachable).count(), 'CLAIM 12 words during a 100 ms wait').toBe(0);
	}
});
