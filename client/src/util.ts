import DiffMatchPatch from 'diff-match-patch';

export const dmp = new DiffMatchPatch();

export function splitExt(name: string): [string, string] {
  const i = name.lastIndexOf('.');
  return i > 0 ? [name.slice(0, i), name.slice(i + 1).toLowerCase()] : [name, ''];
}
export const isMarkdown = (name: string) => /\.(md|markdown)$/i.test(name);
export const isImage = (name: string) => /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i.test(name);
export const displayName = (name: string) => (isMarkdown(name) ? name.replace(/\.(md|markdown)$/i, '') : name);
// имя, которым на файл ссылаются в [[…]]
export const linkName = (name: string) => (/\.md$/i.test(name) ? name.slice(0, -3) : name);

const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });
export const byName = (a: { name: string }, b: { name: string }) => collator.compare(a.name, b.name);

export function formatSize(n: number): string {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} КБ`;
  return `${(n / 1024 / 1024).toFixed(1)} МБ`;
}

const rtf = new Intl.RelativeTimeFormat('ru', { numeric: 'auto' });
export function timeAgo(iso: string): string {
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  if (Math.abs(s) < 60) return 'только что';
  if (Math.abs(s) < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (Math.abs(s) < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  if (Math.abs(s) < 86400 * 30) return rtf.format(Math.round(s / 86400), 'day');
  return new Date(iso).toLocaleDateString('ru');
}

export function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  downloadUrl(url, name);
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
export function downloadUrl(url: string, name = '') {
  const a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
}

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t = 0;
  return (...a: A) => { clearTimeout(t); t = window.setTimeout(() => fn(...a), ms); };
}

export const ls = {
  get<T>(key: string, fallback: T): T {
    try { const v = localStorage.getItem(key); return v === null ? fallback : (JSON.parse(v) as T); } catch { return fallback; }
  },
  set(key: string, value: unknown) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* хранилище переполнено или недоступно */ } },
  del(key: string) { try { localStorage.removeItem(key); } catch { /* недоступно */ } },
};

// минимальный набор правок, превращающий a в b — чтобы при слиянии не прыгал курсор
export function diffChanges(a: string, b: string): { from: number; to: number; insert: string }[] {
  const diffs = dmp.diff_main(a, b);
  dmp.diff_cleanupEfficiency(diffs);
  const out: { from: number; to: number; insert: string }[] = [];
  let pos = 0;
  for (const [op, text] of diffs) {
    if (op === 0) pos += text.length;
    else if (op === -1) { out.push({ from: pos, to: pos + text.length, insert: '' }); pos += text.length; }
    else out.push({ from: pos, to: pos, insert: text });
  }
  return out;
}

export interface Heading { level: number; text: string; line: number }
export function outline(text: string): Heading[] {
  const out: Heading[] = [];
  let fence: string | null = null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const f = /^\s*(```+|~~~+)/.exec(lines[i]);
    if (f) { fence = fence ? (lines[i].trim().startsWith(fence) ? null : fence) : f[1].slice(0, 3); continue; }
    if (fence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
    if (m) out.push({ level: m[1].length, text: m[2].replace(/[*_`=~]|\[\[|\]\]/g, ''), line: i });
  }
  return out;
}

export function contrastOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#04170f';
  const n = parseInt(m[1], 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? '#0a0b0d' : '#ffffff';
}
