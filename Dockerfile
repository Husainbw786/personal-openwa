# --- build the frontend ---
FROM node:24-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY web/ ./
RUN npm run build

# --- runtime: Node runs the TypeScript server directly (type stripping), no build step ---
FROM node:24-alpine
WORKDIR /app/server
ENV NODE_ENV=production
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit
COPY server/src ./src
COPY --from=web /web/dist /app/web/dist
ENV WEB_DIST=/app/web/dist DB_PATH=/app/data/app.sqlite PORT=3000
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "src/index.ts"]
