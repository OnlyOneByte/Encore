import { describe, expect, test } from 'bun:test';
import { read } from '$test';
import { transportFor, slotHoldsSrc, slotHoldsSong, songToken, type TransportInputs } from '$lib/tv/transport';

const base: TransportInputs = { hasSrc: true, playable: true, active: true, visible: true, playing: true };
const at = (over: Partial<TransportInputs>) => transportFor({ ...base, ...over });

describe('transportFor', () => {
	test('the visible, active slot of a playable song plays', () => {
		expect(at({})).toBe('play');
	});

	// Caught: `play()` on a src-less element is undone by the later src assignment (the media load algorithm resets
	// `paused` to true) and rejects with AbortError, pinning currentTime at 0 forever. No input may play a src-less element.
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

// A source guard, because the defect was an ORDERING bug no pure-function test can see: the src is assigned from
// an effect declared BELOW the transport effect, so the transport must depend on the src having landed or it runs
// first, plays a src-less element, and never re-runs.
describe('TvPlayer wires the transport to the src, not to declaration order', () => {
	const src = read('src/lib/tv/TvPlayer.svelte');

	test('the transport decision is driven by transportFor', () => {
		expect(src).toContain('transportFor(');
	});

	test('the transport hasSrc means "holding THIS ENTRY\'s src", so a same-song advance re-runs it (/)', () => {
		const calls = src.split('transportFor({').slice(1);
		expect(calls.length).toBe(1); // ONE decision, derived once
		const call = calls[0]!.slice(0, 1600);
		// hasSrc must compare ENTRY-scoped tokens. `!!currentSrc` is stale-true across any change, and
		// `slotHoldsSrc` is stale-true across a SAME-SONG advance because the src is byte-identical; only
		// the token gives the `idle -> play` value edge that re-runs the memoized derived's effect.
		expect(call).toContain('hasSrc: slotHoldsSong(');
		expect(call).toContain('songToken(currentEntryId, currentSrc)');
		expect(call).toContain('songToken(entryId,');
		expect(call).toContain('fileSrc(media)');
		expect(call).not.toContain('hasSrc: !!currentSrc');
		expect(call).not.toContain('hasSrc: slotHoldsSrc(');
		// A $derived, so both the master and the guide effect track it.
		expect(src).toContain('$derived(\n\t\ttransportFor({');
	});

	// ONE consumer reads the shared derived rather than re-deriving the condition: two copies is how a silent master
	// once produced an audible vocals-only mix, the guide's own check not knowing the master had never started.
	test('the transport is read from the shared derived, never re-derived inline', () => {
		expect(src).toContain("if (transport === 'pause') {");
		expect(src).toContain("if (transport === 'idle') return;");
		expect(src).not.toContain('if (active && visible && playing) {');
	});

	test('play() is never called from a bare active/visible/playing check', () => {
		expect(src).not.toContain('if (active && visible && playing) master.play()');
	});

	test('a refused play() is reported rather than swallowed', () => {
		// `.catch(() => {})` on the MASTER hid the AbortError through two rounds of diagnosis.
		expect(src).not.toContain('master.play().catch(() => {})');
	});

	// Assigning `HTMLMediaElement.src` reloads the resource and resets currentTime to 0 even when the string is
	// byte-identical, so the decision must read what the ELEMENT holds: a shadow copy cleared while the element
	// still held its src rewrote an identical src and yanked the playing song back to 0 on every pause.
	test('the src decision reads the element, not a shadow copy that can go stale', () => {
		expect(src).toContain("nextVideoSrc(master.getAttribute('src') ?? ''");
		expect(src).not.toContain('nextVideoSrc(currentSrc,');
	});

	test('the reset never clears the src bookkeeping — that is what reloaded the playing song', () => {
		expect(src).not.toContain('currentSrc = null');
	});

	// Comments are stripped so prose describing the old behaviour can neither satisfy nor trip the scans.
	const code = src
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1');

	// A queue:sync rebuild makes the PLAYING slot's media read momentarily not-yet-playable, and resolving that churn
	// pass to '' used to CLEAR the element's real src (removeAttribute -> reassign -> reload at 0), so `playable` is
	// threaded into the decision and a not-playable pass is never a clear.
	test('the src decision is told whether the media is playable', () => {
		expect(code).toContain('const playable = !!media && isPlayable(media)');
		expect(code).toMatch(/nextVideoSrc\(master\.getAttribute\('src'\) \?\? '', resolved, playable\)/);
		expect(code).not.toContain("master.removeAttribute('src')");
	});

	test('currentSrc is not clobbered on a not-playable pass', () => {
		// GUARDED inside `if (playable) { … }`: assigning a possibly-empty `resolved` tells the transport the
		// still-playing song has no src.
		expect(code).toContain('currentSrc = resolved');
		expect(code).toMatch(/if\s*\(playable\)\s*\{[\s\S]*?currentSrc = resolved/);
		expect(code).not.toMatch(/\}\s*\n\s*currentSrc = resolved;/);
	});

	test('currentEntryId is written in lockstep with currentSrc, so the held token cannot go half-stale', () => {
		// Recording the src without its entry leaves turn 2 of a twice-queued song holding turn 1's entry id and
		// reopens the silent-second-turn edge, so both shadow writes live in the SAME guarded block.
		expect(code).toMatch(/if\s*\(playable\)\s*\{[\s\S]*currentSrc = resolved[\s\S]*currentEntryId = entryId/);
	});

	// Draining the room UNMOUNTS the master, but the shadows are component-level and outlive the element, so re-adding
	// the same just-ended song would read `hasSrc:true` on a fresh src-less element. This clear fires on the ABSENCE
	// of the binding (`!master`), a DIFFERENT clear from the churn pass where the element is still bound.
	test('both src+entry shadows are reset when the master element unmounts, not left to go stale', () => {
		expect(code).toMatch(/if\s*\(\s*!master\s*\)\s*\{[\s\S]*currentSrc\s*=\s*''[\s\S]*currentEntryId\s*=\s*null/);
		// Not vacuous: the reader it protects is still wired to the shadows.
		expect(code).toContain('songToken(currentEntryId, currentSrc)');
	});
});

// `transportFor` was always correct, so its own tests cannot see the defect; the fix lives in `slotHoldsSrc`.
describe("slotHoldsSrc — the element is holding THIS song's src, not merely SOME src", () => {
	const A = '/media/song-a-instrumental.wav';
	const B = '/media/song-b-instrumental.wav';

	test('true only when the held src equals the wanted src', () => {
		expect(slotHoldsSrc(A, A)).toBe(true);
	});

	test('false when the element still holds the PREVIOUS song across a change — this is', () => {
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

describe('the transport across a song change on one page', () => {
	const A = '/media/song-a-instrumental.wav';
	const B = '/media/song-b-instrumental.wav';
	// The instant B has arrived as `media` but the assign effect has not written B's src, so `currentSrc` holds A's.
	const slot = { playable: true, active: true, visible: true, playing: true };

	test('BASE BEHAVIOUR (regression): !!currentSrc plays B before its src has landed', () => {
		const hasSrcOld = !!A; // === `!!currentSrc`: truthy, so the old contract said hasSrc:true
		expect(transportFor({ ...slot, hasSrc: hasSrcOld })).toBe('play');
	});

	test('FIXED: while the element still holds A, the transport is idle — not play', () => {
		// The effect is LEFT ALONE (not paused) until the src lands, so it does not fight the assign effect.
		const hasSrc = slotHoldsSrc(A, B);
		expect(hasSrc).toBe(false);
		expect(transportFor({ ...slot, hasSrc })).toBe('idle');
	});

	test("FIXED: once the assign effect writes B's src, hasSrc flips true and B plays", () => {
		const hasSrc = slotHoldsSrc(B, B);
		expect(hasSrc).toBe(true);
		expect(transportFor({ ...slot, hasSrc })).toBe('play');
	});

	test('the idle->play VALUE edge exists across the change (the old input never produced it)', () => {
		const before = { ...slot };
		expect(transportFor({ ...before, hasSrc: !!A })).toBe(transportFor({ ...before, hasSrc: !!B })); // old: no edge
		expect(transportFor({ ...before, hasSrc: slotHoldsSrc(A, B) })).not.toBe(
			transportFor({ ...before, hasSrc: slotHoldsSrc(B, B) })
		); // new: idle -> play edge
	});
});

// A song queued twice is two `QueueEntry`s over ONE media record, so `fileSrc(media)` — and the element's held src —
// is BYTE-IDENTICAL across the advance. `songToken` (`${entryId}|${src}`) scopes the input to the entry, so turn 2
// takes a genuine `idle -> play` edge WITHOUT rewriting the src.
describe('the transport across a SAME-SONG advance (a song queued twice)', () => {
	const SRC = '/media/song-a-instrumental.wav';
	const E1 = '01J000000000000000000TURN1';
	const E2 = '01J000000000000000000TURN2';
	const slot = { playable: true, active: true, visible: true, playing: true };

	test('songToken pairs the entry with the src, and is null when either is missing', () => {
		expect(songToken(E1, SRC)).toBe(`${E1}|${SRC}`);
		expect(songToken(E2, SRC)).not.toBe(songToken(E1, SRC)); // turn 2 differs only by entry id
		expect(songToken(null, SRC)).toBeNull();
		expect(songToken(E1, null)).toBeNull();
		expect(songToken(E1, '')).toBeNull();
		expect(songToken('', SRC)).toBeNull();
	});

	test('slotHoldsSong is true only when the element has settled on THIS entry', () => {
		expect(slotHoldsSong(songToken(E1, SRC), songToken(E1, SRC))).toBe(true);
		expect(slotHoldsSong(songToken(E1, SRC), songToken(E2, SRC))).toBe(false); // same song, different entry
		expect(slotHoldsSong(songToken(E1, SRC), null)).toBe(false);
		expect(slotHoldsSong(null, songToken(E2, SRC))).toBe(false);
	});

	test('the src-only input produces NO edge across a same-song advance — the bug', () => {
		// held turn-1 src, wanted turn-2 src: byte-identical, so slotHoldsSrc is true on both sides.
		const before = transportFor({ ...slot, hasSrc: slotHoldsSrc(SRC, SRC) });
		const after = transportFor({ ...slot, hasSrc: slotHoldsSrc(SRC, SRC) });
		expect(before).toBe('play');
		expect(after).toBe('play');
		expect(before).toBe(after); // NO edge — nothing re-runs the effect, turn 2 stays silent
	});

	test('the entry-scoped input DOES take an idle -> play edge across a same-song advance — the fix', () => {
		const held = songToken(E1, SRC);
		const wantedT2 = songToken(E2, SRC);
		const before = transportFor({ ...slot, hasSrc: slotHoldsSong(held, wantedT2) }); // element still on E1
		const after = transportFor({ ...slot, hasSrc: slotHoldsSong(wantedT2, wantedT2) }); // assign effect recorded E2
		expect(before).toBe('idle');
		expect(after).toBe('play');
		expect(before).not.toBe(after); // a genuine value edge — the effect re-runs and play() replays
	});

	test('still holds under the entry-scoped input: two DIFFERENT songs also take the edge', () => {
		const SRC_B = '/media/song-b-instrumental.wav';
		const held = songToken(E1, SRC); // holding song A / entry 1
		const wantedB = songToken(E2, SRC_B); // wanting song B / entry 2
		expect(transportFor({ ...slot, hasSrc: slotHoldsSong(held, wantedB) })).toBe('idle');
		expect(transportFor({ ...slot, hasSrc: slotHoldsSong(wantedB, wantedB) })).toBe('play');
	});
});
