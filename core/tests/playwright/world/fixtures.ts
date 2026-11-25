// THE fixture. Everything a spec needs to make a real party happen, and the only place that knows how: the
// port, the /health poll, the server spawn, the scratch directory and the browser launch.
//
// WHY A CORE PER TEST, not per worker. The room code renders on /tv only while the room is EMPTY, and a boot
// mints exactly one room — so two tests sharing a core cannot both start from a virgin room, and the second
// one reads a lobby instead of a code. Correctness beats the boot cost; if it ever dominates, the fix is a
// room-reset endpoint, not a shared world.
import { test as base, expect, type Page, type Browser } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCore, TEST_HOST_KEY, type Core } from './core';
import { DEMO_LIBRARY, seedDemoLibrary, seedMadeLibrary, type DemoTrack as SeedTrack } from './seed';
import { SEL } from './selectors';

export interface JoinOptions {
	/** A key for the colour ring — it is a `role="slider"` over 48 stops, so a colour is a keypress and
	 *  there is no per-colour element to click. `Home`/`End` are the two ends. */
	stop?: string;
}

/** The join screen's colour sits behind "change" (redesign step 7): open the ring, press `key` on it, close it. */
export async function pickColour(page: Page, key: string): Promise<void> {
	await page.locator(SEL.colourChange).click();
	await page.locator(SEL.colourRing).press(key);
	await page.getByRole('dialog').getByRole('button', { name: 'Done' }).click();
}

export interface DemoTrack {
	id: string;
	source: string;
	sourceRef: string;
	title: string;
	durationSec: number;
}

export interface World {
	readonly core: Core;
	readonly baseURL: string;
	readonly mediaDir: string;
	/** The active room's join code, read off the attract panel before anybody joined. */
	readonly code: string;
	/** The room's TV, as the `encore_tv` cookie it would get from GET /tv. Every TV this world opens carries it, so
	 *  they are ONE screen reloading, not a second screen that is a copy while the seat waits for the first. A spec
	 *  that builds its own TV context adds it: `ctx.addCookies([world.tvCookie])`. See docs/SERVER.md#the-tv-seat. */
	readonly tvCookie: { name: string; value: string; url: string };
	/** Join through the real screen and land on the joined home. Names must be unique per room — a reused
	 *  one gets a 409 and the join page simply stays put, which looks exactly like a broken flow. */
	joinAs(page: Page, name: string, options?: JoinOptions): Promise<void>;
	/** A TV page bound to this room, on a 1080p viewport because the TV's type scale is vh-relative. */
	openTv(): Promise<Page>;
	/** A joined phone on its own context, so its session cookie is its own. */
	openPhone(name: string, options?: JoinOptions): Promise<Page>;
	/** Make this page's context the host, as opening the boot link does. Settings writes, /metrics and /admin need it. */
	becomeHost(page: Page): Promise<void>;
	/** A GET from the test process, as the host: /api/metrics answers no one else. */
	hostGet(path: string): Promise<Response>;
	/**
	 * Wait until the seeded library is INDEXED and hand back one track.
	 *
	 * Necessary because the library scan is a detached boot pass: `/health` answers before it finishes, and it
	 * spawns one ffmpeg per file to read a duration. Measured on this box — `?q=caroline` returned 0 local hits
	 * immediately after boot and 1 about four seconds later. A phone that types before then gets an answer from
	 * an empty index, and nothing re-runs the query, so the search looks broken rather than early.
	 */
	awaitDemoTrack(match?: string): Promise<DemoTrack>;
}

export const test = base.extend<{
	world: World;
	coreEnv: Record<string, string>;
	demoLibrary: SeedTrack[];
	madeSongs: number;
}>({
	/**
	 * Extra environment for this file's core, e.g.
	 * `test.use({ coreEnv: { ENCORE_PUBLIC_ORIGIN: 'http://192.168.1.20:3000' } })`.
	 *
	 * An `option` fixture rather than something the test body sets, because core boots before the body runs —
	 * a spec whose CONFIGURATION is the experiment has to declare it at file or describe scope.
	 */
	coreEnv: [{}, { option: true }],
	/** The library this file's core boots with. A spec that needs a song longer than the 8 s fixture adds one, in
	 *  the tuple form, because Playwright reads a bare array of objects as `[value, options]`:
	 *  `test.use({ demoLibrary: [[...DEMO_LIBRARY, { file: 'long.wav', seconds: 40, hz: [220] }], { scope: 'test' }] })`. */
	demoLibrary: [DEMO_LIBRARY, { option: true }],
	/** How many already-made songs (sidecars in `meta/` and their files) core boots with, for a spec that needs a
	 *  large library (`seedMadeLibrary`). */
	madeSongs: [0, { option: true }],

	// Playwright's own `page`/`request` fixtures resolve relative URLs against this, so overriding it here is
	// what lets a spec write `page.goto('/tv')` with no base in sight.
	baseURL: async ({ world }, use) => {
		await use(world.baseURL);
	},

	world: async ({ browser, coreEnv, demoLibrary, madeSongs }, use, testInfo) => {
		const mediaDir = mkdtempSync(join(tmpdir(), 'enc-media-'));
		// BEFORE core boots: indexing the library is a boot pass, so a file written afterwards is not in it.
		seedDemoLibrary(mediaDir, demoLibrary);
		if (madeSongs) seedMadeLibrary(mediaDir, madeSongs);
		const core = await startCore({ mediaDir, env: coreEnv });

		const opened: Page[] = [];
		const newPage = async (b: Browser, viewport: { width: number; height: number }) => {
			const context = await b.newContext({ viewport, baseURL: core.baseURL });
			const page = await context.newPage();
			opened.push(page);
			return page;
		};

		const tvCookie = { name: 'encore_tv', value: randomBytes(24).toString('base64url'), url: core.baseURL };
		const newTvPage = async (viewport: { width: number; height: number }) => {
			const page = await newPage(browser, viewport);
			await page.context().addCookies([tvCookie]);
			return page;
		};

		// Read while the room is guaranteed empty. A TV is not a room MEMBER — presence counts singers — so
		// this does not spend the emptiness the attract panel depends on.
		const probe = await newTvPage({ width: 1280, height: 720 });
		await probe.goto('/tv');
		const code = (await probe.locator(SEL.attractCode).first().innerText({ timeout: 20_000 })).trim();
		await probe.context().close();
		opened.pop();
		// Loud, with the remedy: an empty code turns every join below into a pane timeout that reads as a UI
		// bug rather than an environment one.
		expect(
			code,
			`could not read the room code off ${core.baseURL}/tv. The attract panel renders it only while the ` +
				`room is EMPTY, so something joined before this fixture did.\n\n${core.log()}`
		).toMatch(/^[A-Z0-9]{6}$/);

		let hostCookie = '';
		const joinAs: World['joinAs'] = async (page, name, { stop } = {}) => {
			// `?room=` lands on the IDENTITY pane. A bare goto('/') lands on the six-box CODE pane, where the
			// name field does not exist — the single most common way a flow times out against nothing.
			await page.goto(`/?room=${encodeURIComponent(code)}`);
			await page.locator(SEL.nameInput).fill(name);
			if (stop) await pickColour(page, stop);
			// The label IS the regex source, so the button is derived rather than re-typed.
			await page.getByRole('button', { name: SEL.submit }).click();
			// The join reloads `/` by hand — a client-side goto from `/` to `/` is a no-op — so wait for the
			// DOCK, not for a URL change. The path never changes. The dock and not the strip inside it: a virgin
			// room has nothing queued, so the strip does not render and a wait on it would never resolve.
			await page.locator(SEL.dock).waitFor({ state: 'attached' });
		};

		await use({
			core,
			baseURL: core.baseURL,
			mediaDir,
			code,
			tvCookie,
			joinAs,
			openTv: async () => {
				const page = await newTvPage({ width: 1920, height: 1080 });
				await page.goto(`/tv?room=${encodeURIComponent(code)}`);
				return page;
			},
			openPhone: async (name, options) => {
				const page = await newPage(browser, { width: 390, height: 844 });
				await joinAs(page, name, options);
				return page;
			},
			becomeHost: async (page) => {
				const res = await page.request.post('/api/host', { data: { key: TEST_HOST_KEY } });
				expect(res.status(), `POST /api/host with the test key\n\n${core.log()}`).toBe(200);
			},
			hostGet: async (path) => {
				if (!hostCookie) {
					const res = await fetch(`${core.baseURL}/api/host`, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ key: TEST_HOST_KEY })
					});
					expect(res.status, `POST /api/host with the test key\n\n${core.log()}`).toBe(200);
					hostCookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
				}
				return fetch(`${core.baseURL}${path}`, { headers: { cookie: hostCookie } });
			},
			awaitDemoTrack: async (match = 'caroline') => {
				const deadline = Date.now() + 30_000;
				let seen = 'nothing';
				while (Date.now() < deadline) {
					const body = (await fetch(`${core.baseURL}/api/search?q=${encodeURIComponent(match)}`)
						.then((r) => (r.ok ? r.json() : null))
						.catch(() => null)) as { ready?: DemoTrack[]; processing?: DemoTrack[]; results?: DemoTrack[] } | null;
					const all = [...(body?.ready ?? []), ...(body?.processing ?? []), ...(body?.results ?? [])];
					const local = all.find((m) => m.source === 'local' && m.sourceRef?.includes(match));
					if (local) return local;
					seen = `${all.length} result(s), none local`;
					await new Promise((r) => setTimeout(r, 250));
				}
				// Names the real cause: an empty index means the scan skipped the files, which it does when it
				// cannot read a duration — so the fixture is undecodable or ffmpeg is missing.
				throw new Error(
					`the seeded library never indexed a local track matching "${match}" within 30s (last saw ${seen}). ` +
						`The scan skips any file whose duration ffmpeg cannot read.\n\n${core.log()}`
				);
			}
		});

		// Core's output is attached on failure, because "the queue never moved" is unreadable without it.
		if (testInfo.status !== testInfo.expectedStatus) {
			await testInfo.attach('core.log', { body: core.log(), contentType: 'text/plain' });
		}
		// A passing test can still hide a server error, so this keeps every test's log (docs/E2E.md#keeping-cores-log).
		if (process.env.ENCORE_KEEP_CORE_LOG === '1') writeFileSync(testInfo.outputPath('core.log'), core.log());
		for (const page of opened)
			await page
				.context()
				.close()
				.catch(() => {});
		// `core.stop()` removes its own DATA_DIR. The media dir is ours, and it is the expensive one: four 689KB
		// library WAVs plus whatever the fake worker published (instrumental, vocals, sometimes a guide mix, ~689KB
		// each), so ~3-5MB per test. Leaving these behind filled this machine's disk mid-session — 1101 orphaned
		// directories, 4.3GB, until every command failed with ENOSPC. Unconditional, and after the attach above:
		// what a failed test needs is core.log(), not 5MB of fixture audio.
		await core.stop();
		rmSync(mediaDir, { recursive: true, force: true });
	}
});

export { expect };
