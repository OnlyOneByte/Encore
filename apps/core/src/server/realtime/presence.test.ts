import { describe, expect, it } from 'bun:test';
import { PresenceTracker } from './presence';
import { syncEvent } from './hub';
import { AuthoritativeState } from '../state/store';

describe('PresenceTracker', () => {
	it('a singer becomes present on their first socket and absent on their last', () => {
		const p = new PresenceTracker();
		expect(p.isOnline('s1')).toBe(false);

		expect(p.connect('s1')).toBe(true); // newly present → broadcast
		expect(p.isOnline('s1')).toBe(true);
		expect(p.online()).toEqual(['s1']);
		expect(p.count()).toBe(1);

		expect(p.disconnect('s1')).toBe(true); // newly absent → broadcast
		expect(p.isOnline('s1')).toBe(false);
		expect(p.online()).toEqual([]);
		expect(p.count()).toBe(0);
	});

	it('ref-counts multiple sockets: a second tab does not re-announce, one close does not remove', () => {
		const p = new PresenceTracker();
		expect(p.connect('s1')).toBe(true);
		expect(p.connect('s1')).toBe(false); // already present — nothing changed
		expect(p.sockets('s1')).toBe(2);

		// closing ONE of two sockets must keep them in the roster (the reconnect case)
		expect(p.disconnect('s1')).toBe(false);
		expect(p.isOnline('s1')).toBe(true);
		expect(p.sockets('s1')).toBe(1);

		expect(p.disconnect('s1')).toBe(true); // last one out
		expect(p.isOnline('s1')).toBe(false);
	});

	it('tracks singers independently and reports arrival order', () => {
		const p = new PresenceTracker();
		p.connect('angelo');
		p.connect('maya');
		p.connect('devon');
		expect(p.online()).toEqual(['angelo', 'maya', 'devon']);

		p.disconnect('maya');
		expect(p.online()).toEqual(['angelo', 'devon']);
		expect(p.count()).toBe(2);
	});

	it('disconnect for an unknown singer is a no-op, not a phantom entry', () => {
		const p = new PresenceTracker();
		expect(p.disconnect('never-connected')).toBe(false);
		expect(p.count()).toBe(0);
		expect(p.online()).toEqual([]);
	});

	it('re-joining after going fully absent works (no stuck zero entry)', () => {
		const p = new PresenceTracker();
		p.connect('s1');
		p.disconnect('s1');
		expect(p.connect('s1')).toBe(true); // announced again
		expect(p.isOnline('s1')).toBe(true);
		expect(p.sockets('s1')).toBe(1);
	});
});

describe('presence rides the sync handshake', () => {
	// A TV or phone connecting mid-party gets the roster from queue:sync, not from the next
	// presence change — otherwise a quiet room renders an empty roster until someone joins or leaves.
	it('syncEvent carries the online snapshot when a listOnline dep is given', () => {
		const p = new PresenceTracker();
		p.connect('angelo');
		p.connect('maya');
		const state = new AuthoritativeState();

		const ev = syncEvent(state, { mediaById: new Map(), listOnline: () => p.online() });
		expect(ev.online).toEqual(['angelo', 'maya']);
	});

	it('omits online entirely when no presence dep is wired, so a client keeps what it has', () => {
		const ev = syncEvent(new AuthoritativeState(), { mediaById: new Map() });
		expect(ev.online).toBeUndefined();
	});
});
