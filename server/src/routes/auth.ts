import type { FastifyInstance } from 'fastify';
import { checkThrottle, clearFailures, createSession, destroySession, hashPassword, noteFailure, verifyPassword } from '../auth.js';
import { config } from '../config.js';
import { q, tx } from '../db.js';
import { bad, conflict, forbidden, HttpError } from '../http.js';
import { WELCOME, WELCOME_NAME } from '../welcome.js';

const LOGIN_RE = /^[a-z0-9а-яё._-]{3,32}$/;

const userDto = (r: any) => ({
  id: r.id, login: r.login, displayName: r.display_name, settings: r.settings ?? {}, bio: r.bio ?? '', profilePublic: !!r.profile_public,
});

function credentials(body: any) {
  const login = String(body?.login ?? '').trim().toLowerCase();
  const password = String(body?.password ?? '');
  return { login, password };
}

// первый пользователь может зарегистрироваться всегда — иначе в систему не попасть
async function registrationOpen() {
  if (config.allowRegistration) return true;
  return (await q('select 1 from users limit 1')).rowCount === 0;
}

export async function publicRoutes(app: FastifyInstance) {
  app.get('/config', async () => ({ allowRegistration: await registrationOpen() }));

  app.post('/auth/register', async (req, reply) => {
    if (!(await registrationOpen())) throw forbidden('Регистрация закрыта');
    const { login, password } = credentials(req.body);
    if (!LOGIN_RE.test(login)) throw bad('Логин: 3–32 символа — буквы, цифры, точка, дефис, подчёркивание');
    if (password.length < 6 || password.length > 200) throw bad('Пароль должен быть не короче 6 символов');
    const displayName = String((req.body as any)?.displayName ?? '').trim().slice(0, 60) || login;
    const hash = await hashPassword(password);
    const user = await tx(async (c) => {
      const exists = await c.query('select 1 from users where login = $1', [login]);
      if (exists.rowCount) throw conflict('Такой логин уже занят');
      const u = (await c.query('insert into users (login, display_name, password_hash) values ($1, $2, $3) returning *', [login, displayName, hash])).rows[0];
      const v = (await c.query('insert into vaults (name, owner_id) values ($1, $2) returning id', ['Моё хранилище', u.id])).rows[0];
      await c.query('insert into vault_members (vault_id, user_id, role) values ($1, $2, $3)', [v.id, u.id, 'owner']);
      await c.query('insert into nodes (vault_id, name, kind, content, size, updated_by) values ($1, $2, $3, $4, octet_length($4), $5)',
        [v.id, WELCOME_NAME, 'file', WELCOME, u.id]);
      return u;
    });
    await createSession(req, reply, user.id);
    return { user: userDto(user) };
  });

  app.post('/auth/login', async (req, reply) => {
    const { login, password } = credentials(req.body);
    const key = `${req.ip}|${login}`;
    checkThrottle(key);
    const user = (await q('select * from users where login = $1', [login])).rows[0];
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      noteFailure(key);
      throw new HttpError(401, 'Неверный логин или пароль');
    }
    clearFailures(key);
    await createSession(req, reply, user.id);
    return { user: userDto(user) };
  });
}

export async function accountRoutes(app: FastifyInstance) {
  app.post('/auth/logout', async (req, reply) => {
    await destroySession(req, reply);
    return { ok: true };
  });

  app.get('/me', async (req) => {
    const user = (await q('select * from users where id = $1', [req.user.id])).rows[0];
    return { user: userDto(user) };
  });

  app.patch('/me', async (req) => {
    const body = (req.body ?? {}) as any;
    if (typeof body.displayName === 'string') {
      const name = body.displayName.trim().slice(0, 60);
      if (!name) throw bad('Имя не может быть пустым');
      await q('update users set display_name = $1 where id = $2', [name, req.user.id]);
    }
    if (typeof body.bio === 'string') await q('update users set bio = $1 where id = $2', [body.bio.trim().slice(0, 300), req.user.id]);
    if (typeof body.profilePublic === 'boolean') await q('update users set profile_public = $1 where id = $2', [body.profilePublic, req.user.id]);
    if (body.settings && typeof body.settings === 'object') {
      const json = JSON.stringify(body.settings);
      if (json.length > 200_000) throw bad('Слишком большие настройки');
      await q('update users set settings = $1 where id = $2', [json, req.user.id]);
    }
    if (typeof body.newPassword === 'string') {
      if (body.newPassword.length < 6 || body.newPassword.length > 200) throw bad('Пароль должен быть не короче 6 символов');
      const cur = (await q('select password_hash from users where id = $1', [req.user.id])).rows[0];
      if (!(await verifyPassword(String(body.currentPassword ?? ''), cur.password_hash))) throw bad('Текущий пароль указан неверно');
      await q('update users set password_hash = $1 where id = $2', [await hashPassword(body.newPassword), req.user.id]);
      // остальные устройства должны войти заново
      await q('delete from sessions where user_id = $1 and id <> $2', [req.user.id, req.user.sessionId]);
    }
    const user = (await q('select * from users where id = $1', [req.user.id])).rows[0];
    return { user: userDto(user) };
  });
}
