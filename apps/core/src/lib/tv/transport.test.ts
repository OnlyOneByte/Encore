import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { transportFor, slotHoldsSrc, type TransportInputs } from './transport';

const base: TransportInputs = { hasSrc: true, playable: true, active: true, visible: true, playing: true };
const at = (over: Partial<TransportInputs>) => transportFor({ ...base, ...over });

describe('transportFor', () => {
	test('the visible, active slot of a playable song plays', () => {
		expect(at({})).toBe('play');
	});

	/*
	 * THE REGRESSION. This is the whole defect: `play()` on an element that has not been given its src
	 * is undone by the src assignment (the media load algorithm sets `paused` back to true) and its
	 * promise rejects with AbortError. Measured in a real browser: play()-then-src leaves the element at
	 * readyState 4 with correct duration, no error, and currentTime pinned at 0 forever — the exact
	 * state the live TV was in. There must be NO combination of inputs that plays a src-less element.
	 */
	test('never plays an element that is not holding its src', () => {
		for (const playable of [true, false]) {
			for (const active of [true, false]) {
				for (const visible of [true, false]) {
					for (const playing of [true, false]) {
						expect(at({ hasSrc: false, playable, active, visible, playing })).not.toBe('play');
					}
				}
			}
		}
	});

	test('a slot with no src is left ALONE, not paused — idle is a distinct answer', () => {
		expect(at({ hasSrc: false })).toBe('idle');
	});

	test('nothing playable has no transport at all', () => {
		expect(at({ playable: false })).toBe('idle');
	});

	test('the hidden pre-warming slot does not play', () => {
		expect(at({ visible: false })).toBe('pause');
		expect(at({ active: false })).toBe('pause');
	});

	test('the room pause reaches the master', () => {
		expect(at({ playing: false })).toBe('pause');
	});
});

/*
 * A source guard, because the bug was an ORDERING bug and no pure-function test can see ordering.
 *
 * The src is assigned from an effect that is declared BELOW the transport effect, so the transport
 * effect must depend on the src having landed — otherwise it runs first, plays a src-less element, and
 * never re-runs. Reading `currentSrc` is what makes that dependency real. If someone later "simplifies"
 * the transport effect back to reading only `active/visible/playing`, this fails instead of the room
 * going silent again.
 */
describe('TvPlayer wires the transport to the src, not to declaration order', () => {
	const src = readFileSync(join(import.meta.dir, 'TvPlayer.svelte'), 'utf8');

	test('the transport decision is driven by transportFor', () => {
		expect(src).toContain('transportFor(');
	});

	test('the transport hasSrc means "holding THIS song\'s src", so a song change re-runs it (#374)', () => {
		const calls = src.split('transportFor({').slice(1);
		expect(calls.length).toBe(1); // ONE decision, derived once
		const call = calls[0]!.slice(0, 900);
		// The input must compare the element's src against the CURRENT media's resolved src, not merely
		// ask "has this slot ever held a src" (`!!currentSrc`). The latter stays true across a song
		// change, so the derived kept the same `'play'` value and never re-ran its effect after the new
		// src landed — #374. `slotHoldsSrc(currentSrc, ...fileSrc(media)...)` gives the `idle -> play`
		// value edge exactly when the new src lands.
		expect(call).toContain('hasSrc: slotHoldsSrc(currentSrc,');
		expect(call).toContain('fileSrc(media)');
		expect(call).not.toContain('hasSrc: !!currentSrc');
		// and it must be a $derived, so both the master and the guide effect track it
		expect(src).toContain('$derived(\n\t\ttransportFor({');
	});

	/*
	 * The master and the guide must read the SAME decision. Two copies of the same condition is how a
	 * silent master still produced an audible vocals-only mix: the guide's own `active && visible &&
	 * playing` check did not know the master had never started.
	 */
	test('the guide reads the same transport as the master, not its own copy', () => {
		expect(src).toContain("if (transport === 'play') {");
		expect(src).not.toContain('if (active && visible && playing) {');
	});

	test('play() is never called from a bare active/visible/playing check', () => {
		// The exact shape of the defect: the old effect body. Its return is what regressed.
		expect(src).not.toContain('if (active && visible && playing) master.play()');
	});

	test('a refused play() is reported rather than swallowed', () => {
		// `.catch(() => {})` on the MASTER is what hid the AbortError through two rounds of diagnosis.
		expect(src).not.toContain('master.play().catch(() => {})');
	});

	/*
	 * THE OTHER HALF OF THE PAUSE BUG. Assigning `HTMLMediaElement.src` reloads the resource and resets
	 * currentTime to 0 even when the string is byte-identical, so the decision must be made against what
	 * the ELEMENT holds. A shadow copy of it could be cleared while the element still held its src —
	 * which is what rewrote an identical src and yanked the playing song back to 0 on every pause
	 * (measured: SRC-ATTR-WRITTEN, then abort/emptied/loadstart, currentTime 10.9 -> 0).
	 */
	test('the src decision reads the element, not a shadow copy that can go stale', () => {
		// The decision is made against what the ELEMENT holds (`master.getAttribute('src')`), never a
		// shadow copy that could be cleared while the element still held its src.
		expect(src).toContain("nextVideoSrc(master.getAttribute('src') ?? ''");
		expect(src).not.toContain('nextVideoSrc(currentSrc,');
	});

	test('the reset never clears the src bookkeeping — that is what reloaded the playing song', () => {
		expect(src).not.toContain('currentSrc = null');
	});

	/*
	 * #251. A next-up cook reaching a stage rebroadcasts queue:sync; the TV rebuilds its catalog and the
	 * PLAYING slot's media reads momentarily null / not-yet-isPlayable for a churn pass. On the old
	 * contract the assign effect resolved that pass to '' and, since the element still held the real
	 * src, CLEARED it (removeAttribute -> reassign -> reload at 0 — the currently-playing song jumped
	 * back to the start). The fix threads `playable` (the {#if} condition) into the decision so a
	 * not-playable pass is never a clear, and it must NOT clobber `currentSrc` to '' on such a pass
	 * either (that would tell the transport the still-playing song has no src). Comments are stripped so
	 * prose describing the old behaviour can neither satisfy nor trip these checks.
	 */
	const code = src
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1');

	test('#251: the src decision is told whether the media is playable', () => {
		// The pivot of the fix: `playable` is computed and passed to the decision, so a not-playable
		// churn pass returns changed:false instead of clearing.
		expect(code).toContain('const playable = !!media && isPlayable(media)');
		expect(code).toMatch(/nextVideoSrc\(master\.getAttribute\('src'\) \?\? '', resolved, playable\)/);
		// The element is never CLEARED any more — the old '' -> removeAttribute dance is gone.
		expect(code).not.toContain("master.removeAttribute('src')");
	});

	test('#251: currentSrc is not clobbered on a not-playable pass', () => {
		// The bookkeeping the transport gates on must survive a churn pass, so its write is guarded on
		// `playable` rather than assigned unconditionally to a possibly-empty `resolved`.
		expect(code).toContain('if (playable) currentSrc = resolved');
		expect(code).not.toMatch(/^\s*currentSrc = resolved;\s*$/m);
	});

	/*
	 * #674 — draining the room UNMOUNTS the master (`{#if media && isPlayable(media)}`), but `currentSrc`
	 * is a component-level shadow that outlives the element. Re-adding the SAME just-ended song resolves
	 * to the byte-identical src, so `slotHoldsSrc(currentSrc, …)` reads `true` on a fresh, src-less
	 * element: the transport is `'play'` on its first pass, races the src assignment, is aborted, and —
	 * the derived value never having changed — is never retried. The room is silent while every surface
	 * says it is playing. The fix clears the shadow WHEN THE ELEMENT IS GONE, so a remounted element reads
	 * `hasSrc:false` and the transport takes a genuine `idle -> play` edge once the assign effect lands the
	 * new src. This is a DIFFERENT clear from the #251 not-playable churn pass (element still bound, keep
	 * the song) — it fires only on the unmount, and no such reset exists on base, so this reds today.
	 * Comments are stripped so the prose above (which names the old and new shapes) can neither satisfy
	 * nor trip it.
	 */
	test('#674: currentSrc is reset when the master element unmounts, not left to go stale', () => {
		// A guard against the shadow that survives the drain. The reset must fire on the ABSENCE of the
		// binding (`!master`) — a genuine unmount — and clear the shadow to '' so a re-added same-song
		// element does not read a stale hasSrc:true. Wrap-tolerant on whitespace between tokens.
		expect(code).toMatch(/if\s*\(\s*!master\s*\)\s*currentSrc\s*=\s*''/);
		// Not vacuous: the reader it protects is still wired to the shadow (if someone converts the
		// transport reader to the element too, this shadow-reset stops being load-bearing and this anchor
		// should be revisited — until then it must exist).
		expect(code).toContain('slotHoldsSrc(currentSrc,');
	});
});

/*
 * #374 — "skip the only queued song, add another, nothing plays until you pause/unpause"; more
 * broadly, only the FIRST song of a TV page ever plays. The server is correct (verified quiescent):
 * it settles to currentEntryId=null,isPlaying=false and then auto-starts the new song. The defect is
 * the INPUT the TvPlayer derived feeds `transportFor`: it passed `hasSrc: !!currentSrc`, which only
 * asks "has this slot EVER held a src". `currentSrc` holds the PREVIOUS song's URL across a change
 * (TvPlayer never clears it and only rewrites it on a playable pass), so `!!currentSrc` stayed
 * stale-true, `transportFor` returned the SAME `'play'` value, and a memoized `$derived` does not
 * re-run its effect on an unchanged value — so play() was never replayed after the new src landed and
 * the master sat paused at 0.
 *
 * `transportFor` itself was always correct, so its own tests cannot see this — the fix and its proof
 * live in `slotHoldsSrc`, the pure helper that computes the input.
 */
describe("slotHoldsSrc — the element is holding THIS song's src, not merely SOME src", () => {
	const A = '/media/song-a-instrumental.wav';
	const B = '/media/song-b-instrumental.wav';

	test('true only when the held src equals the wanted src', () => {
		expect(slotHoldsSrc(A, A)).toBe(true);
	});

	test('false when the element still holds the PREVIOUS song across a change — this is #374', () => {
		// The slot holds A's URL; the current media now resolves to B. The old `!!currentSrc` read this
		// as `true` (a src exists) and kept the transport at `'play'`; `slotHoldsSrc` reads it as `false`
		// because the element is NOT yet holding B.
		expect(slotHoldsSrc(A, B)).toBe(false);
	});

	test('false when there is nothing to hold', () => {
		expect(slotHoldsSrc('', A)).toBe(false);
		expect(slotHoldsSrc(null, A)).toBe(false);
		expect(slotHoldsSrc(undefined, A)).toBe(false);
		expect(slotHoldsSrc(A, null)).toBe(false);
		expect(slotHoldsSrc(A, undefined)).toBe(false);
		expect(slotHoldsSrc(A, '')).toBe(false);
	});
});

describe('#374: the transport across a song change on one page', () => {
	const A = '/media/song-a-instrumental.wav';
	const B = '/media/song-b-instrumental.wav';
	// The slot state at the moment the new song B has arrived as `media` but the assign effect has not
	// yet written B's src to the element, so `currentSrc` still holds A's URL. This is the exact instant
	// #374 is about.
	const slot = { playable: true, active: true, visible: true, playing: true };

	test('BASE BEHAVIOUR (regression): !!currentSrc plays B before its src has landed', () => {
		// The OLD input. `currentSrc` (A) is truthy, so the old contract said hasSrc:true and the derived
		// returned 'play' — for an element still holding A / holding nothing. play() then races the src
		// assignment and is undone by it. This 'play' is the bug.
		const hasSrcOld = !!A; // === `!!currentSrc`
		expect(transportFor({ ...slot, hasSrc: hasSrcOld })).toBe('play');
	});

	test('FIXED: while the element still holds A, the transport is idle — not play', () => {
		// The NEW input via slotHoldsSrc: held=A, wanted=fileSrc(B)=B → false → 'idle'. The effect is
		// LEFT ALONE (not paused) until the src lands, so it does not fight the assign effect.
		const hasSrc = slotHoldsSrc(A, B);
		expect(hasSrc).toBe(false);
		expect(transportFor({ ...slot, hasSrc })).toBe('idle');
	});

	test("FIXED: once the assign effect writes B's src, hasSrc flips true and B plays", () => {
		// currentSrc has now been rewritten to B (the playable-pass write). held=B, wanted=B → true. The
		// derived VALUE has changed ('idle' -> 'play'), so the effect re-runs and plays B — after the src
		// has landed, which is the whole point.
		const hasSrc = slotHoldsSrc(B, B);
		expect(hasSrc).toBe(true);
		expect(transportFor({ ...slot, hasSrc })).toBe('play');
	});

	test('the idle->play VALUE edge exists across the change (the old input never produced it)', () => {
		// Old input: same value 'play' on both sides of the change (A truthy before, B truthy after) — no
		// edge, so the memoized derived never re-runs the effect. New input: 'idle' then 'play' — a real
		// value change that DOES re-run it. This edge is the fix.
		const before = { ...slot };
		expect(transportFor({ ...before, hasSrc: !!A })).toBe(transportFor({ ...before, hasSrc: !!B })); // old: no edge
		expect(transportFor({ ...before, hasSrc: slotHoldsSrc(A, B) })).not.toBe(
			transportFor({ ...before, hasSrc: slotHoldsSrc(B, B) })
		); // new: idle -> play edge
	});
});
