// CLAIM 15 TV chrome stays inside --tv-safe-x/y at 1920x1080. What counts as chrome: docs/E2E.md#speed-gate.
import type { Page } from '@playwright/test';
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { queueReady, readySong } from '../../world/actors';

async function outside(page: Page) {
	return page.evaluate(() => {
		const probe = document.createElement('div');
		probe.style.cssText = 'position:fixed;left:var(--tv-safe-x);top:var(--tv-safe-y);width:0;height:0';
		document.querySelector('.tv')!.appendChild(probe);
		const sx = probe.getBoundingClientRect().left;
		const sy = probe.getBoundingClientRect().top;
		probe.remove();
		const W = window.innerWidth;
		const H = window.innerHeight;
		const out: { what: string; box: number[] }[] = [];
		const stage = '.lyrics:not(.no-lyrics), .stage, .visualizer, .backdrop, canvas, video';
		for (const el of document.querySelectorAll<HTMLElement>('.tv *')) {
			if (el.closest(stage)) continue;
			const leaf =
				el.matches('img, button, svg, [role="img"]') ||
				[...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim() !== '');
			if (!leaf || (el.closest('svg') !== null && !el.matches('svg'))) continue;
			if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
			const r = el.getBoundingClientRect();
			if (r.width === 0 || r.height === 0) continue;
			// Half a pixel for subpixel layout.
			if (r.left < sx - 0.5 || r.top < sy - 0.5 || r.right > W - sx + 0.5 || r.bottom > H - sy + 0.5)
				out.push({
					what: `${el.nodeName}.${String(el.getAttribute('class') ?? '').slice(0, 40)} "${(el.textContent ?? '').trim().slice(0, 30)}"`,
					box: [r.left, r.top, r.right, r.bottom].map(Math.round)
				});
		}
		return { safe: [Math.round(sx * 10) / 10, Math.round(sy * 10) / 10], out };
	});
}

test('CLAIM 15 TV chrome stays inside the safe area at 1920x1080, empty room and during a song', async ({ world }) => {
	const worker = await startFakeWorker(world);
	try {
		const tv = await world.openTv();
		await expect(tv.locator(SEL.attractCode).first()).toBeVisible();
		await tv.waitForTimeout(1000); // the attract phrase's ruled 600 ms fade
		const empty = await outside(tv);
		expect.soft(empty.out, `CLAIM 15 empty room, safe area ${empty.safe.join(' x ')} px`).toEqual([]);
		// A canary in the band proves the reader catches one.
		await tv.evaluate(() => {
			const s = document.createElement('span');
			s.id = 'sa-canary';
			s.textContent = 'canary';
			s.style.cssText = 'position:fixed;left:10px;top:10px;font-size:20px';
			document.querySelector('.tv')!.appendChild(s);
		});
		const canary = await outside(tv);
		await tv.evaluate(() => document.getElementById('sa-canary')?.remove());
		expect(
			canary.out.map((o) => o.what),
			'CLAIM 15 the reader missed a word in the overscan band'
		).toContainEqual(expect.stringContaining('canary'));

		const maya = await world.openPhone('Maya');
		await readySong(world, maya, 'caroline');
		await queueReady(maya, 'caroline');
		await expect(tv.locator(SEL.stateNext)).toBeHidden({ timeout: 30_000 });
		await tv.waitForTimeout(500);
		const song = await outside(tv);
		expect.soft(song.out, `CLAIM 15 during a song, safe area ${song.safe.join(' x ')} px`).toEqual([]);
	} finally {
		await worker.stop();
	}
});
