/*
 * P16 — THE NOW-PLAYING DRAWER'S LIVE CONTROLS, AND THEIR HONEST DEGRADATION (XR-PH-15, XR-PH-03).
 *
 * ── WHAT MOVED, AND WHY THIS FILE CHANGED SHAPE ────────────────────────────────────────────────
 *
 * `NowPlayingHero` is DELETED. Everything it held — song identity, the seek row, the transport and
 * the live controls — is `NowPlayingDrawer.svelte` now: a bottom drawer (shadcn `ui/drawer` over
 * `vaul-svelte`) mounted in `src/routes/+layout.svelte` beside the persistent band and opened by the
 * band's pull handle. Home is the queue and nothing else.
 *
 * THE SHAPE CHANGED, NOT JUST THE ADDRESS, and three of this probe's original claims were about the
 * shape:
 *
 *   • THERE IS NO DISCLOSURE. The hero had a `.tools-toggle` carrying `aria-expanded` and a
 *     `.tools-peek` summary line beside it. The DRAWER is the act of revealing: vaul portals its
 *     content on open and DESTROYS it on close, so there is no attribute to read and no collapsed
 *     summary to keep a sentence out of. `SEL.toolsToggle` and `SEL.toolsPeek` are retired.
 *   • NOTHING HERE CAN BE READ COLD. The drawer is closed by default, so every controls claim now
 *     takes a tap on `SEL.bandExpand` first. A timeout on `.np-drawer` means the drawer is shut, not
 *     that the app is broken.
 *   • THE RANGE SITS DIRECTLY BELOW THE KEY ROW (ratified 2026-09-14), where it used to be behind a
 *     nested "Vocal range" Collapsible inside the hero's controls Collapsible — two disclosures deep
 *     to see a picture that answers "can I sing this?" at a glance.
 *
 * Each replaced claim is marked REPLACES at its `check()` and names what it stood in for, so a
 * guarantee whose MECHANISM died is not silently dropped along with it.
 *
 * ── WHY THE FILENAME STILL SAYS `hero` ─────────────────────────────────────────────────────────
 *
 * Deliberate, and the churn is the reason. This issue's coverage is a PAIR of rungs: this probe and
 * `tests/guards/hygiene/hero-live-controls-835.test.ts`, whose header rules that renaming ONE half
 * "would leave the two halves of one issue under two different names" and that the rename is worth
 * doing as a single sweep. That sweep is: both files, the registration in `tests/e2e/run-probes.mjs`,
 * the `KNOWN_OFFENDERS` key in `tests/guards/hygiene/contract.test.ts`, the row in
 * `tests/e2e/HARNESS.md`, and the prose pointers in `tests/e2e/contract.ts`,
 * `tests/guards/hygiene/phone-home-832.test.ts`, `docs/ux/04-verification.md`,
 * `src/lib/components/ui/slider/slider.svelte` and `src/lib/components/LyricsReselect.svelte`.
 * This change is scoped to the PROBE, so renaming here would produce exactly the split that header
 * argues against while leaving its pointer aimed at a file that still says "hero". `-835` / `p16` are
 * the anchors that keep the pair findable until that sweep happens; `p16-drawer-live-controls.mjs` is
 * the name it should take when it does.
 *
 * ── WHAT IT ASSERTS, AND WHY EACH ONE IS A REAL DEFECT ─────────────────────────────────────────
 *
 * The subject is a song with NO isolated vocals stem. The guiding track cannot work for it, and the
 * honest response is not to hide the control:
 *
 *   - the control STAYS on screen and is disabled, so the singer is not left wondering where it went;
 *   - its readout says "Off" rather than a live-looking number it is not delivering;
 *   - a sentence explains why, and it names what still works, because a reason alone leaves a singer
 *     thinking the whole control group is dead;
 *   - the sentence renders BEFORE the control it explains, and is not dimmed by ANY ancestor
 *     `opacity` (XR-PH-03) — an explanation at 50% alpha is the one element that must stay legible.
 *
 * And the inverse arm: a song WITH a stem gets a live control and NO explanation, because an
 * explanation for a working control is noise.
 *
 * ── THE GESTURE PAIR, WHICH IS THE MOST VALUABLE THING HERE ────────────────────────────────────
 *
 * `NowPlayingDrawer` sets `handleOnly` on its Root, restricting drag-to-dismiss to the handle. That
 * prop exists because the drawer's body is SLIDERS: a drag surface underneath a slider thumb makes
 * the two gestures one gesture, and the drawer wins because it is the ancestor. That is the substance
 * of XR-PH-15, and no source scan can prove a gesture BEHAVES — `handleOnly` also silently does
 * nothing if the vendored drawer stops rendering vaul's real Handle (shadcn ships a decorative div,
 * which is why `drawer-handle.svelte` exists). So this probe drives both halves with a real pointer:
 *
 *   - a drag ON THE SLIDER moves the guiding track and does NOT dismiss the drawer;
 *   - a drag ON THE HANDLE does dismiss it.
 *
 * The slider drag carries a downward component on purpose: a real thumb drag is never perfectly
 * horizontal, and a vertical component is exactly what a drag-anywhere drawer would steal.
 *
 * ── HOW THE DEGRADED STATE IS REACHED ──────────────────────────────────────────────────────────
 *
 * `hasGuidingTrack()` is `isPlayable(m) && !!m.guideMixRef` — a 4-CHANNEL MIX, not the vocals stem.
 * (It was `!!m.vocalsRef` until the two-element guide path was deleted; this header said so for longer
 * than it was true, and that stale sentence is why the enabled arm was pointed at a fixture that could
 * not satisfy it.) So the ENABLED arm needs `FAKE_GUIDE_MIX=1`, and the degraded arm needs a song that
 * processed successfully and reported no vocals ref. `FAKE_NO_VOCALS=1` on the fake stems worker does
 * exactly that, and it is not a fault injection: `worker-hub.ts` optional-chains
 * `artifacts?.stems?.vocals` and its own comment says a worker that could not encode vocals "reports
 * none". So the probe processes TWO songs against one server, restarting the worker between them.
 *
 * ── NON-VACUITY, MEASURED RATHER THAN ASSERTED ─────────────────────────────────────────────────
 *
 * A probe that cannot fail is worse than no probe. The load-bearing arms are broken like this:
 *
 *   - `disabled={false}` on the <Slider> → "the control STAYS on screen, disabled" FAILS, and
 *     `data-disabled` disappears entirely (Bits UI omits the attribute when enabled and emits it as
 *     `data-disabled=""` when disabled, so PRESENCE is the correct test, not the value).
 *   - `class:disabled={false}` on `.gt` → the XR-PH-03 containment arm FAILS, because nothing is
 *     dimmed for the reason to sit outside of.
 *   - dropping `handleOnly` from `Drawer.Root` → "the slider drag does NOT dismiss the drawer" FAILS:
 *     vaul takes the pointer from the slider and the content unmounts mid-drag.
 *   - replacing `ui/drawer`'s Handle with a plain div (shadcn's own shipped shape) → "a drag on the
 *     HANDLE dismisses the drawer" FAILS while every source scan stays green.
 *
 *   EPORT=5216 bun tests/e2e/probes/p16-hero-live-controls.mjs
 *
 * AS OF THIS MIGRATION the drawer arms have NOT been executed against a live server — the authoring
 * environment has no built app to serve. The command above is what exercises them, and it needs
 * `bun run build` plus a Chromium (see the environment bails below).
 *
 * Exit 0 all passed / 1 a real failure / 2 the environment could not host the test.
 */
import { existsSync, mkdirSync, openSync, statSync } from 'node:fs';
import { readFile as readFileP } from 'node:fs/promises';
import { join } from 'node:path';
import { connect, sleep } from '../driver.mjs';
import { SEL } from '../contract.ts';
import { findChromium } from '../lib/chromium.mjs';
import { repoRoot } from '../lib/repo-root.mjs';
import { spawnChild, killChild } from '../lib/child.mjs';


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
		const p = spawnChild('bun', ['run', 'tests/e2e/seed-media.mjs'], { cwd: CORE_DIR, env: { ...process.env, MEDIA_DIR } });
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
	// THE ENABLED ARM NEEDS A GUIDE MIX, not a vocals stem. `hasGuidingTrack` is `!!guideMixRef`, so a
	// song with vocals and no mix is correctly un-guidable and the slider is correctly disabled — which
	// is exactly how this probe's with-stem arm failed the first time it was run against the drawer.
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

// ── the range label, computed INDEPENDENTLY of the app ─────────────────────
/*
 * Three lines rather than an import of `rangeLabel`, deliberately. The claim is "the drawer STATES
 * this song's range", and an oracle that calls the same helper the UI calls would mirror a bug in it
 * instead of catching one. The spelling — scientific pitch names, ASCII ` - ` between them — is
 * pinned in `src/lib/contract/process/song-profile.ts`, and a change to it should red here.
 */
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

/*
 * Every selector this probe reads, handed to the page ONCE as a lookup table.
 *
 * The table exists so no in-page expression spells a selector as a literal: `contract.test.ts` bans
 * that outright, and a `q(S.foo)` indirection keeps every hook coming from `SEL` where the anchor
 * guard can see it move. `S.bandExpand` is the BAND's pull handle (the way IN) and `S.drawerHandle`
 * is vaul's own drag handle on the open drawer (the way OUT) — two controls, two files, and
 * conflating them is how a gesture test ends up dragging the wrong element.
 */
const PRELUDE = `
	const S = {
		drawer: ${JSON.stringify(SEL.npDrawer)},
		song: ${JSON.stringify(SEL.npSong)},
		drawerHandle: ${JSON.stringify(SEL.drawerHandle)},
		body: ${JSON.stringify(SEL.toolsBody)},
		note: ${JSON.stringify(SEL.toolsNote)},
		gt: ${JSON.stringify(SEL.guidingTrackRoot)},
		readout: ${JSON.stringify(SEL.guideReadout)},
		slider: ${JSON.stringify(SEL.slider)},
		keyCap: ${JSON.stringify(SEL.keyBtn)},
		keyLab: ${JSON.stringify(SEL.keyLabel)},
		bandTitle: ${JSON.stringify(SEL.bandTitle)},
		bandExpand: ${JSON.stringify(SEL.bandExpand)}
	};
	const q = (s) => document.querySelector(s);
	const qq = (s) => Array.prototype.slice.call(document.querySelectorAll(s));
	const painted = (el) => !!el && !!el.getClientRects().length;
`;

/**
 * The CLOSED state, read before anything is tapped.
 *
 * `sliderCount` is a count and not a visibility test on purpose: the hero's control was rendered and
 * merely hidden while its Collapsible was shut, so "not visible" was the strongest available claim.
 * vaul portals the drawer's content on open and destroys it on close, so the honest claim is now
 * ABSENCE — a stronger guarantee than the one it replaces.
 */
const CLOSED_EXPR = `(() => {
	${PRELUDE}
	return {
		bandHandlePresent: !!q(S.bandExpand),
		bandTitleText: q(S.bandTitle)?.textContent?.trim() ?? null,
		drawerPresent: !!q(S.drawer),
		sliderCount: qq(S.slider).length,
		bodyCount: qq(S.body).length,
		notePresent: !!q(S.note)
	};
})()`;

/**
 * Read the OPEN drawer's live-controls state out of a real render. ONE evaluate, so every field
 * describes the same paint: a per-field round trip can straddle a re-render and report a mix of two
 * states.
 *
 * `rangeEl` is found by TEXT rather than by a class, because the range block has no `SEL` hook and
 * inventing one here would put a selector outside the contract. The walk is post-order so the
 * DEEPEST element whose own text is exactly the range label wins — that is the label span itself,
 * not the section wrapping it.
 *
 * `noteDimmedByAncestor` is XR-PH-03 measured rather than inferred. The containment field beside it
 * (`noteInsideDimmedSubtree`) is the ORIGINAL form of that claim and is kept because `class:disabled`
 * on `.gt` is still the anchor the contract pins; but GuidingTrack's `opacity: 0.5` moved onto the
 * control leaf, so containment alone no longer proves nothing dims the sentence. This walks every
 * ancestor and reports the first one that paints below full alpha.
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
			pageTextHasFragment: (document.body.textContent ?? '').toLowerCase().includes(FRAGMENT)
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
 * Open the drawer from the band's pull handle, and wait for the song it is supposed to be about.
 *
 * IDEMPOTENT and gated on the drawer being shut: while it is open, vaul's overlay covers the band, so
 * a second tap would be a click on a scrim rather than on the handle.
 * @param {Page} phone @param {string} title
 */
async function openDrawerFor(phone, title) {
	await waitForBandTitle(phone, title);
	const open = await phone.evaluate(`!!document.querySelector(${JSON.stringify(SEL.npDrawer)})`);
	if (!open) await phone.click(SEL.bandExpand);
	await waitFor(async () => await phone.evaluate(`!!document.querySelector(${JSON.stringify(SEL.npDrawer)})`), {
		timeout: 10_000,
		name: 'the now-playing drawer to open'
	});
	await waitFor(
		async () =>
			(await phone.evaluate(`document.querySelector(${JSON.stringify(SEL.npSong)})?.textContent ?? ''`))?.includes?.(
				title
			),
		{ timeout: 15_000, name: `the drawer showing "${title}"` }
	);
	// One frame for vaul's open transition to settle before anything is measured or dragged.
	await sleep(400);
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

// ── the probe ──────────────────────────────────────────────────────────────
/** @type {import('node:child_process').ChildProcess | undefined} */ let server;
/** @type {import('node:child_process').ChildProcess | undefined} */ let worker;
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
		bail('build is missing. Run `bun run build` first — this probe drives the BUILT app.');
	}
	const builtNewerThan = (/** @type {string} */ f) => {
		try {
			return statSync(join(CORE_DIR, 'build')).mtimeMs >= statSync(join(CORE_DIR, f)).mtimeMs;
		} catch {
			return true;
		}
	};
	/*
	 * The five files this probe's claims are made of. The drawer, its mount and the band joined the
	 * list with the hero's deletion: the controls are only reachable because the LAYOUT mounts the
	 * drawer and hands the band an `onexpand`, so a build predating either one fails the gesture arms
	 * for an environment reason that must not be reported as a defect.
	 */
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

	// ── two songs, two stem states, one library ──
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
	if (nv?.vocalsRef) bail(`FAKE_NO_VOCALS did not withhold the vocals ref (got ${nv.vocalsRef}); the degraded arm has no subject`);
	/*
	 * AND THE MIX, which is the ref the guide gate actually reads. Bailed on separately from vocalsRef
	 * rather than folded into it, because the two came apart: the guide used to be played from the vocals
	 * stem in a second media element, that path was deleted (two decoders cannot be sample-locked from
	 * script — `guide-level.ts`), and `hasGuidingTrack` became `!!guideMixRef`. A probe that keeps
	 * checking only the vocals ref would report a healthy fixture while the enabled arm has no subject,
	 * which is precisely what happened here.
	 */
	if (!wv?.guideMixRef)
		bail(`"${withStem.title}" processed with NO guide mix ref; the ENABLED arm has no subject (FAKE_GUIDE_MIX=1?)`);
	if (nv?.guideMixRef) bail(`the degraded fixture got a guide mix (${nv.guideMixRef}); its arm has no subject`);

	/*
	 * The range claim needs a fixture that HAS a range, and the fake worker publishes one
	 * (p05Midi/p95Midi) unless FAKE_NO_PROFILE is set — so a missing range here is an environment
	 * fault, not a defect in the drawer. Bailing keeps it out of the verdict, the same way the two
	 * stem-state bails above do.
	 */
	const expectedRange = expectedRangeLabel(wv?.songProfile);
	if (!expectedRange) {
		bail(
			`"${withStem.title}" reported no vocal range (songProfile=${JSON.stringify(wv?.songProfile ?? null)}), so the range claim has no subject`
		);
	}
	console.log(`fixture: expected range label ${JSON.stringify(expectedRange)}\n`);


	// `waitFor` reports `unknown`, so the cast is where the browser handle gets its type. Held in a
	// local as well as the module-level `browser` (which teardown needs) so the pages below are reached
	// through a value TypeScript knows is defined.
	const b = /** @type {Browser} */ (await waitFor(() => connect().catch(() => null), { timeout: 20_000, name: 'CDP' }));
	browser = b;
	const phone = await b.newPage();
	// A phone in a hand, and the driver's own method rather than a `setViewport?.()` that silently
	// resolved to undefined — the drawer and the band are thumb-zone chrome, so the width is not
	// incidental to what is being measured.
	await phone.viewport(390, 844);

	/*
	 * Join IN THE BROWSER, so the queue op's actor is this session's singer.
	 *
	 * The name is written through the native value setter and then an `input` event, not by assigning
	 * `.value`: Svelte's `bind:value` listens for the event, and a bare assignment leaves the binding
	 * holding its old value — the submit control stayed disabled and the probe timed out on a page that
	 * looked filled in. The control itself is found by accessible text rather than position, because the
	 * colour swatches are buttons too and they come first in document order.
	 *
	 * An earlier change replaced the standalone /join route with the landing surface at `/`, which
	 * renders the join form while unjoined. Going to the old path would 404 and the probe would time
	 * out on a page that never had a name field.
	 */
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
	/*
	 * The joined signal is the BAND, not the hero. `SEL.homeReady` is `.band`, which the layout mounts
	 * on exactly the condition this wait is really asking about (`isPhoneSurface && me !== null`), so it
	 * answers "this singer is joined" with no gesture — where the hero used to answer it by being the
	 * top of home.
	 */
	await waitFor(async () => await phone.evaluate(`!!document.querySelector(${JSON.stringify(SEL.homeReady)})`), {
		timeout: 20_000,
		name: 'the joined phone (the now-playing band)'
	});

	const actor = /** @type {string} */ (
		await phone.evaluate(`fetch('/api/me').then((r) => r.json()).then((d) => d?.singer?.id ?? d?.id ?? '')`)
	);
	if (!actor) bail('could not read the joined singer id from the browser session, so a queue op would be rejected');


	// ── ARM 1: a song WITH an isolated stem ──
	await queueAdd(phone, withStem.id, actor);
	await sendPlayer(phone, { cmd: 'play' });
	await waitForBandTitle(phone, withStem.title);

	// SHUT first. REPLACES 'the disclosure starts CLOSED, with a summary standing in for the controls'
	// and 'the control is not visible while the disclosure is closed': there is no toggle to read an
	// `aria-expanded` off and no `.tools-peek` summary. What carries the same user-visible promise —
	// the controls are not occupying the screen until asked for, and something still says what is
	// playing — is the band: it offers the pull handle, states the song permanently, and the drawer is
	// not rendered at all.
	const closed = /** @type {any} */ (await phone.evaluate(CLOSED_EXPR));
	check(
		'the controls start away: the band offers a pull handle and no drawer is rendered',
		closed.bandHandlePresent && !closed.drawerPresent && closed.bodyCount === 0,
		JSON.stringify(closed)
	);
	check(
		'the band states what is playing while the controls are away (REPLACES the collapsed peek summary)',
		typeof closed.bandTitleText === 'string' && closed.bandTitleText.includes(withStem.title),
		JSON.stringify(closed.bandTitleText)
	);
	check(
		'no control exists on the page while the drawer is shut (XR-PH-15)',
		closed.sliderCount === 0 && !closed.notePresent,
		JSON.stringify(closed)
	);

	await openDrawerFor(phone, withStem.title);
	const live = /** @type {any} */ (await phone.evaluate(stateExpr(expectedRange)));

	// REPLACES 'the hero renders with its tools disclosure open': the drawer's PRESENCE is the open
	// state — vaul portals the content on open and destroys it on close, so there is no attribute.
	check(
		"the band's pull handle opens the drawer, and the live-controls body is in it",
		live.drawerPresent && live.bodyPresent && live.dragHandlePresent,
		JSON.stringify(live)
	);
	// REPLACES 'the control lives in the disclosure BODY, never inside its toggle'. Same XR-PH-15
	// substance, new drag surface: the control must be in the body and NOT inside vaul's handle, which
	// `handleOnly` makes the drawer's only draggable element.
	check(
		'the control is in the drawer BODY, never on the drag handle (XR-PH-15)',
		live.sliderPresent && live.sliderInBody && !live.sliderOnDragHandle,
		JSON.stringify(live)
	);
	check(
		'a song WITH an isolated stem gets a live control (XR-PH-15)',
		live.sliderPresent && live.sliderPainted && !live.sliderDisabled,
		JSON.stringify(live)
	);
	check(
		'…and no explanation, because a working control needs none (XR-PH-15)',
		!live.notePresent && !live.pageTextHasFragment,
		JSON.stringify(live)
	);
	// The range, in the SAME reveal as the key row. REPLACES nothing that existed — it is the claim the
	// retired nested "Vocal range" Collapsible used to defeat: one level of revealing (the drawer), not
	// two. Read at keyShift 0, before the key row below is driven, because the label transposes with it.
	check(
		'the vocal range is shown in the same reveal as the key row, with nothing further to open',
		live.rangeShown && live.rangeBelowKeyRow,
		`expected ${JSON.stringify(expectedRange)} — shown=${live.rangeShown} belowKeyRow=${live.rangeBelowKeyRow}`
	);
	check(
		'the key row is present and live for a playable song',
		live.keyCapCount === 2 && live.keyCapsLive && live.keyLabelText === 'Key',
		JSON.stringify({ caps: live.keyCapCount, live: live.keyCapsLive, label: live.keyLabelText })
	);

	/*
	 * …and it WORKS: a keycap moves the room's key and the label follows the server's broadcast.
	 * Clicked in-page rather than through a real pointer for the reason p3-key-shift gives — the
	 * keycap's glyph is a small inline SVG and hit-testing it adds nothing here. p3 owns the pitch
	 * semantics end to end; this arm only claims the row is wired where it now lives.
	 */
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

	// ── THE GESTURE PAIR: handleOnly, driven ──
	/*
	 * A real pointer drag across the slider, with a downward component. Two claims come out of one
	 * gesture: the slider ANSWERS it (so the drawer is not swallowing the pointer), and the drawer
	 * SURVIVES it (so `handleOnly` is in force). Dragging away from wherever the level currently sits,
	 * so the assertion cannot pass on a level that never moved.
	 */
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
		'a pointer drag ON THE SLIDER moves the guiding track (XR-PH-15)',
		guideAfter !== null && Math.abs(guideAfter - guideBefore) >= 10,
		`readout ${guideBefore}% → ${guideAfter === null ? 'unreadable' : `${guideAfter}%`} across ${Math.round(sliderBox.w)}px of track`
	);
	const afterSliderDrag = /** @type {any} */ (await phone.evaluate(stateExpr(expectedRange)));
	check(
		'…and that drag does NOT dismiss the drawer — handleOnly is in force (XR-PH-15)',
		afterSliderDrag.drawerPresent && afterSliderDrag.sliderPresent && afterSliderDrag.bodyPresent,
		JSON.stringify(afterSliderDrag)
	);

	/*
	 * The other half, and the reason the first half is not just a slider test: dragging the HANDLE must
	 * still dismiss. A `handleOnly` drawer whose vendored Handle lost vaul's `data-slot` is undraggable
	 * ENTIRELY and nothing warns — shadcn's own copy-in ships a decorative div, which is what
	 * `drawer-handle.svelte` exists to correct.
	 */
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

	// ── ARM 2: a song with NO isolated stem ──
	// The drawer was just dragged shut, so this arm also proves it re-opens after a dismissal.
	await queueAdd(phone, noStem.id, actor);
	await sendPlayer(phone, { cmd: 'skip' });
	await openDrawerFor(phone, noStem.title);
	const degraded = /** @type {any} */ (await phone.evaluate(stateExpr(expectedRange)));

	check(
		'the control STAYS on screen, disabled, for a song with no stem (XR-PH-15)',
		degraded.sliderPresent && degraded.sliderPainted && degraded.sliderDisabled,
		JSON.stringify(degraded)
	);
	check(
		"the readout says 'Off' rather than a live-looking number",
		degraded.readout === 'Off',
		`readout=${JSON.stringify(degraded.readout)}`
	);
	check(
		'the reason is on screen and names what still works (XR-PH-15)',
		degraded.notePresent && /still work/i.test(degraded.noteText ?? ''),
		JSON.stringify(degraded.noteText)
	);
	// REPLACES 'the sentence is in the disclosure BODY, never the collapsed summary'. There is no
	// summary to keep it out of; what survives whole is the reason being read BEFORE the dead row
	// rather than after it, and living with the controls rather than in the drawer's header.
	check(
		'the reason renders BEFORE the control it explains, inside the controls body',
		degraded.noteInBody && degraded.noteBeforeControl,
		JSON.stringify({ inBody: degraded.noteInBody, beforeControl: degraded.noteBeforeControl })
	);
	// XR-PH-03, both forms: the original containment claim (the anchor the contract pins is
	// `class:disabled` on `.gt`), plus the measured one — no ancestor of the sentence paints below full
	// alpha. The second is what still holds now that the dimming moved onto the control leaf.
	check(
		'the reason sits OUTSIDE the subtree the disabled control marks (XR-PH-03)',
		degraded.gtDimmed && !degraded.noteInsideDimmedSubtree,
		`gtDimmed=${degraded.gtDimmed} inside=${degraded.noteInsideDimmedSubtree}`
	);
	/*
	 * The measured half of XR-PH-03, with one re-read. vaul animates its content in, and an ancestor
	 * caught mid-transition can report below full alpha for a frame or two — a probe that calls THAT a
	 * dimmed explanation is crying wolf about an animation. So a dim ancestor is only believed once it
	 * survives a settle; a real `opacity` rule does, a transition does not.
	 */
	let dimmedBy = degraded.noteDimmedByAncestor;
	if (dimmedBy !== null) {
		await sleep(800);
		dimmedBy = /** @type {any} */ (await phone.evaluate(stateExpr(expectedRange))).noteDimmedByAncestor;
	}
	check(
		'…and no ancestor dims the reason with opacity (XR-PH-03, measured)',
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
		// A browser that already died closes with a throw. The child processes below are killed either
		// way, and failing teardown must not mask the verdict this probe already reported.
	}
	await killChild(worker);
	await killChild(server);
}
process.exit(code);
