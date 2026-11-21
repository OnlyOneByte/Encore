// Guard for the 120s "Making karaoke… 0%" on a job nobody can run.
//
// The hub's unservable sweep broadcasts `unservable: true` ONCE, on first sight, from inside `dispatch()`. The route
// used to call `dispatch()` and THEN publish its own `media:status`, which carries no flag — and every phone reads
// an absent flag as "the stall cleared". So the last word the room heard was "queued", for the whole TTL. The
// route's frame must go first, so the sweep's is the one that stands — and on a REPEAT request for the same deduped
// job (Try again), when the sweep stays quiet, the route's own frame must carry the verdict.
import { test, expect, afterEach } from 'bun:test';
import { POST } from '$routes/api/process/+server';
import { AuthoritativeState } from '$lib/server/state/store';
import { JobRepository } from '$lib/server/jobs/repository';
import { migratedDb } from '$lib/server/db/test-db';
import { SettingsRepository } from '$lib/server/state/settings-repository';
import type { Media, ServerEvent } from '$lib/contract';

const APP_KEY = Symbol.for('encore.app');

afterEach(() => {
	delete (globalThis as Record<PropertyKey, unknown>)[APP_KEY];
});

/** The real hub's unservable behaviour with no capable worker connected: one flagged frame per job, on FIRST sight
 * (`#unservableSince`), then silence, and `isUnservable` true from then on. */
function installApp() {
	const db = migratedDb();
	const heard: ServerEvent[] = [];
	const jobs = new JobRepository(db);
	const seen = new Set<string>();
	(globalThis as Record<PropertyKey, unknown>)[APP_KEY] = {
		now: () => 1_700_000_000_000,
		mediaById: new Map<string, Media>([
			[
				'yt1',
				{ id: 'yt1', source: 'youtube', sourceRef: 'vid-yt1', title: 'yt1', durationSec: 200, stemStatus: 'none' }
			]
		]),
		state: new AuthoritativeState(),
		jobs,
		singers: { bySessionToken: () => ({ id: 's1', displayName: 'Ada' }) },
		settings: new SettingsRepository(db),
		media: { upsert: () => {} },
		publish: (e: ServerEvent) => heard.push(e),
		workerHub: {
			isUnservable: (id: string) => seen.has(id),
			dispatch: () => {
				for (const job of jobs.listByStatus('queued')) {
					if (seen.has(job.id)) continue;
					seen.add(job.id);
					heard.push({ type: 'media:status', mediaId: job.mediaId, status: 'queued', pct: 0, unservable: true });
				}
			}
		}
	};
	return heard;
}

const post = () =>
	POST({
		request: new Request('http://x/api/process', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ mediaId: 'yt1' })
		}),
		cookies: { get: () => 'tok' }
	} as never);

const lastStatus = (heard: ServerEvent[]) => heard.filter((e) => e.type === 'media:status').at(-1);

test('the unservable frame dispatch broadcasts is the LAST media:status the room hears', async () => {
	const heard = installApp();
	expect((await post()).status).toBe(200);
	expect(heard.filter((e) => e.type === 'media:status')).toHaveLength(2);
	expect(lastStatus(heard)).toMatchObject({ unservable: true });
});

test('Try again inside the window keeps the verdict: the sweep is silent, so the route says it', async () => {
	const heard = installApp();
	await post();
	heard.length = 0;
	expect((await post()).status).toBe(200);
	// One frame only — the sweep has already seen this job — and it must not read as "the stall cleared".
	expect(heard.filter((e) => e.type === 'media:status')).toHaveLength(1);
	expect(lastStatus(heard)).toMatchObject({ unservable: true });
});
