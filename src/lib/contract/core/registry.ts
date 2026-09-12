// ONE shape for the flat id-keyed registries this package is full of.
//
// WHY THIS EXISTS. Eleven registries accreted across nine PRs in three different shapes: the full
// pattern (a `{id,label,note}[]` array + a `getX` accessor + an `isX` guard), a PARTIAL shape with a
// guard but no accessor (the three TV_* style lists), and a bare string array. A review flagged the
// drift; the very next PR added a fourth partial one (TV_VISUALIZERS) — a guard, no accessor — because
// nothing made the accessor the path of least resistance. This helper is that path: build the id-keyed
// map once, and hand back `all` / `get` / `isValid` / `ids` so a new flat enum registry cannot ship
// without its accessor.
//
// SCOPE. This is ONLY for flat, id-keyed enum registries whose members share `{ id, ... }`. It is
// deliberately NOT used for SEPARATOR_ENGINES (a two-level engine→models structure with quality ranks
// and capability routing) or SINGER_COLORS (a bare palette whose legibility is computed in OKLab, not
// an enum) — folding those in would manufacture the over-generalisation the review otherwise warns
// against.

/** The minimum a registry member must carry: a stable string id. */
export interface HasId {
	id: string;
}

/** The uniform surface every flat registry exposes, built from its member array exactly once. */
export interface Registry<T extends HasId, Id extends string = T['id']> {
	/** The members, in declaration order. The same array reference, frozen upstream as `readonly`. */
	readonly all: readonly T[];
	/** The member with this id, or undefined. O(1) — backed by a Map built at construction. */
	get(id: string): T | undefined;
	/** Is this a real id in the registry? Narrows an `unknown` to the id union. */
	isValid(id: unknown): id is Id;
	/** Every id, in declaration order. */
	readonly ids: readonly Id[];
}

/**
 * Build a {@link Registry} from a member array. The id→member Map and the id list are computed once,
 * here, so every registry gets the same O(1) accessor and the same guard without hand-writing either.
 */
export function makeRegistry<const T extends HasId>(members: readonly T[]): Registry<T, T['id']> {
	const byId = new Map<string, T>(members.map((m) => [m.id, m]));
	const ids = members.map((m) => m.id) as readonly T['id'][];
	return {
		all: members,
		get: (id: string) => byId.get(id),
		isValid: (id: unknown): id is T['id'] => typeof id === 'string' && byId.has(id),
		ids
	};
}
