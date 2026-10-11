import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export const q = <T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []) =>
  pool.query<T>(text, params as any[]);

export type Db = Pick<pg.PoolClient, 'query'>;

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const res = await fn(c);
    await c.query('commit');
    return res;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export const ROOT = '00000000-0000-0000-0000-000000000000';

const MIGRATIONS: [string, string][] = [
  ['001_init', `
    create table users (
      id uuid primary key default gen_random_uuid(),
      login text not null unique,
      display_name text not null,
      password_hash text not null,
      settings jsonb not null default '{}',
      created_at timestamptz not null default now()
    );
    create table sessions (
      id uuid primary key default gen_random_uuid(),
      token_hash text not null unique,
      user_id uuid not null references users(id) on delete cascade,
      user_agent text,
      created_at timestamptz not null default now(),
      last_seen_at timestamptz not null default now(),
      expires_at timestamptz not null
    );
    create index sessions_user on sessions(user_id);
    create table vaults (
      id uuid primary key default gen_random_uuid(),
      name text not null,
      owner_id uuid not null references users(id) on delete cascade,
      created_at timestamptz not null default now()
    );
    create table vault_members (
      vault_id uuid not null references vaults(id) on delete cascade,
      user_id uuid not null references users(id) on delete cascade,
      role text not null check (role in ('owner', 'editor', 'viewer')),
      primary key (vault_id, user_id)
    );
    create index vault_members_user on vault_members(user_id);
    create table nodes (
      id uuid primary key default gen_random_uuid(),
      vault_id uuid not null references vaults(id) on delete cascade,
      parent_id uuid references nodes(id) on delete cascade,
      name text not null,
      kind text not null check (kind in ('folder', 'file')),
      content text,
      blob bytea,
      size integer not null default 0,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      updated_by uuid references users(id) on delete set null
    );
    create unique index nodes_unique_name on nodes (vault_id, coalesce(parent_id, '${ROOT}'::uuid), lower(name));
    create index nodes_parent on nodes(parent_id);
  `],
];

export async function migrate(log: (m: string) => void) {
  // база в соседнем контейнере может подняться чуть позже приложения
  for (let i = 0; ; i++) {
    try { await q('select 1'); break; } catch (e) {
      if (i >= 30) throw e;
      log('Ожидание базы данных…');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  await tx(async (c) => {
    await c.query('select pg_advisory_xact_lock(7707001)');
    await c.query('create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())');
    const done = new Set((await c.query('select id from schema_migrations')).rows.map((r) => r.id));
    for (const [id, sql] of MIGRATIONS) {
      if (done.has(id)) continue;
      await c.query(sql);
      await c.query('insert into schema_migrations (id) values ($1)', [id]);
      log(`Миграция ${id} применена`);
    }
  });
  // триграммный индекс ускоряет поиск, но требует прав на расширение — без него поиск просто медленнее
  try {
    await q('create extension if not exists pg_trgm');
    await q('create index if not exists nodes_content_trgm on nodes using gin (content gin_trgm_ops)');
    await q('create index if not exists nodes_name_trgm on nodes using gin (name gin_trgm_ops)');
  } catch {
    log('pg_trgm недоступен — поиск работает без индекса');
  }
}
