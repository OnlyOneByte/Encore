import { expect, test } from 'bun:test';
import { createGrace } from '$lib/ui/grace';
import { PENDING_GRACE_MS } from '$lib/stores/room';

/** A fake clock: `advance` runs every timer that falls due, in order. */
function clock() {
	let t = 0;
	let timers: { at: number; fn: () => void; id: number }[] = [];
	let next = 0;
	return {
		now: () => t,
		setTimeoutFn: (fn: () => void, ms: number) => {
			timers.push({ at: t + ms, fn, id: ++next });
			return next;
		},
		clearTimeoutFn: (id: unknown) => void (timers = timers.filter((x) => x.id !== id)),
		advance(ms: number) {
			const end = t + ms;
			for (;;) {
				const due = timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
				if (!due) break;
				timers = timers.filter((x) => x !== due);
				t = due.at;
				due.fn();
			}
			t = end;
		}
	};
}

function harness() {
	const c = clock();
	const seen: [number, boolean][] = [];
	const g = createGrace({ ...c, onShow: (s) => seen.push([c.now(), s]) });
	return { c, g, seen };
}

test('a wait shorter than the grace paints nothing', () => {
	const { c, g, seen } = harness();
	g.set(true);
	c.advance(PENDING_GRACE_MS - 1);
	g.set(false);
	c.advance(5_000);
	expect(seen).toEqual([]);
});

test('a long wait paints at the grace and holds the indicator at least as long again', () => {
	const { c, g, seen } = harness();
	g.set(true);
	c.advance(PENDING_GRACE_MS + 10);
	g.set(false); // 10 ms after it painted
	c.advance(5_000);
	expect(seen).toEqual([
		[PENDING_GRACE_MS, true],
		[2 * PENDING_GRACE_MS, false]
	]);
});

test('busy again during the hold keeps the indicator up without a second paint', () => {
	const { c, g, seen } = harness();
	g.set(true);
	c.advance(PENDING_GRACE_MS + 50);
	g.set(false);
	c.advance(100);
	g.set(true);
	c.advance(1_000);
	expect(seen).toEqual([[PENDING_GRACE_MS, true]]);
	g.set(false); // painted long ago, so it goes at once
	expect(seen.at(-1)).toEqual([c.now(), false]);
});

test('dispose drops a pending paint', () => {
	const { c, g, seen } = harness();
	g.set(true);
	g.dispose();
	c.advance(5_000);
	expect(seen).toEqual([]);
});
