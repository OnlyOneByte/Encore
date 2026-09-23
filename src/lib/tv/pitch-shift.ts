// Browser-side pitch shifter for the TV stage — changes PITCH without changing TEMPO.
//
// WHY IT EXISTS. The phone's ±semitone buttons store `PlaybackState.keyShift`, and the TV used to honour it by
// loading a pre-rendered per-key FILE. Nothing ever produced those files, so honouring the shift 404'd mid-song and
// the TV was forced to ignore it. Rendering per-key variants server-side was rejected (N files per song, a worker
// stage nobody built); shifting in the browser needs zero files and works on every already-processed song.
//
// WHY HAND-WRITTEN. soundtouchjs is LGPL and rubberband GPL/commercial, both unacceptable here — so the algorithm
// is written out: a time-domain overlap-add shifter that resamples by the pitch ratio (which alone would change
// tempo) and time-stretches by the inverse through overlapping Hann-windowed grains. SOLA/PSOLA family without
// pitch-synchronous grain placement: cheap, real-time-safe in an AudioWorklet, good enough for a backing track
// under a live vocal. Not studio-grade — transients smear slightly, which is the accepted trade.
//
// THE BIG TRAP. TvPlayer has no AudioContext: plain elements play through the platform mixer. A context created in
// a page that never received a gesture starts `suspended`, and a TV wall may NEVER be clicked — and a
// MediaElementAudioSourceNode, once created for an element, CANNOT be detached, so from that point the element's
// audio reaches the speakers ONLY through the graph. A naive "always wrap the element" design therefore risks
// killing ALL room audio, not just the shift.
//
// The contract that keeps it safe (enforced by PitchShiftGraph and its callers):
//   • keyShift === 0  → do NOTHING. No context, no source node; the audio path is byte-for-byte the plain element.
//     This is the overwhelmingly common case and must never regress.
//   • first non-zero shift → build the graph LAZILY, and only after resume() actually succeeds.
//   • cannot resume → FALL BACK to unshifted AUDIBLE playback through the element's own output. Never silence.
//   • return to 0 → the element cannot be un-sourced, so set the ratio to 1.0 (a pass-through) and leave the graph
//     in place; at ratio 1 that is audibly identical to the bypass path.

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
		// THE TIMELINE IS SHARED ACROSS CHANNELS, and that is the whole point of this node for the guide
		// mix. The four channels of a mix (0/1 instrumental, 2/3 vocals) come from ONE file and must stay
		// sample-locked, so there is exactly ONE read pointer, ONE write head, ONE grain schedule. When
		// each channel kept its own \`readPos\` and ran its own SOLA search, the search picked a DIFFERENT
		// offset per channel (up to +/-SEARCH = 256 samples ~= 5 ms at 48 kHz apart, wandering as the song
		// played), so the guiding vocals drifted from the instrumental at every non-zero shift and nothing
		// downstream could see it — the single-playhead guarantee the mix is built on was reintroduced as
		// drift right here. One timeline makes that drift inexpressible.
		this.readPos = 0;      // fractional read pointer on the continuous input timeline (all channels)
		this.writePos = 0;     // absolute input samples written so far (all channels advance 1:1)
		this.anchored = false; // has readPos been tied to writePos yet?
		this.outHead = 0;      // how many finished output samples are queued in each channel's outAcc
		this.sinceGrain = 0;   // output samples emitted since the last grain was laid down
		// Per-channel state holds only CONTENT — the input history ring and the output accumulator. These
		// are what must NOT be shared: sharing them is the cross-talk failure (the guide pair carrying the
		// instrumental's audio). Grown lazily to the channel count we actually see.
		this.chan = [];
		this.port.onmessage = (e) => {
			if (e.data && typeof e.data.ratio === 'number' && isFinite(e.data.ratio)) {
				const r = e.data.ratio <= 0 ? 1 : Math.min(e.data.ratio, MAX_RATIO);
				if (r !== this.ratio) {
					this.ratio = r;
					// The required lag depends on the ratio, so a change invalidates the current anchor.
					// Re-anchor on the next grain rather than reading past the write head for one grain.
					this.anchored = false;
				}
			}
		};
	}

	ensure(ch) {
		while (this.chan.length < ch) {
			this.chan.push({
				hist: new Float32Array(HIST),
				// output accumulator + its normalisation (sum of WINDOW, not WINDOW^2: with SOLA the grains
				// reinforce, so dividing by sum(w) is unity gain. sum(w^2) is the incoherent-overlap form and
				// over-shot by sum(w)/sum(w^2) = 2.0/1.5 = 1.33x, which would clip loud material.
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

		// Push this block's input into every channel's history ring, advancing the ONE shared write
		// head. A missing input channel is treated as silence rather than dropping the block (which
		// would click) — this is what lets a stereo file up-mixed to quad render [L, R, 0, 0].
		for (let i = 0; i < frames; i++) {
			const abs = this.writePos % HIST;
			for (let c = 0; c < channels; c++) {
				const inCh = input && input[c] ? input[c] : null;
				this.chan[c].hist[abs] = inCh ? inCh[i] : 0;
			}
			this.writePos++;
		}

		// Fast path: at ratio 1 copy straight through, per channel. Bit-exact bypass, so "return to
		// key 0" is audibly identical to the pre-WebAudio path even though the element stays sourced.
		if (this.ratio === 1) {
			for (let c = 0; c < channels; c++) {
				const inCh = input && input[c] ? input[c] : null;
				if (inCh) output[c].set(inCh);
				else output[c].fill(0);
			}
			this.anchored = false; // a later shift must re-anchor rather than resume a stale pointer
			return true;
		}

		// The lag the read pointer must keep behind the write head: the grain's whole resampled
		// span, the alignment search range, plus one hop of slack.
		const lookahead = Math.ceil(GRAIN * this.ratio);
		const need = lookahead + SEARCH + SYNTH_HOP;

		for (let i = 0; i < frames; i++) {
			// Lay down a new grain every SYNTH_HOP output samples — ON EVERY CHANNEL AT ONCE, from the
			// SAME read position, so the four channels of a mix cannot pick different offsets and drift.
			if (this.sinceGrain <= 0) {
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
				const lag = this.writePos - this.readPos;
				if (!this.anchored || lag < need || lag > need + GRAIN) {
					this.readPos = this.writePos - need;
					this.anchored = true;
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
				//
				// ONE OFFSET FOR ALL CHANNELS. The correlation is SUMMED across every channel (see
				// \`align\`), so the chosen offset is the one that best reinforces the mix as a whole and
				// is then applied identically to each channel's grain. A per-channel search would let
				// the guide pair and the instrumental pair land on different read points — the exact
				// inter-channel drift this node exists to prevent. Aligning on the aggregate keeps them
				// sample-locked at the cost of not phase-optimising each pair independently, which is the
				// right trade: a mix's four channels ARE one performance and must move together.
				let best = 0;
				if (this.outHead > GRAIN) {
					best = this.align(channels, CORR_STEP);
					best = this.align(channels, 1, best);
				}
				const base = this.readPos + best;

				// Lay the grain on every channel from the SAME base. Resample geometry (idx, frac, window)
				// is channel-independent, so compute it once per k and reuse it across channels — that is
				// what keeps the four channels reading identical input positions, i.e. sample-locked.
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
				// Advance from the CHOSEN base, so the alignment offset is absorbed rather than
				// re-applied every grain; the anchor band above bounds the resulting drift.
				this.readPos = base + SYNTH_HOP;              // analysis hop == synthesis hop
				this.sinceGrain += SYNTH_HOP;
			}
			// Emit one normalised output sample per channel from the shared output head.
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

	// Best read offset in [-SEARCH, +SEARCH] by normalised cross-correlation between what the candidate
	// grain would contribute and what the output accumulator already holds over the overlap region.
	// \`stride\` walks the candidates; \`around\` narrows a second pass to +/-CORR_STEP of a coarse winner.
	// Normalised (divided by the candidate's energy) so a loud candidate cannot win on level alone.
	//
	// SUMMED ACROSS ALL CHANNELS against the SHARED read pointer, so the winner is one offset that
	// reinforces the whole mix and is applied to every channel identically. A per-channel search is what
	// let the guide vocals drift from the instrumental; correlating the aggregate keeps them locked.
	align(channels, stride, around) {
		const lo = around === undefined ? -SEARCH : Math.max(-SEARCH, around - CORR_STEP);
		const hi = around === undefined ? SEARCH : Math.min(SEARCH, around + CORR_STEP);
		let bestOff = around === undefined ? 0 : around;
		let bestScore = -Infinity;
		// Hoist the per-channel typed arrays into locals ONCE. Indexing \`this.chan[c].outAcc\` inside the
		// innermost correlation loop is a property chain the JIT cannot keep monomorphic, and it made the
		// summed search ~10x slower than the per-channel one it replaced — enough to matter in a worklet
		// that must finish inside one render quantum. With the refs local the summed search costs the same
		// per candidate as the old single-channel one did.
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
				// Inline the two ring reads once — they are shared across channels only in index math, but
				// the sample fetch is per channel. Out-of-range reads return 0 (see histSample).
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
	/**
	 * SPLIT MODE — this element carries a 4-channel GUIDE MIX rather than a plain stereo instrumental,
	 * so the output stage pulls the two pairs apart and gives each its own gain (channels 0/1 the
	 * instrumental, 2/3 the vocals).
	 *
	 * It lives in THIS class rather than a sibling one for a hard reason, not for convenience: a
	 * `MediaElementAudioSourceNode` is a permanent, ONE-PER-ELEMENT capture, so the pitch shifter and the
	 * channel splitter cannot each own a graph over the same element — the second `createMediaElementSource`
	 * throws. One element, one graph.
	 *
	 * The worklet needs no change to serve it: `process()` already loops over `output.length` with
	 * per-channel state (`ensure(output.length)`), and at ratio 1 it is a bit-exact passthrough. So the
	 * SAME node shifts all four channels by the same ratio — which is what we want, because both pairs
	 * are the same recording and a transpose must move them together.
	 */
	private split: boolean;
	private splitter: ChannelSplitterNode | null = null;
	/** Re-merged stereo pairs, kept so `detach` can disconnect them. */
	private mergers: ChannelMergerNode[] = [];
	/** The vocals pair's own level — the guiding-track knob, in split mode. */
	private guideGain: GainNode | null = null;
	/**
	 * The guide pair's level. DEFAULTS TO 0, unlike `desiredGain`, and that asymmetry is deliberate.
	 *
	 * There is precedent: a freshly built graph defaulted its gain to 1, the level effect did not re-run
	 * on construction, and the isolated vocals played at FULL VOLUME under the instrumental for the rest of
	 * the song. Here the stakes are higher — in split mode the vocals are inside the file the room is
	 * playing, so there is no native path that happens to be quiet. Defaulting to silence means the worst
	 * case of a missed `setGuideGain` is a guide nobody hears, never a guide that drowns the singer.
	 */
	private desiredGuideGain = 0;
	/** True once we have attached a MediaElementSource — from here the element only outputs via the graph. */
	private routed = false;
	/** True if we tried to build the graph and could not resume — we are in audible-fallback mode. */
	private degraded = false;
	/**
	 * Can this graph change PITCH at all?
	 *
	 * False when the engine gives us no `AudioWorklet` — which on a correctly-built browser means the page
	 * is not in a secure context, i.e. served over plain HTTP on anything but the `localhost` family. That
	 * is Encore's documented TV deployment (`http://<LAN-IP>:3000/tv`), so this is the NORMAL state there,
	 * not an exotic one.
	 *
	 * Kept separate from `degraded`, which means "no graph at all, element on its native output". A graph
	 * with `canShift === false` is fully built and doing real work: it still splits the guide mix and still
	 * owns both gain stages. Only ±key is unavailable. Callers that conflate the two would either hide a
	 * working guiding track or advertise a transpose that cannot happen.
	 */
	private canShift = true;
	/**
	 * The single in-flight build() promise, or null when no build is running. Memoised so two
	 * setShift(non-zero) calls landing inside the async window before `routed` flips (e.g. two
	 * `playback:state` broadcasts ~10ms apart from a guest double-tapping ±key) SHARE one build
	 * rather than each opening its own AudioContext and each calling the irreversible
	 * createMediaElementSource on the same element — the second of which throws, is swallowed, and
	 * strands a second context. Cleared once the build settles so a FINISHED failed attempt is still
	 * retryable (the an earlier change degraded-retry property).
	 */
	#building: Promise<void> | null = null;
	/**
	 * True once `createMediaElementSource` has run. Distinct from `routed`, which also means "the graph is
	 * wired": between the capture and the last connect there is a window where the element is committed but
	 * the graph is not finished, and the `catch` needs to tell those apart — closing the context after a
	 * capture is what silences the element permanently.
	 */
	#captured = false;
	/**
	 * Set by `detach()`. Checked after every `await` in `#buildOnce` so a build still in flight when the
	 * element is torn down closes its own context instead of routing an orphan nothing holds — the
	 * released-context leak class, which the eager split build reopened without any keyShift involved.
	 */
	#disposed = false;

	/**
	 * The worklet node, with split mode's 4-channel pin and a fallback if the engine refuses it.
	 *
	 * In split mode the node is PINNED to 4 channels: left to negotiate, a worklet whose input has not been
	 * measured yet can settle on stereo and silently drop the guide pair. But `outputChannelCount` is a
	 * documented NotSupportedError candidate on engines that cap worklet output channels, and a throw here
	 * would take the whole graph down — so a refusal DEGRADES to a default node and clears `split`. With
	 * `split` false the caller's `isSplit` gate withholds the mix src, so the room plays the plain
	 * instrumental with no guide rather than a 4-channel file through a stereo graph.
	 */
	private makeWorkletNode(ctx: AudioContext): AudioWorkletNode {
		if (!this.split) return new AudioWorkletNode(ctx, 'encore-pitch-shift');
		try {
			return new AudioWorkletNode(ctx, 'encore-pitch-shift', {
				channelCount: 4,
				channelCountMode: 'explicit',
				outputChannelCount: [4]
			});
		} catch {
			// The engine will not give us four channels. Fall back to a plain node and stop claiming to be
			// a split graph, so nothing promotes a 4-channel src into it.
			this.split = false;
			return new AudioWorkletNode(ctx, 'encore-pitch-shift');
		}
	}

	constructor(el: HTMLMediaElement, opts: { split?: boolean } = {}) {
		this.el = el;
		this.split = opts.split === true;
	}

	/**
	 * Build the graph NOW, without waiting for a transpose to ask for one — the entry point split mode
	 * needs and the plain path must never use.
	 *
	 * `setShift` deliberately refuses to build at ratio 1, so that a song at keyShift 0 touches no
	 * WebAudio at all and a broken graph can never cost the room its audio. That is the right default and
	 * it stays. But a guide mix INVERTS the tradeoff: its guiding track does not exist until the splitter
	 * runs, so the graph has to be attempted up front.
	 *
	 * Resolving does NOT mean success — read `isRouted` afterwards. A suspended context (no gesture on the
	 * TV wall) leaves us degraded with the element on its native output, which is why the caller must keep
	 * the plain instrumental src until this reports routed. See `guide-mix-src.ts` for that rule and what
	 * happens if it is broken.
	 */
	async ensureRouted(): Promise<void> {
		if (this.routed) return;
		await this.build();
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
			// The element may have been torn down while we awaited. Bail before the capture rather than
			// routing a graph nothing holds: the caller has already dropped its reference.
			if (this.#disposed) {
				await this.ctx.close().catch(() => {});
				this.ctx = null;
				return;
			}
			if (this.ctx.state !== 'running') {
				// Cannot run the graph. CRITICAL: do NOT create the MediaElementSource — creating it would
				// permanently steal the element's audio into a dead (suspended) graph = total silence.
				// Leave the element on its native output (audible, unshifted) and remember we degraded.
				await this.ctx.close().catch(() => {});
				this.ctx = null;
				this.degraded = true;
				return;
			}
			// THE WORKLET IS OPTIONAL, AND THAT IS THE POINT OF THIS BRANCH. `AudioWorklet` is a
			// secure-context-only API: browsers expose it on `https://` and the `localhost` family and
			// NOWHERE else. Encore's documented deployment serves the TV at `http://<LAN-IP>:3000/tv`, which
			// is not a secure context, so `ctx.audioWorklet` is `undefined` there. This whole build used to
			// dereference it unconditionally, so the throw took the ENTIRE graph down — including the channel
			// splitter, which needs no worklet at all. The room then lost the guiding track as well as ±key,
			// with nothing logged on any surface.
			//
			// So a missing (or refusing) worklet now clears `canShift` and the build CONTINUES. Pitch
			// shifting is genuinely impossible without it; splitting four channels into two gain stages is
			// ordinary Web Audio and works fine on an insecure origin.
			if (this.ctx.audioWorklet) {
				const blob = new Blob([PITCH_WORKLET_SOURCE], { type: 'application/javascript' });
				this.moduleUrl = URL.createObjectURL(blob);
				try {
					await this.ctx.audioWorklet.addModule(this.moduleUrl);
				} catch {
					// The module itself would not load. Same outcome as an absent worklet: no shifting, but
					// everything downstream of the source can still be built.
					this.canShift = false;
				}
			} else {
				this.canShift = false;
			}
			// Same disposal check on the other side of the other await — this is the window the eager split
			// build actually lands in, because it starts at mount and `addModule` is the slow step.
			if (this.#disposed) {
				await this.ctx.close().catch(() => {});
				this.ctx = null;
				return;
			}

			// NOTHING TO BUILD, AND THE CAPTURE MUST NOT HAPPEN. Without a worklet a non-split song has no
			// reason to exist as a graph: the only thing the graph would add is the shifter it cannot have.
			// Capturing anyway is actively harmful — `createMediaElementSource` is irreversible and bypasses
			// the element's own `volume`, so it would take over the audio path to deliver nothing. A split
			// song is the opposite case: its guiding track does not exist until the splitter runs.
			if (!this.canShift && !this.split) {
				await this.ctx.close().catch(() => {});
				this.ctx = null;
				return;
			}

			// BUILD EVERY NODE BEFORE THE CAPTURE. `createMediaElementSource` is irreversible, so any
			// construction that can throw MUST happen before it — otherwise a throw leaves the element
			// permanently captured by a source node whose context this `catch` then CLOSES, and that
			// element's audio reaches nothing for the life of the page. That is the "killing all room
			// audio" outcome this module exists to prevent, and split mode introduced a real throw
			// candidate: `outputChannelCount: [4]` is rejected with NotSupportedError by engines that cap
			// worklet output channels. Before split mode the only post-capture construction was a bare
			// AudioWorkletNode, which cannot realistically throw once `addModule` has resolved — so the
			// ordering was safe by luck rather than by design. It is now safe by design.
			this.node = this.canShift ? this.makeWorkletNode(this.ctx) : null;
			this.gain = this.ctx.createGain();
			this.gain.gain.value = this.desiredGain;
			if (this.split) {
				// SPLIT OUTPUT STAGE. source -> [shifter] -> splitter(4) -> [pair -> merger -> gain] -> speakers.
				//
				// The shifter is in brackets because it is optional (see the worklet branch above): with no
				// worklet the splitter hangs directly off the source instead, and everything from the splitter
				// onward is identical. That is what lets the guiding track work on an insecure origin.
				//
				// Each pair is re-MERGED to stereo before its gain, which is the part that is easy to get
				// wrong: connecting splitter outputs 0 and 1 into one GainNode SUMS them, collapsing the
				// instrumental to mono. A ChannelMerger keeps left as left.
				//
				// WHICH MERGER FEEDS WHICH GAIN IS HALF THE CONTRACT. Exchanging them puts the instrumental
				// on `guideGain` (which defaults to 0) and the isolated vocals on `gain` (which defaults to
				// 1) — the room then hears full-volume vocals with no backing track. The splitter indices
				// alone do not pin this; `guide-mix-graph.test.ts` asserts the whole chain per pair.
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
				// Whatever level the room had set BEFORE the graph existed, applied at construction. This is
				// the full-volume-vocals fix made structural: the level effect does not re-run when a graph is built, so a
				// graph that did not read the remembered value here would play the vocals at its own default.
				this.guideGain.gain.value = this.desiredGuideGain;
				guideMerger.connect(this.guideGain).connect(this.ctx.destination);
				this.mergers = [instMerger, guideMerger];
			} else {
				// source -> shifter -> gain -> speakers. The gain stage is what re-implements the guide's volume
				// knob once the element property is bypassed by the source capture. Reached only WITH a shifter:
				// the no-worklet non-split case returned above rather than capturing for nothing.
				this.node?.connect(this.gain).connect(this.ctx.destination);
			}

			// LAST: commit the element. Everything downstream of it already exists and is wired to the
			// destination, so from here there is nothing left that can throw and strand a captured element.
			this.source = this.ctx.createMediaElementSource(this.el);
			this.#captured = true;
			// The source feeds the shifter when there is one, and the splitter directly when there is not.
			// `this.splitter` is non-null whenever `split` survived the build, and the no-worklet non-split
			// case returned before the capture, so the fallback is never null in practice — the `??` chain is
			// spelled out so a future fourth case cannot connect the source to nothing.
			this.source.connect(this.node ?? this.splitter ?? this.gain);
			this.routed = true;
			this.node?.port.postMessage({ ratio: this.ratio });
		} catch {
			// A throw before the capture: close the context and leave the element on its native output
			// (audible, unshifted). `degraded` is not terminal, so a later attempt can retry.
			//
			// A throw AFTER the capture must NOT close the context — that is what would silence the element
			// forever. Belt and braces for a case the reordering above should make unreachable: reconnect
			// the captured source straight to the destination so the room still hears the song, and keep the
			// context alive to carry it.
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

	/**
	 * Set the GUIDE pair's level — the guiding-track knob, in split mode only.
	 *
	 * Deliberately a separate method from `setGain` rather than an extra argument: on a non-split graph
	 * there is no guide pair to address, and a single setter taking two levels would let a caller believe
	 * it had set a guide level on an element that has no guide in it. Calling this on a non-split graph is
	 * remembered and simply never applied, which is the same shape `setGain` already has for the
	 * not-yet-built case.
	 */
	setGuideGain(level: number): void {
		const g = Math.max(0, Math.min(1, level));
		this.desiredGuideGain = g;
		if (this.guideGain) this.guideGain.gain.value = g;
	}

	/** True when this graph pulls a 4-channel mix apart — i.e. the guide rides inside the master element. */
	get isSplit(): boolean {
		return this.split;
	}

	/**
	 * True when ±key can actually change the pitch.
	 *
	 * False on a page with no `AudioWorklet` — in practice, a non-secure origin. The guide is unaffected
	 * (see `canShift`), so this is the ONE thing a caller should read before offering a transpose control:
	 * a UI that shows `Key · +2` while this is false is telling the room something untrue, which is the
	 * failure this getter exists to make visible rather than silent.
	 */
	get isShiftable(): boolean {
		return this.canShift;
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
		// Tell an in-flight build to abandon itself rather than route an orphan whose context nothing would
		// ever close. Set BEFORE the disconnects so a build resuming from an await in the same tick sees it.
		this.#disposed = true;
		try {
			this.node?.disconnect();
			this.source?.disconnect();
			this.gain?.disconnect();
			// The split stage's nodes too. Omitting them would leave the splitter and both mergers holding
			// references into a closed context — the same leak already closed for the master graph.
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
