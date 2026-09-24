/*
 * CLAIM 5b: `.fs-btn` overlaps NO z-tier-7 chrome box, at 1080p AND 4K. The button and the corner chrome all
 * sit at z-tier 7, so whichever is later in the DOM paints on top and a shared anchor is a silent occlusion no
 * source scan can see. Ported from tests/e2e/gates/measured-design.mjs.
 *
 * WHY SYNTHETIC BOXES: those classes render only in the PLAYING branch, which needs live WS playback this
 * drive has no processed media for. One element per class is MOUNTED under the real `.tv`, where the loaded
 * stylesheet positions it as production does, with a realistic `.upnext` height and production DOM order.
 *
 * ONE TEST PER VIEWPORT: the two readings are independent, and 4K is the one that has caught a regression, so
 * it is worth a failure that names itself.
 */
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import type { Page } from '@playwright/test';

interface Box {
	l: number;
	t: number;
	r: number;
	b: number;
	w: number;
	h: number;
}

interface Overlap {
	cls: string;
	area: number;
	box: Box;
}

/** Either the scope hash could not be recovered — in which case nothing was mounted and there is nothing to
 *  measure — or the full reading. Discriminated on `noScope`, so neither half can be read as the other. */
type OverlapResult =
	| { noScope: string }
	| {
			fs: Box;
			upH: number;
			scopes: Record<string, string>;
			overlaps: Overlap[];
			viewport: string;
	  };

async function readOverlaps(page: Page): Promise<OverlapResult | null> {
	return page.evaluate(
		({ tvRoot }): OverlapResult | null => {
			const tv = document.querySelector<HTMLElement>(tvRoot);
			if (!tv) return null;
			// The route's CSS is Svelte-SCOPED ('.fs-btn.svelte-HASH'), so a bare class gets NONE of the production
			// positioning, and .corner belongs to a DIFFERENT component with its own hash. Resolve each hash from the
			// live stylesheets and fail loudly if one is missing: an unscoped box measures unstyled geometry.
			function scopeFor(cls: string): string | null {
				const re = new RegExp('\\.' + cls + '\\.(svelte-[a-z0-9]+)');
				for (const sheet of document.styleSheets) {
					let rules: CSSRuleList | undefined;
					try {
						rules = sheet.cssRules;
					} catch {
						continue;
					}
					if (!rules) continue;
					for (const r of rules) {
						const selectorText = (r as CSSStyleRule).selectorText;
						const m = selectorText && re.exec(selectorText);
						if (m) return m[1];
					}
				}
				return null;
			}
			const scopes: Record<string, string> = {};
			for (const cls of ['fs-btn', 'upnext', 'lower-third', 'corner']) {
				const s = scopeFor(cls);
				if (!s) return { noScope: cls };
				scopes[cls] = s;
			}
			const holder = document.createElement('div');
			holder.setAttribute('data-889-probe', '1');
			// Production DOM order: chrome first, fs-btn LAST so it paints on top at equal z — the exact condition the
			// guard must catch. .upnext gets its real child classes so it wraps to a realistic height.
			const uh = scopes['upnext'];
			const lh = scopes['lower-third'];
			const ch = scopes['corner'];
			const specs = [
				{
					cls: 'lower-third',
					html: '<div class="ls-name ' + lh + '">Now singing</div><div class="ls-song ' + lh + '">A Song Title</div>'
				},
				{
					cls: 'upnext',
					html:
						'<span class="un-label ' +
						uh +
						'">Up next</span><span class="un-name ' +
						uh +
						'">A Fairly Long Singer Name Here</span><span class="un-song ' +
						uh +
						'">An Even Longer Wrapping Song Title That Grows The Block Past One Line On A Wall</span>'
				},
				{
					cls: 'corner',
					html:
						'<div class="qr ' +
						ch +
						'"><img width="88" height="88"></div><div class="meta ' +
						ch +
						'"><div class="t ' +
						ch +
						'">Scan to join</div><div class="u ' +
						ch +
						'">192.168.1.20:5173/join</div></div>'
				},
				{ cls: 'fs-btn', html: '' }
			];
			const made: Record<string, HTMLElement> = {};
			for (const s of specs) {
				const el = document.createElement(s.cls === 'fs-btn' ? 'button' : 'div');
				el.className = s.cls + ' ' + scopes[s.cls] + (s.cls === 'fs-btn' ? ' shown' : '');
				el.innerHTML = s.html;
				holder.appendChild(el);
				made[s.cls] = el;
			}
			tv.appendChild(holder);
			// Publish .upnext's REAL height as --tv-upnext-h, as the production ResizeObserver does: without it a
			// fixed-offset regression (one ignoring the token) would not overlap the block here.
			const upH = Math.ceil(made['upnext'].getBoundingClientRect().height);
			tv.style.setProperty('--tv-upnext-h', upH + 'px');
			// Reflow so .fs-btn's top:calc(... + var(--tv-upnext-h) ...) re-resolves against the new value.
			void made['fs-btn'].getBoundingClientRect();
			const rect = (el: Element): Box => {
				const r = el.getBoundingClientRect();
				return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height };
			};
			const fs = rect(made['fs-btn']);
			const others = ['lower-third', 'upnext', 'corner'].map((c) => ({ cls: c, box: rect(made[c]) }));
			const overlaps: Overlap[] = [];
			for (const o of others) {
				const ix = Math.max(0, Math.min(fs.r, o.box.r) - Math.max(fs.l, o.box.l));
				const iy = Math.max(0, Math.min(fs.b, o.box.b) - Math.max(fs.t, o.box.t));
				const area = Math.round(ix * iy);
				if (area > 0) overlaps.push({ cls: o.cls, area, box: o.box });
			}
			const out = { fs, upH, scopes, overlaps, viewport: window.innerWidth + 'x' + window.innerHeight };
			holder.remove();
			tv.style.removeProperty('--tv-upnext-h');
			return out;
		},
		{ tvRoot: SEL.tvRoot }
	);
}

for (const [w, h] of [
	[1920, 1080],
	[3840, 2160]
] as const) {
	test(`CLAIM 5b .fs-btn overlaps no z-tier-7 chrome box at ${w}x${h}`, async ({ world }) => {
		const page = await world.openTv();
		await page.setViewportSize({ width: w, height: h });
		await page.locator(SEL.tvRoot).first().waitFor({ state: 'attached', timeout: 15_000 });
		// A DWELL: the synthetic boxes are positioned by the loaded stylesheet against a viewport that has just
		// changed, so the layout has to settle before the mount measures anything.
		await page.waitForTimeout(300);

		const o = await readOverlaps(page);
		if (o === null) {
			expect
				.soft(o, `CLAIM 5b .fs-btn overlaps no z-tier-7 chrome box at ${w}x${h}: no .tv root to mount the probe on`)
				.not.toBeNull();
		} else if ('noScope' in o) {
			expect
				.soft(
					o.noScope,
					`CLAIM 5b .fs-btn overlaps no z-tier-7 chrome box at ${w}x${h}: could not recover the Svelte scope hash for ` +
						`.${o.noScope} from /tv — the probe would measure an unstyled box, so it is failed rather than trusted`
				)
				.toBeUndefined();
		} else {
			expect
				.soft(
					o.overlaps,
					`CLAIM 5b .fs-btn overlaps no z-tier-7 chrome box at ${w}x${h}: ` +
						`fs-btn ${Math.round(o.fs.w)}x${Math.round(o.fs.h)} @(${Math.round(o.fs.l)},${Math.round(o.fs.t)}) ` +
						`upnext-h=${o.upH} — the button must clear the lower-third, Up-next and join QR entirely, not merely ` +
						'differ in one anchor'
				)
				.toEqual([]);
		}
	});
}
