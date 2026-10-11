import { indentLess, indentMore, redo, selectAll, undo } from '@codemirror/commands';
import { EditorState, type TransactionSpec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { copyText, findInNote, MOD } from '../actions';
import { rawUrl } from '../api';
import {
  insertCallout, insertCodeBlock, insertHr, insertLink, insertTable, insertWikilink, replaceSelection, setHeading, toggleInline, toggleLinePrefix,
} from '../editor/commands';
import { configEffects, createState, type EditorHooks, languageFor } from '../editor/setup';
import { Icon, Logo } from '../icons';
import { renderMarkdown } from '../render/markdown';
import {
  activeId, byId, canWrite, createNode, currentVault, type Doc, docs, docTick, downloadNode, editorRef, ensureDoc, getText, isMobile, nodes, openLink,
  openMenu, overlay, pendingAnchor, searchFor, settings, textTick,
} from '../store';
import type { MenuItem, TreeNode } from '../types';
import { formatSize, isImage, isMarkdown, outline, splitExt } from '../util';

export const editorFocused = signal(false);
let readerEl: HTMLDivElement | null = null;

function dispatchTo(doc: Doc, spec: TransactionSpec) {
  if (!doc.state) return;
  const view = editorRef.view;
  if (view && view.state === doc.state) view.dispatch(spec); // слушатель редактора обновит doc.state
  else doc.state = doc.state.update(spec).state;
}

export function scrollToLine(line: number) {
  const view = editorRef.view;
  const doc = docs.get(activeId.peek() ?? '');
  if (!view || !doc?.state) return;
  if (doc.mode === 'read') {
    readerEl?.querySelector(`[data-line="${line}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    return;
  }
  const l = view.state.doc.line(Math.min(line + 1, view.state.doc.lines));
  view.dispatch({ selection: { anchor: l.to }, effects: EditorView.scrollIntoView(l.from, { y: 'start', yMargin: 20 }) });
  if (!isMobile.peek()) view.focus();
}

// ---------------------------------------------------------------- контекстное меню редактора
const ico = (name: string) => <Icon name={name} size={16} />;

function editorMenu(view: EditorView, md: boolean, link: DOMStringMap | null): MenuItem[] {
  const sel = view.state.selection.main;
  const text = view.state.sliceDoc(sel.from, sel.to);
  const ro = view.state.readOnly;
  const items: MenuItem[] = [];
  if (link?.wiki !== undefined) items.push({ label: 'Открыть заметку', icon: ico('external'), onClick: () => openLink(link.wiki!) }, { sep: true });
  else if (link?.href) {
    items.push({
      label: 'Открыть ссылку', icon: ico('external'),
      onClick: () => (/^[a-z][a-z0-9+.-]*:/i.test(link.href!) ? window.open(link.href, '_blank', 'noopener') : openLink(decodeURIComponent(link.href!))),
    }, { sep: true });
  }
  items.push(
    { label: 'Вырезать', icon: ico('cut'), hint: `${MOD}+X`, disabled: !text || ro, onClick: () => { copyText(text, 'Вырезано'); replaceSelection(view, ''); } },
    { label: 'Копировать', icon: ico('copy'), hint: `${MOD}+C`, disabled: !text, onClick: () => copyText(text) },
    {
      // читать буфер обмена браузер разрешает только по https; иначе остаётся Ctrl+V
      label: 'Вставить', icon: ico('paste'), hint: `${MOD}+V`, disabled: ro || !navigator.clipboard?.readText,
      onClick: () => navigator.clipboard.readText().then((t) => replaceSelection(view, t)).catch(() => {}),
    },
  );
  if (md && !ro) {
    items.push(
      { sep: true },
      {
        label: 'Формат', icon: ico('bold'), children: [
          { label: 'Жирный', icon: ico('bold'), hint: `${MOD}+B`, onClick: () => toggleInline(view, '**') },
          { label: 'Курсив', icon: ico('italic'), hint: `${MOD}+I`, onClick: () => toggleInline(view, '*') },
          { label: 'Зачёркнутый', icon: ico('strike'), hint: `${MOD}+Shift+X`, onClick: () => toggleInline(view, '~~') },
          { label: 'Выделение', icon: ico('highlight'), hint: `${MOD}+Shift+H`, onClick: () => toggleInline(view, '==') },
          { label: 'Код', icon: ico('code'), onClick: () => toggleInline(view, '`') },
        ],
      },
      {
        label: 'Абзац', icon: ico('heading'), children: [
          { label: 'Заголовок 1', onClick: () => setHeading(view, 1) },
          { label: 'Заголовок 2', onClick: () => setHeading(view, 2) },
          { label: 'Заголовок 3', onClick: () => setHeading(view, 3) },
          { label: 'Заголовок 4', onClick: () => setHeading(view, 4) },
          { label: 'Обычный текст', onClick: () => setHeading(view, 0) },
          { sep: true },
          { label: 'Маркированный список', icon: ico('list'), onClick: () => toggleLinePrefix(view, 'bullet') },
          { label: 'Нумерованный список', icon: ico('listOrdered'), onClick: () => toggleLinePrefix(view, 'number') },
          { label: 'Задача', icon: ico('task'), onClick: () => toggleLinePrefix(view, 'task') },
          { label: 'Цитата', icon: ico('quote'), onClick: () => toggleLinePrefix(view, 'quote') },
        ],
      },
      {
        label: 'Вставить', icon: ico('plus'), children: [
          { label: 'Ссылка', icon: ico('link'), hint: `${MOD}+K`, onClick: () => insertLink(view) },
          { label: 'Ссылка на заметку', icon: ico('brackets'), hint: '[[', onClick: () => insertWikilink(view) },
          { sep: true },
          { label: 'Блок кода', icon: ico('codeBlock'), onClick: () => insertCodeBlock(view) },
          { label: 'Таблица', icon: ico('table'), onClick: () => insertTable(view) },
          { label: 'Разделитель', icon: ico('minus'), onClick: () => insertHr(view) },
          { label: 'Шаблон…', icon: ico('template'), hint: 'Alt+T', onClick: () => { overlay.value = { type: 'templates' }; } },
          { sep: true },
          { label: 'Врезка: заметка', icon: ico('callout'), onClick: () => insertCallout(view, 'note') },
          { label: 'Врезка: совет', icon: ico('callout'), onClick: () => insertCallout(view, 'tip') },
          { label: 'Врезка: внимание', icon: ico('callout'), onClick: () => insertCallout(view, 'warning') },
        ],
      },
    );
  }
  items.push(
    { sep: true },
    { label: 'Найти в заметке', icon: ico('search'), hint: `${MOD}+F`, onClick: findInNote },
    { label: 'Выделить всё', hint: `${MOD}+A`, onClick: () => { selectAll(view); view.focus(); } },
  );
  if (text.trim() && text.length < 80 && !text.includes('\n')) items.push({ label: `Искать «${text.trim().slice(0, 24)}» в хранилище`, onClick: () => searchFor(text.trim()) });
  return items;
}

const hooks: EditorHooks = {
  onContextMenu(e, view) {
    // на сенсорном экране долгое нажатие — это выделение текста; системное меню не трогаем
    if ((e as PointerEvent).pointerType === 'touch' || !matchMedia('(any-pointer: fine)').matches) return false;
    e.preventDefault();
    const el = (e.target as HTMLElement).closest?.<HTMLElement>('[data-href], [data-wiki]');
    const link = el ? { ...el.dataset } : null;
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    const sel = view.state.selection.main;
    if (pos !== null && (pos < sel.from || pos > sel.to)) view.dispatch({ selection: { anchor: pos } });
    const node = byId.peek().get(activeId.peek() ?? '');
    openMenu(e, editorMenu(view, !!node && isMarkdown(node.name), link));
    return true;
  },
};

// ---------------------------------------------------------------- панель форматирования над клавиатурой
function cycleHeading(view: EditorView) {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const level = /^(#{1,6})\s/.exec(line.text)?.[1].length ?? 0;
  setHeading(view, level >= 3 ? 0 : level + 1);
}

function MobileToolbar({ md }: { md: boolean }) {
  const run = (fn: (view: EditorView) => unknown) => () => { const v = editorRef.view; if (v) { fn(v); v.focus(); } };
  const B = ({ icon, label, on }: { icon: string; label: string; on: (view: EditorView) => unknown }) => (
    // preventDefault на нажатии не даёт кнопке забрать фокус — клавиатура остаётся открытой
    <button type="button" class="icon-btn" aria-label={label} onPointerDown={(e) => e.preventDefault()} onMouseDown={(e) => e.preventDefault()} onClick={run(on)}>
      <Icon name={icon} size={20} />
    </button>
  );
  return (
    <div class="mtoolbar" role="toolbar" aria-label="Форматирование">
      <B icon="undo" label="Отменить" on={undo} />
      <B icon="redo" label="Повторить" on={redo} />
      <span class="mtoolbar-sep" />
      {md ? (
        <>
          <B icon="heading" label="Заголовок" on={cycleHeading} />
          <B icon="bold" label="Жирный" on={(v) => toggleInline(v, '**')} />
          <B icon="italic" label="Курсив" on={(v) => toggleInline(v, '*')} />
          <B icon="highlight" label="Выделение" on={(v) => toggleInline(v, '==')} />
          <B icon="strike" label="Зачёркнутый" on={(v) => toggleInline(v, '~~')} />
          <span class="mtoolbar-sep" />
          <B icon="list" label="Список" on={(v) => toggleLinePrefix(v, 'bullet')} />
          <B icon="task" label="Задача" on={(v) => toggleLinePrefix(v, 'task')} />
          <B icon="listOrdered" label="Нумерованный список" on={(v) => toggleLinePrefix(v, 'number')} />
        </>
      ) : null}
      <B icon="outdent" label="Уменьшить отступ" on={indentLess} />
      <B icon="indent" label="Увеличить отступ" on={indentMore} />
      {md ? (
        <>
          <span class="mtoolbar-sep" />
          <B icon="brackets" label="Ссылка на заметку" on={insertWikilink} />
          <B icon="link" label="Ссылка" on={insertLink} />
          <B icon="code" label="Код" on={(v) => toggleInline(v, '`')} />
          <B icon="codeBlock" label="Блок кода" on={insertCodeBlock} />
          <B icon="quote" label="Цитата" on={(v) => toggleLinePrefix(v, 'quote')} />
          <B icon="table" label="Таблица" on={insertTable} />
        </>
      ) : null}
      <span class="mtoolbar-sep" />
      <button type="button" class="icon-btn" aria-label="Скрыть клавиатуру" onClick={() => editorRef.view?.contentDOM.blur()}><Icon name="keyboard" size={20} /></button>
    </div>
  );
}

// ---------------------------------------------------------------- просмотр нетекстовых файлов
function Viewer({ node }: { node: TreeNode }) {
  const url = rawUrl(node.id, node.version);
  const ext = splitExt(node.name)[1];
  if (isImage(node.name)) return <div class="viewer"><img src={url} alt={node.name} /></div>;
  if (ext === 'pdf') return <div class="viewer"><iframe src={url} title={node.name} /></div>;
  if (['mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(ext)) return <div class="viewer"><audio controls src={url} /></div>;
  if (['mp4', 'webm', 'mov'].includes(ext)) return <div class="viewer"><video controls src={url} /></div>;
  return (
    <div class="viewer">
      <div class="file-card">
        <Icon name="fileBlank" size={40} />
        <b>{node.name}</b>
        <span>{formatSize(node.size)} · двоичный файл</span>
        <button type="button" class="btn btn-primary" onClick={() => downloadNode(node.id)}><Icon name="download" size={16} />Скачать</button>
      </div>
    </div>
  );
}

function Empty() {
  const vault = currentVault.value;
  return (
    <div class="empty">
      <div class="empty-box rise">
        <Logo size={56} />
        <h2>{vault ? vault.name : 'Оникс'}</h2>
        <p>{vault ? 'Откройте заметку из дерева файлов или создайте новую.' : 'Создайте хранилище, чтобы начать писать.'}</p>
        <div class="empty-actions">
          {vault && canWrite.value ? <button type="button" class="btn btn-primary" onClick={() => createNode('file')}><Icon name="filePlus" size={16} />Новая заметка</button> : null}
          {vault ? <button type="button" class="btn" onClick={() => { overlay.value = { type: 'palette', mode: 'files' }; }}><Icon name="search" size={16} />Найти файл</button> : null}
        </div>
        <div class="keys only-desktop">
          <div><span>Быстрый переход</span><kbd>{MOD} + O</kbd></div>
          <div><span>Палитра команд</span><kbd>{MOD} + P</kbd></div>
          <div><span>Чтение ↔ правка</span><kbd>{MOD} + E</kbd></div>
          <div><span>Новая заметка</span><kbd>Alt + N</kbd></div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- область документа
export function EditorPane() {
  docTick.value;
  const id = activeId.value;
  const node = id ? byId.value.get(id) : undefined;
  const doc = id ? docs.get(id) : undefined;
  const host = useRef<HTMLDivElement>(null);
  const reader = useRef<HTMLDivElement>(null);
  const s = settings.value;
  const ro = !canWrite.value;
  const md = !!node && isMarkdown(node.name);
  const ready = !!doc?.loaded && !!node && !node.binary;
  const mode = doc?.mode ?? 'live';
  const reading = ready && md && mode === 'read';
  const tick = textTick.value;
  const tree = nodes.value;

  // один экземпляр редактора на всё приложение; у каждой вкладки своё состояние (история правок, курсор)
  useEffect(() => {
    const el = host.current!;
    const view = new EditorView({ parent: el, state: EditorState.create({ doc: '' }) });
    editorRef.view = view;
    const onScroll = () => {
      const d = docs.get(activeId.peek() ?? '');
      if (d && view.state === d.state) d.scrollTop = view.scrollDOM.scrollTop;
    };
    const onIn = () => { editorFocused.value = true; };
    const onOut = () => { editorFocused.value = false; };
    view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('focusin', onIn);
    el.addEventListener('focusout', onOut);
    return () => { view.destroy(); editorRef.view = null; };
  }, []);

  useEffect(() => { if (id) ensureDoc(id); }, [id]);

  useEffect(() => {
    const view = editorRef.view;
    if (!view || !doc || !ready || !node) return;
    let fresh = false;
    if (!doc.state) {
      doc.state = createState(doc.id, node.name, doc.text, hooks);
      languageFor(node.name).then((effect) => { if (effect) dispatchTo(doc, { effects: effect }); });
    }
    if (view.state !== doc.state) { view.setState(doc.state); fresh = true; }
    view.dispatch({ effects: configEffects({ mode, md, lineNumbers: s.lineNumbers, spellcheck: s.spellcheck, readOnly: ro }) });
    if (fresh) {
      const top = doc.scrollTop;
      requestAnimationFrame(() => { view.scrollDOM.scrollTop = top; });
    }
    // новую пустую заметку можно сразу печатать; существующую открываем «чистой», без раскрытой разметки
    if (mode !== 'read') { view.requestMeasure(); if (fresh && !isMobile.peek() && !doc.state.doc.length && !ro) view.focus(); }
    if (pendingAnchor.id === doc.id) {
      const want = pendingAnchor.heading.trim().toLowerCase();
      pendingAnchor.id = null;
      const h = outline(getText(doc)).find((x) => x.text.trim().toLowerCase() === want);
      if (h) setTimeout(() => scrollToLine(h.line), 60);
    }
  }, [id, ready, mode, s.lineNumbers, s.spellcheck, ro]);

  // режим чтения: полный рендер, перерисовывается при правках (в том числе чужих)
  useEffect(() => {
    readerEl = reader.current;
    if (!reading || !doc) return;
    let alive = true;
    renderMarkdown(getText(doc)).then((root) => {
      const el = reader.current;
      if (!alive || !el) return;
      root.className = 'markdown reader-inner';
      const top = el.scrollTop;
      el.replaceChildren(root);
      el.scrollTop = top;
    });
    return () => { alive = false; };
  }, [id, reading, tick, tree]);

  const onReaderClick = (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    if (!doc) return;
    if (t instanceof HTMLInputElement && t.classList.contains('task')) {
      if (ro || !doc.state) { e.preventDefault(); return; }
      const line = doc.state.doc.line(Math.min(Number(t.dataset.line) + 1, doc.state.doc.lines));
      const m = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)[ xX]\]/.exec(line.text);
      if (m) dispatchTo(doc, { changes: { from: line.from + m[1].length, to: line.from + m[1].length + 1, insert: t.checked ? 'x' : ' ' } });
      return;
    }
    const a = t.closest('a');
    if (!a) return;
    if (a.dataset.wiki !== undefined) { e.preventDefault(); openLink(a.dataset.wiki); }
    else if (a.dataset.tag) { e.preventDefault(); searchFor(a.dataset.tag); }
  };

  const toolbar = isMobile.value && editorFocused.value && ready && !reading && !ro;

  return (
    <div class="pane">
      {!id ? <Empty /> : null}
      {id && node?.binary ? <Viewer node={node} /> : null}
      {id && node && !node.binary && !doc?.loaded ? (
        doc?.error ? <div class="empty"><div class="empty-box"><p>{doc.error}</p></div></div>
          : <div class="skeleton"><i style="width:45%;height:26px" /><i /><i style="width:88%" /><i style="width:72%" /><i style="width:80%" /></div>
      ) : null}
      <div ref={host} class={`editor-host${md ? '' : ' is-code'}`} hidden={!ready || reading} />
      <div ref={reader} class="reader" hidden={!reading} onClick={onReaderClick} />
      {toolbar ? <MobileToolbar md={md} /> : null}
    </div>
  );
}
