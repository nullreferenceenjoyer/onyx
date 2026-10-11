import { useEffect, useRef } from 'preact/hooks';
import { exportMenu, findInNote, MOD, nodeMenu, tabMenu, toggleRead } from '../actions';
import { Icon } from '../icons';
import {
  activeId, byId, canWrite, closeTab, docs, docTick, isMobile, leftOpen, me, online, openFile, openMenu, overlay, presence, renameNode, rightOpen, setMode,
  settings, tabs, updateSettings,
} from '../store';
import type { MenuItem, Mode } from '../types';
import { displayName, isMarkdown } from '../util';
import { useLongPress } from './ui';

function Tab({ id }: { id: string }) {
  const node = byId.value.get(id);
  const active = activeId.value === id;
  const ref = useRef<HTMLDivElement>(null);
  const long = useLongPress((at) => openMenu(at, tabMenu(id)));
  useEffect(() => { if (active) ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [active]);
  if (!node) return null;
  const dirty = docs.get(id)?.dirty;
  return (
    <div
      ref={ref} class={`tab${active ? ' is-active' : ''}`} role="tab" aria-selected={active} title={node.name}
      onClick={() => openFile(id)}
      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(id); } }}
      onContextMenu={(e) => { e.preventDefault(); openMenu(e, tabMenu(id)); }}
      {...long}
    >
      <span class="tab-name">{displayName(node.name)}</span>
      {dirty ? <i class="tab-dot" title="Есть несохранённые правки" /> : null}
      <button type="button" class="icon-btn tab-close" aria-label="Закрыть вкладку" onClick={(e) => { e.stopPropagation(); closeTab(id); }}><Icon name="x" size={14} /></button>
    </div>
  );
}

export function Tabs() {
  docTick.value;
  if (!tabs.value.length) return null;
  return <div class="tabs" role="tablist">{tabs.value.map((id) => <Tab key={id} id={id} />)}</div>;
}

const MODES: { id: Mode; icon: string; title: string }[] = [
  { id: 'live', icon: 'pencil', title: 'Живой просмотр' },
  { id: 'source', icon: 'code', title: 'Исходник' },
  { id: 'read', icon: 'book', title: 'Чтение' },
];

export function Header() {
  docTick.value;
  const id = activeId.value;
  const node = id ? byId.value.get(id) : undefined;
  const doc = id ? docs.get(id) : undefined;
  const mobile = isMobile.value;
  const md = !!node && isMarkdown(node.name);

  const crumbs: string[] = [];
  for (let p = node?.parentId ? byId.value.get(node.parentId) : undefined; p; p = p.parentId ? byId.value.get(p.parentId) : undefined) crumbs.unshift(p.name);

  let status: { cls: string; text: string } | null = null;
  if (doc && node && !node.binary) {
    if (!canWrite.value) status = { cls: 'is-muted', text: 'только чтение' };
    else if (doc.error) status = { cls: 'is-error', text: doc.error };
    else if (doc.saving || doc.dirty) status = { cls: 'is-saving', text: 'сохранение…' };
    else if (!online.value) status = { cls: 'is-muted', text: 'нет связи' };
    else status = { cls: '', text: 'сохранено' };
  }

  const others = presence.value.filter((p) => p.userId !== me.value?.id);
  const people = [...new Map(others.map((p) => [p.userId, p])).values()];

  const more = (): MenuItem[] => [
    ...(md && doc ? [
      { title: 'Режим' } as MenuItem,
      ...MODES.map((m): MenuItem => ({ label: m.title, icon: <Icon name={m.icon} size={16} />, checked: doc.mode === m.id, onClick: () => setMode(doc.id, m.id) })),
      { sep: true } as MenuItem,
    ] : []),
    ...(node && !node.binary ? [{ label: 'Найти в заметке', icon: <Icon name="search" size={16} />, hint: `${MOD}+F`, onClick: findInNote } as MenuItem] : []),
    { label: 'Номера строк', checked: settings.value.lineNumbers, onClick: () => updateSettings({ lineNumbers: !settings.value.lineNumbers }) },
    { label: 'Текст во всю ширину', checked: !settings.value.lineWidth, onClick: () => updateSettings({ lineWidth: settings.value.lineWidth ? 0 : 760 }) },
    ...(node ? [{ sep: true } as MenuItem, ...nodeMenu(node)] : []),
  ];

  return (
    <header class="head">
      <button type="button" class={`icon-btn${leftOpen.value && !mobile ? ' is-active' : ''}`} title={`Файлы (${MOD}+\\)`} aria-label="Файлы"
        onClick={() => { leftOpen.value = !leftOpen.value; }}><Icon name={mobile ? 'menu' : 'panelLeft'} /></button>
      <div class="crumbs">
        {crumbs.map((c, i) => <><span class="crumb" key={i}>{c}</span><span class="crumb-sep">/</span></>)}
        {node ? (
          <button type="button" class="crumb-name" title={canWrite.value ? 'Переименовать (F2)' : node.name} onClick={() => canWrite.value && renameNode(node.id)}>
            {displayName(node.name)}
          </button>
        ) : null}
      </div>
      {status ? <span class={`status ${status.cls}`} title={status.text}><span>{status.text}</span></span> : null}
      {people.length ? (
        <div class="avatars" title={`Сейчас в хранилище: ${people.map((p) => p.name).join(', ')}`}>
          {people.slice(0, 4).map((p) => <span key={p.userId} class={`avatar${others.some((o) => o.userId === p.userId && o.nodeId === id && id) ? ' is-here' : ''}`}>{p.name.slice(0, 1)}</span>)}
        </div>
      ) : null}
      {md && doc ? (
        mobile ? (
          <button type="button" class="icon-btn" title={doc.mode === 'read' ? 'Править' : 'Читать'} aria-label={doc.mode === 'read' ? 'Править' : 'Читать'} onClick={toggleRead}>
            <Icon name={doc.mode === 'read' ? 'pencil' : 'book'} />
          </button>
        ) : (
          <div class="seg" role="group" aria-label="Режим">
            {MODES.map((m) => (
              <button type="button" key={m.id} class={`seg-btn${doc.mode === m.id ? ' is-active' : ''}`} title={m.title + (m.id === 'read' ? ` (${MOD}+E)` : '')} aria-label={m.title}
                onClick={() => setMode(doc.id, m.id)}><Icon name={m.icon} size={15} /></button>
            ))}
          </div>
        )
      ) : null}
      {node && canWrite.value ? (
        <button type="button" class="icon-btn only-desktop" title="Поделиться: ссылка для всех или доступ человеку" aria-label="Поделиться"
          onClick={() => { overlay.value = { type: 'shareNode', nodeId: node.id }; }}><Icon name="share" /></button>
      ) : null}
      <button type="button" class="btn export-btn" title="Выгрузка: файл, папка или всё хранилище" onClick={(e) => openMenu(e.currentTarget as HTMLElement, exportMenu())}>
        <Icon name="download" size={mobile ? 18 : 16} /><span>Выгрузка</span>
      </button>
      {node ? (
        <button type="button" class={`icon-btn${rightOpen.value ? ' is-active' : ''}`} title="Оглавление и обратные ссылки" aria-label="Оглавление и обратные ссылки"
          onClick={() => { rightOpen.value = !rightOpen.value; }}><Icon name={mobile ? 'outline' : 'panelRight'} /></button>
      ) : null}
      <button type="button" class="icon-btn" title="Ещё" aria-label="Ещё" onClick={(e) => openMenu(e.currentTarget as HTMLElement, more())}><Icon name="more" /></button>
    </header>
  );
}
