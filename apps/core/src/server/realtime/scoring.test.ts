// M8-C3: the ScoreEngine turns mic:pitch into score:update — resolving the current song, its
// reference doc (injected loader), a per-entry accumulator, and the broadcast. Driven with a fake
// loader + publish sink (no MediaStore, no sockets).
import { test, expect } from 'bun:test';
import { ScoreEngine, type ScoreDeps } from './scoring';
import { AuthoritativeState } from '../state/store';
import type { Media, QueueEntry, ServerEvent } from '@encore/shared';
import type { RefPitchDoc } from '../scoring/scorer';

const DOC: RefPitchDoc = {
	hopSec: 0.01,
	frameCount: 4,
	f0Hz: [220, 220, 440, 440],
	midi: [57, 57, 69, 69],
	voiced: [true, true, true, true]
};

const media = (id: string, over: Partial<Media> = {}): Media => ({
	id, source: 'youtube', sourceRef: 'v', title: id, durationSec: 200, stemStatus: 'ready', playMode: 'file', ...over
});
const entry = (id: string, mediaId: string, singerId = 's1'): QueueEntry => ({
	id, mediaId, singerId, status: 'playing', rotationSeq: 0, addedAt: 1
});

function setup(mediaOver: Partial<Media> = {}) {
	const state = new AuthoritativeState();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') });
	state.setPlayback({ currentEntryId: 'q1', isPlaying: true });
	const mediaById = new Map<string, Media>([['m1', media('m1', { pitchRef: 'pitch/m1.json', ...mediaOver })]]);
	const published: ServerEvent[] = [];
	const deps: ScoreDeps = {
		state,
		mediaById,
		publish: (e) => published.push(e),
		loadDoc: async () => DOC
	};
	return { engine: new ScoreEngine(), deps, published };
}

test('primed doc: mic:pitch → score:update for the current entry', () => {
	const { engine, deps, published } = setup();
	engine.primeDoc('pitch/m1.json', DOC);
	engine.handleMicPitch({ positionSec: 0.0, f0Hz: 220 }, deps); // on pitch
	engine.handleMicPitch({ positionSec: 0.01, f0Hz: 220 }, deps); // on pitch
	expect(published).toHaveLength(2);
	const last = published.at(-1) as Extract<ServerEvent, { type: 'score:update' }>;
	expect(last).toMatchObject({ type: 'score:update', entryId: 'q1', singerId: 's1', hits: 2, total: 2 });
	expect(last.score).toBe(100);
});

test('the running score reflects sung pitch (rises on-pitch, dips on misses)', () => {
	const { engine, deps, published } = setup();
	engine.primeDoc('pitch/m1.json', DOC);
	engine.handleMicPitch({ positionSec: 0.0, f0Hz: 220 }, deps); // hit
	engine.handleMicPitch({ positionSec: 0.01, f0Hz: 110 }, deps); // 110 vs 220 = octave → still hit
	engine.handleMicPitch({ positionSec: 0.02, f0Hz: 0 }, deps); // silent while should sing → miss
	const last = published.at(-1) as Extract<ServerEvent, { type: 'score:update' }>;
	expect(last.hits).toBe(2);
	expect(last.total).toBe(3);
	expect(last.score).toBeGreaterThan(0);
	expect(last.score).toBeLessThan(100);
});

test('no current song → no score:update', () => {
	const { engine, deps, published } = setup();
	deps.state.setPlayback({ currentEntryId: null, isPlaying: false });
	engine.primeDoc('pitch/m1.json', DOC);
	engine.handleMicPitch({ positionSec: 0.0, f0Hz: 220 }, deps);
	expect(published).toHaveLength(0);
});

test('song without a reference pitch track → no scoring', () => {
	const { engine, deps, published } = setup({ pitchRef: undefined });
	engine.handleMicPitch({ positionSec: 0.0, f0Hz: 220 }, deps);
	expect(published).toHaveLength(0);
});

test('lazy load: first sample kicks the async load (skipped), later samples score', async () => {
	const { engine, deps, published } = setup(); // NOT primed → lazy path
	let loads = 0;
	deps.loadDoc = async () => {
		loads++;
		return DOC;
	};
	engine.handleMicPitch({ positionSec: 0.0, f0Hz: 220 }, deps); // triggers load, no publish yet
	expect(published).toHaveLength(0);
	expect(loads).toBe(1);
	await Promise.resolve(); // let the load microtask settle
	await Promise.resolve();
	engine.handleMicPitch({ positionSec: 0.01, f0Hz: 220 }, deps); // now the doc is cached → scores
	expect(published).toHaveLength(1);
	expect(loads).toBe(1); // loaded once, cached thereafter
});
