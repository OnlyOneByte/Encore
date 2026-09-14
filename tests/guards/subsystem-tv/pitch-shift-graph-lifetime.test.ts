// Regression guard for the song-change instrumental silence -- skip a song and the instrumental is
// silent until you touch the semitones.
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
import { read } from '@encore/test-support';
import { PitchShiftGraph } from '$lib/tv/pitch-shift';

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

// Was `at('src/lib/tv/TvPlayer.svelte')` — the scanned component was this guard's own SIBLING
// in src/lib/tv (it is the file whose per-song reset effect the source-scan half pins), so it
// is now named in full and anchored on the repo root.
const TV = read('src/lib/tv/TvPlayer.svelte');

test('guard: the per-song reset resets the master graph via setShift(0)', () => {
	const body = stripComments(resetEffectBody(TV));
	expect(body).toMatch(/masterGraph[?][.]setShift[(]\s*0\s*[)]/);
});

test('guard (mutation trap): the per-song reset must NOT detach the master graph', () => {
	const body = stripComments(resetEffectBody(TV));
	expect(body).not.toMatch(/masterGraph[?][.]detach[(]/);
});

test('guard (not-vacuous): the destroy effect detaches the graph on slot unmount', () => {
	// ONE graph, because there is one element. This asserted BOTH while the guide was a second <audio>
	// with its own PitchShiftGraph; that graph is gone, and a reappearing `guideGraph?.detach()` here
	// would mean the second element came back.
	const stripped = stripComments(TV);
	const destroyIdx = stripped.indexOf('return () => {');
	expect(destroyIdx).toBeGreaterThanOrEqual(0);
	const destroyRegion = stripped.slice(destroyIdx, destroyIdx + 300);
	expect(destroyRegion).toMatch(/masterGraph[?][.]detach[(]/);
	expect(destroyRegion).not.toMatch(/guideGraph/);
});

/*
 * THE GUIDE HALF IS GONE. It tested that a routed GUIDE graph survived a song-change `setShift(0)`, that
 * detaching it on a still-mounted element was the silence path, and that a dedicated effect released it
 * when `guideMountable` went false — all of it describing a SECOND media element with its own
 * PitchShiftGraph and its own lifetime.
 *
 * Keeping those two lifetimes in step was a standing obligation and a repeat source of defects (detach on
 * a song change left a permanently-captured element feeding a released context: a silent guide until
 * someone transposed). The guide is now channels 2/3 of the master's own file, so there is exactly one
 * element, one graph and one lifetime. `playhead-sync.test.ts` guards that the second one stays deleted.
 */

// -- THE MASTER HALF: the master element genuinely dies when a drained room unmounts the <audio> behind
//    {#if media && isPlayable(media)}. The `if (!master)` element-unmount effect (the shadow
//    clear) is where that death is detected, so it must ALSO release the master graph and DROP its
//    reference -- detach() alone leaves `masterGraph` truthy and the build site's `!masterGraph` guard
//    stays false forever, so the next song's fresh element is never captured and the instrumental
//    stops transposing for the page's life (the master counterpart of the guide's release). The
//    per-song reset must NOT do this (that is the song-change defect); the release lives only where the ELEMENT dies.
function masterUnmountEffectBody(s: string): string {
	// Anchor on the shadow-clear the unmount fix does when the element is gone: `currentEntryId = null`
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
