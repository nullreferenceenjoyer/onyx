import { useEffect, useRef } from 'preact/hooks';
import { handleGlobalKey } from '../actions';
import { Logo } from '../icons';
import { dialog, isMobile, leftOpen, mainView, me, menu, overlay, rightOpen } from '../store';
import { ls } from '../util';
import { Auth } from './Auth';
import { EditorPane } from './EditorPane';
import { GraphView } from './Graph';
import { Header, Tabs } from './Header';
import { MoveDialog, Palette } from './Palette';
import { RightPanel } from './RightPanel';
import { SettingsModal, ShareModal } from './Settings';
import { Sidebar } from './Sidebar';
import { HistoryModal, ProfileView, ShareNodeModal } from './Social';
import { TemplatesModal } from './Templates';
import { DialogHost, MenuHost, Toasts } from './ui';

function Shell() {
  const ref = useRef<HTMLDivElement>(null);
  const mobile = isMobile.value;
  const ov = overlay.value;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialog.peek() || menu.peek()) return;
      if (e.key === 'Escape' && isMobile.peek() && (leftOpen.peek() || rightOpen.peek())) { leftOpen.value = false; rightOpen.value = false; return; }
      if (handleGlobalKey(e)) { e.preventDefault(); e.stopPropagation(); }
    };
    // перехватываем раньше редактора и браузера (Ctrl+P, Ctrl+O)
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => { if (!mobile) ls.set('onyx.left', leftOpen.value); }, [leftOpen.value, mobile]);

  // жесты на телефоне: свайп от левого края открывает дерево, свайп по шторке — закрывает
  useEffect(() => {
    const el = ref.current!;
    let x0 = 0, y0 = 0, kind: 'open' | 'left' | 'right' | null = null;
    const start = (e: TouchEvent) => {
      const t = e.touches[0];
      x0 = t.clientX; y0 = t.clientY; kind = null;
      if (!isMobile.peek() || e.touches.length > 1) return;
      if (leftOpen.peek()) kind = 'left';
      else if (rightOpen.peek()) kind = 'right';
      else if (x0 < 22) kind = 'open';
    };
    const end = (e: TouchEvent) => {
      if (!kind) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - x0, dy = Math.abs(t.clientY - y0);
      if (Math.abs(dx) < 56 || dy > Math.abs(dx) * 0.8) return;
      if (kind === 'open' && dx > 0) leftOpen.value = true;
      if (kind === 'left' && dx < 0) leftOpen.value = false;
      if (kind === 'right' && dx > 0) rightOpen.value = false;
    };
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchend', end, { passive: true });
    return () => { el.removeEventListener('touchstart', start); el.removeEventListener('touchend', end); };
  }, []);

  // ширину дерева файлов можно менять мышью
  const startResize = (e: PointerEvent) => {
    const handle = e.currentTarget as HTMLElement;
    const shell = ref.current!;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('is-drag');
    const left = shell.getBoundingClientRect().left;
    const move = (ev: PointerEvent) => {
      const w = Math.max(220, Math.min(520, ev.clientX - left - 8));
      shell.style.setProperty('--side-w', `${w}px`);
    };
    const up = () => {
      handle.classList.remove('is-drag');
      handle.removeEventListener('pointermove', move);
      ls.set('onyx.sideW', shell.style.getPropertyValue('--side-w'));
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
  };
  const sideW = ls.get<string>('onyx.sideW', '288px');

  return (
    <div ref={ref} class={`shell${leftOpen.value ? ' left-open' : ''}${rightOpen.value ? ' right-open' : ''}`} style={{ '--side-w': sideW }}>
      <Sidebar />
      {!mobile && leftOpen.value ? <div class="resizer" style={{ left: 'calc(var(--side-w, 288px) + 8px + max(8px, var(--sal)) - 5px)' }} onPointerDown={startResize} /> : null}
      <main class="main">
        <Tabs />
        <Header />
        <EditorPane />
        {mainView.value === 'graph' ? <GraphView /> : null}
        {mainView.value === 'profile' ? <ProfileView /> : null}
      </main>
      <RightPanel />
      {mobile && (leftOpen.value || rightOpen.value) ? <div class="scrim" onClick={() => { leftOpen.value = false; rightOpen.value = false; }} /> : null}
      {ov?.type === 'settings' ? <SettingsModal /> : null}
      {ov?.type === 'palette' ? <Palette key={ov.mode} mode={ov.mode} /> : null}
      {ov?.type === 'share' ? <ShareModal vaultId={ov.vaultId} /> : null}
      {ov?.type === 'move' ? <MoveDialog nodeId={ov.nodeId} /> : null}
      {ov?.type === 'templates' ? <TemplatesModal /> : null}
      {ov?.type === 'shareNode' ? <ShareNodeModal nodeId={ov.nodeId} /> : null}
      {ov?.type === 'history' ? <HistoryModal nodeId={ov.nodeId} /> : null}
    </div>
  );
}

export function App() {
  const user = me.value;
  return (
    <>
      {user === undefined ? <div class="splash"><Logo size={64} /></div> : user === null ? <Auth /> : <Shell />}
      <MenuHost />
      <DialogHost />
      <Toasts />
    </>
  );
}
