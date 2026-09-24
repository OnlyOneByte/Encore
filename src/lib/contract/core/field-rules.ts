// The per-field degradation kit both settings layers are written in. Untrusted input degrades PER FIELD
// against the CURRENT value and is never rejected wholesale, so refusing one bad field cannot wipe an
// unrelated valid choice. One rule BUILDER per shape of field, so a field is named once — in its layer's
// table — instead of three times. See docs/SERVER.md#contract-boundary.

/** One field's rule — the untrusted value and the CURRENT value in, the value to store out. */
export type FieldRule<V> = (input: unknown, base: V) => V;

/** A rule for EVERY field of `S`: a new settings field is a compile error until it has one. */
export type FieldRules<S> = { [K in keyof S]: FieldRule<S[K]> };

/** Walk the table. Key order follows the TABLE, so each one is declared in its interface's field order. */
export function normalizeFields<S extends object>(
	rules: FieldRules<S>,
	input: Partial<S> | null | undefined,
	base: S
): S {
	const out = {} as S;
	// Generic in the key, so each rule is applied at its own field's type with no cast.
	const applyRule = <K extends keyof S>(key: K): void => {
		out[key] = rules[key](input?.[key], base[key]);
	};
	for (const key of Object.keys(rules) as (keyof S)[]) applyRule(key);
	return out;
}

/** Keep the current value unless a registry guard admits the incoming one. */
export function admitted<V>(isValid: (v: unknown) => v is V): FieldRule<V> {
	return (input, base) => (isValid(input) ? input : base);
}

/** The registry guards that take a `string` rather than an `unknown`: a non-string must read as "not
 *  admitted" instead of reaching a guard typed for strings. */
export function stringId<V extends string>(isValid: (v: string) => v is V): (v: unknown) => v is V {
	return (v): v is V => typeof v === 'string' && isValid(v);
}

/** A bounded integer is CLAMPED rather than rejected, so a junk value still leaves a usable room. */
export function clampedInt(lo: number, hi: number): FieldRule<number> {
	return (input, base) =>
		typeof input === 'number' && Number.isFinite(input) ? Math.min(hi, Math.max(lo, Math.round(input))) : base;
}

export const keptBoolean: FieldRule<boolean> = (input, base) => (typeof input === 'boolean' ? input : base);
