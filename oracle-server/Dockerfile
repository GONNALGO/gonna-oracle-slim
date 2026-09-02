# GONNA ARENA oracle server — node:20-slim, non-root, /data volume.
# Render: docker runtime, health check GET /v1/health, disk mounted at /data,
# PORT injected by the platform (local default 8787). ORACLE_MNEMONIC_FILE
# (secret file, preferred) or ORACLE_MNEMONIC env (fallback) — never baked in.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# ROOT CAUSE of the first Render build failures: package-lock.json had been
# created behind a private registry mirror whose tarball URLs don't resolve
# publicly (every npm op died on the ~70s DNS timeout). Lockfile URLs are
# now registry.npmjs.org. node:22-slim (npm>=10.9). Retry + verify kept as
# cheap insurance — npm can crash silently in hosted build envs.
RUN for i in 1 2 3; do \
      npm ci --no-audit --no-fund; \
      if [ -x ./node_modules/.bin/tsc ]; then break; fi; \
    done \
  && test -x ./node_modules/.bin/tsc
COPY tsconfig.json ./
COPY src ./src
# ./node_modules/.bin/tsc directly: npx would silently fetch the fake 'tsc'
# package from the registry if typescript were missing (Render build lesson)
RUN ./node_modules/.bin/tsc -p tsconfig.json && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd -r oracle && useradd -r -g oracle -d /app oracle \
  && mkdir -p /data && chown oracle:oracle /data
COPY --from=build --chown=oracle:oracle /app/node_modules ./node_modules
COPY --from=build --chown=oracle:oracle /app/dist ./dist
COPY --chown=oracle:oracle package.json ./
# pinned replay engine bundles (REPLAY_ENFORCE=1 boot assert fails without
# them — REPLAY_BUNDLES_DIR defaults to <pkg>/replay-bundles)
COPY --chown=oracle:oracle replay-bundles ./replay-bundles
USER oracle
EXPOSE 8787
VOLUME ["/data"]
# node:22-slim has no curl/wget — use node's fetch; honours the injected PORT
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
