// Regression + wiring guard for #462 PR3 -- the MASTER instrumental's loudness-normalization pulldown
// must be applied at BOTH the native (`master.volume`) and routed (`masterGraph.setGain`) sites, and
// must SURVIVE a transpose that builds the master graph.
//
// The shape is identical to the guide's #434 guard (guide-gain-after-transpose.test.ts), and for the
// identical reason: once a shift routes the master through WebAudio, `HTMLMediaElement.volume` is
// bypassed and only the GainNode governs level; a freshly built PitchShiftGraph defaults desiredGain
// to 1, so unless the level is re-applied when the graph is built, an attenuated song jumps to FULL
// volume the moment anyone transposes. The master had NO level control at all before this PR, so this
// is the site that carries the whole feature.
//
// Two halves:
//   A. BEHAVIOURAL -- the real PitchShiftGraph primitive: a level set via setGain() BEFORE the graph
//      is built lands in the GainNode once a shift builds it (the #434 carry, re-proven for the
//      master because the feature leans on it).
//   B. SOURCE-SCAN -- the level lives inside .svelte effects bun cannot execute, so a text scan proves
//      the fix is WIRED at all three sites: the dedicated level effect (native + routed), the pitch
//      effect's master branch (re-apply after build), and the per-song reset. Mutation traps: deleting
//      any setGain(effectiveMasterLevel) call reds the matching test.
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PitchShiftGraph } from './pitch-shift';

// -- A. Behavioural: a pre-set master level lands in the GainNode the moment the graph is built ----

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

test('#462: a master level set BEFORE the graph is built lands in the GainNode when a shift builds it', async () => {
	// An attenuated song (gain 0.5) then a transpose: the pulldown must survive into the GainNode, not
	// reset to full volume.
	const graph = new PitchShiftGraph(fakeEl());
	graph.setGain(0.5);
	await graph.setShift(2);
	expect(graph.isRouted).toBe(true);
	expect(lastCtx).not.toBeNull();
	expect(lastCtx!.gains.length).toBe(1);
	expect(lastCtx!.gains[0].gain.value).toBeCloseTo(0.5, 6);
});

test('#462 control: WITHOUT the pre-set level, a freshly built master graph defaults to full volume', async () => {
	// The state the bug leaves if the re-apply is missing: the graph builds at desiredGain 1, so an
	// attenuated song plays at full volume once transposed. This makes the assertion above meaningful.
	const graph = new PitchShiftGraph(fakeEl());
	await graph.setShift(2);
	expect(graph.isRouted).toBe(true);
	expect(lastCtx!.gains[0].gain.value).toBeCloseTo(1, 6);
});

// -- B. Source-scan: the master level is applied at all three sites --------------------------------

function stripComments(s: string): string {
	return s.replace(/[/][*][\s\S]*?[*][/]/g, '').replace(/(^|[^:])[/][/][^\n]*/g, '$1');
}

const TV = readFileSync(join(import.meta.dir, 'TvPlayer.svelte'), 'utf8');

test('#462: the level effect applies the master level at BOTH the native and routed sites', () => {
	// The dedicated master-level $effect: `master.volume = effectiveMasterLevel` (native path) AND
	// `masterGraph?.setGain(effectiveMasterLevel)` (routed path). Both, because WebAudio capture
	// bypasses .volume once a shift exists. Deleting either line reds this.
	const stripped = stripComments(TV);
	const anchor = 'master.volume = effectiveMasterLevel';
	const at = stripped.indexOf(anchor);
	expect(at, 'expected a master.volume = effectiveMasterLevel assignment').toBeGreaterThanOrEqual(0);
	const region = stripped.slice(at, at + 200);
	expect(region).toMatch(/masterGraph[?][.]setGain[(]\s*effectiveMasterLevel\s*[)]/);
});

// The master branch of the pitch $effect: after `masterGraph = new PitchShiftGraph(v)` and
// `masterGraph?.setShift(shift)`, it must re-apply the normalization level.
function pitchEffectMasterRegion(s: string): string {
	const anchor = 'if (needsShift(shift) && !masterGraph)';
	const at = s.indexOf(anchor);
	expect(at, 'expected the master graph build in the pitch effect').toBeGreaterThanOrEqual(0);
	// From the build up to (but not into) the guide branch `if (g) {`.
	const guideAt = s.indexOf('if (g)', at);
	return s.slice(at, guideAt >= 0 ? guideAt : at + 400);
}

test('#462 guard: the pitch effect re-applies the master level after (re)building the master graph', () => {
	const region = stripComments(pitchEffectMasterRegion(TV));
	expect(region).toMatch(/masterGraph\s*=\s*new PitchShiftGraph/);
	expect(region).toMatch(/masterGraph[?][.]setShift[(]\s*shift\s*[)]/);
	// The load-bearing line: without it, a transpose builds the master graph at desiredGain 1 and the
	// pulldown evaporates (the exact #434 shape, master-side).
	expect(region).toMatch(/masterGraph[?][.]setGain[(]\s*effectiveMasterLevel\s*[)]/);
});

test('#462 guard: the per-song reset re-applies the master level in place (graph is reset, not detached)', () => {
	// A song change resets the master graph in place with setShift(0); a graph defaults its gain to 1,
	// so the level must be re-asserted here too, exactly as the guide is (setGain(effectiveGuide)).
	const stripped = stripComments(TV);
	const anchor = 'void masterGraph?.setShift(0)';
	const at = stripped.indexOf(anchor);
	expect(at, 'expected the in-place master reset setShift(0)').toBeGreaterThanOrEqual(0);
	const region = stripped.slice(at, at + 220);
	expect(region).toMatch(/masterGraph[?][.]setGain[(]\s*effectiveMasterLevel\s*[)]/);
});

test('#462: effectiveMasterLevel is derived clamped to [0,1] (attenuate-only, never a boost)', () => {
	// The prop is clamped in the component too, so a route bug cannot push the master above unity.
	const stripped = stripComments(TV);
	expect(stripped).toMatch(
		/effectiveMasterLevel\s*=\s*\$derived[(]\s*Math[.]max[(]0,\s*Math[.]min[(]1,\s*masterLevel[)][)]\s*[)]/
	);
});

test('#462: the TV route resolves masterLevel from the loudness gain and passes it to both slots', () => {
	// The decision lives in the route (it owns the library catalog + the room toggle); the player is a
	// pure applier. Prove the route wires the pure gain function to a per-slot masterLevel prop.
	const route = readFileSync(join(import.meta.dir, '../../routes/tv/+page.svelte'), 'utf8');
	const src = stripComments(route);
	expect(src).toMatch(/loudnessNormalizationGain[(]/);
	expect(src).toMatch(/enabled:\s*settings[.]room[.]loudnessNormalization/);
	// Per-slot resolution + both slot bindings.
	expect(src).toMatch(/masterLevelA\s*=\s*\$derived/);
	expect(src).toMatch(/masterLevelB\s*=\s*\$derived/);
	expect(src).toMatch(/masterLevel=[{]masterLevelA[}]/);
	expect(src).toMatch(/masterLevel=[{]masterLevelB[}]/);
});
