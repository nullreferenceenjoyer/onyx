import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { q } from './db.js';
import { HttpError } from './http.js';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const COOKIE = 'onyx_sid';
const DAY = 86400_000;

export interface SessionUser { id: string; login: string; displayName: string; sessionId: string }

declare module 'fastify' {
  interface FastifyRequest { user: SessionUser }
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [algo, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), want.length);
  return crypto.timingSafeEqual(want, got);
}

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

function setCookie(req: FastifyRequest, reply: FastifyReply, token: string) {
  reply.setCookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', path: '/', secure: req.protocol === 'https',
    maxAge: config.sessionDays * 86400,
  });
}

export async function createSession(req: FastifyRequest, reply: FastifyReply, userId: string) {
  const token = crypto.randomBytes(32).toString('base64url');
  await q('insert into sessions (token_hash, user_id, user_agent, expires_at) values ($1, $2, $3, now() + make_interval(days => $4))',
    [sha(token), userId, String(req.headers['user-agent'] ?? '').slice(0, 300), config.sessionDays]);
  setCookie(req, reply, token);
}

export async function destroySession(req: FastifyRequest, reply: FastifyReply) {
  const token = req.cookies[COOKIE];
  if (token) await q('delete from sessions where token_hash = $1', [sha(token)]);
  reply.clearCookie(COOKIE, { path: '/' });
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const token = req.cookies[COOKIE];
  if (!token) throw new HttpError(401, 'Требуется вход');
  const { rows } = await q(
    `select s.id as session_id, s.last_seen_at, u.id, u.login, u.display_name
       from sessions s join users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > now()`, [sha(token)]);
  const row = rows[0];
  if (!row) { reply.clearCookie(COOKIE, { path: '/' }); throw new HttpError(401, 'Сессия истекла'); }
  req.user = { id: row.id, login: row.login, displayName: row.display_name, sessionId: row.session_id };
  // скользящая сессия: пока пользователь заходит, она не истекает
  if (Date.now() - new Date(row.last_seen_at).getTime() > DAY) {
    await q('update sessions set last_seen_at = now(), expires_at = now() + make_interval(days => $2) where id = $1', [row.session_id, config.sessionDays]);
    setCookie(req, reply, token);
  }
}

// ---- защита входа от перебора: не больше 10 неудач за 10 минут на пару «адрес + логин»
const fails = new Map<string, { n: number; until: number }>();
export function checkThrottle(key: string) {
  const f = fails.get(key);
  if (f && f.until > Date.now() && f.n >= 10) throw new HttpError(429, 'Слишком много попыток. Попробуйте через несколько минут');
}
export function noteFailure(key: string) {
  const now = Date.now();
  const f = fails.get(key);
  if (!f || f.until < now) fails.set(key, { n: 1, until: now + 10 * 60_000 });
  else f.n++;
  if (fails.size > 5000) for (const [k, v] of fails) if (v.until < now) fails.delete(k);
}
export const clearFailures = (key: string) => fails.delete(key);
