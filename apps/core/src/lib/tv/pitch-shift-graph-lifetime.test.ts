// Regression guard for #477 -- skip a song and the instrumental is silent until you touch the
// semitones.
//
// ROOT CAUSE (owner-triaged at 9b07153, confirmed by reading the code): a PitchShiftGraph binds a
// PERMANENT MediaElementAudioSourceNode to its element (pitch-shift.ts:492-497). The master audio
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
import { test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PitchShiftGraph } from "./pitch-shift";

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
	state: "suspended" | "running" | "closed" = "running";
	destination = new StubNode();
	sources: StubSource[] = [];
	async resume() {
		this.state = "running";
	}
	async close() {
		this.state = "closed";
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
		constructor(public parts: unknown[], public opts: unknown) {}
	};
	g.URL = { createObjectURL: () => "blob:stub", revokeObjectURL: () => {} };
});

afterEach(() => {
	for (const k of Object.keys(saved)) g[k] = saved[k];
});

function fakeEl(): HTMLMediaElement {
	return {} as HTMLMediaElement;
}

test("#477: a routed master graph SURVIVES setShift(0) -- stays routed (song-change reset)", async () => {
	const graph = new PitchShiftGraph(fakeEl());
	await graph.setShift(1);
	expect(graph.isRouted).toBe(true);
	await graph.setShift(0);
	expect(graph.isRouted).toBe(true);
	expect(graph.isDegraded).toBe(false);
});

test("#477 control: detach() (the OLD per-song call) closes the context -- the silence path", async () => {
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
	return s.replace(/[/][*][\s\S]*?[*][/]/g, "").replace(/(^|[^:])[/][/][^\n]*/g, "$1");
}

function resetEffectBody(s: string): string {
	const anchor = "if (id === resetForId) return;";
	const start = s.indexOf(anchor);
	expect(start).toBeGreaterThanOrEqual(0);
	let i = s.indexOf("{", s.lastIndexOf("$effect", start));
	const from = i;
	let depth = 0;
	for (; i < s.length; i++) {
		if (s[i] === "{") depth++;
		else if (s[i] === "}") {
			depth--;
			if (depth === 0) break;
		}
	}
	return s.slice(from, i + 1);
}

const TV = readFileSync(join(import.meta.dir, "TvPlayer.svelte"), "utf8");

test("#477 guard: the per-song reset resets the master graph via setShift(0)", () => {
	const body = stripComments(resetEffectBody(TV));
	expect(body).toMatch(/masterGraph[?][.]setShift[(]\s*0\s*[)]/);
});

test("#477 guard (mutation trap): the per-song reset must NOT detach the master graph", () => {
	const body = stripComments(resetEffectBody(TV));
	expect(body).not.toMatch(/masterGraph[?][.]detach[(]/);
	expect(body).toMatch(/guideGraph[?][.]detach[(]/);
});

test("#477 guard (not-vacuous): the destroy effect still detaches BOTH graphs on slot unmount", () => {
	const stripped = stripComments(TV);
	const destroyIdx = stripped.indexOf("return () => {");
	expect(destroyIdx).toBeGreaterThanOrEqual(0);
	const destroyRegion = stripped.slice(destroyIdx, destroyIdx + 300);
	expect(destroyRegion).toMatch(/masterGraph[?][.]detach[(]/);
	expect(destroyRegion).toMatch(/guideGraph[?][.]detach[(]/);
});
