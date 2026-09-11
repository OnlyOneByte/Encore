// Done-when: a reaper-killed cook is REPORTED, not silent, and every terminal-fail path
// runs the SAME four-step epilogue. #90 wired the reaper's onFailed hook to settle the
// readiness gate, but the hook did nothing else — no media:status broadcast, no operator log, no
// scratch reclaim — so the phone that watched the cook stayed pinned on "Making karaoke… N%" with no
// Sing button forever.
//
// This test drives a REAL JobReaper + JobRepository (in-memory sqlite) to attempts-exhaustion with
// the PRODUCTION `reportTerminalFailure` wired as the onFailed hook — the same function app.ts and
// both worker-hub paths call. It used to reconstruct that hook inline (the "fourth copy" issue #451
// names); asserting the real function instead means a site that diverges from it can no longer pass.
// A `media:status: failed` must reach the broadcast sink and the scratch must be reclaimed.
// reaper.test.ts asserts the media STATE after the settle, but nothing about a broadcast — there was
// no broadcast seam before this fix.
import { test, expect, spyOn } from 'bun:test';
import { migratedDb } from '../db/test-db';
import { JobReaper } from './reaper';
import { JobRepository } from './repository';
import { ackDeadline, progressDeadline } from './leases';
import { reportTerminalFailure } from './make-karaoke';
import type { Media, ServerEvent } from '@encore/shared';

const T0 = 1_700_000_000_000;

const mkMedia = (id: string, over: Partial<Media> = {}): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'vid-' + id,
	title: id,
	durationSec: 200,
	stemStatus: 'none',
	...over
});

function exhaust(jobType: 'stems' | 'align' | 'stems-upgrade', over: Partial<Media> = {}) {
	let clock = T0;
	const db = migratedDb();
	const jobs = new JobRepository(db);
	const mediaById = new Map<string, Media>([['m1', mkMedia('m1', over)]]);
	const broadcasts: ServerEvent[] = [];
	// Wire the REAL production epilogue as the reaper's onFailed hook (exactly as app.ts does), over
	// an injected broadcast sink. cleanJobWork inside it is a no-op here (no filesystem scratch for
	// these ids); the log line goes through console.warn, which each test spies.
	const reaper = new JobReaper(jobs, {
		now: () => clock,
		tickMs: 1_000_000,
		onFailed: (job) => reportTerminalFailure(job, 'reaper', { broadcast: (e) => broadcasts.push(e), mediaById })
	});
	const job = jobs.enqueue('m1', jobType, 0, T0);
	for (let i = 0; i < 3; i++) {
		jobs.assign(job.id, 'w', ackDeadline(clock), clock);
		jobs.accept(job.id, progressDeadline(clock), clock);
		clock += 31_000;
		reaper.tick();
	}
	return { jobs, mediaById, job, broadcasts };
}

test('reaper-killed stems cook broadcasts media:status failed + logs uniformly (the room is told)', () => {
	const warn = spyOn(console, 'warn').mockImplementation(() => {});
	try {
		const { jobs, job, broadcasts } = exhaust('stems', { stemStatus: 'queued' });
		// Reaper path reached terminal failed (not #onFailed).
		expect(jobs.byId(job.id)!.status).toBe('failed');
		// The regression: before #303 broadcasts was []. Now exactly one media:status: failed reaches the sink.
		const statusEvents = broadcasts.filter((e) => e.type === 'media:status');
		expect(statusEvents.length).toBe(1);
		const ev = statusEvents[0] as Extract<ServerEvent, { type: 'media:status' }>;
		expect(ev.status).toBe('failed');
		expect(ev.mediaId).toBe('m1');
		// And the operator gets exactly one line, in the uniform key=value format with the reaper cause.
		expect(warn).toHaveBeenCalledTimes(1);
		const line = warn.mock.calls[0]![0] as string;
		expect(line).toContain('cause=reaper');
		expect(line).toContain(`job=${job.id}`);
		expect(line).toContain('media=m1');
		expect(line).toContain('attempts=');
		expect(line).toContain('reason=');
	} finally {
		warn.mockRestore();
	}
});

test('reaper-killed align cook (playable song) still broadcasts failed', () => {
	const warn = spyOn(console, 'warn').mockImplementation(() => {});
	try {
		// align dies on an already-playable song; the lyrics gate settles but the room must still hear failed.
		const { broadcasts } = exhaust('align', {
			stemStatus: 'ready',
			instrumentalRef: 'derived/stems/m1-instrumental.flac',
			lyricsStatus: 'queued'
		});
		const statusEvents = broadcasts.filter((e) => e.type === 'media:status');
		expect(statusEvents.length).toBe(1);
		expect((statusEvents[0] as Extract<ServerEvent, { type: 'media:status' }>).status).toBe('failed');
	} finally {
		warn.mockRestore();
	}
});

test('a dead stems-upgrade on an ALREADY-singable song is NOT broadcast (no ready-row regress)', () => {
	const warn = spyOn(console, 'warn').mockImplementation(() => {});
	try {
		// shouldBroadcastCook returns false for a stems-upgrade on a readyToSing song — broadcasting failed
		// would flip a happy ready row back to a failure chip for a background job the singer never saw.
		const { jobs, job, broadcasts } = exhaust('stems-upgrade', {
			stemStatus: 'ready',
			instrumentalRef: 'derived/stems/m1-instrumental.flac',
			lyricsStatus: 'ready'
		});
		expect(jobs.byId(job.id)!.status).toBe('failed');
		expect(broadcasts.filter((e) => e.type === 'media:status').length).toBe(0);
		// Even a suppressed broadcast still logs the terminal failure — the operator record is unconditional.
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]![0] as string).toContain('cause=reaper');
	} finally {
		warn.mockRestore();
	}
});
