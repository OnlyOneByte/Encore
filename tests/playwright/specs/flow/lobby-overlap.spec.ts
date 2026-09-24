// On a short TV panel the lobby's typed join address must never be intersected — let alone painted over — by
// the roster strip, at any roster size the real path can produce.
//
// WHY THESE INPUTS. There is NO production cap: `src/routes/tv/+page.svelte` calls
// `lobbyRoster(online, away, singers, Infinity)` and its own comment says "the WHOLE roster, no '+N more':
// Infinity caps nothing, and TvLobby steps the chip size down instead". `lobbyRoster`'s `max = 8` is only a
// function default that this caller overrides — the old probe's header claimed 8 was the ceiling and it was
// wrong, which is why these sizes are a ladder rather than a boundary. The address must stay clear at EVERY
// size, and the chip step-down is the mechanism that has to keep it clear.
// 1280x720 and 1366x768 are the bug's own sizes; 1920x1080 is a non-regression floor that was never
// overlapped even before the fix, and is here so a "fix" that simply hid the strip would fail too.
//
// Four properties are asserted together on purpose: the address clear of the strip, the address painted at its
// own centre, no roster member clipped, and none occluded. Showing the whole roster must not be bought by
// silently dropping the people it names.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { longNames, seedRoster } from '../../world/presence';

const VIEWPORTS = [
	{ width: 1280, height: 720 },
	{ width: 1366, height: 768 },
	{ width: 1920, height: 1080 }
];

interface OverlapReading {
	overlap: number;
	painted: string | null;
	inStrip: boolean;
	stripHeight: number | null;
	clipped: boolean;
	chipsCut: number;
	chipsOccluded: number;
}

/** Reads the geometry the property is ABOUT, in one round trip so nothing can shift between measurements. */
async function readOverlap(page: import('@playwright/test').Page): Promise<OverlapReading> {
	return page.evaluate(
		({ lobbyUrl, lobbyStrip, lobbyStripPerson, strip, fsBtn, badQr }) => {
			const url = document.querySelector(lobbyUrl);
			if (!url) throw new Error('no lobby address element');
			const stripEl = document.querySelector(lobbyStrip);
			const ub = url.getBoundingClientRect();
			const sb = stripEl?.getBoundingClientRect() ?? null;
			const hit = document.elementFromPoint(ub.left + ub.width / 2, ub.top + ub.height / 2);
			const chips = [...document.querySelectorAll(lobbyStripPerson)];
			return {
				overlap: sb ? Math.max(0, ub.bottom - sb.top) : 0,
				painted: hit ? (typeof hit.className === 'string' && hit.className ? '.' + hit.className.split(' ')[0] : hit.tagName) : null,
				inStrip: hit ? !!hit.closest(strip) : false,
				stripHeight: sb ? +sb.height.toFixed(1) : null,
				clipped: stripEl
					? stripEl.scrollHeight > stripEl.clientHeight || stripEl.scrollWidth > stripEl.clientWidth + 1
					: false,
				chipsCut: sb
					? chips.filter((p) => {
							const r = p.getBoundingClientRect();
							return r.bottom > sb.bottom + 0.5 || r.right > sb.right + 0.5;
						}).length
					: 0,
				// A corner control is position:absolute ABOVE the strip in paint order, so a name underneath one
				// is invisible to a clip check and needs its own hit test.
				chipsOccluded: chips.filter((p) => {
					const r = p.getBoundingClientRect();
					const points: [number, number][] = [
						[r.left + r.width / 2, r.top + r.height / 2],
						[r.right - 2, r.top + r.height / 2]
					];
					return points.some(([x, y]) => {
						const h = document.elementFromPoint(x, y);
						return !!h && (!!h.closest(fsBtn) || !!h.closest(badQr));
					});
				}).length
			};
		},
		{
			lobbyUrl: SEL.lobbyUrl,
			lobbyStrip: SEL.lobbyStrip,
			lobbyStripPerson: SEL.lobbyStripPerson,
			strip: SEL.strip,
			fsBtn: SEL.fsBtn,
			badQr: SEL.badQr
		}
	);
}

const CASES = [
	{ label: 'n=3', names: longNames('A', 3) },
	{ label: 'n=8, lobbyRoster’s own default size', names: longNames('B', 8) },
	// Past that default, to prove the caller's `Infinity` really does render every chip and that the step-down
	// — not a "+N more" overflow — is what keeps the address clear. `overflow` is always 0 here.
	{ label: 'n=9, past the default so every chip still renders', names: longNames('C', 9) }
];

for (const { label, names } of CASES) {
	test(`the lobby address stays clear of the roster at ${label}`, async ({ world }) => {
		const roster = await seedRoster(world.baseURL, names);
		const tv = await world.openTv();
		try {
			for (const viewport of VIEWPORTS) {
				await tv.setViewportSize(viewport);
				// Wait for the roster to have SYNCED rather than sleeping: the strip is what the address must
				// clear, so measuring before it arrives measures the wrong layout.
				await expect(tv.locator(SEL.lobbyStripPerson)).toHaveCount(names.length, { timeout: 15_000 });
				await expect(tv.locator(SEL.lobbyUrl)).toBeVisible();

				const m = await readOverlap(tv);
				const where = `${label} @ ${viewport.width}x${viewport.height}`;
				const detail = ` (stripH=${m.stripHeight})`;

				expect(m.overlap, `${where}: the address is intersected by the roster strip${detail}`).toBe(0);
				expect(m.painted, `${where}: something else is painted over the address centre${detail}`).toBe(
					SEL.lobbyAddress
				);
				expect(m.inStrip, `${where}: the address centre hit-tests INTO the strip${detail}`).toBe(false);
				expect(m.clipped, `${where}: the strip is scrolling, so part of the roster is cut off${detail}`).toBe(false);
				expect(m.chipsCut, `${where}: roster members fall outside the strip's box${detail}`).toBe(0);
				expect(m.chipsOccluded, `${where}: roster members sit under a corner control${detail}`).toBe(0);
			}
		} finally {
			await roster.release();
		}
	});
}
