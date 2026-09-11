// Regression guard for #527 -- "Semitones not affecting instrumental sometimes".
//
// ROOT CAUSE (owner-triaged at 8b115b8, confirmed by reading the code): PitchShiftGraph.build()
// guarded on `if (this.routed || this.degraded) return;` (pitch-shift.ts). `degraded` is set when a
// context cannot reach `running` (no user gesture yet on the TV wall) and NOTHING ever cleared it, so
// it was a PERMANENT verdict rather than "the last attempt failed". The master <audio> element is
// mounted unconditionally and its graph lives as long as the SLOT (kept, not rebuilt, per #477), so
// once it degraded pre-gesture the instrumental never shifted again -- while the guide element, which
// is remounted with a FRESH graph per song, recovers. That is the "one shifts, the other does not"
// asymmetry the report describes.
//
// FIX: `degraded` describes only the LAST attempt. build() drops `|| this.degraded` from the early
// return and sets `this.degraded = false` at the top of the attempt, so a finished failed attempt is
// retryable. The irreversible createMediaElementSource stays behind the confirmed `state === "running"`
// check, so a retry that fails again closes its context and leaves the element audible (never silent).
//
// Drives the REAL PitchShiftGraph under stubbed WebAudio (same technique as
// pitch-shift-graph-lifetime.test.ts) with ONE knob: whether a fresh AudioContext can be resumed.
// No audio hardware -- the defect is whether the element is ROUTED through the shifter, measured
// directly on the class.
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { PitchShiftGraph } from './pitch-shift';

// resume() reaches `running` iff this flag is set when the context is created. Toggling it models the
// TV wall being touched (autoplay unblocked) between two setShift() calls on the same graph.
let canResume = false;

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
	// A context created without a gesture starts suspended; resume() only reaches running when allowed.
	state: 'suspended' | 'running' | 'closed' = 'suspended';
	destination = new StubNode();
	sources: StubSource[] = [];
	async resume() {
		if (canResume) this.state = 'running';
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
	canResume = false;
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

test('a graph that degraded pre-gesture RETRIES and routes once a context can resume', async () => {
	// call chain: setShift(shift) -> build() -> new AudioContext().resume() -> state check.
	const graph = new PitchShiftGraph(fakeEl());

	// Pre-gesture press: the TV wall was never touched, so resume() cannot reach running. Correct
	// documented fallback -- audible, unshifted, NOT routed.
	await graph.setShift(2);
	expect(graph.isDegraded).toBe(true);
	expect(graph.isRouted).toBe(false);

	// Someone taps the TV: audio starts, contexts are now resumable. A later semitone press on the
	// SAME (master/instrumental) graph must now route the element through the shifter.
	canResume = true;
	await graph.setShift(3);
	// THIS is the #527 assertion: false on base (degraded latched terminal), true with the fix.
	expect(graph.isRouted).toBe(true);
	expect(graph.isDegraded).toBe(false);
});

test('asymmetry: a FRESH graph (what the guide gets each song) always routes when resumable', async () => {
	// The guide's per-song fresh graph recovers because it never carries a stale `degraded`. Pinning
	// this alongside the retry proves the fix removes the asymmetry, not that fresh graphs are special.
	canResume = true;
	const fresh = new PitchShiftGraph(fakeEl());
	await fresh.setShift(3);
	expect(fresh.isRouted).toBe(true);
	expect(fresh.isDegraded).toBe(false);
});

test('not-vacuous control: resumable from the start routes on the first shift', async () => {
	canResume = true;
	const graph = new PitchShiftGraph(fakeEl());
	await graph.setShift(2);
	expect(graph.isRouted).toBe(true);
	expect(graph.isDegraded).toBe(false);
});

test('safety: a retry that STILL cannot resume stays audible (degraded, not routed, no capture)', async () => {
	// If the gesture never comes, retrying must not create the permanent MediaElementSource into a dead
	// context (= total silence). It re-arms degraded and leaves the element on its native output.
	const graph = new PitchShiftGraph(fakeEl());
	await graph.setShift(2);
	expect(graph.isDegraded).toBe(true);
	await graph.setShift(3);
	expect(graph.isDegraded).toBe(true);
	expect(graph.isRouted).toBe(false);
});
