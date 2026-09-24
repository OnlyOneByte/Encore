import { expect, it } from 'bun:test';
import { read } from '@encore/test-support';
import { stripComments } from '@encore/test-support/scan';

/*
 * THE BAND'S CLOCK MUST NOT JUMP ON RESUME. Pause for forty seconds, resume, and a second later the band's progress
 * ring and the drawer's elapsed / remaining readouts leap forward by the whole pause duration and stay there.
 *
 * `positionSec` arrives on an event, not a frame, so the band extrapolates from an anchor plus wall clock. The
 * anchor used to be captured by its OWN $effect tracking `positionSec` ALONE; play/pause only write `isPlaying`, so
 * a resume re-delivers the SAME number, and writing an equal primitive into a `$state` scalar notifies nothing
 * (strict ===) — the anchor effect did not re-run while the interval effect did. The arithmetic was never wrong;
 * WHICH SIGNALS re-run the capture was, and a dependency set is not a value a pure function can be handed.
 */

const LAYOUT = 'src/routes/+layout.svelte';

/** The effect that owns the extrapolation, located by the interval it arms. */
function extrapolationEffect(src: string): string {
	const code = stripComments(src, { drop: true });
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
	// Both signals in the SAME effect: `isPlaying` makes a resume re-run it, `positionSec` makes a seek snap, and the
	// clock is read HERE so every re-run re-anchors.
	expect(body).toContain('positionSec');
	expect(body).toContain('isPlaying');
	expect(body).toContain('performance.now()');
});

it('the band keeps no anchor outside that effect — a separate $state pair is the defect returning', () => {
	const code = stripComments(read(LAYOUT), { drop: true });
	// Reject the reactive SLOT rather than one spelling of the effect, so any re-introduction reds.
	expect(code).not.toMatch(/let\s+anchor\s*=\s*\$state/);
	expect(code).not.toMatch(/anchor\.(pos|wall)/);
});

it('the extrapolation reads its OWN captured locals, never a value that can go stale between runs', () => {
	const body = extrapolationEffect(read(LAYOUT));
	// `pos` and `wall` must be declared INSIDE this effect: a capture hoisted above it is reachable from a run that
	// did not refresh it, which is precisely the pause-time wall clock the bug extrapolated from.
	expect(body).toMatch(/const\s+pos\s*=\s*positionSec/);
	expect(body).toMatch(/const\s+wall\s*=\s*performance\.now\(\)/);
});
