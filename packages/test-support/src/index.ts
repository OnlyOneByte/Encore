// unit: the package entry. Re-exports the tree anchors so `@encore/test-support` works as a bare import.
//
// Subpaths also resolve (`@encore/test-support/tree`) because this package's exports map carries `"./*"`.
// That is deliberate and it fixes a trap the repo already has: `@encore/shared`'s map carries only `"."`,
// which is why `colour-tokens.test.ts` reaches its own registry through
// `'../../../../packages/shared/src/presentation/player-palette-48.json'` — a relative path that exists
// only because the subpath import does not resolve. Repeating that here would defeat the purpose of a
// module whose job is to delete relative paths.

export * from './tree.ts';
