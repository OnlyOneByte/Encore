import { expect, it } from 'bun:test';
import { isUnreachableJoinOrigin } from './screen';

it('isUnreachableJoinOrigin: flags the IPv4 loopback block 127.0.0.0/8', () => {
	expect(isUnreachableJoinOrigin('http://127.0.0.1:3000')).toBe(true);
	expect(isUnreachableJoinOrigin('http://127.0.0.1:3000/join')).toBe(true);
	expect(isUnreachableJoinOrigin('http://127.255.255.254:5180')).toBe(true);
	expect(isUnreachableJoinOrigin('http://127.10.0.1')).toBe(true);
});

it('isUnreachableJoinOrigin: flags localhost regardless of case', () => {
	expect(isUnreachableJoinOrigin('http://localhost:3000')).toBe(true);
	expect(isUnreachableJoinOrigin('http://LOCALHOST:3000')).toBe(true);
});

it('isUnreachableJoinOrigin: flags the IPv6 loopback ::1', () => {
	expect(isUnreachableJoinOrigin('http://[::1]:3000')).toBe(true);
});

it('isUnreachableJoinOrigin: flags a single-label bare hostname a phone cannot resolve off-box', () => {
	expect(isUnreachableJoinOrigin('http://wsl:3000')).toBe(true);
	expect(isUnreachableJoinOrigin('http://desktop-abc:5180/join')).toBe(true);
});

it('isUnreachableJoinOrigin: treats a routable LAN IP as reachable', () => {
	expect(isUnreachableJoinOrigin('http://192.168.1.20:3000')).toBe(false);
	expect(isUnreachableJoinOrigin('http://10.69.1.169:3000/join')).toBe(false);
});

it('isUnreachableJoinOrigin: treats a real dotted host as reachable', () => {
	expect(isUnreachableJoinOrigin('https://party.example.com')).toBe(false);
	expect(isUnreachableJoinOrigin('https://angryang-encore.v.tunnels.lab.aws.dev')).toBe(false);
});

it('isUnreachableJoinOrigin: a routable IPv6 literal is reachable (only ::1 is loopback)', () => {
	expect(isUnreachableJoinOrigin('http://[2001:db8::1]:3000')).toBe(false);
});

it('isUnreachableJoinOrigin: an absent or empty origin is not a warning — there is nothing to advertise yet', () => {
	expect(isUnreachableJoinOrigin(null)).toBe(false);
	expect(isUnreachableJoinOrigin(undefined)).toBe(false);
	expect(isUnreachableJoinOrigin('')).toBe(false);
});

it('isUnreachableJoinOrigin: an unparseable string is assumed reachable rather than hiding a QR that might work', () => {
	expect(isUnreachableJoinOrigin('not a url')).toBe(false);
});
