/*
 * CLAIM 1 and CLAIM 2, measured on a resolved layout: every operable control's real HIT EXTENT against the
 * `--tap` token, and every text-entry field's COMPUTED font size. Ported from
 * tests/e2e/gates/measured-design.mjs.
 *
 * ONE TEST, SIX ARMS, because they ride ONE SWEEP: 3 viewports x 7 surfaces, and the tallies the non-vacuity
 * floors read are the same pass's. Splitting them would triple the drive and still measure the same layout.
 * Each arm is a SOFT expectation, so a failing run reports every claim it broke rather than the first — which
 * is what the old gate's `check()` did, and what makes one run enough to act on.
 *
 * THERE IS NO SKIP PATH HERE, and nothing to write to get one: a missing Chromium is playwright.config.ts's
 * launch error, an unbuilt tree is its `globalSetup`, and a core that will not answer /health throws out of
 * world/core.ts. All three are FAILURES with the remedy printed, because a permanently-skipped check is
 * indistinguishable from the rot it was meant to catch.
 */
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { FLOORS, MIN_FIELD_PX, QUARANTINE, TAP, TEXT_INPUT_TYPES, VIEWPORTS } from './measured-design-register';
import { controlId, covers, fieldId, fill, matches, openBrowse, sweep } from './measured-design-support';

test('CLAIM 1 every control reaches the tap floor and CLAIM 2 every field computes big enough, at three viewports', async ({
	world,
	page
}) => {
	const newOffenders: string[] = [];
	const worsened: string[] = [];
	const staleQuarantine: string[] = [];
	const smallFields: string[] = [];
	const occludedControls: string[] = [];
	const surfacesSwept = new Set<string>();
	let controlsMeasured = 0;
	let fieldsMeasured = 0;

	await page.setViewportSize({ width: VIEWPORTS[0].w, height: VIEWPORTS[0].h });

	// Join once; every phone surface below is behind a session. The join form is the UNJOINED state of `/`, so
	// it is swept first — `?room=` lands on the identity pane, where the name field exists.
	await page.goto(`/?room=${encodeURIComponent(world.code)}`);
	await page.locator(SEL.nameInput).first().waitFor({ state: 'attached', timeout: 15_000 });
	const joinSweep = await sweep(page);
	await world.joinAs(page, `Gate${Date.now() % 1_000_000}`);
	await openBrowse(page, 20_000);
	expect
		.soft(joinSweep.length, 'the drive reaches a joined session — every phone surface below is behind one')
		.toBeGreaterThan(0);

	// For the record, the way the old gate printed it: a hit extent is a browser's answer, so which browser
	// answered is part of the reading.
	console.log(`browser: ${await page.evaluate(() => navigator.userAgent)}`);

	/** Drive one surface and fold its readings into the tallies. */
	const surface = async (label: string, arrive: () => Promise<void>) => {
		await arrive();
		// A DWELL BEFORE A GEOMETRY READ, kept from the old gate. Not a substitute for auto-waiting: each
		// `arrive` below already waits on a real signal where one exists, and the two tab arms have none in the
		// contract at all — the panel swap IS the thing settling. Hit-testing a control mid-transition measures
		// the layout it is passing through.
		await page.waitForTimeout(400);
		const readings = await sweep(page);
		if (readings.length === 0) return;
		surfacesSwept.add(label);
		controlsMeasured += readings.length;
		for (const r of readings) {
			const id = controlId(label, r);
			const q = QUARANTINE.find((e) => covers(e.where, label) && matches(r, e));
			if (r.occluded > 0) {
				occludedControls.push(
					`${id}: blocked by ${r.blockedBy} at ${r.occluded} of 3 x positions along the control's own centre line`
				);
			}
			if (r.hitH >= TAP) {
				if (q) staleQuarantine.push(`${id}: now measures ${r.hitH}px, at or above the ${TAP}px floor`);
				continue;
			}
			if (!q) {
				newOffenders.push(
					`${id}: hit extent ${r.hitH}px (box ${r.boxH}px) < ${TAP}px${r.blockedBy ? ` — blocked by ${r.blockedBy}` : ''}`
				);
			} else if (r.hitH < q.measured - 1) {
				worsened.push(`${id}: ${q.measured}px when quarantined, now ${r.hitH}px`);
			}
		}
		// CLAIM 2 rides the same sweep: every text-entry field's COMPUTED size, not its declaration.
		for (const r of readings) {
			const isField = r.tag === 'textarea' || (r.tag === 'input' && TEXT_INPUT_TYPES.includes(r.type ?? ''));
			if (!isField) continue;
			fieldsMeasured++;
			if (r.fontSize < MIN_FIELD_PX) {
				smallFields.push(`${fieldId(label, r)}: computed font-size ${r.fontSize}px < ${MIN_FIELD_PX}px`);
			}
		}
	};

	for (const vp of VIEWPORTS) {
		await page.setViewportSize({ width: vp.w, height: vp.h });
		// TWO phone surfaces, not one: `/` carries the queue's controls and the docked band, and the library
		// rows are a screen further in. Measuring only one silently stops measuring the other.
		await surface('/', async () => {
			await page.goto('/');
			await page.locator(SEL.homeReady).first().waitFor({ state: 'attached', timeout: 15_000 });
		});
		await surface('/ (searched)', async () => {
			await openBrowse(page);
			await fill(page, SEL.search, 'caroline');
			// Tolerated, as it was in the old gate: a query that matches nothing still leaves a surface worth
			// sweeping, so the absence of rows must not abort the drive.
			await page
				.locator(SEL.songRow)
				.first()
				.waitFor({ state: 'attached', timeout: 15_000 })
				.catch(() => {});
		});
		await surface('/settings', async () => {
			await page.goto('/settings');
		});
		// BY TEXT, as the old gate clicked them: the tab strip's labels are what a guest reads.
		await surface('/settings#party', async () => {
			await page.getByText('Party').first().click();
		});
		await surface('/settings#server', async () => {
			await page.getByText('Server').first().click();
		});
		await surface('/metrics', async () => {
			await page.goto('/metrics');
		});
		await surface('/stats', async () => {
			await page.goto('/stats');
		});
	}

	expect
		.soft(
			newOffenders,
			`CLAIM 1 every control's measured hit extent reaches ${TAP}px, or is quarantined at a recorded number`
		)
		.toEqual([]);
	expect.soft(worsened, 'CLAIM 1 no quarantined control got worse than the number it was quarantined at').toEqual([]);
	expect
		.soft(
			staleQuarantine,
			'CLAIM 1 no quarantine entry has gone stale — a defect that no longer reproduces is a finding. ' +
				'Re-decide the entry in measured-design-register.ts on the record; do not adjust a number.'
		)
		.toEqual([]);
	expect
		.soft(
			occludedControls,
			'CLAIM 1 no control is occluded along its own centre line — the reason a rendered reading beats a declared one'
		)
		.toEqual([]);
	expect.soft(smallFields, `CLAIM 2 every text-entry field computes at or above ${MIN_FIELD_PX}px`).toEqual([]);

	// NON-VACUITY. A drive that navigates but finds no controls would otherwise report every assertion
	// satisfied over an empty set. A firing floor is a FINDING, never a number to adjust: it says the drive
	// reached fewer controls than it did when this gate landed, so something it used to sweep is no longer
	// reachable.
	expect
		.soft(controlsMeasured, `the drive measured a real population — >=${FLOORS.controlsMeasured} control readings`)
		.toBeGreaterThanOrEqual(FLOORS.controlsMeasured);
	expect
		.soft(
			surfacesSwept.size,
			`the drive reached a real set of surfaces — >=${FLOORS.surfacesSwept}; reached ${[...surfacesSwept].join(', ')}`
		)
		.toBeGreaterThanOrEqual(FLOORS.surfacesSwept);
	expect
		.soft(fieldsMeasured, `the font-size arm examined real fields — >=${FLOORS.fieldsMeasured}`)
		.toBeGreaterThanOrEqual(FLOORS.fieldsMeasured);
});
