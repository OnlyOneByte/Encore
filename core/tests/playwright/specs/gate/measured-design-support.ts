/*
 * THE MEASUREMENTS THEMSELVES, shared by the seven measured-design specs; the claims
 * that consume them are one spec each.
 *
 * WHY IT LIVES HERE AND NOT IN world/: everything in this file is knowledge about THIS gate — a sweep whose
 * hit-extent rule is the gate's own hard-won rule, a quarantine matcher, and two waits the gate's surfaces
 * need. `world/` is shared by four suites and three other agents; a helper that only one gate can be wrong
 * about belongs beside the gate.
 */
import type { Page } from '@playwright/test';
import { CONTROL_SELECTOR, INERT_SELECTOR, LABEL_SELECTOR } from './measured-design-register';
import type { QuarantineEntry } from './measured-design-register';
import { SEL } from '../../world/selectors';

/** One reading per operable control, with the identity fields the quarantine matches on. */
export interface Reading {
	tag: string;
	type: string | null;
	cls: string;
	near: string;
	offscreen: boolean;
	blockedBy: string | null;
	boxH: number;
	hitH: number;
	occluded: number;
	fontSize: number;
}

/**
 * THE IN-PAGE SWEEP. Returns one reading per operable control on the current surface.
 *
 * TAKE A HIT EXTENT AT THE CENTRE x. Chromium hit-tests `border-radius`, so sweeping a control's vertical
 * extent at a far-edge x measures the chord through its own rounded corner, and every 44px pill read 34-42px
 * — a floor unmeetable by construction. Far-edge probes are for OCCLUSION only, along the control's widest
 * row, which is what the 0.25/0.5/0.75 pass below does at a single y.
 *
 * ACCEPT A HIT AS THE CONTROL'S OWN ONLY WHEN `hit === target || target.contains(hit)` — never the reverse,
 * which counts `<body>` as a hit and inflated a 32px target to 93px.
 */
export async function sweep(page: Page): Promise<Reading[]> {
	return page.evaluate(
		({ controlSelector, inertSelector, labelSelector }) => {
			const out: Reading[] = [];
			for (const el of [...document.querySelectorAll(controlSelector)]) {
				const cs = getComputedStyle(el);
				if (cs.visibility === 'hidden' || cs.display === 'none') continue;
				if (el.hasAttribute('disabled') || el.closest(inertSelector)) continue;
				el.scrollIntoView({ block: 'center' });
				const r = el.getBoundingClientRect();
				if (r.width === 0 || r.height === 0) continue;
				// A checkbox/radio DELEGATES its target to the wrapping <label>, which carries min-height:
				// var(--tap); measuring the glyph itself reads an 18px floor off a 44px label.
				const type = (el.getAttribute('type') || '').toLowerCase();
				const glyph = el.tagName === 'INPUT' && (type === 'checkbox' || type === 'radio');
				// The same delegation, in newer markup: the switch is a role=switch button in the same label.check.
				const switchBtn = el.getAttribute('role') === 'switch';
				// A SLIDER THUMB'S TARGET IS ITS TRACK: Bits UI moves the thumb to wherever the track is pressed.
				// A short slider ROOT still fails, so this credits a real target without excusing a small one.
				const thumb = el.matches('[data-slot="slider-thumb"]');
				const target =
					glyph || switchBtn ? el.closest(labelSelector) || el : thumb ? el.closest('[data-slot="slider"]') || el : el;
				const inTarget = (n: Element | null) => !!n && (n === target || target.contains(n));
				const tr = target.getBoundingClientRect();
				const cx = Math.min(Math.max(Math.round(tr.left + tr.width / 2), 0), innerWidth - 1);
				const cy = Math.round(tr.top + tr.height / 2);
				// Vertical hit extent at the CENTRE x. OFF-VIEWPORT IS NOT ZERO-HEIGHT, and the test is on the
				// CENTRE POINT rather than the box: a control straddling the fold intersects the viewport and still
				// has no hittable centre, so its declared box is credited, the occlusion probe is skipped, and the
				// skip is counted in the offscreen tally.
				const onScreen = cy >= 0 && cy < innerHeight;
				let hitH = onScreen ? 0 : Math.round(tr.height * 10) / 10;
				if (onScreen && inTarget(document.elementFromPoint(cx, cy))) {
					let top = cy;
					let bottom = cy;
					while (top - 1 >= 0 && inTarget(document.elementFromPoint(cx, top - 1))) top--;
					while (bottom + 1 < innerHeight && inTarget(document.elementFromPoint(cx, bottom + 1))) bottom++;
					hitH = bottom - top + 1;
				}
				// Occlusion, as a SEPARATE reading along the widest row — never a vertical sweep at a far-edge x,
				// which measures the chord through the control's own border-radius.
				let occluded = 0;
				// WHAT blocked it, so the failure message is the diagnosis. A null means no element at that point,
				// which after the offscreen guard can only be a gap in the target's own paint.
				let blockedBy: string | null = null;
				if (onScreen) {
					for (const f of [0.25, 0.5, 0.75]) {
						const x = Math.min(Math.max(Math.round(tr.left + tr.width * f), 0), innerWidth - 1);
						const hit = document.elementFromPoint(x, cy);
						if (!inTarget(hit)) {
							occluded++;
							if (!blockedBy) {
								blockedBy = hit
									? hit.tagName.toLowerCase() +
										(hit.className && hit.className.toString
											? '.' +
												hit.className
													.toString()
													.replace(/svelte-[\w-]+/g, '')
													.trim()
													.split(/\s+/)
													.slice(0, 2)
													.join('.')
											: '') +
										' pe=' +
										getComputedStyle(hit).pointerEvents +
										(hit === target.parentElement ? ' (the target OWN PARENT)' : '')
									: 'nothing (no element at that point)';
							}
						}
					}
				}
				const label = el.closest(labelSelector);
				const near = (
					el.getAttribute('aria-label') ||
					(label ? label.textContent : '') ||
					(el.parentElement ? el.parentElement.textContent : '') ||
					''
				)
					.trim()
					.replace(/\s+/g, ' ')
					.slice(0, 46);
				out.push({
					tag: el.tagName.toLowerCase(),
					type: el.getAttribute('type'),
					cls: (el.className && el.className.toString ? el.className.toString() : '')
						.replace(/svelte-[\w-]+/g, '')
						.trim()
						.replace(/\s+/g, ' '),
					near,
					offscreen: !onScreen,
					blockedBy,
					boxH: Math.round(r.height * 10) / 10,
					hitH,
					occluded,
					fontSize: parseFloat(cs.fontSize)
				});
			}
			return out;
		},
		{ controlSelector: CONTROL_SELECTOR, inertSelector: INERT_SELECTOR, labelSelector: LABEL_SELECTOR }
	);
}

/**
 * Every field a quarantine entry names must match. `near` matches as a PREFIX, the raw value being a
 * 46-character slice of surrounding label text.
 */
export function matches(r: Reading, q: QuarantineEntry): boolean {
	if (q.match.tag !== r.tag) return false;
	if ('type' in q.match && (q.match.type ?? null) !== r.type) return false;
	if (q.match.cls !== undefined && q.match.cls !== r.cls) return false;
	if (q.match.near !== undefined && !r.near.startsWith(q.match.near)) return false;
	return true;
}

/**
 * A PREFIX, so one entry covers `/settings` and its tabs: listing each tab separately would invite a
 * partial quarantine that lets a real new offender in on whichever tab was forgotten.
 */
export function covers(where: string, label: string): boolean {
	return label === where || label.startsWith(`${where}#`);
}

/** The id CLAIM 1 names a control by: surface, tag, type, classes and the text beside it. */
export function controlId(label: string, r: Reading): string {
	return `${label} ${r.tag}${r.type ? `[${r.type}]` : ''}${r.cls ? `.${r.cls.split(' ').join('.')}` : ''} "${r.near}"`;
}

/** CLAIM 2 names a field without its classes — the same shape the old gate's second `id()` produced. */
export function fieldId(label: string, r: Reading): string {
	return `${label} ${r.tag}${r.type ? `[${r.type}]` : ''} "${r.near}"`;
}

/**
 * From the JOINED home screen, reach the search box — the same three waits as `openBrowseFromHome`
 * in world/actors.ts. There is nothing to CLICK: the field is the
 * first element in the home column, so this only waits, and it waits on three things separately so a failure
 * names which half is missing.
 */
export async function openBrowse(page: Page, timeout = 15_000): Promise<void> {
	// The dock, not the strip inside it: the strip renders only when the room has something to play, so a wait on
	// it never resolves for a drive that has not queued anything.
	await page.locator(SEL.dock).first().waitFor({ state: 'attached', timeout });
	await page.locator(SEL.findBox).first().waitFor({ state: 'attached', timeout });
	await page.locator(SEL.search).first().waitFor({ state: 'attached', timeout });
}

/** `locator.fill` dispatches `input` natively for `bind:value`; `change` goes out too because a `<select>` and
 *  a range input listen for that one instead. */
export async function fill(page: Page, selector: string, value: string): Promise<void> {
	const el = page.locator(selector).first();
	await el.fill(value);
	await el.dispatchEvent('change');
}

/**
 * HEADLESS HAS NO NOTCH. Every `env(safe-area-inset-*)` resolves to 0, so `calc(10px + env(...))` and a bare
 * `10px` measure identically and an arm comparing them proves nothing. There is no Playwright API for this,
 * so it goes over CDP: `Emulation.setSafeAreaInsetsOverride`.
 */
export async function setSafeAreaInsets(
	page: Page,
	insets: { top?: number; right?: number; bottom?: number; left?: number }
): Promise<void> {
	const cdp = await page.context().newCDPSession(page);
	// The bundled protocol typings do not carry this command, so the SESSION is widened rather than the params
	// invented: a wrong shape here would silently resolve every inset to 0 again. Widen the session and not the
	// method — a detached `cdp.send` loses its receiver and dies on `_channel`.
	const session = cdp as unknown as { send(method: string, params?: unknown): Promise<unknown> };
	await session.send('Emulation.setSafeAreaInsetsOverride', { insets });
	await cdp.detach();
}
