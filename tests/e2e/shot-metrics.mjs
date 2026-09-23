// Metrics-page capture.
//
// /metrics fetches /api/metrics on mount and renders empty states without it, so an ephemeral server would
// show none of the copy under review: an initScript overrides fetch for that ONE path with a fixture. The
// numbers are therefore fixture data — read these frames for wording and column headers, never throughput.
//
// Usage: EPORT=3411 OUT=/abs/dir TAG=before bun run tests/e2e/shot-metrics.mjs
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { connect, sleep } from './driver.mjs';

const PORT = process.env.EPORT ?? '3000';
const base = `http://127.0.0.1:${PORT}`;
const OUT = process.env.OUT ?? '/tmp/metrics-shots';
const TAG = process.env.TAG ?? 'shot';

// This is an operator page with a 900px measure, so it is shot at desktop width by default. DPR 1 and
// a 1400px height keep both axes under the 2000px an agent can read back. `SHOT_W` narrows it to a
// phone, which is the case the tables' horizontal scroll exists for.
const W = Number(process.env.SHOT_W ?? 1000);
const H = Number(process.env.SHOT_H ?? 1400);

const FIXTURE = {
	sample: { attempts: 47, processes: 19, provisional: false },
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

const initScript = `
	const fixture = ${JSON.stringify(FIXTURE)};
	const real = window.fetch;
	window.fetch = (input, init) => {
		const url = typeof input === 'string' ? input : (input && input.url) || '';
		if (url.includes('/api/metrics')) {
			return Promise.resolve(new Response(JSON.stringify(fixture), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			}));
		}
		return real(input, init);
	};
`;

if (!(await fetch(`${base}/health`).catch(() => null))?.ok) {
	console.error(`No Encore server on ${base}.`);
	process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const browser = await connect();
try {
	const page = await browser.newPage({ initScript });
	await page.viewport(W, H, 1);
	await page.goto(`${base}/metrics`);
	// A CONDITION, not a selector: contract.test.ts bans a driver from spelling a selector out for
	// itself, and this script wants no element in particular — only the loaded page. The live region
	// holds "Loading…" until the fetch lands, so its absence IS the ready signal.
	await page.waitFor(`!document.body.innerText.includes('Loading…')`);
	await sleep(600);

	const shoot = async (/** @type {string} */ name) => {
		const path = join(OUT, `${TAG}-metrics-${name}.png`);
		await page.screenshot(path);
		console.log('  ✓', path);
	};

	// Scrolled by PROPORTION for the same reason: the frames want top / middle / bottom of a long
	// page, not a named element, and a proportion cannot rot when a card moves.
	await shoot('top');
	await page.evaluate(`window.scrollTo(0, document.body.scrollHeight * 0.22)`);
	await sleep(350);
	await shoot('models');
	await page.evaluate(`window.scrollTo(0, document.body.scrollHeight)`);
	await sleep(350);
	await shoot('tail');
} finally {
	await browser.close();
}
