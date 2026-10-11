import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, ApiError, rawUrl, setRawBase } from '../api';
import { Icon, Logo } from '../icons';
import { renderMarkdown, renderPlain } from '../render/markdown';
import { nodes as storeNodes, pathOf, resolveLink } from '../store';
import type { DayStat, TreeNode } from '../types';
import { byName, displayName, downloadUrl, isImage, isMarkdown, timeAgo } from '../util';
import { edits, expiryText, Heatmap, HeatLegend, streaks } from './Social';

// Страницы, открытые без входа: заметка или папка по ссылке (/s/токен) и открытый профиль (/u/логин).

function Frame({ children, title, sub, actions }: { children: preact.ComponentChildren; title?: string; sub?: string; actions?: preact.ComponentChildren }) {
  return (
    <div class="pub">
      <header class="pub-head">
        <a class="pub-brand" href="/" title="Открыть Оникс"><Logo size={26} /><span>Оникс</span></a>
        <div class="pub-title">{title ? <b>{title}</b> : null}{sub ? <small>{sub}</small> : null}</div>
        {actions}
      </header>
      {children}
    </div>
  );
}

function Problem({ error }: { error: ApiError }) {
  return (
    <Frame>
      <div class="empty">
        <div class="empty-box rise">
          <Icon name={error.status === 401 ? 'lock' : 'cloudOff'} size={44} />
          <h2>{error.status === 401 ? 'Нужен вход' : 'Не открывается'}</h2>
          <p>{error.message}</p>
          <a class="btn btn-primary" href="/">{error.status === 401 ? 'Войти в Оникс' : 'На главную'}</a>
        </div>
      </div>
    </Frame>
  );
}

interface Shared { share: { name: string; kind: 'folder' | 'file'; binary: boolean; ownerName: string; expiresAt: string | null; personal: boolean }; rootId: string; nodes: TreeNode[]; content: string | null }

export function PublicShare({ token }: { token: string }) {
  const [data, setData] = useState<Shared | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setRawBase((id) => `/api/public/${token}/raw/${id}`);
    api<Shared>('GET', `/public/${token}`).then((r) => {
      // ссылки и картинки внутри заметки ищутся среди того, что открыто по этой ссылке
      storeNodes.value = r.nodes;
      setData(r);
      document.title = `${r.share.kind === 'folder' ? r.share.name : displayName(r.share.name)} — Оникс`;
      if (r.share.kind === 'file') setCurrent(r.rootId);
      else {
        const list = r.nodes.filter((n) => n.kind === 'file').sort((a, b) => pathOf(a.id).localeCompare(pathOf(b.id), 'ru', { numeric: true }));
        setCurrent((list.find((n) => /^(readme|index|начало|оглавление)\./i.test(n.name)) ?? list.find((n) => isMarkdown(n.name)) ?? list[0])?.id ?? null);
      }
    }).catch((e) => setError(e));
  }, [token]);

  const fileList = useMemo(() => (data?.nodes ?? []).filter((n) => n.kind === 'file' && !(n.binary && isImage(n.name) && data?.share.kind === 'file'))
    .map((n) => ({ n, path: pathOf(n.id) })).sort((a, b) => a.path.localeCompare(b.path, 'ru', { numeric: true })), [data]);
  const node = data?.nodes.find((n) => n.id === current);

  useEffect(() => {
    const el = body.current;
    if (!data || !node || !el) return;
    let alive = true;
    const show = (root: HTMLElement) => { if (alive) { root.className = 'markdown reader-inner'; el.replaceChildren(root); el.scrollTop = 0; } };
    if (node.binary) {
      const root = document.createElement('div');
      if (isImage(node.name)) { const img = document.createElement('img'); img.src = rawUrl(node.id, node.version); img.alt = node.name; root.appendChild(img); }
      else { const p = document.createElement('p'); p.textContent = 'Этот файл нельзя показать на странице — скачайте его кнопкой сверху.'; root.appendChild(p); }
      show(root);
      return;
    }
    const text = node.id === data.rootId && data.content !== null ? Promise.resolve(data.content) : api('GET', `/public/${token}/node/${node.id}`).then((r) => r.content as string);
    text.then((t) => (isMarkdown(node.name) ? renderMarkdown(t) : renderPlain(t))).then((root) => {
      // на чужой странице флажки задач только показывают состояние
      for (const box of root.querySelectorAll('input.task')) box.setAttribute('disabled', '');
      show(root);
    }).catch(() => {});
    return () => { alive = false; };
  }, [data, current]);

  if (error) return <Problem error={error} />;
  if (!data) return <Frame><div class="splash"><Logo size={56} /></div></Frame>;

  const onClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a || a.dataset.wiki === undefined) return;
    e.preventDefault();
    const hit = resolveLink(a.dataset.wiki);
    if (hit) { setCurrent(hit.id); setListOpen(false); }
  };
  const folder = data.share.kind === 'folder';
  const title = folder ? data.share.name : displayName(data.share.name);

  return (
    <Frame title={title} sub={`${data.share.personal ? 'лично вам от' : 'поделился'} ${data.share.ownerName} · ${expiryText(data.share.expiresAt)}`} actions={
      <>
        {folder ? <button type="button" class="icon-btn only-mobile" aria-label="Список файлов" onClick={() => setListOpen(!listOpen)}><Icon name="menu" /></button> : null}
        {node ? <button type="button" class="btn" title="Скачать исходный файл" onClick={() => downloadUrl(`/api/public/${token}/raw/${node.id}?download=1`, node.name)}><Icon name="download" size={16} /><span class="only-desktop">Скачать</span></button> : null}
      </>
    }>
      <div class={`pub-body${folder ? ' has-list' : ''}${listOpen ? ' list-open' : ''}`}>
        {folder ? (
          <nav class="pub-list">
            {fileList.map(({ n, path }) => (
              <button type="button" key={n.id} class={`tree-row${n.id === current ? ' is-active' : ''}`} title={path} onClick={() => { setCurrent(n.id); setListOpen(false); }}>
                <Icon class="tree-ico" size={16} name={isMarkdown(n.name) ? 'file' : isImage(n.name) ? 'image' : 'fileBlank'} />
                <span class="tree-name">{isMarkdown(n.name) ? path.replace(/\.md$/i, '') : path}</span>
              </button>
            ))}
            {!fileList.length ? <div class="side-empty">Папка пуста</div> : null}
          </nav>
        ) : null}
        <main class="reader pub-reader" ref={body} onClick={onClick} />
      </div>
    </Frame>
  );
}

interface ProfileData {
  profile: { login: string; displayName: string; bio: string; joinedAt: string; isPublic: boolean };
  days: DayStat[];
  notes: { token: string; name: string; kind: 'folder' | 'file'; updatedAt: string; views: number }[];
}

export function PublicProfile({ login }: { login: string }) {
  const [data, setData] = useState<ProfileData | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    api<ProfileData>('GET', `/profile/${encodeURIComponent(login)}`).then((r) => { setData(r); document.title = `${r.profile.displayName} — Оникс`; }).catch((e) => setError(e));
  }, [login]);
  if (error) return <Problem error={error} />;
  if (!data) return <Frame><div class="splash"><Logo size={56} /></div></Frame>;
  const { profile, days, notes } = data;
  const st = streaks(days);
  return (
    <Frame>
      <div class="profile-body">
        <div class="profile-inner">
          <div class="card profile-card rise">
            <span class="avatar avatar-xl">{profile.displayName.slice(0, 1)}</span>
            <div class="profile-who">
              <h2>{profile.displayName}</h2>
              <small>@{profile.login} · в Ониксе с {new Date(profile.joinedAt).toLocaleDateString('ru', { month: 'long', year: 'numeric' })}</small>
              {profile.bio ? <p>{profile.bio}</p> : null}
              {!profile.isPublic ? <p class="card-hint">Профиль закрыт — эту страницу видите только вы.</p> : null}
            </div>
          </div>
          <div class="stats rise">
            <div class="card stat"><span>Правок за год</span><b>{st.total}</b></div>
            <div class="card stat"><span>Серия сейчас</span><b>{st.current}<small> дн.</small></b></div>
            <div class="card stat"><span>Лучшая серия</span><b>{st.best}<small> дн.</small></b></div>
            <div class="card stat"><span>Активных дней</span><b>{st.active}</b></div>
          </div>
          <div class="card rise">
            <div class="card-head"><h3>Активность: {edits(st.total)} за год</h3><HeatLegend /></div>
            <Heatmap days={days} />
          </div>
          <div class="card rise">
            <div class="card-head"><h3>Открытые заметки</h3></div>
            {notes.length ? [...notes].sort((a, b) => byName(a, b)).map((n) => (
              <a class="share-row" key={n.token} href={`/s/${n.token}`}>
                <span class="share-ico"><Icon name={n.kind === 'folder' ? 'folder' : 'file'} size={17} /></span>
                <div class="share-info"><b>{n.kind === 'folder' ? n.name : displayName(n.name)}</b><small>обновлено {timeAgo(n.updatedAt)} · просмотров: {n.views}</small></div>
                <Icon name="chevronRight" size={17} />
              </a>
            )) : <p class="card-hint">Открытых заметок пока нет.</p>}
          </div>
        </div>
      </div>
    </Frame>
  );
}
