// Test stub for SvelteKit's `$env/dynamic/public` virtual module (mount rung), so a component reading a
// PUBLIC_* variable reads an empty value instead of failing to load. Mutated in place, so a component
// that reads `env.PUBLIC_X` at effect time sees whatever a test put there.
export const env: Record<string, string | undefined> = {};

/** Replace the whole environment. Call in a `beforeEach` to keep tests independent. */
export function setEnv(next: Record<string, string | undefined>): void {
	for (const key of Object.keys(env)) delete env[key];
	Object.assign(env, next);
}
