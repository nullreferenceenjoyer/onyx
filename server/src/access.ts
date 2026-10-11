import { q, type Db } from './db.js';
import { forbidden, notFound } from './http.js';

export type Role = 'owner' | 'editor' | 'viewer';

export interface NodeRow {
  id: string; vault_id: string; parent_id: string | null; name: string; kind: 'folder' | 'file';
  binary: boolean; size: number; version: number; updated_at: Date;
}

export const NODE_COLS = 'id, vault_id, parent_id, name, kind, (blob is not null) as binary, size, version, updated_at';

export const nodeDto = (r: NodeRow) => ({
  id: r.id, parentId: r.parent_id, name: r.name, kind: r.kind, binary: r.binary,
  size: r.size, version: r.version, updatedAt: r.updated_at,
});

export async function vaultRole(userId: string, vaultId: string, write = false): Promise<Role> {
  const { rows } = await q('select role from vault_members where vault_id = $1 and user_id = $2', [vaultId, userId]);
  if (!rows[0]) throw notFound('Хранилище не найдено');
  if (write && rows[0].role === 'viewer') throw forbidden('Хранилище доступно только для чтения');
  return rows[0].role;
}

export async function nodeCtx(userId: string, nodeId: string, write = false): Promise<{ node: NodeRow; role: Role }> {
  const { rows } = await q(
    `select n.id, n.vault_id, n.parent_id, n.name, n.kind, (n.blob is not null) as binary, n.size, n.version, n.updated_at, m.role
       from nodes n join vault_members m on m.vault_id = n.vault_id and m.user_id = $2
      where n.id = $1`, [nodeId, userId]);
  if (!rows[0]) throw notFound('Файл не найден');
  if (write && rows[0].role === 'viewer') throw forbidden('Хранилище доступно только для чтения');
  const { role, ...node } = rows[0];
  return { node, role };
}

export function splitExt(name: string): [string, string] {
  const i = name.lastIndexOf('.');
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ''];
}

// «Заметка.md» → «Заметка 1.md», если имя в папке уже занято
export async function uniqueName(db: Db, vaultId: string, parentId: string | null, name: string): Promise<string> {
  const { rows } = await db.query('select lower(name) as n from nodes where vault_id = $1 and parent_id is not distinct from $2', [vaultId, parentId]);
  const taken = new Set(rows.map((r: { n: string }) => r.n));
  if (!taken.has(name.toLowerCase())) return name;
  const [base, ext] = splitExt(name);
  for (let i = 1; ; i++) {
    const next = `${base} ${i}${ext}`;
    if (!taken.has(next.toLowerCase())) return next;
  }
}
