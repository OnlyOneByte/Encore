# Encore core — the whole MVP in one container. FROM oven/bun (the locked runtime).
# Bundles yt-dlp + ffmpeg so keyless YouTube search/resolve + local transcode work out of the box.
FROM oven/bun:1.3-debian AS build
WORKDIR /app

# install deps first (layer cache). The repo-local .npmrc points at public npm. One package.json —
# this is a single-package repo, so there is no member manifest to copy alongside it.
COPY package.json bun.lock .npmrc ./
RUN bun install --frozen-lockfile

# copy sources + build the SvelteKit app (svelte-adapter-bun -> build/)
COPY . .
RUN bun --bun run build

FROM oven/bun:1.3-debian AS runtime
WORKDIR /app

# system media tools: ffmpeg + yt-dlp (keyless YouTube), yt-dlp via the static binary. Pinned because a
# bare :latest auto-deploys whatever upstream publishes. Bump YT_DLP_VERSION deliberately.
ARG YT_DLP_VERSION=2025.06.09
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ffmpeg ca-certificates curl python3 \
	&& curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp" -o /usr/local/bin/yt-dlp \
	&& chmod a+rx /usr/local/bin/yt-dlp \
	&& apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# Production dependencies against the same lockfile. server.ts and the server-side sources it pulls in
# run from source at runtime and the adapter's build/ output does not bundle their npm dependencies, so
# they must be present. Copying node_modules from the build stage would carry the dev deps too.
COPY --from=build /app/package.json /app/bun.lock /app/.npmrc /app/
RUN bun install --frozen-lockfile --production

# the built app + server entry + migrations + server-side sources
COPY --from=build /app/build ./build
COPY --from=build /app/server.ts ./server.ts
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/src ./src

ENV PORT=3000 \
	HOST=0.0.0.0 \
	DATA_DIR=/app/data \
	MEDIA_DIR=/app/media \
	MEDIA_STORE=local
VOLUME ["/app/data", "/app/media"]
EXPOSE 3000

# Run as the non-root `bun` user shipped by the base image: the app never needs root. Own the writable
# volumes + app tree to `bun` so SQLite/media writes work.
RUN mkdir -p /app/data /app/media && chown -R bun:bun /app
USER bun

# server.ts owns Bun.serve (SvelteKit handler + WS hub) — the single process.
CMD ["bun", "run", "server.ts"]
