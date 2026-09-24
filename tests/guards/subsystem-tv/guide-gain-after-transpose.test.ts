// guard: set a guide level, then transpose, and the isolated vocals jumped to FULL volume under the
// instrumental for the rest of the song. The level is owned by a gain $effect whose tracked deps are the
// element and `effectiveGuide` only — the graph variable is a plain `let`, invisible to it — while the pitch
// $effect builds the graph on the first non-zero shift and build() writes the graph's remembered gain into
// the GainNode. Once routed, `HTMLMediaElement.volume` is bypassed, so the level the room set is gone.
// Whatever builds a graph must therefore re-apply the level itself.
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { read } from '@encore/test-support';
import { PitchShiftGraph } from '$lib/tv/pitch-shift';

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
	gains: StubGain[] = [];
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
		const gn = new StubGain();
		this.gains.push(gn);
		return gn as unknown as GainNode;
	}
	audioWorklet = { addModule: async (_url: string) => {} };
}

const G = globalThis as unknown as Record<string, unknown>;
let saved: Record<string, unknown> = {};
let lastCtx: StubAudioContext | null = null;

beforeEach(() => {
	saved = { window: G.window, AudioWorkletNode: G.AudioWorkletNode, Blob: G.Blob, URL: G.URL };
	lastCtx = null;
	const Ctx = class extends StubAudioContext {
		constructor() {
			super();
			// eslint-disable-next-line @typescript-eslint/no-this-alias -- test mock captures its own instance
			lastCtx = this;
		}
	};
	G.window = { AudioContext: Ctx };
	G.AudioWorkletNode = StubNode;
	G.Blob = class {
		constructor(
			public parts: unknown[],
			public opts: unknown
		) {}
	};
	G.URL = { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} };
});

afterEach(() => {
	for (const k of Object.keys(saved)) G[k] = saved[k];
});

function fakeEl(): HTMLMediaElement {
	return {} as HTMLMediaElement;
}

test('a guide level set BEFORE the graph is built lands in the GainNode when a shift builds it', async () => {
	// Order mirrors the repro: level first (setGain remembers it), then a transpose builds the graph.
	const graph = new PitchShiftGraph(fakeEl());
	graph.setGain(0.3);
	await graph.setShift(2);
	expect(graph.isRouted).toBe(true);
	expect(lastCtx).not.toBeNull();
	expect(lastCtx!.gains.length).toBe(1);
	expect(lastCtx!.gains[0].gain.value).toBeCloseTo(0.3, 6);
});

test("control: WITHOUT the pre-set level, a freshly built graph's GainNode defaults to full volume", async () => {
	// The state the bug leaves, and the control that makes the assertion above meaningful.
	const graph = new PitchShiftGraph(fakeEl());
	await graph.setShift(2);
	expect(graph.isRouted).toBe(true);
	expect(lastCtx!.gains[0].gain.value).toBeCloseTo(1, 6);
});

function stripComments(s: string): string {
	return s.replace(/[/][*][\s\S]*?[*][/]/g, '').replace(/(^|[^:])[/][/][^\n]*/g, '$1');
}

const TV = read('src/lib/tv/TvPlayer.svelte');

test('guard: the pitch effect re-applies the room guide level via setGuideGain(effectiveGuide)', () => {
	// `desiredGuideGain` defaults to 0 deliberately, so a missed call yields a guide nobody hears rather than
	// one that drowns the singer — which means the first transpose SILENCES the guide unless the pitch effect
	// re-asserts the level. Anchored on the master-level re-apply beside it: the two exist for the same
	// reason and must not drift apart.
	const stripped = stripComments(TV);
	const at = stripped.indexOf('masterGraph?.setGain(effectiveMasterLevel)');
	expect(at).toBeGreaterThanOrEqual(0);
	const region = stripped.slice(at, at + 300);
	expect(region).toMatch(/masterGraph[?][.]setGuideGain[(]\s*effectiveGuide\s*[)]/);
});

test('guard (not-vacuous): the level effect still owns the level before any graph exists', () => {
	// The pitch-effect re-apply is ADDITIVE: the dedicated level effect must keep pushing the guide gain too,
	// so a level set BEFORE a transpose is remembered on a graph that does not exist yet. Assert a DISTINCT
	// second occurrence.
	const stripped = stripComments(TV);
	const hits = [...stripped.matchAll(/masterGraph[?][.]setGuideGain[(]\s*effectiveGuide\s*[)]/g)];
	expect(hits.length).toBeGreaterThanOrEqual(2);
});
