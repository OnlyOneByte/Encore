import { expect, it } from 'bun:test';
import { read } from '$test';
import { clockFrame, pongFrame } from '$lib/server/realtime/tv-clock';

const playing = { currentEntryId: 'e1', isPlaying: true };

it("clockFrame relays a playing report on the current song, stamped with core's time", () => {
	expect(clockFrame({ status: 'playing', positionSec: 12.5, entryId: 'e1' }, playing, 1000)).toEqual({
		type: 'tv:clock',
		entryId: 'e1',
		positionSec: 12.5,
		serverAt: 1000
	});
});

it('clockFrame relays nothing a copy should not follow', () => {
	const at = 1000;
	expect(clockFrame({ status: 'ended', positionSec: 1, entryId: 'e1' }, playing, at)).toBeNull();
	expect(clockFrame({ status: 'playing', positionSec: 1, entryId: 'old' }, playing, at)).toBeNull();
	expect(clockFrame({ status: 'playing', positionSec: 1 }, playing, at)).toBeNull();
	const paused = { ...playing, isPlaying: false };
	expect(clockFrame({ status: 'playing', positionSec: 1, entryId: 'e1' }, paused, at)).toBeNull();
	for (const bad of [Number.NaN, Infinity, -1, '3' as unknown as number])
		expect(clockFrame({ status: 'playing', positionSec: bad, entryId: 'e1' }, playing, at)).toBeNull();
});

it('pongFrame echoes a finite t0 and refuses anything else', () => {
	expect(pongFrame(42.5, 1000)).toEqual({ type: 'tv:pong', t0: 42.5, serverAt: 1000 });
	for (const bad of [undefined, null, 'x', Number.NaN, {}]) expect(pongFrame(bad, 1000)).toBeNull();
});

// A copy may only RECEIVE the clock: it is fed by the seat's telemetry alone, and a ping is answered to its sender only.
it('server.ts feeds tv:clock from the seat only and answers tv:ping to the origin', () => {
	const src = read('server.ts');
	const telemetry = src.split("case 'tv:telemetry': {")[1]!.split('case ')[0]!;
	expect(telemetry.indexOf('if (!seated(ws)) break;')).toBeLessThan(telemetry.indexOf('clockFrame('));
	expect(telemetry).toContain('ws.publish(roomTvTopic(app.activeRoomId), JSON.stringify(clock))');
	const ping = src.split("case 'tv:ping': {")[1]!.split('case ')[0]!;
	expect(ping).toContain("if (ws.data.role !== 'tv') break;");
	expect(ping).toContain('ws.send(JSON.stringify(pong))');
	expect(ping).not.toContain('publish');
});
