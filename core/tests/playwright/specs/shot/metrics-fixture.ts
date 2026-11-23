// THE /metrics FIXTURE.
//
// WHY IT EXISTS AT ALL. /metrics fetches /api/metrics on mount and renders empty states without it, and a
// per-test core has processed nothing — so the page under review would show none of the copy it is shot for.
// The frames stub this one path and nothing else.
//
// THESE NUMBERS ARE FIXTURE DATA. Read the frames for wording and column headers, NEVER for throughput.
// They are chosen to light every branch the page has: a provisional row, an abandoned job, a model measured
// slower than its vendor claim and one measured faster, and a connected worker (with none, the page leads
// with a "no worker connected" warning instead of the tables).
//
// It lives beside the spec rather than in `world/` because it is data for four frames, not something a
// second spec could want: a fixture in the world reads as a fact about the app.

export interface MetricsFixture {
	sample: {
		attempts: number;
		total: number;
		windowDays: number;
		clipped: boolean;
		processes: number;
		provisional: boolean;
	};
	e2e: { n: number; meanMs: number; p50Ms: number; p95Ms: number };
	steps: {
		jobType: string;
		n: number;
		failed: number;
		abandoned: number;
		meanMs: number;
		p50Ms: number;
		p95Ms: number;
		meanQueueWaitMs: number;
		meanRtFactor: number;
		provisional: boolean;
	}[];
	models: {
		engine: string;
		model: string;
		n: number;
		meanRtFactor: number;
		declared: { rtFactor: number; provenance: string };
		ratioToDeclared: number;
		provisional: boolean;
	}[];
	asr: { asrModel: string; syncMode: string; n: number; meanRtFactor: number; meanMs: number; provisional: boolean }[];
	stages: { stage: string; n: number; meanMs: number }[];
	slowestProcesses: {
		processingId: string;
		mediaId: string;
		title: string;
		totalMs: number;
		workMs: number;
		steps: number;
	}[];
	workers: {
		workerId: string;
		capabilities: string[];
		slotsFree: number;
		host: Record<string, string | number | boolean>;
		profile: { backend?: string; device?: string; threads?: number } | null;
	}[];
}

/** The sample line the page prints from `sample`, which is what the frames wait on: it appears only once the
 *  stubbed fetch has landed, so it is a positive ready signal rather than the absence of "Loading…". */
export const METRICS_READY_TEXT = '47 attempts in the last 7 days, across 19 finished songs.';

export const METRICS_FIXTURE: MetricsFixture = {
	// `clipped: true` and a `total` above `attempts` light the two caveat sentences the page grew for the dropped
	// server fields, per this file's rule that the fixture lights every branch the page has.
	sample: { attempts: 47, total: 1_240, windowDays: 7, clipped: true, processes: 19, provisional: false },
	e2e: { n: 19, meanMs: 214_000, p50Ms: 188_000, p95Ms: 402_000 },
	steps: [
		{
			jobType: 'fetch',
			n: 19,
			failed: 2,
			abandoned: 0,
			meanMs: 21_400,
			p50Ms: 18_900,
			p95Ms: 47_000,
			meanQueueWaitMs: 1_200,
			meanRtFactor: 0.08,
			provisional: false
		},
		{
			jobType: 'stems',
			n: 19,
			failed: 0,
			abandoned: 0,
			meanMs: 154_000,
			p50Ms: 141_000,
			p95Ms: 288_000,
			meanQueueWaitMs: 34_000,
			meanRtFactor: 0.61,
			provisional: false
		},
		{
			jobType: 'align',
			n: 17,
			failed: 1,
			abandoned: 0,
			meanMs: 38_600,
			p50Ms: 35_100,
			p95Ms: 71_000,
			meanQueueWaitMs: 8_400,
			meanRtFactor: 0.15,
			provisional: false
		},
		{
			jobType: 'stems-upgrade',
			n: 4,
			failed: 0,
			abandoned: 1,
			meanMs: 402_000,
			p50Ms: 390_000,
			p95Ms: 512_000,
			meanQueueWaitMs: 121_000,
			meanRtFactor: 1.62,
			provisional: true
		}
	],
	models: [
		{
			engine: 'demucs',
			model: 'htdemucs',
			n: 12,
			meanRtFactor: 0.61,
			declared: { rtFactor: 0.35, provenance: 'vendor' },
			ratioToDeclared: 1.74,
			provisional: false
		},
		{
			engine: 'demucs',
			model: 'htdemucs_ft',
			n: 3,
			meanRtFactor: 1.62,
			declared: { rtFactor: 1.4, provenance: 'vendor' },
			ratioToDeclared: 1.16,
			provisional: true
		},
		{
			engine: 'audio-separator',
			model: 'bs-roformer-1297',
			n: 4,
			meanRtFactor: 0.44,
			declared: { rtFactor: 0.9, provenance: 'vendor' },
			ratioToDeclared: 0.49,
			provisional: false
		}
	],
	asr: [
		{ asrModel: 'base', syncMode: 'forced', n: 14, meanRtFactor: 0.15, meanMs: 38_600, provisional: false },
		{ asrModel: 'small', syncMode: 'forced', n: 3, meanRtFactor: 0.31, meanMs: 79_200, provisional: true }
	],
	stages: [
		{ stage: 'downloading', n: 19, meanMs: 19_800 },
		{ stage: 'separating', n: 19, meanMs: 148_000 },
		{ stage: 'aligning', n: 17, meanMs: 36_100 }
	],
	slowestProcesses: [
		{ processingId: 'p1', mediaId: 'm1', title: 'Bohemian Rhapsody', totalMs: 640_000, workMs: 402_000, steps: 3 },
		{
			processingId: 'p2',
			mediaId: 'm2',
			title: 'Total Eclipse of the Heart',
			totalMs: 512_000,
			workMs: 331_000,
			steps: 3
		},
		{
			processingId: 'p3',
			mediaId: 'm3',
			title: 'Telephone (feat. Beyoncé)',
			totalMs: 448_000,
			workMs: 288_000,
			steps: 4
		}
	],
	workers: [
		{
			workerId: 'stems-1',
			capabilities: ['fetch:ytdlp', 'stems:demucs', 'align:whisperx'],
			slotsFree: 1,
			profile: { backend: 'torch', device: 'cuda', threads: 16 },
			host: {
				accelerator: 'cuda',
				deviceName: 'NVIDIA RTX 4070',
				cpuCount: 16,
				platform: 'linux',
				python: '3.11.9',
				torch: '2.4.1',
				contained: true
			}
		}
	]
};
