import { useEffect, useState } from 'preact/hooks';
import { api } from '../api';
import { Icon } from '../icons';
import { ACCENTS, SKINS } from '../look';
import { DEFAULTS, fail, loadVaults, me, overlay, settings, signOut, toast, updateSettings, vaults } from '../store';
import type { Member, Settings as S } from '../types';
import { debounce } from '../util';
import { Modal, Switch } from './ui';

type Page = 'look' | 'editor' | 'css' | 'account' | 'app';
const PAGES: { id: Page; label: string; icon: string }[] = [
  { id: 'look', label: 'Оформление', icon: 'palette' },
  { id: 'editor', label: 'Редактор', icon: 'pencil' },
  { id: 'css', label: 'Свой CSS', icon: 'code' },
  { id: 'account', label: 'Аккаунт', icon: 'user' },
  { id: 'app', label: 'Приложение', icon: 'download' },
];

const FONT_NAMES: Record<S['uiFont'], string> = { manrope: 'Manrope', system: 'Системный', serif: 'С засечками', mono: 'Моноширинный' };
const PREVIEW: Record<S['skin'], [string, string, string][]> = {
  graphite: [['#0a0b0d', '#171a1e', '#262a31'], ['#f4f5f7', '#ffffff', '#e4e6eb']],
  midnight: [['#080c14', '#151d2d', '#1f2a3f'], ['#eef2f8', '#ffffff', '#dde4ee']],
  paper: [['#12100d', '#211d19', '#2f2a24'], ['#f3eee4', '#fbf8f1', '#e2dacb']],
};

function Row({ title, hint, children }: { title: string; hint?: string; children: preact.ComponentChildren }) {
  return <div class="set-row"><div><b>{title}</b>{hint ? <small>{hint}</small> : null}</div>{children}</div>;
}

function Select<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <select class="select" aria-label={label} value={value} onChange={(e) => onChange((e.target as HTMLSelectElement).value as T)}>
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}

function Look() {
  const s = settings.value;
  const dark = document.documentElement.dataset.theme === 'dark';
  const preset = ACCENTS.some((a) => a.hex.toLowerCase() === s.accent.toLowerCase());
  const fonts = Object.entries(FONT_NAMES) as [S['uiFont'], string][];
  return (
    <>
      <div class="set-group">
        <h4>Тема</h4>
        <div class="seg" style="align-self:start;justify-self:start">
          {([['dark', 'Тёмная'], ['light', 'Светлая'], ['system', 'Как в системе']] as const).map(([v, l]) => (
            <button type="button" key={v} class={`seg-btn${s.theme === v ? ' is-active' : ''}`} onClick={() => updateSettings({ theme: v })}>{l}</button>
          ))}
        </div>
        <div class="skins">
          {SKINS.map((k) => {
            const [bg, surface, border] = PREVIEW[k.id][dark ? 0 : 1];
            return (
              <button type="button" key={k.id} class={`skin-card${s.skin === k.id ? ' is-active' : ''}`} onClick={() => updateSettings({ skin: k.id })}>
                <span class="skin-prev" style={{ '--pv-bg': bg, '--pv-surface': surface, '--pv-border': border }}><i /><i /></span>
                <b>{k.name}</b><small>{k.hint}</small>
              </button>
            );
          })}
        </div>
      </div>
      <div class="set-group">
        <h4>Акцентный цвет</h4>
        <div class="swatches">
          {ACCENTS.map((a) => (
            <button type="button" key={a.hex} class={`swatch${a.hex.toLowerCase() === s.accent.toLowerCase() ? ' is-active' : ''}`} style={{ '--sw': a.hex }}
              title={a.name} aria-label={a.name} onClick={() => updateSettings({ accent: a.hex })} />
          ))}
          <label class={`swatch swatch-custom${preset ? '' : ' is-active'}`} title="Свой цвет" style={preset ? undefined : { '--sw': s.accent }}>
            <input type="color" value={s.accent} aria-label="Свой цвет" onInput={(e) => updateSettings({ accent: (e.target as HTMLInputElement).value })} />
          </label>
        </div>
      </div>
      <div class="set-group">
        <h4>Шрифты и размеры</h4>
        <Row title="Шрифт интерфейса"><Select label="Шрифт интерфейса" value={s.uiFont} options={fonts} onChange={(v) => updateSettings({ uiFont: v })} /></Row>
        <Row title="Шрифт текста заметок"><Select label="Шрифт текста" value={s.textFont} options={fonts} onChange={(v) => updateSettings({ textFont: v })} /></Row>
        <div class="field">
          <span>Размер текста</span>
          <div class="range-row"><input type="range" min="13" max="22" step="1" value={s.fontSize} onInput={(e) => updateSettings({ fontSize: Number((e.target as HTMLInputElement).value) })} /><output>{s.fontSize}px</output></div>
        </div>
        <div class="field">
          <span>Ширина строки</span>
          <div class="range-row">
            <input type="range" min="520" max="1240" step="40" value={s.lineWidth || 1240} onInput={(e) => { const v = Number((e.target as HTMLInputElement).value); updateSettings({ lineWidth: v >= 1240 ? 0 : v }); }} />
            <output>{s.lineWidth ? `${s.lineWidth}px` : 'вся'}</output>
          </div>
        </div>
        <div class="field">
          <span>Скругление углов</span>
          <div class="range-row"><input type="range" min="0" max="24" step="2" value={s.radius} onInput={(e) => updateSettings({ radius: Number((e.target as HTMLInputElement).value) })} /><output>{s.radius}px</output></div>
        </div>
      </div>
      <div class="set-group">
        <h4>Эффекты</h4>
        <Row title="Анимации" hint="Появление окон, пружинящие нажатия, плавные панели"><Switch label="Анимации" checked={s.motion} onChange={(v) => updateSettings({ motion: v })} /></Row>
        <Row title="Волна от нажатия" hint="Круг, расходящийся из-под курсора или пальца"><Switch label="Волна от нажатия" checked={s.ripple} onChange={(v) => updateSettings({ ripple: v })} /></Row>
        <Row title="Фоновое свечение" hint="Цветная волна сверху, следует за курсором"><Switch label="Фоновое свечение" checked={s.ambient} onChange={(v) => updateSettings({ ambient: v })} /></Row>
        <Row title="Стеклянные панели" hint="Полупрозрачные боковые панели с размытием"><Switch label="Стеклянные панели" checked={s.glass} onChange={(v) => updateSettings({ glass: v })} /></Row>
      </div>
      <button type="button" class="btn btn-ghost" style="justify-self:start"
        onClick={() => { const { customCss, defaultMode, lineNumbers, spellcheck } = s; updateSettings({ ...DEFAULTS, customCss, defaultMode, lineNumbers, spellcheck }); }}>
        Сбросить оформление
      </button>
    </>
  );
}

function Editor() {
  const s = settings.value;
  return (
    <div class="set-group">
      <h4>Редактор</h4>
      <Row title="Режим при открытии заметки" hint="Живой просмотр прячет разметку, пока курсор не встанет на строку">
        <Select label="Режим по умолчанию" value={s.defaultMode} options={[['live', 'Живой просмотр'], ['source', 'Исходник'], ['read', 'Чтение']]} onChange={(v) => updateSettings({ defaultMode: v })} />
      </Row>
      <Row title="Номера строк"><Switch label="Номера строк" checked={s.lineNumbers} onChange={(v) => updateSettings({ lineNumbers: v })} /></Row>
      <Row title="Проверка орфографии" hint="Средствами браузера"><Switch label="Проверка орфографии" checked={s.spellcheck} onChange={(v) => updateSettings({ spellcheck: v })} /></Row>
      <div class="note">
        Форматы: Markdown (.md) — основной, с живым просмотром. Любые другие текстовые файлы (.txt, .json, .yaml, .csv, .js, .py, .html…) открываются
        как код с подсветкой. Картинки, PDF, аудио и видео показываются встроенным просмотрщиком.
      </div>
    </div>
  );
}

const pushCss = debounce((css: string) => updateSettings({ customCss: css }), 350);
function Css() {
  const [css, setCss] = useState(settings.value.customCss);
  return (
    <div class="set-group">
      <h4>Свой CSS</h4>
      <div class="note">
        Применяется сразу и синхронизируется между вашими устройствами. Все цвета — CSS-переменные: <code>--bg</code>, <code>--surface</code>, <code>--text</code>,{' '}
        <code>--accent</code>, <code>--border</code>, <code>--radius</code>. Заголовки в редакторе — <code>.cm-h1</code>…<code>.cm-h6</code>, отрисованная заметка — <code>.markdown</code>.
      </div>
      <textarea class="textarea" style="min-height:280px" spellcheck={false} autocapitalize="off" autocomplete="off" value={css}
        placeholder={'/* например */\n.cm-h1 { color: var(--accent); }\n.markdown blockquote { font-style: italic; }'}
        onInput={(e) => { const v = (e.target as HTMLTextAreaElement).value; setCss(v); pushCss(v); }} />
    </div>
  );
}

function Account() {
  const user = me.value!;
  const [name, setName] = useState(user.displayName);
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const saveName = async () => {
    if (!name.trim() || name.trim() === user.displayName) return;
    try { const r = await api('PATCH', '/me', { displayName: name.trim() }); me.value = r.user; toast('Имя сохранено'); } catch (e) { fail(e); }
  };
  const changePassword = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    try { await api('PATCH', '/me', { currentPassword: cur, newPassword: next }); setCur(''); setNext(''); toast('Пароль изменён, остальные устройства разлогинены'); } catch (err) { fail(err); }
    setBusy(false);
  };
  return (
    <>
      <div class="set-group">
        <h4>Профиль</h4>
        <Row title="Логин"><code>{user.login}</code></Row>
        <label class="field"><span>Имя, которое видят другие участники</span>
          <div class="add-row"><input class="input" value={name} maxLength={60} onInput={(e) => setName((e.target as HTMLInputElement).value)} /><button type="button" class="btn" onClick={saveName}>Сохранить</button></div>
        </label>
      </div>
      <form class="set-group" onSubmit={changePassword}>
        <h4>Смена пароля</h4>
        <input class="input" type="password" placeholder="Текущий пароль" autocomplete="current-password" required value={cur} onInput={(e) => setCur((e.target as HTMLInputElement).value)} />
        <input class="input" type="password" placeholder="Новый пароль (от 6 символов)" autocomplete="new-password" required minLength={6} value={next} onInput={(e) => setNext((e.target as HTMLInputElement).value)} />
        <button type="submit" class={`btn${busy ? ' is-loading' : ''}`} style="justify-self:start">Изменить пароль</button>
      </form>
      <div class="set-group">
        <h4>Сессия</h4>
        <div class="note">Вход сохраняется на этом устройстве надолго и продлевается при каждом посещении.</div>
        <button type="button" class="btn" style="justify-self:start" onClick={() => { overlay.value = null; signOut(); }}><Icon name="logout" size={16} />Выйти</button>
      </div>
    </>
  );
}

// событие установки приходит один раз — запоминаем его до открытия настроек
let installEvent: any = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; });

function App() {
  const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const [can, setCan] = useState(!!installEvent);
  return (
    <div class="set-group">
      <h4>Установка</h4>
      {standalone ? <div class="note">Приложение уже установлено и открыто в отдельном окне.</div> : (
        <>
          <div class="note">
            «Оникс» можно установить как обычное приложение: значок на рабочем столе, отдельное окно без адресной строки.
            {ios ? ' На iPhone и iPad: кнопка «Поделиться» в Safari → «На экран „Домой“».' : ' В Chrome и Edge — кнопка ниже или значок установки в адресной строке; на Android — меню браузера → «Установить приложение».'}
            {!window.isSecureContext ? ' Сейчас сайт открыт по незащищённому адресу — для установки нужен https или localhost.' : ''}
          </div>
          {can ? <button type="button" class="btn btn-primary" style="justify-self:start" onClick={async () => { await installEvent.prompt(); installEvent = null; setCan(false); }}><Icon name="download" size={16} />Установить</button> : null}
        </>
      )}
      <h4 style="margin-top:8px">Горячие клавиши</h4>
      <div class="keys" style="color:var(--muted)">
        <div><span>Быстрый переход к файлу</span><kbd>Ctrl + O</kbd></div>
        <div><span>Палитра команд</span><kbd>Ctrl + P</kbd></div>
        <div><span>Чтение ↔ правка</span><kbd>Ctrl + E</kbd></div>
        <div><span>Поиск по хранилищу</span><kbd>Ctrl + Shift + F</kbd></div>
        <div><span>Найти в заметке</span><kbd>Ctrl + F</kbd></div>
        <div><span>Новая заметка</span><kbd>Alt + N</kbd></div>
        <div><span>Закрыть вкладку</span><kbd>Alt + W</kbd></div>
        <div><span>Переименовать</span><kbd>F2</kbd></div>
        <div><span>Дерево файлов</span><kbd>Ctrl + \</kbd></div>
        <div><span>Жирный · курсив · ссылка</span><kbd>Ctrl + B · I · K</kbd></div>
      </div>
    </div>
  );
}

export function SettingsModal() {
  const [page, setPage] = useState<Page>('look');
  return (
    <Modal title="Настройки" size="lg" onClose={() => { overlay.value = null; }}>
      <div class="settings">
        <nav class="set-nav">
          {PAGES.map((p) => (
            <button type="button" key={p.id} class={`menu-item${page === p.id ? ' is-active' : ''}`} onClick={() => setPage(p.id)}><Icon name={p.icon} size={16} /><span>{p.label}</span></button>
          ))}
        </nav>
        <div class="set-page" key={page}>
          {page === 'look' ? <Look /> : page === 'editor' ? <Editor /> : page === 'css' ? <Css /> : page === 'account' ? <Account /> : <App />}
        </div>
      </div>
    </Modal>
  );
}

const ROLE_NAMES = { owner: 'владелец', editor: 'редактор', viewer: 'читатель' };

export function ShareModal({ vaultId }: { vaultId: string }) {
  const vault = vaults.value.find((v) => v.id === vaultId);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [login, setLogin] = useState('');
  const [role, setRole] = useState<'editor' | 'viewer'>('editor');
  const owner = vault?.role === 'owner';
  const load = () => api('GET', `/vaults/${vaultId}/members`).then((r) => setMembers(r.members)).catch(fail);
  useEffect(() => { load(); }, [vaultId]);
  if (!vault) return null;

  const add = async (e: Event) => {
    e.preventDefault();
    try { await api('POST', `/vaults/${vaultId}/members`, { login, role }); setLogin(''); await load(); loadVaults(); toast('Доступ открыт'); } catch (err) { fail(err); }
  };
  const remove = async (m: Member) => {
    try { await api('DELETE', `/vaults/${vaultId}/members/${m.id}`); await load(); loadVaults(); } catch (err) { fail(err); }
  };
  const setMemberRole = async (m: Member, r: 'editor' | 'viewer') => {
    try { await api('POST', `/vaults/${vaultId}/members`, { login: m.login, role: r }); await load(); } catch (err) { fail(err); }
  };

  return (
    <Modal title={`Доступ: ${vault.name}`} onClose={() => { overlay.value = null; }}>
      <div class="modal-body">
        {owner ? (
          <form class="field" onSubmit={add}>
            <span>Пригласить по логину</span>
            <div class="add-row">
              <input class="input" value={login} required placeholder="логин пользователя" autocapitalize="none" autocomplete="off" spellcheck={false}
                onInput={(e) => setLogin((e.target as HTMLInputElement).value)} />
              <select class="select" aria-label="Роль" value={role} onChange={(e) => setRole((e.target as HTMLSelectElement).value as 'editor' | 'viewer')}>
                <option value="editor">редактор</option>
                <option value="viewer">читатель</option>
              </select>
            </div>
            <button type="submit" class="btn btn-primary" style="justify-self:start"><Icon name="plus" size={16} />Открыть доступ</button>
          </form>
        ) : <div class="note">Приглашать участников может только владелец хранилища.</div>}
        <div>
          {members === null ? <p>Загрузка…</p> : members.map((m) => (
            <div class="member" key={m.id}>
              <span class="avatar">{m.displayName.slice(0, 1)}</span>
              <div class="member-info"><b>{m.displayName}{m.id === me.value?.id ? ' (вы)' : ''}</b><small>{m.login}</small></div>
              {owner && m.role !== 'owner' ? (
                <>
                  <select class="select" style="width:auto" aria-label="Роль" value={m.role} onChange={(e) => setMemberRole(m, (e.target as HTMLSelectElement).value as 'editor' | 'viewer')}>
                    <option value="editor">редактор</option>
                    <option value="viewer">читатель</option>
                  </select>
                  <button type="button" class="icon-btn" title="Закрыть доступ" aria-label="Закрыть доступ" onClick={() => remove(m)}><Icon name="x" /></button>
                </>
              ) : <small class="menu-hint">{ROLE_NAMES[m.role]}</small>}
            </div>
          ))}
        </div>
        <div class="note">Редакторы правят заметки одновременно: изменения появляются у всех сразу, а одновременные правки одного файла сливаются автоматически.</div>
      </div>
    </Modal>
  );
}
