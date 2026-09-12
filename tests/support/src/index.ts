// unit: the package entry. Re-exports the tree anchors so `@encore/test-support` works as a bare import.
//
// Subpaths also resolve (`@encore/test-support/tree`) because this package's exports map carries `"./*"`.
//
// A note that used to sit here claimed `$lib/contract` subpaths do NOT resolve, and cited
// `colour-tokens.test.ts` reaching its registry through a four-hop relative path as the proof. That was
// wrong: `tests/tsconfig.json` maps `$lib/*` to `../src/lib/*`, so `$lib/contract/presentation/...json`
// and `$lib/contract/core/ulid` both resolve, verified by importing them. The relative paths were not a
// workaround for anything — they were just hop counts, and they are gone.

export * from './tree.ts';
