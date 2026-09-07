// The guiding-track backfill: which cooked songs need a vocals ref, and the existence-then-loudness
// scan that links them. Fully injected IO — no disk, no ffmpeg.
import { describe, it, expect } from 'bun:test';
import { needsVocalsBackfill, candidateVocalsRefs, backfillVocalsRefs, type VocalsBackfillIO } from './vocals-backfill';
import type { Media } from '@encore/shared';

const m = (id: string, over: Partial<Media> = {}): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'x',
	title: id,
	durationSec: 200,
	stemStatus: 'ready',
	instrumentalRef: `derived/stems/${id}-instrumental.flac`,
	...over
});

describe('needsVocalsBackfill', () => {
	it('selects cooked songs with no vocals ref', () => {
		expect(needsVocalsBackfill([m('a'), m('b')])).toEqual(['a', 'b']);
	});

	it('skips songs that already have one — never re-probes settled work', () => {
		expect(needsVocalsBackfill([m('a', { vocalsRef: 'derived/stems/a-vocals.m4a' })])).toEqual([]);
	});

	it('skips uncooked songs — they get a ref through the normal cook', () => {
		expect(needsVocalsBackfill([m('a', { stemStatus: 'none', instrumentalRef: undefined })])).toEqual([]);
		expect(needsVocalsBackfill([m('a', { stemStatus: 'queued', instrumentalRef: undefined })])).toEqual([]);
	});

	it('skips a song whose status says ready but has no instrumental', () => {
		expect(needsVocalsBackfill([m('a', { instrumentalRef: undefined })])).toEqual([]);
	});
});

describe('candidateVocalsRefs', () => {
	it('offers the modern key first', () => {
		expect(candidateVocalsRefs(m('a'))[0]).toBe('derived/stems/a-vocals.flac'); // #480: modern vocals is FLAC
	});

	it('also offers the LEGACY sibling of an older instrumental ref', () => {
		// songs cooked under the older layout keep their own extension; deriving only the modern key
		// would silently miss them
		const legacy = m('a', { instrumentalRef: 'derived/stems/a-instrumental.wav' });
		expect(candidateVocalsRefs(legacy)).toContain('derived/stems/a-vocals.wav');
	});

	it('de-duplicates when the derived and legacy refs agree', () => {
		const refs = candidateVocalsRefs(m('a', { instrumentalRef: 'derived/stems/a-instrumental.m4a' }));
		expect(new Set(refs).size).toBe(refs.length);
	});

	// #480 CRUX: flipping VOCALS_EXT to FLAC changes only what NEW cooks resolve. A stored legacy .m4a
	// vocals ref must keep resolving as-is (it is never re-derived, only new output uses the constant),
	// and a legacy .m4a-instrumental cook must still surface its .m4a vocals sibling. Existing m4a files
	// are never recompressed (retention.ts isLegacyStemRef is WAV-only); only new stems land as .flac.
	it('#480: a legacy m4a-instrumental cook still surfaces its .m4a vocals sibling (never re-derived)', () => {
		const legacyM4a = m('a', { instrumentalRef: 'derived/stems/a-instrumental.m4a' });
		expect(candidateVocalsRefs(legacyM4a)).toContain('derived/stems/a-vocals.m4a');
	});

	it('#496 G4: a FLAC-instrumental interim cook still surfaces its .m4a vocals sibling', () => {
		// The finding #488 re-measured: once VOCALS_EXT is .flac, an ext-blind swap on a .flac
		// instrumental names only -vocals.flac, so a row that never stored a ref and left an interim
		// .m4a vocals stem on disk becomes unfindable. The fallback must offer EVERY known vocals
		// extension, not just today's constant. BASE reds: Received [derived/stems/a-vocals.flac].
		const interim = m('a', { instrumentalRef: 'derived/stems/a-instrumental.flac' });
		expect(candidateVocalsRefs(interim)).toContain('derived/stems/a-vocals.m4a');
	});
});

describe('#480: a stored legacy vocals ref is honored unchanged', () => {
	it('backfill skips a song that already has a stored .m4a vocals ref — it plays via that ref', () => {
		expect(needsVocalsBackfill([m('a', { vocalsRef: 'derived/stems/a-vocals.m4a' })])).toEqual([]);
	});
});

function io(over: Partial<VocalsBackfillIO> = {}) {
	const linked: Array<[string, string]> = [];
	const base: VocalsBackfillIO = {
		resolve: (ref) => `/media/${ref}`,
		exists: () => true,
		measure: async () => 'audible',
		link: (id, ref) => linked.push([id, ref]),
		...over
	};
	return { io: base, linked };
}

describe('backfillVocalsRefs', () => {
	it('links a song whose vocals stem exists and has audio', async () => {
		const { io: deps, linked } = io();
		const res = await backfillVocalsRefs([m('a')], deps);
		expect(res).toEqual({ linked: 1, silent: 0, missing: 0, unmeasured: 0 });
		expect(linked).toEqual([['a', 'derived/stems/a-vocals.flac']]); // #480: modern vocals is FLAC
	});

	it('counts a song with no vocals file as missing, and links nothing', async () => {
		const { io: deps, linked } = io({ exists: () => false });
		const res = await backfillVocalsRefs([m('a')], deps);
		expect(res).toEqual({ linked: 0, silent: 0, missing: 1, unmeasured: 0 });
		expect(linked).toEqual([]);
	});

	it('REFUSES to link a silent stem — a guide that plays nothing looks like it works', async () => {
		const { io: deps, linked } = io({ measure: async () => 'silent' });
		const res = await backfillVocalsRefs([m('a')], deps);
		expect(res).toEqual({ linked: 0, silent: 1, missing: 0, unmeasured: 0 });
		expect(linked).toEqual([]);
	});

	it('only probes files that actually exist — the probe is the expensive half', async () => {
		let probes = 0;
		const { io: deps } = io({
			exists: () => false,
			measure: async () => {
				probes++;
				return 'audible';
			}
		});
		await backfillVocalsRefs([m('a'), m('b')], deps);
		expect(probes).toBe(0);
	});

	it('falls back to the legacy ref when the modern key is absent', async () => {
		const { io: deps, linked } = io({
			exists: (abs) => abs.endsWith('-vocals.wav')
		});
		const res = await backfillVocalsRefs([m('a', { instrumentalRef: 'derived/stems/a-instrumental.wav' })], deps);
		expect(res.linked).toBe(1);
		expect(linked[0][1]).toBe('derived/stems/a-vocals.wav');
	});

	it('skips a ref that escapes the media root rather than trusting it', async () => {
		const { io: deps } = io({ resolve: () => null });
		expect(await backfillVocalsRefs([m('a')], deps)).toEqual({ linked: 0, silent: 0, missing: 1, unmeasured: 0 });
	});

	it('links an UNMEASURABLE stem but counts it apart from linked', async () => {
		// No ffmpeg. Refusing to link would leave a box with no probe offering no guiding track at all,
		// which is worse than trusting a file the worker wrote — but reporting these as `linked` would
		// tell an operator the stems were checked when nothing was checked.
		const { io: deps, linked } = io({ measure: async () => 'unknown' });
		const res = await backfillVocalsRefs([m('a'), m('b')], deps);
		expect(res).toEqual({ linked: 0, silent: 0, missing: 0, unmeasured: 2 });
		expect(linked.map(([id]) => id)).toEqual(['a', 'b']); // linked anyway
	});

	it('mixes all three outcomes in one pass, and is a no-op for already-linked songs', async () => {
		const { io: deps, linked } = io({
			exists: (abs) => !abs.includes('gone'),
			measure: async (abs) => (abs.includes('silent') ? 'silent' : 'audible')
		});
		const res = await backfillVocalsRefs(
			[m('good'), m('silent'), m('gone'), m('done', { vocalsRef: 'derived/stems/done-vocals.m4a' })],
			deps
		);
		expect(res).toEqual({ linked: 1, silent: 1, missing: 1, unmeasured: 0 });
		expect(linked.map(([id]) => id)).toEqual(['good']);
	});
});
