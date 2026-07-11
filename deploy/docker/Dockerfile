# Clean-room reproduction of the README Quickstart / SERVER_SETUP runbook.
# Builds the toolchains + deps + compiled contract into the image so that at
# runtime the entrypoint only has to bring up the services (stack → deploy →
# relay → webapp) exactly as a tester following the docs would.
#
# Build context is the REPO ROOT (see docker-compose.yml). node_modules and
# compiled artifacts are excluded via .dockerignore so everything is installed
# and compiled fresh inside the image.

FROM oven/bun:1-debian

# --- Prerequisites (README: Bun [in base image], Compact toolchain, curl/git) --
# xz-utils is REQUIRED — the compact installer ships an .tar.xz and fails with
# "xz: Cannot exec" without it (not present on minimal Debian/Ubuntu bases).
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates git unzip xz-utils procps \
    && rm -rf /var/lib/apt/lists/*

# Compact toolchain (the CLI/version-manager). The pinned 0.31.1 compiler is
# installed explicitly below — `compact compile +0.31.1` does NOT auto-fetch it.
# Installer command per Midnight docs.
RUN curl --proto '=https' --tlsv1.2 -LsSf \
      https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh
ENV PATH="/root/.compact/bin:/root/.local/bin:${PATH}"
RUN compact --version
# Install the PINNED compiler. `compact compile +0.31.1` does NOT auto-download
# it — without this the build fails with "Couldn't find compiler … (0.31.1)".
# (Extraction needs unzip, installed above.)
RUN compact update 0.31.1

WORKDIR /app

# --- Dependencies (README step 1 + webapp install) ---------------------------
# Copy manifests first for layer caching, then install. The relay has NO
# dependencies (Bun built-ins only, no lockfile) so it needs no install step.
COPY package.json bun.lock ./
COPY webapp/package.json webapp/bun.lock ./webapp/
# NB: use `cd <dir> && bun install`; `bun --cwd webapp install` is (mis)parsed
# as `bun run install` by current Bun and fails with "Script not found".
RUN bun install --frozen-lockfile \
 && (cd webapp && bun install --frozen-lockfile)

# --- Source + compile the contract (README step 2) ---------------------------
COPY . .
RUN bun run compact \
 && test "$(ls src/contract/managed/keys/*.prover | wc -l)" = "16"

# Ports: webapp 5173, indexer 8088, node 9944, proof 6300, relay 4310
EXPOSE 5173 8088 9944 6300 4310

COPY deploy/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
