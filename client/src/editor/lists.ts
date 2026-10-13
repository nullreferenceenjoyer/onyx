import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { countColumn, EditorSelection, type EditorState, type Line } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

// Поведение списков, как в Obsidian: Enter продолжает список без лишних пустых строк,
// Tab вкладывает пункт только туда, где он останется пунктом списка.

const ITEM = /^([ \t]*)([-*+]|(\d+)([.)]))([ \t]+)(\[[ xX]\](?:[ \t]+|$))?/;
const TAB = 4;

const col = (text: string) => countColumn(text, TAB, /^[ \t]*/.exec(text)![0].length);

function isListItem(state: EditorState, line: Line, indent: number): boolean {
  const tree = ensureSyntaxTree(state, line.to, 50) ?? syntaxTree(state);
  return tree.resolveInner(line.from + indent, 1).name === 'ListMark';
}

const nextMarker = (m: RegExpExecArray) => (m[3] ? `${Number(m[3]) + 1}${m[4]}` : m[2]);

// номера следующих пунктов того же уровня сдвигаются, пока идут подряд
function renumber(state: EditorState, line: Line, level: number, from: number, changes: { from: number; to: number; insert: string }[]) {
  let expect = from;
  for (let n = line.number + 1; n <= state.doc.lines; n++) {
    const l = state.doc.line(n);
    if (!l.text.trim()) continue;
    const c = col(l.text);
    if (c > level) continue;
    const m = ITEM.exec(l.text);
    if (c < level || !m?.[3] || Number(m[3]) !== expect) return;
    const at = l.from + m[1].length;
    changes.push({ from: at, to: at + m[3].length, insert: String(++expect) });
  }
}

export function continueList(view: EditorView): boolean {
  const { state } = view;
  let dont = false;
  const tr = state.changeByRange((range) => {
    const line = state.doc.lineAt(range.from);
    const m = range.empty ? ITEM.exec(line.text) : null;
    if (!m || range.from - line.from < m[0].length || !isListItem(state, line, m[1].length)) { dont = true; return { range }; }
    const level = col(line.text);

    // пустой пункт: вложенный поднимается на уровень выше, верхний — завершает список
    if (!line.text.slice(m[0].length).trim()) {
      let parent: RegExpExecArray | null = null;
      for (let n = line.number - 1; n >= 1 && level > 0; n--) {
        const text = state.doc.line(n).text;
        if (!text.trim()) continue;
        if (col(text) < level) { parent = ITEM.exec(text); break; }
      }
      const insert = parent ? `${parent[1]}${nextMarker(parent)} ${m[6] ? '[ ] ' : ''}` : '';
      return { changes: { from: line.from, to: line.to, insert }, range: EditorSelection.cursor(line.from + insert.length) };
    }

    // пробелы вокруг места разрыва не переезжают ни в конец старого пункта, ни в начало нового
    let from = range.from, to = range.from;
    while (from > line.from + m[0].length && /\s/.test(state.sliceDoc(from - 1, from))) from--;
    while (to < line.to && /\s/.test(state.sliceDoc(to, to + 1))) to++;
    const insert = `${state.lineBreak}${m[1]}${nextMarker(m)}${m[5].length > 3 ? ' ' : m[5]}${m[6] ? '[ ] ' : ''}`;
    const changes = [{ from, to, insert }];
    if (m[3]) renumber(state, line, level, Number(m[3]) + 1, changes);
    return { changes, range: EditorSelection.cursor(from + insert.length) };
  });
  if (dont) return false;
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input' }));
  return true;
}

// пункт сдвигается вместе со всеми вложенными в него
function shiftItems(view: EditorView, dir: 1 | -1): boolean {
  const { state } = view;
  const { doc } = state;
  const sel = state.selection.main;
  const a = doc.lineAt(sel.from).number;
  let b = doc.lineAt(sel.to).number;
  let level = Infinity;
  for (let n = a; n <= b; n++) {
    const l = doc.line(n);
    if (!l.text.trim()) continue;
    const m = ITEM.exec(l.text);
    if (!m || !isListItem(state, l, m[1].length)) return false;
    level = Math.min(level, col(l.text));
  }
  if (level === Infinity || state.selection.ranges.length > 1) return false;

  if (dir > 0) {
    // вкладывать можно только под предыдущий пункт того же уровня, иначе строка перестанет быть списком
    let ok = false;
    for (let n = a - 1; n >= 1; n--) {
      const text = doc.line(n).text;
      if (!text.trim()) continue;
      const c = col(text);
      if (!ITEM.test(text)) { if (c > level) continue; break; }
      ok = c >= level;
      break;
    }
    if (!ok) return true;
  } else if (level === 0) return false;

  while (b < doc.lines) {
    const text = doc.line(b + 1).text;
    if (text.trim() && col(text) <= level) break;
    b++;
  }
  while (b > a && !doc.line(b).text.trim()) b--;

  const changes = [];
  for (let n = a; n <= b; n++) {
    const l = doc.line(n);
    if (!l.text.trim()) continue;
    if (dir > 0) changes.push({ from: l.from, insert: '\t' });
    else changes.push({ from: l.from, to: l.from + /^(?:\t| {1,4})?/.exec(l.text)![0].length, insert: '' });
  }
  view.dispatch({ changes, scrollIntoView: true, userEvent: dir > 0 ? 'input.indent' : 'delete.dedent' });
  return true;
}

export const indentListItem = (view: EditorView) => shiftItems(view, 1);
export const dedentListItem = (view: EditorView) => shiftItems(view, -1);

// «- []» и пробел — тоже задача: недостающий пробел внутри скобок дописывается сам
export const taskShorthand = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== ' ' || from !== to || view.state.readOnly) return false;
  const line = view.state.doc.lineAt(from);
  if (!/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[\]$/.test(line.text.slice(0, from - line.from))) return false;
  view.dispatch({ changes: { from: from - 1, to: from, insert: ' ] ' }, selection: { anchor: from + 2 }, userEvent: 'input.type' });
  return true;
});
