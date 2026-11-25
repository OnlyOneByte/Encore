// The strip's waiting line, measured on the render: the WHOLE sentence shows (no ellipsis, no line cut off), in at
// most two lines, inside the strip, and the strip keeps its one tap floor (the dock does not grow). Shared by CLAIM 8
// (the no-maker line) and p21 (the singer's failure sentence).
import { expect, type Page } from '@playwright/test';
import { SEL } from '../../world/selectors';

export async function stripReadsWhole(page: Page, label: string): Promise<void> {
	const m = await page.evaluate(
		([statusSel, transportSel]) => {
			const s = document.querySelector(statusSel) as HTMLElement;
			const strip = s.closest('.strip') as HTMLElement;
			// Where the TEXT paints, not where the box ends: the range of glyphs, cut at the box only where it clips.
			const range = document.createRange();
			range.selectNodeContents(s);
			const lines = new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
			const box = strip.getBoundingClientRect();
			return {
				text: s.textContent?.trim() ?? '',
				textRight: Math.min(range.getBoundingClientRect().right, s.getBoundingClientRect().right),
				stripRight: box.right - parseFloat(getComputedStyle(strip).paddingRight),
				dockKeys: document.querySelectorAll(transportSel).length,
				cutWide: s.scrollWidth > s.clientWidth,
				cutTall: s.scrollHeight > s.clientHeight + 1,
				lines,
				stripHeight: box.height,
				tap: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tap'))
			};
		},
		[SEL.npStripStatus, SEL.dockTransport] as const
	);
	const why = `${label}: measured ${JSON.stringify(m)}`;
	expect(m.cutWide || m.cutTall, `the line is cut off, so part of the sentence is hidden: ${why}`).toBe(false);
	expect(m.lines, `the line takes more than two lines: ${why}`).toBeLessThanOrEqual(2);
	expect(m.textRight, `the line paints past the strip's edge: ${why}`).toBeLessThanOrEqual(m.stripRight + 0.5);
	expect(m.dockKeys, `the dock carries a transport key again: ${why}`).toBe(0);
	// The strip is one tap floor, as when a song plays; a taller one would grow the dock above --dock-h's measure.
	expect(Math.round(m.stripHeight), `the strip grew past its tap floor: ${why}`).toBeLessThanOrEqual(m.tap + 1);
}
