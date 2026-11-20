// `room:react` — the allowed list, the per-singer token bucket, and the TV-only topic helpers.
//
// The socket test below proves the TOPIC HELPERS (`subscribeTopicFor` + `tvTopicFor`) keep a frame off a phone
// under real Bun pub/sub. It rebuilds the subscriptions, so it does NOT prove server.ts wires them, publishes on
// the right topic, or passes the right singer and setting: that is
// tests/playwright/specs/probe/reactions-lane.spec.ts, which drives the real core and reads the phones' sockets.
import { test, expect, afterEach } from 'bun:test';
import {
	DEFAULT_ROOM_SETTINGS,
	normalizeRoomSettings,
	REACTIONS,
	roomTopic,
	roomTvTopic,
	type ServerEvent
} from '$lib/contract';
import {
	createReactionLimiter,
	handleReaction,
	reactionRefusal,
	REACTION_BURST,
	type ReactionDeps
} from '$lib/server/realtime/reactions';
import { subscribeTopicFor, tvTopicFor } from '$lib/server/realtime/room-scope';

type Reacted = Extract<ServerEvent, { type: 'room:reacted' }>;

function deps(over: Partial<ReactionDeps> = {}, sent: Reacted[] = []): ReactionDeps {
	return {
		actorSingerId: 'fan',
		currentSingerId: 'star',
		isEnabled: () => true,
		colorOf: (id) => (id === 'fan' || id === 'star' ? '#ff5cae' : null),
		limiter: createReactionLimiter(() => 0),
		publishToTv: (e) => sent.push(e),
		...over
	};
}

test('every listed reaction is accepted and goes out with the sender and their colour', () => {
	for (const r of REACTIONS) {
		const sent: Reacted[] = [];
		expect(handleReaction(r.id, deps({}, sent))).toBe(true);
		expect(sent).toEqual([{ type: 'room:reacted', singerId: 'fan', kind: r.id, color: '#ff5cae' }]);
	}
});

test('a kind off the allowed list is refused and sends nothing', () => {
	for (const bad of ['boo', '', 'CLAP', null, 42, { id: 'clap' }, '<img src=x>']) {
		const sent: Reacted[] = [];
		expect(handleReaction(bad, deps({}, sent))).toBe(false);
		expect(sent).toEqual([]);
	}
	expect(reactionRefusal('boo', deps())).toBe('unknown reaction');
});

test('refused when nobody is singing, when not joined, and for the singer cheering themselves', () => {
	expect(reactionRefusal('clap', deps({ currentSingerId: null }))).toBe('nobody is singing');
	expect(reactionRefusal('clap', deps({ actorSingerId: undefined }))).toBe('join the room first');
	expect(reactionRefusal('clap', deps({ actorSingerId: 'star' }))).toBe('you are the one singing');
	expect(reactionRefusal('clap', deps({ actorSingerId: 'ghost' }))).toBe('unknown singer');
});

test('token bucket: a burst of 3 lands, the 4th is dropped, then one more per second', () => {
	let now = 0;
	const limiter = createReactionLimiter(() => now);
	const sent: Reacted[] = [];
	const d = deps({ limiter }, sent);
	const burst = Array.from({ length: 10 }, () => handleReaction('fire', d));
	expect(burst.filter(Boolean).length).toBe(REACTION_BURST);
	expect(sent.length).toBe(3);
	now = 500;
	expect(handleReaction('fire', d)).toBe(false); // half a token is not a token
	now = 1000;
	expect(handleReaction('fire', d)).toBe(true);
	expect(handleReaction('fire', d)).toBe(false);
	// A long quiet refills to the burst and no further.
	now = 60_000;
	expect(Array.from({ length: 5 }, () => handleReaction('fire', d)).filter(Boolean).length).toBe(3);
});

test('the bucket is per singer: one guest spending theirs does not spend anyone else’s', () => {
	const limiter = createReactionLimiter(() => 0);
	const colorOf = () => '#00ff00';
	for (let i = 0; i < 5; i++) handleReaction('clap', deps({ limiter, colorOf, actorSingerId: 'a' }));
	expect(handleReaction('clap', deps({ limiter, colorOf, actorSingerId: 'b' }))).toBe(true);
});

test('switched off: nothing is sent, and the settings read happens only for a tap the bucket let through', () => {
	let reads = 0;
	const sent: Reacted[] = [];
	const d = deps({ isEnabled: () => (reads++, false) }, sent);
	for (let i = 0; i < 10; i++) expect(handleReaction('clap', d)).toBe(false);
	expect(sent).toEqual([]);
	expect(reads).toBe(REACTION_BURST);
});

test('a refused tap costs no token', () => {
	const limiter = createReactionLimiter(() => 0);
	for (let i = 0; i < 10; i++) handleReaction('boo', deps({ limiter }));
	expect(handleReaction('clap', deps({ limiter }))).toBe(true);
});

test('only a TV socket is given the TV topic, and it is not the room topic', () => {
	expect(tvTopicFor('phone', 'r1', 'r1')).toBeNull();
	expect(tvTopicFor('tv', 'r1', 'r1')).toBe(roomTvTopic('r1'));
	expect(tvTopicFor('tv', undefined, 'r1')).toBe(roomTvTopic('r1'));
	expect(roomTvTopic('r1')).not.toBe(roomTopic('r1'));
});

test('"Reactions on TV" ships ON and is a plain boolean', () => {
	expect(DEFAULT_ROOM_SETTINGS.tvReactions).toBe(true);
	expect(normalizeRoomSettings({ tvReactions: false }).tvReactions).toBe(false);
	const off = normalizeRoomSettings({ tvReactions: false });
	expect(normalizeRoomSettings({ tvReactions: 'yes' as never }, off).tvReactions).toBe(false);
});

let server: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => {
	void server?.stop(true);
	server = null;
});

test('topic helpers over real sockets: the TV receives room:reacted, a phone in the same room does not', async () => {
	const ROOM = 'r1';
	server = Bun.serve<{ role: string }>({
		port: 0,
		fetch(req, srv) {
			const role = new URL(req.url).searchParams.get('role') ?? 'phone';
			return srv.upgrade(req, { data: { role } }) ? undefined : new Response('no', { status: 400 });
		},
		websocket: {
			// The same two subscriptions server.ts makes on open.
			open(ws) {
				ws.subscribe(subscribeTopicFor(ROOM, ROOM));
				const tv = tvTopicFor(ws.data.role, ROOM, ROOM);
				if (tv) ws.subscribe(tv);
				ws.send('ready');
			},
			message() {}
		}
	});
	const s = server;
	const open = (role: string) =>
		new Promise<{ ws: WebSocket; got: string[] }>((resolve) => {
			const ws = new WebSocket(`ws://localhost:${s.port}/?role=${role}`);
			const got: string[] = [];
			ws.onmessage = (m) => (m.data === 'ready' ? resolve({ ws, got }) : got.push(String(m.data)));
		});
	const phone = await open('phone');
	const tv = await open('tv');

	expect(handleReaction('heart', deps({ publishToTv: (e) => s.publish(roomTvTopic(ROOM), JSON.stringify(e)) }))).toBe(
		true
	);
	// A room-wide frame as a control: it MUST reach the phone, or a silent phone would prove nothing.
	s.publish(roomTopic(ROOM), JSON.stringify({ type: 'singer:presence', online: [], away: [] }));
	await new Promise((r) => setTimeout(r, 100));

	expect(tv.got.map((m) => JSON.parse(m).type)).toEqual(['room:reacted', 'singer:presence']);
	expect(phone.got.map((m) => JSON.parse(m).type)).toEqual(['singer:presence']);
	phone.ws.close();
	tv.ws.close();
});
