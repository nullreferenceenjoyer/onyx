import { api } from './api';
import { activeId, ask, byId, children, docs, editorRef, expanded, fail, loadTree, me, openFile, toast, toggleFolder, vaultId } from './store';
import type { TreeNode } from './types';
import { displayName, isMarkdown } from './util';

// Шаблоны: готовые (ниже) и свои — любые заметки в папке «Шаблоны» в корне хранилища.
// Свой шаблон с тем же названием, что у готового, заменяет его.

export const TEMPLATES_FOLDER = 'Шаблоны';
export const DAILY_FOLDER = 'Дневник';
const DAILY_NAME = 'Ежедневная заметка';

export interface Template {
  key: string;
  name: string;
  description: string;
  icon: string;
  body: string;
  title?: string;      // как назвать новую заметку (с переменными)
  nodeId?: string;     // свой шаблон — файл в хранилище
}

export const BUILTIN: Template[] = [
  {
    key: 'daily', name: DAILY_NAME, icon: 'calendar', title: '{{date}}',
    description: 'План на день, заметки по ходу и итог вечером',
    body: `# {{date:D MMMM YYYY}}, {{date:dddd}}

## Главное на сегодня

- [ ] {{cursor}}
- [ ]
- [ ]

## Заметки

## Итог дня

- Что получилось:
- Что перенести на завтра:
`,
  },
  {
    key: 'meeting', name: 'Встреча', icon: 'users', title: 'Встреча {{date}}',
    description: 'Повестка, решения и задачи по итогам',
    body: `# {{title}}

**Дата:** {{date}} {{time}}
**Участники:** {{user}},

## Повестка

1. {{cursor}}

## Обсуждение

## Решения

-

## Задачи

- [ ] кто — что — к какому сроку
`,
  },
  {
    key: 'project', name: 'Проект', icon: 'vault', title: 'Проект',
    description: 'Цель, границы, этапы и риски',
    body: `# {{title}}

> [!abstract] Суть в одном абзаце
> {{cursor}}

## Цель

Что должно измениться, когда проект завершится, и как мы это поймём.

## Границы

- **Входит:**
- **Не входит:**

## Этапы

| Этап | Результат | Срок |
| ---- | --------- | ---- |
|      |           |      |

## Риски

-

## Журнал

- {{date}} — проект заведён
`,
  },
  {
    key: 'weekly', name: 'Итоги недели', icon: 'outline', title: 'Неделя {{date}}',
    description: 'Что сделано, что мешало, планы на следующую',
    body: `# Неделя до {{date:D MMMM YYYY}}

## Сделано

- {{cursor}}

## Не успел и почему

-

## Что понял

## На следующую неделю

- [ ]
- [ ]
- [ ]
`,
  },
  {
    key: 'book', name: 'Конспект книги', icon: 'book', title: 'Книга',
    description: 'Главные мысли, цитаты и что применить',
    body: `# {{title}}

**Автор:** {{cursor}}
**Прочитано:** {{date}}
**Оценка:** /10

## О чём книга в трёх предложениях

## Главные мысли

1.
2.
3.

## Цитаты

>

## Что применю

- [ ]
`,
  },
  {
    key: 'decision', name: 'Решение', icon: 'check', title: 'Решение',
    description: 'Контекст, варианты и почему выбрали именно так',
    body: `# {{title}}

**Статус:** предложено · **Дата:** {{date}} · **Автор:** {{user}}

## Контекст

{{cursor}}

## Варианты

### Вариант А

- плюсы:
- минусы:

### Вариант Б

- плюсы:
- минусы:

## Решение

## Последствия
`,
  },
  {
    key: 'person', name: 'Человек', icon: 'user', title: 'Имя Фамилия',
    description: 'Контакты, договорённости, история общения',
    body: `# {{title}}

**Кто:** {{cursor}}
**Контакты:**

## Что важно помнить

-

## Встречи и разговоры

- {{date}} —
`,
  },
  {
    key: 'idea', name: 'Идея', icon: 'sparkles', title: 'Идея',
    description: 'Быстро записать мысль и следующий шаг',
    body: `# {{title}}

#идея

**Проблема:** {{cursor}}

**Решение:**

**Первый шаг:**

- [ ]
`,
  },
];

// ---------------------------------------------------------------- переменные
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const p2 = (n: number) => String(n).padStart(2, '0');

// {{date:D MMMM YYYY}} → «11 октября 2026»; обозначения как в Obsidian (Moment.js)
export function formatDate(d: Date, fmt: string): string {
  // рядом с числом месяц стоит в родительном падеже: «11 октября», но «октябрь 2026»
  const month = /D/.test(fmt) ? MONTHS_GEN : MONTHS;
  return fmt.replace(/YYYY|YY|MMMM|MM|M|DD|D|dddd|HH|H|mm|ss/g, (t) => ({
    YYYY: String(d.getFullYear()), YY: String(d.getFullYear()).slice(2), MMMM: month[d.getMonth()], MM: p2(d.getMonth() + 1), M: String(d.getMonth() + 1),
    DD: p2(d.getDate()), D: String(d.getDate()), dddd: WEEKDAYS[d.getDay()], HH: p2(d.getHours()), H: String(d.getHours()), mm: p2(d.getMinutes()), ss: p2(d.getSeconds()),
  }[t] ?? t));
}

const CURSOR = '{{cursor}}';
export function expand(body: string, title = ''): { text: string; cursor: number } {
  const now = new Date();
  const filled = body.replace(/\{\{\s*(date|time|title|user)(?::([^}]+))?\s*\}\}/g, (_m, name: string, fmt?: string) => {
    if (name === 'date') return formatDate(now, fmt?.trim() || 'YYYY-MM-DD');
    if (name === 'time') return formatDate(now, fmt?.trim() || 'HH:mm');
    if (name === 'title') return title;
    return me.value?.displayName ?? '';
  });
  const cursor = filled.indexOf(CURSOR);
  return { text: filled.split(CURSOR).join(''), cursor: cursor < 0 ? filled.length : cursor };
}

// ---------------------------------------------------------------- свои шаблоны
const rootFolder = (name: string) => (children.value.get('') ?? []).find((n) => n.kind === 'folder' && n.name.toLowerCase() === name.toLowerCase());

export function customTemplates(): Template[] {
  const folder = rootFolder(TEMPLATES_FOLDER);
  if (!folder) return [];
  return (children.value.get(folder.id) ?? []).filter((n) => n.kind === 'file' && !n.binary && isMarkdown(n.name)).map((n) => ({
    key: n.id, name: displayName(n.name), description: 'Свой шаблон', icon: 'file', body: '', nodeId: n.id,
    title: BUILTIN.find((b) => b.name.toLowerCase() === displayName(n.name).toLowerCase())?.title,
  }));
}

// свои идут первыми; готовый шаблон скрывается, если есть свой с тем же названием
export function allTemplates(): Template[] {
  const own = customTemplates();
  const taken = new Set(own.map((t) => t.name.toLowerCase()));
  return [...own, ...BUILTIN.filter((b) => !taken.has(b.name.toLowerCase()))];
}

export async function templateBody(t: Template): Promise<string> {
  if (!t.nodeId) return t.body;
  const open = docs.get(t.nodeId);
  if (open?.loaded) return open.state ? open.state.doc.toString() : open.text;
  return (await api('GET', `/nodes/${t.nodeId}`)).content ?? '';
}

async function ensureFolder(name: string): Promise<string> {
  const found = rootFolder(name);
  if (found) return found.id;
  const r = await api('POST', `/vaults/${vaultId.value}/nodes`, { parentId: null, kind: 'folder', name });
  await loadTree();
  return r.node.id;
}

// ---------------------------------------------------------------- действия
export async function createFromTemplate(t: Template, parentId?: string | null) {
  if (!vaultId.value) return;
  const suggested = expand(t.title ?? t.name).text;
  const name = await ask.prompt({ title: `Новая заметка: ${t.name}`, value: suggested, confirmText: 'Создать' });
  if (!name?.trim()) return;
  try {
    const body = expand(await templateBody(t), name.trim()).text;
    const active = activeId.value ? byId.value.get(activeId.value) : undefined;
    const parent = parentId !== undefined ? parentId : active?.parentId ?? null;
    const r = await api('POST', `/vaults/${vaultId.value}/nodes`, { parentId: parent, kind: 'file', name: `${name.trim()}.md`, content: body, autoRename: true });
    await loadTree();
    openFile(r.node.id);
  } catch (e) { fail(e); }
}

export async function insertTemplate(t: Template) {
  const view = editorRef.view;
  const node = activeId.value ? byId.value.get(activeId.value) : undefined;
  if (!view || !node || node.binary || view.state.readOnly) { toast('Откройте заметку в режиме правки', 'error'); return; }
  try {
    const { text, cursor } = expand(await templateBody(t), displayName(node.name));
    const at = view.state.selection.main;
    view.dispatch({ changes: { from: at.from, to: at.to, insert: text }, selection: { anchor: at.from + cursor }, scrollIntoView: true, userEvent: 'input' });
    view.focus();
  } catch (e) { fail(e); }
}

export async function saveAsTemplate(node: TreeNode) {
  const name = await ask.prompt({ title: 'Сохранить как шаблон', text: `Копия заметки появится в папке «${TEMPLATES_FOLDER}».`, value: displayName(node.name), confirmText: 'Сохранить' });
  if (!name?.trim()) return;
  try {
    const content = (await api('GET', `/nodes/${node.id}`)).content ?? '';
    const folder = await ensureFolder(TEMPLATES_FOLDER);
    await api('POST', `/vaults/${vaultId.value}/nodes`, { parentId: folder, kind: 'file', name: `${name.trim()}.md`, content, autoRename: true });
    await loadTree();
    toast('Шаблон сохранён');
  } catch (e) { fail(e); }
}

// свой шаблон с нуля или копия готового, чтобы изменить его под себя
export async function newTemplate(from?: Template) {
  const name = await ask.prompt({ title: from ? 'Свой вариант шаблона' : 'Новый шаблон', value: from?.name ?? 'Мой шаблон', confirmText: 'Создать' });
  if (!name?.trim()) return;
  try {
    const folder = await ensureFolder(TEMPLATES_FOLDER);
    const content = from ? from.body : '# {{title}}\n\n{{date}} · {{user}}\n\n{{cursor}}\n';
    const r = await api('POST', `/vaults/${vaultId.value}/nodes`, { parentId: folder, kind: 'file', name: `${name.trim()}.md`, content, autoRename: true });
    await loadTree();
    if (!expanded.value.has(folder)) toggleFolder(folder);
    openFile(r.node.id);
    toast('Шаблон открыт для правки. Переменные: {{date}}, {{time}}, {{title}}, {{user}}, {{cursor}}');
  } catch (e) { fail(e); }
}

// заметка на сегодня: одна на день, в папке «Дневник»
export async function openDaily() {
  if (!vaultId.value) return;
  try {
    const title = formatDate(new Date(), 'YYYY-MM-DD');
    const existing = rootFolder(DAILY_FOLDER);
    const hit = existing && (children.value.get(existing.id) ?? []).find((n) => n.name.toLowerCase() === `${title}.md`);
    if (hit) { openFile(hit.id); return; }
    const folder = await ensureFolder(DAILY_FOLDER);
    const tpl = allTemplates().find((t) => t.name.toLowerCase() === DAILY_NAME.toLowerCase()) ?? BUILTIN[0];
    const r = await api('POST', `/vaults/${vaultId.value}/nodes`, { parentId: folder, kind: 'file', name: `${title}.md`, content: expand(await templateBody(tpl), title).text });
    await loadTree();
    openFile(r.node.id);
  } catch (e) { fail(e); }
}
