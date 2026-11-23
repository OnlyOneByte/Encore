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
	let flips = 0;
	const hub = new WorkerHub({
		jobs: new JobRepository(migratedDb()),
		registry,
		mediaById: new Map(),
		toWorker: () => {},
		broadcast: () => {},
		getSettings: settings ? () => settings : undefined,
		now: () => 0,
		queueEntries: () => [],
		onCanMakeChange: () => flips++
	});
	const join = (workerId: string, capabilities = MAKER) =>
		hub.handle({ type: 'worker:hello', workerId, capabilities, concurrency: 1, version: '1' });
	const leave = (workerId: string) => hub.workerLeft(() => registry.remove(workerId));
	return { hub, join, leave, flips: () => flips };
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

test('the sync carries the verdict as one boolean, and nothing about the workers', () => {
	const ev = syncEvent(new AuthoritativeState(), { mediaById: new Map(), canMake: () => false });
	expect(ev.canMake).toBe(false);
	expect(Object.keys(ev).filter((k) => /worker|host/i.test(k))).toEqual([]);
	// A caller that cannot know omits it, which a client reads as "no info".
	expect(syncEvent(new AuthoritativeState(), { mediaById: new Map() }).canMake).toBeUndefined();
});
