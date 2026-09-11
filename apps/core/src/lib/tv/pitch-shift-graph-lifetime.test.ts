// Regression guard for #477 -- skip a song and the instrumental is silent until you touch the
// semitones.
//
// ROOT CAUSE (owner-triaged at 9b07153, confirmed by reading the code): a PitchShiftGraph binds a
// PERMANENT MediaElementAudioSourceNode to its element (see createMediaElementSource in
// PitchShiftGraph.build, pitch-shift.ts). The master audio
// element is mounted unconditionally and lives as long as the SLOT, but TvPlayer per-song reset
// effect used to detach() its graph on every song change. detach() cannot restore the native path,
// so the still-captured element was left feeding a disconnected node = silent instrumental. A later
// keyShift built a NEW graph on the same element and re-routed it -- exactly the touch-the-semitones
// workaround in the report. The guide element sits behind an {#if wantsGuide && guideRef} block so it
// is remounted per song (fresh, uncaptured element) and keeps playing -- the asymmetry naming the bug.
//
// Two halves pin the fix:
//   A. BEHAVIOURAL -- drive the REAL PitchShiftGraph under stubbed WebAudio and prove the primitive
//      the fix leans on: a routed graph SURVIVES setShift(0) still routed, whereas detach() (the old
//      per-song call) tears the context down. No audio hardware -- same technique as pitch-worklet.
//   B. SOURCE-SCAN -- the reset effect lives inside a .svelte effect bun cannot execute without a
//      Svelte compile + DOM, so a text scan proves the fix is WIRED: on song change the master graph
//      is reset via setShift(0) and is NOT detached. Mutation trap: reintroducing masterGraph.detach()
//      in that block reds it.
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PitchShiftGraph } from './pitch-shift';

// -- A. Behavioural: routing lifetime under stubbed WebAudio --------------------------------------

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

// -- B. Source-scan: reset wired to setShift(0), not detach(), for the master ---------------------

function stripComments(s: string): string {
	return s.replace(/[/][*][\s\S]*?[*][/]/g, '').replace(/(^|[^:])[/][/][^\n]*/g, '$1');
}

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

const TV = readFileSync(join(import.meta.dir, 'TvPlayer.svelte'), 'utf8');

test('guard: the per-song reset resets the master graph via setShift(0)', () => {
	const body = stripComments(resetEffectBody(TV));
	expect(body).toMatch(/masterGraph[?][.]setShift[(]\s*0\s*[)]/);
});

test('guard (mutation trap): the per-song reset must NOT detach the master graph', () => {
	const body = stripComments(resetEffectBody(TV));
	expect(body).not.toMatch(/masterGraph[?][.]detach[(]/);
});

test('guard (not-vacuous): the destroy effect still detaches BOTH graphs on slot unmount', () => {
	const stripped = stripComments(TV);
	const destroyIdx = stripped.indexOf('return () => {');
	expect(destroyIdx).toBeGreaterThanOrEqual(0);
	const destroyRegion = stripped.slice(destroyIdx, destroyIdx + 300);
	expect(destroyRegion).toMatch(/masterGraph[?][.]detach[(]/);
	expect(destroyRegion).toMatch(/guideGraph[?][.]detach[(]/);
});

// -- #694: the guide element PERSISTS across a song-to-song skip, so the per-song reset must reset
//    it IN PLACE (setShift(0) + re-apply setGain) rather than detach() it. detach() on the still-
//    mounted, permanently-captured element is the silence-until-a-tone-press bug the master already
//    escaped in #477. Same two halves as above: A behavioural (the primitive survives), B source-scan
//    (the reset is wired for the guide, and detach() moved to the genuine-unmount effect).

test('a routed GUIDE graph SURVIVES setShift(0) -- stays routed (song-change reset)', async () => {
	const graph = new PitchShiftGraph(fakeEl());
	await graph.setShift(1);
	expect(graph.isRouted).toBe(true);
	await graph.setShift(0);
	expect(graph.isRouted).toBe(true);
	expect(graph.isDegraded).toBe(false);
});

test('control: detach() on the still-mounted guide element closes the context -- the silence path', async () => {
	const graph = new PitchShiftGraph(fakeEl());
	await graph.setShift(1);
	expect(graph.isRouted).toBe(true);
	graph.detach();
	// A tone press builds a NEW graph on the same element and re-routes -- the "until tone buttons"
	// workaround. The detached graph itself never comes back; that is why detach() song-to-song was wrong.
	await graph.setShift(2);
	expect(graph.isRouted).toBe(true);
	expect(graph.isDegraded).toBe(false);
});

test('guard: the per-song reset resets the GUIDE graph via setShift(0) and re-applies the level', () => {
	const body = stripComments(resetEffectBody(TV));
	expect(body).toMatch(/guideGraph[?][.]setShift[(]\s*0\s*[)]/);
	// The re-apply is load-bearing (#434: a fresh/reset graph defaults its gain to 1). It must use the
	// resolved room level, not a literal.
	expect(body).toMatch(/guideGraph[?][.]setGain[(]\s*effectiveGuide\s*[)]/);
});

test('guard (mutation trap): the per-song reset must NOT detach the guide graph', () => {
	const body = stripComments(resetEffectBody(TV));
	expect(body).not.toMatch(/guideGraph[?][.]detach[(]/);
});

// The detach() the reset used to do still has to happen where the guide element GENUINELY unmounts
// (guideMountable goes false: a ref-less or non-playable next song). Prove that release path exists as
// its own effect keyed on guideMountable -- otherwise the fix would leak a context bound to a removed
// element. Located by the effect's own comment anchor so it is distinct from the destroy effect.
function guideUnmountEffectBody(s: string): string {
	// Anchor on a CODE token (survives comment stripping): the effect declares its own
	// `guideDetachedForUnmount` latch immediately above it.
	const marker = s.indexOf('guideDetachedForUnmount');
	expect(marker).toBeGreaterThanOrEqual(0);
	const from = s.indexOf('$effect', marker);
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

test('guard (not-vacuous): a dedicated effect releases the guide graph when guideMountable goes false', () => {
	const stripped = stripComments(TV);
	const body = guideUnmountEffectBody(stripped);
	// It gates on guideMountable and detaches only on the false transition.
	expect(body).toMatch(/guideMountable/);
	expect(body).toMatch(/guideGraph[?][.]detach[(]/);
	expect(body).toMatch(/guideGraph = undefined/);
});

// -- #825: the MASTER element genuinely dies when a drained room unmounts the <audio> behind
//    {#if media && isPlayable(media)}. The `if (!master)` element-unmount effect (the #674 shadow
//    clear) is where that death is detected, so it must ALSO release the master graph and DROP its
//    reference -- detach() alone leaves `masterGraph` truthy and the build site's `!masterGraph` guard
//    stays false forever, so the next song's fresh element is never captured and the instrumental
//    stops transposing for the page's life (the master counterpart of the guide's #694 release). The
//    per-song reset must NOT do this (that is #477); the release lives only where the ELEMENT dies.
function masterUnmountEffectBody(s: string): string {
	// Anchor on the shadow-clear the #674 fix does when the element is gone: `currentEntryId = null`
	// sits inside the `if (!master)` block and survives comment stripping. This is distinct from the
	// per-song reset (which keys on `resetForId`) and the destroy effect (which uses `return () =>`).
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
	const stripped = stripComments(TV);
	const body = masterUnmountEffectBody(stripped);
	// Not-vacuous: this really is the `if (!master)` shadow-clear effect (renaming it away reds here).
	expect(body).toMatch(/if\s*[(]\s*!master\s*[)]/);
	expect(body).toMatch(/currentSrc = ''/);
	// The fix: detach frees the context, and dropping the reference is the load-bearing half -- without
	// it `!masterGraph` at the build site stays false forever and the next song is never captured.
	expect(body).toMatch(/masterGraph[?][.]detach[(]/);
	expect(body).toMatch(/masterGraph = undefined/);
});

test('guard (symmetry): master graph is released in BOTH destroy and element unmount', () => {
	// destroy alone is not enough -- it needs the whole slot torn down (a page reload), which no host
	// would do. There must be more than one `masterGraph?.detach()` in the file: the destroy effect
	// plus the element-unmount effect.
	const stripped = stripComments(TV);
	const detaches = stripped.match(/masterGraph[?][.]detach[(]/g) ?? [];
	expect(detaches.length).toBeGreaterThan(1);
});
