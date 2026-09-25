// WHICH FILE the master element holds on a guide-mix song.
//
// The mix is one 4-channel file whose channels 2/3 are the isolated vocals AT FULL SCALE, so played natively the
// browser downmixes and sums them into the instrumental at full volume: it is only ever safe to hand to a CONFIRMED
// split graph. See docs/FRONTEND.md#the-pitch-shift-graph.

import type { GuidePath } from '$lib/contract';

/**
 * Three states, not two: a boolean forces the src to be decided TWICE on a mix song, and the second decision rewrites
 * `src` on a PLAYING element — the load algorithm resets `paused` and `currentTime`, while the memoized transport keeps
 * its `'play'` value and never re-fires. `pending` lets the src be decided ONCE.
 */
export type MixGate =
	/** Still building. No src may be committed yet. */
	| 'pending'
	/** Captured the element AND genuinely a split graph. The mix is safe to play. */
	| 'routed'
	/** Finished without producing a split graph. Play the plain instrumental, no guide. */
	| 'denied';

export interface MasterSrcPlan {
	/** The MediaStore ref to hold, or '' when there is nothing to commit yet. */
	ref: string;
	/** True only when `ref` is the 4-channel mix — never true unless the gate said `routed`. */
	mixed: boolean;
}

/** `instrumental` is the safe default; `gate` is read only on a `mix` plan. */
export function masterSrcPlan(plan: GuidePath, instrumental: string, gate: MixGate): MasterSrcPlan {
	if (!instrumental) return { ref: '', mixed: false };
	if (plan.kind !== 'mix') return { ref: instrumental, mixed: false };
	// Still building: commit NOTHING, so the transport stays `idle` and the `idle -> play` edge fires once when the real
	// src lands.
	if (gate === 'pending') return { ref: '', mixed: false };
	// The ONLY branch that may hand out a 4-channel file.
	if (gate === 'routed') return { ref: plan.ref, mixed: true };
	return { ref: instrumental, mixed: false };
}

/**
 * A mix song's guide DOES NOT EXIST until the splitter runs. A non-mix song builds lazily on the first ±key press,
 * because at keyShift 0 the audio path is the plain element and a broken graph cannot cost the room its sound. Separate
 * from `masterSrcPlan`: this asks "should we try?", that asks "may we commit the src?".
 */
export function wantsEagerGraph(plan: GuidePath): boolean {
	return plan.kind === 'mix';
}

/**
 * The ONE place `isSplit` is folded in, and BOTH halves are required: the capture is permanent and one per element, so
 * a room that transposed a normal song leaves a NON-split graph on that slot forever, where `isRouted` alone is already
 * true and a mix song landing there is downmixed with the guide knob wired to nothing.
 */
export function mixGateFor(graph: { isRouted: boolean; isSplit: boolean } | undefined, settled: boolean): MixGate {
	if (!settled) return 'pending';
	if (!graph) return 'denied';
	return graph.isRouted && graph.isSplit ? 'routed' : 'denied';
}
