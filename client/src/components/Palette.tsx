import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { commandList } from '../actions';
import { Icon } from '../icons';
import { byId, canWrite, children, files, moveNodes, openFile, openLink, overlay, pathOf, tabs } from '../store';
import type { TreeNode } from '../types';
import { displayName, isImage, isMarkdown } from '../util';
import { Modal } from './ui';

// нечёткое совпадение: буквы запроса идут в названии по порядку; подряд и в начале слова — ценнее
function score(query: string, text: string): number {
  const q = query.toLowerCase(), t = text.toLowerCase();
  const at = t.indexOf(q);
  if (at >= 0) return 1000 - at * 2 - (t.length - q.length) * 0.1;
  let ti = 0, s = 0, streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    streak = found === ti ? streak + 1 : 0;
    s += 10 + streak * 5 - (found - ti);
    ti = found + 1;
  }
  return s;
}

interface Item { key: string; label: string; detail?: string; icon: string; run: () => void }

function useList(items: Item[], close: () => void) {
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  // autofocus у вставленных позже элементов браузер не выполняет
  useEffect(() => { input.current?.focus(); }, []);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { setSel(0); }, [items]);
  useEffect(() => { list.current?.querySelector('.is-sel')?.scrollIntoView({ block: 'nearest' }); }, [sel]);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); const it = items[sel]; if (it) { close(); it.run(); } }
  };
  const render = (empty: string) => (
    <div class="palette-list" ref={list}>
      {items.length ? items.map((it, i) => (
        <button type="button" key={it.key} class={`palette-item${i === sel ? ' is-sel' : ''}`} onMouseMove={() => setSel(i)} onClick={() => { close(); it.run(); }}>
          <Icon name={it.icon} size={16} />
          <span>{it.label}</span>
          {it.detail ? <small>{it.detail}</small> : null}
        </button>
      )) : <div class="palette-empty">{empty}</div>}
    </div>
  );
  return { onKey, render, input };
}

const fileIcon = (n: TreeNode) => (isMarkdown(n.name) ? 'file' : isImage(n.name) ? 'image' : 'fileBlank');

export function Palette({ mode }: { mode: 'files' | 'commands' }) {
  const [q, setQ] = useState(mode === 'commands' ? '>' : '');
  const close = () => { overlay.value = null; };
  // «>» в начале переключает на команды, как в редакторах кода
  const cmd = q.startsWith('>');
  const query = (cmd ? q.slice(1) : q).trim();

  const items = useMemo<Item[]>(() => {
    if (cmd) {
      return commandList()
        .map((c) => ({ c, s: query ? score(query, c.label) : 0 }))
        .filter((x) => x.s >= 0).sort((a, b) => b.s - a.s)
        .map(({ c }) => ({ key: c.label, label: c.label, detail: c.keys, icon: c.icon, run: c.run }));
    }
    const all = files.value;
    let list: TreeNode[];
    if (!query) {
      // без запроса — открытые вкладки, затем недавно изменённые
      const open = tabs.value.map((id) => byId.value.get(id)).filter(Boolean) as TreeNode[];
      const recent = [...all].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).filter((n) => !tabs.value.includes(n.id));
      list = [...open.reverse(), ...recent].slice(0, 40);
    } else {
      list = all.map((n) => ({ n, s: Math.max(score(query, displayName(n.name)), score(query, pathOf(n.id)) - 200) }))
        .filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).slice(0, 50).map((x) => x.n);
    }
    const out: Item[] = list.map((n) => ({ key: n.id, label: displayName(n.name), detail: pathOf(n.id, false), icon: fileIcon(n), run: () => openFile(n.id) }));
    if (query && canWrite.value && !all.some((n) => displayName(n.name).toLowerCase() === query.toLowerCase())) {
      out.push({ key: '+new', label: `Создать заметку «${query}»`, icon: 'filePlus', run: () => openLink(query) });
    }
    return out;
  }, [q, files.value, tabs.value]);

  const { onKey, render, input } = useList(items, close);
  return (
    <Modal onClose={close} class="palette">
      <input ref={input} class="input palette-input" value={q} placeholder="Название файла… или «>» для команд" autocomplete="off" autocapitalize="none" spellcheck={false}
        enterkeyhint="go" onInput={(e) => setQ((e.target as HTMLInputElement).value)} onKeyDown={onKey} />
      {render(cmd ? 'Команда не найдена' : 'Ничего не найдено')}
      <button type="button" class="btn btn-ghost only-mobile" style="margin:8px 12px 12px" onClick={close}>Закрыть</button>
    </Modal>
  );
}

// выбор папки для перемещения — на телефоне заменяет перетаскивание
export function MoveDialog({ nodeId, ids = [nodeId] }: { nodeId: string; ids?: string[] }) {
  const [q, setQ] = useState('');
  const close = () => { overlay.value = null; };
  const node = byId.value.get(nodeId);

  const items = useMemo<Item[]>(() => {
    if (!node) return [];
    const out: { id: string | null; path: string }[] = [{ id: null, path: '/ (корень хранилища)' }];
    const walk = (parent: string) => {
      for (const n of children.value.get(parent) ?? []) {
        // папку нельзя переносить в саму себя и в свои вложенные папки
        if (n.kind !== 'folder' || ids.includes(n.id)) continue;
        out.push({ id: n.id, path: pathOf(n.id) });
        walk(n.id);
      }
    };
    walk('');
    const query = q.trim();
    return out
      .filter((f) => ids.length > 1 || f.id !== node.parentId)
      .map((f) => ({ f, s: query ? score(query, f.path) : 0 })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s)
      .map(({ f }) => ({ key: f.id ?? 'root', label: f.path, icon: f.id ? 'folder' : 'vault', run: () => moveNodes(ids, f.id) }));
  }, [q, children.value, ids.join()]);

  const { onKey, render, input } = useList(items, close);
  if (!node) return null;
  return (
    <Modal onClose={close} class="palette">
      <input ref={input} class="input palette-input" value={q} placeholder={ids.length > 1 ? `Куда переместить выбранное (${ids.length})?` : `Куда переместить «${node.name}»?`} autocomplete="off" spellcheck={false}
        onInput={(e) => setQ((e.target as HTMLInputElement).value)} onKeyDown={onKey} />
      {render('Подходящих папок нет')}
      <button type="button" class="btn btn-ghost only-mobile" style="margin:8px 12px 12px" onClick={close}>Отмена</button>
    </Modal>
  );
}
