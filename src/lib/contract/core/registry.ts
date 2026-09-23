// ONE shape for the flat id-keyed registries this package is full of, so a new one cannot ship with a guard
// and no accessor.
//
// SCOPE: only FLAT, id-keyed enum registries whose members share `{ id, ... }`. Deliberately not used for
// `SEPARATOR_ENGINES` (two-level, with quality ranks and capability routing) or `SINGER_COLORS` (a palette
// whose legibility is computed rather than enumerated) — folding those in would over-generalise.

/** The minimum a registry member must carry: a stable string id. */
export interface HasId {
	id: string;
}

/** The uniform surface every flat registry exposes, built from its member array exactly once. */
export interface Registry<T extends HasId, Id extends string = T['id']> {
	/** The members, in declaration order. */
	readonly all: readonly T[];
	/** The member with this id, or undefined. */
	get(id: string): T | undefined;
	/** Is this a real id? Narrows an `unknown` to the id union. */
	isValid(id: unknown): id is Id;
	/** Every id, in declaration order. */
	readonly ids: readonly Id[];
}

/** Build a {@link Registry} from a member array, computing the id→member map once so every registry gets the
 *  same accessor and guard without hand-writing either. */
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
