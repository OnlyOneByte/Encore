// $shared — the single import surface for the realtime contract.
// Imported by BOTH apps/core/src/lib/server (authoritative) and apps/core/src/lib (client).
//
// Modules are grouped into domain subdirectories; the barrel is the only public surface, so
// these re-exports keep every `$shared` import path byte-identical for consumers.
export * from './core/registry';
export * from './core/types';
export * from './lyrics/guide-level';
export * from './queue/gates';
export * from './core/ops';
export * from './queue/rotation';
export * from './queue/membership';
export * from './queue/queue-order';
export * from './lyrics/lyrics';
export * from './cook/song-profile';
export * from './lyrics/loudness-normalization';
export * from './core/events';
export * from './cook/cook-progress';
export * from './lyrics/separators';
export * from './core/settings';
export * from './cook/fetchers';
export * from './lyrics/lyrics-engines';
export * from './core/ulid';
export * from './presentation/colors';
export * from './presentation/song-display';
export * from './core/days-window';
export * from './core/room-code';
