/*
 * WHICH FILE the master element holds on a guide-mix song — and why it is not simply "the mix".
 *
 * THE TRAP THIS EXISTS FOR. The guide mix is one 4-channel file whose channels 2/3 are the isolated
 * vocals at full scale. Splitting those apart and giving them the room's guide level happens in
 * WebAudio. So the mix is only safe to play THROUGH A RUNNING GRAPH — played natively, a browser
 * downmixes four channels to the output device's two, which sums the isolated vocals into the
 * instrumental at FULL VOLUME. That is worse than every failure this feature replaces: a desynced
 * guide is a guide you can turn down, and a downmix is not.
 *
 * And a graph is not guaranteed. `PitchShiftGraph` degrades ON PURPOSE: an AudioContext created
 * without a user gesture is `suspended`, a TV wall may never receive one, and its `#buildOnce`
 * therefore refuses to create the MediaElementSource unless it has confirmed `state === 'running'` —
 * leaving the element audible on its native output rather than permanently stealing its audio into a
 * dead graph. That degrade path is correct and must stay. It is also exactly the path that must never
 * be reached holding a 4-channel src.
 *
 * Hence: the master holds the plain INSTRUMENTAL until the graph is actually routed, and only then
 * takes the mix. A room that cannot run WebAudio plays the song with no guiding track — the same
 * honest degradation an absent vocals stem already produces — instead of a room that blasts the vocals.
 *
 * ORDERING IS THE WHOLE POINT, so this is a pure function rather than a comment inside an effect. The
 * component has already been broken once by effect DECLARATION ORDER (play() was called on an element
 * whose src landed one effect later, the load algorithm reset `paused` to true, and the song sat at
 * readyState 4 forever with no error — see TvPlayer.svelte). A rule about what may be assigned WHEN is
 * the same class of hazard, and it belongs somewhere `bun test` can execute it.
 */

import type { GuidePath } from '$lib/contract';

/**
 * Where the split graph's routing ATTEMPT has got to. Three states, because two are not enough.
 *
 * A boolean "is it routed yet" forces the src to be decided TWICE on a mix song: once at mount (not
 * routed → plain instrumental, `play()` runs) and again when routing lands (→ the mix). The second
 * decision rewrites `src` on a PLAYING element, and the HTML media load algorithm then sets
 * `paused = true` and `currentTime = 0`. Nothing restarts it: the transport derived recomputes to
 * `'play'`, which is the value it already held, and a memoized `$derived` whose value does not change
 * never re-runs its effect. The room goes silent seconds into every mix song while the server still
 * reports playing — the same catastrophe `transport.ts`'s header documents, reached from a different
 * direction.
 *
 * So the src is decided ONCE, and `pending` is what makes that possible: hold nothing until the attempt
 * has SETTLED, then assign the one src that song will use for its whole turn.
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
	/**
	 * True only when `ref` is the 4-channel mix. The caller uses it to assert that the src and the graph
	 * agree — it is never true unless the gate said `routed`, so the two cannot disagree.
	 */
	mixed: boolean;
}

/**
 * @param plan         which guide this song offers (`guidePath` in shared)
 * @param instrumental the plain instrumental ref — what plays today, and the safe default
 * @param gate         how far the split-graph routing attempt has got. On a NON-mix song this is
 *                     ignored, so the caller may pass anything; only a `mix` plan reads it.
 */
export function masterSrcPlan(plan: GuidePath, instrumental: string, gate: MixGate): MasterSrcPlan {
	// Nothing playable beats everything below: an empty src is how the element is left alone.
	if (!instrumental) return { ref: '', mixed: false };
	if (plan.kind !== 'mix') return { ref: instrumental, mixed: false };
	// A mix song, and the graph is still building. Commit NOTHING — see `MixGate`. `nextVideoSrc` reports
	// no change for '' so the element simply holds nothing, `hasSrc` is false, the transport stays `idle`,
	// and the existing `idle -> play` edge fires exactly once when the real src lands a few ms later.
	if (gate === 'pending') return { ref: '', mixed: false };
	// The ONLY branch that may hand out a 4-channel file.
	if (gate === 'routed') return { ref: plan.ref, mixed: true };
	// Denied: no split graph, so the mix would be natively downmixed — vocals summed into the
	// instrumental at full volume. Play the instrumental and offer no guide.
	return { ref: instrumental, mixed: false };
}

/**
 * Does this song want the graph built EAGERLY, before any transpose asks for one?
 *
 * On a non-mix song a graph is built lazily, only once someone presses ±key, and that laziness is
 * deliberate: at keyShift 0 the audio path is byte-for-byte the plain element, so a broken graph cannot
 * cost the room its sound. A mix song inverts the tradeoff — its guide DOES NOT EXIST until the
 * splitter runs — so the graph has to be attempted up front, and `masterSrcPlan` withholds the mix src
 * until that attempt has actually succeeded.
 *
 * Separate from `masterSrcPlan` because they answer different questions at different moments: this one
 * runs BEFORE the graph exists (should we try?), the other AFTER (may we commit the src?). Folding them
 * into one function would need a parameter meaning "pretend the graph is routed", which is precisely the
 * confusion that makes the downmix reachable.
 */
export function wantsEagerGraph(plan: GuidePath): boolean {
	return plan.kind === 'mix';
}

/**
 * Resolve a graph's state into a `MixGate` — the ONE place `isSplit` is folded in.
 *
 * `isRouted` alone is not the question, and asking it alone was a real defect: a room that transposes a
 * normal song builds a NON-split graph on that slot's element, and because a MediaElementAudioSourceNode
 * is a permanent one-per-element capture the graph cannot be replaced. When a mix song lands in that slot
 * the eager build is skipped (a graph already exists), `isRouted` is already true, and a src decision that
 * asks only `isRouted` hands the 4-channel file to a stereo graph. The destination then applies the spec's
 * quad→stereo downmix, summing the isolated vocals into the instrumental at −6 dB with the guide knob
 * wired to nothing — and every later mix song in that slot inherits it for the life of the page.
 *
 * @param graph the slot's master graph, or undefined when none has been built
 * @param settled has the routing attempt finished? While a build is in flight the answer is `pending`
 *                regardless of what the graph currently reports.
 */
export function mixGateFor(graph: { isRouted: boolean; isSplit: boolean } | undefined, settled: boolean): MixGate {
	if (!settled) return 'pending';
	if (!graph) return 'denied';
	// BOTH halves. Routed says the element is captured and the context runs; split says the graph actually
	// pulls the four channels apart. Either one alone is a downmix.
	return graph.isRouted && graph.isSplit ? 'routed' : 'denied';
}
