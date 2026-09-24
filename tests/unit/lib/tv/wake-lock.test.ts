// The TV must HOLD THE SCREEN AWAKE while a song is on stage, and release it when idle. Nothing in the app
// held the screen on, so the OS screensaver blanked the room mid-song — a long instrumental break with no
// input was enough to lose the lyrics. `keepScreenAwake()` (src/lib/tv/wake-lock.ts) takes a Screen Wake Lock
// and hands back the teardown that releases it; the /tv route holds one for exactly the on-stage screens, so
// the effect's cleanup is the release.
//
// This drives the REAL module against a fake Wake Lock API: the re-acquire, the in-flight guard and the
// post-teardown release are PROVEN here rather than spelled. The source-scanning arms this file used to carry
// (asserting `navigator.wakeLock` and `addEventListener('visibilitychange')` appear in the module text) were
// dropped with the guard suite — they restated what the behavioural tests below already demonstrate.
import { test, expect, afterEach } from 'bun:test';
import { Window } from 'happy-dom';
import { keepScreenAwake } from '$lib/tv/wake-lock';

// A DOM local to this file. The module listens on `document` for `visibilitychange` and feature-detects
// `navigator.wakeLock`, so both have to exist; nothing else here needs a browser. This replaces the former
// repo-wide `[test] preload` harness, which installed happy-dom for every one of 300+ test files to serve
// the handful that actually touch a DOM.
const win = new Window({ url: 'http://localhost/' });
const g = globalThis as unknown as Record<string, unknown>;
g.window = win;
g.document = win.document;
g.navigator = win.navigator;

/** happy-dom's own `Event`, off its window: bun defines a global `Event`, and happy-dom's `dispatchEvent` rejects any instance that is not ITS class. */
const visibilityChange = (): void => void win.document.dispatchEvent(new win.Event('visibilitychange'));

interface FakeSentinel {
	released: boolean;
	release: () => Promise<void>;
}

/** Every request the module made, in order, with the lock type it asked for. */
let asked: string[] = [];
/** The sentinels handed out, so a test can read whether each was released. */
let handed: FakeSentinel[] = [];
/** Resolvers for the requests held in flight, for the `defer` mode. */
let inFlight: Array<() => void> = [];
/** The live holder, torn down in `afterEach`: a test that fails mid-way must not leave its listener attached. */
let holder: (() => void) | undefined;

/**
 * `defer` holds every request UNRESOLVED, which is the only way to observe the in-flight window — the state
 * the `acquiring` flag exists for.
 */
function installFakeWakeLock(options: { defer?: boolean } = {}): void {
	asked = [];
	handed = [];
	inFlight = [];
	const wakeLock = {
		request: (type: string): Promise<FakeSentinel> => {
			asked.push(type);
			const sentinel: FakeSentinel = {
				released: false,
				release: async () => {
					sentinel.released = true;
				}
			};
			handed.push(sentinel);
			if (!options.defer) return Promise.resolve(sentinel);
			return new Promise<FakeSentinel>((resolve) => inFlight.push(() => resolve(sentinel)));
		}
	};
	Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: wakeLock });
}

/** Start a holder and remember it for the teardown. The teardown is idempotent, so a test may also call it. */
function hold(): () => void {
	holder = keepScreenAwake();
	expect(holder, 'a supported platform must hand back a teardown').toBeTypeOf('function');
	return holder!;
}

afterEach(() => {
	holder?.();
	holder = undefined;
	Reflect.deleteProperty(navigator, 'wakeLock');
});

/** MACROTASK turns, so the length of the module's internal await chain is never bet on. */
async function settle(): Promise<void> {
	for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

test('it takes one screen lock on call and releases it on teardown', async () => {
	installFakeWakeLock();
	const stop = hold();
	await settle();
	expect(asked).toEqual(['screen']);
	expect(handed[0]!.released).toBe(false);
	stop();
	await settle();
	expect(handed[0]!.released, 'the teardown must release the held lock').toBe(true);
});

test('a lock the platform dropped is RE-TAKEN on the next visibilitychange', async () => {
	installFakeWakeLock();
	hold();
	await settle();
	// What the platform does on a hide: the sentinel is spent and we are not told.
	handed[0]!.released = true;
	visibilityChange();
	await settle();
	expect(asked.length, 'a spent sentinel must be replaced, or the feature works exactly once').toBe(2);
});

test('a held, live lock is NOT re-requested on visibilitychange', async () => {
	installFakeWakeLock();
	hold();
	await settle();
	visibilityChange();
	await settle();
	expect(asked.length).toBe(1);
});

test('a visibilitychange mid-flight does not issue a second request', async () => {
	// The leak this closes: `sentinel` is null for the whole in-flight window, so a second request here
	// leaves the first held lock with nothing holding a handle to it — awake past the song's end.
	installFakeWakeLock({ defer: true });
	hold();
	expect(asked.length).toBe(1);
	visibilityChange();
	expect(asked.length, 'the in-flight request must suppress a second one').toBe(1);
	for (const resolve of inFlight) resolve();
	await settle();
});

test('a lock that arrives AFTER teardown is released, never leaked', async () => {
	installFakeWakeLock({ defer: true });
	hold()();
	inFlight[0]!();
	await settle();
	expect(handed[0]!.released, 'a sentinel resolving after teardown must be released immediately').toBe(true);
});

test('the teardown removes the listener, so a later visibilitychange takes nothing', async () => {
	installFakeWakeLock();
	hold()();
	await settle();
	visibilityChange();
	await settle();
	expect(asked.length, 'a torn-down holder must not re-acquire').toBe(1);
});

test('with no Wake Lock API it is inert: no teardown, and nothing thrown', () => {
	// The documented LAN deployment is plain HTTP, where `navigator.wakeLock` does not exist at all.
	Reflect.deleteProperty(navigator, 'wakeLock');
	expect((navigator as { wakeLock?: unknown }).wakeLock).toBeUndefined();
	expect(keepScreenAwake()).toBeUndefined();
});
