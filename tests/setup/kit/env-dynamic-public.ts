// Test stub for SvelteKit's `$env/dynamic/public` virtual module (rung M).
//
// No first-party file imports this today (verified across apps/ and packages/); stubbed because
// issue #822's acceptance names it and because a component that reads a PUBLIC_* variable would
// otherwise fail to load rather than read an empty value.
//
// Mutated in place so a component that destructured nothing and reads `env.PUBLIC_X` at effect time
// sees whatever a test put there.
export const env: Record<string, string | undefined> = {};

/** Replace the whole environment. Call in a `beforeEach` to keep tests independent. */
export function setEnv(next: Record<string, string | undefined>): void {
	for (const key of Object.keys(env)) delete env[key];
	Object.assign(env, next);
}
