import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { transportFor, slotHoldsSrc, slotHoldsSong, songToken, type TransportInputs } from './transport';

const base: TransportInputs = { hasSrc: true, playable: true, active: true, visible: true, playing: true };
const at = (over: Partial<TransportInputs>) => transportFor({ ...base, ...over });

test('transportFor: the visible, active slot of a playable song plays', () => {
	expect(at({})).toBe('play');
});

/*
 * THE REGRESSION. This is the whole defect: `play()` on an element that has not been given its src
 * is undone by the src assignment (the media load algorithm sets `paused` back to true) and its
 * promise rejects with AbortError. Measured in a real browser: play()-then-src leaves the element at
 * readyState 4 with correct duration, no error, and currentTime pinned at 0 forever — the exact
 * state the live TV was in. There must be NO combination of inputs that plays a src-less element.
 */
test('transportFor never plays an element that is not holding its src', () => {
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

test('transportFor: a slot with no src is left ALONE, not paused — idle is a distinct answer', () => {
	expect(at({ hasSrc: false })).toBe('idle');
});

test('transportFor: nothing playable has no transport at all', () => {
	expect(at({ playable: false })).toBe('idle');
});

test('transportFor: the hidden pre-warming slot does not play', () => {
	expect(at({ visible: false })).toBe('pause');
	expect(at({ active: false })).toBe('pause');
});

test('transportFor: the room pause reaches the master', () => {
	expect(at({ playing: false })).toBe('pause');
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
const src = readFileSync(join(import.meta.dir, 'TvPlayer.svelte'), 'utf8');

test('TvPlayer wires the transport to the src, not to declaration order: the transport decision is driven by transportFor', () => {
	expect(src).toContain('transportFor(');
});

test('TvPlayer wires the transport to the src, not to declaration order: the transport hasSrc means "holding THIS ENTRY\'s src", so a same-song advance re-runs it', () => {
	const calls = src.split('transportFor({').slice(1);
	expect(calls.length).toBe(1); // ONE decision, derived once
	const call = calls[0]!.slice(0, 1600);
	// The input must compare the element's ENTRY-scoped token against the CURRENT entry's, not merely
	// ask "has this slot ever held a src" (`!!currentSrc`, stale-true across ANY change) and not
	// merely "does the element hold this SONG's src" (`slotHoldsSrc`, stale-true across a SAME-SONG
	// advance because the src is byte-identical). `slotHoldsSong(songToken(currentEntryId, ...),
	// songToken(entryId, ...fileSrc(media)...))` gives the `idle -> play` value edge exactly when the
	// assign effect records the new entry, even for turn 2 of a twice-queued song.
	expect(call).toContain('hasSrc: slotHoldsSong(');
	expect(call).toContain('songToken(currentEntryId, currentSrc)');
	expect(call).toContain('songToken(entryId,');
	expect(call).toContain('fileSrc(media)');
	expect(call).not.toContain('hasSrc: !!currentSrc');
	// regression trap: the reader must NOT be the src-only helper — that is exactly the shape that
	// stayed stale-true across a same-song advance and left turn 2 silent.
	expect(call).not.toContain('hasSrc: slotHoldsSrc(');
	// and it must be a $derived, so both the master and the guide effect track it
	expect(src).toContain('$derived(\n\t\ttransportFor({');
});

/*
 * The master and the guide must read the SAME decision. Two copies of the same condition is how a
 * silent master still produced an audible vocals-only mix: the guide's own `active && visible &&
 * playing` check did not know the master had never started.
 */
test('TvPlayer wires the transport to the src, not to declaration order: the guide reads the same transport as the master, not its own copy', () => {
	expect(src).toContain("if (transport === 'play') {");
	expect(src).not.toContain('if (active && visible && playing) {');
});

test('TvPlayer wires the transport to the src, not to declaration order: play() is never called from a bare active/visible/playing check', () => {
	// The exact shape of the defect: the old effect body. Its return is what regressed.
	expect(src).not.toContain('if (active && visible && playing) master.play()');
});

test('TvPlayer wires the transport to the src, not to declaration order: a refused play() is reported rather than swallowed', () => {
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
test('TvPlayer wires the transport to the src, not to declaration order: the src decision reads the element, not a shadow copy that can go stale', () => {
	// The decision is made against what the ELEMENT holds (`master.getAttribute('src')`), never a
	// shadow copy that could be cleared while the element still held its src.
	expect(src).toContain("nextVideoSrc(master.getAttribute('src') ?? ''");
	expect(src).not.toContain('nextVideoSrc(currentSrc,');
});

test('TvPlayer wires the transport to the src, not to declaration order: the reset never clears the src bookkeeping — that is what reloaded the playing song', () => {
	expect(src).not.toContain('currentSrc = null');
});

/*
 * . A next-up cook reaching a stage rebroadcasts queue:sync; the TV rebuilds its catalog and the
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

test('TvPlayer wires the transport to the src, not to declaration order: the src decision is told whether the media is playable', () => {
	// The pivot of the fix: `playable` is computed and passed to the decision, so a not-playable
	// churn pass returns changed:false instead of clearing.
	expect(code).toContain('const playable = !!media && isPlayable(media)');
	expect(code).toMatch(/nextVideoSrc\(master\.getAttribute\('src'\) \?\? '', resolved, playable\)/);
	// The element is never CLEARED any more — the old '' -> removeAttribute dance is gone.
	expect(code).not.toContain("master.removeAttribute('src')");
});

test('TvPlayer wires the transport to the src, not to declaration order: currentSrc is not clobbered on a not-playable pass', () => {
	// The bookkeeping the transport gates on must survive a churn pass, so its write is guarded on
	// `playable` rather than assigned unconditionally to a possibly-empty `resolved`. (the same-song advance fix moved the
	// write inside a `if (playable) { ... }` block that also records `currentEntryId`; the guard on the
	// write's playability is what matters, so match the assignment inside the guarded block.)
	expect(code).toContain('currentSrc = resolved');
	// The write must be GUARDED on `playable` (inside the `if (playable) { ... }` block), never a bare
	// unconditional assignment that would clobber the still-playing song's src on a not-playable churn.
	expect(code).toMatch(/if\s*\(playable\)\s*\{[\s\S]*?currentSrc = resolved/);
	expect(code).not.toMatch(/\}\s*\n\s*currentSrc = resolved;/);
});

test('TvPlayer wires the transport to the src, not to declaration order: currentEntryId is written in lockstep with currentSrc, so the held token cannot go half-stale', () => {
	// The transport reader compares an entry-scoped token; recording the src without the entry it
	// belongs to would leave turn 2 of a twice-queued song holding turn 1's entry id and reintroduce
	// the silent-second-turn edge. Both shadow writes must live in the SAME playable-guarded block.
	expect(code).toMatch(/if\s*\(playable\)\s*\{[\s\S]*currentSrc = resolved[\s\S]*currentEntryId = entryId/);
});

/*
 * — draining the room UNMOUNTS the master (`{#if media && isPlayable(media)}`), but `currentSrc`
 * is a component-level shadow that outlives the element. Re-adding the SAME just-ended song resolves
 * to the byte-identical src, so `slotHoldsSrc(currentSrc, …)` reads `true` on a fresh, src-less
 * element: the transport is `'play'` on its first pass, races the src assignment, is aborted, and —
 * the derived value never having changed — is never retried. The room is silent while every surface
 * says it is playing. The fix clears the shadow WHEN THE ELEMENT IS GONE, so a remounted element reads
 * `hasSrc:false` and the transport takes a genuine `idle -> play` edge once the assign effect lands the
 * new src. This is a DIFFERENT clear from the not-playable churn pass (element still bound, keep
 * the song) — it fires only on the unmount, and no such reset exists on base, so this reds today.
 * Comments are stripped so the prose above (which names the old and new shapes) can neither satisfy
 * nor trip it.
 */
test('TvPlayer wires the transport to the src, not to declaration order: both src+entry shadows are reset when the master element unmounts, not left to go stale', () => {
	// A guard against the shadows that survive the drain. The reset must fire on the ABSENCE of the
	// binding (`!master`) — a genuine unmount — and clear BOTH the src shadow (so a re-added same-song
	// element does not read a stale hasSrc:true) and the entry shadow (the held token half).
	// Wrap-tolerant on whitespace between tokens.
	expect(code).toMatch(/if\s*\(\s*!master\s*\)\s*\{[\s\S]*currentSrc\s*=\s*''[\s\S]*currentEntryId\s*=\s*null/);
	// Not vacuous: the reader it protects is still wired to the shadow (if someone rewires the transport
	// reader off these shadows, this reset stops being load-bearing and this anchor should be revisited —
	// until then it must exist).
	expect(code).toContain('songToken(currentEntryId, currentSrc)');
});

/*
 * — "skip the only queued song, add another, nothing plays until you pause/unpause"; more
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
const A = '/media/song-a-instrumental.wav';
const B = '/media/song-b-instrumental.wav';

test("slotHoldsSrc — the element is holding THIS song's src, not merely SOME src: true only when the held src equals the wanted src", () => {
	expect(slotHoldsSrc(A, A)).toBe(true);
});

test("slotHoldsSrc — the element is holding THIS song's src, not merely SOME src: false when the element still holds the PREVIOUS song across a change — this is the stale-src defect", () => {
	// The slot holds A's URL; the current media now resolves to B. The old `!!currentSrc` read this
	// as `true` (a src exists) and kept the transport at `'play'`; `slotHoldsSrc` reads it as `false`
	// because the element is NOT yet holding B.
	expect(slotHoldsSrc(A, B)).toBe(false);
});

test("slotHoldsSrc — the element is holding THIS song's src, not merely SOME src: false when there is nothing to hold", () => {
	expect(slotHoldsSrc('', A)).toBe(false);
	expect(slotHoldsSrc(null, A)).toBe(false);
	expect(slotHoldsSrc(undefined, A)).toBe(false);
	expect(slotHoldsSrc(A, null)).toBe(false);
	expect(slotHoldsSrc(A, undefined)).toBe(false);
	expect(slotHoldsSrc(A, '')).toBe(false);
});

const srcAForSongChange = '/media/song-a-instrumental.wav';
const srcBForSongChange = '/media/song-b-instrumental.wav';
// The slot state at the moment the new song B has arrived as `media` but the assign effect has not
// yet written B's src to the element, so `currentSrc` still holds A's URL. This is the exact instant
// the stale-src defect is about.
const slotForSongChange = { playable: true, active: true, visible: true, playing: true };

test('the transport across a song change on one page — BASE BEHAVIOUR (regression): !!currentSrc plays B before its src has landed', () => {
	// The OLD input. `currentSrc` (A) is truthy, so the old contract said hasSrc:true and the derived
	// returned 'play' — for an element still holding A / holding nothing. play() then races the src
	// assignment and is undone by it. This 'play' is the bug.
	const hasSrcOld = !!srcAForSongChange; // === `!!currentSrc`
	expect(transportFor({ ...slotForSongChange, hasSrc: hasSrcOld })).toBe('play');
});

test('the transport across a song change on one page — FIXED: while the element still holds A, the transport is idle — not play', () => {
	// The NEW input via slotHoldsSrc: held=A, wanted=fileSrc(B)=B → false → 'idle'. The effect is
	// LEFT ALONE (not paused) until the src lands, so it does not fight the assign effect.
	const hasSrc = slotHoldsSrc(srcAForSongChange, srcBForSongChange);
	expect(hasSrc).toBe(false);
	expect(transportFor({ ...slotForSongChange, hasSrc })).toBe('idle');
});

test("the transport across a song change on one page — FIXED: once the assign effect writes B's src, hasSrc flips true and B plays", () => {
	// currentSrc has now been rewritten to B (the playable-pass write). held=B, wanted=B → true. The
	// derived VALUE has changed ('idle' -> 'play'), so the effect re-runs and plays B — after the src
	// has landed, which is the whole point.
	const hasSrc = slotHoldsSrc(srcBForSongChange, srcBForSongChange);
	expect(hasSrc).toBe(true);
	expect(transportFor({ ...slotForSongChange, hasSrc })).toBe('play');
});

test('the transport across a song change on one page — the idle->play VALUE edge exists across the change (the old input never produced it)', () => {
	// Old input: same value 'play' on both sides of the change (A truthy before, B truthy after) — no
	// edge, so the memoized derived never re-runs the effect. New input: 'idle' then 'play' — a real
	// value change that DOES re-run it. This edge is the fix.
	const before = { ...slotForSongChange };
	expect(transportFor({ ...before, hasSrc: !!srcAForSongChange })).toBe(
		transportFor({ ...before, hasSrc: !!srcBForSongChange })
	); // old: no edge
	expect(transportFor({ ...before, hasSrc: slotHoldsSrc(srcAForSongChange, srcBForSongChange) })).not.toBe(
		transportFor({ ...before, hasSrc: slotHoldsSrc(srcBForSongChange, srcBForSongChange) })
	); // new: idle -> play edge
});

/*
 * — "queue a song TWICE and its second turn never plays". Turn 1 and turn 2 are two separate
 * `QueueEntry`s (distinct client-minted ids) but ONE media record, so `fileSrc(media)` — and thus the
 * element's held src — is BYTE-IDENTICAL across the advance. The stale-src fix compared src strings, so on a
 * same-song advance `slotHoldsSrc(currentSrc, wanted)` is `true` on BOTH sides: no value edge, the
 * transport `$derived` keeps `'play'`, its effect never re-runs, and since `ended` has paused the
 * element and the byte-identical src reset currentTime to 0, the room sits silent at 0 with no
 * affordance. The fix scopes the transport input to the ENTRY via a `songToken` (`${entryId}|${src}`)
 * and the pure `slotHoldsSong`, so turn 2 is a DIFFERENT wanted token and the change takes a genuine
 * `idle -> play` edge — WITHOUT rewriting the byte-identical src.
 *
 * These are the pure-helper tests; the wiring guard above pins that TvPlayer actually passes the token.
 */
const SRC = '/media/song-a-instrumental.wav';
const E1 = '01J000000000000000000TURN1';
const E2 = '01J000000000000000000TURN2';
const slot = { playable: true, active: true, visible: true, playing: true };

test('the transport across a SAME-SONG advance (a song queued twice): songToken pairs the entry with the src, and is null when either is missing', () => {
	expect(songToken(E1, SRC)).toBe(`${E1}|${SRC}`);
	// turn 2 of the SAME song differs only by entry id — but it DOES differ
	expect(songToken(E2, SRC)).not.toBe(songToken(E1, SRC));
	// absent legs => no token (mirrors slotHoldsSrc's "nothing to hold" leg)
	expect(songToken(null, SRC)).toBeNull();
	expect(songToken(E1, null)).toBeNull();
	expect(songToken(E1, '')).toBeNull();
	expect(songToken('', SRC)).toBeNull();
});

test('the transport across a SAME-SONG advance (a song queued twice): slotHoldsSong is true only when the element has settled on THIS entry', () => {
	expect(slotHoldsSong(songToken(E1, SRC), songToken(E1, SRC))).toBe(true);
	// same song, DIFFERENT entry (turn 1 held, turn 2 wanted): NOT holding it yet
	expect(slotHoldsSong(songToken(E1, SRC), songToken(E2, SRC))).toBe(false);
	// no wanted / no held => false, like slotHoldsSrc
	expect(slotHoldsSong(songToken(E1, SRC), null)).toBe(false);
	expect(slotHoldsSong(null, songToken(E2, SRC))).toBe(false);
});

/*
 * THE NAMED GUARD, red on base. On base the transport input is `slotHoldsSrc`, which compares only
 * the src: for a same-song advance held===wanted===SRC on BOTH sides, so both decisions are 'play'
 * and there is NO edge — the exact hole. Expressed against the SRC-ONLY input this assertion FAILS
 * (both 'play'); against the ENTRY-scoped input it PASSES (idle -> play). This is what makes the same-song
 * advance case dispatchable and is byte-for-byte the case the song-change describe block could never reach because every one of
 * its cases used two DIFFERENT songs.
 */
test('the transport across a SAME-SONG advance (a song queued twice): the src-only input produces NO edge across a same-song advance — the bug', () => {
	// held turn-1 src, wanted turn-2 src: byte-identical, so slotHoldsSrc is true on both sides.
	const before = transportFor({ ...slot, hasSrc: slotHoldsSrc(SRC, SRC) });
	const after = transportFor({ ...slot, hasSrc: slotHoldsSrc(SRC, SRC) });
	expect(before).toBe('play');
	expect(after).toBe('play');
	expect(before).toBe(after); // NO edge — nothing re-runs the effect, turn 2 stays silent
});

test('the transport across a SAME-SONG advance (a song queued twice): the entry-scoped input DOES take an idle -> play edge across a same-song advance — the fix', () => {
	// held = turn 1's token, wanted = turn 2's token (same src, different entry).
	const held = songToken(E1, SRC);
	const wantedT2 = songToken(E2, SRC);
	const before = transportFor({ ...slot, hasSrc: slotHoldsSong(held, wantedT2) }); // element still on E1
	const after = transportFor({ ...slot, hasSrc: slotHoldsSong(wantedT2, wantedT2) }); // assign effect recorded E2
	expect(before).toBe('idle');
	expect(after).toBe('play');
	expect(before).not.toBe(after); // a genuine value edge — the effect re-runs and play() replays
});

test('the transport across a SAME-SONG advance (a song queued twice): still holds under the entry-scoped input — two DIFFERENT songs also take the edge', () => {
	const SRC_B = '/media/song-b-instrumental.wav';
	const held = songToken(E1, SRC); // holding song A / entry 1
	const wantedB = songToken(E2, SRC_B); // wanting song B / entry 2
	expect(transportFor({ ...slot, hasSrc: slotHoldsSong(held, wantedB) })).toBe('idle');
	expect(transportFor({ ...slot, hasSrc: slotHoldsSong(wantedB, wantedB) })).toBe('play');
});
