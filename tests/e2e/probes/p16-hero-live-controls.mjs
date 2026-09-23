// P16 — the now-playing drawer's live controls, and their honest degradation.
//
// Two arms, two songs, one server:
//   - WITH a guide mix → a live control and NO explanation beside it.
//   - NO guide mix → the control STAYS on screen disabled, its readout says 'Off', and a sentence
//     naming what still works renders BEFORE the control, dimmed by no ancestor's opacity.
// Plus the gesture pair, which is the part no source scan can reach: a real pointer drag on the
// SLIDER moves the guiding track and does NOT dismiss the sheet (`handleOnly` on Drawer.Root), while
// a drag on the HANDLE does. See docs/E2E.md#gestures
//
// The filename keeps `hero` so this stays paired with tests/guards/hygiene/hero-live-controls.test.ts;
// renaming means both files, the entry in tests/e2e/run-probes.mjs and the guards' keys in one sweep.
//
//   EPORT=5216 bun tests/e2e/probes/p16-hero-live-controls.mjs
//
// Needs `bun run build`: server.ts serves the BUILT app, so a stale build measures yesterday's markup.
// Exit codes: see docs/E2E.md#exit-codes-and-what-ran-means
import { existsSync, mkdirSync, openSync, statSync } from 'node:fs';
import { readFile as readFileP } from 'node:fs/promises';
import { join } from 'node:path';
import { connect, sleep } from '../driver.mjs';
import { SEL } from '../contract.ts';
import { findChromium } from '../lib/chromium.mjs';
import { repoRoot } from '../lib/repo-root.mjs';
import { spawnChild, killChild } from '../lib/child.mjs';
import { openJoin } from '../lib/join.mjs';

/**
 * @typedef {Awaited<ReturnType<typeof connect>>} Browser
 * @typedef {Awaited<ReturnType<Browser['newPage']>>} Page
 * @typedef {{ p05Midi?: number | null, p95Midi?: number | null, keyTonic?: number | null }} Profile
 * @typedef {{ id: string, title: string, source?: string, stemStatus?: string, instrumentalRef?: string | null, vocalsRef?: string | null, songProfile?: Profile | null }} Media
 */

const PORT = process.env.EPORT ?? '5216';
const BASE = `http://127.0.0.1:${PORT}`;
const CORE_DIR = repoRoot;
const SCRATCH = process.env.KIROCREW_SCRATCH ?? process.env.TMPDIR ?? '/tmp';
const RUN_DIR = join(SCRATCH, `p16-drawer-controls-${process.pid}`);
const MEDIA_DIR = join(RUN_DIR, 'media');

/** The exact sentence the drawer derives for a song with no isolated vocals. */
const NOTE_FRAGMENT = 'no isolated vocals';
/** vaul animates the sheet in; measuring or dragging mid-transition reads a frame that is still moving. */
const VAUL_OPEN_SETTLE_MS = 400;
/** A dim ancestor is only believed once it survives this — vaul's own fade reports below full alpha. */
const OPACITY_RECHECK_MS = 800;

/** @type {{ name: string, ok: boolean }[]} */
const checks = [];
/** @param {string} name @param {unknown} ok @param {string} [detail] */
function check(name, ok, detail) {
	checks.push({ name, ok: !!ok });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
}
/** @param {string} msg @returns {never} */
function bail(msg) {
	console.error(`\nENVIRONMENT: ${msg}`);
	process.exit(2);
}

/** @param {() => Promise<unknown>} fn @param {{ timeout?: number, every?: number, name?: string }} [o] */
async function waitFor(fn, { timeout = 30_000, every = 250, name = 'condition' } = {}) {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		const v = await fn().catch(() => null);
		if (v) return v;
		await sleep(every);
	}
	throw new Error(`timed out after ${timeout}ms waiting for ${name}`);
}

const serverAlive = async () =>
	await fetch(`${BASE}/health`)
		.then((r) => r.ok)
		.catch(() => false);

async function bootServer() {
	if (await serverAlive()) bail(`something is already listening on ${BASE}; this probe owns the port and the workers`);
	mkdirSync(MEDIA_DIR, { recursive: true });
	await new Promise((res, rej) => {
		const p = spawnChild('bun', ['run', 'tests/e2e/seed-media.mjs'], {
			cwd: CORE_DIR,
			env: { ...process.env, MEDIA_DIR }
		});
		p.on('exit', (code) => (code === 0 ? res(null) : rej(new Error(`seed exited ${code}`))));
	});
	const logFd = join(RUN_DIR, 'server.log');
	const proc = spawnChild('bun', ['./server.ts'], {
		cwd: CORE_DIR,
		stdio: ['ignore', openSync(logFd, 'w'), openSync(logFd, 'a')],
		env: {
			...process.env,
			ENCORE_EPHEMERAL: '1',
			PORT,
			HOST: '127.0.0.1',
			MEDIA_DIR,
			ENCORE_LYRICS_BACKFILL: '0',
			// The backfill would go and find vocals for the song this probe needs to have none.
			ENCORE_VOCALS_BACKFILL: '0'
		}
	});
	await waitFor(serverAlive, { timeout: 30_000, name: 'server /health' });
	console.log(`[boot] server up on ${BASE} (log ${logFd})`);
	return proc;
}

/**
 * Spawn a fake worker and resolve only once the server has WELCOMED it — otherwise process can
 * enqueue a job before any worker is live and the process sits in 'queued' forever.
 * @param {'withVocals' | 'noVocals'} kind
 */
async function spawnWorker(kind) {
	/** @type {Record<string, string | undefined>} */
	const env = {
		...process.env,
		EPORT: PORT,
		MEDIA_DIR,
		FAKE_WORKER_ID: `p16-${kind}-${process.pid}`,
		FAKE_SLOW_MS: '50'
	};
	if (kind === 'noVocals') env.FAKE_NO_VOCALS = '1';
	// `hasGuidingTrack` is `isPlayable(m) && !!m.guideMixRef` — the 4-channel MIX, not the vocals stem,
	// so a song with vocals and no mix is correctly un-guidable and the enabled arm needs FAKE_GUIDE_MIX.
	if (kind === 'withVocals') env.FAKE_GUIDE_MIX = '1';
	const logFd = join(RUN_DIR, `worker-${kind}.log`);
	const p = spawnChild('bun', ['tests/e2e/fake-stems-worker.mjs'], {
		cwd: CORE_DIR,
		stdio: ['ignore', openSync(logFd, 'w'), openSync(logFd, 'a')],
		env
	});
	const started = Date.now();
	while (Date.now() - started < 15_000) {
		const t = await readFileP(logFd, 'utf8').catch(() => '');
		if (t.includes('welcomed')) {
			console.log(`[boot] worker=${kind} welcomed`);
			return p;
		}
		await sleep(150);
	}
	throw new Error(`worker ${kind} never welcomed (see ${logFd})`);
}

let COOKIE = '';
/** @param {string} path @param {RequestInit} [init] */
async function api(path, init = {}) {
	const headers = new Headers(init.headers ?? {});
	if (COOKIE) headers.set('cookie', COOKIE);
	if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
	const res = await fetch(`${BASE}${path}`, { ...init, headers });
	const sc = res.headers.get('set-cookie');
	if (sc) COOKIE = sc.split(';')[0];
	return res;
}

/** The library is session-scoped, so the probe joins over HTTP before it processes anything.
 *  @param {string} name */
async function apiJoin(name) {
	const r = await api('/api/join', { method: 'POST', body: JSON.stringify({ displayName: name, color: '#ff5cae' }) });
	if (!r.ok) throw new Error(`join failed ${r.status} ${await r.text()}`);
	return r.json();
}

/** @returns {Promise<Media[]>} */
async function library() {
	const d = await api('/api/library').then((r) => r.json());
	return d.library ?? [];
}

/**
 * Process one local song by title fragment and wait for it to be ready.
 *
 * Discovery goes through `/api/search`, not `/api/library`: the library lists media the room already
 * knows about, and a freshly seeded file is not that until something has looked at it. Searching is
 * what surfaces a local file, which is why p2 does the same.
 * @param {string} q
 */
async function processOne(q) {
	const d = await api(`/api/search?q=${encodeURIComponent(q)}`).then((r) => r.json());
	const all = /** @type {Media[]} */ ([...(d.ready ?? []), ...(d.results ?? []), ...(d.processing ?? [])]);
	const m = all.find((x) => x.source === 'local') ?? all[0];
	if (!m) throw new Error(`no song matching "${q}" from /api/search (got ${JSON.stringify(d).slice(0, 300)})`);
	const r = await api('/api/process', { method: 'POST', body: JSON.stringify({ mediaId: m.id }) });
	if (!r.ok && r.status !== 409) throw new Error(`process ${r.status} ${await r.text()}`);
	return /** @type {Media} */ (
		await waitFor(
			async () => (await library()).find((x) => x.id === m.id && x.stemStatus === 'ready' && x.instrumentalRef),
			{ timeout: 60_000, name: `"${m.title}" ready` }
		)
	);
}

// Computed here rather than importing `rangeLabel`: an oracle that calls the helper the UI calls
// would mirror a bug instead of catching one. The spelling is pinned in
// src/lib/contract/process/song-profile.ts, and a change to it should red here.
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
/** @param {number} midi */
function noteName(midi) {
	const n = Math.round(midi);
	return `${SHARP_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
}
/** @param {Profile | null | undefined} p @returns {string | null} */
function expectedRangeLabel(p) {
	if (!p || typeof p.p05Midi !== 'number' || typeof p.p95Midi !== 'number') return null;
	return `${noteName(p.p05Midi)} - ${noteName(p.p95Midi)}`;
}

/** @param {Page} phone */
async function ensureProbeWs(phone) {
	await phone.evaluate(`
		(async () => {
			if (window.probeWs && window.probeWs.readyState === 1) return;
			const ws = new WebSocket((location.protocol === 'https:' ? 'wss': 'ws') + '://' + location.host + '/ws?role=phone');
			await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('probeWs open failed')); });
			window.probeWs = ws;
		})()
	`);
}
/** @param {Page} phone @param {Record<string, unknown>} command */
async function sendPlayer(phone, command) {
	await ensureProbeWs(phone);
	await phone.evaluate(
		`window.probeWs.send(JSON.stringify({ type: 'player:command', command: ${JSON.stringify(command)} }))`
	);
}
/** @param {Page} phone @param {string} mediaId @param {string} singerId */
async function queueAdd(phone, mediaId, singerId) {
	await ensureProbeWs(phone);
	const now = Date.now();
	const command = {
		clientOpId: `p16-o-${now}-${Math.floor(Math.random() * 1e6)}`,
		op: {
			op: 'add',
			entry: {
				id: `p16-e-${now}-${Math.floor(Math.random() * 1e6)}`,
				mediaId,
				singerId,
				status: 'queued',
				rotationSeq: Number.MAX_SAFE_INTEGER,
				addedAt: now
			}
		}
	};
	await phone.evaluate(
		`window.probeWs.send(JSON.stringify({ type: 'queue:command', command: ${JSON.stringify(command)} }))`
	);
	await sleep(250);
}

// Every selector handed to the page ONCE, so no in-page expression spells one as a literal — the
// contract guard bans that. See docs/E2E.md#why-selectors-are-centralised
const PRELUDE = `
	const S = {
		drawer: ${JSON.stringify(SEL.npDrawer)},
		song: ${JSON.stringify(SEL.bandTitle)},
		drawerHandle: ${JSON.stringify(SEL.drawerHandle)},
		body: ${JSON.stringify(SEL.toolsBody)},
		note: ${JSON.stringify(SEL.toolsNote)},
		gt: ${JSON.stringify(SEL.guidingTrackRoot)},
		readout: ${JSON.stringify(SEL.guideReadout)},
		slider: ${JSON.stringify(SEL.slider)},
		keyCap: ${JSON.stringify(SEL.keyBtn)},
		keyLab: ${JSON.stringify(SEL.keyLabel)},
		bandTitle: ${JSON.stringify(SEL.bandTitle)},
		bandOpen: ${JSON.stringify(SEL.bandOpen)},
		songDoor: ${JSON.stringify(SEL.songDoor)}
	};
	const q = (s) => document.querySelector(s);
	const qq = (s) => Array.prototype.slice.call(document.querySelectorAll(s));
	const painted = (el) => !!el && !!el.getClientRects().length;
`;

// The CLOSED state. `sliderCount` is a count, not a visibility test: vaul destroys the drawer's
// content on close, so ABSENCE is the honest claim.
const CLOSED_EXPR = `(() => {
	${PRELUDE}
	return {
		bandOpenPresent: !!q(S.bandOpen),
		bandTitleText: q(S.bandTitle)?.textContent?.trim() ?? null,
		drawerPresent: !!q(S.drawer),
		sliderCount: qq(S.slider).length,
		bodyCount: qq(S.body).length,
		notePresent: !!q(S.note)
	};
})()`;

/**
 * The OPEN drawer's live-controls state, in ONE evaluate so every field describes the same paint —
 * per-field round trips can straddle a re-render and report a mix of two states.
 *
 * `rangeEl` is found by TEXT because the range block has no SEL hook and inventing one here would put
 * a selector outside the contract; the walk is post-order so the DEEPEST exact match wins (the label
 * span, not the section around it). `noteDimmedByAncestor` is measured rather than inferred from
 * containment, because GuidingTrack's `opacity: 0.5` sits on the control leaf.
 *
 * @param {string | null} expectedRange
 */
function stateExpr(expectedRange) {
	return `(() => {
		${PRELUDE}
		const RANGE_TEXT = ${JSON.stringify(expectedRange)};
		const FRAGMENT = ${JSON.stringify(NOTE_FRAGMENT)};
		const drawer = q(S.drawer);
		const body = q(S.body);
		const note = q(S.note);
		const gt = q(S.gt);
		const slider = q(S.slider);
		const handle = q(S.drawerHandle);
		const keyLab = q(S.keyLab);
		const keyCaps = qq(S.keyCap);

		let rangeEl = null;
		if (RANGE_TEXT && body) {
			const walk = (el) => {
				for (let i = 0; i < el.children.length; i += 1) walk(el.children[i]);
				if (!rangeEl && (el.textContent || '').trim() === RANGE_TEXT) rangeEl = el;
			};
			walk(body);
		}

		let dimAncestor = null;
		if (note) {
			for (let el = note.parentElement; el && el !== document.body; el = el.parentElement) {
				const op = parseFloat(getComputedStyle(el).opacity || '1');
				if (op < 1) {
					dimAncestor = el.tagName.toLowerCase() + '.' + String(el.className || '') + ' @ opacity ' + op;
					break;
				}
			}
		}

		return {
			drawerPresent: !!drawer,
			songText: q(S.song)?.textContent?.trim() ?? null,
			bodyPresent: !!body,
			sliderPresent: !!slider,
			sliderPainted: painted(slider),
			sliderInBody: !!(slider && body && body.contains(slider)),
			sliderOnDragHandle: !!(slider && handle && handle.contains(slider)),
			dragHandlePresent: !!handle,
			// PRESENCE, not value: Bits UI emits data-disabled="" when disabled and omits it entirely
			// when enabled, which the non-vacuity mutation in the header confirmed.
			sliderDisabled: !!slider && (slider.hasAttribute('data-disabled') || slider.getAttribute('aria-disabled') === 'true'),
			readout: q(S.readout)?.textContent?.trim() ?? null,
			notePresent: !!note,
			noteText: note?.textContent?.trim() ?? null,
			noteInsideDimmedSubtree: !!(gt && note && gt.contains(note)),
			noteInBody: !!(body && note && body.contains(note)),
			noteBeforeControl: !!(
				note &&
				slider &&
				(note.compareDocumentPosition(slider) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
			),
			noteDimmedByAncestor: dimAncestor,
			gtDimmed: !!gt && gt.classList.contains('disabled'),
			keyCapCount: keyCaps.length,
			keyCapsLive:
				keyCaps.length > 0 &&
				keyCaps.every((b) => !b.disabled && b.getAttribute('aria-disabled') !== 'true'),
			keyLabelText: keyLab?.textContent?.trim() ?? null,
			rangeShown: painted(rangeEl),
			rangeBelowKeyRow: !!(
				keyLab &&
				rangeEl &&
				(keyLab.compareDocumentPosition(rangeEl) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
			),
			pageTextHasFragment: (document.body.textContent ?? '').toLowerCase().includes(FRAGMENT),
			// The "\u00b7\u00b7\u00b7" door to /song/[mediaId]. An ANCHOR, deliberately: back is then the browser's
			// own back and the route stays shareable, which a history.back() button gives up.
			moreHref: /** @type {HTMLAnchorElement | null} */ (q(S.songDoor))?.getAttribute('href') ?? null,
			moreLabel: q(S.songDoor)?.getAttribute('aria-label') ?? null,
			moreIsAnchor: q(S.songDoor)?.tagName === 'A'
		};
	})()`;
}

/** @param {Page} phone @param {string} title */
async function waitForBandTitle(phone, title) {
	await waitFor(
		async () =>
			(await phone.evaluate(`document.querySelector(${JSON.stringify(SEL.bandTitle)})?.textContent ?? ''`))?.includes?.(
				title
			),
		{ timeout: 20_000, name: `the band showing "${title}"` }
	);
}

/**
 * Open the drawer from the band's expand button and wait for the song it should be about.
 *
 * IDEMPOTENT and gated on the drawer being shut: while it is open vaul's overlay covers the band, so a
 * second tap lands on a scrim instead of the button.
 * @param {Page} phone @param {string} title
 */
async function openDrawerFor(phone, title) {
	await waitForBandTitle(phone, title);
	const open = await phone.evaluate(`!!document.querySelector(${JSON.stringify(SEL.npDrawer)})`);
	if (!open) await phone.click(SEL.bandOpen);
	await waitFor(async () => await phone.evaluate(`!!document.querySelector(${JSON.stringify(SEL.npDrawer)})`), {
		timeout: 10_000,
		name: 'the now-playing drawer to open'
	});
	// The band is composed INSIDE this sheet, so its title is the song identity of the OPEN drawer.
	await waitFor(
		async () =>
			(await phone.evaluate(`document.querySelector(${JSON.stringify(SEL.bandTitle)})?.textContent ?? ''`))?.includes?.(
				title
			),
		{ timeout: 15_000, name: `the drawer showing "${title}"` }
	);
	await sleep(VAUL_OPEN_SETTLE_MS);
}

/** The rendered rect of one element, in viewport coordinates — what a real pointer drag needs.
 *  @param {Page} phone @param {string} selector */
async function boxOf(phone, selector) {
	return /** @type {{ x: number, y: number, w: number, h: number } | null} */ (
		await phone.evaluate(`(() => {
			const el = document.querySelector(${JSON.stringify(selector)});
			if (!el) return null;
			const r = el.getBoundingClientRect();
			return { x: r.x, y: r.y, w: r.width, h: r.height };
		})()`)
	);
}

/** 'Off' is zero, not absent: the readout says it at level 0 and for a dead control alike.
 *  @param {string | null} text */
function pctOf(text) {
	if (text === null) return null;
	if (text === 'Off') return 0;
	const m = text.match(/(\d+)/);
	return m ? parseInt(m[1], 10) : null;
}

/** Poll an in-page expression to truthy, reporting FALSE rather than throwing on timeout — a gesture
 *  that did not take is a check result, not a probe error.
 *  @param {Page} phone @param {string} expression @param {number} timeout */
async function settles(phone, expression, timeout) {
	try {
		await waitFor(async () => await phone.evaluate(expression), { timeout, every: 120, name: expression });
		return true;
	} catch {
		return false;
	}
}

/** @type {import('node:child_process').ChildProcess | undefined} */ let server;
/** @type {import('node:child_process').ChildProcess | undefined} */ let worker;
/** @type {Browser | undefined} */ let browser;

async function main() {
	mkdirSync(RUN_DIR, { recursive: true });
	const chromium = findChromium();
	if (!chromium) bail('no Chromium found. Set PW_CHROMIUM.');

	// An environment fault must not be reportable as a defect, so a missing or stale build exits 2.
	if (!existsSync(join(CORE_DIR, 'build'))) {
		bail('build is missing. Run `bun run build` first — this probe drives the BUILT app.');
	}
	const builtNewerThan = (/** @type {string} */ f) => {
		try {
			return statSync(join(CORE_DIR, 'build')).mtimeMs >= statSync(join(CORE_DIR, f)).mtimeMs;
		} catch {
			return true;
		}
	};
	// The controls are only reachable because the layout mounts the drawer and hands the band an
	// `onexpand`, so a build predating any of these five fails the gesture arms for an environment reason.
	for (const f of [
		'src/lib/components/GuidingTrack.svelte',
		'src/lib/components/ui/slider/slider.svelte',
		'src/lib/components/NowPlayingDrawer.svelte',
		'src/lib/components/NowPlayingBand.svelte',
		'src/routes/+layout.svelte'
	]) {
		if (!builtNewerThan(f)) bail(`${f} is newer than build. Run \`bun run build\` — this probe drives the BUILT app.`);
	}

	server = await bootServer();
	await apiJoin('ProbeApi');

	worker = await spawnWorker('withVocals');
	const withStem = await processOne('caroline');
	await killChild(worker);

	worker = await spawnWorker('noVocals');
	const noStem = await processOne('bohemian');
	await killChild(worker);

	const wv = (await library()).find((m) => m.id === withStem.id);
	const nv = (await library()).find((m) => m.id === noStem.id);
	console.log(
		`\nfixture: "${withStem.title}" vocalsRef=${JSON.stringify(wv?.vocalsRef ?? null)} guideMixRef=${JSON.stringify(wv?.guideMixRef ?? null)}`
	);
	console.log(
		`fixture: "${noStem.title}" vocalsRef=${JSON.stringify(nv?.vocalsRef ?? null)} guideMixRef=${JSON.stringify(nv?.guideMixRef ?? null)}\n`
	);

	// The whole probe is meaningless if the two fixtures are not actually in different states, and a
	// fixture that silently drifted into one state would otherwise read as a clean pass.
	if (!wv?.vocalsRef) bail(`"${withStem.title}" processed with NO vocals ref; the with-stem arm has no subject`);
	if (nv?.vocalsRef)
		bail(`FAKE_NO_VOCALS did not withhold the vocals ref (got ${nv.vocalsRef}); the degraded arm has no subject`);
	// The MIX is bailed on separately from vocalsRef because the two came apart: `hasGuidingTrack` reads
	// `!!guideMixRef`, so a fixture with vocals and no mix looks healthy while the enabled arm has no subject.
	if (!wv?.guideMixRef)
		bail(`"${withStem.title}" processed with NO guide mix ref; the ENABLED arm has no subject (FAKE_GUIDE_MIX=1?)`);
	if (nv?.guideMixRef) bail(`the degraded fixture got a guide mix (${nv.guideMixRef}); its arm has no subject`);

	// The fake worker publishes p05Midi/p95Midi unless FAKE_NO_PROFILE is set, so a missing range is an
	// environment fault and bails rather than entering the verdict.
	const expectedRange = expectedRangeLabel(wv?.songProfile);
	if (!expectedRange) {
		bail(
			`"${withStem.title}" reported no vocal range (songProfile=${JSON.stringify(wv?.songProfile ?? null)}), so the range claim has no subject`
		);
	}
	console.log(`fixture: expected range label ${JSON.stringify(expectedRange)}\n`);

	const b = /** @type {Browser} */ (await waitFor(() => connect().catch(() => null), { timeout: 20_000, name: 'CDP' }));
	browser = b;
	const phone = await b.newPage();
	// The drawer and the band are thumb-zone chrome, so the width is not incidental to the measurement.
	await phone.viewport(390, 844);

	// Join IN THE BROWSER so the queue op's actor is this session's singer. The name goes through the
	// native value setter plus an `input` event, because Svelte's `bind:value` listens for the event and a
	// bare `.value =` leaves the binding holding its old value with the submit control still disabled.
	await openJoin(phone, BASE);
	await waitFor(async () => await phone.evaluate(`!!document.querySelector(${JSON.stringify(SEL.nameInput)})`), {
		timeout: 15_000,
		name: 'the join name field'
	});
	await phone.evaluate(`(() => {
		const el = document.querySelector(${JSON.stringify(SEL.nameInput)});
		const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
		setter.call(el, 'Probe');
		el.dispatchEvent(new Event('input', { bubbles: true }));
		el.dispatchEvent(new Event('change', { bubbles: true }));
	})()`);
	await sleep(300);
	const clicked = await phone.evaluate(`(() => {
		const btns = [...document.querySelectorAll('button')];
		const b = btns.find((x) => /sing|join|start/i.test((x.textContent || '') + ' ' + (x.getAttribute('aria-label') || '')));
		if (!b || b.disabled) return { found: !!b, disabled: !!b && b.disabled };
		b.click();
		return { found: true, disabled: false };
	})()`);
	if (!clicked?.found || clicked?.disabled) {
		bail(`the join control was ${clicked?.found ? 'disabled' : 'not found'} — the name field never took its value`);
	}
	// `SEL.homeReady` is `.band`, which the layout mounts on exactly this condition, so it answers
	// "this singer is joined" with no gesture.
	await waitFor(async () => await phone.evaluate(`!!document.querySelector(${JSON.stringify(SEL.homeReady)})`), {
		timeout: 20_000,
		name: 'the joined phone (the now-playing band)'
	});

	const actor = /** @type {string} */ (
		await phone.evaluate(`fetch('/api/me').then((r) => r.json()).then((d) => d?.singer?.id ?? d?.id ?? '')`)
	);
	if (!actor) bail('could not read the joined singer id from the browser session, so a queue op would be rejected');

	// ARM 1: a song WITH a guide mix.
	await queueAdd(phone, withStem.id, actor);
	await sendPlayer(phone, { cmd: 'play' });
	await waitForBandTitle(phone, withStem.title);

	// SHUT first: the controls must not occupy the screen until asked for, while the band still says what is playing.
	const closed = /** @type {any} */ (await phone.evaluate(CLOSED_EXPR));
	check(
		'the controls start away: the band offers its expand button and no drawer is rendered',
		closed.bandOpenPresent && !closed.drawerPresent && closed.bodyCount === 0,
		JSON.stringify(closed)
	);
	check(
		'the band states what is playing while the controls are away',
		typeof closed.bandTitleText === 'string' && closed.bandTitleText.includes(withStem.title),
		JSON.stringify(closed.bandTitleText)
	);
	check(
		'no control exists on the page while the drawer is shut',
		closed.sliderCount === 0 && !closed.notePresent,
		JSON.stringify(closed)
	);

	await openDrawerFor(phone, withStem.title);
	const live = /** @type {any} */ (await phone.evaluate(stateExpr(expectedRange)));

	// The drawer's PRESENCE is the open state: vaul portals its content on open and destroys it on close.
	check(
		"the band's pull handle opens the drawer, and the live-controls body is in it",
		live.drawerPresent && live.bodyPresent && live.dragHandlePresent,
		JSON.stringify(live)
	);
	// `handleOnly` makes vaul's handle the only draggable element, so the control must not be inside it.
	check(
		'the control is in the drawer BODY, never on the drag handle',
		live.sliderPresent && live.sliderInBody && !live.sliderOnDragHandle,
		JSON.stringify(live)
	);
	check(
		'a song WITH an isolated stem gets a live control',
		live.sliderPresent && live.sliderPainted && !live.sliderDisabled,
		JSON.stringify(live)
	);
	check(
		'…and no explanation, because a working control needs none',
		!live.notePresent && !live.pageTextHasFragment,
		JSON.stringify(live)
	);
	// Read at keyShift 0, BEFORE the key row below is driven: the range label transposes with the key.
	check(
		'the vocal range is shown in the same reveal as the key row, with nothing further to open',
		live.rangeShown && live.rangeBelowKeyRow,
		`expected ${JSON.stringify(expectedRange)} — shown=${live.rangeShown} belowKeyRow=${live.rangeBelowKeyRow}`
	);

	// Asserted against the id of the song actually playing, not merely for presence: a door pointing at
	// the wrong song is worse than no door.
	check(
		'the drawer offers the "···" door, as a real anchor to THIS song',
		live.moreIsAnchor === true && live.moreHref === `/song/${withStem.id}`,
		`href=${JSON.stringify(live.moreHref)} (want "/song/${withStem.id}"), tag ${live.moreIsAnchor ? 'A' : 'not A'}, label=${JSON.stringify(live.moreLabel)}`
	);
	check(
		'the key row is present and live for a playable song',
		live.keyCapCount === 2 && live.keyCapsLive && live.keyLabelText === 'Key',
		JSON.stringify({ caps: live.keyCapCount, live: live.keyCapsLive, label: live.keyLabelText })
	);

	// Clicked in-page rather than with a real pointer: the keycap's glyph is a small inline SVG and
	// hit-testing it adds nothing. p3-key-shift owns the pitch semantics; this arm claims only the wiring.
	const keyBefore = live.keyLabelText;
	await phone.evaluate(`(() => {
		const caps = document.querySelectorAll(${JSON.stringify(SEL.keyBtn)});
		if (caps[0]) caps[0].click();
	})()`);
	const keyMoved = await settles(
		phone,
		`(() => {
			const l = document.querySelector(${JSON.stringify(SEL.keyLabel)});
			return !!l && l.textContent.trim() !== ${JSON.stringify(keyBefore)};
		})()`,
		5_000
	);
	check(
		'…and a keycap moves the key: the label follows the server broadcast',
		keyMoved,
		`label was ${JSON.stringify(keyBefore)}, now ${JSON.stringify(await phone.text(SEL.keyLabel))}`
	);

	// One gesture, two claims: the slider ANSWERS the drag (the drawer is not swallowing the pointer) and
	// the drawer SURVIVES it (`handleOnly` is in force). It drags AWAY from the current level so the
	// assertion cannot pass on a level that never moved, and carries a downward component because a real
	// thumb drag is never perfectly horizontal — the vertical part is what a drag-anywhere sheet steals.
	const sliderBox = await boxOf(phone, SEL.slider);
	if (!sliderBox || sliderBox.w < 40) {
		bail(`the guiding-track slider measured ${JSON.stringify(sliderBox)}; there is no track to drag along`);
	}
	const guideBefore = pctOf(await phone.text(SEL.guideReadout));
	if (guideBefore === null) bail('the guiding-track readout is unreadable, so a level change cannot be observed');
	const low = guideBefore <= 50;
	const gy = sliderBox.y + sliderBox.h / 2;
	await phone.drag(
		sliderBox.x + sliderBox.w * (low ? 0.12 : 0.88),
		gy,
		sliderBox.x + sliderBox.w * (low ? 0.85 : 0.15),
		gy + 22,
		{ steps: 10, settle: 20 }
	);
	await sleep(500);
	const guideAfter = pctOf(await phone.text(SEL.guideReadout));
	check(
		'a pointer drag ON THE SLIDER moves the guiding track',
		guideAfter !== null && Math.abs(guideAfter - guideBefore) >= 10,
		`readout ${guideBefore}% → ${guideAfter === null ? 'unreadable' : `${guideAfter}%`} across ${Math.round(sliderBox.w)}px of track`
	);
	const afterSliderDrag = /** @type {any} */ (await phone.evaluate(stateExpr(expectedRange)));
	check(
		'…and that drag does NOT dismiss the drawer — handleOnly is in force',
		afterSliderDrag.drawerPresent && afterSliderDrag.sliderPresent && afterSliderDrag.bodyPresent,
		JSON.stringify(afterSliderDrag)
	);

	// The other half: a `handleOnly` drawer whose vendored Handle lost vaul's `data-slot` is undraggable
	// ENTIRELY and nothing warns, which is what the vendored drawer-handle.svelte exists to correct.
	const handleBox = await boxOf(phone, SEL.drawerHandle);
	if (!handleBox) bail("the drawer renders no vaul handle, so 'a drag on the handle dismisses it' has no subject");
	const hx = handleBox.x + handleBox.w / 2;
	const hy = handleBox.y + handleBox.h / 2;
	await phone.drag(hx, hy, hx, hy + 420, { steps: 14, settle: 22 });
	const dismissed = await settles(phone, `!document.querySelector(${JSON.stringify(SEL.npDrawer)})`, 6_000);
	check(
		'a pointer drag on the HANDLE dismisses the drawer',
		dismissed,
		dismissed ? '' : 'the drawer was still rendered 6s after a 420px downward drag on its handle'
	);

	// ARM 2: a song with NO isolated stem.
	// The drawer was just dragged shut, so this arm also proves it re-opens after a dismissal.
	await queueAdd(phone, noStem.id, actor);
	await sendPlayer(phone, { cmd: 'skip' });
	await openDrawerFor(phone, noStem.title);
	const degraded = /** @type {any} */ (await phone.evaluate(stateExpr(expectedRange)));

	check(
		'the control STAYS on screen, disabled, for a song with no stem',
		degraded.sliderPresent && degraded.sliderPainted && degraded.sliderDisabled,
		JSON.stringify(degraded)
	);
	check(
		"the readout says 'Off' rather than a live-looking number",
		degraded.readout === 'Off',
		`readout=${JSON.stringify(degraded.readout)}`
	);
	check(
		'the reason is on screen and names what still works',
		degraded.notePresent && /still work/i.test(degraded.noteText ?? ''),
		JSON.stringify(degraded.noteText)
	);
	// The reason must be read BEFORE the dead row, and must live with the controls, not in the header.
	check(
		'the reason renders BEFORE the control it explains, inside the controls body',
		degraded.noteInBody && degraded.noteBeforeControl,
		JSON.stringify({ inBody: degraded.noteInBody, beforeControl: degraded.noteBeforeControl })
	);
	// `class:disabled` on `.gt` is the anchor the contract pins; the measured arm below is what still
	// holds now that the dimming sits on the control leaf.
	check(
		'the reason sits OUTSIDE the subtree the disabled control marks',
		degraded.gtDimmed && !degraded.noteInsideDimmedSubtree,
		`gtDimmed=${degraded.gtDimmed} inside=${degraded.noteInsideDimmedSubtree}`
	);
	let dimmedBy = degraded.noteDimmedByAncestor;
	if (dimmedBy !== null) {
		await sleep(OPACITY_RECHECK_MS);
		dimmedBy = /** @type {any} */ (await phone.evaluate(stateExpr(expectedRange))).noteDimmedByAncestor;
	}
	check(
		'…and no ancestor dims the reason with opacity (measured)',
		degraded.notePresent && dimmedBy === null,
		`firstDimmedAncestor=${JSON.stringify(dimmedBy)}`
	);
}

/** @type {number} */
let code;
try {
	await main();
	const failed = checks.filter((c) => !c.ok);
	console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
	code = failed.length ? 1 : 0;
} catch (err) {
	console.error(`\nPROBE ERROR: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
	console.error(`logs: ${RUN_DIR}`);
	code = 1;
} finally {
	try {
		await browser?.close?.();
	} catch {
		// Failing teardown must not mask the verdict already reported; the children are killed either way.
	}
	await killChild(worker);
	await killChild(server);
}
process.exit(code);
