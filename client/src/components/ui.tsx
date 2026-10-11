import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Icon } from '../icons';
import { dialog, isMobile, menu, toasts } from '../store';
import type { MenuItem } from '../types';

// ---------------------------------------------------------------- долгое нажатие = контекстное меню на телефоне
// iOS не присылает событие contextmenu, поэтому меню на сенсорных экранах открываем по таймеру.
export function useLongPress(onLong: (at: { clientX: number; clientY: number }) => void) {
  const state = useRef({ timer: 0, x: 0, y: 0, fired: false });
  const clear = () => { clearTimeout(state.current.timer); };
  return {
    onTouchStart(e: TouchEvent) {
      const t = e.touches[0];
      const s = state.current;
      s.x = t.clientX; s.y = t.clientY; s.fired = false;
      clear();
      s.timer = window.setTimeout(() => {
        s.fired = true;
        navigator.vibrate?.(8);
        onLong({ clientX: s.x, clientY: s.y });
      }, 450);
    },
    onTouchMove(e: TouchEvent) {
      const t = e.touches[0];
      if (Math.abs(t.clientX - state.current.x) > 10 || Math.abs(t.clientY - state.current.y) > 10) clear();
    },
    onTouchEnd(e: TouchEvent) {
      clear();
      // меню уже открыто — отпускание пальца не должно ещё и «кликнуть» по строке
      if (state.current.fired) e.preventDefault();
    },
    onTouchCancel: clear,
  };
}

// ---------------------------------------------------------------- контекстное меню
function MenuList({ items, close, onSub }: { items: MenuItem[]; close: () => void; onSub?: (item: MenuItem & { label: string }, el: HTMLElement) => void }) {
  return (
    <>
      {items.map((it, i) => {
        if ('sep' in it) return <div class="menu-sep" key={i} />;
        if ('title' in it) return <div class="menu-title" key={i}>{it.title}</div>;
        return (
          <button
            key={i} type="button" class={`menu-item${it.danger ? ' is-danger' : ''}`} disabled={it.disabled}
            // фокус остаётся в редакторе: команды форматирования применяются к выделению
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={(e) => { if (!isMobile.value) onSub?.(it, e.currentTarget as HTMLElement); }}
            onClick={(e) => {
              if (it.children) { onSub?.(it, e.currentTarget as HTMLElement); return; }
              close();
              it.onClick?.();
            }}
          >
            {it.icon ?? (it.checked !== undefined ? <Icon name={it.checked ? 'check' : 'fileBlank'} size={16} class={it.checked ? '' : 'is-hidden'} /> : null)}
            <span>{it.label}</span>
            {it.checked && it.icon ? <Icon name="check" size={15} /> : null}
            {it.hint ? <small class="menu-hint">{it.hint}</small> : null}
            {it.children ? <Icon name="chevronRight" size={15} /> : null}
          </button>
        );
      })}
    </>
  );
}

function place(el: HTMLElement, x: number, y: number, avoid?: DOMRect) {
  const w = el.offsetWidth, h = el.offsetHeight;
  const vw = window.innerWidth, vh = window.visualViewport?.height ?? window.innerHeight;
  let left = x, top = y;
  if (avoid) {
    // подменю: справа от пункта, а если не помещается — слева
    left = avoid.right + 2;
    if (left + w > vw - 8) left = avoid.left - w - 2;
    top = avoid.top - 5;
  } else if (left + w > vw - 8) left = vw - w - 8;
  if (top + h > vh - 8) top = vh - h - 8;
  el.style.left = `${Math.max(8, left)}px`;
  el.style.top = `${Math.max(8, top)}px`;
}

export function MenuHost() {
  const m = menu.value;
  const mobile = isMobile.value;
  const ref = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const [sub, setSub] = useState<{ items: MenuItem[]; rect: DOMRect; label: string } | null>(null);
  const close = () => { menu.value = null; };

  useEffect(() => { setSub(null); }, [m]);
  useLayoutEffect(() => { if (m && ref.current && !mobile) place(ref.current, m.x, m.y); }, [m, mobile]);
  useLayoutEffect(() => { if (sub && subRef.current && !mobile) place(subRef.current, 0, 0, sub.rect); }, [sub, mobile]);
  useEffect(() => {
    if (!m) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const list = [...(ref.current?.querySelectorAll<HTMLElement>('.menu-item:not(:disabled)') ?? [])];
      const i = list.indexOf(document.activeElement as HTMLElement);
      list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('resize', close); };
  }, [m]);

  if (!m) return null;
  const onSub = (it: MenuItem & { label: string }, el: HTMLElement) => {
    if ('children' in it && it.children) setSub({ items: it.children, rect: el.getBoundingClientRect(), label: it.label });
    else if (!mobile) setSub(null);
  };

  if (mobile) {
    return (
      <div class="menu-layer is-sheet" onClick={close} onContextMenu={(e) => e.preventDefault()}>
        <div class="menu-sheet" onClick={(e) => e.stopPropagation()}>
          {sub ? (
            <>
              <button type="button" class="menu-item" onClick={() => setSub(null)}><Icon name="chevronLeft" size={16} /><span>{sub.label}</span></button>
              <div class="menu-sep" />
              <MenuList items={sub.items} close={close} />
            </>
          ) : <MenuList items={m.items} close={close} onSub={onSub} />}
        </div>
      </div>
    );
  }
  return (
    <div class="menu-layer" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }} onContextMenu={(e) => { e.preventDefault(); close(); }}>
      <div class="menu" ref={ref} role="menu"><MenuList items={m.items} close={close} onSub={onSub} /></div>
      {sub ? <div class="menu" ref={subRef} role="menu"><MenuList items={sub.items} close={close} /></div> : null}
    </div>
  );
}

// ---------------------------------------------------------------- окна
export function Modal({ title, onClose, children, actions, size, class: cls }: {
  title?: string; onClose: () => void; children: ComponentChildren; actions?: ComponentChildren; size?: 'lg'; class?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div class="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class={`modal${size === 'lg' ? ' modal-lg' : ''}${cls ? ' ' + cls : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        {title ? (
          <div class="modal-head">
            <h3>{title}</h3>
            <button type="button" class="icon-btn" onClick={onClose} aria-label="Закрыть"><Icon name="x" /></button>
          </div>
        ) : null}
        {children}
        {actions ? <div class="modal-actions">{actions}</div> : null}
      </div>
    </div>
  );
}

export function DialogHost() {
  const d = dialog.value;
  return d ? <DialogBody key={d.title + d.kind} d={d} /> : null;
}

function DialogBody({ d }: { d: NonNullable<typeof dialog.value> }) {
  const input = useRef<HTMLInputElement>(null);
  const okBtn = useRef<HTMLButtonElement>(null);
  const [value, setValue] = useState(d.value ?? '');
  // фокус ставится сразу, до отрисовки кадра: имя выделено целиком, можно печатать новое, не теряя первых букв
  useLayoutEffect(() => {
    if (d.kind === 'prompt') { input.current?.focus(); input.current?.select(); } else okBtn.current?.focus();
  }, []);
  const done = (v: string | null) => { dialog.value = null; d.resolve(v); };
  return (
    <Modal title={d.title} onClose={() => done(null)}>
      <form onSubmit={(e) => { e.preventDefault(); done(d.kind === 'prompt' ? value : 'ok'); }} style="display:contents">
        <div class="modal-body">
          {d.text ? <p>{d.text}</p> : null}
          {d.kind === 'prompt' ? (
            <input ref={input} class="input" value={value} placeholder={d.placeholder} onInput={(e) => setValue((e.target as HTMLInputElement).value)}
              autocomplete="off" autocapitalize="sentences" spellcheck={false} enterkeyhint="done" />
          ) : null}
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" onClick={() => done(null)}>Отмена</button>
          <button ref={okBtn} type="submit" class={`btn ${d.danger ? 'btn-danger' : 'btn-primary'}`}>{d.confirmText ?? 'ОК'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function Toasts() {
  return (
    <div class="toasts" aria-live="polite">
      {toasts.value.map((t) => <div key={t.id} class={`toast${t.kind === 'error' ? ' is-error' : ''}`}>{t.text}</div>)}
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label class="switch">
      <input type="checkbox" checked={checked} aria-label={label} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />
      <span class="switch-ui" />
    </label>
  );
}
