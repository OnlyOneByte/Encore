// The TV lobby and the phone strip summarise the rotation in one line, and both used to count every unplayable turn as
// "Making karaoke…". `waitingTurns` folds `queueCardKind` instead, so each outcome the card can show lands in exactly
// one bucket, and `stuckTurnsLines` words the bucket both surfaces print.
import { type Media, type MediaStatus } from '$lib/contract';
import { queueCardKind, waitingTurns, type QueueCardKind } from '$lib/readiness';
import { STALLED_TURN_LABEL, processingGroupHeading, stuckTurnsLines } from '$lib/phrasing/process-phrasing';
import { expect, test } from 'bun:test';

const m = (id: string, over: Partial<Media> = {}): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'vid-' + id,
	title: id,
	durationSec: 200,
	stemStatus: 'none',
	...over
});
const singable = (id: string) =>
	m(id, { stemStatus: 'ready', lyricsStatus: 'ready', instrumentalRef: `derived/stems/${id}-instrumental.flac` });

type Live = { status: MediaStatus; unservable?: boolean };
const OUTCOMES: { name: string; media: Media; live?: Live; kind: QueueCardKind }[] = [
	{ name: 'ready', media: singable('ready'), kind: 'plain' },
	{
		name: 'in flight',
		media: m('making', { stemStatus: 'queued' }),
		live: { status: 'separating' },
		kind: 'processing'
	},
	{ name: 'failed', media: m('failed'), live: { status: 'failed' }, kind: 'failed' },
	{
		name: 'no maker',
		media: m('nomaker', { stemStatus: 'queued' }),
		live: { status: 'queued', unservable: true },
		kind: 'stalled'
	},
	{ name: 'dead turn after a reload', media: m('dead'), kind: 'stalled' }
];

for (const o of OUTCOMES) {
	test(`queueCardKind: ${o.name} → ${o.kind}`, () => {
		expect(queueCardKind(o.media, o.live)).toBe(o.kind);
	});
}

function summarise(picks: { singerId: string; outcome: string }[]) {
	const byName = new Map(OUTCOMES.map((o) => [o.name, o]));
	const queued = picks.map((p) => ({ singerId: p.singerId, mediaId: byName.get(p.outcome)!.media.id }));
	const media = new Map(OUTCOMES.map((o) => [o.media.id, o]));
	return waitingTurns(
		queued,
		(id) => media.get(id)?.media,
		(id) => media.get(id)?.live
	);
}

test('waitingTurns: only an in-flight turn counts as making — the lobby bug was counting all five', () => {
	const w = summarise(OUTCOMES.map((o, i) => ({ singerId: `s${i}`, outcome: o.name })));
	expect(w.making).toBe(1);
	// failed, no maker and the dead turn: the three kinds nothing is making karaoke for, in rotation order.
	expect(w.stuckSingerIds).toEqual(['s2', 's3', 's4']);
	expect(w.noMaker).toBe(true);
});

test('waitingTurns: a failure is not "no maker", and a singer is named once', () => {
	const w = summarise([
		{ singerId: 'theo', outcome: 'failed' },
		{ singerId: 'theo', outcome: 'dead turn after a reload' }
	]);
	expect(w).toEqual({ making: 0, stuckSingerIds: ['theo'], noMaker: false });
});

test('waitingTurns: a ready turn is neither making nor stuck', () => {
	expect(summarise([{ singerId: 'a', outcome: 'ready' }])).toEqual({ making: 0, stuckSingerIds: [], noMaker: false });
});

test('waitingTurns: a failure the TTL called because no worker could run it is still no maker', () => {
	// The 120s terminal frame carries its cause; without it the room was sent to "pick another" — a second dead end.
	const w = waitingTurns(
		[{ singerId: 'maya', mediaId: 'x' }],
		() => m('x'),
		() => ({ status: 'failed', unservable: true })
	);
	expect(w).toEqual({ making: 0, stuckSingerIds: ['maya'], noMaker: true });
});

/* THE LINE EVERY SCREEN PRINTS, from the queue to the words: what probe p21 reads off the TV and both strips, held
   here too so a revert of the fold or the copy fails `bun run gates` and not only a probe someone has to run. */
const names: Record<string, string> = { maya: 'Maya', theo: 'Theo' };
const linesFor = (picks: { singerId: string; outcome: string }[], me?: string) =>
	stuckTurnsLines(summarise(picks), (id) => names[id] ?? 'Someone', me);

test('the room line: no maker outranks a failure, and names the way that still works', () => {
	expect(
		linesFor([
			{ singerId: 'maya', outcome: 'no maker' },
			{ singerId: 'theo', outcome: 'failed' }
		])
	).toEqual({ headline: "Can't make new karaoke right now", next: 'Pick a ready song on your phone' });
});

test('the room line: one singer is named on the TV and addressed as "your" on their own phone', () => {
	const failed = [{ singerId: 'maya', outcome: 'failed' }];
	expect(linesFor(failed)).toEqual({
		headline: "Maya's song didn't work",
		next: 'Maya, try again or pick another on your phone'
	});
	expect(linesFor(failed, 'maya')?.headline).toBe("Your song didn't work. Try again or pick another.");
	expect(linesFor(failed, 'theo')?.headline).toBe("Maya's song didn't work");
});

test('the room line: several singers get one line for the room', () => {
	expect(
		linesFor([
			{ singerId: 'maya', outcome: 'failed' },
			{ singerId: 'theo', outcome: 'dead turn after a reload' }
		])?.headline
	).toBe("Those songs didn't work");
});

// Proposal 24: the room's `canMake` makes "no maker" true before any turn has died, so the first pick is not the one
// that finds out.
test('waitingTurns: with nothing able to make karaoke, an empty queue is already no maker', () => {
	expect(
		waitingTurns(
			[],
			() => undefined,
			() => undefined,
			false
		)
	).toEqual({
		making: 0,
		stuckSingerIds: [],
		noMaker: true
	});
	// A caller that passes nothing keeps today's answer.
	expect(
		waitingTurns(
			[],
			() => undefined,
			() => undefined
		).noMaker
	).toBe(false);
	// A plain failure under no maker is no maker: the next pick hits the same wall.
	const failedOnly = OUTCOMES.find((o) => o.name === 'failed')!;
	expect(
		waitingTurns(
			[{ singerId: 'maya', mediaId: 'failed' }],
			() => failedOnly.media,
			() => failedOnly.live,
			false
		)
	).toEqual({ making: 0, stuckSingerIds: ['maya'], noMaker: true });
});

// #1235: the first paint already says no maker, rather than "Making karaoke…" until the turn's own `unservable` lands.
test('waitingTurns: an in-flight turn under no maker is stuck, not making (#1235)', () => {
	const inFlight = OUTCOMES.find((o) => o.name === 'in flight')!;
	const cooking = waitingTurns(
		[{ singerId: 'maya', mediaId: 'cooking' }],
		() => inFlight.media,
		() => inFlight.live,
		false
	);
	expect(cooking).toEqual({ making: 0, stuckSingerIds: ['maya'], noMaker: true });
	expect(stuckTurnsLines(cooking, () => 'Maya')?.headline).toBe("Can't make new karaoke right now");
});

// The /queue card reads the same verdict, so it cannot say "Making karaoke… %" under the dock's "Can't make new
// karaoke right now", say with a stems-only worker separating it (#1255 review).
test('queueCardKind: an in-flight card under no maker is stalled, and the default keeps it in flight', () => {
	const inFlight = OUTCOMES.find((o) => o.name === 'in flight')!;
	expect(queueCardKind(inFlight.media, inFlight.live, false)).toBe('stalled');
	expect(queueCardKind(undefined, { status: 'separating' }, false)).toBe('stalled');
	expect(queueCardKind(inFlight.media, inFlight.live)).toBe('processing');
	expect(queueCardKind(undefined, { status: 'separating' })).toBe('processing');
});

test('the room line: no maker needs no stuck turn, but a turn being made still wins', () => {
	const empty = { making: 0, stuckSingerIds: [], noMaker: true };
	expect(stuckTurnsLines(empty, () => 'Someone')).toEqual({
		headline: "Can't make new karaoke right now",
		next: 'Pick a ready song on your phone'
	});
	expect(stuckTurnsLines({ ...empty, making: 1 }, () => 'Someone')).toBeNull();
});

test('the room line is silent while anything is being made, or nothing is stuck', () => {
	// One cooking turn beside a dead one: "Making karaoke…" is still true, so no stuck line.
	expect(
		linesFor([
			{ singerId: 'maya', outcome: 'failed' },
			{ singerId: 'theo', outcome: 'in flight' }
		])
	).toBeNull();
	expect(linesFor([{ singerId: 'maya', outcome: 'ready' }])).toBeNull();
});

test('the stalled-card line is one short guest sentence, with the ASCII apostrophe', () => {
	// Pinned word for word: the line every stalled card, Sing-tab row and group heading prints, so a reworded or
	// re-curled copy fails here rather than only in a probe.
	expect(STALLED_TURN_LABEL).toBe("Can't make this one right now");
	expect(STALLED_TURN_LABEL).not.toMatch(/[‘’“”]/);
});

test('the Sing-tab group heading claims "Making karaoke…" only while some row really is being made', () => {
	expect(processingGroupHeading([true, false])).toBe('Making karaoke…');
	expect(processingGroupHeading([false])).toBe("Can't make this one right now");
	// Over a group, the plural: the singular read wrong over two dead songs.
	expect(processingGroupHeading([false, false])).toBe("Can't make these right now");
});
