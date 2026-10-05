/*
 * P10 — SCALING & LEGIBILITY. Measured pixels, never declarations:
 *   1. TV type at 720p/1080p/1440p/2160p — does it scale UP as well as down, or pin at a clamp max?
 *   2. Every transient/error overlay's scrollWidth vs viewport width (right-edge clipping).
 *   3. Each TV type token's resolved px, recorded per panel size.
 *   4. Remote at 320px — horizontal scroll, and every control whose box is under the touch floor.
 *   5. `.app-shell` width vs viewport at 1024/1280/1440/2400 (a capped grid leaving a void).
 *   6. Contrast from COMPUTED colours against WCAG AA (4.5:1; 3:1 for large text).
 *
 * WHAT THE OLD PROBE WAS. tests/e2e/probes/p10-scaling.mjs is a CAPTURE driver: it contains ZERO `check()` calls
 * and "exits 0 whatever it saw, so its OUTPUT is the verdict". Every number below was computed there and written
 * to findings.json for a human. Three of its measurements carry a threshold that is objective and already
 * written down — the type scale must GROW with the panel (the header's own question), nothing may be clipped past
 * the right edge, and `docs/E2E.md` states the probe proves "measured contrast clears WCAG AA on real computed
 * colours" — so those become assertions here. The two that carry no verdict anywhere are the 44px touch floor
 * (`tests/e2e/gates/measured-design-register.mjs` holds a QUARANTINE of controls that already measure under it,
 * so a bare "none under 44px" would be a claim this repo has not made) and the capped-shell void (no threshold
 * exists for how much empty surface is too much). Both are still MEASURED, and attached to the report, because a
 * measurement nobody reads is how the capture driver's value was lost — but neither is asserted, because
 * inventing a threshold is exactly the silent rewrite this port must not do.
 *
 * Item 7 of the old header — "Overscan: anything important inside the 5% region a real television crops" — is
 * NOT implemented in the probe body at all. It is not invented here either.
 */
import { test, expect, type World } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openBrowseFromHome } from '../../world/actors';
import type { Page, TestInfo } from '@playwright/test';

/** deviceScaleFactor stays 1 (the project default): the downscale is the VIEWPORT itself, so a measured px is a
 *  real px. Every size and its reason is carried over from the old probe. */
const TV_SIZES = [
	{ label: '720p', w: 1280, h: 720 }, // the smallest panel the product ships onto — the type floor's own case
	{ label: '1080p', w: 1920, h: 1080 }, // the reference the vh-relative scale is tuned at
	{ label: '1440p', w: 2560, h: 1440 },
	{ label: '2160p', w: 3840, h: 2160 } // does it scale UP, or pin at a clamp max?
];

const REMOTE_SIZES = [
	{ label: '320w', w: 320, h: 568 }, // smallest phone
	{ label: '390w', w: 390, h: 844 }, // iPhone 14
	{ label: '430w', w: 430, h: 932 }, // iPhone 14 Pro Max
	{ label: '1024w', w: 1024, h: 800 },
	{ label: '1280w', w: 1280, h: 800 },
	{ label: '1440w', w: 1440, h: 900 },
	{ label: '2400w', w: 2400, h: 1200 }
];

/** The TV type ladder, every token the old probe resolved. `--tv-safe-*` are lengths rather than type, and are
 *  here for the same reason they were there: the safe area is what the type has to live inside. */
const TV_TOKENS = [
	'--tv-lyric',
	'--tv-eyebrow',
	'--tv-label',
	'--tv-body',
	'--tv-name',
	'--tv-joinurl',
	'--tv-hero',
	'--tv-safe-x',
	'--tv-safe-y'
];

/** WCAG AA: 4.5:1 for body text, 3:1 for large text (>=24px, or >=18.66px at weight 700+). */
const AA_NORMAL = 4.5;
const AA_LARGE = 3;
const LARGE_PX = 24;
const LARGE_BOLD_PX = 18.66;
/** The touch floor the measured-design gate reads out of `--tap`. MEASURED here, never asserted — see the header. */
const TAP_FLOOR_PX = 44;

interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
	right: number;
	bottom: number;
}
interface TokenReading {
	raw: string;
	resolvedPx: number;
}
interface ColourReading {
	fg: string;
	bg: string;
	fontSizePx: number;
	fontWeight: string;
	text: string;
}
interface ContrastReading extends ColourReading {
	ratio: number | null;
	largeText: boolean;
	passAA: boolean | null;
}

function parseRgb(s: string | null | undefined): { r: number; g: number; b: number } | null {
	const m = /rgba?\(([^)]+)\)/i.exec(String(s ?? ''));
	if (!m) return null;
	const parts = m[1].split(',').map((x) => parseFloat(x.trim()));
	return { r: parts[0], g: parts[1], b: parts[2] };
}
function relLum({ r, g, b }: { r: number; g: number; b: number }): number {
	const f = (v: number) => {
		const s = v / 255;
		return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
	};
	return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrastRatio(fg: string, bg: string): number | null {
	const a = parseRgb(fg);
	const b = parseRgb(bg);
	if (!a || !b) return null;
	const [hi, lo] = relLum(a) >= relLum(b) ? [relLum(a), relLum(b)] : [relLum(b), relLum(a)];
	return (hi + 0.05) / (lo + 0.05);
}
/** The verdict half, out of the page: the same rule the old probe applied to its captured colours. */
function gradeContrast(pairs: Record<string, ColourReading>): Record<string, ContrastReading> {
	const out: Record<string, ContrastReading> = {};
	for (const [sel, info] of Object.entries(pairs)) {
		const ratio = contrastRatio(info.fg, info.bg);
		const largeText =
			info.fontSizePx >= LARGE_PX || (info.fontSizePx >= LARGE_BOLD_PX && parseInt(info.fontWeight) >= 700);
		out[sel] = {
			...info,
			ratio,
			largeText,
			passAA: ratio === null ? null : ratio >= (largeText ? AA_LARGE : AA_NORMAL)
		};
	}
	return out;
}
function failedAA(report: Record<string, ContrastReading>): string[] {
	return Object.entries(report)
		.filter(([, r]) => r.passAA === false)
		.map(
			([sel, r]) =>
				`${sel} ${r.ratio?.toFixed(2)}:1 (${r.largeText ? 'large' : 'normal'}, ${r.fontSizePx}px ${r.fontWeight}) fg=${r.fg} bg=${r.bg} ${JSON.stringify(r.text)}`
		);
}

/**
 * COMPUTED colours, and the background RESOLVED by walking ancestors for the first non-transparent one — a
 * foreground over a transparent parent is measured against whatever actually paints behind it, which is the
 * whole point of measuring rather than reading declarations.
 *
 * The literal descendant selectors are carried over from the old probe verbatim. They have no entry in the
 * selector contract, and inventing one from a spec would put a hook outside the contract; they are the SEL gaps
 * this port reports rather than papers over.
 */
async function readColours(page: Page, targets: [string, string][]): Promise<Record<string, ColourReading>> {
	return page.evaluate((targets) => {
		const out: Record<string, ColourReading> = {};
		for (const [selFg, selBg] of targets) {
			const fg = document.querySelector(selFg);
			if (!fg) continue; // a surface that is not on stage is not a finding
			const csFg = getComputedStyle(fg);
			let bgEl: Element | null = document.querySelector(selBg) ?? fg;
			let bgColor = 'rgba(0,0,0,0)';
			while (bgEl && bgEl !== document.documentElement) {
				const c = getComputedStyle(bgEl).backgroundColor;
				if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') {
					bgColor = c;
					break;
				}
				bgEl = bgEl.parentElement;
			}
			if (bgColor === 'rgba(0,0,0,0)') bgColor = getComputedStyle(document.body).backgroundColor;
			out[selFg] = {
				fg: csFg.color,
				bg: bgColor,
				fontSizePx: parseFloat(csFg.fontSize),
				fontWeight: csFg.fontWeight,
				text: fg.textContent?.trim().slice(0, 60) ?? ''
			};
		}
		return out;
	}, targets);
}

interface TvReading {
	label: string;
	viewport: { w: number; h: number; docScrollW: number; docClientW: number };
	rootFontPx: number;
	tokens: Record<string, TokenReading>;
	screen: string;
	/** Every transient/error overlay that is on stage, with its own overflow and clipping. */
	overlays: Record<
		string,
		{
			rect: Rect;
			scrollWidth: number;
			clientWidth: number;
			overflowsSelf: boolean;
			clippedRight: boolean;
			clippedLeft: boolean;
		} | null
	>;
	/** `.badqr`'s children, which is where a long unbreakable address escapes its parent. */
	badqrChildren: { tag: string; cls: string; text: string; overflowsSelf: boolean; escapesParent: boolean | null }[];
	qr: (Rect & { computedWidth: string }) | null;
	lyricsWordPx: number | null;
	colours: Record<string, ColourReading>;
}

const TV_COLOUR_TARGETS: [string, string][] = [
	[SEL.badQrTitle, SEL.badQrTitle],
	[SEL.badQrFix, SEL.badQrFix],
	[SEL.nowNameScoped, SEL.nowNameScoped],
	[SEL.nowSongScoped, SEL.nowSongScoped],
	['.lower-third .ls-artist', '.lower-third .ls-artist'],
	['.lower-third .ls-key', '.lower-third .ls-key'],
	[SEL.upLabel, SEL.upLabel],
	[SEL.upSong, SEL.upSong],
	['.attract .brand', SEL.attract],
	[SEL.stageHeadline, SEL.attract],
	['.attract .jt-url', SEL.attract],
	['.corner .t', SEL.pageBody],
	['.corner .u', SEL.pageBody]
];

async function readTv(tv: Page, label: string): Promise<TvReading> {
	const measured = await tv.evaluate(
		({ S, tokenNames }) => {
			const rect = (el: Element | null): Rect | null => {
				if (!el) return null;
				const r = el.getBoundingClientRect();
				return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
			};
			// SOME TOKENS ARE clamp()/max() EXPRESSIONS, so the declared value is not a number. Resolve each by
			// writing it to a probe element's font-size and reading back the computed px — the technique is the
			// measurement here, because a `rem` token also has to pass through the root's own vh-relative size.
			const cssvar = (name: string) => {
				const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
				const probe = document.createElement('div');
				probe.style.position = 'absolute';
				probe.style.visibility = 'hidden';
				probe.style.fontSize = `var(${name})`;
				document.body.appendChild(probe);
				const resolvedPx = parseFloat(getComputedStyle(probe).fontSize);
				probe.remove();
				return { raw, resolvedPx };
			};
			const overlay = (sel: string) => {
				const el = document.querySelector(sel);
				const r = rect(el);
				if (!el || !r) return null;
				return {
					rect: r,
					scrollWidth: el.scrollWidth,
					clientWidth: el.clientWidth,
					overflowsSelf: el.scrollWidth > el.clientWidth,
					clippedRight: r.right > innerWidth + 0.5,
					clippedLeft: r.x < -0.5
				};
			};
			const tokens: Record<string, { raw: string; resolvedPx: number }> = {};
			for (const name of tokenNames) tokens[name] = cssvar(name);
			const qrEl = document.querySelector(S.qrImage);
			const wordEl = document.querySelector(S.activeWord) ?? document.querySelector(S.lyrics);
			return {
				viewport: {
					w: innerWidth,
					h: innerHeight,
					docScrollW: document.documentElement.scrollWidth,
					docClientW: document.documentElement.clientWidth
				},
				rootFontPx: parseFloat(getComputedStyle(document.documentElement).fontSize),
				tokens,
				screen: document.querySelector(S.attract)
					? 'attract'
					: document.querySelector(S.lobby)
						? 'lobby'
						: document.querySelector(S.stateWaiting)
							? 'waiting'
							: document.querySelector(S.lowerThird)
								? 'playing'
								: 'unknown',
				overlays: {
					[S.badQr]: overlay(S.badQr),
					[S.stateNext]: overlay(S.stateNext),
					[S.stateError]: overlay(S.stateError),
					[S.stateWaiting]: overlay(S.stateWaiting),
					[S.lowerThird]: overlay(S.lowerThird),
					[S.interstitial]: overlay(S.interstitial)
				},
				// The universal-child read stays a LITERAL: a bare universal token has no source anchor to put in
				// the selector contract.
				badqrChildren: [...document.querySelectorAll(`${S.badQr} *`)].map((el) => {
					const r = el.getBoundingClientRect();
					const pr = el.closest(S.badQr)?.getBoundingClientRect();
					return {
						tag: el.tagName.toLowerCase(),
						cls: String(el.className || ''),
						text: el.textContent?.trim().slice(0, 60) ?? '',
						overflowsSelf: el.scrollWidth > el.clientWidth,
						escapesParent: pr ? r.right > pr.right + 0.5 : null
					};
				}),
				qr: qrEl ? { ...(rect(qrEl) as Rect), computedWidth: getComputedStyle(qrEl).width } : null,
				lyricsWordPx: wordEl ? parseFloat(getComputedStyle(wordEl).fontSize) : null
			};
		},
		{
			S: {
				qrImage: SEL.qrImage,
				activeWord: SEL.activeWord,
				lyrics: SEL.lyrics,
				attract: SEL.attract,
				lobby: SEL.lobby,
				stateWaiting: SEL.stateWaiting,
				stateNext: SEL.stateNext,
				stateError: SEL.stateError,
				lowerThird: SEL.lowerThird,
				interstitial: SEL.interstitial,
				badQr: SEL.badQr
			},
			tokenNames: TV_TOKENS
		}
	);
	return { label, ...measured, colours: await readColours(tv, TV_COLOUR_TARGETS) };
}

interface RemoteReading {
	label: string;
	viewport: { w: number; h: number };
	overflow: { horizontal: boolean; scrollWidth: number; clientWidth: number };
	shell: Rect | null;
	/** Controls whose box is under the touch floor — MEASURED, not asserted. */
	undersized: { label: string; w: number; h: number; tag: string; cls: string }[];
	clippedRight: { label: string; right: number; x: number }[];
	colours: Record<string, ColourReading>;
}

/** The QUEUE surface's own targets, then the SEARCH surface's — namespaced rather than merged, because `h1` and
 *  `p` exist on both and one key would overwrite the other. */
const REMOTE_COLOUR_TARGETS: [string, string][] = [
	['h1', 'h1'],
	['h2', 'h2'],
	[SEL.queueTitle, SEL.queueTitle],
	[SEL.dashCard, SEL.dashCard],
	['p', 'p'],
	['a', 'a']
];
const SEARCH_COLOUR_TARGETS: [string, string][] = [
	['.findbox input', '.findbox input'],
	[SEL.clearSearch, SEL.clearSearch],
	[SEL.songTitle, SEL.songTitle],
	['.row .byline', '.row .byline'],
	[SEL.addTurn, SEL.addTurn],
	[SEL.sing, SEL.sing],
	[SEL.chip, SEL.chip]
];

async function readRemote(phone: Page, label: string): Promise<RemoteReading> {
	const measured = await phone.evaluate((appShell) => {
		const rect = (el: Element | null): Rect | null => {
			if (!el) return null;
			const r = el.getBoundingClientRect();
			return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
		};
		const de = document.documentElement;
		// Only what a thumb can actually reach: `offsetParent === null` is display:none or a fixed ancestor, and a
		// control nobody can see is not a touch target.
		const controls = [
			...document.querySelectorAll<HTMLElement>(
				'button, a[href], input, select, textarea, [role="button"], [role="radio"], [role="tab"], summary'
			)
		].filter((el) => el.offsetParent !== null);
		const describe = (el: HTMLElement) =>
			(el.getAttribute('aria-label') || el.textContent?.trim() || el.tagName).slice(0, 40);
		return {
			viewport: { w: innerWidth, h: innerHeight },
			overflow: {
				horizontal: de.scrollWidth > de.clientWidth,
				scrollWidth: de.scrollWidth,
				clientWidth: de.clientWidth
			},
			shell: rect(document.querySelector(appShell)),
			undersized: controls
				.map((el) => {
					const r = el.getBoundingClientRect();
					return {
						label: describe(el),
						w: r.width,
						h: r.height,
						tag: el.tagName.toLowerCase(),
						cls: String(el.className || '')
					};
				})
				.filter((c) => c.w < 44 || c.h < 44)
				.slice(0, 40),
			clippedRight: controls
				.map((el) => {
					const r = el.getBoundingClientRect();
					return { label: describe(el), right: r.right, x: r.x };
				})
				.filter((c) => c.right > innerWidth + 0.5)
		};
	}, SEL.appShell);
	return { label, ...measured, colours: await readColours(phone, REMOTE_COLOUR_TARGETS) };
}

/**
 * Reaching the TV's PLAYING screen needs a real phone driven through join → process → queue: enqueue and play
 * exist only on the websocket, not as REST endpoints. It also gives the CORNER placement of JoinBadge (the
 * during-playback treatment) rather than only the HERO one, which is what `.corner .t` / `.corner .u` measure.
 */
async function roomPlaying(world: World): Promise<{ phone: Page; stop: () => Promise<void> }> {
	const worker = await startFakeWorker(world);
	const phone = await world.openPhone('P10Driver');
	const track = await world.awaitDemoTrack('caroline');
	const res = await phone.request.post('/api/process', { data: { mediaId: track.id } });
	if (!res.ok()) throw new Error(`/api/process refused: ${res.status()} ${await res.text()}`);
	await openBrowseFromHome(phone);
	await phone.locator(SEL.search).fill('caroline');
	// The row's action becomes the plain add once the stems land; before that it is process-and-queue. Either
	// takes the turn, and waiting for the add is what proves the song went READY.
	await phone.locator(SEL.addTurn).first().click({ timeout: 60_000 });
	await expect(phone.locator(SEL.npStripTitle)).toContainText('caroline');
	return { phone, stop: () => worker.stop() };
}

/** Everything measured, on the report, because a capture driver's value is in the numbers a human reads. */
async function attach(testInfo: TestInfo, name: string, body: unknown): Promise<void> {
	await testInfo.attach(name, { body: JSON.stringify(body, null, 1), contentType: 'application/json' });
}

test('the TV type scale grows with the panel rather than pinning at a clamp max', async ({ world }, testInfo) => {
	const room = await roomPlaying(world);
	try {
		const tv = await world.openTv();
		const readings: TvReading[] = [];
		for (const size of TV_SIZES) {
			await tv.setViewportSize({ width: size.w, height: size.h });
			// The scale is vh-relative, so it re-resolves on resize — but `getBoundingClientRect` in the same task
			// as the resize can read the old layout, so the wait is for the viewport the reading claims.
			await expect
				.poll(async () => tv.evaluate(() => innerWidth), { message: `viewport never became ${size.label}` })
				.toBe(size.w);
			readings.push(await readTv(tv, size.label));
		}
		await attach(
			testInfo,
			'tv-tokens.json',
			readings.map((r) => ({ label: r.label, rootFontPx: r.rootFontPx, tokens: r.tokens }))
		);

		// THE HEADER'S OWN QUESTION, as a falsifiable claim: every step up the ladder must resolve LARGER type, or
		// the scale has pinned at a ceiling and a 4K panel reads at 1080p sizes.
		for (const token of ['--tv-lyric', '--tv-name', '--tv-body', '--tv-hero']) {
			const series = readings.map((r) => ({ at: r.label, px: r.tokens[token].resolvedPx }));
			for (let i = 1; i < series.length; i++) {
				expect(
					series[i].px,
					`${token} did not grow from ${series[i - 1].at} to ${series[i].at}: ${JSON.stringify(series)}`
				).toBeGreaterThan(series[i - 1].px);
			}
		}
		// And the floor at the smallest panel: 720p is where the vh term loses to the 20px root floor, so this is
		// the one size where the ladder could collapse.
		expect(
			readings[0].tokens['--tv-lyric'].resolvedPx,
			`the reel's own token resolved to ${readings[0].tokens['--tv-lyric'].resolvedPx}px at 720p — read from three metres`
		).toBeGreaterThan(readings[0].rootFontPx);
	} finally {
		await room.stop();
	}
});

test('no TV surface is clipped past the right edge, at any panel size', async ({ world }, testInfo) => {
	const room = await roomPlaying(world);
	try {
		const tv = await world.openTv();
		const readings: TvReading[] = [];
		for (const size of TV_SIZES) {
			await tv.setViewportSize({ width: size.w, height: size.h });
			await expect
				.poll(async () => tv.evaluate(() => innerWidth), { message: `viewport never became ${size.label}` })
				.toBe(size.w);
			readings.push(await readTv(tv, size.label));
		}
		await attach(
			testInfo,
			'tv-overflow.json',
			readings.map((r) => ({
				label: r.label,
				screen: r.screen,
				viewport: r.viewport,
				overlays: r.overlays,
				badqrChildren: r.badqrChildren,
				qr: r.qr
			}))
		);

		for (const r of readings) {
			expect(
				r.viewport.docScrollW,
				`the /tv document scrolls horizontally at ${r.label}: ${JSON.stringify(r.viewport)} (screen=${r.screen})`
			).toBeLessThanOrEqual(r.viewport.docClientW);
			for (const [sel, o] of Object.entries(r.overlays)) {
				if (!o) continue; // not on stage at this moment — not a finding
				expect(o.clippedRight, `${sel} is clipped past the right edge at ${r.label}: ${JSON.stringify(o)}`).toBe(false);
				expect(o.clippedLeft, `${sel} is clipped past the left edge at ${r.label}: ${JSON.stringify(o)}`).toBe(false);
				expect(o.overflowsSelf, `${sel} overflows its own box at ${r.label}: ${JSON.stringify(o)}`).toBe(false);
			}
			for (const child of r.badqrChildren) {
				expect(
					child.escapesParent,
					`a .badqr child escapes the notice at ${r.label}: ${JSON.stringify(child)}`
				).not.toBe(true);
			}
		}
	} finally {
		await room.stop();
	}
});

test('measured TV contrast clears WCAG AA on real computed colours', async ({ world }, testInfo) => {
	const room = await roomPlaying(world);
	try {
		const tv = await world.openTv();
		const graded: Record<string, Record<string, ContrastReading>> = {};
		for (const size of TV_SIZES) {
			await tv.setViewportSize({ width: size.w, height: size.h });
			await expect
				.poll(async () => tv.evaluate(() => innerWidth), { message: `viewport never became ${size.label}` })
				.toBe(size.w);
			graded[size.label] = gradeContrast(await readColours(tv, TV_COLOUR_TARGETS));
		}
		await attach(testInfo, 'tv-contrast.json', graded);
		for (const [label, report] of Object.entries(graded)) {
			// NON-VACUITY FIRST. A target that is not on stage is skipped rather than failed — which is right, but
			// it also means a renamed class turns this whole claim into an empty loop that passes. Measured: nine
			// of the thirteen targets resolve on the playing screen (the four `.attract` ones cannot, by
			// definition), so a drop below five is the contract rotting, not a different room state.
			expect(
				Object.keys(report),
				`only ${Object.keys(report).length} contrast target(s) resolved on /tv at ${label} — the claim would ` +
					`pass on an empty measurement: ${JSON.stringify(Object.keys(report))}`
			).not.toHaveLength(0);
			expect(
				Object.keys(report).length,
				`too few contrast targets resolved at ${label} to be evidence`
			).toBeGreaterThanOrEqual(5);
			// The large-text allowance is size-dependent, so the same colour pair that clears 3:1 as large type at
			// 2160p is held to 4.5:1 at 720p — which is why every size is graded rather than just the reference one.
			const failures = failedAA(report);
			expect(failures, `TV text below WCAG AA at ${label}:\n  ${failures.join('\n  ')}`).toHaveLength(0);
		}
	} finally {
		await room.stop();
	}
});

test('the remote never scrolls horizontally, from 320px to 2400px', async ({ world }, testInfo) => {
	const room = await roomPlaying(world);
	try {
		const readings: RemoteReading[] = [];
		for (const size of REMOTE_SIZES) {
			await room.phone.setViewportSize({ width: size.w, height: size.h });
			await expect
				.poll(async () => room.phone.evaluate(() => innerWidth), { message: `viewport never became ${size.label}` })
				.toBe(size.w);
			readings.push(await readRemote(room.phone, size.label));
		}
		await attach(
			testInfo,
			'remote-geometry.json',
			readings.map((r) => ({
				label: r.label,
				viewport: r.viewport,
				overflow: r.overflow,
				shell: r.shell,
				undersized: r.undersized,
				clippedRight: r.clippedRight
			}))
		);

		for (const r of readings) {
			expect(
				r.overflow.horizontal,
				`the remote scrolls horizontally at ${r.label}: ${JSON.stringify(r.overflow)}`
			).toBe(false);
			expect(
				r.clippedRight,
				`controls sit past the right edge at ${r.label}: ${JSON.stringify(r.clippedRight)}`
			).toHaveLength(0);
			// THE CAPPED-SHELL VOID IS MEASURED, NOT JUDGED: `--max-w` deliberately stops the column growing, and
			// no threshold exists for how much surface beside it is too much. What IS asserted is the half that is
			// unambiguous — the shell never sticks out of the viewport it is centred in.
			expect(r.shell, `no .app-shell rendered at ${r.label}`).not.toBeNull();
			expect(
				(r.shell as Rect).right,
				`.app-shell reaches past the viewport at ${r.label}: ${JSON.stringify(r.shell)}`
			).toBeLessThanOrEqual(r.viewport.w + 0.5);
		}
		// The touch-floor census, on the report and deliberately unasserted — see the header.
		const census = readings.map((r) => `${r.label}: ${r.undersized.length} control(s) under ${TAP_FLOOR_PX}px`);
		testInfo.annotations.push({ type: 'touch-floor census', description: census.join('; ') });
	} finally {
		await room.stop();
	}
});

test('measured remote contrast clears WCAG AA on real computed colours', async ({ world }, testInfo) => {
	const room = await roomPlaying(world);
	try {
		const graded: Record<string, Record<string, ContrastReading>> = {};
		for (const size of REMOTE_SIZES) {
			await room.phone.setViewportSize({ width: size.w, height: size.h });
			await expect
				.poll(async () => room.phone.evaluate(() => innerWidth), { message: `viewport never became ${size.label}` })
				.toBe(size.w);
			graded[size.label] = gradeContrast(await readColours(room.phone, REMOTE_COLOUR_TARGETS));
		}
		// A TYPED QUERY, in its own pass: with an empty box the home surface lists only the queue and the ready
		// library, so the row action and the clear control never render and those targets would skip SILENTLY.
		await openBrowseFromHome(room.phone);
		await room.phone.locator(SEL.search).fill('caroline');
		await room.phone.locator(SEL.songRow).first().waitFor({ state: 'attached' });
		graded['390w / searched'] = gradeContrast(await readColours(room.phone, SEARCH_COLOUR_TARGETS));

		await attach(testInfo, 'remote-contrast.json', graded);
		for (const [label, report] of Object.entries(graded)) {
			// NON-VACUITY, same reason as the TV arm: an absent target is skipped, so a renamed class would empty
			// the loop rather than fail it. Measured: four resolve on the queue surface (`.qrow .t` cannot while the
			// only entry is PLAYING, and `.card` belongs to /stats) and seven on the searched one.
			expect(
				Object.keys(report).length,
				`only ${Object.keys(report).length} contrast target(s) resolved on the remote at ${label} — the claim ` +
					`would pass on an empty measurement: ${JSON.stringify(Object.keys(report))}`
			).toBeGreaterThanOrEqual(3);
			const failures = failedAA(report);
			expect(failures, `remote text below WCAG AA at ${label}:\n  ${failures.join('\n  ')}`).toHaveLength(0);
		}
	} finally {
		await room.stop();
	}
});
