import { syntaxTree } from '@codemirror/language';
import type { Extension, Range } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { rawUrl } from '../api';
import { nodes, openLink, resolveLink, searchFor } from '../store';
import { displayName, isImage } from '../util';

// «Живой просмотр», как в Obsidian: разметка прячется, пока курсор не встанет на элемент.
// В режиме исходника (live = false) остаются только классы оформления.

const CALLOUT_TITLES: Record<string, string> = {
  note: 'Заметка', info: 'Информация', tip: 'Совет', hint: 'Совет', important: 'Важно', success: 'Готово', check: 'Готово', done: 'Готово',
  question: 'Вопрос', help: 'Вопрос', faq: 'Вопрос', warning: 'Внимание', caution: 'Внимание', attention: 'Внимание', failure: 'Ошибка',
  fail: 'Ошибка', danger: 'Опасно', error: 'Ошибка', bug: 'Баг', example: 'Пример', quote: 'Цитата', cite: 'Цитата', abstract: 'Кратко',
  summary: 'Кратко', tldr: 'Кратко', todo: 'Сделать',
};
export const calloutTitle = (type: string) => CALLOUT_TITLES[type] ?? type.charAt(0).toUpperCase() + type.slice(1);
// несколько синонимов сводятся к общим цветам
export const calloutKind = (type: string) => {
  if (['tip', 'hint', 'important', 'success', 'check', 'done'].includes(type)) return 'good';
  if (['warning', 'caution', 'attention', 'question', 'help', 'faq'].includes(type)) return 'warn';
  if (['failure', 'fail', 'danger', 'error', 'bug', 'missing'].includes(type)) return 'bad';
  if (['example', 'quote', 'cite'].includes(type)) return 'soft';
  return 'info';
};

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) { super(); }
  eq(o: CheckboxWidget) { return o.checked === this.checked; }
  toDOM(view: EditorView) {
    const el = document.createElement('input');
    el.type = 'checkbox';
    el.className = 'cm-task';
    el.checked = this.checked;
    el.addEventListener('mousedown', (e) => e.preventDefault());
    el.addEventListener('click', (e) => {
      e.preventDefault();
      if (view.state.readOnly) return;
      const pos = view.posAtDOM(el);
      if (/^\[.\]$/.test(view.state.sliceDoc(pos, pos + 3))) {
        view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: this.checked ? ' ' : 'x' } });
      }
    });
    return el;
  }
  ignoreEvent() { return true; }
}

class TextWidget extends WidgetType {
  constructor(readonly cls: string, readonly text: string) { super(); }
  eq(o: TextWidget) { return o.cls === this.cls && o.text === this.text; }
  toDOM() {
    const el = document.createElement('span');
    el.className = this.cls;
    el.textContent = this.text;
    return el;
  }
  ignoreEvent() { return false; }
}

class ImageWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string, readonly width: number) { super(); }
  eq(o: ImageWidget) { return o.src === this.src && o.width === this.width && o.alt === this.alt; }
  toDOM() {
    const wrap = document.createElement('span');
    wrap.className = 'cm-img-wrap';
    if (!this.src) {
      wrap.classList.add('is-missing');
      wrap.textContent = `Файл не найден: ${this.alt}`;
      return wrap;
    }
    const img = document.createElement('img');
    img.className = 'cm-img';
    img.src = this.src;
    img.alt = this.alt;
    img.loading = 'lazy';
    img.draggable = false;
    if (this.width) img.style.width = `${this.width}px`;
    wrap.appendChild(img);
    return wrap;
  }
  ignoreEvent() { return false; }
}

class EmbedChip extends WidgetType {
  constructor(readonly target: string, readonly label: string, readonly missing: boolean) { super(); }
  eq(o: EmbedChip) { return o.target === this.target && o.label === this.label && o.missing === this.missing; }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-embed-chip cm-link-rendered' + (this.missing ? ' is-missing' : '');
    el.dataset.wiki = this.target;
    el.textContent = this.label;
    return el;
  }
  ignoreEvent() { return false; }
}

function imageSrc(url: string): string {
  if (/^(https?:|data:image\/|blob:)/i.test(url)) return url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return '';
  let path = url;
  try { path = decodeURIComponent(url); } catch { /* оставляем как есть */ }
  const node = resolveLink(path);
  return node ? rawUrl(node.id, node.version) : '';
}

const hide = Decoration.replace({});
const lineDeco = (cls: string) => Decoration.line({ class: cls });

function build(view: EditorView, live: boolean): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  const out: Range<Decoration>[] = [];
  const ranges = state.selection.ranges;
  // разметка раскрывается только там, где стоит курсор, и только пока редактор в фокусе
  const reveal = !state.readOnly && view.hasFocus;
  const touch = (from: number, to: number) => reveal && ranges.some((r) => r.from <= to && r.to >= from);
  const lineTouch = (pos: number) => { const l = doc.lineAt(pos); return touch(l.from, l.to); };
  const slice = (n: { from: number; to: number }) => state.sliceDoc(n.from, n.to);
  const eachLine = (from: number, to: number, fn: (line: { from: number; to: number; text: string; number: number }, i: number, last: boolean) => void) => {
    const a = doc.lineAt(from).number, b = doc.lineAt(to).number;
    for (let n = a; n <= b; n++) fn(doc.line(n), n - a, n === b);
  };

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from, to,
      enter(ref) {
        const name = ref.name;

        if (name.startsWith('ATXHeading')) {
          out.push(lineDeco(`cm-h cm-h${name.slice(10)}`).range(doc.lineAt(ref.from).from));
          return;
        }
        if (name.startsWith('SetextHeading')) {
          eachLine(ref.from, ref.to, (l) => out.push(lineDeco(`cm-h cm-h${name.slice(13)}`).range(l.from)));
          return;
        }

        switch (name) {
          case 'HeaderMark': {
            const parent = ref.node.parent;
            if (!live || !parent?.name.startsWith('ATXHeading') || lineTouch(ref.from)) return;
            const end = ref.from === parent.from && state.sliceDoc(ref.to, ref.to + 1) === ' ' ? ref.to + 1 : ref.to;
            if (end > ref.from) out.push(hide.range(ref.from, end));
            return;
          }

          case 'EmphasisMark': case 'StrikethroughMark': case 'HighlightMark': {
            const p = ref.node.parent;
            if (live && p && !touch(p.from, p.to)) out.push(hide.range(ref.from, ref.to));
            return;
          }
          case 'Highlight':
            out.push(Decoration.mark({ class: 'cm-highlight' }).range(ref.from, ref.to));
            return;

          case 'InlineCode': {
            out.push(Decoration.mark({ class: 'cm-inline-code' }).range(ref.from, ref.to));
            if (live && !touch(ref.from, ref.to)) {
              for (const m of ref.node.getChildren('CodeMark')) out.push(hide.range(m.from, m.to));
            }
            return false;
          }

          case 'Link': {
            const marks = ref.node.getChildren('LinkMark');
            const url = ref.node.getChild('URL');
            if (marks.length < 4 || !url) return;
            const textFrom = marks[0].to, textTo = marks[1].from;
            if (textTo <= textFrom) return;
            const hidden = live && !touch(ref.from, ref.to);
            out.push(Decoration.mark({ class: 'cm-link' + (hidden ? ' cm-link-rendered' : ''), attributes: { 'data-href': slice(url) } }).range(textFrom, textTo));
            if (hidden) { out.push(hide.range(ref.from, textFrom)); out.push(hide.range(textTo, ref.to)); }
            return;
          }
          case 'URL': {
            const p = ref.node.parent?.name;
            if (p === 'Link' || p === 'Image' || p === 'LinkReference') return;
            out.push(Decoration.mark({ class: 'cm-link cm-link-rendered', attributes: { 'data-href': slice(ref) } }).range(ref.from, ref.to));
            return;
          }

          case 'Image': {
            if (!live) return false;
            const url = ref.node.getChild('URL');
            const marks = ref.node.getChildren('LinkMark');
            if (!url || marks.length < 2) return false;
            const [alt, size] = state.sliceDoc(marks[0].to, marks[1].from).split('|');
            const widget = new ImageWidget(imageSrc(slice(url)), alt || slice(url), /^\d+$/.test(size ?? '') ? Number(size) : 0);
            if (touch(ref.from, ref.to)) out.push(Decoration.widget({ widget, side: 1 }).range(ref.to));
            else out.push(Decoration.replace({ widget }).range(ref.from, ref.to));
            return false;
          }

          case 'Embed': {
            const [target, size] = state.sliceDoc(ref.from + 3, ref.to - 2).split('|');
            out.push(Decoration.mark({ class: 'cm-wikilink' }).range(ref.from, ref.to));
            if (!live) return false;
            const node = resolveLink(target);
            const widget = isImage(target.split('#')[0]) || (node && isImage(node.name))
              ? new ImageWidget(node ? rawUrl(node.id, node.version) : '', target, /^\d+$/.test(size ?? '') ? Number(size) : 0)
              : new EmbedChip(target, node ? displayName(node.name) : target, !node);
            if (touch(ref.from, ref.to)) out.push(Decoration.widget({ widget, side: 1 }).range(ref.to));
            else out.push(Decoration.replace({ widget }).range(ref.from, ref.to));
            return false;
          }

          case 'Wikilink': {
            const inner = state.sliceDoc(ref.from + 2, ref.to - 2);
            const pipe = inner.indexOf('|');
            const target = pipe < 0 ? inner : inner.slice(0, pipe);
            const missing = !resolveLink(target);
            const visFrom = ref.from + 2 + (pipe >= 0 ? pipe + 1 : 0);
            const hidden = live && !touch(ref.from, ref.to) && visFrom < ref.to - 2;
            const cls = 'cm-wikilink' + (missing ? ' is-missing' : '') + (hidden ? ' cm-link-rendered' : '');
            if (hidden) {
              out.push(hide.range(ref.from, visFrom));
              out.push(Decoration.mark({ class: cls, attributes: { 'data-wiki': target } }).range(visFrom, ref.to - 2));
              out.push(hide.range(ref.to - 2, ref.to));
            } else {
              out.push(Decoration.mark({ class: cls, attributes: { 'data-wiki': target } }).range(ref.from, ref.to));
            }
            return false;
          }

          case 'Hashtag':
            out.push(Decoration.mark({ class: 'cm-hashtag cm-link-rendered', attributes: { 'data-tag': slice(ref) } }).range(ref.from, ref.to));
            return;

          case 'Blockquote': {
            if (ref.node.parent?.name === 'Blockquote') return;
            const first = doc.lineAt(ref.from);
            const m = /^(\s*>\s*)\[!([\w-]+)\][+-]?( ?)(.*)$/.exec(first.text);
            const type = m ? m[2].toLowerCase() : '';
            eachLine(ref.from, ref.to, (l, i) => {
              out.push(lineDeco(m ? `cm-callout cm-callout-${calloutKind(type)}${i === 0 ? ' cm-callout-head' : ''}` : 'cm-quote').range(l.from));
            });
            if (m && live && !touch(first.from, first.to)) {
              const a = first.from + m[1].length;
              const b = a + m[0].length - m[1].length - m[4].length;
              // без своего заголовка показываем название типа
              out.push(Decoration.replace(m[4].trim() ? {} : { widget: new TextWidget('cm-callout-title', calloutTitle(type)) }).range(a, b));
            }
            return;
          }
          case 'QuoteMark': {
            if (!live || lineTouch(ref.from)) return;
            const end = state.sliceDoc(ref.to, ref.to + 1) === ' ' ? ref.to + 1 : ref.to;
            out.push(hide.range(ref.from, end));
            return;
          }

          case 'FencedCode': {
            const first = doc.lineAt(ref.from), last = doc.lineAt(ref.to);
            eachLine(ref.from, ref.to, (l, i, isLast) => {
              out.push(lineDeco('cm-code' + (i === 0 ? ' cm-code-first' : '') + (isLast ? ' cm-code-last' : '')).range(l.from));
            });
            if (live && !touch(ref.from, ref.to)) {
              const info = ref.node.getChild('CodeInfo');
              const marks = ref.node.getChildren('CodeMark');
              const close = marks[marks.length - 1];
              if (first.to > ref.from) out.push(Decoration.replace({ widget: new TextWidget('cm-code-lang', info ? slice(info) : '') }).range(ref.from, first.to));
              if (marks.length > 1 && close.from >= last.from && last.number > first.number) out.push(hide.range(close.from, close.to));
            }
            return;
          }
          case 'CodeBlock':
            eachLine(ref.from, ref.to, (l, i, isLast) => {
              out.push(lineDeco('cm-code' + (i === 0 ? ' cm-code-first' : '') + (isLast ? ' cm-code-last' : '')).range(l.from));
            });
            return;

          case 'HorizontalRule': {
            if (live && !lineTouch(ref.from)) out.push(Decoration.replace({ widget: new TextWidget('cm-hr', '') }).range(ref.from, ref.to));
            return;
          }

          case 'ListMark': {
            const list = ref.node.parent?.parent?.name;
            // «- [ ]» в самом конце строки — тоже задача, просто пока без текста
            const task = /^ \[([ xX])\](?: |$)/.exec(state.sliceDoc(ref.to, Math.min(ref.to + 5, doc.lineAt(ref.to).to)));
            if (task) {
              const tFrom = ref.to + 1, tTo = ref.to + 4;
              const checked = task[1] !== ' ';
              if (checked) out.push(lineDeco('cm-task-done').range(doc.lineAt(ref.from).from));
              if (live && !touch(ref.from, tTo)) {
                out.push(hide.range(ref.from, tFrom));
                out.push(Decoration.replace({ widget: new CheckboxWidget(checked) }).range(tFrom, tTo));
              } else {
                out.push(Decoration.mark({ class: 'cm-list-mark' }).range(ref.from, tTo));
              }
            } else if (list === 'BulletList' && live && !touch(ref.from, ref.to)) {
              out.push(Decoration.replace({ widget: new TextWidget('cm-bullet', '•') }).range(ref.from, ref.to));
            } else {
              out.push(Decoration.mark({ class: 'cm-list-mark' }).range(ref.from, ref.to));
            }
            return;
          }

          case 'Table':
            eachLine(ref.from, ref.to, (l, i) => out.push(lineDeco('cm-table' + (i === 0 ? ' cm-table-head' : '')).range(l.from)));
            return;

          case 'DashLine': case 'FrontmatterContent':
            eachLine(ref.from, ref.to, (l) => out.push(lineDeco('cm-frontmatter').range(l.from)));
            return;
        }
        return;
      },
    });
  }
  return Decoration.set(out, true);
}

function follow(el: HTMLElement) {
  const { href, wiki, tag } = el.dataset;
  if (tag) { searchFor(tag); return; }
  if (wiki !== undefined) { openLink(wiki); return; }
  if (!href) return;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) { window.open(href, '_blank', 'noopener'); return; }
  if (/^www\./i.test(href)) { window.open('https://' + href, '_blank', 'noopener'); return; }
  let path = href;
  try { path = decodeURIComponent(href); } catch { /* как есть */ }
  openLink(path);
}

export function livePreview(live: boolean): Extension {
  const plugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    seen = nodes.peek();
    constructor(view: EditorView) { this.decorations = build(view, live); }
    update(u: ViewUpdate) {
      // дерево файлов меняется — меняется и то, какие ссылки «битые»
      const treeChanged = this.seen !== nodes.peek();
      this.seen = nodes.peek();
      if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || treeChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        this.decorations = build(u.view, live);
      }
    }
  }, { decorations: (v) => v.decorations });

  return [
    plugin,
    EditorView.domEventHandlers({
      mousedown(e) {
        if (e.button !== 0) return false;
        const el = (e.target as HTMLElement).closest?.<HTMLElement>('[data-href], [data-wiki], [data-tag]');
        if (!el) return false;
        // отрисованная ссылка открывается сразу; в исходнике — с Ctrl, чтобы можно было править
        if (!(e.ctrlKey || e.metaKey) && !(live && el.classList.contains('cm-link-rendered'))) return false;
        e.preventDefault();
        follow(el);
        return true;
      },
    }),
  ];
}

export type { SyntaxNode };
