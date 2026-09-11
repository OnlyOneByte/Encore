// Browser-side pitch shifter for the TV stage — changes PITCH without changing TEMPO.
//
// WHY THIS EXISTS AT ALL. The phone's ±semitone buttons store `PlaybackState.keyShift`, and the TV
// used to honour it by loading a pre-rendered per-key FILE (`keyedMediaRef`). Nothing ever produced
// those files, so honouring the shift 404'd mid-song and the TV was forced to ignore it. Rendering
// per-key variants server-side was rejected (N files per song, a worker stage nobody built); shifting
// in the browser needs zero files and works on every already-cooked song. `keyedMediaRef` is gone
// from @encore/shared; this module is its replacement.
//
// WHY A HAND-WRITTEN SHIFTER. soundtouchjs is LGPL and rubberband is GPL/commercial — both are
// unacceptable dependencies here — so the algorithm is written out below: a time-domain
// overlap-add (OLA) pitch shifter. It resamples the signal by the pitch ratio (which alone would
// change tempo) and simultaneously time-stretches by the inverse ratio via overlapping Hann-windowed
// grains, so the net tempo is unchanged while the pitch moves. This is the SOLA/PSOLA family without
// pitch-synchronous grain placement — cheap, real-time-safe in an AudioWorklet, and good enough for a
// backing track under a live vocal. It is NOT studio-grade; transients smear slightly. That is the
// accepted trade for a zero-dependency, file-free shift.
//
// ───────────────────────────────────────────────────────────────────────────────────────────────
// THE BIG TRAP (documented for whoever touches this next): TvPlayer has NO AudioContext today. Plain
// <video>/<audio> elements play through the platform mixer with no WebAudio involved. An AudioContext
// created in a page that never received a user gesture starts `suspended`, and the TV wall display may
// NEVER be clicked. If we route audio through a suspended context we get SILENCE — and worse, a
// MediaElementAudioSourceNode, once created for an element, CANNOT be detached: from that point the
// element's audio ONLY reaches the speakers through the graph. So a naive "always wrap the element"
// design risks killing ALL room audio, not just the shift.
//
// The contract that keeps this safe (enforced by PitchShiftGraph below and its callers in
// TvPlayer.svelte):
//   • keyShift === 0  -> do NOTHING. No AudioContext, no MediaElementSource. The audio path is
//     byte-for-byte what it is today. This is the overwhelmingly common case and it must never regress.
//   • first non-zero shift -> build the graph LAZILY, and only after resume() actually succeeds.
//   • cannot resume (no gesture yet) -> FALL BACK to unshifted AUDIBLE playback via the element's own
//     output. Never silence. The pitch is simply not applied until a context can run.
//   • return to 0 -> we cannot un-source the element, so instead we set the shifter's ratio to 1.0
//     (a pass-through that copies input to output) and leave the graph in place. The element stays
//     routed through WebAudio, but at ratio 1 that is audibly identical to the bypass path.
//
// See PitchShiftGraph.setShift (reset to ratio 1) / detach (context release) for the concrete
// teardown strategy.

// ── pure ratio + framing maths (unit-tested; no DOM, no AudioContext) ─────────────────────────────

/**
 * Playback-speed ratio for a semitone shift. +12 -> 2.0 (up an octave), -12 -> 0.5 (down an octave),
 * 0 -> exactly 1.0. This is the factor the resampler reads the input at; the time-stretch stage undoes
 * the tempo change it would otherwise cause. 12 is the semitones-per-octave of equal temperament.
 *
 * Returns exactly 1 at 0 so the caller's "ratio === 1 means bypass" check is bit-exact, never a
 * 0.9999999 that would keep the graph doing needless work.
 */
export function semitonesToRatio(semitones: number): number {
	if (!Number.isFinite(semitones) || semitones === 0) return 1;
	return Math.pow(2, semitones / 12);
}

/** Is this shift audible, i.e. does it need the graph at all? Exactly 0 (or non-finite) -> no. */
export function needsShift(semitones: number): boolean {
	return semitonesToRatio(semitones) !== 1;
}

/**
 * How far AHEAD of the grain's start the resampling read reaches, in input samples.
 *
 * This is the quantity the ring buffer and the read-pointer lag must both respect: a grain that starts
 * at input position `p` reads `p + k × ratio` for k in [0, grainSize), so it needs input out to
 * `p + grainSize × ratio` to exist before it can be laid down.
 *
 * It replaces an `analysisHop(hop, ratio) = hop × ratio` helper that was WRONG for this design, and
 * whose formula was the shipped bug. `hop × ratio` is the correct analysis hop when resampling is a
 * SEPARATE stage applied after time-stretching. Here the resample is fused into the grain read, so the
 * grain itself already consumes `grainSize × ratio` input per `grainSize` output — scaling the hop by
 * `ratio` as well applied the tempo correction TWICE, which is why the read pointer advanced `ratio`×
 * faster than the write pointer and diverged without bound (silence going up, aliased noise going
 * down). In this design the analysis hop simply EQUALS the synthesis hop; the pitch change lives
 * entirely in the intra-grain stride.
 */
export function grainLookahead(grainSize: number, ratio: number): number {
	return Math.ceil(grainSize * ratio);
}

/**
 * How far the SOLA alignment search may move the read point, in input samples.
 *
 * The search is what stops overlapping grains cancelling each other. Without it, at one output instant
 * grain g and grain g+1 come from input positions `hop × (1 − ratio)` apart, so a steady tone can
 * arrive in antiphase: measured output on a unit sine swung between 0.055 and 0.695 purely on
 * frequency and ratio. `search` must cover one period of the lowest tone worth aligning — 256 samples
 * reaches ~94 Hz at 48 kHz.
 */
export const ALIGN_SEARCH = 256;

/**
 * The steady-state lag to hold the read pointer behind the write pointer, in input samples.
 *
 * Enough for the grain's whole resampled span, the alignment search, and one hop of slack, so neither
 * an ordinary block boundary nor the search itself ever reads past the newest input. This is the
 * shifter's added latency: ~40 ms at 48 kHz for the largest shift the UI allows, inaudible under a
 * live vocal.
 */
export function readLag(grainSize: number, synthesisHopSamples: number, ratio: number): number {
	return grainLookahead(grainSize, ratio) + ALIGN_SEARCH + synthesisHopSamples;
}

// ── the AudioWorklet processor, as a self-contained source string ─────────────────────────────────
//
// A worklet runs in a SEPARATE global scope (AudioWorkletGlobalScope) and CANNOT import app modules,
// so the OLA loop is written out in full here rather than importing anything above. It carries its
// own Hann window, its own `SYNTH_HOP = GRAIN / OVERLAP`, and its own inline lerp. One boundary rule
// is deliberate: the worklet's `histSample` returns 0 out of range ON PURPOSE — a wrapped/clamped
// ring read would be unrelated audio (the aliasing the free-running pointer once produced), so it is
// NOT an edge-clamping interpolator and must not be "unified" into one.
// This string is turned into a Blob URL and passed to `audioWorklet.addModule`, which keeps the whole
// shifter in ONE file with no separate static asset to serve or cache-bust.
//
// The processor keeps a small ring of input history per channel and, for each output block, lays down
// Hann-windowed grains resampled by `ratio`, advancing the read pointer by ratio×hop. At ratio 1 it
// still runs but produces output audibly identical to the input (a windowed copy that sums to unity),
// so "return to 0" needs no graph teardown — it just sets ratio to 1 via a message.
export const PITCH_WORKLET_SOURCE = /* js */ `
const GRAIN = 1024;         // grain size in samples
const OVERLAP = 4;          // 75% overlap -> windows^2 sum to a constant
const SYNTH_HOP = GRAIN / OVERLAP;
// The UI clamps the shift to +/-7 semitones, so the fastest read is 2^(7/12) ~= 1.4983. The history
// ring is sized from that bound rather than a round number, so a future widening of the clamp trips
// the assertion below instead of silently reading past the ring and aliasing.
const MAX_RATIO = 1.5;
// How far the SOLA alignment search may move the read point, and how many samples it correlates over.
// SEARCH covers one period down to ~94 Hz at 48 kHz, which is the musically useful range for a backing
// track; CORR_LEN is the overlap region the new grain must agree with. The search runs coarse (stride
// CORR_STEP) then fine around the winner, so it costs ~80 candidate offsets instead of 2*SEARCH+1.
const SEARCH = 256;
const CORR_LEN = 200;
const CORR_STEP = 8;
// Must hold the whole resampled span of a grain (GRAIN * MAX_RATIO), the alignment search range, the
// lag we keep behind the write head, and a render block, with room to spare so a wrap never overwrites
// a sample still to be read.
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
		// Per-channel state, grown lazily to the channel count we actually see.
		this.chan = [];
		this.port.onmessage = (e) => {
			if (e.data && typeof e.data.ratio === 'number' && isFinite(e.data.ratio)) {
				const r = e.data.ratio <= 0 ? 1 : Math.min(e.data.ratio, MAX_RATIO);
				if (r !== this.ratio) {
					this.ratio = r;
					// The required lag depends on the ratio, so a change invalidates the current anchor.
					// Re-anchor on the next grain rather than reading past the write head for one grain.
					for (let i = 0; i < this.chan.length; i++) this.chan[i].anchored = false;
				}
			}
		};
	}

	ensure(ch) {
		while (this.chan.length < ch) {
			this.chan.push({
				hist: new Float32Array(HIST),
				readPos: 0,      // fractional read pointer on the continuous input timeline
				writePos: 0,     // absolute input samples written so far
				anchored: false, // has readPos been tied to writePos yet?
				// output accumulator + its normalisation (sum of WINDOW, not WINDOW^2: with SOLA the grains
				// reinforce, so dividing by sum(w) is unity gain. sum(w^2) is the incoherent-overlap form and
				// over-shot by sum(w)/sum(w^2) = 2.0/1.5 = 1.33x, which would clip loud material.
				outAcc: new Float32Array(GRAIN * 2),
				outNorm: new Float32Array(GRAIN * 2),
				outHead: 0,      // how many finished output samples are queued in outAcc
				sinceGrain: 0    // output samples emitted since the last grain was laid down
			});
		}
	}

	process(inputs, outputs) {
		const input = inputs[0];
		const output = outputs[0];
		if (!output || output.length === 0) return true;
		const frames = output[0].length;
		this.ensure(output.length);

		// ratio 1 with no input still must emit silence-free output; a missing input channel is treated
		// as silence rather than dropping the block (which would click).
		for (let c = 0; c < output.length; c++) {
			const s = this.chan[c];
			const inCh = input && input[c] ? input[c] : null;
			const out = output[c];

			// Push this block's input into the history ring.
			for (let i = 0; i < frames; i++) {
				s.hist[s.writePos % HIST] = inCh ? inCh[i] : 0;
				s.writePos++;
			}

			// Fast path: at ratio 1 copy straight through. Bit-exact bypass, so "return to key 0" is
			// audibly identical to the pre-WebAudio path even though the element stays sourced.
			if (this.ratio === 1) {
				if (inCh) out.set(inCh);
				else out.fill(0);
				s.anchored = false; // a later shift must re-anchor rather than resume a stale pointer
				continue;
			}

			// The lag the read pointer must keep behind the write head: the grain's whole resampled
			// span, the alignment search range, plus one hop of slack.
			const lookahead = Math.ceil(GRAIN * this.ratio);
			const need = lookahead + SEARCH + SYNTH_HOP;

			for (let i = 0; i < frames; i++) {
				// Lay down a new grain every SYNTH_HOP output samples.
				if (s.sinceGrain <= 0) {
					// ANCHOR THE READ POINTER TO THE WRITE HEAD. readPos used to free-run at
					// SYNTH_HOP * ratio per grain while writePos advanced SYNTH_HOP (output and input run
					// 1:1 through this node), so the two diverged by |1 - ratio| * frameRate every second,
					// without bound: reading up, every index landed past writePos and histSample returned
					// 0 -> SILENCE; reading down, indices fell so far behind that absIdx % HIST wrapped
					// onto unrelated recent audio -> ALIASED NOISE. Both got worse the longer a song ran.
					//
					// The pitch shift does NOT come from the hop: it comes from the intra-grain stride
					// (k * ratio below). So the analysis hop equals the synthesis hop, and the pointer
					// stays a fixed distance behind the newest input. The band keeps a normal block
					// boundary from re-anchoring (which would break grain-to-grain continuity and click);
					// it only snaps on startup, a ratio change, or after a dropped block.
					const lag = s.writePos - s.readPos;
					if (!s.anchored || lag < need || lag > need + GRAIN) {
						s.readPos = s.writePos - need;
						s.anchored = true;
					}

					// SOLA: pick the read offset whose content best CONTINUES what is already in the
					// output accumulator. Fixing the pointer drift alone still left tonal material
					// comb-filtering itself: at the same output instant, grain g and grain g+1 come from
					// input positions SYNTH_HOP * (1 - ratio) apart, so for a steady tone they can arrive
					// in antiphase and cancel. Measured on a 1-unit sine, output RMS swung between 0.055
					// and 0.695 purely on frequency and ratio — some notes of a song would have nearly
					// vanished while others played at full level, and which ones would change with the
					// key. Correlating against the existing overlap and shifting the read by up to
					// +/-SEARCH removes that: the grain is placed where it reinforces instead of cancels.
					// Coarse-then-fine so the search costs ~80 offsets rather than 2*SEARCH+1.
					let best = 0;
					if (s.outHead > GRAIN) {
						best = this.align(s, CORR_STEP);
						best = this.align(s, 1, best);
					}
					const base = s.readPos + best;

					for (let k = 0; k < GRAIN; k++) {
						const rp = base + k * this.ratio;      // resample: this is where the pitch changes
						const idx = Math.floor(rp);
						const frac = rp - idx;
						const a = this.histSample(s, idx);
						const b = this.histSample(s, idx + 1);
						const v = (a * (1 - frac) + b * frac) * WINDOW[k];
						const oi = (s.outHead + k) % s.outAcc.length;
						s.outAcc[oi] += v;
						s.outNorm[oi] += WINDOW[k];
					}
					// Advance from the CHOSEN base, so the alignment offset is absorbed rather than
					// re-applied every grain; the anchor band above bounds the resulting drift.
					s.readPos = base + SYNTH_HOP;              // analysis hop == synthesis hop
					s.sinceGrain += SYNTH_HOP;
				}
				// Emit one normalised output sample.
				const oi = s.outHead % s.outAcc.length;
				const norm = s.outNorm[oi];
				out[i] = norm > 1e-6 ? s.outAcc[oi] / norm : 0;
				s.outAcc[oi] = 0;
				s.outNorm[oi] = 0;
				s.outHead++;
				s.sinceGrain--;
			}
		}
		return true;
	}

	// Best read offset in [-SEARCH, +SEARCH] by normalised cross-correlation between what the candidate
	// grain would contribute and what the output accumulator already holds over the overlap region.
	// \`stride\` walks the candidates; \`around\` narrows a second pass to +/-stride*? of a coarse winner.
	// Normalised (divided by the candidate's energy) so a loud candidate cannot win on level alone.
	align(s, stride, around) {
		const lo = around === undefined ? -SEARCH : Math.max(-SEARCH, around - CORR_STEP);
		const hi = around === undefined ? SEARCH : Math.min(SEARCH, around + CORR_STEP);
		let bestOff = around === undefined ? 0 : around;
		let bestScore = -Infinity;
		for (let off = lo; off <= hi; off += stride) {
			let dot = 0;
			let energy = 0;
			for (let k = 0; k < CORR_LEN; k += 2) {   // every other sample: same winner, half the work
				const oi = (s.outHead + k) % s.outAcc.length;
				const n = s.outNorm[oi];
				if (n <= 1e-6) continue;
				const have = s.outAcc[oi] / n;
				const rp = s.readPos + off + k * this.ratio;
				const idx = Math.floor(rp);
				const frac = rp - idx;
				const cand =
					this.histSample(s, idx) * (1 - frac) + this.histSample(s, idx + 1) * frac;
				dot += have * cand;
				energy += cand * cand;
			}
			const score = energy > 1e-9 ? dot / Math.sqrt(energy) : 0;
			if (score > bestScore) {
				bestScore = score;
				bestOff = off;
			}
		}
		return bestOff;
	}

	// Read a sample from the input history by ABSOLUTE input index, mapped into the ring. Out-of-range
	// reads return 0 rather than a wrapped neighbour: a wrapped read is unrelated audio, which is the
	// aliasing the old free-running pointer produced. With the anchor above these bounds are not
	// reached in steady state; they remain as the startup and dropped-block guard.
	histSample(s, absIdx) {
		if (absIdx < 0) return 0;
		if (absIdx >= s.writePos) return 0;
		if (absIdx < s.writePos - HIST) return 0;
		return s.hist[absIdx % HIST];
	}
}

registerProcessor('encore-pitch-shift', PitchShiftProcessor);
`;

// ── the graph controller (DOM/WebAudio; not unit-tested — needs real audio hardware) ──────────────

/**
 * Wraps ONE HTMLMediaElement in a lazily-built pitch-shift graph.
 *
 * Lifecycle mirrors the trap documented at the top of this file:
 *   setShift(shift): the SOLE entry point, and idempotent. It is also what builds the graph: the
 *     FIRST non-zero shift lazily builds the AudioContext + MediaElementSource + worklet ONCE (in
 *     the private build()), resumes the context, and either applies the ratio (resume succeeded) or
 *     falls back to unshifted playback (resume failed). Later calls just change the ratio on the
 *     already-built graph. At shift 0 with no graph yet it is a no-op — nothing is built. Returning
 *     to 0 on a built graph sets ratio 1 (bypass) rather than tearing anything down — see below.
 *   detach(): best-effort disconnect on element teardown. It CANNOT restore the pre-WebAudio path
 *     (a MediaElementSource is permanent) but at ratio 1 the graph is already transparent, so this is
 *     only about releasing the AudioContext when the element goes away.
 */
export class PitchShiftGraph {
	private el: HTMLMediaElement;
	private ctx: AudioContext | null = null;
	private source: MediaElementAudioSourceNode | null = null;
	private node: AudioWorkletNode | null = null;
	private gain: GainNode | null = null;
	private moduleUrl: string | null = null;
	private ratio = 1;
	/**
	 * The output level to apply IN THE GRAPH. This exists because `HTMLMediaElement.volume` is BYPASSED
	 * once the element is captured by a MediaElementAudioSourceNode — so the guide's volume knob, which
	 * works fine on the native path, silently stops working the moment we route it for a shift. The
	 * caller mirrors the element's intended volume here via setGain(), and a GainNode applies it.
	 * Defaults to 1 (master instrumental never attenuates).
	 */
	private desiredGain = 1;
	/** True once we have attached a MediaElementSource — from here the element only outputs via the graph. */
	private routed = false;
	/** True if we tried to build the graph and could not resume — we are in audible-fallback mode. */
	private degraded = false;
	/**
	 * The single in-flight build() promise, or null when no build is running. Memoised so two
	 * setShift(non-zero) calls landing inside the async window before `routed` flips (e.g. two
	 * `playback:state` broadcasts ~10ms apart from a guest double-tapping ±key) SHARE one build
	 * rather than each opening its own AudioContext and each calling the irreversible
	 * createMediaElementSource on the same element — the second of which throws, is swallowed, and
	 * strands a second context. Cleared once the build settles so a FINISHED failed attempt is still
	 * retryable (the degraded-retry property).
	 */
	#building: Promise<void> | null = null;

	constructor(el: HTMLMediaElement) {
		this.el = el;
	}

	/** Build (if needed) and apply the given shift. Safe to call repeatedly with the same value. */
	async setShift(shift: number): Promise<void> {
		const ratio = semitonesToRatio(shift);
		this.ratio = ratio;
		if (!this.routed) {
			// No graph yet. At ratio 1 keep it that way — the whole point is not to touch the audio path
			// until a real shift is asked for.
			if (ratio === 1) return;
			await this.build();
		}
		// Graph exists (or we just tried to build it). Push the ratio; if we degraded, ratio is moot.
		if (this.node) {
			this.node.port.postMessage({ ratio });
		}
	}

	/**
	 * Build the graph if it is not built yet, coalescing concurrent callers onto ONE attempt.
	 * Returns the shared in-flight promise while a build runs; starts a fresh one otherwise. The
	 * promise is cleared when it settles, so a build that failed (degraded, no gesture yet) can be
	 * retried on the next non-zero shift — #buildOnce keeps the createMediaElementSource behind the
	 * confirmed running-context check, so a retry never double-captures the element.
	 */
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
		// Once the element is routed there is nothing to rebuild — the MediaElementSource is permanent.
		// `degraded`, however, records only that the LAST attempt could not run a context (no gesture
		// yet); it must NOT be terminal, or the instrumental never shifts again after the first pre-
		// gesture press. Clear it here and retry: the irreversible createMediaElementSource stays
		// behind the confirmed `state === 'running'` check below, so a retry that fails again simply
		// closes its context and re-arms `degraded`, leaving the element audible on its native output.
		if (this.routed) return;
		this.degraded = false;
		try {
			const Ctor: typeof AudioContext =
				(window as unknown as { AudioContext: typeof AudioContext }).AudioContext ??
				(window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
			if (!Ctor) {
				this.degraded = true;
				return;
			}
			this.ctx = new Ctor();
			// A context created without a user gesture is `suspended`. Try to resume; on the TV wall the
			// gesture may never come, so resume() can reject or stay suspended.
			await this.ctx.resume().catch(() => {});
			if (this.ctx.state !== 'running') {
				// Cannot run the graph. CRITICAL: do NOT create the MediaElementSource — creating it would
				// permanently steal the element's audio into a dead (suspended) graph = total silence.
				// Leave the element on its native output (audible, unshifted) and remember we degraded.
				await this.ctx.close().catch(() => {});
				this.ctx = null;
				this.degraded = true;
				return;
			}
			const blob = new Blob([PITCH_WORKLET_SOURCE], { type: 'application/javascript' });
			this.moduleUrl = URL.createObjectURL(blob);
			await this.ctx.audioWorklet.addModule(this.moduleUrl);
			// Only NOW, with a running context and a loaded module, do we commit the element to the graph.
			this.source = this.ctx.createMediaElementSource(this.el);
			this.node = new AudioWorkletNode(this.ctx, 'encore-pitch-shift');
			this.gain = this.ctx.createGain();
			this.gain.gain.value = this.desiredGain;
			// source -> shifter -> gain -> speakers. The gain stage is what re-implements the guide's volume
			// knob once the element property is bypassed by the source capture.
			this.source.connect(this.node).connect(this.gain).connect(this.ctx.destination);
			this.routed = true;
			this.node.port.postMessage({ ratio: this.ratio });
		} catch {
			// Any failure (addModule rejected, source creation threw) -> leave audible on the native path
			// if we had not yet routed. If we HAD routed, the element is committed to the graph at
			// whatever ratio was last set; ratio defaults to 1 so it is still audible.
			if (!this.routed) {
				await this.ctx?.close().catch(() => {});
				this.ctx = null;
				this.degraded = true;
			}
		}
	}

	/** True once audio is flowing through WebAudio (a real shift has been engaged at least once). */
	get isRouted(): boolean {
		return this.routed;
	}

	/**
	 * Set the graph's output level, mirroring the element's intended `volume`. A no-op-ish call when not
	 * routed (the element property still governs volume), but the caller can set it unconditionally: it
	 * is remembered in `desiredGain` and applied the moment the graph is built. `volume` is bypassed by
	 * the source capture, so THIS is the only volume control once routed.
	 */
	setGain(level: number): void {
		const g = Math.max(0, Math.min(1, level));
		this.desiredGain = g;
		if (this.gain) this.gain.gain.value = g;
	}

	/** True if we tried and could not run a context — playback is audible but unshifted. */
	get isDegraded(): boolean {
		return this.degraded;
	}

	/**
	 * Release the context when the element is torn down. This does NOT — cannot — restore the element's
	 * original native audio output: a MediaElementAudioSourceNode is a permanent capture. It only frees
	 * the AudioContext and revokes the blob URL. In practice the element is being destroyed too (slot
	 * unmount), so the permanence is irrelevant; if it is ever reused, its audio is gone until the page
	 * reloads, which is why callers only ever attach a graph to an element that lives as long as the graph.
	 */
	detach(): void {
		try {
			this.node?.disconnect();
			this.source?.disconnect();
			this.gain?.disconnect();
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
		// routed stays true: the element is still (permanently) captured. Do not pretend otherwise.
	}
}
