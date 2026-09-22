// Test stub for SvelteKit's `$app/environment` virtual module (rung M).
//
// No first-party file imports this today (verified across apps/ and packages/ — the only hits are
// generated files under .svelte-kit/). It is stubbed anyway because it is the module a component
// reaches for the moment it needs to branch on client-vs-server, and the harness contract names
// it explicitly.
//
// `browser` is TRUE: the harness installs a DOM and mounts with Svelte's CLIENT runtime, so a
// component that guards its browser-only work on this flag must run that work here, or the mount
// proves nothing about it.
export const browser = true;
export const dev = false;
export const building = false;
export const version = 'test';
