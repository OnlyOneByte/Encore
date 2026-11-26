import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { at } from '$test';

/*
 * guard: the Queue tab's wirings that neither a browser nor a store test can see.
 *
 * What is covered ELSEWHERE, so it is deliberately not duplicated here:
 *   · tests/playwright/specs/probe/p19-queue-tab.spec.ts drives the four behaviours in a real browser — the join
 *     gate, the silent cold load, the cooking row's grip, and a clock that neither reverses nor passes the end.
 *   · tests/unit/lib/stores/queue.test.ts owns `QueueStore.synced`, the contract the announcement gate reads.
 * What is HERE is the handful of shapes whose correctness is invisible to both: a disposer that only leaks across
 * navigations, and an anchor effect whose dependency SET is the fix — a reader who "simplifies" two scalars back
 * into the object read reintroduces a clock that steps backwards every fifteen seconds, and nothing about the
 * resulting source looks wrong.
 *
 * The component-mount harness was deleted (see bunfig.toml), so this is a source scan on purpose rather than for
 * want of a renderer.
 */

const queuePage = readFileSync(at('src/routes/(phone)/queue/+page.svelte'), 'utf8');

test('the anchor effect reads the SCALAR mirrors, never the mirrored playback object', () => {
	/* `playback = room.playback` mints a fresh proxy on every room emit (proxy() has no identity cache), so an
	   effect reading `playback.positionSec` re-runs on an IDENTICAL rebroadcast — and the heartbeat sends one
	   every 15s. The two scalars are what make an unchanged value silent. */
	expect(queuePage).toContain('positionSec = room.playback.positionSec;');
	expect(queuePage).toContain('isPlaying = room.playback.isPlaying;');
	expect(queuePage).toContain('const anchor = positionSec;');
	expect(queuePage).toContain('const playing = isPlaying;');
	/* THE EFFECT'S OWN BODY, not the whole file: the `sync()` mirror legitimately reads `room.playback.positionSec`
	   (that is where the scalars come from), so a file-wide negative would be unsatisfiable. The object mirror
	   itself stays, for `currentEntryId`/`keyShift`/`guideLevel` — what may not come back is an effect anchoring
	   on it. Sliced from the anchor to its `secondTicker` return, which is the whole dependency set. */
	const anchorAt = queuePage.indexOf('const anchor =');
	const tickerAt = queuePage.indexOf('return secondTicker(', anchorAt);
	expect(anchorAt).toBeGreaterThan(-1);
	expect(tickerAt).toBeGreaterThan(anchorAt);
	const anchorEffect = queuePage.slice(anchorAt, tickerAt);
	expect(anchorEffect).not.toContain('playback.');
});

test('the drawn clock is capped at the song length, and BOTH halves of the readout take the capped value', () => {
	// One readout cannot disagree with itself: the elapsed figure used to run past the end while the remainder
	// clamped at zero. The cap is at the call site because `drawPosition` also feeds the TV reel and the strip.
	expect(queuePage).toContain(
		'const drawnPos = $derived(nowDurationSec > 0 ? Math.min(displayPos, nowDurationSec) : displayPos);'
	);
	expect(queuePage).toContain('{formatClock(drawnPos)}');
	expect(queuePage).toContain('{formatRemaining(drawnPos, nowDurationSec)}');
});

test('the route leaves the link error channel to the layout', () => {
	/* A queue op's refusal (`Couldn't do that: …`) must still reach this tab; the phone layout's one sink carries it
	   (ui-sweep-wiring.test.ts), and a second registration here would toast it twice. */
	expect(queuePage).not.toContain('room.onError(');
});

test('the announcement effect returns on an unsynced store BEFORE it reads or writes the baseline', () => {
	/* Ordering is the whole fix: the guard has to be ahead of `announcedIds = queued.map(...)`, because the
	   defect was the WRITE, not the read — the pre-socket pass correctly announced nothing and then seeded `[]`. */
	const gate = queuePage.indexOf('if (!queueSynced) return;');
	const read = queuePage.indexOf('queueAnnouncement({');
	const seed = queuePage.indexOf('announcedIds = queued.map(');
	expect(gate).toBeGreaterThan(-1);
	expect(seed).toBeGreaterThan(-1);
	expect(gate).toBeLessThan(seed);
	/* Ahead of the CALL too. Gating only the write would also be correct — a pre-sync pass with a null baseline
	   returns null anyway — but it means composing a sentence the effect is about to discard on every pre-socket
	   emit, and it invites the next reader to decide the guard is decorative and move it again. */
	expect(gate).toBeLessThan(read);
	// And the flag is the store's own, not a local approximation of it.
	expect(queuePage).toContain('queueSynced = room.queue?.synced ?? false;');
});
