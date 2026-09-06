/*
 * Real, decodable audio — synthesized, with no encoder on the box.
 *
 * WHY THIS EXISTS. `seed-media.mjs` writes 16-byte ISO-BMFF stubs and says so in its own header:
 * "NOT enough to decode, so do not use this to test playback". That was the single reason the e2e
 * could drive join → search → queue → rotation and still never once prove a sound came out. Every
 * audio defect the party hit — a master element that was never told to play, a <video> that cannot
 * decode FLAC, a silent instrumental published as ready, a range-less route WebKit abandons — lived
 * in exactly the gap the placeholder left open.
 *
 * Encoding is not available here to close it: BOTH ffmpeg builds on this host are decode-only (no
 * muxers, no encoders, no lavfi, not even the `volumedetect` filter the loudness probe shells out to),
 * and there is no flac/sox/lame. So we do not encode — we EMIT. A RIFF/PCM header is 44 bytes of
 * documented layout and s16le samples are just integers, so a WAV can be written by hand with zero
 * dependencies, and `wav: 'audio/wav'` is already in the media route's content-type map. Chromium
 * decodes it natively.
 *
 * The audio is deliberately LOUD and HARMONIC rather than noise, so that a human opening the artifact
 * hears a chord and not a hiss, and so `webkitAudioDecodedByteCount` climbing is unambiguous.
 */

/** One 16-bit PCM WAV, mono, 44.1 kHz, from a set of summed sine partials. */
export function tone({ seconds = 8, hz = [220, 277.18, 329.63], rate = 44100, amp = 0.28 } = {}) {
	const n = Math.floor(seconds * rate);
	const bytes = Buffer.alloc(44 + n * 2);

	// RIFF container
	bytes.write('RIFF', 0, 'ascii');
	bytes.writeUInt32LE(36 + n * 2, 4); // size of everything after this field
	bytes.write('WAVE', 8, 'ascii');
	// fmt chunk — PCM, mono, 16-bit
	bytes.write('fmt ', 12, 'ascii');
	bytes.writeUInt32LE(16, 16); // fmt chunk size
	bytes.writeUInt16LE(1, 20); // audioFormat 1 = PCM (uncompressed)
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

/**
 * Digital silence, at the exact 16-bit floor the silence guard looks for.
 *
 * Its purpose is to be REFUSED. Two of the songs on the real library separated to a floor-level stem
 * and published as ready, so the room played four minutes of nothing with no signal on any surface;
 * a fixture that cannot reproduce that cannot prove the guard against it works.
 */
export function silence({ seconds = 8, rate = 44100 } = {}) {
	return tone({ seconds, rate, amp: 0, hz: [1] });
}
