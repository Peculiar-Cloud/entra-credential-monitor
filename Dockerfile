# syntax=docker/dockerfile:1.27@sha256:bde3983e9c939224420ddaf6b784cc30e09b035a4dea01f581230c50809f372e

ARG NODE_VERSION=24
ARG PNPM_VERSION=11.9.0

# Build TypeScript and install the pure-JavaScript production dependencies natively.
# Revisit this platform choice if production dependencies gain native binaries.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS build-base
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
RUN npm install --global "pnpm@${PNPM_VERSION}"

FROM build-base AS deps
ENV NODE_ENV=development
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM build-base AS prod-deps
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts && pnpm store prune

FROM cgr.dev/chainguard/node:latest AS runtime
WORKDIR /app
LABEL org.opencontainers.image.title="Entra Credential Monitor" \
  org.opencontainers.image.description="Scheduled Microsoft Entra ID credential-expiration monitor" \
  org.opencontainers.image.vendor="Peculiar Cloud" \
  org.opencontainers.image.url="https://peculiar.cloud" \
  org.opencontainers.image.source="https://github.com/Peculiar-Cloud/entra-credential-monitor" \
  org.opencontainers.image.documentation="https://github.com/Peculiar-Cloud/entra-credential-monitor#readme" \
  org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production

COPY --from=prod-deps --chown=65532:65532 /app/node_modules ./node_modules
COPY --from=build --chown=65532:65532 /app/dist ./dist
COPY --chown=65532:65532 package.json ./

USER 65532:65532
ENTRYPOINT ["/usr/bin/node"]
CMD ["dist/run.js"]
