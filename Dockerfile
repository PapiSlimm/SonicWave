# Multi-stage build — fixes the sibling projects' "npm ci --only=production
# triggers a build with no devDeps" unbuildable-image bug, and includes ffmpeg
# (the render worker requires it; the original assumed it was present).

# ---- Stage 1: build ----
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci                         # full install incl. devDeps
COPY . .
RUN npm run build                  # bundles client (vite) + server (esbuild)

# ---- Stage 2: runtime ----
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# ffmpeg for audio rendering.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev              # prod-only deps, NO build step here
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
# Cloud Run injects PORT; the app reads process.env.PORT (see src/config).
EXPOSE 8080
# Liveness/readiness probes hit /health/live and /health/ready.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.cjs"]
