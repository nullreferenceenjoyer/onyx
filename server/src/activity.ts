import type { FastifyRequest } from 'fastify';
import type { Db } from './db.js';

// смещение часового пояса пользователя в минутах: «сегодня» считается по его часам, а не по часам сервера
export function tzOffset(req: FastifyRequest): number {
  const n = Number(req.headers['x-tz-offset']);
  return Number.isFinite(n) ? Math.max(-840, Math.min(840, Math.round(n))) : 0;
}

const WINDOW_MIN = 10;

// Зачисляется и создание заметки, и её изменение. Сохранения идут каждую секунду набора, поэтому правки одной заметки
// считаются не чаще раза в 10 минут: last_at — момент последнего зачисления, а не последнего сохранения.
// Созданной заметке last_at ставится «в прошлое», чтобы первая же правка была засчитана отдельно от создания.
export async function recordActivity(db: Db, userId: string, node: { id: string; vault_id: string; name: string }, chars: number, tz: number, created = false) {
  await db.query(
    `insert into activity (user_id, node_id, vault_id, day, name, sessions, chars, last_at)
     values ($1, $2, $3, (now() at time zone 'utc' + make_interval(mins => $4))::date, $5, 1, $6, now() - make_interval(mins => $7))
     on conflict (user_id, node_id, day) do update set
       sessions = activity.sessions + (case when now() - activity.last_at >= make_interval(mins => $8) then 1 else 0 end),
       last_at = case when now() - activity.last_at >= make_interval(mins => $8) then now() else activity.last_at end,
       chars = activity.chars + excluded.chars, name = excluded.name`,
    [userId, node.id, node.vault_id, tz, node.name, Math.max(0, Math.round(chars)), created ? WINDOW_MIN : 0, WINDOW_MIN]);
}
