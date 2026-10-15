/*
 * P18 — /song/[mediaId], AND WHETHER IT SAYS ANYTHING BACK.
 *
 * WHY THIS SPEC EXISTS. Three defects on this surface were all of one kind: the page performed a write or a
 * fetch and then reported nothing at all. A re-pick that the server REFUSED (401 not joined, 409 not-processed,
 * 409 unknown-candidate, 400 no-text — sentences the endpoint's own comment says are worded "so the phone can
 * say why nothing happened") produced zero toasts, zero inline text, and left the tapped row `disabled` +
 * `aria-busy` forever, because the server broadcasts no `media:status` for a refusal and the local pending flag
 * had no other way down. A re-pick that was ACCEPTED produced nothing either, since `media` is written only by
 * `load()` and `load()` ran only from the `mediaId`-keyed effect — so the page could not observe a write it made
 * itself. And a load that FAILED rendered a bare sentence with no control, re-enterable only by remounting the
 * component.
 *
 * WHAT IS REAL AND WHAT IS STUBBED, stated because it decides what each test proves.
 *   · The REFUSAL test uses the real endpoint and the real refusal: a freshly indexed local song has no vocals
 *     stem, so `requestLyricsReselect` answers `not-processed` for any pick. Only the audit body is augmented,
 *     with one synthetic candidate — the control renders off stored candidates, and earning a real one costs an
 *     align job (p6 pays that; this spec's subject is the reporting, not the ranking).
 *   · The ACCEPTED test stubs the POST and the re-read, because a real 200 needs a retained vocals stem and the
 *     claim under test is entirely client-side: that the page re-asks after its own write, and that it does so
 *     WITHOUT flipping `loading` — which would unmount LyricsReselect and collapse the disclosure the guest is
 *     standing in. The store's half of the contract (false on refusal, true on 200) is proven against the real
 *     code paths in tests/unit/lib/stores/room-reselect-lyrics.test.ts.
 *   · The FAILED-LOAD test is fully real apart from the aborted fetch, which is the reported scenario.
 *
 * NO FAKE WORKER AND NO SEPARATION HERE. Nothing below needs a processed song — which is also what makes the
 * real refusal available for free.
 */
import { test, expect, type World } from '../../world/fixtures';
import type { Page } from '@playwright/test';
import type { LyricsCandidate, Media } from '$lib/contract';

interface SearchBody {
	ready: Media[];
	processing: Media[];
	results: Media[];
}
interface AuditBody {
	media: Media | null;
	[k: string]: unknown;
}

/** The server's verbatim refusal for a song with no vocals stem (src/routes/api/lyrics-reselect/+server.ts). */
const NOT_PROCESSED = 'that song is not processed yet — there is nothing to re-time';

/** One indexed local song, with no processing of any kind. `awaitDemoTrack` first, because the library scan is a
 *  detached boot pass and the index is empty for seconds after `/health` answers. */
async function oneIndexedSong(world: World, phone: Page): Promise<Media> {
	const track = await world.awaitDemoTrack();
	const found = (await phone.request
		.get(`/api/search?q=${encodeURIComponent(track.title)}`)
		.then((r) => r.json())) as SearchBody;
	const row = [...found.ready, ...found.processing, ...found.results].find((x) => x.source === 'local');
	if (!row) throw new Error(`no local song matching "${track.title}" — the demo fixture did not index`);
	return row;
}

/** A stored candidate, in the shape the worker emits. `lrclib`/`line` so the row reads "Synced lyrics". */
const candidate = (ref: string): LyricsCandidate => ({
	ref,
	textSource: 'lrclib',
	timing: 'line',
	textConfidence: 'high',
	createdAt: Date.now()
});

test('a REFUSED pick says why, releases the control, and keeps the pasted words', async ({ world }) => {
	const phone = await world.openPhone('Sonny');
	const row = await oneIndexedSong(world, phone);

	// The one stub: a candidate for the control to render. Everything the tap then does is the real server.
	await phone.route(`**/api/audit/${row.id}`, async (route) => {
		const body = (await route.fetch().then((r) => r.json())) as AuditBody;
		if (!body.media) throw new Error(`/api/audit/${row.id} returned no media row`);
		await route.fulfill({
			json: { ...body, media: { ...body.media, lyricsCandidates: [candidate('derived/lyrics/p18.json')] } }
		});
	});

	await phone.goto(`${world.baseURL}/song/${row.id}`);
	await expect(phone.locator('.facts.card')).toBeVisible();
	await phone.locator('.reselect-toggle').click();
	const opt = phone.locator('.reselect-opt');
	await expect(opt).toHaveCount(1);
	await expect(phone.locator('.reselect-peek')).toHaveText('Auto-selected');

	await opt.click();

	// THE WHOLE POINT: the server's sentence reaches the phone, once. Before the fix the link's error channel
	// had no subscriber on the only route that can produce these messages, so every refusal was dropped.
	await expect(phone.locator('[data-sonner-toast]')).toHaveCount(1);
	await expect(phone.locator('[data-sonner-toast]')).toContainText(NOT_PROCESSED);

	/* AND THE ROW COMES BACK. `justPicked` is set on the tap and cleared by the live status — which never
	   arrives for a refusal, because the endpoint returns before publishing anything. Without the refusal
	   releasing it by hand this row stayed disabled and aria-busy until the guest reloaded. */
	await expect(opt).toBeEnabled();
	expect(await opt.getAttribute('aria-busy')).toBeNull();
	await expect(phone.locator('.reselect-peek')).toHaveText('Auto-selected');

	// THE PASTE HALF. `submitPaste` used to collapse the disclosure and drop the draft unconditionally, so a
	// refusal read as faint acceptance AND threw away the verse.
	await phone.locator('.reselect-paste-open').click();
	const stamp = 'P18 PASTE STAMP\nsecond line';
	await phone.locator('[data-slot="textarea"]').fill(stamp);
	await phone.locator('[data-act="confirm"]').click();

	await expect(phone.locator('[data-sonner-toast]')).toHaveCount(2);
	await expect(phone.locator('[data-slot="textarea"]')).toHaveValue(stamp);
	await expect(opt).toHaveCount(1); // the disclosure is still open
});

test('an ACCEPTED pick is re-read, without collapsing the disclosure', async ({ world }) => {
	const phone = await world.openPhone('Reeda');
	const row = await oneIndexedSong(world, phone);

	/* The re-read's observable is a SECOND candidate arriving — a worker's answer to the pick would reach the
	   page the same way. Counting the requests alone would pass on a page that re-asked and dropped the reply. */
	let audits = 0;
	await phone.route(`**/api/audit/${row.id}`, async (route) => {
		const body = (await route.fetch().then((r) => r.json())) as AuditBody;
		if (!body.media) throw new Error(`/api/audit/${row.id} returned no media row`);
		audits++;
		const cands = [candidate('derived/lyrics/p18.json')];
		if (audits > 1) cands.push(candidate('derived/lyrics/p18-manual-word.json'));
		await route.fulfill({ json: { ...body, media: { ...body.media, lyricsCandidates: cands } } });
	});
	await phone.route('**/api/lyrics-reselect', (route) =>
		route.fulfill({ json: { job: { id: 'p18' }, ref: 'derived/lyrics/p18-manual-word.json' } })
	);

	await phone.goto(`${world.baseURL}/song/${row.id}`);
	await expect(phone.locator('.facts.card')).toBeVisible();
	await phone.locator('.reselect-toggle').click();
	await expect(phone.locator('.reselect-opt')).toHaveCount(1);
	expect(audits).toBe(1);

	await phone.locator('.reselect-opt').first().click();

	// The page re-asked and committed what came back. It used to issue ZERO further audit requests, so the
	// control kept describing the state before the tap until a reload.
	await expect(phone.locator('.reselect-opt')).toHaveCount(2);
	expect(audits).toBe(2);

	/* THE REGRESSION THE QUIET RE-READ GUARDS AGAINST, and the reason `load()` takes a `quiet` flag at all: a
	   plain re-load flips `loading`, which swaps the body for the skeleton, unmounts this component and loses
	   `open`/`pasting`/`draft` — a confirmation that destroys what it is confirming. */
	await expect(phone.locator('.facts.card')).toBeVisible();
	await expect(phone.locator('[data-slot="skeleton"]')).toHaveCount(0);

	// The pending peek is the confirmation on the control the guest actually touched. It outlives a toast on
	// purpose: the re-time itself takes a worker, and this label is true for the whole wait.
	await expect(phone.locator('.reselect-peek')).toHaveText('Re-timing the words…');
	await expect(phone.locator('[data-sonner-toast]')).toHaveCount(0);
});

test('a FAILED load offers a retry, and the retry recovers the page', async ({ world }) => {
	const phone = await world.openPhone('Dedd');
	const row = await oneIndexedSong(world, phone);

	/* ONE handler with a flag rather than route-then-unroute: a "Try again" that fires no request at all would
	   pass the un-routed version, since clearing the flag alone would clear the error. */
	let block = true;
	await phone.route(`**/api/audit/${row.id}`, async (route) => {
		if (block) await route.abort('failed');
		else await route.continue();
	});

	await phone.goto(`${world.baseURL}/song/${row.id}`);

	const description = phone.locator('.load-error [data-slot="empty-description"]');
	await expect(description).toHaveText("Couldn't load this song.");
	// ONE control in `main`, and it is the retry. This arm used to hold a bare `<p>` and nothing else at all.
	await expect(phone.locator('main button, main a, main [role="button"]')).toHaveCount(1);
	await expect(phone.getByRole('button', { name: 'Try again' })).toBeVisible();
	// Announced ONCE. The same sentence was also toasted, so a screen reader heard it twice.
	await expect(phone.locator('[role="alert"]')).toHaveCount(1);
	await expect(phone.locator('[data-sonner-toast]')).toHaveCount(0);

	// The ink the `.load-error` comment argues for has to reach THROUGH the Empty primitive now, so read it off
	// the element rather than trusting the wrapper's rule.
	const colours = await description.evaluate((el) => ({
		ink: getComputedStyle(el).color,
		danger: getComputedStyle(document.documentElement).getPropertyValue('--danger-ink').trim()
	}));
	const resolved = await phone.evaluate((raw) => {
		const probe = document.createElement('span');
		probe.style.color = raw;
		document.body.append(probe);
		const c = getComputedStyle(probe).color;
		probe.remove();
		return c;
	}, colours.danger);
	expect(colours.ink).toBe(resolved);

	block = false;
	await phone.getByRole('button', { name: 'Try again' }).click();
	await expect(phone.locator('.facts.card')).toBeVisible();
	await expect(phone.locator('.load-error')).toHaveCount(0);
});
