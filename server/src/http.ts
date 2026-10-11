export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const bad = (m: string) => new HttpError(400, m);
export const forbidden = (m = 'Недостаточно прав') => new HttpError(403, m);
export const notFound = (m = 'Не найдено') => new HttpError(404, m);
export const conflict = (m: string) => new HttpError(409, m);

const BAD_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

// имена должны пережить выгрузку в zip и распаковку на любой ОС
export function cleanName(v: unknown): string {
  if (typeof v !== 'string') throw bad('Не указано имя');
  const name = v.trim().replace(/[. ]+$/, '');
  if (!name || name === '.' || name === '..') throw bad('Недопустимое имя');
  if (name.length > 200) throw bad('Слишком длинное имя');
  if (name.search(BAD_CHARS) !== -1) throw bad('Имя не должно содержать символы \\ / : * ? " < > |');
  return name;
}

// то же для импорта: не отклоняем, а исправляем
export function sanitizeName(v: string): string {
  const name = v.replace(BAD_CHARS, '_').trim().replace(/[. ]+$/, '').slice(0, 200);
  return name === '.' || name === '..' ? '' : name;
}

export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\\-]/g, '\\$&');
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');

export function contentDisposition(name: string, inline = false): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
