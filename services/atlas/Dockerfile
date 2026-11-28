# Atlas. Built by the build-image WorkflowTemplate (argo-builds) from this
# folder and pushed to registry.jupitertech.net/homelab/atlas:<git sha>.
#
# No compile step: Node 26 runs the TypeScript sources directly (type
# stripping), so the image holds exactly the code in the repo.
FROM node:26.13.1-alpine3.24@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: install-time scripts are how most npm supply-chain attacks
# run code, and none of our dependencies need one.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# The UI (web/), built to static files the API serves. Only web/dist goes
# into the final image; the build tools (Vite, Tailwind, TypeScript) don't.
FROM node:26.13.1-alpine3.24@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM node:26.13.1-alpine3.24@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5
# Nothing at runtime needs a package manager (decided 2026-11-21): the app is
# started with `node`, migrations run from inside it. npm's own bundled
# dependencies are the most common source of CVEs in Node images, so remove
# npm, npx, corepack and yarn (whichever the base image ships).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY --from=web /web/dist ./web/dist
# The node user (uid 1000) from the base image; the Deployment also enforces
# runAsNonRoot and a read-only root filesystem.
USER 1000
EXPOSE 8080
# One image, two Deployments: the collector (default) and the web/API
# (deployment-web.yaml runs src/api/main.ts).
CMD ["node", "src/collector/main.ts"]
