import type { FastifyInstance, FastifyRequest } from 'fastify';
import { NODE_COLS, nodeDto, type NodeRow } from '../access.js';
import { currentUser } from '../auth.js';
import { q } from '../db.js';
import { HttpError, notFound } from '../http.js';
import { linkTargets, sendRaw } from './nodes.js';

// Публичная часть: заметки по ссылке и открытые профили. Вход не требуется
// (кроме доступа, выданного конкретному человеку), всё только для чтения.

const GONE = 'Ссылка недействительна или срок её действия истёк';

interface Share { id: string; node_id: string; vault_id: string; created_by: string; user_id: string | null; expires_at: Date | null; created_at: Date; owner_name: string }

async function loadShare(req: FastifyRequest, token: string): Promise<Share> {
  const share = (await q<Share>(
    `select s.id, s.node_id, s.vault_id, s.created_by, s.user_id, s.expires_at, s.created_at, u.display_name as owner_name
       from shares s join users u on u.id = s.created_by
      where s.token = $1 and (s.expires_at is null or s.expires_at > now())`, [token])).rows[0];
  if (!share) throw notFound(GONE);
  if (share.user_id) {
    const user = await currentUser(req);
    if (!user) throw new HttpError(401, 'Эта заметка открыта конкретному человеку — войдите в свой аккаунт');
    if (user.id !== share.user_id && user.id !== share.created_by) throw notFound(GONE);
  }
  return share;
}

// что именно видно по ссылке: папка со всем содержимым либо заметка и картинки, которые в неё вставлены
async function scope(share: Share): Promise<{ root: NodeRow; nodes: NodeRow[] }> {
  const root = (await q<NodeRow>(`select ${NODE_COLS} from nodes where id = $1`, [share.node_id])).rows[0];
  if (!root) throw notFound(GONE);
  if (root.kind === 'folder') {
    const { rows } = await q<NodeRow>(
      `with recursive sub as (
         select * from nodes where parent_id = $1
         union all select n.* from nodes n join sub on n.parent_id = sub.id)
       select ${NODE_COLS} from sub`, [root.id]);
    return { root, nodes: rows };
  }
  if (root.binary) return { root, nodes: [root] };
  const content = (await q('select content from nodes where id = $1', [root.id])).rows[0].content ?? '';
  const names = linkTargets(content).map((t) => t.split('/').pop()!.toLowerCase()).filter((n) => /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/.test(n));
  if (!names.length) return { root, nodes: [root] };
  const { rows } = await q<NodeRow>(
    `select ${NODE_COLS} from nodes where vault_id = $1 and kind = 'file' and blob is not null and lower(name) = any($2::text[])`, [root.vault_id, names]);
  return { root, nodes: [root, ...rows] };
}

export async function publicShareRoutes(app: FastifyInstance) {
  app.get<{ Params: { token: string } }>('/public/:token', async (req) => {
    const share = await loadShare(req, req.params.token);
    const { root, nodes } = await scope(share);
    await q('update shares set views = views + 1 where id = $1', [share.id]);
    const folder = root.kind === 'folder';
    return {
      share: { name: root.name, kind: root.kind, binary: root.binary, ownerName: share.owner_name, expiresAt: share.expires_at, createdAt: share.created_at, personal: !!share.user_id },
      rootId: root.id,
      // для зрителя общая папка — это корень; о том, где она лежит в хранилище, ему знать незачем
      nodes: nodes.map((n) => ({ ...nodeDto(n), parentId: folder && n.parent_id === root.id ? null : folder ? n.parent_id : null })),
      content: !folder && !root.binary ? (await q('select content from nodes where id = $1', [root.id])).rows[0].content ?? '' : null,
    };
  });

  app.get<{ Params: { token: string; id: string } }>('/public/:token/node/:id', async (req) => {
    const share = await loadShare(req, req.params.token);
    const node = (await scope(share)).nodes.find((n) => n.id === req.params.id);
    if (!node || node.kind !== 'file' || node.binary) throw notFound();
    return { content: (await q('select content from nodes where id = $1', [node.id])).rows[0].content ?? '' };
  });

  app.get<{ Params: { token: string; id: string }; Querystring: { download?: string } }>('/public/:token/raw/:id', async (req, reply) => {
    const share = await loadShare(req, req.params.token);
    const node = (await scope(share)).nodes.find((n) => n.id === req.params.id);
    if (!node) throw notFound();
    return sendRaw(req, reply, node, req.query.download === '1');
  });

  // ---- открытый профиль: имя, карта активности и заметки, которые автор решил показать
  app.get<{ Params: { login: string } }>('/profile/:login', async (req) => {
    const user = (await q('select id, login, display_name, bio, created_at, profile_public from users where login = $1', [req.params.login.toLowerCase()])).rows[0];
    const viewer = await currentUser(req);
    if (!user || (!user.profile_public && viewer?.id !== user.id)) throw notFound('Профиль не найден или закрыт');
    const days = (await q(
      `select to_char(day, 'YYYY-MM-DD') as day, sum(sessions)::int as count, count(*)::int as notes
         from activity where user_id = $1 and day > current_date - 372 group by day order by day`, [user.id])).rows;
    const notes = (await q(
      `select s.token, n.name, n.kind, s.created_at, s.views, n.updated_at from shares s join nodes n on n.id = s.node_id
        where s.created_by = $1 and s.user_id is null and s.listed and (s.expires_at is null or s.expires_at > now())
        order by n.updated_at desc`, [user.id])).rows;
    return {
      profile: { login: user.login, displayName: user.display_name, bio: user.bio, joinedAt: user.created_at, isPublic: user.profile_public },
      days,
      notes: notes.map((n) => ({ token: n.token, name: n.name, kind: n.kind, createdAt: n.created_at, updatedAt: n.updated_at, views: n.views })),
    };
  });
}
