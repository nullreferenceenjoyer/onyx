// Поведение «как у нативного приложения» на телефоне:
// страница не масштабируется жестами, не прокручивается вбок и не уезжает под клавиатуру.

export function initViewport() {
  const root = document.documentElement;
  const vv = window.visualViewport;

  // высота приложения = видимая область: когда открыта клавиатура, панель форматирования остаётся над ней
  const sync = () => {
    root.style.setProperty('--vvh', `${Math.round(vv ? vv.height : innerHeight)}px`);
    // iOS при фокусе сдвигает страницу вверх — возвращаем на место
    if (window.scrollY || window.scrollX) window.scrollTo(0, 0);
  };
  sync();
  vv?.addEventListener('resize', sync);
  vv?.addEventListener('scroll', sync);
  window.addEventListener('resize', sync);
  window.addEventListener('orientationchange', () => setTimeout(sync, 200));
  window.addEventListener('scroll', () => { if (window.scrollY || window.scrollX) window.scrollTo(0, 0); }, { passive: true });

  // Safari игнорирует user-scalable=no — отменяем щипок сами (двойное касание отключает touch-action в CSS)
  for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(t, (e) => e.preventDefault(), { passive: false });
  document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
  // щипок на тачпаде и Ctrl+колесо на сенсорных устройствах
  document.addEventListener('wheel', (e) => { if (e.ctrlKey && matchMedia('(pointer: coarse)').matches) e.preventDefault(); }, { passive: false });
}
