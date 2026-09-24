// Browser-side pitch shifter for the TV stage — changes PITCH without changing TEMPO. A time-domain SOLA shifter
// that resamples by the pitch ratio and time-stretches by the inverse through overlapping Hann-windowed grains.
// Hand-written because soundtouchjs (LGPL) and rubberband (GPL/commercial) are both unusable here.
//
// THE TRAP THE WHOLE LIFECYCLE IS SHAPED BY: a MediaElementAudioSourceNode is a PERMANENT capture, and a context
// built without user activation stays suspended, so getting the order wrong costs the room ALL its audio rather
// than just the shift. See docs/FRONTEND.md#the-pitch-shift-graph.

// Playback-speed ratio for a semitone shift. Returns EXACTLY 1 at 0, so every "ratio === 1 means bypass" check is
// bit-exact rather than a 0.9999999 that keeps the graph doing needless work.
export function semitonesToRatio(semitones: number): number {
	if (!Number.isFinite(semitones) || semitones === 0) return 1;
	return Math.pow(2, semitones / 12);
}

/** Is this shift audible, i.e. does it need the graph at all? Exactly 0 (or non-finite) -> no. */
export function needsShift(semitones: number): boolean {
	return semitonesToRatio(semitones) !== 1;
}

// How far AHEAD of the grain's start the resampling read reaches: a grain at input `p` reads `p + k * ratio`, so
// input out to `p + grainSize * ratio` must exist first. The analysis hop EQUALS the synthesis hop here — scaling it
// by `ratio` too applies the tempo correction twice and the read pointer diverges without bound.
export function grainLookahead(grainSize: number, ratio: number): number {
	return Math.ceil(grainSize * ratio);
}

// How far the SOLA alignment search may move the read point. Must cover one period of the lowest tone worth
// aligning — 256 samples reaches ~94 Hz at 48 kHz — or a steady tone can arrive in antiphase.
export const ALIGN_SEARCH = 256;

// The lag to hold the read pointer behind the write pointer: a grain's resampled span, the search, and one hop of
// slack, so nothing reads past the newest input. ~40 ms of added latency at 48 kHz.
export function readLag(grainSize: number, synthesisHopSamples: number, ratio: number): number {
	return grainLookahead(grainSize, ratio) + ALIGN_SEARCH + synthesisHopSamples;
}

// The OLA processor as a source string, Blob-URL'd into `audioWorklet.addModule`. A worklet cannot import app
// modules, so the loop, the window, the hop and the lerp are written out here.
export const PITCH_WORKLET_SOURCE = /* js */ `
const GRAIN = 1024;         // grain size in samples
const OVERLAP = 4;          // 75% overlap -> windows^2 sum to a constant
const SYNTH_HOP = GRAIN / OVERLAP;
// The UI clamps the shift to +/-7 semitones, so the fastest read is 2^(7/12) ~= 1.4983. The ring is sized from
// THIS bound, so widening the clamp trips the assertion below rather than reading past the ring and aliasing.
const MAX_RATIO = 1.5;
// SEARCH covers one period down to ~94 Hz at 48 kHz; CORR_LEN is the overlap region the new grain must agree
// with. Coarse (stride CORR_STEP) then fine around the winner: ~80 candidates, not 2*SEARCH+1.
const SEARCH = 256;
const CORR_LEN = 200;
const CORR_STEP = 8;
// Must hold a grain's whole resampled span, the search range, the lag behind the write head and a render block,
// so a ring wrap can never overwrite a sample still to be read.
const HIST = 4096;
if (HIST < GRAIN * MAX_RATIO + SEARCH + 2 * SYNTH_HOP) throw new Error('pitch-shift: HIST too small');

function hann(n) {
	const w = new Float32Array(n);
	for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
	return w;
}
const WINDOW = hann(GRAIN);

class PitchShiftProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.ratio = 1;
		// THE TIMELINE IS SHARED ACROSS CHANNELS — one read pointer, one write head, one grain schedule. A mix's four
		// channels are one file and must stay sample-locked; per-channel pointers let each SOLA search pick a
		// different offset, and the guide drifts off the instrumental at every non-zero shift.
		this.readPos = 0;      // fractional read pointer on the continuous input timeline (all channels)
		this.writePos = 0;     // absolute input samples written so far (all channels advance 1:1)
		this.anchored = false; // has readPos been tied to writePos yet?
		this.outHead = 0;      // how many finished output samples are queued in each channel's outAcc
		this.sinceGrain = 0;   // output samples emitted since the last grain was laid down
		// Per-channel state holds only CONTENT — the history ring and the output accumulator. Sharing THOSE is the
		// cross-talk failure: the guide pair carries the instrumental's audio.
		this.chan = [];
		this.port.onmessage = (e) => {
			if (e.data && typeof e.data.ratio === 'number' && isFinite(e.data.ratio)) {
				const r = e.data.ratio <= 0 ? 1 : Math.min(e.data.ratio, MAX_RATIO);
				if (r !== this.ratio) {
					this.ratio = r;
						// A ratio change invalidates the anchor.
					this.anchored = false;
				}
			}
		};
	}

	ensure(ch) {
		while (this.chan.length < ch) {
			this.chan.push({
				hist: new Float32Array(HIST),
					// Normalised by sum(WINDOW), NOT sum(WINDOW^2): with SOLA the grains reinforce, so sum(w) is unity
					// gain. sum(w^2) is the incoherent-overlap form and overshoots by 1.33x, clipping.
				outAcc: new Float32Array(GRAIN * 2),
				outNorm: new Float32Array(GRAIN * 2)
			});
		}
	}

	process(inputs, outputs) {
		const input = inputs[0];
		const output = outputs[0];
		if (!output || output.length === 0) return true;
		const frames = output[0].length;
		const channels = output.length;
		this.ensure(channels);

			// A missing input channel is silence rather than a dropped block, which would click.
		for (let i = 0; i < frames; i++) {
			const abs = this.writePos % HIST;
			for (let c = 0; c < channels; c++) {
				const inCh = input && input[c] ? input[c] : null;
				this.chan[c].hist[abs] = inCh ? inCh[i] : 0;
			}
			this.writePos++;
		}

			// Bit-exact bypass, so "return to key 0" matches the pre-WebAudio path.
		if (this.ratio === 1) {
			for (let c = 0; c < channels; c++) {
				const inCh = input && input[c] ? input[c] : null;
				if (inCh) output[c].set(inCh);
				else output[c].fill(0);
			}
			this.anchored = false; // a later shift must re-anchor rather than resume a stale pointer
			return true;
		}

		const lookahead = Math.ceil(GRAIN * this.ratio);
		const need = lookahead + SEARCH + SYNTH_HOP;

		for (let i = 0; i < frames; i++) {
				// On EVERY channel at once from the SAME read position, or the four channels drift.
			if (this.sinceGrain <= 0) {
					// ANCHOR TO THE WRITE HEAD. The pitch change lives in the intra-grain stride (k * ratio), NOT the hop, so
					// the pointer holds a fixed distance behind the newest input; a ratio-scaled hop diverges without bound —
					// silence going up, aliasing going down. The BAND stops an ordinary block boundary re-anchoring, which
					// would break grain continuity and click.
				const lag = this.writePos - this.readPos;
				if (!this.anchored || lag < need || lag > need + GRAIN) {
					this.readPos = this.writePos - need;
					this.anchored = true;
				}

					// SOLA: place the grain where it REINFORCES the accumulator, or a steady tone comb-filters itself (measured
					// RMS on a unit sine swung 0.055 to 0.695 on frequency and ratio alone). ONE OFFSET FOR ALL CHANNELS —
					// the correlation is SUMMED, because a per-channel winner drifts the pairs apart.
				let best = 0;
				if (this.outHead > GRAIN) {
					best = this.align(channels, CORR_STEP);
					best = this.align(channels, 1, best);
				}
				const base = this.readPos + best;

					// Computed once per k and reused, which is what keeps the channels sample-locked.
				const accLen = this.chan[0].outAcc.length;
				const writePos = this.writePos;
				for (let k = 0; k < GRAIN; k++) {
					const rp = base + k * this.ratio;      // resample: this is where the pitch changes
					const idx = Math.floor(rp);
					const frac = rp - idx;
					const w = WINDOW[k];
					const oi = (this.outHead + k) % accLen;
					const inRange = idx >= 0 && idx + 1 < writePos && idx >= writePos - HIST;
					for (let c = 0; c < channels; c++) {
						const s = this.chan[c];
						const h = s.hist;
						const a = inRange ? h[idx % HIST] : this.histSample(s, idx);
						const b = inRange ? h[(idx + 1) % HIST] : this.histSample(s, idx + 1);
						s.outAcc[oi] += (a * (1 - frac) + b * frac) * w;
						s.outNorm[oi] += w;
					}
				}
					// From the CHOSEN base, so the offset is absorbed rather than re-applied every grain.
				this.readPos = base + SYNTH_HOP;              // analysis hop == synthesis hop
				this.sinceGrain += SYNTH_HOP;
			}
			const oi = this.outHead % this.chan[0].outAcc.length;
			for (let c = 0; c < channels; c++) {
				const s = this.chan[c];
				const norm = s.outNorm[oi];
				output[c][i] = norm > 1e-6 ? s.outAcc[oi] / norm : 0;
				s.outAcc[oi] = 0;
				s.outNorm[oi] = 0;
			}
			this.outHead++;
			this.sinceGrain--;
		}
		return true;
	}

		// Best offset by cross-correlation against the accumulator, normalised by the candidate's energy so a loud
		// candidate cannot win on level alone. Summed across ALL channels, one SHARED read pointer.
	align(channels, stride, around) {
		const lo = around === undefined ? -SEARCH : Math.max(-SEARCH, around - CORR_STEP);
		const hi = around === undefined ? SEARCH : Math.min(SEARCH, around + CORR_STEP);
		let bestOff = around === undefined ? 0 : around;
		let bestScore = -Infinity;
			// Hoisted ONCE: a property chain in the innermost loop made the summed search ~10x slower, and a worklet
			// must finish inside one render quantum.
		const hist = [];
		const outAcc = [];
		const outNorm = [];
		for (let c = 0; c < channels; c++) {
			hist.push(this.chan[c].hist);
			outAcc.push(this.chan[c].outAcc);
			outNorm.push(this.chan[c].outNorm);
		}
		const accLen = outAcc[0].length;
		const writePos = this.writePos;
		for (let off = lo; off <= hi; off += stride) {
			let dot = 0;
			let energy = 0;
			for (let k = 0; k < CORR_LEN; k += 2) {   // every other sample: same winner, half the work
				const oi = (this.outHead + k) % accLen;
				const rp = this.readPos + off + k * this.ratio;
				const idx = Math.floor(rp);
				const frac = rp - idx;
					// Index math is shared across channels; the sample fetch is per channel.
				const inRange = idx >= 0 && idx + 1 < writePos && idx >= writePos - HIST;
				for (let c = 0; c < channels; c++) {
					const n = outNorm[c][oi];
					if (n <= 1e-6) continue;
					const have = outAcc[c][oi] / n;
					const h = hist[c];
					const a = inRange ? h[idx % HIST] : this.histSample(this.chan[c], idx);
					const b = inRange ? h[(idx + 1) % HIST] : this.histSample(this.chan[c], idx + 1);
					const cand = a * (1 - frac) + b * frac;
					dot += have * cand;
					energy += cand * cand;
				}
			}
			const score = energy > 1e-9 ? dot / Math.sqrt(energy) : 0;
			if (score > bestScore) {
				bestScore = score;
				bestOff = off;
			}
		}
		return bestOff;
	}

		// Out of range returns 0, NOT a wrapped neighbour, because a wrapped read is unrelated audio. This is
		// deliberately not an edge-clamping interpolator and must not be unified into one.
	histSample(s, absIdx) {
		if (absIdx < 0) return 0;
		if (absIdx >= this.writePos) return 0;
		if (absIdx < this.writePos - HIST) return 0;
		return s.hist[absIdx % HIST];
	}
}

registerProcessor('encore-pitch-shift', PitchShiftProcessor);
`;

// `webkitAudioContext` is not in the DOM lib at all, and the window is read through ONE narrowed view rather than cast
// per name: the stubs the tests install carry `AudioContext` alone, so both names must stay optional.
function audioContextCtor(): typeof AudioContext | undefined {
	const g = window as unknown as {
		AudioContext?: typeof AudioContext;
		webkitAudioContext?: typeof AudioContext;
	};
	return g.AudioContext ?? g.webkitAudioContext;
}

/**
 * Wraps ONE HTMLMediaElement in a lazily-built pitch-shift graph.
 *
 *   setShift(shift): the SOLE ratio entry point, idempotent, and what builds the graph. At shift 0 with no graph
 *     it builds NOTHING, so the audio path stays byte-for-byte the plain element.
 *   ensureRouted(): build NOW, split mode only. Resolving does not mean success — read `isRouted`.
 *   detach(): disconnect on ELEMENT teardown. It cannot restore the pre-WebAudio path, so only ever attach a
 *     graph to an element that lives as long as the graph.
 */
export class PitchShiftGraph {
	private el: HTMLMediaElement;
	private ctx: AudioContext | null = null;
	private source: MediaElementAudioSourceNode | null = null;
	private node: AudioWorkletNode | null = null;
	private gain: GainNode | null = null;
	private moduleUrl: string | null = null;
	private ratio = 1;
	/** Applied IN THE GRAPH, because `HTMLMediaElement.volume` is BYPASSED once the element is captured. */
	private desiredGain = 1;
	// SPLIT MODE — a 4-channel GUIDE MIX, whose two pairs each get their own gain. It lives in THIS class because the
	// capture is ONE PER ELEMENT: a shifter and a splitter cannot each own a graph over the same element.
	private split: boolean;
	private splitter: ChannelSplitterNode | null = null;
	/** Re-merged stereo pairs, kept so `detach` can disconnect them. */
	private mergers: ChannelMergerNode[] = [];
	/** The vocals pair's own level — the guiding-track knob, in split mode. */
	private guideGain: GainNode | null = null;
	// DEFAULTS TO 0, unlike `desiredGain`: the vocals are INSIDE the file the room is playing, so the worst case of a
	// missed `setGuideGain` must be a guide nobody hears, never isolated vocals at full volume.
	private desiredGuideGain = 0;
	/** True once a MediaElementSource is attached — from here the element only outputs via the graph. */
	private routed = false;
	/** True if we tried to build the graph and could not resume — audible-fallback mode. */
	private degraded = false;
	// Can this graph change PITCH at all? False with no `AudioWorklet`, i.e. a non-secure context — the documented LAN
	// deployment, so the NORMAL state there. Kept SEPARATE from `degraded`: such a graph is fully built and still
	// splits the mix and owns both gains, so conflating them hides a working guide or advertises an impossible ±key.
	private canShift = true;
	// Memoised so two concurrent `setShift(non-zero)` calls SHARE one build: otherwise each opens its own context and
	// calls the irreversible capture, the second throws, and a context is stranded. Cleared once settled, so a FAILED
	// attempt stays retryable.
	#building: Promise<void> | null = null;
	// Distinct from `routed`: between the capture and the last connect the element is committed while the graph is
	// unfinished, and closing the context after a capture silences the element permanently.
	#captured = false;
	// Checked after EVERY `await` in `#buildOnce`, so a build in flight when the element is torn down closes its own
	// context instead of routing an orphan nothing holds.
	#disposed = false;

	// PINNED to 4 channels in split mode: left to negotiate, a worklet settles on stereo and silently drops the guide
	// pair. But `outputChannelCount` is a documented NotSupportedError candidate, so a refusal degrades to a default
	// node and CLEARS `split`, which makes the caller withhold the mix src.
	private makeWorkletNode(ctx: AudioContext): AudioWorkletNode {
		if (!this.split) return new AudioWorkletNode(ctx, 'encore-pitch-shift');
		try {
			return new AudioWorkletNode(ctx, 'encore-pitch-shift', {
				channelCount: 4,
				channelCountMode: 'explicit',
				outputChannelCount: [4]
			});
		} catch {
			// Stop claiming to be a split graph, so nothing promotes a 4-channel src into it.
			this.split = false;
			return new AudioWorkletNode(ctx, 'encore-pitch-shift');
		}
	}

	constructor(el: HTMLMediaElement, opts: { split?: boolean } = {}) {
		this.el = el;
		this.split = opts.split === true;
	}

	// Build NOW — split mode only, because a mix's guiding track does not exist until the splitter runs. Everything
	// else stays LAZY, so keyShift 0 touches no WebAudio. Resolving does NOT mean success: read `isRouted`, because a
	// suspended context leaves the element degraded on its native output.
	async ensureRouted(): Promise<void> {
		if (this.routed) return;
		await this.build();
	}

	/** Build (if needed) and apply the given shift. Safe to call repeatedly with the same value. */
	async setShift(shift: number): Promise<void> {
		const ratio = semitonesToRatio(shift);
		this.ratio = ratio;
		if (!this.routed) {
			// At ratio 1 keep it that way: the audio path is not touched until a real shift is asked for.
			if (ratio === 1) return;
			await this.build();
		}
		if (this.node) {
			this.node.port.postMessage({ ratio });
		}
	}

	/** Coalesce concurrent callers onto ONE attempt, cleared on settle so a gesture-starved build retries. */
	private build(): Promise<void> {
		if (this.routed) return Promise.resolve();
		if (this.#building) return this.#building;
		const p = this.#buildOnce().finally(() => {
			if (this.#building === p) this.#building = null;
		});
		this.#building = p;
		return p;
	}

	async #buildOnce(): Promise<void> {
		// `degraded` records only that the LAST attempt found no runnable context, and must NOT be terminal or the
		// instrumental never shifts again after one pre-gesture press. A retry is harmless because the irreversible
		// capture stays behind the `state === 'running'` check below.
		if (this.routed) return;
		this.degraded = false;
		try {
			const Ctor = audioContextCtor();
			if (!Ctor) {
				this.degraded = true;
				return;
			}
			this.ctx = new Ctor();
			// On a TV wall the gesture may never come, so resume() can reject or stay suspended.
			await this.ctx.resume().catch(() => {});
			// Torn down while awaiting: bail BEFORE the capture rather than route a graph nothing holds.
			if (this.#disposed) {
				await this.ctx.close().catch(() => {});
				this.ctx = null;
				return;
			}
			if (this.ctx.state !== 'running') {
				// CRITICAL: do NOT create the MediaElementSource — that permanently steals the element's audio into a
				// dead suspended graph, i.e. total silence.
				await this.ctx.close().catch(() => {});
				this.ctx = null;
				this.degraded = true;
				return;
			}
			// THE WORKLET IS OPTIONAL. `AudioWorklet` is secure-context-only and the documented deployment is plain HTTP
			// on a LAN IP, so dereferencing it unconditionally takes the ENTIRE graph down — including the splitter,
			// which needs no worklet — costing the room its guide as well as ±key.
			if (this.ctx.audioWorklet) {
				const blob = new Blob([PITCH_WORKLET_SOURCE], { type: 'application/javascript' });
				this.moduleUrl = URL.createObjectURL(blob);
				try {
					await this.ctx.audioWorklet.addModule(this.moduleUrl);
				} catch {
					// Same outcome as an absent worklet: no shifting, everything downstream still buildable.
					this.canShift = false;
				}
			} else {
				this.canShift = false;
			}
			// `addModule` is the slow step, so this is the window an eager split build lands in.
			if (this.#disposed) {
				await this.ctx.close().catch(() => {});
				this.ctx = null;
				return;
			}

			// NOTHING TO BUILD, AND THE CAPTURE MUST NOT HAPPEN: without a worklet a non-split song gains nothing, and
			// the capture is irreversible and bypasses `volume`, so it would take over the audio path to deliver nothing.
			if (!this.canShift && !this.split) {
				await this.ctx.close().catch(() => {});
				this.ctx = null;
				return;
			}

			// BUILD EVERY NODE BEFORE THE CAPTURE. Anything that CAN THROW must precede the irreversible capture, or a
			// throw leaves the element owned by a source node whose context the `catch` then CLOSES — silence for the
			// life of the page. `outputChannelCount: [4]` is a real throw candidate, so this ordering is load-bearing.
			this.node = this.canShift ? this.makeWorkletNode(this.ctx) : null;
			this.gain = this.ctx.createGain();
			this.gain.gain.value = this.desiredGain;
			if (this.split) {
				// source -> [shifter] -> splitter(4) -> pair -> merger -> gain -> speakers. Each pair is re-MERGED to stereo
				// BEFORE its gain, because feeding outputs 0 and 1 into one GainNode SUMS them to mono. WHICH MERGER FEEDS
				// WHICH GAIN IS HALF THE CONTRACT: exchanging them puts the isolated vocals on the gain defaulting to 1.
				this.splitter = this.ctx.createChannelSplitter(4);
				if (this.node) this.node.connect(this.splitter);
				const instMerger = this.ctx.createChannelMerger(2);
				this.splitter.connect(instMerger, 0, 0);
				this.splitter.connect(instMerger, 1, 1);
				instMerger.connect(this.gain).connect(this.ctx.destination);
				const guideMerger = this.ctx.createChannelMerger(2);
				this.splitter.connect(guideMerger, 2, 0);
				this.splitter.connect(guideMerger, 3, 1);
				this.guideGain = this.ctx.createGain();
				// The level set BEFORE the graph existed: the level effect does NOT re-run on construction.
				this.guideGain.gain.value = this.desiredGuideGain;
				guideMerger.connect(this.guideGain).connect(this.ctx.destination);
				this.mergers = [instMerger, guideMerger];
			} else {
				// The gain stage re-implements the volume knob the capture bypasses.
				this.node?.connect(this.gain).connect(this.ctx.destination);
			}

			// LAST: commit the element. Nothing downstream is left that can throw and strand it.
			this.source = this.ctx.createMediaElementSource(this.el);
			this.#captured = true;
			// The `??` chain is spelled out so a future fourth case cannot connect the source to nothing.
			this.source.connect(this.node ?? this.splitter ?? this.gain);
			this.routed = true;
			this.node?.port.postMessage({ ratio: this.ratio });
		} catch {
			// BEFORE the capture: close the context, leaving the element audible on its native output. AFTER the capture
			// it must NOT be closed — that silences the element forever — so reconnect the source to the destination.
			if (this.#captured && this.ctx) {
				try {
					this.source?.connect(this.ctx.destination);
					this.routed = true;
				} catch {
					/* nothing further to try; the element is captured either way */
				}
				return;
			}
			if (!this.routed) {
				await this.ctx?.close().catch(() => {});
				this.ctx = null;
				this.degraded = true;
			}
		}
	}

	/** True once audio is flowing through WebAudio. */
	get isRouted(): boolean {
		return this.routed;
	}

	// Safe to call unconditionally: remembered in `desiredGain` and applied when the graph is built. Once routed,
	// `volume` is bypassed by the capture, so THIS is the only volume control.
	setGain(level: number): void {
		const g = Math.max(0, Math.min(1, level));
		this.desiredGain = g;
		if (this.gain) this.gain.gain.value = g;
	}

	// The guiding-track knob, split mode only. Separate from `setGain` because one setter taking two levels lets a
	// caller believe it set a guide level on an element with no guide in it.
	setGuideGain(level: number): void {
		const g = Math.max(0, Math.min(1, level));
		this.desiredGuideGain = g;
		if (this.guideGain) this.guideGain.gain.value = g;
	}

	/** True when this graph pulls a 4-channel mix apart — i.e. the guide rides inside the master element. */
	get isSplit(): boolean {
		return this.split;
	}

	// True when ±key can actually change the pitch — the ONE thing to read before offering a transpose control,
	// because a UI showing `Key · +2` while this is false tells the room something untrue.
	get isShiftable(): boolean {
		return this.canShift;
	}

	/** True if we tried and could not run a context — playback is audible but unshifted. */
	get isDegraded(): boolean {
		return this.degraded;
	}

	// Release the context when the ELEMENT is torn down. It CANNOT restore the native output — the capture is
	// permanent — so only ever attach a graph to an element that lives as long as it.
	detach(): void {
		// BEFORE the disconnects, so a build resuming from an await in the same tick abandons itself.
		this.#disposed = true;
		try {
			this.node?.disconnect();
			this.source?.disconnect();
			this.gain?.disconnect();
			// The split stage too, or the splitter and both mergers hold references into a closed context.
			this.splitter?.disconnect();
			for (const m of this.mergers) m.disconnect();
			this.guideGain?.disconnect();
		} catch {
			/* disconnect on an already-dead node throws; ignore */
		}
		if (this.moduleUrl) {
			URL.revokeObjectURL(this.moduleUrl);
			this.moduleUrl = null;
		}
		this.ctx?.close().catch(() => {});
		this.ctx = null;
		this.node = null;
		this.source = null;
		this.gain = null;
		this.splitter = null;
		this.mergers = [];
		this.guideGain = null;
		// routed stays true: the element is still (permanently) captured. Do not pretend otherwise.
	}
}
