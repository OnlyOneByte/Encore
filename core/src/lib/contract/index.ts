// The single import surface for the shared contract, imported by BOTH the authoritative server and the
// client. The barrel is the only public surface. See docs/SERVER.md#contract-boundary.
//
// EVERY LINE HERE MUST BE RELATIVE: a `$lib/contract/…` re-export routes the barrel back through the alias
// that resolves TO this file, and a `$lib/…` re-export makes the contract depend on the client code that
// consumes it, inverting the one-way dependency this directory exists to keep.
export * from './core/registry';
export * from './core/types';
export * from './lyrics/guide-level';
export * from './queue/gates';
export * from './core/ops';
export * from './queue/rotation';
export * from './queue/membership';
export * from './queue/queue-order';
export * from './queue/on-deck-hold';
export * from './lyrics/lyrics';
export * from './process/song-profile';
export * from './process/readiness';
export * from './lyrics/loudness-normalization';
export * from './core/events';
// `overallProcessPct` is deliberately NOT re-exported: it lives outside the contract because the client is
// its only consumer, and a module one side uses alone is not a contract.
export * from './lyrics/separators';
export * from './core/settings';
export * from './process/fetchers';
export * from './lyrics/lyrics-engines';
export * from './core/ulid';
export * from './presentation/colors';
export * from './presentation/player-palette';
export * from './presentation/song-display';
export * from './core/days-window';
export * from './core/room-code';
