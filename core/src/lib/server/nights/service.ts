// Writing a turn into its singer's night, and whose history a /api/me/nights call may touch. See docs/SERVER.md#your-night.

import type { Cookies } from '@sveltejs/kit';
import type { EncoreApp } from '../app';
import type { QueueEntry } from '../../contract';
import { keptCaller } from '../people/keep';
import { SESSION_COOKIE, type StoredSinger } from '../singers/repository';
import { NIGHT_SWEEP_EVERY_MS, type HistoryOwner, type TurnEnd } from './repository';

/** The hub's `onTurnEnded`. What the turn ended with is read now; only the write waits for `defer`, so it lands
 *  after the handoff's frames are flushed. Never throws: a lost row is not worth a broken handoff. */
export function recordTurn(
	app: EncoreApp,
	entry: QueueEntry,
	end: TurnEnd,
	endedWith: { keyShift: number; guideLevel: number | null },
	defer: (write: () => void) => unknown = setImmediate
): void {
	const counts = app.nights.take(entry.id);
	const endedAt = app.now();
	const personAtEnd = app.singers.byId(entry.singerId)?.personId ?? null;
	defer(() => {
		try {
			const singer = app.singers.byId(entry.singerId);
			// A Delete me between the end and this write unlinked the singer; the turn was the person's, so it goes too.
			if (!singer || (personAtEnd && !app.people.exists(personAtEnd))) return;
			if (!app.nights.isRecording([singer.id, singer.personId])) return;
			app.nights.record(
				{
					roomId: singer.roomId,
					singerId: singer.id,
					personId: singer.personId,
					mediaId: entry.mediaId,
					entryId: entry.id,
					startedAt: app.playLog.startedAt(entry.id) ?? endedAt,
					endedAt,
					end,
					...endedWith
				},
				counts
			);
		} catch (err) {
			console.warn(`[core] could not record a turn in its night: ${(err as Error).message}`);
		}
	});
}

/** Tonight's singer from the session cookie, and their kept person only when this phone's device cookie names them,
 *  as for Delete me. Never an id from the URL or the body: a copied singer cookie must not become the whole person. */
export function historyOwner(
	app: EncoreApp,
	cookies: Pick<Cookies, 'get' | 'set'>,
	req: { request: Request; url: URL }
): { me: StoredSinger; owner: HistoryOwner } | null {
	const me = app.singers.bySessionToken(cookies.get(SESSION_COOKIE));
	if (!me) return null;
	const personId = me.personId ? (keptCaller(app, cookies, req)?.device.person.id ?? null) : null;
	return { me, owner: { singerId: me.id, personId } };
}

/** For a periodic tick: the guest sweep at most once a day, the first a day after `since` (boot runs its own). */
export function dailyNightSweep(app: EncoreApp, since: number): () => void {
	let last = since;
	return () => {
		if (app.now() - last < NIGHT_SWEEP_EVERY_MS) return;
		last = app.now();
		sweepGuestNights(app);
	};
}

export function sweepGuestNights(app: EncoreApp): void {
	try {
		const gone = app.nights.sweepGuests(app.now());
		if (gone > 0) console.log(`[core] guest nights: deleted ${gone} turn(s) older than 90 days`);
	} catch (err) {
		console.warn(`[core] guest nights sweep skipped: ${(err as Error).message}`);
	}
	// The same 90-day rule for a guest's saved songs, in its own try so one table's failure never skips the other.
	try {
		const gone = app.savedSongs.sweepGuests(app.now());
		if (gone > 0) console.log(`[core] guest saved songs: deleted ${gone} after 90 days unused`);
	} catch (err) {
		console.warn(`[core] guest saved songs sweep skipped: ${(err as Error).message}`);
	}
}
