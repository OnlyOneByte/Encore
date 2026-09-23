// WHICH FILE the master element holds on a guide-mix song.
//
// The mix is one 4-channel file whose channels 2/3 are the isolated vocals AT FULL SCALE. Played natively
// the browser downmixes and sums them into the instrumental at full volume, so the mix is only ever safe to
// hand to a CONFIRMED split graph — and `PitchShiftGraph` degrades on purpose, so a room that cannot run
// WebAudio plays the plain instrumental with no guide. Pure, so `bun test` can execute the ordering rule.
// See docs/FRONTEND.md#the-pitch-shift-graph.

import type { GuidePath } from '$lib/contract';

/**
 * Where the split graph's routing ATTEMPT has got to. Three states, not two: a boolean forces the src to be
 * decided TWICE on a mix song, and the second decision rewrites `src` on a PLAYING element — the load
 * algorithm then resets `paused` and `currentTime`, while the transport `$derived` recomputes to the
 * `'play'` it already held and never re-fires its effect. `pending` lets the src be decided ONCE.
 */
export type MixGate =
	/** The split graph is still building. No src may be committed yet. */
	| 'pending'
	/** The graph captured the element AND is genuinely a split graph. The mix is safe to play. */
	| 'routed'
	/** The attempt finished and did not produce a split graph. Play the plain instrumental, no guide. */
	| 'denied';

/** What the master `<audio>` should be pointed at, and whether the guide rides inside it. */
export interface MasterSrcPlan {
	/** The MediaStore ref to hold, or '' when there is nothing to commit yet. */
	ref: string;
	/** True only when `ref` is the 4-channel mix — never true unless the gate said `routed`. */
	mixed: boolean;
}

/**
 * @param plan         which guide this song offers (`guidePath` in shared)
 * @param instrumental the plain instrumental ref — what plays today, and the safe default
 * @param gate         how far the split-graph routing attempt has got. Read only on a `mix` plan.
 */
export function masterSrcPlan(plan: GuidePath, instrumental: string, gate: MixGate): MasterSrcPlan {
	if (!instrumental) return { ref: '', mixed: false };
	if (plan.kind !== 'mix') return { ref: instrumental, mixed: false };
	// Still building: commit NOTHING, so `hasSrc` is false, the transport stays `idle`, and the
	// `idle -> play` edge fires once when the real src lands.
	if (gate === 'pending') return { ref: '', mixed: false };
	// The ONLY branch that may hand out a 4-channel file.
	if (gate === 'routed') return { ref: plan.ref, mixed: true };
	return { ref: instrumental, mixed: false };
}

/**
 * Does this song want the graph built EAGERLY, before any transpose asks for one? A mix song's guide DOES
 * NOT EXIST until the splitter runs. A non-mix song builds lazily on the first ±key press, because at
 * keyShift 0 the audio path is the plain element and a broken graph cannot cost the room its sound.
 *
 * Kept separate from `masterSrcPlan`: this asks "should we try?" before the graph exists, that asks "may we
 * commit the src?" after.
 */
export function wantsEagerGraph(plan: GuidePath): boolean {
	return plan.kind === 'mix';
}

/**
 * Resolve a graph's state into a `MixGate` — the ONE place `isSplit` is folded in, and BOTH halves are
 * required. A MediaElementAudioSourceNode is a permanent one-per-element capture, so a room that transposed
 * a normal song leaves a NON-split graph on that slot forever; `isRouted` alone is then already true, and a
 * mix song landing there is handed to a stereo graph, downmixed, with the guide knob wired to nothing.
 *
 * @param graph the slot's master graph, or undefined when none has been built
 * @param settled has the routing attempt finished? A build in flight is `pending` regardless.
 */
export function mixGateFor(graph: { isRouted: boolean; isSplit: boolean } | undefined, settled: boolean): MixGate {
	if (!settled) return 'pending';
	if (!graph) return 'denied';
	return graph.isRouted && graph.isSplit ? 'routed' : 'denied';
}
