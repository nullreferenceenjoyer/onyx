import { useEffect, useState } from 'preact/hooks';
import { api } from '../api';
import { Icon } from '../icons';
import { activeId, byId, docs, docTick, getText, isMobile, openFile, pathOf, rightOpen, textTick } from '../store';
import { displayName, formatSize, outline, timeAgo } from '../util';
import { scrollToLine } from './EditorPane';

interface Backlink { id: string; snippets: string[] }

export function RightPanel() {
  docTick.value;
  textTick.value;
  const [tab, setTab] = useState<'outline' | 'links'>('outline');
  const [links, setLinks] = useState<Backlink[] | null>(null);
  const id = activeId.value;
  const node = id ? byId.value.get(id) : undefined;
  const doc = id ? docs.get(id) : undefined;
  const open = rightOpen.value;
  const text = doc?.loaded && node && !node.binary ? getText(doc) : '';
  const heads = open && tab === 'outline' ? outline(text) : [];
  const min = heads.reduce((m, h) => Math.min(m, h.level), 6);

  useEffect(() => {
    if (!open || tab !== 'links' || !id) return;
    let alive = true;
    setLinks(null);
    api('GET', `/nodes/${id}/backlinks`).then((r) => { if (alive) setLinks(r.results); }).catch(() => { if (alive) setLinks([]); });
    return () => { alive = false; };
  }, [open, tab, id, node?.name]);

  const words = text.trim() ? text.trim().split(/\s+/).length : 0;

  return (
    <aside class="right panel" aria-label="Оглавление и ссылки">
      <div class="side-inner">
        <div class="right-head">
          <div class="seg">
            <button type="button" class={`seg-btn${tab === 'outline' ? ' is-active' : ''}`} onClick={() => setTab('outline')}>Оглавление</button>
            <button type="button" class={`seg-btn${tab === 'links' ? ' is-active' : ''}`} onClick={() => setTab('links')}>Ссылки сюда</button>
          </div>
          <button type="button" class="icon-btn only-mobile" aria-label="Закрыть" onClick={() => { rightOpen.value = false; }}><Icon name="x" /></button>
        </div>
        <div class="side-body">
          {!node ? <div class="side-empty">Файл не открыт</div> : null}
          {node && tab === 'outline' ? (
            heads.length ? heads.map((h) => (
              <button type="button" key={h.line} class={`outline-item lvl-${h.level - min + 1}`} style={{ '--depth': h.level - min }} title={h.text}
                onClick={() => { scrollToLine(h.line); if (isMobile.value) rightOpen.value = false; }}>{h.text}</button>
            )) : <div class="side-empty">В заметке нет заголовков</div>
          ) : null}
          {node && tab === 'links' ? (
            links === null ? <div class="side-empty">Загрузка…</div>
              : links.length ? links.map((l) => {
                const n = byId.value.get(l.id);
                return n ? (
                  <button type="button" class="search-item" key={l.id} onClick={() => openFile(l.id)}>
                    <b>{displayName(n.name)}</b>
                    {n.parentId ? <span class="search-path">{pathOf(n.id, false)}</span> : null}
                    {l.snippets.map((s, i) => <span class="search-snip" key={i}>{s}</span>)}
                  </button>
                ) : null;
              }) : <div class="side-empty">На этот файл пока никто не ссылается.<br />Ссылка ставится так: [[{displayName(node.name)}]]</div>
          ) : null}
          {node ? (
            <div class="info-grid">
              <span>Размер</span><b>{formatSize(node.size)}</b>
              {!node.binary ? <><span>Слов</span><b>{words.toLocaleString('ru')}</b><span>Знаков</span><b>{text.length.toLocaleString('ru')}</b></> : null}
              <span>Изменён</span><b>{timeAgo(node.updatedAt)}</b>
            </div>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
