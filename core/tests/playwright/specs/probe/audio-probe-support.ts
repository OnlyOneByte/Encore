// What the six AUDIO probes (p1, p2, p3, p4, p13, tv-audiocontext-resume) all had to do before they could
// measure anything: get a real processed song onto the TV, read the media elements' decode counters in ONE
// round trip, and talk to the server the way a phone does.
//
// NOT in world/: three other ports are in flight against that directory. If a second partition needs any of
// this, it belongs there — this file is the smallest thing that unblocks these six.
//
// THE DECODED BYTE COUNTER IS THE SUBJECT, not `paused` and not `currentTime`. `webkitAudioDecodedByteCount`
// is the only reading that separates "the element says it is playing" from "the room can hear it": a FLAC in a
// <video> reports a valid file, `paused false` and a climbing `currentTime` while decoding NOTHING. Every
// reader below therefore carries it, and a probe that cannot evaluate it must fail rather than pass.
// See docs/E2E.md#proving-audio.
import { expect, type Page } from '@playwright/test';
import { SEL } from '../../world/selectors';

/** One media element as the page sees it. Read as a SET so a compare across a dwell is coherent. */
export interface MediaRow {
	tag: string;
	src: string;
	readyState: number;
	paused: boolean;
	muted: boolean;
	volume: number;
	playbackRate: number;
	currentTime: number;
	duration: number;
	ended: boolean;
	/** `webkitAudioDecodedByteCount`, or null on a browser that does not expose it — which makes the
	 *  question unanswerable rather than answered "no". */
	decoded: number | null;
	error: { code: number; message: string } | null;
	/** Index of the `.slot` this element lives in, or -1. The A/B pair is how gapless works. */
	slotIdx: number;
	/** Whether that slot is the one on screen. The hidden pre-warm slot holds a PAUSED element at t=0. */
	slotVisible: boolean | null;
}

/** One sample of the whole stage: the elements plus the text the wall is showing. */
export interface StageSample {
	slotCount: number;
	slotVisible: boolean[];
	elems: MediaRow[];
	lowerThird: { visible: boolean; name: string; song: string };
	upNext: { visible: boolean; label: string; name: string; song: string; kind: string | null };
	attract: boolean;
	lobby: boolean;
	autoplayHint: boolean;
	/** `performance.now()` at the read, so a sequence of samples carries the page's own monotonic clock. */
	t: number;
}

/** The selector set the in-page readers need, passed in rather than closed over: an `evaluate` body is
 *  serialised and cannot see the module scope. */
const STAGE_SELECTORS = {
	slot: SEL.slot,
	slotVisibleAudio: SEL.slotVisibleAudio,
	lowerThird: SEL.lowerThird,
	nowName: SEL.nowName,
	nowSong: SEL.nowSong,
	interstitial: SEL.interstitial,
	upLabel: SEL.upLabel,
	upName: SEL.upName,
	upSong: SEL.upSong,
	attract: SEL.attract,
	lobby: SEL.lobby,
	autoplayHint: SEL.autoplayHint
} as const;

type StageSelectors = typeof STAGE_SELECTORS;

/**
 * THE reader. Installed as a page function so the dense samplers below and the one-shot readers agree on
 * every field — a boundary measured with one shape and a state read with another is two measurements.
 */
function sampleStage(sel: StageSelectors): StageSample {
	const slotEls = [...document.querySelectorAll(sel.slot)];
	const lt = document.querySelector(sel.lowerThird);
	const up = document.querySelector(sel.interstitial);
	const text = (root: Element | null | undefined, q: string): string =>
		(root?.querySelector(q)?.textContent ?? '').trim();
	return {
		t: performance.now(),
		slotCount: slotEls.length,
		slotVisible: slotEls.map((s) => s.classList.contains('visible')),
		elems: [...document.querySelectorAll('audio,video')].map((raw) => {
			const el = raw as HTMLMediaElement & { webkitAudioDecodedByteCount?: number };
			const slot = el.closest(sel.slot);
			return {
				tag: el.tagName,
				// `currentSrc` first: it is what the element RESOLVED, where the attribute is what was asked for.
				src: el.currentSrc || el.getAttribute('src') || '',
				readyState: el.readyState,
				paused: el.paused,
				muted: el.muted,
				volume: el.volume,
				playbackRate: el.playbackRate,
				currentTime: el.currentTime,
				duration: el.duration,
				ended: el.ended,
				decoded: el.webkitAudioDecodedByteCount ?? null,
				error: el.error ? { code: el.error.code, message: el.error.message } : null,
				slotIdx: slot ? slotEls.indexOf(slot) : -1,
				slotVisible: slot?.classList.contains('visible') ?? null
			};
		}),
		lowerThird: { visible: !!lt, name: text(lt, sel.nowName), song: text(lt, sel.nowSong) },
		upNext: {
			visible: !!up,
			label: text(up, sel.upLabel),
			name: text(up, sel.upName),
			song: text(up, sel.upSong),
			kind: up
				? up.classList.contains('state-next')
					? 'next'
					: up.classList.contains('state-error')
						? 'error'
						: up.classList.contains('state-waiting')
							? 'waiting'
							: 'other'
				: null
		},
		attract: !!document.querySelector(sel.attract),
		lobby: !!document.querySelector(sel.lobby),
		autoplayHint: !!document.querySelector(sel.autoplayHint)
	};
}

/** One coherent read of the stage. */
export async function readStage(page: Page): Promise<StageSample> {
	return page.evaluate(sampleStage, STAGE_SELECTORS);
}

/** One media event, stamped in the page's own clock at the moment it fired. */
export interface MediaEvent {
	ev: 'ended' | 'playing' | 'emptied';
	src: string;
	/** `performance.now()` inside the handler. */
	t: number;
}

/**
 * Logs `ended`, `playing` and `emptied` from every media element on the page, as they FIRE. A 40ms poll of the decode
 * counter cannot time a boundary: the decoder runs ahead of the playhead at a song's end and behind it at a start.
 * Capture-phase on the document, so it needs no reload and sees elements mounted later.
 */
export async function armMediaLog(page: Page): Promise<void> {
	await page.evaluate(() => {
		const w = window as unknown as { probeMediaLog?: MediaEvent[] };
		if (w.probeMediaLog) return;
		const log: MediaEvent[] = (w.probeMediaLog = []);
		for (const ev of ['ended', 'playing', 'emptied'] as const) {
			document.addEventListener(
				ev,
				(e) => {
					const el = e.target as HTMLMediaElement;
					if (el instanceof HTMLMediaElement) log.push({ ev, src: el.getAttribute('src') ?? '', t: performance.now() });
				},
				true
			);
		}
	});
}

export async function readMediaLog(page: Page): Promise<MediaEvent[]> {
	return page.evaluate(() => (window as unknown as { probeMediaLog?: MediaEvent[] }).probeMediaLog ?? []);
}

/**
 * THE MASTER, scoped the way p4 scoped it: `.slot.visible audio` first, because the hidden pre-warm slot
 * carries its own PAUSED <audio> at currentTime 0 and a looser query reads the stage as silent. Falls back to
 * any instrumental-bearing element so a caller can still report the state instead of crashing.
 */
export function pickMaster(sample: StageSample): MediaRow | null {
	const visible = sample.elems.filter((e) => e.slotVisible === true);
	return (
		visible.find((e) => e.src.includes('instrumental')) ??
		visible.find((e) => e.src) ??
		sample.elems.find((e) => e.src.includes('instrumental')) ??
		sample.elems.find((e) => e.src) ??
		null
	);
}

export async function readMaster(page: Page): Promise<MediaRow | null> {
	return pickMaster(await readStage(page));
}

/**
 * Wait until the TV holds a master element with a resolved src. THROWS with the stage state rather than
 * returning null, so "no media" and "not yet" are never confused — every reading downstream depends on it.
 */
export async function awaitMaster(page: Page, timeout = 30_000): Promise<MediaRow> {
	// A HAND-ROLLED POLL rather than `expect.poll`, for one reason: `message` is a string built at CALL time, so
	// the last sample cannot be in it — and "no media element" without the stage beside it is the least
	// actionable failure in this file.
	const deadline = Date.now() + timeout;
	for (;;) {
		const last = await readStage(page);
		const master = pickMaster(last);
		if (master?.src) return master;
		if (Date.now() >= deadline) {
			// The two cases are different bugs, so they get different sentences: NO ELEMENT means the stage is not
			// on the playing screen at all, where an element holding an EMPTY src means the app declined to commit
			// one — on a guide-mix song that is `masterSrcPlan` holding out for a split graph that never routed.
			const diagnosis =
				last.elems.length === 0
					? `no <audio>/<video> is mounted at all: the stage is showing ` +
						`${last.attract ? 'the ATTRACT screen' : last.lobby ? 'the LOBBY' : 'neither attract nor lobby'}, ` +
						`so nothing is playing.`
					: `${last.elems.length} element(s) are mounted and none carries a src.`;
			throw new Error(
				`the TV never mounted a media element with a src within ${timeout}ms. Nothing can be measured ` +
					`without one. ${diagnosis}\n\nstage: ${JSON.stringify(last)}`
			);
		}
		await new Promise((r) => setTimeout(r, 100));
	}
}

/** THE WORKER'S OWN TONE, which is what the TV actually plays: `startFakeWorker` writes the SAME
 *  three-sine instrumental for every track (world/workers.ts), so these are the frequencies an FFT off the
 *  TV's output must show — the library file's own tone is the input to a separation that never happens here. */
export const WORKER_INSTRUMENTAL_HZ = [220, 277.18, 329.63] as const;

/** A demo library track: the FILENAME-derived title, and a single-token query that finds it.
 *  ONE TOKEN ON PURPOSE — the local resolver builds an FTS5 MATCH from the query, and a hyphen in a bare
 *  term is a syntax error there, so `sweet-caroline` returns NOTHING while `caroline` returns the track. */
export const TRACKS = {
	caroline: { title: 'sweet-caroline', q: 'caroline' },
	believin: { title: 'dont-stop-believin', q: 'believin' },
	bohemian: { title: 'bohemian-rhapsody', q: 'bohemian' },
	prayer: { title: 'livin-on-a-prayer', q: 'prayer' }
} as const;

export interface ReadyMedia {
	id: string;
	title: string;
	stemStatus: string;
	instrumentalRef: string;
	vocalsRef?: string;
	guideMixRef?: string;
}

/** `source=local` so the YouTube resolver — which really answers on a box with yt-dlp — cannot put a
 *  same-named stranger in the group being read. */
async function localSearch(baseURL: string, q: string): Promise<{ ready: ReadyMedia[]; processing: ReadyMedia[] }> {
	const res = await fetch(`${baseURL}/api/search?q=${encodeURIComponent(q)}&source=local`);
	const body = (await res.json()) as { ready?: ReadyMedia[]; processing?: ReadyMedia[] };
	return { ready: body.ready ?? [], processing: body.processing ?? [] };
}

/**
 * Take a turn on a library track and let the fake worker separate it: ONE action on the phone, because
 * "sing" queues AND processes (src/lib/process-and-queue.ts) and the rotation holds the slot until the stems
 * land. Returns the media once the catalog itself says it is playable.
 *
 * THE ROW IS PICKED BY TITLE, not by position: a search reaching YouTube returns a dozen strangers, and
 * `.first()` on a stale render is how a probe silently queues someone else's song.
 */
export async function singTrack(
	page: Page,
	baseURL: string,
	track: { title: string; q: string },
	timeout = 45_000
): Promise<ReadyMedia> {
	await fillSearch(page, track.q);
	const row = page.locator(SEL.songRow).filter({ hasText: track.title }).first();
	await row.locator(SEL.addOrSing).first().click();
	let found: ReadyMedia | undefined;
	await expect
		.poll(
			async () => {
				const { ready } = await localSearch(baseURL, track.q);
				found = ready.find((m) => m.title === track.title && !!m.instrumentalRef);
				return !!found;
			},
			{
				timeout,
				message:
					`"${track.title}" never reached stemStatus ready with an instrumentalRef. Nothing plays until it ` +
					`does — is a fake worker connected for this world?`
			}
		)
		.toBe(true);
	return found!;
}

/**
 * SEPARATE the process from the turn, for a probe whose subject is what happens once BOTH songs are already
 * playable: `singTrack` above takes the turn and the process together (one tap, as a guest gets it), which
 * means the first song starts playing while the second is still separating.
 *
 * The search is what MATERIALIZES a library file into a Media with an id, and /api/process needs a joined
 * singer — hence the POST through the phone's own request context, which carries its session cookie.
 */
export async function processTrack(
	phone: Page,
	baseURL: string,
	track: { title: string; q: string },
	timeout = 45_000
): Promise<ReadyMedia> {
	const { ready, processing } = await localSearch(baseURL, track.q);
	const seen = [...ready, ...processing].find((m) => m.title === track.title);
	let id = seen?.id;
	if (!id) {
		// The route mints and persists a Media for every hit, so one search is enough to give the file an id.
		const res = await fetch(`${baseURL}/api/search?q=${encodeURIComponent(track.q)}&source=local`);
		const body = (await res.json()) as { results?: ReadyMedia[]; ready?: ReadyMedia[]; processing?: ReadyMedia[] };
		id = [...(body.ready ?? []), ...(body.processing ?? []), ...(body.results ?? [])].find(
			(m) => m.title === track.title
		)?.id;
	}
	if (!id) throw new Error(`the library has no track titled "${track.title}" — is world/seed.ts still seeding it?`);
	const res = await phone.request.post(`${baseURL}/api/process`, { data: { mediaId: id } });
	// 409 is "already processing/playing", which is a legitimate answer to the same request twice.
	if (!res.ok() && res.status() !== 409) {
		throw new Error(`POST /api/process for "${track.title}" answered ${res.status()}: ${await res.text()}`);
	}
	let found: ReadyMedia | undefined;
	await expect
		.poll(
			async () => {
				found = (await localSearch(baseURL, track.q)).ready.find((m) => m.id === id && !!m.instrumentalRef);
				return !!found;
			},
			{
				timeout,
				message: `"${track.title}" did not become ready — is a fake worker connected for this world?`
			}
		)
		.toBe(true);
	return found!;
}

/** Take a turn on a song that is ALREADY ready, which is the one action a processed row offers. */
export async function queueReadyTrack(phone: Page, track: { title: string; q: string }): Promise<void> {
	await fillSearch(phone, track.q);
	const row = phone.locator(SEL.songRow).filter({ hasText: track.title }).first();
	// `SEL.addAction`, not `SEL.addTurn`: the latter is SCOPED (`.row [data-testid=…]`), so chained under a row
	// locator it resolves to `.row >> .row …` and matches nothing — a hang against a perfectly current contract.
	await row.locator(SEL.addAction).click();
}

/** The search box is the first element in the home column, so there is nothing to click — but it must have
 *  ARRIVED, or the fill types into nothing. */
async function fillSearch(phone: Page, q: string): Promise<void> {
	await phone.locator(SEL.search).first().waitFor({ state: 'attached' });
	await phone.locator(SEL.search).fill(q);
}

/** The authoritative playback state, read the way p4 read it: a `hello` frame over a raw socket, which needs
 *  no joined singer. THROWS on the deadline — a missing answer is not a zero. */
export interface ServerPlayback {
	positionSec: number;
	isPlaying: boolean;
	currentEntryId: string | null;
	keyShift: number;
	guideLevel: number | null;
	background: string | null;
}

export async function serverPlayback(
	baseURL: string,
	timeoutMs = 5_000
): Promise<{ state: ServerPlayback; rev: number }> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`${baseURL.replace(/^http/, 'ws')}/ws?role=probe`);
		let done = false;
		const finish = (fn: () => void) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			try {
				ws.close();
			} catch {
				/* already closing */
			}
			fn();
		};
		const timer = setTimeout(
			() => finish(() => reject(new Error(`no playback:state from ${baseURL} within ${timeoutMs}ms`))),
			timeoutMs
		);
		ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', lastRev: 0 }));
		ws.onmessage = (ev: MessageEvent) => {
			const e = JSON.parse(String(ev.data)) as { type: string; state?: ServerPlayback; rev?: number };
			if (e.type === 'playback:state' && e.state) finish(() => resolve({ state: e.state!, rev: e.rev ?? 0 }));
		};
		ws.onerror = () => finish(() => reject(new Error(`websocket error against ${baseURL}`)));
	});
}

/**
 * Send a `player:command` from the PHONE's page, over a socket opened there: the server rejects a
 * player:command from a socket with no session, and one opened inside the phone's context rides its cookie
 * so the singerId resolves at upgrade. ONE socket, kept on `window`, because a per-command handshake races
 * the client's own queue:sync.
 *
 * Used where the phone has no control for the command (`seek` has none at all) or where the control is the
 * subject of a DIFFERENT probe. A control that exists is clicked.
 */
export async function sendPlayerCommand(phone: Page, command: Record<string, unknown>): Promise<void> {
	await phone.evaluate(async () => {
		const w = window as unknown as { probeWs?: WebSocket; probeCurrent?: string | null };
		if (w.probeWs && w.probeWs.readyState === WebSocket.OPEN) return;
		const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?role=phone`);
		// The socket FOLLOWS the current entry, because skip/restart/seek must name it (the server drops a stale one).
		// Resolved on the hello's playback:state, so the first command already knows what is playing.
		await new Promise<void>((resolve, reject) => {
			ws.onmessage = (ev) => {
				const e = JSON.parse(String(ev.data));
				if (e.type !== 'playback:state') return;
				w.probeCurrent = e.state.currentEntryId;
				resolve();
			};
			ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', lastRev: 0 }));
			ws.onerror = () => reject(new Error('the probe socket would not open from the phone page'));
		});
		w.probeWs = ws;
	});
	await phone.evaluate((cmd) => {
		const w = window as unknown as { probeWs: WebSocket; probeCurrent?: string | null };
		const named = ['skip', 'restart', 'seek', 'key', 'guide'].includes(String(cmd.cmd)) && !('entryId' in cmd);
		const frame = named ? { ...cmd, entryId: w.probeCurrent } : cmd;
		w.probeWs.send(JSON.stringify({ type: 'player:command', command: frame }));
	}, command);
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────────────
 * THE WEBAUDIO GRAPH HOOK. p3 and tv-audiocontext-resume both need to know what the pitch shifter BUILT,
 * and `AudioContext.state` read after the fact cannot tell you whether one was ever constructed — so the
 * constructors are wrapped before the app can call them. Ported from p3's INSTALL_HOOK_SRC.
 * ──────────────────────────────────────────────────────────────────────────────────────────────────────── */

interface HookedGain {
	node: GainNode;
	ctx: BaseAudioContext;
}
interface HookState {
	contexts: AudioContext[];
	gains: HookedGain[];
	worklets: { name: string }[];
	sources: { tag: string; src: string }[];
	connects: { isDestination: boolean }[];
	resumeCalls: number;
	taps: { gain: GainNode; ctx: BaseAudioContext; analyser: AnalyserNode }[];
}
interface HookedWindow {
	__ENCORE_HOOK__?: HookState;
	AudioContext: typeof AudioContext;
	webkitAudioContext?: typeof AudioContext;
	AudioWorkletNode: typeof AudioWorkletNode;
}

/** The hook body. Idempotent, and it reports which of the three things happened rather than throwing. */
const GRAPH_HOOK = (): 'installed' | 'already-installed' | 'no-audio-context' => {
	const w = window as unknown as HookedWindow;
	if (w.__ENCORE_HOOK__) return 'already-installed';
	const OAC = w.AudioContext ?? w.webkitAudioContext;
	if (!OAC) return 'no-audio-context';
	const state: HookState = {
		contexts: [],
		gains: [],
		worklets: [],
		sources: [],
		connects: [],
		resumeCalls: 0,
		taps: []
	};
	w.__ENCORE_HOOK__ = state;

	// EXTENDS the original, so `instanceof` still holds and the wrapped prototype methods are inherited.
	class WrappedAC extends OAC {
		constructor(...args: ConstructorParameters<typeof AudioContext>) {
			super(...args);
			state.contexts.push(this);
		}
	}
	w.AudioContext = WrappedAC;
	w.webkitAudioContext = WrappedAC;

	// ON THE PROTOTYPE: the shifter reads these off the instance it constructs.
	const origGain = OAC.prototype.createGain;
	OAC.prototype.createGain = function (this: AudioContext): GainNode {
		const g = origGain.call(this);
		state.gains.push({ node: g, ctx: this });
		return g;
	};
	const origSource = OAC.prototype.createMediaElementSource;
	OAC.prototype.createMediaElementSource = function (this: AudioContext, el: HTMLMediaElement) {
		const s = origSource.call(this, el);
		state.sources.push({ tag: el.tagName, src: el.currentSrc || el.getAttribute('src') || '' });
		return s;
	};
	// `audioWorklet` is NOT wrapped: it is a per-instance getter, so reading it off the prototype throws
	// 'Illegal invocation', and the AudioWorkletNode wrapper below already proves the module resolved.
	const origResume = OAC.prototype.resume;
	OAC.prototype.resume = function (this: AudioContext): Promise<void> {
		state.resumeCalls++;
		return origResume.call(this);
	};

	if (w.AudioWorkletNode) {
		const OWN = w.AudioWorkletNode;
		class WrappedAWN extends OWN {
			constructor(ctx: BaseAudioContext, name: string, opts?: AudioWorkletNodeOptions) {
				super(ctx, name, opts);
				state.worklets.push({ name });
			}
		}
		Object.setPrototypeOf(WrappedAWN, OWN);
		w.AudioWorkletNode = WrappedAWN;
	}

	// COUNTING EDGES is what proves the graph reaches the speakers; only node-to-node matters.
	const origConnect = AudioNode.prototype.connect;
	AudioNode.prototype.connect = function (this: AudioNode, dst: AudioNode | AudioParam, ...rest: number[]) {
		try {
			state.connects.push({ isDestination: !!(this.context && dst === this.context.destination) });
		} catch {
			/* a node whose context is gone cannot be a destination edge */
		}
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return (origConnect as any).call(this, dst, ...rest);
	};

	return 'installed';
};

/** What the hook saw, minus the node references, which do not serialise. */
export interface GraphState {
	contexts: number;
	contextStates: string[];
	gains: number;
	/** Every hooked GainNode's CURRENT value, in construction order. In the split (guide-mix) graph that is
	 *  [master, guide] — see PitchShiftGraph#buildOnce, which creates the master gain then the guide's. */
	gainValues: number[];
	worklets: string[];
	sources: { tag: string; src: string }[];
	reachedDestination: boolean;
	resumeCalls: number;
	taps: number;
}

/** Install on the CURRENT document. Safe for a lazily-built graph — at keyShift 0 nothing is constructed. */
export async function installGraphHook(page: Page): Promise<'installed' | 'already-installed' | 'no-audio-context'> {
	return page.evaluate(GRAPH_HOOK);
}

/** Arm for the NEXT document, for a graph that is built EAGERLY at mount (a guide-mix song). The caller
 *  reloads or navigates afterwards. */
export async function armGraphHook(page: Page): Promise<void> {
	await page.addInitScript(GRAPH_HOOK);
}

export async function readGraphState(page: Page): Promise<GraphState | null> {
	return page.evaluate(() => {
		const s = (window as unknown as HookedWindow).__ENCORE_HOOK__;
		if (!s) return null;
		return {
			contexts: s.contexts.length,
			contextStates: s.contexts.map((c) => c.state as string),
			gains: s.gains.length,
			gainValues: s.gains.map((g) => g.node.gain.value),
			worklets: s.worklets.map((x) => x.name),
			sources: s.sources,
			reachedDestination: s.connects.some((c) => c.isDestination),
			resumeCalls: s.resumeCalls,
			taps: s.taps.length
		};
	});
}

/** A SECOND edge out of the latest gain node, so the audible path is untouched by the measurement. */
export async function attachTap(page: Page): Promise<{ ok: boolean; why: string; sampleRate?: number }> {
	return page.evaluate(() => {
		const s = (window as unknown as HookedWindow).__ENCORE_HOOK__;
		if (!s) return { ok: false, why: 'no-hook' };
		const latest = s.gains[s.gains.length - 1];
		if (!latest) return { ok: false, why: 'no-gain' };
		if (s.taps.some((t) => t.gain === latest.node)) return { ok: true, why: 'reused' };
		const analyser = latest.ctx.createAnalyser();
		analyser.fftSize = 8192;
		analyser.smoothingTimeConstant = 0;
		latest.node.connect(analyser);
		s.taps.push({ gain: latest.node, ctx: latest.ctx, analyser });
		return { ok: true, why: 'attached', sampleRate: latest.ctx.sampleRate };
	});
}

export interface TapRead {
	ok: boolean;
	why?: string;
	rms: number;
	peakHz: number;
	peakDb: number;
	binHz: number;
	sampleRate: number;
	partials: { hz: number; db: number }[];
}

/**
 * The OUTPUT samples, off the tap. Peak-bin resolution at fftSize 8192 / 48kHz is ~5.86 Hz, comfortably
 * inside the 3% tolerance the pitch assertions use (a semitone is ~5.9%).
 */
export async function readTap(page: Page): Promise<TapRead> {
	return page.evaluate(() => {
		const empty = { rms: 0, peakHz: 0, peakDb: -Infinity, binHz: 0, sampleRate: 0, partials: [] };
		const s = (window as unknown as HookedWindow).__ENCORE_HOOK__;
		if (!s) return { ok: false, why: 'no-hook', ...empty };
		const tap = s.taps[s.taps.length - 1];
		if (!tap) return { ok: false, why: 'no-tap', ...empty };
		const N = tap.analyser.fftSize;
		const time = new Float32Array(N);
		tap.analyser.getFloatTimeDomainData(time);
		let sumSq = 0;
		for (const v of time) sumSq += v * v;
		const rms = Math.sqrt(sumSq / N);
		const freq = new Float32Array(tap.analyser.frequencyBinCount);
		tap.analyser.getFloatFrequencyData(freq); // dB
		const sr = tap.ctx.sampleRate;
		const binHz = sr / N;
		// BELOW 1200 Hz ONLY: higher bins are aliasing or harmonics that would win the argmax outright.
		const searchTo = Math.min(freq.length, Math.ceil(1200 / binHz));
		let peakBin = 1;
		let peakDb = -Infinity;
		for (let i = 1; i < searchTo; i++) {
			const v = freq[i] as number;
			if (v > peakDb) {
				peakDb = v;
				peakBin = i;
			}
		}
		// Every local maximum within 12dB of the peak, so the partials can be seen moving TOGETHER.
		const partials: { hz: number; db: number }[] = [];
		for (let i = 2; i < searchTo - 1; i++) {
			const v = freq[i] as number;
			if (v > (freq[i - 1] as number) && v > (freq[i + 1] as number) && v > peakDb - 12) {
				partials.push({ hz: i * binHz, db: v });
			}
		}
		partials.sort((a, b) => b.db - a.db);
		return { ok: true, rms, peakHz: peakBin * binHz, peakDb, binHz, sampleRate: sr, partials: partials.slice(0, 6) };
	});
}

/**
 * ONE REAL TAP on the TV, which is the product's own route out of a silent television (p13) and the only one
 * that grants user activation: a synthetic `el.click()` is untrusted, fires no `pointerdown`, and reaches the
 * document-wide gesture listener not at all. `page.mouse` is real input, at the centre of a 1080p stage.
 *
 * Every probe whose subject is playback takes it, so the reading is of a television someone walked up to —
 * NOT of a relaxed `--autoplay-policy`, which would prove playback in an environment the product never ships
 * into.
 */
export async function tapStage(tv: Page): Promise<void> {
	await tv.mouse.click(960, 540);
}
