# ---- клиент: сборка статики
FROM node:24-alpine AS client
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# ---- сервер: компиляция TypeScript, затем только рабочие зависимости
FROM node:24-alpine AS server
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ ./
RUN npm run build && npm prune --omit=dev

# ---- итоговый образ: один процесс отдаёт и API, и приложение
FROM node:24-alpine
ENV NODE_ENV=production PORT=8081
WORKDIR /app
COPY --from=server /app/server/package.json ./server/package.json
COPY --from=server /app/server/node_modules ./server/node_modules
COPY --from=server /app/server/dist ./server/dist
COPY --from=client /app/client/dist ./client/dist
USER node
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8081/api/config >/dev/null || exit 1
CMD ["node", "server/dist/index.js"]
