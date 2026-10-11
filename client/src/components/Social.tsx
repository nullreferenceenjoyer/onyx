import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { copyText } from '../actions';
import { api } from '../api';
import { Icon } from '../icons';
import {
  ask, byId, canWrite, currentVault, docs, ensureDoc, fail, getText, mainView, me, openFile, overlay, selectVault, setDocText, sharesTick, toast, vaultId,
} from '../store';
import type { DayStat, Share } from '../types';
import { displayName, dmp, formatSize } from '../util';
import { Modal, Switch } from './ui';

export const shareUrl = (token: string) => `${location.origin}/s/${token}`;
const profileUrl = (login: string) => `${location.origin}/u/${encodeURIComponent(login)}`;
const p2 = (n: number) => String(n).padStart(2, '0');
export const dayKey = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const plural = (n: number, one: string, few: string, many: string) => {
  const a = Math.abs(n) % 100, b = a % 10;
  return `${n} ${a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many}`;
};
export const edits = (n: number) => plural(n, 'правка', 'правки', 'правок');
const notesWord = (n: number) => plural(n, 'заметке', 'заметках', 'заметках');

export function expiryText(iso: string | null): string {
  if (!iso) return 'навсегда';
  const d = new Date(iso);
  if (d.getTime() < Date.now()) return 'срок истёк';
  return `до ${d.toLocaleString('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
}

// ---------------------------------------------------------------- карта активности (как контрибуции)
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

export function Heatmap({ days, selected, onSelect }: { days: DayStat[]; selected?: string | null; onSelect?: (day: string) => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const { weeks, max } = useMemo(() => {
    const by = new Map(days.map((d) => [d.day, d]));
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    // неделя начинается с понедельника; последняя колонка — текущая неделя
    const start = new Date(today);
    start.setDate(start.getDate() - ((today.getDay() + 6) % 7) - 52 * 7);
    const weeks: { key: string; date: Date; stat?: DayStat; future: boolean }[][] = [];
    for (let w = 0; w < 53; w++) {
      const col = [];
      for (let d = 0; d < 7; d++) {
        const date = new Date(start);
        date.setDate(start.getDate() + w * 7 + d);
        const key = dayKey(date);
        col.push({ key, date, stat: by.get(key), future: date > today });
      }
      weeks.push(col);
    }
    return { weeks, max: Math.max(4, ...days.map((d) => d.count)) };
  }, [days]);
  // самое свежее — справа: на узком экране сразу показываем конец года
  useEffect(() => { const el = scroller.current; if (el) el.scrollLeft = el.scrollWidth; }, [weeks]);

  return (
    <div class="heat-scroll" ref={scroller}>
      <div class="heat">
        <div class="heat-months">
          {weeks.map((col, i) => {
            const first = col[0].date, prev = i ? weeks[i - 1][0].date : null;
            return <span key={i}>{!prev || prev.getMonth() !== first.getMonth() ? MONTHS[first.getMonth()] : ''}</span>;
          })}
        </div>
        <div class="heat-days"><span>пн</span><span /><span>ср</span><span /><span>пт</span><span /><span /></div>
        <div class="heat-grid" role="grid">
          {weeks.map((col) => col.map((c) => {
            const n = c.stat?.count ?? 0;
            const lvl = n ? Math.min(4, Math.ceil((n / max) * 4)) : 0;
            const label = `${c.date.toLocaleDateString('ru', { day: 'numeric', month: 'long', year: 'numeric' })}: ${n ? `${edits(n)} в ${notesWord(c.stat!.notes)}` : 'без правок'}`;
            return c.future ? <i key={c.key} class="heat-cell is-future" /> : (
              <button type="button" key={c.key} class={`heat-cell lvl-${lvl}${selected === c.key ? ' is-sel' : ''}`} title={label} aria-label={label}
                onClick={() => onSelect?.(c.key)} />
            );
          }))}
        </div>
      </div>
    </div>
  );
}

export function HeatLegend() {
  return <div class="heat-legend"><span>меньше</span>{[0, 1, 2, 3, 4].map((l) => <i key={l} class={`heat-cell lvl-${l}`} />)}<span>больше</span></div>;
}

export function streaks(days: DayStat[]) {
  const set = new Set(days.filter((d) => d.count).map((d) => d.day));
  const d = new Date();
  // серия не обрывается, пока сегодняшний день ещё не закончился
  if (!set.has(dayKey(d))) d.setDate(d.getDate() - 1);
  let current = 0;
  while (set.has(dayKey(d))) { current++; d.setDate(d.getDate() - 1); }
  let best = 0, run = 0, prev = 0;
  for (const key of [...set].sort()) {
    const t = new Date(key + 'T12:00:00').getTime();
    run = prev && Math.round((t - prev) / 86400_000) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = t;
  }
  return { current, best, active: set.size, total: days.reduce((s, x) => s + x.count, 0) };
}

// ---------------------------------------------------------------- профиль: активность и всё, чем поделился
interface DayItem { nodeId: string; name: string; sessions: number; chars: number; vaultId: string; vaultName: string; available: boolean }

function ShareRow({ s, onChange }: { s: Share; onChange: () => void }) {
  const revoke = async () => {
    const ok = await ask.confirm({ title: 'Закрыть доступ?', text: `«${s.name}» перестанет открываться ${s.target ? `у ${s.target.displayName}` : 'по ссылке'}.`, confirmText: 'Закрыть доступ', danger: true });
    if (ok) api('DELETE', `/shares/${s.id}`).then(onChange).catch(fail);
  };
  return (
    <div class={`share-row${s.expired ? ' is-off' : ''}`}>
      <span class="share-ico"><Icon name={s.target ? 'user' : 'globe'} size={17} /></span>
      <div class="share-info">
        <b>{s.kind === 'folder' ? s.name : displayName(s.name)}</b>
        <small>{s.target ? `для ${s.target.displayName}` : s.listed ? 'для всех · в профиле' : 'для всех по ссылке'} · {expiryText(s.expiresAt)} · просмотров: {s.views}</small>
      </div>
      <button type="button" class="icon-btn" title="Скопировать ссылку" aria-label="Скопировать ссылку" onClick={() => copyText(shareUrl(s.token), 'Ссылка скопирована')}><Icon name="link" size={17} /></button>
      <a class="icon-btn" href={shareUrl(s.token)} target="_blank" rel="noopener" title="Открыть" aria-label="Открыть"><Icon name="external" size={17} /></a>
      <button type="button" class="icon-btn" title="Закрыть доступ" aria-label="Закрыть доступ" onClick={revoke}><Icon name="x" size={17} /></button>
    </div>
  );
}

export function ProfileView() {
  const user = me.value!;
  const [days, setDays] = useState<DayStat[] | null>(null);
  const [totals, setTotals] = useState({ edits: 0, days: 0, notes: 0 });
  const [sel, setSel] = useState<string | null>(dayKey(new Date()));
  const [items, setItems] = useState<DayItem[] | null>(null);
  const [shares, setShares] = useState<{ mine: Share[]; incoming: Share[] }>({ mine: [], incoming: [] });
  const [bio, setBio] = useState(user.bio);
  const tick = sharesTick.value;

  const loadShares = () => api('GET', '/shares').then(setShares).catch(() => {});
  useEffect(() => { api('GET', '/activity').then((r) => { setDays(r.days); setTotals(r.totals); }).catch(fail); }, []);
  useEffect(() => { loadShares(); }, [tick]);
  useEffect(() => {
    if (!sel) return;
    let alive = true;
    setItems(null);
    api('GET', `/activity/day?day=${sel}`).then((r) => { if (alive) setItems(r.items); }).catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, [sel]);

  const st = useMemo(() => streaks(days ?? []), [days]);
  const patch = (body: Record<string, unknown>) => api('PATCH', '/me', body).then((r) => { me.value = r.user; }).catch(fail);
  const openItem = async (it: DayItem) => {
    if (!it.available) { toast('Заметка удалена или больше недоступна'); return; }
    if (it.vaultId !== vaultId.value) await selectVault(it.vaultId);
    if (byId.value.has(it.nodeId)) openFile(it.nodeId); else toast('Заметка не найдена');
  };
  const selDate = sel ? new Date(sel + 'T12:00:00') : null;

  return (
    <section class="view-layer profile" aria-label="Профиль">
      <header class="head">
        <button type="button" class="icon-btn" title="Назад к заметке" aria-label="Назад" onClick={() => { mainView.value = 'doc'; }}><Icon name="chevronLeft" /></button>
        <div class="crumbs"><span class="crumb-name" style="cursor:default">Профиль и активность</span></div>
      </header>
      <div class="profile-body">
        <div class="profile-inner">
          <div class="card profile-card rise">
            <span class="avatar avatar-xl">{user.displayName.slice(0, 1)}</span>
            <div class="profile-who">
              <h2>{user.displayName}</h2>
              <small>@{user.login}</small>
              <textarea class="input profile-bio" rows={2} maxLength={300} placeholder="Пара слов о себе — видно в открытом профиле" value={bio}
                onInput={(e) => setBio((e.target as HTMLTextAreaElement).value)} onBlur={() => { if (bio.trim() !== user.bio) patch({ bio }); }} />
            </div>
            <div class="profile-public">
              <div class="set-row">
                <div><b>Открытый профиль</b><small>Имя, карта активности и заметки, отмеченные «в профиле», видны всем по ссылке</small></div>
                <Switch label="Открытый профиль" checked={user.profilePublic} onChange={(v) => patch({ profilePublic: v })} />
              </div>
              {user.profilePublic ? (
                <div class="link-box">
                  <code>{profileUrl(user.login)}</code>
                  <button type="button" class="icon-btn" title="Скопировать" aria-label="Скопировать" onClick={() => copyText(profileUrl(user.login), 'Ссылка скопирована')}><Icon name="copy" size={16} /></button>
                  <a class="icon-btn" href={profileUrl(user.login)} target="_blank" rel="noopener" title="Открыть" aria-label="Открыть"><Icon name="external" size={16} /></a>
                </div>
              ) : null}
            </div>
          </div>

          <div class="stats rise">
            <div class="card stat"><span>Правок за год</span><b>{st.total}</b></div>
            <div class="card stat"><span>Серия сейчас</span><b>{st.current}<small> дн.</small></b></div>
            <div class="card stat"><span>Лучшая серия</span><b>{st.best}<small> дн.</small></b></div>
            <div class="card stat"><span>Заметок затронуто</span><b>{totals.notes}</b></div>
          </div>

          <div class="card rise">
            <div class="card-head"><h3>Активность</h3><HeatLegend /></div>
            {days ? <Heatmap days={days} selected={sel} onSelect={setSel} /> : <div class="side-empty">Загрузка…</div>}
            <p class="card-hint">Одна правка — это сеанс работы над заметкой: сохранения с паузами до 10 минут считаются одним сеансом.</p>
            {selDate ? (
              <div class="day-detail">
                <h4>{selDate.toLocaleDateString('ru', { weekday: 'long', day: 'numeric', month: 'long' })}</h4>
                {items === null ? <p class="card-hint">Загрузка…</p> : !items.length ? <p class="card-hint">В этот день правок не было.</p> : items.map((it) => (
                  <button type="button" class={`day-item${it.available ? '' : ' is-off'}`} key={it.nodeId} onClick={() => openItem(it)}>
                    <Icon name="file" size={16} />
                    <span><b>{displayName(it.name)}</b><small>{it.vaultName}</small></span>
                    <em>{edits(it.sessions)}{it.chars ? ` · ±${formatSize(it.chars)}` : ''}</em>
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div class="card rise">
            <div class="card-head"><h3>Чем я поделился</h3></div>
            {shares.mine.length ? shares.mine.map((s) => <ShareRow key={s.id} s={s} onChange={loadShares} />)
              : <p class="card-hint">Пока ничем. Откройте меню заметки или папки → «Поделиться», чтобы создать ссылку или открыть доступ человеку.</p>}
          </div>

          <div class="card rise">
            <div class="card-head"><h3>Поделились со мной</h3></div>
            {shares.incoming.length ? shares.incoming.map((s) => (
              <a class="share-row" key={s.id} href={shareUrl(s.token)} target="_blank" rel="noopener">
                <span class="share-ico"><Icon name={s.kind === 'folder' ? 'folder' : 'file'} size={17} /></span>
                <div class="share-info"><b>{s.kind === 'folder' ? s.name : displayName(s.name)}</b><small>от {s.authorName} · {expiryText(s.expiresAt)}</small></div>
                <Icon name="external" size={17} />
              </a>
            )) : <p class="card-hint">Здесь появятся заметки, к которым вам открыли доступ лично.</p>}
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- доступ к заметке или папке
const TERMS: [string, string][] = [['', 'Навсегда'], ['3600', 'На 1 час'], ['86400', 'На 1 день'], ['604800', 'На 7 дней'], ['2592000', 'На 30 дней'], ['date', 'До даты…']];

function TermPicker({ value, date, onChange }: { value: string; date: string; onChange: (v: string, date: string) => void }) {
  return (
    <>
      <select class="select" aria-label="Срок доступа" value={value} onChange={(e) => onChange((e.target as HTMLSelectElement).value, date)}>
        {TERMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      {value === 'date' ? <input class="input" type="datetime-local" aria-label="Дата окончания" value={date} onInput={(e) => onChange(value, (e.target as HTMLInputElement).value)} /> : null}
    </>
  );
}
const termToIso = (value: string, date: string): string | null => {
  if (!value) return null;
  if (value === 'date') return date ? new Date(date).toISOString() : null;
  return new Date(Date.now() + Number(value) * 1000).toISOString();
};

export function ShareNodeModal({ nodeId }: { nodeId: string }) {
  const node = byId.value.get(nodeId);
  const [shares, setShares] = useState<Share[] | null>(null);
  const [term, setTerm] = useState(['', '']);
  const [login, setLogin] = useState('');
  const [pTerm, setPTerm] = useState(['', '']);
  const close = () => { overlay.value = null; };
  const load = () => api('GET', `/nodes/${nodeId}/shares`).then((r) => setShares(r.shares)).catch(fail);
  useEffect(() => { load(); }, [nodeId]);
  if (!node) return null;
  const w = canWrite.value;
  const links = shares?.filter((s) => !s.target) ?? [];
  const people = shares?.filter((s) => s.target) ?? [];
  const what = node.kind === 'folder' ? 'папка со всем содержимым' : 'заметка';

  const create = async (body: Record<string, unknown>) => {
    try {
      const r = await api('POST', `/nodes/${nodeId}/shares`, body);
      await load();
      sharesTick.value++;
      if (!r.share.target) copyText(shareUrl(r.share.token), 'Ссылка создана и скопирована');
      else toast(`Доступ открыт: ${r.share.target.displayName}`);
      setLogin('');
    } catch (e) { fail(e); }
  };
  const update = (s: Share, body: Record<string, unknown>) => api('PATCH', `/shares/${s.id}`, body).then(load).catch(fail);
  const revoke = (s: Share) => api('DELETE', `/shares/${s.id}`).then(() => { load(); sharesTick.value++; }).catch(fail);
  const prolong = async (s: Share) => {
    const v = await ask.prompt({ title: 'Срок доступа', text: 'На сколько дней от сегодняшнего? Пусто — навсегда.', value: '', placeholder: 'например, 7', confirmText: 'Сохранить' });
    if (v === null) return;
    const n = Number(v.trim().replace(',', '.'));
    if (v.trim() && !(n > 0)) { toast('Введите число дней', 'error'); return; }
    update(s, { expiresAt: v.trim() ? new Date(Date.now() + n * 86400_000).toISOString() : null });
  };

  return (
    <Modal title={`Поделиться: ${node.kind === 'folder' ? node.name : displayName(node.name)}`} onClose={close}>
      <div class="modal-body">
        <div class="set-group">
          <h4>Ссылка для всех</h4>
          <p class="card-hint">По ссылке {what} открывается только для чтения, без входа в аккаунт.</p>
          {links.map((s) => (
            <div class={`share-card${s.expired ? ' is-off' : ''}`} key={s.id}>
              <div class="link-box">
                <code>{shareUrl(s.token)}</code>
                <button type="button" class="icon-btn" title="Скопировать" aria-label="Скопировать ссылку" onClick={() => copyText(shareUrl(s.token), 'Ссылка скопирована')}><Icon name="copy" size={16} /></button>
                <a class="icon-btn" href={shareUrl(s.token)} target="_blank" rel="noopener" title="Открыть" aria-label="Открыть"><Icon name="external" size={16} /></a>
              </div>
              <div class="share-meta">
                <button type="button" class="chip" title="Изменить срок" onClick={() => prolong(s)}><Icon name="clock" size={14} />{expiryText(s.expiresAt)}</button>
                <span class="chip is-plain"><Icon name="eye" size={14} />{s.views}</span>
                <label class="chip" title="Показывать эту заметку в вашем открытом профиле">
                  <input type="checkbox" checked={s.listed} onChange={(e) => update(s, { listed: (e.target as HTMLInputElement).checked })} />в профиле
                </label>
                <button type="button" class="chip is-danger" onClick={() => revoke(s)}>Отозвать</button>
              </div>
            </div>
          ))}
          {w ? (
            <div class="add-row wrap">
              <TermPicker value={term[0]} date={term[1]} onChange={(v, d) => setTerm([v, d])} />
              <button type="button" class="btn btn-primary" onClick={() => create({ expiresAt: termToIso(term[0], term[1]) })}><Icon name="link" size={16} />{links.length ? 'Ещё ссылка' : 'Создать ссылку'}</button>
            </div>
          ) : null}
        </div>

        <div class="set-group">
          <h4>Конкретным людям</h4>
          <p class="card-hint">Откроется только у этого человека после входа в его аккаунт — тоже для чтения. Заметка появится у него в «Поделились со мной».</p>
          {people.map((s) => (
            <div class={`member${s.expired ? ' is-off' : ''}`} key={s.id}>
              <span class="avatar">{s.target!.displayName.slice(0, 1)}</span>
              <div class="member-info"><b>{s.target!.displayName}</b><small>{s.target!.login} · {expiryText(s.expiresAt)}</small></div>
              <button type="button" class="icon-btn" title="Изменить срок" aria-label="Изменить срок" onClick={() => prolong(s)}><Icon name="clock" size={17} /></button>
              <button type="button" class="icon-btn" title="Закрыть доступ" aria-label="Закрыть доступ" onClick={() => revoke(s)}><Icon name="x" size={17} /></button>
            </div>
          ))}
          {w ? (
            <form class="add-row wrap" onSubmit={(e) => { e.preventDefault(); create({ login, expiresAt: termToIso(pTerm[0], pTerm[1]) }); }}>
              <input class="input" style="flex:1;min-width:140px" required placeholder="логин пользователя" value={login} autocapitalize="none" autocomplete="off" spellcheck={false}
                onInput={(e) => setLogin((e.target as HTMLInputElement).value)} />
              <TermPicker value={pTerm[0]} date={pTerm[1]} onChange={(v, d) => setPTerm([v, d])} />
              <button type="submit" class="btn">Открыть доступ</button>
            </form>
          ) : <div class="note">Открывать доступ могут владелец и редакторы хранилища.</div>}
        </div>

        <div class="note">
          Нужно править вместе? Пригласите человека в хранилище целиком:{' '}
          <a href="#" onClick={(e) => { e.preventDefault(); const v = currentVault.value; if (v) overlay.value = { type: 'share', vaultId: v.id }; }}>участники и доступ</a>.
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- история версий
interface Revision { id: string; size: number; createdAt: string; author: string }

export function HistoryModal({ nodeId }: { nodeId: string }) {
  const node = byId.value.get(nodeId);
  const [list, setList] = useState<Revision[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [old, setOld] = useState<string | null>(null);
  const [current, setCurrent] = useState('');
  const [view, setView] = useState<'diff' | 'text'>('diff');
  const close = () => { overlay.value = null; };

  useEffect(() => {
    api('GET', `/nodes/${nodeId}/revisions`).then((r) => { setList(r.revisions); setSel(r.revisions[0]?.id ?? null); }).catch(fail);
    const doc = docs.get(nodeId);
    if (doc?.loaded) setCurrent(getText(doc));
    else api('GET', `/nodes/${nodeId}`).then((r) => setCurrent(r.content ?? '')).catch(() => {});
  }, [nodeId]);
  useEffect(() => {
    if (!sel) return;
    let alive = true;
    setOld(null);
    api('GET', `/nodes/${nodeId}/revisions/${sel}`).then((r) => { if (alive) setOld(r.content); }).catch(fail);
    return () => { alive = false; };
  }, [sel]);

  const diff = useMemo(() => {
    if (old === null) return [];
    const d = dmp.diff_main(old, current);
    dmp.diff_cleanupSemantic(d);
    return d;
  }, [old, current]);

  const restore = async () => {
    if (old === null) return;
    openFile(nodeId);
    const doc = ensureDoc(nodeId);
    if (doc.loading) await doc.loading;
    setDocText(nodeId, old);
    close();
    toast('Версия восстановлена. Отмена (Ctrl+Z) вернёт прежний текст');
  };

  if (!node) return null;
  return (
    <Modal title={`История: ${displayName(node.name)}`} size="lg" onClose={close}>
      <div class="tpl history">
        <div class="tpl-list">
          {list === null ? <p class="card-hint">Загрузка…</p> : !list.length ? (
            <p class="card-hint">Версий пока нет. Снимок делается сам, когда вы возвращаетесь к заметке после паузы или её начинает править другой человек.</p>
          ) : list.map((r) => (
            <button type="button" key={r.id} class={`tpl-item${r.id === sel ? ' is-active' : ''}`} onClick={() => setSel(r.id)}>
              <span class="tpl-ico"><Icon name="clock" size={16} /></span>
              <span class="tpl-text">
                <b>{new Date(r.createdAt).toLocaleString('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</b>
                <small>{r.author} · {formatSize(r.size)}</small>
              </span>
            </button>
          ))}
        </div>
        <div class="tpl-main">
          {sel ? (
            <>
              <div class="tpl-actions" style="border:0;padding-top:0">
                <div class="seg">
                  <button type="button" class={`seg-btn${view === 'diff' ? ' is-active' : ''}`} onClick={() => setView('diff')}>Что изменилось с тех пор</button>
                  <button type="button" class={`seg-btn${view === 'text' ? ' is-active' : ''}`} onClick={() => setView('text')}>Текст версии</button>
                </div>
              </div>
              <pre class="tpl-preview diff">
                {old === null ? 'Загрузка…' : view === 'text' ? old : diff.every(([op]) => op === 0) ? 'Отличий от текущего текста нет.'
                  : diff.map(([op, text], i) => (op === 0 ? <span key={i}>{text}</span> : op === 1 ? <ins key={i}>{text}</ins> : <del key={i}>{text}</del>))}
              </pre>
              {canWrite.value ? (
                <div class="tpl-actions">
                  <button type="button" class="btn btn-primary" disabled={old === null || old === current} onClick={restore}><Icon name="undo" size={16} />Восстановить эту версию</button>
                  <button type="button" class="btn btn-ghost" disabled={old === null} onClick={() => old !== null && copyText(old, 'Текст версии скопирован')}>Скопировать текст</button>
                </div>
              ) : null}
            </>
          ) : <div class="tpl-preview" />}
        </div>
      </div>
    </Modal>
  );
}
