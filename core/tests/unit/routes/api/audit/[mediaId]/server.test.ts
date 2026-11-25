// the audit endpoint must surface the variant-pick provenance so /metrics/<mediaId> can
// answer a mis-pick from state. toAudit is the mapper the GET handler runs per attempt; this pins that
// it carries selection through. RED on base: toAudit has no selection field (and attemptSelection does
// not exist), so a reverted mapper drops it.
import { describe, expect, it } from 'bun:test';
import { latestLyricsNote, toAudit } from '$routes/api/audit/[mediaId]/audit-shape';
import type { JobAttempt } from '$lib/contract';

function attempt(over: Partial<JobAttempt> = {}): JobAttempt {
	return {
		id: 'a1',
		jobId: 'j1',
		mediaId: 'm1',
		processingId: 'c1',
		jobType: 'align',
		attempt: 1,
		workerId: 'w1',
		enqueuedAt: 1_700_000_000_000,
		assignedAt: null,
		startedAt: null,
		finishedAt: null,
		outcome: 'ready',
		error: null,
		engine: null,
		model: null,
		backend: null,
		device: null,
		threads: null,
		asrModel: null,
		syncMode: null,
		audioSec: null,
		stages: null,
		selection: null,
		trail: null,
		lyricsNote: null,
		concurrency: null,
		demucsJobs: null,
		asrCompute: null,
		handSet: null,
		...over
	};
}

describe('latestLyricsNote — why a song has no lyrics (#1221)', () => {
	it('reads the latest FINISHED align attempt, so a later align clears an older reason', () => {
		const offline = attempt({ id: 'a1', finishedAt: 10, lyricsNote: 'asr-offline' });
		expect(latestLyricsNote([offline])).toBe('asr-offline');
		expect(latestLyricsNote([offline, attempt({ id: 'a2', finishedAt: 20 })])).toBeNull();
		expect(latestLyricsNote([offline, attempt({ id: 'a3', finishedAt: null })])).toBe('asr-offline');
		expect(latestLyricsNote([attempt({ jobType: 'stems', finishedAt: 30, lyricsNote: 'asr-offline' })])).toBeNull();
	});
});

describe('toAudit — selection provenance', () => {
	it('surfaces the parsed selection record when the attempt recorded one', () => {
		const selection = JSON.stringify({
			baselineFallback: false,
			winnerSuspect: false,
			winnerScore: 0.94,
			choices: [
				{
					textSource: 'lrclib',
					considered: 2,
					chosen: 'lrclib-synced',
					chosenScore: 0.94,
					decidedBy: 'agreement',
					votes: 2,
					rejected: [{ label: 'lrclib-plain', score: 0.61 }]
				}
			]
		});
		const out = toAudit(attempt({ selection }));
		expect(out.selection).not.toBeNull();
		const c = out.selection!.choices[0]!;
		expect(c.rejected).toEqual([{ label: 'lrclib-plain', score: 0.61 }]);
		expect(c.decidedBy).toBe('agreement');
	});

	it('is null when the attempt recorded no selection', () => {
		expect(toAudit(attempt({ selection: null })).selection).toBeNull();
	});
});
