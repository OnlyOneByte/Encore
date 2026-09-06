/*
 * Capture the #68 failed-cook-scar before/after on the phone page.
 *
 * The feature's input is one localStorage key (encore:cook-scars). The phone gates behind a join, so
 * the flow joins the room first, then compares two reloads that differ ONLY by that key:
 *   BEFORE — key absent: the state a reload left the phone in before this fix. The live `failed`
 *            status was in-memory only, so it was gone and nothing re-surfaced it; the song shows no
 *            failed row at all.
 *   AFTER  — a real scar in localStorage: the new mount code merges the snapshot into the catalog and
 *            marks it failed, so the row paints its red "Couldn't make karaoke" chip + Sing retry under
 *            the "Cooking · one didn't work" group head — the same row a live failure renders.
 * Same build, same server; only the persisted scar the fix consumes changes.
 */
import { connect, sleep } from './cdp.mjs';

const base = `http://127.0.0.1:${process.env.EPORT ?? '5568'}`;
const CDP_PORT = Number(process.env.CDP_PORT ?? 9368);

const SCAR_MEDIA = {
	id: 'demo-failed-1',
	source: 'youtube',
	sourceRef: 'dQw4w9WgXcQ',
	title: 'Never Gonna Give You Up',
	artist: 'Rick Astley',
	durationSec: 213
};
const SCAR_JSON = JSON.stringify({
	[SCAR_MEDIA.id]: { expiresAt: Date.now() + 1_800_000, media: SCAR_MEDIA }
});

const browser = await connect(CDP_PORT);
const ctx = await browser.newPage();

// Join once — the phone redirects to /join until a singer exists in this context's cookie jar.
await ctx.goto(base + '/');
await ctx.viewport(390, 844, 2);
await ctx.waitFor(`location.pathname === '/join'`);
await ctx.fill('input[placeholder^="e.g."]', 'Angelo');
await ctx.clickByText('Start singing');
await ctx.waitFor(`location.pathname === '/'`);
await sleep(600);

async function shoot(name, seedScar) {
	await ctx.evaluate(`(() => {
		localStorage.removeItem('encore:cook-scars');
		${seedScar ? `localStorage.setItem('encore:cook-scars', ${JSON.stringify(SCAR_JSON)});` : ''}
	})()`);
	await ctx.goto(base + '/'); // reload so onMount reads the (seeded or absent) scar
	await sleep(1400);
	const markers = await ctx.evaluate(
		`[...document.querySelectorAll('*')].filter(e => (e.textContent||'').includes("Couldn't make karaoke")).length`
	);
	const path = `docs/shots/68/${name}.png`;
	await ctx.screenshot(path, { fullPage: true });
	console.log(`${name}: "Couldn't make karaoke" markers=${markers} -> ${path}`);
	return markers;
}

const before = await shoot('before-reload-no-scar', false);
const after = await shoot('after-reload-with-scar', true);
console.log(`RESULT before=${before} after=${after} (expect before=0, after>=1)`);
process.exit(before === 0 && after >= 1 ? 0 : 3);
