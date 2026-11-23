// The strip's waiting line, measured on the render: the WHOLE sentence shows (no ellipsis, no line cut off), in at
// most two lines, painted before the first live transport button, and the strip keeps its one tap floor (the dock does
// not grow). Shared by CLAIM 8 (the no-maker line) and p21 (the singer's failure sentence).
import { expect, type Page } from '@playwright/test';
import { SEL } from '../../world/selectors';

export async function stripReadsWhole(page: Page, label: string): Promise<void> {
	const m = await page.evaluate(
		([statusSel, transportSel]) => {
			const s = document.querySelector(statusSel) as HTMLElement;
			// The first LIVE key: with no song Restart rests inert in place, as the Cheer key does, and the line runs on
			// over its slot. `inert` and not visibility, which switches only at the end of the key's fade out.
			const first = [...document.querySelectorAll<HTMLElement>(transportSel)].find((b) => !b.inert) as HTMLElement;
			const strip = s.closest('.strip') as HTMLElement;
			// Where the TEXT paints, not where the box ends: the range of glyphs, cut at the box only where it clips.
			const range = document.createRange();
			range.selectNodeContents(s);
			const lines = new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
			return {
				text: s.textContent?.trim() ?? '',
				textRight: Math.min(range.getBoundingClientRect().right, s.getBoundingClientRect().right),
				transportLeft: first.getBoundingClientRect().left,
				cutWide: s.scrollWidth > s.clientWidth,
				cutTall: s.scrollHeight > s.clientHeight + 1,
				lines,
				stripHeight: strip.getBoundingClientRect().height,
				tap: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tap'))
			};
		},
		[SEL.npStripStatus, SEL.npTransport] as const
	);
	const why = `${label}: measured ${JSON.stringify(m)}`;
	expect(m.cutWide || m.cutTall, `the line is cut off, so part of the sentence is hidden: ${why}`).toBe(false);
	expect(m.lines, `the line takes more than two lines: ${why}`).toBeLessThanOrEqual(2);
	expect(m.textRight, `the line paints under a live transport button: ${why}`).toBeLessThanOrEqual(m.transportLeft);
	// The strip is one tap floor, as when a song plays; a taller one would grow the dock above --dock-h's measure.
	expect(Math.round(m.stripHeight), `the strip grew past its tap floor: ${why}`).toBeLessThanOrEqual(m.tap + 1);
}
