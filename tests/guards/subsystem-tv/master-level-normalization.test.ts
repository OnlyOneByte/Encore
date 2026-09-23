// Guard: the MASTER instrumental's loudness-normalization pulldown must be applied at BOTH the native
// (`master.volume`) and routed (`masterGraph.setGain`) sites, and must SURVIVE a transpose.
//
// Same shape and same reason as the guide's guard: once a shift routes the master through WebAudio,
// `HTMLMediaElement.volume` is bypassed and only the GainNode governs level, and a freshly built
// PitchShiftGraph defaults its gain to 1 — so unless the level is re-applied when the graph is built, an
// attenuated song jumps to FULL volume the moment anyone transposes. Three sites carry it: the dedicated
// level effect (native + routed), the pitch effect's master branch, and the per-song reset.
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

test('a master level set BEFORE the graph is built lands in the GainNode when a shift builds it', async () => {
	const graph = new PitchShiftGraph(fakeEl());
	graph.setGain(0.5);
	await graph.setShift(2);
	expect(graph.isRouted).toBe(true);
	expect(lastCtx).not.toBeNull();
	expect(lastCtx!.gains.length).toBe(1);
	expect(lastCtx!.gains[0].gain.value).toBeCloseTo(0.5, 6);
});

test('control: WITHOUT the pre-set level, a freshly built master graph defaults to full volume', async () => {
	// The state a missing re-apply leaves, and the control that makes the assertion above meaningful.
	const graph = new PitchShiftGraph(fakeEl());
	await graph.setShift(2);
	expect(graph.isRouted).toBe(true);
	expect(lastCtx!.gains[0].gain.value).toBeCloseTo(1, 6);
});

function stripComments(s: string): string {
	return s.replace(/[/][*][\s\S]*?[*][/]/g, '').replace(/(^|[^:])[/][/][^\n]*/g, '$1');
}

const TV = read('src/lib/tv/TvPlayer.svelte');

test('the level effect applies the master level at BOTH the native and routed sites', () => {
	// Both, because a WebAudio capture bypasses `.volume` once a shift exists. Deleting either line reds this.
	const stripped = stripComments(TV);
	const anchor = 'master.volume = effectiveMasterLevel';
	const at = stripped.indexOf(anchor);
	expect(at, 'expected a master.volume = effectiveMasterLevel assignment').toBeGreaterThanOrEqual(0);
	const region = stripped.slice(at, at + 200);
	expect(region).toMatch(/masterGraph[?][.]setGain[(]\s*effectiveMasterLevel\s*[)]/);
});

// The pitch effect's master branch, from the build to the effect's closing `});`. That end anchor matters:
// slicing to the guide branch `if (g) {` — which no longer exists — left the region ~80 chars long and blind
// to the very re-applies it exists to check.
function pitchEffectMasterRegion(s: string): string {
	const anchor = 'if (needsShift(shift) && !masterGraph)';
	const at = s.indexOf(anchor);
	expect(at, 'expected the master graph build in the pitch effect').toBeGreaterThanOrEqual(0);
	const endAt = s.indexOf('\n\t});', at);
	return s.slice(at, endAt >= 0 ? endAt : at + 900);
}

test('guard: the pitch effect re-applies the master level after (re)building the master graph', () => {
	const region = stripComments(pitchEffectMasterRegion(TV));
	expect(region).toMatch(/masterGraph\s*=\s*new PitchShiftGraph/);
	expect(region).toMatch(/masterGraph[?][.]setShift[(]\s*shift\s*[)]/);
	// Without the re-apply a transpose builds the graph at gain 1 and the pulldown evaporates.
	expect(region).toMatch(/masterGraph[?][.]setGain[(]\s*effectiveMasterLevel\s*[)]/);
});

test('guard: the per-song reset re-applies the master level in place (graph is reset, not detached)', () => {
	// A song change resets the graph in place with setShift(0), and a reset graph is back at gain 1, so the
	// level must be re-asserted here too — exactly as the guide is.
	const stripped = stripComments(TV);
	const anchor = 'void masterGraph?.setShift(0)';
	const at = stripped.indexOf(anchor);
	expect(at, 'expected the in-place master reset setShift(0)').toBeGreaterThanOrEqual(0);
	const region = stripped.slice(at, at + 220);
	expect(region).toMatch(/masterGraph[?][.]setGain[(]\s*effectiveMasterLevel\s*[)]/);
});

test('effectiveMasterLevel is derived clamped to [0,1] (attenuate-only, never a boost)', () => {
	// Clamped in the component too, so a route bug cannot push the master above unity.
	const stripped = stripComments(TV);
	expect(stripped).toMatch(
		/effectiveMasterLevel\s*=\s*\$derived[(]\s*Math[.]max[(]0,\s*Math[.]min[(]1,\s*masterLevel[)][)]\s*[)]/
	);
});

test('the TV route resolves masterLevel from the loudness gain and passes it to both slots', () => {
	// The decision lives in the route, which owns the library catalog and the room toggle; the player is a
	// pure applier.
	const route = read('src/routes/tv/+page.svelte');
	const src = stripComments(route);
	expect(src).toMatch(/loudnessNormalizationGain[(]/);
	expect(src).toMatch(/enabled:\s*settings[.]room[.]loudnessNormalization/);
	expect(src).toMatch(/masterLevelA\s*=\s*\$derived/);
	expect(src).toMatch(/masterLevelB\s*=\s*\$derived/);
	expect(src).toMatch(/masterLevel=[{]masterLevelA[}]/);
	expect(src).toMatch(/masterLevel=[{]masterLevelB[}]/);
});
