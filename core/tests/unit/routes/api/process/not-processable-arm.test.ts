// Guard for, route half: POST /api/process must ANSWER for a metadata-only source instead of
// falling through to its generic 409.
//
// The route has four honest arms (ready / unknown / playing / over-limit) and a catch-all
// `could not start process`. Because `processState` answered `'processable'` for a Spotify media, none
// of the four fired, `requestProcess` returned null, and the singer got the catch-all — a
// four-second toast that named no reason, for a turn they had just been given that could never play.
//
// The issue's HAZARD note applies here and is why this test exists: adding a `ProcessState` member forces
// NOTHING. There is no `Record<ProcessState, …>` and no exhaustive switch anywhere, so the route reads the
// state through a chain of `if (state === …)` comparisons — a new member type-checks perfectly while
// the route keeps falling through. Only a test can hold this arm in place.
import { test, expect, afterEach } from 'bun:test';
import { POST } from '$routes/api/process/+server';
import { AuthoritativeState } from '$lib/server/state/store';
import { JobRepository } from '$lib/server/jobs/repository';
import { migratedDb } from '$lib/server/db/test-db';
import { SettingsRepository } from '$lib/server/state/settings-repository';
import type { Media } from '$lib/contract';

const APP_KEY = Symbol.for('encore.app');
const SPOTIFY_TRACK_ID = '4uLU6hMCjMI75M1A2tKUQC';

const media = (id: string, over: Partial<Media> = {}): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'vid-' + id,
	title: id,
	durationSec: 200,
	stemStatus: 'none',
	...over
});

/** The real app surface this route reads, with a real job repo + state so nothing under test is faked. */
function installApp(mediaById: Map<string, Media>) {
	const db = migratedDb();
	(globalThis as Record<PropertyKey, unknown>)[APP_KEY] = {
		now: () => 1_700_000_000_000,
		mediaById,
		state: new AuthoritativeState(),
		jobs: new JobRepository(db),
		singers: { bySessionToken: () => ({ id: 's1', displayName: 'Ada' }) },
		// A REAL repository, not a stub returning defaults: the route reads global settings for the
		// per-singer process cap and for the fetcher choice, and a stub would answer the same thing for
		// every deployment — which is how the fetcher dep went unpassed for a release without a test noticing.
		settings: new SettingsRepository(db),
		media: { upsert: () => {} },
		publish: () => {},
		workerHub: { dispatch: () => {} }
	};
}

afterEach(() => {
	delete (globalThis as Record<PropertyKey, unknown>)[APP_KEY];
});

function call(mediaId: string) {
	return POST({
		request: new Request('http://x/api/process', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ mediaId })
		}),
		cookies: { get: () => 'tok' }
	} as never);
}

test('the route names the reason for a Spotify media (was the generic catch-all 409)', async () => {
	const mediaById = new Map<string, Media>();
	mediaById.set('sp1', media('sp1', { source: 'spotify', sourceRef: SPOTIFY_TRACK_ID }));
	installApp(mediaById);

	const res = await call('sp1');
	expect(res.status).toBe(409);
	const body = (await res.json()) as { error?: string; reason?: string };
	// A machine-readable reason, like the over-limit arm has, so a surface can tell a permanent refusal
	// from a transient one rather than parsing prose.
	expect(body.reason).toBe('not-processable');
	// And it must no longer be the catch-all string, which is the thing the singer actually saw.
	expect(body.error).not.toBe('could not start process');
	expect(body.error).toBeTruthy();
});

test('CONTROL: an unknown media still gets its own arm (the new arm did not swallow it)', async () => {
	installApp(new Map<string, Media>());
	const res = await call('nope');
	expect(res.status).toBe(409);
	expect(((await res.json()) as { error?: string }).error).toBe('unknown media');
});

test('CONTROL: a YouTube media still starts a process through this route', async () => {
	// Non-vacuous: the new arm must not refuse everything. Same route, same harness, one field different.
	const mediaById = new Map<string, Media>();
	mediaById.set('yt1', media('yt1'));
	installApp(mediaById);

	const res = await call('yt1');
	expect(res.status).toBe(200);
	const body = (await res.json()) as { job?: { mediaId: string; status: string } };
	expect(body.job?.mediaId).toBe('yt1');
	expect(mediaById.get('yt1')!.stemStatus).toBe('queued');
});
