# Encore core — the whole MVP in one container. FROM oven/bun (the locked runtime).
# Bundles yt-dlp + ffmpeg so keyless YouTube search/resolve + local transcode work out of the box.
FROM oven/bun:1.3-debian AS build
WORKDIR /app

# install deps first (layer cache). The repo-local .npmrc points at public npm.
COPY package.json bun.lock .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/core/package.json apps/core/
RUN bun install --frozen-lockfile

# copy sources + build the SvelteKit app (svelte-adapter-bun -> build/)
COPY . .
WORKDIR /app/apps/core
RUN bun --bun run build

# ── runtime image ──────────────────────────────────────────────────────────────
FROM oven/bun:1.3-debian AS runtime
WORKDIR /app/apps/core

# system media tools: ffmpeg + yt-dlp (keyless YouTube). yt-dlp via the static binary.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ffmpeg ca-certificates curl python3 \
	&& curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
	&& chmod a+rx /usr/local/bin/yt-dlp \
	&& apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# Recreate the full workspace so Bun's @encore/shared workspace symlink resolves at runtime.
# (Copying node_modules from the build stage doesn't preserve the workspace symlink reliably;
#  a fresh install over the copied sources relinks it. Deps are layer-cached + offline-ish.)
COPY --from=build /app/package.json /app/bun.lock /app/.npmrc /app/
COPY --from=build /app/packages /app/packages
COPY --from=build /app/apps/core/package.json /app/apps/core/package.json
RUN cd /app && bun install --frozen-lockfile

# the built app + server entry + migrations + server-side sources
COPY --from=build /app/apps/core/build ./build
COPY --from=build /app/apps/core/server.ts ./server.ts
COPY --from=build /app/apps/core/drizzle ./drizzle
COPY --from=build /app/apps/core/src ./src

ENV PORT=3000 \
	HOST=0.0.0.0 \
	DATA_DIR=/app/data \
	MEDIA_DIR=/app/media \
	MEDIA_STORE=local
VOLUME ["/app/data", "/app/media"]
EXPOSE 3000

# server.ts owns Bun.serve (SvelteKit handler + WS hub) — the single process.
CMD ["bun", "run", "server.ts"]
