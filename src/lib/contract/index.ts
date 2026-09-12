// $lib/contract — the single import surface for the realtime contract.
// Imported by BOTH src/lib/server (authoritative) and src/lib (client).
//
// Modules are grouped into domain subdirectories; the barrel is the only public surface, so
// these re-exports keep every `$lib/contract` import path byte-identical for consumers.
export * from './core/registry';
export * from './core/types';
export * from './lyrics/guide-level';
export * from './queue/gates';
export * from './core/ops';
export * from './core/days-window';
export * from './queue/rotation';
export * from './queue/membership';
export * from './queue/queue-order';
export * from './lyrics/lyrics';
export * from './cook/song-profile';
export * from './lyrics/loudness-normalization';
export * from './core/events';
export * from './lyrics/separators';
export * from './core/settings';
export * from './cook/fetchers';
export * from './lyrics/lyrics-engines';
export * from './core/ulid';
export * from './presentation/colors';
export * from './presentation/song-display';
export * from './core/room-code';
