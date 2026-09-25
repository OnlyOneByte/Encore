// What separation models the CONNECTED WORKERS say they can run, unioned for a picker.
//
// Pure over worker sessions, so it is testable without a hub, a socket or a worker.
//
// WHY A UNION AND NOT AN INTERSECTION. With a mixed fleet — one box with the model zoo installed, one
// without — an intersection would hide every zoo model the moment a plain worker connected, which is a
// menu that silently shrinks for reasons an operator cannot see. A union shows everything some worker can
// run, and `requiredCapability` already routes each job to a worker that has the chosen model: a token
// nobody offers makes `hasCapableWorker` false, which surfaces as "unservable" rather than as a job handed
// to a box that then refuses it.
//
// So `workerCount` is carried per model. One worker offering a model is a real offer AND a single point of
// failure, and a picker should be able to say so.

import type { OfferedModel } from '../../contract';
import type { WorkerSession } from './registry';

export type { OfferedModel };

/**
 * Every model any connected worker offers, best published score first.
 *
 * Duplicate tokens across workers are merged. The richest record wins rather than the first seen: two
 * workers on different `audio-separator` versions can describe the same checkpoint with and without a
 * score, and dropping the scored one would make the list look emptier than it is.
 */
export function offeredModels(workers: WorkerSession[]): OfferedModel[] {
	const merged = new Map<string, OfferedModel>();
	for (const worker of workers) {
		for (const offer of worker.separators ?? []) {
			if (!offer.token) continue;
			const existing = merged.get(offer.token);
			if (!existing) {
				merged.set(offer.token, { ...offer, workerCount: 1 });
				continue;
			}
			existing.workerCount += 1;
			// Fill gaps only; never overwrite a value that is already there, so the result does not depend on
			// worker iteration order.
			if (existing.upstreamInstrumentalSdr === undefined && offer.upstreamInstrumentalSdr !== undefined)
				existing.upstreamInstrumentalSdr = offer.upstreamInstrumentalSdr;
			if (existing.upstreamVocalsSdr === undefined && offer.upstreamVocalsSdr !== undefined)
				existing.upstreamVocalsSdr = offer.upstreamVocalsSdr;
		}
	}
	return [...merged.values()].sort(
		(a, b) =>
			(b.upstreamInstrumentalSdr ?? -Infinity) - (a.upstreamInstrumentalSdr ?? -Infinity) ||
			a.token.localeCompare(b.token)
	);
}

/**
 * Is this token currently runnable by someone? Used to warn on a saved setting whose worker has left.
 *
 * A stale `upgradeModel` is not an error — the worker may reconnect — but it IS worth showing, because
 * otherwise a queued upgrade sits unservable with nothing on screen explaining why.
 */
export function isOffered(token: string, workers: WorkerSession[]): boolean {
	return workers.some((w) => (w.separators ?? []).some((o) => o.token === token));
}
