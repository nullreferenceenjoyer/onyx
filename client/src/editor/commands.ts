import { startCompletion } from '@codemirror/autocomplete';
import { type ChangeSpec, EditorSelection, type EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

// Команды форматирования: общие для горячих клавиш, контекстного меню и панели на телефоне.

function starRun(state: EditorState, pos: number, dir: 1 | -1): number {
  let k = 0;
  while (k < 3 && state.sliceDoc(dir < 0 ? pos - k - 1 : pos + k, dir < 0 ? pos - k : pos + k + 1) === '*') k++;
  return k;
}

export function toggleInline(view: EditorView, mark: string): boolean {
  const { state } = view;
  const n = mark.length;
  // * и ** складываются в ***: по числу звёздочек вокруг текста видно, что уже включено
  const stars = mark === '*' || mark === '**';
  const on = (k: number) => (n === 1 ? k % 2 === 1 : k >= 2);
  view.dispatch(state.changeByRange((range) => {
    let { from, to } = range;
    // без выделения оборачиваем слово под курсором
    if (from === to) {
      const word = state.wordAt(from);
      if (word) { from = word.from; to = word.to; }
    }
    const before = state.sliceDoc(from - n, from), after = state.sliceDoc(to, to + n);
    if (stars ? on(Math.min(starRun(state, from, -1), starRun(state, to, 1))) : before === mark && after === mark) {
      return {
        changes: [{ from: from - n, to: from }, { from: to, to: to + n }],
        range: EditorSelection.range(range.anchor - n, range.head - n),
      };
    }
    const inner = state.sliceDoc(from, to);
    const own = Math.min(/^\**/.exec(inner)![0].length, /\**$/.exec(inner)![0].length, 3);
    if (stars ? own * 2 < inner.length && on(own) : inner.length >= n * 2 && inner.startsWith(mark) && inner.endsWith(mark)) {
      return { changes: [{ from, to: from + n }, { from: to - n, to }], range: EditorSelection.range(from, to - n * 2) };
    }
    if (from === to) {
      return { changes: { from, insert: mark + mark }, range: EditorSelection.cursor(from + n) };
    }
    return {
      changes: [{ from, insert: mark }, { from: to, insert: mark }],
      range: range.empty ? EditorSelection.cursor(range.head + n) : EditorSelection.range(from + n, to + n),
    };
  }), { scrollIntoView: true, userEvent: 'input' });
  view.focus();
  return true;
}

function selectedLines(view: EditorView) {
  const { state } = view;
  const seen = new Set<number>();
  const lines = [];
  for (const r of state.selection.ranges) {
    for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) {
      if (!seen.has(n)) { seen.add(n); lines.push(state.doc.line(n)); }
    }
  }
  return lines;
}

// курсор, стоявший в начале строки, оказывается после вставленной разметки, а не перед ней
function applyPrefix(view: EditorView, spec: ChangeSpec) {
  const changes = view.state.changes(spec);
  view.dispatch({ changes, selection: view.state.selection.map(changes, 1), scrollIntoView: true, userEvent: 'input' });
  view.focus();
}

const PREFIX = /^(\s*)(#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|\d+[.)]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)?/;

export function setHeading(view: EditorView, level: number): boolean {
  const changes = selectedLines(view).map((line) => {
    const m = /^(#{1,6})\s+/.exec(line.text);
    const same = m?.[1].length === level;
    return { from: line.from, to: line.from + (m ? m[0].length : 0), insert: level && !same ? '#'.repeat(level) + ' ' : '' };
  });
  applyPrefix(view, changes);
  return true;
}

export function toggleLinePrefix(view: EditorView, kind: 'bullet' | 'number' | 'task' | 'quote'): boolean {
  const lines = selectedLines(view);
  const tests = { bullet: /^[-*+]\s+(?!\[[ xX]\]\s)/, number: /^\d+[.)]\s+/, task: /^[-*+]\s+\[[ xX]\]\s+/, quote: /^>\s?/ };
  const has = (text: string) => tests[kind].test(text.replace(/^\s*/, ''));
  const all = lines.filter((l) => l.text.trim()).every((l) => has(l.text)) && lines.some((l) => l.text.trim());
  let num = 0;
  const changes = lines.map((line) => {
    const m = PREFIX.exec(line.text)!;
    const indent = m[1], old = m[2] ?? '';
    const from = line.from + indent.length;
    if (all) return { from, to: from + old.length, insert: '' };
    // цитата добавляется поверх остальной разметки, список — заменяет прежний маркер
    if (kind === 'quote') return { from, to: from, insert: '> ' };
    const keep = /^(#{1,6}\s+|>\s?)$/.test(old) ? old.length : 0;
    const insert = kind === 'bullet' ? '- ' : kind === 'task' ? '- [ ] ' : `${++num}. `;
    return { from: from + keep, to: from + old.length, insert };
  });
  applyPrefix(view, changes);
  return true;
}

export function insertLink(view: EditorView): boolean {
  const { state } = view;
  const r = state.selection.main;
  const text = state.sliceDoc(r.from, r.to);
  if (/^https?:\/\/\S+$/.test(text)) {
    view.dispatch({ changes: { from: r.from, to: r.to, insert: `[](${text})` }, selection: { anchor: r.from + 1 }, userEvent: 'input' });
  } else {
    view.dispatch({
      changes: { from: r.from, to: r.to, insert: `[${text}]()` },
      selection: { anchor: r.from + text.length + 3 }, userEvent: 'input',
    });
  }
  view.focus();
  return true;
}

export function insertWikilink(view: EditorView): boolean {
  const { state } = view;
  const r = state.selection.main;
  const text = state.sliceDoc(r.from, r.to);
  view.dispatch({ changes: { from: r.from, to: r.to, insert: `[[${text}]]` }, selection: { anchor: r.from + 2 + text.length }, userEvent: 'input' });
  view.focus();
  if (!text) startCompletion(view);
  return true;
}

// вставка блока отдельным абзацем; $CUR в шаблоне — место курсора
const CUR = '$CUR';
export function insertBlock(view: EditorView, template: string): boolean {
  const { state } = view;
  const r = state.selection.main;
  const line = state.doc.lineAt(r.from);
  const selected = state.sliceDoc(r.from, r.to);
  const body = template.replace('$SEL', () => selected);
  const at = body.indexOf(CUR);
  const clean = at >= 0 ? body.slice(0, at) + body.slice(at + CUR.length) : body;
  const lead = line.text.slice(0, r.from - line.from).trim() ? '\n\n' : line.number > 1 && state.doc.line(line.number - 1).text.trim() && !line.text.trim() ? '\n' : '';
  const nextLine = state.doc.lineAt(r.to);
  const tail = nextLine.text.slice(r.to - nextLine.from).trim() ? '\n\n' : '\n';
  view.dispatch({
    changes: { from: r.from, to: r.to, insert: lead + clean + tail },
    selection: { anchor: r.from + lead.length + (at >= 0 ? at : clean.length) },
    scrollIntoView: true, userEvent: 'input',
  });
  view.focus();
  return true;
}

export const insertCodeBlock = (view: EditorView) => insertBlock(view, '```$CUR\n$SEL\n```');
export const insertTable = (view: EditorView) => insertBlock(view, '| $CURСтолбец 1 | Столбец 2 |\n| --------- | --------- |\n|           |           |');
export const insertCallout = (view: EditorView, type = 'note') => insertBlock(view, `> [!${type}] $CUR\n> $SEL`);
export const insertHr = (view: EditorView) => insertBlock(view, '---\n$CUR');

export function replaceSelection(view: EditorView, text: string) {
  view.dispatch(view.state.replaceSelection(text), { scrollIntoView: true, userEvent: 'input' });
  view.focus();
}
