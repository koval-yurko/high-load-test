# syntax=docker/dockerfile:1
FROM node:22.13-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22.13-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
COPY prisma.config.js ./
# Generate at BUILD time: the container must not need network or a database to
# start. The driver-adapter path is used at runtime, so no query engine binary
# is downloaded for the target platform at boot.
# prisma.config.js resolves DATABASE_URL via env() even for an offline command
# like `generate` -- no real connection is attempted, but the schema engine
# needs *a* syntactically valid value to start (see prisma.config.js). This
# placeholder is build-time only and is not copied into any stage or layer
# consumed at runtime.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
RUN npx prisma generate

FROM node:22.13-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY package.json ./
COPY prisma ./prisma
COPY prisma.config.js ./
COPY src ./src
COPY scripts ./scripts
# Build for the platform the task runs on. The sibling's README records an
# arm64/amd64 mismatch surfacing as CannotPullContainerError at task start, not
# at build -- pass --platform explicitly in deploy-service.sh (plan 2).
EXPOSE 8080
USER node
CMD ["node", "src/server.js"]
