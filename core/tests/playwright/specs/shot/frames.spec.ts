// THE FRAME TABLE. One spec in place of five screenshot tools — tests/e2e/shot.mjs, shot-settings.mjs,
// shot-metrics.mjs, shoot.mjs and capture.mjs, 1,109 lines between them.
//
// Those five differed on exactly two axes: who owns the server, and which frames. The first is gone — the
// `world` fixture boots a seeded core per test — so all that is left is a table, and a frame is
// `{ name, viewport, setup }`.
//
// A FRAME IS DRIVEN INTO ITS STATE, never photographed as it loads. That is the whole point capture.mjs was
// making, and it survives as a rule about waits: every `setup` below ends on a condition — an `aria-selected`
// that only flips once a panel has swapped, a row count, a notice appearing — and never on a duration. The
// old tree's `sleep(800)`s existed because its driver had no auto-waiting; none of them came across.
//
// EVIDENCE, NOT ASSERTIONS. shoot.mjs's own header: "deliberately in no gate list, because a screenshot
// cannot fail a build", which is also why the `shot` project carries `retries: 0` — a retry would silently
// overwrite a frame somebody is looking at. So every frame is written into `testInfo.outputDir` and attached
// to the report for a human or an agent to read. Exactly ONE frame also holds a pixel baseline; see
// `baseline` below for the one case where that is a real regression assertion rather than decoration.
//
// DPR 1, EVERYWHERE, DELIBERATELY. These frames get read back by a human or an agent, and anything over
// 2000px on an axis is unreadable in that pipeline. The `shot` project sets `deviceScaleFactor: 1`, and the
// contexts opened here (`world.openTv`, `world.openPhone`, and the anonymous ones below) come from `browser`
// directly, where Playwright's own default is also 1 — so the two agree rather than one overriding the other.
// Every viewport in the table is chosen to keep BOTH axes inside 2000.
//
// WHAT IS NOT HERE: every frame that needs a song to actually be sounding — the lyrics reel, the TV progress
// and background variants, the key shift, the per-song audit. Those need stems on disk and a granted autoplay
// policy; `world` seeds a raw library with no worker, and playwright.config.ts refuses the autoplay grant on
// purpose ("a television grants no gesture"). capture.mjs skipped them too whenever MEDIA_DIR was not a
// processed volume. They are dropped rather than skipped: this repo ruled a permanently-skipped test is
// indistinguishable from rot, so a frame that cannot be produced is absent and named in the port's notes,
// not present and yellow.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { openQueue } from '../../world/actors';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import type { World } from '../../world/fixtures';
import { METRICS_FIXTURE, METRICS_READY_TEXT } from './metrics-fixture';

interface Viewport {
	width: number;
	height: number;
}

/**
 * Which page a frame is taken on.
 *  `anon` — a fresh context with no session: the join screen, and the two operator pages that are not
 *           join-gated. Its viewport is the frame's, set at context creation.
 *  `phone` — a joined phone (`world.openPhone`), because /settings redirects an unjoined visitor to the
 *           join gate and every settings write needs a singer.
 *  `tv`   — `world.openTv()`, which is 1920x1080 because the TV's type scale is vh-relative: shooting it
 *           smaller does not shrink the TV, it changes the design being reviewed.
 */
type Surface = 'anon' | 'phone' | 'tv';

interface Frame {
	name: string;
	/** What a reader is looking FOR. Annotated onto the test, so the frame arrives with its question. */
	what: string;
	surface: Surface;
	/** Omitted on `tv`: 1920x1080 is load-bearing there and `world.openTv()` already sets it. */
	viewport?: Viewport;
	/** The whole scrolling column rather than the fold. Replaces shoot.mjs's tall-viewport trick on the
	 *  phone: a phone laid out at 1500px tall is not a phone, so the viewport stays 844 and the CAPTURE
	 *  grows instead of the layout. */
	fullPage?: boolean;
	/** Hold a pixel baseline as well as evidence. Earned only by a frame whose every pixel comes from a
	 *  fixture — see `metrics-top`. */
	baseline?: boolean;
	setup(page: Page, world: World): Promise<void>;
}

/** A 390x844 phone. shot.mjs's own default size, and `world.openPhone`'s. */
const PHONE: Viewport = { width: 390, height: 844 };
/** shot-settings.mjs's size, kept with its reason: settings is eleven cards over three scope routes, and 430x1500
 *  at DPR 1 is what fits the LONGEST of them whole while staying inside the 2000px an agent can read back. */
const SETTINGS: Viewport = { width: 430, height: 1500 };
/** /metrics is an operator page with a 900px measure, so it is shot at desktop width; 1400 tall keeps the
 *  other axis under 2000. shot-metrics.mjs exposed these as SHOT_W/SHOT_H; the narrowing is now its own
 *  frame (`metrics-narrow`) rather than an env var nobody reading the frames can see. */
const METRICS_DESKTOP: Viewport = { width: 1000, height: 1400 };
/** The case the metrics tables' horizontal scroll exists for — shot-metrics.mjs's `SHOT_W` override. */
const METRICS_NARROW: Viewport = { width: 390, height: 1400 };

// ── the moves a frame is reached by ───────────────────────────────────────────────────────────────────────

/**
 * Open a settings SCOPE, which is a navigation now that the three are three routes — and wait on a control inside
 * the scope, not on the URL, because a route that has answered is not yet a panel that has rendered. The old form
 * clicked a tablist trigger and waited on `aria-selected`; there is no tablist to click.
 */
async function scope(page: Page, path: string, ready: string): Promise<void> {
	await page.goto(path);
	await expect(page.locator(ready)).toBeVisible();
}

/** The three scope routes, with the control each one is ready at. `/settings` IS the room scope. */
const SCOPE = {
	you: { path: '/settings/you', ready: SEL.setting('profile-name') },
	room: { path: '/settings', ready: SEL.setting('queue-order') },
	server: { path: '/settings/server', ready: SEL.setting('engine') }
} as const;

/** Bring a control into the frame and wait until it is actually there, rather than for a duration. */
async function reveal(page: Page, selector: string): Promise<void> {
	const control = page.locator(selector);
	await control.scrollIntoViewIfNeeded();
	await expect(control).toBeInViewport();
}

/** A room or deployment setting through its real `<select>`. The value is the registry id, so a renamed
 *  label cannot break the frame. */
async function choose(page: Page, id: string, value: string): Promise<void> {
	await page.locator(SEL.setting(id)).selectOption(value);
	await expect(page.locator(SEL.setting(id))).toHaveValue(value);
}

/**
 * Scroll by PROPORTION, which is how shot-metrics.mjs framed its three frames: they want top / middle /
 * bottom of a long page, not a named element, and a proportion cannot rot when a card moves. The wait is on
 * the scroll having LANDED, so this is a condition and not a sleep.
 */
async function scrollToFraction(page: Page, fraction: number): Promise<void> {
	const target = await page.evaluate((f) => {
		const max = Math.max(0, document.body.scrollHeight - window.innerHeight);
		const y = Math.min(max, Math.round(document.body.scrollHeight * f));
		window.scrollTo(0, y);
		return y;
	}, fraction);
	await expect
		.poll(() => page.evaluate(() => Math.round(window.scrollY)))
		.toBeGreaterThanOrEqual(Math.max(0, target - 2));
}

/**
 * Size the viewport to the page's own content — capture.mjs's `fitViewport`, kept for the same reason: a
 * fixed tall viewport turns a 660px page into a frame two thirds black, which reads as a rendering bug
 * rather than a small library. Capped at 2000px, past which the tooling that reviews these frames cannot
 * read them back.
 */
async function fitToContent(page: Page, { min = 600, max = 2000, pad = 40 } = {}): Promise<void> {
	const width = page.viewportSize()?.width;
	if (!width) throw new Error('fitToContent needs a page with a viewport');
	const content = await page.evaluate(() =>
		Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)
	);
	const height = Math.max(min, Math.min(max, Math.ceil(content) + pad));
	await page.setViewportSize({ width, height });
	await expect.poll(() => page.evaluate(() => window.innerHeight)).toBe(height);
}

/**
 * Answer /api/metrics, and ONLY that path, from the fixture. shot-metrics.mjs did this with an initScript
 * that replaced `window.fetch`; `page.route` is the same interception one layer down, and it cannot be
 * defeated by the page holding its own reference to fetch.
 */
async function stubMetrics(page: Page): Promise<void> {
	await page.route('**/api/metrics', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(METRICS_FIXTURE) })
	);
}

/** /metrics, loaded, with the fixture on screen. The sample line is a POSITIVE ready signal: it renders only
 *  once the stubbed response has landed, where "Loading… is gone" is also true of a page that never loaded. */
async function openMetrics(page: Page): Promise<void> {
	await stubMetrics(page);
	await page.goto('/metrics');
	await expect(page.getByText(METRICS_READY_TEXT)).toBeVisible();
}

/** The identity pane. `?room=` is what lands there; a bare `/` lands on the six-box CODE pane, where the
 *  name field does not exist at all. */
async function openIdentityPane(page: Page, world: World): Promise<void> {
	await page.goto(`/?room=${encodeURIComponent(world.code)}`);
	await expect(page.locator(SEL.nameInput)).toBeVisible();
}

// ── the table ────────────────────────────────────────────────────────────────────────────────────────────

const FRAMES: Frame[] = [
	{
		name: 'join-identity',
		what: 'the pane a scanned code lands on — one field, and a CTA that is disabled until it is filled',
		surface: 'anon',
		viewport: PHONE,
		setup: async (page, world) => {
			await openIdentityPane(page, world);
			await expect(page.getByRole('button', { name: SEL.submit })).toBeDisabled();
		}
	},
	{
		name: 'join-colour-ring',
		what: 'the full hue circle — lightness and chroma stay pinned, the hub names the stop',
		surface: 'anon',
		viewport: PHONE,
		setup: async (page, world) => {
			await openIdentityPane(page, world);
			// `End` walks the ring to its last stop: a real interaction, and visibly not the default. The ring is
			// one `role="slider"` over 48 stops, so there is no per-colour element to click — and `aria-valuenow`
			// reaching `aria-valuemax` is the state to wait for, rather than a repaint interval.
			const ring = page.locator(SEL.colourRing);
			const last = await ring.getAttribute('aria-valuemax');
			if (!last) throw new Error('the colour ring has no aria-valuemax to walk to');
			await ring.press('End');
			await expect(ring).toHaveAttribute('aria-valuenow', last);
		}
	},
	{
		name: 'join-ready',
		what: 'a name entered and a ring stop chosen, with the CTA now enabled',
		surface: 'anon',
		viewport: PHONE,
		setup: async (page, world) => {
			await openIdentityPane(page, world);
			await page.locator(SEL.nameInput).fill('Maya');
			await page.locator(SEL.colourRing).press('Home');
			await expect(page.getByRole('button', { name: SEL.submit })).toBeEnabled();
		}
	},
	{
		name: 'phone-home',
		what: 'home is the queue: the rotation with nothing in it yet, under the docked now-playing row',
		surface: 'phone',
		viewport: PHONE,
		fullPage: true,
		setup: async (page) => {
			// TWO empty states are correct here and both are the frame's subject: an empty rotation, and a
			// karaoke library with nothing in it yet — the seeded tracks are raw, and the library lists what can
			// be sung. Hence `.first()` rather than a count, which would pin a number the page may reasonably change.
			await expect(page.locator(SEL.empty).first()).toBeVisible();
		}
	},
	{
		name: 'phone-search',
		what: 'unified search — one row shape, one action per row, readiness first',
		surface: 'phone',
		viewport: PHONE,
		fullPage: true,
		setup: async (page) => {
			// The find box is the first element in the home column, so there is nothing to open first.
			await page.locator(SEL.search).fill('caroline');
			// Wait for a ROW, not for the spinner to stop: the library is already on screen when the box is typed
			// into, so "not loading" is true before any result has arrived.
			await expect(page.locator(SEL.songRow).first()).toBeVisible();
		}
	},
	{
		name: 'phone-processing',
		what: 'a song processing while HOLDING its rotation slot — no worker is attached, which is the state',
		surface: 'phone',
		viewport: PHONE,
		fullPage: true,
		setup: async (page) => {
			await page.locator(SEL.search).fill('believin');
			// The library tracks are raw, so the action a row offers is SING — process and take a turn — not add.
			await page.locator(SEL.sing).first().click();
			// The rotation is its own tab, /queue. The processing card there is what proves the slot is held.
			await openQueue(page);
			await expect(page.locator(SEL.processing).first()).toBeVisible();
		}
	},
	{
		name: 'tv-attract',
		what: 'nobody here yet — the code owns the screen, and the QR is replaced by the operator notice',
		surface: 'tv',
		setup: async (page) => {
			// The world binds core to 127.0.0.1 and no party address is set, so the advertised join address is a
			// loopback one: the TV correctly refuses to paint a QR whose every scan would fail. This is the
			// commonest first-run failure (a loopback bind, a WSL2 NAT, a proxy forwarding no X-Forwarded-*) and
			// it is the DEFAULT here, which is why capture.mjs's separate `tv-join-unreachable` frame is this one.
			await expect(page.locator(SEL.attract)).toBeVisible();
			await expect(page.locator(SEL.badQrTitle)).toBeVisible();
		}
	},
	{
		name: 'tv-lobby',
		what: 'someone is here but nothing is queued — the room asks for a pick',
		surface: 'tv',
		setup: async (page, world) => {
			// The lobby exists at exactly one point: a singer present, nothing queued. A TV is not a room member,
			// so the phone is what moves the screen off attract.
			await world.openPhone('Maya');
			await expect(page.locator(SEL.lobby)).toBeVisible();
			await expect(page.locator(SEL.lobbyStripPerson)).toHaveCount(1);
		}
	},
	{
		name: 'tv-lobby-join-qr',
		what: 'the same lobby once a party address IS set — a QR replaces the notice, with the typed address under it',
		surface: 'tv',
		setup: async (page, world) => {
			const phone = await world.openPhone('Maya');
			await expect(page.locator(SEL.lobby)).toBeVisible();
			// The join address is a MACHINE setting, so this is the machine scope.
			// Driven through the real control rather than staged: the notice on `tv-attract` names this field as
			// the fix, so this frame is that fix being applied. A LAN-shaped address nothing answers is enough —
			// the TV decides on the address's SHAPE (loopback or single-label hosts cannot be reached by a phone),
			// never by trying it. The field commits on change, so the fill is followed by a blur.
			await scope(phone, SCOPE.server.path, SCOPE.server.ready);
			await phone.locator(SEL.setting('join-origin')).fill('http://192.168.7.42:3000');
			await phone.locator(SEL.setting('join-origin')).blur();
			// The TV reloads its own data when the join address MOVES, so the QR appearing is the settled state.
			await expect(page.locator(SEL.qrImage)).toBeVisible();
		}
	},
	{
		name: 'settings-you',
		what: 'who you are — the name and colour that used to live in a profile sheet of their own',
		surface: 'phone',
		viewport: SETTINGS,
		setup: async (page) => {
			await scope(page, SCOPE.you.path, SCOPE.you.ready);
		}
	},
	{
		name: 'settings-party',
		what: 'this room: the house rule for who sings next, the guiding track, and the stage look',
		surface: 'phone',
		viewport: SETTINGS,
		setup: async (page) => {
			await scope(page, SCOPE.room.path, SCOPE.room.ready);
			await reveal(page, SEL.setting('queue-order'));
		}
	},
	{
		name: 'settings-party-lyrics',
		what: 'lyrics on the TV: marker, highlight, lead, size, font, case, rows',
		surface: 'phone',
		viewport: SETTINGS,
		setup: async (page) => {
			await scope(page, SCOPE.room.path, SCOPE.room.ready);
			await reveal(page, SEL.setting('lyrics-highlight'));
		}
	},
	{
		name: 'settings-server',
		what: 'the machine scope: splitter, lyrics engine, the join address, re-processing',
		surface: 'phone',
		viewport: SETTINGS,
		setup: async (page) => {
			await scope(page, SCOPE.server.path, SCOPE.server.ready);
			await reveal(page, SEL.setting('sync-mode'));
		}
	},
	{
		name: 'settings-advanced',
		what: 'the advanced disclosure OPEN — the progressive upgrade chain, a fleet property',
		surface: 'phone',
		viewport: SETTINGS,
		setup: async (page) => {
			// The one disclosure left, and it is on the machine scope: the upgrade chain is a fleet property. It
			// really closes now — the shell's `[data-slot='collapsible-content'][hidden]` rule is what closes it —
			// so this click is the difference between three hidden controls and three visible ones.
			await scope(page, SCOPE.server.path, SCOPE.server.ready);
			const trigger = page.getByRole('button', { name: /Advanced/ });
			await trigger.click();
			// Collapsible owns `aria-expanded`, so the trigger reports the panel's state. NOT `#advanced-body`:
			// the panel is authored as `<Card.Content id="advanced-body" {...props}>` and bits-ui's own generated
			// id arrives in that spread, so the explicit one is overwritten and that selector resolves against
			// nothing. capture.mjs never noticed because it slept instead of waiting.
			await expect(trigger).toHaveAttribute('aria-expanded', 'true');
			// The panel opens below the fold, behind the docked now-playing row, so the frame has to scroll to it.
			await reveal(page, SEL.setting('enqueue-upgrade'));
		}
	},
	{
		name: 'settings-lyrics-clamped',
		what: 'a room asking for word timings a line-sync deployment cannot give, and the page saying so',
		surface: 'phone',
		viewport: SETTINGS,
		setup: async (page) => {
			// TWO SCOPES, in order, because the cause and the effect live on different ones: machine timing decides
			// whether per-word timings EXIST, the room only decides how they are drawn. Each hop is a real
			// navigation now, and the room scope re-reads the settings object on arrival, which is why the warning
			// below is on screen rather than one frame behind. capture.mjs put the deployment back afterwards
			// because thirty later frames shared its server; a core per test makes that restore dead code.
			await scope(page, SCOPE.server.path, SCOPE.server.ready);
			await choose(page, 'sync-mode', 'lines');
			await scope(page, SCOPE.room.path, SCOPE.room.ready);
			await choose(page, 'lyrics-highlight', 'word');
			await choose(page, 'lyrics-ball', 'bounce');
			await expect(page.getByText(/No word timings on this server/)).toBeVisible();
			await reveal(page, SEL.setting('lyrics-ball'));
		}
	},
	{
		name: 'metrics-top',
		what: 'the internal page, head: sample size, end-to-end timing, time per step',
		surface: 'anon',
		viewport: METRICS_DESKTOP,
		// THE ONE BASELINE. Every pixel on this frame comes from `metrics-fixture.ts` — no room code, no
		// port, no date, no measured number — and what the frame is FOR is wording and column headers, which
		// is exactly what a pixel baseline protects. Playwright suffixes the snapshot with the platform, and
		// it has to: the same fixture rasterises its glyphs differently on macOS and Linux (about 2 % of
		// pixels, all text). So each OS carries its own PNG; the Linux one is shot in the pinned
		// mcr.microsoft.com/playwright:v1.56.1 image on aarch64; x86_64 is unverified until CI (proposal 06)
		// runs it, and may need its own re-base. A bumped Chromium fails once and is re-based by hand,
		// which is louder and more honest than a tolerance wide enough to hide a changed heading.
		baseline: true,
		setup: openMetrics
	},
	{
		name: 'metrics-models',
		what: 'cost per model against the rate its own vendor claims — read the wording, never the throughput',
		surface: 'anon',
		viewport: METRICS_DESKTOP,
		setup: async (page) => {
			await openMetrics(page);
			await scrollToFraction(page, 0.22);
		}
	},
	{
		name: 'metrics-tail',
		what: 'the foot: slowest songs, per-stage timing, and the connected worker’s host facts',
		surface: 'anon',
		viewport: METRICS_DESKTOP,
		setup: async (page) => {
			await openMetrics(page);
			await scrollToFraction(page, 1);
		}
	},
	{
		name: 'metrics-narrow',
		what: 'the same page on a phone — the case the tables’ horizontal scroll exists for',
		surface: 'anon',
		viewport: METRICS_NARROW,
		setup: openMetrics
	},
	{
		name: 'stats',
		what: 'the public page: library size, most-sung, top artists, sings per day',
		surface: 'anon',
		viewport: { width: 1280, height: 600 },
		setup: async (page) => {
			await page.goto('/stats');
			await expect(page.locator(SEL.pageHeading)).toBeVisible();
			// A TILE NUMBER, not `SEL.dashCard`: that key is `.card`, and the card component renders
			// `.encore-card` — it resolves against nothing on this page, so it would wait out the timeout on a
			// page that had loaded fine. /stats loads in `+page.ts`, so the tiles ship with the document; this
			// waits out hydration rather than a fetch, and stays a positive signal either way.
			await expect(page.locator(SEL.dashTileNumber).first()).toBeVisible();
			// Fit AFTER the tiles are on screen: measuring before layout has settled sizes the frame wrong.
			await fitToContent(page);
		}
	}
];

// ── the runner ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * A blank frame is the failure all five tools could not catch: a screenshot of an unpainted page is a valid
 * PNG and a passing run. PNG size scales with area, so the floor has to as well — a flat fill measures
 * 4-9 bytes per 1000 pixels across the four viewports here (2.7 KB at 390x844, 8.5 KB at 1920x1080), while
 * the real frames measure 74-173. 25 sits about 3x clear of both, which separates "a frame" from "a
 * rectangle" without encoding what any frame is supposed to look like.
 */
const MIN_BYTES_PER_1000_PIXELS = 25;

async function openSurface(
	frame: Frame,
	browser: Browser,
	world: World
): Promise<{ page: Page; context: BrowserContext | null }> {
	if (frame.surface === 'tv') return { page: await world.openTv(), context: null };
	if (frame.surface === 'phone') {
		const page = await world.openPhone('Maya');
		if (frame.viewport) await page.setViewportSize(frame.viewport);
		return { page, context: null };
	}
	// An anonymous context, made here rather than through the `page` fixture so the frame's viewport is the
	// one it is laid out at from the first paint, and so a frame that wants no session cannot inherit one.
	const context = await browser.newContext({ baseURL: world.baseURL, viewport: frame.viewport });
	return { page: await context.newPage(), context };
}

for (const frame of FRAMES) {
	test(frame.name, async ({ browser, world }, testInfo) => {
		// The question the frame answers, in the report beside it: a PNG with no caption is a rectangle
		// somebody has to guess at. Carried as an annotation rather than in the attachment's name, which is
		// also its filename.
		testInfo.annotations.push({ type: 'frame', description: frame.what });

		const { page, context } = await openSurface(frame, browser, world);
		try {
			await frame.setup(page, world);
			// A webfont still swapping is a frame with the wrong type in it. A real condition, so it replaces
			// the trailing `sleep(700)` every one of the five tools took before shooting.
			await page.evaluate(() => document.fonts.ready.then(() => true));

			const options = { fullPage: frame.fullPage ?? false, animations: 'disabled', caret: 'hide' } as const;
			const path = testInfo.outputPath(`${frame.name}.png`);
			const png = await page.screenshot({ ...options, path });
			await testInfo.attach(`${frame.name}.png`, { path, contentType: 'image/png' });

			// Measured against the VIEWPORT even when the capture is fullPage: a taller capture can only make a
			// real frame bigger, so the floor stays on the conservative side.
			const size = page.viewportSize();
			if (!size) throw new Error(`${frame.name} was shot on a page with no viewport`);
			const floor = Math.round((size.width * size.height * MIN_BYTES_PER_1000_PIXELS) / 1000);
			expect(
				png.byteLength,
				`${frame.name} came out blank or near-blank: ${png.byteLength} bytes for a ${size.width}x${size.height} frame`
			).toBeGreaterThan(floor);

			if (frame.baseline) await expect(page).toHaveScreenshot(`${frame.name}.png`, options);
		} finally {
			await context?.close();
		}
	});
}
