// Browser mic capture → f0 samples. Opens the microphone, runs an AnalyserNode, and on a
// throttled interval reads the time-domain block and detects pitch (pitch-detect.ts). Browser-only:
// the pure DSP is tested separately; this thin Web Audio wrapper is exercised eyes-on. All Web Audio
// access is guarded so importing the module never throws server-side (SvelteKit SSR).
import { detectF0, type F0Result } from './pitch-detect';

export interface MicSample extends F0Result {}

export interface MicPitchOptions {
	intervalMs?: number; // min gap between emitted samples (default ~15 Hz)
	fftSize?: number; // analyser block size (power of 2; default 2048)
}

type WebAudioCtor = typeof AudioContext;

/**
 * Captures mic audio and emits pitch samples via `onSample`. `start()` requests mic permission and
 * begins; `stop()` releases the mic and audio graph. Safe to call `stop()` repeatedly. A single
 * instance is reused across turns — construct once, start/stop as the singer's turn comes and goes.
 */
export class MicPitch {
	#onSample: (s: MicSample) => void;
	#opts: Required<MicPitchOptions>;
	#stream?: MediaStream;
	#ctx?: AudioContext;
	#raf = 0;
	#running = false;
	#lastEmit = 0;

	constructor(onSample: (s: MicSample) => void, opts: MicPitchOptions = {}) {
		this.#onSample = onSample;
		this.#opts = { intervalMs: opts.intervalMs ?? 66, fftSize: opts.fftSize ?? 2048 };
	}

	get running(): boolean {
		return this.#running;
	}

	/** True only where the Web Audio + getUserMedia APIs exist (a real browser over https/localhost). */
	static isSupported(): boolean {
		return (
			typeof navigator !== 'undefined' &&
			!!navigator.mediaDevices?.getUserMedia &&
			(typeof AudioContext !== 'undefined' || typeof (globalThis as { webkitAudioContext?: WebAudioCtor }).webkitAudioContext !== 'undefined')
		);
	}

	async start(): Promise<void> {
		if (this.#running || !MicPitch.isSupported()) return;
		// No processing — we want the raw voice, not echo-cancelled/AGC'd audio that distorts pitch.
		this.#stream = await navigator.mediaDevices.getUserMedia({
			audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
		});
		const Ctor: WebAudioCtor =
			typeof AudioContext !== 'undefined'
				? AudioContext
				: (globalThis as unknown as { webkitAudioContext: WebAudioCtor }).webkitAudioContext;
		this.#ctx = new Ctor();
		const src = this.#ctx.createMediaStreamSource(this.#stream);
		const analyser = this.#ctx.createAnalyser();
		analyser.fftSize = this.#opts.fftSize;
		src.connect(analyser); // NOT connected to destination → no monitoring/feedback
		const block = new Float32Array(analyser.fftSize);
		const sampleRate = this.#ctx.sampleRate;

		this.#running = true;
		const tick = () => {
			if (!this.#running) return;
			const now = performance.now();
			if (now - this.#lastEmit >= this.#opts.intervalMs) {
				this.#lastEmit = now;
				analyser.getFloatTimeDomainData(block);
				this.#onSample(detectF0(block, sampleRate));
			}
			this.#raf = requestAnimationFrame(tick);
		};
		this.#raf = requestAnimationFrame(tick);
	}

	stop(): void {
		this.#running = false;
		if (this.#raf) cancelAnimationFrame(this.#raf);
		this.#raf = 0;
		this.#stream?.getTracks().forEach((t) => t.stop());
		this.#ctx?.close().catch(() => {});
		this.#stream = undefined;
		this.#ctx = undefined;
	}
}
