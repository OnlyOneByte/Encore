// SPLIT MODE: the master element carries the 4-channel guide mix, and the graph pulls the two pairs
// apart so each gets its own level. This is what replaces the two-element guide, and with it the drift
// governor — one decoder means one playhead, so there is nothing left to hold in sync.
//
// Two halves, the repo's usual split for this component:
//
//   A. BEHAVIOURAL — drive the REAL PitchShiftGraph under stubbed WebAudio and prove the graph SHAPE.
//      The channel indices are the whole contract (the browser splits by index, not by layout label),
//      and a stub is the only place they can be asserted without a sound card.
//
//   B. SOURCE-SCAN — the wiring lives in .svelte effects that bun cannot execute without a Svelte
//      compile and a DOM, so a text scan proves it is CONNECTED. Each has a named mutation trap.
import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { read } from '@encore/test-support';
import { PitchShiftGraph } from '$lib/tv/pitch-shift';

// ── stubs ─────────────────────────────────────────────────────────────────────────────────────────

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
	/** The worklet node, so a test can assert what actually feeds the splitter. */
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
 * An `AudioContext` constructor whose instance is published to `ctx`, so a test can inspect the graph the
 * code under test built internally.
 *
 * A factory rather than a subclass that publishes itself from inside its own constructor: doing that is
 * banned by lint, and the ban is right — that shape is what makes it easy to publish a HALF-CONSTRUCTED
 * instance. Building it fully and then publishing cannot.
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

// ── A. the graph shape ────────────────────────────────────────────────────────────────────────────

describe('split mode wires each channel pair to its own gain', () => {
	test('a 4-way splitter and two stereo mergers exist — pairs are re-merged, never summed', async () => {
		// The trap: connecting splitter outputs 0 and 1 into ONE GainNode sums them, collapsing the
		// instrumental to mono. A ChannelMerger is what keeps left as left.
		const g = new PitchShiftGraph(el(), { split: true });
		await g.ensureRouted();
		expect(g.isRouted).toBe(true);
		expect(ctx!.splitters).toHaveLength(1);
		expect(ctx!.splitters[0].outputs).toBe(4);
		expect(ctx!.mergers.map((m) => m.inputs)).toEqual([2, 2]);
	});

	test('the SPLITTER is fed by the worklet, not straight from the source', async () => {
		// Bypassing the worklet leaves the shifter dangling: the graph still plays and the guide still has
		// its own level, but ±key silently does nothing on exactly the songs that got this feature. No other
		// assertion in this file moves when that happens.
		const g = new PitchShiftGraph(el(), { split: true });
		await g.ensureRouted();
		const [splitter] = ctx!.splitters;
		const feeders = inbound(splitter, [ctx!.source!, ctx!.worklet!]);
		expect(feeders.map(([kind]) => kind)).toEqual(['worklet']);
		// And the source feeds the worklet, so the chain is source -> worklet -> splitter.
		expect(inbound(ctx!.worklet!, [ctx!.source!]).map(([k]) => k)).toEqual(['node']);
	});

	test('the WHOLE chain per pair: channels 0/1 -> instrumental gain, 2/3 -> guide gain', async () => {
		// THE contract, and BOTH halves of it. The splitter indices alone are only half: exchanging which
		// merger feeds which gain puts the instrumental on the gain that defaults to 0 and the isolated
		// vocals on the gain that defaults to 1 — the room hears full-volume vocals with no backing track.
		// Asserting the indices and, separately, that "two gains reach the destination" cannot see that, so
		// this walks each pair from splitter to destination as one path.
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

		// Follow each merger to its gain, and identify the gain by the LEVEL it was told to carry — the one
		// thing that cannot be satisfied by exchanging the two nodes.
		const instGain = soleTarget(instMerger) as StubGain | null;
		const guideGain = soleTarget(guideMerger) as StubGain | null;
		expect(instGain?.kind).toBe('gain');
		expect(guideGain?.kind).toBe('gain');
		expect(instGain!.gain.value).toBeCloseTo(0.9, 6);
		expect(guideGain!.gain.value).toBeCloseTo(0.25, 6);
		expect(instGain).not.toBe(guideGain);

		// …and each gain reaches the destination, so both pairs sum back to one output.
		expect(soleTarget(instGain!)).toBe(ctx!.destination);
		expect(soleTarget(guideGain!)).toBe(ctx!.destination);
	});

	test('setGuideGain moves ONLY the guide pair, and setGain only the instrumental pair', async () => {
		// The runtime half of the same property: if the two were exchanged, moving the room's guide level
		// would attenuate the backing track instead.
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

describe('the guide pair defaults to SILENCE, not to full volume', () => {
	test('an un-set guide gain builds at 0 — fail quiet, never loud', async () => {
		// The precedent: a fresh graph defaulted its gain to 1, the level effect did not re-run on
		// construction, and the isolated vocals played at FULL VOLUME for the rest of the song. In split
		// mode the vocals are INSIDE the file the room is playing, so the worst case of a missed
		// setGuideGain must be a guide nobody hears — never one that drowns the singer.
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
		// The room's guide level is set by an effect that does NOT re-run when a graph is constructed, so
		// the graph has to read the remembered value itself.
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
		// Load-bearing: at keyShift 0 a plain song must touch no WebAudio, and when it does route for a
		// transpose it must route exactly as before.
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
		// The reason `masterSrcPlan` withholds the mix src until `isRouted`: here the element is still on
		// its native output, where a 4-channel file would be DOWNMIXED — isolated vocals at full volume.
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
		// `outputChannelCount: [4]` is a documented NotSupportedError candidate. Before the fix a throw
		// here happened AFTER the irreversible capture and the catch then CLOSED the context — silencing
		// that element for the life of the page. Now it falls back and clears `split`, so `mixGateFor`
		// answers `denied` and the room plays the plain instrumental with no guide.
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
		// Ordering as a PROPERTY rather than a comment: make a later node construction throw and assert
		// the element was never committed. A capture followed by a thrown build is what silenced an
		// element permanently, because the catch closed the context under it.
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
		// The released-context leak class, reopened by the EAGER build: a mix song mounts, the build starts,
		// drains and the slot detaches — and the orphan build used to reach `routed = true` on a graph
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

// ── B. the wiring, by source scan ─────────────────────────────────────────────────────────────────

/**
 * The repo's convention for a source scan, and NOT optional here. Two of this file's earlier scans were
 * defeated by simply COMMENTING THE CALL OUT: a raw-text `toContain` is satisfied by the commented copy,
 * so the mutation passed while the behaviour was gone. Blanking comments (rather than deleting them)
 * preserves offsets, so a failure still points at the right line.
 */
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

describe('TvPlayer wiring', () => {
	const src = stripComments(read('src/lib/tv/TvPlayer.svelte'));

	test('the second element is gated on the ELEMENT path, so a mix song never mounts one', () => {
		// The single most important line in the feature. Mounting both would sound the vocals twice —
		// once inside the mix at the room's level, once on top at the element's — a doubled, flanged
		// vocal, which is the defect class the mix exists to remove.
		expect(src).toMatch(/guideRef\s*=\s*\$derived\(\s*guidePlan\.kind === 'element'/);
		// Mutation trap: ANY spelling that reads the raw stem ref would mount both, so reject the field
		// appearing in this derived at all rather than one exact rewrite of it.
		expect(src).not.toMatch(/guideRef\s*=\s*\$derived\([^)]*vocalsRef/);
	});

	test('the master src goes through masterSrcPlan with the FULL gate, never a bare isRouted', () => {
		// `mixGateFor` is what folds in `isSplit`. Passing `isRouted` alone is the leftover-non-split-graph
		// downmix; passing a literal is the pending-src rewrite. Assert the call SHAPE, tolerant of
		// formatting, and reject both failure modes by name.
		expect(src).toMatch(/masterSrcPlan\(\s*guidePlan\s*,\s*playbackRef\(m\)\s*,\s*mixGateFor\(/);
		expect(src).not.toMatch(/masterSrcPlan\([^)]*isRouted/);
		expect(src).not.toMatch(/masterSrcPlan\([^)]*(true|false)\s*\)/);
	});

	test('mixGateFor is asked about the graph AND the settled flag', () => {
		expect(src).toMatch(/mixGateFor\(\s*masterGraph\s*,\s*mixSettled\s*\)/);
	});

	test('the src effect reads the settled signal, so a mix that becomes safe is actually played', () => {
		// The graph's getters cannot wake an effect. Without a reactive read the mix is built, becomes
		// safe, and is never played — a silent no-op nobody would notice.
		// A bare `void` read, which is this repo's idiom for registering a dependency whose VALUE is not
		// needed (see `void seekRev` in the seek effect).
		expect(src).toMatch(/void mixSettled;/);
	});

	test('the routing attempt settles on FAILURE too, or a denied room never gets a src', () => {
		// A mix song commits nothing while pending, so an attempt that only settles on success would leave
		// the element holding '' for the whole song — silence, not a fallback.
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
		// Without this the level knob does nothing on a mix song: there is no second element whose
		// `.volume` it could set, and the graph's gain would sit at its 0 default forever.
		expect(src).toMatch(/masterGraph\?\.setGuideGain\(effectiveGuide\)/);
	});
});
