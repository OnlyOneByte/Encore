// Proposal 24, PR 1: the room knows whether anything can make karaoke BEFORE anyone picks. `canMake` is true the moment
// a capable worker joins, false only after the last one has been gone MAKER_GRACE_MS, and each flip re-sends the sync.
import { test, expect, jest } from 'bun:test';
import { migratedDb } from '$lib/server/db/test-db';
import { WorkerHub, MAKER_GRACE_MS } from '$lib/server/jobs/worker-hub';
import { WorkerRegistry } from '$lib/server/jobs/registry';
import { JobRepository } from '$lib/server/jobs/repository';
import { requiredCapability } from '$lib/server/jobs/dispatch';
import { syncEvent } from '$lib/server/realtime/hub';
import { AuthoritativeState } from '$lib/server/state/store';
import { DEFAULT_EFFECTIVE_SETTINGS, type EffectiveSettings } from '$lib/contract';

const MAKER = [requiredCapability('stems'), requiredCapability('align')];

function fleet(settings?: EffectiveSettings) {
	const registry = new WorkerRegistry();
	// Counts the room being told `canMake` moved; a `canFetch` move fires the same hook and is read off `told`.
	let flips = 0;
	let last = true;
	const told: { canMake: boolean; canFetch: boolean }[] = [];
	const hub: WorkerHub = new WorkerHub({
		jobs: new JobRepository(migratedDb()),
		registry,
		mediaById: new Map(),
		toWorker: () => {},
		broadcast: () => {},
		getSettings: settings ? () => settings : undefined,
		now: () => 0,
		queueEntries: () => [],
		onMakerChange: () => {
			told.push({ canMake: hub.canMake(), canFetch: hub.canFetch() });
			if (hub.canMake() !== last) flips++;
			last = hub.canMake();
		}
	});
	const join = (workerId: string, capabilities = MAKER) =>
		hub.handle({ type: 'worker:hello', workerId, capabilities, concurrency: 1, version: '1' });
	const leave = (workerId: string) => hub.workerLeft(() => registry.remove(workerId));
	return { hub, join, leave, flips: () => flips, told };
}

/** Run `body` on a fake clock, restoring the real one whatever happens. */
function withFakeTimers(body: () => void): void {
	jest.useFakeTimers();
	try {
		body();
	} finally {
		jest.useRealTimers();
	}
}

test('with no worker ever connected, it reads true through the boot grace, then false, said once', () =>
	withFakeTimers(() => {
		const { hub, flips } = fleet();
		jest.advanceTimersByTime(MAKER_GRACE_MS - 1);
		expect(hub.canMake()).toBe(true);
		expect(flips()).toBe(0);
		jest.advanceTimersByTime(1);
		expect(hub.canMake()).toBe(false);
		expect(flips()).toBe(1);
	}));

test('a core restart: the worker redialing inside the boot grace changes nothing on screen', () =>
	withFakeTimers(() => {
		const { hub, join, flips } = fleet();
		jest.advanceTimersByTime(MAKER_GRACE_MS / 2);
		join('w1');
		jest.advanceTimersByTime(MAKER_GRACE_MS * 2);
		expect(hub.canMake()).toBe(true);
		expect(flips()).toBe(0);
	}));

test('a capable worker after the grace turns it on at once, and says so once', () =>
	withFakeTimers(() => {
		const { hub, join, flips } = fleet();
		jest.advanceTimersByTime(MAKER_GRACE_MS);
		join('w1');
		expect(hub.canMake()).toBe(true);
		expect(flips()).toBe(2);
		join('w2'); // a second maker changes nothing the room could hear
		expect(flips()).toBe(2);
	}));

test('the last worker leaving turns it off only after the grace, and says so once', () =>
	withFakeTimers(() => {
		const { hub, join, leave, flips } = fleet();
		join('w1');
		leave('w1');
		jest.advanceTimersByTime(MAKER_GRACE_MS - 1);
		expect(hub.canMake()).toBe(true);
		expect(flips()).toBe(0);
		jest.advanceTimersByTime(1);
		expect(hub.canMake()).toBe(false);
		expect(flips()).toBe(1);
	}));

test('a worker back inside the grace changes nothing on screen, and the old timer cannot fire later', () =>
	withFakeTimers(() => {
		const { hub, join, leave, flips } = fleet();
		join('w1');
		leave('w1');
		jest.advanceTimersByTime(MAKER_GRACE_MS / 2);
		join('w1');
		jest.advanceTimersByTime(MAKER_GRACE_MS * 2);
		expect(hub.canMake()).toBe(true);
		expect(flips()).toBe(0);
	}));

test('the grace counts from the loss, not from the last fleet change', () =>
	withFakeTimers(() => {
		const { hub, join, leave } = fleet();
		join('maker');
		join('aligner', [requiredCapability('align')]);
		leave('maker');
		jest.advanceTimersByTime(6_000);
		leave('aligner'); // the fleet changes again, still with no maker
		jest.advanceTimersByTime(MAKER_GRACE_MS - 6_000);
		expect(hub.canMake()).toBe(false);
	}));

test('another fleet change inside the grace arms no second clock that could fire after the maker is back', () =>
	withFakeTimers(() => {
		const { hub, join, leave } = fleet();
		join('maker');
		join('aligner', [requiredCapability('align')]);
		leave('maker');
		leave('aligner'); // the fleet changes again, still with no maker
		join('maker');
		jest.advanceTimersByTime(MAKER_GRACE_MS * 2);
		expect(hub.canMake()).toBe(true);
	}));

test('one of two makers leaving keeps it on', () =>
	withFakeTimers(() => {
		const { hub, join, leave } = fleet();
		join('w1');
		join('w2');
		leave('w1');
		jest.advanceTimersByTime(MAKER_GRACE_MS * 2);
		expect(hub.canMake()).toBe(true);
	}));

test('a worker missing a step every song needs does not count', () =>
	withFakeTimers(() => {
		const stemsOnly = fleet();
		stemsOnly.join('w1', [requiredCapability('stems')]);
		const alignOnly = fleet();
		alignOnly.join('w1', [requiredCapability('align')]);
		jest.advanceTimersByTime(MAKER_GRACE_MS);
		expect(stemsOnly.hub.canMake()).toBe(false);
		expect(alignOnly.hub.canMake()).toBe(false);
	}));

test("a worker that cannot run the room's quality does not count", () =>
	withFakeTimers(() => {
		const roformer: EffectiveSettings = {
			global: { ...DEFAULT_EFFECTIVE_SETTINGS.global, defaultEngine: 'roformer', defaultModel: 'bs-roformer-1297' },
			room: { ...DEFAULT_EFFECTIVE_SETTINGS.room, maxQualityRank: null }
		};
		const demucsOnly = fleet(roformer);
		demucsOnly.join('w1', ['stems', 'align']);
		const capable = fleet(roformer);
		capable.join('w1', ['stems:roformer', 'align']);
		jest.advanceTimersByTime(MAKER_GRACE_MS);
		expect(demucsOnly.hub.canMake()).toBe(false);
		expect(capable.hub.canMake()).toBe(true);
	}));

test('the sync carries each verdict as one boolean, and nothing about the workers', () => {
	const ev = syncEvent(new AuthoritativeState(), {
		mediaById: new Map(),
		canMake: () => false,
		canFetch: () => false
	});
	expect(ev.canMake).toBe(false);
	expect(ev.canFetch).toBe(false);
	expect(Object.keys(ev).filter((k) => /worker|host/i.test(k))).toEqual([]);
	// A caller that cannot know omits them, which a client reads as "no info".
	const bare = syncEvent(new AuthoritativeState(), { mediaById: new Map() });
	expect([bare.canMake, bare.canFetch]).toEqual([undefined, undefined]);
});

// Proposal 24, PR 2: an uploads-only box (no yt-dlp) makes library files but cannot fetch a search result.
const FETCH = requiredCapability('fetch');

test('an uploads-only worker can make but not fetch, after the same grace', () =>
	withFakeTimers(() => {
		const { hub, join, told } = fleet();
		join('uploads', MAKER);
		jest.advanceTimersByTime(MAKER_GRACE_MS - 1);
		expect(hub.canFetch()).toBe(true);
		jest.advanceTimersByTime(1);
		expect([hub.canMake(), hub.canFetch()]).toEqual([true, false]);
		expect(told).toEqual([{ canMake: true, canFetch: false }]);
	}));

test('a fetcher joining turns canFetch on at once; one leaving turns it off only after the grace', () =>
	withFakeTimers(() => {
		const { hub, join, leave, told } = fleet();
		join('full', [...MAKER, FETCH]);
		jest.advanceTimersByTime(MAKER_GRACE_MS * 2);
		expect(told).toEqual([]); // inside the boot grace: nothing was ever told
		leave('full');
		join('uploads', MAKER);
		jest.advanceTimersByTime(MAKER_GRACE_MS - 1);
		expect(hub.canFetch()).toBe(true);
		jest.advanceTimersByTime(1);
		expect([hub.canMake(), hub.canFetch()]).toEqual([true, false]);
		join('fetcher', [FETCH]);
		expect(hub.canFetch()).toBe(true);
	}));

test('canFetch has the boot grace too: an uploads-only worker joining later is never told it can fetch', () =>
	withFakeTimers(() => {
		const { hub, join } = fleet();
		jest.advanceTimersByTime(MAKER_GRACE_MS);
		expect(hub.canFetch()).toBe(false);
		join('uploads', MAKER);
		expect([hub.canMake(), hub.canFetch()]).toEqual([true, false]);
	}));

test("canFetch routes by the room's fetcher, as dispatch does", () =>
	withFakeTimers(() => {
		const bareFetch = fleet();
		bareFetch.join('w1', [...MAKER, 'fetch']); // the old worker's bare token routes nothing
		jest.advanceTimersByTime(MAKER_GRACE_MS);
		expect(bareFetch.hub.canFetch()).toBe(false);
		expect(FETCH).toBe('fetch:ytdlp');
	}));
