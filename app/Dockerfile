# Image of the Reader application: API, worker and the built front in one Node process (plan.md, Structure Decision).
# Build context is the repository root: `docker build -f app/Dockerfile .` (contracts/compose.md).
# config/ and schemas/ are bind-mounted by compose.yaml and never copied into the image.
ARG NODE_IMAGE=node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

# All dependencies from the lockfile; scripts of packages stay off (nothing here needs a build step of its own).
FROM ${NODE_IMAGE} AS deps
WORKDIR /build
COPY app/package.json app/yarn.lock ./
RUN yarn install --frozen-lockfile --ignore-scripts --non-interactive

# Type check of the backend and the front: `docker build --target check -f app/Dockerfile .`
FROM deps AS check
COPY app/ ./
RUN yarn typecheck

# The front: Vite builds app/web into dist/web (base is relative, vite.config.ts).
FROM deps AS web
COPY app/web ./web
COPY app/src/shared ./src/shared
RUN yarn build:web

# Production dependencies only: react, vite and the type packages are build-time and stay out of the runtime image.
FROM ${NODE_IMAGE} AS runtime-deps
WORKDIR /app
COPY app/package.json app/yarn.lock ./
RUN yarn install --frozen-lockfile --production --ignore-scripts --non-interactive && yarn cache clean

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Mount points of the named volumes are created here so the volumes start owned by the unprivileged user.
# /jobs is shared with the parser sandbox (uid:gid 10001:10001): group 10001 with setgid, compose.yaml runs the app as 1000:10001.
RUN mkdir -p /data/blobs /jobs/in \
 && chown node:node /data/blobs \
 && chown -R 1000:10001 /jobs && chmod 2775 /jobs /jobs/in
COPY --from=runtime-deps /app/node_modules ./node_modules
COPY app/package.json ./
COPY app/src ./src
# The tests run in this image (`docker compose run --rm app node --test`, quickstart.md), so they travel with the code.
COPY app/test ./test
# The page's sources, which `test/i18n.test.ts` (its dictionaries) and `test/front-safety.test.ts` (its code) read.
COPY app/web/src ./web/src
COPY --from=web /build/dist/web ./dist/web
USER node
CMD ["node", "src/main.ts"]
