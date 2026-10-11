import type { FastifyInstance } from 'fastify';
import { vaultRole } from '../access.js';
import { q, tx } from '../db.js';
import { hub } from '../hub.js';
import { bad, forbidden, notFound } from '../http.js';

function vaultName(v: unknown): string {
  const name = String(v ?? '').trim().slice(0, 80);
  if (!name) throw bad('Укажите название хранилища');
  return name;
}

async function memberIds(vaultId: string): Promise<string[]> {
  return (await q('select user_id from vault_members where vault_id = $1', [vaultId])).rows.map((r) => r.user_id);
}
const notifyVaults = (ids: string[]) => ids.forEach((id) => hub.toUser(id, { t: 'vaults' }));

export async function vaultRoutes(app: FastifyInstance) {
  app.get('/vaults', async (req) => {
    const { rows } = await q(
      `select v.id, v.name, m.role, u.display_name as owner_name,
              (select count(*)::int from vault_members where vault_id = v.id) as member_count
         from vaults v
         join vault_members m on m.vault_id = v.id and m.user_id = $1
         join users u on u.id = v.owner_id
        order by v.created_at`, [req.user.id]);
    return { vaults: rows.map((r) => ({ id: r.id, name: r.name, role: r.role, ownerName: r.owner_name, memberCount: r.member_count })) };
  });

  app.post('/vaults', async (req) => {
    const name = vaultName((req.body as any)?.name);
    const id = await tx(async (c) => {
      const v = (await c.query('insert into vaults (name, owner_id) values ($1, $2) returning id', [name, req.user.id])).rows[0];
      await c.query('insert into vault_members (vault_id, user_id, role) values ($1, $2, $3)', [v.id, req.user.id, 'owner']);
      return v.id as string;
    });
    return { id };
  });

  app.patch<{ Params: { id: string } }>('/vaults/:id', async (req) => {
    if ((await vaultRole(req.user.id, req.params.id)) !== 'owner') throw forbidden('Переименовать хранилище может только владелец');
    await q('update vaults set name = $1 where id = $2', [vaultName((req.body as any)?.name), req.params.id]);
    notifyVaults(await memberIds(req.params.id));
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/vaults/:id', async (req) => {
    if ((await vaultRole(req.user.id, req.params.id)) !== 'owner') throw forbidden('Удалить хранилище может только владелец');
    const ids = await memberIds(req.params.id);
    await q('delete from vaults where id = $1', [req.params.id]);
    hub.kick(req.params.id);
    notifyVaults(ids);
    return { ok: true };
  });

  // ---- участники
  app.get<{ Params: { id: string } }>('/vaults/:id/members', async (req) => {
    await vaultRole(req.user.id, req.params.id);
    const { rows } = await q(
      `select u.id, u.login, u.display_name, m.role from vault_members m join users u on u.id = m.user_id
        where m.vault_id = $1 order by (m.role = 'owner') desc, u.display_name`, [req.params.id]);
    return { members: rows.map((r) => ({ id: r.id, login: r.login, displayName: r.display_name, role: r.role })) };
  });

  app.post<{ Params: { id: string } }>('/vaults/:id/members', async (req) => {
    if ((await vaultRole(req.user.id, req.params.id)) !== 'owner') throw forbidden('Приглашать может только владелец');
    const body = (req.body ?? {}) as any;
    const role = body.role === 'viewer' ? 'viewer' : 'editor';
    const user = (await q('select id from users where login = $1', [String(body.login ?? '').trim().toLowerCase()])).rows[0];
    if (!user) throw notFound('Пользователь с таким логином не найден');
    if (user.id === req.user.id) throw bad('Вы уже владелец этого хранилища');
    await q(`insert into vault_members (vault_id, user_id, role) values ($1, $2, $3)
             on conflict (vault_id, user_id) do update set role = excluded.role`, [req.params.id, user.id, role]);
    notifyVaults(await memberIds(req.params.id));
    return { ok: true };
  });

  app.delete<{ Params: { id: string; userId: string } }>('/vaults/:id/members/:userId', async (req) => {
    const role = await vaultRole(req.user.id, req.params.id);
    const self = req.params.userId === req.user.id;
    if (self && role === 'owner') throw bad('Владелец не может покинуть хранилище — удалите его или оставьте себе');
    if (!self && role !== 'owner') throw forbidden('Исключать участников может только владелец');
    const ids = await memberIds(req.params.id);
    await q("delete from vault_members where vault_id = $1 and user_id = $2 and role <> 'owner'", [req.params.id, req.params.userId]);
    hub.kick(req.params.id, req.params.userId);
    notifyVaults(ids);
    return { ok: true };
  });
}
