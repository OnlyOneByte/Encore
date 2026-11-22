/*
 * CLAIM 4: the focus indicator's FORM, on a genuinely `:focus-visible` element, measured on the PAINT rather
 * than read out of a stylesheet.
 *
 * ONE TEST: the two surfaces feed one verdict, and the non-vacuity floor counts the elements both of them
 * actually drove into focus. An element that could not be put into `:focus-visible` is UNMEASURED, never
 * satisfied — that is the whole difference between this and a source scan.
 */
import { test, expect } from '../../world/fixtures';
import { CONTROL_SELECTOR, FLOORS, FOCUS_VISIBLE, INERT_SELECTOR } from './measured-design-register';

interface FocusReading {
	what: string;
	tag: string;
	focusVisible: boolean;
	style: string;
	width: number;
	color: string;
	ring: { style: string; width: number; color: string; on: string } | null;
	shadowChanged: boolean;
	wanted: string;
}

test('CLAIM 4 every focusable control draws a >=2px outline in the resolved --focus, measured on the render', async ({
	world
}) => {
	const page = await world.openPhone(`Focus${Date.now() % 1_000_000}`);
	await page.setViewportSize({ width: 390, height: 844 });

	const badFocus: string[] = [];
	const focusReadings: FocusReading[] = [];

	// Two surfaces: the phone route carries the search FIELD, the one control whose ring is on its wrapper,
	// while /settings carries every <select> and range input, whose rings come from different rules.
	for (const where of ['/', '/settings']) {
		await page.goto(where);
		// A DWELL before a PAINT is read: the route's own transition has to finish, or the outline read back is
		// the one on an element still moving.
		await page.waitForTimeout(600);
		focusReadings.push(
			...(await page.evaluate(
				({ controlSelector, inertSelector, focusVisibleSelector }) => {
					// Resolve --focus the way the cascade does, rather than re-parsing the token file.
					const probe = document.createElement('span');
					probe.style.color = 'var(--focus)';
					document.body.appendChild(probe);
					const wanted = getComputedStyle(probe).color;
					probe.remove();

					const out = [];
					for (const el of [...document.querySelectorAll<HTMLElement>(controlSelector)]) {
						const cs0 = getComputedStyle(el);
						if (
							cs0.visibility === 'hidden' ||
							cs0.display === 'none' ||
							el.hasAttribute('disabled') ||
							el.closest(inertSelector)
						)
							continue;
						if (el.getBoundingClientRect().height === 0) continue;
						const shadowUnfocused = cs0.boxShadow;
						el.focus({ preventScroll: true });
						const visible = el.matches(focusVisibleSelector);
						const cs = getComputedStyle(el);
						/*
						 * THE INDICATOR MAY BE ON THE FIELD RATHER THAN ON THE CONTROL: a composite field is one box to
						 * anyone looking at it, so the ring belongs around the whole of it. The walk goes UP three levels
						 * (a field wrapper is one) and reports the first ancestor satisfying the floor. A widening of
						 * WHERE, never of WHAT — the same >=2px in the resolved --focus is still required.
						 */
						let ring: { style: string; width: number; color: string; on: string } | null = null;
						for (let node = el.parentElement, hops = 0; node && hops < 3; node = node.parentElement, hops++) {
							const acs = getComputedStyle(node);
							const w = parseFloat(acs.outlineWidth) || 0;
							if (acs.outlineStyle !== 'none' && w >= 2) {
								ring = {
									style: acs.outlineStyle,
									width: w,
									color: acs.outlineColor,
									on: node.className || node.tagName
								};
								break;
							}
						}
						out.push({
							what: (el.getAttribute('aria-label') || el.textContent || el.tagName)
								.trim()
								.replace(/\s+/g, ' ')
								.slice(0, 34),
							tag: el.tagName.toLowerCase(),
							focusVisible: visible,
							style: cs.outlineStyle,
							width: parseFloat(cs.outlineWidth) || 0,
							color: cs.outlineColor,
							ring,
							shadowChanged: cs.boxShadow !== shadowUnfocused,
							wanted
						});
						el.blur();
					}
					return out;
				},
				{ controlSelector: CONTROL_SELECTOR, inertSelector: INERT_SELECTOR, focusVisibleSelector: FOCUS_VISIBLE }
			))
		);
	}

	const focusedMeasured = focusReadings.length;
	for (const f of focusReadings) {
		const who = `${f.tag} "${f.what}"`;
		// an element we could not put into :focus-visible is UNMEASURED, never satisfied.
		if (!f.focusVisible) {
			badFocus.push(`${who}: could not be driven into :focus-visible, so its indicator is UNMEASURED — not passed`);
			continue;
		}
		// The control's own ring, or the field wrapper's — see the probe for why a composite field carries it.
		const drawn =
			f.style === 'none' || f.width < 2 ? f.ring : { style: f.style, width: f.width, color: f.color, on: 'itself' };
		if (!drawn) {
			badFocus.push(
				`${who}: outline is ${f.style} ${f.width}px and no ancestor within three levels draws one${f.shadowChanged ? ' — the ring is drawn by box-shadow alone' : ''}`
			);
			continue;
		}
		if (drawn.color !== f.wanted) {
			badFocus.push(`${who}: ring on ${drawn.on} drawn in ${drawn.color}, but --focus resolves to ${f.wanted}`);
		}
	}

	expect
		.soft(
			badFocus,
			'CLAIM 4 every focusable control draws a >=2px outline in the resolved --focus, measured on the render'
		)
		.toEqual([]);
	// NON-VACUITY: a drive that focused nothing would report CLAIM 4 satisfied over an empty set.
	expect
		.soft(focusedMeasured, `the focus arm examined real controls — >=${FLOORS.focusedMeasured}`)
		.toBeGreaterThanOrEqual(FLOORS.focusedMeasured);
});
