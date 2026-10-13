import { autocompletion, closeBrackets, closeBracketsKeymap, type CompletionContext, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { deleteMarkupBackward, insertNewlineContinueMarkupCommand, markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { yamlFrontmatter } from '@codemirror/lang-yaml';
import { bracketMatching, HighlightStyle, indentOnInput, indentUnit, LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, type Extension, type StateEffect } from '@codemirror/state';
import { drawSelection, dropCursor, EditorView, keymap, lineNumbers, placeholder } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { activeId, byId, docChanged, docs, files, loadTree, pathOf, Remote, uploadFiles, wikiLabel } from '../store';
import type { Mode } from '../types';
import { isImage, isMarkdown, splitExt } from '../util';
import { insertLink, toggleInline } from './commands';
import { continueList, dedentListItem, indentListItem, taskShorthand } from './lists';
import { livePreview } from './live';
import { Hashtag, Highlight, Wikilink } from './syntax';

const langComp = new Compartment();
const modeComp = new Compartment();
const prefsComp = new Compartment();
const editableComp = new Compartment();

// цвета берутся из CSS-переменных темы, поэтому одна схема подходит и светлой, и тёмной
const highlight = HighlightStyle.define([
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--muted)' },
  { tag: t.link, color: 'var(--accent)' },
  { tag: t.url, color: 'var(--faint)' },
  { tag: t.monospace, fontFamily: 'var(--font-mono)' },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: 'var(--faint)' },
  { tag: t.quote, color: 'var(--muted)' },
  { tag: t.labelName, color: 'var(--faint)' },
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit], color: 'var(--syn-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--faint)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: 'var(--syn-func)' },
  { tag: [t.typeName, t.className, t.namespace, t.tagName], color: 'var(--syn-type)' },
  { tag: [t.propertyName, t.attributeName, t.definition(t.propertyName)], color: 'var(--syn-prop)' },
  { tag: [t.operator, t.punctuation, t.bracket, t.separator], color: 'var(--muted)' },
  { tag: t.invalid, color: 'var(--danger)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', color: 'var(--text)', backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 30%, transparent)',
  },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--faint)', border: 'none' },
});

const mdSupport = yamlFrontmatter({
  content: markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [Wikilink, Highlight, Hashtag], completeHTMLTags: false, addKeymap: false }),
});

// подсказка заметок после «[[»
function wikiCompletion(ctx: CompletionContext) {
  const m = ctx.matchBefore(/!?\[\[[^\]\[|#\n]*$/);
  if (!m) return null;
  const from = m.from + m.text.indexOf('[[') + 2;
  return {
    from,
    validFor: /^[^\]\[|#\n]*$/,
    options: files.peek().filter((n) => n.id !== activeId.peek()).slice(0, 3000).map((n) => ({
      label: wikiLabel(n),
      detail: pathOf(n.id, false),
      type: 'text',
      apply(view: EditorView, _c: unknown, a: number, b: number) {
        const closed = view.state.sliceDoc(b, b + 2) === ']]';
        const insert = wikiLabel(n) + (closed ? '' : ']]');
        view.dispatch({ changes: { from: a, to: b, insert }, selection: { anchor: a + wikiLabel(n).length + 2 }, userEvent: 'input.complete' });
      },
    })),
  };
}

// списки ведёт lists.ts; библиотечная команда остаётся для цитат и продолжения абзацев внутри пунктов
const mdKeymap = [
  { key: 'Enter', run: continueList },
  { key: 'Enter', run: insertNewlineContinueMarkupCommand({ nonTightLists: false }) },
  { key: 'Backspace', run: deleteMarkupBackward },
  { key: 'Tab', run: indentListItem },
  { key: 'Shift-Tab', run: dedentListItem },
];

const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

// вставленные и перетащенные файлы становятся вложениями рядом с заметкой
async function attach(view: EditorView, list: File[]) {
  const here = byId.peek().get(activeId.peek() ?? '');
  for (const file of list) {
    const [, ext] = splitExt(file.name);
    const generic = /^(image|blob|file)(\.\w+)?$/i.test(file.name) || !file.name;
    const name = generic ? `Вставка ${stamp()}.${ext || (file.type.split('/')[1] ?? 'png')}` : file.name;
    const id = await uploadFiles([{ file, path: name }], here?.parentId ?? null);
    if (!id) continue;
    await loadTree();
    const node = byId.peek().get(id);
    if (!node) continue;
    const link = `${isImage(node.name) ? '!' : ''}[[${wikiLabel(node)}]]`;
    view.dispatch(view.state.replaceSelection(link + (list.length > 1 ? '\n' : '')), { userEvent: 'input.paste' });
  }
}

export interface EditorHooks { onContextMenu: (e: MouseEvent, view: EditorView) => boolean }

export function createState(id: string, name: string, text: string, hooks: EditorHooks): EditorState {
  const md = isMarkdown(name);
  return EditorState.create({
    doc: text,
    extensions: [
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      indentUnit.of('\t'),
      EditorState.tabSize.of(4),
      bracketMatching(),
      closeBrackets(),
      search({ top: true }),
      EditorView.lineWrapping,
      placeholder('Начните писать…'),
      syntaxHighlighting(highlight),
      theme,
      autocompletion({ override: md ? [wikiCompletion] : undefined, icons: false }),
      keymap.of([
        { key: 'Mod-b', run: (v) => md && toggleInline(v, '**') },
        { key: 'Mod-i', run: (v) => md && toggleInline(v, '*') },
        { key: 'Mod-k', run: (v) => md && insertLink(v) },
        { key: 'Mod-Shift-h', run: (v) => md && toggleInline(v, '==') },
        { key: 'Mod-Shift-x', run: (v) => md && toggleInline(v, '~~') },
        ...(md ? mdKeymap : []),
        ...closeBracketsKeymap,
        ...completionKeymap,
        ...searchKeymap,
        ...historyKeymap,
        indentWithTab,
        ...defaultKeymap,
      ]),
      EditorView.scrollMargins.of(() => ({ bottom: 64, top: 8 })),
      langComp.of(md ? mdSupport : []),
      md ? taskShorthand : [],
      modeComp.of([]),
      prefsComp.of([]),
      editableComp.of([]),
      EditorView.updateListener.of((u) => {
        const doc = docs.get(id);
        if (!doc) return;
        doc.state = u.state;
        if (u.docChanged) docChanged(id, u.state, u.transactions.every((tr) => tr.annotation(Remote)));
      }),
      EditorView.domEventHandlers({
        contextmenu: (e, view) => hooks.onContextMenu(e, view),
        paste(e, view) {
          if (view.state.readOnly) return false;
          const list = [...(e.clipboardData?.files ?? [])];
          if (list.length) { e.preventDefault(); attach(view, list); return true; }
          // ссылка поверх выделенного текста превращает его в [текст](ссылку)
          const text = e.clipboardData?.getData('text/plain').trim() ?? '';
          const sel = view.state.selection.main;
          if (md && !sel.empty && /^https?:\/\/\S+$/.test(text)) {
            const cur = view.state.sliceDoc(sel.from, sel.to);
            if (!/^https?:\/\//.test(cur) && !cur.includes('\n')) {
              e.preventDefault();
              view.dispatch({ changes: { from: sel.from, to: sel.to, insert: `[${cur}](${text})` }, userEvent: 'input.paste' });
              return true;
            }
          }
          return false;
        },
        drop(e, view) {
          if (view.state.readOnly) return false;
          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
          const nodeId = e.dataTransfer?.getData('application/x-onyx-node');
          const list = [...(e.dataTransfer?.files ?? [])];
          if (!nodeId && !list.length) return false;
          e.preventDefault();
          if (pos !== null) view.dispatch({ selection: { anchor: pos } });
          if (nodeId) {
            const node = byId.peek().get(nodeId);
            if (node?.kind === 'file') view.dispatch(view.state.replaceSelection(`${isImage(node.name) ? '!' : ''}[[${wikiLabel(node)}]]`));
          } else {
            attach(view, list);
          }
          view.focus();
          return true;
        },
      }),
    ],
  });
}

export function configEffects(o: { mode: Mode; md: boolean; lineNumbers: boolean; spellcheck: boolean; readOnly: boolean }): StateEffect<unknown>[] {
  return [
    modeComp.reconfigure(o.md ? livePreview(o.mode !== 'source') : []),
    prefsComp.reconfigure([
      o.lineNumbers ? lineNumbers() : [],
      EditorView.contentAttributes.of({
        spellcheck: o.spellcheck && o.md ? 'true' : 'false',
        autocorrect: o.md ? 'on' : 'off',
        autocapitalize: o.md ? 'sentences' : 'off',
      }),
    ]),
    editableComp.reconfigure([EditorState.readOnly.of(o.readOnly), EditorView.editable.of(!o.readOnly)]),
  ];
}

export async function languageFor(name: string): Promise<StateEffect<unknown> | null> {
  if (isMarkdown(name)) return null;
  const desc = LanguageDescription.matchFilename(languages, name);
  if (!desc) return null;
  try { return langComp.reconfigure(await desc.load()); } catch { return null; }
}

export type { Extension };
