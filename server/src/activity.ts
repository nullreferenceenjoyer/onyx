import type { FastifyRequest } from 'fastify';
import type { Db } from './db.js';

// смещение часового пояса пользователя в минутах: «сегодня» считается по его часам, а не по часам сервера
export function tzOffset(req: FastifyRequest): number {
  const n = Number(req.headers['x-tz-offset']);
  return Number.isFinite(n) ? Math.max(-840, Math.min(840, Math.round(n))) : 0;
}

// одна «правка» на сеанс: сохранения с паузами до 10 минут считаются одним сеансом работы над заметкой
export async function recordActivity(db: Db, userId: string, node: { id: string; vault_id: string; name: string }, chars: number, tz: number) {
  await db.query(
    `insert into activity (user_id, node_id, vault_id, day, name, sessions, chars, last_at)
     values ($1, $2, $3, (now() at time zone 'utc' + make_interval(mins => $4))::date, $5, 1, $6, now())
     on conflict (user_id, node_id, day) do update set
       sessions = activity.sessions + (case when now() - activity.last_at > interval '10 minutes' then 1 else 0 end),
       chars = activity.chars + excluded.chars, name = excluded.name, last_at = now()`,
    [userId, node.id, node.vault_id, tz, node.name, Math.max(0, Math.round(chars))]);
}
