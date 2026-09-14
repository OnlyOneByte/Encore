// Regression guard: set a guide level, then transpose, and the isolated vocals jump to
// FULL volume under the instrumental for the rest of the song.
//
// ROOT CAUSE (issue-triaged, confirmed by reading the code): the guide's level is owned by the gain
// $effect in TvPlayer.svelte, whose tracked deps are `vocals` and `effectiveGuide` only. `guideGraph`
// is a plain `let`, so it is invisible to that effect. The pitch $effect builds `guideGraph = new
// PitchShiftGraph(g)` on the first non-zero shift; a fresh graph defaults `desiredGain` to 1
// (pitch-shift.ts) and build() writes that straight into the GainNode. The gain effect does NOT
// re-run on graph construction, so `setGain(effectiveGuide)` is never applied and the guide plays at
// full volume. Once routed, HTMLMediaElement.volume is bypassed, so the level the room set is gone.
// (the master graph now persists across songs; the guide graph is still rebuilt on
// transpose, so the fix must re-apply the level whenever that graph is built.)
//
// Two halves pin the fix:
//   A. BEHAVIOURAL -- drive the REAL PitchShiftGraph under stubbed WebAudio and prove the primitive
//      the fix leans on: a level set via setGain() BEFORE the graph is built survives into the
//      GainNode once a shift builds it. No audio hardware -- same technique as pitch-shift-graph-lifetime.test.ts.
//   B. SOURCE-SCAN -- the pitch effect lives inside a .svelte effect bun cannot execute without a
//      Svelte compile + DOM, so a text scan proves the fix is WIRED: after building/keeping the guide
//      graph, the effect re-applies the room level with setGain(effectiveGuide). Mutation trap:
//      deleting that call reds it.
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { read } from '@encore/test-support';
import { PitchShiftGraph } from '$lib/tv/pitch-shift';

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

// -- B. Source-scan: the pitch effect re-applies the room level after (re)building the graph --------

function stripComments(s: string): string {
	return s.replace(/[/][*][\s\S]*?[*][/]/g, '').replace(/(^|[^:])[/][/][^\n]*/g, '$1');
}

// A SIBLING READ, re-anchored explicitly. This was `at('src/lib/tv/TvPlayer.svelte')` — "the
// component next to me" — and the component in question is the TV player whose pitch $effect part B
// scans. `read` throws when it is missing, so a wrong path reds as a path failure rather than handing
// the two scans below an empty string they would both pass on.
const TV = read('src/lib/tv/TvPlayer.svelte');

/*
 * WHAT MOVED. These two guards used to scan the pitch effect's GUIDE BRANCH (`if (g) { ... }`) for a
 * second `PitchShiftGraph` built on the vocals element, and the level effect for the matching
 * `vocals.volume` write. Both are gone with the second element: the guide is a channel pair inside the
 * master, so its level is `setGuideGain` on the ONE split graph.
 *
 * The DEFECT they exist for is unchanged, which is why they are rewritten rather than deleted: a freshly
 * built graph does not inherit the room's level (`desiredGuideGain` defaults to 0 — deliberately, so a
 * missed call yields a guide nobody hears rather than one that drowns the singer), and the level effect's
 * tracked deps do not include the plain `masterGraph` variable. So the pitch effect, which is where the
 * graph gets built, must re-assert the level itself or the first transpose silences the guide.
 */
test('guard: the pitch effect re-applies the room guide level via setGuideGain(effectiveGuide)', () => {
	const stripped = stripComments(TV);
	// Anchor on the pitch effect's own master-level re-apply, then require the guide's beside it — the two
	// re-applies exist for the same reason and must not drift apart.
	const at = stripped.indexOf('masterGraph?.setGain(effectiveMasterLevel)');
	expect(at).toBeGreaterThanOrEqual(0);
	const region = stripped.slice(at, at + 300);
	expect(region).toMatch(/masterGraph[?][.]setGuideGain[(]\s*effectiveGuide\s*[)]/);
});

test('guard (not-vacuous): the level effect still owns the level before any graph exists', () => {
	// The pitch-effect reapply above is ADDITIVE: the dedicated level effect must keep pushing the guide
	// gain too, so the room's level is remembered on a graph that is not built yet (`setGuideGain` stores
	// it and the build applies whatever is remembered). Without this second site the level set BEFORE a
	// transpose is lost. Assert it is a DISTINCT occurrence from the pitch-effect one.
	const stripped = stripComments(TV);
	const hits = [...stripped.matchAll(/masterGraph[?][.]setGuideGain[(]\s*effectiveGuide\s*[)]/g)];
	expect(hits.length).toBeGreaterThanOrEqual(2);
});
