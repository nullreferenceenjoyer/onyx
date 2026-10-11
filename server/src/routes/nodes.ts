import type { FastifyInstance, FastifyRequest } from 'fastify';
import { NODE_COLS, nodeCtx, nodeDto, splitExt, uniqueName, vaultRole } from '../access.js';
import { q, tx } from '../db.js';
import { hub } from '../hub.js';
import { bad, cleanName, contentDisposition, escapeLike, escapeRegex } from '../http.js';

const origin = (req: FastifyRequest) => String(req.headers['x-client-id'] ?? '');
const treeChanged = (vaultId: string, req: FastifyRequest) => hub.toVault(vaultId, { t: 'tree', origin: origin(req) });

// встраиваем в страницу только то, что не может выполнить скрипт в нашем источнике
const INLINE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml', pdf: 'application/pdf',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
};

// имя, под которым на файл ссылаются: [[Заметка]] для .md и [[схема.png]] для остальных
const linkName = (name: string) => (/\.md$/i.test(name) ? name.slice(0, -3) : name);
const linkPattern = (name: string) =>
  `(\\[\\[(?:[^\\]\\[|#]*/)?)${escapeRegex(linkName(name))}${/\.md$/i.test(name) ? '(?:\\.md)?' : ''}(?=[\\]|#])`;

function snippets(content: string, test: (line: string) => number, max = 3): string[] {
  const out: string[] = [];
  for (const line of content.split('\n')) {
    const at = test(line);
    if (at < 0) continue;
    const from = Math.max(0, at - 60);
    out.push((from ? '…' : '') + line.slice(from, at + 140).trim() + (line.length > at + 140 ? '…' : ''));
    if (out.length >= max) break;
  }
  return out;
}

export async function nodeRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/vaults/:id/tree', async (req) => {
    const role = await vaultRole(req.user.id, req.params.id);
    const { rows } = await q(`select ${NODE_COLS} from nodes where vault_id = $1`, [req.params.id]);
    return { role, nodes: rows.map(nodeDto) };
  });

  app.post<{ Params: { id: string } }>('/vaults/:id/nodes', async (req) => {
    await vaultRole(req.user.id, req.params.id, true);
    const body = (req.body ?? {}) as any;
    const kind = body.kind === 'folder' ? 'folder' : 'file';
    const parentId: string | null = body.parentId || null;
    const content = kind === 'file' ? String(body.content ?? '') : null;
    if (content?.includes('\u0000')) throw bad('Недопустимые символы в тексте');
    const node = await tx(async (c) => {
      if (parentId) {
        const p = (await c.query("select 1 from nodes where id = $1 and vault_id = $2 and kind = 'folder'", [parentId, req.params.id])).rowCount;
        if (!p) throw bad('Папка назначения не найдена');
      }
      let name = cleanName(body.name);
      if (body.autoRename) name = await uniqueName(c, req.params.id, parentId, name);
      return (await c.query(
        `insert into nodes (vault_id, parent_id, name, kind, content, size, updated_by)
         values ($1, $2, $3, $4, $5::text, coalesce(octet_length($5::text), 0), $6) returning ${NODE_COLS}`,
        [req.params.id, parentId, name, kind, content, req.user.id])).rows[0];
    });
    treeChanged(req.params.id, req);
    return { node: nodeDto(node) };
  });

  app.get<{ Params: { id: string } }>('/nodes/:id', async (req) => {
    const { node } = await nodeCtx(req.user.id, req.params.id);
    if (node.kind !== 'file' || node.binary) return { node: nodeDto(node), content: null };
    const { rows } = await q('select content, version from nodes where id = $1', [node.id]);
    return { node: { ...nodeDto(node), version: rows[0].version }, content: rows[0].content ?? '' };
  });

  app.get<{ Params: { id: string }; Querystring: { download?: string } }>('/nodes/:id/raw', async (req, reply) => {
    const { node } = await nodeCtx(req.user.id, req.params.id);
    if (node.kind !== 'file') throw bad('Это папка');
    const etag = `"${node.id}-${node.version}"`;
    reply.header('ETag', etag).header('Cache-Control', 'private, no-cache').header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    const row = (await q('select content, blob from nodes where id = $1', [node.id])).rows[0];
    const ext = splitExt(node.name)[1].slice(1).toLowerCase();
    const download = req.query.download === '1';
    if (row.blob) {
      const mime = INLINE_MIME[ext];
      // у PDF «песочница» ломает встроенный просмотрщик, а скриптов из нашего источника он не выполняет
      if (ext === 'pdf') reply.removeHeader('Content-Security-Policy');
      reply.header('Content-Type', mime ?? 'application/octet-stream')
        .header('Content-Disposition', contentDisposition(node.name, !!mime && !download));
      return reply.send(row.blob);
    }
    reply.header('Content-Type', 'text/plain; charset=utf-8').header('Content-Disposition', contentDisposition(node.name, !download));
    return reply.send(row.content ?? '');
  });

  app.put<{ Params: { id: string } }>('/nodes/:id/content', async (req, reply) => {
    const { node } = await nodeCtx(req.user.id, req.params.id, true);
    if (node.kind !== 'file' || node.binary) throw bad('Этот файл нельзя редактировать как текст');
    const body = (req.body ?? {}) as any;
    if (typeof body.content !== 'string' || body.content.includes('\u0000')) throw bad('Недопустимое содержимое');
    const { rows } = await q(
      `update nodes set content = $1::text, size = octet_length($1::text), version = version + 1, updated_at = now(), updated_by = $2
        where id = $3 and version = $4 returning version, size, updated_at`,
      [body.content, req.user.id, node.id, Number(body.baseVersion)]);
    if (!rows[0]) {
      // кто-то сохранил раньше: отдаём свежий текст, клиент сольёт правки и повторит
      const cur = (await q('select content, version from nodes where id = $1', [node.id])).rows[0];
      return reply.code(409).send({ conflict: true, content: cur.content ?? '', version: cur.version });
    }
    hub.toVault(node.vault_id, {
      t: 'content', id: node.id, version: rows[0].version, size: rows[0].size, updatedAt: rows[0].updated_at,
      by: req.user.displayName, origin: origin(req),
    });
    return { version: rows[0].version, size: rows[0].size, updatedAt: rows[0].updated_at };
  });

  // переименование и перемещение
  app.patch<{ Params: { id: string } }>('/nodes/:id', async (req) => {
    const { node } = await nodeCtx(req.user.id, req.params.id, true);
    const body = (req.body ?? {}) as any;
    const name = body.name !== undefined ? cleanName(body.name) : node.name;
    const parentId: string | null = body.parentId !== undefined ? (body.parentId || null) : node.parent_id;

    const touched = await tx(async (c) => {
      if (parentId !== node.parent_id && parentId) {
        const p = (await c.query("select 1 from nodes where id = $1 and vault_id = $2 and kind = 'folder'", [parentId, node.vault_id])).rowCount;
        if (!p) throw bad('Папка назначения не найдена');
        const inside = (await c.query(
          `with recursive up as (
             select id, parent_id from nodes where id = $1
             union all select n.id, n.parent_id from nodes n join up on n.id = up.parent_id)
           select 1 from up where id = $2`, [parentId, node.id])).rowCount;
        if (inside) throw bad('Нельзя переместить папку внутрь самой себя');
      }
      await c.query('update nodes set name = $1, parent_id = $2, updated_at = now() where id = $3', [name, parentId, node.id]);

      // как в Obsidian: ссылки [[…]] на переименованный файл обновляются сами
      if (node.kind !== 'file' || linkName(name) === linkName(node.name)) return [];
      const pattern = linkPattern(node.name);
      const repl = '\\1' + linkName(name).replace(/\\/g, '\\\\');
      return (await c.query(
        `update nodes n set content = s.c, size = octet_length(s.c), version = n.version + 1, updated_at = now(), updated_by = $4
           from (select id, regexp_replace(content, $2, $3, 'gi') as c from nodes
                  where vault_id = $1 and kind = 'file' and content is not null and content ~* $2) s
          where n.id = s.id returning n.id, n.version, n.size, n.updated_at`,
        [node.vault_id, pattern, repl, req.user.id])).rows;
    });

    treeChanged(node.vault_id, req);
    for (const t of touched) {
      hub.toVault(node.vault_id, { t: 'content', id: t.id, version: t.version, size: t.size, updatedAt: t.updated_at, by: req.user.displayName, origin: '' });
    }
    return { ok: true, relinked: touched.length };
  });

  app.delete<{ Params: { id: string } }>('/nodes/:id', async (req) => {
    const { node } = await nodeCtx(req.user.id, req.params.id, true);
    await q('delete from nodes where id = $1', [node.id]);
    treeChanged(node.vault_id, req);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/nodes/:id/duplicate', async (req) => {
    const { node } = await nodeCtx(req.user.id, req.params.id, true);
    if (node.kind !== 'file') throw bad('Дублировать можно только файлы');
    const copy = await tx(async (c) => {
      const [base, ext] = splitExt(node.name);
      const name = await uniqueName(c, node.vault_id, node.parent_id, `${base} — копия${ext}`);
      return (await c.query(
        `insert into nodes (vault_id, parent_id, name, kind, content, blob, size, updated_by)
         select vault_id, parent_id, $2, kind, content, blob, size, $3 from nodes where id = $1 returning ${NODE_COLS}`,
        [node.id, name, req.user.id])).rows[0];
    });
    treeChanged(node.vault_id, req);
    return { node: nodeDto(copy) };
  });

  // ---- поиск по именам и тексту
  app.get<{ Params: { id: string }; Querystring: { q?: string } }>('/vaults/:id/search', async (req) => {
    await vaultRole(req.user.id, req.params.id);
    const query = String(req.query.q ?? '').trim().slice(0, 200);
    if (query.length < 2) return { results: [] };
    const like = `%${escapeLike(query)}%`;
    const { rows } = await q(
      `select id, name, content, (name ilike $2) as by_name from nodes
        where vault_id = $1 and kind = 'file' and (name ilike $2 or (blob is null and content ilike $2))
        order by (name ilike $2) desc, updated_at desc limit 60`, [req.params.id, like]);
    const needle = query.toLowerCase();
    return {
      results: rows.map((r) => ({
        id: r.id, byName: r.by_name,
        snippets: r.content ? snippets(r.content, (line) => line.toLowerCase().indexOf(needle)) : [],
      })),
    };
  });

  // ---- обратные ссылки: кто ссылается на этот файл
  app.get<{ Params: { id: string } }>('/nodes/:id/backlinks', async (req) => {
    const { node } = await nodeCtx(req.user.id, req.params.id);
    if (node.kind !== 'file') return { results: [] };
    const pattern = linkPattern(node.name);
    const { rows } = await q(
      `select id, content from nodes where vault_id = $1 and kind = 'file' and blob is null and id <> $2 and content ~* $3
        order by updated_at desc limit 100`, [node.vault_id, node.id, pattern]);
    const re = new RegExp(pattern, 'i');
    return { results: rows.map((r) => ({ id: r.id, snippets: snippets(r.content, (line) => line.search(re)) })) };
  });
}
