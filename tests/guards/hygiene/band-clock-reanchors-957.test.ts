import { expect, it } from 'bun:test';
import { read } from '@encore/test-support';

/*
 * THE BAND'S CLOCK MUST NOT JUMP ON RESUME.
 *
 * The reported symptom: pause the song on the phone for forty seconds, resume, and one second later the
 * band's progress ring and the drawer's elapsed / remaining readouts leap forward by the full pause
 * duration and stay there. A long enough pause clamped the ring full and drove the remaining time to
 * zero on a song that was still playing. It self-corrected on the next pause and re-broke on the next
 * resume.
 *
 * THE MECHANISM, because the fix is a dependency-set change and nothing else.
 *
 * `positionSec` arrives on an event, not on a frame, so the band extrapolates: anchor on the last
 * authoritative position, then add wall-clock while playing. The anchor used to be captured in its OWN
 * `$state` + `$effect` pair that tracked `positionSec` ALONE:
 *
 *     let anchor = $state({ pos: 0, wall: 0 });
 *     $effect(() => { anchor = { pos: positionSec, wall: performance.now() }; });   // positionSec only
 *     $effect(() => { ... setInterval(... anchor.pos + (now - anchor.wall) ...) }); // + isPlaying
 *
 * `play` and `pause` both call `setPlayback({ isPlaying })` and never touch `positionSec`, and the
 * position-only telemetry path deliberately does not broadcast `playback:state` at all — so a resume
 * re-delivers the SAME number. Writing an equal primitive into a `$state` scalar notifies nothing
 * (strict `===`), so the anchor effect did NOT re-run while the interval effect DID, and the interval
 * extrapolated from the wall clock recorded at pause time.
 *
 * WHY A SOURCE SCAN AND NOT A UNIT TEST. The arithmetic was never wrong — `pos + elapsed` is correct at
 * every call. What was wrong is WHICH SIGNALS re-run the capture, and a dependency set is not a value a
 * pure function can be handed. This is the same reason `playhead-isolation.test.ts` scans source for the
 * TV's seek effect rather than asserting on a return value.
 *
 * WHAT THIS PINS: the wall clock is read inside the effect that also reads `isPlaying`, so every re-run
 * re-anchors. That makes a stale anchor unrepresentable rather than merely absent today.
 */

const LAYOUT = 'src/routes/+layout.svelte';

function stripComments(s: string): string {
	return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** The effect that owns the extrapolation, located by the interval it arms. */
function extrapolationEffect(src: string): string {
	const code = stripComments(src);
	const at_ = code.indexOf('livePos = pos + (performance.now()');
	expect(at_, 'expected the band to extrapolate livePos from a captured pos + wall').toBeGreaterThanOrEqual(0);
	const from = code.lastIndexOf('$effect(() => {', at_);
	expect(from).toBeGreaterThanOrEqual(0);
	let i = code.indexOf('{', from);
	const start = i;
	let depth = 0;
	for (; i < code.length; i++) {
		if (code[i] === '{') depth++;
		else if (code[i] === '}') {
			depth--;
			if (depth === 0) break;
		}
	}
	return code.slice(start, i + 1);
}

it('the band re-anchors its clock on resume: the wall clock is captured in the effect that tracks isPlaying', () => {
	const body = extrapolationEffect(read(LAYOUT));
	// Both signals read in the SAME effect. `isPlaying` is what makes a resume re-run it; `positionSec`
	// is what makes a seek or a song change snap instead of sliding from an old anchor.
	expect(body).toContain('positionSec');
	expect(body).toContain('isPlaying');
	// And the clock is read HERE, so every re-run re-anchors.
	expect(body).toContain('performance.now()');
});

it('the band keeps no anchor outside that effect — a separate $state pair is the defect returning', () => {
	const code = stripComments(read(LAYOUT));
	// The exact shape that broke: an anchor in its own reactive slot, written by its own effect. Reject
	// the slot rather than one spelling of the effect, so any re-introduction reds regardless of naming.
	expect(code).not.toMatch(/let\s+anchor\s*=\s*\$state/);
	expect(code).not.toMatch(/anchor\.(pos|wall)/);
});

it('the extrapolation reads its OWN captured locals, never a value that can go stale between runs', () => {
	const body = extrapolationEffect(read(LAYOUT));
	// `pos` and `wall` must be declared inside this effect. A capture hoisted above it is reachable from
	// a run that did not refresh it, which is precisely the pause-time wall clock the bug extrapolated
	// from.
	expect(body).toMatch(/const\s+pos\s*=\s*positionSec/);
	expect(body).toMatch(/const\s+wall\s*=\s*performance\.now\(\)/);
});
