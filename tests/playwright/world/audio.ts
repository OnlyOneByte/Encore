// Real, decodable audio EMITTED rather than encoded, because the box a run lands on may have a decode-only
// ffmpeg and there is no guarantee of flac/sox/lame. A RIFF header is 44 documented bytes and s16le samples
// are integers, so this needs nothing installed, and `wav: 'audio/wav'` is already in the media route's
// content-type map. Ported from tests/e2e/wav.mjs.

export interface ToneOptions {
	seconds?: number;
	/** Summed sine partials. A chord rather than noise, so a human opening the artifact hears something. */
	hz?: number[];
	rate?: number;
	amp?: number;
}

/** One 16-bit PCM WAV, mono, 44.1 kHz. */
export function tone({ seconds = 8, hz = [220, 277.18, 329.63], rate = 44100, amp = 0.28 }: ToneOptions = {}): Buffer {
	const n = Math.floor(seconds * rate);
	const bytes = Buffer.alloc(44 + n * 2);

	bytes.write('RIFF', 0, 'ascii');
	bytes.writeUInt32LE(36 + n * 2, 4); // everything after this field
	bytes.write('WAVE', 8, 'ascii');
	bytes.write('fmt ', 12, 'ascii');
	bytes.writeUInt32LE(16, 16); // fmt chunk size
	bytes.writeUInt16LE(1, 20); // 1 = PCM, uncompressed
	bytes.writeUInt16LE(1, 22); // channels
	bytes.writeUInt32LE(rate, 24);
	bytes.writeUInt32LE(rate * 2, 28); // byte rate = rate * channels * bytesPerSample
	bytes.writeUInt16LE(2, 32); // block align
	bytes.writeUInt16LE(16, 34); // bits per sample
	bytes.write('data', 36, 'ascii');
	bytes.writeUInt32LE(n * 2, 40);

	// A short fade at each end, so a decoder is never handed a discontinuity it could clamp.
	const fade = Math.min(Math.floor(rate * 0.05), Math.floor(n / 2));
	for (let i = 0; i < n; i++) {
		const t = i / rate;
		let s = 0;
		for (const f of hz) s += Math.sin(2 * Math.PI * f * t);
		s = (s / hz.length) * amp;
		const env = Math.min(1, i / fade, (n - i) / fade);
		bytes.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * env * 32767))), 44 + i * 2);
	}
	return bytes;
}

/** Digital silence at the exact 16-bit floor the silence guard looks for. Its purpose is to be REFUSED. */
export function silence({ seconds = 8, rate = 44100 }: Pick<ToneOptions, 'seconds' | 'rate'> = {}): Buffer {
	return tone({ seconds, rate, amp: 0, hz: [1] });
}
