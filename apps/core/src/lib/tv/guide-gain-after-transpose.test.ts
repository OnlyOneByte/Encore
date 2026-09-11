// Regression guard for #434 -- set a guide level, then transpose, and the isolated vocals jump to
// FULL volume under the instrumental for the rest of the song.
//
// ROOT CAUSE (issue-triaged, confirmed by reading the code): the guide's level is owned by the gain
// $effect in TvPlayer.svelte, whose tracked deps are `vocals` and `effectiveGuide` only. `guideGraph`
// is a plain `let`, so it is invisible to that effect. The pitch $effect builds `guideGraph = new
// PitchShiftGraph(g)` on the first non-zero shift; a fresh graph defaults `desiredGain` to 1
// (pitch-shift.ts) and build() writes that straight into the GainNode. The gain effect does NOT
// re-run on graph construction, so `setGain(effectiveGuide)` is never applied and the guide plays at
// full volume. Once routed, HTMLMediaElement.volume is bypassed, so the level the room set is gone.
// (post-#477 the master graph now persists across songs; the guide graph is still rebuilt on
// transpose, so the fix must re-apply the level whenever that graph is built.)
//
// Two halves pin the fix:
//   A. BEHAVIOURAL -- drive the REAL PitchShiftGraph under stubbed WebAudio and prove the primitive
//      the fix leans on: a level set via setGain() BEFORE the graph is built survives into the
//      GainNode once a shift builds it. No audio hardware -- same technique as the #477 lifetime test.
//   B. SOURCE-SCAN -- the pitch effect lives inside a .svelte effect bun cannot execute without a
//      Svelte compile + DOM, so a text scan proves the fix is WIRED: after building/keeping the guide
//      graph, the effect re-applies the room level with setGain(effectiveGuide). Mutation trap:
//      deleting that call reds it.
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PitchShiftGraph } from './pitch-shift';

// -- A. Behavioural: a pre-set level lands in the GainNode the moment the graph is built ----------

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
	// Order mirrors the incremental repro: level first (setGain remembers it in desiredGain), then a
	// transpose builds the graph.
	const graph = new PitchShiftGraph(fakeEl());
	graph.setGain(0.3);
	await graph.setShift(2);
	expect(graph.isRouted).toBe(true);
	// The single GainNode this graph created must carry the room's level, not the default 1.
	expect(lastCtx).not.toBeNull();
	expect(lastCtx!.gains.length).toBe(1);
	expect(lastCtx!.gains[0].gain.value).toBeCloseTo(0.3, 6);
});

test("control: WITHOUT the pre-set level, a freshly built graph's GainNode defaults to full volume", async () => {
	// This is the state the bug leaves: the graph builds with desiredGain === 1 (full volume). It is
	// the control that makes the behavioural assertion above meaningful.
	const graph = new PitchShiftGraph(fakeEl());
	await graph.setShift(2);
	expect(graph.isRouted).toBe(true);
	expect(lastCtx!.gains[0].gain.value).toBeCloseTo(1, 6);
});

// -- B. Source-scan: the pitch effect re-applies the room level after (re)building the guide graph -

function stripComments(s: string): string {
	return s.replace(/[/][*][\s\S]*?[*][/]/g, '').replace(/(^|[^:])[/][/][^\n]*/g, '$1');
}

// The guide branch of the pitch $effect: `if (g) { ... }`, sitting after `masterGraph?.setShift`.
function guideBranchBody(s: string): string {
	const anchor = 'if (needsShift(shift) && !guideGraph)';
	const at = s.indexOf(anchor);
	expect(at).toBeGreaterThanOrEqual(0);
	// Walk back to the opening `{` of the enclosing `if (g) {` and forward to its close.
	const open = s.lastIndexOf('{', at);
	let i = open;
	let depth = 0;
	for (; i < s.length; i++) {
		if (s[i] === '{') depth++;
		else if (s[i] === '}') {
			depth--;
			if (depth === 0) break;
		}
	}
	return s.slice(open, i + 1);
}

const TV = readFileSync(join(import.meta.dir, 'TvPlayer.svelte'), 'utf8');

test('guard: the pitch effect re-applies the room level to the guide graph via setGain(effectiveGuide)', () => {
	const body = stripComments(guideBranchBody(TV));
	// It must build/keep the graph AND set its gain from the resolved level in the same branch.
	expect(body).toMatch(/guideGraph\s*=\s*new PitchShiftGraph/);
	expect(body).toMatch(/guideGraph[?][.]setGain[(]\s*effectiveGuide\s*[)]/);
});

test('guard (not-vacuous): the level effect still owns the level for the native/pre-build path', () => {
	// The graph-path reapply (test above) is ADDITIVE: the original gain effect must keep setting the
	// guide gain too, so the level is applied on the native path and remembered before any graph is
	// built. Its body reads `vocals` and `effectiveGuide` and sets BOTH the element volume and the
	// graph gain. This makes test 1's guide-branch assertion a genuinely NEW site, not the only one.
	const stripped = stripComments(TV);
	const anchor = 'vocals.volume = effectiveGuide';
	const at = stripped.indexOf(anchor);
	expect(at).toBeGreaterThanOrEqual(0);
	const region = stripped.slice(at, at + 200);
	expect(region).toMatch(/guideGraph[?][.]setGain[(]\s*effectiveGuide\s*[)]/);
});
