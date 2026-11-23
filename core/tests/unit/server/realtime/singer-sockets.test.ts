// A Leave reaches every socket of the leaver (proposal 20). Two tabs of one phone share the cookie, so they hold two
// sockets as the same singer; leaving from one used to leave the other queuing songs as a guest who had gone home.
import { test, expect } from 'bun:test';
import { SingerSockets, type BoundSocket } from '$lib/server/realtime/singer-sockets';
import { validateCommand, type HubDeps } from '$lib/server/realtime/hub';
import { AuthoritativeState } from '$lib/server/state/store';
import { EMPTY_SONG_PROFILE, LEFT_CLOSE_CODE, ulid, type ClientCommand, type Media } from '$lib/contract';

type Fake = BoundSocket & { closed: number | null };
const sock = (role: string, singerId?: string): Fake => ({
	data: { role, singerId },
	closed: null,
	close(code) {
		this.closed = code ?? 1000;
	}
});

const media: Media = {
	id: 'm1',
	source: 'youtube',
	sourceRef: 'x',
	title: 'm1',
	durationSec: 100,
	stemStatus: 'ready',
	lyricsStatus: 'ready',
	instrumentalRef: 'derived/stems/i-instrumental.flac',
	songProfile: EMPTY_SONG_PROFILE
};
/** What server.ts does with a frame: the actor is whatever singer the socket carries NOW. */
const addOn = (ws: Fake) => {
	const deps: HubDeps = {
		state: new AuthoritativeState(),
		publish: () => {},
		mediaById: new Map([['m1', media]]),
		actorSingerId: ws.data.singerId
	};
	const cmd: ClientCommand = {
		clientOpId: ulid(),
		op: {
			op: 'add',
			entry: { id: 'q1', mediaId: 'm1', singerId: 'maya', status: 'queued', rotationSeq: -1, addedAt: 1 }
		}
	};
	return validateCommand(cmd, deps);
};

test('a leave closes every phone socket of that singer, and a frame on one is refused', () => {
	const reg = new SingerSockets<Fake>();
	const tabA = sock('phone', 'maya');
	const tabB = sock('phone', 'maya');
	reg.add(tabA);
	reg.add(tabB);
	expect(addOn(tabA)).toBeNull();

	reg.release('maya');
	expect(tabA.closed).toBe(LEFT_CLOSE_CODE);
	expect(tabB.closed).toBe(LEFT_CLOSE_CODE);
	// An add already on the wire is handled before the close lands: it acts as nobody now.
	expect(addOn(tabA)).toBe('join the room first');
});

test("another singer's sockets are untouched", () => {
	const reg = new SingerSockets<Fake>();
	const maya = sock('phone', 'maya');
	const theo = sock('phone', 'theo');
	reg.add(maya);
	reg.add(theo);
	reg.release('maya');
	expect(theo.closed).toBeNull();
	expect(theo.data.singerId).toBe('theo');
});

test('a TV socket opened with the cookie stops acting as them but stays connected', () => {
	const reg = new SingerSockets<Fake>();
	const tv = sock('tv', 'maya');
	reg.add(tv);
	reg.release('maya');
	expect(tv.closed).toBeNull();
	expect(tv.data.singerId).toBeUndefined();
});

test('a socket that closed on its own is forgotten, and a spectator is never tracked', () => {
	const reg = new SingerSockets<Fake>();
	const gone = sock('phone', 'maya');
	const spectator = sock('phone');
	reg.add(gone);
	reg.add(spectator);
	reg.remove(gone);
	reg.release('maya');
	expect(gone.closed).toBeNull();
	expect(spectator.closed).toBeNull();
});
