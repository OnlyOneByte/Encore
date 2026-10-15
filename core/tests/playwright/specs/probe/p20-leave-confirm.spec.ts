// P20 — THE LEAVE CONFIRM, the one guest action with no undo.
//
// TWO CLAIMS, both of which needed a browser because both are about a dialog's STATE over time rather than
// about what a function returns:
//
//   1. A FAILED leave says so and stays retryable. `leaveRoom` was the only unguarded fetch on the pane: a
//      rejection escaped as an unhandled error and left `leaving` true forever, so the action sat at
//      "Leaving…", disabled, claiming to be in progress — and because `leaving` belongs to a component that
//      stays mounted while the guest stays on /settings/you, closing and reopening the dialog showed the same
//      dead label. The 500 half is a SEPARATE failure the same test covers, because a catch-only guard does not
//      fire for it: fetch resolves, the navigation ran anyway, and a guest who was still a member landed on the
//      Sing tab with nothing saying the leave had failed. A source guard can see the `res.ok` test; only a
//      browser can see that the button comes back and that the second attempt actually leaves.
//   2. The confirm never names a cost it has not been told. `leaveCost` is fetched when the dialog OPENS, and
//      `?? 0` rendered the not-yet-answered null as a confident "You have no songs queued" over a real queue,
//      with "Yes, leave" already tappable. The sentence itself is covered branch-by-branch in
//      tests/unit/lib/leave-cost-sentence.test.ts and is NOT re-asserted here; what is asserted here is the
//      WINDOW — that the neutral sentence is what a slow GET actually renders, and that the real count still
//      lands behind it.
//
// THE DELAY IS THE FIXTURE. On this box the round trip measures single-digit milliseconds, so the unknown
// window is invisible without one — and a test that cannot see the window would pass on the broken tree, which
// is worse than no test. The GET is held 3s by the route handler; the POST legs abort and 500 the same way the
// reported repro did.
//
// NO FAKE WORKER. The cost only needs an ENTRY, so the sparkle on an unprocessed song is enough: /api/process
// enqueues it with nobody to run the job and the queue entry is `queued`, which `removableOnLeave` counts.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { openBrowseFromHome } from '../../world/actors';
import type { Page } from '@playwright/test';

/** The refusal paragraph inside the open dialog — a live region, because it arrives after the open announcement. */
const REFUSAL = '[role="alertdialog"] [role="alert"]';

async function openConfirm(phone: Page): Promise<void> {
	await phone.getByRole('button', { name: 'Leave the room' }).click();
	await expect(phone.locator('[role="alertdialog"]')).toBeVisible();
}

async function stay(phone: Page): Promise<void> {
	await phone.getByRole('button', { name: 'Stay' }).click();
	await expect(phone.locator('[role="alertdialog"]')).toBeHidden();
}

test('a failed leave states the failure and stays retryable', async ({ world }) => {
	const phone = await world.openPhone('P20Fail');
	const errors: string[] = [];
	phone.on('pageerror', (e) => errors.push(e.message));

	// `block` is flipped in place rather than re-routing, so the LAST leg proves the retry re-asks: an
	// unroute-then-retry would also pass against a handler that fired no request at all.
	let posts = 0;
	let mode: 'abort' | 'refuse' | 'allow' = 'abort';
	await phone.route('**/api/leave', async (route) => {
		if (route.request().method() !== 'POST') return route.continue();
		posts++;
		if (mode === 'abort') return route.abort('internetdisconnected');
		if (mode === 'refuse')
			return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"nope"}' });
		return route.continue();
	});

	await phone.goto('/settings/you');
	await openConfirm(phone);
	await phone.getByRole('button', { name: 'Yes, leave' }).click();

	// DEAD WIFI. The reason is stated, and the control the guest has to press again is pressable again.
	await expect(phone.locator(REFUSAL)).toHaveText('Could not leave the room — try again.');
	await expect(phone.getByRole('button', { name: 'Yes, leave' })).toBeEnabled();
	await expect(phone.getByRole('button', { name: 'Leaving…' })).toHaveCount(0);
	// Still on the pane, still a member: a leave that did not happen must not navigate.
	expect(new URL(phone.url()).pathname).toBe('/settings/you');
	expect(posts).toBe(1);

	// The reason does not outlive the attempt that produced it.
	await stay(phone);
	await openConfirm(phone);
	await expect(phone.locator(REFUSAL)).toHaveCount(0);

	// A 500 RESOLVES, so this leg is what a catch alone cannot see.
	mode = 'refuse';
	await phone.getByRole('button', { name: 'Yes, leave' }).click();
	await expect(phone.locator(REFUSAL)).toHaveText('Could not leave the room — try again.');
	expect(new URL(phone.url()).pathname).toBe('/settings/you');
	const stillAMember = await phone.request.get('/api/leave');
	expect(stillAMember.ok()).toBe(true);

	// And the retry really re-asks, and really leaves.
	mode = 'allow';
	await phone.getByRole('button', { name: 'Yes, leave' }).click();
	await expect.poll(() => new URL(phone.url()).pathname).toBe('/');
	expect(posts).toBe(3);
	expect((await phone.request.get('/api/leave')).status()).toBe(401);

	// The unhandled `TypeError: Failed to fetch` the unguarded await used to throw.
	expect(errors).toEqual([]);
});

test('the confirm names no cost until the cost has answered', async ({ world }) => {
	const phone = await world.openPhone('P20Cost');
	await world.awaitDemoTrack();

	// One real queue entry, through the sparkle: the row need not be ready for `removableOnLeave` to count it.
	await openBrowseFromHome(phone);
	await phone.locator(SEL.search).fill('caroline');
	await phone.locator(SEL.sing).first().click();
	await expect.poll(async () => (await phone.request.get('/api/leave').then((r) => r.json())).queuedCount).toBe(1);

	// Held 3s, because the real round trip here is milliseconds and the defect lives in the window.
	await phone.route('**/api/leave', async (route) => {
		if (route.request().method() === 'GET') await new Promise((r) => setTimeout(r, 3000));
		return route.continue();
	});

	await phone.goto('/settings/you');
	await openConfirm(phone);
	const description = phone.locator('[data-slot="alert-dialog-description"]');

	// THE WINDOW. Number-free while unknown — and never the confident zero, which is the sentence the `?? 0`
	// produced over this exact queue.
	await expect(description).toHaveText(
		"Any songs you have queued will be removed, and you'll need to rejoin to sing again."
	);
	// Enabled THROUGHOUT: disabling the only way out of the room while a GET is slow would be a worse defect
	// than the one being fixed, and the pane's own "a failure cannot block" rule forbids it.
	await expect(phone.getByRole('button', { name: 'Yes, leave' })).toBeEnabled();

	// And the count still lands behind it, so the neutral copy is a window and not a replacement.
	await expect(description).toHaveText("Your 1 queued song will be removed, and you'll need to rejoin to sing again.");
});
