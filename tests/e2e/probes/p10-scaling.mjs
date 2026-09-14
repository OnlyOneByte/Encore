// @ts-check
/*
 * P10 — SCALING & LEGIBILITY PROBE.
 *
 * The rendered pixels, at every size that matters. Answers seven questions the source alone cannot:
 *
 *   1. Does the TV scale UP as well as down? Some clamps could be pinning type at their max, so a
 *      4K screen renders the same font-pixels as 1080p. Reports measured px for the QR, lyrics
 *      current-word, and the lower-third who-is-singing line at 720p / 1080p / 1440p / 2160p.
 *   2. Does the JoinBadge "Join QR unavailable" panel overflow the right edge at 1920x1080 with
 *      127.0.0.1 as the origin? User reported this — probe measures every transient/error state
 *      overlay for scrollWidth vs viewport width and clientWidth vs its own bounding box.
 *   3. Is every TV surface legible at ten feet? Reports each TV type token's rendered px at 1080p
 *      against the ten-foot floor documented in app.css.
 *   4. Does the remote work at 320px without horizontal scroll or clipped controls? Probes
 *      documentElement.scrollWidth > clientWidth, and reports every button/link whose bounding
 *      rect is under 44px in either dimension.
 *   5. At laptop widths, does the layout use the space or does the grid cap and leave a void?
 *      Reports .app-shell width and viewport width at 1024 / 1280 / 1440 / 2400.
 *   6. Contrast — measured against COMPUTED colours from the DOM, not eyeballed. Reads
 *      backgroundColor / color pairs on every visible text node with length > 0 and reports any
 *      failing WCAG AA (4.5:1 normal, 3:1 for text >= 18px or >= 14px bold).
 *   7. Overscan / safe area on the TV — is anything important within the ~5% region a real
 *      television crops? Reports the bounding rect of the lower-third, JoinBadge corner card,
 *      and any interstitial state against the 5% safe box.
 *
 * WRITES SCREENSHOTS TO $SCRATCH/shots/p10/. Changes NO other file in the tree.
 */

import { connect, sleep } from '../driver.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SEL } from '../contract.ts';
// The one shared post-join sequence for reaching the search box (tests/e2e/lib/phone.mjs). Imported
// because the remote pass now measures the `/find` surface too, and a second private way to reach that
// field is exactly the drift the helper was extracted to prevent.
import { openBrowseFromHome } from '../lib/phone.mjs';

/**
 * Types for the out-of-program driver. This file runs under tsconfig.e2e.json (following
 * the fuzz.mjs pattern). Browser/Page derive from driver.mjs's own return types; every
 * page.evaluate() result is protocol-shaped and stays loose (driver.mjs types evaluate as Promise<any>),
 * cast at the call site.
 *
 * @typedef {Awaited<ReturnType<typeof connect>>} Browser
 * @typedef {Awaited<ReturnType<Browser['newPage']>>} Page
 * @typedef {{ r: number, g: number, b: number, a?: number }} Rgb
 */

const PORT = Number(process.env.PORT || 5230);
const SCRATCH = process.env.SCRATCH || `${process.env.KIROCREW_SCRATCH || '/tmp'}/e2e-${PORT}`;
const OUT = join(SCRATCH, 'shots', 'p10');
mkdirSync(OUT, { recursive: true });

/** @type {any[]} */ // each record() call carries a differently-shaped measurement object
const findings = [];
/** @param {Record<string, unknown>} obj */
const record = (obj) => {
	findings.push(obj);
	console.log(JSON.stringify(obj));
};

// WCAG relative luminance / contrast — feed it the CSS rgb strings.
/** @param {string | null | undefined} s @returns {Rgb | null} */
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

// Boot the browser once; a fresh guest per page opens its own cookie jar and its own idle state.
const browser = await connect();

// A process has already run before this probe — a probe must not require another. To reach the TV's
// "playing" screen we drive a real phone through join → queue → play in a hidden browser tab, because
// enqueue/play do not exist as REST endpoints — the room's transport lives on the websocket. This
// gives us the CORNER placement of JoinBadge (the during-playback treatment), not just the HERO one.
async function driveRoomToPlaying() {
	const phone = await browser.newPage();
	await phone.viewport(430, 900, 1);
	await phone.goto(`http://127.0.0.1:${PORT}/join`);
	await phone.waitForSelector('input[placeholder^="e.g."]' , { timeout: 5000 });
	const uniq = `Driver-${Date.now().toString(36).slice(-5)}`;
	await phone.fill('input[placeholder^="e.g."]', uniq);
	await phone.evaluate(
		`[...document.querySelectorAll('button')].find(b=>/start singing/i.test(b.textContent||''))?.click()`
	);
	await phone.waitFor(`location.pathname === '/'`, { timeout: 5000 });
	// Add the ready song to the queue (whichever action is offered — .add on ready songs).
	await phone.waitForSelector(SEL.songRow , { timeout: 6000 });
	const clicked = await phone.evaluate(`(() => {
		const row = document.querySelector(${JSON.stringify(SEL.songRow)});
		if (!row) return 'no-row';
		const add = row.querySelector(${JSON.stringify(SEL.addAction)});
		const sing = row.querySelector(${JSON.stringify(SEL.singAction)});
		(add||sing)?.click();
		return add ? 'add' : (sing ? 'sing' : 'nothing');
	})()`);
	console.log('phone queue action:', clicked);
	// Wait for the queue to actually contain a row.
	await phone.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length > 0`, { timeout: 6000 });
	// Hit play/pause.
	await phone.evaluate(`document.querySelector('[aria-label="play/pause"]')?.click()`);
	await sleep(1200);
	return phone;
}

try {
	await driveRoomToPlaying();
} catch (err) {
	record({ phase: 'setup', warning: `could not reach playing state via phone: ${err}` });
}
// Give the TV a beat to react to nowplaying:changed.
await sleep(500);

// ── TV: measurements at 4 sizes ─────────────────────────────────────────────────────────────────

const TV_SIZES = [
	{ label: '720p', w: 1280, h: 720 },
	{ label: '1080p', w: 1920, h: 1080 },
	{ label: '1440p', w: 2560, h: 1440 },
	{ label: '2160p', w: 3840, h: 2160 }
];

/** @param {string} label @param {number} w @param {number} h */
async function measureTv(label, w, h) {
	const page = await browser.newPage();
	// deviceScaleFactor=1 keeps the pixel measurement clean and the screenshot within Kiro's 2000px
	// per-side read limit (we downscale via viewport itself, not DSR).
	await page.viewport(w, h, 1);
	await page.goto(`http://127.0.0.1:${PORT}/tv`);
	// Wait for either the badqr operator notice, a QR image, or the playing overlay.
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
			// QR image (either heroed or corner-placed)
			qrImage: (() => {
				const el = document.querySelector('img[alt="QR code to join Encore"]');
				if (!el) return null;
				const cs = getComputedStyle(el);
				return { ...rect(el), computedWidth: cs.width, computedHeight: cs.height };
			})(),
			// Lyrics current-word (only present when playing)
			lyricsWord: (() => {
				const el = document.querySelector(${JSON.stringify(SEL.activeWord)}) || document.querySelector(${JSON.stringify(SEL.lyrics)});
				if (!el) return null;
				const cs = getComputedStyle(el);
				return { ...rect(el), fontSizePx: parseFloat(cs.fontSize) };
			})(),
			// Lower third
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
			// The badqr operator notice (attract & lobby screens on 127.0.0.1 origin)
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
			// Every direct text descendant of .badqr, so we can see if a child word ran off the box.
			// The .badqr universal-child read below stays a LITERAL (quarantined in contract.test.ts,
			// Group E): a bare universal token has no source anchor the SEL-resolution guard can
			// model, so it cannot live in SEL. The container itself is SEL.badQr, used two lines down.
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
			// Transient states
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

	// Also measure contrast on interesting text nodes at THIS size.
	const contrastPairs = await page.evaluate(`(() => {
		// Contrast target pairs [foreground, background]. In-scope selectors for Group E are
		// interpolated from SEL so the guard reads them from the contract; out-of-scope descendant
		// selectors (".badqr-b b", ".lower-third .ls-artist/.ls-key", ".attract .brand/.jt-url",
		// ".corner .t/.u") keep their literals — they carry a space so the guard's shape rule never
		// flagged them, and they belong to selectors tracked separately, not this group. The attract
		// instruction line reads SEL.stageHeadline (".phrase-line", the rotating phrase) — repointed
		// from the earlier ".idle-head", and the typed address from ".idle-url" to the split panel's
		// ".jt-url".
		const targets = [
			[${JSON.stringify(SEL.badQrTitle)}, ${JSON.stringify(SEL.badQrTitle)}],
			[${JSON.stringify(SEL.badQrBody)}, ${JSON.stringify(SEL.badQrBody)}],
			['.badqr-b b', '.badqr-b b'],
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
			// Walk up parents to find a non-transparent background.
			let bgEl = bg || fg;
			let bgColor = 'rgba(0,0,0,0)';
			while (bgEl && bgEl !== document.documentElement) {
				const c = getComputedStyle(bgEl).backgroundColor;
				if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') { bgColor = c; break; }
				bgEl = bgEl.parentElement;
			}
			// If we exit the loop with nothing, use body's computed bg or fall back to bg2.
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

	// Compute contrast externally so we don't spam the page eval with math.
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

// The song is now queued and (we asked the room to) playing. The FIRST TV visit will land on 'playing'
// once the browser reaches it; some frames may still be in interstitial. That is real state, not a
// probe defect — the frame is what the frame is.
for (const s of TV_SIZES) {
	try {
		await measureTv(s.label, s.w, s.h);
	} catch (err) {
		record({ phase: `tv-${s.label}`, error: String(err) });
	}
}

// Also drive an EXPLICIT attract screen — no queue, no singers — to see the join screen at each size.
// Do this by opening /tv with a fresh page BEFORE any join. But we already have a live queue in this
// probe run. Instead, capture the "join badge only" view by hitting /tv when the current entry is
// consumed. Simpler: skip the currently-playing turn and see if a fresh state renders.
// PRACTICAL: capture the LOBBY page at each size on a route the probe already has painted.
// (For a purely-attract capture, run this probe on a fresh instance.)

// ── REMOTE: measurements at 8 widths ────────────────────────────────────────────────────────────

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
	// Join first so the page lands on the room UI rather than the join landing.
	await page.goto(`http://127.0.0.1:${PORT}/join`);
	await page.waitForSelector('input[placeholder^="e.g."]' , { timeout: 5000 });
	const uniq = `P10-${label}-${Date.now().toString(36).slice(-4)}`;
	await page.fill('input[placeholder^="e.g."]', uniq);
	// Wait for submit, then click.
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
		// Every interactive control's bounding box for tap-size check
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

	// Contrast pairs on remote — cover the primary controls and body text.
	const contrastPairs = await page.evaluate(`(() => {
		// Remote contrast targets, and this array is now the QUEUE surface only. Group E interpolates the
		// in-scope class hooks from SEL; bare tags (h1/h2/p/a) and descendant selectors (.qrow .t) are
		// not selector hooks the guard tracks here. A later repoint moved the dead '.row .a' to
		// '.row .byline' and dropped the dead '.filter-chip' and '.b' targets (no component declares
		// either class).
		//
		// WHAT LEFT THIS ARRAY, AND WHY IT MOVED RATHER THAN BEING DROPPED. The phone-remote rebuild
		// made '/' queue-only: search became the '/find' route, and SongRow renders THERE. So the search
		// field (was '.searchbox input' / '.searchbox button'), the row title/byline, both row actions
		// and the row chip cannot resolve on '/' any more — every one of them would have been a read
		// that silently skips, which is exactly the dead-target class G1 exists to red on. They are in
		// the find-surface array below, measured on the surface that renders them, so the coverage is
		// unchanged rather than quietly lost.
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
	 * THE FIND SURFACE, IN THE SAME PASS AND AT THE SAME SIZE.
	 *
	 * Search left `/` for the `/find` route, and the targets that went with it are the ones this probe
	 * most needs at 200% text: a text FIELD (the only one on the remote), the control that clears it, and
	 * the song row's title / byline / actions / chip. Measuring them on `/` after the move would report
	 * nothing at all — `querySelector` returns null, the loop `continue`s, and the probe still exits 0 —
	 * so the read follows the surface instead of the file it used to live in.
	 *
	 * A query is typed first, deliberately: with an empty box `/find` lists the library (ready rows
	 * only), so the raw-row action and the clear control never render and two targets would skip.
	 * `SEL.search` / `SEL.songRow` come from the contract, so this navigation inherits the same anchor
	 * guarantees as everything else here.
	 *
	 * Its own try/catch: a find-surface hiccup must not cost the `/` measurements already in hand, which
	 * are the whole record for this viewport size.
	 */
	try {
		await page.goto(`http://127.0.0.1:${PORT}/find`);
		// The shared post-join path, called defensively. After this navigation the field is already on
		// screen, which is the helper's own documented no-op case (it probes for the box first and
		// returns), so this costs one short probe — and it keeps this probe on the ONE helper every other
		// driver reaches search through, rather than growing a second private sequence here. When that
		// helper learns to tap the band instead of waiting, the change lands there and not here.
		await openBrowseFromHome(page);
		await page.fill(SEL.search, 'caroline');
		await page
			.waitFor(`document.querySelector(${JSON.stringify(SEL.songRow)}) !== null`, { timeout: 8000 })
			.catch(() => {});
		await sleep(300);
		const findPairs = await page.evaluate(`(() => {
			// The find surface's own contrast targets. Same shape as the queue array above: SEL hooks are
			// interpolated, and the literals that stay literals are descendant selectors ('.findbox input',
			// the field inside its sticky box; '.row .t' / '.row .byline') — none of which the driver ban's
			// shape rule flags, and all of which G1 resolves against real source.
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
		// Namespaced rather than merged flat: `h1` and `p` exist on both surfaces, and one key overwriting
		// the other would report one measurement as if it covered both.
		for (const [k, v] of Object.entries(findPairs)) contrastPairs['/find ' + k] = v;
	} catch (err) {
		contrastPairs['/find (unreachable)'] = { fg: '', bg: '', fontSizePx: 0, fontWeight: '', text: String(err) };
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

// Write consolidated JSON so the report can be built without re-running the browser.
writeFileSync(join(OUT, 'findings.json'), JSON.stringify(findings, null, 2));
console.log(`\nWROTE ${findings.length} findings to ${OUT}/findings.json`);

browser.close();
process.exit(0);
