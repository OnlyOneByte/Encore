import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { transportFor, type TransportInputs } from './transport';

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

	test('the transport reads currentSrc, so it re-runs when the src lands', () => {
		const calls = src.split('transportFor({').slice(1);
		expect(calls.length).toBe(1); // ONE decision, derived once
		expect(calls[0]!.slice(0, 200)).toContain('hasSrc: !!currentSrc');
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
		expect(src).toContain("nextVideoSrc(master.getAttribute('src') ?? ''");
		expect(src).not.toContain('nextVideoSrc(currentSrc,');
	});

	test('the reset never clears the src bookkeeping — that is what reloaded the playing song', () => {
		expect(src).not.toContain('currentSrc = null');
	});
});
