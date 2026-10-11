import fs from 'node:fs';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { requireAuth } from './auth.js';
import { config } from './config.js';
import { migrate, pool, q } from './db.js';
import { hub, type Client } from './hub.js';
import { HttpError } from './http.js';
import { accountRoutes, publicRoutes } from './routes/auth.js';
import { nodeRoutes } from './routes/nodes.js';
import { transferRoutes } from './routes/transfer.js';
import { vaultRoutes } from './routes/vaults.js';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, disableRequestLogging: true, trustProxy: true, bodyLimit: 32 * 1024 * 1024 });

await app.register(cookie);
await app.register(multipart, { limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 5000, fields: 10000 } });
await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

app.setErrorHandler((err: any, req, reply) => {
  if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
  if (err.code === '23505') return reply.code(409).send({ error: 'Такое имя уже занято' });
  if (err.code === '22P02') return reply.code(404).send({ error: 'Не найдено' });
  if (err.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: `Файл больше ${config.maxUploadMb} МБ` });
  if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
  req.log.error(err);
  return reply.code(500).send({ error: 'Внутренняя ошибка сервера' });
});

// cookie c SameSite=Lax + обязательный собственный заголовок: чужая страница изменить данные не сможет
app.addHook('onRequest', async (req) => {
  if (!req.url.startsWith('/api/')) return;
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-onyx'] !== '1') throw new HttpError(403, 'Запрос отклонён');
});

const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src * data: blob:", "media-src * data: blob:",
  "font-src 'self' data:", "connect-src 'self' ws: wss:", "frame-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'",
].join('; ');

app.addHook('onSend', async (req, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'same-origin').header('X-Frame-Options', 'SAMEORIGIN');
  if (req.url.startsWith('/api/')) { if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store'); }
  else if (!reply.hasHeader('Content-Security-Policy')) reply.header('Content-Security-Policy', CSP);
});

await app.register(publicRoutes, { prefix: '/api' });

await app.register(async (api) => {
  api.addHook('preHandler', requireAuth);
  await api.register(accountRoutes);
  await api.register(vaultRoutes);
  await api.register(nodeRoutes);
  await api.register(transferRoutes);

  // ---- живая синхронизация: изменения дерева и текста, кто сейчас в хранилище
  api.get<{ Querystring: { vault?: string; client?: string } }>('/ws', { websocket: true }, async (socket, req) => {
    const vaultId = String(req.query.vault ?? '');
    const member = await q('select 1 from vault_members where vault_id = $1 and user_id = $2', [vaultId, req.user.id]).catch(() => null);
    if (!member?.rowCount) { socket.close(4403, 'forbidden'); return; }
    const client: Client = {
      id: String(req.query.client ?? '').slice(0, 64), socket, userId: req.user.id, name: req.user.displayName, vaultId, nodeId: null,
    };
    hub.add(client);
    let alive = true;
    const ping = setInterval(() => {
      if (!alive) { socket.terminate(); return; }
      alive = false;
      socket.ping();
    }, 30_000);
    socket.on('pong', () => { alive = true; });
    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.t === 'open') { client.nodeId = typeof msg.nodeId === 'string' ? msg.nodeId.slice(0, 64) : null; hub.presence(vaultId); }
      } catch { /* мусор игнорируем */ }
    });
    socket.on('close', () => { clearInterval(ping); hub.remove(client); });
  });
}, { prefix: '/api' });

if (fs.existsSync(config.staticDir)) {
  await app.register(fastifyStatic, {
    root: config.staticDir,
    setHeaders(res, file) {
      // у файлов сборки в имени хеш — их можно кешировать навсегда; остальное всегда перепроверяем
      res.header('Cache-Control', /[\\/]assets[\\/]/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });
}

app.setNotFoundHandler((req, reply) => {
  if (req.method === 'GET' && !req.url.startsWith('/api/') && fs.existsSync(config.staticDir)) {
    return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
  }
  return reply.code(404).send({ error: 'Не найдено' });
});

await migrate((m) => app.log.info(m));
setInterval(() => q('delete from sessions where expires_at < now()').catch(() => {}), 6 * 3600_000).unref();

await app.listen({ port: config.port, host: '0.0.0.0' });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(0);
  });
}
