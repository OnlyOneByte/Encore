// guard: the `days` read-window on /api/stats and /api/metrics enforces the LOWER bound its
// docstring states, not just the upper one.
//
// Both endpoints parse `?days=` and clamp it. The metrics copy's docstring promised `[1, 3650]`, but
// neither copy applied a lower clamp: `Math.floor(0.5)` is `0`, so a fractional value in `(0, 1)`
// survived the `<= 0` gate and collapsed the window to zero length — `windowStart === now`, an empty
// series, and the impossible `0` echoed straight back to the client as if it were the honoured
// request. The shared `clampDays` now applies `Math.max(1, …)`, so the documented lower bound
// is true. This drives the REAL GET handlers and asserts the returned window is >= 1.
import { test, expect, afterEach } from 'bun:test';
import { GET as statsGET } from './stats/+server';
import { GET as metricsGET } from './metrics/+server';

const APP_KEY = Symbol.for('encore.app');

// A minimal app exposing only the accessors these two routes read. Everything returns empty, so the
// only thing under test is the clamp: with no data the window value is whatever clampDays returned.
function installApp() {
	(globalThis as Record<PropertyKey, unknown>)[APP_KEY] = {
		now: () => 1_000_000_000_000,
		media: { all: () => [], listReady: () => [] },
		playLog: {
			topSongs: () => [],
			total: () => 0,
			totalSince: () => 0,
			distinctSongs: () => 0,
			perDay: () => []
		},
		attempts: { finishedSince: () => [], countFinished: () => 0 },
		workers: { list: () => [] }
	};
}

afterEach(() => {
	delete (globalThis as Record<PropertyKey, unknown>)[APP_KEY];
});

function callStats(days: string) {
	return statsGET({ url: new URL(`http://x/api/stats?days=${days}`) } as never);
}
function callMetrics(days: string) {
	return metricsGET({ url: new URL(`http://x/api/metrics?days=${days}`) } as never);
}

test('metrics: ?days=0.5 clamps the window to at least 1, not 0 (its docstring bound)', async () => {
	installApp();
	const body = await (await callMetrics('0.5')).json();
	// base: Received 0 — the fractional value floored to 0 and the window collapsed.
	expect(body.sample.windowDays).toBeGreaterThanOrEqual(1);
});

test('stats: ?days=0.5 clamps the window to at least 1, not 0', async () => {
	installApp();
	const body = await (await callStats('0.5')).json();
	// base: Received 0.
	expect(body.window.days).toBeGreaterThanOrEqual(1);
});

test('a garbage days value still falls back to each endpoint default (7 / 30), unchanged', async () => {
	installApp();
	const m = await (await callMetrics('abc')).json();
	const s = await (await callStats('abc')).json();
	expect(m.sample.windowDays).toBe(7);
	expect(s.window.days).toBe(30);
});

test('a whole days value inside range is returned as-is (upper bound not disturbed)', async () => {
	installApp();
	const m = await (await callMetrics('14')).json();
	const s = await (await callStats('14')).json();
	expect(m.sample.windowDays).toBe(14);
	expect(s.window.days).toBe(14);
});
