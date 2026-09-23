// The package entry. Re-exports the tree anchors so `@encore/test-support` works as a bare import;
// subpaths also resolve (`@encore/test-support/tree`) because the exports map carries `"./*"`.

export * from './tree.ts';
