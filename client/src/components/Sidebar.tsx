import { useEffect, useRef, useState } from 'preact/hooks';
import { nodeMenu, rootMenu, selectionMenu, userMenu, vaultMenu } from '../actions';
import { api } from '../api';
import { Icon, Logo } from '../icons';
import {
  activeId, byId, canWrite, children, createNode, currentVault, deleteNodes, expanded, isMobile, leftOpen, mainView, me, moveNodes, online, openFile, openMenu,
  overlay, pathOf, presence, searchQuery, selected, selectionRoots, selectNode, sideTab, toggleFolder, treeCursor, treeLoaded, uploadFiles, vaultId, visibleRows,
} from '../store';
import type { TreeNode } from '../types';
import { displayName, isImage, isMarkdown, splitExt } from '../util';
import { openDaily } from '../templates';
import { useLongPress } from './ui';

const DRAG_TYPE = 'application/x-onyx-node';
// что именно тащат: одна строка или всё выделенное
let dragIds: string[] = [];

function onRowClick(e: MouseEvent, node: TreeNode) {
  // фокус на дереве — чтобы сразу работали стрелки, F2 и Delete
  (e.currentTarget as HTMLElement).closest<HTMLElement>('.tree')?.focus({ preventScroll: true });
  if (e.shiftKey) { selectNode(node.id, 'range'); return; }
  if (e.ctrlKey || e.metaKey) { selectNode(node.id, 'toggle'); return; }
  selectNode(node.id);
  if (node.kind === 'folder') toggleFolder(node.id); else openFile(node.id);
}

function Row({ node, depth }: { node: TreeNode; depth: number }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [drop, setDrop] = useState(false);
  const folder = node.kind === 'folder';
  const open = folder && expanded.value.has(node.id);
  const active = activeId.value === node.id;
  const picked = selected.value.has(node.id);
  const kids = folder ? children.value.get(node.id) ?? [] : [];
  const here = presence.value.filter((p) => p.nodeId === node.id && p.userId !== me.value?.id);
  const ext = splitExt(node.name)[1];

  const showMenu = (at: { clientX: number; clientY: number } | HTMLElement) => {
    setMenuOpen(true);
    // меню строки вне выделения относится только к ней; внутри выделения — ко всему выделенному
    const many = picked && selected.value.size > 1;
    if (!many) selectNode(node.id);
    openMenu(at, many ? selectionMenu([...selected.value]) : nodeMenu(node));
    // подсветка строки держится, пока открыто её меню
    const off = () => { setMenuOpen(false); window.removeEventListener('pointerdown', off, true); };
    setTimeout(() => window.addEventListener('pointerdown', off, true), 0);
  };
  const long = useLongPress(showMenu);

  return (
    <>
      <div
        class={`tree-row${active ? ' is-active' : ''}${picked ? ' is-selected' : ''}${treeCursor.value === node.id ? ' is-cursor' : ''}${open ? ' is-open' : ''}${menuOpen ? ' is-menu' : ''}${drop ? ' is-drop' : ''}`}
        style={{ '--depth': depth }}
        role="treeitem" aria-expanded={folder ? open : undefined} aria-selected={picked} title={node.name} data-id={node.id}
        draggable={canWrite.value && !isMobile.value}
        onClick={(e) => onRowClick(e, node)}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); showMenu(e); }}
        {...long}
        onDragStart={(e) => { dragIds = picked ? selectionRoots() : [node.id]; e.dataTransfer!.setData(DRAG_TYPE, node.id); e.dataTransfer!.setData('text/plain', node.name); e.dataTransfer!.effectAllowed = 'copyMove'; }}
        onDragOver={folder ? (e) => { e.preventDefault(); e.stopPropagation(); setDrop(true); } : undefined}
        onDragLeave={folder ? () => setDrop(false) : undefined}
        onDrop={folder ? (e) => { e.preventDefault(); e.stopPropagation(); setDrop(false); dropInto(e, node.id); } : undefined}
      >
        {folder ? <span class="tree-chev"><Icon name="chevronRight" size={14} /></span> : <span class="tree-chev" />}
        <Icon class="tree-ico" size={16} name={folder ? (open ? 'folderOpen' : 'folder') : isMarkdown(node.name) ? 'file' : isImage(node.name) ? 'image' : 'fileBlank'} />
        <span class="tree-name">{folder ? node.name : displayName(node.name)}</span>
        {here.length ? <span class="tree-dots" title={here.map((p) => p.name).join(', ')}>{here.slice(0, 3).map((p) => <i class="tree-dot" key={p.clientId} />)}</span> : null}
        {!folder && !isMarkdown(node.name) && ext ? <span class="tree-ext">{ext}</span> : null}
        <button type="button" class="icon-btn tree-more" aria-label="Действия"
          onClick={(e) => { e.stopPropagation(); showMenu(e.currentTarget as HTMLElement); }}><Icon name="more" size={16} /></button>
      </div>
      {open ? (
        <div class="tree-children" role="group" style={{ '--depth': depth }}>
          {kids.length ? kids.map((k) => <Row key={k.id} node={k} depth={depth + 1} />)
            : <div class="tree-row" style={{ '--depth': depth + 1, opacity: 0.5, pointerEvents: 'none' }}><span class="tree-chev" /><span class="tree-name">пусто</span></div>}
        </div>
      ) : null}
    </>
  );
}

// перенос внутри дерева — перемещение; файлы с компьютера — загрузка в эту папку
function dropInto(e: DragEvent, parentId: string | null) {
  if (!canWrite.value) return;
  const id = e.dataTransfer?.getData(DRAG_TYPE);
  if (id) { moveNodes(dragIds.includes(id) ? dragIds : [id], parentId); return; }
  const list = [...(e.dataTransfer?.files ?? [])];
  if (list.length) uploadFiles(list.map((file) => ({ file })), parentId);
}

// клавиатура в дереве — как в проводнике VS Code
function onTreeKey(e: KeyboardEvent) {
  if (e.target !== e.currentTarget) return;
  const rows = visibleRows();
  const cur = byId.value.get(treeCursor.value ?? '');
  const i = cur ? rows.findIndex((n) => n.id === cur.id) : -1;
  const go = (n?: TreeNode) => { if (n) selectNode(n.id, e.shiftKey ? 'range' : 'one'); };
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'ArrowDown') go(rows[Math.min(rows.length - 1, i + 1)]);
  else if (e.key === 'ArrowUp') go(rows[Math.max(0, i - 1)]);
  else if (e.key === 'Home') go(rows[0]);
  else if (e.key === 'End') go(rows[rows.length - 1]);
  else if (e.key === 'ArrowRight' && cur?.kind === 'folder') { if (expanded.value.has(cur.id)) go(children.value.get(cur.id)?.[0]); else toggleFolder(cur.id); }
  else if (e.key === 'ArrowLeft' && cur) { if (cur.kind === 'folder' && expanded.value.has(cur.id)) toggleFolder(cur.id); else if (cur.parentId) selectNode(cur.parentId); }
  else if ((e.key === 'Enter' || e.key === ' ') && cur) { if (cur.kind === 'folder') toggleFolder(cur.id); else openFile(cur.id); }
  else if (e.key === 'Delete' && selected.value.size && canWrite.value) deleteNodes([...selected.value]);
  else if (e.key === 'Escape' && selected.value.size) selectNode(null);
  else if (mod && e.code === 'KeyA') selected.value = new Set(rows.map((n) => n.id));
  else return;
  e.preventDefault();
}

function FileTree() {
  const [drop, setDrop] = useState(false);
  const el = useRef<HTMLDivElement>(null);
  const cursor = treeCursor.value;
  useEffect(() => { el.current?.querySelector('.is-cursor')?.scrollIntoView({ block: 'nearest' }); }, [cursor]);
  const roots = children.value.get('') ?? [];
  const long = useLongPress((at) => openMenu(at, rootMenu()));
  if (!treeLoaded.value) return <div class="side-empty">Загрузка…</div>;
  return (
    <div
      ref={el} class={`tree${drop ? ' is-drop-root' : ''}`} role="tree" aria-multiselectable tabIndex={0}
      onKeyDown={onTreeKey} onClick={(e) => { if (e.target === e.currentTarget) selectNode(null); }}
      onContextMenu={(e) => { e.preventDefault(); openMenu(e, rootMenu()); }}
      onTouchStart={(e) => { if (e.target === e.currentTarget) long.onTouchStart(e); }}
      onTouchMove={long.onTouchMove} onTouchEnd={long.onTouchEnd} onTouchCancel={long.onTouchCancel}
      onDragOver={(e) => { e.preventDefault(); setDrop(true); }}
      onDragLeave={(e) => { if (e.target === e.currentTarget) setDrop(false); }}
      onDrop={(e) => { e.preventDefault(); setDrop(false); dropInto(e, null); }}
    >
      {roots.map((n) => <Row key={n.id} node={n} depth={0} />)}
      {!roots.length ? (
        <div class="side-empty">
          <span>Здесь пока пусто</span>
          {canWrite.value ? <button type="button" class="btn btn-soft" onClick={() => createNode('file', null)}><Icon name="plus" size={16} />Первая заметка</button> : null}
        </div>
      ) : null}
    </div>
  );
}

interface Hit { id: string; byName: boolean; snippets: string[] }

function Marked({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}

function SearchPanel() {
  const q = searchQuery.value;
  const [hits, setHits] = useState<Hit[] | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!isMobile.value) input.current?.focus(); }, []);
  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) { setHits(null); return; }
    let alive = true;
    const t = setTimeout(() => {
      api('GET', `/vaults/${vaultId.value}/search?q=${encodeURIComponent(query)}`).then((r) => { if (alive) setHits(r.results); }).catch(() => { if (alive) setHits([]); });
    }, 220);
    return () => { alive = false; clearTimeout(t); };
  }, [q, vaultId.value]);

  return (
    <>
      <div class="search-box">
        <Icon name="search" size={16} />
        <input ref={input} class="input" type="search" placeholder="Поиск по хранилищу" value={q} enterkeyhint="search"
          onInput={(e) => { searchQuery.value = (e.target as HTMLInputElement).value; }} />
      </div>
      {hits === null ? <div class="side-empty">Введите хотя бы два символа — ищем в названиях и тексте</div> : null}
      {hits && !hits.length ? <div class="side-empty">Ничего не найдено</div> : null}
      {hits?.map((h) => {
        const node = byId.value.get(h.id);
        if (!node) return null;
        return (
          <button type="button" class="search-item" key={h.id} onClick={() => openFile(h.id)}>
            <b><Marked text={displayName(node.name)} q={q.trim()} /></b>
            {node.parentId ? <span class="search-path">{pathOf(node.id, false)}</span> : null}
            {h.snippets.map((s, i) => <span class="search-snip" key={i}><Marked text={s} q={q.trim()} /></span>)}
          </button>
        );
      })}
    </>
  );
}

export function Sidebar() {
  const vault = currentVault.value;
  const user = me.value!;
  const tab = sideTab.value;
  const others = new Set(presence.value.filter((p) => p.userId !== user.id).map((p) => p.userId)).size;
  const go = (view: 'graph' | 'profile') => { mainView.value = mainView.value === view ? 'doc' : view; if (isMobile.value) leftOpen.value = false; };
  return (
    <aside class="sidebar panel" aria-label="Файлы">
      <div class="side-inner">
        <div class="side-head">
          <button type="button" class="vault-btn" onClick={(e) => openMenu(e.currentTarget as HTMLElement, vaultMenu())}>
            <span class="vault-mark"><Logo size={18} /></span>
            <span class="vault-name">
              {vault?.name ?? 'Нет хранилища'}
              <span class="vault-sub">
                {!vault ? 'создайте первое' : vault.role === 'viewer' ? 'только чтение' : others ? `сейчас здесь ещё ${others}` : vault.memberCount > 1 ? `участников: ${vault.memberCount}` : 'личное'}
              </span>
            </span>
            <Icon name="chevronDown" size={16} />
          </button>
        </div>
        {vault ? (
          <div class="side-quick">
            <button type="button" class={`quick${mainView.value === 'graph' ? ' is-active' : ''}`} title="Граф связей (Alt+G)" onClick={() => go('graph')}><Icon name="graph" size={17} /><span>Граф</span></button>
            <button type="button" class="quick" title="Шаблоны (Alt+T)" onClick={() => { overlay.value = { type: 'templates' }; }}><Icon name="template" size={17} /><span>Шаблоны</span></button>
            <button type="button" class="quick" title="Заметка на сегодня (Alt+D)" disabled={!canWrite.value} onClick={openDaily}><Icon name="calendar" size={17} /><span>Сегодня</span></button>
            <button type="button" class={`quick${mainView.value === 'profile' ? ' is-active' : ''}`} title="Профиль и активность" onClick={() => go('profile')}><Icon name="user" size={17} /><span>Профиль</span></button>
          </div>
        ) : null}
        <div class="side-tools">
          <div class="seg">
            <button type="button" class={`seg-btn${tab === 'files' ? ' is-active' : ''}`} onClick={() => { sideTab.value = 'files'; }}>Файлы</button>
            <button type="button" class={`seg-btn${tab === 'search' ? ' is-active' : ''}`} onClick={() => { sideTab.value = 'search'; }}>Поиск</button>
          </div>
          {canWrite.value && vault ? (
            <>
              <button type="button" class="icon-btn" title="Новая заметка (Alt+N)" aria-label="Новая заметка" onClick={() => createNode('file')}><Icon name="filePlus" /></button>
              <button type="button" class="icon-btn" title="Новая папка" aria-label="Новая папка" onClick={() => createNode('folder')}><Icon name="folderPlus" /></button>
            </>
          ) : null}
          <button type="button" class="icon-btn" title="Ещё" aria-label="Ещё" onClick={(e) => openMenu(e.currentTarget as HTMLElement, rootMenu())}><Icon name="more" /></button>
        </div>
        <div class="side-body">
          {!vault ? <div class="side-empty">Выберите или создайте хранилище в меню выше</div> : tab === 'files' ? <FileTree /> : <SearchPanel />}
        </div>
        <div class="side-foot">
          <button type="button" class="user-chip" onClick={(e) => openMenu(e.currentTarget as HTMLElement, userMenu())}>
            <span class="avatar">{user.displayName.slice(0, 1)}</span>
            <b>{user.displayName}</b>
          </button>
          {!online.value ? <span class="icon-btn" title="Нет связи с сервером — изменения сохранятся позже" style="color:var(--warn)"><Icon name="cloudOff" /></span> : null}
          <button type="button" class="icon-btn" title="Настройки" aria-label="Настройки" onClick={() => { overlay.value = { type: 'settings' }; }}><Icon name="settings" /></button>
        </div>
      </div>
    </aside>
  );
}
