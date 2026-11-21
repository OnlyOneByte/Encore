// The two entry ops the on-deck card sends. OWNER ONLY, unlike `remove`/`move`, which have an `-any` capability:
// a preset is the singer's own voice, and "Not yet" spends the singer's own turn — nobody else may do either.
// Values are REJECTED, never clamped: a server-side rewrite would desync the sender's optimistic copy.
// "Once per entry" fences THIS op only. The owner can still `move-to-index` their own entry anywhere, which is fine
// on a trusted LAN; `deferred` itself is server-owned, and the hub strips it from a client add.

import { MAX_KEY_SHIFT, clampGuideLevel, type QueueOp } from '../../contract';
import type { HubDeps } from './hub';

export type OnDeckOp = Extract<QueueOp, { op: 'set-entry-prefs' | 'not-yet' }>;

/** Shared with the `add` arm, which may carry a remembered key. `undefined` is "no preset" and always valid. */
export function entryPrefsRefusal(p: { keyShift?: unknown; guideLevel?: unknown }): string | null {
	const { keyShift, guideLevel } = p;
	if (keyShift !== undefined && !(Number.isInteger(keyShift) && Math.abs(keyShift as number) <= MAX_KEY_SHIFT))
		return `invalid keyShift: ${String(keyShift)}`;
	if (
		guideLevel !== undefined &&
		guideLevel !== null &&
		(typeof guideLevel !== 'number' || clampGuideLevel(guideLevel) !== guideLevel)
	)
		return `invalid guideLevel: ${String(guideLevel)}`;
	return null;
}

export function onDeckOpRefusal(op: OnDeckOp, deps: HubDeps): string | null {
	const target = deps.state.entries.find((e) => e.id === op.id);
	if (!target) return `unknown entry: ${op.id}`;
	if (target.singerId !== deps.actorSingerId) return 'only the singer can change this entry';
	// A playing song's key is the `key` player command's; a preset on it would never apply.
	if (target.status !== 'queued') return 'that song is not waiting';
	if (op.op === 'set-entry-prefs') {
		// Both REQUIRED here: the op is absolute, and an absent field would read as "reset" on apply.
		if (op.keyShift === undefined || op.guideLevel === undefined) return 'missing keyShift or guideLevel';
		return entryPrefsRefusal(op);
	}
	if (target.deferred) return 'not yet was already used for this song';
	const queued = deps.state.entries.filter((e) => e.status === 'queued').sort((a, b) => a.rotationSeq - b.rotationSeq);
	const from = queued.findIndex((e) => e.id === op.id);
	// Strictly BACK and strictly inside the list: with nobody behind there is nobody to let go first.
	if (!Number.isInteger(op.toIdx) || op.toIdx <= from || op.toIdx >= queued.length)
		return `invalid toIdx: ${String(op.toIdx)}`;
	// The entry let through must be someone else's: letting your own next pick through lets nobody go first.
	if (queued[op.toIdx]!.singerId === target.singerId) return 'that is your own song';
	return null;
}
