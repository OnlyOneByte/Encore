// guard: skip a song and the instrumental was silent until you touched the semitones. A PitchShiftGraph
// binds a PERMANENT MediaElementAudioSourceNode to its element, and the master element lives as long as the
// SLOT — but the per-song reset effect used to detach() its graph on every song change, and detach() cannot
// restore the native path, so the still-captured element was left feeding a disconnected node until a later
// keyShift built a new graph on it. Two halves: the behavioural primitive the fix leans on (a routed graph
// SURVIVES setShift(0) still routed, where detach() tears the context down) under stubbed WebAudio, and a
// source scan that the reset is wired to setShift(0) and NOT detach(), since bun cannot run a .svelte effect.
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { read } from '@encore/test-support';
import { PitchShiftGraph } from '$lib/tv/pitch-shift';
import { stripComments } from '@encore/test-support/scan';

class StubNode {
	connections: unknown[] = [];
	port = { postMessage: (_m: unknown) => {} };
	connect(dest: unknown) {
		this.connections.push(dest);
		return dest as StubNode;
	}
	disconnect() {
		this.connections = [];
	}
}
class StubGain extends StubNode {
	gain = { value: 1 };
}
class StubSource extends StubNode {
	constructor(public el: unknown) {
		super();
	}
}
class StubAudioContext {
	state: 'suspended' | 'running' | 'closed' = 'running';
	destination = new StubNode();
	sources: StubSource[] = [];
	async resume() {
		this.state = 'running';
	}
	async close() {
		this.state = 'closed';
	}
	createMediaElementSource(el: unknown) {
		const s = new StubSource(el);
		this.sources.push(s);
		return s as unknown as MediaElementAudioSourceNode;
	}
	createGain() {
		return new StubGain() as unknown as GainNode;
	}
	audioWorklet = { addModule: async (_url: string) => {} };
}

const g = globalThis as unknown as Record<string, unknown>;
let saved: Record<string, unknown> = {};

beforeEach(() => {
	saved = { window: g.window, AudioWorkletNode: g.AudioWorkletNode, Blob: g.Blob, URL: g.URL };
	g.window = { AudioContext: StubAudioContext };
	g.AudioWorkletNode = StubNode;
	g.Blob = class {
		constructor(
			public parts: unknown[],
			public opts: unknown
		) {}
	};
	g.URL = { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} };
});

afterEach(() => {
	for (const k of Object.keys(saved)) g[k] = saved[k];
});

function fakeEl(): HTMLMediaElement {
	return {} as HTMLMediaElement;
}

test('a routed master graph SURVIVES setShift(0) -- stays routed (song-change reset)', async () => {
	const graph = new PitchShiftGraph(fakeEl());
	await graph.setShift(1);
	expect(graph.isRouted).toBe(true);
	await graph.setShift(0);
	expect(graph.isRouted).toBe(true);
	expect(graph.isDegraded).toBe(false);
});

test('control: detach() (the OLD per-song call) closes the context -- the silence path', async () => {
	const graph = new PitchShiftGraph(fakeEl());
	await graph.setShift(1);
	expect(graph.isRouted).toBe(true);
	graph.detach();
	await graph.setShift(2);
	expect(graph.isRouted).toBe(true);
	expect(graph.isDegraded).toBe(false);
});

function resetEffectBody(s: string): string {
	const anchor = 'if (id === resetForId) return;';
	const start = s.indexOf(anchor);
	expect(start).toBeGreaterThanOrEqual(0);
	let i = s.indexOf('{', s.lastIndexOf('$effect', start));
	const from = i;
	let depth = 0;
	for (; i < s.length; i++) {
		if (s[i] === '{') depth++;
		else if (s[i] === '}') {
			depth--;
			if (depth === 0) break;
		}
	}
	return s.slice(from, i + 1);
}

const TV = read('src/lib/tv/TvPlayer.svelte');

test('guard: the per-song reset resets the master graph via setShift(0)', () => {
	const body = stripComments(resetEffectBody(TV), { drop: true });
	expect(body).toMatch(/masterGraph[?][.]setShift[(]\s*0\s*[)]/);
});

test('guard (mutation trap): the per-song reset must NOT detach the master graph', () => {
	const body = stripComments(resetEffectBody(TV), { drop: true });
	expect(body).not.toMatch(/masterGraph[?][.]detach[(]/);
});

test('guard (not-vacuous): the destroy effect detaches the graph on slot unmount', () => {
	// ONE graph, because there is one element: a reappearing `guideGraph?.detach()` here would mean the
	// second <audio> and its own PitchShiftGraph came back.
	const stripped = stripComments(TV, { drop: true });
	const destroyIdx = stripped.indexOf('return () => {');
	expect(destroyIdx).toBeGreaterThanOrEqual(0);
	const destroyRegion = stripped.slice(destroyIdx, destroyIdx + 300);
	expect(destroyRegion).toMatch(/masterGraph[?][.]detach[(]/);
	expect(destroyRegion).not.toMatch(/guideGraph/);
});

// The master element genuinely dies when a drained room unmounts the <audio> behind
// {#if media && isPlayable(media)}, and the `if (!master)` shadow-clear effect is where that death is
// detected. Anchor on `currentEntryId = null`, which sits inside that block and survives comment
// stripping: it is distinct from the per-song reset (which keys on `resetForId`) and from the destroy
// effect (which uses `return () =>`).
function masterUnmountEffectBody(s: string): string {
	const marker = s.indexOf('currentEntryId = null');
	expect(marker).toBeGreaterThanOrEqual(0);
	const from = s.lastIndexOf('$effect', marker);
	expect(from).toBeGreaterThanOrEqual(0);
	let i = s.indexOf('{', from);
	const start = i;
	let depth = 0;
	for (; i < s.length; i++) {
		if (s[i] === '{') depth++;
		else if (s[i] === '}') {
			depth--;
			if (depth === 0) break;
		}
	}
	return s.slice(start, i + 1);
}

test('guard: the element-unmount effect releases the master graph AND drops the reference', () => {
	const stripped = stripComments(TV, { drop: true });
	const body = masterUnmountEffectBody(stripped);
	// Not-vacuous: this really is the `if (!master)` shadow-clear effect (renaming it away reds here).
	expect(body).toMatch(/if\s*[(]\s*!master\s*[)]/);
	expect(body).toMatch(/currentSrc = ''/);
	// Dropping the REFERENCE is the load-bearing half: detach() alone leaves `masterGraph` truthy, so the
	// build site's `!masterGraph` guard stays false forever, the next song's fresh element is never captured,
	// and the instrumental stops transposing for the page's life. The per-song reset must NOT do this -- the
	// release belongs only where the ELEMENT dies.
	expect(body).toMatch(/masterGraph[?][.]detach[(]/);
	expect(body).toMatch(/masterGraph = undefined/);
});

test('guard (symmetry): master graph is released in BOTH destroy and element unmount', () => {
	// Destroy alone needs the whole slot torn down (a page reload), which no host would do -- so there must be
	// more than one `masterGraph?.detach()`: the destroy effect plus the element-unmount effect.
	const stripped = stripComments(TV, { drop: true });
	const detaches = stripped.match(/masterGraph[?][.]detach[(]/g) ?? [];
	expect(detaches.length).toBeGreaterThan(1);
});
