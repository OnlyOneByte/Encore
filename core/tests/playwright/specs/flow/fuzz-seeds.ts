/**
 * Seeds that broke an invariant, replayed by `fuzz.spec.ts` on every run that names no `FUZZ_SEED` and no
 * `FUZZ_RANDOM`. A new failing seed prints its replay line (`fuzz.spec.ts`, `violationReport`): paste it here
 * with the invariant it broke.
 *
 * `open: true` is a KNOWN BUG with no fix yet. Its test is held by `test.fail` the way `p4-transport.spec.ts`
 * holds the seek-past-EOF defect, but only for the invariant named here: the same seed breaking a DIFFERENT one,
 * or breaking nothing, goes red, so a fix (or a new defect) cannot pass unnoticed. When its fix lands, set
 * `open: false` and the seed stays as a plain regression test.
 */

export type InvariantId = 'I1' | 'I2' | 'I3' | 'I4' | 'I5' | 'I6';

export interface KnownSeed {
	seed: number;
	inputs: number;
	invariant: InvariantId;
	note: string;
	open: boolean;
}

export const KNOWN_SEEDS: KnownSeed[] = [
	{
		seed: 3059073472,
		inputs: 24,
		invariant: 'I4',
		note: 'the lyrics highlight sits on a line whose window does not hold the playhead, with the song paused',
		open: true
	},
	{
		// NOT A ROOM BUG. A song queued twice in a row ended between I6's two samples; the repeat kept the same
		// src, and I6 compared the new entry's fresh element (0.8 s in, decoding normally) with the old one's byte
		// count. Fixed in the harness (I6 now skips when the entry advances); kept as that guard's regression seed.
		seed: 3070909777,
		inputs: 24,
		invariant: 'I6',
		note: 'a repeat of the same song advanced between the two decoder samples',
		open: false
	}
];
