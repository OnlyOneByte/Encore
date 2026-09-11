/*
 * P16 — THE HERO'S LIVE CONTROLS, AND THEIR HONEST DEGRADATION (XR-PH-15, XR-PH-03).
 *
 * ── WHY THIS PROBE EXISTS ──────────────────────────────────────────────────────────────────────
 *
 * These four claims used to be `bun test` mount-rung tests in
 * `apps/core/src/lib/components/hero-live-controls-835.test.ts`. #913 moved GuidingTrack's control
 * onto shadcn's <Slider>, which is built on Bits UI, and Bits UI's slider needs a LAYOUT
 * ENVIRONMENT to exist at all:
 *
 *   1. it reads `offsetWidth` to place its thumb, and `test-setup/svelte-dom-preload.ts` replaces
 *      that accessor with a throw, because happy-dom fabricates a zero and "a zero a guard can
 *      mistake for a real measurement is worse than no API at all" (XR-VER-03);
 *   2. it observes its track with `ResizeObserver`, which the same preload deliberately does NOT
 *      install — and `mount-rung.test.ts` has a live arm asserting that absence, so that
 *      `bind:clientHeight` has no silent path to 0.
 *
 * Both refusals are deliberate, each has its own guard, and faking both to get a green mount is
 * exactly the silent-green the mount rung was built to prevent. So the claims moved DOWN to the rung
 * where geometry is real, rather than the component being held back by the harness.
 *
 * What is lost by moving, stated plainly: these four assertions no longer run on a box with no
 * Chromium, where they used to run everywhere. That is the trade, and it was made deliberately.
 *
 * ── WHAT IT ASSERTS, AND WHY EACH ONE IS A REAL DEFECT ─────────────────────────────────────────
 *
 * The claim is about a song with NO isolated vocals stem. The guiding track cannot work for it, and
 * the honest response is not to hide the control:
 *
 *   - the control STAYS on screen and is disabled, so the singer is not left wondering where it went;
 *   - its readout says "Off" rather than a live-looking number it is not delivering;
 *   - a sentence explains why, and it names what still works, because a reason alone leaves a singer
 *     thinking the whole control group is dead;
 *   - the sentence sits OUTSIDE the subtree `.gt.disabled` dims with `opacity` (XR-PH-03) — an
 *     explanation rendered at 50% opacity is the one element on screen that must stay legible;
 *   - the sentence is in the disclosure BODY, never the collapsed summary, so it does not shout at a
 *     singer who has not opened the panel.
 *
 * And the inverse arm: a song WITH a stem gets a live control and NO explanation, because an
 * explanation for a working control is noise.
 *
 * ── HOW THE DEGRADED STATE IS REACHED ──────────────────────────────────────────────────────────
 *
 * `hasGuidingTrack()` is `isPlayable(m) && !!m.vocalsRef`, so the degraded arm needs a song that
 * cooked successfully and reported no vocals ref. `FAKE_NO_VOCALS=1` on the fake stems worker does
 * exactly that, and it is not a fault injection: `worker-hub.ts` optional-chains
 * `artifacts?.stems?.vocals` and its own comment says a worker that could not encode vocals "reports
 * none". So the probe cooks TWO songs against one server, restarting the worker between them.
 *
 * ── NON-VACUITY, MEASURED RATHER THAN ASSERTED ─────────────────────────────────────────────────
 *
 * A probe that cannot fail is worse than no probe. Both load-bearing arms were verified by breaking
 * the product and watching them go red:
 *
 *   - `disabled={false}` on the <Slider> → "the control STAYS on screen, disabled" FAILS, and
 *     `data-disabled` disappears entirely (Bits UI omits the attribute when enabled and emits it as
 *     `data-disabled=""` when disabled, so PRESENCE is the correct test, not the value).
 *   - `class:disabled={false}` on `.gt` → XR-PH-03 FAILS, because the reason is then no longer
 *     outside a dimmed subtree for the reason that matters: nothing is dimmed.
 *
 *   EPORT=5216 bun apps/core/e2e/probes/p16-hero-live-controls.mjs
 *
 * Exit 0 all passed / 1 a real failure / 2 the environment could not host the test.
 */
import { spawn as spawnChild } from 'node:child_process';
import { existsSync, mkdirSync, openSync, statSync } from 'node:fs';
import { readFile as readFileP } from 'node:fs/promises';
import { join } from 'node:path';
import { connect, sleep } from '../cdp.mjs';
import { SEL } from '../contract.ts';
import { findChromium } from '../lib/chromium.mjs';

/**
 * @typedef {Awaited<ReturnType<typeof connect>>} Browser
 * @typedef {Awaited<ReturnType<Browser['newPage']>>} Page
 * @typedef {{ id: string, title: string, source?: string, stemStatus?: string, instrumentalRef?: string | null, vocalsRef?: string | null }} Media
 */

const PORT = process.env.EPORT ?? '5216';
const BASE = `http://127.0.0.1:${PORT}`;
const CDP_PORT = Number(process.env.CDP_PORT ?? 9356);
const CORE_DIR = join(import.meta.dirname, '..', '..');
const SCRATCH = process.env.KIROCREW_SCRATCH ?? process.env.TMPDIR ?? '/tmp';
const RUN_DIR = join(SCRATCH, `p16-hero-controls-${process.pid}`);
const MEDIA_DIR = join(RUN_DIR, 'media');

/** The exact sentence the route derives for a song with no isolated vocals. */
const NOTE_FRAGMENT = 'no isolated vocals';

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

// ── boot ───────────────────────────────────────────────────────────────────
async function bootServer() {
	if (await serverAlive()) bail(`something is already listening on ${BASE}; this probe owns the port and the workers`);
	mkdirSync(MEDIA_DIR, { recursive: true });
	await new Promise((res, rej) => {
		const p = spawnChild('bun', ['run', 'e2e/seed-media.mjs'], { cwd: CORE_DIR, env: { ...process.env, MEDIA_DIR } });
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
 * Spawn a fake worker and resolve only once the server has WELCOMED it — otherwise make-karaoke can
 * enqueue a job before any worker is live and the cook sits in 'queued' forever.
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
	const logFd = join(RUN_DIR, `worker-${kind}.log`);
	const p = spawnChild('bun', ['e2e/fake-stems-worker.mjs'], {
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

/** @param {import('node:child_process').ChildProcess | undefined} p */
async function kill(p) {
	if (!p || p.exitCode !== null) return;
	p.kill('SIGTERM');
	const started = Date.now();
	while (p.exitCode === null && Date.now() - started < 3000) await sleep(100);
	if (p.exitCode === null) p.kill('SIGKILL');
}

// ── HTTP, with the probe's session cookie ──────────────────────────────────
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

/** The library is session-scoped, so the probe joins over HTTP before it cooks anything. */
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
 * Cook one local song by title fragment and wait for it to be ready.
 *
 * Discovery goes through `/api/search`, not `/api/library`: the library lists media the room already
 * knows about, and a freshly seeded file is not that until something has looked at it. Searching is
 * what surfaces a local file, which is why p2 does the same.
 * @param {string} q
 */
async function cookOne(q) {
	const d = await api(`/api/search?q=${encodeURIComponent(q)}`).then((r) => r.json());
	const all = /** @type {Media[]} */ ([...(d.ready ?? []), ...(d.results ?? []), ...(d.cooking ?? [])]);
	const m = all.find((x) => x.source === 'local') ?? all[0];
	if (!m) throw new Error(`no song matching "${q}" from /api/search (got ${JSON.stringify(d).slice(0, 300)})`);
	const r = await api('/api/make-karaoke', { method: 'POST', body: JSON.stringify({ mediaId: m.id }) });
	if (!r.ok && r.status !== 409) throw new Error(`make-karaoke ${r.status} ${await r.text()}`);
	return /** @type {Media} */ (
		await waitFor(
			async () => (await library()).find((x) => x.id === m.id && x.stemStatus === 'ready' && x.instrumentalRef),
			{ timeout: 60_000, name: `"${m.title}" ready` }
		)
	);
}

// ── page driving ───────────────────────────────────────────────────────────
/** @param {Page} phone */
async function ensureProbeWs(phone) {
	await phone.evaluate(`
		(async () => {
			if (window.probeWs && window.probeWs.readyState === 1) return;
			const ws = new WebSocket((location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/ws?role=phone');
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

/**
 * Read the hero's live-controls state out of a real render. ONE evaluate, so every field describes
 * the same paint: a per-field round trip can straddle a re-render and report a mix of two states.
 *
 * `.gt` is GuidingTrack's own root and `.gt.disabled` is the subtree dimmed with opacity, so
 * `noteInsideDimmedSubtree` is XR-PH-03 stated directly as a DOM containment question.
 */
const STATE_EXPR = `(() => {
	const gt = document.querySelector(${JSON.stringify(SEL.guidingTrackRoot)});
	const slider = document.querySelector(${JSON.stringify(SEL.slider)});
	const note = document.querySelector(${JSON.stringify(SEL.toolsNote)});
	const body = document.querySelector(${JSON.stringify(SEL.toolsBody)});
	const peek = document.querySelector(${JSON.stringify(SEL.toolsPeek)});
	return {
		heroPresent: !!document.querySelector(${JSON.stringify(SEL.hero)}),
		toolsOpen: document.querySelector(${JSON.stringify(SEL.toolsToggle)})?.getAttribute('aria-expanded') === 'true',
		sliderPresent: !!slider,
		sliderInsideToggle: !!(slider && document.querySelector(${JSON.stringify(SEL.toolsToggle)})?.contains(slider)),
		// PRESENCE, not value: Bits UI emits data-disabled="" when disabled and omits it entirely when
		// enabled, which the non-vacuity mutation above confirmed.
		sliderDisabled: !!slider && (slider.hasAttribute('data-disabled') || slider.getAttribute('aria-disabled') === 'true'),
		readout: document.querySelector(${JSON.stringify(SEL.guideReadout)})?.textContent?.trim() ?? null,
		notePresent: !!note,
		noteText: note?.textContent?.trim() ?? null,
		noteInsideDimmedSubtree: !!(gt && note && gt.contains(note)),
		noteInBody: !!(body && note && body.contains(note)),
		peekText: peek?.textContent?.trim() ?? null,
		pageTextHasFragment: (document.body.textContent ?? '').toLowerCase().includes(${JSON.stringify(NOTE_FRAGMENT)}),
		gtDimmed: !!gt && gt.classList.contains('disabled')
	};
})()`;

/**
 * Read the disclosure while it is still CLOSED. Ported from phone-home-832's mount test by #913 S5:
 * the hero's disclosure is a Bits UI Collapsible now, which reads `getBoundingClientRect()` for its
 * height, and the mount rung replaces that with a throw (XR-VER-03). So the claim moved to the rung
 * where the hero can actually render.
 * @param {Page} phone @param {string} title
 */
async function readCollapsedFor(phone, title) {
	await waitFor(
		async () =>
			(await phone.evaluate(`document.querySelector(${JSON.stringify(SEL.heroTitle)})?.textContent ?? ''`))?.includes?.(
				title
			),
		{ timeout: 20_000, name: `hero showing "${title}"` }
	);
	return /** @type {any} */ (
		await phone.evaluate(`(() => {
			const toggle = document.querySelector(${JSON.stringify(SEL.toolsToggle)});
			const slider = document.querySelector(${JSON.stringify(SEL.slider)});
			return {
				togglePresent: !!toggle,
				expanded: toggle?.getAttribute('aria-expanded') === 'true',
				peekText: document.querySelector(${JSON.stringify(SEL.toolsPeek)})?.textContent?.trim() ?? null,
				sliderVisible: !!slider && !!slider.getClientRects().length,
				sliderInsideToggle: !!(slider && toggle && toggle.contains(slider))
			};
		})()`)
	);
}

/** @param {Page} phone @param {string} title */
async function openToolsFor(phone, title) {
	await waitFor(
		async () =>
			(await phone.evaluate(`document.querySelector(${JSON.stringify(SEL.heroTitle)})?.textContent ?? ''`))?.includes?.(
				title
			),
		{ timeout: 20_000, name: `hero showing "${title}"` }
	);
	// Idempotent: only toggle when it is actually closed, so a re-entry does not close it again.
	await phone.evaluate(`(() => {
		const t = document.querySelector(${JSON.stringify(SEL.toolsToggle)});
		if (t && t.getAttribute('aria-expanded') !== 'true') t.click();
	})()`);
	await sleep(400);
	return /** @type {any} */ (await phone.evaluate(STATE_EXPR));
}

// ── the probe ──────────────────────────────────────────────────────────────
/** @type {import('node:child_process').ChildProcess | undefined} */ let server;
/** @type {import('node:child_process').ChildProcess | undefined} */ let worker;
/** @type {import('node:child_process').ChildProcess | undefined} */ let chrome;
/** @type {Browser | undefined} */ let browser;

async function main() {
	mkdirSync(RUN_DIR, { recursive: true });
	const chromium = findChromium();
	if (!chromium) bail('no Chromium found. Set PW_CHROMIUM.');

	/*
	 * `server.ts` serves the BUILT app, so a stale build silently measures yesterday's markup. That is
	 * how this probe first "failed": the build predated GuidingTrack's move onto <Slider>, so
	 * `[data-slot='slider']` was absent and the with-stem arm read as a real defect. An environment
	 * problem must not be reportable as one, hence the check and exit 2. `measured-design.mjs` orders
	 * itself after the build for the same reason.
	 */
	if (!existsSync(join(CORE_DIR, 'build'))) {
		bail('apps/core/build is missing. Run `bun run build` first — this probe drives the BUILT app.');
	}
	const builtNewerThan = (/** @type {string} */ f) => {
		try {
			return statSync(join(CORE_DIR, 'build')).mtimeMs >= statSync(join(CORE_DIR, f)).mtimeMs;
		} catch {
			return true;
		}
	};
	for (const f of ['src/lib/components/GuidingTrack.svelte', 'src/lib/components/ui/slider/slider.svelte']) {
		if (!builtNewerThan(f)) bail(`${f} is newer than apps/core/build. Run \`bun run build\` — this probe drives the BUILT app.`);
	}

	server = await bootServer();
	await apiJoin('ProbeApi');

	// ── two songs, two stem states, one library ──
	worker = await spawnWorker('withVocals');
	const withStem = await cookOne('caroline');
	await kill(worker);

	worker = await spawnWorker('noVocals');
	const noStem = await cookOne('bohemian');
	await kill(worker);

	const wv = (await library()).find((m) => m.id === withStem.id);
	const nv = (await library()).find((m) => m.id === noStem.id);
	console.log(`\nfixture: "${withStem.title}" vocalsRef=${JSON.stringify(wv?.vocalsRef ?? null)}`);
	console.log(`fixture: "${noStem.title}" vocalsRef=${JSON.stringify(nv?.vocalsRef ?? null)}\n`);

	// The whole probe is meaningless if the two fixtures are not actually in different states, and a
	// fixture that silently drifted into one state would otherwise read as a clean pass.
	if (!wv?.vocalsRef) bail(`"${withStem.title}" cooked with NO vocals ref; the with-stem arm has no subject`);
	if (nv?.vocalsRef) bail(`FAKE_NO_VOCALS did not withhold the vocals ref (got ${nv.vocalsRef}); the degraded arm has no subject`);

	chrome = spawnChild(
		chromium,
		[
			`--remote-debugging-port=${CDP_PORT}`,
			'--headless=new',
			'--no-sandbox',
			'--disable-gpu',
			'--no-first-run',
			`--user-data-dir=${join(RUN_DIR, 'chrome')}`,
			// This probe reads DOM structure and state, never whether audio started, so autoplay policy
			// is irrelevant here and granted to keep the hero from parking on a tap-to-start card.
			'--autoplay-policy=no-user-gesture-required',
			'about:blank'
		],
		{ stdio: 'ignore' }
	);
	browser = await waitFor(() => connect(CDP_PORT).catch(() => null), { timeout: 20_000, name: 'CDP' });
	const phone = await browser.newPage();
	await phone.setViewport?.({ width: 390, height: 844 });

	// join in the browser, so the queue op's actor matches the session
	/*
	 * Join IN THE BROWSER, so the queue op's actor is this session's singer.
	 *
	 * The name is written through the native value setter and then an `input` event, not by assigning
	 * `.value`: Svelte's `bind:value` listens for the event, and a bare assignment leaves the binding
	 * holding its old value — the submit control stayed disabled and the probe timed out on a page that
	 * looked filled in. The control itself is found by accessible text rather than position, because the
	 * colour swatches are buttons too and they come first in document order.
	 */
	// #834 replaced the standalone /join route with the landing surface at `/`, which renders the join
	// form while unjoined. Going to the old path would 404 and the probe would time out on a page that
	// never had a name field.
	await phone.goto(`${BASE}/`);
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
	await waitFor(async () => await phone.evaluate(`!!document.querySelector(${JSON.stringify(SEL.hero)})`), {
		timeout: 20_000,
		name: 'joined home'
	});

	const actor = /** @type {string} */ (
		await phone.evaluate(`fetch('/api/me').then((r) => r.json()).then((d) => d?.singer?.id ?? d?.id ?? '')`)
	);
	if (!actor) bail('could not read the joined singer id from the browser session, so a queue op would be rejected');


	// ── ARM 1: a song WITH an isolated stem ──
	await queueAdd(phone, withStem.id, actor);
	await sendPlayer(phone, { cmd: 'play' });
	// COLLAPSED first: the summary says where the controls stand, and the control itself is not on screen.
	const closed = await readCollapsedFor(phone, withStem.title);
	check('the disclosure starts CLOSED, with a summary standing in for the controls', closed.togglePresent && !closed.expanded && !!closed.peekText, JSON.stringify(closed));
	check('the control is not visible while the disclosure is closed (XR-PH-15)', !closed.sliderVisible, JSON.stringify(closed));

	const live = await openToolsFor(phone, withStem.title);
	check('the control lives in the disclosure BODY, never inside its toggle (XR-PH-15)', live.sliderPresent && !live.sliderInsideToggle, JSON.stringify(live));
	check('the hero renders with its tools disclosure open (with-stem arm)', live.heroPresent && live.toolsOpen, JSON.stringify(live));
	check('a song WITH an isolated stem gets a live control (XR-PH-15)', live.sliderPresent && !live.sliderDisabled, JSON.stringify(live));
	check('…and no explanation, because a working control needs none (XR-PH-15)', !live.notePresent && !live.pageTextHasFragment, JSON.stringify(live));

	// ── ARM 2: a song with NO isolated stem ──
	await queueAdd(phone, noStem.id, actor);
	await sendPlayer(phone, { cmd: 'skip' });
	const degraded = await openToolsFor(phone, noStem.title);
	check('the control STAYS on screen, disabled, for a song with no stem (XR-PH-15)', degraded.sliderPresent && degraded.sliderDisabled, JSON.stringify(degraded));
	check("the readout says 'Off' rather than a live-looking number", degraded.readout === 'Off', `readout=${JSON.stringify(degraded.readout)}`);
	check('the reason is on screen and names what still works (XR-PH-15)', degraded.notePresent && /still work/i.test(degraded.noteText ?? ''), JSON.stringify(degraded.noteText));
	check('the reason sits OUTSIDE the subtree the disabled control dims (XR-PH-03)', degraded.gtDimmed && !degraded.noteInsideDimmedSubtree, `gtDimmed=${degraded.gtDimmed} inside=${degraded.noteInsideDimmedSubtree}`);
	check('the sentence is in the disclosure BODY, never the collapsed summary', degraded.noteInBody && !(degraded.peekText ?? '').toLowerCase().includes(NOTE_FRAGMENT), JSON.stringify({ inBody: degraded.noteInBody, peek: degraded.peekText }));
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
		// A browser that already died closes with a throw. The child processes below are killed either
		// way, and failing teardown must not mask the verdict this probe already reported.
	}
	await kill(chrome);
	await kill(worker);
	await kill(server);
}
process.exit(code);
