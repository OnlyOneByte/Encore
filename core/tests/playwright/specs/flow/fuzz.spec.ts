/*
 * FUZZ — a seeded, stateful, adversarial input fuzzer for the karaoke room. The six invariants, the knobs and
 * the wire-command substitutions: docs/E2E.md#the-fuzz-invariants and #fuzzing-the-room.
 *
 * What follows is the shape of the fuzzer, because every line of it is load-bearing in a way a scenario's is not.
 *
 * ONE LONG TEST, NOT ONE TEST PER INPUT. The live defects were in the ADJACENCY of inputs that no curated
 * sequence covers, so the subject is a SEQUENCE and not a state. A `test()` per input would boot a core per
 * input — `world` mints a room per test — and the adjacency, which is the entire point, would be gone. So the
 * loop runs inside one test, the invariants are re-evaluated after EVERY input, and a violation is reported
 * through `expect.soft` so the whole run still prints its summary before the test fails.
 *
 * THE SEED IS THE PRODUCT. `FUZZ_SEED` must replay a run INPUT FOR INPUT or a reported seed reproduces
 * nothing and the tool is worthless. mulberry32, the `pick`/`int` wrappers, the deterministic `fuzzId`, and —
 * most importantly — the ORDER and the COUNT of `rnd()` calls at every call site are fixed (changing
 * either breaks every seed in `fuzz-seeds.ts`): `drawInput` spends exactly one draw, `driveInput` spends
 * one for the phone index before it spends anything else, and each input's own draws follow in a fixed order. Nothing here may read `Math.random` or
 * the clock. The seed is printed first, in the summary, and in every failure message.
 *
 * WHICH SEEDS RUN. `FUZZ_SEED` replays that one seed. Without it, the run replays `fuzz-seeds.ts`, one test per
 * seed: the seeds that broke an invariant once, so a PR run is the same run every time and a found bug stays
 * found. `FUZZ_RANDOM=1` draws a fresh seed instead, which is what the nightly job does to look for new ones.
 *
 * THE ASYNCHRONY SPLIT IS BY DESIGN. I2/I3/I5 are CROSS-SURFACE — a value has to cross the server's socket,
 * the TV and two phones — so they are retried against FRESH snapshots until they hold or CROSS_MS runs out.
 * I1/I4/I6 are single-surface and read ONCE. Polling everything would hide a real violation behind a retry;
 * reading everything once would manufacture violations out of propagation delay.
 *
 * I6 CANNOT BE DROPPED OR WEAKENED. `webkitAudioDecodedByteCount` must CLIMB whenever the UI claims to be
 * playing, sampled twice DECODE_GAP_MS apart. A run which never managed to EVALUATE I6 is not green:
 * that is an assertion, so such a run FAILS and names the reason.
 * It never passes, and it never skips: this repo already ruled that a permanently-skipped test is
 * indistinguishable from the rot it was meant to catch.
 *
 * NO AUTOPLAY GRANT. `--autoplay-policy=no-user-gesture-required` is never passed: a television grants no
 * gesture, so a relaxed policy proves playback in an environment the product never ships into
 * (docs/E2E.md#autoplay). The playhead is bought the way p14 buys it — ONE REAL `mouse.click` on the TV, which
 * is the only thing that counts as activation; a synthetic `el.click()` is untrusted and grants none. The
 * gestureless arm of `autoplayRefused()` below is what keeps a REFUSING browser from reporting a phantom I6;
 * on this box nothing actually refuses (see world/autoplay.ts), so it stays quiet.
 *
 * `world` boots a core per test with a seeded MEDIA_DIR and tears both down, and `startFakeWorker` publishes
 * the real audio and the real word-level lyrics that I4 and I6 need something to measure. Fault injection is
 * a TYPED option (see FAULTS) rather than an env string.
 *
 * THREE DRIVER RULES — none touches an invariant, a weight or a draw.
 *
 * ONE: `queue-add` RETURNS to `/queue`, where this phone's `.qrow` counts apply. Left in the SEARCH view, or
 * on the Sing tab (which renders no `.qrow` at all), the phone shows ZERO `.qrow` while the server's waiting
 * set grows — a FALSE I5, manufactured by the driver. The transport is in the dock on every surface, so the
 * taps still apply from there. `restOnQueue` and `openSearch` below are the two route helpers that implement
 * it, and they `goto` rather than clicking the strip's link so a replay cannot branch on whether a strip was
 * rendered.
 *
 * TWO: the catalogue is sorted BY ID before anything picks from it (see `byId`). Without it a seed replays the
 * same index into an array the room hands back in a different order, so two runs of one seed agree on every
 * actor, input, seam and number and disagree on WHICH SONG — which is a replay in name only.
 *
 * THREE: LEAD_SEC reads `settings.room.lyricsLeadMs` off the sync frame — the frame carries
 * `EffectiveSettings = { global, room }` and the lead is a ROOM setting; a bare `settings.lyricsLeadMs`
 * resolves `undefined` — and falls back to `DEFAULT_LYRICS_LEAD_MS`, so I4's window is centred on the lead
 * the room actually applies and cannot drift from the contract. (`schema.ts`'s `.default(300)` on the column
 * is dead: no insert reaches it because `setRoom` names every field.)
 *
 * `__fzRev` is tracked with a comment about carrying a "real baseRev" when the contract has no baseRev on a
 * queue command at all and nothing sends one; it is left as is rather than tidied.
 */
import { test, expect } from '../../world/fixtures';
import type { Page, TestInfo } from '@playwright/test';
// `ws`, not the global: the same choice world/workers.ts makes, and for the same reason — a failed upgrade is
// legible here rather than an opaque error event.
import { WebSocket } from 'ws';
import { SEL } from '../../world/selectors';
import { openBrowseFromHome, openQueue } from '../../world/actors';
import { startFakeWorker, type FakeWorkerFaults } from '../../world/workers';
import type { World } from '../../world/fixtures';
import { DEFAULT_LYRICS_LEAD_MS } from '$lib/contract';
import { KNOWN_SEEDS, type InvariantId, type KnownSeed } from './fuzz-seeds';

// ─────────────────────────────────────────────────────────────────────────────
// Seed and knobs.
// ─────────────────────────────────────────────────────────────────────────────

/** `FUZZ_SEED`, or null when it is unset or unparseable (then the known seeds run, or `FUZZ_RANDOM` draws one). */
const ENV_SEED = Number.isFinite(Number(process.env.FUZZ_SEED)) ? Number(process.env.FUZZ_SEED) >>> 0 : null;

/** Tens, not thousands — a human must be able to replay it. */
const ENV_INPUTS = Number(process.env.FUZZ_INPUTS ?? 24);

/** This run's seed and length, set by `startRun()`: one module runs a test per known seed. */
let SEED = 0;
let N_INPUTS = ENV_INPUTS;

/** The line a reader copies to reproduce this run. Printed first, and again beside every violation. */
let REPLAY = '';

/**
 * Let one input LAND before the single-surface invariants read it. A MEASUREMENT INTERVAL, not a stand-in for
 * auto-waiting: I1 is a claim about `currentTime` between two moments, so the moments have to be spaced, and
 * I4 compares a rendered highlight against a playhead that has to have moved for the comparison to mean
 * anything. Reading immediately would manufacture violations out of nothing having happened yet.
 */
const SETTLE_MS = 700;
/** Budget for a CROSS-SURFACE value to propagate before it counts as a violation. */
const CROSS_MS = 3_000;
/** Pacing between cross-surface retries. Each retry is a fresh snapshot, not a re-read of a stale one. */
const CROSS_RETRY_MS = 250;
/**
 * THE I6 MEASUREMENT INTERVAL — "sample twice, seconds apart". This is a measurement of a continuous quantity
 * and NOT a workaround for anything, which is why it stays a dwell rather than becoming a poll: the claim is
 * that the decoder consumed bytes BETWEEN two moments, so the moments must be spaced on the wall clock.
 */
const DECODE_GAP_MS = 1_500;
/** Ceiling on waiting for the one real tap to reach the decoder. Bounded, and it returns the moment it does. */
const TAP_SETTLE_MS = 1_200;
/** Ceiling on waiting for the opening add to actually be playing before the tap decision is made. */
const FIRST_PLAYBACK_MS = 20_000;
/** Setup (core boot, three processes, two phones and a TV) plus a generous per-input cost. */
const timeBudgetMs = (inputs: number): number => 240_000 + inputs * 20_000;

/**
 * FAULT INJECTION, as typed options on the fake worker rather than env strings — one per row
 * of docs/E2E.md#fault-injection. Empty by default, the healthy worker: `silentVocals`,
 * `skipWrite`, `noProfile`, `noVocals`, `fail: 'stems' | 'align' | …`, `slowMs`, `silentInstrumental`, and
 * `guideMix` (the ONLY way `guide` inputs reach the enabled arm — `hasGuidingTrack()` reads `guideMixRef`).
 * Set one here to fuzz an unhappy path; leaving it empty keeps this run comparable to every other seed.
 */
const FAULTS: FakeWorkerFaults = {};

// ─────────────────────────────────────────────────────────────────────────────
// Types. Only the fields this flow reads, as with every other spec in the tree.
// ─────────────────────────────────────────────────────────────────────────────

type InputName = keyof typeof BASE_WEIGHT;

/** Everything driven so far, in order — this list IS the reproduction recipe. */
interface Step {
	who: string;
	input: string;
	detail: string;
	noop?: boolean;
	seam?: string | null;
}

interface Violation {
	id: InvariantId;
	title: string;
	observed: string;
	expected: string;
	context: string;
}

/** One media element on the TV, as the probe reads it. */
interface MediaEl {
	tag: string;
	src: string;
	readyState: number;
	paused: boolean;
	muted: boolean;
	volume: number;
	currentTime: number;
	duration: number;
	decoded: number | null;
	error: { code: number; message: string } | null;
}

/** Everything the TV can tell us, in one round trip. */
interface TvState {
	rows: MediaEl[];
	nowSong: string | null;
	nowName: string | null;
	lowerThird: boolean;
	attract: boolean;
	connected: boolean;
	activeWord: string | null;
	activeWordRaw: string | null;
}

interface Entry {
	id: string;
	mediaId: string;
	status: string;
	rotationSeq?: number;
}

interface Media {
	id: string;
	source?: string;
	title?: string;
	instrumentalRef?: string;
	lyricsRef?: string;
}

interface Playback {
	currentEntryId?: string | null;
	isPlaying?: boolean;
	positionSec?: number;
	keyShift?: number;
	guideLevel?: number | null;
}

/**
 * THE REAL FRAME SHAPE. `queue:sync` carries `EffectiveSettings = { global, room }` and the lead is a ROOM
 * setting, so it is read at `settings.room.lyricsLeadMs`. Partial and optional throughout because this is a
 * wire snapshot, not the contract type: a frame that arrives before settings are published has neither half,
 * and only the one field I4 needs is named — widening this to the real `EffectiveSettings` would make every
 * unrelated settings change a compile error in the fuzz driver.
 */
interface Settings {
	room?: { lyricsLeadMs?: number };
}

interface ServerSnapshot {
	rev?: number;
	entries?: Entry[];
	media?: Media[];
	settings?: Settings | null;
	playback?: Playback;
}

/** One frame off the probe socket. */
interface Frame {
	type?: string;
	rev?: number;
	entries?: Entry[];
	media?: Media[];
	settings?: Settings | null;
	state?: Playback;
}

interface Catalog {
	ready: Media[];
	processing: Media[];
	raw: Media[];
}

/** What a DRAW is conditioned on — a lighter thing than the whole room. */
interface WorldLite {
	current: Entry | null;
	waiting: number;
	processing: number;
}

/** One complete reading of the room: server, TV, catalogue. */
interface Room {
	srv: ServerSnapshot;
	tv: TvState;
	cat: Catalog;
	mediaById: Map<string, Media>;
	current: Entry | null;
	curMedia: Media | null;
	master: MediaEl | null;
	masterHow: string;
	waiting: number;
	playing: Entry[];
	processing: number;
}

interface LyricWord {
	word: string;
	start: number;
	end: number;
}
interface LyricLine {
	start: number;
	end?: number;
	words?: LyricWord[];
}
interface LyricsDoc {
	lines: LyricLine[];
}

/**
 * The phone's own authenticated socket, parked on `window` between inputs. Structural rather than the DOM
 * `WebSocket` or `ws`'s: this type is read on BOTH sides of a `page.evaluate` boundary, and only these two
 * members cross it.
 */
interface FuzzSocket {
	readyState: number;
	send(data: string): void;
}
interface FuzzWindow {
	__fz?: FuzzSocket;
	__fzRev?: number;
	__fzRejects?: string[];
	/** The room's current entry, which a seek must name or the server drops it as stale. */
	__fzCurrent?: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The PRNG. Every random decision goes through `rnd`, so a seed reproduces the sequence exactly.
// ─────────────────────────────────────────────────────────────────────────────

/** mulberry32, carried across unchanged — a different generator is a different run for the same seed. */
function mulberry32(a: number): () => number {
	return function () {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * MUTABLE, and reset by `startRun()` rather than initialised once at import. A Playwright worker keeps module
 * state across a RETRY, so a `const` here would replay a retry from wherever the first attempt left the
 * generator — which is the one thing the seed exists to prevent.
 */
let rnd = mulberry32(0);
const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];
const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
/** A deterministic Crockford-ish id, so even the clientOpIds a replay sends are identical. */
let idCounter = 0;
const fuzzId = (): string =>
	`FZ${SEED.toString(32).toUpperCase()}${(idCounter++).toString(32).toUpperCase().padStart(4, '0')}`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// Run state. All of it reset by startRun(), for the retry reason above.
// ─────────────────────────────────────────────────────────────────────────────

const sequence: Step[] = [];
const stats: Record<InvariantId, { checked: number; skipped: number; why: Set<string> }> = {
	I1: { checked: 0, skipped: 0, why: new Set() },
	I2: { checked: 0, skipped: 0, why: new Set() },
	I3: { checked: 0, skipped: 0, why: new Set() },
	I4: { checked: 0, skipped: 0, why: new Set() },
	I5: { checked: 0, skipped: 0, why: new Set() },
	I6: { checked: 0, skipped: 0, why: new Set() }
};
const INVARIANT_IDS: InvariantId[] = ['I1', 'I2', 'I3', 'I4', 'I5', 'I6'];

/** I1's previous sample. */
let lastPos: { entryId: string | null; t: number | null } = { entryId: null, t: null };
/**
 * The entry id I4 last evaluated against — the reel re-syncs off a broadcast after a song change, so the first
 * read on a new entry sees the OLD reel and is propagation, not a defect.
 */
let lastLyricsEntry: string | null = null;
/** First decoded byte-count seen per src — the floor a blocked TV never exceeds. See atPreloadFloor(). */
const preloadFloor = new Map<string, number>();
/** Set true once maybeDeliverTap() delivers the run's single real gesture. */
let tapped = false;
/** RAW rows are not listed by /api/library and an empty query returns nothing, so they are discovered once. */
let rawSeen: Map<string, Media> | null = null;
/** Lyrics docs, fetched once per ref from the same /media route the TV overlay reads. */
const lyricsCache = new Map<string, LyricsDoc | null>();

/** Lead applied to the lyrics highlight, in seconds — the reel is cued AHEAD of the playhead. Seeded from the
 *  CONTRACT default rather than a literal, so the room's default and I4's window cannot drift apart; the run
 *  overwrites it with what the server actually reports. */
let LEAD_SEC = DEFAULT_LYRICS_LEAD_MS / 1000;
let base = '';
let wsBase = '';
let tv: Page;
const phones: Page[] = [];

function startRun(seed: number, inputs: number): void {
	SEED = seed;
	N_INPUTS = inputs;
	REPLAY = `FUZZ_SEED=${SEED} FUZZ_INPUTS=${N_INPUTS} bunx playwright test tests/playwright/specs/flow/fuzz.spec.ts`;
	rnd = mulberry32(SEED);
	idCounter = 0;
	sequence.length = 0;
	for (const id of INVARIANT_IDS) {
		stats[id].checked = 0;
		stats[id].skipped = 0;
		stats[id].why.clear();
	}
	lastPos = { entryId: null, t: null };
	lastLyricsEntry = null;
	preloadFloor.clear();
	tapped = false;
	rawSeen = null;
	lyricsCache.clear();
	LEAD_SEC = DEFAULT_LYRICS_LEAD_MS / 1000;
	phones.length = 0;
}

function skip(id: InvariantId, why: string): null {
	stats[id].skipped++;
	stats[id].why.add(why);
	return null;
}

function ok(id: InvariantId): null {
	stats[id].checked++;
	return null;
}

function violation(id: InvariantId, title: string, observed: string, expected: string, context = ''): Violation {
	return { id, title, observed, expected, context };
}

// ─────────────────────────────────────────────────────────────────────────────
// The catalogue.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * READY and PROCESSING come from `/api/library`, whose `processing` list is the SERVER's own `readinessOf()`
 * verdict rather than a guess at a `stemStatus` string. RAW rows are not listed there and an EMPTY query
 * returns nothing, so they are discovered once up front with short queries pinned to `source=local`; they
 * matter because `sing` on a raw song is the ONLY way to put a process in flight.
 *
 * `source=local` narrows which RESOLVERS run and does not filter the rows, so the `row.source === 'local'`
 * test below is load-bearing rather than defensive.
 */
const RAW_PROBE_TERMS = ['a', 'e', 'i', 'o', 'u', 's', 'b', 'd', 'l', 'm', 'n', 'r', 't', 'w'];

/**
 * BY ID, and this is what makes `FUZZ_SEED` a replay rather than a suggestion.
 *
 * `pick(ready)` spends exactly one `rnd()` and takes `arr[floor(r * arr.length)]`, so the INDEX is already
 * deterministic — but `/api/library`'s `library` is a SQL result whose row order is not specified, and three
 * songs finish processing in whatever order the worker got to them. Measured: two runs of seed 777 agreed on
 * every actor, every input, every seam and every number, and disagreed on the SONG at steps 7 and 14 — the
 * same index into two differently-ordered arrays. Sorting costs no draw and moves no call site; it just stops
 * the room's row order from leaking into the decision stream.
 */
const byId = (rows: Media[]): Media[] => rows.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

async function catalog(): Promise<Catalog> {
	const lib = (await fetch(`${base}/api/library`).then((x) => x.json())) as {
		library?: Media[];
		processing?: { media?: Media }[];
	};
	const ready = (lib.library ?? []).filter((m) => m.source === 'local');
	const processing = (lib.processing ?? []).map((c) => c.media).filter((m): m is Media => !!m && m.source === 'local');
	const known = new Set([...ready, ...processing].map((m) => m.id));

	if (rawSeen === null) {
		rawSeen = new Map();
		for (const term of RAW_PROBE_TERMS) {
			try {
				const r = (await fetch(`${base}/api/search?q=${encodeURIComponent(term)}&source=local`).then((x) =>
					x.json()
				)) as { ready?: Media[]; results?: Media[] };
				for (const row of [...(r.ready ?? []), ...(r.results ?? [])]) {
					if (row.source === 'local' && !known.has(row.id)) rawSeen.set(row.id, row);
				}
			} catch {
				/* a term that will not resolve just contributes no rows */
			}
		}
	}
	const raw = [...rawSeen.values()].filter((m) => !known.has(m.id));
	return { ready: byId(ready), processing: byId(processing), raw: byId(raw) };
}

/**
 * Two processed songs give a rotation, so `skip` has somewhere to land and I3 something to disagree about.
 * The fake worker does the actual separating and aligning; this only asks.
 */
async function processSongs(world: World, want: number): Promise<Media[]> {
	const c0 = await catalog();
	if (c0.ready.filter((r) => r.lyricsRef).length >= want) return c0.ready;

	// /api/process refuses an anonymous caller, and rightly — no anonymous compute. This singer holds no
	// socket, so it never even counts as `here`.
	const joinRes = await fetch(`${base}/api/join`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ displayName: 'FuzzProcessor', color: '#ff5cae' })
	});
	if (!joinRes.ok) {
		throw new Error(`could not join to process a song (${joinRes.status}).\n\n${world.core.log()}`);
	}
	const cookie = joinRes.headers.get('set-cookie')?.split(';')[0] ?? '';

	let processed = c0.ready.length;
	const attempts: string[] = [];
	for (const row of c0.raw) {
		if (processed >= want) break;
		const res = await fetch(`${base}/api/process`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie },
			body: JSON.stringify({ mediaId: row.id })
		});
		const body = await res.text().catch(() => '');
		attempts.push(`${row.title}→${res.status}${res.ok ? '' : ` ${body.slice(0, 80)}`}`);
		if (res.ok) processed++;
	}
	console.log(
		`process: discovered ${c0.raw.length} raw local row(s); requested ${attempts.length} — ${attempts.join('; ')}`
	);

	// The stems job chains an align job, so readiness arrives a few seconds later. Polled rather than slept
	// on: the worker's latency is not a number this file can know.
	let ready: Media[] = [];
	await expect
		.poll(
			async () => {
				ready = (await catalog()).ready.filter((r) => r.lyricsRef);
				return ready.length;
			},
			{
				timeout: 42_000,
				message:
					`no song reached READY with a lyrics artifact, so there is nothing to sing and no playback ` +
					`invariant means anything.\n\n${world.core.log()}`
			}
		)
		.toBeGreaterThanOrEqual(Math.min(want, 2));
	return ready;
}

// ─────────────────────────────────────────────────────────────────────────────
// Authoritative server state.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A `hello` replies with one consistent snapshot. Read on a FRESH short-lived socket per snapshot rather than
 * mirrored from a long-lived one — a mirror would re-implement the clients' rev/patch reconciliation, and a
 * bug in the mirror would look exactly like a bug in the room.
 */
function serverSnapshot(timeoutMs = 4_000): Promise<ServerSnapshot> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`${wsBase}/ws?role=probe`);
		const out: ServerSnapshot = {};
		let done = false;
		const finish = (err?: Error): void => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			try {
				ws.close();
			} catch {
				/* already closed, or never opened */
			}
			if (err) reject(err);
			else resolve(out);
		};
		const timer = setTimeout(() => finish(new Error('server snapshot timed out')), timeoutMs);
		ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', lastRev: 0 })));
		ws.on('message', (raw: Buffer | string) => {
			let e: Frame;
			try {
				e = JSON.parse(String(raw)) as Frame;
			} catch {
				return;
			}
			if (e.type === 'queue:sync') {
				out.rev = e.rev;
				out.entries = e.entries ?? [];
				out.media = e.media ?? [];
				out.settings = e.settings ?? null;
			}
			if (e.type === 'playback:state') out.playback = e.state;
			if (out.entries && out.playback) finish();
		});
		ws.on('error', () => finish(new Error('server snapshot socket error')));
	});
}

/** Lyrics docs, fetched once per ref from the same /media route the TV overlay reads. */
async function lyricsFor(ref: string | null | undefined): Promise<LyricsDoc | null> {
	if (!ref) return null;
	const cached = lyricsCache.get(ref);
	if (cached !== undefined) return cached;
	let doc: LyricsDoc | null = null;
	try {
		const j = (await fetch(`${base}/media/${ref}`).then((r) => (r.ok ? r.json() : null))) as LyricsDoc | null;
		if (j && Array.isArray(j.lines)) doc = j;
	} catch {
		/* a missing or malformed artifact reads as "no lyrics", which every caller handles */
	}
	lyricsCache.set(ref, doc);
	return doc;
}

// ─────────────────────────────────────────────────────────────────────────────
// The TV.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The TV's on-stage master element. The gapless controller mounts TWO slots and the hidden one pre-warms the
 * next song with its own paused <audio>, so "any audio with an instrumental src" can read a permanently silent
 * element as the stage. Matched against the SERVER's own instrumentalRef instead; when that cannot be resolved
 * the fallback is RECORDED, so a skipped check is never read as a pass.
 */
function pickMaster(rows: MediaEl[], wantRef: string | undefined): { master: MediaEl | null; how: string } {
	const instrumentals = rows.filter((r) => r.src.includes('instrumental'));
	if (wantRef) {
		const matched = instrumentals.filter((r) => r.src.includes(wantRef));
		if (matched.length === 1) return { master: matched[0], how: 'src matches server instrumentalRef' };
		if (matched.length > 1) {
			// Two elements on the same song: the pre-warm slot for a repeat. Take the advanced one.
			const best = matched.slice().sort((a, b) => b.currentTime - a.currentTime)[0];
			return { master: best, how: 'two elements on the server song; took the advanced one' };
		}
	}
	if (instrumentals.length === 0) return { master: null, how: 'no instrumental element mounted' };
	const best = instrumentals.slice().sort((a, b) => b.currentTime - a.currentTime)[0];
	return { master: best, how: 'fallback: furthest-advanced instrumental element' };
}

/** Everything the TV can tell us, in ONE round trip. Only contract selectors are used in here. */
async function readTv(page: Page): Promise<TvState> {
	return page.evaluate(
		(sel) => {
			const rows = [...document.querySelectorAll<HTMLMediaElement>(sel.mediaEl)].map((el) => ({
				tag: el.tagName,
				src: el.currentSrc || el.src || '',
				readyState: el.readyState,
				paused: el.paused,
				muted: el.muted,
				volume: el.volume,
				currentTime: el.currentTime,
				duration: el.duration,
				decoded:
					(el as HTMLMediaElement & { webkitAudioDecodedByteCount?: number }).webkitAudioDecodedByteCount ?? null,
				error: el.error ? { code: el.error.code, message: el.error.message } : null
			}));
			const t = (selector: string): string | null => {
				const el = document.querySelector(selector);
				return el ? (el.textContent ?? '').trim() : null;
			};
			const activeWordEl = document.querySelector(sel.activeWord);
			// The bouncing ball is an aria-hidden CHILD of the active word span, so textContent reads its glyph
			// too: the word a PERSON reads is the concatenation of the children that are not hidden.
			const wordText = activeWordEl
				? [...activeWordEl.childNodes]
						.filter((n) => !(n.nodeType === 1 && (n as Element).getAttribute('aria-hidden') === 'true'))
						.map((n) => n.textContent ?? '')
						.join('')
						.trim()
				: null;
			return {
				rows,
				nowSong: t(sel.nowSong),
				nowName: t(sel.nowName),
				lowerThird: document.querySelector(sel.lowerThird) !== null,
				attract: document.querySelector(sel.attract) !== null,
				connected: document.querySelector(sel.tvConnected) !== null,
				activeWord: wordText,
				activeWordRaw: activeWordEl ? (activeWordEl.textContent ?? '').trim() : null
			};
		},
		{
			mediaEl: SEL.mediaEl,
			nowSong: SEL.nowSong,
			nowName: SEL.nowName,
			lowerThird: SEL.lowerThird,
			attract: SEL.attract,
			tvConnected: SEL.tvConnected,
			activeWord: SEL.activeWord
		}
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// The phone's own wire.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A phone's own authenticated socket, opened ONCE and kept. A wire-substituted input goes out from THIS socket
 * so the server resolves the same singerId from the same session cookie and runs the same authorization.
 *
 * `__fzRev` and `__fzRejects` are kept and neither is read — the rev is said to be tracked "so a queue command carries a real baseRev", but the contract has no baseRev on a queue
 * command (src/lib/contract/core/ops.ts) and nothing sends one. Reported rather than tidied.
 */
async function openWire(page: Page): Promise<void> {
	await page.evaluate(
		() =>
			new Promise<string>((res, rej) => {
				const w = window as unknown as FuzzWindow;
				if (w.__fz && w.__fz.readyState === 1) return res('reused');
				const proto = location.protocol === 'https:' ? 'wss' : 'ws';
				const s = new WebSocket(`${proto}://${location.host}/ws?role=phone`);
				w.__fzRev = 0;
				w.__fzRejects = [];
				s.onmessage = (ev) => {
					try {
						const e = JSON.parse(String(ev.data));
						if (e.type === 'queue:sync') w.__fzRev = e.rev;
						else if (e.type === 'queue:patch') w.__fzRev = e.patch.rev;
						else if (e.type === 'op:reject') w.__fzRejects?.push(e.reason);
						else if (e.type === 'playback:state') w.__fzCurrent = e.state.currentEntryId;
					} catch {
						/* a frame this socket does not model */
					}
				};
				s.onopen = () => {
					w.__fz = s;
					s.send(JSON.stringify({ type: 'hello', lastRev: 0 }));
					res('open');
				};
				s.onerror = () => rej(new Error('the fuzz socket would not open'));
				setTimeout(() => rej(new Error('the fuzz socket timed out')), 5_000);
			})
	);
}

async function wirePlayer(page: Page, command: Record<string, unknown>): Promise<string> {
	return page.evaluate((cmd) => {
		const w = window as unknown as FuzzWindow;
		if (!w.__fz || w.__fz.readyState !== 1) return 'closed';
		const frame = ['seek', 'key', 'guide'].includes(String(cmd.cmd)) ? { ...cmd, entryId: w.__fzCurrent } : cmd;
		w.__fz.send(JSON.stringify({ type: 'player:command', command: frame }));
		return 'sent';
	}, command);
}

async function wireQueueOp(page: Page, op: Record<string, unknown>, opId: string): Promise<string> {
	return page.evaluate(
		({ op, opId }) => {
			const w = window as unknown as FuzzWindow;
			if (!w.__fz || w.__fz.readyState !== 1) return 'closed';
			w.__fz.send(JSON.stringify({ type: 'queue:command', command: { clientOpId: opId, op } }));
			return 'sent';
		},
		{ op, opId }
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// The input alphabet and the adjacency bias.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `back` is absent DELIBERATELY — it exists nowhere in the server, so mapping it onto `restart` would read as
 * evidence about a back button. A starting point the adjacency bias below reshapes.
 */
const TRANSPORT = new Set<string>(['pause', 'resume', 'skip', 'restart', 'seek']);
const BASE_WEIGHT = {
	pause: 3,
	resume: 3,
	skip: 3,
	restart: 3,
	seek: 2,
	key: 2,
	guide: 2,
	'queue-add': 3,
	'queue-remove': 2
};

/**
 * The draw is conditioned on what just happened AND on what the room is doing, so the named seams get hit:
 * back-to-back transport is tripled, a process in flight favours `restart` and `queue-remove`, and nothing
 * waiting favours `skip`.
 */
function weightsFor(prev: InputName | null, world: WorldLite): Record<InputName, number> {
	const w: Record<InputName, number> = { ...BASE_WEIGHT };
	if (prev && TRANSPORT.has(prev)) for (const k of TRANSPORT) w[k as InputName] *= 3;
	if (world.processing > 0) {
		w.restart *= 6;
		w['queue-remove'] *= 3;
	}
	if (world.current && world.waiting === 0) w.skip *= 6;
	if (prev === 'restart') w.pause *= 6;
	if (world.waiting + (world.current ? 1 : 0) === 0) {
		// An empty room can only meaningfully be filled.
		for (const k of Object.keys(w) as InputName[]) w[k] = k === 'queue-add' ? 10 : 0;
	}
	return w;
}

/** ONE `rnd()` call, always — the draw's cost in the stream must not depend on the weights. */
function drawInput(prev: InputName | null, world: WorldLite): InputName {
	const w = weightsFor(prev, world);
	const keys = (Object.keys(w) as InputName[]).filter((k) => w[k] > 0);
	const total = keys.reduce((s, k) => s + w[k], 0);
	let r = rnd() * total;
	for (const k of keys) {
		r -= w[k];
		if (r <= 0) return k;
	}
	return keys[keys.length - 1];
}

/** Which seam, if any, this draw was biased toward — printed in the sequence so a replay reads clearly. */
function seamLabel(input: InputName, prev: InputName | null, world: WorldLite): string | null {
	if (input === 'restart' && world.processing > 0) return 'RESTART-DURING-PROCESS';
	if (input === 'skip' && world.current && world.waiting === 0) return 'SKIP-AT-LAST-ENTRY';
	if (input === 'pause' && prev === 'restart')
		return 'RESTART-THEN-PAUSE (stands in for back-then-pause; `back` does not exist)';
	return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading the room.
// ─────────────────────────────────────────────────────────────────────────────

const RESETS_POSITION = new Set<string>(['seek', 'restart', 'skip']);

async function readRoom(): Promise<Room> {
	const srv = await serverSnapshot();
	const tvState = await readTv(tv);
	const cat = await catalog();
	const mediaById = new Map((srv.media ?? []).map((m) => [m.id, m]));
	const cur = (srv.entries ?? []).find((e) => e.id === srv.playback?.currentEntryId) ?? null;
	const curMedia = cur ? (mediaById.get(cur.mediaId) ?? null) : null;
	const { master, how } = pickMaster(tvState.rows, curMedia?.instrumentalRef);
	// The FIRST decoded byte-count seen for this src; see atPreloadFloor().
	if (master && master.decoded !== null && master.decoded !== undefined && !preloadFloor.has(master.src)) {
		preloadFloor.set(master.src, master.decoded);
	}
	return {
		srv,
		tv: tvState,
		cat,
		mediaById,
		current: cur,
		curMedia,
		master,
		masterHow: how,
		waiting: (srv.entries ?? []).filter((e) => e.status === 'queued').length,
		playing: (srv.entries ?? []).filter((e) => e.status === 'playing'),
		processing: cat.processing.length
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// The invariants (docs/E2E.md#the-fuzz-invariants). MOVED, not rewritten.
// ─────────────────────────────────────────────────────────────────────────────

/** I2 · exactly one entry is `playing`. */
function checkI2(w: Room): Violation | null {
	const n = w.playing.length;
	if (n > 1) {
		return violation(
			'I2',
			'two or more queue entries are in state `playing` at once',
			`${n} playing: ${w.playing.map((e) => `${e.id}(seq ${e.rotationSeq})`).join(', ')}`,
			'exactly one entry may be `playing`'
		);
	}
	const tvRendersASong = w.tv.lowerThird || !!w.tv.nowSong;
	if (n === 0) {
		if (tvRendersASong) {
			return violation(
				'I2',
				'the TV renders a song while NO entry is in state `playing`',
				`playing=0, tv.nowSong=${JSON.stringify(w.tv.nowSong)}, tv.lowerThird=${w.tv.lowerThird}`,
				'an entry must be `playing` whenever the TV shows one'
			);
		}
		return skip('I2', 'nothing playing and the TV renders no song (an idle room is not a violation)');
	}
	return ok('I2');
}

/** I3 · the TV's RENDERED now-playing equals the SERVER's currentEntryId. */
function checkI3(w: Room): Violation | null {
	if (!w.current) {
		if (w.tv.nowSong) {
			return violation(
				'I3',
				'the TV names a song while the server has no current entry',
				`tv.ls-song=${JSON.stringify(w.tv.nowSong)}`,
				'server.currentEntryId=null → the TV must render no now-playing'
			);
		}
		return skip('I3', 'the server has no current entry and the TV names none');
	}
	if (!w.curMedia) return skip('I3', 'the server current entry resolves to no media row');
	if (!w.tv.nowSong) {
		return violation(
			'I3',
			'the server has a current entry but the TV renders no now-playing',
			'tv.ls-song=null',
			`server.currentEntryId=${w.current.id} → media ${JSON.stringify(w.curMedia.title)}`
		);
	}
	// The lower third prints the TITLE — the rendered string a person in the room sees.
	const want = String(w.curMedia.title ?? '');
	const got = String(w.tv.nowSong);
	if (!(got === want || got.includes(want) || want.includes(got))) {
		return violation(
			'I3',
			"the TV's rendered now-playing disagrees with the server's current entry",
			`tv.ls-song=${JSON.stringify(got)}`,
			`server.currentEntryId=${w.current.id} → media ${JSON.stringify(want)}`
		);
	}
	if (w.master && w.curMedia.instrumentalRef && !w.master.src.includes(w.curMedia.instrumentalRef)) {
		return violation(
			'I3',
			'the TV title agrees but the audio on stage is a DIFFERENT song',
			`master.src=${w.master.src} (picked: ${w.masterHow})`,
			`server current instrumentalRef=${w.curMedia.instrumentalRef}`
		);
	}
	return ok('I3');
}

/**
 * THE PHONE'S RESTING SURFACE. `.qrow` is on /queue, so that is where a phone waits between inputs — see the
 * header. Clears any query first, because a phone left holding one is a phone whose Sing tab shows results rather
 * than its idle state, and a later `openSearch` would then be re-running somebody else's query.
 */
async function restOnQueue(page: Page): Promise<void> {
	if ((await page.locator(SEL.clearSearch).count()) > 0) await page.locator(SEL.clearSearch).first().click();
	await page.goto('/queue');
	await page.locator(SEL.pageHeading).first().waitFor({ state: 'attached', timeout: 15_000 });
}

/** The search field is a field ON the Sing tab, so reaching it from the resting surface is a route change. */
async function openSearch(page: Page): Promise<void> {
	if (new URL(page.url()).pathname !== '/') await page.goto('/');
	await openBrowseFromHome(page);
}

/** I5 · no entry is both playing and waiting; the phones' rotation agrees with the server. */
async function checkI5(w: Room): Promise<Violation | null> {
	// The server models status as ONE field, so "both at once" can only appear as a disagreement: either the
	// current entry is not marked playing, or something marked playing is not the current.
	if (w.current && w.current.status !== 'playing') {
		return violation(
			'I5',
			'the current entry is not in state `playing` (it is waiting while the room treats it as current)',
			`entry ${w.current.id} status=${w.current.status}`,
			'the server current entry must be `playing`'
		);
	}
	for (const e of w.playing) {
		if (w.srv.playback?.currentEntryId !== e.id) {
			return violation(
				'I5',
				'an entry is `playing` that the server does not consider current',
				`entry ${e.id} status=playing, currentEntryId=${w.srv.playback?.currentEntryId}`,
				'only the current entry may be `playing`'
			);
		}
	}
	// The rotation VIEW: /queue renders exactly the entries whose status is `queued` (a QueueRow or a
	// ProcessingCard, both carrying .qrow), so a count mismatch means a phone is showing a rotation the server
	// does not have. The phones REST on /queue for this reason — see `restOnQueue` and the header.
	for (let i = 0; i < phones.length; i++) {
		const n = await phones[i].locator(SEL.queueRow).count();
		if (n !== w.waiting) {
			return violation(
				'I5',
				`phone${i + 1}'s rendered rotation disagrees with the server's waiting set`,
				`phone${i + 1} renders ${n} ${SEL.queueRow} rows`,
				`server has ${w.waiting} entries with status=queued`,
				`server entries: ${(w.srv.entries ?? []).map((e) => `${e.id.slice(-6)}:${e.status}`).join(' ')}`
			);
		}
	}
	return ok('I5');
}

/** I1 · currentTime monotonic within a song. */
function checkI1(w: Room, lastInput: InputName): Violation | null {
	if (!w.master) return skip('I1', 'no master element on stage to measure');
	const t = w.master.currentTime;
	const id = w.current?.id ?? null;
	const prev = lastPos;
	lastPos = { entryId: id, t };
	if (prev.t === null) return skip('I1', 'first sample — nothing to compare against');
	if (prev.entryId !== id) return skip('I1', 'the entry changed, so a lower currentTime is expected');
	if (RESETS_POSITION.has(lastInput)) return skip('I1', `the input was \`${lastInput}\`, an intentional discontinuity`);
	if (t < prev.t - 0.25) {
		return violation(
			'I1',
			'currentTime went BACKWARDS within one song, with no seek, restart or entry change',
			`currentTime ${prev.t.toFixed(2)} → ${t.toFixed(2)} on entry ${id}`,
			`currentTime >= ${prev.t.toFixed(2)} (a fall is only legal across seek/restart/entry change)`,
			`last input was \`${lastInput}\``
		);
	}
	return ok('I1');
}

/**
 * Whether a silent master is EXCUSABLE — shared by I4 and I6 so the two cannot drift. The predicate for "not
 * started yet" is NOT `currentTime === 0`: a `seek` on a blocked master moves the playhead off 0 while the
 * element stays paused, turning every gestureless seek into a phantom I6. Key on the DECODER not having passed
 * the preload burst recorded for this src, which survives a skip mounting a fresh element too.
 */
function atPreloadFloor(w: Room): boolean {
	const m = w.master;
	if (!m) return false;
	const d = m.decoded;
	// FALSE deliberately: fail toward measuring audio rather than toward excusing an unreadable state.
	if (d === null || d === undefined) return false;
	const floor = preloadFloor.get(m.src);
	return floor !== undefined && d <= floor;
}

/**
 * The gestureless arm. This suite never grants autoplay, so the condition is unconditionally the
 * gestureless one.
 */
function autoplayRefused(w: Room): boolean {
	return w.master?.paused === true && atPreloadFloor(w);
}

/** I4 · the lyrics active index is consistent with currentTime. */
async function checkI4(w: Room, lastInput: InputName): Promise<Violation | null> {
	if (!w.master) return skip('I4', 'no master element on stage to measure');
	if (autoplayRefused(w))
		return skip(
			'I4',
			'gestureless, before the tap: the browser refused autoplay (paused, decoder still at its preload floor) — exactly what a real TV does before someone taps it, so the reel advances off the server intent while audio has not started; nothing about the highlight vs currentTime is testable yet'
		);
	{
		const id = w.current?.id ?? null;
		const changed = id !== lastLyricsEntry;
		lastLyricsEntry = id;
		if (changed)
			return skip(
				'I4',
				'the current entry just changed; the lyrics reel re-syncs off a broadcast, so this first read still shows the previous song'
			);
		if (RESETS_POSITION.has(lastInput))
			return skip('I4', `the input was \`${lastInput}\`, a position discontinuity the reel re-syncs to asynchronously`);
	}
	if (!w.curMedia?.lyricsRef) return skip('I4', 'the current song has no lyrics artifact');
	if (!w.tv.activeWord) return skip('I4', 'no active word rendered (between words, or word-highlight is off)');
	const doc = await lyricsFor(w.curMedia.lyricsRef);
	if (!doc) return skip('I4', 'the lyrics artifact could not be read');
	// The rendered ACTIVE WORD identifies the active line: the contract names the word, not the row.
	const hits: number[] = [];
	doc.lines.forEach((l, i) => {
		if ((l.words ?? []).some((x) => String(x.word).trim() === w.tv.activeWord)) hits.push(i);
	});
	if (hits.length === 0) {
		return violation(
			'I4',
			"the TV highlights a word that is not in the current song's lyrics at all",
			`activeWord=${JSON.stringify(w.tv.activeWord)} (raw textContent ${JSON.stringify(w.tv.activeWordRaw)})`,
			`one of the words in ${w.curMedia.lyricsRef}`
		);
	}
	if (hits.length > 1) return skip('I4', 'the highlighted word text is ambiguous across lines');
	const idx = hits[0];
	// The highlight is cued LEAD_SEC ahead of the playhead and the reel HOLDS a line through the gap until the
	// next one starts, so the legal window for line i runs from its own start to the next line's start.
	const cue = w.master.currentTime + LEAD_SEC;
	const start = doc.lines[idx].start;
	const nextStart = idx + 1 < doc.lines.length ? doc.lines[idx + 1].start : Number.POSITIVE_INFINITY;
	const TOL = 1.0; // the reel interpolates from the server anchor; it is allowed to be a beat off
	const preRoll = idx === 0 && cue < start; // before the first line, line 0 is correctly lit
	if (!preRoll && (cue < start - TOL || cue > nextStart + TOL)) {
		return violation(
			'I4',
			'the lyrics highlight is on a line whose window does not contain the playhead',
			`activeWord=${JSON.stringify(w.tv.activeWord)} → line ${idx} [${start}, ${nextStart}); currentTime=${w.master.currentTime.toFixed(2)} (cue ${cue.toFixed(2)})`,
			`cue within [${(start - TOL).toFixed(2)}, ${(nextStart + TOL).toFixed(2)}]`,
			w.master.paused === true
				? `the master is PAUSED at ${w.master.currentTime.toFixed(2)} (decoded ${w.master.decoded}) while the server says isPlaying=${w.srv.playback?.isPlaying} — the reel advances off the SERVER's intent (lyricsAdvancing(screen, tvState, isPlaying) in src/routes/tv/+page.svelte), never off audio progress, so it runs away from a playhead that is not moving`
				: `server positionSec=${w.srv.playback?.positionSec}, lead ${LEAD_SEC}s`
		);
	}
	return ok('I4');
}

/**
 * I6 · decoded bytes climbing whenever the UI claims to be playing.
 *
 * THE GATE IS THE ROOM'S CLAIM, NOT `master.paused`: keying on the element's own `paused` makes the check skip
 * itself in the one state worth catching — server says isPlaying, phones render a playing transport, and the
 * element sits paused at 0 with only its preload burst decoded.
 */
async function checkI6(w: Room): Promise<Violation | null> {
	const roomClaimsPlaying = w.srv.playback?.isPlaying === true && !!w.current;
	if (!roomClaimsPlaying) return skip('I6', 'the room does not claim to be playing, so it claims nothing about audio');
	if (!w.master) return skip('I6', 'no master element mounted to measure');
	if (w.master.decoded === null) return skip('I6', 'this build exposes no webkitAudioDecodedByteCount');
	if (autoplayRefused(w)) {
		return skip(
			'I6',
			'gestureless, before the tap: the browser refused autoplay (paused, decoder still at its preload floor) — exactly what a real TV does before someone taps it, so nothing about the decoder is testable yet'
		);
	}
	const before = { decoded: w.master.decoded, t: w.master.currentTime, src: w.master.src, paused: w.master.paused };
	// THE MEASUREMENT INTERVAL. A dwell on purpose: see DECODE_GAP_MS.
	await sleep(DECODE_GAP_MS);
	const after0 = await readTv(tv);
	const { master: m2 } = pickMaster(after0.rows, w.curMedia?.instrumentalRef);
	if (!m2 || m2.src !== before.src) return skip('I6', 'the song changed between the two samples');
	// A pause that ARRIVED between the samples is a legal transport action — but only if the room stopped
	// claiming to be playing too, so re-read the server rather than trusting the element.
	const srv2 = await serverSnapshot().catch(() => null);
	if (srv2 && srv2.playback?.isPlaying !== true) return skip('I6', 'playback was stopped between the two samples');
	// THE ENTRY, not just the src: a song queued twice in a row keeps its src across the advance, so a song that
	// ended between the samples hands the second one a FRESH element at 0 for the same file. Comparing its bytes
	// with the old element's reported that advance as a silent room (seed 3070909777, the second entry decoding
	// normally at 0.8 s).
	if (srv2 && srv2.playback?.currentEntryId !== w.current?.id) {
		return skip('I6', 'the entry advanced between the two samples (a repeat of the same song keeps its src)');
	}
	if ((m2.decoded ?? 0) <= before.decoded) {
		return violation(
			'I6',
			'the room claims to be playing but the DECODER consumed nothing — the room is silent',
			`decoded ${before.decoded} → ${m2.decoded} over ${DECODE_GAP_MS}ms; master.paused ${before.paused} → ${m2.paused}, currentTime ${before.t.toFixed(2)} → ${m2.currentTime.toFixed(2)}, readyState=${m2.readyState}`,
			'strictly more decoded bytes at the second sample',
			`server isPlaying=true, currentEntryId=${w.current?.id}, positionSec=${w.srv.playback?.positionSec}. ` +
				(m2.paused === true
					? `The element is PAUSED while the room believes it is playing — no sound, no timeupdate, no telemetry, while the server position reads ${w.srv.playback?.positionSec}.`
					: '`paused === false` reports INTENT, not progress; a failed decode looks exactly like this.')
		);
	}
	return ok('I6');
}

// ─────────────────────────────────────────────────────────────────────────────
// Retry bookkeeping for the cross-surface trio.
// ─────────────────────────────────────────────────────────────────────────────

function snapshotStats(): Record<string, { checked: number; skipped: number }> {
	return Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, { checked: v.checked, skipped: v.skipped }]));
}

function restoreStats(snap: Record<string, { checked: number; skipped: number }>): void {
	for (const [k, v] of Object.entries(snap)) {
		stats[k as InvariantId].checked = v.checked;
		stats[k as InvariantId].skipped = v.skipped;
	}
}

/**
 * The asynchrony split, in one place. I2/I3/I5 are retried against FRESH snapshots until they hold or CROSS_MS
 * runs out; I1/I4/I6 are read once off the snapshot that survived.
 */
async function checkAll(lastInput: InputName): Promise<{ v: Violation | null; world: Room }> {
	const deadline = Date.now() + CROSS_MS;
	const before = snapshotStats();
	let world: Room;
	let cross: Violation | null;
	for (;;) {
		// Each retry is a DISCARDED reading, so its bookkeeping is rolled back: otherwise a value that took
		// three attempts to propagate inflates the summary's counts threefold.
		restoreStats(before);
		world = await readRoom();
		cross = checkI2(world) ?? checkI3(world) ?? (await checkI5(world));
		if (!cross || Date.now() > deadline) break;
		await sleep(CROSS_RETRY_MS);
	}
	if (cross) return { v: cross, world };
	// I6 is evaluated BEFORE I4 deliberately: a silent room makes the reel drift, so the drift is a downstream
	// SYMPTOM, and reporting it first sends a reader to the overlay when the fault is the player.
	const single = checkI1(world, lastInput) ?? (await checkI6(world)) ?? (await checkI4(world, lastInput));
	return { v: single, world };
}

// ─────────────────────────────────────────────────────────────────────────────
// The inputs, driven.
// ─────────────────────────────────────────────────────────────────────────────

async function driveInput(input: InputName, world: Room): Promise<Step> {
	// FIRST, and unconditionally: this draw's position in the stream is part of the seed's contract.
	const phoneIdx = int(0, phones.length - 1); // interleaved between the two phones on purpose
	const page = phones[phoneIdx];
	const who = `phone${phoneIdx + 1}`;
	const playing = world.srv.playback?.isPlaying === true;
	let detail: string;

	/**
	 * A DISABLED transport button swallows a click silently — no action, no throw — so state is read first and
	 * a no-op is RECORDED as one: a step that silently did nothing must still replay identically.
	 *
	 * BY CONTRACT SELECTOR rather than by role+name, unlike skip and restart below: play/pause's accessible name
	 * IS its state (`aria-label={isPlaying ? 'Pause' : 'Play'}`), so a role query would resolve through the
	 * very disagreement between server state and rendered label that this fuzzer exists to catch — and would
	 * fail as a driver error instead of recording it. The label it actually carried is recorded in the detail.
	 * That rationale survived the move from the band's `.disc` to the strip's filled button unchanged.
	 *
	 * "NO STRIP RENDERED" IS NOW A LEGITIMATE IDLE STATE, not a suspicious one. The band was permanently
	 * present, so an absent transport meant something had gone wrong; the strip renders only when
	 * `hasSong || canStart`, so on a drained room the correct reading is that there is nothing to tap. It is
	 * still recorded as a no-op, because a replay has to reproduce the same nothing.
	 */
	async function tapPlayPause(): Promise<Step> {
		// The transport is on /queue's Now card (redesign step 4).
		await openQueue(page);
		const btn = page.locator(SEL.npPlayPause).first();
		if ((await btn.count()) === 0)
			return { who, input, detail: 'no-op (no strip rendered — nothing to play or resume)', noop: true };
		if (await btn.isDisabled()) return { who, input, detail: 'no-op (play/pause is disabled)', noop: true };
		const name = await btn.getAttribute('aria-label');
		await btn.click();
		return { who, input, detail: `clicked the strip's play/pause (${name})` };
	}

	/** BY ROLE AND ACCESSIBLE NAME: skip and restart both carry a literal label, so the label is the contract. */
	async function tapTransport(control: { role: 'button'; name: string }): Promise<Step> {
		await openQueue(page);
		const button = page.getByRole(control.role, { name: control.name }).first();
		if ((await button.count()) === 0)
			return { who, input, detail: `no-op (no ${control.name} control rendered)`, noop: true };
		if (await button.isDisabled()) return { who, input, detail: `no-op (${control.name} is disabled)`, noop: true };
		await button.click();
		return { who, input, detail: `clicked ${control.name}` };
	}

	switch (input) {
		case 'pause': {
			// ONE toggle keyed on playback.isPlaying, so pausing a paused room sends nothing.
			if (!playing) return { who, input, detail: 'no-op (already paused)', noop: true };
			return await tapPlayPause();
		}
		case 'resume': {
			if (playing) return { who, input, detail: 'no-op (already playing)', noop: true };
			return await tapPlayPause();
		}
		case 'skip':
			return await tapTransport(SEL.skip);
		case 'restart':
			return await tapTransport(SEL.restart);
		case 'seek': {
			// 1 in 10 lands past EOF deliberately: an element that hits the end fires `ended`, which the server
			// treats as advance-to-next — a seam.
			const beyond = rnd() < 0.1;
			const positionSec = beyond ? int(60, 400) : int(0, 7);
			const r = await wirePlayer(page, { cmd: 'seek', positionSec });
			return { who, input, detail: `seek positionSec=${positionSec}${beyond ? ' (past EOF)' : ''} [wire: ${r}]` };
		}
		case 'key': {
			const cur = world.srv.playback?.keyShift ?? 0;
			const semitones = Math.max(-9, Math.min(9, cur + (rnd() < 0.5 ? -1 : 1) * int(1, 3)));
			const r = await wirePlayer(page, { cmd: 'key', semitones });
			return { who, input, detail: `key semitones=${semitones} (from ${cur}) [wire: ${r}]` };
		}
		case 'guide': {
			const clear = rnd() < 0.2;
			const level = clear ? null : Math.round(rnd() * 100) / 100;
			const r = await wirePlayer(page, { cmd: 'guide', level });
			return { who, input, detail: `guide level=${level} [wire: ${r}]` };
		}
		case 'queue-add': {
			const { ready, raw } = world.cat;
			if (ready.length === 0 && raw.length === 0) return { who, input, detail: 'no-op (empty library)', noop: true };
			// 30% of adds target a RAW song, the only way RESTART-DURING-PROCESS becomes reachable.
			const wantRaw = raw.length > 0 && (ready.length === 0 || rnd() < 0.3);
			const row = pick(wantRaw ? raw : ready);
			const term = String(row.title).split(/\s+/)[0].toLowerCase();
			await openSearch(page); // the search field is at the top of the SING tab, which may be a route away
			await page.locator(SEL.search).fill(term);
			try {
				await page.locator(SEL.songRow).first().waitFor({ state: 'attached', timeout: 15_000 });
			} catch {
				// A term that returns nothing is a no-op, not a failure — but the phone is left holding a query on the
				// Sing tab, so it still has to go back to the rotation. See the header.
				await restOnQueue(page);
				return { who, input, detail: `no-op (search "${term}" returned no ${SEL.songRow})`, noop: true };
			}
			const nAdd = await page.locator(SEL.addTurn).count();
			const nSing = await page.locator(SEL.sing).count();
			if (wantRaw && nSing > 0) {
				await page.locator(SEL.sing).first().click();
				detail = `search "${term}" → clicked ${SEL.sing} (queues AND starts a process)`;
			} else if (nAdd > 0) {
				await page.locator(SEL.addTurn).first().click();
				detail = `search "${term}" → clicked ${SEL.addTurn}`;
			} else if (nSing > 0) {
				await page.locator(SEL.sing).first().click();
				detail = `search "${term}" → clicked ${SEL.sing}`;
			} else {
				await restOnQueue(page);
				return { who, input, detail: `no-op (search "${term}" offered no queue action)`, noop: true };
			}
			// THE ONE DRIVER FIX (header): back to the rotation, because that is where this phone's `.qrow`
			// counts apply and I5 compares them against the server's waiting set.
			await restOnQueue(page);
			return { who, input, detail };
		}
		case 'queue-remove': {
			// Every joined singer is a host, so removing a turn it did not add is legal — including the PLAYING
			// one, the dangling-current-entry seam.
			const candidates = (world.srv.entries ?? []).filter((e) => e.status === 'queued' || e.status === 'playing');
			if (candidates.length === 0) return { who, input, detail: 'no-op (nothing in the queue)', noop: true };
			const target = pick(candidates);
			const r = await wireQueueOp(page, { op: 'remove', id: target.id }, fuzzId());
			return {
				who,
				input,
				detail: `remove entry ${target.id.slice(-6)} (status ${target.status}${
					target.id === world.srv.playback?.currentEntryId ? ', THE CURRENT ONE' : ''
				}) [wire: ${r}]`
			};
		}
		default:
			return { who, input, detail: 'unknown input', noop: true };
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Report.
// ─────────────────────────────────────────────────────────────────────────────

/** One step, in the form a reader replays. Prefixed so a determinism diff can select exactly these lines. */
function stepLine(i: number, s: Step, mark = ''): string {
	return `fuzz step ${String(i + 1).padStart(3)} ${s.who.padEnd(7)} ${s.input.padEnd(13)} ${s.detail}${
		s.seam ? `   [seam: ${s.seam}]` : ''
	}${mark}`;
}

function sequenceText(markLast: boolean): string {
	return sequence
		.map((s, i) => stepLine(i, s, markLast && i === sequence.length - 1 ? '  <-- the offending input' : ''))
		.join('\n');
}

function violationReport(v: Violation, world: Room): string {
	return [
		'',
		'════════════════════════════════════════════════════════════════════════════',
		`VIOLATION · ${v.id} — ${v.title}`,
		'════════════════════════════════════════════════════════════════════════════',
		`  seed        ${SEED}`,
		`  replay      ${REPLAY}`,
		'  policy      gestureless (a real TV) — no --autoplay-policy grant',
		`  at input    #${sequence.length} of ${N_INPUTS}`,
		'  sequence',
		sequenceText(true),
		`  observed    ${v.observed}`,
		`  expected    ${v.expected}`,
		...(v.context ? [`  context     ${v.context}`] : []),
		'  room state',
		`    server    rev=${world.srv.rev} currentEntryId=${world.srv.playback?.currentEntryId} isPlaying=${world.srv.playback?.isPlaying} positionSec=${world.srv.playback?.positionSec} keyShift=${world.srv.playback?.keyShift} guideLevel=${world.srv.playback?.guideLevel}`,
		`    entries   ${(world.srv.entries ?? []).map((e) => `${e.id.slice(-6)}:${e.status}@${e.rotationSeq}`).join(' ') || '(none)'}`,
		`    tv        nowSong=${JSON.stringify(world.tv.nowSong)} nowName=${JSON.stringify(world.tv.nowName)} attract=${world.tv.attract} activeWord=${JSON.stringify(world.tv.activeWord)}`,
		`    master    ${
			world.master
				? `src=${world.master.src} paused=${world.master.paused} t=${world.master.currentTime.toFixed(2)} decoded=${world.master.decoded} err=${JSON.stringify(world.master.error)}`
				: 'none'
		} (${world.masterHow})`,
		''
	].join('\n');
}

const INVARIANT_TITLES: Record<InvariantId, string> = {
	I1: 'currentTime monotonic within a song',
	I2: 'exactly one entry is `playing`',
	I3: 'TV rendered now-playing == server currentEntryId',
	I4: 'lyrics active index consistent with currentTime',
	I5: 'no entry both playing and waiting; rotation agrees',
	I6: 'decoded bytes climbing while the UI claims to play'
};

function summaryText(): string {
	const lines = [
		'',
		`ran 1 opening add + ${Math.max(sequence.length - 1, 0)} fuzzed inputs across ${phones.length} phones + the TV, ` +
			`seed ${SEED}, gestureless`,
		'',
		'invariant   checked  skipped  why it was skipped'
	];
	for (const id of INVARIANT_IDS) {
		const s = stats[id];
		lines.push(
			`  ${id}       ${String(s.checked).padStart(6)}   ${String(s.skipped).padStart(6)}  ${[...s.why].join(' | ') || '—'}`
		);
		lines.push(`             ${INVARIANT_TITLES[id]}`);
	}
	lines.push(
		'',
		`I6 evaluations: ${stats.I6.checked} (skipped ${stats.I6.skipped})`,
		'',
		'sequence',
		sequenceText(false)
	);
	return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// The one real gesture.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE ONE GESTURE, DELIVERED AND KEPT. A real trusted tap with no `--autoplay-policy` flag, so this is still a
 * television. On a real TV the activation is STICKY across the auto-advance a skip triggers; headless mounts a
 * fresh <audio> per entry and does not always re-apply it, so the tap is RE-APPLIED — but only to a master
 * still at its own preload floor, the state a sticky activation would already have cleared.
 *
 * `page.mouse.click` and nothing else: a synthetic `el.click()` is untrusted and grants no user activation.
 *
 * Only the FIRST tap enters the sequence, so a replay stays faithful; the rest are silent recovery.
 */
async function maybeDeliverTap(world: Room): Promise<void> {
	if (!world.master || !world.current) return;
	if (world.srv.playback?.isPlaying !== true) return;
	// Nothing to do once this master is genuinely playing (decoder past its floor).
	if (tapped && !(world.master.paused === true && atPreloadFloor(world))) return;
	await tv.mouse.click(960, 540);
	if (!tapped) {
		tapped = true;
		const step: Step = {
			who: 'TV',
			input: 'real-tap',
			detail: 'the one real tap a viewer makes to start a gestureless TV'
		};
		sequence.push(step);
		console.log(stepLine(sequence.length - 1, step));
	}
	// Let the decoder begin climbing before the next invariant read. BOUNDED AND EARLY-RETURNING, where the old
	// driver slept a flat 1.2s: the gesture's effect is observable, so it is waited for rather than assumed.
	const deadline = Date.now() + TAP_SETTLE_MS;
	const wantRef = world.curMedia?.instrumentalRef;
	while (Date.now() < deadline) {
		const { master } = pickMaster((await readTv(tv)).rows, wantRef);
		if (master && master.decoded !== null) {
			const floor = preloadFloor.get(master.src);
			if (floor === undefined || master.decoded > floor) return;
		}
		await sleep(100);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// The run.
// ─────────────────────────────────────────────────────────────────────────────

/** One seeded run. `known` is the seed's `fuzz-seeds.ts` row, which decides whether its failure is expected. */
async function fuzzRun(world: World, testInfo: TestInfo, seed: number, inputs: number, known?: KnownSeed) {
	test.setTimeout(timeBudgetMs(inputs));
	startRun(seed, inputs);
	// The seed FIRST, before anything can fail.
	console.log(`fuzz seed=${SEED}`);
	console.log(`fuzz replay: ${REPLAY}   (inputs=${N_INPUTS}, policy=gestureless)`);

	base = world.baseURL;
	wsBase = world.baseURL.replace(/^http/, 'ws');

	// The fake worker publishes REAL audio and real word-level lyrics: a placeholder fixture leaves I4 and I6
	// with nothing to assert on.
	const worker = await startFakeWorker(world, FAULTS);
	try {
		const processedRows = await processSongs(world, 3);
		{
			const c = await catalog();
			console.log(
				`fixture: ${processedRows.length} processed (${processedRows.map((r) => r.title).join(', ')}), ` +
					`${c.raw.length} raw left for the process seam${
						c.raw.length === 0
							? ' — RESTART-DURING-PROCESS will NOT be reachable this run'
							: ` (${c.raw.map((r) => r.title).join(', ')})`
					}`
			);
		}

		const probe0 = await serverSnapshot().catch((e: Error) => {
			throw new Error(`cannot read server state: ${e.message}\n\n${world.core.log()}`);
		});
		// The lead is a ROOM setting, so it is read off `settings.room` — the frame carries
		// `EffectiveSettings = { global, room }` and never a bare `settings.lyricsLeadMs`. A frame with no settings
		// yet falls back to the CONTRACT default, which is what a room with no written row actually resolves to.
		const reportedLeadMs = probe0?.settings?.room?.lyricsLeadMs;
		LEAD_SEC = (Number.isFinite(reportedLeadMs) ? (reportedLeadMs ?? 0) : DEFAULT_LYRICS_LEAD_MS) / 1000;

		// Two phones, each its own context and session: one client cannot disagree with itself. Each starts on the
		// QUEUE TAB — that is where its `.qrow` counts apply, and its transport taps apply from any phone surface
		// because the transport is in the dock.
		for (const name of ['FzA', 'FzB']) {
			const page = await world.openPhone(name);
			await openBrowseFromHome(page);
			await openWire(page);
			await restOnQueue(page);
			phones.push(page);
		}

		tv = await world.openTv();
		await tv
			.locator(SEL.tvConnected)
			.first()
			.waitFor({ state: 'attached', timeout: 15_000 })
			.catch(() => {});

		// The room starts empty; the opening add is recorded in the sequence like any other input.
		{
			const world0 = await readRoom();
			const first = await driveInput('queue-add', world0);
			const step: Step = { ...first, detail: `${first.detail} (opening add)` };
			sequence.push(step);
			console.log(stepLine(sequence.length - 1, step));
			// Wait for the room to be PLAYING before deciding about the tap, rather than sleeping.
			// Bounded: a room that never starts is a finding the loop reports, not a reason to hang here.
			const deadline = Date.now() + FIRST_PLAYBACK_MS;
			let opening = await readRoom();
			while (
				Date.now() < deadline &&
				!(opening.current && opening.srv.playback?.isPlaying === true && opening.master)
			) {
				await sleep(250);
				opening = await readRoom();
			}
			await maybeDeliverTap(opening);
		}

		let found: Violation | null = null;
		let foundReport = '';
		let prev: InputName | null = null;
		for (let i = 0; i < N_INPUTS; i++) {
			const room = await readRoom();
			const lite: WorldLite = { current: room.current, waiting: room.waiting, processing: room.processing };
			await maybeDeliverTap(room);
			const input = drawInput(prev, lite);
			const seam = seamLabel(input, prev, lite);
			const rec = await driveInput(input, room);
			const step: Step = { ...rec, seam };
			sequence.push(step);
			console.log(stepLine(sequence.length - 1, step));
			prev = input;

			await sleep(SETTLE_MS);
			const { v, world: after } = await checkAll(input);
			if (v) {
				found = v;
				foundReport = violationReport(v, after);
				break;
			}
		}

		console.log(summaryText());
		// A KNOWN BUG, held open: expected to fail, but only on ITS invariant. Marked here rather than at the top
		// of the body, so the same seed breaking another invariant, or failing setup, still goes red.
		const heldOpen = known?.open === true;
		const holdReason = `seed ${SEED} breaks ${known?.invariant} (${known?.note}): a known bug, held open until its fix lands`;
		if (heldOpen && found?.id === known.invariant) test.fail(true, holdReason);
		if (found) {
			console.log(foundReport);
			await testInfo.attach('fuzz-run.txt', {
				body: `${REPLAY}\n${summaryText()}\n${foundReport}`,
				contentType: 'text/plain'
			});
			// SOFT, so the summary above is already on screen and the whole run is reported rather than the
			// first line of it. The test still fails.
			expect.soft(found, foundReport).toBeNull();
		} else {
			// NON-VACUITY FLOOR. A run that never managed to evaluate I6 is never green, because such a run
			// measured nothing about audio. That is an assertion: it FAILS, and it never
			// skips, because a permanently-skipped test is indistinguishable from the rot it was meant to catch.
			expect(
				stats.I6.checked,
				`NON-VACUITY: I6 (decoded bytes climbing while the room claims to play) was never evaluated in ` +
					`${sequence.length} step(s) — this run measured nothing about audio, so it cannot report green. ` +
					`seed ${SEED}; replay with ${REPLAY}. I6 skipped ${stats.I6.skipped}× for: ` +
					`${[...stats.I6.why].join(' | ') || '(no reason recorded — the loop never reached it)'}\n\n${worker.log()}`
			).toBeGreaterThan(0);
			console.log('\nall six invariants held after every input.');
			// Nothing broke on a seed listed as an open bug: the bug is fixed or the seed no longer reaches it.
			// `test.fail` on a run that passes is what turns that red, so someone flips the row to `open: false`.
			if (heldOpen) test.fail(true, `${holdReason}, and this run held every invariant: set open: false`);
		}
	} finally {
		await worker.stop();
	}
}

if (ENV_SEED !== null || process.env.FUZZ_RANDOM) {
	// NO RETRIES. Playwright runs a retry in a fresh worker that loads this module again, so a random seed would
	// be redrawn and a failing seed could come back green as `flaky` (the config retries once under CI). A seed
	// that breaks an invariant has to fail on its first run. No `fuzz-seeds.ts` hold here either: a replay of a
	// known seed is someone looking at the bug, and it should fail in front of them.
	const seed = ENV_SEED ?? (Math.random() * 0xffffffff) >>> 0;
	test.describe(() => {
		test.describe.configure({ retries: 0 });
		test('the six invariants hold after every input', async ({ world }, testInfo) => {
			await fuzzRun(world, testInfo, seed, ENV_INPUTS);
		});
	});
} else {
	for (const known of KNOWN_SEEDS) {
		test(`known seed ${known.seed} · ${known.invariant} · ${known.note}`, async ({ world }, testInfo) => {
			await fuzzRun(world, testInfo, known.seed, known.inputs, known);
		});
	}
}
