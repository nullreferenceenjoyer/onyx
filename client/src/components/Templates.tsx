import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon } from '../icons';
import { renderMarkdown } from '../render/markdown';
import { activeId, byId, canWrite, children, docs, openFile, overlay } from '../store';
import { allTemplates, createFromTemplate, expand, insertTemplate, newTemplate, type Template, templateBody } from '../templates';
import { Modal } from './ui';

export function TemplatesModal() {
  const list = allTemplates();
  children.value; // свои шаблоны — файлы: список обновляется вместе с деревом
  const [key, setKey] = useState(list[0]?.key);
  const current = list.find((t) => t.key === key) ?? list[0];
  const preview = useRef<HTMLDivElement>(null);
  const close = () => { overlay.value = null; };
  const active = activeId.value ? byId.value.get(activeId.value) : undefined;
  const canInsert = !!active && !active.binary && canWrite.value && docs.get(active.id)?.mode !== 'read';

  useEffect(() => {
    if (!current) return;
    let alive = true;
    templateBody(current)
      .then((body) => renderMarkdown(expand(body, current.title ? expand(current.title).text : current.name).text))
      .then((root) => { if (alive && preview.current) { root.className = 'markdown'; preview.current.replaceChildren(root); preview.current.scrollTop = 0; } })
      .catch(() => {});
    return () => { alive = false; };
  }, [current?.key]);

  const own = list.filter((t) => t.nodeId);
  const builtin = list.filter((t) => !t.nodeId);
  const item = (t: Template) => (
    <button type="button" key={t.key} class={`tpl-item${t.key === current?.key ? ' is-active' : ''}`} onClick={() => setKey(t.key)}>
      <span class="tpl-ico"><Icon name={t.icon} size={17} /></span>
      <span class="tpl-text"><b>{t.name}</b><small>{t.description}</small></span>
    </button>
  );

  return (
    <Modal title="Шаблоны" size="lg" onClose={close}>
      <div class="tpl">
        <div class="tpl-list">
          {own.length ? <><h4>Свои</h4>{own.map(item)}</> : null}
          <h4>Готовые</h4>
          {builtin.map(item)}
          {canWrite.value ? (
            <button type="button" class="btn btn-ghost tpl-new" onClick={() => { close(); newTemplate(); }}><Icon name="plus" size={16} />Свой шаблон</button>
          ) : null}
        </div>
        <div class="tpl-main">
          <div class="tpl-preview" ref={preview} />
          {current && canWrite.value ? (
            <div class="tpl-actions">
              <button type="button" class="btn btn-primary" onClick={() => { close(); createFromTemplate(current); }}><Icon name="filePlus" size={16} />Создать заметку</button>
              <button type="button" class="btn" disabled={!canInsert} title={canInsert ? 'Вставить на место курсора' : 'Откройте заметку в режиме правки'}
                onClick={() => { close(); insertTemplate(current); }}>Вставить в текущую</button>
              {current.nodeId
                ? <button type="button" class="btn btn-ghost" onClick={() => { close(); openFile(current.nodeId!); }}><Icon name="pencil" size={16} />Изменить</button>
                : <button type="button" class="btn btn-ghost" title="Создать свою копию в папке «Шаблоны» и изменить её" onClick={() => { close(); newTemplate(current); }}>Настроить под себя</button>}
            </div>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
