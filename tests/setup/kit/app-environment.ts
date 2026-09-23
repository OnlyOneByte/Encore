// Test stub for SvelteKit's `$app/environment` virtual module (mount rung).
//
// `browser` is TRUE: the harness installs a DOM and mounts with Svelte's CLIENT runtime, so a component
// that guards its browser-only work on this flag must run that work here, or the mount proves nothing about it.
export const browser = true;
export const dev = false;
export const building = false;
export const version = 'test';
