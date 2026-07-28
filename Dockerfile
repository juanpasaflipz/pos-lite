FROM node:20-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

# .dockerignore drops .git, so the build stamp can't fall back to `git rev-parse`.
# Without the SHA the buildId degrades to `dev`, which silently disables
# new-version detection for every tenant. Railway passes service variables as
# build args; the ARG is what lets scripts/gen-version.mjs see it.
ARG RAILWAY_GIT_COMMIT_SHA
ENV RAILWAY_GIT_COMMIT_SHA=$RAILWAY_GIT_COMMIT_SHA

COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-kiosk ./dist-kiosk
COPY --from=build /app/server ./server
COPY --from=build /app/print-bridge ./print-bridge
# The server reports the build the bundles were stamped with, so it needs both
# the stamp and the resolver that reads it. Omitting either crashes boot on
# server/helpers/appVersion.js.
COPY --from=build /app/version.json ./version.json
COPY --from=build /app/scripts/app-version.mjs ./scripts/app-version.mjs

EXPOSE 3001

CMD ["node", "server/index.js"]
