import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { nodeCtx } from '../access.js';
import { tzOffset } from '../activity.js';
import { q } from '../db.js';
import { hub } from '../hub.js';
import { bad, notFound } from '../http.js';

const SHARE_SELECT = `
  select s.id, s.token, s.node_id, s.vault_id, s.created_by, s.user_id, s.listed, s.expires_at, s.views, s.created_at,
         n.name, n.kind, v.name as vault_name, t.login as target_login, t.display_name as target_name, a.display_name as author_name
    from shares s
    join nodes n on n.id = s.node_id
    join vaults v on v.id = s.vault_id
    join users a on a.id = s.created_by
    left join users t on t.id = s.user_id`;

const shareDto = (r: any) => ({
  id: r.id, token: r.token, nodeId: r.node_id, vaultId: r.vault_id, name: r.name, kind: r.kind, vaultName: r.vault_name,
  listed: r.listed, expiresAt: r.expires_at, views: r.views, createdAt: r.created_at, authorName: r.author_name,
  target: r.user_id ? { login: r.target_login, displayName: r.target_name } : null,
  expired: !!r.expires_at && new Date(r.expires_at).getTime() < Date.now(),
});

function parseExpiry(v: unknown): Date | null {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw bad('Некорректная дата окончания доступа');
  if (d.getTime() < Date.now() + 30_000) throw bad('Срок доступа должен заканчиваться в будущем');
  return d;
}

// изменять и отзывать доступ может тот, кто его открыл, и владелец хранилища
async function ownShare(userId: string, shareId: string) {
  const row = (await q(
    `select s.id, s.created_by, s.user_id, m.role from shares s
       left join vault_members m on m.vault_id = s.vault_id and m.user_id = $2
      where s.id = $1`, [shareId, userId])).rows[0];
  if (!row || (row.created_by !== userId && row.role !== 'owner')) throw notFound('Доступ не найден');
  return row;
}

export async function socialRoutes(app: FastifyInstance) {
  // ---- доступ к заметке или папке
  app.get<{ Params: { id: string } }>('/nodes/:id/shares', async (req) => {
    const { node } = await nodeCtx(req.user.id, req.params.id);
    const { rows } = await q(`${SHARE_SELECT} where s.node_id = $1 order by s.created_at`, [node.id]);
    return { shares: rows.map(shareDto) };
  });

  app.post<{ Params: { id: string } }>('/nodes/:id/shares', async (req) => {
    const { node } = await nodeCtx(req.user.id, req.params.id, true);
    const body = (req.body ?? {}) as any;
    const expires = parseExpiry(body.expiresAt);
    let target: string | null = null;
    if (body.login) {
      const user = (await q('select id from users where login = $1', [String(body.login).trim().toLowerCase()])).rows[0];
      if (!user) throw notFound('Пользователь с таким логином не найден');
      if (user.id === req.user.id) throw bad('Это ваша заметка — доступ у вас уже есть');
      const dup = await q('select 1 from shares where node_id = $1 and user_id = $2', [node.id, user.id]);
      if (dup.rowCount) throw bad('Этому человеку доступ уже открыт');
      target = user.id;
    }
    const token = crypto.randomBytes(16).toString('base64url');
    const id = (await q(
      'insert into shares (token, node_id, vault_id, created_by, user_id, listed, expires_at) values ($1, $2, $3, $4, $5, $6, $7) returning id',
      [token, node.id, node.vault_id, req.user.id, target, !target && body.listed === true, expires])).rows[0].id;
    if (target) hub.toUser(target, { t: 'shares' });
    const row = (await q(`${SHARE_SELECT} where s.id = $1`, [id])).rows[0];
    return { share: shareDto(row) };
  });

  app.patch<{ Params: { id: string } }>('/shares/:id', async (req) => {
    const own = await ownShare(req.user.id, req.params.id);
    const body = (req.body ?? {}) as any;
    if ('expiresAt' in body) await q('update shares set expires_at = $1 where id = $2', [parseExpiry(body.expiresAt), own.id]);
    if (typeof body.listed === 'boolean') {
      if (own.user_id) throw bad('В профиле показываются только ссылки, открытые для всех');
      await q('update shares set listed = $1 where id = $2', [body.listed, own.id]);
    }
    const row = (await q(`${SHARE_SELECT} where s.id = $1`, [own.id])).rows[0];
    return { share: shareDto(row) };
  });

  app.delete<{ Params: { id: string } }>('/shares/:id', async (req) => {
    const own = await ownShare(req.user.id, req.params.id);
    await q('delete from shares where id = $1', [own.id]);
    if (own.user_id) hub.toUser(own.user_id, { t: 'shares' });
    return { ok: true };
  });

  // всё, чем я поделился, и всё, чем поделились со мной
  app.get('/shares', async (req) => {
    const mine = await q(`${SHARE_SELECT} where s.created_by = $1 order by s.created_at desc`, [req.user.id]);
    const incoming = await q(
      `${SHARE_SELECT} where s.user_id = $1 and (s.expires_at is null or s.expires_at > now()) order by s.created_at desc`, [req.user.id]);
    return { mine: mine.rows.map(shareDto), incoming: incoming.rows.map(shareDto) };
  });

  // ---- активность: правки по дням за последний год
  app.get('/activity', async (req) => {
    const { rows } = await q(
      `select to_char(day, 'YYYY-MM-DD') as day, sum(sessions)::int as count, count(*)::int as notes, sum(chars)::int as chars
         from activity where user_id = $1 and day > (now() at time zone 'utc' + make_interval(mins => $2))::date - 372
        group by day order by day`, [req.user.id, tzOffset(req)]);
    const totals = (await q(
      `select coalesce(sum(sessions), 0)::int as edits, count(distinct day)::int as days, count(distinct node_id)::int as notes
         from activity where user_id = $1`, [req.user.id])).rows[0];
    return { days: rows, totals };
  });

  app.get<{ Querystring: { day?: string } }>('/activity/day', async (req) => {
    const day = String(req.query.day ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw bad('Некорректная дата');
    // заметка могла быть удалена или стать недоступной — тогда остаётся только её название
    const { rows } = await q(
      `select a.node_id, a.name, a.sessions, a.chars, a.vault_id, v.name as vault_name,
              exists (select 1 from nodes n join vault_members m on m.vault_id = n.vault_id and m.user_id = $1 where n.id = a.node_id) as available
         from activity a left join vaults v on v.id = a.vault_id
        where a.user_id = $1 and a.day = $2::date order by a.sessions desc, a.last_at desc`, [req.user.id, day]);
    return {
      items: rows.map((r) => ({
        nodeId: r.node_id, name: r.name, sessions: r.sessions, chars: r.chars, vaultId: r.vault_id, vaultName: r.vault_name ?? 'удалённое хранилище',
        available: r.available,
      })),
    };
  });
}
