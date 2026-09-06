// Done-when: a reaper-killed cook is REPORTED, not silent (issue #303). #90 wired the reaper's
// onFailed hook to settle the readiness gate, but the hook did nothing else — no media:status
// broadcast, no operator log, no scratch reclaim — so the phone that watched the cook stayed pinned
// on "Making karaoke… N%" with no Sing button forever. This test drives a REAL JobReaper +
// JobRepository (in-memory sqlite) to attempts-exhaustion through the SAME onFailed closure app.ts
// wires (settle + broadcast-gated-on-shouldBroadcastCook + log + cleanJobWork), and asserts a
// `media:status: failed` reaches the broadcast sink. reaper.test.ts asserts the media STATE after
// the settle, but nothing about a broadcast — there was no broadcast seam before this fix.
import { test, expect } from 'bun:test';
import { JobReaper } from './reaper';
import { JobRepository } from './repository';
import { ackDeadline, progressDeadline } from './leases';
import { openDb } from '../db/index';
import { runMigrations } from '../db/migrate';
import { settleGatesForFailedJob } from './make-karaoke';
import { mediaStatusFor, shouldBroadcastCook } from './media-status';
import type { Media, ServerEvent, Job } from '@encore/shared';

const T0 = 1_700_000_000_000;

const mkMedia = (id: string, over: Partial<Media> = {}): Media => ({
	id, source: 'youtube', sourceRef: 'vid-' + id, title: id, durationSec: 200, stemStatus: 'none', ...over
});

// The onFailed hook app.ts wires around the reaper, reconstructed here over an injected sink so the
// behaviour — not a copy of the source text — is what this test pins. Kept in lockstep with the
// source by reaper-onfailed-wiring.test.ts, which scans app.ts's actual hook.
function appOnFailed(
	mediaById: Map<string, Media>,
	broadcasts: ServerEvent[],
	logs: string[],
	cleaned: string[]
) {
	return (job: Job) => {
		settleGatesForFailedJob(job, mediaById);
		const media = mediaById.get(job.mediaId);
		if (shouldBroadcastCook(job, media)) {
			broadcasts.push({
				type: 'media:status',
				mediaId: job.mediaId,
				status: mediaStatusFor(job),
				pct: job.progressPct,
				etaSec: job.etaSec ?? undefined
			});
		}
		logs.push(`reaper killed ${job.id} ${job.mediaId}`);
		cleaned.push(job.id); // stands in for cleanJobWork(job.id) — no filesystem in this harness
	};
}

function exhaust(jobType: 'stems' | 'align' | 'stems-upgrade', over: Partial<Media> = {}) {
	let clock = T0;
	const { db } = openDb(':memory:');
	runMigrations(db);
	const jobs = new JobRepository(db);
	const mediaById = new Map<string, Media>([['m1', mkMedia('m1', over)]]);
	const broadcasts: ServerEvent[] = [];
	const logs: string[] = [];
	const cleaned: string[] = [];
	const reaper = new JobReaper(jobs, {
		now: () => clock,
		tickMs: 1_000_000,
		onFailed: appOnFailed(mediaById, broadcasts, logs, cleaned)
	});
	const job = jobs.enqueue('m1', jobType, 0, T0);
	for (let i = 0; i < 3; i++) {
		jobs.assign(job.id, 'w', ackDeadline(clock), clock);
		jobs.accept(job.id, progressDeadline(clock), clock);
		clock += 31_000;
		reaper.tick();
	}
	return { jobs, mediaById, job, broadcasts, logs, cleaned };
}

test('#303 reaper-killed stems cook broadcasts media:status failed (the room is told)', () => {
	const { jobs, job, broadcasts, logs, cleaned } = exhaust('stems', { stemStatus: 'queued' });
	// Reaper path reached terminal failed (not #onFailed).
	expect(jobs.byId(job.id)!.status).toBe('failed');
	// The regression: before #303 broadcasts was []. Now exactly one media:status: failed reaches the sink.
	const statusEvents = broadcasts.filter((e) => e.type === 'media:status');
	expect(statusEvents.length).toBe(1);
	const ev = statusEvents[0] as Extract<ServerEvent, { type: 'media:status' }>;
	expect(ev.status).toBe('failed');
	expect(ev.mediaId).toBe('m1');
	// And the operator gets one line + the scratch is reclaimed.
	expect(logs.length).toBe(1);
	expect(cleaned).toEqual([job.id]);
});

test('#303 reaper-killed align cook (playable song) still broadcasts failed', () => {
	// align dies on an already-playable song; the lyrics gate settles but the room must still hear failed.
	const { broadcasts } = exhaust('align', {
		stemStatus: 'ready',
		instrumentalRef: 'derived/stems/m1-instrumental.flac',
		lyricsStatus: 'queued'
	});
	const statusEvents = broadcasts.filter((e) => e.type === 'media:status');
	expect(statusEvents.length).toBe(1);
	expect((statusEvents[0] as Extract<ServerEvent, { type: 'media:status' }>).status).toBe('failed');
});

test('#303 a dead stems-upgrade on an ALREADY-singable song is NOT broadcast (no ready-row regress)', () => {
	// shouldBroadcastCook returns false for a stems-upgrade on a readyToSing song — broadcasting failed
	// would flip a happy ready row back to a failure chip for a background job the singer never saw.
	const { jobs, job, broadcasts } = exhaust('stems-upgrade', {
		stemStatus: 'ready',
		instrumentalRef: 'derived/stems/m1-instrumental.flac',
		lyricsStatus: 'ready'
	});
	expect(jobs.byId(job.id)!.status).toBe('failed');
	expect(broadcasts.filter((e) => e.type === 'media:status').length).toBe(0);
});
