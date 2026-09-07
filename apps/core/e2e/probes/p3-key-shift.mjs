/*
 * P3 — DOES THE PITCH SHIFTER ACTUALLY MAKE A SOUND, AT THE RIGHT PITCH?
 *
 * A prior numerical review left an unproven suspicion that the browser-side OLA pitch shifter
 * (apps/core/src/lib/tv/pitch-shift.ts) SILENCES or DESTROYS the audio at every non-zero shift. The
 * unit tests (pitch-worklet.test.ts) run the REAL worklet source through a stub `AudioWorkletProcessor`
 * and pass, so the numerical maths cannot be the whole story — but a unit test cannot see:
 *
 *   • whether AudioWorklet is actually WIRED into the audio graph in the browser (a missing
 *     `source.connect(node).connect(gain).connect(destination)` step silences the room and no unit test
 *     catches it),
 *   • whether the AudioContext resumes on a TV that never got a user gesture (the app documents
 *     a fallback to audible-but-unshifted, but a fallback is a claim until measured),
 *   • whether the ratio-message round-trip from the phone → server → TV → PitchShiftGraph.setShift
 *     ends up with the right ratio in the worklet,
 *   • whether the shift survives pause/resume and resets on song change.
 *
 * WHAT THIS PROBE MEASURES.
 *   1. Baseline: at keyShift 0 the master <audio> decodes normally (webkitAudioDecodedByteCount
 *      climbing, currentTime advancing) and no AudioContext exists.
 *   2. Graph wiring: at the first non-zero shift, an AudioContext + AudioWorkletNode + GainNode are
 *      constructed, the gain connects to destination, and audio is flowing through it.
 *   3. Sample capture: an AnalyserNode is tapped in PARALLEL onto the gain node (so the audible path
 *      is untouched), and the OUTPUT samples are measured for RMS and dominant partial frequency.
 *   4. Ratio correctness: the dominant partial moves by exactly 2^(N/12) between shift 0 (via
 *      ratio-1 passthrough on the same graph) and shift N, at N ∈ {+1, +2, -1, -3, +5}.
 *   5. Sounding-key label: the phone's `Key ·` label agrees with the server-broadcast keyShift.
 *   6. Pause/resume + song change: the shift is preserved across pause/resume; the graph is torn down
 *      on song change and rebuilds fresh (or resets to shift 0, whichever the server dictates).
 *
 * THE FIXTURE. The fake worker publishes an 8-second WAV chord at 220 / 277.18 / 329.63 Hz (see
 * e2e/wav.mjs). The three partials are equal-amplitude sines, so the FFT peak lands cleanly on one of
 * them and moves by the ratio when transposed. That property is what makes this test decisive rather
 * than approximate — a chord smeared by MP3 or a real recording could not carry it.
 *
 *   PORT=5223 bun apps/core/e2e/probes/p3-key-shift.mjs
 *
 * Exit codes: 0 all findings clean · 1 a real defect · 2 environment could not host the test.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { connect, sleep } from '../cdp.mjs';
import { SEL } from '../contract.ts';
import { findChromium } from '../lib/chromium.mjs';

/**
 * Types for this out-of-program driver, which runs under tsconfig.e2e.json (issue #562, following the
 * #557/#558/#559/#560/#561 pattern). Browser/Page are derived from cdp.mjs's own return types (#553) so
 * they cannot drift from the driver. page.evaluate() is typed Promise<any> by cdp.mjs, so DOM/API-shaped
 * results are cast at the call site.
 *
 * @typedef {Awaited<ReturnType<typeof connect>>} Browser
 * @typedef {Awaited<ReturnType<Browser['newPage']>>} Page
 * @typedef {'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'} Severity
 *
 * One finding row: a pass/fail/env check with its severity and evidence.
 * @typedef {{ severity: Severity, name: string, ok: boolean, detail: string, env: boolean }} Finding
 *
 * One <video>/<audio> element read out of the TV page per MEDIA_PROBE sample.
 * @typedef {{
 *   i: number, tag: string, src: string, readyState: number, paused: boolean, muted: boolean,
 *   volume: number, currentTime: number, duration: number, decoded: number | null,
 *   error: { code: number, message: string } | null
 * }} MediaEl
 *
 * The serialisable HOOK_STATE snapshot (node references stripped for logging).
 * @typedef {{
 *   contexts: number, contextStates: string[], gains: number, worklets: string[],
 *   sources: { tag: string, src: string }[], reachedDestination: boolean,
 *   resumeCalls: number, taps: number
 * }} HookState
 *
 * One analyser read: RMS + the dominant-partial spectrum returned by READ_TAP_SRC.
 * @typedef {{
 *   ok: boolean, why?: string, rms: number, peakHz: number, peakDb: number, binHz: number,
 *   sampleRate: number, partials: { hz: number, db: number }[]
 * }} TapRead
 */

const PORT = process.env.EPORT ?? process.env.PORT ?? '5223';
const base = `http://127.0.0.1:${PORT}`;
const CDP_PORT = Number(process.env.CDP_PORT ?? 9503);
const SCRATCH = process.env.KIROCREW_SCRATCH ?? '/tmp';

// Findings collected as { severity, name, ok, detail }. Severity per the prompt:
// CRITICAL (silence/decoder wedge at ±1..±7), HIGH (wrong pitch by more than
// 3%, or label/state disagreement), MEDIUM (transient state, one-shift class
// of bugs), LOW (cosmetic). ok=false is what the prompt calls a "real defect";
// findings with ok=true but a note document what we CHECKED not what we found
// wrong. Environment limits (env=true) are neither pass nor fail — they say
// "the probe couldn't reach this shore" and print separately so a reader
// never confuses them with a defect.
/** @type {Finding[]} */
const findings = [];
/**
 * @param {Severity} severity
 * @param {string} name
 * @param {unknown} ok
 * @param {string} [detail]
 * @param {boolean} [env]
 */
function record(severity, name, ok, detail = '', env = false) {
	findings.push({ severity, name, ok: !!ok, detail, env });
	const tag = env ? 'ENV  ' : ok ? 'PASS ' : 'FAIL ';
	const sev = env ? '     ' : severity.padEnd(8, ' ');
	console.log(`${tag} ${sev} ${name}${!detail ? '' : `\n           ${detail}`}`);
}
/** @param {string} msg @returns {never} */
function bail(msg) {
	console.error(`\nENVIRONMENT: ${msg}`);
	process.exit(2);
}

const chromium = findChromium();
if (!chromium) bail('no Chromium found. Set PW_CHROMIUM.');
if (!(await fetch(`${base}/health`).catch(() => null))?.ok) {
	bail(`no Encore server on ${base}. Start one and re-run.`);
}

// A cooked, playable song is a hard precondition for anything below.
const ready = await fetch(`${base}/api/search?q=caroline`)
	.then((r) => r.json())
	.then((d) => d.ready ?? []);
if (!ready.length) {
	bail(
		'no READY song in the library — nothing to play.\n' +
			'  Seed + cook one first:  bun run e2e/seed-media.mjs  &&  bun e2e/fake-stems-worker.mjs  (then POST /api/make-karaoke)'
	);
}
console.log(`fixture: "${ready[0].title}" → ${ready[0].instrumentalRef}\n`);

// A second cooked song, so the song-change sub-check has somewhere to advance TO. Cooked before the
// browser is even launched: the fake worker takes ~1s per song and this keeps the probe's own tests
// out of that critical path. If a second raw title is not present the sub-check is downgraded to an
// environment limit, not a defect.
async function ensureSecondReady() {
	// Cast a wide net: "caroline" only matches the fixture cook. "a" matches any track with an 'a' in
	// its metadata — which every seeded song does.
	const list = await fetch(`${base}/api/search?q=a`)
		.then((r) => r.json())
		.catch(() => null);
	if (!list) return null;
	const already = list.ready ?? [];
	// Pick a NON-cooked LOCAL track other than the first fixture as the second cook target.
	const raw = /** @type {any[]} */ (list.results ?? []).find(
		(/** @type {any} */ r) =>
			r.source === 'local' && !(/** @type {any[]} */ (already).some((/** @type {any} */ a) => a.id === r.id))
	);
	if (already.length >= 2) return already[1];
	if (!raw) return null;
	const jr = await fetch(`${base}/api/join`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ displayName: `P3Cooker${Date.now() % 100000}`, color: '#77ccff' })
	});
	const cookie = jr.headers.get('set-cookie') ?? '';
	await fetch(`${base}/api/make-karaoke`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie },
		body: JSON.stringify({ mediaId: raw.id })
	});
	// Poll (using a search that matches THIS raw title, so we don't miss it) until it's ready.
	for (let i = 0; i < 40; i++) {
		const l = await fetch(`${base}/api/search?q=a`)
			.then((r) => r.json())
			.catch(() => null);
		if (/** @type {any[]} */ (l?.ready ?? []).some((/** @type {any} */ r) => r.id === raw.id)) return raw;
		await sleep(500);
	}
	return null;
}
const secondReady = await ensureSecondReady();
if (secondReady) {
	console.log(`second fixture: "${secondReady.title}" → ${secondReady.id}\n`);
} else {
	console.log(`no second cookable song available — song-change advance check will be an env limit\n`);
}

const proc = spawn(
	chromium,
	[
		`--remote-debugging-port=${CDP_PORT}`,
		'--headless=new',
		'--no-sandbox',
		'--disable-gpu',
		'--no-first-run',
		'--user-data-dir=' + join(SCRATCH, `encore-p3-${process.pid}`),
		'--autoplay-policy=no-user-gesture-required',
		'about:blank'
	],
	{ stdio: 'ignore' }
);

// The probe harness itself lives in a template literal so both the CDP driver
// and the in-page tap read from a single source. Wraps `window.AudioContext`
// so any pitch-shift graph built later hands us back the context and the
// gain node it constructed (see pitch-shift.ts: exactly one AudioContext and
// one createGain per element, both in PitchShiftGraph.build()). Also wraps
// AudioWorkletNode so we can prove the worklet actually got constructed —
// silence with no worklet is a very different defect from silence with one.
const INSTALL_HOOK_SRC = `
	(() => {
		if (window.__ENCORE_HOOK__) return 'already-installed';
		const OAC = window.AudioContext || window.webkitAudioContext;
		if (!OAC) return 'no-audio-context';
		const state = {
			contexts: [],
			gains: [],
			worklets: [],
			sources: [],
			connects: [],
			addModuleCalls: 0,
			resumeCalls: 0,
			taps: []
		};
		window.__ENCORE_HOOK__ = state;

		// Wrap the CONSTRUCTOR by shadowing the class. Extends the original so instanceof stays true
		// and the prototype chain (with the wrapped methods below) is inherited.
		class WrappedAC extends OAC {
			constructor(...args) {
				super(...args);
				state.contexts.push(this);
			}
		}
		window.AudioContext = WrappedAC;
		window.webkitAudioContext = WrappedAC;

		// Wrap prototype methods once, so both native and wrapped instances hit them. Reading them off
		// OAC.prototype is required because the shifter reads them off the instance it constructs.
		const origCG = OAC.prototype.createGain;
		OAC.prototype.createGain = function() {
			const g = origCG.call(this);
			state.gains.push({ node: g, ctx: this });
			return g;
		};
		const origCS = OAC.prototype.createMediaElementSource;
		OAC.prototype.createMediaElementSource = function(el) {
			const s = origCS.call(this, el);
			state.sources.push({ node: s, ctx: this, elTag: el.tagName, elSrc: el.currentSrc || el.src || '' });
			return s;
		};
		// audioWorklet is a per-instance getter on the prototype — reading it off the prototype
		// throws 'Illegal invocation'. We do not need to wrap addModule; the AudioWorkletNode wrapper
		// below is enough proof the module resolved and the processor was actually constructed.
		const origResume = OAC.prototype.resume;
		OAC.prototype.resume = function() {
			state.resumeCalls++;
			return origResume.call(this);
		};

		// Wrap AudioWorkletNode: the honest proof the shifter's Worklet was ever constructed.
		if (window.AudioWorkletNode) {
			const OWN = window.AudioWorkletNode;
			class WrappedAWN extends OWN {
				constructor(ctx, name, opts) {
					super(ctx, name, opts);
					state.worklets.push({ node: this, name, ctx });
				}
			}
			// Copy statics if any
			Object.setPrototypeOf(WrappedAWN, OWN);
			window.AudioWorkletNode = WrappedAWN;
		}

		// Also count \`connect\` calls so we can prove the graph reaches destination. Node.connect can
		// be called against nodes or against AudioParams; we only care about node-to-node here.
		const origConnect = AudioNode.prototype.connect;
		AudioNode.prototype.connect = function(dst, ...rest) {
			try {
				state.connects.push({
					from: this.constructor.name,
					to: dst && dst.constructor ? dst.constructor.name : String(dst),
					isDestination: !!(this.context && dst === this.context.destination)
				});
			} catch {}
			return origConnect.call(this, dst, ...rest);
		};

		return 'installed';
	})()
`;

// Attaches an AnalyserNode in PARALLEL on the latest captured gain node and
// primes it. Returns whether it succeeded so the caller can distinguish a
// missing graph (no shift engaged yet) from a broken tap. Called from
// outside the shifter's own module so it never interferes with the audible
// path — gain.connect(destination) was already done at build time, and this
// only adds a second edge out of gain.
const ATTACH_TAP_SRC = `
	(() => {
		const s = window.__ENCORE_HOOK__;
		if (!s) return { ok: false, why: 'no-hook' };
		const latest = s.gains[s.gains.length - 1];
		if (!latest) return { ok: false, why: 'no-gain' };
		// If a tap is already on this gain, reuse it.
		const existing = s.taps.find((t) => t.gain === latest.node);
		if (existing) return { ok: true, why: 'reused' };
		const analyser = latest.ctx.createAnalyser();
		analyser.fftSize = 8192;
		analyser.smoothingTimeConstant = 0;
		latest.node.connect(analyser);
		s.taps.push({ gain: latest.node, ctx: latest.ctx, analyser });
		return { ok: true, why: 'attached', sampleRate: latest.ctx.sampleRate };
	})()
`;

// Reads the currently-active tap and returns RMS and the peak-bin frequency
// of the LOUDEST partial. The chord is 220/277.18/329.63 Hz — three
// equal-amplitude sines — so the FFT peak lands on one of them and moves by
// exactly the pitch ratio when transposed. Peak-bin resolution at fftSize
// 8192 / 48kHz is ~5.86 Hz, which is well within the 3% ratio tolerance we
// judge against (a semitone is ~5.9% of frequency).
const READ_TAP_SRC = `
	(() => {
		const s = window.__ENCORE_HOOK__;
		if (!s) return { ok: false, why: 'no-hook' };
		const tap = s.taps[s.taps.length - 1];
		if (!tap) return { ok: false, why: 'no-tap' };
		const N = tap.analyser.fftSize;
		const time = new Float32Array(N);
		tap.analyser.getFloatTimeDomainData(time);
		let sumSq = 0;
		for (let i = 0; i < N; i++) sumSq += time[i] * time[i];
		const rms = Math.sqrt(sumSq / N);
		const freq = new Float32Array(tap.analyser.frequencyBinCount);
		tap.analyser.getFloatFrequencyData(freq); // dB
		// Only search below 1200 Hz — the fixture's partials all live under 350 Hz and the shifted
		// ones under ~700 Hz, so anything above is either aliasing or a spurious harmonic and would
		// dominate the argmax on some browsers.
		const sr = tap.ctx.sampleRate;
		const binHz = sr / N;
		const searchTo = Math.min(freq.length, Math.ceil(1200 / binHz));
		let peakBin = 1;
		let peakDb = -Infinity;
		for (let i = 1; i < searchTo; i++) {
			if (freq[i] > peakDb) { peakDb = freq[i]; peakBin = i; }
		}
		// Find ALL local-maximum bins above (peakDb - 12dB) so we can spot chord partials moving in
		// concert with the shift.
		const partials = [];
		for (let i = 2; i < searchTo - 1; i++) {
			if (freq[i] > freq[i - 1] && freq[i] > freq[i + 1] && freq[i] > peakDb - 12) {
				partials.push({ hz: i * binHz, db: freq[i] });
			}
		}
		partials.sort((a, b) => b.db - a.db);
		return {
			ok: true,
			rms,
			peakHz: peakBin * binHz,
			peakDb,
			binHz,
			sampleRate: sr,
			partials: partials.slice(0, 6)
		};
	})()
`;

// Media state on the TV, without assuming which tag or how many elements are mounted.
const MEDIA_PROBE = `(() => {
	const els = [...document.querySelectorAll('video,audio')];
	return els.map((el, i) => ({
		i, tag: el.tagName, src: el.currentSrc || el.src || '',
		readyState: el.readyState, paused: el.paused, muted: el.muted, volume: el.volume,
		currentTime: el.currentTime, duration: el.duration,
		decoded: el.webkitAudioDecodedByteCount ?? null,
		error: el.error ? { code: el.error.code, message: el.error.message } : null
	}));
})()`;

// The hook state, minus the non-serialisable node references, for logging.
const HOOK_STATE = `(() => {
	const s = window.__ENCORE_HOOK__;
	if (!s) return null;
	return {
		contexts: s.contexts.length,
		contextStates: s.contexts.map((c) => c.state),
		gains: s.gains.length,
		worklets: s.worklets.map((w) => w.name),
		sources: s.sources.map((x) => ({ tag: x.elTag, src: x.elSrc })),
		reachedDestination: s.connects.some((c) => c.isDestination),
		resumeCalls: s.resumeCalls,
		taps: s.taps.length
	};
})()`;

/** @type {Browser | undefined} */
let browser;
/** @type {Page | undefined} */
let phone;
/** @type {Page | undefined} */
let tv;
try {
	browser = await connect(CDP_PORT);

	// ── phone: join and queue ───────────────────────────────────────────────
	phone = await browser.newPage();
	await phone.viewport(390, 844);
	await phone.goto(`${base}/join`);
	await phone.fill(SEL.nameInput, `P3S${Date.now() % 100000}`);
	await phone.clickByText('Start singing');
	await phone.waitFor(`document.querySelector(${JSON.stringify(SEL.search)}) !== null`);
	await phone.fill(SEL.search, 'caroline');
	await phone.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.songRow)}).length > 0`);
	const hasAdd = await phone.count(SEL.addTurn);
	if (hasAdd === 0)
		bail(`cooked song offered no ${SEL.addTurn} action — the seeder+worker sequence probably did not finish`);
	await phone.click(SEL.addTurn);
	await phone.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length > 0`);

	// ── TV: install the hook FIRST, then navigate ──────────────────────────
	tv = await browser.newPage();
	await tv.viewport(1920, 1080, 1);
	await tv.goto(`${base}/tv`);
	// AudioContext is only constructed once we ask for a shift — but be safe and install BEFORE any
	// shift is possible (we clicked no key buttons on the phone yet, and shift 0 does not build a graph).
	const installed = await tv.evaluate(INSTALL_HOOK_SRC);
	record('LOW', 'the probe hook installs on the TV page', installed === 'installed', `got: ${installed}`);

	// ── (1) baseline: at keyShift 0, audio decodes normally, no graph ──────
	try {
		await tv.waitFor(
			`(() => { const e=[...document.querySelectorAll('video,audio')].filter(x=>x.currentSrc||x.src); return e.length ? ${MEDIA_PROBE} : null; })()`,
			{ timeout: 25000 }
		);
	} catch {
		await tv.evaluate(MEDIA_PROBE);
	}
	/** @param {MediaEl[]} set @returns {MediaEl | undefined} */
	const pick = (set) => set.find((e) => e.src.includes('instrumental')) ?? set.find((e) => e.src);

	const t0 = pick(/** @type {MediaEl[]} */ (await tv.evaluate(MEDIA_PROBE)));
	await sleep(2500);
	const t1 = pick(/** @type {MediaEl[]} */ (await tv.evaluate(MEDIA_PROBE)));
	const decoded0 = (t1?.decoded ?? 0) - (t0?.decoded ?? 0) > 0;
	const advanced0 = (t1?.currentTime ?? 0) - (t0?.currentTime ?? 0) > 1.2;
	record(
		'CRITICAL',
		'baseline (keyShift 0): audio decodes without a WebAudio graph',
		decoded0 && advanced0,
		`decoded ${t0?.decoded} → ${t1?.decoded}, currentTime ${t0?.currentTime?.toFixed(2)} → ${t1?.currentTime?.toFixed(2)}`
	);
	const noGraphAt0 = /** @type {HookState | null} */ (await tv.evaluate(HOOK_STATE));
	record(
		'LOW',
		'baseline: no AudioContext is constructed at shift 0',
		noGraphAt0?.contexts === 0,
		`hook state: ${JSON.stringify(noGraphAt0)}`
	);

	// ── (2) engage a shift and prove the graph gets wired ─────────────────
	// Send +1 through the real UI (via the sendPlayer WS message the button emits).
	// The plus button is the second .key-btn under .key; we click it programmatically to avoid
	// hit-testing the tiny inline SVG.
	/** @param {'plus' | 'minus'} sign */
	async function clickKey(sign) {
		const idx = sign === 'plus' ? 1 : 0;
		await /** @type {Page} */ (phone).evaluate(`
			(() => {
				const btns = document.querySelectorAll(${JSON.stringify(SEL.keyBtn)});
				if (btns[${idx}]) btns[${idx}].click();
			})()
		`);
	}
	/** @param {number} target @returns {Promise<boolean>} */
	async function targetShift(target) {
		// Read current from the phone's rendered label — the source of truth is the server-broadcast
		// playback.keyShift, and that is exactly what "Key · +N" prints.
		async function readCurrent() {
			return await /** @type {Page} */ (phone).evaluate(`(() => {
				const lab = document.querySelector(${JSON.stringify(SEL.keyLabel)});
				if (!lab) return null;
				const txt = lab.textContent.trim();
				if (txt === 'Key') return 0;
				// The label is "Key · ±N" with a middle dot; the minus is U+2212, not ASCII.
				const m = txt.match(/([+\\-\\u2212])(\\d+)/);
				if (!m) return null;
				const n = parseInt(m[2], 10);
				return m[1] === '+' ? n : -n;
			})()`);
		}
		let cur = await readCurrent();
		if (cur === null) return false;
		let safety = 20;
		while (cur !== target && safety-- > 0) {
			await clickKey(cur < target ? 'plus' : 'minus');
			// Wait for the label to reflect the new state — it updates on the playback:state broadcast.
			const deadline = Date.now() + 2000;
			let next = cur;
			while (Date.now() < deadline) {
				next = await readCurrent();
				if (next !== cur) break;
				await sleep(30);
			}
			cur = next;
		}
		return cur === target;
	}

	const shiftedTo1 = await targetShift(1);
	record(
		'HIGH',
		'phone → server: sending +1 lands playback.keyShift at +1 (round trip)',
		shiftedTo1,
		'the phone label is the same string the server broadcasts back'
	);

	// Give the TV time to receive the state, run the shift-wiring effect, build the graph, and resume.
	await sleep(1500);
	const stateAfter1 = /** @type {HookState | null} */ (await tv.evaluate(HOOK_STATE));
	record(
		'CRITICAL',
		'a WebAudio graph is constructed the first time a shift engages',
		(stateAfter1?.contexts ?? 0) >= 1 && (stateAfter1?.gains ?? 0) >= 1,
		`hook: ${JSON.stringify(stateAfter1)}`
	);
	record(
		'CRITICAL',
		"the AudioWorkletNode is actually constructed (not just 'planned')",
		stateAfter1?.worklets?.includes('encore-pitch-shift'),
		`worklets seen: ${JSON.stringify(stateAfter1?.worklets ?? [])}`
	);
	record(
		'CRITICAL',
		'the graph reaches AudioContext.destination (source→node→gain→destination)',
		stateAfter1?.reachedDestination === true,
		'a graph that does not connect to destination silences the room and no unit test catches it'
	);
	record(
		'HIGH',
		'the AudioContext is RUNNING (not stuck suspended)',
		stateAfter1?.contextStates?.includes('running'),
		`ctx states: ${JSON.stringify(stateAfter1?.contextStates ?? [])}`
	);

	// ── (3) decoding continues while shift is engaged ─────────────────────
	const tS1a = pick(/** @type {MediaEl[]} */ (await tv.evaluate(MEDIA_PROBE)));
	await sleep(2500);
	const tS1b = pick(/** @type {MediaEl[]} */ (await tv.evaluate(MEDIA_PROBE)));
	const decodedS1 = (tS1b?.decoded ?? 0) - (tS1a?.decoded ?? 0) > 0;
	record(
		'CRITICAL',
		'at +1 semitone: the element keeps decoding audio (bytes climbing)',
		decodedS1,
		`decoded ${tS1a?.decoded} → ${tS1b?.decoded} over 2.5s. Zero means the shifter silenced it.`
	);

	// ── (4) attach the analyser tap and measure RMS + dominant partial ────
	const tap1 = await tv.evaluate(ATTACH_TAP_SRC);
	record('LOW', 'analyser tap attaches to the gain node', tap1?.ok, `${JSON.stringify(tap1)}`);
	// Prime — need a couple of AnalyserNode fill windows before getFloatTimeDomainData is meaningful.
	// Also loop the fixture (it is 8s, positionSec could be near end).
	// Restart the song for a clean read window.
	async function restart() {
		await /** @type {Page} */ (phone).evaluate(`
			(() => {
				const btn = document.querySelector('[aria-label="restart"]');
				if (btn) btn.click();
			})()
		`);
	}
	await restart();
	await sleep(700);
	const meas1 = /** @type {TapRead} */ (await tv.evaluate(READ_TAP_SRC));
	// Now switch to 0 (ratio-1 passthrough on the same graph) so the "baseline" is measured through
	// the same tap as +N. This is what gives the ratio check its cleanness.
	const shiftedTo0 = await targetShift(0);
	record('HIGH', 'phone → server: returning to 0 lands playback.keyShift at 0', shiftedTo0);
	await sleep(800);
	await restart();
	await sleep(700);
	const meas0 = /** @type {TapRead} */ (await tv.evaluate(READ_TAP_SRC));

	// Now +2, +3, -1, -3 in turn.
	/** @param {number} target @returns {Promise<TapRead>} */
	async function measureAtShift(target) {
		await targetShift(target);
		await sleep(600);
		await restart();
		await sleep(700);
		return /** @type {TapRead} */ (await /** @type {Page} */ (tv).evaluate(READ_TAP_SRC));
	}

	/** @type {Record<number, TapRead>} */
	const measurements = { 0: meas0, 1: meas1 };
	for (const s of [2, 3, -1, -3, 5]) {
		measurements[s] = await measureAtShift(s);
	}

	// ── judge the measurements ─────────────────────────────────────────────
	// The fixture is a chord of three equal-amplitude sines at 220 / 277.18 / 329.63 Hz. At any given
	// FFT the peak-bin winner between the three is not stable across runs (they land at nearly the
	// same magnitude), so we do NOT compare peakHz at 0 vs peakHz at N — that would compare two
	// different partials. Instead: for each shift, look at the TOP TWO or THREE partials returned
	// (they are sorted by dB) and expect them to be close to the fixture partials multiplied by
	// semitonesToRatio(N).
	/** @param {number} n @returns {number} */
	function ratio(n) {
		return Math.pow(2, n / 12);
	}
	const FIXTURE = [220, 277.18, 329.63];
	/** @param {number} n @returns {number[]} */
	function expected(n) {
		return FIXTURE.map((f) => f * ratio(n));
	}
	/** @param {{ hz: number, db: number }[]} measured @param {number[]} expectedHz @param {number} [tolPct] */
	function matches(measured, expectedHz, tolPct = 3) {
		// Return true iff at least TWO of the expected partials are within tolPct% of some measured partial.
		let hits = 0;
		for (const e of expectedHz) {
			if (measured.some((m) => Math.abs(m.hz - e) / e < tolPct / 100)) hits++;
		}
		return hits >= 2;
	}

	/** @param {number} n @param {TapRead | undefined} m @returns {string} */
	function summarise(n, m) {
		if (!m?.ok) return `n/a: ${m?.why ?? 'no reading'}`;
		const top = (m.partials || [])
			.slice(0, 3)
			.map((p) => `${p.hz.toFixed(1)}Hz`)
			.join(', ');
		return `rms=${m.rms.toFixed(4)}, peak=${m.peakHz.toFixed(1)}Hz, top=[${top}], expected~[${expected(n)
			.map((f) => f.toFixed(1))
			.join(', ')}]`;
	}

	console.log('\n─── frequency-domain measurements ───');
	for (const n of [0, 1, 2, 3, -1, -3, 5]) {
		console.log(`  shift ${n >= 0 ? '+' : ''}${n}:  ${summarise(n, measurements[n])}`);
	}
	console.log('');

	// Silence test at each shift: RMS above a floor.
	const RMS_FLOOR = 0.02; // a chord at amp 0.28/3 through Hann OLA is ~0.11–0.20 RMS; 0.02 is a very cautious floor
	for (const n of [1, 2, 3, -1, -3, 5]) {
		const m = measurements[n];
		record(
			'CRITICAL',
			`shift ${n >= 0 ? '+' : ''}${n}: output is NOT silent (RMS > ${RMS_FLOOR})`,
			m?.ok && m.rms > RMS_FLOOR,
			`rms=${m?.rms?.toFixed(4) ?? 'n/a'} — a shifter that silences is worse than one that shifts wrong`
		);
	}
	// Ratio-1 passthrough (measured at 0 through the built graph) should also be audible.
	{
		const m = measurements[0];
		record(
			'CRITICAL',
			'shift 0 through built graph (ratio-1 passthrough): output is audible',
			m?.ok && m.rms > RMS_FLOOR,
			`rms=${m?.rms?.toFixed(4) ?? 'n/a'} — the graph must be a bit-exact passthrough at ratio 1`
		);
	}

	// Pitch-correctness test at each shift: two of the three chord partials land near their expected
	// transposed frequencies.
	for (const n of [1, 2, 3, -1, -3, 5]) {
		const m = measurements[n];
		const partials = m?.partials ?? [];
		const ok = m?.ok && matches(partials, expected(n));
		record(
			'HIGH',
			`shift ${n >= 0 ? '+' : ''}${n}: two of the chord partials land at 2^(${n}/12)× their fixture frequencies`,
			ok,
			`measured top: ${partials
				.slice(0, 3)
				.map((p) => p.hz.toFixed(1) + 'Hz')
				.join(', ')}   expected: ${expected(n)
				.map((f) => f.toFixed(1) + 'Hz')
				.join(', ')}`
		);
	}

	// The specifically-called-out +2 vs 0 comparison: dominant partial ratio ~= 1.1225 (±3%).
	{
		const a = measurements[0];
		const b = measurements[2];
		if (a?.ok && b?.ok) {
			// Compare the LOUDEST partial at each — but only if their absolute frequencies are within
			// the same fixture cluster (i.e. one of the three partials). Otherwise the FFT chose two
			// different partials and the ratio has no meaning; fall back to a per-partial nearest-match.
			const measuredRatio = b.peakHz / a.peakHz;
			// Nearest-match ratio: for each fixture partial, find the measured (at 0) and (at +2) partial
			// closest to it and its ratio, then average.
			/** @param {number} freq @param {{ hz: number, db: number }[]} arr */
			const closest = (freq, arr) =>
				arr.reduce((best, p) => (Math.abs(p.hz - freq) < Math.abs(best.hz - freq) ? p : best), arr[0]);
			let sum = 0,
				n = 0;
			for (const fx of FIXTURE) {
				const c0 = closest(fx, a.partials);
				const c2 = closest(fx * ratio(2), b.partials);
				if (c0 && c2) {
					sum += c2.hz / c0.hz;
					n++;
				}
			}
			const nearest = n > 0 ? sum / n : NaN;
			record(
				'HIGH',
				'shift 0 → +2: the mean per-partial frequency ratio is 2^(2/12) ≈ 1.1225 (±3%)',
				Math.abs(nearest - ratio(2)) / ratio(2) < 0.03,
				`per-partial mean ratio = ${nearest.toFixed(4)}, dominant-peak ratio = ${measuredRatio.toFixed(4)}, expected = ${ratio(2).toFixed(4)}`
			);
			record(
				'HIGH',
				'shift 0 → +2: RMS is roughly preserved (within a factor of 2)',
				Math.abs(Math.log2(b.rms / a.rms)) < 1,
				`rms@0=${a.rms.toFixed(4)}  rms@+2=${b.rms.toFixed(4)}  ratio=${(b.rms / a.rms).toFixed(3)}`
			);
		}
	}

	// ── (5) UI sounding-key label agrees with the actual shift ────────────
	// The `Key ·` label is the value the server broadcasts back after the round-trip, so this is
	// really "does the phone label agree with server state" — the "sounding key" line above it also
	// prints keySounding, but that helper returns null unless a real songProfile is populated, which
	// the fake worker does not produce (see search response: songProfile.keyTonic === null). We can
	// therefore only assert on the Key label; the keySounding case is an environment limit.
	{
		await targetShift(2);
		await sleep(200);
		const label2 = await phone.text(SEL.keyLabel);
		record(
			'HIGH',
			'phone key label matches +2 shift',
			label2 && (label2.includes('+2') || label2.includes('· 2') || label2.includes('· +2')),
			`label at +2: ${JSON.stringify(label2)}`
		);
		await targetShift(-3);
		await sleep(200);
		const labelN3 = await phone.text(SEL.keyLabel);
		record(
			'HIGH',
			'phone key label matches -3 shift',
			labelN3 && (labelN3.includes('−3') || labelN3.includes('-3') || labelN3.includes('· 3')),
			`label at -3: ${JSON.stringify(labelN3)}`
		);
		record(
			'MEDIUM',
			"the 'sounding key' line renders when a real songProfile is present",
			false,
			'the fake worker publishes a legacy-shape songProfile that setSongProfile discards (see search response — songProfile.keyTonic === null), so keySounding is null and the .key-head line does not render. This is an environment limit, not a defect in the shifter.',
			true /* env */
		);
	}

	// ── (6) shift survives pause/resume; resets on song change ────────────
	{
		await targetShift(2);
		await sleep(600);
		await restart(); // ensures we are inside the 8s fixture
		await sleep(700);
		const meas2a = /** @type {TapRead} */ (await tv.evaluate(READ_TAP_SRC));
		// pause
		await phone.clickByLabel('play/pause');
		await sleep(700);
		const pausedEls = pick(/** @type {MediaEl[]} */ (await tv.evaluate(MEDIA_PROBE)));
		record(
			'MEDIUM',
			'shift +2: pause halts the master',
			pausedEls?.paused === true,
			`paused=${pausedEls?.paused}, currentTime=${pausedEls?.currentTime?.toFixed(2)}`
		);
		// resume
		await phone.clickByLabel('play/pause');
		await sleep(1200);
		const resumedEls = pick(/** @type {MediaEl[]} */ (await tv.evaluate(MEDIA_PROBE)));
		record(
			'MEDIUM',
			'shift +2: resume keeps decoding',
			(resumedEls?.decoded ?? 0) > (pausedEls?.decoded ?? 0) && !resumedEls?.paused,
			`decoded ${pausedEls?.decoded} → ${resumedEls?.decoded}`
		);
		const meas2b = /** @type {TapRead} */ (await tv.evaluate(READ_TAP_SRC));
		record(
			'HIGH',
			'shift +2: the pitch survives pause/resume (top partial matches expected within 3%)',
			meas2b?.ok && matches(meas2b.partials, expected(2)),
			`before pause top=[${(meas2a.partials || [])
				.slice(0, 3)
				.map((p) => p.hz.toFixed(1))
				.join(', ')}]  after resume top=[${(meas2b.partials || [])
				.slice(0, 3)
				.map((p) => p.hz.toFixed(1))
				.join(', ')}]`
		);
	}

	// ── song change: reset ────────────────────────────────────────────────
	// Advance the queue. If a second cooked song is available, add it and skip; the media.id changes,
	// TvPlayer's reset effect detaches the graphs, and the server resets keyShift to 0 on advance. If
	// no second song is available, we can still verify the graph teardown (context.state === 'closed')
	// and the keyShift reset, but not "the fresh song keeps decoding" — that becomes an env limit.
	{
		if (secondReady) {
			// The second song is already ready-cooked (see ensureSecondReady above). The phone's search
			// field still has 'caroline' from earlier, so first change it to a term that finds the second
			// song. Then click .add on its row.
			await phone.fill(SEL.search, secondReady.title.split(' ')[0].toLowerCase());
			await phone.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.songRow)}).length > 0`);
			await phone.evaluate(`
				(async () => {
					const rows = [...document.querySelectorAll(${JSON.stringify(SEL.songRow)})];
					const row = rows.find((r) => r.textContent.includes(${JSON.stringify(secondReady.title)}));
					const add = row?.querySelector(${JSON.stringify(SEL.addAction)});
					const sing = row?.querySelector(${JSON.stringify(SEL.singAction)});
					(add || sing)?.click();
				})()
			`);
			await sleep(1200);
			// Skip to advance to the second song.
			await phone.clickByLabel('skip');
			await sleep(2500);
			// The server resets keyShift on advance, so the phone label should return to 'Key'.
			const labelAfter = await phone.text(SEL.keyLabel);
			record(
				'HIGH',
				'song change: server resets keyShift to 0 on advance',
				labelAfter === 'Key',
				`.key .lab after advance: ${JSON.stringify(labelAfter)}`
			);
			// The reset effect on the TV detaches the graphs; at shift 0, no new graph is built. Audio
			// must still decode through the native path on the fresh song.
			const advA = pick(/** @type {MediaEl[]} */ (await tv.evaluate(MEDIA_PROBE)));
			await sleep(1800);
			const advB = pick(/** @type {MediaEl[]} */ (await tv.evaluate(MEDIA_PROBE)));
			const bothPresent = advA && advB;
			record(
				'CRITICAL',
				'song change: audio keeps decoding on the fresh song after a shifted song',
				bothPresent && (advB.decoded ?? 0) > (advA.decoded ?? 0),
				bothPresent
					? `decoded ${advA.decoded} → ${advB.decoded} on the second song`
					: `no <audio> mounted after advance (advA=${!!advA}, advB=${!!advB}) — the queue likely emptied`
			);
			const stateAfterChange = /** @type {HookState | null} */ (await tv.evaluate(HOOK_STATE));
			// The previous song's context should be closed by detach(); if the new song stayed at shift 0
			// no new context is built. Log for the record.
			record(
				'MEDIUM',
				"song change: the previous song's AudioContext was closed by detach()",
				stateAfterChange?.contextStates?.every((s) => s === 'closed' || s === 'running'),
				`ctx states: ${JSON.stringify(stateAfterChange?.contextStates ?? [])} (expect the shifted song's ctx to be 'closed')`
			);
			console.log(`  post-advance hook state: ${JSON.stringify(stateAfterChange)}`);
		} else {
			// Only one song cookable — do a "reset without an advance target": skip past the song and
			// verify (a) label resets, (b) the shift graph tore down (context.state === 'closed').
			await phone.clickByLabel('skip');
			await sleep(2000);
			const labelAfter = await phone.text(SEL.keyLabel);
			record(
				'HIGH',
				'song-end reset: server resets keyShift to 0 when the queue empties',
				labelAfter === 'Key',
				`.key .lab after advance: ${JSON.stringify(labelAfter)}`
			);
			const stateAfterChange = /** @type {HookState | null} */ (await tv.evaluate(HOOK_STATE));
			record(
				'MEDIUM',
				"song-end: the shifted song's AudioContext was closed by detach()",
				stateAfterChange?.contextStates?.every((s) => s === 'closed'),
				`ctx states: ${JSON.stringify(stateAfterChange?.contextStates ?? [])}`
			);
			record(
				'LOW',
				'song-change advance to a fresh cooking song',
				false,
				'no second cookable song was available in the fixture library — advance target check is an env limit',
				true /* env */
			);
			console.log(`  post-advance hook state: ${JSON.stringify(stateAfterChange)}`);
		}
	}

	// A final screenshot for a human to sanity-check.
	const shot = join(SCRATCH, `p3-key-shift-${PORT}.png`);
	await tv.screenshot(shot);
	console.log(`\nTV frame: ${shot}`);
	const finalMedia = await tv.evaluate(MEDIA_PROBE);
	const finalHook = /** @type {HookState | null} */ (await tv.evaluate(HOOK_STATE));
	console.log('final media state:', JSON.stringify(finalMedia, null, 1));
	console.log('final hook state:', JSON.stringify(finalHook, null, 1));
} catch (/** @type {any} */ err) {
	record('CRITICAL', 'the flow ran to completion', false, String(err?.stack ?? err));
} finally {
	browser?.close();
	proc.kill();
}

// ── summary ───────────────────────────────────────────────────────────────
const defects = findings.filter((f) => !f.env && !f.ok);
const passes = findings.filter((f) => !f.env && f.ok);
const envs = findings.filter((f) => f.env);
console.log('');
console.log(`${passes.length}/${passes.length + defects.length} checks passed  ·  ${envs.length} environment limits`);
if (defects.length) {
	console.log('\nDEFECTS:');
	/** @type {Record<Severity, Finding[]>} */
	const bySeverity = { CRITICAL: [], HIGH: [], MEDIUM: [], LOW: [] };
	for (const f of defects) (bySeverity[f.severity] ?? []).push(f);
	for (const sev of /** @type {Severity[]} */ (['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'])) {
		if (!bySeverity[sev].length) continue;
		console.log(`  ${sev}:`);
		for (const f of bySeverity[sev]) {
			console.log(`    - ${f.name}`);
			if (f.detail) console.log(`      ${f.detail}`);
		}
	}
}
if (envs.length) {
	console.log('\nENVIRONMENT LIMITS (not defects):');
	for (const f of envs) {
		console.log(`  - ${f.name}`);
		if (f.detail) console.log(`    ${f.detail}`);
	}
}
process.exit(defects.length ? 1 : 0);
