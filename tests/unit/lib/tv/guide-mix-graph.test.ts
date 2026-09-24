// SPLIT MODE: the master element carries the 4-channel guide mix and the graph pulls the two pairs apart so
// each gets its own level, so one decoder means one playhead and no drift governor. The channel INDICES are
// the whole contract — the browser splits by index, not by layout label.
import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { read } from '$test';
import { PitchShiftGraph } from '$lib/tv/pitch-shift';
import { stripComments } from '$test';

interface Conn {
	to: StubNode;
	out?: number;
	in?: number;
}
class StubNode {
	kind = 'node';
	conns: Conn[] = [];
	port = { postMessage: (_m: unknown) => {} };
	connect(to: unknown, out?: number, inp?: number) {
		this.conns.push({ to: to as StubNode, out, in: inp });
		return to as StubNode;
	}
	disconnect() {
		this.conns = [];
	}
}
class StubGain extends StubNode {
	kind = 'gain';
	gain = { value: 1 };
}
class StubSplitter extends StubNode {
	kind = 'splitter';
	constructor(public outputs: number) {
		super();
	}
}
class StubMerger extends StubNode {
	kind = 'merger';
	constructor(public inputs: number) {
		super();
	}
}
class StubWorklet extends StubNode {
	kind = 'worklet';
	constructor(
		_ctx: unknown,
		_name: string,
		public opts?: Record<string, unknown>
	) {
		super();
	}
}
class StubCtx {
	state: 'suspended' | 'running' | 'closed' = 'running';
	destination = new StubNode();
	gains: StubGain[] = [];
	splitters: StubSplitter[] = [];
	mergers: StubMerger[] = [];
	source: StubNode | null = null;
	worklet: StubNode | null = null;
	async resume() {
		this.state = 'running';
	}
	async close() {
		this.state = 'closed';
	}
	createMediaElementSource() {
		this.source = new StubNode();
		return this.source as unknown as MediaElementAudioSourceNode;
	}
	createGain() {
		const g = new StubGain();
		this.gains.push(g);
		return g as unknown as GainNode;
	}
	createChannelSplitter(n: number) {
		const s = new StubSplitter(n);
		this.splitters.push(s);
		return s as unknown as ChannelSplitterNode;
	}
	createChannelMerger(n: number) {
		const m = new StubMerger(n);
		this.mergers.push(m);
		return m as unknown as ChannelMergerNode;
	}
	audioWorklet: { addModule: (u: string) => Promise<void> } = { addModule: async (_u: string) => {} };
}

const G = globalThis as unknown as Record<string, unknown>;
let saved: Record<string, unknown> = {};
let ctx: StubCtx | null = null;

/**
 * An `AudioContext` constructor whose instance is published to `ctx`, so a test can inspect the graph built
 * internally. A factory rather than a subclass publishing itself: that shape is lint-banned because it can
 * publish a HALF-CONSTRUCTED instance.
 */
function capturingCtx(shape: (c: StubCtx) => void = () => {}): new () => StubCtx {
	return function CapturedCtx(): StubCtx {
		const c = new StubCtx();
		shape(c);
		ctx = c;
		return c;
	} as unknown as new () => StubCtx;
}
let workletOpts: Record<string, unknown> | undefined;

beforeEach(() => {
	saved = { window: G.window, AudioWorkletNode: G.AudioWorkletNode, Blob: G.Blob, URL: G.URL };
	ctx = null;
	workletOpts = undefined;
	G.window = { AudioContext: capturingCtx() };
	G.AudioWorkletNode = class extends StubWorklet {
		constructor(c: unknown, n: string, o?: Record<string, unknown>) {
			super(c, n, o);
			workletOpts = o;
			if (ctx) ctx.worklet = this;
		}
	};
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

const el = () => ({}) as HTMLMediaElement;
/** Every connection made INTO `node`, as `[fromKind, outIndex, inIndex]`. */
const inbound = (target: StubNode, from: StubNode[]) =>
	from.flatMap((f) => f.conns.filter((c) => c.to === target).map((c) => [f.kind, c.out, c.in] as const));
/** The single node `from` feeds, or null. Used to walk a pair's chain end to end. */
const soleTarget = (from: StubNode): StubNode | null => (from.conns.length === 1 ? from.conns[0].to : null);

describe('split mode wires each channel pair to its own gain', () => {
	test('a 4-way splitter and two stereo mergers exist — pairs are re-merged, never summed', async () => {
		// Outputs 0 and 1 into ONE GainNode would SUM them to mono; a ChannelMerger keeps left as left.
		const g = new PitchShiftGraph(el(), { split: true });
		await g.ensureRouted();
		expect(g.isRouted).toBe(true);
		expect(ctx!.splitters).toHaveLength(1);
		expect(ctx!.splitters[0].outputs).toBe(4);
		expect(ctx!.mergers.map((m) => m.inputs)).toEqual([2, 2]);
	});

	test('the SPLITTER is fed by the worklet, not straight from the source', async () => {
		// Bypassing the worklet leaves the shifter dangling: ±key silently does nothing, and nothing else here moves.
		const g = new PitchShiftGraph(el(), { split: true });
		await g.ensureRouted();
		const [splitter] = ctx!.splitters;
		const feeders = inbound(splitter, [ctx!.source!, ctx!.worklet!]);
		expect(feeders.map(([kind]) => kind)).toEqual(['worklet']);
		expect(inbound(ctx!.worklet!, [ctx!.source!]).map(([k]) => k)).toEqual(['node']);
	});

	test('the WHOLE chain per pair: channels 0/1 -> instrumental gain, 2/3 -> guide gain', async () => {
		// Both halves of the contract: exchanging which merger feeds which gain puts the instrumental on the gain
		// defaulting to 0 and the isolated vocals on the gain defaulting to 1 — full-volume vocals with no backing
		// track. Indices alone cannot see that, so each pair is walked splitter to destination as one path, with
		// each gain identified by the LEVEL it was told to carry.
		const g = new PitchShiftGraph(el(), { split: true });
		g.setGain(0.9);
		g.setGuideGain(0.25);
		await g.ensureRouted();
		const [splitter] = ctx!.splitters;
		const [instMerger, guideMerger] = ctx!.mergers;

		expect(inbound(instMerger, [splitter])).toEqual([
			['splitter', 0, 0],
			['splitter', 1, 1]
		]);
		expect(inbound(guideMerger, [splitter])).toEqual([
			['splitter', 2, 0],
			['splitter', 3, 1]
		]);

		const instGain = soleTarget(instMerger) as StubGain | null;
		const guideGain = soleTarget(guideMerger) as StubGain | null;
		expect(instGain?.kind).toBe('gain');
		expect(guideGain?.kind).toBe('gain');
		expect(instGain!.gain.value).toBeCloseTo(0.9, 6);
		expect(guideGain!.gain.value).toBeCloseTo(0.25, 6);
		expect(instGain).not.toBe(guideGain);

		// Each gain reaches the destination, so both pairs sum back to one output.
		expect(soleTarget(instGain!)).toBe(ctx!.destination);
		expect(soleTarget(guideGain!)).toBe(ctx!.destination);
	});

	test('setGuideGain moves ONLY the guide pair, and setGain only the instrumental pair', async () => {
		// Exchanged, moving the room's guide level would attenuate the backing track instead.
		const g = new PitchShiftGraph(el(), { split: true });
		await g.ensureRouted();
		const [instMerger, guideMerger] = ctx!.mergers;
		const instGain = soleTarget(instMerger) as StubGain;
		const guideGain = soleTarget(guideMerger) as StubGain;
		g.setGuideGain(0.4);
		expect(guideGain.gain.value).toBeCloseTo(0.4, 6);
		expect(instGain.gain.value).toBe(1);
		g.setGain(0.5);
		expect(instGain.gain.value).toBe(0.5);
		expect(guideGain.gain.value).toBeCloseTo(0.4, 6);
	});

	test('the worklet is PINNED to 4 channels, so it cannot settle on stereo and drop the guide', async () => {
		const g = new PitchShiftGraph(el(), { split: true });
		await g.ensureRouted();
		expect(workletOpts?.outputChannelCount).toEqual([4]);
		expect(workletOpts?.channelCount).toBe(4);
		expect(workletOpts?.channelCountMode).toBe('explicit');
	});
});

// `AudioWorklet` is secure-context-only, so on a plain-HTTP LAN TV `ctx.audioWorklet` is undefined — and
// dereferencing it unconditionally threw, taking the whole graph down (splitter included) so the room
// silently lost the guiding track as well as ±key. The splitter needs no worklet.
describe('with no AudioWorklet (insecure origin) the guide still works', () => {
	/** A context shaped like a non-secure origin: no `audioWorklet` member at all, as the spec requires. */
	const insecure = () =>
		capturingCtx((c) => {
			delete (c as unknown as Record<string, unknown>).audioWorklet;
		});

	test('the split graph still builds, and the SOURCE feeds the splitter directly', async () => {
		G.window = { AudioContext: insecure() };
		const g = new PitchShiftGraph(el(), { split: true });
		await g.ensureRouted();

		expect(g.isRouted).toBe(true);
		expect(g.isSplit).toBe(true); // the gate reads this; false here withholds the mix and kills the guide
		expect(ctx!.worklet).toBeNull(); // no shifter was constructed
		expect(ctx!.splitters).toHaveLength(1);
		expect(ctx!.splitters[0].outputs).toBe(4);
		expect(inbound(ctx!.splitters[0], [ctx!.source!]).map(([k]) => k)).toEqual(['node']);
	});

	test('both pairs keep their own gain, exactly as with a worklet', async () => {
		// The guide's whole value is the SEPARATE level: merge the pairs and the slider moves something else.
		G.window = { AudioContext: insecure() };
		const g = new PitchShiftGraph(el(), { split: true });
		g.setGain(0.8);
		g.setGuideGain(0.3);
		await g.ensureRouted();

		const [splitter] = ctx!.splitters;
		const [instMerger, guideMerger] = ctx!.mergers;
		expect(inbound(instMerger, [splitter])).toEqual([
			['splitter', 0, 0],
			['splitter', 1, 1]
		]);
		expect(inbound(guideMerger, [splitter])).toEqual([
			['splitter', 2, 0],
			['splitter', 3, 1]
		]);
		const instGain = soleTarget(instMerger) as StubGain;
		const guideGain = soleTarget(guideMerger) as StubGain;
		expect(instGain.gain.value).toBeCloseTo(0.8, 6);
		expect(guideGain.gain.value).toBeCloseTo(0.3, 6);
	});

	test('it reports that it CANNOT shift, so the UI need not lie about ±key', async () => {
		// Conflating the two made this silent: `isDegraded` alone shows a healthy graph offering a dead control.
		G.window = { AudioContext: insecure() };
		const g = new PitchShiftGraph(el(), { split: true });
		await g.ensureRouted();
		expect(g.isShiftable).toBe(false);
		expect(g.isDegraded).toBe(false); // NOT degraded — the graph is real and doing work
	});

	test('setShift is a no-op rather than a throw', async () => {
		G.window = { AudioContext: insecure() };
		const g = new PitchShiftGraph(el(), { split: true });
		await g.ensureRouted();
		await g.setShift(2); // would previously dereference a null worklet port
		expect(g.isRouted).toBe(true);
		expect(g.isShiftable).toBe(false);
	});

	test('a NON-split song captures nothing — no graph is worth an irreversible capture', async () => {
		// `createMediaElementSource` is permanent AND bypasses the element's own `volume`, and without a shifter a
		// plain song gains nothing from a graph — so capturing here takes over the audio path to deliver nothing.
		G.window = { AudioContext: insecure() };
		const g = new PitchShiftGraph(el(), { split: false });
		await g.setShift(3);
		expect(g.isRouted).toBe(false);
		expect(ctx!.source).toBeNull();
		expect(ctx!.state).toBe('closed');
	});

	test('a worklet that REFUSES its module degrades the same way, not into a broken graph', async () => {
		// Distinct from an absent worklet: the member exists and `addModule` rejects (a CSP blocking the blob URL).
		G.window = {
			AudioContext: capturingCtx((c) => {
				c.audioWorklet = {
					addModule: async () => {
						throw new Error('blocked');
					}
				};
			})
		};
		const g = new PitchShiftGraph(el(), { split: true });
		await g.ensureRouted();
		expect(g.isRouted).toBe(true);
		expect(g.isSplit).toBe(true);
		expect(g.isShiftable).toBe(false);
		expect(ctx!.splitters).toHaveLength(1);
	});
});

describe('the guide pair defaults to SILENCE, not to full volume', () => {
	test('an un-set guide gain builds at 0 — fail quiet, never loud', async () => {
		// In split mode the vocals are INSIDE the file the room plays, so a missed setGuideGain must yield a guide
		// nobody hears — never one that drowns the singer.
		const g = new PitchShiftGraph(el(), { split: true });
		await g.ensureRouted();
		const guideGain = ctx!.gains[1];
		expect(guideGain.gain.value).toBe(0);
	});

	test('the INSTRUMENTAL pair still defaults to 1 — the master never attenuates by accident', async () => {
		const g = new PitchShiftGraph(el(), { split: true });
		await g.ensureRouted();
		expect(ctx!.gains[0].gain.value).toBe(1);
	});

	test('a level set BEFORE the build lands in the GainNode once it is built', async () => {
		// The level effect does NOT re-run on graph construction, so the graph must read the remembered value.
		const g = new PitchShiftGraph(el(), { split: true });
		g.setGuideGain(0.35);
		await g.ensureRouted();
		expect(ctx!.gains[1].gain.value).toBeCloseTo(0.35, 6);
	});

	test('a level set AFTER the build applies immediately, and clamps', async () => {
		const g = new PitchShiftGraph(el(), { split: true });
		await g.ensureRouted();
		g.setGuideGain(0.5);
		expect(ctx!.gains[1].gain.value).toBe(0.5);
		g.setGuideGain(9);
		expect(ctx!.gains[1].gain.value).toBe(1);
		g.setGuideGain(-2);
		expect(ctx!.gains[1].gain.value).toBe(0);
	});
});

describe('the plain path is untouched', () => {
	test('a non-split graph builds NO splitter and no second gain', async () => {
		// At keyShift 0 a plain song must touch no WebAudio, and a transpose must route it exactly as before.
		const g = new PitchShiftGraph(el());
		await g.setShift(2);
		expect(g.isRouted).toBe(true);
		expect(g.isSplit).toBe(false);
		expect(ctx!.splitters).toHaveLength(0);
		expect(ctx!.mergers).toHaveLength(0);
		expect(ctx!.gains).toHaveLength(1);
	});

	test('setShift(0) on a fresh NON-split graph still builds nothing', async () => {
		const g = new PitchShiftGraph(el());
		await g.setShift(0);
		expect(g.isRouted).toBe(false);
		expect(ctx).toBeNull();
	});

	test('setGuideGain on a non-split graph is remembered and harmlessly never applied', async () => {
		const g = new PitchShiftGraph(el());
		g.setGuideGain(0.4);
		await g.setShift(2);
		// The single gain is the MASTER's, so it must not have taken the guide level.
		expect(ctx!.gains[0].gain.value).toBe(1);
	});
});

describe('a context that will not run leaves the element alone', () => {
	test('ensureRouted on a suspended context does NOT capture the element', async () => {
		// Why `masterSrcPlan` withholds the mix src until `isRouted`: on the native output a 4-channel file is
		// DOWNMIXED — isolated vocals at full volume.
		G.window = {
			AudioContext: capturingCtx((c) => {
				c.state = 'suspended';
				// The TV wall never got a gesture, so resume() resolves while still suspended.
				c.resume = async () => {};
			})
		};
		const g = new PitchShiftGraph(el(), { split: true });
		await g.ensureRouted();
		expect(g.isRouted).toBe(false);
		expect(g.isDegraded).toBe(true);
		expect(ctx!.source).toBeNull(); // never captured — the permanence trap avoided
	});

	test('a worklet the engine REFUSES degrades to non-split, so no mix src is ever promoted', async () => {
		// `outputChannelCount: [4]` is a documented NotSupportedError candidate, and a throw here used to happen
		// AFTER the irreversible capture, with the catch then CLOSING the context — silencing that element for the
		// page's life. It now falls back and clears `split`, so `mixGateFor` answers `denied`.
		G.AudioWorkletNode = class extends StubWorklet {
			constructor(c: unknown, n: string, o?: Record<string, unknown>) {
				super(c, n, o);
				if (o?.outputChannelCount) throw new Error('NotSupportedError');
				if (ctx) ctx.worklet = this;
			}
		};
		const g = new PitchShiftGraph(el(), { split: true });
		await g.ensureRouted();
		expect(g.isSplit).toBe(false);
		expect(g.isRouted).toBe(true); // still audible, still transposable — just not split
		expect(ctx!.splitters).toHaveLength(0);
		expect(ctx!.state).not.toBe('closed'); // the room keeps its audio
	});

	test('the element is captured LAST, after every node that could throw', async () => {
		// Ordering as a PROPERTY: a later node construction throws and the element must never have been
		// committed, because a capture followed by a thrown build silenced an element permanently.
		G.window = {
			AudioContext: capturingCtx((c) => {
				c.createChannelSplitter = () => {
					throw new Error('boom');
				};
			})
		};
		const g = new PitchShiftGraph(el(), { split: true });
		await g.ensureRouted();
		expect(ctx!.source).toBeNull();
		expect(g.isRouted).toBe(false);
		expect(g.isDegraded).toBe(true);
	});
});

describe('a build interrupted by teardown does not route an orphan', () => {
	test('detach during the build closes the context instead of leaving it running', async () => {
		// The released-context leak the EAGER build reopened: an orphan build reached `routed = true` on a graph
		// nothing holds, with its AudioContext never closed.
		let release: (() => void) | undefined;
		G.window = {
			AudioContext: capturingCtx((c) => {
				c.audioWorklet = {
					addModule: () =>
						new Promise<void>((r) => {
							release = r;
						})
				};
			})
		};
		const g = new PitchShiftGraph(el(), { split: true });
		const building = g.ensureRouted();
		g.detach(); // the slot goes away mid-build
		release?.();
		await building;
		expect(g.isRouted).toBe(false);
		expect(ctx!.state).toBe('closed');
		expect(ctx!.source).toBeNull();
	});
});

describe('teardown releases the split stage', () => {
	test('detach disconnects the splitter and both mergers, not just the old three nodes', async () => {
		const g = new PitchShiftGraph(el(), { split: true });
		await g.ensureRouted();
		const [splitter] = ctx!.splitters;
		const mergers = ctx!.mergers;
		expect(splitter.conns.length).toBeGreaterThan(0);
		g.detach();
		expect(splitter.conns).toHaveLength(0);
		for (const m of mergers) expect(m.conns).toHaveLength(0);
	});
});

// The wiring, by source scan — the effects above live in .svelte and bun cannot execute them.

// Two earlier scans here were defeated by COMMENTING THE CALL OUT; blanking rather than deleting keeps offsets.
describe('TvPlayer wiring', () => {
	const src = stripComments(read('src/lib/tv/TvPlayer.svelte'));

	test('there is no second element to mount, on any path', () => {
		// Mounting both elements would sound the vocals twice — inside the mix and on top: a doubled, flanged vocal.
		// The gate is structural now (the element and its whole branch are deleted), so assert the artefacts stay gone.
		expect(src).not.toMatch(/guideRef/);
		expect(src).not.toMatch(/bind:this=\{vocals\}/);
		expect(src).not.toMatch(/vocalsRef/);
	});

	test('the master src goes through masterSrcPlan with the FULL gate, never a bare isRouted', () => {
		// `mixGateFor` folds in `isSplit`: passing `isRouted` alone is the leftover-non-split-graph downmix, and
		// passing a literal is the pending-src rewrite, so both failure modes are rejected by name.
		expect(src).toMatch(/masterSrcPlan\(\s*guidePlan\s*,\s*playbackRef\(m\)\s*,\s*mixGateFor\(/);
		expect(src).not.toMatch(/masterSrcPlan\([^)]*isRouted/);
		expect(src).not.toMatch(/masterSrcPlan\([^)]*(true|false)\s*\)/);
	});

	test('mixGateFor is asked about the graph AND the settled flag', () => {
		expect(src).toMatch(/mixGateFor\(\s*masterGraph\s*,\s*mixSettled\s*\)/);
	});

	test('the src effect reads the settled signal, so a mix that becomes safe is actually played', () => {
		// The graph's getters cannot wake an effect, so without a reactive read the mix is built, becomes safe and
		// is never played. A bare `void` read is this repo's idiom for a dependency whose VALUE is not needed.
		expect(src).toMatch(/void mixSettled;/);
	});

	test('the routing attempt settles on FAILURE too, or a denied room never gets a src', () => {
		// A mix song commits nothing while pending, so settling only on success leaves the element on '' all song.
		expect(src).toMatch(/\.finally\(/);
		expect(src).toMatch(/mixSettled = true;/);
	});

	test('the gate is reset per SONG, so one song cannot inherit another song s verdict', () => {
		expect(src).toMatch(/mixSettled = false;/);
	});

	test('a mix song builds the graph EAGERLY and in split mode', () => {
		expect(src).toMatch(/new PitchShiftGraph\(v,\s*\{\s*split:\s*true\s*\}\)/);
		expect(src).toMatch(/wantsEagerGraph\(guidePlan\)/);
	});

	test('the room guide level is pushed into the split graph, not only into the second element', () => {
		// Without this the knob does nothing on a mix song: no second element's `.volume` to set, and the graph's
		// gain sits at its 0 default forever.
		expect(src).toMatch(/masterGraph\?\.setGuideGain\(effectiveGuide\)/);
	});
});
