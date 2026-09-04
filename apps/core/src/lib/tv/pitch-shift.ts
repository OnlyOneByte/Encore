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
// See PitchShiftGraph.attach / detach for the concrete teardown strategy.

// ── pure ratio + framing maths (unit-tested; no DOM, no AudioContext) ─────────────────────────────

/** Frames per octave in equal temperament. 12 semitones == one octave == a 2× frequency ratio. */
export const SEMITONES_PER_OCTAVE = 12;

/**
 * Playback-speed ratio for a semitone shift. +12 -> 2.0 (up an octave), -12 -> 0.5 (down an octave),
 * 0 -> exactly 1.0. This is the factor the resampler reads the input at; the time-stretch stage undoes
 * the tempo change it would otherwise cause.
 *
 * Returns exactly 1 at 0 so the caller's "ratio === 1 means bypass" check is bit-exact, never a
 * 0.9999999 that would keep the graph doing needless work.
 */
export function semitonesToRatio(semitones: number): number {
	if (!Number.isFinite(semitones) || semitones === 0) return 1;
	return Math.pow(2, semitones / SEMITONES_PER_OCTAVE);
}

/** Is this shift audible, i.e. does it need the graph at all? Exactly 0 (or non-finite) -> no. */
export function needsShift(semitones: number): boolean {
	return semitonesToRatio(semitones) !== 1;
}

/**
 * A periodic Hann window of length `n`. Periodic (denominator `n`, not `n-1`) is the correct form for
 * overlap-add: with 50%+ overlap the squared windows sum to a constant, so no amplitude ripple is
 * introduced across grain boundaries. Returns a fresh Float32Array; callers cache it.
 */
export function hannWindow(n: number): Float32Array {
	const w = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
	}
	return w;
}

/**
 * The synthesis hop (output stride between grains) for a given analysis grain size and overlap.
 * With `overlap` of 4 and a 1024 grain the hop is 256 — i.e. 75% overlap. The analysis hop is this
 * scaled by the pitch ratio, which is what accomplishes the time-stretch that cancels the resample's
 * tempo change.
 */
export function synthesisHop(grainSize: number, overlap: number): number {
	return Math.max(1, Math.floor(grainSize / overlap));
}

/**
 * The analysis hop: how far to advance the READ pointer per grain so that after resampling by
 * `ratio` the tempo is preserved. analysisHop = synthesisHop × ratio. Reading faster (ratio > 1,
 * pitch up) consumes more input per output grain, so more grains overlap onto the same output span —
 * which stretches time back to normal after the pitch has been raised.
 */
export function analysisHop(synthesisHopSamples: number, ratio: number): number {
	return synthesisHopSamples * ratio;
}

/** Linear-interpolated sample read at a fractional index into `buf`; 0 outside the buffer. */
export function sampleAt(buf: Float32Array, pos: number): number {
	if (pos <= 0) return buf.length ? buf[0] : 0;
	const i = Math.floor(pos);
	if (i >= buf.length - 1) return buf.length ? buf[buf.length - 1] : 0;
	const frac = pos - i;
	return buf[i] * (1 - frac) + buf[i + 1] * frac;
}

// ── the AudioWorklet processor, as a self-contained source string ─────────────────────────────────
//
// A worklet runs in a SEPARATE global scope (AudioWorkletGlobalScope) and CANNOT import app modules,
// so the OLA loop is written out in full here rather than importing the helpers above. The maths is
// the same as the exported functions — kept deliberately simple so the two stay legible side by side.
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
				this.ratio = e.data.ratio <= 0 ? 1 : e.data.ratio;
			}
		};
	}

	ensure(ch) {
		while (this.chan.length < ch) {
			this.chan.push({
				// input history ring, long enough to look back one full grain at the fastest read rate
				hist: new Float32Array(GRAIN * 4),
				histFill: 0,
				readPos: 0,      // fractional read pointer into the continuous input timeline
				writePos: 0,     // absolute input samples written so far
				// output accumulator + its normalisation (sum of squared windows) for the block edge
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
				s.hist[s.histFill % s.hist.length] = inCh ? inCh[i] : 0;
				s.histFill++;
				s.writePos++;
			}

			// Fast path: at ratio 1 copy straight through. Bit-exact bypass, so "return to key 0" is
			// audibly identical to the pre-WebAudio path even though the element stays sourced.
			if (this.ratio === 1) {
				if (inCh) out.set(inCh);
				else out.fill(0);
				continue;
			}

			// OLA synthesis for this output block.
			for (let i = 0; i < frames; i++) {
				// Lay down a new grain every SYNTH_HOP output samples.
				if (s.sinceGrain <= 0) {
					const base = s.readPos;
					for (let k = 0; k < GRAIN; k++) {
						const rp = base + k * this.ratio;      // resample: read faster/slower by ratio
						const idx = Math.floor(rp);
						const frac = rp - idx;
						// Read from history relative to writePos; clamp to available samples.
						const a = this.histSample(s, idx);
						const b = this.histSample(s, idx + 1);
						const v = (a * (1 - frac) + b * frac) * WINDOW[k];
						const oi = (s.outHead + k) % s.outAcc.length;
						s.outAcc[oi] += v;
						s.outNorm[oi] += WINDOW[k] * WINDOW[k];
					}
					s.readPos += SYNTH_HOP * this.ratio;       // analysis hop = synth hop × ratio
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

	// Read a sample from the input history by ABSOLUTE input index, mapped into the ring.
	histSample(s, absIdx) {
		if (absIdx < 0) return 0;
		if (absIdx >= s.writePos) return 0;
		return s.hist[absIdx % s.hist.length];
	}
}

registerProcessor('encore-pitch-shift', PitchShiftProcessor);
`;

// ── the graph controller (DOM/WebAudio; not unit-tested — needs real audio hardware) ──────────────

/**
 * Wraps ONE HTMLMediaElement in a lazily-built pitch-shift graph.
 *
 * Lifecycle mirrors the trap documented at the top of this file:
 *   attach(shift): idempotent. At shift 0 it is a no-op and no graph is built. At a non-zero shift it
 *     builds the AudioContext + MediaElementSource + worklet ONCE, resumes the context, and either
 *     applies the ratio (resume succeeded) or falls back to unshifted playback (resume failed).
 *   setShift(shift): change the ratio on an already-attached element. Returning to 0 sets ratio 1
 *     (bypass) rather than tearing anything down — see below.
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

	private async build(): Promise<void> {
		if (this.routed || this.degraded) return;
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
