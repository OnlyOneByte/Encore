// CLAIM 12 (waits) under 300 ms shows nothing; a lost party is called lost after 3 s of asking, and by 4 s (3 s plus
// room.ts's 1 s in-flight grace). Method: docs/E2E.md#speed-gate.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { flashes, instrument, readState } from './speed-measure';

const WORDS_NOT_BEFORE_MS = 3000;
const WORDS_BY_MS = 4000;
// A timer due at 4 s runs a little late on a loaded box; anything past this is the product, not the box.
const TIMER_SLACK_MS = 200;

test('CLAIM 12 a lost party is called lost after 3 s of asking, and by 4 s (#1093)', async ({ world }) => {
	const phone = await world.openPhone('Maya');
	await instrument(phone);
	// Both stamped in the page: when expect's poll finds the words is up to a second after they came (#1093).
	await phone.addInitScript((words) => {
		const w = window as unknown as { __askAt?: number; __wordsAt?: number };
		const f = window.fetch;
		window.fetch = (input, init) => {
			if (String(input instanceof Request ? input.url : input).includes('/api/me')) w.__askAt ??= performance.now();
			return f(input, init);
		};
		new MutationObserver(() => {
			if (w.__wordsAt === undefined && document.body?.textContent?.includes(words)) w.__wordsAt = performance.now();
		}).observe(document, { subtree: true, childList: true, characterData: true });
	}, SEL.unreachable);
	await phone.route('**/api/me', () => {});
	await phone.reload({ waitUntil: 'commit' });
	await expect(phone.getByText(SEL.unreachable)).toBeVisible({ timeout: 10_000 });
	const { askAt, wordsAt } = await phone.evaluate(() => {
		const w = window as unknown as { __askAt: number; __wordsAt: number };
		return { askAt: w.__askAt, wordsAt: w.__wordsAt };
	});
	const after = wordsAt - askAt;
	console.log(
		`CLAIM 12 "Can't reach the party" ${Math.round(after)} ms after the first ask (${Math.round(wordsAt)} ms from navigation), budget ${WORDS_NOT_BEFORE_MS}-${WORDS_BY_MS} ms`
	);
	expect(after, `CLAIM 12 the words ${Math.round(after)} ms after the first ask`).toBeGreaterThanOrEqual(
		WORDS_NOT_BEFORE_MS
	);
	expect(after, `CLAIM 12 the words ${Math.round(after)} ms after the first ask`).toBeLessThanOrEqual(
		WORDS_BY_MS + TIMER_SLACK_MS
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
