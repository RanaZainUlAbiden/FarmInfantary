FROM node:24-bookworm-slim AS dependencies
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev --no-audit

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY --from=dependencies --chown=node:node /app/server/node_modules ./server/node_modules
COPY --chown=node:node server ./server
COPY --chown=node:node db ./db
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node scripts/ops ./scripts/ops
COPY --chown=node:node ops ./ops
COPY --chown=node:node package.json package-lock.json angular.json tsconfig.json tsconfig.app.json Dockerfile .dockerignore ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:3000/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","server/src/server.js"]
