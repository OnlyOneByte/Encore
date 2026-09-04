// The guiding-track backfill: which cooked songs need a vocals ref, and the existence-then-loudness
// scan that links them. Fully injected IO — no disk, no ffmpeg.
import { describe, it, expect } from 'bun:test';
import {
	needsVocalsBackfill,
	candidateVocalsRefs,
	backfillVocalsRefs,
	type VocalsBackfillIO
} from './vocals-backfill';
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
		expect(candidateVocalsRefs(m('a'))[0]).toBe('derived/stems/a-vocals.m4a');
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
		expect(linked).toEqual([['a', 'derived/stems/a-vocals.m4a']]);
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

	it('mixes all three outcomes in one pass, and is a no-op for already-linked songs', async () => {		const { io: deps, linked } = io({
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
