import { byId, docs, ensureDoc, getText, save, toast } from '../store';
import noteCss from '../styles/markdown.css?inline';
import { displayName, downloadBlob, escapeHtml, isMarkdown } from '../util';
import { renderMarkdown, renderPlain } from './markdown';

// Выгрузка одной заметки: самодостаточный HTML и печать (в т. ч. «Сохранить как PDF»).

const PAGE_CSS = `
:root { color-scheme: light dark; --bg: #ffffff; --surface-2: #f1f2f5; --text: #0a0b0d; --muted: #5f6672; --faint: #8b929c; --border: #e4e6eb;
  --border-strong: #d2d6dd; --accent: #0b7d5a; --danger: #d13a4d; --warn: #b9770a; --radius-sm: 10px;
  --font-text: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; --font-mono: ui-monospace, 'Cascadia Code', Consolas, monospace; --fs-text: 16px; }
@media (prefers-color-scheme: dark) { :root { --bg: #0a0b0d; --surface-2: #171a1e; --text: #f4f5f7; --muted: #a1a7b0; --faint: #6b727d;
  --border: #262a31; --border-strong: #3a404a; --accent: #3ddc97; --danger: #ff6b7d; --warn: #f5b84a; } }
@media print { :root { --bg: #fff; --surface-2: #f4f4f4; --text: #000; --muted: #444; --faint: #777; --border: #ddd; --border-strong: #bbb; --accent: #0b5d44; } }
html { background: var(--bg); }
body { margin: 0 auto; max-width: 780px; padding: 40px 24px 80px; }
h1.doc-title { font: 700 2.1em/1.2 var(--font-text); color: var(--text); margin: 0 0 .8em; letter-spacing: -.02em; }
`;

async function currentText(id: string): Promise<string> {
  const doc = ensureDoc(id);
  if (doc.loading) await doc.loading;
  await save(doc);
  return getText(docs.get(id) ?? doc);
}

async function render(id: string): Promise<HTMLElement | null> {
  const node = byId.value.get(id);
  if (!node || node.binary) return null;
  const text = await currentText(id);
  const root = isMarkdown(node.name) ? await renderMarkdown(text) : renderPlain(text);
  root.className = 'markdown';
  return root;
}

const toDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = reject;
  r.readAsDataURL(blob);
});

export async function exportHtml(id: string) {
  const node = byId.value.get(id);
  const root = await render(id);
  if (!node || !root) { toast('Этот файл нельзя выгрузить как HTML', 'error'); return; }
  // вложенные картинки встраиваются в файл, чтобы он открывался где угодно
  await Promise.all([...root.querySelectorAll('img')].map(async (img) => {
    const src = img.getAttribute('src') ?? '';
    if (!src.startsWith('/api/')) return;
    try { img.setAttribute('src', await toDataUrl(await (await fetch(src, { credentials: 'same-origin' })).blob())); } catch { /* остаётся ссылкой */ }
    img.removeAttribute('loading');
  }));
  for (const a of root.querySelectorAll('a[data-wiki], a[data-tag]')) a.removeAttribute('href');
  for (const box of root.querySelectorAll('input.task')) box.setAttribute('disabled', '');
  const title = displayName(node.name);
  const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${PAGE_CSS}${noteCss}</style>
</head>
<body>
<h1 class="doc-title">${escapeHtml(title)}</h1>
${root.outerHTML}
</body>
</html>
`;
  downloadBlob(`${title}.html`, new Blob([html], { type: 'text/html;charset=utf-8' }));
}

export async function printNote(id: string) {
  const node = byId.value.get(id);
  const root = await render(id);
  if (!node || !root) { toast('Этот файл нельзя напечатать', 'error'); return; }
  document.getElementById('print-root')?.remove();
  const host = document.createElement('div');
  host.id = 'print-root';
  const h = document.createElement('h1');
  h.className = 'doc-title';
  h.textContent = displayName(node.name);
  host.append(h, root);
  document.body.appendChild(host);
  // картинки должны успеть загрузиться до открытия диалога печати
  await Promise.all([...host.querySelectorAll('img')].map((img) => {
    img.loading = 'eager';
    return img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; setTimeout(r, 4000); });
  }));
  const prev = document.title;
  document.title = displayName(node.name);
  const done = () => { document.title = prev; host.remove(); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
}
