// Loudness probing — the check that stops a SILENT vocals stem being published as a working
// guiding track. Pure parser + verdict; the ffmpeg spawn is not exercised here.
import { describe, it, expect } from 'bun:test';
import { parseVolumeDetect, isDigitalSilence, SILENCE_FLOOR_DB } from './loudness';

// Real ffmpeg volumedetect output, trimmed to the summary block.
const HEALTHY = `
[Parsed_volumedetect_0 @ 0x55d1] n_samples: 15925248
[Parsed_volumedetect_0 @ 0x55d1] mean_volume: -21.4 dB
[Parsed_volumedetect_0 @ 0x55d1] max_volume: -1.2 dB
[Parsed_volumedetect_0 @ 0x55d1] histogram_1db: 24
`;

// The known defect: mean AND max both pinned at the 16-bit floor.
const SILENT = `
[Parsed_volumedetect_0 @ 0x55d1] n_samples: 15925248
[Parsed_volumedetect_0 @ 0x55d1] mean_volume: -91.0 dB
[Parsed_volumedetect_0 @ 0x55d1] max_volume: -91.0 dB
`;

describe('parseVolumeDetect', () => {
	it('reads mean and max out of real output', () => {
		expect(parseVolumeDetect(HEALTHY)).toEqual({ meanDb: -21.4, maxDb: -1.2 });
	});

	it('reads an integer-valued reading', () => {
		expect(parseVolumeDetect(SILENT)).toEqual({ meanDb: -91, maxDb: -91 });
	});

	it('handles 0 dB peak (a hot master)', () => {
		expect(parseVolumeDetect('mean_volume: -14 dB\nmax_volume: 0 dB')?.maxDb).toBe(0);
	});

	it('returns null when the lines are absent — UNMEASURABLE, not silent', () => {
		expect(parseVolumeDetect('')).toBeNull();
		expect(parseVolumeDetect('ffmpeg: No such file or directory')).toBeNull();
		expect(parseVolumeDetect('mean_volume: -20 dB')).toBeNull(); // truncated: no max
	});
});

describe('isDigitalSilence', () => {
	it('flags a stem pinned at the floor', () => {
		expect(isDigitalSilence({ meanDb: -91, maxDb: -91 })).toBe(true);
	});

	it('does NOT flag real audio, however quiet', () => {
		expect(isDigitalSilence({ meanDb: -21.4, maxDb: -1.2 })).toBe(false);
		// a very quiet but genuine vocal take still peaks far above the floor
		expect(isDigitalSilence({ meanDb: -58, maxDb: -34 })).toBe(false);
	});

	it('judges on PEAK, not mean — a sparse vocal has a low mean and real content', () => {
		// mostly silence between phrases, but the phrases are loud
		expect(isDigitalSilence({ meanDb: -89, maxDb: -6 })).toBe(false);
	});

	it('treats an unmeasurable file as audible, so a missing ffmpeg cannot disable every guide', () => {
		expect(isDigitalSilence(null)).toBe(false);
	});

	it('the floor leaves headroom below any real signal', () => {
		expect(SILENCE_FLOOR_DB).toBeLessThan(-80);
		expect(isDigitalSilence({ meanDb: -95, maxDb: SILENCE_FLOOR_DB })).toBe(true);
		expect(isDigitalSilence({ meanDb: -95, maxDb: SILENCE_FLOOR_DB + 1 })).toBe(false);
	});
});
