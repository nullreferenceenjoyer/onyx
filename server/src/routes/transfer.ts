import type { FastifyInstance } from 'fastify';
import { unzipSync, zipSync, type Zippable } from 'fflate';
import type pg from 'pg';
import { nodeCtx, uniqueName, vaultRole } from '../access.js';
import { q, tx } from '../db.js';
import { hub } from '../hub.js';
import { bad, contentDisposition, sanitizeName } from '../http.js';

const utf8 = new TextDecoder('utf-8', { fatal: true });

// текстом считаем всё, что является корректным UTF-8 без нулевых байтов, — расширение не важно
function asText(buf: Uint8Array): string | null {
  if (buf.includes(0)) return null;
  try { return utf8.decode(buf).replace(/^﻿/, ''); } catch { return null; }
}

interface Row { id: string; parent_id: string | null; name: string; kind: string; content: string | null; blob: Buffer | null }

function buildZip(rows: Row[], rootId: string | null): Uint8Array {
  const byParent = new Map<string | null, Row[]>();
  for (const r of rows) {
    const list = byParent.get(r.parent_id);
    if (list) list.push(r); else byParent.set(r.parent_id, [r]);
  }
  const files: Zippable = {};
  const walk = (parent: string | null, prefix: string) => {
    for (const r of byParent.get(parent) ?? []) {
      if (r.kind === 'folder') {
        files[`${prefix}${r.name}/`] = new Uint8Array(0);
        walk(r.id, `${prefix}${r.name}/`);
      } else {
        files[prefix + r.name] = r.blob ? new Uint8Array(r.blob) : new TextEncoder().encode(r.content ?? '');
      }
    }
  };
  walk(rootId, '');
  return zipSync(files, { level: 6 });
}

export async function transferRoutes(app: FastifyInstance) {
  // ---- выгрузка всего хранилища одним архивом
  app.get<{ Params: { id: string } }>('/vaults/:id/export', async (req, reply) => {
    await vaultRole(req.user.id, req.params.id);
    const vault = (await q('select name from vaults where id = $1', [req.params.id])).rows[0];
    const { rows } = await q<Row>('select id, parent_id, name, kind, content, blob from nodes where vault_id = $1 order by name', [req.params.id]);
    const zip = buildZip(rows, null);
    reply.header('Content-Type', 'application/zip').header('Content-Disposition', contentDisposition(`${vault.name}.zip`));
    return reply.send(Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength));
  });

  // ---- выгрузка папки архивом
  app.get<{ Params: { id: string } }>('/nodes/:id/export', async (req, reply) => {
    const { node } = await nodeCtx(req.user.id, req.params.id);
    if (node.kind !== 'folder') throw bad('Архивом выгружаются папки; файл скачивается как есть');
    const { rows } = await q<Row>(
      `with recursive sub as (
         select id, parent_id, name, kind, content, blob from nodes where parent_id = $1
         union all
         select n.id, n.parent_id, n.name, n.kind, n.content, n.blob from nodes n join sub on n.parent_id = sub.id)
       select * from sub order by name`, [node.id]);
    const zip = buildZip(rows, node.id);
    reply.header('Content-Type', 'application/zip').header('Content-Disposition', contentDisposition(`${node.name}.zip`));
    return reply.send(Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength));
  });

  // ---- загрузка файлов, папок и zip-архивов (например, готового хранилища Obsidian)
  app.post<{ Params: { id: string }; Querystring: { parentId?: string } }>('/vaults/:id/upload', async (req) => {
    const vaultId = req.params.id;
    await vaultRole(req.user.id, vaultId, true);
    const rootParent = req.query.parentId || null;
    if (rootParent) {
      const ok = (await q("select 1 from nodes where id = $1 and vault_id = $2 and kind = 'folder'", [rootParent, vaultId])).rowCount;
      if (!ok) throw bad('Папка назначения не найдена');
    }

    const items: { path: string; data: Uint8Array | null }[] = [];
    let pendingPath: string | null = null;
    let unzip = false;
    for await (const part of req.parts()) {
      if (part.type === 'field') {
        if (part.fieldname === 'path') pendingPath = String(part.value);
        if (part.fieldname === 'unzip') unzip = part.value === '1';
        continue;
      }
      const buf = await part.toBuffer();
      const path = pendingPath ?? part.filename;
      pendingPath = null;
      if (unzip && /\.zip$/i.test(path)) {
        let entries: Record<string, Uint8Array>;
        try { entries = unzipSync(new Uint8Array(buf)); } catch { throw bad(`Не удалось распаковать архив «${path}»`); }
        for (const [name, data] of Object.entries(entries)) {
          // служебные папки macOS и настройки Obsidian заметками не являются
          if (/(^|\/)(__MACOSX|\.obsidian|\.trash|\.git)\//.test(name) || /(^|\/)\.DS_Store$/.test(name)) continue;
          items.push({ path: name, data: name.endsWith('/') ? null : data });
        }
      } else {
        items.push({ path, data: buf });
      }
    }
    if (!items.length) throw bad('Нет файлов для загрузки');

    const created: string[] = [];
    await tx(async (c) => {
      const folders = new Map<string, string>();
      const ensureFolder = async (parentId: string | null, name: string): Promise<string> => {
        const key = `${parentId}/${name.toLowerCase()}`;
        const hit = folders.get(key);
        if (hit) return hit;
        const found = (await c.query(
          "select id from nodes where vault_id = $1 and parent_id is not distinct from $2 and lower(name) = lower($3) and kind = 'folder'",
          [vaultId, parentId, name])).rows[0];
        const id = found?.id ?? (await insert(c, parentId, await uniqueName(c, vaultId, parentId, name), 'folder', null));
        folders.set(key, id);
        return id;
      };
      const insert = async (db: pg.PoolClient, parentId: string | null, name: string, kind: string, data: Uint8Array | null): Promise<string> => {
        const text = data ? asText(data) : null;
        const { rows } = await db.query(
          `insert into nodes (vault_id, parent_id, name, kind, content, blob, size, updated_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
          [vaultId, parentId, name, kind, kind === 'file' ? text : null, kind === 'file' && text === null && data ? Buffer.from(data) : null,
            data?.byteLength ?? 0, req.user.id]);
        return rows[0].id;
      };

      for (const item of items) {
        const segs = item.path.split(/[\\/]+/).map(sanitizeName).filter(Boolean);
        if (!segs.length) continue;
        let parent = rootParent;
        const dirs = item.data ? segs.slice(0, -1) : segs;
        for (const d of dirs) parent = await ensureFolder(parent, d);
        if (!item.data) continue;
        const name = await uniqueName(c, vaultId, parent, segs[segs.length - 1]);
        created.push(await insert(c, parent, name, 'file', item.data));
      }
    });

    hub.toVault(vaultId, { t: 'tree', origin: String(req.headers['x-client-id'] ?? '') });
    return { created: created.length, firstId: created[0] ?? null };
  });
}
