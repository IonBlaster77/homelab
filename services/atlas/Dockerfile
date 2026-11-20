# Atlas. Built by the build-image WorkflowTemplate (argo-builds) from this
# folder and pushed to registry.jupitertech.net/homelab/atlas:<git sha>.
#
# No compile step: Node 26 runs the TypeScript sources directly (type
# stripping), so the image holds exactly the code in the repo.
FROM node:26.13.1-alpine3.24@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:26.13.1-alpine3.24@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# The node user (uid 1000) from the base image; the Deployment also enforces
# runAsNonRoot and a read-only root filesystem.
USER 1000
EXPOSE 8080
CMD ["node", "src/collector/main.ts"]
