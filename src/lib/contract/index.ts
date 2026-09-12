// $lib/contract — the single import surface for the realtime contract.
// Imported by BOTH src/lib/server (authoritative) and src/lib (client).
//
// Modules are grouped into domain subdirectories; the barrel is the only public surface, so
// these re-exports keep every `$lib/contract` import path byte-identical for consumers.
//
// EVERY LINE HERE IS RELATIVE, and that is load-bearing rather than stylistic: a re-export spelled
// `$lib/contract/…` would route the barrel back through the alias that resolves TO this file, and a
// re-export spelled `$lib/…` would make the contract depend on the client code that consumes it. The
// merge that folded `packages/shared` in introduced one of each; the boundary guard
// (tests/guards/meta/shared-contract-boundary.test.ts) is what named them.
export * from './core/registry';
export * from './core/types';
export * from './lyrics/guide-level';
export * from './queue/gates';
export * from './core/ops';
export * from './queue/rotation';
export * from './queue/membership';
export * from './queue/queue-order';
export * from './lyrics/lyrics';
export * from './process/song-profile';
export * from './process/readiness';
export * from './lyrics/loudness-normalization';
export * from './core/events';
// `overallProcessPct` is NOT re-exported here, deliberately. It lives at `$lib/process-progress`
// because the client is its only consumer, and a module used by one side is not a contract — so the
// barrel re-exporting it would invert the dependency this whole directory exists to keep one-way.
// Its two call sites import it directly; `tests/unit/contract/barrel-surface.test.ts` records the removal.
export * from './lyrics/separators';
export * from './core/settings';
export * from './process/fetchers';
export * from './lyrics/lyrics-engines';
export * from './core/ulid';
export * from './presentation/colors';
export * from './presentation/song-display';
export * from './core/days-window';
export * from './core/room-code';
