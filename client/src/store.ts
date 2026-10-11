import { Annotation, Transaction, type EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { batch, computed, signal } from '@preact/signals';
import { api, ApiError, clientId, setUnauthorizedHandler } from './api';
import type { MenuItem, Mode, Presence, Role, Settings, TreeNode, User, Vault } from './types';
import { byName, debounce, diffChanges, displayName, dmp, downloadUrl, isMarkdown, linkName, ls, splitExt } from './util';

// ---------------------------------------------------------------- настройки
export const DEFAULTS: Settings = {
  theme: 'dark', skin: 'graphite', accent: '#3ddc97', uiFont: 'manrope', textFont: 'manrope', fontSize: 16, lineWidth: 760, radius: 16,
  motion: true, ripple: true, glass: true, ambient: true, defaultMode: 'live', lineNumbers: false, spellcheck: true, customCss: '',
};
export const settings = signal<Settings>({ ...DEFAULTS, ...ls.get<Partial<Settings>>('onyx.settings', {}) });

const pushSettings = debounce(() => { api('PATCH', '/me', { settings: settings.value }).catch(() => {}); }, 600);
export function updateSettings(patch: Partial<Settings>) {
  settings.value = { ...settings.value, ...patch };
  ls.set('onyx.settings', settings.value);
  pushSettings();
}

// ---------------------------------------------------------------- состояние
export const me = signal<User | null | undefined>(undefined);
export const allowRegistration = signal(true);
export const vaults = signal<Vault[]>([]);
export const vaultId = signal<string | null>(null);
export const role = signal<Role>('owner');
export const nodes = signal<TreeNode[]>([]);
export const treeLoaded = signal(false);
export const tabs = signal<string[]>([]);
export const activeId = signal<string | null>(null);
export const expanded = signal<Set<string>>(new Set());
export const presence = signal<Presence[]>([]);
export const online = signal(true);
export const searchQuery = signal('');
// что показано в основной области поверх документа: граф связей или профиль с активностью
export const mainView = signal<'doc' | 'graph' | 'profile'>('doc');
// меняется, когда кто-то открыл или закрыл мне доступ к заметке
export const sharesTick = signal(0);

const mobileMQ = matchMedia('(max-width: 820px)');
export const isMobile = signal(mobileMQ.matches);
export const leftOpen = signal(!mobileMQ.matches && ls.get('onyx.left', true));
export const rightOpen = signal(false);
export const sideTab = signal<'files' | 'search'>('files');
mobileMQ.addEventListener('change', (e) => {
  isMobile.value = e.matches;
  leftOpen.value = !e.matches;
  rightOpen.value = false;
});

// меняется при любом изменении статуса документов (загрузка, сохранение, режим)
export const docTick = signal(0);
// меняется с задержкой после правок текста — для оглавления и режима чтения
export const textTick = signal(0);
const bump = () => { docTick.value++; };
const bumpText = debounce(() => { textTick.value++; }, 250);

export const currentVault = computed(() => vaults.value.find((v) => v.id === vaultId.value) ?? null);
export const canWrite = computed(() => role.value !== 'viewer');
export const byId = computed(() => new Map(nodes.value.map((n) => [n.id, n])));
export const children = computed(() => {
  const map = new Map<string, TreeNode[]>();
  for (const n of nodes.value) {
    const k = n.parentId ?? '';
    const list = map.get(k);
    if (list) list.push(n); else map.set(k, [n]);
  }
  for (const list of map.values()) list.sort((a, b) => (a.kind === b.kind ? byName(a, b) : a.kind === 'folder' ? -1 : 1));
  return map;
});
export const files = computed(() => nodes.value.filter((n) => n.kind === 'file'));
const linkIndex = computed(() => {
  const map = new Map<string, TreeNode[]>();
  const add = (k: string, n: TreeNode) => { const l = map.get(k); if (l) l.push(n); else map.set(k, [n]); };
  for (const n of files.value) {
    add(n.name.toLowerCase(), n);
    if (isMarkdown(n.name)) add(displayName(n.name).toLowerCase(), n);
  }
  return map;
});

export function pathOf(id: string | null, withSelf = true): string {
  const parts: string[] = [];
  let n = id ? byId.value.get(id) : undefined;
  if (n && !withSelf) n = n.parentId ? byId.value.get(n.parentId) : undefined;
  while (n) { parts.unshift(n.name); n = n.parentId ? byId.value.get(n.parentId) : undefined; }
  return parts.join('/');
}

// [[Заметка]], [[Папка/Заметка#Раздел|подпись]], относительный путь из обычной ссылки
export function resolveLink(target: string): TreeNode | undefined {
  let t = target.split('|')[0].split('#')[0].trim().replace(/\\/g, '/').replace(/^\.?\//, '');
  if (!t) return activeId.value ? byId.value.get(activeId.value) : undefined;
  const name = t.split('/').pop()!.toLowerCase();
  const hits = linkIndex.value.get(name);
  if (!hits?.length) return undefined;
  if (t.includes('/')) {
    const want = t.toLowerCase();
    const exact = hits.find((n) => { const p = pathOf(n.id).toLowerCase(); return p === want || p === want + '.md' || p.endsWith('/' + want) || p.endsWith('/' + want + '.md'); });
    if (exact) return exact;
  }
  return hits.find((n) => isMarkdown(n.name)) ?? hits[0];
}

// ---------------------------------------------------------------- уведомления, диалоги, меню
export interface Toast { id: number; text: string; kind: 'info' | 'error' }
export const toasts = signal<Toast[]>([]);
let toastSeq = 0;
export function toast(text: string, kind: Toast['kind'] = 'info') {
  const id = ++toastSeq;
  toasts.value = [...toasts.value.slice(-3), { id, text, kind }];
  setTimeout(() => { toasts.value = toasts.value.filter((t) => t.id !== id); }, kind === 'error' ? 5000 : 2600);
}
export const fail = (e: unknown) => toast(e instanceof Error ? e.message : 'Что-то пошло не так', 'error');

export interface DialogSpec {
  kind: 'prompt' | 'confirm';
  title: string;
  text?: string;
  value?: string;
  placeholder?: string;
  confirmText?: string;
  danger?: boolean;
  resolve: (v: string | null) => void;
}
export const dialog = signal<DialogSpec | null>(null);
export const ask = {
  prompt: (o: Omit<DialogSpec, 'kind' | 'resolve'>) => new Promise<string | null>((resolve) => { dialog.value = { ...o, kind: 'prompt', resolve }; }),
  confirm: (o: Omit<DialogSpec, 'kind' | 'resolve'>) => new Promise<boolean>((resolve) => { dialog.value = { ...o, kind: 'confirm', resolve: (v) => resolve(v !== null) }; }),
};

export type Overlay =
  | { type: 'settings' }
  | { type: 'palette'; mode: 'files' | 'commands' }
  | { type: 'vaults' }
  | { type: 'share'; vaultId: string }
  | { type: 'move'; nodeId: string }
  | { type: 'templates' }
  | { type: 'shareNode'; nodeId: string }
  | { type: 'history'; nodeId: string }
  | null;
export const overlay = signal<Overlay>(null);

export const menu = signal<{ x: number; y: number; items: MenuItem[] } | null>(null);
export function openMenu(at: { clientX: number; clientY: number } | HTMLElement, items: MenuItem[]) {
  if (at instanceof HTMLElement) {
    const r = at.getBoundingClientRect();
    menu.value = { x: r.left, y: r.bottom + 6, items };
  } else {
    menu.value = { x: at.clientX, y: at.clientY, items };
  }
}

// ---------------------------------------------------------------- документы
export const Remote = Annotation.define<boolean>();

export interface Doc {
  id: string;
  loaded: boolean;
  loading: Promise<void> | null;
  missing: boolean;
  base: string;          // текст, который точно лежит на сервере
  baseVersion: number;
  text: string;          // пока редактор не создан
  state: EditorState | null;
  dirty: boolean;
  saving: boolean;
  error: string | null;
  mode: Mode;
  scrollTop: number;
  timer: number;
}
export const docs = new Map<string, Doc>();
export const editorRef: { view: EditorView | null } = { view: null };
export const pendingAnchor: { id: string | null; heading: string } = { id: null, heading: '' };

export const getText = (doc: Doc) => (doc.state ? doc.state.doc.toString() : doc.text);

function applyText(doc: Doc, next: string) {
  const cur = getText(doc);
  if (cur === next) return;
  if (!doc.state) { doc.text = next; bumpText(); return; }
  const spec = { changes: diffChanges(cur, next), annotations: [Remote.of(true), Transaction.addToHistory.of(false)] };
  const view = editorRef.view;
  if (view && view.state === doc.state) view.dispatch(spec); // слушатель редактора сам обновит doc.state
  else doc.state = doc.state.update(spec).state;
  bumpText();
}

// свои правки накладываются поверх чужой версии — как трёхстороннее слияние
function merge(doc: Doc, theirs: string, version: number) {
  const mine = getText(doc);
  let merged = theirs;
  if (doc.dirty && mine !== doc.base) merged = dmp.patch_apply(dmp.patch_make(doc.base, mine), theirs)[0];
  doc.base = theirs;
  doc.baseVersion = version;
  applyText(doc, merged);
  doc.dirty = merged !== theirs;
  if (doc.dirty) scheduleSave(doc, 300);
}

const draftKey = (id: string) => `onyx.draft.${id}`;
const writeDraft = debounce((doc: Doc) => {
  if (!doc.dirty) return;
  const text = getText(doc);
  if (text.length < 400_000) ls.set(draftKey(doc.id), { v: doc.baseVersion, text });
}, 1000);

export function docChanged(id: string, state: EditorState, remote: boolean) {
  const doc = docs.get(id);
  if (!doc) return;
  doc.state = state;
  bumpText();
  if (remote) return;
  const was = doc.dirty;
  doc.dirty = true;
  scheduleSave(doc);
  writeDraft(doc);
  if (!was) bump();
}

function scheduleSave(doc: Doc, delay = 900) {
  clearTimeout(doc.timer);
  doc.timer = window.setTimeout(() => save(doc), delay);
}

export async function save(doc: Doc, keepalive = false): Promise<void> {
  if (doc.saving || !doc.dirty || !doc.loaded || doc.missing || !canWrite.value) return;
  clearTimeout(doc.timer);
  const text = getText(doc);
  if (text === doc.base) { doc.dirty = false; ls.del(draftKey(doc.id)); bump(); return; }
  doc.saving = true;
  bump();
  try {
    // keepalive-запросы ограничены 64 КБ
    const r = await api('PUT', `/nodes/${doc.id}/content`, { content: text, baseVersion: doc.baseVersion }, { keepalive: keepalive && text.length < 20_000 });
    doc.base = text;
    doc.baseVersion = r.version;
    doc.error = null;
    patchNode(doc.id, { version: r.version, size: r.size, updatedAt: r.updatedAt });
    ls.del(draftKey(doc.id));
  } catch (e) {
    const err = e as ApiError;
    if (err.status === 409 && err.data?.conflict) merge(doc, err.data.content, err.data.version);
    else if (err.status === 404) { doc.missing = true; doc.error = 'Файл удалён на сервере'; }
    else if (err.status === 403) doc.error = 'Нет прав на запись';
    else doc.error = err.status === 0 ? 'Нет связи — сохраним, когда появится' : err.message;
  } finally {
    doc.saving = false;
    doc.dirty = getText(doc) !== doc.base;
    if (doc.dirty && !doc.missing) scheduleSave(doc, doc.error ? 5000 : 300);
    bump();
  }
}

export const saveAll = (keepalive = false) => Promise.all([...docs.values()].map((d) => save(d, keepalive)));

function patchNode(id: string, patch: Partial<TreeNode>) {
  const n = byId.value.get(id);
  if (!n) return;
  nodes.value = nodes.value.map((x) => (x.id === id ? { ...x, ...patch } : x));
}

// сервер сообщил о более новой версии — подтягиваем и сливаем
async function syncDoc(doc: Doc) {
  const node = byId.value.get(doc.id);
  if (!node || !doc.loaded || doc.saving || node.binary || node.version <= doc.baseVersion) return;
  try {
    const r = await api('GET', `/nodes/${doc.id}`);
    if (r.node.version > doc.baseVersion && !doc.saving) { merge(doc, r.content ?? '', r.node.version); bump(); }
  } catch { /* повторим при следующем событии */ }
}

export function ensureDoc(id: string): Doc {
  let doc = docs.get(id);
  if (!doc) {
    const node = byId.value.get(id);
    doc = {
      id, loaded: false, loading: null, missing: false, base: '', baseVersion: 0, text: '', state: null, dirty: false, saving: false, error: null,
      mode: node && isMarkdown(node.name) ? settings.value.defaultMode : 'source', scrollTop: 0, timer: 0,
    };
    docs.set(id, doc);
  }
  if (!doc.loaded && !doc.loading) {
    const d = doc;
    const node = byId.value.get(id);
    if (node?.binary) { d.loaded = true; return d; }
    d.loading = (async () => {
      try {
        const r = await api('GET', `/nodes/${id}`);
        d.base = d.text = r.content ?? '';
        d.baseVersion = r.node.version;
        d.loaded = true;
        d.error = null;
        await restoreDraft(d);
      } catch (e) {
        d.error = (e as Error).message;
        if ((e as ApiError).status === 404) d.missing = true;
      } finally {
        d.loading = null;
        bump();
      }
    })();
  }
  return doc;
}

// несохранённые правки переживают перезагрузку страницы и обрыв связи
async function restoreDraft(doc: Doc) {
  const draft = ls.get<{ v: number; text: string } | null>(draftKey(doc.id), null);
  if (!draft) return;
  ls.del(draftKey(doc.id));
  if (draft.text === doc.base || !canWrite.value) return;
  if (draft.v === doc.baseVersion) {
    doc.text = draft.text;
    doc.dirty = true;
    scheduleSave(doc, 300);
    return;
  }
  // пока нас не было, файл изменили: черновик кладём рядом отдельной заметкой
  const node = byId.value.get(doc.id);
  if (!node || !vaultId.value) return;
  const [base, ext] = splitExt(node.name);
  await api('POST', `/vaults/${vaultId.value}/nodes`, {
    parentId: node.parentId, kind: 'file', autoRename: true, content: draft.text, name: `${base} (несохранённый черновик)${ext ? '.' + ext : ''}`,
  }).then(() => { toast('Несохранённые правки восстановлены в отдельной заметке'); loadTree(); }).catch(() => {});
}

// замена текста как обычная правка: попадает в историю отмены и сохраняется (восстановление версии, вставка шаблона)
export function setDocText(id: string, next: string) {
  const doc = docs.get(id);
  if (!doc?.loaded) return;
  const cur = getText(doc);
  if (cur === next) return;
  if (!doc.state) { doc.text = next; doc.dirty = true; scheduleSave(doc, 300); bumpText(); bump(); return; }
  const spec = { changes: diffChanges(cur, next) };
  const view = editorRef.view;
  if (view && view.state === doc.state) view.dispatch(spec);
  else docChanged(id, doc.state.update(spec).state, false);
}

export function setMode(id: string, mode: Mode) {
  const doc = docs.get(id);
  if (!doc || doc.mode === mode) return;
  doc.mode = mode;
  bump();
}

// ---------------------------------------------------------------- вкладки
const vKey = (suffix: string) => `onyx.v.${vaultId.value}.${suffix}`;
function persistTabs() { ls.set(vKey('tabs'), { tabs: tabs.value, active: activeId.value }); }

export function openFile(id: string, opts: { anchor?: string } = {}) {
  const node = byId.value.get(id);
  if (!node || node.kind !== 'file') return;
  if (opts.anchor) { pendingAnchor.id = id; pendingAnchor.heading = opts.anchor; }
  ensureDoc(id);
  batch(() => {
    if (!tabs.value.includes(id)) tabs.value = [...tabs.value, id];
    activeId.value = id;
    mainView.value = 'doc';
    if (isMobile.value) leftOpen.value = false;
  });
  revealInTree(id);
  persistTabs();
  sendPresence();
}

export function closeTab(id: string) {
  const list = tabs.value;
  const i = list.indexOf(id);
  if (i < 0) return;
  const doc = docs.get(id);
  if (doc) save(doc).finally(() => { if (!tabs.value.includes(id) && !doc.dirty) docs.delete(id); });
  batch(() => {
    tabs.value = list.filter((t) => t !== id);
    if (activeId.value === id) activeId.value = tabs.value[Math.min(i, tabs.value.length - 1)] ?? null;
  });
  persistTabs();
  sendPresence();
}
export function closeOthers(id: string) { tabs.value.filter((t) => t !== id).forEach(closeTab); }

export function revealInTree(id: string) {
  const set = new Set(expanded.value);
  let n = byId.value.get(id);
  let changed = false;
  while (n?.parentId) { if (!set.has(n.parentId)) { set.add(n.parentId); changed = true; } n = byId.value.get(n.parentId); }
  if (changed) setExpanded(set);
}
export function setExpanded(set: Set<string>) { expanded.value = set; ls.set(vKey('expanded'), [...set]); }
export function toggleFolder(id: string) {
  const set = new Set(expanded.value);
  if (!set.delete(id)) set.add(id);
  setExpanded(set);
}

// ---------------------------------------------------------------- дерево
let treeSeq = 0;
export async function loadTree() {
  const vid = vaultId.value;
  if (!vid) return;
  const seq = ++treeSeq;
  try {
    const r = await api('GET', `/vaults/${vid}/tree`);
    if (seq !== treeSeq || vid !== vaultId.value) return;
    batch(() => { nodes.value = r.nodes; role.value = r.role; treeLoaded.value = true; });
    // вкладки удалённых файлов закрываем, остальные сверяем по версии
    for (const id of tabs.value) if (!byId.value.has(id)) { docs.delete(id); closeTab(id); }
    for (const doc of docs.values()) syncDoc(doc);
  } catch (e) {
    if ((e as ApiError).status === 404) { toast('Хранилище больше недоступно', 'error'); await loadVaults(); }
  }
}
const loadTreeSoon = debounce(loadTree, 150);

const defaultParent = () => {
  const a = activeId.value ? byId.value.get(activeId.value) : undefined;
  return a?.parentId ?? null;
};

export async function createNode(kind: 'file' | 'folder', parentId: string | null = defaultParent()) {
  if (!vaultId.value) return;
  const name = await ask.prompt({
    title: kind === 'file' ? 'Новая заметка' : 'Новая папка',
    text: parentId ? `в папке «${pathOf(parentId)}»` : undefined,
    value: kind === 'file' ? 'Без названия' : 'Новая папка',
    confirmText: 'Создать',
  });
  if (!name?.trim()) return;
  try {
    const full = kind === 'file' && !/\.[a-z0-9]{1,10}$/i.test(name.trim()) ? `${name.trim()}.md` : name.trim();
    const r = await api('POST', `/vaults/${vaultId.value}/nodes`, { parentId, kind, name: full, content: '' });
    await loadTree();
    if (parentId && !expanded.value.has(parentId)) toggleFolder(parentId);
    if (kind === 'file') openFile(r.node.id);
  } catch (e) { fail(e); }
}

export async function renameNode(id: string) {
  const node = byId.value.get(id);
  if (!node) return;
  const md = node.kind === 'file' && isMarkdown(node.name);
  const name = await ask.prompt({ title: 'Переименовать', value: md ? displayName(node.name) : node.name, confirmText: 'Сохранить' });
  if (!name?.trim()) return;
  const full = md && !/\.(md|markdown)$/i.test(name.trim()) ? `${name.trim()}.${splitExt(node.name)[1]}` : name.trim();
  if (full === node.name) return;
  try {
    await saveAll();
    const r = await api('PATCH', `/nodes/${id}`, { name: full });
    await loadTree();
    if (r.relinked) toast(`Ссылки обновлены в заметках: ${r.relinked}`);
  } catch (e) { fail(e); }
}

export async function moveNode(id: string, parentId: string | null) {
  const node = byId.value.get(id);
  if (!node || node.parentId === parentId || id === parentId) return;
  try {
    await api('PATCH', `/nodes/${id}`, { parentId });
    await loadTree();
    if (parentId && !expanded.value.has(parentId)) toggleFolder(parentId);
  } catch (e) { fail(e); }
}

export async function deleteNode(id: string) {
  const node = byId.value.get(id);
  if (!node) return;
  const inside = node.kind === 'folder' ? (children.value.get(id)?.length ?? 0) : 0;
  const yes = await ask.confirm({
    title: node.kind === 'folder' ? 'Удалить папку?' : 'Удалить файл?',
    text: `«${node.name}»${inside ? ' и всё её содержимое' : ''} будет удалено без возможности восстановления.`,
    confirmText: 'Удалить', danger: true,
  });
  if (!yes) return;
  try { await api('DELETE', `/nodes/${id}`); await loadTree(); } catch (e) { fail(e); }
}

export async function duplicateNode(id: string) {
  try {
    await saveAll();
    const r = await api('POST', `/nodes/${id}/duplicate`);
    await loadTree();
    openFile(r.node.id);
  } catch (e) { fail(e); }
}

export async function uploadFiles(items: { file: File; path?: string }[], parentId: string | null = null, unzip = false): Promise<string | null> {
  if (!vaultId.value || !items.length) return null;
  const fd = new FormData();
  if (unzip) fd.append('unzip', '1');
  for (const it of items) { fd.append('path', it.path || it.file.name); fd.append('file', it.file, it.file.name); }
  try {
    const r = await api('POST', `/vaults/${vaultId.value}/upload${parentId ? `?parentId=${parentId}` : ''}`, fd);
    await loadTree();
    return r.firstId as string | null;
  } catch (e) { fail(e); return null; }
}

export function pickAndUpload(parentId: string | null, mode: 'files' | 'folder' | 'zip') {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = mode !== 'zip';
  if (mode === 'zip') input.accept = '.zip,application/zip';
  if (mode === 'folder') (input as any).webkitdirectory = true;
  input.onchange = async () => {
    const list = [...(input.files ?? [])];
    if (!list.length) return;
    toast(`Загрузка: ${list.length}…`);
    const first = await uploadFiles(list.map((file) => ({ file, path: (file as any).webkitRelativePath || file.name })), parentId, mode === 'zip');
    if (first) { toast('Загружено'); if (parentId && !expanded.value.has(parentId)) toggleFolder(parentId); }
  };
  input.click();
}

export async function downloadNode(id: string) {
  const node = byId.value.get(id);
  if (!node) return;
  await saveAll();
  downloadUrl(node.kind === 'folder' ? `/api/nodes/${id}/export` : `/api/nodes/${id}/raw?download=1`, node.name);
}
export async function exportVault() {
  if (!vaultId.value) return;
  await saveAll();
  downloadUrl(`/api/vaults/${vaultId.value}/export`);
  toast('Архив хранилища готовится…');
}

// переход по ссылке; несуществующая заметка создаётся, как в Obsidian
export async function openLink(target: string) {
  const [path, anchor] = target.split('|')[0].split('#');
  const node = resolveLink(path);
  if (node) { openFile(node.id, { anchor }); return; }
  if (!canWrite.value || !vaultId.value || !path.trim()) { toast('Заметка не найдена'); return; }
  const segs = path.trim().split('/');
  const name = segs.pop()!;
  try {
    const r = await api('POST', `/vaults/${vaultId.value}/nodes`, {
      parentId: defaultParent(), kind: 'file', content: '', name: /\.[a-z0-9]{1,10}$/i.test(name) ? name : `${name}.md`,
    });
    await loadTree();
    openFile(r.node.id);
  } catch (e) { fail(e); }
}

export function searchFor(q: string) {
  batch(() => { searchQuery.value = q; sideTab.value = 'search'; leftOpen.value = true; });
}

export const wikiLabel = (n: TreeNode) => linkName(n.name);

// ---------------------------------------------------------------- хранилища
export async function loadVaults() {
  const r = await api('GET', '/vaults');
  vaults.value = r.vaults;
  if (!r.vaults.some((v: Vault) => v.id === vaultId.value)) {
    const last = ls.get<string | null>('onyx.vault', null);
    await selectVault(r.vaults.find((v: Vault) => v.id === last)?.id ?? r.vaults[0]?.id ?? null);
  } else {
    role.value = r.vaults.find((v: Vault) => v.id === vaultId.value)!.role;
  }
}

export async function selectVault(id: string | null) {
  if (id === vaultId.value) return;
  await saveAll().catch(() => {});
  disconnect();
  docs.clear();
  batch(() => {
    vaultId.value = id;
    nodes.value = []; tabs.value = []; activeId.value = null; presence.value = []; treeLoaded.value = false; mainView.value = 'doc';
    expanded.value = new Set(id ? ls.get<string[]>(`onyx.v.${id}.expanded`, []) : []);
  });
  bump();
  if (!id) return;
  ls.set('onyx.vault', id);
  await loadTree();
  const saved = ls.get<{ tabs: string[]; active: string | null }>(vKey('tabs'), { tabs: [], active: null });
  const alive = saved.tabs.filter((t) => byId.value.get(t)?.kind === 'file');
  batch(() => {
    tabs.value = alive;
    activeId.value = alive.includes(saved.active ?? '') ? saved.active : alive[0] ?? null;
  });
  if (activeId.value) ensureDoc(activeId.value);
  connect();
}

export async function createVault() {
  const name = await ask.prompt({ title: 'Новое хранилище', value: 'Хранилище', confirmText: 'Создать' });
  if (!name?.trim()) return;
  try {
    const r = await api('POST', '/vaults', { name: name.trim() });
    await loadVaults();
    await selectVault(r.id);
  } catch (e) { fail(e); }
}

// ---------------------------------------------------------------- вход
export async function init() {
  setUnauthorizedHandler(() => { if (me.value) { disconnect(); me.value = null; } });
  api('GET', '/config').then((c) => { allowRegistration.value = c.allowRegistration; }).catch(() => {});
  try {
    const r = await api('GET', '/me');
    await enter(r.user);
  } catch (e) {
    // без сети остаёмся на экране входа с понятным сообщением
    me.value = null;
    if ((e as ApiError).status === 0) toast('Нет связи с сервером', 'error');
  }
}

async function enter(user: User) {
  // настройки с сервера важнее локальных: оформление одинаково на всех устройствах
  settings.value = { ...DEFAULTS, ...settings.value, ...user.settings };
  ls.set('onyx.settings', settings.value);
  me.value = user;
  await loadVaults().catch(fail);
}

export async function signIn(mode: 'login' | 'register', login: string, password: string, name?: string) {
  const r = await api('POST', `/auth/${mode}`, { login, password, displayName: name });
  if (mode === 'register' && Object.keys(r.user.settings).length === 0) api('PATCH', '/me', { settings: settings.value }).catch(() => {});
  await enter(r.user);
}

export async function signOut() {
  await saveAll().catch(() => {});
  await api('POST', '/auth/logout').catch(() => {});
  disconnect();
  docs.clear();
  batch(() => { vaultId.value = null; vaults.value = []; nodes.value = []; tabs.value = []; activeId.value = null; mainView.value = 'doc'; me.value = null; });
}

// ---------------------------------------------------------------- живая синхронизация
let ws: WebSocket | null = null;
let wsTimer = 0;
let wsRetry = 0;

function sendPresence() {
  if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'open', nodeId: activeId.value }));
}

function connect() {
  const vid = vaultId.value;
  if (!vid) return;
  clearTimeout(wsTimer);
  const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws?vault=${vid}&client=${clientId}`);
  ws = sock;
  sock.onopen = () => {
    online.value = true;
    // после обрыва могли пропустить события — сверяемся целиком
    if (wsRetry > 0) { loadTree(); saveAll(); }
    wsRetry = 0;
    sendPresence();
  };
  sock.onmessage = (e) => {
    let m: any;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === 'presence') presence.value = m.users;
    else if (m.t === 'tree') { if (m.origin !== clientId) loadTreeSoon(); }
    else if (m.t === 'vaults') loadVaults().catch(() => {});
    else if (m.t === 'shares') sharesTick.value++;
    else if (m.t === 'content') {
      patchNode(m.id, { version: m.version, size: m.size, updatedAt: m.updatedAt });
      const doc = docs.get(m.id);
      if (doc && m.origin !== clientId) syncDoc(doc);
    }
  };
  sock.onclose = (e) => {
    if (ws !== sock) return;
    ws = null;
    online.value = false;
    if (e.code === 4403) { loadVaults().catch(() => {}); return; }
    wsRetry++;
    wsTimer = window.setTimeout(connect, Math.min(15_000, 800 * 2 ** Math.min(wsRetry, 5)));
  };
}

function disconnect() {
  clearTimeout(wsTimer);
  const sock = ws;
  ws = null;
  wsRetry = 0;
  sock?.close();
  online.value = true;
}

// уходим со страницы или сворачиваем приложение — сохраняем сразу
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveAll(true);
  else if (me.value && vaultId.value && !ws) { wsRetry = Math.max(wsRetry, 1); connect(); }
});
window.addEventListener('pagehide', () => { saveAll(true); });
window.addEventListener('online', () => { saveAll(); if (me.value && vaultId.value && !ws) connect(); });
