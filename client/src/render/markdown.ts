import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';
import { rawUrl } from '../api';
import { calloutKind, calloutTitle } from '../editor/live';
import { resolveLink } from '../store';
import { displayName, escapeHtml, isImage } from '../util';

// Режим чтения и выгрузка в HTML: полный рендер Markdown с расширениями Obsidian.

type Hljs = typeof import('highlight.js').default;
let hljs: Hljs | null = null;
async function loadHljs() {
  if (!hljs) hljs = (await import('highlight.js/lib/common')).default as Hljs;
}

const md = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: true,
  highlight(code, lang) {
    if (hljs && lang && hljs.getLanguage(lang)) {
      try { return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value; } catch { /* без подсветки */ }
    }
    return '';
  },
});

// ---- [[вики-ссылки]] и ![[вставки]]
md.inline.ruler.before('link', 'wikilink', (state, silent) => {
  const src = state.src;
  let pos = state.pos;
  const embed = src.charCodeAt(pos) === 33;
  if (embed) pos++;
  if (src.charCodeAt(pos) !== 91 || src.charCodeAt(pos + 1) !== 91) return false;
  const end = src.indexOf(']]', pos + 2);
  if (end < 0 || end === pos + 2) return false;
  const inner = src.slice(pos + 2, end);
  if (/[\n[]/.test(inner)) return false;
  if (!silent) {
    const token = state.push('wikilink', '', 0);
    token.content = inner;
    token.meta = { embed };
  }
  state.pos = end + 2;
  return true;
});
md.renderer.rules.wikilink = (tokens, i) => {
  const { content } = tokens[i];
  const meta = tokens[i].meta as { embed: boolean };
  const pipe = content.indexOf('|');
  const target = pipe < 0 ? content : content.slice(0, pipe);
  const alias = pipe < 0 ? '' : content.slice(pipe + 1);
  const node = resolveLink(target);
  if (meta.embed && (isImage(target.split('#')[0]) || (node && isImage(node.name)))) {
    if (!node) return `<span class="missing-embed">Файл не найден: ${escapeHtml(target)}</span>`;
    const width = /^\d+$/.test(alias) ? ` width="${alias}"` : '';
    return `<img src="${rawUrl(node.id, node.version)}" alt="${escapeHtml(target)}"${width}>`;
  }
  const label = alias || (node ? displayName(node.name) + (target.includes('#') ? ' › ' + target.split('#')[1] : '') : target);
  return `<a class="internal-link${node ? '' : ' is-missing'}${meta.embed ? ' embed-chip' : ''}" data-wiki="${escapeHtml(target)}">${escapeHtml(label)}</a>`;
};

// ---- ==выделение==
md.inline.ruler.before('emphasis', 'mark', (state, silent) => {
  const src = state.src, pos = state.pos;
  if (src.charCodeAt(pos) !== 61 || src.charCodeAt(pos + 1) !== 61) return false;
  const end = src.indexOf('==', pos + 2);
  if (end < 0 || end === pos + 2 || src.slice(pos + 2, end).includes('\n')) return false;
  if (!silent) {
    state.push('mark_open', 'mark', 1);
    const old = state.posMax;
    state.pos = pos + 2;
    state.posMax = end;
    state.md.inline.tokenize(state);
    state.posMax = old;
    state.push('mark_close', 'mark', -1);
  }
  state.pos = end + 2;
  return true;
});

// ---- #теги
md.inline.ruler.push('hashtag', (state, silent) => {
  const src = state.src, pos = state.pos;
  if (src.charCodeAt(pos) !== 35) return false;
  if (pos > 0 && !/[\s(]/.test(src[pos - 1])) return false;
  const m = /^[\p{L}\p{N}_/-]+/u.exec(src.slice(pos + 1, pos + 80));
  if (!m || /^\d+$/.test(m[0])) return false;
  if (!silent) {
    const token = state.push('hashtag', '', 0);
    token.content = '#' + m[0];
  }
  state.pos = pos + 1 + m[0].length;
  return true;
});
md.renderer.rules.hashtag = (tokens, i) => `<a class="tag" data-tag="${escapeHtml(tokens[i].content)}">${escapeHtml(tokens[i].content)}</a>`;

// ---- задачи: «- [ ]» превращается в флажок, который помнит свою строку в исходнике
md.core.ruler.after('inline', 'tasks', (state) => {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i++) {
    const inline = tokens[i];
    if (inline.type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') continue;
    const first = inline.children?.[0];
    const m = first?.type === 'text' ? /^\[([ xX])\](?:\s+|$)/.exec(first.content) : null;
    if (!m || !first) continue;
    first.content = first.content.slice(m[0].length);
    const box = new state.Token('html_inline', '', 0);
    const line = (inline.map?.[0] ?? 0) + Number(state.env?.lineOffset ?? 0);
    box.content = `<input type="checkbox" class="task" data-line="${line}"${m[1] === ' ' ? '' : ' checked'}> `;
    inline.children!.unshift(box);
    tokens[i - 2].attrJoin('class', 'task-item' + (m[1] === ' ' ? '' : ' is-done'));
  }
});

// ---- заголовки помнят строку (для оглавления), ссылки и картинки ведут куда надо
md.renderer.rules.heading_open = (tokens, i, opts, env, self) => {
  tokens[i].attrSet('data-line', String((tokens[i].map?.[0] ?? 0) + Number(env?.lineOffset ?? 0)));
  return self.renderToken(tokens, i, opts);
};
const isExternal = (href: string) => /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');
md.renderer.rules.link_open = (tokens, i, opts, _env, self) => {
  const href = String(tokens[i].attrGet('href') ?? '');
  if (href.startsWith('#')) return self.renderToken(tokens, i, opts);
  if (isExternal(href)) {
    tokens[i].attrSet('target', '_blank');
    tokens[i].attrSet('rel', 'noopener noreferrer');
  } else {
    let path = href;
    try { path = decodeURIComponent(href); } catch { /* как есть */ }
    tokens[i].attrSet('data-wiki', path);
    tokens[i].attrSet('class', 'internal-link' + (resolveLink(path) ? '' : ' is-missing'));
    tokens[i].attrs = tokens[i].attrs!.filter(([k]) => k !== 'href');
  }
  return self.renderToken(tokens, i, opts);
};
const defaultImage = md.renderer.rules.image!;
md.renderer.rules.image = (tokens, i, opts, env, self) => {
  const src = String(tokens[i].attrGet('src') ?? '');
  if (!isExternal(src) && !src.startsWith('/api/')) {
    let path = src;
    try { path = decodeURIComponent(src); } catch { /* как есть */ }
    const node = resolveLink(path);
    tokens[i].attrSet('src', node ? rawUrl(node.id, node.version) : '');
  }
  tokens[i].attrSet('loading', 'lazy');
  return defaultImage(tokens, i, opts, env, self);
};

DOMPurify.addHook('afterSanitizeAttributes', (el) => {
  // флажки нужны только как задачи; прочие поля ввода из заметок не пропускаем
  if (el.tagName === 'INPUT' && (el.getAttribute('type') !== 'checkbox' || !el.classList.contains('task'))) el.remove();
});

function splitFrontmatter(text: string): { meta: string; body: string; offset: number } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(text);
  if (!m) return { meta: '', body: text, offset: 0 };
  return { meta: m[1], body: text.slice(m[0].length), offset: m[0].split('\n').length - 1 };
}

// «> [!note] Заголовок» → оформленная врезка
function callouts(root: HTMLElement) {
  for (const bq of [...root.querySelectorAll('blockquote')]) {
    const p = bq.firstElementChild;
    if (!p || p.tagName !== 'P') continue;
    const first = p.firstChild;
    const m = first?.nodeType === 3 ? /^\[!([\w-]+)\]([+-]?)[ \t]*/.exec(first.nodeValue ?? '') : null;
    if (!m || !first) continue;
    first.nodeValue = (first.nodeValue ?? '').slice(m[0].length);
    const type = m[1].toLowerCase();
    const title = document.createElement('div');
    title.className = 'callout-title';
    // заголовок — первая строка абзаца, остальное уходит в тело
    while (p.firstChild && p.firstChild.nodeName !== 'BR') title.appendChild(p.firstChild);
    p.firstChild?.remove();
    if (!title.textContent?.trim()) title.textContent = calloutTitle(type);
    if (!p.textContent?.trim() && !p.querySelector('img')) p.remove();

    const foldable = m[2] !== '';
    const box = document.createElement(foldable ? 'details' : 'div');
    box.className = `callout callout-${calloutKind(type)}`;
    if (foldable) {
      if (m[2] === '+') (box as HTMLDetailsElement).open = true;
      const summary = document.createElement('summary');
      summary.className = 'callout-title';
      summary.append(...title.childNodes);
      box.appendChild(summary);
    } else {
      box.appendChild(title);
    }
    const body = document.createElement('div');
    body.className = 'callout-body';
    body.append(...bq.childNodes);
    if (body.textContent?.trim() || body.querySelector('img')) box.appendChild(body);
    bq.replaceWith(box);
  }
}

export async function renderMarkdown(text: string): Promise<HTMLElement> {
  if (text.includes('```') || text.includes('~~~')) await loadHljs().catch(() => {});
  const { meta, body, offset } = splitFrontmatter(text);
  const html = md.render(body, { lineOffset: offset });
  const root = document.createElement('div');
  root.innerHTML = DOMPurify.sanitize(html, {
    ADD_ATTR: ['target', 'data-wiki', 'data-tag', 'data-line', 'loading'],
    FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select'],
  });
  callouts(root);
  for (const table of [...root.querySelectorAll('table')]) {
    // широкие таблицы прокручиваются сами, а не растягивают страницу
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    table.replaceWith(wrap);
    wrap.appendChild(table);
  }
  if (meta) {
    const box = document.createElement('details');
    box.className = 'frontmatter';
    box.innerHTML = `<summary>Свойства</summary><pre>${escapeHtml(meta)}</pre>`;
    root.prepend(box);
  }
  return root;
}

export function renderPlain(text: string): HTMLElement {
  const root = document.createElement('div');
  const pre = document.createElement('pre');
  pre.className = 'plain';
  pre.textContent = text;
  root.appendChild(pre);
  return root;
}
