import { openSearchPanel } from '@codemirror/search';
import { api } from './api';
import { Icon } from './icons';
import { exportHtml, printNote } from './render/export';
import { openDaily, saveAsTemplate } from './templates';
import {
  activeId, ask, byId, mainView, canWrite, closeOthers, closeTab, createNode, createVault, currentVault, deleteNode, docs, downloadNode, duplicateNode,
  editorRef, exportVault, fail, isMobile, leftOpen, loadVaults, me, overlay, pathOf, pickAndUpload, renameNode, revealInTree, rightOpen, saveAll,
  searchFor, selectVault, setExpanded, setMode, settings, signOut, tabs, toast, updateSettings, vaults, wikiLabel,
} from './store';
import type { MenuItem, TreeNode } from './types';
import { isMarkdown } from './util';

// Единый список действий: его используют контекстные меню, палитра команд и горячие клавиши.

const ico = (name: string) => <Icon name={name} size={16} />;
export const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

export async function copyText(text: string, done = 'Скопировано') {
  try {
    if (navigator.clipboard) await navigator.clipboard.writeText(text);
    else {
      // без https буфер обмена доступен только так
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast(done);
  } catch { toast('Не удалось скопировать', 'error'); }
}

export function toggleRead() {
  const id = activeId.value;
  const doc = id ? docs.get(id) : undefined;
  const node = id ? byId.value.get(id) : undefined;
  if (!doc || !node || !isMarkdown(node.name)) return;
  setMode(doc.id, doc.mode === 'read' ? (settings.value.defaultMode === 'read' ? 'live' : settings.value.defaultMode) : 'read');
}

export function findInNote() {
  const view = editorRef.view;
  const doc = activeId.value ? docs.get(activeId.value) : undefined;
  if (!view || !doc) return;
  if (doc.mode === 'read') setMode(doc.id, 'live');
  setTimeout(() => { view.focus(); openSearchPanel(view); }, 30);
}

// ---------------------------------------------------------------- меню «Выгрузка»
export function exportMenu(): MenuItem[] {
  const node = activeId.value ? byId.value.get(activeId.value) : undefined;
  const folder = node?.parentId ? byId.value.get(node.parentId) : undefined;
  const items: MenuItem[] = [];
  if (node) {
    items.push({ title: 'Этот файл' });
    items.push({ label: `Исходный файл (.${node.name.split('.').pop()})`, icon: ico('download'), onClick: () => downloadNode(node.id) });
    if (!node.binary) {
      items.push({ label: 'Страница HTML', icon: ico('globe'), onClick: () => exportHtml(node.id).catch(fail) });
      items.push({ label: 'Печать / PDF', icon: ico('printer'), onClick: () => printNote(node.id).catch(fail) });
    }
  }
  if (folder) {
    items.push({ title: 'Папка' });
    items.push({ label: `«${folder.name}» архивом (.zip)`, icon: ico('archive'), onClick: () => downloadNode(folder.id) });
  }
  items.push({ title: 'Хранилище' });
  items.push({ label: 'Всё хранилище (.zip)', icon: ico('vault'), onClick: exportVault });
  return items;
}

function uploadItems(parentId: string | null): MenuItem[] {
  return [
    { label: 'Загрузить файлы…', icon: ico('upload'), onClick: () => pickAndUpload(parentId, 'files') },
    { label: 'Загрузить папку…', icon: ico('folder'), onClick: () => pickAndUpload(parentId, 'folder') },
    { label: 'Распаковать zip-архив…', icon: ico('archive'), onClick: () => pickAndUpload(parentId, 'zip') },
  ];
}

// ---------------------------------------------------------------- дерево файлов
export function nodeMenu(node: TreeNode): MenuItem[] {
  const w = canWrite.value;
  const md = isMarkdown(node.name);
  if (node.kind === 'folder') {
    return [
      ...(w ? [
        { label: 'Новая заметка', icon: ico('filePlus'), onClick: () => createNode('file', node.id) },
        { label: 'Новая папка', icon: ico('folderPlus'), onClick: () => createNode('folder', node.id) },
        { label: 'Загрузить сюда', icon: ico('upload'), children: uploadItems(node.id) },
        { sep: true as const },
        { label: 'Переименовать', icon: ico('pencil'), hint: 'F2', onClick: () => renameNode(node.id) },
        { label: 'Переместить…', icon: ico('move'), onClick: () => { overlay.value = { type: 'move', nodeId: node.id }; } },
      ] : []),
      ...(w ? [{ label: 'Поделиться…', icon: ico('share'), onClick: () => { overlay.value = { type: 'shareNode', nodeId: node.id }; } }] : []),
      { label: 'Скачать архивом (.zip)', icon: ico('archive'), onClick: () => downloadNode(node.id) },
      { label: 'Скопировать путь', icon: ico('copy'), onClick: () => copyText(pathOf(node.id)) },
      ...(w ? [{ sep: true as const }, { label: 'Удалить', icon: ico('trash'), danger: true, onClick: () => deleteNode(node.id) }] : []),
    ];
  }
  return [
    ...(w ? [
      { label: 'Переименовать', icon: ico('pencil'), hint: 'F2', onClick: () => renameNode(node.id) },
      { label: 'Дублировать', icon: ico('copy'), onClick: () => duplicateNode(node.id) },
      { label: 'Переместить…', icon: ico('move'), onClick: () => { overlay.value = { type: 'move', nodeId: node.id }; } },
      { sep: true as const },
    ] : []),
    ...(w ? [{ label: 'Поделиться…', icon: ico('share'), onClick: () => { overlay.value = { type: 'shareNode', nodeId: node.id }; } }] : []),
    ...(!node.binary ? [{ label: 'История версий', icon: ico('clock'), onClick: () => { overlay.value = { type: 'history', nodeId: node.id }; } }] : []),
    ...(w && md ? [{ label: 'Сохранить как шаблон', icon: ico('template'), onClick: () => saveAsTemplate(node) }] : []),
    { sep: true },
    { label: 'Скопировать ссылку [[…]]', icon: ico('brackets'), onClick: () => copyText(`[[${wikiLabel(node)}]]`) },
    { label: 'Скопировать путь', icon: ico('copy'), onClick: () => copyText(pathOf(node.id)) },
    { sep: true },
    { label: 'Скачать файл', icon: ico('download'), onClick: () => downloadNode(node.id) },
    ...(!node.binary ? [
      { label: md ? 'Выгрузить в HTML' : 'Выгрузить как HTML', icon: ico('globe'), onClick: () => exportHtml(node.id).catch(fail) },
      { label: 'Печать / PDF', icon: ico('printer'), onClick: () => printNote(node.id).catch(fail) },
    ] : []),
    ...(w ? [{ sep: true as const }, { label: 'Удалить', icon: ico('trash'), danger: true, onClick: () => deleteNode(node.id) }] : []),
  ];
}

export function rootMenu(): MenuItem[] {
  return [
    ...(canWrite.value ? [
      { label: 'Новая заметка', icon: ico('filePlus'), hint: 'Alt+N', onClick: () => createNode('file', null) },
      { label: 'Новая папка', icon: ico('folderPlus'), onClick: () => createNode('folder', null) },
      { label: 'Заметка из шаблона…', icon: ico('template'), onClick: () => { overlay.value = { type: 'templates' }; } },
      { label: 'Заметка на сегодня', icon: ico('calendar'), hint: 'Alt+D', onClick: openDaily },
      { sep: true as const },
      ...uploadItems(null),
      { sep: true as const },
    ] : []),
    { label: 'Граф связей', icon: ico('graph'), hint: 'Alt+G', onClick: () => { mainView.value = 'graph'; closeSidebarsOnMobile(); } },
    { label: 'Свернуть все папки', icon: ico('collapse'), onClick: () => setExpanded(new Set()) },
    { label: 'Выгрузить хранилище (.zip)', icon: ico('vault'), onClick: exportVault },
  ];
}

export function tabMenu(id: string): MenuItem[] {
  const node = byId.value.get(id);
  return [
    { label: 'Закрыть', icon: ico('x'), hint: 'Alt+W', onClick: () => closeTab(id) },
    { label: 'Закрыть остальные', disabled: tabs.value.length < 2, onClick: () => closeOthers(id) },
    { label: 'Закрыть все', onClick: () => [...tabs.value].forEach(closeTab) },
    { sep: true },
    { label: 'Показать в дереве', icon: ico('folderOpen'), onClick: () => { revealInTree(id); leftOpen.value = true; } },
    ...(node ? nodeMenu(node).filter((i) => !('danger' in i && i.danger)) : []),
  ];
}

// ---------------------------------------------------------------- хранилища и пользователь
export function vaultMenu(): MenuItem[] {
  const cur = currentVault.value;
  const items: MenuItem[] = [{ title: 'Хранилища' }];
  for (const v of vaults.value) {
    items.push({
      label: v.name, icon: ico('vault'), checked: v.id === cur?.id,
      hint: v.role === 'owner' ? (v.memberCount > 1 ? `${v.memberCount} уч.` : '') : v.role === 'editor' ? 'общее' : 'чтение',
      onClick: () => selectVault(v.id),
    });
  }
  items.push({ sep: true }, { label: 'Новое хранилище…', icon: ico('plus'), onClick: createVault });
  if (cur) {
    items.push({ title: cur.name });
    items.push({ label: 'Участники и доступ', icon: ico('users'), onClick: () => { overlay.value = { type: 'share', vaultId: cur.id }; } });
    if (cur.role === 'owner') {
      items.push({
        label: 'Переименовать', icon: ico('pencil'), onClick: async () => {
          const name = await ask.prompt({ title: 'Название хранилища', value: cur.name, confirmText: 'Сохранить' });
          if (name?.trim()) api('PATCH', `/vaults/${cur.id}`, { name: name.trim() }).then(loadVaults).catch(fail);
        },
      });
    }
    if (canWrite.value) items.push({ label: 'Загрузить', icon: ico('upload'), children: uploadItems(null) });
    items.push({ label: 'Выгрузить архивом (.zip)', icon: ico('download'), onClick: exportVault });
    items.push({ sep: true });
    if (cur.role === 'owner') {
      items.push({
        label: 'Удалить хранилище', icon: ico('trash'), danger: true, onClick: async () => {
          const ok = await ask.confirm({
            title: 'Удалить хранилище?', confirmText: 'Удалить навсегда', danger: true,
            text: `«${cur.name}» и все заметки в нём будут удалены у всех участников. Отменить это нельзя — при необходимости сначала выгрузите архив.`,
          });
          if (ok) api('DELETE', `/vaults/${cur.id}`).then(loadVaults).catch(fail);
        },
      });
    } else {
      items.push({
        label: 'Покинуть хранилище', icon: ico('logout'), danger: true, onClick: async () => {
          const ok = await ask.confirm({ title: 'Покинуть хранилище?', text: `Вы потеряете доступ к «${cur.name}».`, confirmText: 'Покинуть', danger: true });
          if (ok) api('DELETE', `/vaults/${cur.id}/members/${me.value!.id}`).then(loadVaults).catch(fail);
        },
      });
    }
  }
  return items;
}

export function userMenu(): MenuItem[] {
  const dark = document.documentElement.dataset.theme === 'dark';
  return [
    { label: 'Профиль и активность', icon: ico('user'), onClick: () => { mainView.value = 'profile'; closeSidebarsOnMobile(); } },
    { label: 'Настройки', icon: ico('settings'), hint: `${MOD}+,`, onClick: () => { overlay.value = { type: 'settings' }; } },
    { label: dark ? 'Светлая тема' : 'Тёмная тема', icon: ico('palette'), onClick: () => updateSettings({ theme: dark ? 'light' : 'dark' }) },
    { label: 'Палитра команд', icon: ico('sparkles'), hint: `${MOD}+P`, onClick: () => { overlay.value = { type: 'palette', mode: 'commands' }; } },
    { sep: true },
    { label: 'Выйти', icon: ico('logout'), onClick: signOut },
  ];
}

// ---------------------------------------------------------------- палитра команд
export interface Command { label: string; icon: string; keys?: string; run: () => void }

export function commandList(): Command[] {
  const id = activeId.value;
  const node = id ? byId.value.get(id) : undefined;
  const doc = id ? docs.get(id) : undefined;
  const w = canWrite.value;
  const list: (Command | false | undefined)[] = [
    w && { label: 'Новая заметка', icon: 'filePlus', keys: 'Alt+N', run: () => createNode('file') },
    w && { label: 'Новая папка', icon: 'folderPlus', run: () => createNode('folder') },
    w && { label: 'Заметка из шаблона / вставить шаблон', icon: 'template', keys: 'Alt+T', run: () => { overlay.value = { type: 'templates' }; } },
    w && { label: 'Заметка на сегодня', icon: 'calendar', keys: 'Alt+D', run: openDaily },
    { label: 'Граф связей', icon: 'graph', keys: 'Alt+G', run: () => { mainView.value = 'graph'; } },
    { label: 'Профиль и активность', icon: 'user', run: () => { mainView.value = 'profile'; } },
    node && w && { label: 'Поделиться заметкой', icon: 'share', run: () => { overlay.value = { type: 'shareNode', nodeId: node.id }; } },
    node && !node.binary && { label: 'История версий', icon: 'clock', run: () => { overlay.value = { type: 'history', nodeId: node.id }; } },
    node && w && isMarkdown(node.name) && { label: 'Сохранить заметку как шаблон', icon: 'template', run: () => saveAsTemplate(node) },
    { label: 'Быстрый переход к файлу', icon: 'search', keys: `${MOD}+O`, run: () => { overlay.value = { type: 'palette', mode: 'files' }; } },
    { label: 'Поиск по хранилищу', icon: 'search', keys: `${MOD}+Shift+F`, run: () => searchFor('') },
    node && !node.binary && { label: 'Найти в заметке', icon: 'search', keys: `${MOD}+F`, run: findInNote },
    node && isMarkdown(node.name) && { label: doc?.mode === 'read' ? 'Перейти к правке' : 'Перейти к чтению', icon: doc?.mode === 'read' ? 'pencil' : 'book', keys: `${MOD}+E`, run: toggleRead },
    node && isMarkdown(node.name) && doc && { label: doc.mode === 'source' ? 'Живой просмотр' : 'Режим исходника', icon: 'code', run: () => setMode(doc.id, doc.mode === 'source' ? 'live' : 'source') },
    { label: 'Показать или скрыть дерево файлов', icon: 'panelLeft', keys: `${MOD}+\\`, run: () => { leftOpen.value = !leftOpen.value; } },
    { label: 'Оглавление и обратные ссылки', icon: 'panelRight', run: () => { rightOpen.value = !rightOpen.value; } },
    node && w && { label: 'Переименовать файл', icon: 'pencil', keys: 'F2', run: () => renameNode(node.id) },
    node && w && { label: 'Переместить файл…', icon: 'move', run: () => { overlay.value = { type: 'move', nodeId: node.id }; } },
    node && { label: 'Скачать файл', icon: 'download', run: () => downloadNode(node.id) },
    node && !node.binary && { label: 'Выгрузить заметку в HTML', icon: 'globe', run: () => exportHtml(node.id).catch(fail) },
    node && !node.binary && { label: 'Печать / сохранить как PDF', icon: 'printer', run: () => printNote(node.id).catch(fail) },
    { label: 'Выгрузить всё хранилище (.zip)', icon: 'vault', run: exportVault },
    w && { label: 'Загрузить файлы', icon: 'upload', run: () => pickAndUpload(null, 'files') },
    w && { label: 'Распаковать zip-архив в хранилище', icon: 'archive', run: () => pickAndUpload(null, 'zip') },
    node && { label: 'Закрыть вкладку', icon: 'x', keys: 'Alt+W', run: () => closeTab(node.id) },
    { label: 'Участники и доступ', icon: 'users', run: () => { if (currentVault.value) overlay.value = { type: 'share', vaultId: currentVault.value.id }; } },
    { label: 'Новое хранилище', icon: 'vault', run: createVault },
    { label: 'Настройки', icon: 'settings', keys: `${MOD}+,`, run: () => { overlay.value = { type: 'settings' }; } },
    { label: 'Переключить тему', icon: 'palette', run: () => updateSettings({ theme: document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark' }) },
    { label: 'Выйти', icon: 'logout', run: signOut },
  ];
  return list.filter(Boolean) as Command[];
}

// ---------------------------------------------------------------- горячие клавиши
export function handleGlobalKey(e: KeyboardEvent): boolean {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  const code = e.code;
  if (mod && !e.shiftKey && !e.altKey && code === 'KeyO') { overlay.value = { type: 'palette', mode: 'files' }; return true; }
  if (mod && !e.shiftKey && !e.altKey && code === 'KeyP') { overlay.value = { type: 'palette', mode: 'commands' }; return true; }
  if (mod && !e.shiftKey && !e.altKey && code === 'KeyE') { toggleRead(); return true; }
  if (mod && e.shiftKey && code === 'KeyF') { searchFor(''); return true; }
  if (mod && !e.shiftKey && code === 'Backslash') { leftOpen.value = !leftOpen.value; return true; }
  if (mod && key === ',') { overlay.value = { type: 'settings' }; return true; }
  if (mod && !e.shiftKey && code === 'KeyS') { saveAll(); return true; }
  if (e.altKey && !mod && code === 'KeyN' && canWrite.value) { createNode('file'); return true; }
  if (e.altKey && !mod && code === 'KeyT' && canWrite.value) { overlay.value = { type: 'templates' }; return true; }
  if (e.altKey && !mod && code === 'KeyD' && canWrite.value) { openDaily(); return true; }
  if (e.altKey && !mod && code === 'KeyG') { mainView.value = mainView.value === 'graph' ? 'doc' : 'graph'; return true; }
  if (e.key === 'Escape' && mainView.value !== 'doc' && !overlay.value) { mainView.value = 'doc'; return true; }
  if (e.altKey && !mod && code === 'KeyW' && activeId.value) { closeTab(activeId.value); return true; }
  if (key === 'f2' && activeId.value && canWrite.value) { renameNode(activeId.value); return true; }
  // в режиме чтения Ctrl+F открывает поиск редактора, а не браузера
  if (mod && !e.shiftKey && code === 'KeyF' && activeId.value && docs.get(activeId.value)?.mode === 'read') { findInNote(); return true; }
  return false;
}

export const closeSidebarsOnMobile = () => { if (isMobile.value) { leftOpen.value = false; rightOpen.value = false; } };
