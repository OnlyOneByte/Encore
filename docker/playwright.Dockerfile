# The image the probes and gate:measured run in, in CI (probes.yml) and locally (docs/E2E.md#running-in-docker).
# The Playwright base pins the browsers `@playwright/test` expects; ffmpeg is for the probes that read or make audio.
ARG PW_IMAGE=mcr.microsoft.com/playwright:v1.56.1-noble
FROM ${PW_IMAGE}
ARG BUN_VERSION=1.4.3
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
RUN npm install -g bun@${BUN_VERSION}
