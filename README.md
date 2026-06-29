# 🎤 Encore

Self-hosted karaoke that's **mobile-first, wicked fast, and cleaner than any incumbent**.
YouTube + local now; "make karaoke from any song" (stem separation) + scoring later.

> Full design lives in [`docs/MASTER-DESIGN.md`](docs/MASTER-DESIGN.md). Start there.

## Stack (LOCKED)

**Bun** runtime · **SvelteKit + Svelte 5 (PWA)** · **`Bun.serve` native WebSocket pub/sub** ·
**`bun:sqlite` (WAL) + Drizzle** · in-memory authoritative state · bundled **yt-dlp + ffmpeg**.
One container for the MVP; a Python **Demucs + WhisperX** worker joins (container 2) for stems.
See [`docs/MASTER-DESIGN.md`](docs/MASTER-DESIGN.md) §2a.

## Layout

```
packages/shared/   ← the realtime contract, made physical (imported by client AND server)
apps/core/         ← Container 1: Bun + SvelteKit (the whole MVP)
  server.ts          Bun.serve entry: HTTP + native WS pub/sub hub
  src/server/        authoritative backend (state, rotation, playback, jobs, media, db)
  src/lib/           client: optimistic store, ws client, components, TV state machine
  src/routes/        phone (+page), /join, /tv, /api
apps/worker/       ← Container 2: Python stems/align (dials home; stems profile only)
docs/              ← design docs + UI mocks
```

## ▶️ Step one — the de-risk (do this before building features)

The one non-first-party seam is **`svelte-adapter-bun`**. Before investing in features,
confirm a SvelteKit production build serves under Bun on aarch64:

```bash
bun install
# scaffold SvelteKit into apps/core, set adapter to svelte-adapter-bun, then:
bun --filter '@encore/core' build && bun --filter '@encore/core' start
# hit http://localhost:3000 — if rough, fall back to adapter-node run ON bun
# (keeps Bun.serve pub/sub + bun:sqlite; nothing in the design depends on the adapter)
```

The WS hub skeleton already runs today:

```bash
bun run apps/core/server.ts      # then: curl localhost:3000/health
```

## Dev

```bash
bun install            # installs workspaces
bun run dev            # core in watch mode
docker compose up      # MVP (core only) — worker is behind: --profile stems
```
