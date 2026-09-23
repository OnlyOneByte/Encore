// @ts-check
/*
 * P10 — SCALING & LEGIBILITY. Measured pixels, never declarations:
 *   1. TV type at 720p/1080p/1440p/2160p — does it scale UP as well as down, or pin at a clamp max?
 *   2. Every transient/error overlay's scrollWidth vs viewport width (right-edge clipping).
 *   3. Each TV type token's resolved px against the ten-foot floor documented in app.css.
 *   4. Remote at 320px — horizontal scroll, and every control whose box is under 44px.
 *   5. .app-shell width vs viewport at 1024/1280/1440/2400 (a capped grid leaving a void).
 *   6. Contrast from COMPUTED colours against WCAG AA (4.5:1; 3:1 for large text).
 *   7. Overscan — anything important inside the 5% region a real television crops.
 *
 * Captures only: writes screenshots + findings.json under $SCRATCH/shots/p10/ and exits 0 whatever
 * it saw, so its output is the verdict. See docs/E2E.md#probes.
 */

import { connect, sleep } from '../driver.mjs';
import { openNowPlaying, openBrowseFromHome } from '../lib/phone.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SEL } from '../contract.ts';

/**
 * @typedef {Awaited<ReturnType<typeof connect>>} Browser
 * @typedef {Awaited<ReturnType<Browser['newPage']>>} Page
 * @typedef {{ r: number, g: number, b: number, a?: number }} Rgb
 */

const PORT = Number(process.env.PORT || 5230);
const SCRATCH = process.env.SCRATCH || `${process.env.KIROCREW_SCRATCH || '/tmp'}/e2e-${PORT}`;
const OUT = join(SCRATCH, 'shots', 'p10');
/** Time for the TV to react to a nowplaying:changed frame before it is measured. */
const NOWPLAYING_SETTLE_MS = 500;
mkdirSync(OUT, { recursive: true });

/** @type {any[]} */ // each record() call carries a differently-shaped measurement object
const findings = [];
/** @param {Record<string, unknown>} obj */
const record = (obj) => {
	findings.push(obj);
	console.log(JSON.stringify(obj));
};

/** Parses a CSS rgb()/rgba() string. @param {string | null | undefined} s @returns {Rgb | null} */
function parseRgb(s) {
	if (!s) return null;
	const m = String(s).match(/rgba?\(([^)]+)\)/i);
	if (!m) return null;
	const parts = m[1].split(',').map((x) => parseFloat(x.trim()));
	return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
}
/** @param {Rgb} rgb */
function relLum({ r, g, b }) {
	const f = (/** @type {number} */ v) => {
		const s = v / 255;
		return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
	};
	return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
/** @param {Rgb | null} fg @param {Rgb | null} bg @returns {number | null} */
function contrastRatio(fg, bg) {
	if (!fg || !bg) return null;
	const L1 = relLum(fg);
	const L2 = relLum(bg);
	const [hi, lo] = L1 >= L2 ? [L1, L2] : [L2, L1];
	return (hi + 0.05) / (lo + 0.05);
}

const browser = await connect();

// Reaching the TV's "playing" screen needs a real phone driven through join → queue → play: enqueue
// and play exist only on the websocket, not as REST endpoints. It also gives the CORNER placement of
// JoinBadge (the during-playback treatment) rather than only the HERO one.
async function driveRoomToPlaying() {
	const phone = await browser.newPage();
	await phone.viewport(430, 900, 1);
	await phone.goto(`http://127.0.0.1:${PORT}/join`);
	await phone.waitForSelector('input[placeholder^="e.g."]', { timeout: 5000 });
	const uniq = `Driver-${Date.now().toString(36).slice(-5)}`;
	await phone.fill('input[placeholder^="e.g."]', uniq);
	await phone.evaluate(
		`[...document.querySelectorAll('button')].find(b=>/start singing/i.test(b.textContent||''))?.click()`
	);
	await phone.waitFor(`location.pathname === '/'`, { timeout: 5000 });
	await phone.waitForSelector(SEL.songRow, { timeout: 6000 });
	const clicked = await phone.evaluate(`(() => {
		const row = document.querySelector(${JSON.stringify(SEL.songRow)});
		if (!row) return 'no-row';
		const add = row.querySelector(${JSON.stringify(SEL.addAction)});
		const sing = row.querySelector(${JSON.stringify(SEL.singAction)});
		(add||sing)?.click();
		return add ? 'add' : (sing ? 'sing' : 'nothing');
	})()`);
	console.log('phone queue action:', clicked);
	await phone.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length > 0`, { timeout: 6000 });
	// Pull the sheet up before tapping: the drawer's own controls (± keycaps, guiding track,
	// restart/skip) are below the fold while it is collapsed, and a tap must land on a visible element.
	await openNowPlaying(phone);
	await phone.evaluate(`document.querySelector(${JSON.stringify(SEL.bandTransport)})?.click()`);
	await sleep(1200);
	return phone;
}

try {
	await driveRoomToPlaying();
} catch (err) {
	record({ phase: 'setup', warning: `could not reach playing state via phone: ${err}` });
}
await sleep(NOWPLAYING_SETTLE_MS);

const TV_SIZES = [
	{ label: '720p', w: 1280, h: 720 },
	{ label: '1080p', w: 1920, h: 1080 },
	{ label: '1440p', w: 2560, h: 1440 },
	{ label: '2160p', w: 3840, h: 2160 }
];

/** @param {string} label @param {number} w @param {number} h */
async function measureTv(label, w, h) {
	const page = await browser.newPage();
	// deviceScaleFactor=1: the downscale is the viewport itself, so a measured px is a real px.
	await page.viewport(w, h, 1);
	await page.goto(`http://127.0.0.1:${PORT}/tv`);
	await page.waitFor(
		`(document.querySelector(${JSON.stringify(SEL.badQr)}) || document.querySelector('img[alt="QR code to join Encore"]') || document.querySelector(${JSON.stringify(SEL.lowerThird)})) != null`,
		{ timeout: 8000 }
	);
	await sleep(400); // let hydration + one paint settle

	const shot = join(OUT, `tv-${label}.png`);
	await page.screenshot(shot);

	const measurement = await page.evaluate(`(() => {
		const px = (el, prop) => el ? parseFloat(getComputedStyle(el).getPropertyValue(prop)) : null;
		const rect = (el) => {
			if (!el) return null;
			const r = el.getBoundingClientRect();
			return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
		};
		const cssvar = (name) => {
			const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
			// Some tokens are clamp() expressions — resolve them by writing to a probe element.
			const probe = document.createElement('div');
			probe.style.position = 'absolute';
			probe.style.visibility = 'hidden';
			probe.style.fontSize = 'var(' + name + ')';
			document.body.appendChild(probe);
			const resolved = parseFloat(getComputedStyle(probe).fontSize);
			probe.remove();
			return { raw: v, resolvedPx: resolved };
		};

		const measurements = {
			viewport: { w: innerWidth, h: innerHeight, docScrollW: document.documentElement.scrollWidth, docClientW: document.documentElement.clientWidth },
			tokens: {
				'--tv-lyric': cssvar('--tv-lyric'),
				'--tv-eyebrow': cssvar('--tv-eyebrow'),
				'--tv-label': cssvar('--tv-label'),
				'--tv-body': cssvar('--tv-body'),
				'--tv-name': cssvar('--tv-name'),
				'--tv-joinurl': cssvar('--tv-joinurl'),
				'--tv-hero': cssvar('--tv-hero'),
				'--tv-qr': cssvar('--tv-qr'),
				'--tv-safe-x': cssvar('--tv-safe-x'),
				'--tv-safe-y': cssvar('--tv-safe-y')
			},
			qrImage: (() => {
				const el = document.querySelector('img[alt="QR code to join Encore"]');
				if (!el) return null;
				const cs = getComputedStyle(el);
				return { ...rect(el), computedWidth: cs.width, computedHeight: cs.height };
			})(),
			lyricsWord: (() => {
				const el = document.querySelector(${JSON.stringify(SEL.activeWord)}) || document.querySelector(${JSON.stringify(SEL.lyrics)});
				if (!el) return null;
				const cs = getComputedStyle(el);
				return { ...rect(el), fontSizePx: parseFloat(cs.fontSize) };
			})(),
			lowerThird: rect(document.querySelector(${JSON.stringify(SEL.lowerThird)})),
			lowerThirdName: (() => {
				const el = document.querySelector(${JSON.stringify(SEL.nowNameScoped)});
				if (!el) return null;
				return { ...rect(el), fontSizePx: parseFloat(getComputedStyle(el).fontSize) };
			})(),
			lowerThirdSong: (() => {
				const el = document.querySelector(${JSON.stringify(SEL.nowSongScoped)});
				if (!el) return null;
				return { ...rect(el), fontSizePx: parseFloat(getComputedStyle(el).fontSize) };
			})(),
			badqr: (() => {
				const el = document.querySelector(${JSON.stringify(SEL.badQr)});
				if (!el) return null;
				const cs = getComputedStyle(el);
				const r = rect(el);
				return {
					...r,
					scrollWidth: el.scrollWidth,
					clientWidth: el.clientWidth,
					computedMaxWidth: cs.maxWidth,
					isCorner: el.classList.contains('corner'),
					isHero: el.classList.contains('hero'),
					clippedRight: r.right > innerWidth,
					clippedLeft: r.x < 0,
					overflowsSelf: el.scrollWidth > el.clientWidth
				};
			})(),
			// The universal-child read stays a LITERAL: a bare universal token has no source anchor the
			// SEL-resolution guard can model, so it cannot live in SEL (quarantined, Group E).
			badqrChildren: [...document.querySelectorAll('.badqr *')].map((el) => {
				const r = el.getBoundingClientRect();
				const parent = el.closest(${JSON.stringify(SEL.badQr)});
				const pr = parent?.getBoundingClientRect();
				return {
					tag: el.tagName.toLowerCase(),
					cls: el.className,
					text: el.textContent?.trim().slice(0, 60) || '',
					scrollW: el.scrollWidth,
					clientW: el.clientWidth,
					overflowsSelf: el.scrollWidth > el.clientWidth,
					escapesParent: pr ? r.right > pr.right + 0.5 : null
				};
			}),
			stateNext: rect(document.querySelector(${JSON.stringify(SEL.stateNext)})),
			stateError: rect(document.querySelector(${JSON.stringify(SEL.stateError)})),
			stateWaiting: rect(document.querySelector(${JSON.stringify(SEL.stateWaiting)})),
			screenLabel: (() => {
				if (document.querySelector(${JSON.stringify(SEL.attract)})) return 'attract';
				if (document.querySelector(${JSON.stringify(SEL.lobby)})) return 'lobby';
				if (document.querySelector(${JSON.stringify(SEL.stateWaiting)})) return 'waiting';
				if (document.querySelector(${JSON.stringify(SEL.lowerThird)})) return 'playing';
				return 'unknown';
			})()
		};
		return measurements;
	})()`);

	const contrastPairs = await page.evaluate(`(() => {
			// [foreground, background]. In-scope hooks interpolate from SEL so the guard reads them off the
			// contract; descendant literals carry a space, which is why the shape rule never flagged them.
			// NO BACKTICK anywhere in this template literal — one would close it and break parsing.
		const targets = [
			[${JSON.stringify(SEL.badQrTitle)}, ${JSON.stringify(SEL.badQrTitle)}],
			[${JSON.stringify(SEL.badQrFix)}, ${JSON.stringify(SEL.badQrFix)}],
			[${JSON.stringify(SEL.nowNameScoped)}, ${JSON.stringify(SEL.nowNameScoped)}],
			[${JSON.stringify(SEL.nowSongScoped)}, ${JSON.stringify(SEL.nowSongScoped)}],
			['.lower-third .ls-artist', '.lower-third .ls-artist'],
			['.lower-third .ls-key', '.lower-third .ls-key'],
			[${JSON.stringify(SEL.upLabel)}, ${JSON.stringify(SEL.upLabel)}],
			[${JSON.stringify(SEL.upSong)}, ${JSON.stringify(SEL.upSong)}],
			['.attract .brand', ${JSON.stringify(SEL.attract)}],
			[${JSON.stringify(SEL.stageHeadline)}, ${JSON.stringify(SEL.attract)}],
			['.attract .jt-url', ${JSON.stringify(SEL.attract)}],
			['.corner .t', 'body'],
			['.corner .u', 'body']
		];
		const out = {};
		for (const [selFg, selBg] of targets) {
			const fg = document.querySelector(selFg);
			const bg = document.querySelector(selBg);
			if (!fg) continue;
			const csFg = getComputedStyle(fg);
			let bgEl = bg || fg;
			let bgColor = 'rgba(0,0,0,0)';
			while (bgEl && bgEl !== document.documentElement) {
				const c = getComputedStyle(bgEl).backgroundColor;
				if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') { bgColor = c; break; }
				bgEl = bgEl.parentElement;
			}
			if (bgColor === 'rgba(0,0,0,0)') bgColor = getComputedStyle(document.body).backgroundColor;
			out[selFg] = {
				fg: csFg.color,
				bg: bgColor,
				fontSizePx: parseFloat(csFg.fontSize),
				fontWeight: csFg.fontWeight,
				text: fg.textContent?.trim().slice(0, 60) || ''
			};
		}
		return out;
	})()`);

	/** @type {Record<string, any>} */
	const contrastReport = {};
	for (const [sel, info] of Object.entries(contrastPairs)) {
		const fg = parseRgb(info.fg);
		const bg = parseRgb(info.bg);
		const cr = contrastRatio(fg, bg);
		const largeText = info.fontSizePx >= 24 || (info.fontSizePx >= 18.66 && parseInt(info.fontWeight) >= 700);
		const passAA = cr ? cr >= (largeText ? 3 : 4.5) : null;
		contrastReport[sel] = { ...info, ratio: cr, largeText, passAA };
	}

	record({
		phase: `tv-${label}`,
		screenshot: shot,
		viewport: measurement.viewport,
		screen: measurement.screenLabel,
		tokens: measurement.tokens,
		qr: measurement.qrImage,
		lyricsWord: measurement.lyricsWord,
		lowerThird: measurement.lowerThird,
		lowerThirdName: measurement.lowerThirdName,
		lowerThirdSong: measurement.lowerThirdSong,
		badqr: measurement.badqr,
		badqrChildren: measurement.badqrChildren,
		stateNext: measurement.stateNext,
		stateError: measurement.stateError,
		stateWaiting: measurement.stateWaiting,
		contrast: contrastReport
	});
}

// Some frames legitimately land on the interstitial rather than 'playing'. That is real state.
for (const s of TV_SIZES) {
	try {
		await measureTv(s.label, s.w, s.h);
	} catch (err) {
		record({ phase: `tv-${s.label}`, error: String(err) });
	}
}

// The attract screen is not reachable once this run has a live queue; for purely-attract frames, run
// this probe against a fresh instance.

const REMOTE_SIZES = [
	{ label: '320w', w: 320, h: 568 }, // smallest phone
	{ label: '390w', w: 390, h: 844 }, // iPhone 14
	{ label: '430w', w: 430, h: 932 }, // iPhone 14 Pro Max
	{ label: '1024w', w: 1024, h: 800 },
	{ label: '1280w', w: 1280, h: 800 },
	{ label: '1440w', w: 1440, h: 900 },
	{ label: '2400w', w: 2400, h: 1200 }
];

/** @param {string} label @param {number} w @param {number} h */
async function measureRemote(label, w, h) {
	const page = await browser.newPage();
	await page.viewport(w, h, 1);
	await page.goto(`http://127.0.0.1:${PORT}/join`);
	await page.waitForSelector('input[placeholder^="e.g."]', { timeout: 5000 });
	const uniq = `P10-${label}-${Date.now().toString(36).slice(-4)}`;
	await page.fill('input[placeholder^="e.g."]', uniq);
	await page.waitFor(`[...document.querySelectorAll('button')].some(b=>/start singing/i.test(b.textContent||''))`);
	await page.evaluate(
		`[...document.querySelectorAll('button')].find(b=>/start singing/i.test(b.textContent||''))?.click()`
	);
	await page.waitFor(`location.pathname === '/'`, { timeout: 5000 });
	await sleep(300);

	const shot = join(OUT, `remote-${label}.png`);
	await page.screenshot(shot);

	const m = await page.evaluate(`(() => {
		const rect = (el) => { if (!el) return null; const r=el.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom}; };
		const shell = document.querySelector(${JSON.stringify(SEL.appShell)});
		const shellRect = rect(shell);
		const overflow = { horizontal: document.documentElement.scrollWidth > document.documentElement.clientWidth,
		                   scrollWidth: document.documentElement.scrollWidth,
		                   clientWidth: document.documentElement.clientWidth };
		const controls = [...document.querySelectorAll('button, a[href], input, select, textarea, [role="button"], [role="radio"], [role="tab"], summary')].filter(el => el.offsetParent !== null);
		const undersized = controls.map(el => {
			const r = el.getBoundingClientRect();
			const label = (el.getAttribute('aria-label') || el.textContent?.trim() || el.tagName).slice(0,40);
			return { label, w: r.width, h: r.height, tag: el.tagName.toLowerCase(), cls: el.className };
		}).filter(c => c.w < 44 || c.h < 44).slice(0, 40);
		const clippedRight = controls.map(el => {
			const r = el.getBoundingClientRect();
			return { label: (el.getAttribute('aria-label') || el.textContent?.trim() || el.tagName).slice(0,40), right: r.right, x: r.x };
		}).filter(c => c.right > innerWidth + 0.5);
		return { viewport: { w: innerWidth, h: innerHeight }, shell: shellRect, overflow, undersized, clippedRight };
	})()`);

	const contrastPairs = await page.evaluate(`(() => {
		// The QUEUE surface only. In-scope hooks interpolate from SEL; bare tags and descendant selectors
		// are not hooks the guard tracks. Targets that need a typed QUERY to render live in the search array
		// below, because a querySelector miss here would skip silently and the probe would still exit 0.
		const targets = ['h1','h2','.qrow .t',${JSON.stringify(SEL.dashCard)},'p','a'];
		const out = {};
		for (const sel of targets) {
			const els = [...document.querySelectorAll(sel)];
			for (let i=0;i<Math.min(els.length,2);i++){
				const el = els[i];
				if (!el.offsetParent) continue;
				const cs = getComputedStyle(el);
				let bgEl = el; let bgColor = 'rgba(0,0,0,0)';
				while (bgEl && bgEl !== document.documentElement) {
					const c = getComputedStyle(bgEl).backgroundColor;
					if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') { bgColor = c; break; }
					bgEl = bgEl.parentElement;
				}
				if (bgColor === 'rgba(0,0,0,0)') bgColor = getComputedStyle(document.body).backgroundColor;
				out[sel+':'+i] = { fg: cs.color, bg: bgColor, fontSizePx: parseFloat(cs.fontSize), fontWeight: cs.fontWeight, text: el.textContent?.trim().slice(0,60) || '' };
			}
		}
		return out;
	})()`);
	/*
	 * A typed query first, and its own try/catch. With an empty box home lists only the queue and the
	 * ready library, so the raw-row action and the clear control never render and those targets would
	 * skip silently; and a search hiccup must not cost the queue-view measurements already in hand.
	 */
	try {
		await openBrowseFromHome(page);
		await page.fill(SEL.search, 'caroline');
		await page
			.waitFor(`document.querySelector(${JSON.stringify(SEL.songRow)}) !== null`, { timeout: 8000 })
			.catch(() => {});
		await sleep(300);
		const findPairs = await page.evaluate(`(() => {
			// Same shape as the queue array above; the literals that stay literals are descendant selectors.
			const targets = ['h1','.findbox input',${JSON.stringify(SEL.clearSearch)},'.row .t','.row .byline',${JSON.stringify(SEL.addTurn)},${JSON.stringify(SEL.sing)},${JSON.stringify(SEL.chip)},'p'];
			const out = {};
			for (const sel of targets) {
				const els = [...document.querySelectorAll(sel)];
				for (let i=0;i<Math.min(els.length,2);i++){
					const el = els[i];
					if (!el.offsetParent) continue;
					const cs = getComputedStyle(el);
					let bgEl = el; let bgColor = 'rgba(0,0,0,0)';
					while (bgEl && bgEl !== document.documentElement) {
						const c = getComputedStyle(bgEl).backgroundColor;
						if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') { bgColor = c; break; }
						bgEl = bgEl.parentElement;
					}
					if (bgColor === 'rgba(0,0,0,0)') bgColor = getComputedStyle(document.body).backgroundColor;
					out[sel+':'+i] = { fg: cs.color, bg: bgColor, fontSizePx: parseFloat(cs.fontSize), fontWeight: cs.fontWeight, text: el.textContent?.trim().slice(0,60) || '' };
				}
			}
			return out;
		})()`);
		// Namespaced, not merged flat: h1 and p exist on both surfaces and one key would overwrite the other.
		for (const [k, v] of Object.entries(findPairs)) contrastPairs['/ search ' + k] = v;
	} catch (err) {
		contrastPairs['/ search (unreachable)'] = { fg: '', bg: '', fontSizePx: 0, fontWeight: '', text: String(err) };
	}
	/** @type {Record<string, any>} */
	const contrastReport = {};
	for (const [k, info] of Object.entries(contrastPairs)) {
		const fg = parseRgb(info.fg);
		const bg = parseRgb(info.bg);
		const cr = contrastRatio(fg, bg);
		const largeText = info.fontSizePx >= 24 || (info.fontSizePx >= 18.66 && parseInt(info.fontWeight) >= 700);
		const passAA = cr ? cr >= (largeText ? 3 : 4.5) : null;
		contrastReport[k] = { ...info, ratio: cr, largeText, passAA };
	}

	record({
		phase: `remote-${label}`,
		screenshot: shot,
		...m,
		contrast: contrastReport
	});
}

for (const s of REMOTE_SIZES) {
	try {
		await measureRemote(s.label, s.w, s.h);
	} catch (err) {
		record({ phase: `remote-${s.label}`, error: String(err) });
	}
}

writeFileSync(join(OUT, 'findings.json'), JSON.stringify(findings, null, 2));
console.log(`\nWROTE ${findings.length} findings to ${OUT}/findings.json`);

browser.close();
process.exit(0);
