/*
 * CLAIM 6: the ratified TV states, measured on the render. The source-scan half lived in
 * tests/guards/subsystem-tv/tv-ratified-states.test.ts (deleted with that tree). Only a render settles that
 * the join URL is ONE unbreakable token (scrollWidth <= clientWidth) at a realistic long LAN address, and that
 * no roster chip is OCCLUDED — swept at 6/10/12/13 guests, because name length is load-bearing here.
 *
 * ONE TEST: the four roster sizes are one INCREMENTAL drive — guests are added to a room that keeps the ones
 * already in it — and the URL arm is taken once, on the first populated sweep. Each size is a soft arm, so a
 * failure at 10 still reports 12 and 13.
 *
 * THE LOBBY, NOT THE ATTRACT SCREEN: singers have joined, and the lobby carries the same join panel plus the
 * roster.
 */
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { seedRoster, type Roster } from '../../world/presence';
import type { Page } from '@playwright/test';

/**
 * The names the old gate swept with, verbatim: name LENGTH is what fills the strip, so these are not
 * interchangeable with generated padding.
 */
const NAMES = [
	'Bartholomew',
	'Alexandria',
	'Maximilian',
	'Christopher',
	'Evangeline',
	'Sebastian',
	'Anastasia',
	'Montgomery',
	'Josephine',
	'Wilhelmina',
	'Fitzgerald',
	'Konstantin',
	'Persephone'
];

/** A CSS NAMED colour, never a `#hex` literal, because a
 *  `#`-led string in a test reads as an id selector to a human too. */
const CHIP_COLOR = 'rebeccapurple';

async function readLobby(page: Page) {
	return page.evaluate(
		({ lobbyStripPerson, lobbyUrl, fsBtn, badQr }) => {
			const chips = [...document.querySelectorAll(lobbyStripPerson)];
			const url = document.querySelector(lobbyUrl);
			const isControl = (el: Element | null) => el && (el.closest(fsBtn) || el.closest(badQr));
			let occluded = 0;
			const hits: string[] = [];
			for (const chip of chips) {
				const r = chip.getBoundingClientRect();
				for (const [x, y] of [
					[r.left + r.width / 2, r.top + r.height / 2],
					[r.right - 2, r.top + r.height / 2]
				]) {
					if (isControl(document.elementFromPoint(x, y))) {
						occluded++;
						hits.push((chip.textContent ?? '').trim());
						break;
					}
				}
			}
			let intersects = 0;
			const controls = [...document.querySelectorAll(fsBtn), ...document.querySelectorAll(badQr)].map((c) =>
				c.getBoundingClientRect()
			);
			for (const chip of chips) {
				const r = chip.getBoundingClientRect();
				for (const c of controls) {
					if (r.left < c.right && r.right > c.left && r.top < c.bottom && r.bottom > c.top) {
						intersects++;
						break;
					}
				}
			}
			return {
				chipCount: chips.length,
				occluded,
				hits,
				intersects,
				docOverflow: document.documentElement.scrollWidth - window.innerWidth,
				urlScrollW: url ? url.scrollWidth : null,
				urlClientW: url ? url.clientWidth : null,
				urlLines: url ? url.getClientRects().length : null,
				urlText: url ? url.textContent : null
			};
		},
		{ lobbyStripPerson: SEL.lobbyStripPerson, lobbyUrl: SEL.lobbyUrl, fsBtn: SEL.fsBtn, badQr: SEL.badQr }
	);
}

test('CLAIM 6 the lobby renders every roster chip unoccluded, and its join URL never breaks mid-token', async ({
	world
}) => {
	const tv = await world.openTv();
	const tvUrl = `/tv?room=${encodeURIComponent(world.code)}`;

	/*
	 * A ROUTABLE, LONG LAN ADDRESS, because that is the worst case this claim's URL-break probe needs — and
	 * because a loopback origin renders the operator notice instead of the join panel, which is a different
	 * screen. The old gate declared it with ENCORE_PUBLIC_ORIGIN at boot; the `world` fixture owns core's env,
	 * so it is declared here through the `joinOrigin` SETTING, which outranks the env var by design
	 * (src/lib/server/public-origin.ts). The write needs a joined singer, and that singer is the analogue of the
	 * phone-flow singer the old drive carried — which is exactly why every chip count below is a FLOOR (>=).
	 */
	const port = new URL(world.baseURL).port;
	const joinResponse = await tv.request.post('/api/join', {
		data: { displayName: 'GateOrigin', color: CHIP_COLOR }
	});
	expect(joinResponse.ok(), `could not join to authorise the joinOrigin write: ${joinResponse.status()}`).toBe(true);
	const settingsResponse = await tv.request.put('/api/settings', {
		data: { joinOrigin: `http://192.168.1.20:${port}` }
	});
	expect(settingsResponse.ok(), `could not set the join origin: ${settingsResponse.status()}`).toBe(true);

	const rosters: Roster[] = [];
	let joined = 0;
	let urlChecked = false;
	try {
		for (const count of [6, 10, 12, 13]) {
			if (joined < count) {
				// Joined over HTTP with a HELD phone socket per singer, because presence is "has an open socket": a
				// joined singer with no socket is counted away and never reaches the strip as a present member.
				rosters.push(await seedRoster(world.baseURL, NAMES.slice(joined, count)));
				joined = count;
			}
			await tv.goto(tvUrl);
			await tv.locator(SEL.lobbyStripPerson).first().waitFor({ state: 'attached', timeout: 15_000 });
			// A BOUNDED POLL, not an assertion: presence arrives over the socket, so this replaces the old gate's
			// blind sleep — but a roster that never fills must be REPORTED by the arm below rather than abort the
			// remaining counts.
			const deadline = Date.now() + 15_000;
			while ((await tv.locator(SEL.lobbyStripPerson).count()) < count && Date.now() < deadline) {
				await tv.waitForTimeout(200);
			}
			// A DWELL before the geometry read: the strip steps its chip size down and rewraps as it fills, and a
			// hit test taken mid-reflow measures the row the chips are leaving.
			await tv.waitForTimeout(900);
			const r = await readLobby(tv);
			// chipCount is a FLOOR (>=): the drive carries the joinOrigin singer as well, so the point is occlusion
			// plus no overflow, not an exact count.
			expect
				.soft(
					r !== null && r.chipCount >= count && r.occluded === 0 && r.intersects === 0 && r.docOverflow <= 0,
					`CLAIM 6 lobby at >=${count} guests renders every chip with none occluded by a control: ` +
						`chips=${r?.chipCount} (>= ${count}) occluded=${r?.occluded} ${JSON.stringify(r?.hits)} ` +
						`intersects=${r?.intersects} docOverflow=${r?.docOverflow}`
				)
				.toBe(true);
			// the typed join URL must fit one line — checked once, on the first populated sweep.
			if (!urlChecked && r && r.urlScrollW !== null) {
				urlChecked = true;
				expect
					.soft(
						r.urlScrollW <= (r.urlClientW ?? 0) + 1 && (r.urlLines ?? 0) <= 1,
						'CLAIM 6 the lobby join URL fits one line — no mid-token break: ' +
							`.url "${r.urlText}" scrollW=${r.urlScrollW} clientW=${r.urlClientW} lines=${r.urlLines} — an address is ` +
							'one unbreakable token, shrinking beats breaking'
					)
					.toBe(true);
			}
		}
		expect
			.soft(
				urlChecked,
				'CLAIM 6 the lobby join URL was measured: the .lobby .url element never rendered — the probe could not reach it'
			)
			.toBe(true);
	} finally {
		for (const roster of rosters) await roster.release();
	}
});
